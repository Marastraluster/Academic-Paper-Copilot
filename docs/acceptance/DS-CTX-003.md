# Acceptance Criteria — DS-CTX-003: Context Effectiveness & Mapping Benchmark

- **Author:** Gemini (`gemini-3.8-flash-high`), via the standing two-agent workflow
- **Reviewed and frozen by:** DeepSeek, before implementation
- **Date:** 2026-09-17
- **Baseline:** `e837d08`
- **Status:** **FROZEN.** **9 P0 · 3 P1 · 2 P2.**

Baselines: `backend 663 passed · frontend 75 passed`.

## DeepSeek review — the measurement ran before the freeze, and it settles two things

Part 2 of the task was to measure mapping coverage *before* changing anything.
That is provider-independent work, so it was done while the criteria were being
authored. It answers one of Gemini's two questions and **refutes one of its premises**.

Measured across three real papers — ResNet, PPO (arXiv:1707.06347), Diffusion Policy
(arXiv:2303.04137) — 432 translation units captured from real runs:

| Paper | Units | Matched | Prose the IR missed | Prose coverage | Effective coverage |
|---|---|---|---|---|---|
| ResNet | 149 | 101 | 6 | 94.4% | 96.0% |
| PPO | 62 | 46 | 1 | 95.8% | 96.8% |
| Diffusion Policy | 221 | 164 | 2 | 97.0% | 98.2% |
| **Total** | **432** | **311** | **9** | **96.3%** | **97.2%** |

**The unmapped 28% is almost entirely correct refusals**: headings 10.4%, captions
10.0%, tables 2.5%, running headers 1.6%. Only **2.8%** of units are body prose the IR
failed to represent as a paragraph.

### Answering Gemini's Q1 with data

Gemini asked what coverage is sufficient and answered **≥85% of body prose**. The
measurement gives **96.3%**, so the bar is met and **Decision D (`MAPPING BOTTLENECK`)
is excluded** — it requires prose coverage below 75%.

### Refuting Gemini's Premise 1

> *"High prose mapping coverage cannot be achieved purely via string gymnastics in
> `unit_mapper.py`. … a split half-paragraph will fail … Attempting to solve this by
> lowering the score threshold below 0.80 will cause catastrophic false-positive
> collisions."*

The measurement contradicts the prediction. Text-only matching, with **no threshold
relaxation at all**, resolves 96.3% of prose. The score threshold stayed at 0.80 and the
ambiguity rule stayed in place; coverage came from the containment-first scoring, not
from loosening it.

This matters because the premise, if accepted, would have justified the large change
Gemini defers to P1 — passing bounding boxes and page numbers down from upstream. The
data says that complexity is not needed to reach the prose coverage bar.

## Premise critiques accepted

**Premise 2 — term-frequency counting is flawed methodology.** Accepted, and it is a
criticism of DS-CTX-002's own evidence. Counting `shortcut connection 8 → 11` conflates
accuracy with lexical bias: if context makes the model repeat a term where the source
used a neutral construction, that is overtranslation, not improvement. **The ambiguous-
paper benchmark evaluates per unit, judging whether the term was warranted by the source
syntax**, not by counting occurrences.

**Premise 3 — run instability may be thread-local leakage, not model variance.**
Accepted as a diagnostic requirement. DS-CTX-002's A/B moved from 1-of-7 to 4-of-5 on
identical inputs, and attributing that to stochasticity without checking is exactly the
kind of assumption this project refuses elsewhere. The thread-local is cleared in a
`finally`, but "it looks airtight" is not a measurement. **The benchmark must verify, in
the real pipeline, that each unit receives its own context and no other's.**

**Premise 4 — ResNet is disqualified as the primary benchmark.** Accepted.

### Answering Gemini's Q2 — and it changes the implementation

> *"Unmatched units should receive Off-mode translation (zero context) by default.
> Document-level fallback should be strictly restricted or eliminated for unmapped
> units."*

**Accepted, and the measurement supports it more strongly than Gemini could have known.**
Gemini argued from the *shape* of unmatched units — fragments, table cells, short
headings. The measurement confirms it: of 121 unmatched units, **111 are captions,
headings, tables, references and running headers**; only 9 are prose.

Attaching a 250-word document summary to a five-word table cell is prompt asymmetry with
no disambiguation value, doubling the cost of a unit where context cannot help. The
current implementation does exactly that.

