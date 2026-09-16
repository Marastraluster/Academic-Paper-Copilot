# ARCHITECTURE.md — Academic PDF Copilot

- **Status:** Phase 1 baseline
- **Date:** 2026-09-15
- **Grounded in:** `docs/REPO_AUDIT.md` (commit `c0fa967` of PDFMathTranslate)
- **Supersedes:** none

## 1. Product in one sentence

A local-first desktop reader that opens a PDF, produces a lossless translated copy and a
bilingual copy without ever touching the original, and hosts an AI assistant that can answer
questions about the paper with citations that jump to the source page.

## 2. Non-negotiable principles

These are architectural invariants, not aspirations. Each maps to a place where it can be
violated.

| Principle | Enforced by |
|---|---|
| **Original PDF is immutable** | The kernel opens the source `"rb"` and only writes *new* files (`REPO_AUDIT` §1). Our API never opens a user file in a writable mode. |
| **Do not rebuild PDFMathTranslate** | ADR-001: pinned dependency + thin adapter |
| **Formula safety > translation completeness** | Placeholder validator; on repeated failure, fall back to source text rather than emit corrupted output |
| **Terminology consistency > literal translation** | Glossary is a cache-key component and a prompt input |
| **Translation and Paper QA share Document Intelligence** | One `DocumentContext` store; no second PDF parse |
| **User owns endpoint, model, key** | Provider profiles; no hardcoded service |
| **Chat Completions and Responses are first-class** | Both protocols behind one `LLMProvider` |
| **Local-first / privacy-first** | Parsing, OCR, layout, DB, retrieval, rendering all local; only text destined for translation/QA leaves the machine |

## 3. System topology

```
┌──────────────────────────────────────────────────────────────┐
│  Desktop shell (Phase 12: Tauri v2)                          │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Frontend — React + TS + Vite + PDF.js + Zustand       │  │
│  │  Reader workspace · AI sidebar · Settings · Glossary   │  │
│  └───────────────────────┬────────────────────────────────┘  │
│                          │ HTTP + SSE (localhost only)        │
│  ┌───────────────────────┴────────────────────────────────┐  │
│  │  Backend — FastAPI + SQLite              (sidecar)     │  │
│  │                                                        │  │
│  │   api/          HTTP + SSE surface                     │  │
│  │   llm/          Provider layer (Chat/Responses/Auto)   │  │
│  │   document/     Document Intelligence                  │  │
│  │   context/      Glossary · ContextBuilder · Validator  │  │
│  │   translation/  TranslationTask orchestration          │  │
│  │   paper_qa/     Retrieval + grounded answering         │  │
│  │   security/     Credential store (keyring)             │  │
│  │   pdfkernel/    ► ADAPTER to PDFMathTranslate          │  │
│  └───────────────────────┬────────────────────────────────┘  │
└──────────────────────────┼───────────────────────────────────┘
                           │ in-process Python call (pinned dep)
                  ┌────────┴─────────┐
                  │ PDFMathTranslate │  AGPL-3.0 — see ADR-002
                  │  fast kernel     │
                  └──────────────────┘
```

Phase 1-11 build the **localhost web MVP** (brief §26). Tauri is Phase 12 only, and
`cargo` is not installed on the current machine.

## 4. Layer contracts

### 4.1 `pdfkernel/` — the only module allowed to import `pdf2zh`

Isolating the upstream dependency behind one package is what makes ADR-001's pin-and-upgrade
strategy real. No other module may `import pdf2zh`.

```python
@dataclass(frozen=True)
class TranslationRequest:
    document_id: str
    source_path: Path          # never opened for write
    output_dir: Path
    lang_in: str
    lang_out: str
    profile: ProviderProfile   # endpoint/model/protocol/key-alias
    glossary: Mapping[str, str]
    document_context: DocumentContext | None
    engine: Literal["fast"]    # "precise" deferred (ADR-001)
    context_mode: Literal["off", "standard", "deep"]

@dataclass(frozen=True)
class TranslationResult:
    mono_path: Path            # N pages, translated only
    dual_path: Path            # 2N pages, interleaved
    page_count: int
    failed_blocks: list[FailedBlock]
```

Rules this layer must obey (each from a specific audit finding):

1. Call `high_level.translate` with **explicit keyword arguments**. Never `**locals()` —
   `translate_stream` propagates it implicitly (`REPO_AUDIT` §9).
