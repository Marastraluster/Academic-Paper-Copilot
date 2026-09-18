# Evidence — DS-QA-005 Selection → ParagraphIR Mapping + Selection QA

- **Date:** 2026-09-18
- **Agent:** DeepSeek (Claude Code CLI)
- **Acceptance criteria:** `docs/acceptance/DS-QA-005.md` (Gemini, frozen before implementation,
  with five `AC_CHANGE_REQUEST`s — four before implementation, one after the final review)
- **Baseline:** `79ed9ec` (the DS-QA-004 disposition)
- **Verdict:** **A reader drags across source text and asks about exactly that text.** Mapping is
  geometric, page-aware, reading-order-correct, zoom-independent and two-column-safe; the
  canonical ids come from the `DocumentIR` and nothing is derived from the DOM. Rotation is
  refused rather than guessed, after a measurement.

## What was built

```
frontend/src/api/ir.ts              the canonical IR, fetched once per document
frontend/src/qa/selection.ts        geometry → paragraph identity, pure and tested without a DOM
frontend/src/qa/useSelectionCapture.ts   the browser listeners, and when a selection clears
frontend/src/qa/session.ts          capture, refresh, clear; the Selection request scope
frontend/src/stores/workspace.ts    the IR and the selection, both bound to the document
frontend/src/assistant/ScopeSelector.tsx  enabling, preview, and one sentence per refusal
frontend/src/tests/selection-mapping.test.ts  26 tests, no browser
frontend/scripts/e2e-selection.mjs  the real-drag verification
```

**The browser is not the source of truth.** The DOM supplies geometry and the text the reader
dragged across; every id comes from the `DocumentIR`. Span classes, node indices and character
offsets are never identity — the first two change with zoom and rerender, and the third cannot be
computed at all, because the text layer's segmentation is not the IR's.

**One bounding box would have been wrong, and this was measured before it was believed.** The
ResNet body pages are two-column: the left column runs x=49→287 of 612 pt. A selection's overall
`getBoundingClientRect()` spans the gutter and would intersect every right-column paragraph at
the same height, so only the per-line fragments from `getClientRects()` are used.

**A drag is a real drag, not a synthetic `Range`.** The end-to-end checks move `page.mouse` over
the text layer, because a programmatic range proves the geometry while proving nothing about
whether a *reader* can produce a selection the mapper understands. That distinction earned its
place twice, in both directions (below).

## Verification

```
backend       807 passed
frontend      149 passed   (112 before this task)
typecheck     PASS
build         exit 0
bundle        307.03 kB initial (ceiling 350 kB) — +7.6 kB, no new dependency
real browser  48/48 against the real backend and the real provider in Edge
```

### The mapping, measured

```
single span / single paragraph     PASS   a one-line drag maps to exactly that paragraph
multiple paragraphs                PASS   a drag that really crosses maps both, reading order
backward drag                      PASS   same paragraph, not reversed
two-column                         PASS   the right column's paragraph is excluded
zoom independence                  PASS   the same paragraph, exactly, at 2×
duplicate text                     PASS   resolved by page and geometry, never by text
cross-page                         DEFERRED  per the frozen criteria; both pages must be mounted
rotated page                       REFUSED   maps to nothing, Selection stays unavailable
low-confidence / non-prose         PASS   a heading, caption or figure maps to nothing and says so
```

### The real bug the tests found

**Clicking *Ask* destroyed the thing being asked about.** The first version cleared the mapping
whenever the browser selection collapsed. Clicking a button takes focus out of the page and
collapses the selection — so 150 ms after the click the scope resolved to nothing and the request
was never sent. The unit test caught it as a request that did not happen; the fix distinguishes
where the click landed: **in the paper it clears, in the sidebar it keeps.** The selection
survives moving focus to the feature, and clicking the document still clears it as intended.

### The measurement that stopped a wrong fix

The first browser run reported that a one-line drag mapped to **two** paragraphs, and it was
tempting to loosen the matching thresholds. Measuring instead of adjusting showed the matcher was
right: the drag ended at the *column edge*, past the last character of the line, where the browser
resolves the caret to the next line — so the selection genuinely covered the heading and the
following paragraph. The test was wrong, not the code, and the fix was to stop the drag inside the
line. The two-paragraph case it accidentally produced is now a deliberate test.

This is the third time in this project that the honest response to a surprising number was to
measure rather than to tune, and the second time the answer was "the code is right".

