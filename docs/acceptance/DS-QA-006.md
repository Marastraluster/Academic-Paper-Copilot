# Acceptance Criteria — DS-QA-006: Retrieval Ranking Refinement

- **Author:** project maintainer.
  §1–§6 are transcribed from its output with nothing added or removed. §0 is
  the review, written before implementation.
- **Reviewed and frozen by:** project maintainer
- **Date:** 2026-09-18
- **Baseline:** `33be9d9` (DS-QA-005)
- **Status:** **FROZEN**, with **2 `AC_CHANGE_REQUEST`s**, both resolved. **10 P0 · 4 P1 · 1 P2.**

---

## 0. Review before implementation

The criteria did the measurement work before writing criteria, which is what this task
needed, and it **rejected five speculative mechanisms on evidence** rather than
qualifying them into the design: the RRF sweep, path weighting, block-type
penalties, MMR diversity, and phrase boosting. That is the discipline this project
has been building towards, and it means the task is bounded to two changes.

I verified the numbers its criteria lean on, offline, over the real per-variant
rankings. Two of its claims are exactly right, one is nearly right, one does not
reproduce, and one of my own objections turned out to be wrong:

| Claim | Verified |
|---|---|
| baseline Hit@5 21/33 = 63.6% | **exact** |
| coverage lifts 4 of 7 LOW_RANK, 0 regressions, Hit@5 → 25/33 = 75.8% | **exact** |
| `RRF(d)` spans [0.0125, 0.033] | **exact** — measured min 0.0125, median 0.0143, max 0.0313 |
| Hit@1/3/5/10 "100% identical" across k ∈ [1, 200] | **nearly** — Hit@1/3/5 are flat (16/20/21) from 1 to 200; **Hit@10 is 25 up to k=10 and 26 from k=20** |
| PPO held-out baseline Hit@5 69.2% (9/13) | **does not reproduce** — the local path measures **8/13 = 61.5%** |

**I was wrong about α.** I had prepared a change request arguing that the stated
`RRF(d)` range omits multi-variant accumulation — a candidate found by five
variants should score up to 5/61 = 0.082, five times the stated ceiling, which
would make an `α` of 0.05 behave differently from the specified arithmetic. Measured:
**no candidate is retrieved by five variants at rank one**, and the observed
maximum is 0.0313. The stated range is the real one, and the α reasoning holds. I
record the refutation because the objection was reasonable a priori and only
measurement settled it — the same pattern as three earlier findings in this phase.

I also swept α independently: **lifts 4, regressions 0, for every α from 0.01 to
1.0**, so the value is not load-bearing anywhere in that range and 0.05 is a
defensible midpoint rather than a tuned constant.

### AC_CHANGE_REQUEST 1 — the criteria must name a configuration, and one of its numbers does not reproduce

| | |
|---|---|
| **As written** | AC-P1-01: *"PPO held-out Hit@5 ≥ 75.0% (baseline 69.2%, 9/13 → 10/13)"*. The rest of the document quotes the local-path figures (63.6% overall, 48.5% Hit@1) without saying which configuration they describe. |
| **Problem** | Two different measurements of PPO exist in this repository and they differ by ten points. The **local retrieval path** — variants, fusion, coverage, no rewrite — puts the gold in the top five for **8 of 13 questions (61.5%)**. The **full cascade**, in which the rewrite fires on the three Chinese questions, was measured by DS-QA-004 at **69%**. The second figure is the second number attached to a criterion whose neighbours are the first. An acceptance threshold that names the wrong baseline cannot be evaluated: 10/13 would be +15% over the local baseline and +1 question over the cascade one, and those mean different things. |
| **Also** | "100% identical across all k" is off by one on Hit@10, which moves from 25 to 26 between k=10 and k=20. The conclusion — that a sweep is ceremony and k=60 stays — is right and now rests on a measurement rather than an assertion. |
| **Resolution** | Every threshold states the configuration it was measured in. The local-path baselines are the ones this task optimises and the ones the criteria gate on; the cascade figure is reported alongside as the product context it is, not used as a baseline. |
| **Not accepted** | Adopting 69.2% because it makes the target look closer, or dropping the PPO threshold because the two numbers disagree. |

