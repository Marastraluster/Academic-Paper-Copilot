# DS-BE-001 — Acceptance Criteria (FROZEN)

> **Author:** Gemini 3.8 Flash (High) via Antigravity CLI — *independent Acceptance Criteria Agent*
> **Authored:** 2026-09-15, **before any implementation code was written**
> **Model invocation:** `agy -p <prompt> --model gemini-3.8-flash-high --output-format text`
> **Prompt:** `.agent/tasks/_gemini-prompt-DS-BE-001.md`
> **Raw model output:** `.agent/tasks/_gemini-ac-DS-BE-001.raw.md`
>
> **FROZEN.** DeepSeek may not silently weaken or delete any criterion (brief §10).

---

## Acceptance Criteria Review — DeepSeek (before implementation)

**Verdict: accepted as-is. No `AC_CHANGE_REQUEST`.**

| Observation | Assessment |
|---|---|
| AC-01 forbids import-time side effects | Correct, and directly informed by the Phase 0 finding that upstream runs `init_db()` at import (`REPO_AUDIT` §9). DB creation moves to lifespan startup. |
| FC-06 / AC-25 forbid touching `~/.cache/pdf2zh/` or `~/.config/PDFMathTranslate/` | Correct isolation from the upstream library, which owns those paths. |
| AC-26 / FC-05 forbid tests touching the real user database | Essential; enforced via an injected settings object plus a `tmp_path` database. |
| AC-11 permits only FastAPI/uvicorn/pytest/httpx/keyring, barring PDF/OCR/AI libraries | Satisfied. `pydantic-settings` is additionally included: AC-09 names it explicitly and it is what makes AC-16 (fail-fast on a malformed `PORT`) robust rather than hand-rolled. Recorded here because it is one dependency beyond AC-11's literal list. |
| AC-32 (no `Server:` banner) | Requires explicitly disabling uvicorn's server header — noted, not a conflict. |
| AC-38.13 (suite passes fully offline) | Implementable with a socket guard fixture. Worth doing: this backend must never reach the network on its own. |
| AC-37 (`/docs` reachable) | P2, enabled in development mode only. |

**Implementation notes recorded at review time** (reminders, not AC changes):

1. DB bootstrap must run in the **lifespan** handler, never at import (AC-01).
2. `Settings` must be injectable so tests can point `DATABASE_PATH` at `tmp_path` before the
   app is constructed (AC-26).
3. `pythonpath = ["."]` in pytest config so `import app` resolves from `backend/`.

---

# Acceptance Criteria: DS-BE-001 — Backend Foundation

- **Task ID**: `DS-BE-001`
- **Scope**: Greenfield FastAPI backend scaffold, SQLite bootstrap, structured logging, error envelope, configuration, and pytest test harness.
- **Target Runtime**: Python 3.12.13 (`backend/.venv`) on Windows 11 (Loopback only: `127.0.0.1`).
- **Priority Tags**:
  - `[P0]`: **MUST** — Blocks completion of this task.
  - `[P1]`: **SHOULD** — Strongly recommended; does not block completion if deferred with documentation.
  - `[P2]`: **OPTIONAL** — Non-blocking backlog / enhancement item.

---

## 1. Functional Acceptance Criteria

