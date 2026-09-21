# DS-FE-002 — Acceptance Criteria (FROZEN)

> **Author:** project maintainer
> **Authored:** 2026-09-16, **before any implementation code was written**
> **Prompt:** the task brief
> **Raw model output:** the task brief
> **Baseline:** commit `3ca35e9`
>
> **FROZEN.** No criterion may be silently weakened or deleted (brief §10).

## Acceptance criteria review (before implementation)

**Verdict: accepted as-is. No `AC_CHANGE_REQUEST`.** 49 criteria, of which 29 are P0.

All six design questions were settled concretely — with test IDs, reset rules and tie-breakers
rather than adjectives, which is what makes them checkable.

### What the criteria get right

- **Q2 makes the text layer P0, and demands it be *verified aligned* with the canvas.** A
  mis-scaled text layer is worse than none: selection silently lands on the wrong characters
  while appearing to work. The criteria require the overlay's bounding rect to match the canvas
  at each zoom level rather than merely asserting the element exists.
- **Q3 avoids premature virtualisation** (my own concern in the task file) while still solving
  the 200-page problem: all page *containers* exist with reserved height, but canvases render
  only inside a buffered viewport window. That keeps scroll geometry stable without a
  virtualisation dependency.
- **Q5 resets zoom and page on document switch.** Carrying a zoom ratio across documents of
  different dimensions is exactly the kind of subtle state bug that takes an afternoon to find.
- **Q6 gives a deterministic tie-breaker** (most visible area; topmost wins ties), so the
  current-page assertion is reproducible rather than dependent on scroll timing.
- **Q4 defers the interactive password prompt to P2** rather than expanding scope, while still
  requiring a graceful state at P0.

### Implementation notes recorded at review time

1. **Existing test IDs must be preserved.** `reader-mode.test.tsx` and `scripts/capture.mjs`
   both key on `viewer-original` / `viewer-translated`, and the capture harness also uses a
   `viewer-scroll` container inside them. The real viewer keeps those hooks so DS-FE-001's
   protections keep verifying real behaviour instead of being deleted alongside the mock.
   Where a DS-FE-001 test asserted the *placeholder* specifically, it changes to assert the real
   viewer — the protection is preserved, not dropped.
2. **`pdfjs-dist` 6.3.289 is the version available.** Its worker must be resolved so that both
   `npm run dev` and `npm run build` work; a dev-only-correct worker setup is a known trap and
   the build gate exists to catch it.
3. **The backend is not involved.** No document endpoints exist, and R2 forbids uploading the
   PDF to render it — so every check here runs against local `File`/`Blob` input.

---
**Task ID:** DS-FE-002  
**Target Milestone:** Desktop Academic Reading Workspace — Phase 1 Core Viewer  
**Classification:** Independent Acceptance Criteria Specification (Pre-Implementation Baseline)  
**Scope Boundary:** Local-first PDF.js rendering, text layer, continuous scroll, zoom/fit-width, state machine, and dual-instance viewer architecture. Does **NOT** include translation pipelines (DS-FE-003), Paper QA, or Context Engine.

---

## 1. Resolution of Architectural Design Questions (Q1 – Q6)

