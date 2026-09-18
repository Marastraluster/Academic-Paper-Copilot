# DS-QA-011 — Acceptance Criteria authoring task (Gemini)

You are the independent Acceptance Criteria author for the Academic PDF Copilot
repository at `D:\marti\SciPrograms`. DeepSeek owns all production code. **You do
not write production code.** Your only deliverable is one document.

## Your deliverable

Write the file:

    D:\marti\SciPrograms\docs\acceptance\DS-QA-011.md

It must contain P0 MUST / P1 SHOULD / P2 OPTIONAL acceptance criteria, each
numbered, each independently verifiable by a command or a browser observation,
each stating what evidence would prove it. Follow the structure of the existing
`docs/acceptance/DS-QA-010.md` and `docs/acceptance/DS-QA-005.md` in this
repository — read them first.

## Time budget discipline — read this before you start

You have a hard 25-minute wall clock. **Do not run the test suites. Do not run
`npm run build`. Do not run `pytest`. Do not run `vitest`.** A previous round was
lost entirely because the agent spent its budget launching suites and waiting for
them, and returned no document. Everything you need to decide the criteria is
already in this prompt and in the repository's source files, which are cheap to
read. Read files, then write the document. Spending 20 minutes reading source and
5 minutes writing is the right allocation.

## The task you are writing criteria for

**Task ID:** DS-QA-011
**Task name:** Cross-page Selection + Persistent Annotation
**Primary goal:** Allow a user to select source text spanning more than one PDF
page and create one persistent highlight/note whose source targets remain
correctly attached, rendered, persisted, reloaded, and navigable across those
pages.

The flow to be verified:

    select across a page boundary
    → one Annotation is created
    → ordered per-page AnnotationTargets persist
    → highlights render on both pages
    → close/reload/restart restores both
    → clicking the annotation navigates to the start of the span

Hard constraints on the feature: source-PDF grounded, paragraph-anchor based,
geometry preserving, local-only, zero AI calls, source PDF immutable. The
existing annotation persistence and the existing `StableSourceAnchor` must NOT be
redesigned. Character-offset identity must NOT be introduced.

## Verified current state (measure these again yourself only if cheap)

- DS-QA-010 Persistent Notes is closed at **18/18 P0 PASS**, commit `2529674`.
- Backend **950 passed**, frontend **182 passed**, typecheck PASS, build exit 0,
  initial bundle **330.13 kB** against a **350 kB ceiling** — about 20 kB of
  headroom. No selection or geometry library may be added.
- Provider calls on the notes path: **0**. Source PDF byte-identical.
- The annotation model already supports **one Annotation → N ordered
  AnnotationTargets**. A target carries: stable source anchor id, anchor version,
  page number, the paragraph envelope bbox, the per-target source rects, the exact
  quote, and prefix/suffix context.
- `ParagraphIR.source_anchor_id` is the persistent identity; `ParagraphIR.id` is
  runtime ordinal identity.
- Historical Diffusion Policy replay: 160 → 155 paragraphs, 150 EXACT,
  10 REATTACHED, 0 AMBIGUOUS, 0 ORPHANED, 0 WRONG.
- Anchor resolution states: `EXACT | REATTACHED | AMBIGUOUS | ORPHANED`, plus a
  frontend-only `UNRESOLVED` used when the document has not been extracted yet.
- `backend/app/annotations/store.py` already creates an annotation and all of its
  targets in one transaction (`BEGIN IMMEDIATE`).
- `frontend/src/notes/targets.ts::buildAnnotationTargets` already reads
  `mapping.rects[paragraph.page_number]` **per page** and already sorts targets by
  DocumentIR order across the whole document. It is not page-limited.
- `frontend/src/qa/selection.ts::matchParagraphs` already accepts a
  `Map<pageNumber, PdfRect[]>` and already returns `rects: Record<page, Bbox[]>`.
- `frontend/src/qa/selection.ts::readDomSelection` already returns
  `byPage: {page, element, rects}[]` and a `crossPage` boolean.
- **The single guard that refuses cross-page selection is**
  `frontend/src/qa/session.ts` lines ~385-394, which returns
  `{status: "cross_page"}`. `captureSelection` below it uses only
  `dom.byPage[0]`, i.e. one page. This is the code path to be changed.
