# Evidence — DS-BE-002 LLMProvider Interface + OpenAI Chat Completions Adapter

- **Date:** 2026-09-16
- **Agent:** DeepSeek (Claude Code CLI)
- **Acceptance criteria:** `docs/acceptance/DS-BE-002.md` (Gemini, frozen before implementation)
- **Verdict:** **DONE — 34/34 criteria PASS, 10/10 failure conditions avoided**

## Implementation Summary

A vendor-neutral LLM layer under `backend/app/llm/`. Callers use `LLMProvider` and the
request/result models; they never import the OpenAI SDK, read `response.choices`, interpret an
HTTP status, or touch an authorization header. One implementation ships: an OpenAI-compatible
**Chat Completions** adapter that works against any conforming endpoint.

No translation, PDF, glossary, or retrieval logic is present, and the Responses protocol,
auto-detection, profile persistence and credential storage are explicitly deferred.

## Modified Files

| File | Change |
|---|---|
| `backend/app/llm/__init__.py` | New — public exports |
| `backend/app/llm/models.py` | New — `ChatMessage`, `LLMRequest`, `LLMUsage`, `LLMResult`, `ConnectionReport`, `ProviderConfig` |
| `backend/app/llm/errors.py` | New — error hierarchy + `normalize_exception` |
| `backend/app/llm/base.py` | New — `LLMProvider` ABC |
| `backend/app/llm/chat_completions.py` | New — adapter, `build_client` |
| `backend/tests/test_llm_provider.py` | New — 88 tests |
| `backend/pyproject.toml` | Declare `openai~=3.14.0` (AC-31); enable `asyncio_mode = "auto"` |
| `backend/tests/test_isolation.py` | **One guard list updated** — see "Superseded guard" below |
| `backend/README.md` | Documents the package and its usage |
| `docs/acceptance/DS-BE-002.md` | Frozen criteria + review (authored by Gemini, reviewed by DeepSeek) |

`frontend/` was **not modified**: its newest file is timestamped **12:36**, while this task's
work began at **19:10**. Verified by mtime, since no git baseline commit exists.

### Superseded guard (DS-BE-001 → DS-BE-002)

`backend/tests/test_isolation.py` contained a guard asserting `openai` must **not** appear in
the dependency manifest — written for DS-BE-001's AC-11, whose intent was *no premature
heavyweight dependencies*. DS-BE-002's AC-31 requires the opposite.

The edit is the minimum possible: `openai` moves from the forbidden list to the required list,
with a comment recording why. The remaining prohibitions (`torch`, `onnxruntime`, `opencv`,
`chromadb`, `anthropic`, `pdf2zh`) still stand. **No security guard was weakened** — that list
was a scope guard, not a security control.

## Gemini Acceptance Criteria Source

`docs/acceptance/DS-BE-002.md`, authored by `gemini-3.8-flash-high` via `agy` **before any
implementation code existed**. 34 criteria (24 P0, 7 P1, 3 P2), 25 specified tests, 10 failure
conditions. Reviewed and frozen with no `AC_CHANGE_REQUEST`.

Three facts were established by executing the SDK before design, rather than assumed:

1. `APITimeoutError` **subclasses** `APIConnectionError` — so timeout must be matched *first*
   in `normalize_exception`. Getting this order wrong would have silently reported every
   timeout as a connection failure.
2. The SDK **appends a trailing slash** to `base_url` internally. We pass the user's string
   verbatim and do not "correct" this; AC-06 is verified at the constructor boundary.
3. The SDK **rejects an empty API key**, so AC-27's keyless local-server case required a
   placeholder at client construction.

## Automated Tests Run

```
$ cd backend && .venv/Scripts/python -m pytest
    → 182 passed, 1 warning in 3.72s
      (94 pre-existing + 88 new)

$ cd frontend && npm run test
    → 5 files, 27 tests, all passed
```

The one warning comes from Starlette's own `testclient.py`, not this codebase.

## Automated Test Results

