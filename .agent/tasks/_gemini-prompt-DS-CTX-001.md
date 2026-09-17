You are the independent Acceptance Criteria author for a local-first academic PDF
reader + bilingual translator ("Academic PDF Copilot").

Define objective P0 / P1 / P2 acceptance criteria for the next task.

**Do NOT write production code.** Return acceptance criteria only.

---

# TASK — DS-CTX-001: Academic Context Foundation

Build the first **AI-derived semantic layer** on top of the canonical Document IR:
document analysis, hierarchical summarisation, section summaries, academic domain
inference, glossary candidates, acronyms, named entities, provenance, invalidation,
persistence, and a `ContextBuilder` for future translation.

This task must **NOT** modify the PDF translation kernel, its prompt, or its output.
That integration is a separate, later task.

## Where the project is now

The first usable-client milestone is complete, and so is the canonical document
structure it rests on. All of this works today and **must not be redesigned**:

```
Open PDF → Read → Translate → Read translation → Bilingual side by side
```

Verified baselines:

```
backend   560 passed
frontend   75 passed
```

---

# VERIFIED GROUND TRUTH (measured in this repository — treat as authoritative)

## The canonical Document IR (DS-DOC-001, validated on a real paper)

A source PDF becomes one structured representation that every later feature reads
from. It describes the **source document only** — it has no field for translated
text, answers, or embeddings, and that separation is deliberate.

```python
DocumentIR:
    document_id: str
    content_hash: str          # sha256 of the source PDF
    source_filename: str
    page_count: int
    metadata: DocumentMetadata # title, authors, subject, keywords, creator,
                               # producer, creation_date — every field nullable
    sections: list[SectionIR]
    pages: list[PageIR]
    paragraphs: list[ParagraphIR]
    page_mapping: dict[str, int]   # paragraph_id -> 1-based page number
    has_text_layer: bool
    ocr_required: bool

PageIR:       page_index (0-based), page_number (1-based), width_pt, height_pt,
              rotation, has_text, blocks: list[TextBlockIR]

TextBlockIR:  id, page_index, page_number, layout_class, bbox, text,
              font_size, caption_of

SectionIR:    id, title, level (int|None), page_range, parent_id, is_references

ParagraphIR:  id, section_id (str|None), text, page_number, page_range,
              block_ids: list[str], bboxes, is_abstract
```

**Two distinctions the IR enforces, and which any new layer must respect:**

* **`page_index` (0-based) vs `page_number` (1-based)** are separate named fields.
  The bare word `page` is banned as a field name. Citations are 1-based.
* **`TextBlock` is physical; `Paragraph` is semantic.** A block is a rectangle a
  vision model found. A paragraph is prose assembled from one or more blocks,
  possibly across columns and pages.

`layout_class` is one of exactly ten values from the DocLayout-YOLO model:
`title`, `plain text`, `abandon`, `figure`, `figure_caption`, `table`,
`table_caption`, `table_footnote`, `isolate_formula`, `formula_caption`.

**`abandon` blocks are running headers, footers and page stamps. They are retained
in `PageIR.blocks` for coordinates but are excluded from every paragraph.** They
must never reach an LLM prompt or a retrieval corpus.

**Identity and reading order are already resolved.** `paragraphs` are in canonical
reading order; neighbouring paragraphs in that list are genuinely adjacent in the
document. Two-column papers read column-wise, not interleaved — verified on ResNet
(arXiv:1512.03385, 12 pages): zero column-confined blocks appear after their column
has ended.

## How the IR is persisted

**There is no SQLite table for it, deliberately.** The IR is a file:

```
<documents_dir>/<document_id>/ir.json      alongside source.pdf, mono.pdf, dual.pdf
```

`tests/test_db.py` pins the database's table set to **exactly**
`["documents", "profiles", "schema_version", "translation_tasks"]` and names
`pages`, `sections`, `paragraphs`, `glossary`, `chunks_fts` as forbidden. A test
exists specifically to catch a speculative table appearing for a phase that has not
started. `SCHEMA_VERSION` is 3.

Writes are atomic (sibling temp file + `os.replace`); a failed write leaves no
partial file. Extraction is lazy on first read and cached: a cached read is under
50 ms and never invokes the model. Extraction runs off the event loop via
`asyncio.to_thread`, and per-document locks stop two readers both running it.

Existing endpoints:

```
GET  /api/documents/{id}/ir             full IR (extracts lazily on first read)
GET  /api/documents/{id}/sections       outline
GET  /api/documents/{id}/page-mapping   paragraph_id -> 1-based page
POST /api/documents/{id}/extract-ir     explicit trigger, {force} re-runs
GET  /api/documents/{id}                metadata
GET  /api/documents/{id}/translated     mono artifact
```

## The LLM layer — reuse it, do not add another

This is the abstraction boundary and it is already complete:

