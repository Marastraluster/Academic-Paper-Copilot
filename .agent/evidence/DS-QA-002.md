# Evidence — DS-QA-002 Grounded Answer Generation

- **Date:** 2026-09-18
- **Agent:** DeepSeek (Claude Code CLI)
- **Acceptance criteria:** `docs/acceptance/DS-QA-002.md` (Gemini, frozen before implementation,
  with three `AC_CHANGE_REQUEST`s raised in review)
- **Baseline:** `bb018a4` (DS-QA-001), `3438e5a` (its P0-9 disposition)
- **Verdict:** **The answer layer works. It abstains when the evidence does not answer, and it
  refuses to answer from memory on a paper the model certainly knows. Two of its own checks
  were wrong, and running the real benchmark is what found them.**

## What was built

```
backend/app/qa/models.py       AnswerResult, ResolvedCitation, AnswerDiagnostics, the tri-state
backend/app/qa/prompts.py      the versioned envelope, evidence as untrusted data
backend/app/qa/citations.py    marker extraction, claim detection, anchor attestation, resolution
backend/app/qa/answering.py    the pipeline: gate → budget → generate → validate → resolve
backend/app/api/documents.py   POST /api/documents/{id}/answer
backend/tests/test_qa_answer.py   50 tests, all offline
```

Three design decisions carry the task.

**Abstention is a result, not an error.** `insufficient_evidence` returns `200` with a rationale.
A provider failure returns `502` with the provider's own code. Reporting "the paper does not say"
when the truth is "the provider timed out" is a lie the user cannot detect, so the two never share
a path.

**Empty evidence costs nothing.** Zero items, or `NO_MATCH_TOKEN`, or whitespace-only evidence
returns before any provider call. Asking a model to look at nothing and report back is how money
buys an answer from memory.

**The model is given no page numbers and asked for none.** It names `E1`; the application resolves
that against the `DocumentIR` to a page, a section and bounding boxes. AC-P0-07 is checked
mechanically: the serialized prompt contains no page label for any bundle item.

## Verification

```
$ cd backend && .venv/Scripts/python -m pytest      → 768 passed   (718 before this task)
$ cd frontend && npm run test                       → 78 passed
$ npm run build                                     → exit 0
```

### Latency (P1-06) — measured against a zero-latency provider

```
non-LLM overhead: median 3.39 ms, max 5.12 ms   (median of 30)
budget: pre-LLM ≤ 5 ms, post-LLM ≤ 15 ms, total < 20 ms   → PASS
```

### The real-provider benchmark

`Deepseek / deepseek-flash`, both real papers, no stubs. Ground truth was **verified mechanically
before the run**: every unanswerable question names a term confirmed absent from the paper, every
partial question has one facet present and one absent.

```
paper              arm            n   answered   partial   abstained   false answers
ResNet             answerable    10       8          -          2             -
ResNet             partial        6       -          6          0             -
ResNet             unanswerable  10       -          -         10             0
Diffusion Policy   answerable     6       5          -          1             -
Diffusion Policy   partial        4       2          1          1             -
Diffusion Policy   unanswerable   6       -          -          6             0
```

**P0-03 satisfied: 16 of 16 unanswerable questions abstained, zero false answers.**

```
citations:  22 answers carried citations, 0 answered without any → structural validity 100%
errors:     0
performance: 42 questions, 102.3 s total, median 2.0 s, median prompt 2761 tokens
             136,743 prompt tokens, 19,847 completion tokens, 7 repairs
```

### The counterfactual — the test a correct answer cannot fake

ResNet is in every model's training data, so a right answer proves nothing. The evidence was
re-run with its hyperparameters swapped to values the paper never states — momentum 0.9 → 0.5,
weight decay 0.0001 → 0.05 — and asked three times.

```
run 1: answered  counterfactual=True   pretraining=False
run 2: answered  counterfactual=True   pretraining=False
run 3: answered  counterfactual=True   pretraining=False
```

**3 of 3 reported the swapped values and cited the evidence. 0 of 3 reported the real ones.**
A model answering from memory would have said 0.9 and 0.0001, and it would have looked correct.

This is the single strongest piece of evidence in the task, and it is why the measurement is
repeated: this project has twice reversed a single-sample conclusion.

### Chinese question, English paper, real provider (P0-11)

The unit tests cover the pipeline; only the model can show whether the *answer* is in
Chinese with its identifiers intact. The document's real 207-entry glossary is what makes
the Chinese query reach the English text at all.

```
作者是如何解决退化问题的？
  answered · Chinese · identifiers kept: ResNet, 152, 34
  8 citations → pages [3, 3, 2, 3, 3, 6, 5, 7]

捷径连接有什么作用？
  answered · Chinese · identifiers kept: ResNet, ImageNet, 34
  4 citations → pages [3, 5, 3, 5]
```

The answers keep `residual learning`, `shortcut connections` and `identity mapping` in
English inside the Chinese prose — which is what a Chinese reader of an English paper
wants — and every citation resolves to an English source paragraph with its real page.

### Source-support audit (§55/§56) — read, not computed

A valid citation ID is not a supported claim, so eight answers across both papers and all three
arms were audited by reading each cited sentence against the text it points at: **22 claims,
21 SUPPORTED, 1 PARTIALLY_SUPPORTED, 0 UNSUPPORTED.**