| Design Question | Architectural Decision | Objective Verification Rule |
| :--- | :--- | :--- |
| **Q1: Ingestion Entry Points** | **Dual Entry: Explicit File Picker + Workspace Drag/Drop + TopBar Trigger.**<br>The shell must not rely on inert buttons. Ingestion is fully local-first via browser APIs (`FileReader` / `URL.createObjectURL`). | 1. **Empty State:** `PDFWorkspace` renders a primary action button (`data-testid="open-pdf-button"`) coupled to a hidden `<input type="file" accept="application/pdf">`.<br>2. **TopBar:** The document title area or dedicated open trigger (`data-testid="topbar-open-btn"`) activates the file picker.<br>3. **Drag & Drop:** `PDFWorkspace` listens to `dragover`, `dragleave`, and `drop`. Dropping a `.pdf` file loads the document immediately.<br>4. **Keyboard:** Pressing `Mod+O` (`Ctrl+O` on Win/Linux, `Cmd+O` on macOS) within the window prevents default browser open and opens the file picker.<br>5. **No Network:** Ingestion must never issue `fetch` or `XMLHttpRequest` calls. |
| **Q2: Text-Layer Scope** | **P0 Critical: Native Selectable Text Layer Aligned with Canvas.**<br>For an academic reader, text selection (for citations, copying, and future translation spans) is non-negotiable. | 1. A `.textLayer` container is rendered as an absolute overlay matching the exact bounding box of the page `<canvas>`.<br>2. CSS bounding rect (`width`, `height`, `top`, `left`) of `.textLayer` must match `<canvas>` within `0.5px` at 100%, 150%, and fit-width.<br>3. Native text selection (`window.getSelection()`) on paper headings and two-column paragraphs extracts clean UTF-8 text matching the document content.<br>4. Text layer glyphs must have `color: transparent` and semi-transparent selection highlighting (`rgba(..., 0.2-0.4)`) so underlying canvas glyphs remain crisp without visual double-rendering. |
| **Q3: Rendering Strategy** | **Lazy Viewport Window with Placeholder Geometry Reservation.**<br>No heavy pre-emptive virtualization libraries. Pre-calculate layout heights and render canvases only within a buffered viewport window. | 1. On document load, DOM instantiates lightweight `.pdf-page-container` elements for all $N$ pages with pre-calculated `min-height` based on page 1 viewport aspect ratio and zoom.<br>2. An `IntersectionObserver` with `rootMargin: "300px 0px"` (approx. 1–1.5 pages buffer) monitors visibility.<br>3. Only pages intersecting the buffered viewport instantiate `<canvas>` and render via `page.render()`.<br>4. On a 50+ page document, at any given scroll offset, active `<canvas>` count in DOM must not exceed `visiblePages + 4`.<br>5. Canvases $> 5$ pages away from viewport are unmounted/cleared to bound GPU/RAM consumption. Fast scrolling must cancel in-flight `renderTask`s cleanly without uncaught exceptions. |
| **Q4: Password-Protected PDFs** | **Explicit Non-Crashing Error State (Stop & Report).**<br>Interactive password prompts are deferred to P2. P0 requires a graceful, non-crashing error boundary state. | 1. PDF.js `PasswordException` is caught gracefully.<br>2. Viewer replaces canvas area with `data-testid="pdf-password-error"` containing header *"Document is Password-Protected"* / *"文档已受密码保护"* and message *"Encrypted PDFs are not currently supported. Please open an unencrypted PDF."*<br>3. Provides an *"Open Another File"* button that resets to the file picker.<br>4. Shell Error Boundary does **not** catch; the rest of the application (TopBar, Sidebar, StatusBar) remains fully interactive. |
| **Q5: Zoom Persistence Across Document Switches** | **Reset to "Fit Width" (`fit-width`) on Document Switch.**<br>Academic papers differ drastically in dimensions (A4, US Letter, slides, 2-column IEEE). Carrying arbitrary zoom ratios across documents leads to broken layouts. | 1. When switching from Document A to Document B, zoom state resets to `fit-width`.<br>2. Current page resets to `1`.<br>3. Viewport scroll position resets to top `(0, 0)`.<br>4. `fit-width` calculates the zoom factor such that page width equals viewer container client width minus horizontal padding (default `32px`). |
| **Q6: "Current Page" Definition** | **Maximum Visible Area (Topmost Tie-Breaker).**<br>Calculated continuously during vertical scroll via visible intersection height. | 1. `currentPage = pageIndex` with maximum visible vertical height in viewport (`intersectionRect.height`).<br>2. **Tie-Breaker:** If two pages have equal visible height (e.g. 50/50 split), the lower page index (topmost) is selected.<br>3. Toolbar page counter updates within 50ms of scroll stop and reflects `currentPage / totalPages`. |

---

## 2. Acceptance Criteria Table (P0 / P1 / P2)

Columns: **ID** | **Priority** | **Description & Verification Target**

### Category 1: Document Ingestion & Local-First Security

