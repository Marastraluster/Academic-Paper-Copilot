# Evidence — DS-BE-001 Backend Foundation

- **Date:** 2026-09-16
- **Agent:** DeepSeek (Claude Code CLI)
- **Acceptance criteria:** `docs/acceptance/DS-BE-001.md` (Gemini, frozen before implementation)
- **Verdict:** **DONE — 37/37 criteria PASS, 7/7 failure conditions avoided**

## Modified Files

All new. Nothing outside `backend/` was touched.

| Area | Files |
|---|---|
| Application | `backend/app/{__init__,main,config,errors,logging,db}.py` |
| API | `backend/app/api/{__init__,health}.py` |
| Tests | `backend/tests/{conftest,test_health,test_errors,test_db,test_logging,test_config,test_isolation}.py` |
| Project | `backend/pyproject.toml`, `backend/README.md`, `backend/.env.example` |

**Forbidden-path compliance (AC-24):** `frontend/` was not modified. Verified by mtime rather
than by assertion — the newest frontend source file is timestamped **12:35** (from DS-FE-001),
while the oldest backend file is **18:52**. No frontend file was touched, and its 27 tests
still pass.

## Tests Run

```
$ cd backend && .venv/Scripts/python -m pytest
   → 94 passed, 1 warning in 1.81s

$ cd frontend && npm run test
   → 5 files, 27 tests, all passed        (AC-24 regression check)

$ # live server
$ .venv/Scripts/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --no-server-header --no-date-header
```

The single warning is emitted by Starlette's own `testclient.py` (a deprecated `anyio` alias
inside a third-party library), not by this codebase.

## Manual / Runtime Verification

Executed against a real uvicorn process, not mocks.

```
# AC-39.3 health
$ curl -i http://127.0.0.1:8000/api/health
HTTP/1.1 200 OK
content-length: 33
content-type: application/json
x-request-id: 4f8edfd4-1d16-457b-bec3-c31320aeee37
{"status":"ok","version":"0.1.0"}

# AC-39.4 error envelope
$ curl http://127.0.0.1:8000/api/invalid
{"error":{"code":"NOT_FOUND","message":"Not Found","detail":{}}}
$ curl -X POST http://127.0.0.1:8000/api/health
{"error":{"code":"METHOD_NOT_ALLOWED","message":"Method Not Allowed","detail":{}}}

# AC-28 / AC-39.2 network boundary
$ netstat -ano | grep :8000 | grep LISTEN
  TCP    127.0.0.1:8000        0.0.0.0:0              LISTENING       28012
        ^^^^^^^^^^^ bound to loopback only — NOT 0.0.0.0

# AC-15 client-supplied correlation id
$ curl -i -H "X-Request-ID: test-req-42" http://127.0.0.1:8000/api/health
x-request-id: test-req-42

# AC-32 no server banner
(only content-length, content-type, x-request-id present — no `Server:` header)

# AC-33 latency, 100 sequential requests
p50=14.42ms  p95=25.21ms  max=40.72ms        (budget: p95 ≤ 50ms)

# AC-34 cold start, process spawn → first successful response
579ms                                        (budget: ≤ 1500ms)

# AC-35 bootstrap overhead, 10 runs
mean=5.3ms  max=7.2ms                        (budget: ≤ 100ms)

# AC-36 startup console output
{"message": "Backend started", "app": "Academic PDF Copilot", "version": "0.1.0",
 "address": "http://127.0.0.1:8000",
 "database_path": "C:\\Users\\marti\\AppData\\Local\\AcademicPDFCopilot\\db.sqlite3"}

# AC-37 /docs
GET /docs → 200 with DEBUG=true; openapi.json lists exactly ['/api/health']
GET /docs → 404 with DEBUG=false

# AC-39.5 database on disk, created by the running app
journal_mode: wal
tables      : ['schema_version']
schema rows : [(1, '2026-09-16T10:55:34.069033+00:00')]
```

## Acceptance Criteria Evaluation

### 1. Functional

