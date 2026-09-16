# DS-BE-003 — OpenAI Responses API Adapter

- **Phase:** 2 (LLM Provider)
- **Status:** AC authoring — implementation NOT started
- **Owner:** DeepSeek (implementation) · Gemini (acceptance criteria)
- **Created:** 2026-09-16

## Goal

Add the second first-class protocol: an adapter implementing the existing `LLMProvider`
contract against OpenAI's **Responses API** (`POST /v1/responses`).

The point is not merely to add a protocol. It is to prove the DS-BE-002 abstraction actually
holds: a second protocol should slot in **without changing a single caller**, reusing the same
request models, result type, error taxonomy, and configuration.

## Product Context

The brief makes Chat Completions and Responses both first-class (brief §38). Users of
OpenAI-compatible gateways increasingly expose Responses; some expose only one or the other.
Which protocol a given profile speaks is resolved later (DS-BE-004). This task supplies the
implementation that detection will choose between.

## Technical Context

DS-BE-002 (complete, 25/25 P0 PASS) established `backend/app/llm/`:

| Component | Reused unchanged by this task |
|---|---|
| `LLMProvider` ABC | `generate()` + `test_connection()` |
| `LLMRequest` / `ChatMessage` | protocol-neutral input |
| `LLMResult` / `LLMUsage` | normalised output |
| `ProviderConfig` | endpoint, key, model, timeout, headers |
| `normalize_exception()` | SDK/HTTP → internal errors |
| Error hierarchy | `code` + `retryable` |

**The SDK surface was inspected before writing this task** (`openai` 3.14.0):

- `client.responses.create(...)` accepts `model`, `input`, `instructions`,
  `max_output_tokens`, `temperature`, `stream`, `timeout`, `extra_headers`, `store`.
- Responses reports usage as **`input_tokens` / `output_tokens` / `total_tokens`** — note the
  first two differ from Chat Completions' `prompt_tokens` / `completion_tokens`. Mapping them
  onto the shared `LLMUsage` is precisely the normalisation this layer exists to perform.
- `max_output_tokens` is already the native parameter name, so unlike Chat Completions (which
  needed aliasing to `max_tokens`) no translation is required here.
- `Response.output_text` is a convenience property that concatenates `output_text` content
  blocks from `message` items and returns `""` when there are none.
- A response carries `status` (`completed` | `failed` | `in_progress` | `incomplete`) and an
  optional `error`. Output content parts are `output_text` or **`refusal`**.

## Files Allowed To Modify

```
backend/app/llm/responses.py       (new)
backend/app/llm/__init__.py        (export the new provider)
backend/tests/test_llm_responses.py (new tests)
.agent/tasks/DS-BE-003.md
.agent/evidence/DS-BE-003.md
```

## Files Forbidden To Modify

```
backend/app/llm/{base,models,errors,chat_completions}.py   (DS-BE-002, accepted)
backend/app/{main,config,db,errors,logging}.py, backend/app/api/**
backend/tests/**  other than the new file
frontend/**        (untouched; must keep passing 27 tests)
docs/** other than this task's acceptance file
_reference/**
```

If a DS-BE-002 file must change, it must be the minimum possible, must not alter Chat
Completions behaviour, and must be recorded in the evidence.

## Requirements

R1. `OpenAIResponsesProvider` implementing `LLMProvider`, with `protocol = "responses"`.
R2. Reuses `LLMRequest`, `LLMResult`, `LLMUsage`, `ProviderConfig`, and the error hierarchy
    **unchanged**. No new request/result types.
R3. Maps protocol-neutral messages onto Responses parameters: system messages become
    `instructions`, the remaining messages become `input`.
R4. Maps Responses usage (`input_tokens`/`output_tokens`) onto the shared
    `LLMUsage.prompt_tokens`/`completion_tokens`.
R5. Passes `base_url` verbatim; constructs the client with `max_retries=0`; forwards timeout
    and custom headers — identical guarantees to the Chat Completions adapter.
R6. Reuses `normalize_exception` so every failure arrives as an `LLMError` with a stable `code`
    and `retryable`.
R7. Malformed or unusable responses raise `LLMInvalidResponseError`; no primitive exception and
    no SDK object escapes.
R8. `test_connection()` behaves as it does for Chat Completions: cheap probe, returns a
    `ConnectionReport`, never raises for an expected failure, never swallows cancellation.
R9. `asyncio.CancelledError` propagates untouched.
R10. No vendor-specific branching; no translation, glossary, PDF, or retrieval logic.
R11. Chat Completions behaviour is untouched — it is the regression baseline and must keep
     passing every existing test.
R12. Tests are offline and use mocks/fakes only.

## Known Constraints

- Do **not** implement protocol auto-detection (DS-BE-004) or profile persistence (DS-BE-005).
- Do not add dependencies.
- Keep caller-visible types identical; a caller must not be able to tell which protocol ran
  except via `LLMResult.protocol`.

## Design questions the acceptance criteria should settle

These are genuine ambiguities in the Responses protocol with no obviously correct answer. The
frozen criteria must decide them, so the implementation is not guessing:

1. **System messages → `instructions`.** Responses has no `system` role. Is folding system
   messages into `instructions` correct, and what happens with multiple system messages (join,
   or last-wins)?
2. **`status == "failed"`** with a populated `error` — normalise to which error, and is it
   retryable?
3. **`status == "incomplete"`** (e.g. output-token cap reached) — is partially returned text
   usable, or must it be rejected?
4. **Refusals.** A refusal produces no `output_text`, so it would surface as "empty content".
   Is a distinct outcome required, or is `LLMInvalidResponseError` acceptable?
5. **`max_output_tokens`** maps directly, with the same request-overrides-config precedence as
   Chat Completions — confirm.

## Expected Tests

Mocked, offline, mirroring the Chat Completions suite's coverage so the two protocols are held
to the same standard:

- Valid response → normalised `text` / `model` / `protocol == "responses"` / usage.
- Usage null → `usage is None`; partial usage completed.
- Custom base URL verbatim; model; temperature; max output tokens; timeout; headers.
- `max_retries == 0` on the constructed client.
- Error normalisation: 401, 403, 429, timeout, connection, 400, 404, 5xx.
- Retryability correct per category.
- Malformed responses (no output, no message item, empty text, non-text content) →
  `LLMInvalidResponseError`, never a primitive exception.
- The resolved design for status/refusal cases above.
- Secret never in repr, log, or exception message.
- Cancellation propagates from both `generate()` and `test_connection()`.
- `test_connection()` success and failure paths.
- The interface holds: a caller written against `LLMProvider` runs against either provider
  with no branches.

## Dependencies

DS-BE-002 (complete). No other task.

## Known Risks

- **Behaviour drift between the two adapters.** They must produce identical `LLMResult` shapes
  and identical error codes for identical failures; otherwise the abstraction is cosmetic.
  A cross-protocol test should assert this.
- **Guessing at status/refusal semantics** without the criteria settling them.
- **Touching shared files.** Reuse should make `base.py`, `models.py`, and `errors.py` require
  no edits at all; if they do, that is a signal the DS-BE-002 design was incomplete.