```python
class LLMProvider(ABC):
    async def generate(self, request: LLMRequest) -> LLMResult
    async def test_connection(self) -> ConnectionReport
    async def generate_stream(self, request: LLMRequest) -> AsyncIterator[str]

LLMRequest(messages: list[ChatMessage], temperature: float|None,
           max_output_tokens: int|None, timeout_s: float|None)
ChatMessage(role: Literal["system","user","assistant"]|str, content: str)

LLMResult(text: str, model: str|None, protocol: str, usage: LLMUsage|None)
LLMUsage(prompt_tokens, completion_tokens, total_tokens)

ProviderConfig(base_url, api_key: SecretStr, model, timeout_s, temperature,
               max_output_tokens, custom_headers)
```

`resolve_provider(config, protocol)` returns a provider, handling protocol
auto-detection (`chat_completions` / `responses`) with a cache.

Error hierarchy, already normalised — **no SDK exception ever reaches a caller**:

```
LLMAuthenticationError   LLM_AUTHENTICATION_ERROR   (401)
LLMPermissionDeniedError LLM_PERMISSION_DENIED      (403)
LLMBadRequestError       LLM_BAD_REQUEST
LLMNotFoundError         LLM_NOT_FOUND              (unknown model / bad base URL)
LLMInvalidResponseError  LLM_INVALID_RESPONSE
LLMRateLimitError        LLM_RATE_LIMIT             retryable
LLMTimeoutError          LLM_TIMEOUT                retryable
LLMConnectionError       LLM_CONNECTION_ERROR       retryable
LLMServerError           LLM_SERVER_ERROR           retryable
LLMAPIError                                         fallback
```

Each carries `.message` and `.retryable`. `sanitize_message(text, api_key)` strips a
key literal before anything is logged or returned.

Provider profiles live in SQLite (`profiles` table) with the **credential in the OS
keyring**, referenced by an opaque `credential_ref`. `GET /api/profiles` returns
`has_key: bool` and `api_key_masked` and **has no key-bearing field at all**.

**A keyless profile is a fully supported configuration** (local OpenAI-compatible
servers). Nothing may require an API key to be present.

**Failure is already bounded** (DS-BE-FIX-002). A previous defect let a provider
failure retry effectively forever; that is fixed and must not be reintroduced in a
new layer. `LLMRequest.max_output_tokens` and `timeout_s` exist; a caller supplying
neither gets the provider's configured defaults.

## Conventions this project enforces by test

* **No speculative tables.** See above — this is the single strictest storage rule.
* **No secret in any response, log, or persisted record.** Tests assert this across
  the existing surfaces.
* **No filesystem path in any HTTP response.**
* **Honest uncertainty over invented structure.** This principle has governed every
  task: fabricated progress bars, fabricated retry endpoints and fabricated section
  levels were each explicitly refused.
* **Error envelope** `{"error": {"code", "message", "detail"}}` everywhere.
* `LLM_API_KEY`-style secrets are never hashed into a semantic cache key (see the
  requirements below).

---

# WHAT THIS TASK MUST BUILD

```
DocumentIR  (source truth, immutable)
     │
     ▼
DocumentAnalysisPipeline
     │
     ▼
DocumentAnalysis  (AI-derived, replaceable, rebuildable)
     ├── summary
     ├── section summaries
     ├── glossary
     ├── acronyms
     ├── entities
     └── domain
```

and a `ContextBuilder` that, given `document_id` + `paragraph_id`, produces a
**bounded** context package for future translation:

```
document_summary, section_summary, current_section, glossary,
previous_paragraph, next_paragraph
```

## Requirements the criteria must pin down

R1. **`DocumentIR` remains immutable.** No analysis output is ever written into it.
    Its paragraphs, reading order, page numbers, section ids, bboxes and
    `content_hash` must be byte-identical after analysis.
R2. **No second PDF parser.** Analysis consumes `DocumentIR`. It must not re-open the
    PDF or build a competing text representation.
R3. **Hierarchical analysis, bounded.** A 50–100 page paper must never be sent in one
    request. Sections, then chunked sections, then synthesis.
R4. **Paragraph-respecting chunk boundaries**, not arbitrary character slicing.
R5. **Explicit token budget**, with prompt overhead, input and output allowance
    accounted for. No "send until the provider rejects it".
R6. **Structured output with validation.** Important fields must not be parsed by
    regex from conversational prose. Malformed or empty output must not be persisted.
R7. **Partial failure.** One failed section must not discard the successful analysis
    of others. A clear status model (`READY` / `PARTIAL` / `FAILED` or equivalent),
    using only states the implementation genuinely distinguishes.

R8. **Provenance is mandatory**, persisted with the analysis: which document, which
    provider profile, which model, which prompt version, which pipeline version,
    when. **No API key, ever.**

R9. **Invalidation is explicit and deterministic.** Changing the model, the prompt
    version, or the source document must not silently reuse analysis generated under
    different semantics. **Changing only the API key must not invalidate.** Provider
    identity belongs in the key; credentials do not.
R10. **Rebuildable.** Deleting or regenerating analysis must never delete the source
    PDF, the IR, or translation output.
R11. **Persistence and re-opening.** Reopening an unchanged, already-analysed paper
    must load the cached analysis without calling the provider.
R12. **Glossary entries must preserve the exact source spelling** of identifiers such
    as `LeVJEPA`, `ImageNet`, `Something-Something V2`, `ResNet-50`, `VLA`. Terms
    that should not be translated must be distinguishable from terms that should.
