# DS-BE-002 — Acceptance Criteria (FROZEN)

> **Author:** Gemini 3.8 Flash (High) via Antigravity CLI — *independent Acceptance Criteria Agent*
> **Authored:** 2026-09-16, **before any implementation code was written**
> **Prompt:** `.agent/tasks/_gemini-prompt-DS-BE-002.md`
> **Raw model output:** `.agent/tasks/_gemini-ac-DS-BE-002.raw.md`
>
> **FROZEN.** DeepSeek may not silently weaken or delete any criterion (brief §10).

---

## Acceptance Criteria Review — DeepSeek (before implementation)

**Verdict: accepted as-is. No `AC_CHANGE_REQUEST`.** 34 criteria (24 P0, 7 P1, 3 P2),
25 specified tests, 10 failure conditions.

### Findings from the pre-implementation SDK probe

Three facts were verified by executing the SDK rather than assuming, and they shape the
implementation:

1. **`base_url` is normalised by the SDK, not by us.** Passing `https://example.invalid/v1`
   results in the client reporting `https://example.invalid/v1/` — the SDK appends a trailing
   slash internally. AC-06 forbids *our* code rewriting the URL, and we do not. AC-35.6 is
   therefore verified by capturing the keyword arguments we hand to `AsyncOpenAI`, which is
   the correct boundary; the SDK's internal storage is its own affair. We deliberately do
   **not** "correct" this, as doing so would itself be a mutation.
2. **The SDK rejects an empty API key** (`OpenAIError: Missing credentials`). AC-27 requires
   `ProviderConfig` to *permit* an empty key, which is satisfiable on its own — but a config
   that cannot then construct a client is useless. Resolution: an empty key is accepted by
   the config and replaced with a documented placeholder at client-construction time, so
   genuinely keyless local servers (Ollama, LM Studio, local vLLM) work. This mirrors upstream
   `OpenAIlikedTranslator`, which passes the literal `"openailiked"` for the same reason
   (`docs/REPO_AUDIT.md` §4). Recorded here because it is an addition beyond the literal text
   of AC-27, not a weakening of it.
3. **SDK exceptions are constructible in tests** with an `httpx.Response`, so error-mapping
   tests exercise the real exception classes rather than look-alikes.

### Implementation notes recorded at review time

1. `asyncio.CancelledError` derives from `BaseException`, so `except Exception` cannot swallow
   it (AC-23, FC-08). No `except BaseException` will be used anywhere in the package.
2. AC-22 relies on `redact_text`, which scrubs `Bearer <token>` and `key=value` shapes. That
   does not cover a bare `sk-…` with no prefix, so messages additionally have the **known key
   literal** stripped. We hold the key, so this closes FC-02 regardless of upstream formatting.
3. `LLMRequest.messages` is typed `list[ChatMessage]`. Because pydantic coerces mappings, the
   plain-dict call style in the brief's §39 continues to work.
4. AC-03's "raises `ValueError` if empty" is satisfied by a `min_length=1` constraint —
   pydantic raises `ValidationError`, which subclasses `ValueError`.
5. AC-32 (`generate_stream`) is a P2 hook only; it will not grow a streaming subsystem.

---

# Acceptance Criteria: DS-BE-002 — LLMProvider Interface + OpenAI Chat Completions Adapter

- **Task ID**: `DS-BE-002`
- **Scope**: Greenfield `app/llm/` package: vendor-neutral `LLMProvider` abstraction, request/result data models, normalized `ProviderConfig`, normalized error hierarchy with retry classification, `OpenAIChatCompletionsProvider` adapter, secret redaction, and offline mock-based pytest harness.
- **Target Runtime**: Python 3.12.13 (`backend/.venv`) on Windows 11.
- **Priority Legend**:
  - `[P0]`: **MUST** — Blocks completion of this task.
  - `[P1]`: **SHOULD** — Strongly recommended; does not block completion if deferred with documented rationale.
  - `[P2]`: **OPTIONAL** — Architectural hooks or future-facing extension items.

---

## 1. Priority P0 (MUST) — Core Contract & Functional Criteria (Blocks Completion)

