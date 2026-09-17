You are the independent Acceptance Criteria author for a local-first academic PDF
reader + bilingual translator ("Academic PDF Copilot").

Define objective P0 / P1 / P2 acceptance criteria for the next task.

**Do NOT write production code.** Return acceptance criteria only.

---

# TASK — DS-CTX-003: Context Effectiveness & Translation-Unit Mapping Benchmark

This is a **measurement task**. Context-aware translation exists and works; what is
unknown is whether it earns its cost, and whether the answer is being distorted by
the quality of one specific piece of the pipeline.

Three questions, in order:

```
A. How much is context quality limited by IR ↔ translation-unit mapping coverage?
B. Does context provide measurable value on genuinely ambiguous academic terminology?
C. Should Standard mode be the recommended default?
```

**No Paper QA. No UI. No more Context Engine until the current one is measured.**

## Where the project is

```
backend   663 passed
frontend   75 passed
```

Complete and verified: usable reader · real translation · DocumentIR (validated on a
real paper) · DocumentAnalysis (validated against a real model) · ContextBuilder ·
context-aware translation with per-unit cache identity (`e837d08`).

## The measurement that triggered this task

Real Off-vs-Standard A/B, two pages of ResNet, real provider (`deepseek-flash`):

```
identity mapping     1 -> 2   BETTER
degradation problem  1 -> 2   BETTER
shortcut connection  8 -> 11  BETTER
residual learning    3 -> 3   SAME
residual network     3 -> 3   SAME
citations 36 = 36 · source unchanged
```

An earlier run of the same comparison showed only 1 of 7 better. So the gain is real
but **modest and unstable between runs**, at roughly double the prompt cost.

Three candidate explanations, and this task exists to separate them:

1. **ResNet is a bad test.** It is one of the most widely known papers in machine
   learning; a strong model already renders `残差学习` and `恒等映射` unaided. Context
   should earn its cost on ambiguous terminology, and this paper has little.
2. **Mapping coverage caps the benefit.** Only ~68% of translation units resolve to an
   IR paragraph, so a third get document-level fallback.
3. **Context genuinely does not help much.** Possible, and the benchmark must be able
   to say so.

---

# VERIFIED GROUND TRUTH — the current mapper

`app/context/unit_mapper.py`, measured on a real run:

| | |
|---|---|
| Translation units (12-page paper) | **149** |
| IR paragraphs | **101** |
| Resolved | **101 / 149 = 68%** |
| Time | 0.74 ms/unit |
| Unresolved: "unit too short" | 28 |
| Unresolved: "no paragraph matched closely enough" | 19 |
| Unresolved: "ambiguous: 2 equally good matches" | 1 |

The algorithm, in order:

```python
normalize(text):  strip `{vN}` placeholders, collapse every run of non-word
                  characters to one space, casefold
score(unit, para): 1.0 if unit is a substring of the paragraph
                   len(para)/len(unit) if the paragraph is a substring of the unit
                   else |shared tokens| / |unit tokens|
match(unit):      refuse if len(unit) < 40 characters
                  refuse if best score < 0.80
                  refuse if two paragraphs tie at the best score
```

**The translation unit arrives as text only.** `translate(self, text)` receives a
string — no page number, no bounding box, no id. Upstream builds it by grouping
characters the layout model marked as one region; the IR builds paragraphs by joining
prose blocks that continue each other. The two segmentations do not correspond, and
149 ≠ 101 shows it.

**What is available that the mapper is not currently using**: the IR has, for every
paragraph and every text block, a `page_number`, a `bbox` in PDF points, a
`section_id`, and a canonical reading order. Upstream's translation call does not hand
those over — but nothing prevents the mapper being *given* more than the text if a
signal can be recovered upstream.

**The fallback today** distinguishes two cases and records which: a unit that matched
a paragraph but whose context build failed (`FALLBACK_DOCUMENT_ONLY`) and a unit that
never matched (`UNMAPPED`). Both currently receive document summary + domain, and no
section and no neighbours.

## What "sufficient coverage" is not yet known to be

A global 68% may be entirely acceptable. If the unmapped third is captions, reference
lists, table fragments and headings — regions where a paragraph's section summary and
neighbours would be *wrong* to attach — then 68% could be near the ceiling of what is
useful. If a third of ordinary body prose is unmapped, that is a serious defect.

**This distinction is the task.** One aggregate percentage is not an answer.

## Safety machinery that must not regress

* **Placeholders are `{vN}`, single-brace.** Confirmed two ways — captured from a real
  run, and from `converter.py:275` `f"{{v{len(var)}}}"` whose doubled braces are
  f-string escapes. The `get_formular_placeholder()` accessor returning `{{vN}}` is
  dead code. Validation compares multisets of `{vN}` between source and translation,
  rejects rewritten shapes, permits exactly one targeted repair, and on a second
  failure returns the **source unit** — formula correctness outranks completeness.
