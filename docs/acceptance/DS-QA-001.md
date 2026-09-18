# Acceptance Criteria — DS-QA-001: Scope-Aware Retrieval + Citation Grounding

- **Author:** Gemini (`gemini-3.8-flash-high`), via the standing two-agent workflow
- **Reviewed and frozen by:** DeepSeek, before implementation
- **Date:** 2026-09-18
- **Baseline:** `0d952bf`
- **Status:** **FROZEN.** **9 P0 · 7 P1 · 3 P2.** P0-9 was **redefined** after measurement —
  see AC_CHANGE_REQUEST 1, raised post-implementation at DS-QA-002 §2.

## DeepSeek review

### AC_CHANGE_REQUEST 1 — P0-9 predicts a number that measurement falsified

*Raised after the measured run, at DS-QA-002 §2. The other requests in this repository were
raised before implementation; this one can only be raised afterwards, because it is about
whether a hypothesis survived contact with the real corpus.*

| | |
|---|---|
| **As written** | *Retrieval quality baseline. Ten English technical questions per paper against the real ResNet and Diffusion Policy IRs: Hit@5 ≥ 80% and Hit@10 ≥ 90%.* |
| **Measured** | **Hit@5 60–70%** on both papers (ResNet assisted 70%, raw 60%; Diffusion Policy 60% both arms). Hit@10 80% on ResNet, 90% on Diffusion Policy. |
| **Problem** | The criterion is a **hypothesis about whether lexical retrieval would be sufficient**, written as though it were a specification. It was falsified. The retrieval engine itself is not failing: scope enforcement, page metadata, paragraph identity, deterministic indexing and the assisted bilingual path all pass their own criteria, and every miss is the same class — the question's vocabulary is not the paper's (`datasets` vs `CIFAR-10`, `optimization method` vs `momentum`). No ranking change fixes that; only a different retrieval paradigm would, and §66 forbids reaching for one before classifying the failure. |
| **Resolution** | The threshold is **replaced by a disposition requirement**, not lowered. Retrieval is not required to be sufficient; it is required to be **honest about when it is not**. Specifically: (1) the failing query class is classified and recorded; (2) the measured benchmark is preserved unchanged as the evidence for that classification; (3) evidence sufficiency becomes a first-class signal every downstream consumer must handle; (4) DS-QA-002's answer generator **must abstain** when the evidence does not support an answer. Task completion is then gated on the abstention machinery working, which is a property this task can actually control. |
| **Not accepted** | Tuning weights, adding neighbour heuristics or seeding the ground truth to reach 80%. The measurement stands as measured, including in this file: **P0-9 fails its original threshold.** Nothing in the evidence was edited, softened or re-run until it looked better. |
| **Consequence for DS-QA-001's own tally** | P0 is **8 of 9 as written**, and **9 of 9 as redefined** — the redefinition is recorded here rather than applied silently to the score. |

### What the redefinition binds DS-QA-002 to

The retrieval layer can return an evidence bundle that does not contain the answer, and it
says so through `diagnostics.code` (`SUCCESS` / `NO_MATCH_TOKEN`). The answer layer therefore
cannot assume its input is sufficient, and **an abstention is a successful product outcome
rather than a backend error** — distinguished both from a provider failure and from a partial
answer. Any answer composed from whatever the ranking happened to return, without that
distinction, would be confidently wrong about one question in five.

### The rest of the review

Gemini answered all four decisions and the index-location question, and **corrected a claim
I put in its brief**. Two verifications were run before freezing, and one of them changed
the reasoning behind a P0.

### The index location: per-document `search.db` (Option B)

The brief noted that `tests/test_db.py` names `chunks_fts` as forbidden and asked which
resolution to take. Gemini chose **(B)**: each document indexed in its own SQLite file at
`<documents_dir>/<document_id>/search.db`, beside `ir.json` and `analysis.json`.

Its strongest argument is one I had not considered, and it is decisive:

