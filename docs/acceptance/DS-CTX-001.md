# Acceptance Criteria — DS-CTX-001: Academic Context Foundation

- **Author:** Gemini (`gemini-3.8-flash-high`), via the standing two-agent workflow
- **Reviewed and frozen by:** DeepSeek, before any implementation code was written
- **Date:** 2026-09-17
- **Baseline:** `ff744ab` (DS-DOC-001 + Gate 0 fix)
- **Authoring input:** the actual Document IR, the actual LLM provider layer, the profile
  and credential stores, `tests/test_db.py`, and the DS-DOC-001 test suite.
- **Status:** **FROZEN.** **24 P0 · 4 P1 · 3 P2.**

Baselines this task must not regress:

```
backend  → 560 passed
frontend →  75 passed
```

## DeepSeek review

Gemini inspected the real implementation and criticised its own brief rather than writing
criteria around it — including catching that the suggested prompt conflates language-independent
analysis with Chinese glossary translation. That criticism is accepted and the resolution it
proposes is adopted.

### AC_CHANGE_REQUEST 1 — AC-P0-09 references a field that does not exist

| | |
|---|---|
| **As written** | `Tokens(overhead) + Tokens(chunk) + max_output ≤ ProviderConfig.context_window` |
| **Problem** | `ProviderConfig` has no `context_window`. Its fields are exactly `base_url, api_key, model, timeout_s, temperature, max_output_tokens, custom_headers`. The criterion's budget test is unenforceable as written. |
| **Why it likely happened** | Model context windows are not modelled anywhere in this project, and deliberately so: the user supplies an endpoint and a model name, and the application never assumes what that model can hold. |
| **Resolution** | The budget is an **explicit analysis-side configuration** with a conservative default, not a property inferred from the model. The invariant becomes `overhead + input + max_output ≤ configured_budget`, checked before every request. This is what the task brief anticipated — *"If model context capacity is unknown: use conservative defaults/configuration."* Adding `context_window` to `ProviderConfig` would mean a migration and a schema change the task does not require. |
| **Not accepted** | Trusting the provider to reject an oversized request, which the brief forbids by name. |

### AC_CHANGE_REQUEST 2 — "provider_name" is the wrong cache identity

| | |
|---|---|
| **As written** | The cache key and provenance carry `provider_name` (AC-P0-17, AC-P0-18), described as e.g. `"openai"` / `"anthropic"`. |
| **Problem** | In this project a provider is a **user-created profile**, not a vendor. There is no vendor identity to record: the profile carries a `base_url`, a `model` and a protocol, and its *name* is a free-text label the user can edit at will. Using the name means (a) renaming a profile silently invalidates every analysis made with it, and (b) two profiles pointing at different endpoints but named alike would be treated as the same provider — which is exactly the upstream translation-cache defect (§41) that this task is told not to repeat. |
| **Resolution** | Provider identity is `(base_url, model, protocol)`. The profile *name* is recorded in provenance for display only and is **not** part of the cache key. `api_key` and `credential_ref` remain excluded, per AC-P0-18's credential-invariance rule. |
| **Not accepted** | Including a mutable display label in a semantic cache key, or omitting provider identity entirely. |

### Confirmations

- **Persistence is `analysis.json` in the document directory**, beside `ir.json`, `source.pdf`,
  `mono.pdf` and `dual.pdf`. `test_db.py` pins the table set to exactly four names and the task
  forbids new tables, so this is the only choice consistent with the architecture — and the right
  one, since analysis is a derived, rebuildable artifact.
- **The two-tier split is adopted**: language-independent understanding (domain, summary,
  sections, entities, acronyms) is separated from target-language glossary translations, so a
  Chinese glossary cannot contaminate language-independent comprehension and a future Japanese
  run does not discard the rest.
- **Paragraph ids are the evidence anchor**; verbatim snippets are optional and validated by
  normalised containment rather than exact equality, because models normalise whitespace and
  hyphens and exact matching would reject honest output.
