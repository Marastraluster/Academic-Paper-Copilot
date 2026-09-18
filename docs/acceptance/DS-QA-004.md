# Acceptance Criteria — DS-QA-004: Retrieval Recall Improvement

- **Author:** Gemini (`gemini-3.8-flash-high`), via the standing two-agent workflow.
  Gemini returned its criteria in the session rather than writing this file; they are
  transcribed here verbatim in §2–§5, with nothing added or removed.
- **Reviewed and frozen by:** DeepSeek, before implementation
- **Date:** 2026-09-18
- **Baseline:** `6198bad` (DS-QA-003)
- **Status:** **FROZEN**, with **6 `AC_CHANGE_REQUEST`s** — five raised in review before
  implementation, one after the measured run. **10 P0 · 4 P1 · 2 P2.**
  **DS-QA-004 is PARTIAL, NOT DONE.** P0 is 9 of 10 as written: AC-09's thresholds were
  falsified by measurement and redefined as a disposition requirement
  (AC_CHANGE_REQUEST 6), and the falsifying numbers stand in the evidence unchanged.

---

## 1. DeepSeek review

Gemini **accepted the measurement in our brief and corrected the brief's own framing**, which is
the second time it has done that and the more useful half of its job. Three of its calls are
worth recording before the change requests.

**It refused to make Stage A an empirical blocker for Stage B.** Our brief asked what evidence
would be required before adding LLM query rewriting; Gemini's answer is that the evidence is
already in hand — a Chinese query shares no token with an English index, so no amount of
deterministic metadata appending can reach it, and 5 of the 13 measured misses are exactly that.
It is right, and holding Stage B behind a Stage A measurement we can already predict would be
ceremony.

**It found a flaw in the current design that the brief had not noticed.** Today expansion is one
big `(base) OR (exp1) OR (exp2)` expression. Gemini's point: concatenating alternatives into one
FTS5 query lets common expanded tokens dilute the query's IDF and outvote the paragraph that
actually answers it — which is precisely the PPO miss where the paragraph titled "Algorithm 1
PPO" was outvoted by four ordinary words. Query variants must be **independent queries, fused
afterwards**. That is a better design than ours and it is adopted.

**It set Stage C to NO-GO** with a specific, falsifiable reopen gate rather than a vague "later".

### AC_CHANGE_REQUEST 1 — AC-10 would delete the documentation it should protect

| | |
|---|---|
| **As written** | `git grep -iE 'resnet\|schulman\|cifar\|imagenet\|ppo\|trpo\|diffusion policy' app/qa/` must return **zero** matches. |
| **Measured** | It returns matches in **5 files** — `query.py` (the docstring that records `MATCH 'ResNet-50' -> OperationalError: no such column: 50`, which is the entire justification for sanitisation), `citations.py` (a comment listing identifier shapes), `index.py` (a comment recording the measured weight sweep), `answering.py` (a comment recording the section-title finding from the DS-QA-002 benchmark), and `prompts.py` (a substring false positive — `support` contains `ppo`). **None is executable logic.** |
| **Problem** | As written the criterion is satisfied only by deleting the record of *why* the code is shaped the way it is, and this repository has already ruled on that: `tests/test_isolation.py::_code_string_literals` excludes docstrings from its guard with the reasoning *"a guard that fires on documentation teaches people to delete the documentation."* A benchmark question string in a comment is not hardcoding; a paper name in a lookup table would be. |
| **Resolution** | The assertion targets **executable string literals and identifiers**, using the repository's own AST approach for the prose/code split, and adds the question strings from both benchmark sets as literal patterns. The comment in `index.py` that records a measurement is exactly the kind of thing a hardcoding guard must not delete. |
| **Not accepted** | Satisfying the grep by rewriting the docstrings to avoid naming the strings they are about. A docstring that cannot say which token broke the parser is not documentation. |

### AC_CHANGE_REQUEST 2 — the rewrite budget and timeout cannot be met by this provider as specified

