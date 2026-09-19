# Evidence — DS-QA-013 Non-prose Annotation

- **Date:** 2026-09-19
- **Commits:** `docs(acceptance)` (criteria), `feat(notes)` (implementation), this file
- **Acceptance criteria:** `docs/acceptance/DS-QA-013.md` — Gemini authored 48 P0;
  **three `AC_CHANGE_REQUEST`s** were raised and resolved before the list was frozen.
- **Verdict:** **CAPTION + FORMULA ANNOTATIONS READY.**

## The gap, reproduced on the current pipeline

`.agent/results/nonprose/audit.txt`, five real papers, blocks outside any paragraph
by geometric coverage:

| paper | figure_caption | table_caption | formula_caption | isolate_formula |
|---|---|---|---|---|
| resnet | 8 | 5 | 2 | 2 |
| mamba | 13 | 8 | 4 | 7 |
| diffusion-policy | 24 | 2 | 9 | 11 |
| ppo | 7 | 4 | 12 | 12 |
| unet | 2 | 0 | 0 | 0 |
| **total** | **54** | **19** | **27** | **32** |

**The task's stated "14 captions / 4 formulas" matches no current paper.** It was a
DS-DOC-003-era figure; these are the real values and they supersede it.

## Were they selectable? — the gate the task's Phase 11 set

`.agent/results/nonprose/browser/probe.json`, real Edge, the application's own
scale, every candidate class:

```
class               blocks  selectable  exact text
figure_caption           9         9         9
table_caption            5         5         5
formula_caption          2         2         2
isolate_formula          2         2         2
figure                   7         7         7
table                   15        15        15
title                   23        23        23
```

The task listed four possible formula representations and expected one to
qualify. Measured: `y = F(x, {Wi}) + x.` arrives as **18 text-layer spans** with
the canonical characters intact — formulas are text, and P0 could include them.

`figure` and `table` are selectable but their text is run-together diagram
labels (`"identityweight layerweight layerrelu…"`), and `abandon` is the arXiv
stamp and page numbers. Both refused, measured rather than assumed.

## Three claims in the criteria that measurement corrected

1. **The quantum's justification was false.** The criteria cited a minimum
   same-page separation of 18.4 pt; measured it is **0.12 pt** on Mamba. The grid
   is safe because the canonical text is in the payload, not because boxes are far
   apart — and repeated extraction moved a block by **0.0 pt**, so the grid is
   insurance rather than a requirement.
2. **The jitter tolerance was false.** `1.0 → 0.0` but `1.0 + 0.8 → 2.0`. The
   criterion now says *within a grid cell* rather than naming a tolerance the
   arithmetic does not have.
3. **Refusing the whole gesture would have regressed prose.** `figure` and `table`
   blocks sit beside body text on nearly every page; refusing on intersection
   would have refused ordinary paragraph selections.

## A defect found by writing a test

**Every `error_response` call in `api/annotations.py` passed `(code, message,
status)` to a `(status, code, message)` signature.** All sixteen error paths
raised inside `JSONResponse` and answered **500 instead of the documented
status** — a missing document, an unknown kind, a refused selection. The happy
paths were the only ones ever exercised, which is why it survived two prior
tasks. Fixed, and pinned by `TestTheErrorPathAnswers`.

## Also found by running

- **The button asked the wrong question.** The create action read the *QA*
  mapping's paragraph count, so a caption selection disabled an action that could
  create a perfectly good note. It now asks the target builder, so the button and
  the action cannot disagree.
- **A geometric sort scrambled the formula.** Reading a formula's text-layer spans
  in `(top, left)` order gives `"=F(,{W}) +.yxxi"`; DOM order gives
  `"y = F(x, {Wi}) + x."`. My own harness bug, and the reason the earlier probe
  measured coverage 1.0 and the first E2E run measured a jumble.
- **A drag aimed at empty space.** Scrolling to the page top left the formula at
  y=1187 in a 900 px window; the text layer measured correctly — because
  `getBoundingClientRect()` works off-screen — and the mouse hit nothing.

## Measured

```
backend                    1011 passed, 1 flake
frontend                   257 passed  (243 + 14)
typecheck                  PASS
build                      exit 0
bundle                     337.51 kB of 350 kB
non-prose browser E2E      22/22   (a real formula, a real caption)
QA browser                 48/48
notes browser              17/17
cross-page browser         23/23
outline browser            26/26
search/export browser      30/30
historical anchor replay   WRONG 0, 150 exact, 10 reattached — unchanged
provider calls             0
source PDF                 byte-identical
```

The E2E drags across the real formula `y = F(x, {Wi}) + x.`, creates one
annotation whose target is `source_class: isolate_formula`, draws 11 highlight
boxes on page 3, searches it, reloads, restores the overlay, and exports JSON
carrying `isolate_formula` and Markdown tagged 公式.

## Known limitations

1. **Two full backend runs each had exactly one failure, and it was a different
   test each time** (`test_pdfkernel` then `test_document_ir`). Both pass in
   isolation and neither is on a path this task touched. Recorded as
   unreproduced, not fixed.
2. **`IR_PIPELINE_VERSION` moved 4 → 5**, so every cached extraction is
   re-computed once on next open. That is the repository's own mechanism for an
   extraction-output change and it is what makes block anchors reach the client;
   the alternative was a second anchor implementation in the browser.
3. **Headings, tables and figures remain unannotatable**, each for a measured
   reason recorded in the criteria.

## Next task

**DS-QA-014 — Paper Overview / Reading Entry.** Every measured Notes gap is now
closed: prose, cross-page, search, export and non-prose source all work and are
verified. The remaining question is product shape rather than a measured defect —
what a reader should see when they open a paper they have not read.