| ID | Priority | Description & Verification Target |
| :--- | :--- | :--- |
| **AC-01** | `[P0]` | **Application Package Structure & Clean Importability**<br>The backend application source code is housed under `backend/app/` with an `__init__.py` file making it an importable Python package. Running `python -c "import app"` or `python -c "from app.main import app"` succeeds with return code `0` and emits zero top-level side effects (no automatic DB file creation, network calls, or logging on import). |
| **AC-02** | `[P0]` | **Single Documented Startup Command**<br>The application can be started locally via a single documented command using the virtual environment interpreter from the `backend/` directory: e.g. `uvicorn app.main:app --host 127.0.0.1 --port 8000` (or `python -m uvicorn app.main:app`). The command is documented in `backend/README.md`. |
| **AC-03** | `[P0]` | **Strict Loopback Binding Default**<br>When booted with default settings, the server binds strictly to IPv4 loopback `127.0.0.1` and port `8000`. Default configuration files, environment variables, or CLI defaults must never default to `0.0.0.0` or `::`. |
| **AC-04** | `[P0]` | **Health Check Endpoint (`GET /api/health`)**<br>Sending `GET http://127.0.0.1:8000/api/health` returns HTTP status `200 OK`, `Content-Type: application/json`, and body:<br>`{"status": "ok", "version": "<semver>"}`<br>where `status` is literal `"ok"`, and `version` matches SemVer regex `^\d+\.\d+\.\d+.*$`. |
| **AC-05** | `[P0]` | **SQLite Bootstrap & WAL Mode**<br>The database bootstrap module initializes the SQLite database at the configured path upon application startup. It executes `PRAGMA journal_mode=WAL;` (returning `"wal"`) and `PRAGMA foreign_keys=ON;`. It idempotently creates a metadata schema table (e.g. `schema_version` with `version INTEGER PRIMARY KEY`, `applied_at TIMESTAMP`). Running the bootstrap repeatedly against the same DB file produces no errors and does not alter existing data. |
| **AC-06** | `[P0]` | **Zero Product Tables**<br>Inspecting the database schema after bootstrap reveals strictly only the metadata/version tracking table. Tables for `documents`, `pages`, `sections`, `paragraphs`, `glossary`, `profiles`, `translation_tasks`, `chat_sessions`, `chat_messages`, or FTS5 indexes must **not** exist. |
| **AC-07** | `[P0]` | **Configurable Database Path with Safe User Default**<br>The SQLite database file location is configurable via the `DATABASE_PATH` environment variable. When unset, it defaults to a standard per-user local application directory (on Windows: `%LOCALAPPDATA%\<app_name>\db.sqlite3` or equivalent user home directory). The bootstrap creates missing parent directories automatically if they do not exist. |
| **AC-08** | `[P0]` | **Structured Logging with Request ID**<br>All application log records are emitted as structured lines (single-line JSON or structured key-value) to `stdout`/`stderr`. Every incoming HTTP request logs an event containing at minimum: `timestamp` (ISO 8601), `level`, `request_id` (UUID4 string or propagated header), `method`, `path`, and `status_code`. |
| **AC-09** | `[P0]` | **Settings Management via Environment**<br>Application settings load from environment variables (e.g. via `pydantic-settings` or dedicated config module). All variables provide safe defaults (`HOST=127.0.0.1`, `PORT=8000`, `LOG_LEVEL=INFO`). No credentials or sensitive values exist in source code defaults. |
| **AC-10** | `[P0]` | **Environment Template File (`.env.example`)**<br>A `.env.example` file is placed in `backend/` documenting every supported environment variable (e.g. `HOST`, `PORT`, `DATABASE_PATH`, `LOG_LEVEL`, `CORS_ORIGINS`). It contains zero real secrets or actual user paths. |
| **AC-11** | `[P0]` | **Minimal Pinned Dependency Manifest**<br>Dependencies are specified in a project manifest (`pyproject.toml` or `requirements.txt`) targeting Python 3.12. Core dependencies are pinned: `fastapi`, `uvicorn`, `pytest`, `httpx`, and `keyring`. No extraneous or speculative libraries (no PDF extractors, OCR libraries, or AI SDKs) are included. |
| **AC-12** | `[P0]` | **Automated Pytest Suite Runner**<br>Running `pytest` from the `backend/` directory using `backend/.venv` executes the test harness using FastAPI's test client (`httpx` / `TestClient`). Tests execute with zero network access and complete with code `0`. |

---

## 2. Edge Cases

| ID | Priority | Description & Verification Target |
| :--- | :--- | :--- |
| **AC-13** | `[P0]` | **Non-Existent Database Parent Directory**<br>When `DATABASE_PATH` points to a path where parent directories do not exist (e.g. `C:\Users\...\AppData\Local\CustomDir\nested\db.sqlite3`), the bootstrap automatically creates all missing parent directories without raising `FileNotFoundError` or crashing. |
| **AC-14** | `[P1]` | **Spaces and Unicode in Database Path**<br>When `DATABASE_PATH` contains spaces, non-ASCII characters, or typical Windows path characters (e.g. `C:\Users\张伟\AppData\Local\DeepShelf\data.sqlite3`), the SQLite connection and bootstrap succeed without string encoding errors. |
| **AC-15** | `[P1]` | **Client-Supplied vs. Missing `X-Request-ID`**<br>- If an incoming request includes `X-Request-ID: test-req-42`, the backend adopts this ID in structured logs and echoes `X-Request-ID: test-req-42` in the response headers.<br>- If the request lacks `X-Request-ID`, the backend generates a valid UUIDv4, uses it in logs, and includes it in response headers. |
| **AC-16** | `[P1]` | **Invalid Environment Variable Types**<br>Providing an invalid type for a numeric setting (e.g. `PORT=invalid_int`) causes the application to fail fast at startup with a clear stderr error message and non-zero exit code, rather than starting in a degraded state. |
| **AC-17** | `[P1]` | **Concurrent Local Database Reads**<br>Concurrent calls to the health check or database read operations during bootstrap do not raise `sqlite3.OperationalError: database is locked`. SQLite busy timeout is configured to at least `5.0` seconds. |
| **AC-18** | `[P2]` | **Graceful Shutdown Signal Handling**<br>Sending `SIGINT` (Ctrl+C) or `SIGTERM` to the running backend cleanly shuts down the server, releases open SQLite file handles, and leaves no stale lock files or uncommitted transactions. |

