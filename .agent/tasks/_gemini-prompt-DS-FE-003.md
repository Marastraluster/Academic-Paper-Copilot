You are the independent Acceptance Criteria author for a local-first academic PDF
reader + bilingual translator ("Academic PDF Copilot").

Define objective P0 / P1 / P2 acceptance criteria for the next frontend task.

**Do NOT write production code.** Return acceptance criteria only.

---

# TASK — DS-FE-003: Translate Action + Translation Result Viewer

## Goal

Connect the existing real PDF.js reader to the existing real Document + Translation
HTTP API, closing the first complete user-facing loop:

```
Open PDF
→ read original
→ click AI Translate
→ configure translation
→ start a genuine backend translation
→ observe honest progress
→ translation completes
→ read translated PDF
→ switch to bilingual
→ Original | Translation side by side
```

At completion this is the **Usable Client Milestone**.

---

# GROUND TRUTH — WHAT ACTUALLY EXISTS

Everything below was verified by reading the implementation and its tests at commit
`ef17457`. **This is the authoritative contract. Do not invent endpoints, fields, or
states that are not listed here.**

## Verified test baseline

```
backend  → 514 passed
frontend → 48 passed
```

## The working pipeline (real, not mocked)

```
Local PDF
→ backend document API
→ translation HTTP API
→ genuine PDFMathTranslate kernel
→ ONNX layout detection
→ real provider request
→ translated mono PDF
→ dual PDF
```

An end-to-end test drives this against a real loopback provider and asserts the provider
was genuinely called:

```
provider calls : 5
progress events: [(1, 1)]
mono pages     : 1 | dual pages: 2
translated text contains CJK: True
```

## Backend HTTP surface — ACTUAL (all paths prefixed `/api`)

| Method | Path | Status | Notes |
|---|---|---|---|
| POST | `/api/documents` | 201 | **Two request forms** (see below) |
| GET | `/api/documents` | 200 | List |
| GET | `/api/documents/{id}` | 200 | Metadata |
| GET | `/api/documents/{id}/file` | 200 | Original, `application/pdf` |
| GET | `/api/documents/{id}/translated` | 200 | Mono output, N pages |
| GET | `/api/documents/{id}/bilingual` | 200 | Dual output, 2N pages |
| DELETE | `/api/documents/{id}` | 204 | Removes record + derived artifacts |
| POST | `/api/documents/{id}/translate` | 202 | Returns immediately |
| GET | `/api/tasks/{task_id}` | 200 | Snapshot |
| GET | `/api/tasks/{task_id}/events` | 200 | **SSE** |
| POST | `/api/tasks/{task_id}/cancel` | 200 | Page-boundary cancellation |
| POST | `/api/tasks/{task_id}/retry` | **501 always** | Block retry not implemented |
| GET | `/api/profiles` | 200 | Keys masked, never returned |
| POST | `/api/profiles/{id}/test` | 200/5xx | Probe |

### `POST /api/documents` — two forms, both real

* **Multipart upload** — `file` field, `UploadFile`. **This is the browser's path**: the
  browser holds a `File`, never a filesystem path.
* **JSON `{"path": "..."}`** — imports a local file in place, for local callers. Never
  copies or modifies the user's file.

### Document response — actual shape

```json
{ "document_id": "doc_…", "name": "paper.pdf", "page_count": 18,
  "source": "upload" | "path", "has_translation": false,
  "created_at": "2026-09-17T…" }
```

**No filesystem path is ever present in any response.** There is **no** `title`, no
`has_text_layer`, no `ocr_required` field.

### `POST /api/documents/{id}/translate` — request

```json
{ "profile_id": "prof_…", "lang_in": "en", "lang_out": "zh", "engine": "fast" }
```

* The model is `extra="forbid"` — **an unknown field is a 422.**
* Defaults: `lang_in="en"`, `lang_out="zh"`, `engine="fast"`.
* Only `"fast"` is a supported engine (a second engine needs a separate repository).
* **`profile_id` is the only credential reference.** The API key is never sent by a
  client and never returned to one. `GET /api/profiles` exposes `has_key: bool` and
  `api_key_masked`, nothing more.