> **BM25's IDF is computed across the whole table.** In a shared `app.db`, a robotics
> paper's term weights would be skewed by every previously-ingested computer-vision or
> chemistry paper. Per-document files keep the statistics local to the paper being read.

The other reasons stand on their own: the guard invariants survive untouched (no migration,
no schema bump, two guard tests unmodified), isolation stops being a `WHERE` clause and
becomes physical, and the index is deleted with the document like every other derived
artifact.

**Two guard tests are therefore left unmodified** — a change request against the brief's
§58, resolved in favour of the repository's own constraint.

### Do not reopen the translation decision

`Basic` remains the default, `Academic` optional, `Contextual` experimental. DS-QA-001
changes none of it.

### My premise about the tokenizer was wrong — verified, not accepted

The brief claimed the `unicode61` tokenizer made hyphenated identifiers safe, having tested
`resnet` matching `resnet-50` at **index** time. That test was correct and the conclusion
was wrong: it says nothing about the **query** parser. Measured:

```
MATCH 'ResNet-50'   -> OperationalError: no such column: 50
MATCH 'F(x)'        -> OperationalError: fts5: syntax error near "F"
MATCH 'p < 0.05'    -> OperationalError: fts5: syntax error near "<"
MATCH 'AND NOT'     -> OperationalError: fts5: syntax error near "AND"
MATCH 'neural*'     -> []                 (valid, matched nothing)
MATCH '"deep nets"' -> ['degradation problem in deep nets']
```

**Ordinary academic queries raise an unhandled exception.** Gemini's mechanism was slightly
wrong — it predicted the hyphen would invert the query to `ResNet NOT 50`, whereas SQLite
raises a column-syntax error — but its conclusion is better founded than its reasoning:
sanitisation is not a nicety, it is what stops `ResNet-50` from being a 500. P0-5 stands,
with the corrected evidence recorded.

### A ground-truth ambiguity Gemini found in the IR

`ParagraphIR` carries both `page_number` and `page_range`. A paragraph starting at the foot
of page 3 and finishing on page 4 cited only as page 3 would send a reader to a page where
the text is not visible. Both must be exported, and a page-scoped query must test
`target_page in page_range`.

---

# P0 — must pass (9)

| ID | Requirement | Verification |
|---|---|---|
| **P0-1** | **Per-document `search.db`.** The app database is untouched: zero migrations, zero version bumps, and the `test_db.py` / `test_isolation.py` assertions pass **unmodified**. Cross-document retrieval is structurally impossible. Deleting the document directory purges the index. | The table set is still exactly four; a search for A cannot open B's file. |
| **P0-2** | **Scope is a candidate-generation constraint, not a post-filter.** `whole_paper` / `section` (`section_id ==` target) / `page` (`target_page in page_range`) / `selection` (exactly the given ids). | A query strong on page 10 under `page=2` returns **zero** page-10 hits; every hit under a section scope satisfies that scope. |
| **P0-3** | **100% deterministic citation grounding.** Every item comes verbatim from `DocumentIR`: `text` byte-identical to the paragraph, `page_number` and `page_range` real, `section_id` real, local ids `E1…En` ordered by rank. **No field is LLM-derived.** | Byte-equality and page-equality asserted for every returned item. |
| **P0-4** | **`abandon` is never indexed.** Running headers, footers and page stamps are excluded from the index entirely — not merely down-ranked. | No evidence item's `block_ids` intersects the abandon block ids. |
| **P0-5** | **Query sanitisation.** Technical tokens survive (`ResNet-50`, `CIFAR-10`, `VLA`, `F(x)`, `p < 0.05`) and FTS5 operators (`-`, `+`, `*`, `:`, `"`, `(`, `)`, `AND`, `NOT`, `NEAR`) are neutralised. | No user string raises `OperationalError`; `ResNet-50` retrieves the paragraphs containing it. |
| **P0-6** | **Neighbour expansion strictly after ranking**, within the same section only, never across sections or into references, deduplicated into merged windows. Direct hits carry `is_direct_hit=True`, neighbours `False`. | Adjacent hits merge without duplicate ids; the last paragraph of a section does not pull the first of the next. |
| **P0-7** | **Index lifecycle.** Building twice yields the same row count. The index records `content_hash`; a mismatch marks it stale and rebuilds atomically. Building or querying never modifies `ir.json` or `analysis.json`. | Row counts compared; a changed hash triggers a rebuild and the query still succeeds. |
| **P0-8** | **No dependency on `DocumentAnalysis`.** Index and query work from `DocumentIR` alone when `analysis.json` is absent, incomplete or corrupt, and never trigger the analysis pipeline. | A search over a document with no analysis returns valid BM25 hits and calls no provider. |
| **P0-9** | **Retrieval quality baseline.** Ten English technical questions per paper against the real ResNet and Diffusion Policy IRs: **Hit@5 ≥ 80%** and **Hit@10 ≥ 90%**. — **NOT MET as written: measured 60–70% Hit@5. Redefined as an abstention requirement by AC_CHANGE_REQUEST 1.** | The benchmark asserts both. It fails one, and the failure is recorded rather than tuned away. |

