# Acceptance Criteria — DS-QA-006: Retrieval Ranking Refinement

- **Author:** Gemini (`gemini-3.8-flash-high`), Independent Acceptance Criteria Author
- **Lead Engineer:** DeepSeek (implementor)
- **Date:** 2026-09-18
- **Baseline:** `79ed9ec` (DS-QA-005)
- **Status:** **PROPOSED & FROZEN FOR IMPLEMENTATION**
- **Classification:** **10 P0 · 4 P1 · 1 P2**

---

## 1. Executive Judgment: Is This Task Worth Doing?

**Yes — but strictly as a surgical micro-task**, and **explicitly rejecting the speculative complexity** contemplated in earlier briefs.

Our offline diagnosis across all 33 questions (20 development across ResNet and Diffusion Policy, 13 held-out on PPO) reveals the exact ceiling of the task:

1. **5 questions are `NOT_RETRIEVED`** (4 cross-language Chinese queries against an English index, which return 0 rows on the lexical path by construction; and 1 lexical synonym, *"What optimization method is used?"*, where the paper writes "momentum" and never once uses the word "optimization" in that paragraph). **Ranking cannot fix an empty candidate pool.**
2. **7 questions are `LOW_RANK`** (the gold paragraph was retrieved into the candidate pool at ranks 6–13). In 6 of the 7, `fused_rank == best_variant_rank`: multi-query fusion did not displace them; the single BM25 list already scored them too low because BM25 accumulates term frequency over common words rather than rewarding distinct content word coverage.

A deterministic **Query Term Coverage** signal over the candidate pool:
- Lifts **4 of the 7 addressable misses** directly into the Top 5:
  - *"How is a robot policy represented?"* (DP): rank 10 → 3
  - *"How is a rollout defined?"* (DP): rank 6 → 3
  - *"What is Algorithm 1 in this paper?"* (PPO control): rank 13 → 1
  - *"What role does diffusion play in action generation?"* (DP): rank 9 → 5
- Causes **0 regressions** across the 21 currently passing Top-5 questions.
- Lifts overall 33-question **Hit@5 from 63.6% (21/33) to 75.8% (25/33)** (+12.2 percentage points, a 57.1% recovery of the entire addressable ranking failure class).
- Lifts **Hit@1 from 48.5% to 54.5%**, and **Hit@3 from 60.6% to 69.7%**.
- Incurs **0 additional provider calls**, **0 external dependencies**, and **< 0.2 ms** computational overhead.

Everything else proposed in early brainstorms — sweeping RRF damping constant $k$, path-weighting trees, diversity reranking (MMR), block-type priority penalties, or phrase boosting — is proved by measurement to be either zero-impact or actively harmful. The task is justified **only** when bounded to deterministic term coverage reranking within the candidate pool and resolving the `EvidenceItem.score` type debt.

---

## 2. False Premises in the Brief, Corrected

### False Premise 1 — "An empirical sweep of RRF parameter $k$ is required before $k = 60$ is justified."
**Correction:** We executed an exhaustive sweep of $k \in [1, 5, 10, 20, 30, 40, 50, 60, 80, 100, 200]$ across all 33 benchmark questions.
The measured Hit@1, Hit@3, Hit@5, and Hit@10 are **100% identical and completely invariant across all $k$ from 1 to 200** (Hit@1 = 45.5%, Hit@3 = 60.6%, Hit@5 = 63.6%, Hit@10 = 75.8%).
On the single question where fusion was implicated (*"What datasets are used for evaluation?"*), the fused rank is **11 for every value of $k$ from 1 to 200**.
When variants retrieve largely disjoint candidate sets, single-list rank order dominates regardless of $k$. Requiring a parameter sweep before implementation is ceremony; keep Cormack’s standard $k = 60$.