R13. **Evidence must reference real source text.** No fabricated "source examples".
    Prefer paragraph ids over duplicated quotations.
R14. **Acronyms are extracted, never invented.** `Vision-Language-Action → VLA` where
    the long form actually appears.
R15. **Domain is an interpretation, not a fact.** `Unknown` / `Interdisciplinary` must
    be available rather than forcing a confident label.
R16. **Provider failures reuse the normalized error hierarchy**, and remain bounded.
R17. **Privacy.** Do not log paragraphs, sections, or the full paper. Operational
    logging may carry ids, counts, token counts, provider, model, latency, status.
R18. **HTTP surface stays small** and follows the existing conventions. A debug
    endpoint for context inspection is acceptable if it materially helps testing.
R19. **No frontend feature.** No glossary editor, no dashboard, no sidebar.
R20. **The translation kernel is untouched** — no change to PDFMathTranslate prompts,
    translator behaviour, paragraph translation flow, or translated output.

## Suggested analysis prompt content (the criteria should require it be versioned)

Analyse an academic paper for downstream academic translation, using **only** the
supplied source material, returning structured JSON: academic domain, concise summary,
technical terms, acronyms, named models/datasets/benchmarks, and terms whose Chinese
translation depends on document context. Preserve model names, dataset names, acronyms
and mathematical identifiers exactly. Propose rigorous Simplified Chinese translations
for glossary terms appropriate to the paper's academic context; do not translate
identifiers that should remain unchanged. Omit rather than guess where evidence is
insufficient.

## Questions the criteria should settle explicitly

1. **Is `DocumentAnalysis` one model or two?** Domain/summary/sections/entities are
   language-independent; a Chinese glossary is not. Should they be separate records
   with separate cache identities? Answer with the simplest design that does not
   contaminate language-independent understanding with one target language.
2. **Where is analysis persisted?** The IR uses a file in the document directory and
   the DB table set is pinned exactly. Is `analysis.json` the answer, or a justified
   additive migration? Justify either way against R1/R11 and the table guard.
3. **What exactly is in the cache key**, given R9? Enumerate the fields.
4. **How are sections with `section_id = None` analysed?** Some papers have poor
   structure. Chunk by page/paragraph then.
5. **How does `ContextBuilder` select glossary entries** when the glossary is large?
   Bounded strategy required.
6. **How is the context budget enforced and prioritised?** Which parts are dropped
   first when it is exceeded?
7. **Current paragraph.** `ContextBuilder` may expose metadata about the target
   paragraph, but the target text is supplied separately by the future translation
   call. How is duplicate inclusion avoided?
8. **What proves "no source quotation was fabricated"?** This must be objectively
   checkable.
9. **What is the required behaviour when the provider returns valid JSON with an empty
   analysis** versus invalid JSON?
10. **Cancellation.** If the running task infrastructure supports it, respect it at
    request/chunk boundaries — and do not claim requests were force-killed if they
    were not.

## Out of scope — do not write criteria for these

Translation-kernel integration (consuming this context) · Paper QA · embeddings ·
vector database · AI sidebar · Tauri · synchronised PDF scrolling · user glossary
editor UI · outline/sidebar frontend work.

---

# EVALUATION DIMENSIONS

Assign each P0 / P1 / P2, or state explicitly that it does not apply:

1. DocumentIR remains immutable  2. no duplicate PDF parsing  3. analysis uses the
existing IR  4. document summary quality contract  5. section summary mapping
6. glossary schema  7. glossary source-term fidelity  8. academic terminology
consistency  9. acronym extraction  10. model names  11. dataset names
12. domain inference  13. evidence/provenance  14. page references
15. paragraph references  16. missing sections  17. unknown domain  18. malformed LLM
output  19. empty LLM output  20. provider 401/403  21. provider 429  22. provider 5xx
23. timeout  24. token limits  25. very long papers  26. partial analysis failure
27. cancellation  28. analysis persistence  29. re-opening documents
30. model/provider changes  31. prompt-version changes  32. source-document changes
33. cache invalidation  34. API key secrecy  35. logging privacy  36. deterministic
mock tests  37. real-provider verification  38. no translation regression
39. no DocumentIR regression  40. performance  41. context-size limits
42. no invented source quotations

---

# OUTPUT FORMAT

Return:

1. **P0 criteria** — numbered, each objectively verifiable, each with a short rationale.
   P0 means: the task is not DONE if this fails.
2. **P1 criteria** — important, acceptable to defer with a stated rationale.
3. **P2 criteria** — desirable polish.
4. **Explicitly not applicable** — and why.
5. **Answers to the questions above** where a criterion settles them.
6. **Any premise you believe is wrong**, stated plainly — including anything in the
   ground truth above you think is a mistake, or any requirement you believe cannot be
   met while respecting the storage and isolation rules already in force.

Be specific about observable behaviour. Where deterministic verification genuinely
cannot reach a conclusion, require an honest "unknown" over a plausible guess, and say
so explicitly. Do not require any capability this project does not have.