---

## 3. Error Handling Criteria

| ID | Priority | Description & Verification Target |
| :--- | :--- | :--- |
| **AC-19** | `[P0]` | **Standard Error Envelope Shape**<br>Every error response across the entire API (HTTP 4xx and 5xx) strictly conforms to the JSON envelope:<br>```json<br>{<br>  "error": {<br>    "code": "<STRING_CODE>",<br>    "message": "<Human-readable message>",<br>    "detail": {}<br>  }<br>}<br>```<br>Responses must never return bare strings, raw HTML, or FastAPI's default `{ "detail": "..." }` shape. |
| **AC-20** | `[P0]` | **Route Not Found (HTTP 404)**<br>Requesting an unmapped URL (e.g. `GET /api/unknown`) returns HTTP status `404 Not Found` with body:<br>`code` = `"NOT_FOUND"`, `message` = non-empty string, `detail` = `{}` or path details. |
| **AC-21** | `[P0]` | **Method Not Allowed (HTTP 405)**<br>Requesting a valid URL with an invalid verb (e.g. `POST /api/health`) returns HTTP status `405 Method Not Allowed` with body:<br>`code` = `"METHOD_NOT_ALLOWED"`, `message` = non-empty string, `detail` = `{}`. |
| **AC-22** | `[P0]` | **Request Validation Error (HTTP 422)**<br>Requesting any endpoint with invalid query or body parameters returns HTTP status `422 Unprocessable Entity` with body:<br>`code` = `"VALIDATION_ERROR"`, `message` = descriptive summary string, `detail` = structured validation error list/object identifying the invalid parameters. |
| **AC-23** | `[P0]` | **Unhandled Server Exception (HTTP 500) & Zero Leakage**<br>Any unexpected exception raised during request processing is caught by a global exception handler. The client receives HTTP status `500 Internal Server Error` with body:<br>```json<br>{<br>  "error": {<br>    "code": "INTERNAL_ERROR",<br>    "message": "An internal error occurred.",<br>    "detail": {}<br>  }<br>}<br>```<br>**Zero Information Leakage**: The response body and headers must contain NO Python tracebacks, file paths, line numbers, variable values, or environment details. |

---

## 4. Regression Protection

| ID | Priority | Description & Verification Target |
| :--- | :--- | :--- |
| **AC-24** | `[P0]` | **Frontend Test Suite Preserved (27/27 Passing)**<br>No files in `frontend/` or `src/` are modified or deleted. Executing the frontend test command (e.g. `pnpm test` or `npm test`) completes with all 27 existing tests passing. |
| **AC-25** | `[P0]` | **Zero Upstream Cache/Config Directory Pollution**<br>The backend code and tests must not read, write, create, or inspect `~/.cache/pdf2zh/` or `~/.config/PDFMathTranslate/`. These upstream directories remain completely untouched. |
| **AC-26** | `[P0]` | **Absolute Test Database Isolation**<br>The pytest suite overrides the database path to an isolated directory (e.g. `tmp_path` fixture or `:memory:`). Running `pytest` does not create, read, modify, or delete the developer's default database file located in `%LOCALAPPDATA%` or user home. |
| **AC-27** | `[P0]` | **Python 3.12 Runtime Compatibility**<br>All backend code runs successfully under Python 3.12.13. No language features or syntax specific to Python 3.13+ (e.g. enhanced REPL features, new standard library additions) are used. |

---

## 5. Security Criteria