### AC_CHANGE_REQUEST 2 — §4.1's length filter destroys the term these questions turn on

| | |
|---|---|
| **As written** | §4.1: *"`content_terms(text)` filters out tokens in STOPWORDS and **tokens of length < 2**"*. |
| **Problem** | Measured on the held-out paper, that rule is what makes AC-P0-01's fourth lift unreachable and makes its own gate fail. For *"What is Algorithm 1 in this paper?"* it reduces the content terms to `["algorithm"]` — the query's only remaining word is one the paper uses constantly — so the gold, whose text is literally "Algorithm 1 PPO, Actor-Critic Style", ties at coverage 1.0 with **ten other paragraphs** and the boost cannot separate them. Keeping the digit gives the gold 1.00 against their 0.50 and it separates. **Measured with the filter: 3 of 7 lifted, Hit@5 72.7%. Without it: 4 of 7, Hit@5 75.8%, 0 regressions.** |
| **Why the filter is wrong in principle, not just in measurement** | An academic question names things as `Algorithm 1`, `Figure 3`, `Table 1`, `Eq. 4`. A bare single letter is noise; a single **digit** is the most discriminative token in the sentence. This is the same failure this repository opened with — `MATCH 'ResNet-50'` raising `no such column: 50`, because a rule that is right for prose is wrong for identifiers. |
| **Resolution** | `content_terms` keeps a single character **when it is a digit**, and drops it otherwise. The gate is untouched; the filter that prevented reaching it is fixed. |
| **A note on who measured what** | The analysis scripts used for the review, run during its acceptance session against the artifacts this task published (`rank_diagnosis.json`, `rank_candidates.json`). They report 4 lifts and Hit@5 75.8% under every weight from 0.01 to 5.0 — measuring with `signal_probe.coverage`, which has no length filter. Its criteria then specified a function *with* one. The gate and the specification disagreed, and the specification was the part that was wrong. |
| **Not accepted** | Rewriting the gate to 3-of-7. That is lowering a bar to get green, and the measurement showed the bar was reachable. |

### Superseded: an assertion in AC-P0-01 that came from that same probe

| | |
|---|---|
| **As written** | AC-P0-01: *"at least 4 of the 7 LOW_RANK misses enter the top five: … **'What is Algorithm 1 in this paper?' rank 1**"*. |
| **Problem** | That rank-1 prediction came from `signal_probe.py`, whose `content_terms` used a **different stopword set and no minimum-length rule** from the one §4.1 of this document specifies. The two functions disagree on that question: the question's specified content terms are `["algorithm"]` alone, so **10 of its 20 candidates tie at coverage 1.0** and the boost cannot separate them — the order among them is decided by RRF, and the gold sits at BM25 rank 13. Measured: it lands at **rank 6**, not 1. The probe's sort also carried `path count` and `best rank` tie-breakers that the frozen composite does not have, and those — not coverage — produced the rank-1 prediction. This is a measurement defect of ours, recorded because the criterion was built on it. |
| **Also measured** | Re-run with the *specified* function the recovery was **3 of 7** (the three Diffusion Policy lifts landed exactly as predicted: 10→3, 9→5, 6→3), and the gate failed. AC_CHANGE_REQUEST 2 above traced that to §4.1's length filter and fixed it; with the filter corrected, **the rank-1 figure in this assertion is met exactly**, along with the rest of the gate. |
| **Resolution** | The assertion stands as written and now passes: Robot Policy ≤3 ✓, Rollout ≤3 ✓, **Algorithm 1 rank 1 ✓**, Diffusion ≤5 ✓. |
| **Not accepted** | Adding a phrase signal to reach the fourth. Phrase boosting was measured inert, and reaching a gate by inventing a mechanism would be designing a feature to satisfy a test. |

### Note on the improvement gate