The one partial is worth stating plainly. A sentence beginning *"For CIFAR-10, the network ends
with a 10-way fully-connected layer…"* cited a paragraph that never says "CIFAR-10" — it is in
§4.2 *CIFAR-10 and Analysis*, and the section title is what grounds it. That is a citation
supported by the section's identity rather than by the paragraph's own words, and it is a direct
consequence of the section-title allowance below.

## Two of this task's own checks were wrong, and the benchmark found both

**The validator rejected honest answers.** It checked a claim's numbers and identifiers against
the cited paragraph's text — while the envelope hands the model the section title as orientation.
A paragraph in "4.2. CIFAR-10 and Analysis" whose own prose never says "CIFAR-10" produced a
sentence the validator called fabricated. Measured cost: **two honest answers withheld in 25**
(8%), and it was the difference between 7/10 and 9/10 answered on the ResNet arm. The section
title now counts as part of what the citation vouches for. A regression test encodes it.

**The benchmark's ground truth was too shallow.** Two questions were filed as unanswerable because
a *term* was absent — `tesla`, `milliseconds` — while the *information* was present: the paper
says the models were trained "on two GPUs", and it states the inference latency in seconds. Both
produced grounded, disclosed answers, and both were counted as hallucinations. They have been
moved to the partial arm, which is where a question with one answerable facet belongs. A question
is unanswerable when it is unanswerable in every part, not in the part that is easy to grep for.

**And the measurement itself had a bug.** The first counterfactual run reported a grounding
failure. It was an artefact: the index records the *source PDF's* `content_hash`, which swapping
paragraph text does not change, so the run queried a stale index and handed the model the original
numbers. The counterfactual now uses its own directory. Recorded because the first result looked
exactly like the failure the test exists to detect.

## Failure taxonomy (§61)

```
RETRIEVAL_MISS              1   "What optimization method is used?" — the bundle contains
                                 no paragraph with "momentum" (DS-QA-001's vocabulary gap).
                                 The model abstained rather than answering from memory.
ANSWER_GENERATION_ERROR     0
CITATION_ERROR              0
EVIDENCE_SUFFICIENCY_ERROR  3   2 answers withheld by this project's validator after a failed
                                 repair; 1 over-abstention where the evidence was present and
                                 the model declined anyway.
```

**The validator withholds about 5% of answers** (2 of 42) and both re-ran clean on a fresh draw,
so the cause is model stochasticity rather than a fixed input. The criteria allow exactly one
repair (AC-P0-14), so the alternative to withholding is showing an answer that failed its
grounding check — and the measurement says the conservative choice costs a few good answers.

## Safety

| | |
|---|---|
| Citation IDs | **PASS** — every emitted marker names evidence in this bundle; `E99` triggers repair, then demotion, and is never displayed |
| Pages from the model | **PASS** — no page label reaches the prompt; every `ResolvedCitation` page equals the IR's |
| Paragraph identity | **PASS** — from `DocumentIR`, never derived or reinterpreted |
| Bounding boxes | **PASS** — resolved from IR blocks, `len(bboxes) == len(block_ids)` by construction |
| No answer without evidence | **PASS** — an uncited claim is repaired or the answer is withheld |
| Duplicate citations | **PASS** — deduplicated in first-appearance order |
| Prompt injection | **PASS** mechanically — evidence and question are delimited and declared untrusted; an answer that *is* the injected payload cites nothing and is withheld |
| Provider failures distinct | **PASS** — 401/429/5xx/timeout/truncation raise; they never become an abstention |
| Scope | **PASS** — all four preserved end to end; a scoped abstention reports whether the whole paper would have answered |
| DocumentIR / analysis immutability | **PASS** — byte-identical before and after |
| Application database | **PASS** — no migration, no table, `test_db.py` unmodified |
| Privacy (P1-04) | **PASS** — logs carry `document_id`, scope, status, counts and latency; no question text, no paper text |

## Gemini criteria, as evaluated

**P0: 18 of 18.** Including P0-03 (16/16 abstention, 0 false answers) and P0-09 (3/3 counterfactual).
**P1: 6 of 6.**
**P2: 1 of 3** — scope-expansion diagnostics implemented; the local QA cache and the lexical
overlap score are not, and are recorded as absent rather than approximated.

## Known limitations

1. **The validator withholds ~5% of answers** and cannot be told apart, from the outside, from
   over-abstention. Two observed cases re-ran clean, which bounds the rate without explaining
   the individual decision.
2. **A claim can be grounded in a section title** rather than in the paragraph's own text — see
   the audit. Defensible (the model was shown the title) and worth knowing.
3. **Anchor attestation only checks numbers and identifiers.** Prose is not verified, because
   verifying it needs understanding rather than string matching. A false claim containing no
   number is not caught.
4. **One over-abstention observed** ("How is a rollout defined?") where the evidence was present.
5. **Whole-paper scope only** in the benchmark; the scoped paths are covered by unit tests, not
   by the real-provider run.
6. **The DP arm uses 6/4/6 questions** rather than ResNet's 10/6/10. The frozen criteria require
   ResNet; the second paper is supplementary.

## Recommended next task

**DS-QA-003 — the Paper QA sidebar.** The contract this task had to prove is proven: an answer
carries `[E1]` markers, the application resolves them to a paragraph id, a page, a section and
bounding boxes, and an abstention is a first-class outcome the UI can render as an answer rather
than as an error. The click-through from a citation chip to a PDF page and a highlight is now a
frontend exercise against settled metadata.
