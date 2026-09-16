# DS-BE-FIX-002 — Bound Provider Failure / Eliminate Infinite Translation Retry

- **Phase:** runtime stabilization (blocking DS-FE-003)
- **Status:** AC authoring — implementation NOT started
- **Owner:** DeepSeek (implementation) · Gemini (acceptance criteria)
- **Created:** 2026-09-16
- **Baseline commit:** `3ca35e9`

## Goal

A provider failure must become a **controlled translation failure**, not a hang. This is the
last blocker before translation can be exposed as a normal frontend action.

## The defect, observed live

Upstream's per-paragraph worker:

```python
# pdf2zh/converter.py
@retry(wait=wait_fixed(1))
def worker(s: str):
    ...
    new = self.translator.translate(s)
```

`@retry` with no `stop` condition retries **forever**. Observed against a loopback endpoint
returning HTTP 500: the call retried indefinitely and never returned.

Impact: a user whose provider starts failing gets no error, no completion, and no way to
recover — the translation simply never finishes.

## Investigated constraints

| Fact | Consequence |
|---|---|
| tenacity's default predicate catches `Exception` but **not** `BaseException` (verified by experiment) | A non-`Exception` sentinel escapes the retry loop without editing upstream |
| `worker` catches `BaseException` only to log and **re-raise** | The sentinel propagates cleanly |
| `converter.py` binds `OpenAIlikedTranslator` at module level | Substituting that attribute injects our translator; no upstream source is edited |
| ADR-001 forbids forking upstream | The fix must live in our adapter |
| DS-BE-002 already classifies provider errors with `retryable` | Reuse `normalize_exception` rather than a second classifier |

## Files Allowed To Modify

```
backend/app/pdfkernel/**              (the adapter and its new translator)
backend/tests/test_pdfkernel.py       (extend)
.agent/tasks/DS-BE-FIX-002.md
.agent/evidence/DS-BE-FIX-002.md
```

## Files Forbidden To Modify

```
_reference/**            (upstream clone — never edited; the whole point of ADR-001)
backend/app/{llm,storage,security,api}/**, backend/app/{config,db,errors,logging,main}.py
backend/tests/** other than test_pdfkernel.py
frontend/**
docs/** other than this task's acceptance file
```

## Requirements

R1. No provider failure may retry without bound.
R2. Retry classification reuses the existing taxonomy: **retryable** = 429, 5xx, connection,
    timeout; **not retryable** = 401, 403, 400, 404, invalid model, malformed config.
R3. A finite retry budget with backoff. No multi-minute uncontrolled hangs, and no 100-attempt
    loops.
R4. When retries are exhausted, the failure surfaces as a typed `PDFKernelError`.
R5. **The process must survive.** No `exit()`, `sys.exit()`, `os._exit()`, or unhandled
    `SystemExit` — a failed translation is `TASK FAILED`, not `SERVER TERMINATED`.
R6. The bound applies to **failure behaviour**, not to legitimate long-running document
    translation. A large PDF that takes minutes must still succeed.
R7. Source immutability (the staged-copy guarantee) is preserved.
R8. Successful translation does not regress: same outputs, same page counts, same provider call
    behaviour.
R9. No secret in any error message.
R10. Tests assert **provider call counts**, not merely that a PDF exists — a run that produced
    output without calling the provider must not count as success.

## Known Constraints

- Do **not** rewrite upstream. The injection must be an attribute substitution from our adapter,
  documented as such.
- Do **not** redesign the cache (Finding 3) or build the Context Engine. Both are later phases.
- The 5-second style limit used for the layout-model pre-flight must not be confused with this:
  that bounds a *precondition check*, this bounds *failure behaviour*.

## Design questions the acceptance criteria should settle

1. **Retry budget.** Exact attempt count and backoff for retryable errors. What is the worst-case
   wall-clock time a persistently failing provider can cost one paragraph, and therefore a page?
2. **Fail-fast vs fail-slow.** With N paragraphs each retrying, a failing provider costs
   `N × budget`. Should the first terminally-failed paragraph abort the whole translation, or
   should each paragraph exhaust its own budget? State the rule and the expected provider-call
   count.
3. **What the caller receives.** Is a partial result (some paragraphs untranslated) ever
   acceptable, or must any terminal failure fail the task?
4. **Sentinel behaviour.** A non-`Exception` sentinel escapes tenacity — confirm this is the
   intended mechanism, and state what must happen if upstream ever changes to catch
   `BaseException` without re-raising.
5. **Injection scope.** The substitution patches a module attribute for the process lifetime.
   Should it be applied once at import, per call, or via a context manager — and what happens
   under concurrent translations?

## Expected Tests

- Persistent 500 → finite provider calls, controlled `PDFKernelError`, no hang.
- 401/403 → prompt failure, no retry storm.
- 429, timeout, connection failure → bounded retry, then controlled failure.
- Success path unchanged (real end-to-end against a loopback provider).
- Process survives a failure (asserted, not assumed).
- Source immutable across the failure path.
- Provider-call counts asserted in every failure test.
- Secret absent from failure messages.

## Dependencies

DS-PDF-001 (kernel), DS-BE-002 (error taxonomy).

## Known Risks

- **Sentinel leakage.** A `BaseException` that escapes somewhere unexpected could bypass normal
  error handling. Its type must be narrow and its handling explicit.
- **Injection side effects.** A process-wide attribute substitution affects every translation in
  the process, including concurrent ones.
- **Over-correcting.** Aborting on the first failure would make a single flaky paragraph fail an
  otherwise fine 300-page document.