| ID | Priority | Description & Verification Target |
| :--- | :---: | :--- |
| **AC-001** | **P0** | **Mock Page Removal:** `src/reader/ViewerPanel.tsx` mock page (grey placeholder bars on white card) is completely eliminated from the DOM and replaced by the real PDF.js reader container. Verified by: `grep -rn "bg-muted-foreground" src/reader/` returns zero mock skeleton rows; DOM contains `data-testid="pdf-viewer-panel"`. |
| **AC-002** | **P0** | **Native File Picker Ingestion:** User can click "Open PDF" button in empty state or TopBar action to select a `.pdf` file from the local file system. Verified by: Triggering file input change with a valid PDF file (`application/pdf`) transitions the viewer to the loading state and renders the PDF within 1500ms. |
| **AC-003** | **P0** | **Workspace Drag and Drop Ingestion:** Dragging a `.pdf` file from the OS desktop onto `PDFWorkspace` highlights the drop target and loads the document upon drop. Verified by: Dispatching `dragover` applies `ring-2 ring-primary` visual state; dispatching `drop` with `dataTransfer.files[0] = test.pdf` triggers file load. Non-PDF files (e.g., `.png`, `.txt`) are rejected with an error toast/banner and do not crash the app. |
| **AC-004** | **P0** | **Local-First Zero-Upload Guarantee:** Opening and viewing any PDF must execute 100% locally in the browser. Verified by: Playwright/Vitest network interception asserts **0** outgoing HTTP requests to `127.0.0.1:8000/api/*` or external CDNs during document loading, parsing, page switching, or rendering. |
| **AC-005** | **P1** | **Keyboard Shortcut Open (`Mod+O`):** Pressing `Ctrl+O` (Windows/Linux) or `Cmd+O` (macOS) invokes the native file picker without triggering browser default "Save/Open HTML" behaviors. Verified by: Dispatching `keydown` event (`ctrlKey: true, key: 'o'`) calls `.click()` on the hidden file input element and prevents default. |

---

### Category 2: Rendering Engine & PDF.js Worker Configuration

| ID | Priority | Description & Verification Target |
| :--- | :---: | :--- |
| **AC-006** | **P0** | **`pdfjs-dist` Worker Resolution in Dev & Preview:** PDF.js web worker must initialize correctly in both Vite development (`npm run dev`) and production preview (`npm run build && npm run preview`). Verified by: `GlobalWorkerOptions.workerSrc` resolves to a valid local worker script (via `new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()`). Console displays 0 worker loading errors (no `Setting up fake worker` fallback warnings in production). |
| **AC-007** | **P0** | **Real Multi-Page Rendering:** Renders real vector glyphs and bitmaps for multi-page documents. Verified by: Loading a 10-page academic PDF results in `totalPages === 10`; page 1 renders a `<canvas>` containing non-blank pixel data (`getImageData` has non-zero alpha and color variation). |
| **AC-008** | **P0** | **HiDPI / Retina Display Sharpness:** Canvases must account for `window.devicePixelRatio`. Verified by: Canvas internal bitmap dimensions equal `viewport.width * devicePixelRatio` and `viewport.height * devicePixelRatio`, while CSS style `width` and `height` equal `viewport.width` px and `viewport.height` px. Renders crisp text on `dpr: 2` without pixelation. |
| **AC-009** | **P1** | **Orientation & Non-A4 Aspect Ratio Support:** Academic papers with landscape pages, US Letter, A4, or embedded `/Rotate 90/180/270` tags render with correct orientation. Verified by: Loading a test PDF containing mixed portrait and landscape pages renders each page container with its corresponding aspect ratio without clipping or distortion. |
| **AC-010** | **P1** | **Two-Column Academic Paper Rendering:** Standard IEEE/ACM/NeurIPS two-column academic formats render text, mathematical formulas, figures, and tables without layout drift or overlapping blocks. Verified by: Visual diff comparison on NeurIPS sample paper matches baseline within 0.1% pixel difference. |

---

### Category 3: Continuous Scroll & Viewport Navigation

