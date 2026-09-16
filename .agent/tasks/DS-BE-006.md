# DS-BE-006 — Provider Profile HTTP API

- **Phase:** 2 (LLM Provider)
- **Status:** AC authoring — implementation NOT started
- **Owner:** DeepSeek (implementation) · Gemini (acceptance criteria)
- **Created:** 2026-09-16

## Goal

Expose provider profiles over HTTP so the settings screen can manage them: list, create, edit,
delete, and test a connection. This is the last piece of Phase 2 the frontend is waiting on.

## Product Context

The user configures their own endpoint, key and model. The settings screen must be able to show
*that* a key is set without ever receiving it, and a "Test Connection" button must report the
protocol, model and latency it found.

## Technical Context

| Layer | State |
|---|---|
| HTTP | FastAPI, loopback-only, error envelope `{"error": {code, message, detail}}` |
| Storage | `ProfileStore` CRUD, keys in the OS credential store, `credential_ref` only in SQLite |
| Detection | `resolve_provider` / `test_endpoint_connection` returning `(protocol, ConnectionReport)` |
| Contract | `docs/API_CONTRACT.md` §3 already freezes these endpoints' shapes |

`docs/API_CONTRACT.md` §3 specifies: `GET/POST /api/profiles`, `PATCH/DELETE
/api/profiles/{id}`, `POST /api/profiles/{id}/test`, with `api_key_masked` in responses and
`{ok, protocol, model, latency_ms}` from the test endpoint.

## Files Allowed To Modify

```
backend/app/api/profiles.py         (new router)
backend/app/api/__init__.py         (if it needs the router registered)
backend/app/main.py                 (mount the router + expose the profile store)
backend/tests/test_api_profiles.py  (new)
.agent/tasks/DS-BE-006.md
.agent/evidence/DS-BE-006.md
```

## Files Forbidden To Modify

```
backend/app/llm/**      (the provider layer)
backend/app/storage/**, backend/app/security/**   (the store and credential layer)
backend/app/{config,db,errors,logging}.py
backend/tests/** other than the new file
frontend/**             (untouched; must keep passing 27 tests)
docs/** other than this task's acceptance file
_reference/**
```

## Requirements

R1. CRUD endpoints under `/api/profiles` matching `docs/API_CONTRACT.md` §3.
R2. **No endpoint ever returns an API key.** Responses carry `has_key` and `api_key_masked`
    only. A create/update request may *accept* a key.
R3. `POST /api/profiles/{id}/test` resolves a provider, probes it, and returns
    `{ok, protocol, model, latency_ms}` — the three things the settings screen must display.
R4. Store errors map onto the existing error envelope with stable codes: not-found → 404,
    duplicate name / validation → 400, credential store unavailable → 503.
R5. Request validation (blank name, bad protocol, unknown fields) produces the existing
    `VALIDATION_ERROR` envelope, not a raw pydantic traceback.
R6. `PATCH` preserves the three-way key semantics: key omitted → unchanged; `""` → cleared;
    value → replaced. An unrelated edit must never destroy a key.
R7. The profile store is provided by the app (lifespan), not constructed per request.
R8. No secret in logs, error envelopes, or OpenAPI schemas.
R9. Tests use the in-memory credential store and a temporary database; no test touches the
    developer's real credential store or database.

## Design questions the acceptance criteria should settle

1. **Where does the store come from?** Lifespan-created and stashed on `app.state`, or a
   dependency that opens a connection per request? (R7 leans one way; the criteria should fix
   it, including what happens if the lifespan did not run.)
2. **`PATCH` body shape.** How is "key omitted" distinguished from "key explicitly empty" in
   JSON? (Absent field vs `null` vs `""` — these must be defined, since R6 depends on it.)
3. **Status codes.** Exact code per failure: unknown id, duplicate name, invalid protocol,
   unavailable credential store, upstream provider failure during a test.
4. **Does the test endpoint block?** A connection test performs a real request; state the
   timeout expectation and what is returned when the provider is unreachable.
5. **Creation with a key when the credential store is unavailable** — the profile must not be
   half-created (R4/AC from DS-BE-005). Confirm the API surfaces this without leaving a row.

## Expected Tests

- List / create / get / update / delete round trip.
- Every response body asserted to contain no key material (including the raw secret string).
- `api_key_masked` present and correctly shaped; `has_key` accurate.
- Filtering/handling of unknown id → 404 with the envelope.
- Duplicate name → 400 with the envelope.
- Invalid protocol / blank name → validation envelope.
- `PATCH` without a key leaves the credential intact; `PATCH` with `""` clears it.
- Test endpoint returns protocol, model and latency for a working endpoint; a failure returns
  the documented shape rather than a 500.
- Credential store unavailable → 503 with the envelope, and no profile row created.
- Existing 379 backend + 27 frontend tests still pass.

## Dependencies

DS-BE-005 (store + credentials), DS-BE-004 (detection), DS-BE-002/003 (adapters).

## Known Risks

- **Leaking a key through a response body or the OpenAPI schema.** An echo-back of the request
  body, or a pydantic model that includes the field, would do it.
- **Half-created profiles** when the credential store fails mid-create.
- **Blocking the event loop** during a connection test.
- **Duplicate logic**: the store already enforces uniqueness and validation; the API must
  translate its errors rather than re-implement the rules.