- Rotated pages: `toPdfRects` returns `[]` for any non-zero rotation, and
  `PdfWorkspace` suppresses the persistent overlay entirely when the page's
  rotation is not 0. This is accepted, measured behaviour and is NOT reopened.
- Translation mode: source geometry must never render on the translated pane
  (accepted invariant). Bilingual: source boxes on the original pane only.

## MEASURED native browser behaviour — the reason this task exists

These numbers were produced today by `frontend/scripts/probe-crosspage.mjs`
against the built bundle, the real backend and real Edge, with a 3-page A4
fixture whose prose runs to the bottom of every page
(`frontend/scripts/make-crosspage-pdf.mjs`, 40 lines in 10 four-line paragraphs
per page, every line prefixed `L<page>-<nn>` for identification).
Window 1440x900, reader viewport 770 px tall, fit-width scale 1.7647.

**1. A native drag DOES span two PDF.js text layers.**
Dragging from line `L1-37` (first line of the last paragraph on page 1) to line
`L2-04` (last line of the first paragraph on page 2) produced:

    selection.toString().length = 655
    rangeCount = 1, collapsed = false
    getClientRects().length = 15
    rects by page: { page 1: 8, page 2: 7 }

The text layer is **not** re-rendered or interrupted by the drag.

**2. Two pages are mounted at a page boundary; a third never is.**
`PdfViewer` gives a page a canvas and a text layer only while it intersects a
viewport buffered by `RENDER_BUFFER_MARGIN_PX = 300`. Scrolled to the page 1/2
boundary and measured:

    page 1  hasCanvas=true  hasTextLayer=true   spanCount=40
    page 2  hasCanvas=true  hasTextLayer=true   spanCount=40
    page 3  hasCanvas=false hasTextLayer=false  spanCount=0

Repeatable while zooming out: at scales 1.5, 1.25 and 1.0 the rendered set was
`[1, 2]` every time. **The simultaneously-mounted span at fit-width in this
window is 2 adjacent pages.**

**3. Naive rect ownership is WRONG, and this is the central hazard.**
The existing `readDomSelection` assigns each client rect to a page by
hit-testing its centre with `document.elementFromPoint`, falling back to the
range's start container. On the cross-page selection above it produced this
rect, attributed to **page 1**:

    { page: 1, left: 365, top: 476, width: 1050, height: 1486 }

That rectangle is **page 2's entire text layer** — page 2's box is exactly
`left=365, top=476, 1050x1486`. `elementFromPoint` returned `null` because the
rect's centre is below the 900 px window, so the fallback fired and labelled a
page-2 rectangle as page-1 geometry. A rectangle like that intersects every
paragraph on page 1 and would persist a highlight over the whole page.

