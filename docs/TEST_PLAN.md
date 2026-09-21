# TEST_PLAN.md — Academic PDF Copilot

- **Status:** Phase 1 baseline
- **Date:** 2026-09-15
- **Grounded in:** `docs/REPO_AUDIT.md`, upstream `test/` inspection

## 0. Position

Tests are **evidence, not decoration** (brief §104). A task is not done because tests were
written; it is done because tests ran, passed, and their output is recorded in
the local working directoryevidence/<TASK-ID>.md`.

Two rules that follow from the audit:

1. **A test that cannot fail is not a test.** Where we assert "the original file was not
   modified", we assert on a recorded hash, not on the absence of an exception.
2. **No test may touch the user's real data.** Upstream writes its cache to
   `~/.cache/pdf2zh/cache.v1.db` and its config to `~/.config/PDFMathTranslate/config.json`,
   and `pdf2zh.cache.init_db()` runs **at import time** (`cache.py:141`). Every test that
   imports the kernel must redirect both paths to a temporary directory first.

## 1. Test pyramid

| Level | Scope | Tooling | Gate |
|---|---|---|---|
| Unit | Pure logic: validators, context builder, cache keys, provider parsing | `pytest` / `vitest` | Every task |
| Integration | Our modules together, upstream mocked | `pytest`, `respx`/`responses` | Every task touching a boundary |
| Contract | Real LLM protocols against recorded fixtures | `pytest` + fixtures | Phase 4+ |
| End-to-end | Real PDF → real translated PDF | `pytest` + PDF corpus | Phase 5+ |
| Manual/visual | UI surfaces | screenshots in the local working directoryscreenshots/` | Every frontend task |

Frontend gates per task: `npm run typecheck && npm run test && npm run build`. `strict: true`
and no unbounded `any` (brief §87).

## 2. Reusable patterns from upstream (verified by reading, not execution)

```python
# test/test_translator.py:16-23 — minimal translator double
class AutoIncreaseTranslator(BaseTranslator):
    name = "auto_increase"; n = 0
    def do_translate(self, text):
        self.n += 1
        return str(self.n)
```

- `cache.init_test_db()` / `cache.clean_test_db(db)` (`test_translator.py:26-30`) give an
  **isolated SQLite cache** — the correct harness for all our cache-key tests.
- `ConfigManager.clear()` is required in `setUp` because translator construction mutates
  global config (`test_translator.py:96`). We inherit this hazard and must neutralise it the
  same way.
- `test/file/*.pdf` provides three small fixtures upstream
  (`translate.cli.plain.text.pdf`, `…text.with.figure.pdf`, `…font.unknown.pdf`) that are
  useful smoke inputs for the Phase 5 adapter.

> **Blocker.** Executing the cloned upstream test suite was denied by the permission
> classifier (the evidence record for DS-ARCH-000 Step 4). Upstream's own tests are currently
> **not runnable** in this environment, so we have **no upstream regression baseline**. This
> must be resolved before Phase 5 and is tracked in `ROADMAP.md`.

## 3. Critical test suites

### 3.1 Immutability (highest priority — brief §4)

```
GIVEN a source PDF with sha256 H
WHEN  a full translation runs to completion
THEN  sha256(source) == H
AND   no file in the source directory has a modified mtime
AND   exactly two new artifacts exist (mono, dual)
```

Also test the failure path: when translation **fails** or is **cancelled**, the source hash is
still unchanged. This is the one property whose violation is unrecoverable for a user.

### 3.2 Placeholder safety (brief §42)

Target format is **`{vN}` single-brace** (`REPO_AUDIT` §2.1).

| Case | Expected |
|---|---|
| Source `{v0}` preserved verbatim | PASS, no error |
| Translation drops `{v0}` | Retry; on second failure keep **source** and record `TranslationError` |
| Translation duplicates `{v0}` | Detect as mismatch (sequence differs) |
| Translation reorders `{v0} {v1}` → `{v1} {v0}` | Detect as mismatch |
| Translation invents out-of-range `{v99}` | Detect; upstream silently `continue`s (`converter.py:416-420`) — we must not |
| Translation translates `{v0}` → `{v零}` | Detect |
| Multiple placeholders, correct order | PASS |