### Translate response — 202

```json
{ "task_id": "task_…", "document_id": "doc_…", "status": "PENDING" }
```

The request returns immediately; the kernel takes minutes.

### Task response — actual shape

```json
{ "task_id": "task_…", "document_id": "doc_…",
  "status": "PENDING" | "TRANSLATING" | "SUCCESS" | "FAILED" | "CANCELLED",
  "lang_in": "en", "lang_out": "zh", "engine": "fast",
  "progress": { "page": 4, "page_count": 18 },
  "error": { "code": "…", "message": "…" } | null,
  "created_at": "…", "updated_at": "…" }
```

* **`progress` is `null` until the first page reports**, then `{page, page_count}`.
* **`ANALYZING` and `RENDERING` are NEVER emitted.** The contract once listed them, but
  the fast kernel runs one unified pipeline and reports only per page. The implementation
  deliberately refuses to fabricate them.
* **Block counters do not exist and are omitted, not faked.** A test asserts the string
  `blocks_done` appears nowhere in a task payload.

### SSE stream — actual events

```
event: snapshot
data: { …full task payload… }

event: progress
data: {"event":"progress","status":"TRANSLATING","progress":{"page":4,"page_count":18}}

event: done
data: {"event":"done","status":"SUCCESS","page_count":18,"translated_page_count":18}

event: error
data: {"event":"error","status":"FAILED","code":"…","message":"…"}

event: cancelled
data: {"event":"cancelled","status":"CANCELLED"}

: keepalive            ← every 15 s, so a proxy does not close an idle stream
```

The stream **closes itself** after `done` / `error` / `cancelled`. A late subscriber
always receives a `snapshot` first, so it never has to wait for the next page to learn the
current state.

### Error envelope — every error, everywhere

```json
{ "error": { "code": "…", "message": "…", "detail": {…} } }
```

Document/task codes actually emitted: `EMPTY_FILE` (400), `UNSUPPORTED_MEDIA_TYPE` (415),
`SOURCE_INVALID` (422), `PAYLOAD_TOO_LARGE` (413), `NOT_FOUND` (404),
`DOCUMENT_BUSY` (409), `TASK_ALREADY_TERMINAL` (409), `NOT_IMPLEMENTED` (501),
`PROVIDER_ERROR` (502), `INTERNAL_ERROR` (500), `VALIDATION_ERROR` (422).

Provider-probe codes: `PROVIDER_AUTH_FAILED` (502, `detail.http_status` 401 or 403),
`PROVIDER_RATE_LIMITED` (502, 429), `PROVIDER_MODEL_NOT_FOUND` (502),
`PROVIDER_TIMEOUT` (504), `PROVIDER_UNREACHABLE` (502), `PROVIDER_ERROR` (502),
`SERVICE_UNAVAILABLE` (503).

A **failed translation task** carries `error.code` from the kernel (e.g.
`TRANSLATION_SERVICE_ERROR`), or `SOURCE_NOT_FOUND` / `INTERNAL_ERROR` /
`PROCESS_INTERRUPTED`.

### Cancellation — honest, and limited

`POST /cancel` returns `{"task_id", "status": "CANCELLING", "message": "Cancellation
requested. The current page will finish, then translation will halt."}`.

The stored status only becomes `CANCELLED` when the kernel actually stops. Cancelling an
already-terminal task is refused with 409. **Worker threads may be abandoned rather than
force-stopped.**

### `POST /retry` — 501, deliberately

Returns `{"error": {"code": "NOT_IMPLEMENTED", "message": "Block-level retry is not
supported by the translation kernel. Re-run translation via POST
/api/documents/{id}/translate."}}`. A UI must not pretend this capability exists.

---

# FRONTEND — WHAT ALREADY EXISTS