| ID | Priority | Description & Verification Target |
| :--- | :---: | :--- |
| **AC-011** | **P0** | **Continuous Vertical Scrolling:** All pages of the document are stacked vertically in a scrollable viewer pane with consistent gap (`gap-4` / `16px`). Verified by: The outer window never scrolls (`window.scrollY === 0`); the `.pdf-scroll-container` scroll offset changes smoothly from page 1 to page $N$. |
| **AC-012** | **P0** | **Viewport-Synchronized Current Page Tracking:** As the user scrolls vertically, the current page displayed in the toolbar and status bar dynamically updates. Verified by: Scrolling until Page 3 has the largest visible vertical intersection immediately updates toolbar text to `3 / 10`. |
| **AC-013** | **P0** | **Direct Page Jump via Toolbar Input:** User can type a target page number into the toolbar input (`data-testid="page-number-input"`) and press Enter to jump immediately to that page. Verified by: Entering `5` and pressing Enter scrolls the container such that the top of Page 5 aligns with the top of the viewer viewport (`scrollTop` equals Page 5 offset). Out-of-bounds inputs (< 1 or > totalPages) clamp to `1` or `totalPages`. Non-numeric inputs are discarded. |
| **AC-014** | **P0** | **Previous / Next Page Buttons:** Toolbar provides "Previous Page" and "Next Page" icon buttons. Verified by: Clicking "Next" scrolls the viewport to align the next page; clicking "Previous" scrolls to the previous page. "Previous" is disabled on page 1; "Next" is disabled on page $N$. |
| **AC-015** | **P1** | **Large Document Lazy Rendering (200-Page Scalability):** On large academic documents (e.g. 100–200 pages), browser does not freeze or run out of memory. Verified by: Loading a 200-page document initializes all 200 page container placeholders (`.pdf-page-container`), but only pages within `viewport + 300px buffer` instantiate `<canvas>` and render. Active `<canvas>` count in DOM never exceeds 6 at 100% zoom. |
| **AC-016** | **P1** | **Rapid Scroll Render Task Cancellation:** Fast scrolling past multiple pages does not crash the application with unhandled rejections. Verified by: Programmatically scrolling from page 1 to page 50 at 2000px/s aborts intermediate in-flight `RenderTask`s via `.cancel()`; console logs 0 unhandled `RenderingCancelledException` errors. |

---

### Category 4: Zoom & Fit-Width Mechanics

| ID | Priority | Description & Verification Target |
| :--- | :---: | :--- |
| **AC-017** | **P0** | **Zoom In & Zoom Out Controls:** Toolbar provides dedicated Zoom In (`+`) and Zoom Out (`-`) buttons. Verified by: Base zoom steps follow discrete scale factors: `[0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0]`. Clicking `+` at 100% scales viewer to 125%; clicking `-` scales to 75%. Canvas and text layer re-render at the new scale. |
| **AC-018** | **P0** | **Fit-Width Calculation:** Toolbar provides a "Fit Width" toggle (`data-testid="fit-width-btn"`). Verified by: When activated, calculates scale factor $S = \frac{\text{container.clientWidth} - 32\text{px}}{\text{page.viewport(1.0).width}}$. Page horizontal width exactly spans the container width with `16px` padding on left and right; horizontal scrollbars do not appear. |
| **AC-019** | **P0** | **Zoom Anchor Preservation:** Zooming in/out must anchor to the current reading position rather than jumping to page 1. Verified by: While reading page 5 (centered in viewport), clicking Zoom In preserves Page 5 within the viewport after re-render completes. |
| **AC-020** | **P1** | **Window Resize Auto-Refit under Fit-Width:** When viewer is in `fit-width` mode, resizing the browser window (or expanding/collapsing the sidebar) automatically recalculates zoom and re-renders pages without manual user intervention. Verified by: Collapsing the sidebar from 380px to 0px expands viewer width and automatically rescales pages to fill the newly available width. |
| **AC-021** | **P1** | **Ctrl + Mouse Wheel Zoom:** Holding `Ctrl` (or `Cmd`) while scrolling the mouse wheel over the viewer viewport increases or decreases zoom level. Verified by: Wheel down with `ctrlKey: true` zooms out; wheel up zooms in. Standard vertical scroll is suppressed during pinch/wheel-zoom. |