| ID | Priority | Description & Verification Target |
| :--- | :--- | :--- |
| **AC-01** | `[P0]` | **Application Package Structure & Inert Importability**<br>The LLM layer is housed under `backend/app/llm/` with an `__init__.py` exporting: `LLMProvider`, `LLMRequest`, `ChatMessage`, `LLMResult`, `LLMUsage`, `ProviderConfig`, `OpenAIChatCompletionsProvider`, and all error classes (`LLMError`, `LLMAuthenticationError`, `LLMPermissionDeniedError`, `LLMRateLimitError`, `LLMTimeoutError`, `LLMConnectionError`, `LLMServerError`, `LLMBadRequestError`, `LLMNotFoundError`, `LLMInvalidResponseError`, `LLMAPIError`).<br>Running `python -c "import app.llm"` succeeds with exit code `0` and produces zero side effects (no network probes, no disk writes, no logging). |
| **AC-02** | `[P0]` | **Protocol-Neutral `LLMProvider` Abstract Interface**<br>An abstract base class or protocol `LLMProvider` defines the async contract for all provider implementations:<br>- `async def generate(self, request: LLMRequest) -> LLMResult: ...`<br>- `async def test_connection(self) -> ConnectionReport: ...`<br>The method signatures are strictly protocol-neutral, containing zero parameters specific to Chat Completions, allowing an `OpenAIResponsesProvider` (DS-BE-003) to implement the exact same interface without callers changing. |
| **AC-03** | `[P0]` | **Protocol-Neutral Request Models (`LLMRequest`, `ChatMessage`)**<br>`ChatMessage` is an immutable/frozen model with fields: `role: Literal["system", "user", "assistant"] | str` and `content: str`.<br>`LLMRequest` has fields:<br>- `messages: list[ChatMessage]` (must contain $\ge 1$ message; raises `ValueError` if empty)<br>- `temperature: float | None = None`<br>- `max_output_tokens: int | None = None`<br>Models contain zero vendor or protocol-specific properties. |
| **AC-04** | `[P0]` | **Normalized Provider Configuration (`ProviderConfig`)**<br>`ProviderConfig` is a Pydantic model with fields:<br>- `base_url: str` (non-empty)<br>- `api_key: SecretStr`<br>- `model: str` (non-empty)<br>- `timeout_s: float = 60.0` (validated $> 0.0$)<br>- `temperature: float | None = None` (if set, validated $0.0 \le \text{temperature} \le 2.0$)<br>- `max_output_tokens: int | None = None` (if set, validated $> 0$)<br>- `custom_headers: dict[str, str] | None = None`<br>Attempting to instantiate with empty strings for `base_url` or `model` raises a Pydantic `ValidationError`. |
| **AC-05** | `[P0]` | **API Key Protection & Masked Representation**<br>`ProviderConfig.api_key` is strictly typed as `pydantic.SecretStr`. Calling `repr(config)`, `str(config)`, or `config.model_dump()` must NEVER reveal the plaintext key. Calling `repr(config)` outputs masked text (e.g. `SecretStr('**********')`). The plaintext string is only accessed via explicit `api_key.get_secret_value()` at the point of client instantiation. |
| **AC-06** | `[P0]` | **Verbatim Base URL Preservation**<br>The base URL provided in `ProviderConfig.base_url` is passed to `AsyncOpenAI(base_url=...)` exactly as supplied, without any alteration, trimming, normalization, or appending.<br>- `https://api.deepseek.com/v1` remains `https://api.deepseek.com/v1`<br>- `http://localhost:11434` remains `http://localhost:11434` (never automatically appends `/v1`)<br>- `https://openrouter.ai/api/v1/` retains its trailing slash.<br>The code must NOT inspect, mutate, strip, or rewrite the string. |
| **AC-07** | `[P0]` | **OpenAI-Compatible Token Limit Parameter (`max_tokens`)**<br>When passing token limits to `AsyncOpenAI.chat.completions.create()`, the adapter maps `max_output_tokens` strictly to the keyword argument `max_tokens`. The adapter must **NEVER** pass `max_completion_tokens`. If `request.max_output_tokens` is provided, it overrides `config.max_output_tokens`. If neither is provided, `max_tokens` is omitted or passed as `None`. |
| **AC-08** | `[P0]` | **Zero Vendor-Specific Sniffing or Branching**<br>The codebase in `backend/app/llm/` must contain zero vendor-specific string checks or conditional branching (e.g. NO `if "deepseek" in base_url`, NO `if "openai" in base_url`, NO `if model.startswith("gpt")`). All requests, headers, and responses follow the uniform OpenAI Chat Completions specification. |
| **AC-09** | `[P0]` | **Client Construction with Silent Retries Disabled (`max_retries=0`)**<br>The adapter instantiates `AsyncOpenAI` with `max_retries=0`. Inspecting the initialized client instance verifies `client.max_retries == 0`. The adapter does not permit the underlying SDK to perform automatic retries, ensuring deterministic latency and immediate error classification for caller layers. |
| **AC-10** | `[P0]` | **Normalized Execution Result (`LLMResult`)**<br>A successful call to `await provider.generate(request)` returns an `LLMResult` object with fields:<br>- `text: str`: equal to `response.choices[0].message.content`<br>- `model: str`: string model identifier reported in `response.model` (falling back to `config.model` if missing)<br>- `protocol: str`: exactly literal `"chat_completions"`<br>- `usage: LLMUsage | None`: normalized token usage structure. |
| **AC-11** | `[P0]` | **Usage Normalization & Nullable Upstream Tolerance**<br>- When the upstream response includes a valid `usage` object with `prompt_tokens`, `completion_tokens`, and `total_tokens`, `LLMResult.usage` is populated with `LLMUsage(prompt_tokens=int, completion_tokens=int, total_tokens=int)`.<br>- When upstream returns `usage=None` or omits `usage` (standard for local models or proxies), `LLMResult.usage` is `None` and the call completes successfully without error. |
| **AC-12** | `[P0]` | **Normalized Error Hierarchy Structure**<br>All exceptions raised by the LLM layer inherit from `LLMError(Exception)`. Every `LLMError` subclass provides:<br>- `message: str`: non-empty descriptive error message<br>- `code: str`: uppercase, stable machine-readable identifier<br>- `retryable: bool`: boolean flag indicating whether the failure is safe to retry<br>- `cause: Exception | None`: original caught exception (or `None`). |
| **AC-13** | `[P0]` | **Authentication Failure Mapping (HTTP 401)**<br>When the upstream endpoint returns HTTP status 401 or raises `openai.AuthenticationError`, the adapter catches it and raises `LLMAuthenticationError` with:<br>`code` = `"LLM_AUTHENTICATION_ERROR"`, `retryable` = `False`. |
| **AC-14** | `[P0]` | **Permission Denied Mapping (HTTP 403)**<br>When the upstream endpoint returns HTTP status 403 or raises `openai.PermissionDeniedError`, the adapter catches it and raises `LLMPermissionDeniedError` with:<br>`code` = `"LLM_PERMISSION_DENIED"`, `retryable` = `False`. |
| **AC-15** | `[P0]` | **Rate Limit Mapping (HTTP 429)**<br>When the upstream endpoint returns HTTP status 429 or raises `openai.RateLimitError`, the adapter catches it and raises `LLMRateLimitError` with:<br>`code` = `"LLM_RATE_LIMIT"`, `retryable` = `True`. |
| **AC-16** | `[P0]` | **Request Timeout Mapping**<br>When the request exceeds `config.timeout_s` or raises `openai.APITimeoutError` / `asyncio.TimeoutError`, the adapter catches it and raises `LLMTimeoutError` with:<br>`code` = `"LLM_TIMEOUT"`, `retryable` = `True`. |
| **AC-17** | `[P0]` | **Connection / Network Failure Mapping**<br>When an upstream connection fails (DNS resolution failure, connection refused, connection reset) raising `openai.APIConnectionError`, the adapter catches it and raises `LLMConnectionError` with:<br>`code` = `"LLM_CONNECTION_ERROR"`, `retryable` = `True`. |
| **AC-18** | `[P0]` | **Server Error Mapping (HTTP 5xx)**<br>When the upstream endpoint returns HTTP status 500, 502, 503, or 504 (raising `openai.InternalServerError`), the adapter catches it and raises `LLMServerError` with:<br>`code` = `"LLM_SERVER_ERROR"`, `retryable` = `True`. |
| **AC-19** | `[P0]` | **Bad Request & Validation Error Mapping (HTTP 400 / 422)**<br>When the upstream endpoint returns HTTP status 400 or 422 (raising `openai.BadRequestError` or `openai.UnprocessableEntityError`), the adapter catches it and raises `LLMBadRequestError` with:<br>`code` = `"LLM_BAD_REQUEST"`, `retryable` = `False`. |
| **AC-20** | `[P0]` | **Not Found Error Mapping (HTTP 404)**<br>When the upstream endpoint returns HTTP status 404 (raising `openai.NotFoundError`), the adapter catches it and raises `LLMNotFoundError` with:<br>`code` = `"LLM_NOT_FOUND"`, `retryable` = `False`. |
| **AC-21** | `[P0]` | **Malformed Response Protection & Zero Primitive Exception Leakage**<br>The adapter validates the upstream response payload before accessing elements:<br>- `response.choices` is empty list (`[]`)<br>- `response.choices[0].message` is `None`<br>- `response.choices[0].message.content` is `None`<br>- `response.choices[0].message.content == ""` (empty string)<br>- `openai.APIResponseValidationError` is raised.<br>In all such cases, the adapter raises `LLMInvalidResponseError` with `code: "LLM_INVALID_RESPONSE"`, `retryable: False`. Under no circumstances may `AttributeError`, `IndexError`, `KeyError`, or `TypeError` leak to the caller. |
| **AC-22** | `[P0]` | **Secret Redaction in Exception Messages & Tracebacks**<br>All exception messages and upstream error texts incorporated into `LLMError.message` or raised by the adapter must be passed through `app.logging.redact_text()`. Even if an upstream SDK exception contains `Bearer sk-proj-...` or `key=sk-12345`, the resulting `LLMError.message` and `str(exc)` strictly output `Bearer [REDACTED]` or `key=[REDACTED]`. The plaintext API key must never appear in any exception string or repr. |
| **AC-23** | `[P0]` | **Clean Async Cancellation Propagation**<br>If the calling task cancels the coroutine running `generate()` (raising `asyncio.CancelledError`), the adapter must NOT catch or swallow it, nor wrap it in `LLMError`. `asyncio.CancelledError` must propagate cleanly to the caller, and any active HTTP socket must be aborted without dangling resources. |
| **AC-24** | `[P0]` | **Zero Network Access in Test Suite (Offline Isolation)**<br>All tests in `backend/tests/test_llm_*.py` execute with mocked responses and fakes. No test connects to the real internet, sends external HTTP requests, or consumes paid API credits. Running `pytest` does not trigger the autouse `block_external_network` socket guard in `conftest.py`. |
| **AC-25** | `[P0]` | **Regression Protection: Existing Test Suites Preserved**<br>- All 94 existing backend tests in `backend/tests/` continue to pass with 0 failures.<br>- All 27 existing frontend tests in `frontend/` continue to pass with 0 failures.<br>- No files outside `backend/app/llm/`, `backend/tests/`, and allowed task documentation are modified. |

