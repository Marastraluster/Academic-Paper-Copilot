# Evidence — DS-QA-011 Cross-page Selection + Persistent Annotation

- **Date:** 2026-09-19
- **Commits:** `d452e68` (criteria), `8972aa2` (implementation)
- **Acceptance criteria:** `docs/acceptance/DS-QA-011.md` — Gemini authored 26 P0,
  five P1, three P2 before any production code; six `AC_CHANGE_REQUEST`s were
  raised and resolved before the list was frozen.
- **Verdict:** **ADJACENT-MOUNTED-PAGE ANNOTATIONS READY.** The bound is the
  viewer's render window, not the mapper.

## The guard was not where the brief said it was

The task's Phase 1 warned not to assume the limitation's location. It was not in
`SelectionMapping`. `readDomSelection` already returned per-page fragments,
`matchParagraphs` already took a map of pages, `buildAnnotationTargets` already
read `rects[page]` per paragraph, and `AnnotationStore.create` already stored N
ordered targets. The single refusal was three lines in `captureSelection`.

## The measurement that decided the design

`.agent/results/crosspage/probe.json`, real Edge, built bundle, real backend,
3-page A4 fixture, window 1440×900, scale 1.7647:

```
native drag L1-37 → L2-04:         655 chars, 15 rects, {page 1: 8, page 2: 7}
pages mounted at the boundary:     1 and 2 (canvas + 40-span text layer each)
                                   3 never, at scales 1.5, 1.25 and 1.0
auto-scroll, pointer at the edge:  scrollTop 1135 → 3752 in ~900 ms
after that scroll:                 page 1's text layer gone; selection 6388 chars
```

**Rect ownership, on the same live selection:**

| strategy | page 1 | page 2 | artifact |
|---|---|---|---|
| hit-test each rect centre | 7 rects | 8 rects | **1050×1486, attributed to page 1** |
| clamp range to each text node | 4 rects | 4 rects | none |

The artifact was page 2's entire text layer. `elementFromPoint` returns null for
a centre below the fold, and the fallback attributed it to the range's start
page — a rectangle intersecting every paragraph on page 1.

## Three defects found by running

1. **The naive ownership strategy**, above. Fixed by clamping to each text node.
2. **A silent truncation path.** `Range.toString()` survives a page's removal
   while its geometry does not, so the mapper would have saved a shorter span
   than the reader could still see highlighted. Now refused as `unmeasurable`.
3. **My own harness twice**: the first drag after a scroll landed on a text layer
   being replaced, and drags were dispatched as a single jump that the browser
   does not latch into a selection. Both recorded as harness bugs, not product
   ones — the second cost the most time and was found by bisecting the gesture
   with a direction sweep rather than by reading the mapper.

## Measured

```
synthetic two-page fixture       23/23
real paper (ResNet), pages 2-3   23/23   5 targets 2,2,3,3,3 after a BACKWARD drag
                                          tallest rectangle 11.1 pt
                                          26 boxes page 2, 75 boxes page 3
backend                          959 passed  (950 + 9)
frontend                         201 passed  (182 + 19)
typecheck                        PASS
build                            exit 0
bundle                           331.84 kB of 350 kB
QA browser (selection/citation)  48/48
notes browser                    17/17
outline browser                  26/26
historical anchor replay         WRONG 0; multi-target annotation EXACT + REATTACHED
provider calls                   0
source PDF                       byte-identical, both papers
```

`e2e-selection.mjs` was run standalone and produced nothing — it is a module
imported by `e2e-qa.mjs`, and its checks are inside that suite's 48.

## What is not supported, and why

- **Three or more pages.** Measured: two adjacent pages are mounted at a
  boundary and never three. The task's own Phase 26 prefers a correct bounded
  implementation to a fake unlimited one; the bound is stated in the criteria
  and in the refusal message.
- **Page pinning.** Rejected for P0 by Gemini (Decision P) and not needed for
  the supported span. It would be needed to hold a page across a long
  auto-scroll, which is the rejected ten-page-drag case.
- **Rotated pages.** Refused whole, consistent with DS-QA-005's measurement that
  the transform is not reconcilable by inspection.

## Next task

The persistence and mapping layers are closed. The strongest remaining gap a
reader will hit is **Notes Search + Export**: notes now accumulate across pages
with no way to find or take them out.