| AC | P | Verdict | Evidence |
|---|---|---|---|
| AC-01 Clean importability, no side effects | P0 | **PASS** | Subprocess test: `import app.main` creates no DB file, writes nothing to stdout/stderr. `test_importing_the_app_creates_no_database`, `..._emits_no_log_output` |
| AC-02 Single documented startup command | P0 | **PASS** | `backend/README.md` documents the uvicorn command; asserted by `test_readme_documents_a_single_startup_command` |
| AC-03 Loopback binding default | P0 | **PASS** | Default `127.0.0.1:8000`; confirmed live via `netstat` |
| AC-04 Health endpoint | P0 | **PASS** | 200, `application/json`, `{"status":"ok","version":"0.1.0"}`, semver-asserted |
| AC-05 SQLite bootstrap, WAL, idempotent | P0 | **PASS** | WAL + `foreign_keys=ON` asserted; repeat bootstrap leaves rows byte-identical |
| AC-06 Zero product tables | P0 | **PASS** | `['schema_version']` only — asserted in-test and observed on the real on-disk DB |
| AC-07 Configurable path, per-user default | P0 | **PASS** | `DATABASE_PATH` honoured; default under `%LOCALAPPDATA%\AcademicPDFCopilot` |
| AC-08 Structured logging + request id | P0 | **PASS** | JSON lines with `timestamp, level, request_id, method, path, status_code` |
| AC-09 Environment-driven settings | P0 | **PASS** | Safe defaults asserted; env overrides asserted |
| AC-10 `.env.example` | P0 | **PASS** | Documents all six variables; contains no secret and no real user path |
| AC-11 Minimal pinned manifest | P0 | **PASS** | fastapi/uvicorn/pytest/httpx/keyring present; torch/onnxruntime/opencv/chromadb/openai/pdf2zh asserted absent |
| AC-12 Pytest harness, offline | P0 | **PASS** | 94 tests, exit 0; autouse socket guard fails any non-loopback connection |

### 2. Edge cases

| AC | P | Verdict | Evidence |
|---|---|---|---|
| AC-13 Missing parent directories | P0 | **PASS** | `tmp/deep/nested/` created automatically |
| AC-14 Spaces/Unicode in path | P1 | **PASS** | `张 伟/my documents/db.sqlite3` bootstraps and runs WAL |
| AC-15 Request id adoption/generation | P1 | **PASS** | Supplied id echoed; absent id → valid UUID4; unique across 10 calls; **also verified on the 500 path**, which bypasses the request middleware |
| AC-16 Invalid env var type | P1 | **PASS** | `PORT=invalid_int` and out-of-range ports raise at construction |
| AC-17 Concurrent reads / busy timeout | P1 | **PASS** | `busy_timeout=5000`; 25 reads alongside an open writer |
| AC-18 Graceful shutdown | P2 | **PASS** | Lifespan closes the connection; asserted by executing against it after exit |

### 3. Error handling

| AC | P | Verdict | Evidence |
|---|---|---|---|
| AC-19 Envelope shape everywhere | P0 | **PASS** | Explicitly asserted that FastAPI's `{"detail": "Not Found"}` shape is gone |
| AC-20 404 | P0 | **PASS** | `code=NOT_FOUND`, `detail={}` |
| AC-21 405 | P0 | **PASS** | `code=METHOD_NOT_ALLOWED` |
| AC-22 422 with structured detail | P0 | **PASS** | `code=VALIDATION_ERROR`, `detail.errors[]` populated |
| AC-23 500 with zero leakage | P0 | **PASS** | Injected `RuntimeError("… sk-live-DEADBEEF… C:\secret\path.py")` — response asserted free of the secret, `Traceback`, `RuntimeError`, file paths and `site-packages` |

### 4. Regression protection

