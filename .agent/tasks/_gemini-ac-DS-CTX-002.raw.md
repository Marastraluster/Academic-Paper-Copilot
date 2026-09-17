# Acceptance Criteria — DS-CTX-002: Context-Aware Academic PDF Translation

- **Author:** Gemini (`gemini-3.8-flash-high`), via the standing two-agent workflow  
- **Role:** Independent Acceptance Criteria Author  
- **Task:** DS-CTX-002 (`Context-Aware Academic PDF Translation`)  
- **Date:** 2026-09-17  
- **Baseline:** `backend 618 passed`, `frontend 75 passed`  
- **Target Invariant:** Zero regression to upstream freeze (ADR-001), DocumentIR, DocumentAnalysis, ContextBuilder, or existing provider adapters.  
- **Status:** **PROPOSED SPECIFICATION — READY FOR REVIEW AND FREEZE.**  

---

## Executive Summary & Task Boundary

The upstream translation pipeline operates at the level of translation units extracted from layout masks. DS-CTX-002 connects the verified upstream context artifacts (`DocumentIR`, `DocumentAnalysis`, and [`ContextBuilder`](file:///D:/marti/SciPrograms/backend/app/context/context_builder.py#L59-L231)) into the translation execution path via [`BoundedOpenAIlikedTranslator`](file:///D:/marti/SciPrograms/backend/app/pdfkernel/bounded_translator.py#L48-L144) and [`translate_pdf`](file:///D:/marti/SciPrograms/backend/app/pdfkernel/adapter.py#L286-L405).

```
Source PDF ──► DocumentIR ──► DocumentAnalysis ──► ContextBuilder
                     │                                   │
                     └─────────► Unit Mapper ◄───────────┘
                                      │
                         Target Unit + TranslationContext
                                      │
                     BoundedOpenAIlikedTranslator
                     (Cache Check ──► Prompt Envelope ──► LLM Call ──► Placeholder Guard)
                                      │
                           PDFMathTranslate Layout ──► mono.pdf & dual.pdf
```

---

# 1. P0 Criteria — Must Pass

All P0 criteria are mandatory, non-negotiable, and objectively verifiable.

## A. Context Modes & Invariance

| ID | Requirement | Verification | Rationale |
|---|---|---|---|
| **AC-P0-01** | **Context Mode "Off" Parity**<br>When `context_mode="OFF"`, translation must be strictly byte-and-prompt equivalent to the baseline system: no context assembly, no IR paragraph lookup, zero context overhead tokens in outgoing prompts, and upstream default instruction envelope. | Compare captured outgoing LLM prompt against baseline prompt template in [`test_pdfkernel.py`](file:///D:/marti/SciPrograms/backend/tests/test_pdfkernel.py#L1-L120). Prompt character count matches baseline exactly; zero context sections present. | Prevents regression for users selecting fast/unaugmented translation or when running against constrained models. |
| **AC-P0-02** | **Context Mode "Standard" Activation**<br>When `context_mode="STANDARD"`, every translation unit mapped to an IR paragraph must be enveloped with the bounded context package produced by [`ContextBuilder.build_context`](file:///D:/marti/SciPrograms/backend/app/context/context_builder.py#L72-L98) adhering to the delimited prompt contract. | Inspect intercepted outgoing requests on a test paper: mapped units contain academic domain, section summary, local glossary, and adjacent paragraph context. | Connects the upstream semantic engine to the translation kernel. |
| **AC-P0-03** | **IR & Source Immutability**<br>Executing translation under any context mode, whether succeeding, failing, or aborting mid-flight, must never mutate `source.pdf`, `ir.json`, or in-memory `DocumentIR`. | SHA-256 and file `mtime` of `source.pdf` and `ir.json` before run == after run across success and injected 500 error exits. | Fundamental standing invariant: source and extraction assets are immutable read-only records. |

## B. Unit-to-IR Mapping & Honest Fallback

| ID | Requirement | Verification | Rationale |
|---|---|---|---|
| **AC-P0-04** | **Normalized Text Unit Matching**<br>Translation units ($s$) must be associated with `DocumentIR` paragraphs by stripping `{v\d+}` placeholders, collapsing whitespace, case-folding, and checking normalized containment against IR paragraph text. | Feed units with `{v0}`, `{v1}` markers matching known IR paragraphs; verify 100% resolve to the exact canonical `paragraph_id`. | Upstream layout boxes inject formula tokens not present in IR text. Normalization bridges the 149-unit vs 101-paragraph segmentation gap. |
| **AC-P0-05** | **Conservative Ambiguity Ceiling**<br>If a unit matches multiple IR paragraphs with equal score, or matches with character overlap below threshold ($< 0.80$), or cannot be resolved, the mapper must mark the unit as `MAPPING_UNRESOLVED`. | Pass duplicate short headings (e.g. repeated "Introduction" or page-header snippets); mapper returns `None` for target `paragraph_id` rather than guessing. | Wrong context is worse than no context. Guessing attaches false section summaries and false neighbors. |
| **AC-P0-06** | **Honest Fallback Semantics**<br>When a unit is `MAPPING_UNRESOLVED`, the translator must fall back strictly to **Document-Level Context** (academic domain and document summary only, with no section summary, no neighbors, and only document-wide protected glossary terms), or to **Empty Context**. The unit provenance must explicitly record `mapping_status="FALLBACK_DOCUMENT_ONLY"` or `"UNMAPPED"`. | Assert unit metadata emitted in task diagnostics: unmapped unit has `section_id=None` and `context_level="FALLBACK"`. Output must NEVER claim paragraph-level context was applied. | Truthful execution reporting; prevents silent misattribution. |

## C. Prompt Delimitation & Anti-Leakage Contract

| ID | Requirement | Verification | Rationale |
|---|---|---|---|
| **AC-P0-07** | **Versioned Delimited Prompt Envelope**<br>Context-augmented prompts must use strict, non-colliding structural delimiters separating Reference Context from Target Source Text, carrying explicit `PROMPT_VERSION = "2.0.0"`. Delimiters must clearly instruct the model that context is reference-only and must never be translated or output. | Assert outgoing request envelope matches specification format: contains `=== ACADEMIC CONTEXT (REFERENCE ONLY - DO NOT TRANSLATE) ===` and `=== TARGET SOURCE TEXT (TRANSLATE THIS ONLY) ===`. | Clear visual boundaries prevent reasoning models from conflating reference material with translation targets. |
| **AC-P0-08** | **Zero Context Leakage (Sentinel Invariant)**<br>Unique sentinel tokens placed strictly inside context fields (document summary, section summary, glossary definition, previous paragraph, next paragraph) must **never** appear in the translated output text. | Inject 5 distinct synthetic sentinels (`CTX_SENTINEL_DOMAIN_X7`, `CTX_SENTINEL_SEC_Y3`, etc.) into context fixtures. Assert for every translated unit: `sentinel not in translated_text`. Zero tolerance. | Leaking reference material, glossary explanations, or adjacent paragraph text into PDF layout corrupts rendering and document integrity. |
| **AC-P0-09** | **Strict Translation Preamble Prohibition**<br>Model output must contain only the translated text. Any model conversational filler (e.g., `"Here is the translation:"`, `"Translated text:"`, `"<translation>"`, markdown backticks around the full block) must be stripped or rejected. | Test with mock provider returning `"Here is the translation:\n\n实际文本"`; output saved to PDF is strictly `"实际文本"`. | PDF layout engines calculate exact font bounding boxes for every glyph; conversational noise breaks page typesetting. |

## D. Placeholder & Formula Safety Guard

| ID | Requirement | Verification | Rationale |
|---|---|---|---|
| **AC-P0-10** | **Single-Brace `{vN}` Format Invariant**<br>Placeholder validation must enforce single-brace notation `{v\d+}` matching the real upstream converter, rejecting any assumptions based on dead `<bN>` or `{{vN}}` methods. | Assert regex matches `{v0}`, `{v12}` and flags `{{v0}}` or `<b0>` as invalid. | Ground truth proves upstream uses `f"{{v{len(var)}}}"` yielding single braces. Validators checking double braces would fail valid translations. |
| **AC-P0-11** | **Placeholder Identity and Multiplicity Conservation**<br>For every translation unit, the multiset of formula placeholders `{vN}` in the translation must **strictly equal** the multiset in the source unit: $\text{Counter}(\text{placeholders}_{\text{trans}}) == \text{Counter}(\text{placeholders}_{\text{src}})$. | (a) Dropping `{v1}`, (b) duplicating `{v0}`, (c) hallucinating `{v99}` fails validation immediately. | Missing or extra placeholders crash or misalign PDFMathTranslate's formula layout stack. |
| **AC-P0-12** | **Bounded Single-Attempt Placeholder Repair**<br>Upon placeholder validation failure, the translator must issue **exactly one (1)** targeted repair prompt containing the source text, corrupted translation, and missing/corrupted placeholder IDs with an explicit correction directive. | Injected mock failure triggers exactly 1 repair request; repair prompt contains `Missing placeholders: ['{v1}']`. If repair returns valid output, it is accepted. | Prevents infinite retry loops while recovering from minor model reordering glitches. |
| **AC-P0-13** | **Fail-Safe Source Unit Preservation on Repair Failure**<br>If the single repair attempt fails to produce valid placeholders, the system must **preserve the untranslated source unit** in the translated output, log a structured warning, and continue document translation. Under no circumstances may corrupted placeholder text reach the PDF renderer. | Repair fails with missing placeholder; verify output PDF contains the original English text for that unit, and task record reports `PLACEHOLDER_CORRUPTED_FALLBACK_SOURCE`. | Formula correctness outranks translation completeness. An untranslated English paragraph maintains layout; corrupted markers corrupt the entire page. |

## E. Per-Unit Effective-Context Cache Identity

| ID | Requirement | Verification | Rationale |
|---|---|---|---|
| **AC-P0-14** | **Per-Unit Effective-Context Hash Inclusion**<br>Translation cache identity must incorporate a cryptographic hash (`effective_context_hash`) computed over the specific canonicalized context payload handed to that unit (academic domain, document summary, section title, section summary, paragraph-filtered glossary entries, adjacent paragraphs). | Units with identical source text but different section/glossary context produce distinct cache keys; modifying Section B's summary invalidates Section B units but results in cache hits for Section A units. | Prevents cross-context cache poisoning while preserving fine-grained cache hits across partial analysis updates. |
| **AC-P0-15** | **Comprehensive Semantic Cache Key Specification**<br>The cache key must consist exclusively of semantic parameters: `(source_text, source_lang, target_lang, provider_base_url, provider_model, provider_protocol, prompt_version, context_mode, effective_context_hash, temperature, max_tokens, stop)`. | (a) Switching `base_url` or `model` results in a cache miss. (b) Switching `context_mode="OFF"` to `"STANDARD"` results in a cache miss. (c) Valid cache hit makes 0 network/LLM calls. | Solves the upstream cache defect where translations across different providers or models collided. |
| **AC-P0-16** | **Credential Cache Invariance**<br>Rotating, modifying, or removing the API key (`api_key`, `credential_ref`) must **never** alter cache identity or cause a cache miss. | Run translation with `key_A`, cache populates. Rerun identical translation with `key_B`: yields 100% cache hits, 0 LLM calls issued. | Credentials represent authorization, not semantic content. Key changes must not discard expensive translations. |

## F. Concurrency, Isolation & Thread Safety

| ID | Requirement | Verification | Rationale |
|---|---|---|---|
| **AC-P0-17** | **Task & Unit Concurrency Isolation**<br>When 4 worker threads translate units concurrently in upstream's `ThreadPoolExecutor`, context lookup and prompt construction must be thread-safe and strictly unit-scoped. No mutable shared state or global variables may hold "current unit context". | Run 4 parallel units carrying distinct sentinels (`SENTINEL_TH1` through `SENTINEL_TH4`). Verify no thread request ever receives another thread's sentinel or context. | Upstream runs multi-threaded translation per document; leaked thread state would contaminate translations. |
| **AC-P0-18** | **Thread-Safe Cache Operations**<br>Concurrent cache lookups and writes for different units with distinct `effective_context_hash`es must execute without race conditions, deadlocks, or database lock errors. | 4 concurrent threads translate distinct units requiring cache writes; assert SQLite peewee database finishes with 0 `OperationalError: database is locked` exceptions and all entries exist. | Upstream `TranslationCache` relies on thread-safe underlying SQLite; our parameter injection must preserve this guarantee. |

## G. Missing, Partial, or Failed Analysis Semantics

| ID | Requirement | Verification | Rationale |
|---|---|---|---|
| **AC-P0-19** | **Refusal on Missing Analysis when Context Required**<br>If translation is initiated with `context_mode="STANDARD"`, but `analysis.json` is missing or has status `FAILED` or `CANCELLED`, the pipeline must fail immediately with a typed error (`AnalysisRequiredError`, code `"ANALYSIS_UNAVAILABLE"`). It must **never silently downgrade** to unaugmented translation. | Attempt `translate_pdf(..., context_mode="STANDARD")` on an unanalyzed document directory; raises `AnalysisRequiredError` within $\le 50$ ms without invoking upstream. | Silent downgrades deceive users into believing their translation was academic-context-aware when it was not. |
| **AC-P0-20** | **Granular Execution on `PARTIAL` Analysis**<br>If `analysis.json` has status `PARTIAL`, units matching successfully analyzed sections must receive full context; units matching truncated/failed sections must gracefully fall back to Document-Level Context and record the fallback in task diagnostics. | Test with `SEMANTIC_BASELINE` partial fixture (sections 6–7 truncated): units in sections 1–5 receive section context; units in section 6 fall back to document summary with diagnostic warning. | Leverages all usable work from expensive analysis runs rather than rejecting the entire paper. |

## H. Bounded Provider Failure & Document Fast-Abort

| ID | Requirement | Verification | Rationale |
|---|---|---|---|
| **AC-P0-21** | **Bounded Retries per Unit**<br>Provider calls within [`BoundedOpenAIlikedTranslator`](file:///D:/marti/SciPrograms/backend/app/pdfkernel/bounded_translator.py#L48-L144) must strictly cap retryable errors (429, 5xx, timeouts) to `RETRYABLE_ATTEMPTS = 3` total attempts before terminating. Non-retryable errors (401, 403, 400, invalid model) must fail immediately on attempt 1. | Injected 401 raises `TranslationAbortSentinel` after exactly 1 call. Injected 500 raises after exactly 3 calls. | Inherited from DS-PDF-001; ensures context injection does not bypass bounded retry safety. |
| **AC-P0-22** | **Document Fast-Fail Abort**<br>The first terminal provider failure on any unit must immediately trigger `_abort()`, causing all concurrent and subsequent unit workers for that document to abort without dispatching further HTTP calls. | In a 4-thread run with 149 units, inject terminal failure on unit 1: total HTTP requests made across the entire job must not exceed $4 + \text{retries}$. | Prevents wasting user API tokens and waiting minutes when a provider outage occurs. |

## I. Artifact Generation & Page Invariants

| ID | Requirement | Verification | Rationale |
|---|---|---|---|
| **AC-P0-23** | **Strict Page Count and Interleaving Conservation**<br>Context-aware translation must produce valid mono and dual PDFs preserving all physical layout invariants: $\text{pages}(\text{mono}) == N$ and $\text{pages}(\text{dual}) == 2N$, with dual pages strictly interleaved $[O_0, T_0, O_1, T_1, \dots, O_{N-1}, T_{N-1}]$. | Assert PyMuPDF page count and extract page-marker text across 2-page fixture in both Off and Standard modes. | Context injection modifies text length and terms; layout and page count must remain structurally identical. |
| **AC-P0-24** | **Atomic Artifact Placement**<br>Finished translated PDFs must be written to temporary staging and atomically renamed (`os.replace`) to canonical paths (`mono.pdf`, `dual.pdf`). Any aborted or failed run must leave no corrupted or partial PDF in the document directory. | Kill translation mid-stream; verify neither `mono.pdf` nor `dual.pdf` exists, and `.translation-work` temporary files are completely purged. | Guarantees local storage is never left in an inconsistent state. |

---

# 2. P1 Criteria — Important, Deferrable

These criteria represent significant functional, quality, and performance guarantees that can be deferred if necessary without compromising core safety or system stability.

| ID | Requirement | Verification | Deferral Reason |
|---|---|---|---|
| **AC-P1-01** | **Measured Off-vs-Standard Quality Benchmark**<br>An automated benchmark on the frozen `SEMANTIC_BASELINE` paper must measure: (1) Glossary term consistency $\ge$ Off mode, (2) Correct disambiguation of polysemous terms (e.g. "residual mapping" $\to$ "残差映射" vs "剩余映射"), (3) 100% placeholder preservation. | Automated offline evaluation script comparing captured translations of 10 sampled paragraphs in both modes against expected domain terminology. | Requires pre-recorded baseline model responses; can be deferred to a post-integration evaluation pass. |
| **AC-P1-02** | **Context Building Overhead Ceiling**<br>Context retrieval and assembly per unit (unit normalization + IR lookup + [`ContextBuilder.build_context`](file:///D:/marti/SciPrograms/backend/app/context/context_builder.py#L72-L98) + cache key hashing) must complete in $\le 10$ ms on average per unit and $\le 25$ ms p99. | Profile 149 units on a standard 12-page IR; total context resolution overhead $\le 1.5$ seconds across the entire document. | Can be optimized later if initial regex/containment matching is slightly slower but functional. |
| **AC-P1-03** | **Unsectioned Document Synthetic Context Partitioning**<br>For papers with unsectioned content or bibliography blocks, the mapper must associate units with synthetic section partitions (from `SectionAnalysis.synthetic=True`), providing domain and document summary without injecting irrelevant section titles. | Test bibliography unit: attached context has `section_title=None` or synthetic bibliography title, and does not attach adjacent body paragraph text. | Most body text belongs to recognized sections; bibliography context fallback is non-critical for core reading. |
| **AC-P1-04** | **Opt-In Real-Provider Integration Test**<br>Provide an opt-in test (`pytest -m real_llm`) running real context-aware translation of 2 pages against an external OpenAI-compatible endpoint when environment credentials exist. | Offline suite skips test; running with `--run-real-llm` verifies end-to-end PDF generation against live model. | Default CI/local developer loop must stay 100% offline and cost-free. |

---

# 3. P2 Criteria — Polish

Low-priority enhancements and developer ergonomics.

| ID | Requirement | Verification |
|---|---|---|
| **AC-P2-01** | **Translation Context Inspection Endpoint**<br>A developer/debug API endpoint `GET /api/documents/{id}/debug/unit-context?text=...` returning the resolved `TranslationContext`, matched `paragraph_id`, and `effective_context_hash`. | Request with sample paragraph returns JSON matching `TranslationContext` schema. |
| **AC-P2-02** | **Task Diagnostics Context Metrics**<br>Task completion event includes structured context usage metrics: `{"units_total": 149, "units_context_aware": 141, "units_fallback": 8, "cache_hits": 120, "repairs_attempted": 1, "repairs_succeeded": 1}`. | Inspect SSE completion event payload; fields present and accurately counted. |
| **AC-P2-03** | **Terminology Highlight Metadata**<br>Record which glossary terms were injected and matched in each translated unit for potential future frontend reader highlighting. | Cache or task artifact records mapping of `{unit_id: [glossary_term_ids]}`. |

---

# 4. Explicitly Not Applicable

The following capabilities are deliberately excluded from DS-CTX-002:

| Excluded Item | Justification & Architectural Boundary |
|---|---|
| **Deep Context Mode** | **Rejected as cosmetic/vaporware.** Upstream processes units independently in parallel. True "Deep" context would require multi-pass draft-and-refinement or global document re-ranking, multiplying latency and token costs 3x–5x without architectural support. "Deep" mode has no distinct semantic meaning in this task and is omitted. |
| **Paper QA / Interactive Chat** | Out of scope for translation pipeline; belongs to a dedicated Phase 8 conversational agent. |
| **Vector Database & Embeddings** | Explicitly forbidden by architecture rules (ADR-001/002). Lexical and IR reading-order neighborhood retrieval in [`ContextBuilder`](file:///D:/marti/SciPrograms/backend/app/context/context_builder.py#L59-L231) is deterministic, lightweight, and local-first. |
| **Tauri Desktop & Frontend UI Changes** | DS-CTX-002 is strictly backend and kernel integration. UI integration for toggling modes belongs in frontend task DS-FE-004. |
| **Glossary Editing UI** | Analysis and glossary generation are automated and derived; user editing of glossaries is a future milestone. |
| **Synchronized PDF Scrolling** | Reader feature handled by viewer canvas, unrelated to PDF generation kernel. |
| **Modifying Upstream Source Code** | ADR-001 mandates upstream [`pdf2zh`](file:///backend/.venv/Lib/site-packages/pdf2zh) is consumed as a pinned dependency. All extensions reside in [`backend/app/pdfkernel/`](file:///D:/marti/SciPrograms/backend/app/pdfkernel). |

---

# 5. Direct Answer to the Effective-Context-Hash Question

### The Question
> **Must translation cache identity use a per-translation-unit effective-context hash rather than only a document-level analysis hash?**

### Direct Verdict
**YES. Translation cache identity MUST use a per-translation-unit effective-context hash.**

### Technical Reasoning
1. **Semantic Isolation and Correctness:**
   In an academic paper, identical generic text strings (e.g., `"Method"`, `"Overview"`, `"The policy is updated iteratively"`, or figure captions) appear in different sections. In Section 2 (Robotics Background), `"policy"` refers to a control policy ($\pi$); in Section 4 (Safety Ethics), `"policy"` might refer to organizational rules. If caching were keyed only on source text and a document-level analysis hash, whichever paragraph translated first would poison all subsequent identical strings across the document, ignoring their specific section summaries, local glossary terms, and adjacent neighbors.
2. **Preventing Cache Invalidation Thrashing:**
   If cache identity used only a document-level analysis hash (`sha256(analysis.json)`):
   Whenever an analysis is regenerated or updated (for example, transitioning from `PARTIAL` to `READY`, fixing a single section summary, or enriching an acronym expansion), the *entire* document hash changes. Consequently, **100% of all 149 translation units across the paper would suffer a cache miss**, forcing a complete, expensive re-translation of every page.
   With a **per-unit effective-context hash**, if Section 3's context is unchanged, all units in Section 3 produce the exact same `effective_context_hash` and **hit the cache instantly**, saving significant API cost and time.
3. **Honest Fallback Discrimination:**
   When a unit cannot be mapped to an IR paragraph (e.g. an ambiguous header or fragmented caption), it receives Fallback Context (document-level only).
   Its effective context hash is $H_{\text{fallback}} = \text{hash}(\text{fallback\_context})$.
   If an updated mapping algorithm later successfully resolves this unit to its true IR paragraph, its effective context hash becomes $H_{\text{rich}} = \text{hash}(\text{paragraph\_context})$.
   Because $H_{\text{fallback}} \ne H_{\text{rich}}$, the cache correctly misses and executes a high-quality context-aware translation, rather than forever serving the low-context fallback.
4. **Architectural Viability within ADR-001:**
   While upstream's default `self.cache` has a single instance-level `translate_engine_params`, our adapter **already owns and overrides `translate(text)`** via [`BoundedOpenAIlikedTranslator`](file:///D:/marti/SciPrograms/backend/app/pdfkernel/bounded_translator.py#L100-L134).
   The implementation can resolve unit context, compute `effective_context_hash`, and execute thread-safe cache lookup/insertion directly inside `translate()` before invoking `do_translate()`. This requires zero upstream source modifications.

---

# 6. Premise Critiques & Technical Clarifications

The following premises and implicit assumptions in the task briefing were scrutinized against the real codebase and reference audit:

### 1. The Placeholder Format Discrepancy (Confirmed and Settled)
- **Brief Premise:** The source code in [`OpenAITranslator.get_formular_placeholder()`](file:///D:/marti/SciPrograms/_reference/PDFMathTranslate/pdf2zh/translator.py#L493-L495) returns `"{{v" + str(id) + "}}"` and rich text markers `<bN>`.
- **Reality:** As audited in `docs/REPO_AUDIT.md` §2.1 and `converter.py:334`:
  Upstream converter constructs placeholders via `f"{{v{len(var)}}}"`, which in Python string formatting evaluates to a **single brace**: `{v0}`, `{v1}`, `{v2}`. The methods on `BaseTranslator` are dead code.
- **Specification Rule:** AC-P0-10 pins `{v\d+}` as the sole valid placeholder format. Any validator written against double braces would fail 100% of valid production runs.

### 2. Cache Hook Location: `translate()` vs `do_translate()`
- **Brief Premise:** "Where context can be injected: Hook: `do_translate(self, text)`".
- **Critique:** Injecting context only in `do_translate(self, text)` is **too late** for context-aware caching. Upstream's `translate()` calls `self.cache.get(text)` *before* `do_translate(text)`. If context is only known inside `do_translate`, cache lookup will run using unaugmented parameters, leading to cache collisions or requiring `ignore_cache=True`.
- **Resolution:** Context resolution, effective-context hash computation, and cache evaluation must occur inside **`translate(self, text)`**, which [`BoundedOpenAIlikedTranslator`](file:///D:/marti/SciPrograms/backend/app/pdfkernel/bounded_translator.py#L100-L134) already overrides. `do_translate()` merely executes the model dispatch with the prepared prompt.

### 3. Concurrency on `self.cache.translate_engine_params`
- **Brief Premise:** `add_cache_impact_parameters("base_url", ...)` is upstream's API for fixing cache identity in a class we own.
- **Critique:** Calling `add_cache_impact_parameters()` inside `translate()` during multi-threaded execution would mutate shared instance state without a lock, causing data races across the 4 worker threads. Upstream's comment in `cache.py:51` explicitly notes that `replace_params` assumes single-threaded configuration before translation starts.
- **Resolution:** Global parameters (`base_url`, `model`, `prompt_version`, `context_mode`) are registered at translator instantiation. Per-unit `effective_context_hash` must be evaluated thread-safely per unit call inside `translate()` without mutating shared translator instance fields.

### 4. Rejection of "Deep" Context Mode
- **Brief Premise:** "Context modes (Off and Standard; Deep only if a real semantic difference exists)".
- **Critique:** In a pipeline processing isolated units in parallel, there is no technical mechanism for "Deep" mode other than inflating token budget or dumping distant glossary terms. This degrades model attention without providing architectural value.
- **Resolution:** Deep mode is explicitly rejected and classified as Not Applicable. The system implements strictly `OFF` and `STANDARD`.

---

# Acceptance Criteria Verification Matrix

| Area | Criteria Count | Pass Threshold |
|---|---|---|
| **P0 (Must Pass)** | **24 criteria** | **100% (24/24)** |
| **P1 (Should Pass)** | **4 criteria** | Deferred with explicit rationale |
| **P2 (Optional Polish)** | **3 criteria** | Polish only |
| **Frozen Baselines** | `backend 618 passed`, `frontend 75 passed` | Zero regressions |
