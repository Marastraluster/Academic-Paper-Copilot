# Evidence — DS-BE-003 OpenAI Responses API Adapter

- **Date:** 2026-09-16
- **Agent:** DeepSeek (Claude Code CLI)
- **Acceptance criteria:** `docs/acceptance/DS-BE-003.md` (Gemini, frozen before implementation)
- **Verdict:** **DONE — 28/28 criteria PASS, 11/11 failure conditions avoided**

## Implementation Summary

`OpenAIResponsesProvider` implements the existing `LLMProvider` contract against
`POST /v1/responses`. It reuses `LLMRequest`, `LLMResult`, `LLMUsage`, `ProviderConfig`,
`normalize_exception` and the entire error taxonomy **without altering any of them** — which
was the real point of the task: proving the DS-BE-002 abstraction absorbs a second protocol
rather than being Chat-Completions-shaped in disguise.

Protocol differences are absorbed at the adapter boundary:

| Concept | Chat Completions | Responses | Absorbed by |
|---|---|---|---|
| Token limit | `max_tokens` | `max_output_tokens` | `_build_payload` |
| Token accounting | `prompt_tokens` / `completion_tokens` | `input_tokens` / `output_tokens` | `_extract_usage` |
| System prompt | a `system` message | `instructions` | `_build_payload` |
| Failure signal | HTTP status | HTTP 200 + `status="failed"` | `_raise_for_failed_response` |

## Modified Files

| File | Change |
|---|---|
| `backend/app/llm/responses.py` | **New** — the adapter |
| `backend/app/llm/client.py` | **New** — protocol-neutral SDK-client construction |
| `backend/tests/test_llm_responses.py` | **New** — 71 tests |
| `backend/app/llm/__init__.py` | Export `OpenAIResponsesProvider`, `build_responses_client` |
| `backend/app/llm/chat_completions.py` | **Minimum change** — `build_client` now delegates (below) |
| `docs/acceptance/DS-BE-003.md` | Frozen criteria + review |

**`base.py`, `models.py` and `errors.py` are untouched** — verified by a test asserting no
Responses-specific type (`ResponsesRequest`, `LLMRefusalError`) leaked into them. `FC-02`
held.

`frontend/` was not modified: its newest file is **12:36**, while this task's work began at
**19:32** (mtime evidence, since no git baseline commit exists).

### The one edit to a DS-BE-002 file

DS-BE-003's AC-28 requires a client-builder hook. `build_client` lived inside
`chat_completions.py`, and a Responses adapter importing from the Chat Completions adapter
would be a genuine layering smell. Resolution:

- Construction logic moved verbatim to a new protocol-neutral `app/llm/client.py`.
- `chat_completions.build_client` remains as a thin wrapper that resolves `AsyncOpenAI` from
  **its own module namespace**.
- `responses.py` has `build_responses_client`, doing the same for its own namespace.

The wrapper is not ceremony: the DS-BE-002 test suite substitutes `chat_completions.AsyncOpenAI`
to inspect client construction, and that substitution must keep working. Each adapter now has
an independently patchable seam. **`chat_completions` behaviour is unchanged** and all 182
pre-existing tests pass — verified immediately after the extraction, before writing any
Responses code.

## Gemini Acceptance Criteria Source

`docs/acceptance/DS-BE-003.md`, authored by `gemini-3.8-flash-high` via `agy` **before any
implementation code existed**. 28 criteria (21 P0, 5 P1, 2 P2), 32 specified tests, 11 failure
conditions. Reviewed and frozen with no `AC_CHANGE_REQUEST`.

All five design questions the task raised were settled explicitly by the criteria rather than
left to the implementer — which removed the main risk this task carried:

| Q | Settled as |
|---|---|
| Q1 system → `instructions` | Extract system turns; join multiples with `\n\n` (not last-wins, which would silently drop instructions); omit entirely when none |
| Q2 `status="failed"` | Map `error.code` onto the shared taxonomy; missing error → `LLMInvalidResponseError` |
| Q3 `status="incomplete"` | Partial text is usable; no usable text → `LLMInvalidResponseError` |
| Q4 refusals | `LLMInvalidResponseError` with a distinct message; **no new error type** |
| Q5 `max_output_tokens` | Native parameter; request overrides config; omit entirely when unset |

## Automated Tests Run

```
$ cd backend && .venv/Scripts/python -m pytest
    → 253 passed, 1 warning in 4.87s
      (182 pre-existing + 71 new)

$ cd frontend && npm run test
    → 5 files, 27 tests, all passed
```

The warning is Starlette's own `testclient.py`, not this codebase.

## Automated Test Results

| Suite | Result |
|---|---|
| `tests/test_llm_responses.py` (new) | **71 passed** |
| `tests/test_llm_provider.py` (DS-BE-002 baseline) | **88 passed** |
| DS-BE-001 suites | **94 passed** |
| Frontend vitest | **27 passed** |
| **Total** | **280 passed, 0 failed** |

