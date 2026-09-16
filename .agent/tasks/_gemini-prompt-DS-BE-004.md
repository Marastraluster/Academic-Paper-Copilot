You are the independent Acceptance Criteria Agent for task DS-BE-004.

You are NOT implementing this task. You are NOT writing production code.

Define objective, testable acceptance criteria BEFORE implementation begins.

Scope:
- protocol auto-detection (choose between two EXISTING adapters)
- cached resolution per profile, never per request
- connection test reporting protocol/model/latency
- normalized errors when neither protocol works
- no secret leakage
- tests using mocks only

Explicitly exclude:
- provider profile persistence / credential storage (DS-BE-005)
- retry engine (DS-BE-006)
- PDF translation, Paper QA, Document Intelligence, frontend, Tauri

Return criteria grouped as P0 MUST / P1 SHOULD / P2 OPTIONAL, numbered AC-01, AC-02, ...
Tag every criterion. Only P0 blocks completion.

=====================================================================
TASK_DESCRIPTION
=====================================================================

# DS-BE-004 — Protocol Auto-Detection + Connection Test

## Goal
Let a caller hand over a configured profile without knowing whether the endpoint speaks
Responses or Chat Completions, and get back a working provider. Plus a connection test that
reports what it found.
DS-BE-002 and DS-BE-003 built two adapters. This task builds the thing that chooses between
them — and makes that choice ONCE, not per request.

## Product Context
Users configure an arbitrary endpoint. Most compatible gateways implement Chat Completions;
some implement Responses; a few implement both. The brief requires `Auto` as a first-class
protocol option: the user should not have to know which one their provider speaks.
The settings screen needs a Test Connection action reporting protocol, model and latency —
which is the visible product surface this task feeds.

## Technical Context
backend/app/llm/ currently holds two adapters behind one LLMProvider contract:
  base.py             LLMProvider ABC (generate, test_connection)
  models.py           LLMRequest, LLMResult, LLMUsage, ProviderConfig, ConnectionReport
  errors.py           error hierarchy + normalize_exception
  client.py           shared build_client, KEYLESS_API_KEY_PLACEHOLDER
  chat_completions.py OpenAIChatCompletionsProvider, build_client, PROBE_PROMPT, PROBE_MAX_TOKENS
  responses.py        OpenAIResponsesProvider, build_responses_client
253 backend tests pass.

## Requirements
R1. A resolver that, given a ProviderConfig with protocol `auto`, returns a working
    LLMProvider — without the caller learning which protocol was chosen except by inspecting
    the returned provider or LLMResult.protocol.
R2. Detection order: Responses first, then Chat Completions.
R3. Detection is cached per profile, keyed on something that identifies the endpoint+model.
    A second resolve for the same key must not re-probe. Detection must NEVER run per
    translation block or per generation call.
R4. An explicit protocol (chat_completions / responses) bypasses detection entirely.
R5. If neither protocol works, raise a normalised error carrying enough information to explain
    what was tried. A partially-working endpoint must not be reported as a generic failure.
R6. test_connection() on the resolved provider reports protocol, model and latency.
R7. Detection must not leak the API key into any log, cache key, repr, or error message.
R8. Concurrent detection for the same key must not stampede — one probe, not N.
R9. No vendor-specific branching. No translation, PDF, or retrieval logic.

## Known Cleanup (carried from DS-BE-003)
PROBE_PROMPT / PROBE_MAX_TOKENS currently live in chat_completions.py and are imported by
responses.py — a deliberate but mild coupling. Detection needs them too, which makes a shared
home correct. Move them to client.py and have both adapters import from there.

## Known Risks
- Detection on the hot path. If any code path re-probes per request, translating a 300-block
  document would issue hundreds of probes.
- Misclassifying an auth failure as "unsupported protocol", producing a confusing second error
  that hides the real cause.
- Cache key too coarse (wrong protocol served for a different model) or too fine (never hits).

=====================================================================
DESIGN QUESTIONS THE CRITERIA MUST SETTLE
=====================================================================

Give an explicit, verifiable rule for each:

Q1. CACHE KEY. What identifies a profile for caching? Base URL alone would collide across
    models; base URL + model ignores key rotation, which is probably fine (the protocol rarely
    changes with the key). What about a key change pointing at a different backend behind the
    same URL? State the exact key composition.

Q2. WHAT COUNTS AS "SUPPORTS RESPONSES"? A probe returning 404 (endpoint absent) clearly means
    no. What about 401 (key rejected) — that means the PROTOCOL exists but the credentials are
    wrong; falling through to Chat Completions would produce a misleading second error. Which
    failure classes should STOP detection rather than fall through? Give the exact rule per
    error type (authentication, permission, bad request, rate limit, timeout, connection,
    server error, not found, invalid response).

Q3. CACHE LIFETIME. In-process only, or persisted? (Profile persistence is DS-BE-005.)
    State it and say what happens across a process restart.

Q4. CACHE INVALIDATION. Is there an explicit way to force re-detection? Name the mechanism.

Q5. CONCURRENCY. One in-flight probe per key with waiters, or independent probes? State the
    observable behaviour a test should assert.

=====================================================================
PRODUCT_ARCHITECTURE
=====================================================================

  Application (translation, context, Paper QA — LATER TASKS)
      ↓
  resolve_provider(config)              <- THIS TASK
      ├── OpenAIResponsesProvider       <- DS-BE-003  (tried first)
      └── OpenAIChatCompletionsProvider <- DS-BE-002  (fallback)
      ↓
  OpenAI-compatible HTTP API

Both adapters produce an identical LLMResult and identical error codes for identical failures
(verified by DS-BE-003 AC-26). That is what makes detection safe: whichever protocol is
chosen, the caller sees the same shapes.

Existing backend conventions that must be followed:
- Structured JSON logging; any field named api_key/authorization/token/secret/password is
  redacted to "[REDACTED]"; free text is scrubbed for "Bearer <token>" and "key=value".
- The API key literal is ALSO stripped from error messages explicitly, because redact_text only
  recognises those two shapes.
- Importing app modules must have no side effects.
- The test suite runs entirely offline under an autouse socket guard that fails any non-loopback
  connection.

=====================================================================
RELEVANT_EXISTING_BEHAVIOR
=====================================================================

- app/llm/ exists with 7 modules and 253 passing backend tests total.
- Existing error taxonomy (all with a stable `code` and a `retryable` flag):
  LLMAuthenticationError (401), LLMPermissionDeniedError (403), LLMRateLimitError (429),
  LLMTimeoutError, LLMConnectionError, LLMServerError (5xx), LLMBadRequestError (400/422),
  LLMNotFoundError (404), LLMInvalidResponseError, LLMAPIError (fallback).
- Both adapters expose test_connection() returning ConnectionReport(ok, latency_ms, message, model).
- Both adapters build their client via a shared helper with base_url verbatim, max_retries=0,
  forwarded timeout and custom headers.
- ProviderConfig is a frozen pydantic model: base_url, api_key (SecretStr), model, timeout_s,
  temperature, max_output_tokens, custom_headers. It has NO protocol field currently — adding
  one is a decision the criteria should make explicit (or the criteria may say detection takes
  the protocol as a separate argument).
- No provider-profile database or credential store exists. This task creates neither.

=====================================================================

Now produce the acceptance criteria document in Markdown. Use a table with columns
ID | Priority | Description & Verification Target. Be specific and objectively verifiable —
prefer concrete values (status codes, exact key composition, error types) over adjectives.
Give an explicit answer to each of Q1-Q5.
