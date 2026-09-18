# Evidence — DS-QA-004 Retrieval Recall Improvement

- **Date:** 2026-09-18
- **Agent:** DeepSeek (Claude Code CLI)
- **Acceptance criteria:** `docs/acceptance/DS-QA-004.md` (Gemini, frozen before implementation,
  with five `AC_CHANGE_REQUEST`s raised in review)
- **Baseline:** `6198bad` (DS-QA-003)
- **Verdict:** **Stage A and Stage B both work, and neither meets its own frozen gate.**
  Held-out Hit@5 went 62% → 69%, Hit@10 62% → 85%, cross-language went from retrieving nothing
  at all to retrieving something for a third of its questions, and 5 of 6 previously-abstained
  product questions now answer. Gate B's 80% bar was not reached, and Stage C stays closed by its
  own gate.

## What was built

```
backend/app/qa/query.py      independent query variants; bidirectional expansion; bounded entities
backend/app/qa/fusion.py     reciprocal rank fusion, k=60, dedup by chunk identity
backend/app/qa/retrieval.py  one query per variant, fused by rank; the rewrite trigger
backend/app/qa/rewrite.py    bounded rewriting: search phrases, never answers
backend/app/qa/answering.py  the cascade, and the fallback that keeps a rewrite failure local
backend/tests/test_qa_expansion.py   35 tests, all offline
```

**Each expansion is now its own query.** The old design concatenated everything into one
`(base) OR (exp1) OR (exp2)`. Within one MATCH every term shares the score, so appending common
words dilutes the rare ones that identify the answer — measured on the PPO paper, where the
paragraph titled "Algorithm 1 PPO" lost to four ordinary words. Variants are fused by rank,
where a query that matches nothing contributes nothing instead of dragging.

**Identity is the chunk, never the text.** A paper repeats its own sentences; merging two
identical paragraphs would lose a page, a section and a citation.

**The rewrite is reached on a diagnosis, not on every question.** `needs_rewrite` fires on "no
match at all" or "the question's script cannot appear in the index" — both observable without a
model. An exact model-name lookup never pays for a provider round trip.

## Verification

```
backend       805 passed   (768 before this task)
frontend      112 passed
typecheck     PASS
build         exit 0
bundle        299.44 kB initial (ceiling 350 kB) — unchanged, no frontend code changed
real browser  39/39 against the real provider in Edge
```

### Failure taxonomy — classified before anything was built

All 13 Hit@5 misses across both benchmarks (20 diagnostic + 13 held-out questions):

```
CROSS_LANGUAGE     5   a Chinese question against an English index retrieves zero rows by
                       construction. One ResNet case is fixed by the glossary when an analysis
                       exists; the rest are not reachable deterministically at all.
PARAPHRASE         5   "How does the method limit how far the policy may change in one update?"
                       vs the paper's "constraint on the size of the policy update".
ENTITY_TYPE        1   "What datasets are used?" vs CIFAR-10 / ImageNet / COCO.
LEXICAL_SYNONYM    1   "What optimization method is used?" vs SGD / momentum.
EXACT_TERM         1   "What is Algorithm 1 in this paper?" — outvoted by four common words.
```

**Entity-type expansion was 1 miss in 13**, which is why Gemini authorised Stage B immediately
rather than gating it behind a Stage A measurement.

### Baselines, reproduced before anything changed

```
set              mode        Hit@1  Hit@3  Hit@5  Hit@10
ResNet           raw          50%    60%    60%     70%
ResNet           assisted     60%    70%    70%     80%
Diffusion Policy raw/assisted 50%    50%    60%     90%
PPO (held out)   raw          38%    62%    62%     62%
```

### Stage A — deterministic expansion: **GATE A PASSES**

```
ResNet assisted   60% / 70% / 70% / 90%     Hit@10 80% -> 90%; the entity-type miss is fixed
ResNet raw        50% / 60% / 60% / 70%     unchanged — the control
Diffusion Policy  50% / 50% / 60% / 90%     unchanged — no analysis exists for it
PPO (held out)    38% / 62% / 62% / 62%     unchanged — no analysis exists for it
```

Gate A required diagnostic Hit@5 ≥ 65% (70% measured) and zero cold-paper regressions (none).
The gain is entirely on the one paper with a stored analysis, which is the honest shape of a
stage that reads existing metadata.

### Stage B — bounded rewriting: **GATE B FAILS on Hit@5, passes on latency**

```
set                  Hit@1  Hit@3  Hit@5  Hit@10
PPO held out         46%    69%    69%     85%     (baseline 38/62/62/62)
diagnostic cross-lang 33%   67%   100%    100%     (baseline  0/ 0/ 0/ 0)
every other class    unchanged on both sets
```

| Gate B | Required | Measured | |
|---|---|---|---|
| held-out PPO Hit@5 | ≥ 80% | **69%** | **FAILS** |
| cross-language Hit@5 | ≥ 80% | 33% held-out / 100% diagnostic | **FAILS** |
| abstention 16/16 intact | 16/16 | 16/16 | passes |
| latency | ≤ 1500 ms | 656–1291 ms | passes |

```
cost: 3 of 13 held-out and 3 of 10 diagnostic questions reached the rewrite; 0 failures
      median local retrieval 4.6 ms (held-out) / 5.7 ms (diagnostic)
      rewrite 656–1291 ms across 11 real calls
```

Every other class is **byte-identical** to its baseline, which is the evidence that variants
fuse rather than dilute.

### End-to-end product outcome — the number that matters

Six questions the paper answers, which earlier tasks recorded as abstentions:

