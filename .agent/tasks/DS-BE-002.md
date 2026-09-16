# DS-BE-002 — LLMProvider Interface + OpenAI Chat Completions Adapter

- **Phase:** 2 (LLM Provider)
- **Status:** AC authoring — implementation NOT started
- **Owner:** DeepSeek (implementation) · Gemini (acceptance criteria)
- **Created:** 2026-09-16

## Goal

Establish the vendor-neutral LLM abstraction the whole product depends on, and one working
implementation of it: an OpenAI-compatible **Chat Completions** adapter.

After this task, higher layers (translation, context analysis, Paper QA) can call
`await provider.generate(request)` and receive a normalised `LLMResult` without knowing
anything about the OpenAI SDK, HTTP status codes, or authorization headers.

## Product Context

Academic PDF Copilot is local-first: the user supplies their own endpoint, API key, and model.
The adapter must therefore be **OpenAI-compatible, not OpenAI-only** — it must work equally
against DeepSeek, OpenRouter, SiliconFlow, a private gateway, or a local server.

This task builds infrastructure only. It contains no translation, no PDF, and no paper logic.

## Technical Context

`backend/app/` currently contains the DS-BE-001 foundation: app factory, settings, error
envelope, structured logging with secret redaction, SQLite bootstrap, health endpoint, and a
94-test suite. **No LLM abstraction exists yet** — verified by grep, so there is no duplicate
to reconcile.

Available and already proven:

| Capability | Where |
|---|---|
| `redact_text()` / `is_sensitive_key()` | `app/logging.py` — reuse for sanitising upstream error text |
| Error-envelope vocabulary | `docs/API_CONTRACT.md` §0, `app/errors.py` |
| `pydantic` 2 + `SecretStr` | already a dependency |
| `openai` SDK **3.14.0** with `AsyncOpenAI` | present (transitively today; will be declared explicitly) |
| `WinVaultKeyring` verified active | for the later credential task |

The backend is async (FastAPI). `AsyncOpenAI` is available and is the correct choice — a
synchronous client would block the event loop.

## Files Allowed To Modify

```
backend/app/llm/**            (new package)
backend/tests/test_llm_*.py   (new tests)
backend/tests/conftest.py     (only to add shared fakes, if needed)
backend/pyproject.toml        (declare openai explicitly)
backend/README.md             (document the new package, briefly)
.agent/tasks/DS-BE-002.md
.agent/evidence/DS-BE-002.md
```

## Files Forbidden To Modify

```
frontend/**                   (untouched; must keep passing 27 tests)
backend/app/{main,config,db,errors,logging}.py, backend/app/api/**   (DS-BE-001, stable)
docs/** other than this task's acceptance file
_reference/**
```

If a change to a DS-BE-001 file is genuinely unavoidable, it must be the minimum possible and
recorded in the evidence.

## Requirements

R1. `app/llm/` package exporting: the provider interface, request/result models, the provider
    config, the error hierarchy, and the Chat Completions implementation.
R2. `LLMProvider` abstraction covering `generate()` and `test_connection()`, structured so a
    Responses adapter can be added later **without callers changing**.
R3. `LLMRequest` with protocol-neutral `messages`, optional `temperature`, optional
    `max_output_tokens`.
R4. `LLMResult` with `text`, `model`, `protocol`, `usage`; `usage` may be `None`.
R5. `ProviderConfig`: `base_url`, `api_key`, `model`, `timeout_s`, `temperature`,
    `max_output_tokens`, `custom_headers`.
R6. **Base URL is used verbatim.** No appending `/v1`, no normalisation, no rewriting.
R7. The API key must never appear in a repr, a log line, or an exception message produced by
    our code.
R8. Normalised error hierarchy mapping SDK/HTTP failures to internal types, each carrying a
    stable `code` and a `retryable` flag.
R9. Malformed provider responses (no choices, missing message, `content=None`, empty content)
    must raise a normalised error — never leak `AttributeError`/`IndexError`/`TypeError`.
R10. `AsyncOpenAI` used with `max_retries=0`: retry policy belongs to a later layer, and an SDK
    that silently retries would make both error classification and latency unpredictable.
R11. No vendor-specific branching (`if "deepseek" in base_url`, `if model.startswith("gpt")`).
R12. No translation, glossary, PDF, or retrieval logic in this package.
R13. Tests use mocks/fakes only — no network, no paid API calls.

## Known Constraints

- Do **not** implement the Responses API, protocol auto-detection, profile persistence, or
  credential storage (DS-BE-003+).
- Do **not** build a provider-profile database.
- `max_tokens` vs `max_completion_tokens`: prefer the broadly-compatible `max_tokens`, since
  the target is arbitrary OpenAI-compatible endpoints rather than OpenAI's newest models.
- Do not add dependencies beyond declaring `openai` explicitly.
- Keep the module count small; do not create a file per class.

## Expected Tests

Mocked, offline, at the SDK boundary:

- Valid response → normalised `text`/`model`/`protocol`/`usage`.
- Response without usage → `usage is None`, still success.
- Custom base URL, model, temperature, max tokens, timeout all reach the SDK client.
- Custom headers preserved.
- API key reaches the client but appears in **no** repr, log, or error message.
- Errors normalised: 401, 403, 429, timeout, connection, 400, 404, 5xx, generic.
- Retryability correct: 429/timeout/connection/5xx retryable; 401/403/400/404 not.
- Malformed responses → `LLMInvalidResponseError`, not an SDK error.
- Every error type carries a non-empty stable `code`.
- `test_connection()` succeeds and fails cleanly.

## Dependencies

DS-BE-001 (complete). No other task.

## Known Risks

- **Leaking the key through an upstream error string.** The SDK's exception text is
  interpolated into our messages; it must pass through `redact_text` first.
- **Designing Chat Completions in a way that blocks Responses.** The request/result models
  must not encode Chat-Completions-specific concepts.
- **Over-engineering.** The brief explicitly warns against factory/builder ceremony.
- **`max_tokens` compatibility.** Choosing an OpenAI-proprietary parameter would break the
  compatible endpoints this product is built for.