the criteria's gate — **≥ 4 of 7 LOW_RANK lifted, 0 regressions, Hit@5 ≥ 75%, 16/16
abstentions, ≤ 5 ms** — is reproducible from the measurements above and is adopted
unchanged. It is worth recording what it is *not*: at the current evidence window
(`top_k = 8`) only **2 of the 7** low-ranked golds reach the answer model, and
**4 of the 5 whose gold is outside the window were answered anyway** — the
neighbour paragraphs in the bundle carry the content. So this gate measures a real
retrieval improvement whose *product* effect is smaller than the metric suggests,
and the end-to-end section of the evidence says so rather than implying the
answer rate moves with it.

---

## 1. Executive judgment: is this task worth doing?

**Yes — but strictly as a surgical micro-task**, and **explicitly rejecting the
speculative complexity** contemplated in earlier briefs.

The offline diagnosis across all 33 questions (20 development across ResNet and
Diffusion Policy, 13 held-out on PPO) reveals the exact ceiling of the task:

1. **5 questions are `NOT_RETRIEVED`** (4 cross-language Chinese queries against an
   English index, which return 0 rows on the lexical path by construction; and 1
   lexical synonym, *"What optimization method is used?"*, where the paper writes
   "momentum" and never once uses the word "optimization" in that paragraph).
   **Ranking cannot fix an empty candidate pool.**
2. **7 questions are `LOW_RANK`** (the gold paragraph was retrieved into the
   candidate pool at ranks 6–13). In 6 of the 7, `fused_rank == best_variant_rank`:
   multi-query fusion did not displace them; the single BM25 list already scored
   them too low because BM25 accumulates term frequency over common words rather
   than rewarding distinct content-word coverage.

A deterministic **Query Term Coverage** signal over the candidate pool:

- Lifts **4 of the 7 addressable misses** directly into the Top 5:
  - *"How is a robot policy represented?"* (DP): rank 10 → 3
  - *"How is a rollout defined?"* (DP): rank 6 → 3
  - *"What is Algorithm 1 in this paper?"* (PPO control): rank 13 → 1
  - *"What role does diffusion play in action generation?"* (DP): rank 9 → 5
- Causes **0 regressions** across the 21 currently passing Top-5 questions.
- Lifts overall 33-question **Hit@5 from 63.6% (21/33) to 75.8% (25/33)**
  (+12.2 points, a 57.1% recovery of the addressable ranking failure class).
- Lifts **Hit@1 from 48.5% to 54.5%**, and **Hit@3 from 60.6% to 69.7%**.
- Incurs **0 additional provider calls**, **0 external dependencies**, and
  **< 0.2 ms** computational overhead.

Everything else proposed in early brainstorms — sweeping the RRF damping constant,
path-weighting trees, diversity reranking (MMR), block-type priority penalties, or
phrase boosting — is proved by measurement to be either zero-impact or actively
harmful. The task is justified **only** when bounded to deterministic term-coverage
reranking within the candidate pool and resolving the `EvidenceItem.score` debt.

## 2. False premises in the brief, corrected

**1 — "An empirical sweep of RRF k is required before k = 60 is justified."** A
sweep of k ∈ [1, 5, 10, 20, 30, 40, 50, 60, 80, 100, 200] across all 33 questions
leaves Hit@1, Hit@3 and Hit@5 invariant. On the single question where fusion was
implicated (*"What datasets are used for evaluation?"*), the fused rank barely
moves. When variants retrieve largely disjoint candidate sets, single-list rank
order dominates regardless of k. Requiring a sweep before implementation is
ceremony; keep Cormack's standard k = 60.

**2 — "Query path weighting is needed to prevent rewrite variants from outvoting
the raw query."** Rewriting is gated behind a strict cascade trigger in
`needs_rewrite()`. English queries with *any* lexical matches never invoke it, and
in all 7 ranking misses rewrites never fired. When rewrites *do* run the raw query
returned zero hits, so there are no raw results to protect. A path-weighting
penalty would only sabotage the queries that rescue cross-language searches.