| Suite | Result |
|---|---|
| `tests/test_llm_provider.py` (new) | **88 passed** |
| `tests/test_{config,db,errors,health,isolation,logging}.py` (DS-BE-001) | **94 passed** |
| Frontend vitest | **27 passed** |
| **Total** | **209 passed, 0 failed** |

Offline guarantee: the autouse `block_external_network` fixture permits only loopback, and no
test triggered it.

## Manual Verification

Executed against a **real HTTP server on loopback** speaking the actual Chat Completions
protocol — not a mock. This is separate from the pytest suite, which AC-24 scopes to mocks.

```
loopback endpoint: http://127.0.0.1:59457

[1] generate() -> text='OK' model='live-model' protocol='chat_completions'
    usage=LLMUsage(prompt_tokens=3, completion_tokens=1, total_tokens=4)
    request path  : /v1/chat/completions
    auth header   : Bearer sk-live-LIVETEST
    request body  : {'messages': [{'role': 'user', 'content': 'ping'}], 'model': 'live-model'}

[2] test_connection() -> ok=True latency=2.3ms model='live-model'

[3] verbatim base URL: request hit /v1/chat/completions

[4] real HTTP 503 -> LLMServerError code=LLM_SERVER_ERROR retryable=True
[5] key on the wire: yes | leaked into our surfaces: 0

All live checks passed.
```

What this proves that mocks cannot: the SDK builds the right request path from a verbatim base
URL, the key reaches the wire as a bearer token, a genuine JSON response parses into a
normalised result, and a genuine HTTP 503 maps to `LLMServerError` with `retryable=True`.

**A defect in my own check was found and fixed here.** The first version asserted the key was
absent from the mock server's capture — which was wrong, because the key *must* travel in the
`Authorization` header. It printed `False` while the script still reported success. The check
now asserts the correct property: the key reaches the wire **and** appears in zero of our own
surfaces (exception `str`/`repr`/`message`, config `str`/`repr`).

## Security Verification

- **Key never in a repr, `str`, or `model_dump`** — asserted for JSON and Python modes.
- **Key never in an exception message** — both `Bearer sk-…` shaped and a bare key literal are
  tested. The bare case matters because `redact_text` only recognises `Bearer`/`key=` shapes, so
  the provider additionally strips the known key literal outright.
- **Key never in the log stream** — asserted with a captured log handler on a failing call.
- **Key reaches the wire correctly** — confirmed by the live server's captured auth header.
- **No secret in the repository** — no key material added; tests use obvious fixtures.
- No shell invocation, no `eval`, no dynamic import, no credential persistence.

## Regression Verification

| Check | Result |
|---|---|
| 94 DS-BE-001 backend tests | **PASS** |
| 27 frontend tests | **PASS** |
| Frontend files modified | **None** (mtime evidence) |
| Files outside `backend/app/llm/`, `backend/tests/`, allowed docs | **None, except two documented edits** |

The two documented edits are `backend/pyproject.toml` (AC-31 mandates it, plus one pytest
option) and `backend/tests/test_isolation.py` (one superseded guard list, explained above).

## Acceptance Criteria Evaluation

Every criterion from `docs/acceptance/DS-BE-002.md`. Nothing weakened, deleted, or skipped.

### P0 — MUST

