# Evidence — DS-QA-001 Scope-Aware Retrieval + Citation Grounding

- **Date:** 2026-09-18
- **Agent:** DeepSeek (Claude Code CLI)
- **Acceptance criteria:** `docs/acceptance/DS-QA-001.md` (Gemini, frozen before implementation)
- **Baseline:** `0d952bf`
- **Verdict:** **The retrieval layer is built, tested and correct. P0-9 — the quality
  baseline — FAILS, and the failure is classified rather than explained away. A
  pre-existing `DocumentIR` defect that made half the sections empty was found and fixed.**

## What was built

```
backend/app/qa/models.py       Scope, EvidenceItem, EvidenceBundle, Diagnostics
backend/app/qa/query.py        sanitisation + deterministic expansion
backend/app/qa/index.py        the per-document FTS5 index
backend/app/qa/retrieval.py    scopes, ranking, neighbour expansion, dedup
backend/app/api/documents.py   POST /api/documents/{id}/retrieve
backend/tests/test_qa_retrieval.py   43 tests
```

**The index is one SQLite file per document** — `<documents_dir>/<id>/search.db` — not a
table in the application database. Gemini chose this and its decisive argument was one the
brief had not considered: **BM25's IDF is computed across the whole table**, so in a shared
database a robotics paper's term weights would be skewed by every previously-ingested paper.
The other two reasons stand on their own: document isolation becomes physical rather than a
`WHERE` clause, and the guards that pin the application's table set pass **unmodified**.

## This task was lost once and recovered — recorded because it happened

The session hit its context limit at the point of committing. Between that and the next
turn, the working tree was reverted to `0d952bf`: the four new modules, the acceptance
criteria, the tests and the evidence were gone, and **nothing had been committed**, so git
could not restore them. Surviving on disk were Gemini's raw output, `app/qa/__init__.py`,
the benchmark JSON, and `.pyc` files of the deleted modules.

Everything was replayed from the session transcript, which records each file's full
contents and each patch verbatim, and then **re-verified from scratch rather than assumed**:
the tree matched the pre-revert `git status` exactly, 712 tests passed, and the benchmark
reproduced its numbers to the digit. The replay is scripted and reviewable
(`.agent/results/qa/_replay.py`).

One operation was missed on the first pass — an append whose later patch then failed its own
assertion, which is how the omission was caught rather than absorbed. The failure was the
diagnostic.

## A `DocumentIR` defect found on the way — and it was major

Section scope returned nothing for "Identity Mapping by Shortcuts". The cause was not
retrieval.

`_assign_sections` chose a paragraph's section by **page**: a page-3 paragraph received the
last section that *started* on page 3. Academic sections routinely share a page, so on the
real ResNet paper:

```
BEFORE                            AFTER
8 of 16 sections owned           2 of 16 own
no paragraphs at all             no paragraphs

Abstract          0  ->   2      References        0  ->   2
3.1 Residual      0  ->   3      3.2 Identity Map  0  ->   8
3.3 Architectures 15 ->   4      A. Baselines      0  ->   7
```

Re-confirmed on the restored code by a fresh extraction of the real paper: **2 of 16**, the
two being `3. Deep Residual Learning` and `4. Experiments`, parent headings immediately
followed by their own subsections. Source PDF byte-identical afterwards.

**Nothing upstream noticed, because everything else was right**: reading order, headings and
page mapping all still passed. It surfaced only when Paper QA needed to retrieve *within* a
section. The docstring even said "the last heading that appeared before it in reading order"
while the code compared pages — intent and implementation had disagreed since DS-DOC-001.

Fixed, with a regression test that builds three headings on one page.

**The stored IR is not re-extracted by this task.** `ir.json` for the existing document
predates the fix, and the cache semantics are deliberate — a read never redoes the work.
`POST /extract-ir {"force": true}` applies it to an existing document.

## Verification

```
$ cd backend && .venv/Scripts/python -m pytest      → 718 passed   (674 before this task)
$ cd frontend && npm run test                       → 78 passed
$ npm run build                                     → exit 0
```

### Latency (P1-7) — measured, on the real 101-paragraph paper

```
index build             9.9 ms   (115 chunks = 101 paragraphs + 14 captions)
warm whole-paper        1.21 ms  median of 30   budget 8 ms   PASS
warm page-scoped        1.19 ms  median of 30   budget 3 ms   PASS
warm section-scoped     1.08 ms  median of 30   budget 3 ms   PASS
```