Well-formed responses are built as **real SDK objects**, so the adapter is exercised against
the genuine schema. Stubs are used only for the three shapes the SDK's own types forbid
(unmapped `error.code`, `model=None`, partial `usage`) — a compatible provider is not bound by
those types, which is precisely why the defensive paths exist.

## Manual Verification

Executed against a **real HTTP server on loopback** speaking the Responses protocol.

```
loopback endpoint: http://127.0.0.1:62258

[1] text='OK' model='live-responses-model' protocol='responses'
    usage=LLMUsage(prompt_tokens=13, completion_tokens=5, total_tokens=18)
    path : /v1/responses
    auth : Bearer sk-live-RESPKEY
    instructions: 'be terse\n\ncite sources'
    input       : [{'role': 'user', 'content': 'ping'}]
    max_output_tokens: 64  temperature: 0.3

[2] test_connection() -> ok=True latency=3.9ms model='live-responses-model'

[3] in-band status=failed/server_error -> LLMServerError code=LLM_SERVER_ERROR retryable=True

[4] refusal -> LLMInvalidResponseError msg='Provider refused request: I cannot help with that'
[5] incomplete/no text -> 'Provider returned incomplete response with no usable content'
[6] key on the wire: yes | leaked into our surfaces: 0

All live Responses checks passed.
```

What this proves that mocks cannot: the `instructions`/`input` split is correct on the wire,
system messages never leak into `input`, `max_output_tokens` (not `max_tokens`) is what the
server actually receives, `input_tokens`/`output_tokens` translate into the shared usage shape,
an **in-band `status="failed"` over HTTP 200** maps to a retryable `LLMServerError`, a refusal
is distinguishable from an empty response, and the key travels in the auth header while
appearing in none of our surfaces.

## Security Verification

- Key absent from `str`/`repr`/`message` of errors and from `repr(provider.config)`.
- Key absent from the captured log stream on a failing call.
- In-band failure messages are sanitised through `sanitize_message` — they are attacker-adjacent
  text arriving in a 200 response, so they get the same treatment as SDK messages.
- Key confirmed reaching the wire correctly (live server capture).
- No shell invocation, no `eval`, no credential persistence.

## Regression Verification

| Check | Result |
|---|---|
| 182 pre-existing backend tests | **PASS** |
| 88 DS-BE-002 provider tests | **PASS** |
| 27 frontend tests | **PASS** |
| Frontend files modified | **None** (mtime evidence) |
| `base.py` / `models.py` / `errors.py` modified | **None** |

## Acceptance Criteria Evaluation

### P0 — MUST

| AC | Verdict | Evidence |
|---|---|---|
| AC-01 Export & inert import | **PASS** | Subprocess import emits nothing and writes no file; provider exported |
| AC-02 `LLMProvider` implementation | **PASS** | `issubclass` verified; `protocol == "responses"`; usable through the base type |
| AC-03 Zero modification to shared contract | **PASS** | No new request/result/config/error types; no refusal error introduced |
| AC-04 System → `instructions` (Q1) | **PASS** | Single, multiple-joined-in-order, omitted-when-absent, and excluded from `input` |
| AC-05 Non-system → `input` (Q1) | **PASS** | Order preserved across user/assistant turns |
| AC-06 Verbatim base URL | **PASS** | 4 parametrized URLs incl. trailing slash and no `/v1`; live wire check |
| AC-07 `max_retries=0` | **PASS** | Asserted on the stub **and** a real client instance |
| AC-08 `max_output_tokens` (Q5) | **PASS** | Native name; request overrides config; omitted when unset; `max_tokens`/`max_completion_tokens` asserted absent |
| AC-09 Temperature & timeout | **PASS** | Request overrides config; both omitted when unset; timeout reaches the client |
| AC-10 `LLMResult` normalisation | **PASS** | All four fields; `type(result) is LLMResult`; no `output` attribute escapes |
| AC-11 Usage translation | **PASS** | `input_tokens`→`prompt_tokens`, `output_tokens`→`completion_tokens`; total derived when omitted; absent usage tolerated; unrecognisable usage → `None` |
| AC-12 `incomplete` handling (Q3) | **PASS** | With text → success; without → `LLM_INVALID_RESPONSE` |
| AC-13 `failed` + error mapping (Q2) | **PASS** | 5 real codes mapped to the right types/retryability; unmapped → `LLM_API_ERROR`; missing error → invalid response; message sanitised |
| AC-14 Refusal normalisation (Q4) | **PASS** | `LLM_INVALID_RESPONSE` with a distinct "refused" message, not the generic empty-content message |
| AC-15 Malformed response guards | **PASS** | 7 shapes incl. null `output`, null/empty content, non-string text, whitespace; plus SDK validation error. No primitive exception leaks |
| AC-16 Reused `normalize_exception` | **PASS** | 401/403/429/400/404/5xx + timeout + connection, with the **same codes** as Chat Completions |
| AC-17 Secret redaction | **PASS** | Errors, repr, and log stream; plus in-band error messages |
| AC-18 Cancellation propagation | **PASS** | Verified from **both** `generate()` and `test_connection()` |
| AC-19 Zero vendor branching | **PASS** | AST guard over the whole package |
| AC-20 Offline test suite | **PASS** | Fakes throughout; socket guard never fired |
| AC-21 Regression baseline | **PASS** | 253 backend + 27 frontend green; Chat Completions behaviour untouched |

