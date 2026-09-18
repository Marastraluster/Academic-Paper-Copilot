You are the independent Acceptance Criteria author for a local-first academic PDF
reader + bilingual translator ("Academic PDF Copilot"). You are Gemini; the lead
engineer is DeepSeek, who will implement what you specify. You define the criteria;
you do not write production code.

Your criteria for the previous twelve tasks in this repository have been used as
written, and you have twice corrected a false premise in a brief of ours. Do that
again if you find one here. Look for the parts of this brief that are wrong,
unimplementable, or that contradict the repository's own invariants — that is more
valuable than agreeing with us.

# The task

DS-QA-002 — Grounded Answer Generation. Given a question, a scope, and a DS-QA-001
`EvidenceBundle`, produce either a grounded answer with valid evidence citations, or
an explicit insufficient-evidence response. The system must never be forced to answer
when the retrieved evidence does not support an answer.

DS-QA-003 will build the sidebar UI on top of this. DS-QA-002 is backend, domain and
API only: no frontend work, no chat persistence, no multi-turn.

# What exists and is committed (`bb018a4`, `3438e5a`)

Backend 718 tests pass, frontend 78, production build exits 0.

## Retrieval (DS-QA-001) — the input to this task

`app/qa/models.py`:

```python
ScopeType = Literal["whole_paper", "section", "page", "selection"]
ChunkKind = Literal["paragraph", "caption"]

class Scope(BaseModel):            # extra="forbid"
    type: ScopeType
    page: int | None = Field(default=None, ge=1)          # for "page"
    section_id: str | None = None                          # for "section"
    paragraph_ids: list[str] | None = None                 # for "selection"

class EvidenceItem(BaseModel):     # extra="forbid"
    id: str                        # "E1", "E2", ... assigned by rank
    chunk_id: str
    kind: ChunkKind = "paragraph"
    paragraph_id: str
    section_id: str | None = None
    section_title: str | None = None
    page_number: int = Field(ge=1)
    page_range: list[int] = Field(default_factory=list)
    block_ids: list[str] = Field(default_factory=list)
    text: str                      # verbatim from DocumentIR, never rewritten
    score: float | None = None     # BM25 score, or None for a neighbour
    is_direct_hit: bool = True
    is_caption: bool = False

class Diagnostics(BaseModel):      # extra="forbid"
    code: str = "SUCCESS"          # only "SUCCESS" and "NO_MATCH_TOKEN" exist
    execution_time_ms: float = 0.0
    total_candidates_scored: int = 0
    expansions: list[ExpansionApplied] = Field(default_factory=list)
    index_rebuilt: bool = False

class EvidenceBundle(BaseModel):   # extra="forbid"
    document_id: str
    query: str
    query_normalized: str          # the FTS5 MATCH expression
    scope: Scope
    items: list[EvidenceItem] = Field(default_factory=list)
    token_estimate: int = 0        # sum(len(text)) // 4
```

`app/qa/retrieval.py`:

```python
DEFAULT_TOP_K = 8
NEIGHBOUR_RADIUS = 1

class RetrievalError(Exception):   # .code, .message
    ...

def retrieve(ir: DocumentIR, document_dir: Path, *, query: str, scope: Scope,
             analysis: DocumentAnalysis | None = None, top_k: int = DEFAULT_TOP_K,
             max_items: int | None = None) -> EvidenceBundle
```

Behaviour worth knowing:

* Scope constrains **candidate generation** inside the SQL MATCH, not post-filtering.
* Neighbour expansion (one paragraph either side, same section only, deduplicated)
  runs after ranking and is **skipped entirely under `selection`**. Neighbours carry
  `is_direct_hit=False` and `score=None`.
* Under `selection` with an **empty query**, FTS is bypassed and the selected
  paragraphs are returned in reading order — the "explain what I highlighted" case.
* An empty or word-free query returns zero items with `code="NO_MATCH_TOKEN"`.
* `analysis` is optional; when absent retrieval still works. It may add glossary and
  acronym **expansions** to the query. It never supplies evidence.
* Latency, measured on the real 12-page paper: index build 9.9 ms, warm whole-paper
  1.21 ms, page 1.19 ms, section 1.08 ms (medians of 30).

## The measured retrieval quality — read this before specifying thresholds

Ten benchmark questions per paper, ground truth defined by a phrase that must appear
in the answering paragraph:

```
paper                  mode        n   Hit@1   Hit@3   Hit@5  Hit@10
ResNet                 raw        10    50%    60%    60%    70%
ResNet                 assisted   10    60%    70%    70%    80%
Diffusion Policy       raw        10    50%    50%    60%    90%
Diffusion Policy       assisted   10    50%    50%    60%    90%
```

