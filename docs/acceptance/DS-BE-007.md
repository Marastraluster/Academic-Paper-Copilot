# DS-BE-007 — Acceptance Criteria (FROZEN)

> **Author:** Gemini 3.8 Flash (High) via Antigravity CLI — *independent Acceptance Criteria Agent*  
> **Authored:** 2026-09-17, **before any implementation code was written**  
> **Scope:** Document management and translation HTTP API (`/api/documents`, `/api/tasks`), multipart upload & read-only serving, background execution off the event loop, honest per-page progress reporting, dual progress transport (SSE + snapshot polling), cooperative cancellation, artifact serving, error envelope mapping, strict secret & filesystem containment, offline isolated testing.  
>
> **FROZEN.** DeepSeek may not silently weaken or delete any criterion (brief §10). Only P0 blocks completion.

---

# Acceptance Criteria: DS-BE-007 — Document + Translation HTTP API

- **Task ID**: `DS-BE-007`
- **Role**: Independent Acceptance Criteria Agent
- **Status**: Defined prior to implementation (**FROZEN**)
- **Scope**:
  - Expose document import (`multipart/form-data` upload and optional JSON-path import), read-only original file streaming, derived artifact streaming (`mono` and `dual`), and document deletion matching [`docs/API_CONTRACT.md §2`](file:///D:/marti/SciPrograms/docs/API_CONTRACT.md#L44-L75).
  - Expose translation task dispatch (`POST /api/documents/{id}/translate`), task snapshot polling (`GET /api/tasks/{id}`), live progress events over SSE (`GET /api/tasks/{id}/events`), cooperative task cancellation (`POST /api/tasks/{id}/cancel`), and explicit refusal of unsupported block retry (`POST /api/tasks/{id}/retry`) matching [`docs/API_CONTRACT.md §5`](file:///D:/marti/SciPrograms/docs/API_CONTRACT.md#L137-L179).
  - Non-blocking asynchronous dispatch: translate requests return immediately with HTTP **202 Accepted**; synchronous, blocking kernel execution runs strictly off the asyncio event loop.
  - Progress honesty: progress is reported truthfully per page as emitted by the kernel. Block counts (`blocks_done`, `blocks_total`) and artificial stages (`ANALYZING`, `RENDERING`) are strictly omitted.
  - Database schema migration to `SCHEMA_VERSION = 3` adding `documents` and `translation_tasks` tables with transactional atomicity.
  - Source PDF immutability: original files are never altered or corrupted, and external user paths are never deleted on document removal.
  - Strict secret containment: provider API keys are never stored in document or task tables, never returned in API responses, never emitted in SSE events, and redacted from structured logs.
  - 100% offline, isolated test suite in [`backend/tests/test_api_documents.py`](file:///D:/marti/SciPrograms/backend/tests/test_api_documents.py) with zero regressions across existing backend (488 tests) and frontend (48 tests) suites.
- **Explicit Exclusions**:
  - Modifying the translation kernel ([`backend/app/pdfkernel/`](file:///D:/marti/SciPrograms/backend/app/pdfkernel)): the kernel is already verified and frozen; this task wraps it without altering it.
  - LLM adapter modifications ([`backend/app/llm/`](file:///D:/marti/SciPrograms/backend/app/llm/)) and OS credential store modifications ([`backend/app/security/`](file:///D:/marti/SciPrograms/backend/app/security/)).
  - Frontend reader integration (DS-FE-003: this backend task is the prerequisite for DS-FE-003).
  - Paper QA ([`docs/API_CONTRACT.md §6`](file:///D:/marti/SciPrograms/docs/API_CONTRACT.md#L181-L214)), Glossary ([`docs/API_CONTRACT.md §4`](file:///D:/marti/SciPrograms/docs/API_CONTRACT.md#L117-L135)), Chat ([`docs/API_CONTRACT.md §7`](file:///D:/marti/SciPrograms/docs/API_CONTRACT.md#L216-L224)).
- **Permitted File Modifications**:
  - `backend/app/api/documents.py` (new route handlers for documents and tasks)
  - `backend/app/documents/**` (new document store, task manager, models)
  - `backend/app/db.py` (migration `003_create_documents_and_tasks`, `SCHEMA_VERSION = 3`)
  - `backend/app/main.py`, `backend/app/api/__init__.py` (router registration and store initialization)
  - `backend/app/config.py` (adding `documents_dir` and `max_upload_bytes` settings)
  - `backend/tests/test_api_documents.py` (new comprehensive offline test suite)
  - `backend/tests/test_db.py`, `backend/tests/test_isolation.py` (pinned table assertion updates for migration 3)
  - `.agent/tasks/DS-BE-007.md`, `.agent/evidence/DS-BE-007.md`
- **Target Runtime**: Python 3.12.13 (`backend/.venv`) on Windows 11.
- **Priority Tags**:
  - `[P0]`: **MUST** — Blocks completion of this task.
  - `[P1]`: **SHOULD** — Strongly recommended; does not block completion if deferred with documented rationale.
  - `[P2]`: **OPTIONAL** — Architectural hooks or future-facing extension items.

---

## Design Decisions (Settling Q1 – Q7)

The following explicit, verifiable rules settle the seven core architectural and behavioural design questions:

### Q1. Where Do Uploaded Files and Outputs Live? Original Deletion Semantics
- **Configurable Storage Root**:
  All files managed by the application reside under a configurable directory:
  `Settings.documents_dir: Path = Field(default_factory=lambda: default_data_dir() / "documents")`.
- **Directory Layout per Document**:
  Each document receives an isolated subdirectory named strictly by its opaque `document_id`:
  `<documents_dir>/<document_id>/`
  - Original source PDF: `<documents_dir>/<document_id>/source.pdf`
  - Translated mono output: `<documents_dir>/<document_id>/mono.pdf`
  - Translated bilingual output: `<documents_dir>/<document_id>/dual.pdf`
  - Temporary translation working directory: `<documents_dir>/<document_id>/.pdfkernel-<random>/` (purged on completion or failure).
- **Import Modes & `is_upload` Tracking**:
  - **Multipart Upload (`is_upload = 1`)**: The uploaded file stream from the browser is saved into `<documents_dir>/<document_id>/source.pdf`. The user's client-side file on their local operating system remains completely separate and inaccessible.
  - **Path Import (`is_upload = 0`)**: The database records `source_path` pointing to the user-supplied external file (e.g. `D:\papers\policy.pdf`). The source file remains in place.
- **Original Deletion Semantics (`DELETE /api/documents/{id}`)**:
  - **External Path-Imported Document (`is_upload = 0`)**: The external file `source_path` on the user's filesystem **MUST NEVER BE DELETED, MODIFIED, OR RENAMED**. Only the database record and the managed directory `<documents_dir>/<document_id>/` (containing any derived `mono.pdf`, `dual.pdf`, or cached files) are removed.
  - **Multipart-Uploaded Document (`is_upload = 1`)**: Calling DELETE removes the database record and purges the document directory `<documents_dir>/<document_id>/` (including the internal copy `source.pdf` and derived outputs). No file outside `<documents_dir>/<document_id>/` is ever touched.
- **Path Traversal Hardening**:
  Supplied filenames from multipart headers or JSON paths are strictly sanitized. Basenames are extracted via `Path(name).name`; directory traversal sequences (`..`, leading slashes, path separators) are rejected or stripped. Filesystem paths are never reflected back in API responses.

### Q2. Task Execution Model & Crash Recovery
- **Execution Model**:
  - `POST /api/documents/{id}/translate` is non-blocking. It constructs the translation task, writes initial state to SQLite, and launches a background coroutine via `asyncio.create_task`.
  - The coroutine executes the synchronous, CPU-blocking [`translate_pdf`](file:///D:/marti/SciPrograms/backend/app/pdfkernel/adapter.py) inside a worker thread using `asyncio.to_thread` or an explicit `ThreadPoolExecutor`.
  - The HTTP request handler immediately returns HTTP **202 Accepted** with payload `{"task_id": "...", "document_id": "...", "status": "PENDING"}`.
- **Task Concurrency per Document**:
  - Exactly **one** translation task may be active (`PENDING` or `TRANSLATING`) for a given `document_id` at any time.
  - Attempting to initiate a concurrent translation on a document already being translated returns HTTP **409 Conflict** (`code: "DOCUMENT_BUSY"`).
- **Process Exit & Crash Recovery**:
  - Because tasks execute off-loop in the local process, an abrupt process termination (kill, crash, system reboot) terminates in-flight execution.
  - **Lifespan Startup Reconciliation**: During application startup in `lifespan`, the task store scans SQLite: any task recorded with status `PENDING` or `TRANSLATING` is transitioned to `FAILED` with normalized error code `"PROCESS_INTERRUPTED"` and message `"Translation was interrupted by a backend restart."`.
- **Non-Existent Tasks**:
  - Requesting `GET /api/tasks/{task_id}` or `GET /api/tasks/{task_id}/events` for a `task_id` not present in SQLite returns HTTP **404 Not Found** with error code `"NOT_FOUND"`.

### Q3. Status Vocabulary & Honest Progress
- **Truthful Status Vocabulary**:
  The task status state machine implements **only** states that are truthfully distinguishable by the kernel:
  `PENDING` $\rightarrow$ `TRANSLATING` $\rightarrow$ `SUCCESS` | `FAILED` | `CANCELLED`
- **Strict Prohibition of Invented Stages**:
  The contract mentions `ANALYZING` and `RENDERING`. The underlying fast kernel executes layout analysis, page rendering, translation, and font injection in a unified pipeline and exposes **only per-page progress callbacks**. Therefore, reporting `ANALYZING` or `RENDERING` is **FABRICATION** and is strictly prohibited.
- **Block Count Omission**:
  Per [`docs/API_CONTRACT.md §5`](file:///D:/marti/SciPrograms/docs/API_CONTRACT.md#L173-L178), per-block counting is not implemented by the kernel. Therefore, `blocks_done` and `blocks_total` counters **MUST BE OMITTED** from progress payloads (or set to `None`), never fabricated as fake numbers or `0/0`.
- **Progress Payload Shape**:
  Progress reported in snapshots and SSE events consists strictly of real page counters:
  `"progress": {"page": <int>, "page_count": <int>}`.

### Q4. Progress Transport: Dual SSE + Snapshot Polling
- **Both Transports Are Required**:
  1. **SSE (`GET /api/tasks/{task_id}/events`)**: Required by [`docs/API_CONTRACT.md §5`](file:///D:/marti/SciPrograms/docs/API_CONTRACT.md#L143). Provides live reactive streaming for the frontend without client polling loops. Emits `event: progress`, `event: done`, `event: error`, and `event: cancelled`. Closes gracefully upon reaching terminal state.
  2. **Snapshot Polling (`GET /api/tasks/{task_id}`)**: Required for initial state synchronization, reconnection after network drops, and post-completion artifact inspection.
- **Kernel Callback Forwarding**:
  A thread-safe callback bridges the kernel's per-page tqdm/progress updates to the asyncio event loop, updating SQLite and publishing to connected SSE subscriber queues.

### Q5. Cancellation Semantics & Honest Promises
- **Cooperative Per-Page Boundary Guarantee**:
  - The translation kernel polls cancellation once per page; an in-flight page cannot be interrupted mid-paragraph.
  - Calling `POST /api/tasks/{task_id}/cancel`:
    - If task is `PENDING`: Cancelled immediately $\rightarrow$ status becomes `CANCELLED`.
    - If task is `TRANSLATING`: Sets a cancellation flag (`asyncio.Event`). Returns HTTP **200 OK** (or 202) with:
      `{"task_id": "...", "status": "CANCELLING", "message": "Cancellation requested. The current page will finish, then translation will halt."}`.
    - When the current page finishes, the kernel checks the cancel sentinel, stops processing subsequent pages, cleans up `.pdfkernel-*` working directories, and transitions task status to `CANCELLED`.
    - If task is already terminal (`SUCCESS`, `FAILED`, `CANCELLED`), returns HTTP **409 Conflict** (`code: "TASK_ALREADY_TERMINAL"`).

### Q6. Retry Semantics: Explicit Refusal of Unsupported Block Retry
- **No Block-Level Retry in Kernel**:
  The verified fast translation kernel translates entire documents and has no block-level retry or resumption capability.
- **Honesty Rule**:
  `POST /api/tasks/{task_id}/retry` MUST NOT pretend to retry failed blocks, nor silently re-run the entire document under a misleading endpoint name.
- **Response**:
  Calling `POST /api/tasks/{task_id}/retry` returns HTTP **501 Not Implemented** with standard error envelope:
  `code: "NOT_IMPLEMENTED"`, `message: "Block-level retry is not supported by the translation kernel. Re-run translation via POST /api/documents/{id}/translate."`.

### Q7. Upload Limits & Failure Modes
- **Limits**:
  - Maximum upload size: **100 MiB** (`104,857,600` bytes), configured via `Settings.max_upload_bytes = 104_857_600`.
- **Validation Failure Modes**:
  - File exceeds 100 MiB: HTTP **413 Payload Too Large**, `code: "PAYLOAD_TOO_LARGE"`.
  - Non-PDF file (invalid MIME type or missing `%PDF-` header magic): HTTP **415 Unsupported Media Type**, `code: "UNSUPPORTED_MEDIA_TYPE"`.
  - Empty file (0 bytes): HTTP **400 Bad Request**, `code: "EMPTY_FILE"`.
  - Corrupted or unparseable PDF (PyMuPDF `fitz.open` fails): HTTP **422 Unprocessable Entity**, `code: "SOURCE_INVALID"`.

---

## 1. Priority P0 (MUST) — Core Functional, Security & Error Criteria (Blocks Completion)

| ID | Priority | Description & Verification Target |
| :--- | :--- | :--- |
| **AC-01** | `[P0]` | **Database Migration 003 & Table Schemas (Q1, R10)**<br>Bump `SCHEMA_VERSION` from `2` to `3` in [`backend/app/db.py`](file:///D:/marti/SciPrograms/backend/app/db.py). Migration `003_create_documents_and_tasks` creates tables `documents` and `translation_tasks` inside a database transaction. If migration fails, transaction rolls back leaving no half-applied schema. `test_db.py` and `test_isolation.py` assert `tables == ["documents", "profiles", "schema_version", "translation_tasks"]`. |
| **AC-02** | `[P0]` | **Multipart Upload Import (`POST /api/documents`) (Q1, Q7, R1)**<br>Accepts `multipart/form-data` with form field `file`. Generates opaque `document_id` matching `doc_<uuid4_hex[:12]>`. Saves source bytes into `<documents_dir>/<document_id>/source.pdf`. Uses `fitz.open()` to extract `title` (from PDF metadata or sanitized filename), `page_count` ($\ge 1$), and detects if a text layer is present. Inserts record into `documents` table with `is_upload = 1`. Returns HTTP **201 Created** with JSON: `{"document_id": "...", "title": "...", "page_count": N, "has_text_layer": bool, "ocr_required": bool}`. |
| **AC-03** | `[P0]` | **JSON Path Import (`POST /api/documents`) (Q1, R1)**<br>Accepts `application/json` with payload `{"path": "<absolute_path>"}`. Validates that `path` exists, is a readable regular file, and ends with `.pdf`. Inserts record with `is_upload = 0` and `source_path = str(path)`. Returns HTTP **201 Created** with metadata. Non-existent path returns HTTP **400 Bad Request** (`code: "BAD_REQUEST"`). |
| **AC-04** | `[P0]` | **Upload Validation & Rejection Envelope (Q7, R1)**<br>Validates upload before processing:<br>1. Upload exceeding 100 MiB returns HTTP **413 Payload Too Large** (`code: "PAYLOAD_TOO_LARGE"`).<br>2. Non-PDF files (e.g. `.txt`, `.docx`, or binary without `%PDF-` header) return HTTP **415 Unsupported Media Type** (`code: "UNSUPPORTED_MEDIA_TYPE"`).<br>3. Empty file (0 bytes) returns HTTP **400 Bad Request** (`code: "EMPTY_FILE"`).<br>4. Corrupt PDF unparseable by `fitz` returns HTTP **422 Unprocessable Entity** (`code: "SOURCE_INVALID"`).<br>All rejections adhere strictly to the standard error envelope. |
| **AC-05** | `[P0]` | **List Documents Endpoint (`GET /api/documents`)**<br>Returns HTTP **200 OK** with JSON list of all imported documents sorted by `created_at DESC`. Each entry contains `document_id`, `title`, `page_count`, `has_text_layer`, `ocr_required`, `has_translated: bool`, `has_bilingual: bool`, `created_at`. Returns empty list `[]` when library is empty. Never exposes raw filesystem paths. |
| **AC-06** | `[P0]` | **Get Document Metadata (`GET /api/documents/{id}`)**<br>Returns HTTP **200 OK** with document detail for `{id}`. If `{id}` does not exist, returns HTTP **404 Not Found** with error envelope `{"error": {"code": "NOT_FOUND", "message": "...", "detail": {}}}`. |
| **AC-07** | `[P0]` | **Serve Original File Read-Only (`GET /api/documents/{id}/file`) (R2)**<br>Streams the original PDF file with HTTP **200 OK**, `Content-Type: application/pdf`, `Content-Disposition: inline`. Delivered bytes match original input byte-for-byte (`sha256` identical). The source file on disk is opened strictly read-only and is never modified. Unknown `{id}` returns HTTP **404 Not Found**. |
| **AC-08** | `[P0]` | **Start Translation Background Task (`POST /api/documents/{id}/translate`) (Q2, R3)**<br>Accepts JSON: `{"profile_id": "...", "lang_in": "en", "lang_out": "zh", "engine": "fast", "ignore_cache": false}`. Resolves profile credentials via `ProfileStore.to_provider_config(profile_id)`. Verifies layout model is cached. Spawns translation coroutine via `asyncio.create_task` and returns immediately with HTTP **202 Accepted** (or 201/200) containing `{"task_id": "task_<hex>", "document_id": "...", "status": "PENDING"}`. The HTTP response completes in $< 100\text{ ms}$; execution runs asynchronously off the event loop. |
| **AC-09** | `[P0]` | **Translation Pre-Flight Validations & Concurrency Guard (Q2)**<br>1. If `document_id` does not exist: HTTP **404 Not Found** (`NOT_FOUND`).<br>2. If `profile_id` does not exist: HTTP **400 Bad Request** or **404 Not Found** (`NOT_FOUND` / `PROFILE_NOT_FOUND`).<br>3. If a task for `document_id` is already in `PENDING` or `TRANSLATING`: HTTP **409 Conflict** (`code: "DOCUMENT_BUSY"`).<br>4. If layout model is missing from local cache: fails fast with HTTP **503 Service Unavailable** (`code: "LAYOUT_MODEL_UNAVAILABLE"`). |
| **AC-10** | `[P0]` | **Task Snapshot Endpoint (`GET /api/tasks/{task_id}`) (Q2, Q3, R4)**<br>Returns HTTP **200 OK** with JSON snapshot: `task_id`, `document_id`, `status` (`PENDING | TRANSLATING | SUCCESS | FAILED | CANCELLED`), `progress: {"page": int, "page_count": int}`, `error: dict | null`, `created_at`, `updated_at`. If `task_id` is unknown, returns HTTP **404 Not Found** (`NOT_FOUND`). |
| **AC-11** | `[P0]` | **Honest Progress Reporting & Zero Block Fabrication (Q3, R8)**<br>Task progress strictly reflects kernel page callback counters (`page` and `page_count`). `blocks_done` and `blocks_total` counters **MUST BE OMITTED** from JSON payloads. The status never enters `ANALYZING` or `RENDERING`. |
| **AC-12** | `[P0]` | **SSE Progress Event Stream (`GET /api/tasks/{task_id}/events`) (Q4)**<br>Returns HTTP **200 OK** with `Content-Type: text/event-stream`, `Cache-Control: no-cache`. Streams progress updates as they occur:<br>- On page completion: `event: progress\ndata: {"status":"TRANSLATING","page":P,"page_count":N}\n\n`<br>- On success: `event: done\ndata: {"status":"SUCCESS","mono_pages":N,"dual_pages":2N}\n\n`<br>- On failure: `event: error\ndata: {"error":{"code":"...","message":"...","detail":{...}}}\n\n`<br>- On cancel: `event: cancelled\ndata: {"status":"CANCELLED"}\n\n`<br>Closes connection cleanly after terminal event (`done`, `error`, `cancelled`). If task is already terminal when client connects, emits the terminal event and closes immediately. Unknown task returns HTTP **404 Not Found**. |
| **AC-13** | `[P0]` | **Serve Translated Mono PDF (`GET /api/documents/{id}/translated`) (R5)**<br>Streams the translated monolingual PDF artifact (`mono.pdf`) with HTTP **200 OK**, `Content-Type: application/pdf`. Monolingual PDF page count $N_{\text{mono}}$ equals original source page count $N_{\text{source}}$ exactly ($N_{\text{mono}} == N_{\text{source}}$). If translation is not yet completed or failed, returns HTTP **404 Not Found** (`code: "TRANSLATION_NOT_FOUND"` or `"NOT_FOUND"`). |
| **AC-14** | `[P0]` | **Serve Bilingual Dual PDF (`GET /api/documents/{id}/bilingual`) (R5)**<br>Streams the bilingual interleaved PDF artifact (`dual.pdf`) with HTTP **200 OK**, `Content-Type: application/pdf`. Dual PDF page count $N_{\text{dual}}$ equals exactly twice the source page count ($N_{\text{dual}} == 2 \times N_{\text{source}}$). If bilingual artifact is not yet available, returns HTTP **404 Not Found**. |
| **AC-15** | `[P0]` | **Cryptographic Source PDF Immutability (R2, R9)**<br>The original source PDF file hash `sha256` and file modification time `st_mtime` are cryptographically verified before and after translation across all exit conditions (success, provider failure, cancellation). Under no circumstance is the source PDF overwritten or modified. |
| **AC-16** | `[P0]` | **Kernel Error Envelope Normalization (R6)**<br>Every failure raised by `app.pdfkernel` (`PDFKernelError` subclasses) is normalized directly onto the error envelope with its stable `.code` and `.detail`. Provider auth failures map to `PROVIDER_AUTH_FAILED`, rate limits to `PROVIDER_RATE_LIMITED`, timeouts to `PROVIDER_TIMEOUT`, service aborts to `TRANSLATION_SERVICE_ERROR`. Raw upstream exception text, tracebacks, and library internals are never sent to the client. Bounded retries terminate promptly. |
| **AC-17** | `[P0]` | **Strict Secret & Credential Containment (R7)**<br>Plaintext API keys never appear in any response body from `/api/documents` or `/api/tasks`, never appear in SSE event data, are never written to `documents` or `translation_tasks` database columns, and are redacted to `"[REDACTED]"` in structured log outputs. |
| **AC-18** | `[P0]` | **Cooperative Task Cancellation (`POST /api/tasks/{task_id}/cancel`) (Q5)**<br>1. If task is `PENDING`: transitions immediately to `CANCELLED`.<br>2. If task is `TRANSLATING`: sets cancellation flag, returns HTTP **200 OK** with `status: "CANCELLING"`. At the next page boundary, the kernel aborts, deletes `.pdfkernel-*` temporary files, and sets task status to `CANCELLED`.<br>3. If task is already in terminal state (`SUCCESS`, `FAILED`, `CANCELLED`): returns HTTP **409 Conflict** (`code: "TASK_ALREADY_TERMINAL"`). |
| **AC-19** | `[P0]` | **Delete Document Semantics (`DELETE /api/documents/{id}`) (Q1)**<br>Removes document record and associated tasks from SQLite. If document was imported by path (`is_upload = 0`), the external file on disk is left untouched. If document was uploaded (`is_upload = 1`), internal directory `<documents_dir>/<document_id>/` is removed. Derived artifacts (`mono.pdf`, `dual.pdf`) are purged. Returns HTTP **204 No Content**. If `{id}` does not exist, returns HTTP **404 Not Found**. |
| **AC-20** | `[P0]` | **Filesystem Containment & Anti-Traversal (Q1)**<br>Uploaded filenames and JSON paths are strictly validated. Directory traversal attacks (e.g. `../../etc/passwd`, `C:\Windows\...`) are blocked. Internal filesystem paths are never returned to clients in JSON payloads. |
| **AC-21** | `[P0]` | **Block Retry Refusal (`POST /api/tasks/{task_id}/retry`) (Q6)**<br>Invoking `POST /api/tasks/{task_id}/retry` returns HTTP **501 Not Implemented** with `{"error": {"code": "NOT_IMPLEMENTED", "message": "Block-level retry is not supported by the translation kernel. Re-run translation via POST /api/documents/{id}/translate.", "detail": {}}}`. |
| **AC-22** | `[P0]` | **Process Restart Task Reconciliation (Q2)**<br>During application startup in `lifespan`, any tasks found in `translation_tasks` with status `PENDING` or `TRANSLATING` are transitioned to `FAILED` with `code: "PROCESS_INTERRUPTED"`. |
| **AC-23** | `[P0]` | **Offline Isolated Test Suite (R10)**<br>All tests in [`backend/tests/test_api_documents.py`](file:///D:/marti/SciPrograms/backend/tests/test_api_documents.py) execute 100% offline using `TestClient` with temporary SQLite and isolated temporary storage directory. Upstream PDF pipeline is mocked in unit tests. All 488 existing backend tests and 48 frontend tests continue to pass. |

---

## 2. Priority P1 (SHOULD) — Operational Quality & Consistency (Non-Blocking)

| ID | Priority | Description & Verification Target |
| :--- | :--- | :--- |
| **AC-24** | `[P1]` | **Cache Bypass Forwarding (`ignore_cache`)**<br>`POST /api/documents/{id}/translate` accepts optional `"ignore_cache": bool` (defaults to `false`). When `true`, it is passed directly to `translate_pdf(..., ignore_cache=True)`, bypassing upstream's provider-blind cache. |
| **AC-25** | `[P1]` | **SSE Connection Drop & Reconnect Resilience**<br>If an SSE client disconnects mid-stream, the background translation task continues unimpeded. A subsequent connection to `GET /api/tasks/{task_id}/events` or polling `GET /api/tasks/{task_id}` receives current progress or terminal status. |
| **AC-26** | `[P1]` | **Request Correlation ID Echo**<br>All responses from `/api/documents` and `/api/tasks` endpoints echo the `X-Request-ID` header from the incoming request (or generate a UUID4 if absent). |
| **AC-27** | `[P1]` | **OCR Required Detection on Import**<br>During document import, if PyMuPDF inspects all pages and finds 0 text characters (e.g. scanned image PDF), the document record sets `ocr_required = true` and `has_text_layer = false`. If text is present, `ocr_required = false`. |
| **AC-28** | `[P1]` | **Document Language Parameters**<br>`POST /api/documents/{id}/translate` validates `lang_in` and `lang_out`. Defaults `lang_in` to `"en"` and `lang_out` to `"zh"`. Unsupported engine strings (anything other than `"fast"`) return HTTP **400 Bad Request** (`code: "ENGINE_UNSUPPORTED"`). |

---

## 3. Priority P2 (OPTIONAL) — Future Extensions & Hooks (Non-Blocking)

| ID | Priority | Description & Verification Target |
| :--- | :--- | :--- |
| **AC-29** | `[P2]` | **Configurable Worker Concurrency Pool**<br>Settings provides `max_concurrent_translations: int = 2`. If active translations reach the ceiling, subsequent translation requests queue in `PENDING` until a slot becomes free. |
| **AC-30** | `[P2]` | **Overwrite Existing Translation Outputs**<br>If a document has already been translated, calling `POST /api/documents/{id}/translate` with `"overwrite": true` replaces existing `mono.pdf` and `dual.pdf` artifacts rather than failing with an error. |

---

## 4. Expected Automated Tests

The test suite in [`backend/tests/test_api_documents.py`](file:///D:/marti/SciPrograms/backend/tests/test_api_documents.py) must be runnable via `pytest` and include at minimum the following automated test cases:

| ID | Test Name | Purpose / Assertions | Priority |
| :--- | :--- | :--- | :--- |
| **AC-31.01** | `test_multipart_upload_creates_document_and_returns_201` | Uploads valid 2-page PDF via multipart; asserts 201 Created, `document_id` format, `page_count == 2`, `has_text_layer == true`. | `[P0]` |
| **AC-31.02** | `test_json_path_import_creates_document_and_returns_201` | Imports valid PDF via JSON path; asserts 201 Created and `is_upload == 0`. | `[P0]` |
| **AC-31.03** | `test_upload_rejects_file_exceeding_max_bytes_with_413` | Submits payload > 100 MiB; asserts 413 `PAYLOAD_TOO_LARGE` envelope. | `[P0]` |
| **AC-31.04** | `test_upload_rejects_non_pdf_mime_or_magic_with_415` | Submits `.txt` file; asserts 415 `UNSUPPORTED_MEDIA_TYPE` envelope. | `[P0]` |
| **AC-31.05** | `test_upload_rejects_empty_file_with_400` | Submits 0-byte file; asserts 400 `EMPTY_FILE` envelope. | `[P0]` |
| **AC-31.06** | `test_upload_rejects_corrupt_pdf_with_422` | Submits corrupted PDF binary; asserts 422 `SOURCE_INVALID` envelope. | `[P0]` |
| **AC-31.07** | `test_list_documents_returns_all_sorted` | Imports multiple documents; asserts `GET /api/documents` returns sorted list with correct metadata. | `[P0]` |
| **AC-31.08** | `test_get_document_metadata_success_and_404` | Asserts `GET /api/documents/{id}` returns 200 for existing and 404 `NOT_FOUND` for missing. | `[P0]` |
| **AC-31.09** | `test_serve_original_file_read_only_and_byte_identical` | Fetches `/file`; asserts status 200, `Content-Type: application/pdf`, bytes match `sha256(source)`. | `[P0]` |
| **AC-31.10** | `test_translate_returns_202_immediately_with_task_id` | `POST /translate` returns 202 Accepted in $< 100\text{ ms}$; task status is `PENDING`. | `[P0]` |
| **AC-31.11** | `test_translate_fails_fast_404_on_missing_document` | `POST /api/documents/doc_missing/translate` returns 404 `NOT_FOUND`. | `[P0]` |
| **AC-31.12** | `test_translate_fails_fast_on_missing_profile` | `POST /translate` with missing `profile_id` returns 400/404. | `[P0]` |
| **AC-31.13** | `test_translate_rejects_concurrent_task_with_409` | Initiating translation while document has active task returns 409 `DOCUMENT_BUSY`. | `[P0]` |
| **AC-31.14** | `test_translate_fails_fast_503_if_layout_model_missing` | Missing layout model fails fast with 503 `LAYOUT_MODEL_UNAVAILABLE` before running worker. | `[P0]` |
| **AC-31.15** | `test_task_snapshot_reports_honest_progress_without_blocks` | Asserts snapshot `progress` has `page` and `page_count`; asserts `blocks_done` is omitted. | `[P0]` |
| **AC-31.16** | `test_task_snapshot_status_never_enters_analyzing_or_rendering` | Verifies task status sequence transitions only through `PENDING` $\rightarrow$ `TRANSLATING` $\rightarrow$ `SUCCESS`. | `[P0]` |
| **AC-31.17** | `test_sse_events_stream_progress_and_done` | Connects to `/events`; receives `progress` events per page and terminal `done` event. | `[P0]` |
| **AC-31.18** | `test_serve_mono_and_dual_artifacts_page_counts` | Asserts `/translated` has $N$ pages; asserts `/bilingual` has $2N$ pages. | `[P0]` |
| **AC-31.19** | `test_serve_artifacts_returns_404_before_translation` | Asserts `/translated` and `/bilingual` return 404 when translation has not run. | `[P0]` |
| **AC-31.20** | `test_source_pdf_is_cryptographically_identical_after_translation` | Asserts `sha256(source)` is byte-identical before and after successful translation. | `[P0]` |
| **AC-31.21** | `test_kernel_error_mapped_to_normalized_envelope` | Mocked provider 401 returns `TRANSLATION_SERVICE_ERROR` with `PROVIDER_AUTH_FAILED` detail. | `[P0]` |
| **AC-31.22** | `test_zero_secrets_in_responses_db_and_logs` | Verifies API key does not appear in task snapshot, SSE events, database tables, or log capture. | `[P0]` |
| **AC-31.23** | `test_cancel_pending_task_marks_cancelled` | Cancelling `PENDING` task transitions immediately to `CANCELLED`. | `[P0]` |
| **AC-31.24** | `test_cancel_translating_task_cooperatively_halts_and_cleans_up` | Cancelling `TRANSLATING` task halts at page boundary, purges `.pdfkernel-*`, marks `CANCELLED`. | `[P0]` |
| **AC-31.25** | `test_cancel_terminal_task_returns_409` | Calling `/cancel` on `SUCCESS` or `FAILED` task returns 409 `TASK_ALREADY_TERMINAL`. | `[P0]` |
| **AC-31.26** | `test_delete_document_preserves_external_file` | Deleting path-imported document leaves external file on disk untouched; removes DB record. | `[P0]` |
| **AC-31.27** | `test_delete_uploaded_document_purges_internal_directory` | Deleting multipart document purges `<documents_dir>/<id>` and all derived artifacts. | `[P0]` |
| **AC-31.28** | `test_retry_endpoint_returns_501_not_implemented` | `POST /api/tasks/{task_id}/retry` returns 501 `NOT_IMPLEMENTED`. | `[P0]` |
| **AC-31.29** | `test_startup_reconciles_interrupted_tasks_to_failed` | Tasks in SQLite with `TRANSLATING` at startup transition to `FAILED` (`PROCESS_INTERRUPTED`). | `[P0]` |

---

## 5. Failure Conditions (FCs) — Anti-Patterns & Prohibitions

Any of the following behaviors constitutes a failure of task DS-BE-007:

- **FC-01 (Event Loop Blocking)**: Invoking synchronous kernel translation (`translate_pdf` or upstream functions) directly in the async request thread, causing FastAPI's event loop to stall.
- **FC-02 (External File Mutation / Deletion)**: Overwriting, moving, or deleting a user's original source file located outside the application's internal document storage directory.
- **FC-03 (Secret Leakage)**: Returning a plaintext provider API key in any document or task response, writing an API key to the SQLite database, or emitting a secret in SSE event data or log outputs.
- **FC-04 (Progress Inflation & Stage Fabrication)**: Reporting artificial stages such as `ANALYZING` or `RENDERING`, or reporting fabricated per-block counters (`blocks_done`, `blocks_total`) that the kernel does not measure.
- **FC-05 (Path Traversal Vulnerability)**: Permitting arbitrary filesystem access via `..` sequences, absolute paths, or unvalidated filenames in upload or path import parameters.
- **FC-06 (Internal Path Leakage)**: Exposing local server filesystem paths (e.g. `C:\Users\...` or `/var/...`) in JSON response payloads to the client.
- **FC-07 (Unbounded Retry Hangs)**: Failing to respect bounded provider retry limits, resulting in requests hanging for minutes on provider errors.
- **FC-08 (Dangling Working Files on Cancel)**: Leaving temporary working directories (`.pdfkernel-*`) or orphaned partial files on disk after cancellation or failure.
- **FC-09 (Half-Applied Schema Migration)**: Modifying the database schema without a transactional migration, leaving a corrupted schema on failure.
- **FC-10 (Fake Block Retry)**: Implementing `POST /tasks/{id}/retry` as a fake mock or silently re-running the full translation while calling it block retry.
- **FC-11 (Kernel Code Modification)**: Altering any code inside [`backend/app/pdfkernel/`](file:///D:/marti/SciPrograms/backend/app/pdfkernel/) instead of consuming its existing public API.
- **FC-12 (Environment Contamination)**: Writing test artifacts to the user's real database, default data directory, or operating system credential store.