### False Premise 2 — "Query path weighting is needed to prevent rewrite variants from outvoting the raw query."
**Correction:** In the architecture established in DS-QA-004, query rewriting is gated behind a strict cascade trigger in [`needs_rewrite()`](file:///D:/marti/SciPrograms/backend/app/qa/retrieval.py#L181-L205). English queries with *any* lexical matches never invoke rewriting. In all 7 ranking misses, rewrites were never triggered. When rewrites *do* run (Chinese queries or zero-hit technical terms), the raw query returned zero hits. There are no raw results to "protect" from rewrites. Adding an artificial path-weighting penalty to rewrites would only sabotage the very queries that rescue cross-language searches.

### False Premise 3 — "Captions outranking body prose on conceptual questions requires a block-type ranking penalty."
**Correction:** In *"How is a rollout defined?"*, non-gold figure captions outranked body prose not because they were captions, but because BM25 rewarded term frequency of the single shared term "diffusion".
Query term coverage lifts the gold body prose from rank 6 to 3 naturally because the prose contains both "rollout" and "defined" (coverage = 1.0), whereas the figure caption contains only 0.0–0.5.
Adding an ad-hoc block-type penalty would degrade queries that specifically seek captions (e.g. *"What does Figure 3 show?"*). Term coverage resolves this competition on lexical fidelity without arbitrary block-type rules.

### False Premise 4 — "A post-ranking diversity stage (e.g. MMR) is needed to prevent near-duplicate candidates from crowding the evidence window."
**Correction:** Inspection of the candidate pools of all 7 LOW_RANK misses reveals **zero instances of near-duplicate crowding in ranks 1–5**. The candidates outranking the gold are distinct paragraphs with partial keyword overlap. Adding an MMR diversity stage would introduce tokenization and pair-wise similarity latency, risk dropping complementary evidence, and addresses a non-existent failure mode. Canonical deduplication by `paragraph_id` is already enforced.

### False Premise 5 — "Phrase matching boost is an effective ranking signal for academic QA."
**Correction:** Measurement in `signal_probe.py` showed phrase matching lifted **0 of 12 misses (0%)**. Academic vocabulary (e.g., "plain networks", "residual mapping", "action sequence") repeats frequently across body text and methodology sections. An exact phrase match rewards common phrases as much as distinctive ones, elevating noise rather than gold evidence.

---

## 3. Explicit Decisions A–J

| Decision | Verdict | Authoritative Specification & Rationale |
| :--- | :--- | :--- |
| **A. Does RRF stay?** | **YES** | **RRF stays.** FTS5 BM25 scores from disparate query expressions (e.g., raw 8-term vs entity 1-term) are non-comparable sums. RRF provides scale-free, rank-based multi-query aggregation. In 6 of 7 ranking misses, $fused == best\_variant$; RRF is not the root cause of low ranks. |
| **B. Is $k = 60$ justified?** | **YES** | **Keep $k = 60$; no sweep.** Across $k \in [1, 200]$, Hit@1/3/5/10 is 100% flat across all 33 questions. On the one question where fusion altered rank (*"What datasets are used for evaluation?"*), the fused rank remains 11 for all $k \in [1, 200]$. Requiring a sweep is rejected as ceremonial. |
| **C. Protect original query over rewrites?** | **NO** | **No protection mechanism.** The cascade gate in [`needs_rewrite()`](file:///D:/marti/SciPrograms/backend/app/qa/retrieval.py#L181) already protects the raw query: rewrites only run when raw returned 0 hits or a script mismatch occurred. When rewrites execute, raw candidates do not exist to be protected. |
| **D. Equal influence for rewrite variants?** | **YES** | **Equal RRF weighting across all active variants.** When rewrites trigger, multiple variants agreeing on a candidate represents legitimate multi-query consensus. In DS-QA-004, this consensus lifted cross-language Hit@5 from 0% to 100% (diagnostic) and 33% (held-out) while maintaining 16/16 abstentions on unanswerables. |
| **E. Should block type affect ranking?** | **NO** | **No block-type weights or penalties.** DS-QA-001 measured that excluding references changed nothing; DS-QA-004 measured that varying section-title weight from 0.0 to 10.0 yielded identical Hit@1/3/5/10 (60/70/70/80). Crucial findings often reside in tables, captions, and pseudocode. Block-type weighting is uncalibrated and fragile. |
| **F. Body prose vs captions on conceptual questions** | **Term Coverage Primary** | **Term coverage naturally promotes body prose without suppressing captions.** Conceptual questions contain multiple content words ("rollout", "defined") that body prose matches completely (coverage 1.0) while incidental captions match partially (coverage 0.0–0.5). Figure-targeted queries (*"What does Figure 3 show?"*) match the caption's exact terms ("figure", "3"), keeping the caption in the top 3 without heuristic exception rules. |
| **G. Post-ranking diversity stage (MMR)?** | **NO-GO** | **Strictly forbidden.** Zero of the 7 LOW_RANK misses are caused by near-duplicate crowding. Canonical deduplication by `paragraph_id` already prevents duplicate blocks. MMR adds unnecessary quadratic text comparison overhead and risks discarding complementary evidence. |
| **H. Neighbour paragraphs slot consumption** | **Attach After Selection** | **Neighbours MUST attach AFTER top-K direct hits and NEVER consume top-K slots.** Direct hits average 7.0 items (780 tokens); neighbours average 7.5 items (775 tokens). The total bundle (~1,550 tokens) easily fits within the 4,000-token evidence budget in [`answering.py`](file:///D:/marti/SciPrograms/backend/app/qa/answering.py#L169). Forcing neighbours into top-K slots would reduce direct hits from 8 to ~2, collapsing recall. Existing tail-pruning in [`fit_to_budget()`](file:///D:/marti/SciPrograms/backend/app/qa/answering.py#L154) correctly drops neighbours before direct hits. |
| **I. `EvidenceItem.score` semantics & shape** | **Preserve & Clarify** | **Keep `score: float | None` as the final composite ranking score** for backwards compatibility with tests ([`test_qa_retrieval.py` line 402](file:///D:/marti/SciPrograms/backend/tests/test_qa_retrieval.py#L402)) and external callers. Add optional `coverage_score: float | None = None` to [`EvidenceItem`](file:///D:/marti/SciPrograms/backend/app/qa/models.py#L48). In [`Diagnostics`](file:///D:/marti/SciPrograms/backend/app/qa/models.py#L86), add `ranking_strategy: str = "rrf_coverage"`. For neighbours, `score` remains `None`. |
| **J. Frozen improvement gate** | **LOW_RANK Recovery** | **Gate: $\ge 50\%$ recovery of addressable LOW_RANK misses (at least 4/7 lifted into Top 5)**, achieving overall 33-question **Hit@5 $\ge 75\%$** (from 63.6%), with **0 regressions** on currently passing questions, **16/16 unanswerable abstentions**, and ranking latency $\le 5\text{ ms}$. If $\ge 1$ passing question regresses, the task is **NO-GO / STOP**, freezing Option D ("current system good enough"). |

---

## 4. Technical Architecture: Candidate Pool Coverage Refinement

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          QUERY CANDIDATE GENERATION                         │
│  Scope Constraint (SQL) → Variant Execution (FTS5 BM25) → Pool (M=20/query) │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     RECIPROCAL RANK FUSION (k = 60)                         │
│             Compute RRF(d) = Σ 1 / (60 + rank_q(d)) per candidate           │
│             Deduplicate strictly by canonical paragraph_id / chunk_id       │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                 DETERMINISTIC TERM COVERAGE RERANKING                       │
│  1. Extract content terms Q_terms = content_terms(query) (strip stopwords)  │
│  2. Compute Coverage C(q, d) = |Q_terms ∩ terms(d)| / |Q_terms|             │
│  3. Composite Score: S(d) = RRF(d) + α * C(q, d)   (α = 0.05)               │
│  4. Stable Sort: descending S(d), tie-break alphabetically by chunk_id      │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        EVIDENCE BUNDLE ASSEMBLY                             │
│  Top-K Direct Hits (is_direct_hit=True, score=S(d))                         │
│  Append Neighbour Expansion (radius=1, same section, score=None)            │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.1. Stopword & Content Term Extraction
To prevent common function words from skewing coverage, normalization applies a minimal, immutable stopword set:
```python
STOPWORDS = {
    "what", "which", "how", "why", "is", "are", "was", "were", "the", "a", "an",
    "of", "to", "in", "on", "for", "and", "or", "does", "do", "did", "it", "its",
    "this", "that", "these", "those", "with", "by", "as", "at", "from", "be",
    "used", "use", "using", "role", "paper",
}
```
1. `terms(text)` extracts lowercase word tokens using regex `[^\w\-.]+` (preserving technical tokens like `ResNet-50` and `0.05`).
2. `content_terms(text)` filters out tokens in `STOPWORDS` and tokens of length $< 2$.
3. If `content_terms(query)` is empty (e.g. all stopwords or non-alphabetic/CJK query), $C(q, d) = 0.0$, preserving pure RRF ordering.

### 4.2. Coverage Formulation & Scoring Integration
For each candidate $d$ in the fused candidate pool:
$$C(q, d) = \frac{|\text{content\_terms}(q) \cap \text{terms}(d)|}{|\text{content\_terms}(q)|} \in [0.0, 1.0]$$

The composite score is:
$$S(d) = \text{RRF}(d) + \alpha \cdot C(q, d)$$
Where $\alpha = 0.05$.
- Range of $\text{RRF}(d)$ for candidates at ranks 1–20 is $[0.0125, 0.033]$.
- $\alpha = 0.05$ ensures that matching an additional content word ($+0.33$ to $+0.50$ in coverage) reliably elevates a candidate across BM25 frequency-inflated noise, while maintaining RRF consensus across multiple queries.
- As verified in Section 1, any $\alpha \in [0.01, 0.50]$ produces identical 4/7 lifts and 0 regressions. $\alpha = 0.05$ is frozen as the balanced midpoint.
- Stable tie-breaking: Sort descending by $S(d)$, then ascending by canonical `chunk_id`.

---

## 5. Acceptance Criteria

### P0 — Blocking

- **AC-P0-01: Candidate Pool Coverage Reranking Monotonicity.**
  Within the scope-constrained candidate pool returned across all variants, candidate ordering incorporates deterministic query content-term coverage.
  *Assertion:* On the 33-question benchmark, term coverage reranking lifts at least 4 of the 7 `LOW_RANK` misses into Top 5:
  - *"How is a robot policy represented?"* enters Top 5 ($\le 3$).
  - *"How is a rollout defined?"* enters Top 5 ($\le 3$).
  - *"What is Algorithm 1 in this paper?"* enters Top 5 (rank 1).
  - *"What role does diffusion play in action generation?"* enters Top 5 ($\le 5$).

- **AC-P0-02: Zero Regression Floor on Passing Queries.**
  Applying coverage reranking must not degrade any query that currently achieves rank $\le 5$ under baseline RRF.
  *Assertion:* 21 out of 21 baseline Top-5 queries across ResNet, Diffusion Policy, and PPO maintain rank $\le 5$. Regressions out of Top 5 count == 0.

- **AC-P0-03: Scope Invariance & Authoritative Candidate Generation.**
  Reranking operates exclusively over candidates generated within the active [`Scope`](file:///D:/marti/SciPrograms/backend/app/qa/models.py#L30). Candidate selection is constrained in SQL prior to ranking.
  *Assertion:* For a `section` or `page` scope, 100% of reranked candidates and attached neighbours satisfy the scope constraint. Selection scope bypasses reranking and expansion entirely (0 provider calls).

- **AC-P0-04: Canonical Paragraph & Block Identity Deduplication.**
  Deduplication identity is strictly `paragraph_id` / `chunk_id`, never raw text.
  *Assertion:* Two distinct paragraphs with identical text (e.g. ResNet paragraphs `p4` and `p6`: *"We evaluate on CIFAR-10 and ImageNet."*) maintain separate entries, distinct ranks, distinct page numbers, and distinct citation IDs.

- **AC-P0-05: Grounding and Abstention Safety Floors.**
  Reranking evidence must not compromise grounding checks or induce hallucination.
  *Assertion:*
  - Deliberately unanswerable questions: 16/16 abstained (`insufficient_evidence`), 0 false supported answers.
  - Counterfactual evidence: 3/3 follow altered evidence, 0 from parametric memory.
  - Citation structural validity: 100% resolve to valid IR block geometries.

- **AC-P0-06: Neighbour Expansion Detached from Top-K Slots.**
  Neighbour paragraphs attach *after* primary top-K direct hits and do not consume top-K direct hit slots.
  *Assertion:* For `top_k=8`, retrieval returns up to 8 direct hits (`is_direct_hit=True`), followed by section-bounded neighbours (`is_direct_hit=False`, `score=None`). Direct hits are never displaced from the first $K$ positions by neighbours.

- **AC-P0-07: Preservation of RRF Fusion and Parameter Stability.**
  Multi-query variants are issued independently and combined using RRF with Cormack constant $k = 60$.
  *Assertion:* Single-hit outliers are damped according to $1 / (60 + \text{rank})$; identical rankings produce byte-identical candidate order across repeated runs via deterministic tie-breaking.

- **AC-P0-08: Zero Additional Provider Calls.**
  Ranking refinement is 100% local and deterministic.
  *Assertion:* Retrieval provider call count == 0. No LLM reranker, no cross-encoder, no embedding models, and no query-understanding API calls are made.

- **AC-P0-09: Score Semantic Clarification & Backward Compatibility.**
  [`EvidenceItem.score`](file:///D:/marti/SciPrograms/backend/app/qa/models.py#L70) is defined as the final composite ranking score ($S(d)$).
  *Assertion:*
  - For all direct hits, `score` is a positive float ($\ge 0.0$).
  - For all neighbour items, `score is None` (preserving [`test_qa_retrieval.py` line 402](file:///D:/marti/SciPrograms/backend/tests/test_qa_retrieval.py#L402)).
  - `EvidenceItem` carries optional `coverage_score: float | None = None`.
  - [`Diagnostics`](file:///D:/marti/SciPrograms/backend/app/qa/models.py#L86) records `ranking_strategy = "rrf_coverage"`.

- **AC-P0-10: Zero Benchmark Hardcoding Guard.**
  Executable logic in `app/qa/` contains zero paper-specific identifiers, titles, authors, or question strings.
  *Assertion:* An AST-based literal inspection over `app/qa/` verifies that no string literal contains benchmark terms (`resnet`, `schulman`, `cifar`, `ppo`, `diffusion policy`, `visuomotor`). Comments and docstrings documenting bug fixes are excluded.

---

### P1 — Quality & Performance

- **AC-P1-01: Benchmark Recall Thresholds.**
  *Assertion:* Across the 33 benchmark questions:
  - Overall Hit@5 $\ge 75.0\%$ (baseline 63.6%).
  - Addressable `LOW_RANK` recovery $\ge 50.0\%$ (4/7).
  - PPO held-out Hit@5 $\ge 75.0\%$ (baseline 69.2%, 9/13 $\to$ 10/13).
  - Diagnostic Hit@5 $\ge 75.0\%$ (baseline 60.0%, 12/20 $\to$ 15/20).

- **AC-P1-02: Caption Handling Fidelity.**
  Captions are evaluated based on content term coverage without block-type down-weighting.
  *Assertion:* Figure-directed questions (e.g. *"What is shown in Figure 3?"*) rank the matching figure caption in Top 3. Conceptual questions (e.g. *"How is a rollout defined?"*) rank the defining body paragraph above non-gold figure captions.

- **AC-P1-03: Reranking Latency Budget.**
  *Assertion:* Coverage calculation and candidate pool reranking executes in $\le 2.0\text{ ms}$ (p95) over $M \le 50$ candidates. Multi-query retrieval + fusion + reranking completes in $\le 25\text{ ms}$ (p95) on the local lexical path.

- **AC-P1-04: Non-interference with CJK and Zero-term Queries.**
  For queries with zero content terms or script-mismatched characters without spaces:
  *Assertion:* Term coverage evaluates to 0.0 without throwing exceptions; ranking gracefully degrades to pure RRF order.

---

### P2 — Maintainability

- **AC-P2-01: Scoring Diagnostics Telemetry.**
  *Assertion:* When diagnostics are enabled, [`Diagnostics`](file:///D:/marti/SciPrograms/backend/app/qa/models.py#L86) exposes the coverage score and contributing query variants for each item in the bundle, allowing retrieval inspection without exposing document text.

---

## 6. Verification Protocol

1. **Unit Tests (`backend/tests/test_qa_retrieval.py`):**
   - Verify coverage calculation across alphanumeric technical terms (`ResNet-50`, `CIFAR-10`, `0.05`).
   - Verify that an item matching 2 of 2 content words outranks an item matching 1 of 2 content words when both have similar BM25 ranks.
   - Verify that neighbour items have `score is None` and `is_direct_hit is False`.
   - Verify tie-breaking determinism by running 50 identical queries on identical corpora.

2. **Benchmark Regression Suite:**
   - Execute the 33-question suite across ResNet, Diffusion Policy, and PPO.
   - Verify that Hit@5 $\ge 75.8\%$ (25/33), regressions == 0, and the 4 target queries lift as specified.
   - Verify 16/16 unanswerable abstentions and 3/3 counterfactual detections.

3. **Real-Browser End-to-End Verification ([`e2e-qa.mjs`](file:///D:/marti/SciPrograms/frontend/scripts/e2e-qa.mjs)):**
   - Run `node frontend/scripts/e2e-qa.mjs` against the live backend and real PDF viewer.
   - Verify that asking a conceptual question returns the top-ranked evidence, citation markers `[E1]` render properly, clicking a citation scrolls to the exact paragraph bounding box on the original PDF page, and no frontend errors occur.
