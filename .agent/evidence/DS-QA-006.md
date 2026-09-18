# Evidence — DS-QA-006 Retrieval Ranking Refinement

- **Date:** 2026-09-18
- **Agent:** DeepSeek (Claude Code CLI)
- **Acceptance criteria:** `docs/acceptance/DS-QA-006.md` (Gemini, frozen before implementation,
  with two `AC_CHANGE_REQUEST`s, both resolved)
- **Baseline:** `33be9d9` (DS-QA-005)
- **Verdict:** **The gate passes on every clause, and the change is two things: term coverage
  added to the fused score, and a length filter that was destroying the term these questions turn
  on.** Twelve of the thirty-three benchmark questions move; none regress.**

## What was built

```
backend/app/qa/query.py      content_terms + coverage; single digits kept
backend/app/qa/fusion.py     COVERAGE_ALPHA, an optional coverage term in the fused score
backend/app/qa/retrieval.py  coverage computed over the candidate pool
backend/app/qa/models.py     EvidenceItem.coverage_score, Diagnostics.ranking_strategy
backend/tests/test_qa_expansion.py   +11 tests
```

**The task was bounded by measurement before it was bounded by design.** Gemini rejected five
mechanisms on evidence — the RRF sweep, path weighting, block-type penalties, MMR diversity and
phrase boosting — and the data agreed with all five rejections.

## Verification

```
backend       817 passed   (807 before this task)
frontend      150 passed
typecheck     PASS
build         exit 0
bundle        307.03 kB initial (ceiling 350 kB) — unchanged; backend-only change
real browser  48/48 against the real backend and the real provider in Edge
```

### The gate, evaluated over all 33 questions

Before is RRF alone; after is the shipped code. Both measured in the same run.

```
              before   after     gate
Hit@1          48.5%   54.5%
Hit@3          60.6%   69.7%
Hit@5          63.6%   75.8%    >= 75%     PASSES
Hit@10         78.8%   84.8%
LOW_RANK lifted   —     4/7      >= 4 of 7  PASSES
regressions       —      0       == 0       PASSES
```

Twelve questions moved:

```
dp  PARAPHRASE   10 ->  3   How is a robot policy represented?      LIFTED
dp  PARAPHRASE    9 ->  5   What role does diffusion play...        LIFTED
dp  PARAPHRASE    6 ->  3   How is a rollout defined?               LIFTED
ppo EXACT_TERM   13 ->  1   What is Algorithm 1 in this paper?      LIFTED
dp  PARAPHRASE    4 ->  1   What observations condition the policy?
ppo ACRONYM       2 ->  1   What does A2C stand for?
ppo ENTITY_TYPE   3 ->  2   Which benchmark was the method compared on?
ppo PARAPHRASE   11 -> 10   How does the method limit how far...
dp  EXACT_TERM    1 ->  5   How is the policy trained from demonstration?
resnet PARAPHRASE 9 ->  9   Why does increasing depth hurt plain networks?
resnet ENTITY_TYPE 8 -> 10  What datasets are used for evaluation?
ppo CROSS_LANG  None->None  该方法如何限制策略更新的幅度？   (needs the rewrite, not ranking)
```

Three of those deserve naming rather than burying: **"How is the policy trained from
demonstration?" fell from 1 to 5** and **"What datasets are used for evaluation?" fell from 8 to
10**. Neither leaves the top five, so neither is a regression by the frozen gate — but both are
rank changes caused by this task, and the datasets one has a cause worth recording: its gold
paragraph says "We evaluate on CIFAR-10", and the question asks about "evaluation" — different
tokens, so the gold earns no coverage while paragraphs containing the question's actual words
overtake it. A stemmer would fix that; adding one was not in the criteria and is not proposed on
the strength of one question.

### Failure taxonomy, before any change

The premise — "correct evidence sits at rank 6–8" — was tested first, and the distinction that
mattered was between *absent* and *merely low*:

```
total Hit@5 misses            12
NOT_RETRIEVED                  5   4 cross-language + 1 English lexical synonym
SINGLE_LIST_RANK               6   gold in the pool at 6-13; fused rank == best variant rank
QUERY_PATH_COMPETITION         1   fusion moved it down (entity variant 5 -> fused 8)
```

**Six of the seven ranking-class misses were never about fusion.** The single BM25 list already
ranked them where they landed. That is what pointed the task at ranking *within* the pool rather
than at fusion, at path weighting or at candidate depth — and the pool was already deep enough,
since every one of those golds sat inside the 20-candidate cap.

## The finding that decided the task

The first implementation reached **3 of 7 lifts and Hit@5 72.7% — the gate failed.** The cause was
one line of the specification, and it was traced rather than guessed:

