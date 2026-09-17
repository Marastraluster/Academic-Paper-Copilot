# ACCEPTANCE CRITERIA: DS-FE-003 Translate Action + Translation Result Viewer

## Section 1: Architectural Design Decisions (Resolving the 13 Specific Questions)

1. **Local `File` to Backend Document Registration**:
   * The browser holds a `File` reference, never a native filesystem path.
   * The frontend **MUST** use `POST /api/documents` with `multipart/form-data` containing the file in the `file` field (`UploadFile`).
   * The JSON form (`{"path": "..."}`) is strictly reserved for local headless callers and **MUST NOT** be used by the browser client.
2. **Local-First Zero-Latency Rendering**:
   * The reader **MUST NOT** wait for backend upload/registration before rendering.
   * When a file is picked or dropped, `PdfWorkspace` immediately loads the local `File` via `file.arrayBuffer()` into PDF.js.
   * Background registration (`POST /api/documents`) is kicked off concurrently without blocking reading.
3. **Translation Action Disabled States**:
   * `AI翻译` button is disabled if:
     1. No document is loaded in the workspace.
     2. Document registration is actively in flight (`isRegistering === true`), displaying an inline spinner/tooltip.
     3. A translation task is actively running (`PENDING`, `TRANSLATING`, or `CANCELLING`) for the active document.
   * `AI翻译` button is enabled when:
     1. Document registration has succeeded and no translation task is in flight.
     2. A previous translation is terminal (`SUCCESS`, `FAILED`, `CANCELLED`), allowing retranslation.
   * If `GET /api/profiles` returns an empty list, clicking `AI翻译` opens the modal with an empty-state warning and disables the "Start" button.
4. **Document Identity & Race Prevention**:
   * The client workspace state tracks an immutable pair: `documentId: string | null` and a client-side `sessionToken: string` (generated per document load).
   * Translation requests, SSE connections, and binary downloads are tagged with both.
   * Incoming SSE events and fetch responses check `activeDocumentId === event.documentId && activeSessionToken === event.sessionToken`. If mismatched, the payload is immediately dropped.
5. **Reader Modes Before Translation**:
   * Before a successful translation exists, the `ReaderModeSwitch` shows `原文` as active.
   * `双语` and `译文` controls are visually rendered but disabled (`aria-disabled="true"`, pointer-events disabled, dimmed styling, tooltip indicating translation is required).
   * Only upon receiving task `SUCCESS` and loading the mono PDF are `双语` and `译文` unlocked.
6. **In-Flight Translation When Switching Documents**:
   * The UI **NEVER** blocks the user from opening another document.
   * Switching documents immediately unbinds the viewer, terminates the active SSE connection on the client, revokes existing blob URLs, and transitions the workspace to the new document.
   * The background task on the backend is allowed to finish on its own server-side without poisoning the client state.
7. **Bilingual Mode PDF Artifact**:
   * Side-by-side bilingual mode uses **Original (`/file` or local `File`) + Mono Translated (`/translated`)**.
   * Rationale: The dual artifact (`/bilingual`) is an interleaved 2N-page document. Rendering the 2N-page PDF in a side-by-side view would break 1:1 page alignment and duplicate original pages. Left pane = Original (N pages), Right pane = Mono Translated (N pages).
8. **Honest Progress Representation**:
   * When `status === "PENDING"` or `progress === null`: Render indeterminate progress ("Preparing translation...") without fake percentages or fake phases (`ANALYZING`/`RENDERING`).
   * When `progress === { page: 1, page_count: 1 }`: Render "Translating page 1 of 1 (100%)".
   * When `progress === { page: p, page_count: N }`: Render `Translating page p of N` and exact percentage `Math.round((p / N) * 100)%`.
   * Hardcoded placeholder progress (`currentPage: 5, pageCount: 18, percent: 72`) and the `示例` chip in `StatusBar.tsx` are **completely deleted**.
9. **Differentiated Error Messages**:
   * `PROVIDER_AUTH_FAILED` (502): *"Translation provider authentication failed. Please verify your API key in settings."*
   * `PROVIDER_RATE_LIMITED` (502): *"Provider rate limit exceeded. Please wait before retrying."*
   * `PROVIDER_TIMEOUT` (504): *"Translation provider timed out. The model took too long to respond."*
   * Unreachable backend (network failure): *"Cannot connect to backend translation service. Ensure the local server is running on {API_BASE_URL}."*
   * `TRANSLATION_SERVICE_ERROR` / Kernel failure: Display `error.message` directly without masking.
