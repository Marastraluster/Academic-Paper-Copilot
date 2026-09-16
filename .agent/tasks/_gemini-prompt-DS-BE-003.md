You are the independent Acceptance Criteria Agent for task DS-BE-003.

You are NOT implementing this task. You are NOT writing production code.

Define objective, testable acceptance criteria BEFORE implementation begins.

Scope:
- OpenAI Responses API adapter implementing the EXISTING LLMProvider contract
- reuse of existing request/result/config/error types (no new ones)
- mapping protocol-neutral messages onto Responses parameters
- normalization of Responses usage onto the shared usage model
- normalized provider errors with retry classification
- no secret leakage
- tests using mocks only

Explicitly exclude:
- protocol auto-detection (later task)
- provider profile persistence / credential storage (later task)
- retry engine (later task)
- PDF translation, Paper QA, Document Intelligence, frontend, Tauri

Return criteria grouped as P0 MUST / P1 SHOULD / P2 OPTIONAL, numbered AC-01, AC-02, ...
Tag every criterion. Only P0 blocks completion.

=====================================================================
TASK_DESCRIPTION
=====================================================================

# DS-BE-003 — OpenAI Responses API Adapter

## Goal
Add the second first-class protocol: an adapter implementing the existing LLMProvider contract
against OpenAI's Responses API (POST /v1/responses).
The point is not merely to add a protocol. It is to prove the DS-BE-002 abstraction holds: a
second protocol should slot in WITHOUT CHANGING A SINGLE CALLER, reusing the same request
models, result type, error taxonomy, and configuration.

## Technical Context
DS-BE-002 (complete, 25/25 P0 PASS) established backend/app/llm/:
  LLMProvider ABC          -> generate() + test_connection()
  LLMRequest / ChatMessage -> protocol-neutral input
  LLMResult / LLMUsage     -> normalised output
  ProviderConfig           -> endpoint, key, model, timeout, headers
  normalize_exception()    -> SDK/HTTP failures to internal errors
  Error hierarchy          -> each error has `code` (str) and `retryable` (bool)

Facts established by inspecting the SDK (openai 3.14.0) BEFORE writing this task:
- client.responses.create(...) accepts: model, input, instructions, max_output_tokens,
  temperature, stream, timeout, extra_headers, store.
- Responses reports usage as input_tokens / output_tokens / total_tokens. The first two DIFFER
  from Chat Completions' prompt_tokens / completion_tokens. Mapping them onto the shared
  LLMUsage is exactly the normalisation this layer exists to perform.
- max_output_tokens is already the native parameter name, so unlike Chat Completions (which
  needed aliasing to max_tokens) no translation is required.
- Response.output_text is a convenience property that concatenates output_text content blocks
  from message items, and returns "" when there are none. It tolerates null text.
- A response carries status: "completed" | "failed" | "in_progress" | "incomplete", and an
  optional `error` object. Content parts are either output_text or REFUSAL.

## Requirements
R1.  OpenAIResponsesProvider implementing LLMProvider, protocol = "responses".
R2.  Reuses LLMRequest, LLMResult, LLMUsage, ProviderConfig, and the error hierarchy UNCHANGED.
     No new request/result types.
R3.  Maps protocol-neutral messages onto Responses parameters: system messages become
     `instructions`, remaining messages become `input`.
R4.  Maps Responses usage (input_tokens/output_tokens) onto shared LLMUsage
     prompt_tokens/completion_tokens.
R5.  base_url passed verbatim; client constructed with max_retries=0; timeout and custom
     headers forwarded — identical guarantees to the Chat Completions adapter.
R6.  Reuses normalize_exception so every failure is an LLMError with stable code + retryable.
R7.  Malformed/unusable responses raise LLMInvalidResponseError; no primitive exception and no
     SDK object escapes.
R8.  test_connection() behaves as for Chat Completions: cheap probe, returns ConnectionReport,
     never raises for an expected failure, never swallows cancellation.
