# Evidence — DS-BE-004 Protocol Auto-Detection + Connection Test

- **Date:** 2026-09-16
- **Agent:** DeepSeek (Claude Code CLI)
- **Acceptance criteria:** `docs/acceptance/DS-BE-004.md` (Gemini, frozen before implementation)
- **Verdict:** **DONE — 26/26 criteria PASS, 11/11 failure conditions avoided**

## Implementation Summary

`resolve_provider(config)` returns a working provider without the caller knowing which protocol
the endpoint speaks. Detection probes **Responses first**, falls back to **Chat Completions**,
and caches the outcome per profile so it runs **once**, not per request.

The load-bearing distinction is *why* a probe failed: a 404/400/5xx/malformed response means
"no Responses endpoint here", so falling through is correct; a **401/403/429/connection/timeout**
means "this protocol exists but rejected us", so detection **aborts** rather than producing a
misleading second error — and, for a 429, rather than hammering a throttled host.

## Modified Files

| File | Change |
|---|---|
| `backend/app/llm/detection.py` | **New** — resolution, caching, single-flight |
| `backend/tests/test_llm_detection.py` | **New** — 52 tests |
| `backend/app/llm/client.py` | Shared home for `PROBE_PROMPT` / `PROBE_MAX_TOKENS` |
| `backend/app/llm/chat_completions.py` | Imports the constants; still re-exports them |
| `backend/app/llm/responses.py` | Imports the constants from their new home |
| `backend/app/llm/__init__.py` | Exports the detection surface |
| `docs/acceptance/DS-BE-004.md` | Frozen criteria + review |

**`base.py`, `models.py` and `errors.py` remain untouched** — the third consecutive task in
which the DS-BE-002 contract absorbed new capability without change. `FC-02` held.