---

### Category 5: Native Text Layer & Academic Text Selection

| ID | Priority | Description & Verification Target |
| :--- | :---: | :--- |
| **AC-022** | **P0** | **Text Layer Rendering:** For native-text PDFs, PDF.js `renderTextLayer` (or `TextLayer`) must render text span elements corresponding to all text items. Verified by: `.textLayer` element exists inside each rendered page container; contains `<span>` elements with text matching the document content. |
| **AC-023** | **P0** | **Geometric Canvas Alignment Under Zoom:** Text layer spans must geometrically overlay the canvas glyphs across all zoom levels. Verified by: Bounding rect of `.textLayer` matches `<canvas>` bounding rect within `0.5px` at scale 1.0, 1.5, and `fit-width`. Inspecting text span positions reveals horizontal and vertical offset deviation $< 1.0\text{px}$ from canvas rendering. |
| **AC-024** | **P0** | **Selectable & Copyable Academic Text:** User can click and drag to select text across single-column abstract and two-column paper bodies. Verified by: Triggering selection on paragraph text, executing copy (`Ctrl+C`), and reading clipboard text yields clean string matching the original paper text without missing spaces or garbage characters. |
| **AC-025** | **P1** | **Visual Transparency of Text Layer:** Text layer glyphs must not cause visible double-rendering or font fuzziness. Verified by: CSS rule `color: transparent` applies to all `.textLayer span`; `::selection` background is semi-transparent (e.g. `rgba(59, 130, 246, 0.25)`). Canvas rendering provides the visible crisp text. |

---

### Category 6: State Machine: Empty, Loading, Error & Encrypted States

| ID | Priority | Description & Verification Target |
| :--- | :---: | :--- |
| **AC-026** | **P0** | **Empty State:** When no document is loaded, workspace displays a clean empty state. Verified by: Container `data-testid="pdf-empty-state"` displays an academic reader icon, "No document opened" heading, and primary "Open PDF" button. Toolbar controls (page jump, zoom) are disabled or hidden. |
| **AC-027** | **P0** | **Loading State Indicator:** During PDF parsing and initial page rendering, viewer displays an accessible loading indicator. Verified by: While document is fetching/parsing, `data-testid="pdf-loading-spinner"` is visible with `aria-busy="true"`. Skeleton card matches expected page aspect ratio to prevent CLS (Cumulative Layout Shift $< 0.05$). |
| **AC-028** | **P0** | **Corrupted / Invalid File Handling:** Loading a non-PDF file or corrupted byte sequence displays an informative error state without crashing the workspace. Verified by: Attempting to open a corrupted file catches `InvalidPDFException`; renders `data-testid="pdf-error-state"` with message *"Failed to load PDF document. The file may be corrupted or invalid."* and an "Open Another File" action. |
| **AC-029** | **P0** | **Password-Protected / Encrypted PDF Handling:** Opening a password-protected PDF stops cleanly and reports encryption status. Verified by: Catching `PasswordException` displays `data-testid="pdf-password-error"` stating *"Document is password-protected. Encrypted PDFs are not currently supported."* Workspace does not enter an infinite render loop. |
| **AC-030** | **P1** | **Document Reload / Error Recovery:** After encountering an error state (corrupt or encrypted file), user can immediately select and open a valid PDF without refreshing the browser page. Verified by: Clicking "Open Another File" and selecting a valid PDF clears the error and renders the new PDF successfully. |

---

### Category 7: Lifecycle, Resource Cleanup & Memory Safety

