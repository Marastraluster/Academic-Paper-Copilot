You are the independent Acceptance Criteria author for a local-first academic PDF
reader + bilingual translator ("Academic PDF Copilot").

Define objective P0 / P1 / P2 acceptance criteria for the next task.

**Do NOT write production code.** Return acceptance criteria only.

---

# TASK — DS-QA-001: Scope-Aware Retrieval + Citation Grounding

Begin the Paper QA phase. Build the deterministic retrieval and citation foundation
that a later answer generator consumes.

```
Question → Scope resolution → Candidate source units → FTS5 / BM25
        → Evidence bundle → (DS-QA-002: grounded answer)
```

**This task does not generate an answer.** It returns source-grounded evidence with
real paragraph ids, page numbers, section ids, source text and scores.

## Where the project is

```
backend   674 passed
frontend   78 passed
```

Complete and verified, and **must be reused, not rebuilt**: `DocumentIR` (validated on
real papers, 96.3% prose mapping), `DocumentAnalysis` (validated against a real model,
96.3% evidenced glossary, zero fabrications), `ContextBuilder`, translation in three
modes, provider system, bounded failure.

`DocumentIR` already provides paragraphs with stable ids, page mapping, section
mapping, reading order and geometry. `DocumentAnalysis` already provides a document
summary, section summaries, a glossary with evidence, acronyms, entities and
provenance. **None of that is to be re-derived.** No second PDF parser, no second
document representation, no second section detector, no second glossary pipeline.

---

# A CONSTRAINT THAT CHANGES THE DESIGN

The brief says the FTS index should persist "with the application database", and the
repository's own guards forbid exactly that.

`backend/tests/test_db.py`:

```python
# Grown by DS-BE-007. Still pinned to an exact set: a table for a phase
# that has not started is a failure, which was the original guard's point.
assert tables == ["documents", "profiles", "schema_version", "translation_tasks"]

forbidden = {
    "pages", "sections", "paragraphs", "glossary",
    "tasks", "chat_sessions", "chat_messages", "chunks_fts",
}
assert not forbidden & set(tables), f"speculative tables present: {forbidden & set(tables)}"
```

`backend/tests/test_isolation.py` asserts the same exact set. **`chunks_fts` is named
as forbidden**, and this is its literal purpose: a table reserved for a phase that had
not started.

Two candidate resolutions, and the criteria must settle this explicitly:

**(A) Add `chunks_fts` to the application database.** Requires editing both guards.
There is precedent — `openai` was removed from a forbidden list in DS-BE-002 and
`onnxruntime` in DS-DOC-001, each because the phase that needed it began, with the
reasoning recorded in place. Paper QA is the phase `chunks_fts` was reserved for.

**(B) Index each document in its own SQLite file in the document's directory** —
`search.db` beside `ir.json`, `analysis.json`, `mono.pdf` and `dual.pdf`. No guard
changes, no migration, no schema version bump. Document isolation stops being a
`WHERE` clause and becomes structural: a query against document A *physically cannot*
reach document B, because they are different files. Invalidation is deleting a file.
The whole index is deleted with the document, like every other derived artifact.

**The design question for you**: which should the criteria require, and why? If you
choose (A), say what justifies editing two guards that exist to prevent exactly this.
If you choose (B), say what it costs.

Measured: SQLite 3.53.1 with FTS5 and `bm25()` available. The default `unicode61`
tokenizer splits `resnet-50` into `resnet` and `50`, so a bare `resnet` query already
matches — the tokenizer is not the threat to identifiers that aggressive query
normalisation would be.

---

# GROUND TRUTH — what exists

