# DS-BE-003 — Acceptance Criteria (FROZEN)

> **Author:** Gemini 3.8 Flash (High) via Antigravity CLI — *independent Acceptance Criteria Agent*
> **Authored:** 2026-09-16, **before any implementation code was written**
> **Prompt:** `.agent/tasks/_gemini-prompt-DS-BE-003.md`
> **Raw model output:** `.agent/tasks/_gemini-ac-DS-BE-003.raw.md`
>
> **FROZEN.** DeepSeek may not silently weaken or delete any criterion (brief §10).

## Acceptance Criteria Review — DeepSeek (before implementation)

**Verdict: accepted as-is. No `AC_CHANGE_REQUEST`.** 28 criteria (21 P0, 5 P1, 2 P2),
32 specified tests, 11 failure conditions.

All five design questions were answered explicitly (see "Design Decisions" below) rather than
left to the implementer, which removes the main risk this task carried.

### Verified against the SDK before accepting

| Claim the criteria depend on | Verified |
|---|---|
| `Response` is constructible in tests with `status` / `error` / refusal content | **Yes** — tests will build real SDK objects, not duck-typed stubs |
| `ResponseError` carries `code` and `message` | **Yes** |
| `ResponseOutputRefusal` carries `refusal` text with `type == "refusal"` | **Yes** |
| A refusal yields `output_text == ""` | **Yes** — so AC-14's detection must inspect content parts, not just the aggregated text |

### Implementation notes recorded at review time

1. **AC-28 (P2) forces a structural decision.** `build_client` currently lives inside
   `chat_completions.py`. A Responses adapter importing from the Chat Completions module would
   be a genuine smell — one protocol implementation depending on the other for construction.
   Resolution: move `build_client` verbatim into a new protocol-neutral
   `backend/app/llm/client.py`; both adapters import it from there. This is a ~3-line edit to
   `chat_completions.py` that changes **no behaviour**, permitted by the task's "minimum
   possible change" clause and recorded in the evidence. `FC-02` protects `base.py`,
   `models.py` and `errors.py` — all three remain untouched, which is the real test of whether
   the DS-BE-002 abstraction held.
2. **AC-13's bad-request list is open-ended** ("`invalid_prompt`, …"). A closed set will be
   defined explicitly in the adapter and documented, so the mapping is deterministic rather
   than depending on which codes the model happened to list.
3. **AC-09** allows the effective timeout to go to the client or the request. Matches the
   Chat Completions precedent: `config.timeout_s` at construction, `request.timeout_s` per call.
4. **AC-26** (cross-protocol interchangeability) is the criterion that actually justifies this
   task's existence, and is implemented as a shared caller run against both providers.

---
# Acceptance Criteria: DS-BE-003 — OpenAI Responses API Adapter

