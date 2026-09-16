You are the independent Acceptance Criteria Agent for task DS-BE-FIX-002.

You are NOT implementing this task. You are NOT writing production code.

Define objective, testable acceptance criteria BEFORE implementation begins.

Task:
Prevent PDF translation from retrying provider failures indefinitely.

Observed real defect:
PDFMathTranslate upstream translator contains retry behavior with no finite stop condition:

    @retry(wait=wait_fixed(1))
    def worker(s: str):
        ...
        new = self.translator.translate(s)

Observed result:
A provider returning HTTP 500 caused the translation call to retry forever and never return.

Architecture constraint:
We prefer not to deeply patch upstream PDFMathTranslate internals. Upstream is a PINNED
DEPENDENCY consumed as a library and is never edited (ADR-001).

Future architecture:
A custom/context-aware translator will eventually replace more upstream translation behavior.

Current requirement:
Real frontend translation must not hang forever.

Define P0/P1/P2 acceptance criteria for the SMALLEST SAFE bounded-failure solution.

Cover:
- persistent 500
- 429
- timeout
- connection failure
- 401/403
- invalid model / bad request
- maximum retry behavior
- total failure latency
- error propagation
- cancellation
- no process exit
- no infinite retry
- no regression to successful translation
- no regression to source immutability
- test determinism
- provider-call counting
- secret leakage
- PDF translation task cleanup

Do not redesign the future Context Engine.
Do not implement production code.

=====================================================================
TASK_DESCRIPTION
=====================================================================

# DS-BE-FIX-002 — Bound Provider Failure / Eliminate Infinite Translation Retry

## Goal
A provider failure must become a CONTROLLED TRANSLATION FAILURE, not a hang. This is the last
blocker before translation can be exposed as a normal frontend action.

## The defect, observed live
Upstream's per-paragraph worker uses `@retry(wait=wait_fixed(1))` with NO stop condition, so it
retries forever. Observed against a loopback endpoint returning HTTP 500: the call retried
indefinitely and never returned.
Impact: a user whose provider starts failing gets no error, no completion, and no way to
recover — the translation simply never finishes.

## Investigated constraints (VERIFIED BY EXPERIMENT, not assumed)
1. tenacity's default `@retry` predicate catches `Exception` but NOT `BaseException`.
   Verified: a `ValueError` is retried; a `BaseException` subclass passes straight through.
   Consequence: a non-Exception sentinel can escape the retry loop WITHOUT editing upstream.
2. Upstream's worker catches `BaseException` only in order to log it and RE-RAISE it, so such a
   sentinel propagates cleanly out of the executor.
3. `pdf2zh/converter.py` binds the name `OpenAIlikedTranslator` at module level (it is imported
   there). Substituting that module attribute injects our own translator subclass into upstream's
   construction path without touching upstream source.
4. ADR-001 forbids forking or editing upstream; the fix must live in our adapter.
5. The existing DS-BE-002 LLM error taxonomy already classifies provider failures with
   `code` and `retryable` flags, and `normalize_exception()` maps SDK/HTTP errors onto it.
   Reusing it avoids a second classifier.

## Requirements
R1.  No provider failure may retry without bound.
R2.  Retry classification reuses the existing taxonomy: retryable = 429, 5xx, connection,
     timeout; NOT retryable = 401, 403, 400, 404, invalid model, malformed config.
R3.  A finite retry budget with backoff. No multi-minute uncontrolled hangs, no 100-attempt loops.
R4.  When retries are exhausted, the failure surfaces as a typed PDFKernelError.
R5.  THE PROCESS MUST SURVIVE. No exit(), sys.exit(), os._exit(), or unhandled SystemExit.
     A failed translation is TASK FAILED, not SERVER TERMINATED.
R6.  The bound applies to FAILURE behaviour, not to legitimate long-running document translation.
     A large PDF that legitimately takes minutes must still succeed.
R7.  Source immutability (the staged-copy guarantee) is preserved.
R8.  Successful translation does not regress: same outputs, same page counts, same provider calls.
R9.  No secret in any error message.
R10. Tests assert PROVIDER CALL COUNTS, not merely that a PDF exists. A run that produced output
     without calling the provider must not count as success. (A real hazard: a sparse page can be
     classified as "abandon" and produce valid-looking output while translating nothing.)

