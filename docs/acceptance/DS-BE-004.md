# DS-BE-004 — Acceptance Criteria (FROZEN)

> **Author:** project maintainer
> **Authored:** 2026-09-16, **before any implementation code was written**
> **Prompt:** the task brief
> **Raw model output:** the task brief
>
> **FROZEN.** No criterion may be silently weakened or deleted (brief §10).

## Acceptance criteria review (before implementation)

**Verdict: accepted as-is. No `AC_CHANGE_REQUEST`.** 26 criteria (20 P0, 4 P1, 2 P2),
30 specified tests, 11 failure conditions.

All five design questions were settled explicitly, and the Q2 error-routing table is the most
valuable part: it distinguishes failures that mean *"this protocol is absent"* (404, 400, 5xx,
malformed, 405/501) from failures that mean *"this protocol exists but rejected us"*
(401, 403, 429, connection, timeout). Falling through on the latter would produce a misleading
second error and, for 429, hammer an already-throttled endpoint.

### Implementation notes recorded at review time

1. **Detection cannot use `test_connection()`.** That method deliberately *returns*
   `ConnectionReport(ok=False)` rather than raising, so it discards the error type — and AC-07
   and AC-08 depend on exactly that type to decide abort-vs-fall-through. Detection therefore
   calls `generate()` with the probe request directly, which raises the normalised error. The
   probe cost is identical; only the error visibility differs.
2. **AC-26 (P2) interacts with the `protocol` argument.** `ProviderConfig` has no `protocol`
   field and `models.py` is frozen by FC-02, so the fallback must be `getattr(config,
   "protocol", None)` — for subclasses and duck-typed objects only. Per AC-26, a config-level
   protocol takes precedence over the literal `"auto"`; both an omitted argument and `"auto"`
   are treated as "not explicitly specified".
3. **Cache-key hashing uses the key's secret value.** The sha256 digest is the only form that
   ever appears in the key, satisfying AC-10 and AC-15 simultaneously: rotating a key separates
   cache entries without the plaintext ever entering a data structure.
4. AC-02 requires `chat_completions` to keep **re-exporting** the probe constants after they
   move to `client.py`, so no existing caller breaks.

---

# Acceptance Criteria: DS-BE-004 — Protocol Auto-Detection + Connection Test