| | |
|---|---|
| **As written** | AC-04: `temperature=0.0`, `max_tokens=150`, `timeout=2.0s`. AC-11: rewrite ≤ 1200 ms, hard abort at 2000 ms. |
| **Problem** | The configured provider is `deepseek-flash`, a **reasoning model** whose thinking is billed against the output budget. This repository measured that: DS-QA-002's `DEFAULT_OUTPUT_ALLOWANCE = 4000` exists because *"at the original 1200 it returned nothing at all — the whole budget went on reasoning and `content` came back empty"*, and the translation kernel hit the same thing repeatedly as `LLMOutputTruncatedError` with `PROBE_MAX_TOKENS = 1`. A 150-token budget will be consumed by reasoning before any JSON is written, and a 2.0-second abort will fire before a reasoning model finishes thinking. Both numbers are guesses about a model this project has already measured, and they would produce a rewriter that never once succeeds — which is indistinguishable, in the results, from a rewriter that is not needed. |
| **Resolution** | The output budget and the abort threshold are **measured against the configured provider** and recorded, rather than fixed in advance. The design keeps what the numbers were for: the rewrite is **only reached when the fast path has already failed** (see AC_CHANGE_REQUEST 3), so its latency is paid by a minority of questions rather than by all of them, and the fallback to Stage A on timeout or error is unchanged and remains P0. |
| **Not accepted** | Discovering the real numbers after the fact and reporting a product decision built on a rewriter that silently timed out. |
| **Measured afterwards, and it partly vindicates the criterion** | The rewrite came in at **656–1291 ms** on eleven real calls, so AC-11's 1200 ms budget is met by most of them and missed by one. Sizing the budget from measurement rather than from a guess still stands as the reason this change request was raised — the 150-token output budget would have returned nothing, which cannot be seen from a timing number. |

### AC_CHANGE_REQUEST 3 — the rewrite must be reached on a diagnosis, not on every question

| | |
|---|---|
| **As written** | AC-04 describes the rewriter as part of the retrieval path; AC-11 budgets its latency as an end-to-end cost. Nothing says when it runs. |
| **Problem** | Our brief's §37 asks for a cascade and §38 for a diagnostic trigger, and neither is in the criteria. Unconditional rewriting would make every question pay a provider round trip — including an exact model-name lookup that lexical retrieval answers at rank 1 in about a millisecond, which is the path the whole design protects. |
| **Resolution** | The trigger is **deterministic and observable**, taken from `Diagnostics`: no match at all (`NO_MATCH_TOKEN`), or no usable lexical overlap with the corpus, or a query whose script differs from the indexed text's. Those are the measured conditions under which the fast path cannot possibly succeed — a Chinese query against an English index retrieves *zero* rows, which is knowable without asking a model anything. Everything else stays on the lexical path. The trigger is recorded in diagnostics so the evidence shows which questions paid. |
| **Not accepted** | A BM25-score threshold as the trigger: the scores are uncalibrated, which is why DS-QA-001 forbade them as a sufficiency signal and DS-QA-002 forbade them as a truth oracle. |

### AC_CHANGE_REQUEST 4 — AC-14 requires a third held-out paper that does not exist here

| | |
|---|---|
| **As written** | AC-14 (P1): evaluate on a third academic paper — *"e.g. LoRA or FlashAttention, 10 pre-authored questions with gold spans"* — and reach Hit@5 ≥ 75%. |
| **Measured** | The project contains **two** real papers: ResNet (`gate0/resnet.pdf`, the validated baseline) and the two in `.agent/results/papers/` (Diffusion Policy, PPO). Everything else is either a synthetic fixture (`doc001-probe/two-col.pdf`, the E2E-generated `paper.pdf`) or a 3-page toy from the upstream repository's test directory. Obtaining another academic PDF means downloading one, which this project has not done and should not start doing as a side effect of a retrieval task. |
| **Problem** | The criterion's *intent* is the important part — do not overfit to PPO — and it is satisfiable without a third paper. The property that matters is that the held-out numbers are **published before any tuning is done against them**, so that a change which helps PPO can be told apart from a change that was chosen because it helps PPO. |
| **Resolution** | PPO stays the held-out set, and the discipline is made explicit and checkable: every configuration's held-out numbers are recorded on its **first** run, no configuration is revised after seeing them, and failures are reported with the same prominence as successes. If a future task wants to verify generalization a third time, that belongs with obtaining a third paper, as its own step. |
| **Not accepted** | Calling the ResNet and Diffusion Policy sets held-out when both have been read repeatedly during development; they are diagnostic sets, and the criteria already say so. |

### AC_CHANGE_REQUEST 5 — DS-QA-002's "zero provider calls" rule has to narrow, or this task cannot work

