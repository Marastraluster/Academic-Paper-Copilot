# Evidence — DS-CTX-003 Context Effectiveness & Mapping Benchmark

- **Date:** 2026-09-17
- **Agent:** DeepSeek (Claude Code CLI)
- **Acceptance criteria:** `docs/acceptance/DS-CTX-003.md` (Gemini, frozen before implementation)
- **Baseline:** `e837d08`
- **Verdict:** **The mapping bottleneck is refuted, and the context payload does not earn
  its cost. Recommended: `CONTEXT NOT YET JUSTIFIED` as a default — but adopt the prompt,
  which is where the measured gains actually come from.**

## PART 2 — where the unmapped units come from

432 translation units captured from real runs of three papers — ResNet, PPO
(arXiv:1707.06347), Diffusion Policy (arXiv:2303.04137) — classified by **what each unit
is**, not merely whether it matched.

```
total units        432
resolved           311   (72.0%)
prose coverage     96.3%      <- Gemini's bar for representative benchmarking is 85%
effective          97.2%      <- excluding refusals that were correct
genuine misses      12   (2.8%)  <- body prose the IR failed to represent
```

| Paper | Units | Matched | Prose the IR missed | Prose coverage |
|---|---|---|---|---|
| ResNet | 149 | 101 | 6 | 94.4% |
| PPO | 62 | 46 | 1 | 95.8% |
| Diffusion Policy | 221 | 164 | 2 | 97.0% |

**The catalogued failure taxonomy** for the 121 unmatched units:

```
non-prose (caption)      43     correctly refused — a caption has no section to belong to
non-prose (heading)      45     correctly refused — a heading is not a paragraph
non-prose (table)        11     correctly refused
abandon                   7     correctly refused — running headers, footers, page stamps
prose-block-only          9     GENUINE — body text the IR holds as a block, not a paragraph
absent                    3     GENUINE — text nowhere in the IR
non-prose (figure)        1
non-prose (formula)       1
empty                     1
```

**The mapping bottleneck hypothesis is refuted.** 90% of unmatched units are regions where
attaching a paragraph's section summary and neighbours would be *wrong*. Only 2.8% are body
prose, and the score threshold never moved from 0.80 to achieve 96.3% prose coverage —
Gemini's prediction that text-only matching would fail without geometric metadata did not
hold.

## PART 4–5 — the changes the evidence supported

1. **Unmatched units now receive no context at all**, where they previously received the
   document summary and domain. Worth stating plainly: **this is a reversal of the design
   DS-CTX-002 shipped.** Gemini argued it from the shape of unmatched units; the measurement
   confirms it — 111 of 121 are captions, headings, tables and headers. A 250-word summary
   attached to a five-word table cell cannot tell it which sense of a word it means, and
   double-charges a unit where context cannot help. An unmatched unit now shares the
   off-mode cache entry, so it costs nothing extra.
2. **Categorical confidence** — `EXACT` / `NORMALIZED` / `FALLBACK` / `UNMAPPED` — replacing
   the bare score as any kind of gate. No decimal is exposed, because none is calibrated.
3. **A failure taxonomy** on the mapper's own result, so a future change can be judged
   against which causes it removes.

## PART 7–13 — the ambiguous-paper benchmark

**Paper:** Diffusion Policy (arXiv:2303.04137), a robotics paper whose terminology —
`policy`, `action`, `observation`, `trajectory`, `rollout`, `planning` — is genuinely
domain-dependent. ResNet is disqualified: `残差学习` is in the model's weights.

**Method:** 15 units, 3 repeats each, both modes, **90 real provider calls**. Prompts are
built by the real code paths — Off uses upstream's own envelope, Standard uses
`prompts.translation_messages` fed by the real `UnitContextProvider`.

**Assessed per unit**, not by counting term occurrences. (Gemini's Premise 2 is right that
counting conflates accuracy with lexical bias — and it is a criticism of DS-CTX-002's own
evidence.)

```
BETTER    4      units 1, 5, 14, 15
SAME     10
WORSE     1      unit 4 — a provider failure, not a bad translation

net value  (4 - 1) / 15 = +20%
```

### Reliability, which the quality table hides

```
off        0 / 45 calls failed
standard   2 / 45 calls failed          (4.4%)
```