### Rotation: measured, then refused

AC-02 asked for the affine inverse for `rotation ∈ {90, 180, 270}`. It was implemented, and then
removed, because three real fixtures — a ResNet body page rotated by 90°, 180° and 270° — could
not confirm it: on the 90° one, a drag anchored on a span's own *text* resolved to no paragraph
at all. Investigating why showed the conventions are not reconcilable by inspection — PyMuPDF
reports a rotated page's `rect` as 792×612 while reporting its text blocks in unrotated
coordinates, and PDF.js's viewport transform already carries the rotation.

A wrong inverse maps a horizontal span onto a vertical coordinate and returns a **confidently
wrong paragraph**. The criterion's own fallback permits failing safe, so a rotated page now maps
to nothing, Selection stays unavailable, and the refusal is a test.

## Gemini's decisions, as implemented

**A** all intersecting paragraphs, deduplicated, in `DocumentIR` reading order, capped at 20.
**B** line-fragment overlap: per fragment, vertical overlap ≥ 50% and horizontal ≥ 4 pt; a
paragraph qualifies on `min(80 pt², 0.40 × selection area)`. **C** geometry proposes, text
validates. **D** whole paragraph ids — no offsets, because a DOM offset is not an offset into
`paragraph.text`. **E** cross-page deferred. **F** headings and captions rejected in isolation —
verified against the IR: **zero of 101 paragraphs is a heading**. **G** a validated subset is
usable, an all-failing selection is not. **H/I** Original and the original pane of Bilingual.
**J** Translation mode disables it and offers the switch.

## AC_CHANGE_REQUESTs

1. **AC-09 named `/api/chat` or `/api/qa` and a `query` field.** Neither route exists; the
   endpoint is `POST /api/documents/{id}/answer` with `question` and a `profile_id`. The
   substance — a two-key scope object, no whole-paper fallback — is unchanged and verified.
2. **AC-11 auto-selected the Selection scope.** A reader highlighting a sentence to copy it would
   have had their scope silently replaced, and the brief says twice to *enable* it. Enabled and
   previewed; choosing it stays a user action. There is a test asserting the scope does not move.
3. **AC-02's rotation formulas were unverified.** Measured, and refused — see above.
4. **AC-12 required the cached IR to be "garbage collected"**, which JavaScript cannot assert.
   Restated as the release being observable: after a switch the store's IR is `null` and the
   previous paper's ids cannot be sent.

5. **AC-12's abort-on-clear is narrowed** *(raised in the final review)*. A document switch and a mode change abort an in-flight
   question; clearing the selection does not, because clicking elsewhere does not retract a
   question already asked, and the turn's own document and scope binding is what prevents anything
   stale being shown. Raised as a change request rather than done quietly.

Also recorded rather than claimed as measured: the containment thresholds (0.35, 0.25, 80 pt²,
40%) are Gemini's specified defaults. No sweep produced them.

## Known limitations

1. **Rotation is unsupported** — refused rather than mapped, deliberately.
2. **Cross-page selection is deferred**, per the frozen criteria: the viewer windows pages, so
   both must be mounted for a range to span them.
3. **Selection is whole-paragraph, not character-exact.** Three words inside a long paragraph
   scope the whole paragraph. The UI shows the exact selected text, but that is a preview, not
   the scope.
4. **A heading or caption selected alone cannot be asked about** — neither is a `ParagraphIR`,
   and inventing an id for one would fabricate identity.
5. **The matching thresholds are uncalibrated**, as above.
6. **A drag that ends past a line's last character selects the next line**, which is browser
   behaviour the mapper reports faithfully and the reader may not intend. Observed while testing;
   it is how text selection works, not a defect introduced here.
7. **The rotated-page refusal means a reader with a rotated paper gets no Selection**, and the
   sidebar says the mapping is unavailable rather than why.

## Recommended next task

**DS-QA-006 — Retrieval Ranking Refinement.** The measured product need is unchanged from
DS-QA-004's close and is now visible in the sidebar: questions that *are* retrieved land at rank
6–8 rather than in the top five, and DS-QA-004's fusion is where that is decided. It is a ranking
problem, not a semantic one, and it needs no new dependency.

**Multi-turn conversation** is the wrong next step: the single-turn contract is what makes
abstention honest, and a follow-up like "what about the second experiment?" needs referent
resolution the system does not have.

Embeddings stay closed by their own frozen gate.