2. **Never** use `ConfigManager` for credentials; pass `envs` per call and keep the process
   environment clean (`REPO_AUDIT` §16).
3. Run in a **worker thread or process**, never on the asyncio event loop — the kernel API
   is synchronous and blocking, and the ONNX model is a process-global singleton
   (`REPO_AUDIT` §9, §11).
4. Register `glossary_hash`, `document_context_hash`, and `prompt_version` as cache impact
   parameters **before** the first translation of a document (`REPO_AUDIT` §12).
5. Lazy-import the kernel so FastAPI can boot without loading ONNX/OpenCV.

### 4.2 Provider layer (`llm/`)

One interface, two protocols, one normalization boundary (brief §46, §50).

```python
class LLMProvider(Protocol):
    async def generate(self, req: GenerateRequest) -> LLMResult: ...
    async def translate(self, text: str, ctx: TranslationContext | None) -> LLMResult: ...
    async def test_connection(self) -> ConnectionReport: ...

@dataclass(frozen=True)
class LLMResult:
    text: str
    model: str
    protocol: str          # "chat_completions" | "responses"
    usage: dict | None
```

- `chat_completions.py` and `responses.py` are peers; nothing above them may depend on a
  protocol-specific response shape.
- **Protocol detection is cached per profile** and runs only on save or explicit
  `Test Connection` — never per translation block (brief §49).
- Retry policy is owned here, not upstream: exponential backoff on 429 / 5xx / timeout /
  network; **no retry** on 401 / 403 / invalid-model / invalid-request (brief §51).
  Upstream retries *only* 429 up to 100 times (`REPO_AUDIT` §3), so the adapter must not
  simply inherit that behaviour.
- Base URL is used **verbatim**. If it looks like it is missing `/v1`, we *warn*; we never
  rewrite it (brief §48).

### 4.3 Document Intelligence (`document/`)

Single source of truth for structure (brief §33). Translation and Paper QA both read from
it; neither re-parses the PDF.

```
Document
├── metadata          title, authors, year, domain
├── pages[]           page_number, section_id, text
├── sections[]        id, title, level, page_range, summary
├── paragraphs[]      paragraph_id, page_number, section_id, text
├── figures[]/tables[]/captions[]
├── glossary / acronyms / named_entities
├── document_summary
└── page_mapping      paragraph_id → page_number  (for citations)
```

Built **once** per document, cached in SQLite, keyed by content hash. This is also what makes
citations work: `PageMapping` is why an answer can cite `p.6 Method` and have the reader jump
there (brief §32, §60).

### 4.4 Context Engine (`context/`)

Three parts:

- **`glossary.py`** — precedence `Locked user term > Document glossary > AI decision`
  (brief §40). Serialised to a stable hash for the cache key.
- **`builder.py`** — assembles the per-block prompt context. Modes: `off` (upstream
  behaviour), `standard` (summary + glossary + section + neighbours), `deep` (+ section
  summary, cross-section terminology). `standard` is the default; `deep` is opt-in.
  Only the **target paragraph's translation** is ever returned (brief §38).
- **`placeholder_validator.py`** — compares the `{vN}` sequence of source and translation.

> **Verified format correction.** The live placeholder is **single-brace `{vN}`**
> (`converter.py:275`, matched `:411`). The brief's `{{v0}}` / `<b0>` forms come from helper
> methods that are **dead code** — never called anywhere in the repository
> (`REPO_AUDIT` §2.1). The validator targets `{vN}`.

Failure policy: first mismatch → retry; second mismatch → **keep the source text** and record
a `TranslationError`. Never emit a corrupted formula.

### 4.5 Translation task system (`translation/`)

Long translations cannot be a blocking request (brief §64, §65).

```
PENDING → ANALYZING → TRANSLATING → RENDERING → SUCCESS
                                    ↘ FAILED / CANCELLED
```

Progress is streamed over **SSE**. Honest granularity note: upstream reports progress per
**page** and checks cancellation once per page (`high_level.py:123`) — so our per-block
counts must come from our own instrumentation, and the cancel button cannot interrupt
mid-page work. We will report what is actually true rather than imply finer control.

### 4.6 Paper QA (`paper_qa/`)

Retrieval-first, not stuff-the-whole-PDF (brief §55-§61).

```
Question → query rewrite → SQLite FTS5 / BM25 → relevant chunks
         → document context → LLM → answer + citations
```

