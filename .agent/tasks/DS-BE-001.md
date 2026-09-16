# DS-BE-001 — Backend Foundation

- **Phase:** 2 (LLM Provider) — prerequisite
- **Status:** AC authoring — implementation NOT started
- **Owner:** DeepSeek (implementation) · Gemini (acceptance criteria)
- **Created:** 2026-09-15

## Goal

Establish the minimum runnable FastAPI backend that every remaining phase builds on: an app
that starts, binds to loopback, exposes a health endpoint, persists to SQLite, returns a
consistent error shape, logs without leaking secrets, and has a working test harness.

This task deliberately builds **no product features**. Its value is that everything after it
has somewhere to live and a way to be tested.

## Product Context

Academic PDF Copilot is a local-first desktop tool: a PDF reader with lossless bilingual
translation and an AI paper assistant. The frontend shell already exists (DS-FE-001,
38/38 criteria passed). `backend/app/` is currently **empty — zero files**.

The frontend already centralises its backend URL in `src/api/config.ts` at
`http://127.0.0.1:8000` and issues **no** requests yet. This task creates the service that
address will eventually reach.

## Technical Context

- **Python 3.12.13** via `backend/.venv`. The machine default (3.14.6) is outside the pinned
  upstream's supported range — every backend command must use the venv interpreter.
- **FastAPI + SQLite**, per brief §15 and `docs/ARCHITECTURE.md` §3.
- The architecture doc defines this layer as local-only and never exposed beyond the machine.
- Later phases add: provider profiles, credentials (keyring), documents, translation tasks,
  chat. The foundation must not preclude them, and must not pre-build them.

**Relevant existing behaviour:**
- `docs/ARCHITECTURE.md` §4.7 — API keys go to the OS keyring; SQLite stores only an alias.
  Nothing in this task may persist a secret.
- `docs/API_CONTRACT.md` §0 — the error envelope shape is already specified:

```json
{ "error": { "code": "PROVIDER_AUTH_FAILED", "message": "...", "detail": { } } }
```

- `docs/API_CONTRACT.md` §1 — `/api/health` returns `{"status":"ok","version":"..."}`.

## Files Allowed To Modify

```
backend/**                          (entire subtree — currently empty apart from .venv)
.agent/tasks/DS-BE-001.md
.agent/evidence/DS-BE-001.md
```

## Files Forbidden To Modify

```
frontend/**                         (complete and verified; do not touch)
docs/**                             (contracts already frozen for this task)
_reference/**                       (upstream, read-only)
.agent/tasks/DS-*.md other than DS-BE-001
```

No frontend change is required or permitted. The existing frontend must keep passing
`npm run typecheck && npm run test && npm run build` untouched.

## Requirements

R1. FastAPI application under `backend/app/`, importable as a package, started via a single
    documented command.
R2. Binds to **127.0.0.1 only** — never `0.0.0.0`. This is a privacy-first local product.
R3. `GET /api/health` returns `{"status": "ok", "version": "<semver>"}`, HTTP 200.
R4. All errors return the envelope in `docs/API_CONTRACT.md` §0 — stable machine-readable
    `code`, human `message`, optional `detail`. No bare strings, no stack traces in responses.
R5. Unhandled exceptions are converted to the envelope (HTTP 500, code `INTERNAL_ERROR`)
    **without** leaking tracebacks, file paths, or environment values to the client.
R6. SQLite database bootstrap: a single module that opens/creates the DB, enables WAL, and
    creates tables idempotently. No product tables yet — a schema-version/meta table is
    sufficient to prove the mechanism.
R7. The database path is configurable and defaults to a per-user location. **No test may
    touch the user's real database.**
R8. Structured logging: JSON or key=value, one line per event, with a request id. Logging
    must never emit secrets (`api_key`, `authorization`, `token`, `secret`, `password`).
R9. Settings load from environment with safe defaults; no secrets in defaults, none committed.
R10. `pytest` harness configured and runnable from `backend/` with a single command, using
     FastAPI's test client. Tests must not require network access.
R11. Dependency manifest (`pyproject.toml` or equivalent) pinning FastAPI, uvicorn, pytest,
     httpx, and the keyring library to be used in DS-BE-005. Adding a dependency not needed
     for this task is out of scope (brief §89).
R12. A `.env.example` documenting every environment variable, containing no real values.

## Known Constraints

- Do **not** implement any provider, PDF, or document logic. This is scaffolding only.
- Do **not** add authentication — the service is loopback-only.
- Do **not** add CORS wildcards. If CORS is configured at all, it must name the exact local
  frontend origin.
- Do not pre-create tables for phases not yet built; speculative schema is a liability.
- Python 3.12 target; no 3.13+ syntax.

## Expected Tests

- `pytest` green from `backend/`, using a temporary database per test session.
- Health endpoint returns 200 and the documented body.
- Error envelope shape asserted for: a raised `HTTPException`, a validation error, and an
  unhandled exception.
- An unhandled exception response body contains **no** traceback text and no file path.
- Logging test: a record containing a key-like value does not emit that value.
- Database bootstrap is idempotent (running it twice does not error) and creates WAL mode.
- Binding test/config assertion: host is loopback.

## Dependencies

None. This is the first backend task; `backend/app/` is empty.

## Known Risks

- **Scope creep.** "Foundation" invites building the whole app. The task fails if it ships
  provider, document, or task logic.
- **Secret leakage in logs** is easy to introduce accidentally and impossible to un-leak.
  R8 exists for this and is tested directly.
- **Test isolation.** A test that writes to the real `~/.cache` or user data directory would
  be a serious defect; R7 and the expected tests guard it.
- **Speculative schema.** Creating tables for later phases now would lock in guesses made
  before Document Intelligence is designed.