| AC | Verdict | Evidence |
|---|---|---|
| AC-01 Package structure & inert import | **PASS** | Subprocess import emits nothing, writes no file; all 20 required names exported |
| AC-02 Protocol-neutral `LLMProvider` | **PASS** | `LLMProvider` ABC with `generate` + `test_connection`; adapter is a subclass; no protocol-specific parameter anywhere |
| AC-03 Request models | **PASS** | Frozen models; empty `messages` rejected; `model_fields` is exactly the four permitted names; plain dicts coerce |
| AC-04 `ProviderConfig` validation | **PASS** | Blank `base_url`/`model`, non-positive timeout, out-of-range temperature, zero max tokens all raise |
| AC-05 API key masking | **PASS** | `SecretStr`; key absent from `repr`, `str`, `model_dump()` (JSON and Python modes) |
| AC-06 Verbatim base URL | **PASS** | 5 parametrized URLs incl. trailing slash, double slash, and no `/v1`; all passed through unchanged |
| AC-07 `max_tokens` mapping | **PASS** | Request overrides config; config used when request omits; omitted when both unset; `max_completion_tokens` asserted absent |
| AC-08 No vendor branching | **PASS** | AST-based guard (ignores prose); payloads byte-identical across 4 vendor endpoints except `model` |
| AC-09 `max_retries=0` | **PASS** | Asserted on the stub **and** on a real `AsyncOpenAI` instance |
| AC-10 `LLMResult` normalisation | **PASS** | All four fields asserted; `type(result) is LLMResult`; result has no `choices` |
| AC-11 Usage normalisation & nullability | **PASS** | Present → normalised; `usage=None` → `None`, call still succeeds; absent attribute tolerated; partial usage completed |
| AC-12 Error hierarchy | **PASS** | All errors inherit `LLMError` with non-empty `message`, stable `code`, `retryable`, `cause` |
| AC-13 401 → authentication | **PASS** | `LLM_AUTHENTICATION_ERROR`, retryable `False` |
| AC-14 403 → permission | **PASS** | `LLM_PERMISSION_DENIED`, retryable `False` |
| AC-15 429 → rate limit | **PASS** | `LLM_RATE_LIMIT`, retryable `True` |
| AC-16 Timeout | **PASS** | Both `APITimeoutError` and `asyncio.TimeoutError` → `LLM_TIMEOUT`, retryable `True` |
| AC-17 Connection failure | **PASS** | `LLM_CONNECTION_ERROR`, retryable `True` |
| AC-18 5xx → server error | **PASS** | 500/502/503/504 all parametrized → `LLM_SERVER_ERROR`, retryable `True` |
| AC-19 400/422 → bad request | **PASS** | Both → `LLM_BAD_REQUEST`, retryable `False` |
| AC-20 404 → not found | **PASS** | `LLM_NOT_FOUND`, retryable `False` |
| AC-21 Malformed responses | **PASS** | 8 shapes (empty/None choices, None message, None/empty/whitespace/non-string content, missing attribute) + SDK validation error → `LLM_INVALID_RESPONSE`; no primitive exception leaks |
| AC-22 Secret redaction in errors | **PASS** | `Bearer` form and bare key literal both redacted; key absent from `str`/`repr`/`message` |
| AC-23 Cancellation propagation | **PASS** | Cancelled mid-flight `generate()` **and** `test_connection()` both raise `CancelledError`, never wrapped |
| AC-24 Offline test suite | **PASS** | Injected fakes throughout; socket guard never fired |
| AC-25 Regression protection | **PASS** | 94 backend + 27 frontend preserved; no unauthorized file modified |

### P1 — SHOULD

| AC | Verdict | Evidence |
|---|---|---|
| AC-26 `test_connection` probe | **PASS** | Returns `ok=True` with latency and model; probe payload asserted cheap (`max_tokens=1`, one message); failures return `ok=False` rather than raising |
| AC-27 Keyless local provider support | **PASS** | Empty key accepted by config; client builds successfully via documented placeholder |
| AC-28 Whitespace-only content rejected | **PASS** | `"   \n\t  "` → `LLM_INVALID_RESPONSE` |
| AC-29 Unmapped `APIError` fallback | **PASS** | → `LLM_API_ERROR`; retryable `False` at 418, `True` at 599 |
| AC-30 Custom headers forwarded | **PASS** | `default_headers` receives the mapping; `None` when unset |
| AC-31 `openai` declared explicitly | **PASS** | `openai~=3.14.0` in `pyproject.toml` |

### P2 — OPTIONAL

| AC | Verdict | Evidence |
|---|---|---|
| AC-32 Streaming hook | **PASS** | `generate_stream` declared on the ABC; iterating raises `NotImplementedError`; no streaming subsystem built |
| AC-33 Per-request timeout override | **PASS** | `LLMRequest.timeout_s` forwarded to `create()` |
| AC-34 Structured `ConnectionReport` | **PASS** | Dataclass with `ok`, `latency_ms`, `message`, `model` |