10. **Independent Pane Toolbars and Controls**:
    * The translated pane in bilingual mode mounts an independent `PdfWorkspace` instance with its own toolbar, zoom controls, and scroll container.
    * No shared PDF.js singleton is used; panes maintain separate PDFDocumentProxy instances and render loops.
11. **Resource Teardown on Lifecycle Transitions**:
    * `URL.revokeObjectURL(blobUrl)` is invoked on:
      1. Retranslation replacing an existing translation.
      2. Document switch or document close.
      3. Component unmount.
    * `loadingTask.destroy()` is called on any active PDF.js loading task before initiating a new one or unmounting.
12. **Mismatched Page Counts**:
    * If `translated_page_count !== original_page_count`, the translated viewer renders its actual page count honestly (e.g., "Page 1 of M").
    * The reader does not crash, throw unhandled errors, or clamp the viewer artificially. An informational warning chip ("Translated document page count differs from original") is displayed.
13. **Objective Testability of "No Credential Leakage"**:
    1. DOM: `document.querySelectorAll('*')` contains no plaintext API key; profile lists render only `api_key_masked`.
    2. Payload: `POST /api/documents/{id}/translate` payload contains strictly `{ profile_id, lang_in, lang_out, engine }`.
    3. Headers: No `Authorization` or third-party provider keys in client request headers.
    4. Console: `console.log/warn/error` spies verify 0 secret keys logged.
    5. Store: Inspection of Zustand stores shows only `profile_id` and masked metadata.

---

## Section 2: P0 Acceptance Criteria (Must Pass for Task Completion)

### 1. Document Registration & Local-First Ingestion (Dimensions 1, 32)
* **AC-P0-01: Non-blocking Local PDF Opening**:
  * *Given* a user selects a local `.pdf` file via file picker or drag-drop,
  * *When* the file is loaded into the app,
  * *Then* `PdfWorkspace` immediately parses and displays the original PDF locally via `file.arrayBuffer()` without waiting for backend network responses.
  * *Rationale*: Preserves the local-first reading promise; UI is instantly responsive.
* **AC-P0-02: Multipart Backend Registration**:
  * *Given* a local `File` has been opened,
  * *When* background registration is triggered,
  * *Then* the client issues a `POST /api/documents` request using `multipart/form-data` with field name `file`.
  * *And* the client stores the returned `document_id`, `name`, and `page_count` in the workspace store.
  * *And* the local file is not mutated on disk or in memory.
  * *Rationale*: Conforms to the backend browser ingestion contract without requiring nonexistent local file paths.

### 2. Translate Action & Configuration Modal (Dimensions 2, 3, 4, 5, 6, 7)
* **AC-P0-03: Translate Action Availability**:
  * *Given* no document is loaded, or document registration is in flight,
  * *Then* the `AI翻译` button in `TopBar` is disabled (`disabled` attribute and visual disabled state).
  * *When* document registration completes successfully,
  * *Then* the `AI翻译` button becomes enabled.
  * *Rationale*: Prevents dispatching translation requests against nonexistent backend documents.
* **AC-P0-04: Profile Selection & Keyless Provider Support**:
  * *Given* the user clicks `AI翻译`,
  * *When* the configuration dialog opens,
  * *Then* it queries `GET /api/profiles` and populates the profile dropdown.
  * *And* profiles with `has_key: false` (e.g. local Ollama/vLLM) are treated as valid and selectable without prompting for an API key.
  * *Rationale*: Directly respects the keyless OpenAI-compatible provider fix from DS-BE-007.
* **AC-P0-05: Exact Translation Request Contract**:
  * *Given* the user submits the translation dialog with `profile_id: "prof_123"`, `lang_in: "en"`, `lang_out: "zh"`,
  * *When* the request is sent,
  * *Then* it issues `POST /api/documents/{document_id}/translate` with JSON body:
    `{"profile_id": "prof_123", "lang_in": "en", "lang_out": "zh", "engine": "fast"}`.
  * *And* no extra fields are included (verifying `extra="forbid"` does not reject with 422).
  * *And* upon receiving 202 with `{"task_id": "task_abc", "status": "PENDING"}`, the store transitions to translating state.
  * *Rationale*: Enforces backend schema strictness and avoids 422 validation errors.