The original criterion required Hit@5 >= 80%. **It failed, and was reported as a
failure.** It has since been formally redefined by AC_CHANGE_REQUEST 1 in
`docs/acceptance/DS-QA-001.md` (committed as `3438e5a`): the threshold was a
hypothesis about lexical retrieval written as a specification, and measurement
falsified it. It was replaced by a disposition requirement — retrieval is not
required to be sufficient, it is required to be honest about when it is not — and
that is the requirement DS-QA-002 now inherits.

Every miss is the same class: **vocabulary mismatch**. The question says "datasets",
the paper says `CIFAR-10`. The question says "optimization method", the paper says
`momentum`. No ranking change repairs that.

Counter-evidence, and the reason the semantic layer earns its place here: a Chinese
question against the English ResNet paper —

```
"作者如何解决退化问题？"
raw       -> 0 hits, NO_MATCH_TOKEN
assisted  -> correct evidence at rank 1, via glossary expansion 退化问题 -> degradation problem
```

## Provider layer — reuse it, do not add another

`app/llm/models.py`:

```python
class ChatMessage(BaseModel):  # frozen, extra="forbid"
    role: Role                 # "system" | "user" | "assistant" | str
    content: str

class LLMRequest(BaseModel):   # frozen, extra="forbid"
    messages: list[ChatMessage] = Field(min_length=1)
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    max_output_tokens: int | None = Field(default=None, gt=0)
    timeout_s: float | None = Field(default=None, gt=0)

@dataclass(frozen=True)
class LLMUsage:
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int

@dataclass(frozen=True)
class LLMResult:
    text: str
    model: str | None
    protocol: str
    usage: LLMUsage | None = None

class ProviderConfig(BaseModel):   # frozen, extra="forbid"
    base_url: str
    api_key: SecretStr = SecretStr("")   # empty allowed: keyless local servers
    model: str
    timeout_s: float = 60.0
    temperature: float | None = None
    max_output_tokens: int | None = None
    custom_headers: dict[str, str] | None = None
```

Note what `ProviderConfig` does **not** have: no `context_window`, no vendor
identity. Model capacity is deliberately not modelled — the user supplies an
endpoint and a model name and the application never assumes what it can hold. A
previous criterion in this repository assumed a `context_window` field and had to
be corrected. Budgets are explicit configuration with conservative defaults.

`app/llm/base.py`:

```python
class LLMProvider(ABC):
    protocol: str = "unknown"
    async def generate(self, request: LLMRequest) -> LLMResult: ...
    async def test_connection(self) -> ConnectionReport: ...
```

`app/llm/errors.py` — every failure funnels into an `LLMError` subclass carrying
`code` (stable, matchable) and `retryable` (bool):

```
LLMAuthenticationError    LLM_AUTHENTICATION_ERROR  not retryable   (401)
LLMPermissionDeniedError  LLM_PERMISSION_DENIED     not retryable   (403)
LLMBadRequestError        LLM_BAD_REQUEST           not retryable   (400/422)
LLMNotFoundError          LLM_NOT_FOUND             not retryable   (404)
LLMInvalidResponseError   LLM_INVALID_RESPONSE      not retryable
LLMRateLimitError         LLM_RATE_LIMIT            retryable       (429)
LLMTimeoutError           LLM_TIMEOUT               retryable
LLMConnectionError        LLM_CONNECTION_ERROR      retryable
LLMServerError            LLM_SERVER_ERROR          retryable       (5xx)
LLMOutputTruncatedError   LLM_OUTPUT_TRUNCATED      retryable
LLMAPIError               LLM_API_ERROR             inferred from status
```

`LLMOutputTruncatedError` is not hypothetical: it was observed repeatedly in the
translation benchmarks. A reasoning model emits its thinking first and that thinking
is billed against the output budget, so a budget sized only for the answer produces
`finish_reason="length"` with **empty content**. `deepseek-flash` — the provider this
task must benchmark against — is such a model.

## Existing patterns to follow, not reinvent

* **Token estimation**, `app/context/budget.py`: `estimate_tokens(text)` counts CJK
  at 1.5 tokens/char and everything else at 1 token per 3.5 chars — deliberately
  pessimistic, in the safe direction. `truncate_to_tokens(text, n)` cuts at a
  sentence or word boundary. `DEFAULT_CONTEXT_BUDGET = 16000`,
  `DEFAULT_OUTPUT_ALLOWANCE = 4000` (measured: a reasoning model spent 950–1500
  tokens thinking on a realistic prompt; at a 1200-token allowance it returned
  nothing at all).
