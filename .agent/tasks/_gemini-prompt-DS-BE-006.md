You are the independent Acceptance Criteria Agent for task DS-BE-006.

You are NOT implementing this task. You are NOT writing production code.

Define objective, testable acceptance criteria BEFORE implementation begins.

Scope:
- HTTP endpoints for provider profile CRUD + connection test
- strict secret containment (no endpoint may ever return an API key)
- error mapping onto the EXISTING error envelope
- three-way api_key update semantics
- tests offline, using the in-memory credential store

Explicitly exclude:
- the profile store and credential layer themselves (DS-BE-005, complete)
- the LLM adapters and detection (DS-BE-002/003/004, complete)
- retry engine, PDF translation, Paper QA, frontend, Tauri

Return criteria grouped as P0 MUST / P1 SHOULD / P2 OPTIONAL, numbered AC-01, AC-02, ...
Tag every criterion. Only P0 blocks completion.

=====================================================================
TASK_DESCRIPTION
=====================================================================

# DS-BE-006 — Provider Profile HTTP API

## Goal
Expose provider profiles over HTTP so the settings screen can manage them: list, create, edit,
delete, and test a connection. This is the last piece of Phase 2 the frontend is waiting on.

## Product Context
The user configures their own endpoint, key and model. The settings screen must be able to show
THAT a key is set without ever receiving it, and a "Test Connection" button must report the
protocol, model and latency it found.

## Technical Context
  HTTP      FastAPI, loopback-only, error envelope {"error": {code, message, detail}}
  Storage   ProfileStore CRUD; keys in the OS credential store; only credential_ref in SQLite
  Detection resolve_provider / test_endpoint_connection returning (protocol, ConnectionReport)
  Contract  docs/API_CONTRACT.md §3 already freezes these endpoints' shapes

docs/API_CONTRACT.md §3 specifies: GET/POST /api/profiles, PATCH/DELETE /api/profiles/{id},
POST /api/profiles/{id}/test, with api_key_masked in responses and {ok, protocol, model,
latency_ms} from the test endpoint.

## Requirements
R1. CRUD endpoints under /api/profiles matching docs/API_CONTRACT.md §3.
R2. NO endpoint ever returns an API key. Responses carry has_key and api_key_masked only.
    A create/update request may ACCEPT a key.
R3. POST /api/profiles/{id}/test resolves a provider, probes it, returns
    {ok, protocol, model, latency_ms} — the three things the settings screen must display.
R4. Store errors map onto the existing error envelope with stable codes: not-found -> 404,
    duplicate name / validation -> 400, credential store unavailable -> 503.
R5. Request validation (blank name, bad protocol, unknown fields) produces the existing
    VALIDATION_ERROR envelope, not a raw pydantic traceback.
R6. PATCH preserves three-way key semantics: key omitted -> unchanged; "" -> cleared;
    value -> replaced. An unrelated edit must never destroy a key.
R7. The profile store is provided by the app (lifespan), not constructed per request.
R8. No secret in logs, error envelopes, or OpenAPI schemas.
R9. Tests use the in-memory credential store and a temporary database.

## Known Risks
- Leaking a key through a response body or the OpenAPI schema. An echo-back of the request
  body, or a pydantic model that includes the field, would do it.
- Half-created profiles when the credential store fails mid-create.
- Blocking the event loop during a connection test.
- Duplicate logic: the store already enforces uniqueness and validation; the API must
  translate its errors rather than re-implement the rules.

=====================================================================
DESIGN QUESTIONS THE CRITERIA MUST SETTLE
=====================================================================

Give an explicit, verifiable rule for each:

Q1. WHERE DOES THE STORE COME FROM? Lifespan-created and stashed on app.state, or a dependency
    that opens a connection per request? R7 leans one way; fix it, including what happens if
    the lifespan did not run (e.g. a request served without startup).

Q2. PATCH BODY SHAPE. How is "key omitted" distinguished from "key explicitly empty" in JSON?
    Absent field vs null vs "" — these must be defined, because R6 depends on it. State the
    exact JSON for each of the three intents.

Q3. EXACT STATUS CODE per failure: unknown id, duplicate name, invalid protocol, blank name,
    unavailable credential store, and upstream provider failure during a connection test.

Q4. DOES THE TEST ENDPOINT BLOCK? A connection test performs a real request. State the timeout
    expectation, and what is returned when the provider is unreachable (200 with ok=false, or
    a 4xx/5xx?).

Q5. CREATION WITH A KEY WHEN THE CREDENTIAL STORE IS UNAVAILABLE. The profile must not be
    half-created. Confirm the API surfaces this without leaving a row, and state the exact
    response.

=====================================================================
PRODUCT_ARCHITECTURE
=====================================================================

  Settings UI (frontend, later)  ->  THIS TASK (HTTP)  ->  ProfileStore  ->  SQLite
                                                        ->  keyring (Windows Credential Manager)

Existing backend conventions that must be followed:
- Error envelope: {"error": {"code": "<STABLE_CODE>", "message": "...", "detail": {}}}
  with handlers already registered for 404/405/422/500. New error types must map onto it.
- Structured JSON logging; fields named api_key/authorization/token/secret/password are
  redacted to "[REDACTED]"; free text is scrubbed for "Bearer <token>" and "key=value".
- The key literal is ALSO stripped from error messages explicitly (app.llm.errors.sanitize_message).
- Importing app modules must have no side effects.
- The test suite runs entirely offline under an autouse socket guard that fails any non-loopback
  connection. Tests must substitute the credential store (an autouse fixture already installs an
  in-memory fake).
- The service is loopback-only and single-user.

=====================================================================
RELEVANT_EXISTING_BEHAVIOR
=====================================================================

- backend has 379 passing tests. frontend has 27. All must still pass.
- ProfileStore (app/storage/profiles.py) already provides:
    create_profile(*, name, base_url, model, protocol="auto", temperature=None,
                   max_output_tokens=None, timeout_s=60.0, custom_headers=None, api_key=None)
    get_profile(id), get_profile_by_name(name), list_profiles()
    update_profile(id, *, api_key=None, **fields)
    delete_profile(id)
    to_provider_config(id) -> ProviderConfig
  and raises ProfileNotFoundError, ProfileNameExistsError, ProfileValidationError,
  ProfileStoreError (all subclasses of ProfileStoreError).
- Profile (returned by reads) carries: id, name, base_url, model, protocol, temperature,
  max_output_tokens, timeout_s, custom_headers, credential_ref, created_at, updated_at,
  has_key, api_key_masked. It contains NO plaintext key.
- app/security/credentials.py exposes CredentialStoreUnavailableError, CredentialNotFoundError,
  CredentialStoreError, is_credential_store_available().
- app/llm/detection.py exposes resolve_provider(config, protocol, *, force_probe=False) and
  test_endpoint_connection(config, protocol, *, force_probe=False) -> (protocol, ConnectionReport).
- ConnectionReport is a frozen dataclass: ok: bool, latency_ms: float | None,
  message: str = "Connection successful", model: str | None = None.
- app/main.py builds the app in create_app(settings), runs a lifespan that calls
  bootstrap_database and stores the connection on app.state.db, and mounts the health router
  under /api.
- The existing profile table was added by a numbered migration; SCHEMA_VERSION is 2.

=====================================================================

Now produce the acceptance criteria document in Markdown. Use a table with columns
ID | Priority | Description & Verification Target. Be specific and objectively verifiable —
prefer concrete values (status codes, exact JSON keys, exact error codes) over adjectives.
Give an explicit answer to each of Q1-Q5.
