You are the independent Acceptance Criteria Agent.

You are NOT implementing this task.

Your job is to define objective acceptance criteria BEFORE implementation begins.

Read TASK_DESCRIPTION, PRODUCT_ARCHITECTURE and RELEVANT_EXISTING_BEHAVIOR below, then
produce the acceptance criteria.

For this task produce:
1. Functional acceptance criteria
2. Edge cases
3. Error handling criteria
4. Regression protection
5. Security criteria
6. Performance expectations if relevant
7. UI/UX criteria if relevant
8. Suggested automated tests
9. Suggested manual tests
10. Explicit failure conditions

Every criterion should be objectively verifiable where possible. Number every criterion
(e.g. AC-01, AC-02, ...) so each can be individually marked PASS / FAIL / NOT_APPLICABLE.
Tag each criterion P0 (MUST — blocks completion), P1 (SHOULD) or P2 (OPTIONAL / backlog).
Only P0 criteria block the task from being marked done.

Do not write production code.
Do not redesign unrelated architecture.
Do not expand the task outside its intended scope.

=====================================================================
TASK_DESCRIPTION
=====================================================================

# DS-BE-001 — Backend Foundation

## Goal
Establish the minimum runnable FastAPI backend that every remaining phase builds on: an app
that starts, binds to loopback, exposes a health endpoint, persists to SQLite, returns a
consistent error shape, logs without leaking secrets, and has a working test harness.
This task deliberately builds NO product features. Its value is that everything after it has
somewhere to live and a way to be tested.

## Technical Context
- Python 3.12.13 via backend/.venv. Machine default 3.14.6 is outside the pinned upstream's
  supported range; every backend command must use the venv interpreter.
- FastAPI + SQLite.
- The service is local-only and never exposed beyond the machine.
- Later phases add: provider profiles, credentials (OS keyring), documents, translation
  tasks, chat. The foundation must not preclude them, and must not pre-build them.

## Requirements
R1.  FastAPI application under backend/app/, importable as a package, started via a single
     documented command.
R2.  Binds to 127.0.0.1 ONLY — never 0.0.0.0. This is a privacy-first local product.
R3.  GET /api/health returns {"status": "ok", "version": "<semver>"}, HTTP 200.
R4.  All errors return the envelope below — stable machine-readable code, human message,
     optional detail. No bare strings, no stack traces in responses.
       { "error": { "code": "INTERNAL_ERROR", "message": "...", "detail": {} } }
R5.  Unhandled exceptions are converted to the envelope (HTTP 500, code INTERNAL_ERROR)
     WITHOUT leaking tracebacks, file paths, or environment values to the client.
R6.  SQLite bootstrap: one module that opens/creates the DB, enables WAL, and creates tables
     idempotently. No product tables yet — a schema-version/meta table suffices.
R7.  The database path is configurable and defaults to a per-user location. NO TEST may touch
     the user's real database.
R8.  Structured logging: JSON or key=value, one line per event, with a request id. Logging
     must never emit secrets (api_key, authorization, token, secret, password).
R9.  Settings load from environment with safe defaults; no secrets in defaults, none committed.
R10. pytest harness configured and runnable from backend/ with a single command, using
     FastAPI's test client. Tests must not require network access.
R11. Dependency manifest pinning FastAPI, uvicorn, pytest, httpx, and keyring (used in a
     later task). No dependency beyond what this task needs.
R12. A .env.example documenting every environment variable, containing no real values.

## Known Constraints
- Do NOT implement any provider, PDF, or document logic. Scaffolding only.
- Do NOT add authentication — the service is loopback-only.
- Do NOT add CORS wildcards. If CORS is configured, it must name the exact local origin.
- Do not pre-create tables for phases not yet built; speculative schema is a liability.
- Python 3.12 target; no 3.13+ syntax.

## Known Risks
- Scope creep: "foundation" invites building the whole app. Task fails if it ships provider,
  document, or task logic.
- Secret leakage in logs is easy to introduce and impossible to un-leak.
- Test isolation: a test writing to the real ~/.cache or user data directory is a defect.
- Speculative schema locks in guesses made before Document Intelligence is designed.

=====================================================================
PRODUCT_ARCHITECTURE
=====================================================================

  Desktop shell (Tauri, later phase)
    └─ Frontend: React + TS + Vite + PDF.js + Zustand   [ALREADY BUILT, DS-FE-001]
         Reader workspace | AI sidebar | Settings | Glossary
    └─ Backend: FastAPI + SQLite, loopback only          [THIS TASK CREATES IT]

Full backend endpoint surface planned across all phases (NONE of it exists yet; listed so you
understand what this foundation must not preclude):
  GET  /api/health
  POST /api/documents                       import PDF by path
  GET  /api/documents/{id}/file             original PDF, N pages
  GET  /api/documents/{id}/translated       translated PDF, N pages
  GET  /api/documents/{id}/bilingual        interleaved PDF, 2N pages
  POST /api/documents/{id}/translate        start task -> task_id
  GET  /api/tasks/{task_id}/events          SSE progress stream
  POST /api/documents/{id}/ask              scoped question -> answer + citations
  GET/POST /api/profiles                    provider profiles (API keys MASKED)
  POST /api/profiles/{id}/test              connection test

Later phases will need: documents, pages, sections, paragraphs, glossary, profiles,
translation_tasks, chat_sessions, chat_messages, and an FTS5 index. This task must not
create them, but its migration/bootstrap mechanism must be able to add them cleanly.

SECURITY CONTEXT (important):
API keys will be stored in the OS credential store (Windows Credential Manager) via keyring.
SQLite stores only an alias/reference, never key material. The frontend may only ever receive
a masked form such as sk-••••••••ab12. Keys must never reach git, logs, stack traces,
acceptance docs, or task docs. Nothing in THIS task stores a secret, but the logging and
error-envelope machinery it establishes is what later tasks will rely on to avoid leaking.

ENVIRONMENT CONTEXT:
- Windows 11, local developer machine.
- The user runs this locally; there is no server, no deployment, no multi-user access.
- The frontend already centralises the backend URL at http://127.0.0.1:8000 and currently
  issues zero requests.

=====================================================================
RELEVANT_EXISTING_BEHAVIOR
=====================================================================

- backend/app/ is currently EMPTY (0 files). This is a true greenfield backend.
- The frontend shell exists and passes 27 tests. It must keep passing, untouched.
- docs/API_CONTRACT.md already freezes the error envelope and health response shapes; the
  criteria should be consistent with it rather than inventing a different contract.
- A prior Phase 0 audit established that the upstream PDF translation library writes its own
  cache to ~/.cache/pdf2zh/ and config to ~/.config/PDFMathTranslate/, and that its
  ConfigManager stores API keys in PLAINTEXT. This project deliberately does NOT reuse that
  config mechanism, which is part of why this backend exists.

=====================================================================

Now produce the acceptance criteria document in Markdown. Be specific and objectively
verifiable. Prefer concrete values (status codes, exact JSON keys, timeouts) over adjectives.