R9.  asyncio.CancelledError propagates untouched.
R10. No vendor-specific branching; no translation/glossary/PDF/retrieval logic.
R11. Chat Completions behaviour untouched — it is the regression baseline.
R12. Tests offline, mocks/fakes only.

## Known Constraints
- Do NOT implement auto-detection or profile persistence.
- Do not add dependencies.
- Caller-visible types stay identical; a caller must not be able to tell which protocol ran
  except via LLMResult.protocol.

=====================================================================
DESIGN QUESTIONS THE CRITERIA MUST SETTLE
=====================================================================

These are genuine ambiguities in the Responses protocol with no obviously correct answer. The
frozen criteria must decide them so the implementation is not guessing. Please give an explicit,
verifiable rule for each:

Q1. System messages -> `instructions`. Responses has no `system` role. Is folding system messages
    into `instructions` correct, and what happens with MULTIPLE system messages (join them, or
    last-wins)? What about a request with NO system message — is `instructions` omitted?

Q2. status == "failed" with a populated `error` object — normalise to which error type, and is it
    retryable?

Q3. status == "incomplete" (e.g. output-token cap reached) — is the partially returned text
    usable, or must the response be rejected?

Q4. REFUSALS. A refusal produces no output_text, so it would currently surface as "empty content".
    Is a distinct outcome required, or is LLMInvalidResponseError acceptable?

Q5. max_output_tokens maps directly with the same request-overrides-config precedence as Chat
    Completions — confirm, and state what happens when neither is set.

=====================================================================
PRODUCT_ARCHITECTURE
=====================================================================

  Application (translation, context, Paper QA — LATER TASKS)
      ↓
  LLMProvider                          <- DS-BE-002
      ├── OpenAIChatCompletionsProvider <- DS-BE-002 (regression baseline)
      └── OpenAIResponsesProvider       <- THIS TASK (DS-BE-003)
      ↓
  OpenAI-compatible HTTP API

Both implementations must produce an identical LLMResult and identical error codes for
identical failures. Otherwise the abstraction is cosmetic.
A caller written against LLMProvider must run against either provider with ZERO branching.

Existing backend conventions that must be followed:
- Error envelope for HTTP: {"error": {"code", "message", "detail"}}.
- Structured JSON logging; fields named api_key/authorization/token/secret/password are
  redacted to "[REDACTED]"; free text is scrubbed for "Bearer <token>" and "key=value".
- Importing app modules must have no side effects.
- The test suite runs entirely offline under an autouse socket guard that fails any non-loopback
  connection.
- The service is local-only. Nothing may be transmitted that the caller did not supply.

=====================================================================
RELEVANT_EXISTING_BEHAVIOR
=====================================================================

- backend/app/llm/ exists with 5 modules and 88 passing tests (DS-BE-002).
- The backend has 182 passing tests total; all must still pass afterwards.
- frontend has 27 passing tests; it must not be touched at all.
- The Chat Completions adapter establishes these precedents, which the Responses adapter should
  match unless there is a protocol reason not to:
    * max_tokens omitted entirely when unset (rather than sent as null)
    * empty/whitespace-only content -> LLMInvalidResponseError
    * usage absent -> usage is None, call still succeeds
    * model falls back to config.model when upstream omits it
    * API key stripped from every message it could appear in, IN ADDITION to redact_text,
      because redact_text only recognises "Bearer <token>" and "key=value" shapes
    * test_connection uses a trivial probe with a 1-token cap
- No provider-profile database, credential store, or provider HTTP endpoints exist. This task
  creates none of them.

=====================================================================

Now produce the acceptance criteria document in Markdown. Use a table with columns
ID | Priority | Description & Verification Target. Be specific and objectively verifiable —
prefer concrete values (status codes, exact field names, exception types) over adjectives.
Give an explicit answer to each of Q1-Q5.