```
"What is Algorithm 1 in this paper?"
  content_terms with the length filter   ["algorithm"]        gold 1.00, 10 others 1.00 -> tie, RRF decides
  content_terms keeping the digit        ["algorithm", "1"]    gold 1.00, others 0.50 -> separates
```

§4.1 filtered out tokens shorter than two characters. An academic question names things as
`Algorithm 1`, `Figure 3`, `Table 1`, `Eq. 4` — so the filter removed the most discriminative
token in the sentence and left a word the paper uses everywhere. **Keeping single digits gives
the fourth lift and regresses nothing.**

This is the same failure the repository opened with: `MATCH 'ResNet-50'` raising `no such column:
50`, because a rule that is right for prose is wrong for identifiers. Fourth occurrence in this
phase of the same pattern — measure, find the rule was the problem, not the mechanism.

## Where the numbers came from, and one of mine that was wrong

Gemini's acceptance session left its analysis scripts in `backend/tmp_test/`, run against the
artifacts this task published. They report 4 lifts and Hit@5 75.8% — measuring with
`signal_probe.coverage`, which has **no** length filter — while its own §4.1 specified a function
*with* one. The gate and the specification disagreed, and the specification was the wrong half.

**Two of my own review claims were refuted by measurement and are recorded as refuted:**

* I prepared a change request arguing Gemini's stated `RRF(d)` range omitted multi-variant
  accumulation (a five-variant candidate should reach 5/61 = 0.082 against a stated ceiling of
  0.033). Measured: no candidate is retrieved by five variants at rank one, the observed maximum
  is 0.0313, and the stated range is exactly right. The objection was reasonable a priori and
  only measurement settled it.
* I wrote in `fusion.py` that α = 0.05 was "a nudge within" the fused band. A test asserting the
  real behaviour failed and showed it is not: 0.05 exceeds the entire RRF band, so coverage
  outranks rank consensus whenever coverage differs. The comment and the tests now say what the
  code does.

## Safety floors

```
deliberately unanswerable   16/16 abstained, 0 false supported answers
previously avoidable        5 of 6 answered, unchanged from before this task
citation structural validity 100%
all four scopes             unchanged; Selection still bypasses ranking entirely
```

## END-TO-END: the metric moved and the product outcome did not

Measured before and after on the seven low-ranked questions, with the real provider:

```
                        before   after
answered                     5       5
partial                      1       1
abstained                    1       1
of the 5 outside the window  4       4 answered
```

**Identical.** The retrieval metric improved by 12 points and the answers did not change, and the
reason was measured before the change was made: at `top_k = 8` only 2 of the 7 low-ranked golds
reach the model, and **4 of the 5 whose gold is outside the window were answered anyway** — the
neighbour paragraphs in the bundle carry the content. The ranking improvement is real and, on
this benchmark, invisible to the reader.

That is the honest headline, and it is why the product decision below is not "sufficient".

## Product decision: **B — RANKING IMPROVED BUT INSUFFICIENT**

The gate passes. The retrieval improvement is large on the paper where it applies (Diffusion
Policy Hit@5 60% → 90%) and zero on the one where it does not (ResNet unchanged, its remaining
misses being a lexical synonym and a cross-language query that ranking cannot reach).

It is **not** sufficient because the end-to-end outcome is unchanged, and **not** "not the
bottleneck", because five of twelve misses are still not retrieved at all. D was rejected: the
gains are not too small to justify the complexity — they cost one function and one optional
parameter — but they are not visible where it counts yet.

## Known limitations

1. **No product-visible gain on this benchmark.** Retrieval improved; answers did not.
2. **Coverage cannot separate candidates that share the question's words.** `Algorithm 1` worked
   only once the digit was kept; a question whose content terms are all common still ties.
3. **No stemming**, so "evaluation" in a question does not match "evaluate" in the paper — the
   cause of the one question that moved *down*.
4. **Two questions moved down within the top five** (1→5, 8→10), recorded above.
5. **Five of twelve misses remain NOT_RETRIEVED**, four of them cross-language, which is the
   rewrite's job and not ranking's.
6. **`α` is not tuned** — every value from 0.01 to 1.0 gives the same lifts and regressions.
7. **`backend/tmp_test/` is not committed.** It holds another agent's ad-hoc analysis scripts and
   pytest scratch databases, including temporary SQLite files; it is left on disk and excluded
   from this commit rather than deleted by me.

## Recommended next task

**DS-QA-007 — Hybrid Retrieval Experiment**, and only now is there evidence for it: five of
twelve misses are not retrievable by any lexical path, four of them cross-language, and ranking
has been shown to reach four of the seven that *are* retrievable. That is the first time the
remaining failure class has been isolated from ranking as a cause.

It is not recommended as "add embeddings": the experiment is to measure whether a local semantic
index recovers the cross-language class that the rewrite only partly reaches, with the frozen
Stage C gate from DS-QA-004 as the bar — and to report it as a measurement, not as an adopted
architecture.