**This is a production change DS-CTX-003 makes**: unmatched units get Off-mode translation.

## What is *not* changed, and why

Gemini defers geometric metadata passing to P1, on the grounds that P0 must first
establish whether the text-only mapper is the bottleneck. The measurement settles that
question: it is not. **No upstream signature change is made in this task.**

---

# P0 — must pass (9)

| ID | Requirement | Verification |
|---|---|---|
| **P0-1** | **Categorical coverage, not an aggregate.** Coverage reported per structural type (prose / heading / caption / table / formula / reference), per page and per layout. A machine-readable report plus a summary table. | The report exists and shows prose coverage separately from non-prose refusal. |
| **P0-2** | **Deterministic failure taxonomy.** Every unresolved unit classified into mutually exclusive causes: too short, non-prose region, normalisation/hyphenation, upstream merged, upstream split, placeholder mismatch, duplicate text, no IR correspondence, below threshold. | 100% of unresolved units carry exactly one cause. |
| **P0-3** | **Anti-loosening invariants.** No cross-page fuzzy matching. No nearest-paragraph fallback below threshold. A **categorical** confidence tag — `EXACT` / `NORMALIZED` / `GEOMETRIC` / `FALLBACK` / `UNMAPPED` — with no uncalibrated decimal gate. | Threshold unchanged at 0.80; a sub-threshold unit is never attached to its nearest neighbour. |
| **P0-4** | **A domain-ambiguous benchmark paper.** Open access, rich in polysemous terminology (`policy`, `state`, `action`, `observation`, `rollout`, `reward`, `agent`, `world model`, `latent state`, `trajectory`, `planning`, `control`), with at least 10 instances across 5 core terms whose correct rendering depends on domain. ResNet disqualified. The configured `deepseek-flash` only; no paid endpoints added. | The chosen paper is not ResNet and contains the vocabulary. |
| **P0-5** | **Repeated-run stability, N ≥ 3.** At least 80% of units must carry an identical `BETTER`/`SAME`/`WORSE` classification across three runs. Below that the run is marked `UNSTABLE_EVIDENCE`. | Stability rate computed over a fixed subset. |
| **P0-6** | **Bidirectional quality and active harm search.** Harm taxonomy: wrong glossary enforcement, neighbour contamination, section contamination, overtranslation, context leakage. Net value = `(BETTER − WORSE) / TOTAL`. Viability floor: `WORSE / BETTER < 0.15`. Reporting only improvements is forbidden. | Both counts reported. |
| **P0-7** | **Cost and latency accounting.** Mean prompt and completion tokens per mode, the context token multiplier, per-unit latency with p95, and **cold vs cached** Standard separately — the first Standard run pays for analysis, later ones do not. | All figures measured, not estimated. |
| **P0-8** | **Deterministic four-way decision.** The conclusion maps to exactly one outcome by thresholds, not by preference. | See the thresholds below. |
| **P0-9** | **Safety regression.** Placeholder multiset equivalence, cache isolation (endpoint / model / context / glossary), concurrency isolation in the real pipeline, and source + IR immutability. | Existing suites pass; concurrency verified with canaries. |

## P0-8 thresholds, and where the measurement already lands

```
A. STANDARD RECOMMENDED    prose ≥ 85% · net value ≥ +15% · stability ≥ 80% · harm < 0.10
B. STANDARD OPTIONAL       prose ≥ 75% · net value > 0    · harm < 0.20 · but cost or scope limited
C. CONTEXT NOT YET JUSTIFIED  prose ≥ 75% · net value ≤ 0 OR stability < 70% OR harm ≥ 0.20
D. MAPPING BOTTLENECK      prose < 75%
```

**Prose coverage measures 96.3%, so D is excluded before the benchmark runs.** The
remaining three are decided by the ambiguous-paper A/B.

# P1 (3)

Multi-paper cross-domain profiling · geometric metadata passed from upstream (deferred —
the measurement says it is not needed to reach the bar) · a calibrated LLM-as-judge.

# P2 (2)

A visual mapping overlay · a formatted benchmark CLI. Both developer ergonomics only.

# Explicitly not applicable

Paper QA · frontend toggles · Context Engine redesign · paid third-party models · layout
model retraining.