| ID | Priority | Description & Verification Target |
| :--- | :--- | :--- |
| **AC-28** | `[P0]` | **Hard Prohibition on Non-Loopback Interfaces**<br>The backend application code and startup script configuration strictly reject or disallow binding to `0.0.0.0` or public network adapters. Network probes from external hosts to the backend port are rejected/drop. |
| **AC-29** | `[P0]` | **Secret Redaction in Structured Logs**<br>Logging filters or formatters inspect all logged messages and structured parameters. Any key matching `api_key`, `authorization`, `token`, `secret`, or `password` (case-insensitive) has its value redacted to `"[REDACTED]"`. Plaintext HTTP `Authorization` headers (e.g. `Bearer ...`) must never appear in log outputs. |
| **AC-30** | `[P0]` | **No Plaintext Secrets in Repository**<br>No API keys, passwords, or active authentication tokens are present in any commit, code file, default configuration value, or test file. |
| **AC-31** | `[P0]` | **Restrictive Local CORS Policy (No Wildcards)**<br>If CORS middleware is configured, `allow_origins` must **never** contain wildcard `"*"`. Allowed origins must be restricted strictly to local frontend origins (e.g. `["http://localhost:5173", "http://127.0.0.1:5173", "tauri://localhost"]`). |
| **AC-32** | `[P1]` | **Server Banner Information Disclosure**<br>The backend does not expose unnecessary server banner headers (e.g. `Server: uvicorn`) revealing server internals, or sanitizes them. |

---

## 6. Performance Expectations

| ID | Priority | Description & Verification Target |
| :--- | :--- | :--- |
| **AC-33** | `[P1]` | **Health Check Latency**<br>Under local single-client execution via `httpx`, `GET /api/health` responds in $\le$ 50 ms (p95) over 100 consecutive requests. |
| **AC-34** | `[P1]` | **Application Startup Time**<br>Cold start of the FastAPI application process until it is ready to accept HTTP traffic on `127.0.0.1:8000` is under 1.5 seconds on local developer machine. |
| **AC-35** | `[P1]` | **Database Bootstrap Overhead**<br>SQLite initialization and metadata table check/migration complete in under 100 ms on application startup. |

---

## 7. UI/UX Criteria

| ID | Priority | Description & Verification Target |
| :--- | :--- | :--- |
| **AC-36** | `[P1]` | **Clean Developer Console Output**<br>When launched from the command line, the backend outputs clear, informative console lines showing:<br>- App name and version.<br>- Bound address: `http://127.0.0.1:8000`.<br>- Resolved database path.<br>No unhandled warning spam or cryptic tracebacks during startup. |
| **AC-37** | `[P2]` | **Local Interactive Documentation (`/docs`)**<br>When running in development mode, `GET http://127.0.0.1:8000/docs` (Swagger UI) is reachable locally and accurately displays the `/api/health` endpoint and the schema for the error envelope. |

---

## 8. Suggested Automated Tests

The test suite in `backend/tests/` should be runnable via `pytest` and contain at minimum the following automated test cases:

| ID | Test Name | Purpose / Assertions | Priority |
| :--- | :--- | :--- | :--- |
| **AC-38.1** | `test_health_endpoint` | Asserts `GET /api/health` returns status `200`, JSON content type, and body `{"status": "ok", "version": <semver>}`. | `[P0]` |
| **AC-38.2** | `test_error_envelope_404` | Asserts `GET /api/does_not_exist` returns status `404` and matches error envelope with `code: "NOT_FOUND"`. | `[P0]` |
| **AC-38.3** | `test_error_envelope_405` | Asserts `POST /api/health` returns status `405` and matches error envelope with `code: "METHOD_NOT_ALLOWED"`. | `[P0]` |
| **AC-38.4** | `test_error_envelope_422` | Sends invalid parameter to a validated route; asserts status `422` and matches error envelope with `code: "VALIDATION_ERROR"` and structured `detail`. | `[P0]` |
| **AC-38.5** | `test_unhandled_exception_sanitization` | Injects a test route raising `RuntimeError("DB_SECRET_KEY leaked")`; asserts status `500`, envelope `code: "INTERNAL_ERROR"`, message `"An internal error occurred."`, and verifies the secret text and stack trace are **absent** from response. | `[P0]` |
| **AC-38.6** | `test_sqlite_bootstrap_wal_and_meta` | Bootstraps DB in a `tmp_path`; executes `PRAGMA journal_mode;` (asserts `"wal"`), checks `schema_version` table exists and contains initial version. | `[P0]` |
| **AC-38.7** | `test_sqlite_bootstrap_idempotent` | Calls bootstrap function twice on the same DB file; asserts no exception raised and metadata table remains intact. | `[P0]` |
| **AC-38.8** | `test_zero_product_tables` | Queries `SELECT name FROM sqlite_master WHERE type='table';` on bootstrapped DB; asserts no tables named `documents`, `profiles`, `tasks`, `chats`, etc. | `[P0]` |
| **AC-38.9** | `test_sqlite_creates_parent_dirs` | Sets `DATABASE_PATH` to `tmp_path / "deep" / "nested" / "db.sqlite3"`; runs bootstrap; asserts file and parent directories are created. | `[P0]` |
| **AC-38.10** | `test_test_isolation_user_dir_clean` | Checks user default data directory before and after running test suite; verifies no DB files were created or modified outside `tmp_path`. | `[P0]` |
| **AC-38.11** | `test_request_id_in_logs_and_headers` | Sends request with `X-Request-ID: abc`; verifies response header `X-Request-ID: abc` and captured log record contains `"request_id": "abc"`. Sends request without header; verifies generated UUID4 in header and logs. | `[P0]` |
| **AC-38.12** | `test_log_redaction_of_sensitive_fields` | Logs a record containing `{"api_key": "sk-12345", "token": "secret"}`; verifies captured log output replaces values with `"[REDACTED]"`. | `[P0]` |
| **AC-38.13** | `test_offline_execution` | Configures socket mock / blocks external networking during test run; verifies 100% of test suite passes completely offline. | `[P0]` |

