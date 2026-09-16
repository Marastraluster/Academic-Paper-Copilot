# DS-FE-002 — Real PDF.js Reader

- **Phase:** 4 (PDF Reader)
- **Status:** AC authoring — implementation NOT started
- **Owner:** DeepSeek (implementation) · Gemini (acceptance criteria)
- **Created:** 2026-09-16
- **Baseline commit:** `3ca35e9`

## Goal

Replace the placeholder viewer panels that DS-FE-001 shipped — deliberately — with a real local
PDF reader. This is the surface the user actually looks at.

## Product Context

The PDF is the product's primary visual surface: reading controls, the AI sidebar and every
decorative element are subordinate to it. This task makes that surface real, and establishes the
viewer architecture the bilingual mode will reuse.

## Technical Context

| Piece | State |
|---|---|
| Shell | DS-FE-001 complete: four-region workspace, reader-mode switch, collapsible sidebar, 38/38 AC |
| Viewer | `src/reader/ViewerPanel.tsx` renders a **mock page**; no PDF is parsed |
| Stack | React 18 + TS (strict) + Vite 6 + Tailwind + Zustand |
| Tests | vitest + Testing Library, 27 passing; browser capture harness in `scripts/capture.mjs` |
| PDF.js | **Not installed.** DS-FE-001's AC-22 explicitly forbade adding `pdfjs-dist` — this task lifts that ban |

## Files Allowed To Modify

```
frontend/package.json, frontend/package-lock.json   (add pdfjs-dist)
frontend/src/pdf/**            (new — viewer components)
frontend/src/reader/**         (replace the placeholder panel)
frontend/src/stores/**         (reader/document state)
frontend/src/app/**            (toolbar integration)
frontend/src/tests/**          (new + updated tests)
frontend/scripts/capture.mjs   (extend runtime verification)
.agent/tasks/DS-FE-002.md
.agent/evidence/DS-FE-002.md
```

## Files Forbidden To Modify

```
backend/**             (no backend change is required for rendering)
docs/** other than this task's acceptance file
_reference/**
```

## Requirements

R1. Open a real local PDF and render real pages. The mock page component is removed, not hidden.
R2. Rendering is **local-first**: opening a PDF for viewing must not upload it anywhere.
R3. Continuous vertical scrolling; the toolbar shows current page / total pages, and the current
   page tracks viewport position.
R4. Zoom in, zoom out, and fit-width.
R5. A text layer where the PDF has native text, so text remains selectable.
R6. Loading, empty, and error states — including invalid/corrupt and password-protected files.
R7. Switching documents cleans up the previous document: instance, object URLs, pending render
   tasks, listeners, and stale page state. No pages from the previous document may appear.
R8. The viewer is **reusable as separate instances** with independent document/page/zoom — the
   bilingual mode will run two side by side. No single-document global singleton.
R9. Non-A4 and landscape pages render correctly; academic two-column pages are the target case.
R10. The toolbar stays compact; the PDF keeps the space.
R11. Works at 1024 / 1440 / 1920 px, with the sidebar both expanded and collapsed.
R12. Frontend `typecheck`, `test` and `build` all pass.

## Known Constraints

- Do not build a custom PDF renderer, and do not rasterize pages on the backend for native-text
  PDFs.
- Do not introduce a second document-import mechanism; reuse whatever the shell already has.
- Do not add a virtualisation library pre-emptively; PDF.js rendering is already incremental.
- Do not expand into translation, Paper QA, or the Context Engine.

## Design questions the acceptance criteria should settle

1. **How does a PDF get in?** DS-FE-001 shipped no file picker (the top bar's actions are inert).
   Is a picker + drag-and-drop in scope here, or does the shell already provide a route?
2. **Text-layer scope.** PDF.js can render a selectable text layer, but it interacts with zoom and
   with the canvas. Is a selectable layer P0 for this task, or is a correctly scaled canvas the
   P0 with selection as P1?
3. **Rendering strategy.** Render every page up front, render lazily as pages approach the
   viewport, or render a window and discard? The choice determines behaviour on a 200-page paper
   — state the rule and what a test can assert about it.
4. **Password-protected PDFs.** Prompt for a password, or report a clear error and stop? State
   which, and the exact user-visible state.
5. **Zoom persistence across document switches.** Reset to fit-width, or carry the zoom over?
6. **What "current page" means** when two pages are equally visible — topmost, most-visible, or
   the last one whose top passed the viewport top?

## Expected Tests

Unit tests with PDF.js mocked (a real PDF.js run belongs in the runtime verification, not the
unit suite):

- Empty state renders when no document is loaded.
- Loading state appears while a document is opening.
- A successful load renders the page count and at least one page surface.
- Page navigation updates the current page.
- Zoom controls change the scale and are reflected in the UI.
- A corrupt document produces the error state, not a crash.
- Switching documents resets page state and does not show the previous document.
- Unmounting releases the document (no leaked object URL / render task).
- The viewer can be instantiated twice independently (the bilingual requirement).

Plus: runtime verification against a real multi-page academic PDF, with screenshots.

## Dependencies

DS-FE-001 (shell). DS-PDF-001 (translation) is independent of rendering but motivates R8.

## Known Risks

- **Memory.** PDF.js documents and canvases are large; repeated open/close is the classic leak.
- **The text layer and zoom.** A mis-scaled text layer makes selection land in the wrong place —
  worse than no selection, because it looks like it works.
- **Worker setup under Vite.** `pdfjs-dist` needs its worker resolved correctly in both dev and
  production builds; getting it wrong works in dev and fails in the built bundle.
- **Large documents.** Rendering 200 pages eagerly will stall the browser.
- **Scope creep into translation**, which belongs to DS-FE-003.
