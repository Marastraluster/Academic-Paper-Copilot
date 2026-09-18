# Evidence — DS-CTX-004 Academic Prompt Translation Baseline

- **Date:** 2026-09-18
- **Agent:** DeepSeek (Claude Code CLI)
- **Acceptance criteria:** `docs/acceptance/DS-CTX-004.md` (Gemini, frozen before implementation)
- **Baseline:** `4811ae9`
- **Verdict:** **The academic prompt-only mode exists, works, needs no analysis, and does not
  earn the default. `BASIC DEFAULT, ACADEMIC OPTIONAL` — decided by the gate, against the
  expectation recorded in both the brief and DS-CTX-003.**

## What was built

```
app/context/translation_context.py   MODE_ACADEMIC; VALID_MODES = (off, academic, standard)
app/context/prompts.py               a self-contained academic envelope
app/pdfkernel/contextual_translator.py  mode-aware dispatch and cache key
app/pdfkernel/context_registry.py    MODE_ENV — the mode travels without a provider
app/pdfkernel/adapter.py             additive: context_mode
app/documents/tasks.py               only contextual builds a provider
frontend/src/translation/session.ts    ContextMode, mapped to the API's names
frontend/src/translation/TranslateDialog.tsx  three modes, cost disclosed
```

Academic mode sends the academic instructions and **nothing else** — no summary, no section,
no neighbours, no glossary — and it does so without a `UnitContextProvider` at all. That is
the point: no `DocumentIR`, no `DocumentAnalysis`, no mapper.

### Cache identity

Academic and basic send **pure `source_text`** to the cache; only contextual namespaces with a
per-unit context hash. The mode is a registered cache *parameter*, so the three still cannot
return each other's entries — but a mode that reads no analysis is no longer invalidated when
analysis changes.

## Verification

```
$ cd backend && .venv/Scripts/python -m pytest       → 674 passed
$ cd frontend && npm run test                        → 78 passed
$ npm run build                                      → exit 0
```

### The three-arm gate (P0.7)

Diffusion Policy, `deepseek-flash`, the same 15 units, three repeats per arm, all in one
session so no arm is measured under different conditions.

```
arm           tokens   vs basic   latency   failures
basic            196      1.00x     2.9s      1/45
academic         407      2.07x     3.5s      3/45
contextual      1239      6.32x     2.1s      0/45

analysis (contextual only): 468 s
```

**Quality, on the signals DS-CTX-003 used:**

```
                        basic   academic   contextual
identifier preserved       6        6          7
citations verbatim         6        6          6
placeholder mismatches     0        0          0
preambles / fences         0        0          0
```

### Gemini's gate for Decision A, applied

| Gate | Required | Measured | |
|---|---|---|---|
| net quality win, academic vs basic | ≥ 20% | indistinguishable (6/6, 6/6) | **FAILS** |
| academic prompt tokens | ≤ 2.0× basic | **2.07×** | **FAILS** |
| analysis duration for academic | 0 s | 0 s | passes |
| academic failure rate | ≤ 2.2% | **6.7%** | **FAILS** |

**Three of four gates fail.** The default does not move.

### The failures are stochastic, not mode-driven

All four failures across 135 calls were `LLMOutputTruncatedError` — the reasoning model
exceeding the output budget. They were scattered: unit 3 failed once in **basic** as well as
once in academic, and contextual — 6.3× larger prompts — had **zero** failures this run after
**two** in DS-CTX-003.

A mode-dependent failure rate cannot be inferred from 1/45 versus 3/45 when the same mode
moves from 2/45 to 0/45 between sessions. Recorded rather than attributed.

## The finding that decided it

**DS-CTX-003's third-arm result did not replicate.**

That experiment concluded the academic *prompt* carried the observed gains, and that Standard's
payload added nothing — on one run, with one repeat per arm. DS-CTX-004 repeated it three
times per arm, under identical conditions, and **academic matched basic exactly** on both
identifier and citation preservation (6 and 6 out of 15).

