# Evidence — DS-BE-FIX-002 Bound Provider Failure / Eliminate Infinite Translation Retry

- **Date:** 2026-09-16
- **Agent:** DeepSeek (Claude Code CLI)
- **Acceptance criteria:** `docs/acceptance/DS-BE-FIX-002.md` (Gemini, frozen before implementation)
- **Baseline:** `git` commit `3ca35e9`
- **Verdict:** **DONE — 20/20 criteria PASS, 0 FAIL, 0 NOT_APPLICABLE**

## The defect

Upstream wraps its per-paragraph worker in an unbounded retry:

```python
# pdf2zh/converter.py
@retry(wait=wait_fixed(1))
def worker(s: str):
    ...
    new = self.translator.translate(s)
```

`@retry` with no stop condition means a provider returning HTTP 500 is retried
**forever**. Observed live: the call never returned. A user whose provider started failing got
no error, no completion and no way to recover.

## The fix — no upstream file touched (ADR-001)

Upstream constructs its translator by matching a service name against classes it imported, so
the adapter substitutes the class on `pdf2zh.converter` — an attribute assignment, deferred
until the first translation, idempotent, and guarded by a lock.

The replacement (`BoundedOpenAIlikedTranslator`) does its own bounded retrying and signals
terminal failure with `TranslationAbortSentinel`, a **`BaseException`**:

* tenacity's default predicate catches `Exception` and **not** `BaseException` (verified by
  experiment before the design was chosen), so the sentinel escapes the retry loop;
* upstream's worker catches `BaseException` only to log and re-raise, so it propagates;
* the adapter catches it and raises a normal `TranslationServiceError`.

**Fail-fast.** The first terminal failure sets an abort flag on the translator instance.
Upstream builds one translator per document, so the flag is document-scoped by construction —
later paragraphs give up without issuing a request. A provider outage costs 3 calls, not `3 × N`.

## `git diff --stat` (vs `3ca35e9`)

```
 backend/app/pdfkernel/adapter.py |  77 +++++++
 backend/app/pdfkernel/errors.py  |  13 +-
 backend/tests/test_pdfkernel.py  | 441 ++++++++++++++++++++++++++++++++++++++-
 3 files changed, 524 insertions(+), 7 deletions(-)
```

Plus two new modules: `app/pdfkernel/abort.py` (the sentinel) and
`app/pdfkernel/bounded_translator.py` (the bounded translator). **No upstream file is modified**
— verified by a test asserting the injected class is ours.

## Verification

```
$ cd backend && .venv/Scripts/python -m pytest
    → 488 passed          (baseline 465, +23 new)
    → 62 in tests/test_pdfkernel.py

$ cd frontend && npm run test
    → 27 passed
```

### The defect, reproduced and then fixed — measured

| | provider calls | outcome |
|---|---|---|
| **Before the fix** | unbounded | never returned |
| **After, first attempt** | **9** | returned, but 3× the budget — see finding 2 |
| **After, final** | **3** | typed `TranslationServiceError`, source unchanged, no partial output |

The final run: terminates in 1.61 s (backoff zeroed), `cause=LLMServerError`, source SHA-256
unchanged, `output/` empty.

## Two findings from implementing this

### 1. The sentinel mechanism, confirmed by experiment rather than assumed

I verified before designing: tenacity's default predicated retries a `ValueError` and passes a
`BaseException` straight through. Had I assumed otherwise, the whole approach would have been
built on sand. `test_the_sentinel_escapes_an_unbounded_tenacity_retry` now pins the property, so
if tenacity's default ever changes it fails here rather than as a hang in production.

### 2. Upstream's own OpenAI client silently retried — multiplying the budget by 3

The first working fix made **9** calls where the criteria required **3**. The abort flag was
working perfectly (traced: one instance; paragraph 1 exhausted its budget, paragraphs 2–5 made
zero calls). The extra calls came from the SDK's own default `max_retries=2` *inside* each of our
attempts: 3 logical attempts × 3 HTTP requests.

Fixed with `self.client.with_options(max_retries=0)` in the injected translator. Our own provider
adapters disable silent retries for exactly this reason (DS-BE-002 AC-09); upstream's does not —
so any layer that delegates retry policy to a library silently multiplies whatever budget the
caller believes it has.

### A third, smaller one: my own test hung

`test_the_sentinel_escapes_an_unbounded_tenacity_retry` initially used an `AssertionError` as its
loop guard — which tenacity retried too, so the guard itself never fired and the suite hung for
13 minutes. The guard is now a `BaseException`. The same trap appears twice in this task, which
is precisely why the mechanism deserves a dedicated test rather than a comment.

## Acceptance Criteria Evaluation

### P0 — MUST (all PASS)