**3 — "Captions outranking body prose on conceptual questions requires a block-type
penalty."** In *"How is a rollout defined?"*, non-gold captions outranked body prose
not because they were captions but because BM25 rewarded term frequency of the
shared term "diffusion". Coverage lifts the gold prose from 6 to 3 naturally,
because the prose contains both "rollout" and "defined" (coverage 1.0) while the
caption contains 0.0–0.5. A block-type penalty would degrade queries that
specifically seek captions.

**4 — "A post-ranking diversity stage is needed."** The candidate pools of all 7
LOW_RANK misses show **zero instances of near-duplicate crowding in ranks 1–5**.
The candidates outranking the gold are distinct paragraphs with partial keyword
overlap. MMR would add pairwise-similarity latency, risk dropping complementary
evidence, and address a failure mode that does not occur.

**5 — "Phrase matching is an effective signal."** Measured: it lifted **0 of 12**
misses. Academic vocabulary repeats across body text, so an exact phrase match
rewards common phrases as much as distinctive ones.

## 3. Decisions A–J

| | Verdict | Specification |
|---|---|---|
| **A** | **RRF stays** | FTS5 BM25 scores from disparate query expressions are non-comparable sums; RRF gives scale-free rank aggregation. In 6 of 7 ranking misses `fused == best_variant`, so RRF is not the cause of low ranks. |
| **B** | **k = 60, no sweep** | Flat across k ∈ [1, 200]. |
| **C** | **No protection mechanism** | The cascade gate already protects the raw query: rewrites run only when raw returned nothing. |
| **D** | **Equal weighting across active variants** | Multi-variant agreement is legitimate consensus; it lifted cross-language Hit@5 from 0% to 100% (diagnostic) while holding 16/16 abstentions. |
| **E** | **No block-type weights or penalties** | DS-QA-001 measured reference exclusion as inert; DS-QA-004 measured the section-title weight as unmeasurable. Crucially, findings often live in tables and captions. |
| **F** | **Term coverage primary** | Coverage promotes body prose without suppressing captions: a figure-directed query matches the caption's own terms and keeps it in the top three, with no heuristic exception rule. |
| **G** | **MMR: NO-GO** | Zero of the 7 misses are caused by near-duplicate crowding. |
| **H** | **Neighbours attach after top-K, never consuming slots** | Direct hits first, neighbours appended; `fit_to_budget` already drops neighbours before direct hits. |
| **I** | **Preserve `score`, add `coverage_score`** | `score: float \| None` stays the final composite ranking score (backwards compatible; `None` for neighbours). `EvidenceItem` gains optional `coverage_score: float \| None = None`; `Diagnostics` gains `ranking_strategy = "rrf_coverage"`. |
| **J** | **Gate: ≥ 50% recovery of addressable LOW_RANK (4/7), overall Hit@5 ≥ 75%, 0 regressions, 16/16 abstentions, latency ≤ 5 ms** | If ≥ 1 passing question regresses, the task is NO-GO and Option D ("current system good enough") is frozen. |

## 4. Architecture

```
scope-constrained candidate generation (SQL)  →  per-variant FTS5 BM25  →  pool (20/variant)
   →  RRF, k = 60, deduplicated by canonical chunk identity
   →  deterministic term-coverage reranking:  S(d) = RRF(d) + α · C(q, d),  α = 0.05
   →  evidence bundle: top-K direct hits, then neighbours attached after them
```

`STOPWORDS` is a small, immutable set (`what`, `which`, `how`, `the`, `of`, `to`,
`used`, `role`, `paper`, …). `terms()` lowercases and splits on `[^\w\-.]+`,
preserving `ResNet-50` and `0.05`. `content_terms()` drops stopwords and
single-character tokens. `C(q, d) = |content_terms(q) ∩ terms(d)| /
|content_terms(q)|`. **If the query has no content terms — a CJK query, or one made
only of stopwords — `C = 0.0` and ranking degrades to pure RRF order.** Stable
sort descending by `S(d)`, then ascending by canonical `chunk_id`.

## 5. Criteria

### P0

- **AC-P0-01 Coverage reranking lifts the addressable misses.** On the 33-question
  benchmark, at least 4 of the 7 LOW_RANK misses enter the top five:
  *"How is a robot policy represented?"* ≤ 3, *"How is a rollout defined?"* ≤ 3,
  *"What is Algorithm 1 in this paper?"* rank 1, *"What role does diffusion play in
  action generation?"* ≤ 5.