| ID | Priority | Description & Verification Target |
| :--- | :---: | :--- |
| **AC-031** | **P0** | **Document Switching Cleanup:** Opening Document B while Document A is loaded completely cleans up Document A resources. Verified by: Calls `doc.destroy()`, cancels all pending `RenderTask` instances, revokes object URLs (`URL.revokeObjectURL`), removes previous DOM nodes, and resets page state to page 1. No pages from Document A remain in the DOM. |
| **AC-032** | **P1** | **Canvas Memory Deallocation on Unmount:** Closing or switching documents frees canvas backing stores. Verified by: Canvases have width/height set to 0 or are removed from DOM; `renderTask.cancel()` is called if rendering was in progress. Profiling 10 consecutive document open/close cycles shows stable JS heap and zero detached canvas memory leaks. |
| **AC-033** | **P1** | **Event Listener Teardown:** All window, container, resize, and intersection observer listeners registered by the viewer instance are disconnected on component unmount. Verified by: Unmounting `PDFViewer` decreases active `IntersectionObserver` instances to 0; no resize callbacks fire after unmount. |

---

### Category 8: Dual-View / Bilingual Architecture Preservation

| ID | Priority | Description & Verification Target |
| :--- | :---: | :--- |
| **AC-034** | **P0** | **Independent Reusable Viewer Instances:** The `PDFViewer` component must be designed as an autonomous, self-contained instance without relying on a single global singleton document state. Verified by: Instantiating two `PDFViewer` components side-by-side (simulating future DS-FE-003 bilingual mode): each viewer can independently open different documents, maintain different current page numbers, and have different zoom levels without cross-talk. |
| **AC-035** | **P0** | **Reader Mode Switch Integration:** Switching between `原文` (Original), `双语` (Bilingual), and `译文` (Translation) via the existing TopBar reader-mode switch correctly mounts and unmounts viewer instances. Verified by: In `原文` mode, 1 viewer is rendered; in `双语` mode, 2 viewer panes are rendered side-by-side; in `译文` mode, 1 viewer is rendered. Each pane maintains isolated scrolling and layout. |
| **AC-036** | **P1** | **Dual Viewer Layout Partitioning:** In bilingual mode (`双语`), both viewer panes split the available horizontal space equally (`50% / 50%` or flex-1) with independent horizontal fit-width calculations. Verified by: Neither pane overflows; fit-width on Pane 1 fits to Pane 1's client width; fit-width on Pane 2 fits to Pane 2's client width. |

---

### Category 9: Layout, Responsive Density & Sidebar Integration

| ID | Priority | Description & Verification Target |
| :--- | :---: | :--- |
| **AC-037** | **P0** | **Zero Window Overflow at 1024 / 1440 / 1920 px:** The entire workspace operates inside a fixed viewport container (`100vh`, `overflow-hidden`). Verified by: Playwright capture harness asserts `document.documentElement.scrollHeight === window.innerHeight` at widths 1024px, 1440px, and 1920px. Only the inner `.pdf-scroll-container` exhibits vertical scrolling. |
| **AC-038** | **P0** | **Compact Desktop Toolbar Density:** The PDF viewer toolbar uses desktop density tokens (`h-10` / `40px` height, `text-xs`, compact icon buttons `p-1.5`). Verified by: Toolbar height does not exceed `40px`; toolbar does not wrap onto multiple lines at 1024px width with sidebar expanded (380px). |
| **AC-039** | **P0** | **Sidebar Collapse / Expand Accommodation:** Toggling the AI sidebar (320px–380px to 0px) expands/contracts the PDF workspace without breaking page centering or causing layout jitter. Verified by: Clicking sidebar toggle smoothly resizes viewer width; canvas text and layout remain intact. |
| **AC-040** | **P1** | **Narrow Desktop Layout (1024px):** At 1024px viewport width with sidebar expanded (380px), available PDF workspace is ~644px. Verified by: Viewer displays cleanly; toolbar controls collapse overflow gracefully (e.g. secondary zoom presets into dropdown, primary controls remain visible); no horizontal scrollbar on body. |

---

### Category 10: Keyboard Navigation & Accessibility (a11y)