### 3. Task Progress & Honest Status Reporting (Dimensions 8, 9, 28)
* **AC-P0-06: SSE Stream Subscription & Lifecycle**:
  * *Given* a 202 response with `task_id`,
  * *When* the task starts,
  * *Then* the client opens an EventSource/SSE connection to `GET /api/tasks/{task_id}/events`.
  * *And* upon receiving terminal events (`done`, `error`, `cancelled`), the client explicitly closes the EventSource.
  * *Rationale*: Real-time updates without polling overhead; prevents dangling HTTP connections.
* **AC-P0-07: Elimination of Fake Progress & Honest Page Tracking**:
  * *Given* a translation task is active,
  * *When* `status === "PENDING"` or `progress === null`, the UI shows indeterminate progress (animated bar / "Preparing...") and does NOT render fake phases (`ANALYZING`, `RENDERING`) or fake block counts.
  * *When* SSE emits `progress` event with `{"page": p, "page_count": N}`, the `StatusBar` displays `Translating page p of N` and progress bar percentage `Math.round((p / N) * 100)`.
  * *And* the mock `currentPage: 5, pageCount: 18, percent: 72` and the `示例` badge in `StatusBar` are completely eliminated.
  * *Rationale*: Honest progress reporting matching the unified fast kernel reality.

### 4. Translation Success & Mono PDF Viewer (Dimensions 10, 12, 14, 15, 16, 17)
* **AC-P0-08: Translation Completion & Mono Retrieval**:
  * *Given* an active translation task,
  * *When* the SSE stream emits `event: done` with `status: "SUCCESS"`,
  * *Then* the client marks `has_translation: true` in store,
  * *And* fetches `GET /api/documents/{document_id}/translated` as `blob()`,
  * *And* generates a local `blob:` URL via `URL.createObjectURL`.
  * *Rationale*: Closes the loop from background processing to local displayable artifact.
* **AC-P0-09: Unlocking Reader Modes**:
  * *Given* translation has succeeded and the mono PDF blob is ready,
  * *When* inspecting `ReaderModeSwitch`,
  * *Then* `双语` and `译文` segmented buttons become interactive and enabled.
  * *Rationale*: Ensures user can only enter translated views once the artifact exists.
* **AC-P0-10: Reader Mode Viewport Rendering**:
  * *Given* a translated document,
  * *When* `原文` is selected: `ReaderWorkspace` renders a single `PdfWorkspace` containing the original document.
  * *When* `译文` is selected: `ReaderWorkspace` renders a single `PdfWorkspace` containing the translated mono document.
  * *When* `双语` is selected: `ReaderWorkspace` renders two side-by-side `PdfWorkspace` panes: Left = Original, Right = Translated Mono.
  * *And* each pane maintains independent zoom, toolbar, and scroll state.
  * *Rationale*: Satisfies the core Usable Client Milestone user story without breaking existing layout architecture.

### 5. Document Identity, Isolation & Retranslation (Dimensions 19, 20, 21, 22)
* **AC-P0-11: Stale Result Protection on Document Switch**:
  * *Given* document A is actively translating,
  * *When* the user opens document B,
  * *Then* the active document context switches to document B immediately.
  * *And* any subsequent SSE messages or HTTP responses for document A are discarded and do not alter document B's viewer, progress bar, or mode switch.
  * *Rationale*: Eliminates the single highest-risk defect: cross-document state corruption.
* **AC-P0-12: Retranslation Flow**:
  * *Given* document A has completed translation (`SUCCESS` or `FAILED`),
  * *When* the user clicks `AI翻译` again and confirms,
  * *Then* any previous translated blob URL is revoked,
  * *And* a new task is initiated via `POST /api/documents/{id}/translate`,
  * *And* reader modes are reset to `原文` until the new task completes.
  * *Rationale*: Enables users to re-run translations with different settings.

### 6. Honest Error Handling & Provider Faults (Dimensions 11, 23, 24, 25, 26, 27)
* **AC-P0-13: Backend Unreachable Handling**:
  * *Given* the local backend service is offline,
  * *When* any document or profile API call fails with a network connection error,
  * *Then* an error banner/toast appears: *"Cannot connect to backend translation service. Ensure the local server is running on {API_BASE_URL}."*
  * *And* the UI does not crash or enter an unrecoverable loading state.
  * *Rationale*: Provides actionable guidance when the local background service is stopped.
