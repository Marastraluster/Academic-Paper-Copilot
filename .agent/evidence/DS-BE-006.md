# Evidence — DS-BE-006 Provider Profile HTTP API

- **Date:** 2026-09-16
- **Agent:** DeepSeek (Claude Code CLI)
- **Acceptance criteria:** `docs/acceptance/DS-BE-006.md` (Gemini, frozen before implementation)
- **Verdict:** **DONE — 21/21 criteria PASS, 0 FAIL, 0 NOT_APPLICABLE**

## Implementation Summary

`/api/profiles` exposes profile CRUD and a connection test, completing the backend half of
Phase 2. The settings screen can now create, edit, delete and probe providers — and it can
never receive an API key, because the response model simply has no such field.

Two structural choices carry the security property:

- **`ProfileResponse` has no key-bearing field at all** — not the key, not the credential
  reference. A leak would require *adding* a field, not forgetting to remove one.
- **The failure shape is a 5xx envelope, never `200 {ok: false}`.** A caller cannot mistake an
  unreachable provider for a working one by checking the status code alone.

## Modified Files

| File | Change |
|---|---|
| `backend/app/api/profiles.py` | **New** — router, request/response models, error mapping |
| `backend/tests/test_api_profiles.py` | **New** — 46 tests |
| `backend/app/main.py` | Lifespan creates the store; router + handlers registered |
| `docs/acceptance/DS-BE-006.md` | Frozen criteria |