| ID | Priority | Description & Verification Target |
| :--- | :---: | :--- |
| **AC-041** | **P1** | **Keyboard Page Navigation:** When focus is inside the viewer scroll container, keyboard navigation keys operate predictably. Verified by: `PageDown` or `Space` scrolls down one screen; `PageUp` scrolls up one screen; `Home` scrolls to Page 1 top; `End` scrolls to last page bottom. |
| **AC-042** | **P1** | **Keyboard Zoom Controls:** Pressing `Ctrl + +` / `Cmd + +` zooms in; `Ctrl + -` / `Cmd + -` zooms out; `Ctrl + 0` / `Cmd + 0` resets to fit-width/100%. Verified by: Dispatching corresponding `keydown` events modifies the viewer zoom state accordingly. |
| **AC-043** | **P1** | **Focus Rings & Interactive Accessibility:** Every interactive control in the toolbar and empty state has distinct focus rings (`focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none`). Verified by: Tab navigation moves sequentially across Open, Prev, Page Input, Next, Zoom Out, Zoom Level, Zoom In, Fit Width. Active focus is visible in screenshots. |
| **AC-044** | **P1** | **Screen Reader ARIA Attributes:** Viewer states and toolbar controls provide accessible names and live regions. Verified by: Toolbar buttons have descriptive `aria-label`s (`"Previous Page"`, `"Next Page"`, `"Zoom In"`, `"Zoom Out"`, `"Fit Width"`); page indicator uses `aria-live="polite"` so page changes can be announced. |

---

### Category 11: Performance, Rendering Budget & Build Integrity

| ID | Priority | Description & Verification Target |
| :--- | :---: | :--- |
| **AC-045** | **P0** | **TypeScript Strict Typecheck:** The entire frontend codebase passes strict typechecking with no errors. Verified by: `npm run typecheck` (or `tsc --noEmit`) completes with exit code 0 and zero warnings. No `any` escapes used for PDF.js document or page objects (use `pdfjs-dist` types). |
| **AC-046** | **P0** | **Vite Production Build Success:** Frontend builds cleanly for production. Verified by: `npm run build` completes with exit code 0. Chunk size analysis shows `pdfjs-dist` split into an asynchronous vendor chunk; total initial bundle size increase remains within reasonable bounds (< 450kB gzipped). |
| **AC-047** | **P0** | **Playwright Capture Harness Verification:** Existing capture script `frontend/scripts/capture.mjs` executes against `npm run preview` and passes all visual/layout assertions. Verified by: Node execution `node scripts/capture.mjs` exits with code 0; captures screenshots at 1024, 1440, 1920 widths showing real PDF viewer rendered without layout shifts. |
| **AC-048** | **P1** | **Initial Page Render Performance:** On a standard 10-page academic paper, Page 1 canvas and text layer must render within 800ms of file selection on a desktop CPU. Verified by: Performance mark `pdf-load-start` to `pdf-page-1-rendered` $< 800\text{ms}$. |
| **AC-049** | **P1** | **No Unnecessary Re-Renders:** Scrolling the document must only update the page indicator; it must not trigger re-rendering of the entire workspace, sidebar, or un-scrolled pages. Verified by: React Profiler or `useWhyDidYouUpdate` hook confirms that scrolling within Page 2 does not re-render the TopBar, Sidebar, or Page 1 `<canvas>`. |

---

## 3. Existing Test Regression & Replacement Strategy

DS-FE-001 established 27 passing tests across 5 test suites. The following strategy governs test evolution for DS-FE-002:

| Existing Test File / Assertion | Change Required for DS-FE-002 | Preservation / Replacement Rule |
| :--- | :--- | :--- |
| **`ViewerPanel.test.tsx`** (Assertions on mock grey bars / placeholder skeleton) | **REPLACE** | Replace assertions expecting `.bg-muted-foreground` placeholder lines with assertions expecting `data-testid="pdf-empty-state"` (when no file loaded) or `data-testid="pdf-viewer-panel"` (when file loaded). |
| **`WorkspaceLayout.test.tsx`** (Four-region workspace, sidebar collapse) | **PRESERVE** | Must pass without changes. The PDF workspace must remain inside the designated central reading region. |
| **`ReaderModeSwitch.test.tsx`** (Swapping 1 vs 2 viewer panels) | **UPDATE MOCK** | Update test to verify that `原文` renders 1 `PDFViewer`, `双语` renders 2 `PDFViewer` instances, and `译文` renders 1 `PDFViewer`. Assert independent container IDs. |
| **`StatusBar.test.tsx`** (Status bar page indicator) | **PRESERVE & WIRE** | Ensure StatusBar receives real page updates (`Page X / Y`) propagated from the active `PDFViewer` instance via Zustand workspace store. |
| **`ErrorBoundary.test.tsx`** | **PRESERVE** | Uncaught viewer rendering errors still bubble to `ErrorBoundary`; PDF.js handled errors (corrupt, encrypted) are caught locally within `PDFViewer`. |