### The benchmark — and its failure

Ten questions per paper, ground truth defined by a phrase that must appear in the answering
paragraph.

```
paper                  mode        n   Hit@1   Hit@3   Hit@5  Hit@10
ResNet                 raw        10    50%    60%    60%    70%
ResNet                 assisted   10    60%    70%    70%    80%
Diffusion Policy       raw        10    50%    50%    60%    90%
Diffusion Policy       assisted   10    50%    50%    60%    90%
```

**P0-9 requires Hit@5 ≥ 80% and Hit@10 ≥ 90%. It fails on both papers for Hit@5**, and on
ResNet for Hit@10. Reported as a failure.

### Failure taxonomy — the classification §66 asks for before reaching for embeddings

Every miss is the same kind, and it is not a tokenizer, acronym or scope problem:

| Question | Expected paragraphs say | Question says |
|---|---|---|
| *What datasets are used for evaluation?* | `CIFAR-10`, `ImageNet` | "datasets" |
| *What optimization method is used?* | `momentum` | "optimization method" |

**Vocabulary mismatch.** The question's words are not the paper's words. BM25 cannot bridge
that: `CIFAR-10` and "datasets" share no term, and no amount of sanitisation, weighting or
neighbour expansion makes them. The two Chinese queries failed in the *raw* arm for the same
underlying reason — no shared vocabulary — and one of them had no analysis to expand from.

This is exactly the class §66 predicted and told us **not** to fix with embeddings before
classifying. Classified: it needs either query expansion or an answer model that can say it
found nothing.

### The semantic layer does pay here — measurably

Glossary-assisted expansion lifted ResNet from **60% → 70% Hit@5** and **70% → 80% Hit@10**
in the ablation. That matters: `DocumentAnalysis` produced *no* measurable benefit across
three translation experiments, and here it produces a clear one, at no model cost and no
latency. The hypothesis recorded at the end of DS-CTX-003 — that the semantic artifacts are
worth more to Paper QA than to translation — has its first supporting measurement.

### The title weight is not tuned, and this benchmark cannot tune it (P1-2)

The first version of `index.py` asserted 5.0 and the comment justified it. Re-running the
real ResNet set across the candidates shows the justification was invented:

```
 title w   Hit@1   Hit@3   Hit@5  Hit@10
     0.0    60%    70%    70%    80%     <- title column removed from ranking
     1.0    60%    70%    70%    80%
     3.0    60%    70%    70%    80%
     5.0    60%    70%    70%    80%
    10.0    60%    70%    70%    80%
```

Identical throughout. 5.0 is kept as a conventional middle value that leaves the signal
available, and the comment now says that instead of claiming a measurement it does not have.

### References do not crowd anything out (P1-3) — measured, then not implemented

The frozen criteria exclude references from default candidate generation. The brief's §52
does not require the filter, it requires the *measurement*.

```
             Hit@1   Hit@3   Hit@5  Hit@10
raw           60%    70%    70%    80%
no refs       60%    70%    70%    80%

references items returned across the 10 questions: 0
```

**Not one references paragraph reached a top-10 result, and excluding them changes nothing.**
The filter would be dead code whose only effect is to make section-scoped behaviour harder to
reason about. Recorded as measured-and-declined rather than silently skipped — and the
measurement is ResNet-only, so it is a finding about this paper rather than a universal.

The exclusion was applied by dropping references items from the ranked list, not by removing
them from the `MATCH` clause; the latter would additionally shift IDF for every remaining
term. The approximation is stated rather than hidden.

## Safety

| | |
|---|---|
| Citation page accuracy | **100%** — every item byte-equal to its IR paragraph, page equal too |
| Paragraph identity | **PASS** — `paragraph_id` is the IR's id, never derived |
| Sources come from `DocumentIR` | **PASS** — the analysis may expand a query; it never supplies evidence |
| Header/footer contamination | **none** — `abandon` is not indexed at all |
| Scope | **PASS** — all four, enforced in candidate generation |
| Artifacts untouched | **PASS** — indexing and querying leave `ir.json` and `analysis.json` byte-identical |
| Source immutability | **PASS** — no run modified a PDF |
| No LLM required | **PASS** — retrieval works with `analysis.json` absent |
| Privacy (P1-6) | **PASS** — the log carries `query_sha256` and `query_length`, never the question or any source text |

### Three bugs my own tests caught