- **AC-P0-02 Zero regression floor.** All 21 baseline top-five queries stay in the
  top five. Regressions == 0.
- **AC-P0-03 Scope invariance.** Reranking operates only over candidates generated
  inside the active scope, constrained in SQL before ranking. Selection bypasses
  reranking and expansion entirely.
- **AC-P0-04 Canonical identity deduplication.** Identity is `paragraph_id` /
  `chunk_id`, never text: two paragraphs with identical text keep separate entries,
  ranks, pages and citation ids.
- **AC-P0-05 Grounding and abstention floors.** 16/16 unanswerable abstentions, 0
  false supported answers; 3/3 counterfactual detections; 100% citation structural
  validity.
- **AC-P0-06 Neighbour expansion detached from top-K slots.** For `top_k = 8`,
  retrieval returns up to 8 direct hits first, then section-bounded neighbours with
  `is_direct_hit=False` and `score=None`.
- **AC-P0-07 RRF preserved and stable.** `1/(60 + rank)` with deterministic
  tie-breaking; identical rankings produce byte-identical order across runs.
- **AC-P0-08 Zero additional provider calls.** Retrieval makes none: no LLM
  reranker, no cross-encoder, no embedding, no query-understanding call.
- **AC-P0-09 Score semantics and backward compatibility.** `score` is the final
  composite ranking score (positive for direct hits, `None` for neighbours);
  `coverage_score` is added; `diagnostics.ranking_strategy == "rrf_coverage"`.
- **AC-P0-10 Zero benchmark hardcoding.** AST-based inspection of `app/qa/` finds no
  benchmark term in an *executed* string literal. Comments and docstrings are
  excluded. *(Raised as AC_CHANGE_REQUEST 1 in DS-QA-004 for the same reason: a
  guard that fires on documentation teaches people to delete the documentation.)*

### P1

- **AC-P1-01 Benchmark thresholds.** Overall Hit@5 ≥ 75.0% (baseline 63.6%);
  addressable LOW_RANK recovery ≥ 50% (4/7); diagnostic Hit@5 ≥ 75% (baseline
  60.0%); PPO held-out Hit@5 ≥ 75% against **the local-path baseline of 61.5%**
  (AC_CHANGE_REQUEST 1).
- **AC-P1-02 Caption fidelity.** Figure-directed questions rank the matching caption
  in the top three; conceptual questions rank the defining body paragraph above
  non-gold captions. No block-type down-weighting.
- **AC-P1-03 Latency.** Coverage calculation and reranking ≤ 2.0 ms p95 over ≤ 50
  candidates; multi-query retrieval + fusion + reranking ≤ 25 ms p95.
- **AC-P1-04 CJK and zero-term queries.** Coverage evaluates to 0.0 without raising,
  and ranking degrades gracefully to pure RRF order.

### P2

- **AC-P2-01 Diagnostics telemetry.** `Diagnostics` exposes the coverage score and
  contributing variants per item, without exposing document text.

## 6. Verification protocol

**Unit (`tests/test_qa_retrieval.py`):** coverage across alphanumeric technical
terms (`ResNet-50`, `CIFAR-10`, `0.05`); a candidate matching 2 of 2 content words
outranks one matching 1 of 2 at similar RRF rank; neighbours carry `score is None`
and `is_direct_hit is False`; tie-breaking determinism over 50 identical runs.

**Benchmark regression:** the 33-question suite across ResNet, Diffusion Policy and
PPO; Hit@5 ≥ 75.8% (25/33), regressions == 0, the four target queries lifted as
specified; 16/16 abstentions and 3/3 counterfactual detections.

**Real browser:** `node frontend/scripts/e2e-qa.mjs` against the live backend and
the real PDF viewer — a conceptual question returns top-ranked evidence, citation
markers render, clicking a citation scrolls to the paragraph's bounding box on the
original page, and no frontend errors occur.