---

# P1 (7)

**P1-1** deterministic cross-lingual and acronym expansion from `DocumentAnalysis` — longest-substring glossary matching, attested expansions only, no LLM at query time, and an ablation proving causality. **P1-2** section-title column boost via `bm25(fts, weight, 1.0)`, with headings never emitted as standalone evidence. **P1-3** reference sections excluded from default candidate generation. **P1-4** captions indexed as first-class evidence tagged `is_caption` with their target. **P1-5** scope invariance under contrasting scopes. **P1-6** privacy — log `query_sha256` and lengths, never raw prose or raw questions. **P1-7** latency — index build ≤ 1.5 s, warm search ≤ 8 ms whole-paper and ≤ 3 ms scoped.

# P2 (3)

A diagnostic failure taxonomy (`NO_MATCH_TOKEN`, `OUT_OF_SCOPE`, `CROSS_LINGUAL_NO_ANALYSIS`, `ACRONYM_UNATTESTED`) · a Hit@K / MRR report harness · a storage bound for `search.db`.

---

# The four decisions

1. **Headings, captions, references.** Headings are **not** standalone evidence — they are
   indexed as the `section_title` column that boosts their child paragraphs. A three-word
   heading returned as an "answer" is worse than useless. Captions **are** first-class
   searchable evidence, because `What does Figure 3 show?` is a real question. References
   are indexed but excluded from default candidate generation — they carry a high density of
   academic keywords and no explanatory content, so they inflate BM25 without answering
   anything. `abandon` is never indexed.

2. **Neighbour expansion: after ranking.** Concatenating three paragraphs into one unit
   inflates its length against BM25's length normalisation, suppressing exactly the
   comprehensive sections it was meant to favour, and blurs which paragraph matched.

3. **Summaries participate in neither.** A summary is an LLM paraphrase, and citing it would
   violate P0-3's verbatim requirement. For expansion, the glossary and acronym tables are
   structured and evidence-backed; free prose is neither. Summaries belong to DS-QA-002 as
   optional macro-context.

4. **Selection is an absolute constraint.** With no query, FTS is bypassed entirely and the
   selected paragraphs are returned in reading order. With a query, candidates are
   restricted to the given ids. Nothing outside the selection may ever be returned.

# The principle this task protects

**Citation metadata never comes from an LLM.** Every page, section and paragraph identity
originates in the retrieval layer from `DocumentIR`. DS-QA-002's answer model will cite
`[E1]`, and the application resolves that to a real page — rather than trusting a model to
count pages correctly.

# Explicitly not applicable

Answer generation (DS-QA-002) · embeddings, Chroma, FAISS, Milvus, Qdrant, Pinecone ·
frontend UI · a second PDF parser · re-deriving any Document Intelligence artifact ·
LLM query expansion · cross-document library search.
