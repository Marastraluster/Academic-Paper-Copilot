# Acceptance Criteria: DS-QA-004 — Retrieval Recall Improvement

**Role:** Gemini (Independent Acceptance Criteria Author)  
**Implementer:** DeepSeek (Lead Engineer)  
**Target Codebase:** [`app/qa/`](file:///app/qa) (`query.py`, `retrieval.py`, `index.py`, `models.py`)  
**Specification Artifact:** [DS-QA-004-Acceptance-Criteria.md](file:///C:/Users/marti/.gemini/antigravity-cli/brain/a02942dc-33d4-45d2-b1bc-f28a957cce99/DS-QA-004-Acceptance-Criteria.md)

---

## 1. False Premise & Corrections to the Brief

Before specifying the criteria, we must correct three structural flaws in the brief’s framing:

### False Premise 1: "Entity-type expansion is the most important deterministic experiment."
* **The Reality:** In our measured failure taxonomy across 33 questions (13 misses at Hit@5), `ENTITY_TYPE` accounts for exactly **1 miss in 13 (7.7%)**. 
* **The Structural Flaw:** `CROSS_LANGUAGE` (5 misses) and `PARAPHRASE` (5 misses) account for **76.9% (10 of 13)** of all misses. Furthermore, entity-type expansion relies entirely on `DocumentAnalysis` (`app/context/models.py`), which takes hundreds of seconds to generate. On a freshly uploaded paper with no pre-analysis, entity-type expansion addresses **0% of misses**. Framing it as the primary experiment was an error.

### False Premise 2: "Stage B (LLM Rewriting) must wait for Stage A measurement."
* **The Reality:** In SQLite FTS5 with `unicode61`, Chinese characters ("这个方法如何限制策略更新幅度？") produce zero token matches against English text ("constraint on the size of the policy update"). Deterministic string matching cannot map unshared vocabularies without an existing glossary entry (which is absent on cold papers).
* **The Verdict:** **The evidence required to justify Stage B is already in hand.** Making Stage A an empirical blocker for Stage B is an artificial delay. Stage B must be authorized immediately. Stage A is retained as an ultra-fast, zero-provider fallback and deterministic supplement.

### False Premise 3: "Monolithic OR-expansion preserves BM25 ranking fidelity."
* **The Reality:** In SQLite FTS5, concatenating queries as `(base) OR (exp1) OR (exp2)` lets high-frequency expanded tokens dilute the query's IDF and outvote the gold paragraph (as observed in PPO: *"What is Algorithm 1 in this paper?"* where gold paragraph "Algorithm 1 PPO" was outvoted by four common words).
* **The Verdict:** Query variants must be issued as **independent FTS5 queries** and fused using **Reciprocal Rank Fusion (RRF)**.

---

## 2. Explicit Answers to Architectural Decisions (A through F)

### A. Evidence for LLM Query Rewriting
* **Is evidence in hand?** **Yes.** 77% of measured misses (10/13) are cross-language and paraphrase. Lexical FTS5 cannot bridge non-overlapping vocabularies. DeepSeek does not need to pause after Stage A; Stage B is approved for immediate implementation.

### B. Evidence for Embeddings (Stage C) & Product Cost
* **Verdict:** **Stage C is a strict NO-GO.**
* **Product Costs in a Local-First Desktop App:**
  1. *Binary & Model Bloat:* 100MB–500MB download and memory overhead for ONNX/PyTorch embedding weights.
  2. *Cold-Start Latency:* Embedding 50–100 paragraphs on CPU takes 1–5 seconds per PDF on upload.
  3. *Cross-Platform Native Dependencies:* Compiling SQLite vector extensions (`sqlite-vec`, `sqlite-vss`) across Windows, macOS, and Linux creates packaging and stability liabilities.
  4. *Alphanumeric Failure Mode:* Dense embeddings suffer from hubness and routinely fail on exact variable names, formulas, and hyperparameter tables where BM25 excels.
* **Gate to reopen Stage C:** Residual Hit@5 on a fresh held-out set remains $< 80\%$ after Stage B, and an offline POC demonstrates dense retrieval recovers $\ge 60\%$ of residual failures without regressing exact alphanumeric lookups, within an indexing budget $\le 2.0\text{s}$ on an 8-core CPU.

### C. Multi-Query Fusion & Deduplication Identity
* **Algorithm:** **Reciprocal Rank Fusion (RRF)**:
  $$RRF(d) = \sum_{q \in Q} \frac{1}{k_{RRF} + r_q(d)}$$
* **Constant:** $k_{RRF} = 60$ (Cormack et al. 2009 standard). A smaller $k$ (e.g. 10) over-biases towards noisy top-1 outliers; $k=60$ smoothly rewards items appearing across multiple query variants.
* **Candidate Pool:** Top $M = 20$ candidates retrieved per query variant before fusion.
* **Deduplication Identity:** **Must be `paragraph_id`** (or `chunk_id` for captions/non-paragraphs), **never raw text**. Academic papers frequently repeat identical sentences (*"See Table 1 for details"*, *"We evaluate on ImageNet"*). Deduplicating by text corrupts section/page provenance, citation mapping, and neighbor expansion.

### D. Entity-Type Expansion Without `DocumentAnalysis`
* **Verdict:** **It MUST NOT run when `DocumentAnalysis` is absent.**
* **Rationale:** Extracting entities on-the-fly at query time introduces latency and hallucination risks. On cold papers, Stage B query rewriting naturally handles entity types (e.g., rewriting *"What datasets are used?"* into `"dataset" OR "benchmark" OR "experiments"`).

### E. Entity-Type Expansion Bounds & Saliency
* **Trigger:** Query contains an entity-type indicator matching an entity `kind` in `analysis.entities` (`dataset`, `model`, `benchmark`, `metric`).
* **Saliency Metric:** `len(entity.paragraph_ids)` (occurrence count across paragraphs).
* **Selection Rule:**
  1. Filter: `entity.kind == target_kind` AND `len(entity.paragraph_ids) >= 2` (drops single-mention noise/citations).
  2. Sort: Descending by `len(entity.paragraph_ids)`, tie-broken alphabetically.
  3. Hard Bound: **Top-3 entities maximum**.
* **Failure Modes:**
  * *Under-expansion:* Misses a dataset mentioned only once in a footnote. (Acceptable).
  * *Over-expansion:* Prevented by the hard cap of 3, protecting FTS5 from IDF dilution.

### F. Preventing Benchmark Tuning
* **Rule 1 (Zero Corpus Pollution):** No paper-specific terms (`"ResNet"`, `"PPO"`, `"TRPO"`, `"Diffusion Policy"`, author names, or benchmark question strings) may appear anywhere in `app/qa/` or prompts. They are only permitted in `tests/qa/`.
* **Rule 2 (Split Governance):** ResNet and Diffusion Policy are *diagnostic*. PPO is *held-out*. Acceptance requires verification on a **third unread held-out paper** (e.g., LoRA or FlashAttention, 10 pre-authored questions with gold spans).
* **Rule 3 (Pareto Non-Regression):** Any change that improves ResNet while degrading PPO by $\ge 5\%$ is **REJECTED**.
* **Rule 4 (DS-QA-002 Invariance):** 16/16 abstentions on unanswerable questions and 3/3 counterfactual grounding checks must remain 100% intact.

---

## 3. Go/No-Go Stage Gates

```
STAGE A: Deterministic Expansion & Multi-Query Infrastructure
├── Bidirectional acronym & glossary matching
├── Bounded entity expansion (cap=3, min_freq=2, analysis-present only)
└── Zero-provider fallback (< 15ms execution)
    └──> GATE A: Diagnostic Hit@5 >= 65%, Zero cold-paper regressions -> [GO]

STAGE B: Bounded LLM Query Rewriting & RRF Fusion
├── 2 to 4 lexical variants (cross-language English translation + paraphrasing)
├── Independent FTS5 queries + RRF (k=60, dedup by paragraph_id)
├── Graceful degradation to Stage A on timeout (> 2.0s) or error
└── Scope enforced in SQL candidate generation for ALL queries
    └──> GATE B: Held-Out PPO Hit@5 >= 80%, Cross-Lang Hit@5 >= 80%, 
                 Abstention 16/16 intact, Latency <= 1500ms -> [GO]

STAGE C: Hybrid Dense Retrieval (Embeddings / Vector DB)
└──> GATE C: [FROZEN / NO-GO]. Re-evaluation barred unless Stage B 
             fails the 80% Hit@5 threshold on unseen papers.
```

---

## 4. Verifiable Acceptance Criteria

### P0 (Blocking for Release)

* **AC-01: Cold Paper & Zero-Provider Fallback (Baseline Invariance)**
  * When `analysis is None` and the LLM provider is disabled, offline, or times out, retrieval MUST operate purely deterministically using SQLite FTS5 BM25.
  * *Assertion:* Under zero-provider conditions, Hit@5 on cold ResNet, DiffPolicy, and PPO must match or exceed the raw baseline (ResNet $\ge 50\%$, DiffPolicy $\ge 50\%$, PPO $\ge 38\%$) with 0 unhandled exceptions.

* **AC-02: Bidirectional Acronym & Glossary Expansion (Stage A)**
  * `app/qa/query.py` must support case-insensitive, bidirectional expansion:
    1. Acronym $\leftrightarrow$ Full Expansion (e.g., `"PPO"` $\rightarrow$ `"Proximal Policy Optimization"` AND `"Proximal Policy Optimization"` $\rightarrow$ `"PPO"`).
    2. Glossary Term $\leftrightarrow$ Suggested Translation.
  * *Assertion:* Querying `"Proximal Policy Optimization"` against an analysis containing acronym `"PPO"` produces an alternative search term `"PPO"`. Acronyms where `expansion is None` are skipped without error.

* **AC-03: Bounded Entity Expansion (Stage A)**
  * When `analysis` is present, entity expansion triggers only if the query explicitly matches an entity category (`dataset`, `model`, `benchmark`, `metric`). Only entities with $\ge 2$ occurrences (`len(paragraph_ids) >= 2`) are eligible, capped strictly at the top 3 by frequency.
  * *Assertion:* On ResNet (34 model entities), querying *"What models are evaluated?"* injects at most 3 models. If `analysis is None`, 0 entity expansions are generated.

* **AC-04: Bounded LLM Query Rewriting (Stage B)**
  * `app/qa/rewrite.py` must use the existing provider to generate 2 to 4 distinct lexical query variants in English (JSON output `{"queries": [...]}`).
  * For non-ASCII / CJK queries, at least 2 variants must be fluent English technical translations.
  * Provider call parameters: `temperature=0.0`, `max_tokens=150`, `timeout=2.0s`.
  * *Assertion:* On Chinese query *"这个方法如何限制策略更新？"*, the rewriter generates English queries containing terms like `"limit"`, `"policy update"`, `"clip"`, or `"constraint"`.

* **AC-05: Strict Scope Enforcement at Candidate Generation**
  * Every query variant issued by the retrieval engine MUST execute with the active `Scope` (`whole_paper`, `section`, `page`, `selection`) enforced directly in SQLite's `WHERE` clause.
  * *Assertion:* For `scope=Scope.SECTION("sec_intro")`, every candidate row across all rewritten queries has `section_id == "sec_intro"`. No global searching with post-filtering.

* **AC-06: Selection Scope Fast Path**
  * When `scope == Scope.SELECTION`, LLM rewriting, entity expansion, and neighbor expansion MUST be bypassed entirely.
  * *Assertion:* `retrieve(..., scope=Scope.SELECTION(...))` completes in $< 30\text{ms}$ with 0 provider calls.

* **AC-07: Reciprocal Rank Fusion & Paragraph Identity Deduplication**
  * Multiple query candidate lists (up to 20 candidates per query) must be fused via RRF ($k=60$). Deduplication MUST be keyed by `paragraph_id` (or `chunk_id`), preserving exact chunk provenance.
  * *Assertion:* If two distinct paragraphs contain the identical text *"We train using Adam."*, both paragraphs retain distinct `EvidenceItem` entries with their respective `page_number` and `paragraph_id`.

* **AC-08: Grounding & Abstention Non-Regression (DS-QA-002 Invariance)**
  * Retrieval recall expansion must not dilute the top-8 evidence bundle with distractor noise that triggers generator hallucinations.
  * *Assertion:* Running the DS-QA-002 regression suite yields:
    * 16/16 abstentions (`INSUFFICIENT_EVIDENCE`) on unanswerable questions.
    * 3/3 swapped counterfactual evidence detections.
    * 0 answers drawn from model parametric memory.

* **AC-09: Benchmark Recall Thresholds**
  * Running `tests/qa/benchmark_retrieval.py` with Stage A + Stage B must meet:
    * **PPO Held-Out (Overall):** Hit@5 $\ge 80\%$ (baseline: 62%). Hit@10 $\ge 85\%$.
    * **Cross-Language Subset:** Hit@5 $\ge 80\%$ (baseline: 0%).
    * **Paraphrase Subset:** Hit@5 $\ge 80\%$ (baseline: 67%).
    * **Diagnostic Sets (ResNet + DiffPolicy):** Hit@5 $\ge 75\%$.

* **AC-10: Zero Benchmark Hardcoding**
  * *Assertion:* `git grep -iE 'resnet|schulman|cifar|imagenet|ppo|trpo|diffusion policy' app/qa/` returns zero matches.

---

### P1 (High Priority / Product Quality)

* **AC-11: Latency Budgets & SLA**
  * *Cold / Fallback (Stage A):* $\le 20\text{ms}$.
  * *Rewritten (Stage B):* LLM rewrite $\le 1200\text{ms}$, multi-query FTS5 + RRF $\le 50\text{ms}$. Total end-to-end retrieval $\le 1500\text{ms}$ (p95).
  * *Hard Timeout:* If rewriting exceeds $2000\text{ms}$, abort rewrite and immediately fall back to Stage A.

* **AC-12: Captions, Tables & Index Weight Preservation**
  * FTS5 index weights (`section_title: 5.0`, `text: 1.0`) and caption chunking (`is_caption=True`) must be preserved across multi-query retrieval.
  * *Assertion:* For query *"What is shown in Figure 3?"*, the caption chunk for Figure 3 ranks in the top-3 with `is_caption=True`.

* **AC-13: Neighbor Expansion Continuity Post-RRF**
  * Neighbour expansion (`radius = 1`) within the same section runs on the final top-k fused results.
  * *Assertion:* Neighbor chunks receive `is_direct_hit=False`, correct `paragraph_id`, and are not duplicated if already present in direct hits.

* **AC-14: Generalization Verification on 3rd Held-Out Paper**
  * To guarantee zero overfitting to PPO phrasing, retrieval must be evaluated against a 3rd academic paper (e.g., LoRA or FlashAttention, 10 pre-authored questions with gold spans).
  * *Assertion:* Hit@5 on the 3rd paper achieves $\ge 75\%$.

---

### P2 (Nice-to-Have / Polish)

* **AC-15: Query Rewriter Caching & Token Telemetry**
  * Cache query rewrites by `(document_id, user_query)`. Caching yields $< 1\text{ms}$ response on repeat queries. Average prompt token consumption $\le 300$, completion $\le 150$ tokens.

* **AC-16: Stage C Formal Evaluation Report**
  * Document residual misses post-Stage B. If Hit@5 across all benchmarks $\ge 85\%$, Stage C is formally archived as unnecessary.

---

## 5. End-to-End Verification Protocol

DeepSeek must verify this implementation against four test suites before submitting:

1. **Unit Tests (`tests/qa/test_query_fusion.py`):**
   - Test bidirectional acronym mapping, entity frequency cutoffs (cap=3), and RRF score monotonicity.
   - Verify that synthetic duplicate paragraphs with distinct `paragraph_id` retain separate ranks.
2. **Provider & Fallback Tests (`tests/qa/test_rewrite.py`):**
   - Simulate a 3.0s provider timeout $\rightarrow$ verify graceful fallback to Stage A within 2.1s without throwing.
   - Simulate malformed JSON $\rightarrow$ verify graceful fallback to Stage A.
   - Test Chinese query input $\rightarrow$ verify English query variants generated.
3. **Automated Benchmark Runner (`tests/qa/test_benchmark_recall.py`):**
   - Run diagnostic (ResNet, DiffPolicy) and held-out (PPO) sets.
   - Run DS-QA-002 counterfactual regression test (3/3 swapped evidence caught, 16/16 abstentions intact).
4. **Real Sidebar UI Verification:**
   - Open a freshly uploaded, unanalyzed paper in the desktop viewer.
   - Enter Chinese question: *"PPO与TRPO的主要区别是什么？"*
   - Verify:
     - Sidebar transitions smoothly without UI hang.
     - Evidence cards show relevant English paragraphs comparing PPO and TRPO.
     - Citations resolve to the correct PDF bounding box on the page.
     - Abstention correctly triggers when asking an intentionally absent question (e.g., *"What learning rate was used on ImageNet?"* on the PPO paper).