```
answered              What datasets are used for evaluation?        (6 citations, entity expansion)
answered              What is the bottleneck architecture?          (5 citations)
answered              作者是如何解决退化问题的？                        (8 citations, rewrite)
answered              该方法如何限制策略更新的幅度？                     (4 citations, rewrite)
answered              用哪些环境来低成本地比较不同算法？                  (1 citation,  rewrite)
insufficient_evidence What optimization method is used?            (still a retrieval miss)
```

**5 of 6 recovered, all with citations.** The sixth is unchanged and is the honest part: it
matches plenty of paragraphs, so the rewrite trigger correctly never fires, and the paragraph
naming "momentum" still does not reach the top of the ranking.

### Unanswerable safety — 16/16, at the second attempt

```
16 unanswerable questions   16 abstained   0 false answers
```

**The first run of this measurement reported 15/16, and the failure was mine, not the system's.**
A question probing for the word "timestep" — genuinely absent from the ResNet paper — had been
reused verbatim against the Diffusion Policy paper, whose *subject matter* is diffusion and
whose paragraph 39 discusses the noise schedule by name. The system retrieved it and answered
correctly; my ground truth called that a hallucination. The script now verifies, against each
paper, that every unanswerable question's term is actually absent, and it refused my first
replacement ("dropout") too.

This is the **third time in this project** a benchmark's ground truth was wrong in the same way:
term absence used as a proxy for information absence. DS-QA-002 hit it twice.

### Real browser, real provider — 39/39

Microsoft Edge, the built bundle, the real backend, the real `Deepseek / deepseek-flash` profile,
against a copy of the application database. The two checks this task added:

```
a Chinese question on an unanalysed paper is now answerable   6 citations
a generic entity-type question reaches the dataset paragraphs 13 citations — "MS COCO, PASCAL
                                                              VOC, ImageNet (classification,
                                                              detection and localization)"
```

Every DS-QA-003 check still passes: the four scopes, the four answer states, citation rendering
and jumping, the highlight surviving a mode switch, translation and bilingual behaviour, the
layout at three widths, and source immutability.

The entity-type check failed on its **first** run (0 citations) and passed on a re-run with no
code change between them; the backend reproduces the answer in-process. Recorded as the same
model stochasticity DS-QA-002 documented as a ~5% withholding rate, not as a fixed defect.

## AC_CHANGE_REQUESTs, all five resolved before implementation

1. **AC-10's grep deleted documentation** — it matched five files of docstrings and comments,
   including the one recording *why* `MATCH 'ResNet-50'` is a parse error. The guard now reads
   executed string literals only, using the repository's own AST precedent.
2. **`max_tokens=150` and a 2.0 s abort cannot work against a reasoning model** whose thinking
   is billed against the output budget. Sized from measurement instead. The measurement then
   partly vindicated the criterion: the rewrite came in at 656–1291 ms.
3. **The criteria never said when the rewrite runs** — added a deterministic trigger.
4. **AC-14 needs a third real paper**, which the project does not have. Held-out numbers are
   recorded on first run and never revised after being seen.
5. **DS-QA-002's "zero provider calls" rule had to narrow**, or Stage B could never fire on the
   case it exists for — a Chinese question retrieves zero rows *by construction*. The rule now
   reads "the answer model is never called on empty evidence", which is what it was defending,
   and the four DS-QA-002 tests assert that instead.

## PRODUCT DECISION: **B — DETERMINISTIC + BOUNDED REWRITE SUFFICIENT**, with Gate B not met

The architecture question is settled by evidence: Stages A and B both work, neither regresses
anything, and together they are what the product keeps. **Stage C remains closed** by Gemini's
own frozen gate, which requires a proof of concept this task was not authorised to run.

What is *not* settled, and is recorded as a failure rather than softened: **Gate B's 80% Hit@5
bar was not reached** (69% held-out, 33% cross-language held-out). The system is materially
better — held-out Hit@10 62% → 85%, the dominant failure class from 0% to a third — and it is
not yet good enough to call the retrieval problem closed.

## Known limitations

1. **Gate B fails.** Residual misses remain concentrated in cross-language and paraphrase.
2. **One cross-language question of three still misses at Hit@5** on held-out; it lands at rank
   6–8, so it is retrievable but not well-ranked.
3. **The rewrite costs ~1 s and is paid by any question whose local retrieval comes back empty**,
   including genuinely off-topic ones. Measured on 23 questions: 6 paid it.
4. **Entity expansion needs an analysis**, so on a freshly uploaded paper the entity-type class
   is untouched. That is the tier constraint, working as specified.
5. **The rewrite's quality is unmeasured as such** — only its effect on retrieval. No audit of
   whether the phrases are good, only of whether the results improved.
6. **`EvidenceItem.score` now carries a fused RRF value**, not raw BM25. Its docstring says so;
   any consumer treating it as a BM25 score would be reading it wrong.
7. **The DS-QA-002 limitations stand**: ~5% of answers are withheld by the validator, and
   retrieval can still miss conceptually related evidence.

## Recommended next task

**DS-QA-005 — Selection QA mapping.** It is now the smaller of the open items and the one whose
machinery already exists: the highlight, the coordinates and the jump are built and verified, so
what is missing is the DOM-selection-to-`ParagraphIR` mapping and nothing else.

Hybrid semantic retrieval stays closed. Its gate requires residual Hit@5 below 80% after Stage B
*and* a proof of concept recovering ≥ 60% of what remains without regressing exact lookups — the
first condition is met and the second has never been run, so the honest next step on retrieval is
to improve ranking for the questions that now retrieve at rank 6–8, which is a fusion and
weighting problem rather than a semantic one.