---

## 4. Verification & Test Harness Plan

Implementation must be validated against three distinct test layers before acceptance:

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Vitest Unit & Component Tests (jsdom / mock worker)      │
│    - File open state transitions (empty -> loading -> ready)│
│    - Toolbar event firing (zoom, page jump, fit-width)     │
│    - Error handling (InvalidPDFException, PasswordException)│
│    - Document destroy & cleanup lifecycle                   │
├─────────────────────────────────────────────────────────────┤
│ 2. End-to-End Visual & Layout Tests (Playwright / Chrome)   │
│    - Real PDF.js Web Worker loading in production bundle    │
│    - Canvas + Text Layer visual alignment (< 0.5px)         │
│    - Continuous vertical scroll & current page tracking     │
│    - No window scrollbars at 1024, 1440, and 1920px widths  │
├─────────────────────────────────────────────────────────────┤
│ 3. Performance & Memory Leak Verification                   │
│    - 200-page document lazy rendering (active canvas <= 6)  │
│    - 10x consecutive document load/switch memory profile    │
│    - 0 network requests outside local browser sandbox       │
└─────────────────────────────────────────────────────────────┘
```

### Standard Test Fixtures Required for Verification:
1. `single-page-paper.pdf`: Standard 1-page academic abstract (verifies baseline rendering and text layer).
2. `two-column-neurips.pdf`: Multi-page (e.g. 10 pages) two-column paper with formulas, figures, and landscape tables (verifies multi-page scrolling, layout density, and text selection).
3. `large-thesis-200p.pdf`: 200-page academic thesis (verifies lazy page unmounting and scroll performance).
4. `corrupt-file.pdf`: Truncated/corrupt binary stream (verifies invalid file error boundary).
5. `password-locked.pdf`: Standard AES-encrypted PDF (verifies encrypted document non-crashing state).

---

## 5. Acceptance Sign-Off Checklist (Prioritized Summary)

- [ ] **P0:** Mock page removed; real PDF.js canvas and worker render successfully in both `npm run dev` and `npm run preview`.
- [ ] **P0:** Zero network calls (`fetch`/`XHR`) during PDF ingestion and rendering (local-first).
- [ ] **P0:** Continuous vertical scroll with accurate `currentPage / totalPages` tracking in toolbar.
- [ ] **P0:** Zoom In, Zoom Out, and Fit-Width accurately scale canvas and text layer.
- [ ] **P0:** Selectable text layer geometrically aligns with canvas within `0.5px`; text is copyable.
- [ ] **P0:** Empty state, loading spinner, corrupted file error, and password-protected notice render cleanly without crashing.
- [ ] **P0:** Document switching cleanly destroys previous document, revokes URLs, and cancels in-flight tasks.
- [ ] **P0:** Dual viewer instances run independently without shared state conflicts (ready for DS-FE-003 bilingual view).
- [ ] **P0:** Strict TypeScript check passes (`tsc --noEmit`), Vitest suite passes, production build succeeds.
- [ ] **P0:** Playwright capture harness passes at 1024px, 1440px, and 1920px with 0 window scrollbars.
- [ ] **P1:** Page jump via input, keyboard navigation (`PageDown`/`PageUp`, `Ctrl+O`), and ARIA attributes fully operational.
- [ ] **P1:** Large document lazy rendering limits active canvases in DOM to $\le 6$; rapid scrolling cancels in-flight tasks without console errors.
- [ ] **P1:** Repeated document switching exhibits stable memory usage without detached canvas leaks.
- [ ] **P2:** Advanced preset zoom dropdown, smooth zoom transitions, and visual drag-over feedback.
