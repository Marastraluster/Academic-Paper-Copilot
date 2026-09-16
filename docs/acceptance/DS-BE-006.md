# DS-BE-006 — Acceptance Criteria (FROZEN)

> **Author:** Gemini 3.8 Flash (High) via Antigravity CLI — *independent Acceptance Criteria Agent*  
> **Authored:** 2026-09-16, **before any implementation code was written**  
> **Scope:** Provider Profile HTTP API (CRUD + Connection Test), strict secret containment, error envelope mapping, three-way API key semantics, offline testing  
>
> **FROZEN.** DeepSeek may not silently weaken or delete any criterion (brief §10). Only P0 blocks completion.

---

# Acceptance Criteria: DS-BE-006 — Provider Profile HTTP API

- **Task ID**: `DS-BE-006`
- **Role**: Independent Acceptance Criteria Agent
- **Status**: Defined prior to implementation (**FROZEN**)
- **Scope**:
  - HTTP REST endpoints under `/api/profiles` matching [`docs/API_CONTRACT.md §3`](file:///D:/marti/SciPrograms/docs/API_CONTRACT.md#L78-L115) (`GET /api/profiles`, `POST /api/profiles`, `GET /api/profiles/{id}`, `PATCH /api/profiles/{id}`, `DELETE /api/profiles/{id}`, `POST /api/profiles/{id}/test`).
  - Strict secret containment: no endpoint, error response, log stream, or OpenAPI schema ever exposes a plaintext API key.
  - Integration with existing [`ProfileStore`](file:///D:/marti/SciPrograms/backend/app/storage/profiles.py) stashed on `app.state` during lifespan.
  - Normalization of store and provider failures onto the existing error envelope `{"error": {"code": "...", "message": "...", "detail": {}}}`.
  - Strict three-way key semantics on `PATCH` (omitted = retain, `""` = clear, string = replace).
  - Non-blocking asynchronous connection probe reporting `{ok, protocol, model, latency_ms}`.
  - 100% offline test suite in [`backend/tests/test_api_profiles.py`](file:///D:/marti/SciPrograms/backend/tests/test_api_profiles.py) using `TestClient`, temporary SQLite, and in-memory `FakeKeyring`.
- **Explicit Exclusions**:
  - Profile store implementation and OS keyring storage (DS-BE-005, complete).
  - LLM adapter implementation and protocol detection engine (DS-BE-002/003/004, complete).
  - Retry policy engine, PDF translation, Paper QA, frontend UI, Tauri packaging.
- **Target Runtime**: Python 3.12.13 (`backend/.venv`) on Windows 11.
- **Priority Tags**:
  - `[P0]`: **MUST** — Blocks completion of this task.
  - `[P1]`: **SHOULD** — Strongly recommended; does not block completion if deferred with documented rationale.
  - `[P2]`: **OPTIONAL** — Architectural hooks or future extensions.

---

## Design Decisions (Settling Q1 – Q5)

The following explicit, verifiable rules settle the design ambiguities for the HTTP surface:

### Q1. Where Does the Store Come From?
- **Rule**: The `ProfileStore` is constructed **once** during application lifespan startup in [`backend/app/main.py`](file:///D:/marti/SciPrograms/backend/app/main.py#L47-L70) using the initialized database connection `app.state.db`:
  ```python
  app.state.profile_store = ProfileStore(connection)
  ```
- **Route Dependency**: Route handlers retrieve the store through a FastAPI dependency:
  ```python
  def get_profile_store(request: Request) -> ProfileStore:
      store = getattr(request.app.state, "profile_store", None)
      if store is None:
          raise RuntimeError("ProfileStore is not initialized; lifespan did not execute.")
      return store
  ```
- **Lifespan Non-Execution**: If a request arrives when lifespan did not run (e.g. ad-hoc ASGI invocation without startup), accessing `/api/profiles` triggers `RuntimeError`, which is trapped by Starlette's unhandled exception handler and returned as HTTP **500 Internal Server Error** with the standard envelope:
  ```json
  {
    "error": {
      "code": "INTERNAL_ERROR",
      "message": "An internal error occurred.",
      "detail": {}
    }
  }
  ```
  Endpoints MUST NEVER open ad-hoc SQLite connections per request or instantiate a new `ProfileStore`.

### Q2. PATCH Body Shape & Three-Way Key Semantics
The PATCH payload distinguishes three user intents regarding credentials:
1. **Intent 1: Retain Existing Key (Omitted)**
   - **Exact JSON**:
     ```json
     { "name": "DeepSeek Primary", "model": "deepseek-chat" }
     ```
   - **Semantics**: `"api_key"` is absent from the JSON object (`"api_key" not in patch_model.model_fields_set`). Passed to [`store.update_profile(id, api_key=None, ...)`](file:///D:/marti/SciPrograms/backend/app/storage/profiles.py#L240-L307). The existing credential in keyring remains intact and `credential_ref` is untouched.
2. **Intent 2: Clear Stored Key (Explicit Empty String `""`)**
   - **Exact JSON**:
     ```json
     { "api_key": "" }
     ```
   - **Semantics**: `"api_key"` is explicitly set to `""`. Passed to `store.update_profile(id, api_key="", ...)`. The credential is deleted from keyring, `credential_ref` is set to `NULL`, `has_key` becomes `false`, and `api_key_masked` becomes `""`.
3. **Intent 3: Replace / Rotate Stored Key (Non-Empty String)**
   - **Exact JSON**:
     ```json
     { "api_key": "sk-live-newsecret987654321" }
     ```
   - **Semantics**: `"api_key"` is a non-empty string. Stored in keyring under `credential_ref`. Read response reflects `has_key: true` and updated `api_key_masked`.
4. **Strict Rejection of `null`**:
   - Sending `{ "api_key": null }` is strictly rejected with HTTP **422 Unprocessable Entity** (`code: "VALIDATION_ERROR"`). `api_key` expects a string if provided; `null` is forbidden to prevent ambiguous or accidental wiping.
   - For metadata fields that are genuinely nullable (`temperature`, `max_output_tokens`, `custom_headers`), `null` is accepted to clear the field.

### Q3. Exact Status Codes per Failure Mode

| Failure Condition | Source / Exception | HTTP Status | Error Code (`:code`) | Detail Shape (`:detail`) |
| :--- | :--- | :--- | :--- | :--- |
| **Unknown Profile ID** | `ProfileNotFoundError` | **404** Not Found | `"NOT_FOUND"` | `{}` |
| **Duplicate Profile Name** | `ProfileNameExistsError` | **400** Bad Request | `"BAD_REQUEST"` | `{}` |
| **Blank Required Field** | `ProfileValidationError` or Pydantic | **400** / **422** | `"BAD_REQUEST"` / `"VALIDATION_ERROR"` | `{}` or `{"errors": [...]}` |
| **Invalid Protocol Value** | `ProfileValidationError` or Pydantic | **400** / **422** | `"BAD_REQUEST"` / `"VALIDATION_ERROR"` | `{}` or `{"errors": [...]}` |
| **Unavailable Credential Store** | `CredentialStoreUnavailableError` | **503** Service Unavailable | `"SERVICE_UNAVAILABLE"` | `{}` |
| **Connection Test: Unreachable** | `LLMConnectionError` | **502** Bad Gateway | `"PROVIDER_UNREACHABLE"` | `{}` |
| **Connection Test: Auth Refused** | `LLMAuthenticationError` | **502** Bad Gateway | `"PROVIDER_AUTH_FAILED"` | `{"http_status": 401}` |
| **Connection Test: Rate Limited** | `LLMRateLimitError` | **502** Bad Gateway | `"PROVIDER_RATE_LIMITED"` | `{"http_status": 429}` |
| **Connection Test: Model Not Found** | `LLMNotFoundError` | **502** Bad Gateway | `"PROVIDER_MODEL_NOT_FOUND"` | `{"http_status": 404}` |
| **Connection Test: Timeout** | `LLMTimeoutError` | **504** Gateway Timeout | `"PROVIDER_TIMEOUT"` | `{}` |

### Q4. Does the Test Endpoint Block & Timeout / Failure Handling?
- **Non-blocking Asynchronous Execution**: `POST /api/profiles/{id}/test` is declared as `async def` and awaits [`test_endpoint_connection`](file:///D:/marti/SciPrograms/backend/app/llm/detection.py#L245-L259). It performs asynchronous HTTP requests via `httpx` / `AsyncOpenAI` and MUST NOT block FastAPI's asyncio event loop.
- **Timeout Expectation**: The probe duration is bounded by the profile's configured `timeout_s` (defaults to 60.0s). If the probe fails to complete within that window, [`LLMTimeoutError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L87-L89) is raised.
- **Response Shape on Provider Failure**:
  When the upstream provider is unreachable, times out, or fails authentication, the endpoint returns a **5xx response using the canonical error envelope** (specifically HTTP **502 Bad Gateway** or HTTP **504 Gateway Timeout**), as specified in [`docs/API_CONTRACT.md §3`](file:///D:/marti/SciPrograms/docs/API_CONTRACT.md#L108-L110). It does **NOT** return HTTP 200 with `ok=false`. HTTP 200 is strictly reserved for successful probes (`ok: true`).

### Q5. Creation with a Key When Credential Store is Unavailable
- **Atomic Failure & Zero Half-Created Profiles**: In [`ProfileStore.create_profile`](file:///D:/marti/SciPrograms/backend/app/storage/profiles.py#L193-L200), `set_credential()` is called before `INSERT INTO profiles`. If the OS credential store is unavailable, `CredentialStoreUnavailableError` is raised before SQLite is touched.
- **API Response**:
  - HTTP Status: **503 Service Unavailable**
  - Response Body:
    ```json
    {
      "error": {
        "code": "SERVICE_UNAVAILABLE",
        "message": "No usable OS credential store is available, so the API key cannot be stored securely. Refusing to fall back to plaintext storage.",
        "detail": {}
      }
    }
    ```
- **Verification**: Querying SQLite confirms `SELECT COUNT(*) FROM profiles` is unchanged (0 rows created). No orphaned database records exist.

---

## 1. Priority P0 (MUST) — Core Functional, Security & Error Criteria (Blocks Completion)

| ID | Priority | Description & Verification Target |
| :--- | :--- | :--- |
| **AC-01** | `[P0]` | **Lifespan Store Provisioning & Dependency Injection (Q1, R7)**<br>[`ProfileStore`](file:///D:/marti/SciPrograms/backend/app/storage/profiles.py) is initialized once in `lifespan` in [`backend/app/main.py`](file:///D:/marti/SciPrograms/backend/app/main.py) and stored on `app.state.profile_store`. Endpoints access it via FastAPI dependency. No endpoint opens an ad-hoc connection or instantiates `ProfileStore` per request. Invoking endpoints when lifespan has not run returns HTTP 500 with `{"error": {"code": "INTERNAL_ERROR", "message": "An internal error occurred.", "detail": {}}}`. |
| **AC-02** | `[P0]` | **Create Profile Endpoint (`POST /api/profiles`) (R1, R2, R4)**<br>Accepts JSON payload: `name` (str), `base_url` (str), `model` (str), and optional `protocol` ("auto"\|"chat_completions"\|"responses"), `temperature` (float\|null), `max_output_tokens` (int\|null), `timeout_s` (float, default 60.0), `custom_headers` (dict\|null), `api_key` (str\|null).<br>Returns HTTP **201 Created** with profile JSON containing `id`, `name`, `base_url`, `model`, `protocol`, `temperature`, `max_output_tokens`, `timeout_s`, `custom_headers`, `has_key`, `api_key_masked`, `created_at`, `updated_at`. Plaintext `api_key` is NEVER returned. |
| **AC-03** | `[P0]` | **List Profiles Endpoint (`GET /api/profiles`) (R1, R2)**<br>Returns HTTP **200 OK** with a JSON list of profiles ordered by name case-insensitively (`ORDER BY name COLLATE NOCASE`). Every profile includes `has_key: bool` and `api_key_masked: str`. Returns empty list `[]` when no profiles exist. Plaintext `api_key` is NEVER returned. |
| **AC-04** | `[P0]` | **Get Single Profile Endpoint (`GET /api/profiles/{id}`) (R1, R2, R4)**<br>Returns HTTP **200 OK** with the single profile matching `{id}`. If `{id}` does not exist, returns HTTP **404 Not Found** with error envelope `{"error": {"code": "NOT_FOUND", "message": "...", "detail": {}}}`. Plaintext `api_key` is NEVER returned. |
| **AC-05** | `[P0]` | **Update Profile & Three-Way Key Semantics (`PATCH /api/profiles/{id}`) (Q2, R1, R2, R6)**<br>Updates specified fields and returns HTTP **200 OK** with updated profile. Preserves three-way key semantics:<br>1. `api_key` omitted $\rightarrow$ credential in keyring unchanged, `credential_ref` unchanged.<br>2. `api_key == ""` $\rightarrow$ credential deleted from keyring, `credential_ref` set to `NULL`, `has_key = false`, `api_key_masked = ""`.<br>3. `api_key == "<str>"` $\rightarrow$ credential stored/rotated in keyring, `has_key = true`, `api_key_masked` updated.<br>If `{id}` is unknown, returns HTTP **404 Not Found** (`NOT_FOUND`). |
| **AC-06** | `[P0]` | **Delete Profile Endpoint (`DELETE /api/profiles/{id}`) (R1, R4)**<br>Deletes the profile row from SQLite and removes its secret from the keyring. Returns HTTP **204 No Content** (or 200). If `{id}` does not exist, returns HTTP **404 Not Found** (`NOT_FOUND`). Subsequent GET returns 404. Keyring inspection confirms secret is deleted. |
| **AC-07** | `[P0]` | **Connection Test Endpoint Success (`POST /api/profiles/{id}/test`) (Q4, R3)**<br>Constructs provider configuration for profile `{id}` (retrieving credential from keyring) and executes asynchronous connection probe. On successful connection, returns HTTP **200 OK** with exact shape:<br>`{"ok": true, "protocol": "<responses|chat_completions>", "model": "<model_name>", "latency_ms": <float>}`.<br>Latency is positive (`> 0`); does not block event loop. |
| **AC-08** | `[P0]` | **Connection Test Failure Envelope Mapping (Q3, Q4, R3)**<br>When upstream provider probe fails, the endpoint returns a non-2xx status with the canonical error envelope matching [`docs/API_CONTRACT.md §3`](file:///D:/marti/SciPrograms/docs/API_CONTRACT.md#L108-L110):<br>- Host unreachable / connection refused: HTTP **502 Bad Gateway**, `code: "PROVIDER_UNREACHABLE"`<br>- Auth rejected (401/403): HTTP **502 Bad Gateway**, `code: "PROVIDER_AUTH_FAILED"`, `detail: {"http_status": 401}`<br>- Rate limited (429): HTTP **502 Bad Gateway**, `code: "PROVIDER_RATE_LIMITED"`, `detail: {"http_status": 429}`<br>- Model/endpoint 404: HTTP **502 Bad Gateway**, `code: "PROVIDER_MODEL_NOT_FOUND"`, `detail: {"http_status": 404}`<br>- Timeout exceeded: HTTP **504 Gateway Timeout**, `code: "PROVIDER_TIMEOUT"`<br>Does NOT return HTTP 200 with `ok=false`. Never returns raw provider response bodies or stack traces. |
| **AC-09** | `[P0]` | **Strict Secret Containment in HTTP Responses (R2, R8)**<br>No response body or HTTP header from GET, POST, PATCH, DELETE, or POST /test under `/api/profiles` ever contains the raw plaintext API key. Key existence is represented solely by `has_key: bool` and `api_key_masked: str`. |
| **AC-10** | `[P0]` | **Zero Secret Leakage in Logs, OpenAPI, and Error Envelopes (R8)**<br>1. Request logging via [`backend/app/logging.py`](file:///D:/marti/SciPrograms/backend/app/logging.py) redacts keys to `"[REDACTED]"`.<br>2. OpenAPI schema at `/openapi.json` defines `ProfileResponse` without any `api_key` property.<br>3. Pydantic validation errors and store exception envelopes never reflect plaintext key literals. |
| **AC-11** | `[P0]` | **Duplicate Name Rejection (Q3, R4)**<br>Attempting to create a profile or update an existing profile's name to an existing name (case-insensitive comparison, e.g. `"OpenAI"` vs `"openai"`) returns HTTP **400 Bad Request** with error envelope `{"error": {"code": "BAD_REQUEST", "message": "...", "detail": {}}}`. |
| **AC-12** | `[P0]` | **Request Validation Error Envelope (Q3, R5)**<br>Malformed request payloads (e.g. blank name `"name": " "`, unsupported protocol `"protocol": "grpc"`, unknown fields with `extra="forbid"`, negative timeout) produce HTTP **422 Unprocessable Entity** (or 400 Bad Request) adhering to `{"error": {"code": "VALIDATION_ERROR", "message": "Request parameters failed validation.", "detail": {"errors": [...]}}}`. Raw Pydantic traces or default FastAPI error shapes are suppressed. |
| **AC-13** | `[P0]` | **Atomic Failure on Unavailable Credential Store (Q3, Q5, R4)**<br>Attempting to create or update a profile with an `api_key` when the credential store is unavailable returns HTTP **503 Service Unavailable** with `{"error": {"code": "SERVICE_UNAVAILABLE", "message": "...", "detail": {}}}`.<br>On creation, no profile row is written to SQLite (`SELECT COUNT(*) FROM profiles` is unchanged). On update, existing profile data and credential remain unchanged. |
| **AC-14** | `[P0]` | **Offline Isolated Tests & Non-Regression (R9)**<br>All profile API tests run in [`backend/tests/test_api_profiles.py`](file:///D:/marti/SciPrograms/backend/tests/test_api_profiles.py) using `TestClient` with temporary SQLite database and in-memory `FakeKeyring`. External network access remains blocked by `block_external_network` fixture. Upstream LLM responses in connection tests are mocked. All 379 existing backend tests and 27 frontend tests continue to pass. |

---

## 2. Priority P1 (SHOULD) — Operational Quality & Consistency (Non-Blocking)

| ID | Priority | Description & Verification Target |
| :--- | :--- | :--- |
| **AC-15** | `[P1]` | **Detect Protocol Endpoint (`POST /api/profiles/{id}/detect-protocol`)**<br>[`docs/API_CONTRACT.md §3`](file:///D:/marti/SciPrograms/docs/API_CONTRACT.md#L87) defines `POST /api/profiles/{id}/detect-protocol`. Calling this endpoint for a profile with `protocol="auto"` resolves the provider, determines the concrete protocol (`"chat_completions"` or `"responses"`), populates the detection cache, and returns HTTP **200 OK** with `{"protocol": "<resolved_protocol>"}`. If profile does not exist, returns 404. |
| **AC-16** | `[P1]` | **Base URL Verbatim Guarantee & Warning Flag (Contract §3)**<br>Base URL is passed and saved verbatim without stripping trailing slashes or auto-appending `/v1`. If base URL appears to omit `/v1` for OpenAI-compatible endpoints, creation/update response may optionally carry a non-fatal `warning` message, but base URL is never rewritten. |
| **AC-17** | `[P1]` | **Strict Rejection of `{"api_key": null}` (Q2)**<br>PATCH request containing `{"api_key": null}` is rejected with HTTP **422 Unprocessable Entity** (`VALIDATION_ERROR`). Clients must explicitly omit `api_key` to keep it or send `""` to clear it. |
| **AC-18** | `[P1]` | **Custom Headers Round-Trip via HTTP**<br>Supplying `"custom_headers": {"X-Org": "Acme", "HTTP-Referer": "https://test.com"}` in POST/PATCH stores the JSON and returns the dictionary in GET/POST/PATCH responses. Passing `null` or `{}` clears custom headers to `None`. |
| **AC-19** | `[P1]` | **Pre-Check Profile Existence on Test Endpoint**<br>Calling `POST /api/profiles/prof_nonexistent/test` immediately returns HTTP **404 Not Found** (`NOT_FOUND`) without attempting provider construction, keyring retrieval, or upstream network probing. |

---

## 3. Priority P2 (OPTIONAL) — Future Extensions & Hooks (Non-Blocking)

| ID | Priority | Description & Verification Target |
| :--- | :--- | :--- |
| **AC-20** | `[P2]` | **Keyless Profile Connection Test Execution**<br>Calling `POST /api/profiles/{id}/test` on a profile created without an API key uses the LLM layer's keyless placeholder (`"no-key-required"`) and successfully returns connectivity reports for local Ollama / llama.cpp servers. |
| **AC-21** | `[P2]` | **Request Correlation ID Propagation on Profile Endpoints**<br>All responses from `/api/profiles` endpoints echo the `X-Request-ID` header from the incoming request (or generate a UUID4 if omitted), including on 400, 404, 422, 500, and 503 error responses. |

---

## 4. Expected Automated Tests

The test suite in [`backend/tests/test_api_profiles.py`](file:///D:/marti/SciPrograms/backend/tests/test_api_profiles.py) must be runnable via `pytest` and include at minimum the following automated test cases:

| ID | Test Name | Purpose / Assertions | Priority |
| :--- | :--- | :--- | :--- |
| **AC-22.01** | `test_list_profiles_empty` | `GET /api/profiles` returns 200 and `[]` when database is empty. | `[P0]` |
| **AC-22.02** | `test_create_profile_with_key_returns_201_and_masked_key` | `POST /api/profiles` with `api_key` creates profile, returns 201, `has_key: true`, and masked key. Asserts raw key not in body. | `[P0]` |
| **AC-22.03** | `test_create_keyless_profile_returns_201` | `POST /api/profiles` without `api_key` returns 201, `has_key: false`, `api_key_masked: ""`. | `[P0]` |
| **AC-22.04** | `test_create_profile_rejects_duplicate_name` | `POST /api/profiles` with existing name (case-insensitive) returns 400 `BAD_REQUEST`. | `[P0]` |
| **AC-22.05** | `test_create_profile_validation_error_blank_fields` | `POST /api/profiles` with blank `name` or `base_url` returns 422 `VALIDATION_ERROR`. | `[P0]` |
| **AC-22.06** | `test_create_profile_validation_error_unknown_fields` | `POST /api/profiles` with extra unknown fields returns 422 `VALIDATION_ERROR`. | `[P0]` |
| **AC-22.07** | `test_create_profile_store_unavailable_fails_503_without_half_creation` | When keyring fails, `POST /api/profiles` returns 503 `SERVICE_UNAVAILABLE` and 0 rows exist in SQLite. | `[P0]` |
| **AC-22.08** | `test_get_profile_by_id_success` | `GET /api/profiles/{id}` returns 200 and correct profile shape. | `[P0]` |
| **AC-22.09** | `test_get_profile_by_id_not_found` | `GET /api/profiles/prof_missing` returns 404 `NOT_FOUND` envelope. | `[P0]` |
| **AC-22.10** | `test_list_profiles_returns_all_sorted_with_masked_keys` | `GET /api/profiles` returns multiple profiles sorted by name case-insensitively with masked keys. | `[P0]` |
| **AC-22.11** | `test_patch_profile_omitted_key_preserves_credential` | `PATCH /api/profiles/{id}` updating `model` leaves keyring credential untouched. | `[P0]` |
| **AC-22.12** | `test_patch_profile_empty_key_clears_credential` | `PATCH /api/profiles/{id}` with `api_key: ""` deletes key from keyring and sets `has_key: false`. | `[P0]` |
| **AC-22.13** | `test_patch_profile_new_key_replaces_credential` | `PATCH /api/profiles/{id}` with new key rotates keyring secret and updates `api_key_masked`. | `[P0]` |
| **AC-22.14** | `test_patch_profile_rejects_null_key` | `PATCH /api/profiles/{id}` with `api_key: null` returns 422 `VALIDATION_ERROR`. | `[P0]` |
| **AC-22.15** | `test_patch_profile_duplicate_name_fails_400` | Renaming profile to an existing name returns 400 `BAD_REQUEST`. | `[P0]` |
| **AC-22.16** | `test_patch_profile_not_found` | `PATCH /api/profiles/prof_missing` returns 404 `NOT_FOUND`. | `[P0]` |
| **AC-22.17** | `test_delete_profile_removes_row_and_keyring_credential` | `DELETE /api/profiles/{id}` returns 204, removes SQLite row, and removes keyring secret. | `[P0]` |
| **AC-22.18** | `test_delete_profile_not_found` | `DELETE /api/profiles/prof_missing` returns 404 `NOT_FOUND`. | `[P0]` |
| **AC-22.19** | `test_test_connection_success_returns_200` | Mocked successful probe returns 200 `{ok: true, protocol: "...", model: "...", latency_ms: ...}`. | `[P0]` |
| **AC-22.20** | `test_test_connection_unreachable_returns_502` | Mocked `LLMConnectionError` returns 502 `PROVIDER_UNREACHABLE`. | `[P0]` |
| **AC-22.21** | `test_test_connection_auth_failed_returns_502` | Mocked `LLMAuthenticationError` returns 502 `PROVIDER_AUTH_FAILED` with detail `http_status: 401`. | `[P0]` |
| **AC-22.22** | `test_test_connection_rate_limited_returns_502` | Mocked `LLMRateLimitError` returns 502 `PROVIDER_RATE_LIMITED` with detail `http_status: 429`. | `[P0]` |
| **AC-22.23** | `test_test_connection_timeout_returns_504` | Mocked `LLMTimeoutError` returns 504 `PROVIDER_TIMEOUT`. | `[P0]` |
| **AC-22.24** | `test_test_connection_profile_not_found_returns_404` | `POST /api/profiles/prof_missing/test` returns 404 `NOT_FOUND`. | `[P0]` |
| **AC-22.25** | `test_openapi_schema_contains_no_secret_in_profile_response` | Asserts `/openapi.json` `ProfileResponse` schema has no `api_key` property. | `[P0]` |
| **AC-22.26** | `test_profile_endpoints_emit_no_secrets_in_logs` | Inspects captured logs during profile create/update; asserts raw key absent. | `[P0]` |
| **AC-22.27** | `test_store_dependency_fails_500_if_lifespan_did_not_run` | Accessing `/api/profiles` on an app whose lifespan did not run returns 500 `INTERNAL_ERROR`. | `[P0]` |
| **AC-22.28** | `test_custom_headers_roundtrip_via_http` | Creates profile with custom headers; asserts GET/PATCH return expected header dict. | `[P1]` |
| **AC-22.29** | `test_detect_protocol_endpoint_success` | Calls `POST /api/profiles/{id}/detect-protocol`; asserts concrete protocol returned. | `[P1]` |
| **AC-22.30** | `test_keyless_profile_connection_test` | Connection test on keyless profile succeeds using keyless placeholder. | `[P2]` |

---

## 5. Explicit Failure Conditions

The implementation **FAILS** if any of the following conditions occur:

- **FC-01 (Scope Creep / Premature Code)**: Modifies profile store SQLite schema, modifies LLM adapter classes, or touches PDF processing, Paper QA, frontend UI, or Tauri files.
- **FC-02 (API Key Leakage in Response)**: Any HTTP response body or response header from any `/api/profiles` endpoint contains a plaintext API key.
- **FC-03 (API Key in OpenAPI Response Model)**: The OpenAPI schema (`/openapi.json`) includes an `api_key` field in `ProfileResponse` or any model returned by read operations.
- **FC-04 (Raw Traceback or Default FastAPI Error Format)**: A validation error, 404, or unhandled exception bypasses the canonical `{"error": {"code": "...", "message": "...", "detail": {}}}` envelope.
- **FC-05 (Key Wiping on Metadata PATCH)**: Updating a profile's name, model, or generation parameters without sending `api_key` wipes, clears, or alters the existing stored credential.
- **FC-06 (Ad-Hoc Store Construction Per Request)**: Route handlers open independent SQLite connections or construct `ProfileStore` per request instead of obtaining the lifespan-managed instance via dependency injection.
- **FC-07 (Half-Created Profile on Credential Failure)**: When the credential store is unavailable during profile creation, a row is left behind in SQLite.
- **FC-08 (Blocking Event Loop During Connection Test)**: The connection test endpoint blocks FastAPI's asyncio event loop with synchronous network I/O.
- **FC-09 (Test Credential Store Contamination)**: Tests execute against the live OS credential store (`WinVaultKeyring`) instead of the mandatory in-memory `FakeKeyring`.
- **FC-10 (Regression)**: Any of the 379 existing backend tests or 27 frontend tests fail.