```python
# app/document/models.py
ParagraphIR:  id, section_id (str|None), text, page_number, page_range,
              block_ids: list[str], bboxes, is_abstract
TextBlockIR:  id, page_index, page_number, layout_class, bbox, text,
              font_size, caption_of
SectionIR:    id, title, level, page_range, parent_id, is_references
DocumentIR:   document_id, content_hash, source_filename, page_count, metadata,
              sections, pages, paragraphs, page_mapping, has_text_layer, ocr_required

# layout_class is one of exactly ten values:
# title, plain text, abandon, figure, figure_caption, table, table_caption,
# table_footnote, isolate_formula, formula_caption

# app/context/models.py
DocumentAnalysis: provenance, status, domain, summary, sections,
                  glossary, acronyms, entities, errors
GlossaryEntry:    source_term, suggested_translation, definition,
                  is_translatable, category, paragraph_ids, confidence
AcronymEntry:     acronym, expansion (may be None), paragraph_ids
EntityEntry:      name, kind, paragraph_ids
```

**`abandon` blocks are running headers, footers and page stamps.** They are retained
in `PageIR.blocks` for coordinates but excluded from every paragraph. They must never
become evidence.

**`DocumentIR` lives at `<documents_dir>/<document_id>/ir.json`**, written atomically.
`DocumentAnalysis` lives beside it as `analysis.json`, with provenance carrying
`content_hash`, `pipeline_version`, `prompt_version`, provider identity and target
language. An `is_cache_valid` function already decides whether a stored analysis may
be reused.

**The source document's fingerprint is `DocumentIR.content_hash`** (sha256 of the PDF).

**Retrieval must work without `DocumentAnalysis`.** 468 seconds of analysis is the
reason: a basic search must not depend on it. With analysis, glossary and acronym
assistance may improve results. Analysis is lazy and must not be triggered silently by
a search.

---

# WHAT THE CRITERIA MUST COVER

## Scopes — enforced in the backend, not the UI

Four scopes: **Selection**, **Page**, **Section**, **Whole Paper**.

Scope is a correctness boundary, not a filter the frontend applies afterwards. A page
query that searches the whole paper and filters is a failure.

A suggested request shape (reconcile with existing API conventions — the implementation
follows the repository, not this):

```json
{"query": "...", "scope": {"type": "whole_paper"}, "top_k": 8}
{"query": "...", "scope": {"type": "page", "page": 4}}
{"query": "...", "scope": {"type": "section", "section_id": "..."}}
{"query": "...", "scope": {"type": "selection", "paragraph_ids": ["..."]}}
```

**Selection is special**: the selected source is the primary evidence. It must not run
an unrestricted whole-document search and present that as the selection. Frontend
selection UX is out of scope; the backend contract is what this task establishes.

## Four decisions the criteria must settle explicitly

1. **Should headings, captions and references be indexed separately from body prose?**
   Likely: body prose is the primary corpus; headings are a boosting signal rather than
   prose evidence; captions are plausibly searchable (`What does Figure 3 show?`);
   references contain query terms but should not outrank body discussion about them;
   `abandon` is never evidence. Settle it, with the reasoning.

2. **Does neighbour expansion happen before or after ranking?** The brief says after,
   and forbids ranking giant concatenated windows. Say so, or say why not.

3. **Do `DocumentAnalysis` summaries participate in candidate generation, or only in
   query expansion?** A summary is a model's paraphrase, not source text — evidence must
   come from `DocumentIR`. But a summary could suggest query terms. Which is it?

4. **How does Selection scope bypass or constrain retrieval?**

## Citation grounding — the core rule

**Citation metadata never comes from an LLM.** Every hit carries the real `page_number`,
`paragraph_id` and `section_id` from the `DocumentIR`. Page citation accuracy must be
**100%** for correctly represented evidence; a wrong page is a P0 failure.

Each evidence item needs a stable local identifier (`E1`, `E2`, …) so a later answer
generator can cite `[E1]` and the application resolves it to a real page and section.
This is the whole reason retrieval precedes answer generation.

## Query handling

* **Conservative normalisation.** Whitespace, Unicode, punctuation — and nothing that
  destroys `ResNet-50`, `CIFAR-10`, `VLA`, `F(x)`.