1. **The Chinese expansion was ANDed with the user's words**, producing
   `"作者如何解决退化问题" AND ("degradation" "problem")`. The Chinese matches nothing in an
   English paper, so the query returned **nothing at all** — the expansion, the only part
   that could have matched, was dragged down by the part that could not. Expansions are now
   alternatives.
2. **ANDing every query word made BM25 a boolean filter.** `"degradation problem residual"`
   matched no single paragraph. Ranked retrieval exists to handle exactly that, so the terms
   are ORed and ranked.
3. **Neighbour expansion escaped a selection scope**, returning a paragraph the user had not
   selected. A selection is an absolute boundary, so expansion is now skipped for it.

### Found in review, after the fact, and fixed

- **`_WEIGHTS` was dead code.** The weights were documented in `index.py` and the real
  literal was hardcoded in `retrieval.py`, so editing `TITLE_WEIGHT` would have changed
  nothing while looking like it did. One exported `BM25_EXPRESSION` now feeds both.
- **`prepare()`'s docstring contradicted its code**, still describing the words as ANDed
  after the fix that ORed them. This is the same defect class as the `_assign_sections` bug
  above — prose and behaviour disagreeing — so it is fixed rather than tolerated.
- **P1-6 was not implemented.** The log recorded no query digest at all. It now records
  `query_sha256` and `query_length` and still no raw text.

### Gemini's correction, verified before accepting

The brief claimed the `unicode61` tokenizer made hyphenated identifiers safe, having tested
it at *index* time. That was true and the conclusion was wrong — it says nothing about the
*query* parser. Measured: `MATCH 'ResNet-50'` → `OperationalError: no such column: 50`,
`MATCH 'F(x)'` → syntax error, `MATCH 'p < 0.05'` → syntax error. Ordinary academic questions
raised an unhandled exception. Gemini's mechanism was slightly off — a column-syntax error,
not a `NOT` inversion — but its conclusion was right, and better founded than its reasoning.

The four tokens above are now covered by a test that asserts they **retrieve** the paragraph
containing them, not merely that they fail to raise: a sanitiser that discarded every symbol
would pass the second and fail the first.

## RETRIEVAL DECISION: **INSUFFICIENT FOR conceptual questions whose vocabulary differs from the source**

Not "sufficient", and not "sufficient with glossary expansion" — expansion measurably helps
(+10% Hit@5 on ResNet) but does not close the gap, and it cannot: the failures are questions
whose terms simply do not occur in the paper.

Everything else works. Scope is enforced, citations are exact, the index is isolated and
idempotent, and 8 of 10 questions return their evidence within the top ten.

**What DS-QA-002 needs to know**: the evidence bundle can legitimately come back empty or
without the answering paragraph, and an answer generator must be able to say so rather than
composing an answer from whatever ranking did return.

## Gemini criteria, as evaluated

**P0:** 8 of 9 pass. **P0-9 fails** and is the verdict above.
**P1:** 6 of 7 pass — P1-1, P1-2 (as the column, not as a tuned weight), P1-4, P1-5, P1-6,
P1-7. **P1-3 is measured and declined**, with the measurement recorded.
**P2:** 1 of 3 — the diagnostic is a flat `SUCCESS` / `NO_MATCH_TOKEN`; the richer taxonomy
(`OUT_OF_SCOPE`, `CROSS_LINGUAL_NO_ANALYSIS`, `ACRONYM_UNATTESTED`) is not implemented, and
neither is the MRR harness or the storage bound. All three are P2 and are recorded as absent
rather than approximated.

## Known limitations

1. **Hit@5 is below the bar** — 70% on ResNet, 60% on Diffusion Policy.
2. **Diffusion Policy has no analysis**, so its ablation arm is raw. The glossary-assisted
   measurement is ResNet-only, as is the references measurement.
3. **50 sections for 160 paragraphs** on Diffusion Policy suggests the section detector
   over-splits that layout. It does not affect retrieval, but it would affect a section-scoped
   UI.
4. **The stored `ir.json` predates the section fix** and is not regenerated automatically.
5. **The title weight is unmeasured** in the sense that matters: no candidate value,
   including omitting the column, changes any benchmark result.
6. **P2 is largely unimplemented** — see above.

## Recommended next task

**DS-QA-002 — grounded answer generation**, with one requirement this task's failure makes
non-negotiable: **the answer model must be able to report that the retrieved evidence does
not answer the question.** Twenty per cent of questions return evidence that does not contain
the answer, and a generator that always produces prose from whatever ranking returned would
be confidently wrong one time in five.