---

## 2. Priority P1 (SHOULD) — Robustness & Operational Quality (Non-Blocking)

| ID | Priority | Description & Verification Target |
| :--- | :--- | :--- |
| **AC-26** | `[P1]` | **Connection Test Probe (`test_connection`)**<br>`await provider.test_connection()` executes a lightweight probe call (e.g. non-streaming request with single user message `"ping"` and `max_tokens=1`).<br>- On success, returns `ConnectionReport(ok=True, latency_ms=float >= 0.0, message="Connection successful")`<br>- On failure, raises normalized `LLMError` or returns `ConnectionReport(ok=False, latency_ms=None, message="...")` with redacted error text. |
| **AC-27** | `[P1]` | **Keyless / Local Provider Compatibility**<br>For local servers (e.g. Ollama, LM Studio, local vLLM) that operate without authentication, `ProviderConfig` permits an empty or dummy key (e.g. `api_key=SecretStr("")` or `SecretStr("none")`) without validation error. |
| **AC-28** | `[P1]` | **Whitespace-Only Response Content Rejection**<br>If upstream returns HTTP 200 with `choice.message.content` consisting solely of whitespace (e.g. `"   \n\t  "`), the adapter treats it as an invalid completion and raises `LLMInvalidResponseError`. |
| **AC-29** | `[P1]` | **Fallback for Unmapped SDK `APIError`**<br>Any unhandled `openai.APIError` subclass not mapped to a specific status code raises `LLMAPIError` with `code: "LLM_API_ERROR"`. Its `retryable` flag is evaluated as `True` if HTTP status code $\ge 500$, else `False`. |
| **AC-30** | `[P1]` | **Custom Headers Forwarding**<br>Custom headers defined in `ProviderConfig.custom_headers` (e.g. `{"HTTP-Referer": "https://example.com", "X-Title": "PDF Copilot"}`) are forwarded to `AsyncOpenAI(default_headers=...)` and reach the request. |
| **AC-31** | `[P1]` | **Explicit Dependency Declaration in `pyproject.toml`**<br>`backend/pyproject.toml` explicitly declares `openai` in its dependencies list (e.g. `openai~=3.14.0`). |