**4. Clamping the Range to each individual text node is EXACT.**
Measuring both strategies on the same live selection:

    clamp to page CONTAINER → page 1: 7 rects, page 2: 8 rects,
                              and page 2 still contains the 1050x1486 artifact
    clamp to TEXT NODE       → page 1: 4 rects, page 2: 4 rects, NO artifact

    page 1 rects (all 19 px tall, inside page 1's box which spans top -1026..460):
      492,205 522x19    492,229 569x19    492,254 546x19    492,279 517x19
    page 2 rects (all 19 px tall, inside page 2's box which spans top 476..1962):
      492,563 562x19    492,588 522x19    492,612 569x19    492,637 538x19

The text split correctly at the boundary: page 1 got `"L1-37 the representation
is tr…"` and page 2 got `"L2-01 report the mean success …"`. A text node belongs
to exactly one page container, so ownership is known **directly**, with no
hit-testing and no fallback.

**5. Native drag auto-scroll is real and fast.**
With the button held down and the pointer moved to the bottom edge of the
window, `scrollTop` went **1135 → 3752 in about 900 ms** (≈ 2.9 px/ms). A drag
that crosses a page boundary routinely keeps scrolling well past it.

**6. A long auto-scroll unmounts the page the selection started on.**
After the auto-scroll above, page 1's text layer was gone
(`hasTextLayer=false`) while the button was still down. The selection's text had
grown to **6388 characters with 119 rects**. Its boundary nodes still reported
`isConnected=true`, but the page-1 geometry a mapping needs is no longer
measurable, because `getClientRects()` on a removed text layer returns nothing.

## Decisions you must make explicitly

Answer every one of these in the document, with the chosen answer stated as a
criterion or as an explicit non-goal. Do not leave any of them implicit.

- **A.** Is P0 limited to exactly **two adjacent pages**, or does it claim
  arbitrary N consecutive mounted pages?
- **B.** Must browser-native drag auto-scroll across pages be supported in P0?
- **C.** What happens when page N+1 is **not mounted** at the moment the drag
  reaches the boundary?
- **D.** Should P0 support only pages **currently mounted** by virtualisation?
- **E.** Can a valid cross-page annotation be created when one touched page maps
  successfully and another does not?
- **F.** Should partial mapping **refuse creation**, **allow with a warning**, or
  something else?
- **G.** What defines AnnotationTarget ordering — page + canonical paragraph
  order, DOM range order, or another rule?
- **H.** What should clicking a cross-page annotation do — jump to the first
  target, the most recently active target, or something else?
- **I.** Should the Notes panel show a page range such as `p.3–4`?
- **J.** Should Selection QA inherit cross-page support in P0, P1, or stay
  deferred?
- **K.** How should **Translation mode** behave for a cross-page annotation?
- **L.** How should **Bilingual mode** behave?
- **M.** If one touched page is rotated and its overlay transform is
  intentionally suppressed, may the annotation still be created?
- **N.** If a cross-page selection spans non-prose material on one page, is the
  whole gesture rejected, or are only the prose targets retained?

Also decide and state:

- **O.** What the supported **page span boundary** is, in the plainest words a
  reader of the criteria could check, given measurements 2, 5 and 6 above.
- **P.** Whether **page pinning** (holding a touched page's text layer mounted
  until the selection resolves) is required for P0, optional, or rejected.
- **Q.** Whether an annotation-level summary badge is required when targets
  resolve to **different** states (one EXACT, one REATTACHED, etc.).
- **R.** What the honest **user-visible behaviour** is when a cross-page
  selection cannot be mapped.

## Acceptance criteria must cover at least these 48 areas

1. two-page native selection, 2. forward selection, 3. backward selection,
4. multiple paragraphs, 5. multiple text spans, 6. page boundary, 7. selection
text ordering, 8. per-page rect extraction, 9. per-page coordinate conversion,
10. per-page ParagraphIR mapping, 11. canonical source ordering,
12. AnnotationTarget ordering, 13. one annotation / multiple pages, 14. exact
quotes, 15. per-target quotes, 16. source rects, 17. `source_anchor_id`,
18. duplicate text across pages, 19. document isolation, 20. zoom, 21. fit-width,
22. continuous scroll, 23. page virtualisation, 24. page unmount, 25. page
remount, 26. document close/reopen, 27. application restart, 28. edit/delete,
29. persistent overlay restoration, 30. click annotation navigation,
31. Translation mode, 32. Bilingual mode, 33. original-only geometry,
34. rotated page involvement, 35. partially unmappable page, 36. low-confidence
mapping, 37. formula-only region, 38. heading/caption boundaries, 39. zero
provider calls, 40. source immutability, 41. browser accessibility, 42. normal
copy behaviour, 43. backend regression, 44. frontend regression, 45. bundle
ceiling, 46. no persistence redesign, 47. no stable-anchor redesign,
48. no retrieval/QA redesign.

Where an area is genuinely out of scope, say so **as an explicit non-goal**
rather than omitting it.

## Rules for the criteria you write

- Every P0 criterion must be **observable**. "The mapping is correct" is not a
  criterion; "the page-2 target's rects all lie inside page 2's box and none of
  them spans both pages" is.
- State the **evidence** for each P0: which command, which browser observation,
  or which test file proves it.
- Do not invent performance thresholds unless you justify the number. If you set
  one, say why that number and not another.
- Do not require a custom text-selection engine. Native browser Selection is the
  required basis unless you can show from the measurements above that it is
  unusable.
- Do not require a character-offset identity. Paragraph anchors are the identity.
- Do not widen the task into Notes Search, Export, cloud sync, multi-turn chat,
  retrieval changes, QA prompt changes, or PDF annotation writeback. Those are
  non-goals.

Write the document now. Return, as your final message, only the list of P0
criteria ids and one line each.
