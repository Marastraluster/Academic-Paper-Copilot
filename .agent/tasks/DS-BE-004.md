# DS-BE-004 — Protocol Auto-Detection + Connection Test

- **Phase:** 2 (LLM Provider)
- **Status:** AC authoring — implementation NOT started
- **Owner:** DeepSeek (implementation) · Gemini (acceptance criteria)
- **Created:** 2026-09-16

## Goal

Let a caller hand over a configured profile without knowing whether the endpoint speaks
Responses or Chat Completions, and get back a working provider. Plus a connection test that
reports what it found.

DS-BE-002 and DS-BE-003 built two adapters. This task builds the thing that chooses between
them — and makes that choice **once**, not per request.

## Product Context

Users configure an arbitrary endpoint. Most compatible gateways implement Chat Completions;
some implement Responses; a few implement both. The brief requires `Auto` as a first-class
protocol option (brief §38, §41): the user should not have to know which one their provider
speaks.

The settings screen also needs a **Test Connection** action reporting protocol, model and
latency — which is the visible product surface this task feeds.

## Technical Context

`backend/app/llm/` currently holds two adapters behind one `LLMProvider` contract:

| Module | Contents |
|---|---|
| `base.py` | `LLMProvider` ABC (`generate`, `test_connection`) |
| `models.py` | `LLMRequest`, `LLMResult`, `LLMUsage`, `ProviderConfig`, `ConnectionReport` |
| `errors.py` | error hierarchy + `normalize_exception` |
| `client.py` | shared `build_client`, `KEYLESS_API_KEY_PLACEHOLDER` |
| `chat_completions.py` | `OpenAIChatCompletionsProvider`, `build_client`, `PROBE_PROMPT`, `PROBE_MAX_TOKENS` |
| `responses.py` | `OpenAIResponsesProvider`, `build_responses_client` |

253 backend tests pass. `_release` of the probe constants is overdue — see "Known cleanup".

## Files Allowed To Modify

```
backend/app/llm/detection.py        (new)
backend/app/llm/__init__.py         (export)
backend/app/llm/client.py           (home for the shared probe constants)
backend/app/llm/chat_completions.py (import probe constants from their new home)
backend/app/llm/responses.py        (same)
backend/tests/test_llm_detection.py (new tests)
.agent/tasks/DS-BE-004.md
.agent/evidence/DS-BE-004.md
```

## Files Forbidden To Modify

```
backend/app/llm/{base,models,errors}.py    (the shared contract — unchanged since DS-BE-002)
backend/app/{main,config,db,errors,logging}.py, backend/app/api/**
backend/tests/** other than the new file
frontend/**        (untouched; must keep passing 27 tests)
docs/** other than this task's acceptance file
_reference/**
```

## Requirements

R1. A resolver that, given a `ProviderConfig` with protocol `auto`, returns a working
    `LLMProvider` — **without the caller learning which protocol was chosen** except by
    inspecting the returned provider or `LLMResult.protocol`.
R2. Detection order: **Responses first, then Chat Completions** (brief §41).
R3. Detection is **cached per profile**, keyed on something that identifies the endpoint+model.
    A second resolve for the same key must not re-probe. Detection must **never** run per
    translation block or per generation call.
R4. An explicit protocol (`chat_completions` / `responses`) bypasses detection entirely.
R5. If neither protocol works, raise a normalised error carrying enough information to explain
    what was tried. A partially-working endpoint must not be reported as a generic failure.
R6. `test_connection()` on the resolved provider reports protocol, model and latency, as the
    settings screen needs.
R7. Detection must not leak the API key into any log, cache key, repr, or error message.
R8. Concurrent detection for the same key must not stampede — one probe, not N.
R9. No vendor-specific branching. No translation, PDF, or retrieval logic.

## Known Cleanup (carried from DS-BE-003)

`PROBE_PROMPT` / `PROBE_MAX_TOKENS` currently live in `chat_completions.py` and are imported by
`responses.py` — a deliberate but mild coupling recorded in DS-BE-003's evidence. Detection
needs them too, which makes a shared home correct. Move them to `client.py` and have both
adapters import from there.

## Design questions the acceptance criteria should settle

1. **Cache key.** What identifies a profile for caching? Base URL alone would collide across
   models; base URL + model ignores key rotation, which is fine (the protocol rarely changes
   with the key). What about a key change pointing at a different backend behind the same URL?
2. **What counts as "supports Responses"?** A probe that returns 404 (endpoint absent) clearly
   means no. What about 401 (key rejected) — that means the *protocol* exists but the
   credentials are wrong; falling through to Chat Completions would produce a misleading second
   error. Which failures should stop detection rather than fall through?
3. **Cache lifetime.** In-process only, or persisted? (Profile persistence is DS-BE-005;
   in-process is likely right here, but state it.)
4. **Cache invalidation.** Is there an explicit way to force re-detection?
5. **Concurrency.** One in-flight probe per key with waiters, or independent probes?

## Expected Tests

- Detection picks Responses when it works.
- Detection falls back to Chat Completions when Responses fails in a way that means "absent".
- Detection does **not** fall through on a failure that means "protocol exists but rejected"
  (per Q2).
- Neither working → normalised error naming both attempts.
- Explicit protocol skips detection entirely (assert no probe was issued).
- Cache: second resolve issues **no** probe; distinct keys probe independently.
- Concurrency: N simultaneous resolves for one key issue exactly one probe.
- Key never appears in a cache key, log, or error message.
- `test_connection` reports protocol/model/latency.
- Existing 253 backend + 27 frontend tests still pass.

## Dependencies

DS-BE-002, DS-BE-003 (both complete).

## Known Risks

- **Detection on the hot path.** If any code path re-probes per request, translation of a
  300-block document would issue hundreds of probes. R3 exists for this; it needs a real test.
- **Misclassifying an auth failure as "unsupported protocol"**, producing a confusing second
  error that hides the real cause (Q2).
- **Cache key too coarse** (wrong protocol served for a different model) or too fine (never
  hits, defeating the purpose).