React 18 + TypeScript (strict) + Vite 6 + Tailwind 3 + shadcn/ui + Zustand.

```
src/api/config.ts          API_BASE_URL + apiUrl(path)  ← the only backend-location
                                                           source of truth; no component
                                                           may hardcode a URL
src/pdf/pdfjs.ts           loadPdfjs() — LAZY import, ZOOM_STEPS, clampZoom,
                           FIT_WIDTH_PADDING_PX=32, RENDER_BUFFER_MARGIN_PX=300
src/pdf/PdfWorkspace.tsx   A complete, self-contained reading surface: file picker,
                           drag-drop, empty/loading/error states, toolbar, viewer.
                           Opens a local `File` via `file.arrayBuffer()` → PDF.js.
                           Teardown is on the LOADING TASK (PDF.js 6 has no
                           PDFDocumentProxy.destroy()). Has its own load-token guard.
src/pdf/PdfViewer.tsx      Windowed page stack; owns PDF.js document + viewerRef
src/pdf/PdfToolbar.tsx     Page navigation, zoom, fit-width
src/pdf/PdfPage.tsx        Canvas + text layer per page
src/reader/ReaderWorkspace.tsx   Renders 1 or 2 `PdfWorkspace` panes based on readerMode.
                                 Real DOM restructuring, not relabelling.
src/reader/ReaderModeSwitch.tsx  原文 / 双语 / 译文 segmented control
src/stores/workspace.ts    Zustand. readerMode, sidebarOpen, scope, messages,
                           progress, engine, documentName
src/app/TopBar.tsx         Has an inert `AI翻译` button (no handler) and a document-name
                           display bound to the store
src/app/StatusBar.tsx      Bottom bar with a progress bar + engine indicator
```

**Two facts about the existing code that matter:**

1. `ReaderWorkspace` mounts two `PdfWorkspace` panes, but **`PdfWorkspace` can currently
   only open a local `File` from its own picker**. It has no way to be *given* a document.
   The translation pane must display a PDF fetched from the backend.
2. `src/stores/workspace.ts` currently holds **placeholder progress**
   (`currentPage: 5, pageCount: 18, percent: 72`) and a hardcoded `documentName:
   "paper.pdf"`, both carried over from the DS-FE-001 shell. `StatusBar` renders a `示例`
   ("example") chip to flag them as fake. They must become real or disappear.

## Frozen frontend constraints from earlier tasks

* Initial JS bundle **< 500 kB**. PDF.js is deliberately in its own async chunk
  (measured: 250 kB initial, 483 kB async). Reintroducing an eager PDF.js import
  regresses this.
* Exactly three reader modes, labelled `原文` / `双语` / `译文`, in that order.
* Two panes must remain **independent** — separate loading task, document, zoom, scroll,
  current page. They must not collapse into one shared PDF.js singleton.
* Whole-viewport `overflow: hidden`; panes scroll internally.

---

# KNOWN REALITIES THE CRITERIA MUST RESPECT

* `ANALYZING` and `RENDERING` are not emitted. **Do not require fake phases.**
* Block counters do not exist. **Do not require fake counters.**
* Progress is genuinely page-level. `(1, 1)` on a one-page document is a real value.
* `POST /retry` returns 501. **Do not require pretend retry.**
* The upstream translation cache still does **not** include provider endpoint identity. An
  `ignore_cache` correctness workaround is used server-side. **Do not redesign the cache in
  this task.**
* Provider failure is already bounded by DS-BE-FIX-002 (the backend cannot retry forever).
  **The frontend must not add its own automatic retry loop.**
* **Keyless local OpenAI-compatible providers are fully supported** and were a real bug fix
  in DS-BE-007. A keyless profile is valid; an API key is NOT mandatory, and the frontend
  must not validate "API key must not be empty".
* Cancellation exists only to the extent DS-BE-007 supports it (page boundary; threads may
  be abandoned). The UI must not claim instantaneous termination.