---

## 3. Priority P2 (OPTIONAL) — Future Extensions & Enhancements (Non-Blocking)

| ID | Priority | Description & Verification Target |
| :--- | :--- | :--- |
| **AC-32** | `[P2]` | **Optional Streaming Interface Hook**<br>`LLMProvider` defines an optional method `async def generate_stream(self, request: LLMRequest) -> AsyncIterator[str]: ...`. If unimplemented in this task, it may raise `NotImplementedError` or remain an abstract hook. The primary non-streaming `generate()` method remains the authoritative P0 contract. |
| **AC-33** | `[P2]` | **Per-Request Timeout Override**<br>`LLMRequest` supports an optional field `timeout_s: float | None = None`. If provided, it overrides `config.timeout_s` for that individual execution. |
| **AC-34** | `[P2]` | **Structured Connection Report Dataclass**<br>`ConnectionReport` is exported as a typed dataclass or Pydantic model with fields: `ok: bool`, `latency_ms: float | None = None`, `message: str = "Connection successful"`, `model: str | None = None`. |

---

## 4. Expected Automated Tests

The test suite in `backend/tests/test_llm_*.py` must be runnable via `pytest` and contain at minimum the following automated test cases:

| ID | Test Name | Purpose / Assertions | Priority |
| :--- | :--- | :--- | :--- |
| **AC-35.1** | `test_llm_package_inert_import` | Imports `app.llm`; verifies return code 0, no disk writes, no network calls, and no log emissions. | `[P0]` |
| **AC-35.2** | `test_provider_config_secret_masking` | Verifies `repr(config)`, `str(config)`, and `config.model_dump()` mask `api_key` and never reveal raw secret text. | `[P0]` |
| **AC-35.3** | `test_provider_config_validation` | Asserts `ValidationError` when `base_url` or `model` are empty strings, or `timeout_s <= 0`. | `[P0]` |
| **AC-35.4** | `test_generate_success_normalized_result` | Mocks valid chat completion response; asserts `LLMResult.text`, `model`, `protocol == "chat_completions"`, and token counts match. | `[P0]` |
| **AC-35.5** | `test_generate_success_without_usage` | Mocks response with `usage=None`; asserts `generate()` succeeds and `LLMResult.usage is None`. | `[P0]` |
| **AC-35.6** | `test_verbatim_base_url_preservation` | Configures URLs with `/v1`, without `/v1`, and with trailing slash; verifies exact string is passed to `AsyncOpenAI`. | `[P0]` |
| **AC-35.7** | `test_max_tokens_parameter_mapping` | Sets `request.max_output_tokens=500`; verifies `chat.completions.create` receives `max_tokens=500` and NEVER `max_completion_tokens`. | `[P0]` |
| **AC-35.8** | `test_max_retries_zero_enforced` | Inspects client initialization; asserts `client.max_retries == 0`. | `[P0]` |
| **AC-35.9** | `test_no_vendor_branching` | Verifies identical request construction and parameter mapping across diverse vendor endpoint URLs (DeepSeek, OpenRouter, Ollama). | `[P0]` |
| **AC-35.10** | `test_error_normalization_401_auth` | Injects HTTP 401 / `AuthenticationError`; asserts `LLMAuthenticationError` raised with `code == "LLM_AUTHENTICATION_ERROR"` and `retryable is False`. | `[P0]` |
| **AC-35.11** | `test_error_normalization_403_permission` | Injects HTTP 403 / `PermissionDeniedError`; asserts `LLMPermissionDeniedError` raised with `code == "LLM_PERMISSION_DENIED"` and `retryable is False`. | `[P0]` |
| **AC-35.12** | `test_error_normalization_429_rate_limit` | Injects HTTP 429 / `RateLimitError`; asserts `LLMRateLimitError` raised with `code == "LLM_RATE_LIMIT"` and `retryable is True`. | `[P0]` |
| **AC-35.13** | `test_error_normalization_timeout` | Injects `APITimeoutError`; asserts `LLMTimeoutError` raised with `code == "LLM_TIMEOUT"` and `retryable is True`. | `[P0]` |
| **AC-35.14** | `test_error_normalization_connection` | Injects `APIConnectionError`; asserts `LLMConnectionError` raised with `code == "LLM_CONNECTION_ERROR"` and `retryable is True`. | `[P0]` |
| **AC-35.15** | `test_error_normalization_5xx_server` | Injects HTTP 500/502/503; asserts `LLMServerError` raised with `code == "LLM_SERVER_ERROR"` and `retryable is True`. | `[P0]` |
| **AC-35.16** | `test_error_normalization_400_bad_request` | Injects HTTP 400 / `BadRequestError`; asserts `LLMBadRequestError` raised with `code == "LLM_BAD_REQUEST"` and `retryable is False`. | `[P0]` |
| **AC-35.17** | `test_error_normalization_404_not_found` | Injects HTTP 404 / `NotFoundError`; asserts `LLMNotFoundError` raised with `code == "LLM_NOT_FOUND"` and `retryable is False`. | `[P0]` |
| **AC-35.18** | `test_malformed_response_empty_choices` | Mocks response with `choices=[]`; asserts `LLMInvalidResponseError` raised, no `IndexError`. | `[P0]` |
| **AC-35.19** | `test_malformed_response_none_content` | Mocks response with `choice.message.content=None`; asserts `LLMInvalidResponseError` raised, no `AttributeError`. | `[P0]` |
| **AC-35.20** | `test_malformed_response_empty_content` | Mocks response with `choice.message.content=""`; asserts `LLMInvalidResponseError` raised. | `[P0]` |
| **AC-35.21** | `test_error_message_secret_redaction` | Injects upstream error containing `Bearer sk-secret-12345`; asserts exception message replaces key with `[REDACTED]`. | `[P0]` |
| **AC-35.22** | `test_async_cancellation_propagation` | Cancels in-flight `generate()` task; asserts `asyncio.CancelledError` is raised and not converted to `LLMError`. | `[P0]` |
| **AC-35.23** | `test_connection_probe_success` | Mocks successful ping response; asserts `test_connection()` returns `ConnectionReport(ok=True)`. | `[P1]` |
| **AC-35.24** | `test_connection_probe_failure` | Injects connection failure during ping; asserts `test_connection()` returns `ConnectionReport(ok=False)` or raises normalized error. | `[P1]` |
| **AC-35.25** | `test_custom_headers_forwarding` | Configures `custom_headers={"X-Test": "123"}`; asserts headers are present in mock client request. | `[P1]` |