| | |
|---|---|
| **As written** | DS-QA-002 AC-P0-01: *"If `evidence_bundle.items` is empty … the pipeline returns `insufficient_evidence` immediately **without calling any LLM provider**"*, verified as *"Provider `generate()` call count == 0"*. |
| **Problem** | An empty result is the **exact** condition under which a rewrite is worth attempting, and the measured dominant failure class produces exactly that: a Chinese question against an English paper retrieves **zero rows**, every time, by construction — the characters cannot match the index. Under DS-QA-002's rule as written, the rewrite could never fire on the case it exists for, and Stage B — which Gemini itself authorised — would be dead code. |
| **What the DS-QA-002 rule was protecting** | Two things, and neither is at risk. It prevented *"asking a model to look at nothing and report back"* — buying an answer from memory with an empty prompt. The rewrite does not answer: it is asked for search phrases, its output goes through FTS5, and a phrase that matches nothing retrieves nothing. And it protected the deterministic fast path's cost; that is preserved by the cascade, since the rewrite is reached only after the local paths have already failed. |
| **Resolution** | The rule narrows to what it was defending: **the answer model is never called on empty evidence.** The rewrite may be, because it is a different call with a different contract — it produces queries, not claims, and every hit it leads to still comes from the index. The four DS-QA-002 tests that assert "zero provider calls" are updated to assert "zero **answer** calls", which is the property that matters and is still checkable. |
| **Measured cost of the narrowing** | On the held-out set, 3 of 13 questions reached the rewrite and none failed; each paid 884–1291 ms. On the diagnostic set, 3 of 10. Every other question — including every exact-term lookup — stayed on the lexical path at a median of ~5 ms. A genuinely off-topic question now pays one bounded call before abstaining, which is the price of being able to answer a cross-language one at all. |
| **Not accepted** | Leaving the rule as written and shipping a Stage B that silently never runs; or firing the rewrite unconditionally, which would make every question pay a provider round trip to help a tenth of them. |

### AC_CHANGE_REQUEST 6 — AC-09's thresholds were a hypothesis, and they were falsified

*Raised after the measured run. The other five were raised before implementation; this one can
only be raised afterwards, because it is about whether a prediction survived contact with the
benchmarks — the same situation as DS-QA-001's P0-9.*

| | |
|---|---|
| **As written** | AC-09 (P0): held-out PPO Hit@5 ≥ 80% (baseline 62%), Hit@10 ≥ 85%; cross-language Hit@5 ≥ 80% (baseline 0%); paraphrase Hit@5 ≥ 80% (baseline 67%); diagnostic sets Hit@5 ≥ 75%. |
| **Measured** | Held-out PPO **69% Hit@5** and **85% Hit@10** (62% → 85% is a 23-point gain). Cross-language **33% held-out / 100% diagnostic**, from a baseline of **0%** — a class that previously retrieved *nothing at all*. Paraphrase unchanged at 67%. Diagnostic ResNet assisted 70% Hit@5, Hit@10 80% → 90%. |
| **Problem** | Like DS-QA-001's P0-9, the numbers are a **prediction about a mechanism that did not exist when they were written**. They were falsified. The mechanism is not failing: scope is enforced for every variant, citations remain source-resolved, the unanswerable floor held at 16/16 with zero false answers, every class untouched by the change is byte-identical to its baseline, and 5 of 6 avoidably-abstained product questions now answer. What the criterion actually encodes is the *stage gate*, and that gate is what the project should keep. |
| **Resolution** | AC-09 becomes a **disposition requirement**, not a threshold: the stage's measured result must be recorded, the gate evaluated against its frozen numbers, and escalation to Stage C permitted only by Stage C's own frozen gate — which is not satisfied, so Stage C stays closed. The measured numbers stand in the evidence unchanged, including the ones that miss. |
| **Not accepted** | Lowering the bar to 69% and calling it met, or reporting the Hit@10 gain as if it satisfied a Hit@5 criterion. |
| **Consequence for DS-QA-004's own tally** | P0 is **9 of 10 as written** and the task is **PARTIAL, not DONE**: the product bar AC-09 encoded was not reached. Recorded here rather than softened, and the same way DS-QA-001's P0-9 was: the failure is in the record, the redefinition is in the record, and the difference between them is visible. |

### A second P0 that this disposition found

Reviewing AC-09 surfaced **AC-06, which was also failing**: a selection scope reached
`needs_rewrite` like any other, so a selection naming a paragraph id the document does not have
cost a provider call searching for something the scope forbids finding. It passed by accident in
the common case — the selection branch happens to fill `items` with the selected paragraphs —
and stopped passing the moment the ids did not resolve. Fixed, with two tests, before this
disposition was written. It matters most to DS-QA-005, which is the task that will send
browser-derived paragraph ids.

### Confirmations

* **AC-01's floors are Hit@1 numbers used as Hit@5 bounds.** Implemented as a **no-regression**
  check against the measured raw Hit@5 for each set — 60% ResNet, 60% Diffusion Policy, 62% PPO —
  which is stricter than the written floors and is what "match or exceed the raw baseline" means.
* **Stage C is NO-GO.** No embeddings, no vector store, no new dependency.