---

## 9. Suggested Manual Tests

| ID | Test Procedure | Expected Verification Result | Priority |
| :--- | :--- | :--- | :--- |
| **AC-39.1** | **Venv Verification & Launch**<br>1. Open terminal in `backend/`.<br>2. Run `.venv\Scripts\python -V`.<br>3. Run documented start command (e.g. `.venv\Scripts\uvicorn app.main:app --host 127.0.0.1 --port 8000`). | Python version reports `3.12.13`. App starts and reports binding to `http://127.0.0.1:8000`. | `[P0]` |
| **AC-39.2** | **Network Boundary Probe**<br>1. Obtain machine LAN IP (e.g. `192.168.x.x`).<br>2. Attempt `curl http://192.168.x.x:8000/api/health` from host or separate local device. | Connection is refused immediately; confirms no binding on `0.0.0.0`. | `[P0]` |
| **AC-39.3** | **Health Endpoint Curl Verification**<br>Run `curl -i http://127.0.0.1:8000/api/health`. | HTTP `200 OK`, JSON headers, body `{"status": "ok", "version": "0.1.0"}`. | `[P0]` |
| **AC-39.4** | **Error Envelope Curl Verification**<br>Run `curl -i http://127.0.0.1:8000/api/invalid`.<br>Run `curl -X POST -i http://127.0.0.1:8000/api/health`. | Both return HTTP 404/405 with standard `{ "error": { "code": ..., "message": ..., "detail": {} } }`. | `[P0]` |
| **AC-39.5** | **SQLite DB Inspection on Disk**<br>1. Locate created database file in default `%LOCALAPPDATA%` directory.<br>2. Open file with `sqlite3` CLI tool.<br>3. Run `PRAGMA journal_mode;` and `.tables`. | Journal mode outputs `wal`. Table list shows only `schema_version`. Zero product tables exist. | `[P0]` |
| **AC-39.6** | **Frontend Regression Check**<br>In project root, run frontend test suite (e.g. `npm test` or `pnpm test`). | All 27 existing tests pass untouched with zero failures. | `[P0]` |

---

## 10. Explicit Failure Conditions

The implementation **FAILS** if any of the following conditions occur:

- **FC-01 (Scope Creep)**: The implementation creates routes, database tables, models, or logic for PDF processing, documents, pages, sections, provider profiles, credentials, translation tasks, chat sessions, or FTS5 indices.
- **FC-02 (Interface Exposure)**: The application binds to `0.0.0.0`, `::`, or any non-loopback network interface, or CORS middleware is configured with wildcard `*`.
- **FC-03 (Contract Breach)**: `GET /api/health` returns any structure other than `{"status": "ok", "version": "<semver>"}` with HTTP 200, or any error response returns bare strings, raw HTML, default FastAPI detail wrappers, or unhandled tracebacks.
- **FC-04 (Secret Exposure)**: Passwords, tokens, API keys, or `Authorization` headers appear unredacted in application logs, console output, or committed repository files.
- **FC-05 (Test Database Contamination)**: Executing `pytest` writes to, modifies, or deletes the real user database file in `%LOCALAPPDATA%` or user home.
- **FC-06 (Upstream Cache/Config Contamination)**: Code interacts with or creates files in `~/.cache/pdf2zh/` or `~/.config/PDFMathTranslate/`.
- **FC-07 (Python Target Mismatch)**: Backend fails to execute cleanly in `backend/.venv` (Python 3.12.13) or uses Python 3.13+ syntax.