Frontend untouched (newest file 12:36 vs. this task's work at 19:46).

## Automated Tests Run

```
$ cd backend && .venv/Scripts/python -m pytest
    → 305 passed, 1 warning in 7.26s
      (253 pre-existing + 52 new)

$ cd frontend && npm run test
    → 5 files, 27 tests, all passed
```

## Manual Verification — detection against real endpoints

Four loopback endpoints with genuinely different capabilities, exercising the decision table
over real HTTP rather than through mocks:

```
loopback endpoint: http://127.0.0.1:63921

[1] both available   -> chose 'responses'  (hits: {('both', 'responses'): 1})
[2] responses 404    -> chose 'chat_completions'

[3] both fail        -> LLMAPIError code=LLM_API_ERROR
    message: Auto-detection failed: Responses probe failed (LLM_SERVER_ERROR: ...);
             Chat Completions probe failed (...)

[4] responses 401    -> LLMAuthenticationError code=LLM_AUTHENTICATION_ERROR retryable=False

[5] cache            -> requests after 1st resolve: 7, after 3 resolves: 7
[6] 10 concurrent    -> 1 probe request(s), 10 providers returned
[7] generate()       -> text='OK' protocol='responses' usage=LLMUsage(prompt_tokens=1, ...)
```

What this proves that mocks cannot: a server implementing **both** protocols is probed only on
`/responses` (Chat Completions is never touched); a server that 404s `/responses` falls through
and succeeds on Chat Completions; a **401 aborts without falling through**; and the caching and
anti-stampede guarantees hold against real sockets — 3 resolves produce the same request count
as 1, and 10 concurrent resolves produce exactly 1 probe.

## Two defects found during implementation

1. **Concurrent failing resolves each issued their own probe.** A lock-plus-recheck pattern
   serialises callers but does not *share* an outcome, so when detection failed (nothing is
   cached, per AC-09) every waiter re-probed — violating AC-14 and doing exactly the thing
   FC-06 forbids against a throttled endpoint. Replaced with true single-flight: one shared
   task per key, whose **failure is shared with current waiters but not cached** for future
   calls. This satisfies AC-09 and AC-14 simultaneously.
2. **Cancelling one waiter aborted the shared probe.** `Task.cancel()` on a caller propagates
   into the task it is awaiting, so one caller giving up (a closed settings dialog) killed the
   probe every other waiter depended on. Fixed with `asyncio.shield`, with a test that asserts
   a cancelled waiter does not disturb the survivors.

Both were caught because the tests asserted the *property* rather than the implementation.

## Acceptance Criteria Evaluation

### P0 — MUST

| AC | Verdict | Evidence |
|---|---|---|
| AC-01 Exports & inert import | **PASS** | All five names exported; subprocess import emits nothing, writes no file |
| AC-02 Probe constants consolidated | **PASS** | `client.PROBE_PROMPT == "ping"`, `PROBE_MAX_TOKENS == 1`; both adapters import from there; `chat_completions` still re-exports |
| AC-03 Shared contracts unmodified | **PASS** | `base.py`/`models.py`/`errors.py` untouched; no new error or model types |
| AC-04 Explicit protocol bypass | **PASS** | Both explicit values return the right provider with **zero** probes and an untouched cache |
| AC-05 Responses-first order | **PASS** | Live: Chat Completions hit count stayed 0 |
| AC-06 Fall-through on route absence | **PASS** | 404, 400, invalid-response, 5xx, and API-error each parametrized; live 404 case confirmed |
| AC-07 Abort on 401/403 | **PASS** | Re-raises the identical exception; Chat Completions never probed; nothing cached |
| AC-08 Abort on 429/connection/timeout | **PASS** | Same, parametrized |
| AC-09 Dual failure normalisation | **PASS** | `LLMAPIError(retryable=False)` naming both attempts; live message inspected; not cached |
| AC-10 Exact cache key | **PASS** | `(base_url, model, sha256(key))`; model rotation and key rotation each produce distinct entries; plaintext absent |
| AC-11 Zero re-probing on hit | **PASS** | Second resolve issues no probe; live request count unchanged across 3 resolves |
| AC-12 Cache isolation | **PASS** | Distinct base URLs → distinct entries, no cross-talk |
| AC-13 Invalidation mechanisms | **PASS** | `clear_detection_cache`, `invalidate_detection_cache` (returns whether anything was removed), `force_probe=True`; a forced re-probe **overwrites** a changed outcome |
| AC-14 Anti-stampede | **PASS** | 10 concurrent resolves → exactly 1 probe, live and mocked; holds for **failure** as well as success |
| AC-15 Secret redaction | **PASS** | Key absent from cache keys, composite error messages, reprs, logs |
| AC-16 Connection diagnostics | **PASS** | `(protocol, ConnectionReport)` with protocol, model, latency |
| AC-17 Cancellation | **PASS** | Propagates untouched from a cancelled waiter; the in-flight slot is always cleared; a cancelled waiter does not disturb other waiters |
| AC-18 No vendor branching | **PASS** | AST guard over `detection.py` plus a check that it never inspects `base_url`/`model` by value |
| AC-19 Offline tests | **PASS** | Probe seam substituted; socket guard never fired |
| AC-20 Regression | **PASS** | 305 backend + 27 frontend green |

### P1 — SHOULD

| AC | Verdict | Evidence |
|---|---|---|
| AC-21 Case-insensitive protocol | **PASS** | `"Auto"`, `"AUTO"`, `" responses "`, `"CHAT_COMPLETIONS"`, `""` all handled |
| AC-22 Invalid protocol rejected | **PASS** | `ValueError` naming all valid options; no probe issued |
| AC-23 Composite diagnostic helper | **PASS** | `test_endpoint_connection` returns `(protocol, report)` |
| AC-24 Keyless endpoints | **PASS** | Empty key detects normally; cache key uses the empty-string digest |

### P2 — OPTIONAL

| AC | Verdict | Evidence |
|---|---|---|
| AC-25 Cache introspection | **PASS** | `get_detection_cache_stats()` → `{entries, hits, misses}`, counters asserted |
| AC-26 Config-declared protocol | **PASS** | A config carrying `protocol` skips detection and issues no probe |

### Specified tests AC-27.01 … AC-27.30

All 30 exist and pass (52 test functions including parametrizations). Two were added beyond the
specification, both catching real defects: a cancelled waiter must not cancel the shared probe,
and concurrent *failures* must not multiply probes.

### Failure conditions

| FC | Verdict |
|---|---|
| FC-01 Scope creep | **AVOIDED** — no tables, migrations, keyring, retry engine, or frontend code |
| FC-02 Shared contract mutation | **AVOIDED** — `base.py`/`models.py`/`errors.py` untouched |
| FC-03 Secret exposure | **AVOIDED** — digest-only cache key; errors, reprs and logs asserted clean |
| FC-04 Hot-path re-probing | **AVOIDED** — cache asserted; live request count flat across repeated resolves |
| FC-05 Auth/permission fall-through | **AVOIDED** — 401 aborts; live server confirmed Chat Completions untouched |
| FC-06 Stampeding probes | **AVOIDED** — one shared in-flight task, success and failure alike |
| FC-07 Vendor branching | **AVOIDED** — AST guard |
| FC-08 Unsanitised composite error | **AVOIDED** — both failures named, sanitised, no primitive escapes |
| FC-09 Swallowed cancellation | **AVOIDED** — `except BaseException` re-raises; two cancellation tests |
| FC-10 Test network access | **AVOIDED** — mocked throughout |
| FC-11 Regression | **AVOIDED** — 332 tests green |

**Result: 26/26 PASS. No FAIL, no NOT_APPLICABLE.**

## Known Limitations

1. **No git baseline commit** (carried across all tasks). `git diff` still reports nothing.
2. **The cache is unbounded and in-process.** Entries are keyed by profile; a long-running
   process that churns through many endpoints would accumulate them. Bounded by the number of
   configured profiles in practice, and `clear_detection_cache()` exists. Worth revisiting if
   profiles become numerous.
3. **A successful detection is cached indefinitely** until explicitly invalidated. An endpoint
   that *gains* Responses support after a fallback will keep using Chat Completions until
   `force_probe` or a restart. Acceptable — both protocols produce identical results — but the
   settings screen's "Test Connection" should pass `force_probe=True`.
4. **`asyncio.shield` means a probe outlives its last waiter.** If every caller cancels, the
   probe still completes and caches. That is deliberate (the result is useful and it is one
   request), but it is a choice, not an accident.
5. **Detection cost is one real completion.** The probe is `max_output_tokens=1`, but it is
   still a billed request. Inherent to capability detection without a cheaper signal.

## Recommended Next Task

**DS-BE-005 — Provider profile store + credential storage** (criteria already frozen at
`docs/acceptance/DS-BE-005.md`). It supplies the persisted profile this resolver consumes, and
is the task where a mistake is unrecoverable: a leaked key cannot be un-leaked.