---

## 2. False premises Gemini corrected

**False Premise 1 — "Entity-type expansion is the most important deterministic experiment."**
In the measured taxonomy across 33 questions (13 misses at Hit@5), `ENTITY_TYPE` accounts for
exactly 1 miss (7.7%). `CROSS_LANGUAGE` (5) and `PARAPHRASE` (5) are 76.9% between them. And
entity-type expansion depends entirely on `DocumentAnalysis`, which costs hundreds of seconds —
so on a freshly uploaded paper it addresses 0% of misses. Framing it as the primary experiment
was an error.

**False Premise 2 — "Stage B must wait for a Stage A measurement."** With `unicode61`, Chinese
characters produce zero token matches against English text. Deterministic string matching cannot
map unshared vocabularies without a glossary entry, and a cold paper has none. The evidence to
justify Stage B is already in hand; Stage A is retained as an ultra-fast, zero-provider fallback
and deterministic supplement.

**False Premise 3 — "Monolithic OR-expansion preserves BM25 ranking fidelity."** Concatenating
queries as `(base) OR (exp1) OR (exp2)` lets high-frequency expanded tokens dilute the query's
IDF and outvote the gold paragraph — as observed on the PPO question *"What is Algorithm 1 in
this paper?"*, where the gold paragraph "Algorithm 1 PPO" was outvoted by four common words.
Query variants must be issued as **independent FTS5 queries** and fused with RRF.

## 3. Answers to the six decisions

**A — Evidence for LLM query rewriting.** Yes, in hand. 77% of measured misses are
cross-language and paraphrase; Stage B is approved for immediate implementation.

**B — Evidence for embeddings.** **Stage C is a strict NO-GO.** Costs in a local-first desktop
app: 100–500 MB of model weights; 1–5 s of CPU embedding per PDF on upload; native SQLite vector
extensions to compile across three platforms; and dense retrieval's known weakness on exact
variable names, formulas and hyperparameter tables — the very lookups BM25 wins. Reopen only if
residual Hit@5 on a fresh held-out set stays below 80% after Stage B, **and** an offline proof of
concept recovers ≥ 60% of residual failures without regressing exact alphanumeric lookups, within
a ≤ 2.0 s indexing budget on an 8-core CPU.

**C — Fusion.** Reciprocal Rank Fusion, `RRF(d) = Σ 1/(k + r_q(d))` over the query set, with
**k = 60** (a smaller k over-biases toward noisy top-1 outliers). Top **M = 20** candidates per
variant before fusion. **Deduplication identity must be `paragraph_id`** (or `chunk_id` for
captions), never raw text: papers repeat their own sentences, and deduplicating by text corrupts
provenance, citation mapping and neighbour expansion.

**D — Entity-type expansion without `DocumentAnalysis`.** It **must not run**. Extracting entities
at query time adds latency and hallucination risk; on cold papers Stage B handles the type word.

**E — Bounds.** Trigger on an entity-type word matching an entity `kind`. Eligibility requires
`len(entity.paragraph_ids) >= 2` (drops single-mention noise). Sort by occurrence count
descending, tie-broken alphabetically. **Hard cap: 3 entities.**

**F — Preventing benchmark tuning.** Four rules: no corpus-specific term may appear in `app/qa/`
(AC-10); ResNet and Diffusion Policy are diagnostic while PPO is held out; a change that improves
one set while degrading another by ≥ 5% is rejected; and DS-QA-002's invariance must hold (16/16
abstentions, 3/3 counterfactual).

## 4. Stage gates

```
STAGE A: deterministic expansion & multi-query infrastructure
├── bidirectional acronym & glossary matching
├── bounded entity expansion (cap 3, min frequency 2, analysis-present only)
└── zero-provider fallback, < 15 ms
    └─> GATE A: diagnostic Hit@5 ≥ 65%, zero cold-paper regressions  → GO

STAGE B: bounded LLM query rewriting & RRF fusion
├── 2–4 lexical variants, cross-language English translation + paraphrasing
├── independent FTS5 queries, RRF (k=60), dedup by paragraph_id
├── graceful degradation to Stage A on error or timeout
└── scope enforced in SQL candidate generation for every variant
    └─> GATE B: held-out PPO Hit@5 ≥ 80%, cross-language Hit@5 ≥ 80%,
                abstention 16/16 intact, latency ≤ 1500 ms  → GO

STAGE C: hybrid dense retrieval
    └─> GATE C: FROZEN / NO-GO. Barred unless Stage B fails 80% Hit@5 on unseen papers.
```

## 5. Criteria

### P0 — blocking