- **Task ID**: `DS-BE-003`
- **Role**: Independent Acceptance Criteria Agent
- **Status**: Defined prior to implementation (**FROZEN**)
- **Scope**: OpenAI Responses API adapter implementing the existing [`LLMProvider`](file:///D:/marti/SciPrograms/backend/app/llm/base.py#L16-L46) contract in [`backend/app/llm/responses.py`](file:///D:/marti/SciPrograms/backend/app/llm/responses.py), exporting [`OpenAIResponsesProvider`](file:///D:/marti/SciPrograms/backend/app/llm/responses.py) from [`backend/app/llm/__init__.py`](file:///D:/marti/SciPrograms/backend/app/llm/__init__.py), reusing existing models ([`LLMRequest`](file:///D:/marti/SciPrograms/backend/app/llm/models.py#L29-L58), [`ChatMessage`](file:///D:/marti/SciPrograms/backend/app/llm/models.py#L20-L27), [`LLMResult`](file:///D:/marti/SciPrograms/backend/app/llm/models.py#L70-L78), [`LLMUsage`](file:///D:/marti/SciPrograms/backend/app/llm/models.py#L60-L68), [`ProviderConfig`](file:///D:/marti/SciPrograms/backend/app/llm/models.py#L90-L117), [`ConnectionReport`](file:///D:/marti/SciPrograms/backend/app/llm/models.py#L80-L88)), reusing [`normalize_exception`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L129-L185) and [`LLMError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L34-L44) taxonomy, secret redaction, and offline mock-only test harness in [`backend/tests/test_llm_responses.py`](file:///D:/marti/SciPrograms/backend/tests/test_llm_responses.py).
- **Explicit Exclusions**: Protocol auto-detection (DS-BE-004), provider profile persistence / credential storage (DS-BE-005), retry engine, PDF translation, Paper QA, Document Intelligence, frontend, and Tauri.
- **Target Runtime**: Python 3.12.13 (`backend/.venv`) on Windows 11.
- **Priority Tags**:
  - `[P0]`: **MUST** — Blocks completion of this task.
  - `[P1]`: **SHOULD** — Strongly recommended; does not block completion if deferred with documented rationale.
  - `[P2]`: **OPTIONAL** — Architectural hooks or future-facing extension items.

---

## Design Decisions (Settling Q1 – Q5)

The following explicit rules resolve ambiguities in the OpenAI Responses API (`POST /v1/responses`) to ensure deterministic implementation and verification:

### Q1. System messages -> `instructions`
- **Extraction Rule**: All messages in [`LLMRequest.messages`](file:///D:/marti/SciPrograms/backend/app/llm/models.py#L39) where `message.role == "system"` are extracted into the Responses API `instructions` top-level parameter.
- **Multiple System Messages**: When multiple messages have `role == "system"`, their `content` strings are concatenated using double newlines `"\n\n"` in the exact order they appear in `request.messages`. (*Rationale: Preserves layered prompt instructions without loss; a "last-wins" strategy would silently destroy earlier instructions.*)
- **Zero System Messages**: When no message has `role == "system"`, the `instructions` parameter MUST BE OMITTED entirely from the kwargs passed to `client.responses.create(...)` (never passed as `None` or `""`).
- **Input Messages**: All remaining non-system messages (`role != "system"`, such as `"user"` and `"assistant"`) are converted into items in the `input` list parameter: `[{"role": msg.role, "content": msg.content}, ...]` preserving their original relative sequence.

### Q2. `status == "failed"` with populated `error` object
When `client.responses.create(...)` returns a response object with `status == "failed"` and an `error` object:
- **`error.code == "server_error"`** $\rightarrow$ Normalizes to [`LLMServerError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L96-L99) (`code="LLM_SERVER_ERROR"`, `retryable=True`).
- **`error.code == "rate_limit_exceeded"`** $\rightarrow$ Normalizes to [`LLMRateLimitError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L81-L84) (`code="LLM_RATE_LIMIT"`, `retryable=True`).
- **`error.code == "vector_store_timeout"`** (or any code containing `"timeout"`) $\rightarrow$ Normalizes to [`LLMTimeoutError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L86-L89) (`code="LLM_TIMEOUT"`, `retryable=True`).
- **Known Client / Policy / Validation Failure Codes** (e.g. `"invalid_prompt"`, `"data_residency_mismatch"`, `"bio_policy"`, `"misalignment_policy_violation"`, or image format errors) $\rightarrow$ Normalizes to [`LLMBadRequestError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L59-L62) (`code="LLM_BAD_REQUEST"`, `retryable=False`).
- **Unmapped / Unknown Error Codes** $\rightarrow$ Normalizes to [`LLMAPIError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L104-L122) (`code="LLM_API_ERROR"`, `retryable=False`).
- **Missing Error Object**: If `status == "failed"` but `error` is `None` or missing $\rightarrow$ Raises [`LLMInvalidResponseError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L71-L75)(`"Provider response marked as failed without error details"`, `code="LLM_INVALID_RESPONSE"`, `retryable=False`).
- **Sanitization**: The error message in all cases is sanitized via [`sanitize_message(error.message, api_key)`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L26-L31) to scrub any credential literals before raising.

### Q3. `status == "incomplete"` (e.g. output-token cap reached)
- **Usable Partial Text**: If `response.output_text` is non-empty and contains non-whitespace text (e.g., token limit reached where `incomplete_details.reason == "max_output_tokens"`), the partially returned text IS USABLE and MUST BE RETURNED as a successful [`LLMResult`](file:///D:/marti/SciPrograms/backend/app/llm/models.py#L70-L78). (*Rationale: Mirrors Chat Completions parity where partial generation at token limit (`finish_reason == "length"`) is delivered to callers for downstream handling.*)
- **Empty / Unusable Text**: If `response.output_text` is empty (`""`) or whitespace-only (e.g. generation cut off before producing text or suppressed by content filter), the response MUST BE REJECTED by raising [`LLMInvalidResponseError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L71-L75)(`"Provider returned incomplete response with no usable content"`, `code="LLM_INVALID_RESPONSE"`, `retryable=False`).

### Q4. Refusals
- **No New Error Types**: Per Requirement R2, existing error types are reused unchanged; no `LLMRefusalError` may be introduced.
- **Refusal Handling**: When a response contains a refusal (e.g., content item with `type == "refusal"`, or `refusal` text present, and `output_text` is empty), the adapter MUST raise [`LLMInvalidResponseError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L71-L75) with `code="LLM_INVALID_RESPONSE"`, `retryable=False`.
- **Message Formulation**: The exception message formats the refusal reason cleanly (e.g., `f"Provider refused request: {refusal_text}"` or `"Provider refused request"`), sanitized via [`sanitize_message()`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L26-L31). Under no circumstances may a raw SDK refusal object or unhandled primitive exception escape.

### Q5. `max_output_tokens` parameter mapping & precedence
- **Native Parameter**: Passed directly as keyword argument `max_output_tokens` to `client.responses.create(...)` without translation (Responses uses `max_output_tokens` natively).
- **Precedence**: `request.max_output_tokens` (if not `None`) strictly overrides `config.max_output_tokens`.
- **Unset Semantics**: If NEITHER `request.max_output_tokens` nor `config.max_output_tokens` is set (both are `None`), `max_output_tokens` MUST BE OMITTED entirely from the kwargs dict passed to `client.responses.create(...)`. It must NEVER be passed as `None`, `0`, or an arbitrary guessed default.

---

## 1. Priority P0 (MUST) — Core Functional & Contract Criteria (Blocks Completion)

| ID | Priority | Description & Verification Target |
| :--- | :--- | :--- |
| **AC-01** | `[P0]` | **Public Package Export & Inert Importability**<br>[`backend/app/llm/__init__.py`](file:///D:/marti/SciPrograms/backend/app/llm/__init__.py) exports [`OpenAIResponsesProvider`](file:///D:/marti/SciPrograms/backend/app/llm/responses.py) in addition to all existing DS-BE-002 exports (`LLMProvider`, `LLMRequest`, `ChatMessage`, `LLMResult`, `LLMUsage`, `ProviderConfig`, `ConnectionReport`, `OpenAIChatCompletionsProvider`, and all `LLMError` subclasses).<br>Executing `python -c "import app.llm"` succeeds with exit code `0` and produces zero side effects (no network sockets, no file creation, no logging). |
| **AC-02** | `[P0]` | **`LLMProvider` Protocol Implementation**<br>[`OpenAIResponsesProvider`](file:///D:/marti/SciPrograms/backend/app/llm/responses.py) implements the [`LLMProvider`](file:///D:/marti/SciPrograms/backend/app/llm/base.py#L16-L46) abstract base class:<br>- Satisfies `issubclass(OpenAIResponsesProvider, LLMProvider)`<br>- Defines class attribute `protocol: str = "responses"`<br>- Implements async methods `generate(self, request: LLMRequest) -> LLMResult` and `test_connection(self) -> ConnectionReport`. |
| **AC-03** | `[P0]` | **Zero Modifications to Shared Contract & Models**<br>The implementation reuses [`base.py`](file:///D:/marti/SciPrograms/backend/app/llm/base.py), [`models.py`](file:///D:/marti/SciPrograms/backend/app/llm/models.py), and [`errors.py`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py) UNCHANGED. No new request, result, config, or error classes are defined. Callers interact strictly through [`LLMProvider`](file:///D:/marti/SciPrograms/backend/app/llm/base.py#L16-L46), [`LLMRequest`](file:///D:/marti/SciPrograms/backend/app/llm/models.py#L29-L58), [`LLMResult`](file:///D:/marti/SciPrograms/backend/app/llm/models.py#L70-L78), and [`ProviderConfig`](file:///D:/marti/SciPrograms/backend/app/llm/models.py#L90-L117). |
| **AC-04** | `[P0]` | **System Messages to `instructions` Mapping (Q1)**<br>Messages with `role == "system"` in [`LLMRequest.messages`](file:///D:/marti/SciPrograms/backend/app/llm/models.py#L39) are extracted into the Responses API `instructions` parameter:<br>- If multiple system messages exist, their `content` strings are joined with `"\n\n"` in original order.<br>- If no system messages exist, `instructions` is completely omitted from the payload kwargs dict.<br>- System messages are NOT included in the `input` list. |
| **AC-05** | `[P0]` | **Non-System Messages to `input` Parameter Mapping (Q1)**<br>All messages in [`LLMRequest.messages`](file:///D:/marti/SciPrograms/backend/app/llm/models.py#L39) with `role != "system"` (e.g. `"user"`, `"assistant"`) are mapped to the `input` list parameter passed to `client.responses.create(input=...)` as `[{"role": msg.role, "content": msg.content}, ...]` preserving their exact relative order. |
| **AC-06** | `[P0]` | **Verbatim Base URL Preservation**<br>The base URL provided in [`ProviderConfig.base_url`](file:///D:/marti/SciPrograms/backend/app/llm/models.py#L98) is passed to `AsyncOpenAI(base_url=...)` exactly as supplied, without alteration, trimming, normalization, or appending:<br>- `https://api.openai.com/v1` remains `https://api.openai.com/v1`<br>- `http://localhost:8000` remains `http://localhost:8000` (never automatically appends `/v1`)<br>- `https://gateway.example.com/v1/` retains its trailing slash.<br>The code must NOT mutate, strip, or rewrite the string. |
| **AC-07** | `[P0]` | **Client Construction with Silent Retries Disabled (`max_retries=0`)**<br>The Responses adapter initializes `AsyncOpenAI` with `max_retries=0`. Inspecting the client instance confirms `client.max_retries == 0`. Automatic SDK retries are forbidden so that latency and error classification remain deterministic. |
| **AC-08** | `[P0]` | **Native Token Limit Parameter Mapping & Precedence (Q5)**<br>The adapter passes token limits strictly via the keyword argument `max_output_tokens` to `client.responses.create(...)`:<br>- `request.max_output_tokens` overrides `config.max_output_tokens`<br>- If `request.max_output_tokens` is `None`, falls back to `config.max_output_tokens`<br>- If neither is set, `max_output_tokens` is omitted entirely from payload kwargs.<br>The adapter NEVER passes `max_tokens` or `max_completion_tokens`. |
| **AC-09** | `[P0]` | **Temperature and Timeout Parameter Forwarding**<br>- `request.temperature` overrides `config.temperature`. If both are `None`, `temperature` is omitted from payload kwargs.<br>- `request.timeout_s` overrides `config.timeout_s`. The effective timeout is passed as `timeout=...` to `client.responses.create(...)` or configured on the client. |
| **AC-10** | `[P0]` | **Normalized Execution Result (`LLMResult`)**<br>A successful call to `await provider.generate(request)` returns an [`LLMResult`](file:///D:/marti/SciPrograms/backend/app/llm/models.py#L70-L78) where:<br>- `text: str` is populated from `response.output_text`<br>- `model: str` is populated from `response.model` (falling back to `config.model` if `response.model` is `None` or empty)<br>- `protocol: str` is exactly literal `"responses"`<br>- `usage: LLMUsage | None` contains normalized token metrics. |
| **AC-11** | `[P0]` | **Responses Usage Normalization (`input_tokens` / `output_tokens`)**<br>- When `response.usage` is present, maps `usage.input_tokens` $\rightarrow$ `LLMUsage.prompt_tokens`, `usage.output_tokens` $\rightarrow$ `LLMUsage.completion_tokens`, and `usage.total_tokens` $\rightarrow$ `LLMUsage.total_tokens`. If `total_tokens` is omitted upstream, it is computed as `prompt_tokens + completion_tokens`.<br>- When `response.usage` is `None` or lacks token attributes, `LLMResult.usage` is `None` and generation succeeds without error. |
| **AC-12** | `[P0]` | **Status "incomplete" Handling (Q3)**<br>- If `response.status == "incomplete"` and `response.output_text` contains non-empty, non-whitespace text, the adapter succeeds and returns [`LLMResult`](file:///D:/marti/SciPrograms/backend/app/llm/models.py#L70-L78) with the partial text.<br>- If `response.status == "incomplete"` and `response.output_text` is empty or whitespace-only, the adapter raises [`LLMInvalidResponseError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L71-L75) (`code="LLM_INVALID_RESPONSE"`, `retryable=False`). |
| **AC-13** | `[P0]` | **Status "failed" and Populated `error` Mapping (Q2)**<br>When `response.status == "failed"` with an `error` object:<br>- `error.code == "server_error"` $\rightarrow$ raises [`LLMServerError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L96-L99) (`code="LLM_SERVER_ERROR"`, `retryable=True`)<br>- `error.code == "rate_limit_exceeded"` $\rightarrow$ raises [`LLMRateLimitError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L81-L84) (`code="LLM_RATE_LIMIT"`, `retryable=True`)<br>- `error.code == "vector_store_timeout"` $\rightarrow$ raises [`LLMTimeoutError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L86-L89) (`code="LLM_TIMEOUT"`, `retryable=True`)<br>- `error.code in ("invalid_prompt", ...)` $\rightarrow$ raises [`LLMBadRequestError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L59-L62) (`code="LLM_BAD_REQUEST"`, `retryable=False`)<br>- unmapped code $\rightarrow$ raises [`LLMAPIError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L104-L122) (`code="LLM_API_ERROR"`, `retryable=False`)<br>- missing `error` $\rightarrow$ raises [`LLMInvalidResponseError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L71-L75) (`code="LLM_INVALID_RESPONSE"`, `retryable=False`). |
| **AC-14** | `[P0]` | **Refusal Normalization (Q4)**<br>When the response contains a refusal (e.g. content block with `type == "refusal"` or `refusal` text and empty `output_text`), the adapter raises [`LLMInvalidResponseError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L71-L75) with `code="LLM_INVALID_RESPONSE"`, `retryable=False`. No raw SDK refusal object or primitive exception escapes to the caller. |
| **AC-15** | `[P0]` | **Malformed Response Protection & Zero Primitive Exception Leakage**<br>The adapter guards all response parsing. If the response has `output=None`, empty output items, message content without text, or non-string text, or if `openai.APIResponseValidationError` is raised, the adapter catches it and raises [`LLMInvalidResponseError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L71-L75) (`code="LLM_INVALID_RESPONSE"`, `retryable=False`). Under no circumstances may `AttributeError`, `IndexError`, `KeyError`, or `TypeError` leak. |
| **AC-16** | `[P0]` | **Reused Exception Normalization via `normalize_exception`**<br>All SDK and HTTP exceptions raised by `client.responses.create(...)` are passed through [`normalize_exception()`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L129-L185):<br>- 401 $\rightarrow$ [`LLMAuthenticationError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L49-L52) (`code="LLM_AUTHENTICATION_ERROR"`, `retryable=False`)<br>- 403 $\rightarrow$ [`LLMPermissionDeniedError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L54-L57) (`code="LLM_PERMISSION_DENIED"`, `retryable=False`)<br>- 429 $\rightarrow$ [`LLMRateLimitError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L81-L84) (`code="LLM_RATE_LIMIT"`, `retryable=True`)<br>- Timeout $\rightarrow$ [`LLMTimeoutError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L86-L89) (`code="LLM_TIMEOUT"`, `retryable=True`)<br>- Connection failure $\rightarrow$ [`LLMConnectionError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L91-L94) (`code="LLM_CONNECTION_ERROR"`, `retryable=True`)<br>- 5xx $\rightarrow$ [`LLMServerError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L96-L99) (`code="LLM_SERVER_ERROR"`, `retryable=True`)<br>- 400 / 422 $\rightarrow$ [`LLMBadRequestError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L59-L62) (`code="LLM_BAD_REQUEST"`, `retryable=False`)<br>- 404 $\rightarrow$ [`LLMNotFoundError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L64-L69) (`code="LLM_NOT_FOUND"`, `retryable=False`). |
| **AC-17** | `[P0]` | **API Key Redaction in Exceptions & Logs**<br>The plaintext API key is never leaked in `str()`, `repr()`, error messages, or logs. Any error message containing the key literal or `Bearer <key>` is scrubbed via [`sanitize_message()`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L26-L31) to `[REDACTED]`. `repr(provider.config)` never displays the raw secret. |
| **AC-18** | `[P0]` | **Clean Async Cancellation Propagation**<br>If the task running `generate()` or `test_connection()` is cancelled, `asyncio.CancelledError` MUST propagate cleanly to the caller. The adapter must NOT catch `asyncio.CancelledError` or wrap it into `LLMError`. |
| **AC-19** | `[P0]` | **Zero Vendor-Specific Branching**<br>Code in `backend/app/llm/` must contain zero vendor-specific checks or conditional branches (NO `if "openai" in base_url`, NO `if "responses" in base_url`, NO `if model.startswith(...)`). Requests are constructed strictly according to the generic OpenAI Responses specification. |
| **AC-20** | `[P0]` | **Zero Network Access in Test Suite (Offline Isolation)**<br>All tests in [`backend/tests/test_llm_responses.py`](file:///D:/marti/SciPrograms/backend/tests/test_llm_responses.py) run offline using mocked responses and fakes. No test opens an external network socket. The autouse socket guard in [`conftest.py`](file:///D:/marti/SciPrograms/backend/tests/conftest.py#L28-L43) is never triggered. |
| **AC-21** | `[P0]` | **Regression Baseline Protection**<br>- All 88 existing tests in [`backend/tests/test_llm_provider.py`](file:///D:/marti/SciPrograms/backend/tests/test_llm_provider.py) continue to pass.<br>- All existing 182 backend tests continue to pass.<br>- All 27 frontend tests remain untouched and pass.<br>- Existing Chat Completions behavior is completely unaffected. |

---

## 2. Priority P1 (SHOULD) — Robustness & Operational Quality (Non-Blocking)

| ID | Priority | Description & Verification Target |
| :--- | :--- | :--- |
| **AC-22** | `[P1]` | **Connection Test Probe (`test_connection`)**<br>`await provider.test_connection()` executes a cheap probe call using a trivial prompt (e.g. `messages=[{"role": "user", "content": "ping"}]`, `max_output_tokens=1`):<br>- On success, returns `ConnectionReport(ok=True, latency_ms=float >= 0.0, message="Connection successful", model=result.model)`.<br>- On expected `LLMError`, returns `ConnectionReport(ok=False, latency_ms=None, message=f"{exc.code}: {exc.message}")` without raising.<br>- Never swallows `asyncio.CancelledError`. |
| **AC-23** | `[P1]` | **Keyless / Local Provider Compatibility**<br>When [`ProviderConfig.api_key`](file:///D:/marti/SciPrograms/backend/app/llm/models.py#L102) is empty (`""`), the client is constructed using [`KEYLESS_API_KEY_PLACEHOLDER`](file:///D:/marti/SciPrograms/backend/app/llm/chat_completions.py#L43) (`"no-key-required"`) so that local, keyless Responses-compatible servers (e.g. local gateways) initialize without error. |
| **AC-24** | `[P1]` | **Custom Headers Forwarding**<br>Custom headers defined in [`ProviderConfig.custom_headers`](file:///D:/marti/SciPrograms/backend/app/llm/models.py#L107) are passed to `AsyncOpenAI(default_headers=...)` and forwarded on requests. |
| **AC-25** | `[P1]` | **Whitespace-Only Output Content Rejection**<br>If `response.output_text` consists solely of whitespace (e.g. `"   \n\t  "`), the adapter rejects it and raises [`LLMInvalidResponseError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L71-L75)(`"Provider returned empty content"`). |
| **AC-26** | `[P1]` | **Cross-Protocol Caller Interchangeability**<br>A caller function written against [`LLMProvider`](file:///D:/marti/SciPrograms/backend/app/llm/base.py#L16-L46) executes against both [`OpenAIChatCompletionsProvider`](file:///D:/marti/SciPrograms/backend/app/llm/chat_completions.py#L71-L215) and [`OpenAIResponsesProvider`](file:///D:/marti/SciPrograms/backend/app/llm/responses.py) receiving identical [`LLMResult`](file:///D:/marti/SciPrograms/backend/app/llm/models.py#L70-L78) structure (with respective `protocol` tags) and identical error codes for identical failure modes, with zero caller branching. |

---

## 3. Priority P2 (OPTIONAL) — Future Extensions & Hooks (Non-Blocking)

| ID | Priority | Description & Verification Target |
| :--- | :--- | :--- |
| **AC-27** | `[P2]` | **Unimplemented Streaming Hook**<br>Calling `provider.generate_stream(request)` raises `NotImplementedError` per the base contract in [`LLMProvider`](file:///D:/marti/SciPrograms/backend/app/llm/base.py#L35-L45); no streaming subsystem is implemented in this task. |
| **AC-28** | `[P2]` | **Exposed Client Builder Hook**<br>A module-level client builder function (e.g. `build_responses_client` or shared `build_client`) is exposed to allow deterministic test inspection of client kwargs. |

---

## 4. Expected Automated Tests

The test suite in [`backend/tests/test_llm_responses.py`](file:///D:/marti/SciPrograms/backend/tests/test_llm_responses.py) must be runnable via `pytest` and include at minimum the following automated test cases:

| ID | Test Name | Purpose / Assertions | Priority |
| :--- | :--- | :--- | :--- |
| **AC-29.01** | `test_responses_provider_export` | Asserts `OpenAIResponsesProvider` is exported in `app.llm` and satisfies `issubclass(..., LLMProvider)`. | `[P0]` |
| **AC-29.02** | `test_responses_package_import_is_inert` | Asserts importing `app.llm` produces zero side effects and exit code 0. | `[P0]` |
| **AC-29.03** | `test_responses_protocol_identifier` | Asserts `provider.protocol == "responses"`. | `[P0]` |
| **AC-29.04** | `test_responses_generate_success_normalized_result` | Mocks `responses.create` returning output text, model, usage; asserts `LLMResult.text`, `model`, `protocol == "responses"`. | `[P0]` |
| **AC-29.05** | `test_responses_usage_normalization` | Verifies `input_tokens` $\rightarrow$ `prompt_tokens`, `output_tokens` $\rightarrow$ `completion_tokens`, and `total_tokens` normalized. | `[P0]` |
| **AC-29.06** | `test_responses_missing_usage_tolerated` | Verifies `response.usage = None` results in `LLMResult.usage is None` without error. | `[P0]` |
| **AC-29.07** | `test_responses_single_system_message_to_instructions` | Verifies single system message maps to `instructions: str` and is omitted from `input`. | `[P0]` |
| **AC-29.08** | `test_responses_multiple_system_messages_joined` | Verifies multiple system messages are concatenated with `\n\n` into `instructions`. | `[P0]` |
| **AC-29.09** | `test_responses_no_system_message_omits_instructions` | Verifies `instructions` is omitted from payload kwargs when no system message is present. | `[P0]` |
| **AC-29.10** | `test_responses_non_system_messages_to_input` | Verifies `user` and `assistant` messages are forwarded in `input` in order. | `[P0]` |
| **AC-29.11** | `test_responses_verbatim_base_url` | Asserts `base_url` is passed through verbatim without stripping trailing slash or appending `/v1`. | `[P0]` |
| **AC-29.12** | `test_responses_max_retries_zero` | Inspects constructed client; asserts `max_retries == 0`. | `[P0]` |
| **AC-29.13** | `test_responses_max_output_tokens_native_parameter` | Asserts parameter is passed as `max_output_tokens` (NEVER `max_tokens` or `max_completion_tokens`). | `[P0]` |
| **AC-29.14** | `test_responses_token_limit_precedence` | Asserts `request.max_output_tokens` overrides `config.max_output_tokens`. | `[P0]` |
| **AC-29.15** | `test_responses_token_limit_omitted_when_unset` | Asserts `max_output_tokens` is omitted from payload when neither request nor config specifies it. | `[P0]` |
| **AC-29.16** | `test_responses_temperature_and_timeout_forwarding` | Asserts request temperature and timeout override config defaults. | `[P0]` |
| **AC-29.17** | `test_responses_status_incomplete_with_text_succeeds` | Verifies `status == "incomplete"` with non-empty `output_text` returns `LLMResult`. | `[P0]` |
| **AC-29.18** | `test_responses_status_incomplete_empty_text_raises` | Verifies `status == "incomplete"` with empty `output_text` raises `LLMInvalidResponseError`. | `[P0]` |
| **AC-29.19** | `test_responses_status_failed_server_error` | Mocks `status == "failed"` with `error.code == "server_error"`; asserts `LLMServerError` (`retryable=True`). | `[P0]` |
| **AC-29.20** | `test_responses_status_failed_rate_limit` | Mocks `status == "failed"` with `error.code == "rate_limit_exceeded"`; asserts `LLMRateLimitError` (`retryable=True`). | `[P0]` |
| **AC-29.21** | `test_responses_status_failed_timeout` | Mocks `status == "failed"` with `error.code == "vector_store_timeout"`; asserts `LLMTimeoutError` (`retryable=True`). | `[P0]` |
| **AC-29.22** | `test_responses_status_failed_bad_request` | Mocks `status == "failed"` with `error.code == "invalid_prompt"`; asserts `LLMBadRequestError` (`retryable=False`). | `[P0]` |
| **AC-29.23** | `test_responses_refusal_raises_invalid_response` | Mocks response containing refusal content; asserts `LLMInvalidResponseError` (`retryable=False`). | `[P0]` |
| **AC-29.24** | `test_responses_malformed_response_guards` | Mocks responses with `output=None`, empty items, non-string text; asserts `LLMInvalidResponseError`. | `[P0]` |
| **AC-29.25** | `test_responses_sdk_status_errors_normalized` | Parametrized test asserting 401, 403, 404, 429, 500 normalize to correct `LLMError` subclasses. | `[P0]` |
| **AC-29.26** | `test_responses_secret_redacted_in_errors_and_repr` | Asserts raw API key is scrubbed from exception messages, repr, and logs. | `[P0]` |
| **AC-29.27** | `test_responses_cancellation_propagates` | Asserts `asyncio.CancelledError` propagates without being wrapped into `LLMError`. | `[P0]` |
| **AC-29.28** | `test_responses_no_vendor_branching` | Source-level AST check verifying no vendor/model string comparisons in the package. | `[P0]` |
| **AC-29.29** | `test_responses_connection_probe_success` | Asserts `test_connection()` returns `ConnectionReport(ok=True, model=...)`. | `[P1]` |
| **AC-29.30** | `test_responses_connection_probe_failure_non_raising` | Asserts `test_connection()` returns `ConnectionReport(ok=False)` on `LLMError` without raising. | `[P1]` |
| **AC-29.31** | `test_responses_custom_headers_forwarded` | Asserts `custom_headers` are passed to the client. | `[P1]` |
| **AC-29.32** | `test_cross_protocol_caller_interchangeability` | Executes generic caller with both providers; asserts identical result shapes and error handling. | `[P1]` |

---

## 5. Explicit Failure Conditions

The implementation **FAILS** if any of the following conditions occur:

- **FC-01 (Scope Creep)**: The implementation creates classes, functions, or schemas for protocol auto-detection (DS-BE-004), provider profile database persistence (DS-BE-005), retry engine, PDF translation, Paper QA, Document Intelligence, frontend, or Tauri.
- **FC-02 (Shared Contract Mutation)**: The implementation modifies [`backend/app/llm/base.py`](file:///D:/marti/SciPrograms/backend/app/llm/base.py), [`backend/app/llm/models.py`](file:///D:/marti/SciPrograms/backend/app/llm/models.py), or [`backend/app/llm/errors.py`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py), or introduces new request/result models or new error classes.
- **FC-03 (Secret Exposure)**: The plaintext API key appears in any log output, console print, exception message, `repr(provider.config)`, or `str(provider.config)`.
- **FC-04 (Base URL Mutation)**: The adapter rewrites, trims, normalizes, or appends to `base_url` (e.g. stripping slashes or appending `/v1`).
- **FC-05 (Vendor Branching)**: The adapter contains conditional logic branching on vendor names or model names (e.g. `if "openai" in base_url` or `if "gpt" in model`).
- **FC-06 (Parameter Naming Violation)**: The adapter passes `max_tokens` or `max_completion_tokens` to `client.responses.create(...)` instead of the native `max_output_tokens`.
- **FC-07 (Silent SDK Retries)**: The adapter constructs `AsyncOpenAI` without `max_retries=0`, permitting silent SDK retries.
- **FC-08 (Leaked Primitive Exceptions)**: A malformed response, refusal, or unhandled SDK error raises `AttributeError`, `IndexError`, `KeyError`, `TypeError`, or a raw SDK exception instead of a normalized [`LLMError`](file:///D:/marti/SciPrograms/backend/app/llm/errors.py#L34-L44).
- **FC-09 (Swallowed Async Cancellation)**: A broad `try/except` catches and swallows or wraps `asyncio.CancelledError` into `LLMError`.
- **FC-10 (Regression)**: Any of the 88 existing DS-BE-002 tests, 182 total backend tests, or 27 frontend tests fail.
- **FC-11 (Test Network Access)**: Any test attempts a real network connection or fails the autouse offline socket guard.