* Mixed-orientation pages may reserve page 1's aspect ratio before rendering, causing slight
  scroll shifts. This is a known, accepted DS-FE-002 limitation. **Do not turn this into a
  mixed-orientation layout rewrite.**
* There is **no password-entry UI** for encrypted PDFs; existing honest failure behaviour
  stays. **Do not implement password management.**

# OUT OF SCOPE — do not write criteria for these

Document Intelligence · Context Engine · Glossary · Academic context translation ·
Paper QA · AI chat · citation retrieval · vector database · Tauri packaging ·
cache redesign · block-level retry · password entry · advanced synchronized scrolling.

---

# THE 40 EVALUATION DIMENSIONS

Evaluate each and assign P0 / P1 / P2 (or state explicitly that it is not applicable):

1. Document registration/upload
2. Translation action
3. Provider profile selection
4. Source language
5. Target language
6. Translation engine
7. Actual API request structure
8. Actual task polling/progress mechanism
9. Honest progress reporting
10. Translation success
11. Translation failure
12. Translated mono PDF retrieval
13. Dual PDF availability
14. Translated PDF.js rendering
15. Original mode
16. Translation mode
17. Bilingual mode
18. Source/translation page association
19. Document identity
20. Stale async-result protection
21. Switching documents
22. Retranslating
23. Backend unavailable
24. Provider 401/403
25. Provider 429
26. Provider 5xx
27. Timeout
28. Bounded failure behaviour
29. Translated-file-not-found behaviour
30. Object URL cleanup
31. PDF.js lifecycle cleanup
32. Original source immutability
33. No credential leakage
34. Responsive desktop layout
35. Loading/error/empty states
36. Accessibility
37. Regression protection
38. Bundle-size regression
39. Automated tests
40. Real-browser E2E verification

---

# SPECIFIC DESIGN QUESTIONS THE CRITERIA SHOULD SETTLE

1. **How does a local `File` become a backend document?** The browser holds a `File`, not
   a path. Which request form must the frontend use?
2. **Must the reader wait for backend registration before the PDF renders?** The product
   premise is that you can start reading immediately.
3. **What is `Translate` disabled on, exactly?** No document? Registration in flight?
   A task already running? A completed translation (retranslate)?
4. **How is a translation result associated with a document** such that opening document B
   while A is translating can never show A's result as B's translation? This is believed to
   be the single most likely defect in this task.
5. **Before any translation exists, which reader modes are available?**
6. **What happens to an in-flight translation when the user switches documents** — discard,
   keep, or block the switch?
7. **Bilingual mode uses original + mono, or the dual PDF?** (Note the dual artifact is 2N
   interleaved pages — that has a bearing on the answer.)
8. **How should progress be expressed when the backend has a page count but the value is
   `(1, 1)`, `(0, N)`, or `null`?**
9. **What must the failure surface say for a provider auth failure vs a timeout vs an
   unreachable backend**, given the codes listed above?
10. **Does the translated pane need its own toolbar/zoom, or share state with the original?**
11. **What must happen to the previous translation's object URL and PDF.js loading task on
    retranslation, document switch, and component teardown?**
12. **What is acceptable behaviour if the translated page count differs from the original's?**
13. **What exactly must be true for the "no credential leakage" criterion to be objectively
    testable?** (Consider: rendered DOM, request payloads, request headers, console output,
    and the fact that `GET /api/profiles` returns masked values only.)

---

# OUTPUT FORMAT

Return:

1. **P0 criteria** — numbered, each objectively verifiable, each with a short rationale.
   P0 means: the task is not DONE if this fails.
2. **P1 criteria** — important, but the task can be accepted without them.
3. **P2 criteria** — desirable polish.
4. **Explicitly not applicable** — dimensions from the 40 above that do not apply, and why.
5. **Any premise you believe is wrong**, stated plainly. If the ground truth above
   contradicts what the task should be, say so rather than writing criteria around it.

Be specific about observable behaviour — what the user sees, what request is sent, what
state results. Avoid criteria that cannot be checked by a test or by a person using the app.