Frontend untouched (newest file 12:36 vs. this task's work at 20:04).

## Automated Tests Run

```
$ cd backend && .venv/Scripts/python -m pytest
    → 425 passed, 1 warning in 13.96s
      (379 pre-existing + 46 new)

$ cd frontend && npm run test
    → 5 files, 27 tests, all passed
```

## Manual Verification — full stack over real HTTP

The real backend, started as a subprocess against a temporary database, driven by real HTTP
requests, with a loopback fake LLM standing in for the user's provider.

**Deliberately keyless.** Exercising the create-with-key path live would write a real
credential into the user's Windows Credential Manager — not a side effect to incur without
being asked. That path is covered against the in-memory store in the suite instead.

```
[1] GET  /api/profiles        -> 200 []
[2] POST /api/profiles        -> 201
    {"id": "prof_a371cbcf…", "name": "Local Fake", "base_url": "http://127.0.0.1:8078/v1",
     "model": "fake-model", "protocol": "auto", …, "has_key": false, "api_key_masked": ""}
[3] GET  /api/profiles        -> 200, 1 profile(s)
    GET  /api/profiles/prof_a371cbcf… -> 200, name='Local Fake'
[4] POST …/test               -> 200 {'ok': True, 'protocol': 'responses',
                                     'model': 'fake-model', 'latency_ms': 7.17}
[5] GET  /api/profiles/nope   -> 404 {'error': {'code': 'NOT_FOUND', …}}
[6] POST invalid protocol     -> 400 code=BAD_REQUEST
[7] PATCH …                   -> 200, model='renamed-model'
[8] DELETE …                  -> 204 ; GET after delete -> 404
[9] ProfileResponse fields    -> ['api_key_masked', 'base_url', 'created_at', 'custom_headers',
                                  'has_key', 'id', 'max_output_tokens', 'model', 'name',
                                  'protocol', 'temperature', 'timeout_s', 'updated_at']

All live API checks passed.
```

Check **[4]** is the one that matters most: it exercises the whole chain — HTTP → profile store
→ credential layer → protocol detection → a real Chat Completions/Responses exchange — and
returns the protocol, model and latency a settings screen must display.

## Acceptance Criteria Evaluation

### P0 — MUST (all PASS)

| AC | Verdict | Evidence |
|---|---|---|
| AC-01 Lifespan store provisioning | **PASS** | Store created at startup and shared; a request without lifespan returns the 500 envelope, and no ad-hoc store is built |
| AC-02 Create → 201 + shape | **PASS** | Field set pinned exactly; 201 observed live |
| AC-03 List, sorted, empty case | **PASS** | Case-insensitive ordering asserted; `[]` when empty |
| AC-04 Get + 404 | **PASS** | 200 for a known id, `NOT_FOUND` envelope otherwise |
| AC-05 PATCH three-way semantics | **PASS** | omitted → unchanged (value *and* call count); `""` → cleared; value → rotated. Explicit `null` → 422 |
| AC-06 Delete → 204 + credential gone | **PASS** | 204, subsequent GET 404, keyring entry removed |
| AC-07 Connection test success shape | **PASS** | `{ok, protocol, model, latency_ms}`, latency positive, live run confirms |
| AC-08 Failure mapping, never `200 ok=false` | **PASS** | 6 failure types parametrized: 502/504 with `PROVIDER_UNREACHABLE` / `PROVIDER_AUTH_FAILED` / `PROVIDER_RATE_LIMITED` / `PROVIDER_MODEL_NOT_FOUND` / `PROVIDER_TIMEOUT`, plus `detail.http_status` |
| AC-09 No key in any response | **PASS** | Five endpoints checked as whole bodies *and* headers |
| AC-10 No key in logs or OpenAPI | **PASS** | Schema asserted free of `api_key`; log stream captured during a create and asserted clean |
| AC-11 Duplicate name → 400 | **PASS** | Case-insensitive; covers create and rename |
| AC-12 Validation envelope | **PASS** | 6 malformed payloads incl. unknown field, blank name, bad protocol, negative timeout |
| AC-13 Atomic failure on unavailable store | **PASS** | 503 `SERVICE_UNAVAILABLE`, no row written; keyless creation still works |
| AC-14 Offline tests + no regression | **PASS** | 425 backend + 27 frontend green; socket guard never fired |

### P1 — SHOULD (all PASS)

| AC | Verdict | Evidence |
|---|---|---|
| AC-15 `detect-protocol` | **PASS** | Returns the resolved protocol; 404 for an unknown id |
| AC-16 Base URL verbatim | **PASS** | Three URLs incl. no-`/v1` and trailing slash, stored unchanged |
| AC-17 `{"api_key": null}` rejected | **PASS** | 422 with a message explaining omit-vs-clear; nullable metadata may still be nulled |
| AC-18 Custom headers round-trip | **PASS** | Stored and returned; `{}` clears to `None` |
| AC-19 Test endpoint pre-check | **PASS** | Unknown id → 404 with **zero** probes issued (asserted) |

### P2 — OPTIONAL (both PASS)

| AC | Verdict | Evidence |
|---|---|---|
| AC-20 Keyless connection test | **PASS** | Keyless profile probes successfully; live run used exactly this path |
| AC-21 `X-Request-ID` propagation | **PASS** | Echoed on success and on a 404 |

**Result: 21/21 PASS. No FAIL, no NOT_APPLICABLE.**

## Notable findings during implementation

1. **Reads through `app.state.profile_store` fail from a test thread.** SQLite connections are
   thread-affine, and the store's connection belongs to the lifespan's thread — the constraint
   DS-BE-001 identified and pinned. The test helper now opens its own read-only connection
   rather than fighting it. Worth knowing for any future code that touches the store off the
   event loop.
2. **`TestClient(app)` without a context manager never runs the lifespan**, which is exactly
   what AC-01's negative case needs — but it also requires `raise_server_exceptions=False`, or
   the `RuntimeError` propagates instead of becoming a response.
3. My own live-check assertion was initially too crude: it flagged `api_key_masked` as a leak.
   That field is *required* by the contract and is not secret. Corrected to assert the precise
   property — no raw key field — rather than a keyword match.

## Known Limitations

1. **No git baseline commit** (carried across all tasks).
2. **No authentication on these endpoints.** The service is loopback-only and single-user, so
   this is consistent with the architecture — but it means any local process can read profile
   metadata (never keys) and can delete profiles. Worth a deliberate decision before Phase 10
   packaging.
3. **The connection test performs a real (billed) request** with a 1-token cap. Inherent to
   capability detection without a cheaper signal.
4. **`force_probe=True` on every test call** means a settings screen polling repeatedly will
   re-probe each time. Correct for a "Test Connection" button; would need throttling if it ever
   becomes automatic.
5. **The store's connection is shared and thread-affine** (finding 1). All current endpoints are
   `async def` and therefore run on the event loop, matching the connection's thread. A future
   synchronous endpoint would need its own connection.
6. **No pagination on `GET /api/profiles`.** Bounded by how many providers a person configures,
   so not yet warranted.

## Phase 2 Status

The LLM Provider phase is now functionally complete for the frontend's purposes:

| Piece | State |
|---|---|
| Provider interface + Chat Completions | DS-BE-002 ✅ |
| Responses adapter | DS-BE-003 ✅ |
| Auto-detection + connection test | DS-BE-004 ✅ |
| Profile store + credentials | DS-BE-005 ✅ |
| Profile HTTP API | DS-BE-006 ✅ |
| Retry policy | Not started (DS-BE-007) — errors already carry `retryable`, and the SDK's own retries are disabled |

**Next recommended task: DS-PDF-001** (criteria already frozen, layout model cached). The
provider layer is done; the product's core promise — a lossless bilingual PDF — is what remains
between here and a usable client.