- **Task ID**: `DS-BE-004`
- **Role**: Independent Acceptance Criteria Agent
- **Status**: Defined prior to implementation (**FROZEN**)
- **Scope**:
  - Protocol auto-detection in [`backend/app/llm/detection.py`](file:///D:/marti/SciPrograms/backend/app/llm/detection.py) resolving between existing [`OpenAIResponsesProvider`](file:///D:/marti/SciPrograms/backend/app/llm/responses.py) and [`OpenAIChatCompletionsProvider`](file:///D:/marti/SciPrograms/backend/app/llm/chat_completions.py).
  - In-process cached resolution per endpoint+model profile key, never per request.
  - Connection test reporting protocol, model, and latency for settings UI.
  - Error normalization explaining both attempts when neither protocol succeeds.
  - Consolidation of probe constants into [`backend/app/llm/client.py`](file:///D:/marti/SciPrograms/backend/app/llm/client.py).
  - Public exports in [`backend/app/llm/__init__.py`](file:///D:/marti/SciPrograms/backend/app/llm/__init__.py).
  - Secret protection (zero API key leakage in logs, repr, cache keys, or error messages).
  - Concurrency control (anti-stampede one-probe guarantee for concurrent resolves of the same key).
  - 100% offline unit/integration test suite in [`backend/tests/test_llm_detection.py`](file:///D:/marti/SciPrograms/backend/tests/test_llm_detection.py) using mocks only.
- **Explicit Exclusions**:
  - Provider profile database / SQLite persistence & OS keyring credential storage (DS-BE-005).
  - Retry engine / policy layer (DS-BE-006).
  - PDF translation, Paper QA, Document Intelligence, frontend, and Tauri.
- **Target Runtime**: Python 3.12.13 (`backend/.venv`) on Windows 11.
- **Priority Tags**:
  - `[P0]`: **MUST** — Blocks completion of this task.
  - `[P1]`: **SHOULD** — Strongly recommended; does not block completion if deferred with documented rationale.
  - `[P2]`: **OPTIONAL** — Architectural hooks or future extensions.

---

## Design Decisions (Settling Q1 – Q5)

The following explicit, verifiable rules settle the design ambiguities for protocol auto-detection, caching, error routing, and concurrency:

### Q1. Cache Key Composition
- **Exact Key Formulation**:
  ```python
  cache_key = (
      config.base_url,
      config.model,
      hashlib.sha256(config.api_key.get_secret_value().encode("utf-8")).hexdigest(),
  )
  ```
- **Type**: `tuple[str, str, str]`
- **Verifiable Rules**:
  1. `base_url`: Identifies the physical/logical network endpoint verbatim.
  2. `model`: Identifies the requested model name. Crucial because an endpoint gateway may support Responses for newer models while supporting only Chat Completions for legacy models (or vice versa).
  3. `sha256(api_key)`: A cryptographic one-way digest of the raw API key secret value. If a user rotates credentials, switches accounts, or points to a multi-tenant gateway that routes based on API key, the cache key automatically separates the profiles without requiring manual eviction.
  4. **Strict Secret Hygiene (R7)**: The raw plaintext API key MUST NEVER be part of the cache key, printed in `__repr__`, or logged. Hashing ensures complete isolation while strictly maintaining zero secret leakage.
  5. **Keyless Local Endpoints**: For keyless local servers (`api_key == SecretStr("")`), the SHA-256 digest of an empty string (`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`) is used deterministically.

### Q2. Protocol Capability Detection & Error Routing
Detection evaluates protocols in strict sequence: **Responses first, then Chat Completions**. The probe executes a minimal completion request using the shared constants `PROBE_PROMPT = "ping"` and `PROBE_MAX_TOKENS = 1`.

The outcome of the Responses probe determines whether detection succeeds, stops immediately, or falls through to Chat Completions:

| Exception Class | HTTP / Cause | Detection Action | Rationale & Verification Rule |
| :--- | :--- | :--- | :--- |
| **`LLMAuthenticationError`** | 401 | **STOP immediately (Re-raise)** | Credentials rejected. The endpoint exists and enforces auth. Falling through to Chat Completions with the same invalid key would produce a misleading secondary error, mask auth issues, or risk account lockout. |
| **`LLMPermissionDeniedError`** | 403 | **STOP immediately (Re-raise)** | Account or model access forbidden. The endpoint exists and rejected permissions. Falling through would mask the permission denial. |
| **`LLMRateLimitError`** | 429 | **STOP immediately (Re-raise)** | Quota exhausted or rate limit hit. The endpoint and protocol exist. Probing Chat Completions immediately would waste quota or hammer a throttled endpoint. |
| **`LLMConnectionError`** | Network / DNS / Refused | **STOP immediately (Re-raise)** | Host unreachable or socket connection refused. The physical host cannot be contacted; probing Chat Completions to the exact same host is guaranteed to fail and wastes latency. |
| **`LLMTimeoutError`** | Socket / Gateway Timeout | **STOP immediately (Re-raise)** | Upstream failed to respond within timeout window. Probing Chat Completions immediately would double user wait time with near-certain failure. |
| **`LLMNotFoundError`** | 404 | **FALL THROUGH to Chat Completions** | Route `/v1/responses` absent. Clear signal that the gateway does not implement the Responses API endpoint. |
| **`LLMInvalidResponseError`** | Non-JSON / Malformed / HTML | **FALL THROUGH to Chat Completions** | Gateway returned unparseable content (e.g. HTML 404/405 page or unexpected schema), indicating Responses API is not supported. |
| **`LLMBadRequestError`** | 400 / 422 | **FALL THROUGH to Chat Completions** | Non-OpenAI gateways often reject unknown routes or unrecognized schemas with 400 or 422. Probe falls through; if Chat Completions also fails, both errors are reported. |
| **`LLMServerError`** | 500 / 502 / 503 / 504 | **FALL THROUGH to Chat Completions** | Gateways/proxies without `/responses` handler often crash with 500/502. Falling through allows partially-working gateways (working Chat Completions) to succeed. |
| **`LLMAPIError`** | 405 / 501 / Other | **FALL THROUGH to Chat Completions** | Method Not Allowed (405) or Not Implemented (501) indicates route unsupported. |

- **Dual Failure Behavior (R5)**: If Responses falls through and Chat Completions ALSO fails, detection raises [`LLMAPIError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L104-L122) (with `code="LLM_API_ERROR"`, `retryable=False`). The exception message MUST explicitly identify both attempts:
  `f"Auto-detection failed: Responses probe failed ({resp_err.code}: {resp_err.message}); Chat Completions probe failed ({cc_err.code}: {cc_err.message})"`
  The message is sanitized via [`sanitize_message()`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L26-L31). Failed detections are NEVER cached.

### Q3. Cache Lifetime & Persistence Boundary
- **In-Memory Lifetime**: The resolution cache is strictly **in-memory (in-process)**.
- **Persistence Boundary**: No SQLite tables, filesystem state, or persistent configuration are touched. Profile persistence is explicitly assigned to DS-BE-005.
- **Process Restart Behavior**: On process restart, the in-memory cache is empty. The initial resolve for any profile issues exactly one probe, caches the resolved protocol, and subsequent calls in that process hit the cache with zero network I/O.

### Q4. Cache Invalidation Mechanisms
Three explicit mechanisms are provided:
1. `clear_detection_cache() -> None`: Clears all entries in the resolution cache. (Used for test isolation and application reset).
2. `invalidate_detection_cache(config: ProviderConfig) -> bool`: Evicts the specific cache entry corresponding to the profile key. Returns `True` if evicted, `False` if not present.
3. `force_probe: bool = False` argument on `resolve_provider`:
   ```python
   async def resolve_provider(
       config: ProviderConfig,
       protocol: str = "auto",
       *,
       force_probe: bool = False,
   ) -> LLMProvider
   ```
   When `force_probe=True`, bypasses any cached value, re-runs detection, overwrites the cache entry with the fresh outcome, and returns the provider.

### Q5. Concurrency & Anti-Stampede Guarantee
- **Mechanism**: Single in-flight probe per cache key with concurrent waiters (e.g. via per-key `asyncio.Lock` or registered in-flight `asyncio.Task` / `Future`).
- **Observable Testable Behavior**:
  When $N$ coroutines concurrently call `resolve_provider(config, protocol="auto")` for the same uncached profile key:
  1. Exactly **ONE** underlying probe request is executed across both protocols. The mock call count for the probe is asserted to be exactly `1`, not $N$.
  2. All $N - 1$ concurrent waiters pause until the in-flight probe completes and receive the exact same resolved [`LLMProvider`](file:///D:/marti/SciPrograms/backend/app/llm/base.py#L16-L46) instance.
  3. If the probe raises a terminal error, all $N$ coroutines receive the identical exception.
  4. Concurrent resolves for different cache keys execute independently without cross-key blocking.

---

## 1. Priority P0 (MUST) — Core Contract & Functional Criteria (Blocks Completion)

| ID | Priority | Description & Verification Target |
| :--- | :--- | :--- |
| **AC-01** | `[P0]` | **Public Package Exports & Inert Importability**<br>[`backend/app/llm/__init__.py`](file:///D:/marti/SciPrograms/backend/app/llm/__init__.py) exports `resolve_provider`, `clear_detection_cache`, `invalidate_detection_cache`, `PROBE_PROMPT`, and `PROBE_MAX_TOKENS`, while preserving all existing exports.<br>Executing `python -c "import app.llm"` succeeds with exit code `0` and produces zero side effects (zero network sockets, zero disk I/O, zero log emissions). |
| **AC-02** | `[P0]` | **Consolidation of Probe Constants (Known Cleanup)**<br>[`PROBE_PROMPT`](file:///D:/marti/SciPrograms/backend/app/llm/chat_completions.py#L42) (`"ping"`) and [`PROBE_MAX_TOKENS`](file:///D:/marti/SciPrograms/backend/app/llm/chat_completions.py#L43) (`1`) are relocated to [`backend/app/llm/client.py`](file:///D:/marti/SciPrograms/backend/app/llm/client.py).<br>[`chat_completions.py`](file:///D:/marti/SciPrograms/backend/app/llm/chat_completions.py) and [`responses.py`](file:///D:/marti/SciPrograms/backend/app/llm/responses.py) import them from `app.llm.client`.<br>[`chat_completions.py`](file:///D:/marti/SciPrograms/backend/app/llm/chat_completions.py) re-exports them to preserve full backward compatibility with any external callers. |
| **AC-03** | `[P0]` | **Zero Modifications to Shared Contracts**<br>[`backend/app/llm/base.py`](file:///D:/marti/SciPrograms/backend/app/llm/base.py), [`backend/app/llm/models.py`](file:///D:/marti/SciPrograms/backend/app/llm/models.py), and [`backend/app/llm/errors.py`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py) remain 100% UNCHANGED. No new error classes, request/result models, or config fields are introduced. |
| **AC-04** | `[P0]` | **Explicit Protocol Bypass (R4)**<br>When `protocol="chat_completions"` or `protocol="responses"`, `resolve_provider(config, protocol=...)` directly constructs and returns the corresponding provider ([`OpenAIChatCompletionsProvider`](file:///D:/marti/SciPrograms/backend/app/llm/chat_completions.py) or [`OpenAIResponsesProvider`](file:///D:/marti/SciPrograms/backend/app/llm/responses.py)).<br>Zero network probes are issued, the resolution cache is neither read nor updated. |
| **AC-05** | `[P0]` | **Responses-First Auto-Detection Order (R1, R2)**<br>When `protocol="auto"`, detection probes Responses first. If the Responses probe succeeds, `resolve_provider` selects Responses, stores `"responses"` in the profile cache, and returns an [`OpenAIResponsesProvider`](file:///D:/marti/SciPrograms/backend/app/llm/responses.py) whose `protocol == "responses"`. Chat Completions is never probed. |
| **AC-06** | `[P0]` | **Chat Completions Fallback on Route Absence (R2, Q2)**<br>If the Responses probe fails with [`LLMNotFoundError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L64-L69) (HTTP 404), [`LLMBadRequestError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L59-L62) (400/422), [`LLMInvalidResponseError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L71-L75), [`LLMServerError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L96-L99) (5xx), or [`LLMAPIError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L104-L122), detection falls through and probes Chat Completions.<br>If the Chat Completions probe succeeds, `resolve_provider` caches `"chat_completions"` and returns an [`OpenAIChatCompletionsProvider`](file:///D:/marti/SciPrograms/backend/app/llm/chat_completions.py) whose `protocol == "chat_completions"`. |
| **AC-07** | `[P0]` | **Terminal Abort on Credential & Permission Rejection (Q2)**<br>If the Responses probe fails with [`LLMAuthenticationError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L49-L52) (HTTP 401) or [`LLMPermissionDeniedError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L54-L57) (HTTP 403), detection STOPS immediately.<br>It MUST NOT probe Chat Completions, MUST NOT populate the cache, and MUST re-raise the exact normalized exception. |
| **AC-08** | `[P0]` | **Terminal Abort on Rate Limit, Connection & Timeout Errors (Q2)**<br>If the Responses probe fails with [`LLMRateLimitError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L81-L84) (HTTP 429), [`LLMConnectionError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L91-L94), or [`LLMTimeoutError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L86-L89), detection STOPS immediately.<br>It MUST NOT probe Chat Completions, MUST NOT populate the cache, and MUST re-raise the exact normalized exception. |
| **AC-09** | `[P0]` | **Dual Failure Normalization (R5)**<br>If Responses falls through and Chat Completions ALSO fails, `resolve_provider` raises a normalized [`LLMAPIError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L104-L122) with `code="LLM_API_ERROR"`, `retryable=False`.<br>The exception message explicitly specifies both attempted protocols and their respective failure details (e.g. `LLM_NOT_FOUND` and `LLM_SERVER_ERROR`). No raw primitive exceptions escape. The failure is NOT cached. |
| **AC-10** | `[P0]` | **Exact Cache Key Composition (Q1)**<br>Profile caching uses the exact tuple `(config.base_url, config.model, sha256(api_key))`.<br>- Distinct models for the same base URL resolve to different cache keys.<br>- Rotating the API key changes the key hash and produces a distinct cache key.<br>- The cache key NEVER contains the raw plaintext API key string. |
| **AC-11** | `[P0]` | **Zero Re-Probing on Cache Hit (R3)**<br>A second call to `resolve_provider` with an identical cache key returns a working [`LLMProvider`](file:///D:/marti/SciPrograms/backend/app/llm/base.py#L16-L46) without issuing any network probe. In automated tests, mock probe invocation count for the key remains exactly 1. |
| **AC-12** | `[P0]` | **Cache Isolation Across Profiles**<br>Resolving provider for Profile A (`base_url="http://host-a"`, `model="m1"`) and Profile B (`base_url="http://host-b"`, `model="m2"`) issues distinct probes and maintains isolated cache entries without cross-talk. |
| **AC-13** | `[P0]` | **Explicit Cache Invalidation Mechanisms (Q4)**<br>- `clear_detection_cache()` purges all cached resolution entries.<br>- `invalidate_detection_cache(config)` removes the specific entry for `config`.<br>- Calling `resolve_provider(config, force_probe=True)` forces a fresh probe regardless of cache status and updates the cache with the new outcome. |
| **AC-14** | `[P0]` | **In-Flight Anti-Stampede Concurrency (R8, Q5)**<br>When $N$ coroutines invoke `resolve_provider(config)` simultaneously for the same uncached key, exactly ONE probe is executed across both protocols (asserting mock call count == 1). All $N$ coroutines receive the resolved provider instance. |
| **AC-15** | `[P0]` | **Strict Secret Redaction (R7)**<br>The plaintext API key is never exposed in cache keys, error messages, exception strings, `repr()`, or logs. All generated error text is sanitized via [`sanitize_message()`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L26-L31). |
| **AC-16** | `[P0]` | **Connection Test Diagnostics Parity (R6)**<br>Calling `await provider.test_connection()` on the resolved provider returns a [`ConnectionReport`](file:///D:/marti/SciPrograms/backend/app/llm/models.py#L80-L88) reporting `ok: bool`, `latency_ms: float >= 0.0`, `message: str`, and `model: str | None`.<br>Combined with `provider.protocol` (`"responses"` or `"chat_completions"`), all three required settings-screen attributes (protocol, model, latency) are accessible. |
| **AC-17** | `[P0]` | **Clean Async Cancellation Propagation**<br>If a coroutine awaiting `resolve_provider` is cancelled, `asyncio.CancelledError` propagates untouched. The internal lock/waiter state is cleanly released without corrupting future resolution calls for that key. |
| **AC-18** | `[P0]` | **Zero Vendor-Specific Branching (R9)**<br>Detection and resolution code contains zero vendor heuristics or URL inspection (`if "deepseek" in base_url`, `if "openai" in base_url`, `if "gpt" in model`). Protocol selection is purely behavioral based on endpoint responses. |
| **AC-19** | `[P0]` | **Zero Test Network Access (Offline Isolation)**<br>All tests in [`backend/tests/test_llm_detection.py`](file:///D:/marti/SciPrograms/backend/tests/test_llm_detection.py) run offline using mocked provider clients. No test triggers the offline autouse socket guard. |
| **AC-20** | `[P0]` | **Regression Baseline Protection**<br>All 253 existing backend tests (88 in `test_llm_provider.py`, 32 in `test_llm_responses.py`, and remaining backend tests) and 27 frontend tests continue to pass with zero failures. |

---

## 2. Priority P1 (SHOULD) — Operational Quality & Robustness (Non-Blocking)

| ID | Priority | Description & Verification Target |
| :--- | :--- | :--- |
| **AC-21** | `[P1]` | **Protocol Parameter Normalization**<br>`resolve_provider` accepts protocol strings case-insensitively with whitespace stripped (`"auto"`, `"Auto"`, `"AUTO"`, `"chat_completions"`, `"Chat_Completions"`, `"responses"`, `"RESPONSES"`). |
| **AC-22** | `[P1]` | **Invalid Protocol String Rejection**<br>Calling `resolve_provider(config, protocol="unsupported_protocol")` raises `ValueError` with an explicit error message listing the valid options (`"auto"`, `"chat_completions"`, `"responses"`). No probe is issued. |
| **AC-23** | `[P1]` | **Composite Connection Test Diagnostic Helper**<br>[`detection.py`](file:///D:/marti/SciPrograms/backend/app/llm/detection.py) provides a convenience helper `test_endpoint_connection(config: ProviderConfig, protocol: str = "auto", *, force_probe: bool = False) -> tuple[str, ConnectionReport]` returning both the resolved protocol name and the probe [`ConnectionReport`](file:///D:/marti/SciPrograms/backend/app/llm/models.py#L80-L88) in a single async call. |
| **AC-24** | `[P1]` | **Keyless Local Server Resolution**<br>When [`ProviderConfig.api_key`](file:///D:/marti/SciPrograms/backend/app/llm/models.py#L102) is empty (`""`), auto-detection executes normally using [`KEYLESS_API_KEY_PLACEHOLDER`](file:///D:/marti/SciPrograms/backend/app/llm/client.py#L24) for the probe client and computes the SHA-256 hash of `""` for caching without raising errors. |

---

## 3. Priority P2 (OPTIONAL) — Future Extensions & Hooks (Non-Blocking)

| ID | Priority | Description & Verification Target |
| :--- | :--- | :--- |
| **AC-25** | `[P2]` | **In-Memory Cache Introspection**<br>[`detection.py`](file:///D:/marti/SciPrograms/backend/app/llm/detection.py) exposes `get_detection_cache_stats() -> dict[str, int]` returning cache metrics (`{"entries": int, "hits": int, "misses": int}`) for testing and diagnostics. |
| **AC-26** | `[P2]` | **Duck-Typed Config Protocol Attribute**<br>If a caller passes a `ProviderConfig` subclass or duck-typed object possessing a `.protocol` attribute, `resolve_provider` defaults to `config.protocol` when the `protocol` argument is omitted or set to `"auto"`. |

---

## 4. Expected Automated Tests

The test suite in [`backend/tests/test_llm_detection.py`](file:///D:/marti/SciPrograms/backend/tests/test_llm_detection.py) must be runnable via `pytest` and include at minimum the following automated test cases:

| ID | Test Name | Purpose / Assertions | Priority |
| :--- | :--- | :--- | :--- |
| **AC-27.01** | `test_detection_package_exports` | Asserts `resolve_provider`, `clear_detection_cache`, `invalidate_detection_cache`, `PROBE_PROMPT`, `PROBE_MAX_TOKENS` are exported in `app.llm`. | `[P0]` |
| **AC-27.02** | `test_detection_package_import_is_inert` | Asserts importing `app.llm` produces zero side effects and exit code 0. | `[P0]` |
| **AC-27.03** | `test_probe_constants_relocated_to_client` | Asserts `PROBE_PROMPT == "ping"` and `PROBE_MAX_TOKENS == 1` are defined in `app.llm.client` and re-exported from `chat_completions`. | `[P0]` |
| **AC-27.04** | `test_explicit_protocol_chat_completions_bypasses_probe` | Verifies `protocol="chat_completions"` returns `OpenAIChatCompletionsProvider` with zero probe calls. | `[P0]` |
| **AC-27.05** | `test_explicit_protocol_responses_bypasses_probe` | Verifies `protocol="responses"` returns `OpenAIResponsesProvider` with zero probe calls. | `[P0]` |
| **AC-27.06** | `test_auto_detection_responses_success` | Mocks Responses probe success; asserts `resolve_provider` returns `OpenAIResponsesProvider` with `protocol == "responses"`. | `[P0]` |
| **AC-27.07** | `test_auto_detection_fallback_on_404` | Mocks Responses 404 (`LLMNotFoundError`), CC success; asserts fallback to CC (`protocol == "chat_completions"`). | `[P0]` |
| **AC-27.08** | `test_auto_detection_fallback_on_bad_request` | Mocks Responses 400 (`LLMBadRequestError`), CC success; asserts fallback to CC. | `[P0]` |
| **AC-27.09** | `test_auto_detection_fallback_on_server_error` | Mocks Responses 500 (`LLMServerError`), CC success; asserts fallback to CC. | `[P0]` |
| **AC-27.10** | `test_auto_detection_fallback_on_invalid_response` | Mocks Responses `LLMInvalidResponseError`, CC success; asserts fallback to CC. | `[P0]` |
| **AC-27.11** | `test_auto_detection_abort_on_401_authentication_error` | Mocks Responses 401; asserts immediate `LLMAuthenticationError` raised; CC never probed. | `[P0]` |
| **AC-27.12** | `test_auto_detection_abort_on_403_permission_denied` | Mocks Responses 403; asserts immediate `LLMPermissionDeniedError` raised; CC never probed. | `[P0]` |
| **AC-27.13** | `test_auto_detection_abort_on_429_rate_limit` | Mocks Responses 429; asserts immediate `LLMRateLimitError` raised; CC never probed. | `[P0]` |
| **AC-27.14** | `test_auto_detection_abort_on_connection_error` | Mocks Responses `LLMConnectionError`; asserts immediate abort; CC never probed. | `[P0]` |
| **AC-27.15** | `test_auto_detection_abort_on_timeout_error` | Mocks Responses `LLMTimeoutError`; asserts immediate abort; CC never probed. | `[P0]` |
| **AC-27.16** | `test_auto_detection_both_fail_raises_composite_error` | Mocks Responses 404 and CC 500; asserts `LLMAPIError` raised containing details of both failures. | `[P0]` |
| **AC-27.17** | `test_resolution_caching_prevents_reprobe` | Resolves same profile twice; asserts probe executed exactly once (mock count == 1). | `[P0]` |
| **AC-27.18** | `test_cache_key_differentiation_by_model` | Resolves profile with model `m1` and `m2` on same URL; asserts independent probes and keys. | `[P0]` |
| **AC-27.19** | `test_cache_key_differentiation_by_key_hash` | Resolves profile with rotated API keys; asserts independent cache entries without secret leakage. | `[P0]` |
| **AC-27.20** | `test_cache_invalidation_forces_reprobe` | Populates cache, calls `clear_detection_cache()`; asserts subsequent resolve re-probes. | `[P0]` |
| **AC-27.21** | `test_force_probe_bypasses_cache` | Calls `resolve_provider(..., force_probe=True)`; asserts fresh probe issued and cache updated. | `[P0]` |
| **AC-27.22** | `test_concurrent_anti_stampede_single_probe` | Runs 10 concurrent resolves for same key; asserts exactly 1 probe executed and all 10 succeed. | `[P0]` |
| **AC-27.23** | `test_secret_never_leaked_in_cache_keys_or_errors` | Asserts raw key is absent from cache data structures, exception messages, and repr strings. | `[P0]` |
| **AC-27.24** | `test_resolved_provider_test_connection_diagnostics` | Resolves provider, calls `await provider.test_connection()`; asserts `report.latency_ms`, `model`, and `provider.protocol`. | `[P0]` |
| **AC-27.25** | `test_cancellation_propagates_cleanly` | Asserts `asyncio.CancelledError` propagates without being wrapped into `LLMError`. | `[P0]` |
| **AC-27.26** | `test_no_vendor_specific_branching` | Source-level AST inspection verifying zero vendor string checks in `detection.py`. | `[P0]` |
| **AC-27.27** | `test_protocol_string_case_insensitivity` | Verifies `"Auto"` and `"CHAT_COMPLETIONS"` are recognized without error. | `[P1]` |
| **AC-27.28** | `test_invalid_protocol_string_raises_value_error` | Verifies `protocol="grpc"` raises `ValueError`. | `[P1]` |
| **AC-27.29** | `test_keyless_provider_auto_detection` | Tests auto-detection with `api_key=SecretStr("")` succeeds using dummy placeholder. | `[P1]` |
| **AC-27.30** | `test_composite_connection_test_helper` | Calls `test_endpoint_connection(config)`; asserts `(protocol, report)` returned correctly. | `[P1]` |

---

## 5. Explicit Failure Conditions

The implementation **FAILS** if any of the following conditions occur:

- **FC-01 (Scope Creep)**: The implementation introduces database tables, SQLite migrations, filesystem persistence, OS keyring storage (DS-BE-005), retry engines (DS-BE-006), PDF translation, Paper QA, or frontend/Tauri code.
- **FC-02 (Shared Contract Mutation)**: The implementation modifies [`backend/app/llm/base.py`](file:///D:/marti/SciPrograms/backend/app/llm/base.py), [`backend/app/llm/models.py`](file:///D:/marti/SciPrograms/backend/app/llm/models.py), or [`backend/app/llm/errors.py`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py).
- **FC-03 (Secret Exposure)**: The raw plaintext API key appears anywhere in cache keys, dictionary representations, error messages, exception strings, or logs.
- **FC-04 (Hot-Path Re-Probing)**: Auto-detection is executed per generation call or per translation block rather than once per profile key.
- **FC-05 (Auth / Permission Fall-Through)**: An endpoint returning 401 Unauthorized or 403 Forbidden on Responses falls through to probe Chat Completions instead of aborting immediately.
- **FC-06 (Stampeding Probes)**: Concurrent requests for the same uncached profile key execute multiple independent probe calls instead of synchronizing behind a single in-flight probe.
- **FC-07 (Vendor Branching)**: `detection.py` contains conditional branches inspecting URL strings or model names (`if "deepseek" in ...`, `if "openai" in ...`).
- **FC-08 (Unsanitized Composite Error)**: When both protocols fail, an unhandled primitive exception (`KeyError`, `AttributeError`) escapes, or the resulting error fails to describe both attempted failures.
- **FC-09 (Swallowed Cancellation)**: An exception handler catches and suppresses or wraps `asyncio.CancelledError`.
- **FC-10 (Test Network Access)**: Any detection test initiates a real network socket connection or triggers the offline autouse socket guard.
- **FC-11 (Regression)**: Any of the 253 existing backend tests or 27 frontend tests fail.