- **No vector database in v1** (brief §59).
- Answers are grounded **only** in retrieved evidence. Insufficient evidence yields
  *"当前论文上下文中没有找到足够信息。"* — never a fabrication (brief §61).
- Result is structured, not a bare string:

```json
{ "answer": "...", "citations": [{ "page": 6, "section": "3.2 Policy Learning" }] }
```

### 4.7 Security (`security/`)

- API keys live in the **OS credential store** via `keyring` (Windows Credential Manager).
  SQLite stores only an alias. The frontend only ever receives `sk-••••••••ab12`.
- Keys must never reach git, logs, stack traces, task files, or plain frontend storage
  (brief §53).
- Upstream's plaintext `ConfigManager` is **unusable** for this and is not used
  (`REPO_AUDIT` §16).

## 5. How the Context Engine attaches without forking (key design decision)

The pipeline reaches the translator at exactly one place that matters:
`converter.py:353`, `self.translator.translate(s)`, inside a thread pool. The translator
receives **only text** — no page, no section, no document (REPO_AUDIT §6).

Two options were evaluated:

**(a) Thread a `context_provider` through upstream** — 4 files, ~10 lines. Gives exact
per-block page identity. Requires editing upstream, which ADR-001 forbids.

**(b) Subclass + immutable context map (chosen).** `TranslateConverter` already constructs the
translator with `envs=envs` (`converter.py:166`). We supply a translator subclass that
receives an **immutable, document-scoped context map at construction** and resolves context by
**source-text key** inside `translate()`. Zero upstream edits. Thread-safe because the map is
built before the pool starts and only ever read.

```
Document Intelligence ──builds──► {source_text: BlockContext}  (frozen)
                                          │
                        TranslateConverter.__init__(envs=…)
                                          │
                                 ContextTranslator
                                          │
                    ThreadPoolExecutor ───┴─── translate(s) → ctx = map.get(s)
```

**Known limitation:** text-keyed lookup is ambiguous if the same paragraph string appears on
two pages. Acceptable because glossary and document summary are document-scoped. If byte-exact
per-block page attribution is later required, we escalate to a documented patch series
(ADR-001 escalation rule).

## 6. Data model (SQLite)

```
documents        id, path, sha256, title, domain, page_count, created_at
pages            document_id, page_number, section_id, text
sections         document_id, section_id, title, level, start_page, end_page, summary
paragraphs       document_id, paragraph_id, page_number, section_id, text
glossary         document_id, source_term, target_term, locked, origin
profiles         id, name, base_url, model, protocol, temperature, max_tokens,
                 timeout, concurrency, streaming, secret_ref   -- no key material
translation_tasks id, document_id, status, progress, error, created_at
chat_sessions    id, document_id, title
chat_messages    id, session_id, role, content, citations_json, created_at
chunks_fts       FTS5 virtual table over paragraph text   -- BM25 retrieval
```

`profiles.secret_ref` is deliberately a pointer, never a secret.

## 7. Deliberate deferrals

| Deferred | Why |
|---|---|
| Tauri packaging (Phase 12) | No `cargo` on this machine; also brief §26 says don't start there |
| `precise` kernel | Requires an uninitialised second repo + isolated venv (`REPO_AUDIT` §13) |
| Vector database | FTS5 + BM25 is sufficient for v1 (brief §59) |
| Tesseract OCR on mixed pages | Upstream handles image-only pages; partial scans are a known gap |
| Dark theme | Light ships first (brief §74) |
| Cross-page paragraph context | Strategy (b) is page-local; neighbours are resolved within the page |

## 8. Traceability — audit finding → architectural consequence

| Audit finding | Where it lands |
|---|---|
| §2.1 placeholders are `{vN}`, helpers are dead code | §4.4 validator targets `{vN}` |
| §3 upstream retries only 429 | §4.2 we own retry |
| §6 context unreachable from `worker()` | §5 strategy (b) |
| §9 sync API + global ONNX singleton | §4.1 rule 3 |
| §12 cache is document-agnostic | §4.1 rule 4 |
| §13 precise kernel unavailable | §7 deferred |
| §15 use original + mono for side-by-side | Reader sync is a 1:1 page map |
| §16 plaintext credentials upstream | §4.7 keyring |
| §19 AGPL-3.0 + PyMuPDF AGPL | ADR-002, Phase 12 gate |