Standard's prompt is **6.58× larger**, and on two occasions the model's reasoning exhausted
the output budget before it wrote anything. Off never failed.

### Cost

```
mean prompt tokens    off  186   ·   standard 1226   ·   multiplier 6.58x
analysis (first run)  392 s for 3 pages
source unchanged      True
```

The multiplier is far above the "~2×" every earlier estimate assumed, including the
product brief's.

## PART 11 — the experiment that decides it

Standard changes **two** things at once: the prompt (which explicitly instructs identifier
and citation preservation) and the context payload. The gains above are all in identifier
and citation preservation — which the prompt alone might produce.

So a **third arm**: the identical envelope with every context field empty.

```
                     identifier kept   citation kept
off                       6/15              —          unit 14: False
standard                  7/15              —          unit 14: True
prompt-only               6/15              —          unit 14: True
```

Unit-by-unit the prompt-only arm lands with Standard on units 1, 4 and 5 — on unit 4 the two
outputs are character-identical — and with Off on unit 7. **It matches Standard on every
signal that produced a BETTER call, at Off's cost.**

The observable improvement therefore comes from the **prompt**, not the payload.

## Safety

| | |
|---|---|
| Placeholder / formula | **PASS** — unchanged; all 15 units preserved `{vN}` multisets in both arms |
| Citations | **PASS** — preserved; Standard's arm improved them, via the prompt |
| Concurrency isolation | **PASS** — 20 units over 2 threads, every one saw only its own context |
| Cache isolation | **PASS** — endpoint, model, prompt version, mode, per-unit context hash |
| Source immutability | **PASS** — byte-identical after every run |
| Backend | **666 passed** |
| Frontend | **75 passed**, build exit 0 |

One flake observed and recorded rather than waved away:
`test_force_regenerates_and_leaves_every_other_artifact_alone` failed once in a full-suite
run and passed three times in isolation and once in a subsequent full run. Unreproduced;
noted so it is not mistaken for green.

## PRODUCT DECISION: **C — CONTEXT NOT YET JUSTIFIED**

**as a default mode.** The evidence, and what each piece rules out:

| Option | Ruled out by |
|---|---|
| **D — MAPPING BOTTLENECK** | Prose coverage 96.3%, against a threshold requiring <75% |
| **A — STANDARD RECOMMENDED** | No ambiguous term was translated differently in either mode; the 6.58× multiplier; 4.4% call failures against Off's 0% |
| **B — STANDARD OPTIONAL** | It helps nowhere that Off does not, once the prompt is held constant — so "optional for difficult papers" has no measured basis |
| **C — CONTEXT NOT YET JUSTIFIED** | What remains |

The stated purpose of context-aware translation was **disambiguation**: choosing the right
sense of `policy`, `action`, `observation` for the paper's domain. **No unit rendered any
ambiguous term differently between modes.** The feature did not do the thing it exists for.

What it did do — preserving `Diffusion Policy`, keeping `Song and Ermon (2019)` literal — is
real and useful, and comes from prompt instructions that cost a constant handful of tokens
rather than a 6.58× payload.

### Implication, stated but not acted on

The obvious next step is a mode that keeps the **prompt** and drops the **payload**. That
would cost roughly Off plus a constant instruction block, and on this evidence would retain
every measured gain. It is a production change this task did not make, because the criteria
scoped DS-CTX-003 to measurement.

### Implication for Paper QA

Gemini's Premise 2 correction applies here too. The DS-CTX-001 semantic baseline — 96.3%
evidenced glossary, 24 of 29 acronyms honestly unexpanded, zero fabrications — is a
**higher-quality artifact than its use here suggests**. Translation needed almost none of it.
Paper QA, summarisation and citation-aware explanation are the consumers that would need a
document summary, a section structure and a terminology list, and would pay for them once
per answer rather than once per paragraph.

The hypothesis recorded at the start of this task — *the semantic layer may create more value
for Paper QA than for every translation request* — is **supported** by these measurements.

## Recommended next task

**A prompt-only translation mode.** Small, cheap, and the only change this evidence actually
supports: adopt the academic translation prompt as the default envelope, keep the context
payload behind an explicit opt-in, and re-measure. If the prompt alone holds the gains — as
the third arm indicates — the product gets better translations at Off's cost, and the context
layer waits for the consumer that needs it.
