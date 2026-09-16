You are the independent Acceptance Criteria Agent for task DS-BE-002.

You are NOT implementing this task. You are NOT writing production code.

Your job is to define objective, testable acceptance criteria BEFORE implementation begins.

Read TASK_DESCRIPTION, PRODUCT_ARCHITECTURE and RELEVANT_EXISTING_BEHAVIOR below, then produce
the acceptance criteria.

Scope:
- shared LLMProvider abstraction
- normalized provider configuration needed by the adapter
- normalized LLMResult
- OpenAI-compatible Chat Completions
- custom Base URL
- API Key handling
- custom model name
- temperature
- optional max output tokens
- request timeout
- streaming support only if consistent with current architecture
- normalized provider errors
- retry-safe error classification
- no secret leakage
- tests using mocks only

Explicitly exclude:
- Responses API implementation
- Auto protocol detection
- provider profile persistence
- credential storage backend
- PDF translation
- Paper QA
- frontend
- Tauri

Return criteria grouped as P0 MUST / P1 SHOULD / P2 OPTIONAL, numbered AC-01, AC-02, ...
Tag every criterion. Only P0 blocks completion.

Cover:
1. functional behavior
2. custom endpoint compatibility
3. API key handling
4. result normalization
5. error normalization
6. authentication failure
7. rate limiting
8. server errors
9. timeout
10. malformed/empty provider responses
11. streaming behavior if applicable
12. cancellation considerations if applicable
13. secret leakage prevention
14. testability
15. regression protection
16. expected automated tests
17. explicit failure conditions

Acceptance criteria must be objectively verifiable where possible.
Do not expand scope beyond DS-BE-002.

=====================================================================
TASK_DESCRIPTION
=====================================================================

# DS-BE-002 — LLMProvider Interface + OpenAI Chat Completions Adapter

## Goal
Establish the vendor-neutral LLM abstraction the whole product depends on, plus one working
implementation: an OpenAI-compatible Chat Completions adapter.
After this task, higher layers (translation, context analysis, Paper QA) can call
`await provider.generate(request)` and receive a normalized LLMResult without knowing anything
about the OpenAI SDK, HTTP status codes, or authorization headers.

## Product Context
Academic PDF Copilot is local-first: the USER supplies their own endpoint, API key, and model.
The adapter must be OpenAI-COMPATIBLE, not OpenAI-ONLY — it must work equally against DeepSeek,
OpenRouter, SiliconFlow, a private gateway, or a local server.

## Technical Context
backend/app/ currently contains the DS-BE-001 foundation: app factory, settings, error
envelope, structured logging with secret redaction, SQLite bootstrap, health endpoint, and a
94-test suite. NO LLM abstraction exists yet (verified by grep), so there is no duplicate to
reconcile.

Already available and proven:
- redact_text() / is_sensitive_key() in app/logging.py (reuse to sanitize upstream error text)
- pydantic 2 with SecretStr (already a dependency)
- openai SDK 3.14.0 with AsyncOpenAI (present transitively; will be declared explicitly)
- The backend is async (FastAPI); AsyncOpenAI is the correct choice.

## Requirements
R1.  app/llm/ package exporting: provider interface, request/result models, provider config,
     error hierarchy, Chat Completions implementation.
R2.  LLMProvider abstraction covering generate() and test_connection(), structured so a
     Responses adapter can be added later WITHOUT callers changing.
R3.  LLMRequest with protocol-neutral messages, optional temperature, optional max_output_tokens.
R4.  LLMResult with text, model, protocol, usage; usage may be None.
R5.  ProviderConfig: base_url, api_key, model, timeout_s, temperature, max_output_tokens,
     custom_headers.
R6.  Base URL used VERBATIM. No appending /v1, no normalization, no rewriting.
R7.  The API key must never appear in a repr, a log line, or an exception message produced by
     our code.
R8.  Normalized error hierarchy mapping SDK/HTTP failures to internal types, each carrying a
     stable `code` and a `retryable` flag.