- **Adaptive fast path accepted** for short documents (§6.4 of Gemini's critique): forcing a
  two-page paper through three serialised calls is waste, not rigour.
- **No new SQLite table, no second PDF parser, no translation-kernel change, no frontend work,
  no embeddings, no vector store.**

---

# P0 — must pass (24)

## A. IR invariance and consumption

| ID | Requirement | Verification |
|---|---|---|
| **AC-P0-01** | Running the analysis pipeline must not mutate `ir.json` on disk or any in-memory `DocumentIR`: `content_hash`, sections, paragraphs, pages, page mapping, metadata and bboxes all identical. | `ir.json` sha256 before == after. |
| **AC-P0-02** | The pipeline's only document input is the IR. It must not import PyMuPDF/`fitz`, pdfminer or any PDF library, nor run layout detection. | Delete `source.pdf` and analysis still succeeds; AST check finds no PDF import in the analysis package. |
| **AC-P0-03** | `abandon` blocks (running headers, footers, page stamps) never reach any prompt, chunk, summary, entity or glossary. | A marker string in an `abandon` block appears 0 times across all outgoing requests. |

## B. Extraction fidelity, provenance and evidence

| ID | Requirement | Verification |
|---|---|---|
| **AC-P0-04** | Every acronym, term and entity cites evidence through **valid `paragraph_id`s**. If a verbatim snippet is present it must be a normalised substring of that paragraph's real text. | A fake paragraph id is rejected or dropped; a fabricated snippet is rejected; on real output, 100% of cited ids resolve in `page_mapping`. |
| **AC-P0-05** | Exact source spelling preserved for identifiers: case, hyphenation, punctuation (`LeVJEPA`, `ResNet-50`, `Something-Something V2`, `VLA`). | Asserted against a paragraph containing them; translatable-identifier flag set false. |
| **AC-P0-06** | An acronym expansion is recorded **only** when both the acronym and its expansion co-occur in the referenced paragraph. Never inferred from model memory. | `"Vision-Language-Action (VLA)"` yields the expansion; `"standard VLA benchmarks"` yields none. |
| **AC-P0-07** | Domain is an interpretation with explicit uncertainty: primary, optional secondary, confidence, rationale. Weak evidence yields `Unknown` or `Interdisciplinary`, never a forced label. | Low-confidence input does not produce a confident domain. |
| **AC-P0-08** | All analysis models and JSON use `page_number` (1-based). The bare field name `page` is banned across context schemas. | No `page` key in any serialised analysis payload; every page reference ≥ 1. |

## C. Hierarchical processing

| ID | Requirement | Verification |
|---|---|---|
| **AC-P0-09** | Chunking respects paragraph boundaries — no paragraph split across words or characters — and every request satisfies the configured token budget (AC_CHANGE_REQUEST 1). | Long document: every chunk starts and ends at a paragraph boundary; no request exceeds the budget. |
| **AC-P0-10** | When sections are absent or unreliable, contiguous unsectioned paragraphs are grouped into synthetic partitions bounded by page and token limits. | A document with no sections still reaches `READY` with every paragraph covered. |

## D. Failure, boundedness and resilience

| ID | Requirement | Verification |
|---|---|---|
| **AC-P0-11** | Normalised LLM errors are reused. Auth failures (401/403) fail immediately with **exactly one** call. Rate limits and 5xx timeouts retry within a bounded budget, then fail. No SDK exception escapes the pipeline. | Call counts asserted per error class. |
| **AC-P0-12** | Output is validated structurally. Unparseable JSON is retried once with correction, then fails. Structurally valid but empty output is rejected. Neither is ever persisted as valid analysis. | Malformed and empty responses both leave no `READY` analysis on disk. |
| **AC-P0-13** | Partial failure is granular: one failed section must not discard the others. A status model distinguishing `READY` / `PARTIAL` / `FAILED` records which parts failed. | 5 sections, 1 failing → `PARTIAL`, the other 4 present. |
| **AC-P0-14** | Cancellation takes effect at a chunk boundary, dispatches no further requests, leaves no corrupt `analysis.json`, and is reported as `CANCELLED` — not `FAILED`, not `READY`. | No further provider calls after cancel; no partial file. |

## E. Storage

| ID | Requirement | Verification |
|---|---|---|
| **AC-P0-15** | Persisted to `<documents_dir>/<document_id>/analysis.json`. **No new SQLite table.** | The exact-table-set guard still passes; `SCHEMA_VERSION` stays 3. |
| **AC-P0-16** | Writes are atomic: sibling temp file then `os.replace`. A failure mid-write leaves any existing `analysis.json` intact. | Injected write failure preserves the previous file. |

## F. Provenance, caching, invalidation

| ID | Requirement | Verification |
|---|---|---|
| **AC-P0-17** | Provenance persisted with every analysis: document id, source content hash, pipeline version, prompt version, provider identity, model, target language, generation timestamp. **No credential, ever.** | All fields populated; no key material present. |
| **AC-P0-18** | Cache hit requires an exact match on source hash, pipeline version, prompt version, provider identity and model. Changing any of those invalidates. **Changing only the API key does not.** | Key rotation → cache hit, 0 provider calls. Prompt version bump → cache miss. |
| **AC-P0-19** | Analysis is rebuildable: forcing regeneration never deletes or alters `source.pdf`, `ir.json`, `mono.pdf` or `dual.pdf`. | Checksums and mtimes unchanged after a forced rebuild. |

## G. Security, privacy, isolation

| ID | Requirement | Verification |
|---|---|---|
| **AC-P0-20** | No API key or credential appears in `analysis.json`, any HTTP response, or any log. | A distinctive dummy key appears 0 times across logs, files and responses. |
| **AC-P0-21** | Paper text is not logged. A marker sentence in the source appears in no log record; ids, counts, token counts, model, latency and status may be logged. | Marker absent from captured logs. |
| **AC-P0-22** | The translation kernel is untouched and the full existing suite passes unchanged. | 560 backend tests pass; no file under `app/pdfkernel/` modified. |

## H. ContextBuilder

| ID | Requirement | Verification |
|---|---|---|
| **AC-P0-23** | `build_context(document_id, paragraph_id, max_tokens)` returns a bounded package that sheds in a defined order — distant glossary first, then document summary, then section summary, then neighbour text — while **never** dropping the current section title or glossary terms matched in the target paragraph. | With a small budget the result stays within it and retains the protected components. |
| **AC-P0-24** | The context package contains surrounding context, metadata, summaries and glossary, but **no target paragraph text** — the caller supplies that separately. | No field carries the current paragraph's text. |

---

# P1 — should pass (4)

| ID | Requirement |
|---|---|
| **AC-P1-01** | Document summary quality contract: a bounded length, covering problem, method and findings, and synthesising rather than copying the abstract. |
| **AC-P1-02** | Terminology deduplication: singular/plural and obvious variants collapse into one entry with aliases. |
| **AC-P1-03** | An opt-in real-provider integration test (`-m real_llm`), off by default so the suite stays offline. |
| **AC-P1-04** | Cached analysis read < 50 ms; `build_context` < 5 ms. |

# P2 — optional (3)

**AC-P2-01** optional arXiv-style category mapping on the domain record ·
**AC-P2-02** a technical-density score per glossary entry ·
**AC-P2-03** a debug endpoint returning the assembled context for a paragraph.

---

# Explicitly not applicable

| Item | Why |
|---|---|
| Translation-kernel integration | Forbidden by this task; it is DS-CTX-002. |
| Paper QA / chat | Later phase. |
| Embeddings / vector search / vector database | Out of scope, and incompatible with the storage rules. |
| AI sidebar, Tauri, glossary editor UI | Frontend work is not in this task. |
| Synchronised PDF scrolling | Reader milestone, not context layer. |

---

# Settled design questions

| # | Decision |
|---|---|
| 1 | **Two tiers in one artifact.** Language-independent understanding (domain, summary, sections, entities, acronyms) is separate from target-language glossary translations. A different target language reuses tier 1. |
| 2 | **`analysis.json`** in the document directory. The table guard leaves no alternative that is consistent with the architecture. |
| 3 | **Cache key = hash of** `content_hash + pipeline_version + prompt_version + provider identity + model + target_language`. Never the key, never the credential reference, never the profile display name (AC_CHANGE_REQUEST 2). |
| 4 | **Unsectioned documents** get synthetic partitions bounded by page and token limits, analysed through the identical pipeline. No paragraph is left unanalysed. |
| 5 | **Glossary selection** is lexical and local: terms occurring in the target paragraph first, untranslatable identifiers prioritised, then section locality — under a hard cap. |
| 6 | **Budget shedding order** as in AC-P0-23, with the current section title and in-paragraph matched terms protected absolutely. |
| 7 | **The target paragraph is structurally absent** from the context package. |
| 8 | **Evidence is proven by paragraph id**; snippet containment is a secondary, normalised check. |
| 9 | **Invalid JSON** → one corrective retry, then fail. **Valid but empty** → validation failure. Neither is persisted as valid. |
| 10 | **Cancellation** is checked before every request dispatch and at chunk boundaries, and is reported honestly as `CANCELLED`. No claim that an in-flight request or thread was force-killed. |

---

# Premise critiques accepted

1. **Coupling extraction with Chinese translation in one prompt contaminates language-independent
   understanding.** Accepted; the two-tier split resolves it.
2. **`page` as a field name is banned** even though "page references" are required — the
   requirement is satisfied by `page_number`.
3. **Demanding verbatim quotations would reject honest output**, because models normalise
   whitespace and hyphens. Paragraph ids are the primary anchor; snippets are optional and
   normalised.
4. **Rigid multi-stage chunking wastes calls on tiny documents.** An adaptive single-pass path is
   permitted below the small-document threshold.