* **Cache identity** = source text + languages + `base_url` + `model` + protocol +
  prompt version + context mode + per-unit effective-context hash. **Never the API
  key.** This fixed the upstream defect where two providers shared one cache entry.
* **Context never appears in the output**; sentinels in context must not reach the
  translation.
* **Concurrency**: context travels in a thread-local and per-unit identity in the
  cache key argument, because four worker threads share one translator instance.
* **Source and IR are immutable.**
* **DocumentAnalysis consumes DocumentIR only** — no second PDF parser.

---

# WHAT THE CRITERIA MUST SETTLE

## Two questions requiring a direct answer

> **1. What mapping coverage is sufficient before paragraph-level contextual
> translation can be considered representative?**

> **2. Should unmatched translation units receive document-level fallback,
> section-level fallback, or Off-mode translation?**

Answer both with reasoning, not preference. On the second, note that document-level
fallback is already implemented and that section-level fallback is *not currently
possible* for a unit that failed to match a paragraph — nothing maps a unit to a
section without going through a paragraph first. If you require it, say what would
have to become true.

## Coverage must be measured by category, not in aggregate

The criteria must require a breakdown that can distinguish "we are missing body prose"
from "we are correctly refusing to attach context to a reference list". At minimum by
block type (prose / heading / caption / table-adjacent / formula-adjacent /
reference), by page, and by document layout.

## Failure causes must be classified before the algorithm changes

An error taxonomy, sampled from real units, distinguishing at least: text
normalisation, hyphenation, line-break differences, upstream merged several IR
paragraphs into one unit, upstream split one IR paragraph across units, bbox
disagreement, reading-order disagreement, formula-placeholder transformation,
duplicate source text, non-prose region, no corresponding IR unit.

## Mapping must not be improved by loosening it

Ordered preference, stated in the brief: correct mapping > high mapping percentage.
The criteria must make it mechanically hard to raise coverage by attaching wrong
context — in particular **no cross-page fuzzy matching** and **no arbitrary
nearest-paragraph matching**.

## Confidence must be categorical, not decorative

`EXACT | NORMALIZED | GEOMETRIC | FALLBACK | UNMAPPED` is suggested. Do **not** invent
a decimal confidence with no calibration behind it. Paragraph-level context should be
injected only where the mapping is trustworthy.

## The benchmark paper must be genuinely ambiguous

ResNet alone is disqualified as evidence. The benchmark should use a paper whose
terminology is domain-dependent — reinforcement learning, robotics, embodied
intelligence, world models, control, state-space models, multimodal learning — with
terms like `policy`, `state`, `action`, `observation`, `rollout`, `agent`, `world
model`, `alignment`, `representation`, `latent state`, `trajectory`, `planning`,
`control`, `reward`. The paper should represent the product's intended users rather
than being easy to translate.

Model: the already-configured `deepseek-flash`. Do not add paid providers for this.

## Repeated-run stability

The same comparison produced 1-of-7 and then 4-of-5 between runs. Criteria must
require **at least three repeated runs** on a fixed subset, measuring the stability of
the *classification* (BETTER / SAME / WORSE), not the exact wording — the model is
stochastic and identical output is not a reasonable bar.

## Cost and latency must be stated

Input and output tokens for both modes, provider calls, wall time, and the context
token multiplier. Distinguish **first** Standard translation (which pays for
DocumentAnalysis) from **cached** Standard translation (which does not). Do not call
context worth it without stating its overhead.

## Harm must be actively sought

Wrong glossary enforcement, incorrect disambiguation, neighbour contamination,
section-summary contamination, overtranslation, identifier translation, context
leakage, hallucinated words. If Standard improves 8 units and damages 4, both numbers
matter.

## The task must end in one of four decisions

```
A. STANDARD RECOMMENDED     useful, sufficiently stable gains justify the overhead
B. STANDARD OPTIONAL        helps some papers/terms but should not be the default
C. CONTEXT NOT YET JUSTIFIED current gain does not justify cost or complexity
D. MAPPING BOTTLENECK       cannot judge context; mapping quality is still insufficient
```

Chosen from evidence. Note the product rule in the brief: **do not make Standard the
default merely because it was built.** "Small improvement + ~2x tokens + high variance"
legitimately yields Off as default with Standard offered as "Academic Context" for
difficult papers.

---

# OUTPUT FORMAT

Return:

1. **P0 criteria** — numbered, objectively verifiable, each with a short rationale.
2. **P1 criteria** — deferrable with a stated reason.
3. **P2 criteria** — polish.
4. **Explicitly not applicable**, and why.
5. **Direct answers to the two questions above**, with reasoning.
6. **Any premise you believe is wrong** — including anything in the ground truth here
   you think is mistaken, or any measurement you believe cannot be made with the
   architecture as it stands.

Be specific about observable behaviour. Where a judgement is genuinely a matter of
degree, say what threshold would be defensible and why, rather than demanding
perfection or accepting anything.