### P1 — SHOULD

| AC | Verdict | Evidence |
|---|---|---|
| AC-22 Connection probe | **PASS** | Success with latency/model; failure returns `ok=False` without raising; probe asserted cheap; key hidden in the failure message; cancellation not swallowed |
| AC-23 Keyless local providers | **PASS** | Empty key → shared `KEYLESS_API_KEY_PLACEHOLDER` |
| AC-24 Custom headers | **PASS** | Forwarded as `default_headers` |
| AC-25 Whitespace-only rejection | **PASS** | `LLM_INVALID_RESPONSE` |
| AC-26 Cross-protocol interchangeability | **PASS** | One protocol-agnostic caller runs against both providers: identical `LLMResult` types, identical text, equal `usage`, and **identical error codes** for identical failures |

### P2 — OPTIONAL

| AC | Verdict | Evidence |
|---|---|---|
| AC-27 Streaming hook | **PASS** | Raises `NotImplementedError`; no streaming subsystem built |
| AC-28 Client builder hook | **PASS** | `build_responses_client` exposed at module level |

### Specified tests AC-29.01 … AC-29.32

All 32 exist and pass. Several were broadened: AC-29.24 became 7 malformed shapes, AC-29.25 a
6-case status table plus timeout/connection, AC-29.19–29.22 a 5-code parametrization with a
separate unmapped-code fallback.

### Failure conditions

| FC | Verdict |
|---|---|
| FC-01 Scope creep | **AVOIDED** — no detection, persistence, retry engine, PDF, or QA code |
| FC-02 Shared contract mutation | **AVOIDED** — `base.py`/`models.py`/`errors.py` untouched, asserted by test |
| FC-03 Secret exposure | **AVOIDED** — errors, repr, logs, and live wire check |
| FC-04 Base URL mutation | **AVOIDED** — 4 verbatim cases + live check |
| FC-05 Vendor branching | **AVOIDED** — AST guard |
| FC-06 Parameter naming | **AVOIDED** — `max_tokens`/`max_completion_tokens` asserted absent |
| FC-07 Silent SDK retries | **AVOIDED** — `max_retries=0` on a real client |
| FC-08 Leaked primitive exceptions | **AVOIDED** — 7 malformed shapes + in-band failure paths |
| FC-09 Swallowed cancellation | **AVOIDED** — no `except BaseException`; both entry points tested |
| FC-10 Regression | **AVOIDED** — 280 tests green |
| FC-11 Test network access | **AVOIDED** — mocked throughout |

**Result: 28/28 PASS. No FAIL, no NOT_APPLICABLE.**

## Known Limitations

1. **No git baseline commit** (carried from DS-BE-001/002). `git diff` still reports nothing;
   "no unrelated changes" is evidenced by mtime. This remains the largest process gap.
2. **`responses.py` imports `PROBE_PROMPT`/`PROBE_MAX_TOKENS` from `chat_completions`.** This is
   deliberate: sharing the constants structurally guarantees both protocols probe identically,
   which AC-26 wants. It is a mild coupling — if a third protocol appears, these belong in a
   shared home (the natural one, `base.py`, is frozen by FC-02 for this task).
3. **A system-only request produces an empty `input` list.** Not special-cased; the API will
   reject it with 400 → `LLMBadRequestError`, which is a reasonable outcome for a caller error.
   No criterion covered it.
4. **Three defensive paths are stub-tested rather than real-object-tested**, because the SDK's
   types forbid the inputs: an unmapped `error.code` (closed `Literal`), `model=None`
   (non-nullable), and a partial `usage` (strict model). A compatible provider is not bound by
   those types, so the paths are legitimate; the tests just cannot use the real classes.
5. **`max_tokens` vs `max_completion_tokens`** remains a Chat Completions concern only —
   Responses uses the native `max_output_tokens`, so this task sidesteps the trade-off noted in
   DS-BE-002.
6. **No retry engine and no streaming** — unchanged from DS-BE-002, both deliberate.

## Recommended Next Task

**DS-BE-004 — protocol auto-detection + `Test Connection`.** It now has two real
implementations to choose between. The natural shape: try Responses first, fall back to Chat
Completions, cache the resolved protocol per profile, and never re-detect per translation block.
It is also the right moment to relocate the probe constants noted in limitation 2, since
DS-BE-004 legitimately touches detection across both adapters.