* **AC-P0-14: Differentiated Provider Error Mapping**:
  * *Given* a translation task fails via SSE `event: error` or polling snapshot with `status: "FAILED"`,
  * *When* the error code is:
    * `PROVIDER_AUTH_FAILED` -> Displays: *"Translation provider authentication failed. Please verify your API key in settings."*
    * `PROVIDER_RATE_LIMITED` -> Displays: *"Provider rate limit exceeded. Please wait before retrying."*
    * `PROVIDER_TIMEOUT` -> Displays: *"Translation provider timed out. The model took too long to respond."*
    * Any kernel error (e.g. `TRANSLATION_SERVICE_ERROR`) -> Displays: `error.message`.
  * *And* the client does NOT initiate an automatic retry loop.
  * *And* the `AI翻译` button is re-enabled to allow manual re-running.
  * *Rationale*: Accurately reflects DS-BE-007 error codes and DS-BE-FIX-002 bounded failure guarantees.

### 7. Resource Teardown & Security (Dimensions 30, 31, 33)
* **AC-P0-15: Memory & PDF.js Lifecycle Cleanup**:
  * *Given* a translated mono PDF is loaded from an object URL,
  * *When* the document is retranslated, switched, or the component is unmounted,
  * *Then* `URL.revokeObjectURL` is invoked for the blob URL,
  * *And* `loadingTask.destroy()` is called on the active PDF.js loading task.
  * *Rationale*: Prevents severe memory leaks and zombie worker processes during prolonged reading sessions.
* **AC-P0-16: Zero Credential Leakage**:
  * *Given* profiles are fetched and translation is triggered,
  * *Then* no plaintext API key is ever rendered in the DOM (verified by inspecting HTML/attributes).
  * *And* no API key is sent in client request bodies or client headers.
  * *And* no API key is logged to the browser console.
  * *And* the client store holds only `profile_id` and masked strings.
  * *Rationale*: Protects user credentials in local multi-profile environments.

### 8. Quality, Regression & Bundle Constraints (Dimensions 35, 37, 38, 39)
* **AC-P0-17: Loading, Error, and Empty States**:
  * *Given* `PdfWorkspace` in translated mode,
  * *When* fetching the blob, it renders a spinner loading state.
  * *When* the fetch or render fails, it renders an error state with an honest message.
  * *When* no translation exists, the translated mode is inaccessible.
  * *Rationale*: Consistent user feedback across all states.
* **AC-P0-18: Existing Test Suite Regression Guard**:
  * *Given* the updated codebase,
  * *When* running `npm run test` (or `vitest run`),
  * *Then* all existing 48 frontend tests pass without modification or breakage.
  * *Rationale*: Guarantees zero regression on baseline reader capabilities.
* **AC-P0-19: Bundle Size Threshold Enforcement**:
  * *Given* a production build (`npm run build`),
  * *When* inspecting the output bundle chunks,
  * *Then* the initial entry JS bundle remains `< 500 kB`.
  * *And* PDF.js remains segregated in an asynchronous dynamic chunk.
  * *Rationale*: Preserves startup performance and honors frozen project constraints.
* **AC-P0-20: Automated Test Coverage for Translation Flow**:
  * *Given* the new translation components and stores,
  * *Then* automated unit/integration tests cover:
    1. Document registration multipart dispatch.
    2. Translation request structure and store updates.
    3. SSE stream handling (snapshot, progress, done, error).
    4. ReaderModeSwitch locking/unlocking behavior.
  * *Rationale*: Ensures maintainability and regression resilience.

---

## Section 3: P1 Acceptance Criteria (Important for Usability, Non-Blocking)

### 1. Page Association & Mismatches (Dimensions 18, 29)
* **AC-P1-01: Page Number Alignment in Bilingual Mode**:
  * *Given* the reader is in `双语` mode,
  * *When* both panes are rendered,
  * *Then* both panes default to Page 1.
  * *And* if the translated page count $M$ equals original page count $N$, toolbar page navigation operates independently without throwing errors or locking the sister pane.
  * *Rationale*: Allows users to align pages while keeping pane controls independent.
* **AC-P1-02: Graceful 404 on Translated Blob Retrieval**:
  * *Given* a task emits `status: "SUCCESS"`,
  * *When* the subsequent `GET /api/documents/{id}/translated` returns 404,
  * *Then* the translated pane displays an error message: *"Translated file could not be retrieved from server"* instead of crashing the React tree.
  * *Rationale*: Handles rare filesystem synchronization edge cases cleanly.