---

## 5. Explicit Failure Conditions

The implementation **FAILS** if any of the following conditions occur:

- **FC-01 (Scope Creep)**: The implementation creates classes, functions, or schemas for the Responses API, auto-protocol detection, provider profile databases, keyring credential storage, PDF parsing, translation, or Paper QA.
- **FC-02 (Secret Exposure)**: The API key appears unmasked in any log record, console output, string representation (`str()`), object repr (`repr()`), or exception message.
- **FC-03 (Base URL Mutation)**: The adapter rewrites, trims, or appends to `base_url` (e.g. appending `/v1` or stripping slashes).
- **FC-04 (Vendor Branching)**: The adapter contains conditional logic branching on vendor names or model strings (e.g. `if "deepseek" in base_url` or `if "gpt" in model`).
- **FC-05 (Proprietary Parameter Leak)**: The adapter passes `max_completion_tokens` to `AsyncOpenAI.chat.completions.create` instead of the standard `max_tokens`.
- **FC-06 (Silent SDK Retries)**: The adapter constructs `AsyncOpenAI` without `max_retries=0`, permitting silent SDK-internal retries.
- **FC-07 (Leaked Primitive Exceptions)**: A malformed response or API failure raises `AttributeError`, `IndexError`, `KeyError`, `TypeError`, or an unhandled raw SDK exception instead of a normalized `LLMError`.
- **FC-08 (Swallowed Async Cancellation)**: Broad `except Exception:` blocks catch `asyncio.CancelledError` and swallow it or wrap it into `LLMError`.
- **FC-09 (Test Network Access)**: Any test makes a real network connection or requires a live, paid third-party API key.
- **FC-10 (Regression)**: Any of the 94 existing backend tests or 27 frontend tests fail.