| AC | Verdict | Evidence |
|---|---|---|
| AC-FIX-01 Persistent 500 no longer hangs | **PASS** | Terminates with a typed error in well under the 5 s ceiling |
| AC-FIX-02 Finite retry budget | **PASS** | Exactly **3** provider requests for 500 and 429; asserted, not inferred |
| AC-FIX-03 Immediate abort on 401/403/400 | **PASS** | Exactly **1** request for 401 and for 403 |
| AC-FIX-04 Document-level fail-fast | **PASS** | Traced: paragraph 1 uses the budget, paragraphs 2–5 issue **zero** calls |
| AC-FIX-05 Sentinel bypasses tenacity | **PASS** | Dedicated test: `Exception` retried 6×, sentinel retried **once** |
| AC-FIX-06 Sentinel containment | **PASS** | Callers receive a `PDFKernelError` that *is* an `Exception`; never the sentinel |
| AC-FIX-07 Process survival | **PASS** | Subprocess performing a failing translation exits **0** |
| AC-FIX-08 Exact provider call counts | **PASS** | 3 for 500/429, 1 for 401/403 — every failure test asserts a count |
| AC-FIX-09 Source immutability | **PASS** | SHA-256 and mtime unchanged across all four failure routes |
| AC-FIX-10 Credential scrubbing | **PASS** | Secret absent from message, `str`, and `to_dict()` |
| AC-FIX-11 Successful translation unregressed | **PASS** | End-to-end tests pass; a flaky provider still recovers within budget |
| AC-FIX-12 Zero regression | **PASS** | 488 backend + 27 frontend |
| AC-FIX-13 Upstream never edited | **PASS** | Injected class asserted to be ours; `git diff` touches no upstream file |

### P1 — SHOULD (all PASS)

| AC | Verdict | Evidence |
|---|---|---|
| AC-FIX-14 Latency ceilings | **PASS** | Failure path completes in 1.61 s with backoff zeroed |
| AC-FIX-15 Work-directory purge | **PASS** | `output/` empty after failure; no `.pdfkernel-*` survivors |
| AC-FIX-16 Cancellation cleanup | **PASS** | A cancelled translation leaves no scratch directory |
| AC-FIX-17 Lazy, idempotent injection | **PASS** | Subprocess: importing the kernel leaves upstream **unpatched**; repeated patching converges |
| AC-FIX-18 Upstream re-raise contract | **PASS** | Pinned end to end — the persistent-500 case raising at all *is* the contract holding |

### P2 — OPTIONAL (both PASS)

| AC | Verdict | Evidence |
|---|---|---|
| AC-FIX-19 Configurable backoff | **PASS** | `BACKOFF_SECONDS` patchable to `(0.0, 0.0)`; used by every failure test |
| AC-FIX-20 Structured error detail | **PASS** | `detail` carries `failed_phase`, `provider_error_code`, `retryable`; no response text |

**Result: 20/20 PASS. No FAIL, no NOT_APPLICABLE.**

## Known Limitations

1. **The bounded translator covers `openailiked` only.** Other upstream services (`openai`,
   `deepl`, …) keep the unbounded retry. The product only ever uses `openailiked` for
   translation, so this is not currently reachable — but it is a scope boundary, not a guarantee.
2. **A `BaseException` sentinel is an unusual mechanism.** It works because tenacity's predicate
   is `Exception`-based and upstream re-raises. AC-FIX-05 and AC-FIX-18 pin both halves, so a
   change in either dependency fails a test rather than hanging in production — but the coupling
   is real and worth remembering during any upstream upgrade.
3. **The retry budget is per paragraph, and fail-fast is per document.** A provider that fails
   intermittently still costs up to 3 calls per paragraph. That is the intent (it lets a flaky
   provider succeed), but a provider failing ~50% of the time will be slow rather than fast.
4. **Backoff is 1 s then 2 s.** For a 300-paragraph document where every paragraph fails once and
   then succeeds, that is 300 s of sleeping. Acceptable, and the budget is a class attribute if
   it needs tuning.
5. **`ignore_cache` is still required for tests.** Upstream's cache key omits the endpoint
   (Finding 3 of DS-PDF-001); unchanged here, and deliberately out of scope.
6. **A cancelled translation's worker thread is abandoned, not stopped.** `asyncio` cannot
   cancel a thread; the scratch directory is cleaned up, but an in-flight provider request runs
   to completion. Bounding that needs process-level isolation.

## Recommended Next Task

**DS-FE-002 — the real PDF.js reader** (criteria already frozen at
`docs/acceptance/DS-FE-002.md`, 49 criteria). This fix was the last blocker: translation can now
be exposed as a frontend action without the risk of an indefinite hang. DS-FE-002 turns the
placeholder panels into a real reader; DS-FE-003 then wires the Translate action that this task
made safe.