### 2. Desktop Layout & Accessibility (Dimensions 34, 36)
* **AC-P1-03: Responsive Split-Pane Layout**:
  * *Given* `双语` mode is active on a desktop screen,
  * *When* the browser window is resized,
  * *Then* the two panes divide the viewport width equally (50/50 split),
  * *And* the root viewport maintains `overflow: hidden`, with scrollbars isolated to individual pane containers.
  * *Rationale*: Preserves desktop reading ergonomy across window sizes.
* **AC-P1-04: Keyboard & Screen Reader Accessibility**:
  * *Given* the translation modal and reader controls,
  * *When* navigating via keyboard (`Tab`, `Escape`, `Enter`),
  * *Then* focus is trapped within the translation modal when open, and `Escape` closes the modal.
  * *And* `ReaderModeSwitch` options and the `AI翻译` button have descriptive `aria-label` attributes.
  * *Rationale*: Adheres to standard desktop accessibility conventions.

### 3. End-to-End Verification (Dimension 40)
* **AC-P1-05: Real-Browser End-to-End Verification**:
  * *Given* the frontend running in a real browser against a mock or loopback backend,
  * *When* a test script drops a PDF, clicks `AI翻译`, waits for `done` event, and switches to `双语` mode,
  * *Then* both original and translated canvases render text layers in the DOM.
  * *Rationale*: Validates real DOM rendering, canvas painting, and async timing end-to-end.

---

## Section 4: P2 Acceptance Criteria (Desirable Polish)

### 1. Artifact Export & Dual PDF (Dimension 13)
* **AC-P2-01: Export Bilingual Dual PDF Action**:
  * *Given* a document has completed translation,
  * *When* the user clicks an "Export / Download" dropdown in the top bar,
  * *Then* an option "Download Interleaved Bilingual PDF" is available, triggering a browser download of `GET /api/documents/{id}/bilingual`.
  * *Rationale*: Exposes the backend's 2N dual artifact for printing or offline study without cluttering the side-by-side reading viewer.
* **AC-P2-02: Export Mono Translated PDF Action**:
  * *Given* a document has completed translation,
  * *Then* an option "Download Translated PDF" is available in the export menu, downloading `GET /api/documents/{id}/translated`.
  * *Rationale*: Convenience feature for saving translated files locally.

---

## Section 5: Explicitly Not Applicable Dimensions

The following evaluation dimensions are explicitly **NOT APPLICABLE** to DS-FE-003:

1. **Dual PDF Rendering in Side-by-Side Viewer (from Dimension 13)**:
   * *Why*: The backend dual PDF (`/bilingual`) is an interleaved 2N-page document. Rendering it inside the two-pane `ReaderWorkspace` would display interleaved pages in a side-by-side viewer, creating severe duplication and misalignment. Dual PDF is only applicable as an export artifact.
2. **Block-Level Retry (`POST /api/tasks/{task_id}/retry`)**:
   * *Why*: The backend contract explicitly returns `501 NOT_IMPLEMENTED` by design. Building UI or retry buttons targeting `/retry` is strictly forbidden.
3. **Local Filesystem Path Registration (`{"path": "..."}`) (from Dimension 1)**:
   * *Why*: The browser environment does not have access to absolute filesystem paths due to web security sandboxing. The browser client uses multipart file upload exclusively.
4. **Intermediate Pipeline Phases (`ANALYZING`, `RENDERING`)**:
   * *Why*: The backend fast translation kernel runs a unified pipeline reporting solely on page boundaries. Emitting or animating fake phase steps in the UI contradicts ground truth.
5. **Synchronized Scrolling Lockstep**:
   * *Why*: Explicitly listed as out of scope. Panes are strictly independent in this milestone.
6. **Encrypted PDF Password Entry**:
   * *Why*: Explicitly listed as out of scope; existing honest error handling for unreadable PDFs is retained.

---

## Section 6: Premise Critiques

1. **Flawed Premise: "Bilingual mode should render the dual PDF"**:
   * *Critique*: The dual PDF generated by the backend is an interleaved document (Page 1 Orig, Page 1 Trans, Page 2 Orig, Page 2 Trans...). If bilingual mode loaded this dual PDF, the two-pane architecture would either render duplicate pages or desynchronize completely. The frontend must pair the original document with the mono translated document (`/translated`) to achieve an authentic side-by-side view.