- **AC-01 Cold paper & zero-provider fallback.** With `analysis is None` and the provider
  disabled, offline or timing out, retrieval operates purely on FTS5/BM25. Assertion: Hit@5 on
  cold ResNet / Diffusion Policy / PPO meets or exceeds the measured raw baseline with zero
  unhandled exceptions.
- **AC-02 Bidirectional acronym & glossary expansion.** Case-insensitive both ways: acronym ↔
  full expansion, glossary term ↔ suggested translation. `expansion is None` is skipped without
  error. Assertion: querying `"Proximal Policy Optimization"` against an analysis containing
  acronym `"PPO"` produces `"PPO"` as an alternative search term.
- **AC-03 Bounded entity expansion.** Analysis-present only; triggers on an entity-category word;
  `len(paragraph_ids) >= 2`; cap 3 by frequency. Assertion: on ResNet's 34 model entities,
  *"What models are evaluated?"* injects at most 3; with `analysis is None`, 0.
- **AC-04 Bounded LLM query rewriting.** Generate 2–4 distinct lexical variants as JSON
  `{"queries": [...]}`. For CJK queries, ≥ 2 variants are fluent English technical translations.
  Assertion: a Chinese query yields English variants containing terms such as `limit`, `policy
  update`, `clip`, `constraint`. *(Budgets — AC_CHANGE_REQUEST 2.)*
- **AC-05 Strict scope enforcement at candidate generation.** Every variant runs with the active
  `Scope` applied in SQL. Assertion: for a section scope, every candidate row across all variants
  has that `section_id`.
- **AC-06 Selection scope fast path.** Rewriting, entity expansion and neighbour expansion are
  bypassed entirely; 0 provider calls.
- **AC-07 RRF and paragraph-identity deduplication.** Up to 20 candidates per variant, fused at
  k=60, deduplicated by `paragraph_id`/`chunk_id`. Assertion: two distinct paragraphs with
  identical text keep distinct `EvidenceItem`s with their own page and id.
- **AC-08 Grounding and abstention non-regression.** 16/16 abstentions on unanswerable questions,
  3/3 counterfactual detections, 0 answers from parametric memory.
- **AC-09 Benchmark recall thresholds.** PPO held-out Hit@5 ≥ 80% (baseline 62%), Hit@10 ≥ 85%;
  cross-language subset Hit@5 ≥ 80% (baseline 0%); paraphrase subset Hit@5 ≥ 80% (baseline 67%);
  diagnostic sets Hit@5 ≥ 75%.
- **AC-10 Zero benchmark hardcoding.** *(AC_CHANGE_REQUEST 1.)*

### P1

- **AC-11 Latency budgets.** Stage A ≤ 20 ms; Stage B rewrite ≤ 1200 ms, multi-query FTS5 + RRF
  ≤ 50 ms, end-to-end ≤ 1500 ms (p95); hard abort and fallback past the rewrite budget.
  *(AC_CHANGE_REQUEST 2.)*
- **AC-12 Captions, tables and index weights preserved** across multi-query retrieval: weights
  `section_title 5.0 / text 1.0`, captions carry `is_caption=True`. Assertion: *"What is shown in
  Figure 3?"* ranks its caption in the top 3.
- **AC-13 Neighbour expansion continuity after fusion.** Runs on the fused top-k, same section,
  `is_direct_hit=False`, never duplicating a direct hit.
- **AC-14 Generalization on a third held-out paper** ≥ 75% Hit@5. *(AC_CHANGE_REQUEST 4.)*

### P2

- **AC-15 Rewrite caching and token telemetry.** Cache by `(document_id, user_query)`;
  repeat queries < 1 ms; average prompt ≤ 300 tokens, completion ≤ 150.
- **AC-16 Stage C formal evaluation report.** Document residual misses after Stage B; if Hit@5
  ≥ 85% everywhere, archive Stage C as unnecessary.

## 6. Verification protocol Gemini specified

1. Unit tests — bidirectional acronym mapping, entity frequency cutoff and cap, RRF monotonicity,
   and that synthetic duplicate paragraphs with distinct ids keep separate ranks.
2. Provider and fallback tests — a provider timeout falls back to Stage A without throwing;
   malformed JSON falls back; a Chinese query yields English variants.
3. Automated benchmark runner — diagnostic (ResNet, Diffusion Policy) and held-out (PPO) sets,
   plus the DS-QA-002 counterfactual regression.
4. Real sidebar verification on a freshly uploaded, unanalysed paper with a Chinese question,
   checking that relevant English paragraphs are returned, citations resolve to real boxes, and
   an intentionally absent question still abstains.
