# DS-QA-015-FIX-004 — Final evaluation task (Gemini)

You are the **independent acceptance author** for the Academic PDF Copilot
repository at `D:\marti\SciPrograms`. You wrote `docs/acceptance/DS-QA-015.md`
and its 55 frozen P0 criteria. DeepSeek owns all production code. **You do not
write production code.** Your deliverable here is one evaluation document.

## Your deliverable

Write:

    D:\marti\SciPrograms\.agent\results\ds015-fix4-gemini-eval.md

## Time budget — read before you start

Hard 25-minute wall clock. **Do not run `pytest`, `vitest`, `npm run build`, or
any browser harness.** Everything you need is already recorded on disk; a
previous round was lost to an agent that spent its budget launching suites. Read
the artifacts and judge.

## What you are evaluating

The final state of DS-QA-015:

- **Commit under evaluation:** the working tree at the time you read it (HEAD
  `a477eb1` plus the DS-QA-015-FIX-004 changes).
- **The frozen criteria:** `docs/acceptance/DS-QA-015.md` — 55 P0, 6 P1, 4 P2,
  with three accepted AC_CHANGE_REQUESTs in §0 and a fourth **proposed** in §0.1.
- **The 55-item matrix:** `.agent/results/ds015-matrix.md` — every criterion, its
  status, and the evidence each PASS rests on. Read it in full: it is what you
  are auditing.
- **Final regressions:** backend **1118 passed**; frontend **299 passed**;
  typecheck clean; production build exit 0 with the initial chunk `index-*.js` at
  **304.54 kB**.
- **Browser evidence:** `.agent/results/e2e-overview15/results.json` (38/38, a
  real provider generation) plus the other suites' logs in `.agent/results/`.
- **Semantic audit:** `.agent/results/audit-overview-summary.log` (four papers,
  88 claims) and the per-paper `audit-*.txt` records.
- **The bundle decomposition and the proposed amendment:**
  `docs/acceptance/DS-QA-015.md` §0.1.

## What to do

1. **Audit the matrix for overclaiming.** This is the main job. For a sample of
   at least twelve rows — including every row whose evidence names a test rather
   than a file, and every row marked PASS where the implemented mechanism differs
   from the mechanism your frozen wording named — open the named test or artifact
   and check that it says what the row claims. Say which rows you checked and what
   you found. If a row overstates its evidence, name it and say what the
   evidence actually supports.
2. **Rule on AC_CHANGE_REQUEST 4** in §0.1: does the recorded evidence justify
   raising AC-P0-52's ceiling from 300.0 kB to 310.0 kB, or should the criterion
   stand and the row remain FAIL? Give your reasoning and a decision. You are the
   author of that criterion; the proposal is DeepSeek's.
3. **State your own verdict on the task**, in your own words, and say plainly
   whether DS-QA-015 closes at your criteria. Do not defer to the matrix's
   self-assessment — if you think it is wrong, say so.
4. **Record anything you judge to be a P0 defect that the matrix does not
   mention.** Runtime observations are not yours to override, but a criterion
   that the matrix has quietly reinterpreted is exactly what you are here to
   find.

## What not to do

- Do not run suites, builds or harnesses.
- Do not edit any file other than your deliverable.
- Do not re-derive the criteria or write new ones. This is an evaluation of a
  frozen set, not another authoring round.

## Format for your deliverable

```
# DS-QA-015-FIX-004 — final evaluation (Gemini)

## Rows I checked
<row by row: AC id, what you opened, whether the claim holds>

## Row-level disagreements
<any row where you read the evidence differently, or "none">

## AC_CHANGE_REQUEST 4
<decision, reasoning>

## Verdict on DS-QA-015
<your words; whether it closes at your criteria; anything you would still refuse>

## P0 concerns the matrix does not record
<or "none">
```