* **Structured output**, `app/context/pipeline.py`: one parse, then at most **one**
  repair attempt (`repair_attempts_left = 1`) whose message shows the model the
  parse error and its previous reply; JSON extracted from a fenced or embedded
  block as a fallback. Truncation is a distinct branch, not a parse failure.
* **Evidence validation**, `app/context/evidence.py`: `EvidenceValidator` with
  `filter_ids` (drops ids that name no real paragraph, counts them in
  `dropped_ids`), `snippet_is_supported`, and `normalize_for_matching` (NFKC,
  dash-folding, whitespace-folding, casefold) — lenient about honest variation,
  strict about invention.
* **Prompt versioning**, `app/context/prompts.py`: `PROMPT_VERSION` /
  `TRANSLATION_PROMPT_VERSION` constants, bumped when the wording changes what the
  model is asked to produce. Delimited envelopes (`=== TARGET SOURCE TEXT ===`) with
  an explicit instruction that reference material is not to be translated or quoted.
* **API**, `app/api/documents.py`: `POST /api/documents/{id}/retrieve` exists; errors
  use `error_response(status, code, message)`; request bodies are pydantic models
  with `extra="forbid"` so an unknown field is a 422 rather than a silent ignore.
* **Tests**: `backend/tests/conftest.py` gives every test a `Settings` pointed at
  `tmp_path`, an autouse in-memory keyring, and an autouse socket guard that fails
  any non-loopback connection. The suite must run **offline**.

## The real provider

The benchmark provider is the user's existing configured profile: `Deepseek` /
`deepseek-flash`. It is already in the application database and must be reached
through the existing `ProfileStore` → `to_provider_config` → `resolve_provider`
path. Do not add a provider, and never read, print or persist credentials.

# Your deliverable

`docs/acceptance/DS-QA-002.md` with P0 (must) / P1 (should) / P2 (optional)
criteria. Each criterion needs a verifiable assertion, not a description.

You must explicitly decide and justify:

1. **What constitutes sufficient evidence?** A BM25 score is not calibrated
   semantic confidence. Be specific about what signal the system may use, and say
   plainly what it may not.
2. **When must the system return INSUFFICIENT_EVIDENCE?** Including the empty-bundle
   case, which must not cost a provider call.
3. **Is PARTIAL a separate answerability state, or a flavour of ANSWERED?** Decide,
   and define what a partial answer must contain — the fragment it could support and
   an explicit statement of what it could not.
4. **What citation requirement applies to each substantive claim?** Whether one
   citation blob at the end is acceptable, or whether claim-level association is
   required, and how that is verified mechanically rather than judged.
5. **What false-answer rate on deliberately unanswerable questions is acceptable?**
   Give a number, and say what happens when it is exceeded.

Cover at least these, in whatever structure you judge best:

evidence-only answering · abstention · no answer without evidence · the four scopes
preserved end to end · evidence IDs · citation validation · nonexistent IDs ·
duplicate citations · page / paragraph / section resolution · bbox readiness ·
unsupported-claim handling · partial answers · Chinese question against an English
paper with a Chinese answer · answer language · citation placement · malformed,
truncated and empty model output · provider 401/403, 429, 5xx, timeout · bounded
retry and bounded repair · no citation, page or quotation hallucination ·
prompt injection from paper text · prompt injection from the question · token,
evidence and answer-length budgeting · deterministic tests · a real-provider
benchmark with answerable / partially answerable / unanswerable questions ·
citation correctness · source support · no translation regression · no DocumentIR
mutation · privacy and logging.

# Constraints you must respect

* **Do not require embeddings or a vector database.** DS-QA-001's lexical misses are
  the premise of this task, not a defect to fix inside it. The question here is what
  happens *when* retrieval is insufficient.
* **No new LLM abstraction.** Reuse the provider layer as it stands.
* **No frontend, no sidebar, no conversation persistence, no multi-turn memory.**
* **Do not cite `DocumentAnalysis.summary` as paper truth.** It is model-generated.
  Glossary and acronyms may aid retrieval or orientation; they are not evidence.
* **Page numbers never come from the model.** The application resolves them.
* The application database table set is pinned by two guard tests
  (`documents`, `profiles`, `schema_version`, `translation_tasks`). Derived artifacts
  live in the document directory (`ir.json`, `analysis.json`, `search.db`,
  `mono.pdf`, `dual.pdf`). If you need persistence, say where it goes.
* A PDF is untrusted input. So is the question. Instructions inside either must not
  control the model.
* Assume the benchmark paper is **ResNet** — a paper the model certainly knows from
  pretraining. A correct answer therefore does not prove grounding, and a test must
  distinguish the two.

Answer the five questions above explicitly. Where you disagree with this brief, say
so and say why.