R9.  Malformed provider responses (no choices, missing message, content=None, empty content)
     must raise a normalized error — never leak AttributeError/IndexError/TypeError.
R10. AsyncOpenAI used with max_retries=0: retry policy belongs to a later layer, and an SDK
     that silently retries would make error classification and latency unpredictable.
R11. No vendor-specific branching (no `if "deepseek" in base_url`, no `if model.startswith("gpt")`).
R12. No translation, glossary, PDF, or retrieval logic in this package.
R13. Tests use mocks/fakes only — no network, no paid API calls.

## Known Constraints
- Do NOT implement Responses API, protocol auto-detection, profile persistence, or credential
  storage (later tasks).
- max_tokens vs max_completion_tokens: prefer the broadly-compatible `max_tokens`, since the
  target is arbitrary OpenAI-compatible endpoints rather than OpenAI's newest models.
- Do not add dependencies beyond declaring `openai` explicitly.
- Keep the module count small; do not create a file per class.

## Known Risks
- Leaking the key through an upstream error string. The SDK's exception text is interpolated
  into our messages; it must pass through redact_text first.
- Designing Chat Completions in a way that blocks Responses.
- Over-engineering (the brief explicitly warns against factory/builder ceremony).

=====================================================================
PRODUCT_ARCHITECTURE
=====================================================================

  Desktop shell (Tauri, much later)
    └─ Frontend: React + TS + Vite + PDF.js + Zustand   [ALREADY BUILT]
    └─ Backend: FastAPI + SQLite, loopback only         [DS-BE-001 COMPLETE]

Target layering for THIS task:

  Application (translation, context, Paper QA — LATER TASKS)
      ↓
  LLMProvider                       <- created here
      ↓
  OpenAIChatCompletionsProvider     <- created here
      ↓
  OpenAI-compatible HTTP API

Future (DS-BE-003), without changing callers:

  LLMProvider
  ├── OpenAIChatCompletionsProvider
  └── OpenAIResponsesProvider

Existing DS-BE-001 backend conventions that MUST be followed:
- Error envelope for HTTP: {"error": {"code", "message", "detail"}} with stable machine-readable codes.
- Structured JSON logging; any field named api_key/authorization/token/secret/password is
  redacted to "[REDACTED]", and free text is scrubbed for "Bearer <token>" and "key=value".
- Settings via pydantic-settings; no secrets in defaults.
- Importing app modules must have no side effects (no files, no sockets, no logging).
- The test suite runs entirely offline under an autouse socket guard that fails any
  non-loopback connection.

The service is local-only. Nothing in the provider layer may transmit anything the caller did
not explicitly supply — no telemetry, no automatic uploads.

=====================================================================
RELEVANT_EXISTING_BEHAVIOR
=====================================================================

- backend/app/llm/ does NOT exist yet. This is greenfield within an established codebase.
- backend has 94 passing tests. They must all still pass afterwards.
- frontend has 27 passing tests. It must not be touched at all.
- The OpenAI SDK version present is 3.14.0. Relevant facts verified by inspection:
    * AsyncOpenAI exists and accepts: api_key, base_url, timeout, max_retries, default_headers
    * chat.completions.create accepts: messages, model, temperature, max_tokens,
      max_completion_tokens, stop, stream, extra_headers, timeout
    * Exception classes present: APIError, APIStatusError, APITimeoutError, APIConnectionError,
      AuthenticationError(401), PermissionDeniedError(403), RateLimitError(429),
      BadRequestError(400), NotFoundError(404), InternalServerError, UnprocessableEntityError,
      ConflictError, APIResponseValidationError
- No provider-profile database, no credential store, and no API endpoints for providers exist
  yet. This task creates none of them.

=====================================================================

Now produce the acceptance criteria document in Markdown. Use a table with columns
ID | Priority | Description & Verification Target. Be specific and objectively verifiable —
prefer concrete values (status codes, exact field names, exception types) over adjectives.
