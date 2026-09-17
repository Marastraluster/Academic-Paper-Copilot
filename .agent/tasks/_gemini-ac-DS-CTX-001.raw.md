# DS-CTX-001: Academic Context Foundation — Acceptance Criteria Specification

**Document Role:** Independent Acceptance Criteria Author  
**Target Milestone:** Task DS-CTX-001 (AI-Derived Semantic Context Layer)  
**Baseline Status:** Backend 560 passed, Frontend 75 passed, `SCHEMA_VERSION = 3`, Database tables pinned strictly to `["documents", "profiles", "schema_version", "translation_tasks"]`.

---

## 1. P0 Criteria (Must Pass for Task Completion)

P0 criteria represent absolute blockers. If any of these fail, the task cannot be marked DONE.

### Category A: IR Invariance, Consumption & Separation

#### AC-P0-01: DocumentIR Bitwise & Semantic Immutability
* **Dimension:** 1 (DocumentIR remains immutable), 39 (No DocumentIR regression)
* **Specification:** Executing `DocumentAnalysisPipeline` against an existing document must not mutate `ir.json` on disk or any in-memory instance of [`DocumentIR`](file:///backend/models/ir.py).
* **Verification:**
  1. Load `<documents_dir>/<doc_id>/ir.json`, record its SHA-256 hash and serialized JSON AST.
  2. Run `DocumentAnalysisPipeline.run(document_id)`.
  3. Re-read `ir.json` from disk and calculate its SHA-256 hash; assert hash identity (`hash_before == hash_after`).
  4. Assert `content_hash`, `sections`, `paragraphs`, `pages`, `page_mapping`, `metadata`, and bounding boxes in memory are strictly identical.
* **Rationale:** R1 & R20. The IR is the source of truth for physical and layout structure. Context derivation is downstream and ephemeral; polluting the IR couples layout extraction to LLM semantics.

#### AC-P0-02: Zero Secondary PDF Parsing
* **Dimension:** 2 (No duplicate PDF parsing), 3 (Analysis uses existing IR)
* **Specification:** The analysis pipeline must accept `DocumentIR` (or `document_id` resolving to `DocumentIR`) as its sole document input. The pipeline must not import PyMuPDF, `fitz`, PDFMiner, pypdf, or invoke DocLayout-YOLO / OCR tools.
* **Verification:**
  1. In unit tests, delete or rename `source.pdf` in the document directory after `ir.json` exists.
  2. Invoke `DocumentAnalysisPipeline.run(document_id)`.
  3. Execution must complete successfully without error, proving `source.pdf` was never opened.
  4. Static test: AST grep confirms no PDF parsing libraries are imported in `context/` or `analysis/`.
* **Rationale:** R2. Redundant text extraction creates divergent reading orders and wastes compute.

#### AC-P0-03: Header/Footer/Stamp ("Abandon" Block) Exclusion
* **Dimension:** 3 (Analysis uses existing IR)
* **Specification:** Blocks marked `layout_class == "abandon"` in `PageIR.blocks` must never be included in section chunks, summaries, entities, or glossary prompts.
* **Verification:**
  1. Construct a test `DocumentIR` containing a `TextBlockIR` with `layout_class="abandon"` and text `"CONFIDENTIAL DRAFT - PAGE 1"`.
  2. Trigger analysis with a mock provider recording all outgoing prompt contents.
  3. Assert substring `"CONFIDENTIAL DRAFT - PAGE 1"` appears 0 times across all outgoing LLM requests.
* **Rationale:** Running headers, page stamps, and footers corrupt summarization and generate spurious acronyms/terms.

---

### Category B: Extraction Fidelity, Provenance & Evidence

#### AC-P0-04: Strict Evidence Anchor via Paragraph IDs (No Invented Citations)
* **Dimension:** 13 (Evidence/provenance), 15 (Paragraph references), 42 (No invented source quotations)
* **Specification:** Every extracted acronym, technical term, named entity, and section summary must cite evidence exclusively through valid `paragraph_ids: list[str]`. If an extraction includes an optional verbatim snippet, it must be validated via strict substring containment: `snippet in ir.get_paragraph(pid).text`.
* **Verification:**
  1. Pass an LLM mock response that includes an acronym citing a non-existent `paragraph_id="para-fake-999"`. Assert validator rejects or drops the item.
  2. Pass an LLM mock response where `snippet` contains text not present in `ir.paragraphs["para-real-1"].text`. Assert validator raises `EvidenceValidationError` or sanitizes the fabricated snippet.
  3. Validate on real papers: 100% of persisted glossary and entity `paragraph_ids` resolve to real keys in `ir.page_mapping`.
* **Rationale:** R13, Dimension 42. LLMs hallucinate quotes; anchoring strictly to immutable IR paragraph IDs guarantees factual provenance.

#### AC-P0-05: Exact Source-Spelling Preservation
* **Dimension:** 7 (Glossary source-term fidelity), 10 (Model names), 11 (Dataset names)
* **Specification:** Extracted technical terms, model identifiers (`ResNet-50`, `LeVJEPA`, `VLA`), datasets (`ImageNet`, `Something-Something V2`), and benchmarks must preserve exact case, hyphenation, and punctuation as they appear in the source paragraph.
* **Verification:**
  1. Provide a paragraph containing `"We benchmarked LeVJEPA and ResNet-50 on Something-Something V2."`
  2. Run extraction.
  3. Assert extracted entities have `term == "LeVJEPA"`, `term == "ResNet-50"`, `term == "Something-Something V2"`.
  4. Assert terms are marked `is_translatable = False`.
* **Rationale:** R12. Translating or case-normalizing proper technical identifiers destroys downstream technical translation accuracy.

#### AC-P0-06: Acronym Extraction from Explicit Ground Truth Only
* **Dimension:** 9 (Acronym extraction)
* **Specification:** An acronym entry `AcronymEntry(acronym, expansion, paragraph_id)` is valid if and only if both the acronym and its expanded definition co-occur within the referenced paragraph (or adjacent paragraph). The system must never guess expansions from pre-trained parametric memory.
* **Verification:**
  1. Input paragraph: `"We introduce Vision-Language-Action (VLA) models."` -> Successfully extracts `VLA -> Vision-Language-Action`.
  2. Input paragraph: `"We evaluate our method on standard VLA benchmarks."` (no expansion provided) -> System must NOT invent `"Vision-Language-Action"` for that paragraph; it must record expansion as `None` or omit it.
* **Rationale:** R14. False acronym expansions ruin domain-specific translations.

#### AC-P0-07: Domain Inference with Explicit Uncertainty
* **Dimension:** 12 (Domain inference), 17 (Unknown domain)
* **Specification:** The `domain` field must conform to `AcademicDomain(primary: str, secondary: list[str], confidence: float, rationale: str)`. When evidence is insufficient, the system must emit `"Unknown"` or `"Interdisciplinary"` with `confidence < 0.5`.
* **Verification:**
  1. Feed a 1-page paper with ambiguous text.
  2. Verify that when LLM returns low confidence, `primary` is set to `"Unknown"` or `"Interdisciplinary"`.
  3. Assert the system never crashes on unclassifiable domains and does not hallucinate a random field (e.g. forced `"Computer Science"`).
* **Rationale:** R15, Dimension 17. Honest uncertainty over invented structure.

#### AC-P0-08: Universal Page Numbering Rule (1-Based, Bare `page` Banned)
* **Dimension:** 14 (Page references)
* **Specification:** All analysis data models and JSON outputs must use `page_number: int` (1-based). The bare field name `page` is strictly prohibited across all context schemas.
* **Verification:**
  1. Serialize `DocumentAnalysis` to JSON schema.
  2. Assert `"page"` is not a key in any dictionary or Pydantic model field definition.
  3. Assert `page_number >= 1` for all references.
* **Rationale:** Core ground-truth distinction. Prevents off-by-one errors between internal indexes and PDF viewer pages.

---

### Category C: Hierarchical Processing & Unstructured Papers

#### AC-P0-09: Paragraph-Preserving Chunking within Hard Token Budgets
* **Dimension:** 24 (Token limits), 25 (Very long papers)
* **Specification:** Chunking for section analysis and synthesis must respect paragraph boundaries. No paragraph may be sliced across characters or words. Each chunk must strictly respect:
  $$\text{Tokens}(\text{prompt\_overhead}) + \text{Tokens}(\text{chunk\_paragraphs}) + \text{max\_output\_tokens} \le \text{ProviderConfig.context\_window}$$
* **Verification:**
  1. Feed a 60-page paper (e.g. ResNet or 100-page survey) to `DocumentAnalysisPipeline`.
  2. Verify that every chunk sent to the LLM begins at the start of a `ParagraphIR` and ends at the conclusion of a `ParagraphIR`.
  3. Verify no LLM call exceeds the configured token budget.
* **Rationale:** R3, R4, R5. Arbitrary character slicing splits equations, acronyms, and sentences.

#### AC-P0-10: Robust Handling of Missing or Malformed Sections
* **Dimension:** 16 (Missing sections)
* **Specification:** When `SectionIR` is absent or paragraphs have `section_id is None`, the pipeline must group contiguous unsectioned paragraphs into synthetic section partitions bounded by page ranges and token limits (e.g., `synthetic_chunk_p1_p3`).
* **Verification:**
  1. Provide a `DocumentIR` with `sections = []` and 20 paragraphs spanning 4 pages.
  2. Execute analysis.
  3. Assert analysis completes with `status = "READY"`.
  4. Assert synthetic sections exist, mapping all paragraphs to summaries with valid 1-based page numbers.
* **Rationale:** Question 4, R3. Real-world PDFs frequently lack clean outline metadata.

---

### Category D: Failure Handling, Boundedness & Resilience

#### AC-P0-11: Reuse of Normalized LLM Error Hierarchy
* **Dimension:** 20 (Provider 401/403), 21 (Provider 429), 22 (Provider 5xx), 23 (Timeout)
* **Specification:** The pipeline must catch and handle existing normalized errors from `LLMProvider`:
  - `LLMAuthenticationError` (401) & `LLMPermissionDeniedError` (403) -> Fail immediately, no retry, set status `FAILED`.
  - `LLMRateLimitError` (429) -> Retry with exponential backoff up to max 3 attempts.
  - `LLMServerError` (5xx) & `LLMTimeoutError` -> Retry bounded (max 2 attempts).
  - No raw SDK exception (`openai.*`, `httpx.*`) may escape the pipeline boundary.
* **Verification:**
  1. Mock provider returning 401: pipeline immediately raises `AnalysisError` with code `LLM_AUTHENTICATION_ERROR` and performs exactly 1 call.
  2. Mock provider returning 429: pipeline retries up to 3 times with backoff, then marks status `FAILED` with code `LLM_RATE_LIMIT`.
* **Rationale:** R16. Failure must remain bounded; infinitely looping retries are strictly prohibited.

#### AC-P0-12: Structured Output Validation & Empty/Malformed Response Handling
* **Dimension:** 18 (Malformed LLM output), 19 (Empty LLM output)
* **Specification:** Analysis output must be validated via Pydantic.
  - If output is unparseable JSON: retry once with schema correction; if still invalid, fail section.
  - If output is valid JSON but empty (e.g. `{"summary": ""}`, `{"terms": []}` on a 10-page text): validator raises `AnalysisValidationError`.
  - Empty or malformed output must never be persisted as valid analysis.
* **Verification:**
  1. Mock returns `"```json\n{malformed"` -> Pipeline catches parse error, retries once, records failure without writing corrupt `analysis.json`.
  2. Mock returns `{"summary": "   ", "domain": ""}` -> Pydantic validator fails; pipeline refuses to save `READY` analysis.
* **Rationale:** R6, Question 9. Prevent silent database/file corruption with vacuous data.

#### AC-P0-13: Granular Partial Failure Model (`READY`, `PARTIAL`, `FAILED`)
* **Dimension:** 26 (Partial analysis failure)
* **Specification:** If 1 out of 8 sections fails after retries, the pipeline must not discard the other 7 sections. The document analysis must be saved with status `PARTIAL`, containing successful section summaries and a clear `errors: list[AnalysisErrorRecord]` field identifying the failed section.
* **Verification:**
  1. Simulate 5 sections, where section 3 fails with `LLMServerError`.
  2. Pipeline finishes and writes `analysis.json`.
  3. Assert `analysis.status == "PARTIAL"`.
  4. Assert sections 1, 2, 4, and 5 have valid summaries.
  5. Assert document-level summary explicitly notes partial synthesis.
* **Rationale:** R7. Expensive LLM extraction must not be thrown away due to a single section timeout.

#### AC-P0-14: Graceful Task Cancellation at Chunk Boundaries
* **Dimension:** 27 (Cancellation)
* **Specification:** When an analysis task is cancelled via `asyncio.CancelledError` or task manager cancellation, the pipeline must terminate at the current chunk/request boundary. It must not dispatch further HTTP calls and must not leave a corrupted `analysis.json` on disk.
* **Verification:**
  1. Start analysis on a multi-chunk document.
  2. Cancel the task while chunk 1 is in-flight or immediately after chunk 1 completes.
  3. Verify chunk 2 is never dispatched to the LLM provider.
  4. Verify that no partial or corrupt `analysis.json` is left on disk.
  5. Verify task status is reported as `CANCELLED`, not `FAILED` or `READY`.
* **Rationale:** Question 10. Honest cancellation reporting without orphaned requests.

---

### Category E: Storage, Atomic Persistence & Schema Boundaries

#### AC-P0-15: Zero Speculative SQLite Tables (Persistence to `analysis.json`)
* **Dimension:** 28 (Analysis persistence), 39 (No DocumentIR regression)
* **Specification:** Analysis must be persisted to `<documents_dir>/<document_id>/analysis.json`. Absolutely no new SQLite tables (e.g., `analysis`, `glossary`, `sections_summary`) may be added to SQLite.
* **Verification:**
  1. Run `tests/test_db.py`.
  2. Verify the test asserting that database tables match **exactly** `["documents", "profiles", "schema_version", "translation_tasks"]` continues to pass.
  3. Verify `SCHEMA_VERSION` remains 3.
* **Rationale:** R11, Ground Truth. Strictly enforced storage convention. Adding tables breaks existing schema regression tests.

#### AC-P0-16: Atomic Disk Writes
* **Dimension:** 28 (Analysis persistence)
* **Specification:** Persistence of `analysis.json` must use atomic writes via a sibling temporary file (`analysis.json.tmp.<uuid>`) followed by `os.replace`.
* **Verification:**
  1. Inject an I/O crash or exception midway through writing `analysis.json.tmp`.
  2. Assert that existing `analysis.json` (if present) remains completely intact and no corrupt file is loaded on subsequent reads.
* **Rationale:** R10, R11. Guarantees zero data corruption upon unexpected power loss or process kill.

---

### Category F: Provenance, Caching & Invalidation Mechanics

#### AC-P0-17: Comprehensive Provenance Record
* **Dimension:** 13 (Evidence/provenance), 30 (Model/provider changes), 31 (Prompt-version changes)
* **Specification:** Every `analysis.json` must persist an immutable `AnalysisProvenance` block containing:
  - `document_id`: str
  - `content_hash`: str (SHA-256 of source PDF)
  - `pipeline_version`: str
  - `prompt_version`: str
  - `provider_name`: str
  - `model`: str
  - `target_language`: str (e.g. `"zh-CN"`)
  - `created_at`: str (ISO 8601 UTC timestamp)
* **Verification:**
  1. Generate analysis. Inspect serialized JSON.
  2. Assert all 8 provenance fields are populated and non-null.
* **Rationale:** R8. Required for deterministic invalidation and auditability.

#### AC-P0-18: Cache Invalidation Matrix (Strict Exclusions & Inclusions)
* **Dimension:** 30, 31, 32, 33 (Cache invalidation mechanics), 34 (API key secrecy)
* **Specification:**
  - Cache Hit: If `analysis.json` exists, has `status == "READY"`, and `(content_hash, pipeline_version, prompt_version, provider_name, model, target_language)` match exactly, return cached analysis without calling LLM.
  - Cache Invalidation: If `content_hash`, `prompt_version`, `model`, or `pipeline_version` changes, cached analysis is invalid.
  - Credential Invariance: Changing `api_key` or `credential_ref` in the provider profile must NOT invalidate the cache. The API key must never be hashed or included in the cache key.
* **Verification:**
  1. Run analysis. Verify cached read makes 0 LLM calls.
  2. Update provider profile's API key in keyring. Re-read analysis. Assert cache is HIT (0 LLM calls).
  3. Bump `prompt_version` from `"1.0"` to `"1.1"`. Re-read analysis. Assert cache is MISS and pipeline re-runs.
  4. Inspect cache key generator; assert API key string or secret ref is never an input.
* **Rationale:** R9, R11, Question 3. API key rotation must not discard expensive analysis.

#### AC-P0-19: Non-Destructive Rebuildability
* **Dimension:** 10 (Rebuildable)
* **Specification:** Forcing analysis regeneration (`POST /api/documents/{id}/extract-analysis?force=true`) or deleting `analysis.json` must never delete or alter `source.pdf`, `ir.json`, `mono.pdf`, or `dual.pdf`.
* **Verification:**
  1. Create document with `source.pdf`, `ir.json`, `mono.pdf`, `analysis.json`.
  2. Invoke forced analysis rebuild.
  3. Assert `source.pdf`, `ir.json`, and `mono.pdf` file timestamps and checksums remain untouched.
* **Rationale:** R10. Analysis is an AI-derived layer; rebuilding it must not damage underlying documents or translations.

---

### Category G: Security, Privacy & Translation Isolation

#### AC-P0-20: Total Secrecy of Credentials
* **Dimension:** 34 (API key secrecy)
* **Specification:** Under no circumstances may an API key or raw credential appear in:
  - Any field of `analysis.json`
  - Any HTTP response body
  - Any log message (enforced via `sanitize_message`)
* **Verification:**
  1. Configure provider with a dummy key `"sk-secret-key-xyz-12345"`.
  2. Run full analysis pipeline with debug logging enabled.
  3. Grep all log outputs, cache files, and API responses for `"sk-secret-key-xyz-12345"`. Assert 0 occurrences.
* **Rationale:** R8, Ground Truth. Core security policy across the repository.

#### AC-P0-21: Logging Privacy for Academic Text
* **Dimension:** 35 (Logging privacy)
* **Specification:** Raw paper paragraphs, section bodies, or prompt text must not be emitted to standard operational logs (`INFO` / `WARNING`). Operational logs may only include document IDs, paragraph IDs, section IDs, token counts, model names, latency, and status.
* **Verification:**
  1. Run analysis on a paper containing distinctive text: `"Quantum Cryptography 89231 Unique Marker"`.
  2. Read captured application logs.
  3. Assert `"Quantum Cryptography 89231 Unique Marker"` is absent from logs.
* **Rationale:** R17. Protects user document confidentiality.

#### AC-P0-22: Zero Translation Kernel Regression
* **Dimension:** 38 (No translation regression)
* **Specification:** This task must not modify the PDF translation kernel, its prompt templates, or its output.
* **Verification:**
  1. Run the existing 560 backend tests: `pytest backend/tests`.
  2. Assert all 560 tests pass with zero regressions.
  3. Git diff asserts no files under the translation kernel package have been edited.
* **Rationale:** Project constraint: Task DS-CTX-001 must not touch translation kernel code.

---

### Category H: ContextBuilder Contract

#### AC-P0-23: Bounded Context Assembly & Priority Shedding
* **Dimension:** 41 (Context-size limits)
* **Specification:** `ContextBuilder.build_context(document_id: str, paragraph_id: str, max_tokens: int = 1500) -> TranslationContext` must return a bounded context package. When content exceeds `max_tokens`, it must shed components strictly in the following order:
  1. Drop distant glossary terms not present in current paragraph.
  2. Truncate document summary.
  3. Truncate section summary.
  4. Truncate `previous_paragraph` / `next_paragraph` (to sliding windows).
  5. *Never drop:* Current section title, and directly matched proper nouns / untranslatable terms present in the target paragraph.
* **Verification:**
  1. Call `ContextBuilder.build_context` with a small budget (`max_tokens = 300`).
  2. Assert returned context length $\le 300$ tokens.
  3. Assert current section title and directly matched in-paragraph terms are retained.
  4. Assert document summary was truncated or shed first.
* **Rationale:** R5, Question 5, Question 6. Predictable token bounding for downstream translator prompts.

#### AC-P0-24: Non-Duplication of Target Paragraph Content
* **Dimension:** 41 (Context-size limits)
* **Specification:** `TranslationContext` must provide surrounding context (`prev_text`, `next_text`), metadata, summaries, and glossary, but must NOT include `current_paragraph_text`.
* **Verification:**
  1. Inspect `TranslationContext` schema.
  2. Verify there is no field named `current_paragraph_text` or `text`.
  3. Assert caller supplies target text separately.
* **Rationale:** Question 7. Eliminates duplicate token overhead in future translation requests.

---

## 2. P1 Criteria (Important — Acceptable to Defer with Justification)

P1 criteria are important quality and contract requirements that may be deferred to a follow-up hardening cycle if blocked by external dependencies, provided the deferral rationale is documented.

### AC-P1-01: Document Summary Quality Contract
* **Dimension:** 4 (Document summary quality contract)
* **Specification:** The document-level summary must:
  1. Be between 150 and 400 words.
  2. State the primary problem, methodology, and main quantitative/qualitative findings.
  3. If an abstract exists (`ParagraphIR.is_abstract == True`), the summary must synthesize rather than replicate the abstract word-for-word.
* **Verification:** Run on 3 benchmark papers; assert summary length is within [150, 400] words and Levenshtein distance against the abstract is $> 0.3$.
* **Deferral Rationale:** Calibrating prompt wording for ideal academic style requires iterative evaluation; basic length bounds and non-empty checks in P0 are sufficient for initial foundation.

### AC-P1-02: Terminology Deduplication & Canonicalization
* **Dimension:** 8 (Academic terminology consistency)
* **Specification:** If different sections extract synonymous variants (e.g. `"residual connection"`, `"residual connections"`, `"skip connection"`), the pipeline should cluster or canonicalize them into a single primary `GlossaryEntry` with aliases.
* **Verification:** Verify that plural and singular variants of identical terms are collapsed into a single entry in `analysis.json`.
* **Deferral Rationale:** Simple exact-match glossary slicing works reliably for translation context; cluster-based deduplication can be added as a refinement.

### AC-P1-03: Real-Provider Integration Smoke Test
* **Dimension:** 37 (Real-provider verification)
* **Specification:** An end-to-end integration test runs against a real provider (e.g. OpenAI / DeepSeek / Ollama) via an opt-in flag (`pytest -m real_llm`), verifying JSON schema compatibility with live model outputs.
* **Verification:** Run `pytest -m real_llm tests/test_analysis_real.py` with local Ollama or test key; assert `status == "READY"`.
* **Deferral Rationale:** CI runs strictly offline using deterministic mocks (AC-P0-35). Live provider tests require network access and API credentials.

### AC-P1-04: Cached Read & Pipeline Performance SLA
* **Dimension:** 40 (Performance)
* **Specification:**
  - Cached read of `analysis.json` via `GET /api/documents/{id}/analysis` must return in $< 50\text{ ms}$.
  - In-memory `ContextBuilder.build_context()` must execute in $< 5\text{ ms}$.
* **Verification:** Benchmark 1,000 iterations in pytest; assert P99 latency $< 50\text{ ms}$ for API read, $< 5\text{ ms}$ for context builder.
* **Deferral Rationale:** Correctness and safety take precedence. Performance profiling is deferred until storage formats stabilize.

---

## 3. P2 Criteria (Desirable Polish)

P2 criteria represent enhancements that improve developer experience or downstream usability but do not affect baseline correctness.

### AC-P2-01: Academic Ontology Normalization
* **Dimension:** 12 (Domain inference)
* **Specification:** Map inferred domains to standard taxonomy categories (e.g., arXiv category trees such as `cs.CV`, `stat.ML`, `physics.optics`).
* **Verification:** Inferred domain record contains an optional `arxiv_category: str | None`.

### AC-P2-02: Glossary Technical Density Scoring
* **Dimension:** 6 (Glossary schema)
* **Specification:** Assign a `technical_density: float` (0.0 to 1.0) to glossary entries, indicating whether a term is specialized jargon versus general scientific vocabulary, aiding context-pruning algorithms.
* **Verification:** Entries contain `technical_density` calculated via TF-IDF or prompt heuristics.

### AC-P2-03: Context Builder Debug Inspection Endpoint
* **Dimension:** 18 (HTTP surface)
* **Specification:** Expose `GET /api/documents/{id}/context-preview?paragraph_id={pid}` returning the assembled `TranslationContext` for rapid verification and debugging.
* **Verification:** Query endpoint in browser/curl; assert payload matches `TranslationContext` JSON schema without exposing internal file paths.

---

## 4. Explicitly Not Applicable

The following dimensions are explicitly out of scope for DS-CTX-001:

| Dimension / Item | Reason for Exclusion |
| :--- | :--- |
| **Translation Kernel Integration** | Explicitly forbidden by task instructions. Integrating context into translation prompts is a separate, downstream task. |
| **Paper QA / Conversational Chat** | Out of scope. DS-CTX-001 builds context foundation, not interactive RAG chat. |
| **Vector Embeddings / Embedding Models** | Out of scope. Retrieval uses structured IR paragraph IDs and lexical matching; no embedding pipeline is introduced. |
| **Vector Database (Chroma, Qdrant, etc.)** | Out of scope and forbidden by project storage constraints. |
| **AI Sidebar / Tauri UI Integration** | R19. No frontend work, sidebar UI, or Tauri IPC bindings in this backend milestone. |
| **User Glossary Editor UI** | R19. No frontend glossary editing interface. |
| **Synchronized PDF Scrolling** | Belongs to reader viewer UI milestone, not backend context layer. |

---

## 5. Answers to Mandatory Design Questions

### Q1: Is `DocumentAnalysis` one model or two?
**Decision: Two-tier decoupled schema stored in a single unified document artifact.**
- **Tier 1 (Language-Independent):** `Domain`, `DocumentSummary`, `SectionSummary`, `NamedEntities` (models, datasets, tools), and `Acronyms`. These represent immutable structural comprehension of the source paper.
- **Tier 2 (Target-Language Context):** `GlossaryItem(term, category, is_translatable, definition_en, target_translation: dict[str, str])`.
- **Cache Identity:** The provenance records `target_language: str` (e.g. `"zh-CN"`). Language-independent fields and target-language glossary translations share the file `analysis.json`, but are defined as separate Pydantic models. If a user later requests a different target language, Tier 1 extractions are preserved, and only Tier 2 translation mapping is recalculated.

### Q2: Where is analysis persisted?
**Decision: `<documents_dir>/<document_id>/analysis.json`.**
- **Justification:** `tests/test_db.py` pins SQLite tables strictly to `["documents", "profiles", "schema_version", "translation_tasks"]` with `SCHEMA_VERSION = 3`. Introducing an `analysis` or `glossary` SQLite table violates existing architecture and fails the database table guard test. Persisting as a sibling file alongside `ir.json`, `source.pdf`, and `mono.pdf` with atomic writes (`.tmp` + `os.replace`) adheres to established storage patterns and ensures zero migration overhead.

### Q3: What exactly is in the cache key?
**Decision: A deterministic hash of 6 semantic fields:**
$$\text{CacheKey} = \text{SHA256}(\text{content\_hash} + \text{pipeline\_version} + \text{prompt\_version} + \text{provider\_name} + \text{model} + \text{target\_language})$$
- `content_hash`: SHA-256 of source PDF (from `DocumentIR`).
- `pipeline_version`: Code release version (e.g., `"1.0.0"`).
- `prompt_version`: Version string of analysis prompt templates (e.g., `"v1.0-202609"`).
- `provider_name`: Provider identifier (e.g., `"openai"`, `"anthropic"`), **never the API key**.
- `model`: Target model string (e.g., `"gemini-1.5-pro"`, `"deepseek-chat"`).
- `target_language`: Default `"zh-CN"`.
- *Strictly Excluded:* `api_key`, `credential_ref`, timestamps, file paths, hostnames.

### Q4: How are sections with `section_id = None` analysed?
**Decision: Synthetic Section Fallback Partitions.**
- Paragraphs lacking a section header are grouped sequentially into synthetic sections bounded by page breaks and token thresholds (max 1,200 tokens per synthetic partition).
- Partition ID: `f"synthetic_chunk_p{start_page}_p{end_page}_{idx}"`.
- Title: `"Unsectioned Content (Pages X-Y)"`.
- Level: `None`.
- These synthetic sections pass through the identical section-analysis and summarization pipeline, ensuring zero unanalyzed paragraphs.

### Q5: How does `ContextBuilder` select glossary entries when the glossary is large?
**Decision: 4-Stage Lexical & Locality Filter with a Hard Token Cap (Max 15 terms / 300 tokens).**
1. **Paragraph Lexical Match:** Scan target paragraph text for exact matches of known glossary terms, acronyms, and model names.
2. **Untranslatable Rule Priority:** Terms where `is_translatable == False` found in the paragraph receive highest priority.
3. **Section Locality:** If matched terms exceed budget, prioritize terms first defined or frequently cited in the target paragraph's `section_id`.
4. **Hard Ceiling:** Cap selection at 15 items or 300 tokens, whichever is reached first.

### Q6: How is the context budget enforced and prioritised?
**Decision: Strict Priority Shedding Order.**
- Overall context overhead is capped at `max_tokens` (default 1,500 tokens).
- When total tokens exceed budget, shed components in this exact order:
  1. *First to Drop:* Distant glossary terms not matching the paragraph text.
  2. *Second to Drop:* Document-level summary details (truncate to first 2 sentences).
  3. *Third to Drop:* Section summary details (truncate to key takeaway).
  4. *Fourth to Drop:* Surrounding paragraphs (truncate previous/next paragraph sliding windows from 200 tokens down to 50 tokens).
  5. *Never Dropped:* Current section title, and directly matched in-paragraph proper nouns / untranslatable terms.

### Q7: How is duplicate inclusion of the current paragraph avoided?
**Decision: Structural Omission from `TranslationContext`.**
- `ContextBuilder.build_context()` returns surrounding context (`prev_text`, `next_text`), metadata (`section_title`, `page_number`), summaries, and glossary terms.
- The schema contains no field for the target paragraph's text. The translation caller already possesses the target paragraph and injects it into its own prompt slot, preventing double token consumption.

### Q8: What proves "no source quotation was fabricated"?
**Decision: Deterministic String Containment & Paragraph ID Cross-Check.**
- Evidence validation requires:
  $$\forall \text{item} \in \text{ExtractedItems}, \quad \text{item.paragraph\_ids} \subseteq \text{ir.page\_mapping.keys()}$$
- If an item provides an optional source quotation string `q`, the validator asserts:
  $$\exists \text{pid} \in \text{item.paragraph\_ids} \text{ such that } \text{normalize}(q) \subseteq \text{normalize}(\text{ir.paragraphs}[\text{pid}].\text{text})$$
- Any item referencing non-existent IDs or fabricated quotes is rejected during Pydantic schema validation.

### Q9: Behaviour on valid JSON with empty analysis vs invalid JSON?
- **Invalid JSON:** Caught as `LLMInvalidResponseError`. Pipeline triggers 1 retry with explicit JSON schema repair instructions. If the retry fails, the section or phase is marked `FAILED` with error code `LLM_INVALID_RESPONSE`.
- **Valid JSON with Empty Content (`{"summary": "", "terms": []}`):** Pydantic validators enforce `min_length=1` on summaries and sensible constraints on non-empty documents. Validation fails with `AnalysisValidationError`. The run is marked `FAILED` (or `PARTIAL`), never saved as `READY`.

### Q10: Cancellation Semantics
- **Decision: Chunk-Boundary Async Checks.**
- The pipeline checks `task.is_cancelled()` or handles `asyncio.CancelledError`:
  1. Immediately prior to dispatching any HTTP LLM call.
  2. In the exception handler of an in-flight network request.
- If cancelled, in-flight work halts, no further chunks are scheduled, no `analysis.json` is committed as `READY`, and the task state is reported honestly as `CANCELLED`. The system never fabricates a low-level thread abort.

---

## 6. Plainly Stated Incorrect Premises & Tensions in Ground Truth

As an independent acceptance criteria author, the following architectural tensions and questionable premises in the prompt must be highlighted plainly:

1. **Flawed Premise: Coupling Extraction and Chinese Translation in a Single Prompt**
   - *The Issue:* The suggested prompt combines structural analysis (domain, summary, acronyms, entities) with Simplified Chinese glossary translation in a single pass.
   - *Why It Is Wrong:* It contaminates language-independent document understanding with target-language translation. If a user later translates to Japanese or German, or uses the context for English document QA, the entire analysis cache is invalidated. Furthermore, models instructed to translate terms in the same prompt frequently suffer from degraded attention and hallucinate source expansions.
   - *Resolution:* The criteria enforce a two-tier logical separation (AC-P0-05, Q1). Technical terms and acronyms are extracted first as source entities; Chinese translation mappings are populated into a target-language field.

2. **Tension: Banning `page` Field Name vs Prompt Request for "Page References"**
   - *The Issue:* Ground truth firmly states: "`page_index` (0-based) vs `page_number` (1-based) are separate named fields. The bare word `page` is banned as a field name." Yet Evaluation Dimension 14 requests "page references".
   - *Why It Matters:* If any engineer creates an `analysis.json` schema with `"page": 5`, it directly violates the IR naming rule and causes confusion across the codebase.
   - *Resolution:* AC-P0-08 explicitly bans `"page"` as a field name in all context models, mandating `page_number: int` (1-based).

3. **Impractical Premise: Verbatim Text Quotations as Evidence**
   - *The Issue:* R13 and Dimension 42 mention "no invented source quotations" and "evidence must reference real source text".
   - *Why It Is Risky:* LLMs rarely return byte-accurate quotations from long scientific texts; they frequently normalize hyphens, drop commas, or adjust whitespace. Demanding exact string equality for long quotes causes rampant false-positive validation failures.
   - *Resolution:* The criteria establish that `paragraph_id` is the primary, infallible evidence anchor (AC-P0-04). String snippets are strictly optional and, when present, checked via normalized substring matching rather than rigid exact matching.

4. **Rigid Multi-Stage Chunking on Tiny Documents**
   - *The Issue:* R3 states "Hierarchical analysis, bounded... Sections, then chunked sections, then synthesis."
   - *Why It Is Inefficient:* Many academic preprints or extended abstracts are 1 to 2 pages long ($< 1,500$ tokens total). Forcing a 1-page paper through section chunking followed by a synthesis call wastes time and money on 3 serialized LLM calls.
   - *Resolution:* The criteria permit an adaptive fast path: if the document's total token count is below 2,000 tokens, the pipeline may execute in a single bounded pass.