2. **Flawed Premise: "The browser should register documents via filesystem path"**:
   * *Critique*: In a browser context, a `File` object from `<input type="file">` or Drag-and-Drop does not expose its native absolute OS path (`file.path` is undefined or security-masked). Attempting to use the JSON `POST /api/documents {"path": "..."}` endpoint in the web frontend is impossible without native desktop bindings (Tauri), which is out of scope. Multipart upload is the only valid web path.
3. **Flawed Premise: "UI should offer a 'Retry' button that calls `/tasks/{id}/retry`"**:
   * *Critique*: As established in the verified test baseline, `/api/tasks/{task_id}/retry` returns HTTP 501 unconditionally. Any UI design offering task retry must re-dispatch `POST /api/documents/{id}/translate`.
4. **Flawed Premise: "API Key is mandatory for all translation profiles"**:
   * *Critique*: DS-BE-007 resolved keyless local OpenAI-compatible providers (Ollama, LocalAI, vLLM). Enforcing client-side validation requiring a non-empty API key breaks local-first offline translation.
5. **Flawed Premise: "Status bar should show fake granular block progress"**:
   * *Critique*: The legacy mockup in `workspace.ts` (`percent: 72`, `示例` chip) was an early placeholder. The backend fast kernel does not emit block counters. Retaining mock progress chips compromises product honesty.

---

## Section 7: Traceability Matrix (All 40 Dimensions)

| # | Dimension | Classification | Criteria Mapping |
|---|---|---|---|
| 1 | Document registration/upload | **P0** | AC-P0-01, AC-P0-02 |
| 2 | Translation action | **P0** | AC-P0-03 |
| 3 | Provider profile selection | **P0** | AC-P0-04 |
| 4 | Source language | **P0** | AC-P0-05 |
| 5 | Target language | **P0** | AC-P0-05 |
| 6 | Translation engine | **P0** | AC-P0-05 |
| 7 | Actual API request structure | **P0** | AC-P0-05 |
| 8 | Actual task polling/progress mechanism | **P0** | AC-P0-06 |
| 9 | Honest progress reporting | **P0** | AC-P0-07 |
| 10 | Translation success | **P0** | AC-P0-08 |
| 11 | Translation failure | **P0** | AC-P0-14 |
| 12 | Translated mono PDF retrieval | **P0** | AC-P0-08 |
| 13 | Dual PDF availability | **P2 / NA** | AC-P2-01 / Section 5.1 |
| 14 | Translated PDF.js rendering | **P0** | AC-P0-08, AC-P0-10 |
| 15 | Original mode | **P0** | AC-P0-10 |
| 16 | Translation mode | **P0** | AC-P0-10 |
| 17 | Bilingual mode | **P0** | AC-P0-10 |
| 18 | Source/translation page association | **P1** | AC-P1-01 |
| 19 | Document identity | **P0** | AC-P0-11 |
| 20 | Stale async-result protection | **P0** | AC-P0-11 |
| 21 | Switching documents | **P0** | AC-P0-11 |
| 22 | Retranslating | **P0** | AC-P0-12 |
| 23 | Backend unavailable | **P0** | AC-P0-13 |
| 24 | Provider 401/403 | **P0** | AC-P0-14 |
| 25 | Provider 429 | **P0** | AC-P0-14 |
| 26 | Provider 5xx | **P0** | AC-P0-14 |
| 27 | Timeout | **P0** | AC-P0-14 |
| 28 | Bounded failure behaviour | **P0** | AC-P0-14 |
| 29 | Translated-file-not-found behaviour | **P1** | AC-P1-02 |
| 30 | Object URL cleanup | **P0** | AC-P0-15 |
| 31 | PDF.js lifecycle cleanup | **P0** | AC-P0-15 |
| 32 | Original source immutability | **P0** | AC-P0-01, AC-P0-02 |
| 33 | No credential leakage | **P0** | AC-P0-16 |
| 34 | Responsive desktop layout | **P1** | AC-P1-03 |
| 35 | Loading/error/empty states | **P0** | AC-P0-17 |
| 36 | Accessibility | **P1** | AC-P1-04 |
| 37 | Regression protection | **P0** | AC-P0-18 |
| 38 | Bundle-size regression | **P0** | AC-P0-19 |
| 39 | Automated tests | **P0** | AC-P0-20 |
| 40 | Real-browser E2E verification | **P1** | AC-P1-05 |