* **Acronym expansion only where the paper states it.** `DocumentAnalysis` records
  `expansion: None` for 24 of 29 acronyms; inventing one would be a fabrication.
* **Chinese query against an English paper.** `“作者如何解决退化问题？”` must be able to
  reach `degradation problem`. The evidenced glossary can bridge this, and it is one of
  the strongest reasons to reuse `DocumentAnalysis` here. Expansion is deterministic
  glossary lookup — **not** machine translation of the query.
* **No AI-generated query expansion.** Retrieval stays deterministic and testable.

## Evidence bundle

Bounded, deduplicated, and ordered by priority (highest-ranked evidence, then direct
neighbours, then lower-ranked). Neighbour expansion creates overlapping windows and
must not send the same paragraph twice. **Evidence text comes from `DocumentIR`** —
never rewritten, never paraphrased.

## Benchmark

Real papers only for the final evidence — **ResNet** (computer vision) and **Diffusion
Policy** (robotics / embodied / control terminology), both already in the validation
history. At least 10 questions each, covering exact terminology, concept explanation,
method, experiment, dataset, motivation, acronym, section-specific and cross-language
queries, with expected relevant paragraphs or pages recorded per question.

Metrics: `Hit@K` (does top-K contain expected evidence?). `MRR` if easy. **Do not
introduce a complex IR evaluation framework.** The product question is "does top-K
contain enough source for a future answer model?", not "is the gold paragraph always
ranked first?".

**Ablation**: raw FTS versus glossary-assisted expansion, especially bilingual. This
tests whether the semantic layer that did not pay for translation pays here.

**Failure taxonomy** before any remedy: tokenization, synonym, acronym,
Chinese-English mismatch, scope, candidate filtering, BM25 lexical limitation. If a
query class fails, name it — do not reach for embeddings. **Embeddings are explicitly
out of scope**, and so are Chroma, FAISS, Milvus, Qdrant, Pinecone and embedding APIs.

## Scope benchmark

The same query under whole-paper, the correct section, a **wrong** section, the correct
page and a **wrong** page — verifying scope genuinely constrains candidates rather than
being cosmetic.

## Safety and regression

Headers/footers must not become top evidence merely because a paper title repeats on
every page. `abandon` is excluded. Document isolation is P0: a query against A must
never return B's paragraphs. Index idempotency: indexing twice must not duplicate rows.
Source fingerprint changes must invalidate a stale index rather than silently
representing a new PDF. No `DocumentIR` mutation. No LLM required for retrieval. No
translation regression. Non-destructive migration — never solve this by deleting the
database.

## Privacy

Do not log the whole paper or whole evidence bundles. `document_id`, query length,
scope, top_k, latency and hit count are acceptable. Be conservative with raw user
questions.

## Performance

Measure index build time, cached query latency, scope-filtered latency and database
size growth. Do not impose millisecond targets without measurement, but interactive
local retrieval should be reasonably fast.

## The decision this task ends with

```
SUFFICIENT
SUFFICIENT WITH GLOSSARY EXPANSION
INSUFFICIENT FOR <named query class>
```

# Explicitly not applicable

Answer generation (DS-QA-002) · embeddings and vector stores · frontend UI · a second
PDF parser · re-deriving any Document Intelligence artifact.

---

# OUTPUT FORMAT

Return:

1. **P0 criteria** — numbered, objectively verifiable, each with a rationale.
2. **P1 criteria**, 3. **P2 criteria**.
4. **Explicitly not applicable**, and why.
5. **Direct answers to the four decisions and to the index-location question**, with
   reasoning.
6. **Any premise you believe is wrong** — including anything in the ground truth here
   you think is mistaken, or any part of this plan you believe would produce a
   retrieval layer that looks correct and is not.

Be specific about observable behaviour. Where a judgement is a matter of degree, say
what threshold is defensible and why.
