You are the independent Acceptance Criteria Agent for task DS-FE-002.

You are NOT implementing this task. You are NOT writing production code.

Define objective, testable acceptance criteria BEFORE implementation begins.

Task:
Replace DS-FE-001 placeholder PDF panels with a real PDF.js-based local academic PDF reader.

This is a desktop-oriented academic reading workspace. THE PDF IS THE PRIMARY VISUAL SURFACE.

Define P0/P1/P2 acceptance criteria.

Cover:
- local PDF open
- drag/drop if already supported by shell
- PDF.js rendering
- multi-page document
- page navigation
- continuous scroll
- zoom
- fit width
- loading state
- corrupt PDF
- password-protected PDF
- empty state
- large PDF behavior
- text selection
- cleanup when switching documents
- no memory leaks obvious from repeated open/close
- toolbar integration
- sidebar interaction
- narrow desktop layouts
- 1024 / 1440 / 1920 desktop widths
- keyboard behavior where appropriate
- accessibility
- no layout overflow
- no unnecessary rerender
- no upload to remote server merely to render the PDF
- preservation of future original/translation dual-view architecture

Do not implement code.
Do not expand into Paper QA or Context Engine.

=====================================================================
TASK_DESCRIPTION
=====================================================================

# DS-FE-002 — Real PDF.js Reader

## Goal
Replace the placeholder viewer panels that DS-FE-001 shipped — deliberately — with a real local
PDF reader. This is the surface the user actually looks at.

## Product Context
The PDF is the product's primary visual surface: reading controls, the AI sidebar and every
decorative element are subordinate to it. This task makes that surface real, and establishes the
viewer architecture the bilingual mode will reuse.

## Technical Context
- Shell: DS-FE-001 COMPLETE — four-region workspace, reader-mode switch (原文 | 双语 | 译文),
  collapsible sidebar (320-380px, collapses to 0), status bar, error boundary. 38/38 AC, 27 tests.
- Viewer: src/reader/ViewerPanel.tsx renders a MOCK PAGE (grey bars on a white rectangle). No PDF
  is parsed. That mock is what this task removes.
- Stack: React 18 + TypeScript (strict, noUncheckedIndexedAccess) + Vite 6 + Tailwind 3 +
  shadcn/ui conventions + Zustand.
- Tests: vitest + @testing-library/react. A Playwright-based capture harness already exists at
  frontend/scripts/capture.mjs, run against `npm run preview` on 127.0.0.1.
- PDF.js is NOT installed. DS-FE-001's AC-22 explicitly FORBADE pdfjs-dist; this task lifts that
  ban, so `pdfjs-dist` will be added to package.json.
- Backend: FastAPI on 127.0.0.1:8000 with /api/health and /api/profiles. No document endpoints
  exist yet, so this task cannot depend on the backend for rendering.
- Existing Zustand store (src/stores/workspace.ts) holds readerMode, sidebarOpen, scope, messages,
  progress, engine.

## Requirements
R1.  Open a real local PDF and render real pages. The mock page component is REMOVED, not hidden.
R2.  Rendering is LOCAL-FIRST: opening a PDF for viewing must not upload it anywhere.
R3.  Continuous vertical scrolling; the toolbar shows current page / total pages, and the current
     page tracks viewport position.
R4.  Zoom in, zoom out, and fit-width.
R5.  A text layer where the PDF has native text, so text remains selectable.
R6.  Loading, empty, and error states — including invalid/corrupt and password-protected files.
R7.  Switching documents cleans up the previous document: instance, object URLs, pending render
     tasks, listeners, and stale page state. No pages from the previous document may appear.
R8.  The viewer is REUSABLE AS SEPARATE INSTANCES with independent document/page/zoom — the
     bilingual mode will run two side by side. No single-document global singleton.
R9.  Non-A4 and landscape pages render correctly; academic two-column pages are the target case.
R10. The toolbar stays compact; the PDF keeps the space.
R11. Works at 1024 / 1440 / 1920 px, with the sidebar both expanded and collapsed.
R12. Frontend typecheck, test and build all pass.

## Known Constraints
- Do not build a custom PDF renderer, and do not rasterize pages on the backend for native-text
  PDFs.
- Do not introduce a second document-import mechanism.
- Do not add a virtualisation library pre-emptively.
- Do not expand into translation, Paper QA, or the Context Engine.

## Known Risks
- MEMORY: PDF.js documents and canvases are large; repeated open/close is the classic leak.
- THE TEXT LAYER AND ZOOM: a mis-scaled text layer makes selection land in the wrong place —
  worse than no selection, because it looks like it works.