| AC | P | Verdict | Evidence |
|---|---|---|---|
| AC-24 Frontend suite preserved | P0 | **PASS** | 27/27 pass; no frontend file modified (mtime evidence above) |
| AC-25 No upstream cache/config pollution | P0 | **PASS** | `~/.cache/pdf2zh` mtime unchanged (yesterday's install); `~/.config/PDFMathTranslate` does not exist; plus a source-level grep guard |
| AC-26 Test database isolation | P0 | **PASS** | Every test uses a `tmp_path` DB; default user DB asserted unchanged |
| AC-27 Python 3.12 compatibility | P0 | **PASS** | Everything runs on 3.12.13; sources compiled under 3.12 in-test |

### 5. Security

| AC | P | Verdict | Evidence |
|---|---|---|---|
| AC-28 Non-loopback refused | P0 | **PASS** | Five non-loopback hosts rejected at config time; enforced on the real env-var path too; `netstat` confirms loopback binding |
| AC-29 Secret redaction in logs | P0 | **PASS** | Key-based and content-based (`Bearer …`, `key=value`) redaction; end-to-end test sends credentials in headers and asserts none appear in captured logs |
| AC-30 No plaintext secrets in repo | P0 | **PASS** | Repo-wide scan clean; defaults asserted secret-free |
| AC-31 No wildcard CORS | P0 | **PASS** | `*` rejected, including inside a list; defaults are local origins only |
| AC-32 No server banner | P1 | **PASS** | `--no-server-header`; live response carries no `Server:` header |

### 6. Performance

| AC | P | Verdict | Evidence |
|---|---|---|---|
| AC-33 Health latency p95 ≤ 50 ms | P1 | **PASS** | p95 = 25.21 ms over 100 requests |
| AC-34 Cold start < 1.5 s | P1 | **PASS** | 579 ms |
| AC-35 Bootstrap < 100 ms | P1 | **PASS** | mean 5.3 ms, max 7.2 ms |

### 7. UI/UX (developer-facing)

| AC | P | Verdict | Evidence |
|---|---|---|---|
| AC-36 Informative startup output | P1 | **PASS** | Logs app name, version, bound address and resolved DB path |
| AC-37 `/docs` in development | P2 | **PASS** | 200 with `DEBUG=true`, 404 with `DEBUG=false`, both asserted |

### 8-9. Automated / manual tests

AC-38.1 … AC-38.13 and AC-39.1 … AC-39.6: **all PASS**, each mapped to a test above or a
runtime command in the section preceding this table.

### 10. Failure conditions

| FC | Verdict |
|---|---|
| FC-01 Scope creep (no provider/PDF/document tables or routes) | **AVOIDED** — openapi lists only `/api/health`; DB lists only `schema_version` |
| FC-02 Non-loopback / wildcard CORS | **AVOIDED** — rejected at config time, confirmed by `netstat` |
| FC-03 Contract breach | **AVOIDED** — health and every error path asserted against the frozen envelope |
| FC-04 Secret exposure | **AVOIDED** — redaction tested at unit and end-to-end level; repo scan clean |
| FC-05 Test DB contamination | **AVOIDED** — default user DB asserted unchanged before/after |
| FC-06 Upstream cache/config contamination | **AVOIDED** — mtime check plus a source grep guard |
| FC-07 Python target mismatch | **AVOIDED** — all code runs on 3.12.13 |

**Result: 37/37 PASS. No FAIL, no NOT_APPLICABLE.**

## Known Limitations

1. **No git baseline commit exists.** The repository still has zero commits, so `git diff` —
   named the source of truth by the brief — reports nothing. Every file is untracked, which
   makes the mandated diff review unenforceable. **This needs a user decision.** Until then,
   "no unrelated file modifications" is evidenced by mtime rather than by diff.
2. **The database connection is thread-affine.** SQLite refuses to use a connection from a
   thread other than the one that created it; the lifespan creates it on the event-loop
   thread. Every current endpoint is `async def` and therefore stays on that thread. A future
   *synchronous* (`def`) endpoint would be dispatched to a worker thread and fail immediately.
   This is now pinned by `test_database_connection_is_confined_to_one_thread` so the
   constraint cannot be violated silently.
3. **`pydantic-settings` is one dependency beyond AC-11's literal list.** Justified in the
   frozen AC review (`docs/acceptance/DS-BE-001.md`): AC-09 names it, and it is what makes
   AC-16 (fail-fast on a malformed `PORT`) robust rather than hand-rolled.
4. **Running the server created the real user database** at
   `%LOCALAPPDATA%\AcademicPDFCopilot\db.sqlite3`. That is the intended production behaviour
   (AC-07), not test leakage — the test suite provably never touches it.
5. **No CORS preflight test.** CORS is configured with an explicit allow-list and asserted
   wildcard-free by configuration, but no test exercises an actual OPTIONS preflight, because
   the frontend does not call the backend yet (that begins in DS-BE-002).
6. **Third-party deprecation warning.** Starlette's `testclient.py` uses a deprecated `anyio`
   alias. Not actionable from this codebase; recorded so it is not mistaken for a defect here.

## Unblocked Next Task

**DS-BE-002 — `LLMProvider` interface + Chat Completions adapter.** The backend now has
somewhere to put it, an error envelope to reuse, redaction so provider keys cannot leak into
logs, and a test harness that runs offline. `keyring` is already verified working
(`WinVaultKeyring` active on this machine) for DS-BE-005.