The earlier single-run difference was noise. Gemini's P0.5 — three repeats, judge the
*classification*, not the wording — is what caught it, and it earned its place.

This is the second time in this phase that a repeated measurement reversed a single-run
conclusion. DS-CTX-003 reversed DS-CTX-002's evidence; DS-CTX-004 reverses DS-CTX-003's.

## End-to-end in academic mode (P0.6)

```
pages: 3  profile: Deepseek/deepseek-flash
accepted: PENDING (no analysis required)
status: SUCCESS in 74 s

mono pages=3 (source 3)   dual: 200
CJK characters      2921
citations             18
unsubstituted {v     0
analysis.json written   False     <- the mode's whole purpose
ir.json written         False     <- it does not even need the document structure
source unchanged        True
```

74 seconds against contextual's 468 seconds of analysis *before* any translation. No
`DocumentAnalysis`, no `DocumentIR`, no context builder.

## Safety

| | |
|---|---|
| Placeholders | **PASS** — 0 multiset mismatches across all 45 arm-runs and the E2E |
| Formula | **PASS** — no unsubstituted `{vN}` in the produced PDF |
| Citations | **PASS** — 18 in the E2E output, preserved in all three arms |
| Source immutability | **PASS** — byte-identical after every run |
| Full PDF E2E | **PASS** |
| Contextual regression | **PASS** — all DS-CTX-002 tests unchanged and green |

### The flake (P0.8, amended)

Gemini attributed the DS-CTX-003 flake to NTFS timestamp granularity and prescribed a clock
mock. **The test asserts file contents, not timestamps** — there is no `mtime` anywhere in it,
so the diagnosis could not be right and the remedy would have fixed nothing. The criteria were
amended to a diagnosis-agnostic protocol.

**Measured after the flake: 12 isolation runs and 3 full-suite runs, all green, not
reproduced.** Recorded as unreproduced with the caveat that a single observation under
full-suite load is a real signal that remains unexplained. The assertion was not weakened,
skipped or deleted.

## PRODUCT DECISION: **B — BASIC DEFAULT, ACADEMIC OPTIONAL**

Academic mode is real, fast, analysis-free and safe — and it does not measurably improve
translation over the basic prompt, at twice the token cost. It stays available for users who
want the academic instructions; it does not become the default.

**The frontend default was changed back to basic to match.** I had set it to academic on the
expectation the brief recorded. The measurement disagreed, and the measurement wins.

## CONTEXTUAL STATUS: **EXPERIMENTAL**

Gemini's answer, and the evidence supports it.

Not "visible advanced": 6.32× the tokens and 468 seconds of analysis for a one-unit difference
in identifier preservation that is not significant at n=15. Labelling it *better* would cost
users minutes and money for nothing measured.

Not hidden: the sample is one robotics paper, and a document glossary might genuinely help on
a polysemous interdisciplinary paper. Burying it would also let the machinery rot before Paper
QA needs it.

It is badged, its cost is stated where the user chooses, and it is not the default — which is
what the measurement supports.

## Implication for Paper QA

The DS-CTX-003 observation stands and is now stronger: the semantic layer has produced no
measurable benefit on **three** consecutive translation experiments, while its artifact
quality (96.3% evidenced glossary, zero fabrications) is high. Translation does not need it.
Paper QA, summarisation and citation-aware answers do — and would pay for it once per answer
rather than once per paragraph.

## Recommended next task

**Paper QA foundation.** Stop optimising translation; three tasks have measured it and the
answer is stable. Build the consumer that needs the artifacts: scope selection → `DocumentIR`
+ `DocumentAnalysis` + retrieval → source chunks → answer with real page and paragraph
citations, starting with SQLite FTS5 / BM25 rather than embeddings. The existing document
summary, section summaries, glossary, acronyms, page mapping and paragraph ids are the
foundation, and none of them needs rebuilding.