- WORKER SETUP UNDER VITE: pdfjs-dist needs its worker resolved correctly in BOTH dev and
  production builds; getting it wrong works in dev and fails in the built bundle.
- LARGE DOCUMENTS: rendering 200 pages eagerly will stall the browser.
- SCOPE CREEP into translation, which belongs to DS-FE-003.

=====================================================================
DESIGN QUESTIONS THE CRITERIA MUST SETTLE
=====================================================================

Give an explicit, verifiable rule for each:

Q1. HOW DOES A PDF GET IN? DS-FE-001 shipped no file picker (the top bar's actions are inert).
    Is a picker + drag-and-drop in scope here, or does the shell already provide a route? State
    exactly which entry points are required.

Q2. TEXT-LAYER SCOPE. PDF.js can render a selectable text layer, but it interacts with zoom and
    with the canvas. Is a selectable layer P0 for this task, or is a correctly scaled canvas the
    P0 with selection as P1? If P0, state how correct alignment under zoom is verified.

Q3. RENDERING STRATEGY. Render every page up front, render lazily as pages approach the viewport,
    or render a window and discard? The choice determines behaviour on a 200-page paper — state
    the rule and what a test can assert about it.

Q4. PASSWORD-PROTECTED PDFs. Prompt for a password, or report a clear error and stop? State
    which, and the exact user-visible state.

Q5. ZOOM PERSISTENCE across document switches. Reset to fit-width, or carry the zoom over?

Q6. WHAT "CURRENT PAGE" MEANS when two pages are equally visible — topmost, most-visible, or the
    last one whose top passed the viewport top?

=====================================================================
PRODUCT_ARCHITECTURE
=====================================================================

  ┌──────────────────────────────────────────────────────────────┐
  │ TopBar: brand | doc name | 原文|双语|译文 | AI翻译 | search ⚙ │
  ├──────────────┬───────────────────────────────────────────────┤
  │ AI Sidebar   │  PDF Workspace                                │
  │ (320-380px,  │   (this task fills this region with a REAL    │
  │  collapsible)│    PDF.js reader)                             │
  ├──────────────┴───────────────────────────────────────────────┤
  │ StatusBar: progress | page | engine                          │
  └──────────────────────────────────────────────────────────────┘

Target component shape (names are illustrative — design as fits):

  PDFWorkspace
      ├── PDFToolbar        page nav, current/total, zoom, fit-width
      └── PDFViewer         canvas + text layer per page, continuous scroll
              └── PDFDocumentState   document, pageCount, currentPage, zoom, loading, error

FUTURE (DS-FE-003) — the architecture must allow this without a rewrite:
  ┌─────────────────┬─────────────────┐
  │ OriginalViewer  │ TranslatedViewer│
  │ (page, scroll,  │ (page, scroll,  │
  │  zoom, doc)     │  zoom, doc)     │
  └─────────────────┴─────────────────┘

Existing frontend conventions:
- TypeScript strict; no unbounded `any`.
- Semantic Tailwind tokens only (no hardcoded colours) — a dark theme is a later token swap.
- Focus-visible rings on every interactive control.
- The window never scrolls; designated inner regions do (asserted in DS-FE-001).
- Desktop density: text-xs / text-2xs for chrome; the PDF is the visual protagonist.
- No external CDNs or network calls on render.

=====================================================================
RELEVANT_EXISTING_BEHAVIOR
=====================================================================

- frontend has 27 passing tests across 5 files, all of which must still pass (except where a test
  asserts the mock placeholder, which this task legitimately replaces — if such a test changes,
  state what it should assert instead so the protection is preserved rather than dropped).
- backend has 465 passing tests and is NOT modified by this task.
- The reader-mode switch already exists and changes the number of viewer panels (1 vs 2). In
  DS-FE-001 that swapped placeholder panels; after this task it must swap REAL viewers.
- A Playwright capture harness (scripts/capture.mjs) already verifies: no window scrollbars at
  1024/1440/1920, bilingual pane alignment, sidebar collapse, FCP, CLS, hover states, keyboard
  traversal. It runs against `npm run preview`.
- The layout model and translation pipeline (backend) are complete but irrelevant to rendering.
- No document backend endpoints exist: rendering must not require one.

=====================================================================

Now produce the acceptance criteria document in Markdown. Use a table with columns
ID | Priority | Description & Verification Target. Be specific and objectively verifiable —
prefer concrete values (pixel sizes, page counts, state names, assertions) over adjectives.
Give an explicit answer to each of Q1-Q6.