## Known Constraints
- Do NOT rewrite upstream. The injection must be an attribute substitution from our adapter.
- Do NOT redesign the cache (upstream's cache key omits the endpoint) or build the Context Engine.
  Both are later phases.
- A 5-second limit already exists for a LAYOUT MODEL PRE-FLIGHT CHECK. That bounds a precondition,
  not failure behaviour; do not conflate them.

=====================================================================
DESIGN QUESTIONS THE CRITERIA MUST SETTLE
=====================================================================

Give an explicit, verifiable rule for each:

Q1. RETRY BUDGET. Exact attempt count and backoff for retryable errors. What is the worst-case
    wall-clock time a persistently failing provider can cost ONE paragraph, and therefore one
    page?

Q2. FAIL-FAST vs FAIL-SLOW. With N paragraphs each retrying, a failing provider costs N x budget.
    Should the FIRST terminally-failed paragraph abort the whole translation, or should each
    paragraph exhaust its own budget? State the rule and the resulting expected provider-call
    count for a 2-paragraph page.

Q3. WHAT THE CALLER RECEIVES. Is a partial result (some paragraphs untranslated) ever acceptable,
    or must any terminal failure fail the task? Note the product principle "formula safety >
    translation completeness" already accepts preserving source text over producing bad output.

Q4. SENTINEL BEHAVIOUR. A non-Exception sentinel escapes tenacity. Confirm this is the intended
    mechanism, state what must happen if upstream ever changes to catch BaseException without
    re-raising, and state how the sentinel is kept from leaking to callers.

Q5. INJECTION SCOPE. The substitution patches a module attribute for the process lifetime.
    Should it be applied once at import, per call, or via a context manager? What happens under
    CONCURRENT translations — is the substitution safe, and must it be idempotent?

=====================================================================
PRODUCT_ARCHITECTURE
=====================================================================

  FastAPI (loopback only)
      ↓
  app/pdfkernel.translate_pdf()          <- already exists (DS-PDF-001)
      ↓  stages a COPY of the source (upstream deletes temp-dir inputs)
      ↓  runs upstream on a worker thread
  pdf2zh.high_level.translate()          <- pinned dependency, never edited
      ↓
  pdf2zh.converter.TranslateConverter
      ↓  constructs a translator by service name ("openailiked")
      ↓  @retry(wait=wait_fixed(1))   <-- INFINITE; the defect
  translator.translate(paragraph)
      ↓
  OpenAI-compatible endpoint (the user's own provider)

Existing backend conventions:
- Errors carry a stable `code`; `PDFKernelError.to_dict()` renders the HTTP envelope.
- Structured JSON logging; fields named api_key/authorization/token/secret/password are redacted
  to "[REDACTED]"; free text is scrubbed for "Bearer <token>" and "key=value"; the key literal is
  additionally stripped explicitly.
- The test suite runs entirely offline under an autouse socket guard that fails any NON-LOOPBACK
  connection. Loopback is permitted and is the intended seam for provider tests.
- Importing app modules must have no side effects.

=====================================================================
RELEVANT_EXISTING_BEHAVIOR
=====================================================================

- backend has 465 passing tests; frontend has 27. All must still pass.
- app/llm/errors.py exposes normalize_exception(exc, *, api_key=None) -> LLMError, where every
  LLMError has `.code`, `.retryable` and `.message`. Retryable: LLMRateLimitError (429),
  LLMTimeoutError, LLMConnectionError, LLMServerError (5xx). Not retryable:
  LLMAuthenticationError (401), LLMPermissionDeniedError (403), LLMBadRequestError (400/422),
  LLMNotFoundError (404), LLMInvalidResponseError, and LLMAPIError (fallback).
- app/pdfkernel/ has: translate_pdf(source_pdf, output_dir, target_lang, provider_config, *,
  source_lang, engine, overwrite, threads, ignore_cache, executor) -> TranslationResult, with
  typed errors PDFEngineUnsupportedError, PDFSourceNotFoundError, PDFSourceInvalidError,
  OutputFileExistsError, LayoutModelUnavailableError, TranslationServiceError,
  TranslationOutputMissingError.
- The kernel currently calls upstream with explicit keyword arguments and catches Exception and
  BaseException, wrapping both into TranslationServiceError. That wrapper is where a bounded
  failure must surface.
- A real end-to-end test already exists: it runs the genuine upstream pipeline against a loopback
  provider and asserts the provider was actually called (not merely that a PDF appeared).
- The layout model (~72 MiB) is already cached locally, so end-to-end tests can run offline.
- Git baseline commit 3ca35e9 exists, so changes are reviewable by diff.

=====================================================================

Now produce the acceptance criteria document in Markdown. Use a table with columns
ID | Priority | Description & Verification Target. Be specific and objectively verifiable —
prefer concrete values (attempt counts, second ceilings, exception types, call counts) over
adjectives. Give an explicit answer to each of Q1-Q5.