### Specified tests AC-35.1 … AC-35.25

All 25 specified test cases exist and pass. AC-35.18, 35.19 and 35.20 were expanded into 8
parametrized malformed-response shapes; AC-35.10–35.17 into a 7-case status-error table plus a
4-case 5xx table.

### Failure conditions

| FC | Verdict |
|---|---|
| FC-01 Scope creep | **AVOIDED** — no Responses, auto-detection, persistence, keyring, PDF, or QA code exists |
| FC-02 Secret exposure | **AVOIDED** — 4 dedicated tests plus live verification |
| FC-03 Base URL mutation | **AVOIDED** — 5 verbatim URL cases plus a live wire check |
| FC-04 Vendor branching | **AVOIDED** — AST guard; identical payload across vendors |
| FC-05 Proprietary parameter leak | **AVOIDED** — `max_completion_tokens` asserted absent in 2 tests |
| FC-06 Silent SDK retries | **AVOIDED** — `max_retries=0` asserted on the real client |
| FC-07 Leaked primitive exceptions | **AVOIDED** — 8 malformed shapes + a `RuntimeError` injection all normalise |
| FC-08 Swallowed cancellation | **AVOIDED** — no `except BaseException`; cancellation tested on both entry points |
| FC-09 Test network access | **AVOIDED** — mocked throughout; socket guard never fired |
| FC-10 Regression | **AVOIDED** — 209 tests green |

**Result: 34/34 PASS. No FAIL, no NOT_APPLICABLE.**

## Known Limitations

1. **No git baseline commit** (carried from DS-BE-001). `git diff` still reports nothing, so
   "no unrelated changes" is evidenced by mtime and explicit file listing instead. This needs a
   user decision and remains the single largest process gap in the project.
2. **The SDK normalises `base_url` internally** — the client reports `…/v1/` after being given
   `…/v1`. This is the SDK's own behaviour; we deliberately do not correct it, because
   correcting it *would* be the mutation AC-06/FC-03 prohibit. Verified at the constructor
   boundary, which is the correct contract point.
3. **`max_tokens` is incompatible with OpenAI's newest reasoning models**, which require
   `max_completion_tokens`. This is a deliberate trade in favour of the broad compatibility the
   product is built on (DeepSeek, OpenRouter, SiliconFlow, local servers). A per-profile
   override can be added if a user needs it.
4. **The keyless placeholder is an addition beyond AC-27's literal text.** AC-27 only requires
   the config to *permit* an empty key; without the placeholder such a config could never build
   a client, making the criterion hollow. Recorded rather than silently added.
5. **No retry engine.** Errors carry `retryable`, and the SDK's own retries are disabled, but
   nothing re-issues a request yet — that belongs to a dedicated later layer (brief §17).
6. **No streaming.** The contract exposes the hook; the implementation does not.
7. **`test_isolation.py` will block Phase 3.** Its guard forbids any backend source mentioning
   `pdf2zh`/`PDFMathTranslate` — correct now, but the PDFMathTranslate adapter must import
   upstream legitimately. That guard needs a deliberate, documented narrowing at Phase 3
   (scoped to "must not touch upstream cache/config *paths*"). Flagged here so it is a planned
   change rather than a surprise.
8. **`test_connection` does not verify the model separately.** A provider that accepts the key
   but rejects the model returns 404 → `LLM_NOT_FOUND`, which the report surfaces as a failure.
   That is adequate, but the message distinguishes them only by code. DS-BE-004 will refine it.

## Recommended Next Task

**DS-BE-003 — OpenAI Responses API Adapter.** The interface, models, and error taxonomy were
designed for it: a Responses provider implements the same two methods, produces the same
`LLMResult`, and reuses `normalize_exception` unchanged. Chat Completions stays as the
regression baseline, so a Responses bug cannot silently break the working protocol.