Invariant to assert explicitly: **formula correctness beats translation completeness.** A
missing translation is acceptable; a corrupted formula is not.

### 3.3 Cache correctness (REPO_AUDIT §12 — top technical risk)

```
GIVEN document A with glossary GA translating paragraph P → TA
WHEN  document B with a DIFFERENT glossary GB translates the same paragraph P
THEN  the result is NOT TA
```

Plus:

- Same text + same glossary + same context → cache **hit** (assert the counter does not
  increment, using the `AutoIncreaseTranslator` pattern).
- Changing glossary / context / prompt version → cache **miss**.
- Cache key is stable across process restarts (params JSON is key-sorted, `cache.py:32-42`).
- `ignore_cache=True` bypasses reads but still writes.

### 3.4 LLM provider (brief §88)

`chat_completions` and `responses` each:

| Case | Expected |
|---|---|
| Normal request | parsed into `LLMResult` |
| Custom base URL | used **verbatim**, not rewritten |
| 401 / 403 | **no retry**, normalized `PROVIDER_AUTH_FAILED` |
| 429 | retried with exponential backoff, then normalized |
| 500 | retried, then normalized |
| Timeout | retried, then normalized `PROVIDER_TIMEOUT` |
| Empty response body | explicit error, not empty-string success |
| Usage absent | `usage=None`, not a crash |
| Streaming | chunks joined; no duplicated final chunk |
| Cancellation | request aborted, no orphan task |
| **Secret leakage** | key appears in **no** log, error, or response body |

Plus: protocol auto-detection resolves once and is **cached** — assert the detector is called
exactly once across N translation blocks (brief §49).

### 3.5 Translation consistency (brief §89)

```
"The policy is optimized through multiple rollouts."
"The learned policy produces stable trajectories."
```

Assert both translate `policy` identically under one document context. This is the
acceptance test for the whole Context Engine — without it, the engine is decorative.

### 3.6 PDF fidelity corpus (brief §90)

| # | Document class | Focus |
|---|---|---|
| 1 | Single-column paper | baseline |
| 2 | IEEE two-column | column handling |
| 3 | Formula-dense | placeholder preservation |
| 4 | Table-dense | table integrity |
| 5 | Figure-dense | figure preservation |
| 6 | Citation-dense | citation preservation |
| 7 | 50+ pages | token budget, progress, memory |
| 8 | Mixed zh/en | language handling |
| 9 | OCR text layer | OCR path |
| 10 | Scanned (image-only) | `ocr_required` signalling |

Assertions per document: page count preserved (mono = N, dual = 2N), figures not translated
or destroyed, formulas intact, citations intact, output opens in a standard viewer, no
catastrophic layout corruption, Unicode correct.

### 3.7 Security (brief §53)

- API key never appears in: SQLite rows, log files, error responses, git, or
  the local working directory files. Assert by grepping the artifacts for the literal key.
- `GET /api/profiles` returns only a masked key.
- Deleting a profile deletes the keyring entry.
- Malformed / hostile provider response bodies cannot inject into error envelopes.

### 3.8 Grounding / anti-hallucination (brief §61)

- Question with no supporting evidence → the fixed refusal string, `grounded: false`.
- Question with evidence → citations present, each citation's page resolves to a real page.
- **Every returned citation page number must exist in the document.** Assert
  `1 <= page <= page_count`.

## 4. Frontend / UI verification

Automated: `typecheck`, unit tests, `build`. Visual: screenshot to
`docs/screenshots/<TASK-ID>.png`, evaluated against theored criteria.

Design surfaces (brief §21, §75): layout, spacing, hierarchy, density, typography, overflow,
empty/loading/error states, resize, sidebar collapse, workspace width, contrast,
hover/focus, keyboard usability, scroll behaviour, visual consistency. Responsive widths:
1024 / 1440 / 1920.

## 5. What "measured" means

Where a criterion cannot be verified automatically, it must be verified **manually and
explicitly**, and the evidence file must say how. "Looks fine" is not a verdict
(brief §82). Verdicts are `PASS` / `FAIL` / `NOT_APPLICABLE`, and `NOT_APPLICABLE` requires
a stated reason.
