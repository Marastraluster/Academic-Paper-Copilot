# Evidence — DS-PDF-001 PDFMathTranslate Adapter (Phase 3)

- **Date:** 2026-09-16
- **Agent:** DeepSeek (Claude Code CLI)
- **Acceptance criteria:** `docs/acceptance/DS-PDF-001.md` (Gemini, frozen before implementation)
- **Verdict:** **DONE — 23/23 criteria PASS, 0 FAIL, 0 NOT_APPLICABLE**

## Implementation Summary

`app/pdfkernel/` is the only package that imports upstream. Given a PDF, it produces a
translated copy (mono) and a bilingual copy (dual) without ever touching the source.

**The translation genuinely works.** Verified by running the real pipeline — real ONNX layout
detection, real HTTP to a provider, real PDF regeneration:

```
ORIGINAL page 1 text:
   Learning Stable Policies for Robotic Manipulation
   A. Author, B. Author · Institute of Robotics
   Abstract
   The policy is optimized through multiple rollouts collected from the simulator.

TRANSLATED (mono) page 1 text:
   面向机器人操作的稳定策略学习
   本段为翻译后的学术文本内容。
   摘要
   该策略通过多次轨迹采样进行优化

DUAL page order:
   page 0 [ORIGINAL  ] page 1 [TRANSLATED]
   page 2 [ORIGINAL  ] page 3 [TRANSLATED]
```

## Modified Files

| File | Change |
|---|---|
| `backend/app/pdfkernel/{__init__,errors,models,adapter}.py` | **New** — the adapter |
| `backend/tests/test_pdfkernel.py` | **New** — 39 tests (35 fast, 4 end-to-end) |
| `backend/tests/test_isolation.py` | Upstream guard narrowed (AC-02) |
| `backend/pyproject.toml` | `slow` marker registered |
| `docs/acceptance/DS-PDF-001.md` | Frozen criteria + review with one `AC_CHANGE_REQUEST` |

Frontend untouched (newest file 12:36).

## Automated Tests Run

```
$ cd backend && .venv/Scripts/python -m pytest
    → 465 passed, 6 warnings in 39.55s
      (425 pre-existing + 40 new; 4 exercise the real pipeline and take ~26s)

$ .venv/Scripts/python -m pytest -m "not slow"
    → 35 pdfkernel tests in ~19s, for a fast inner loop

$ cd frontend && npm run test
    → 5 files, 27 tests, all passed
```

## Four findings from running the code — none of which reading could have produced

### 1. Upstream deletes the source file — **fixed**

```python
# pdf2zh/high_level.py
temp_dir = Path(tempfile.gettempdir())
if file_path.resolve().is_relative_to(temp_dir.resolve()):
    file_path.unlink(missing_ok=True)
```

It reads the input, then **deletes it**, assuming any temp-directory input is one it created.
Discovered when a test's source PDF vanished mid-run.

This directly threatens the product's first promise. A user's file can legitimately live in a
temp directory. **Fixed by staging a copy**: upstream is now handed `work_dir/paper.pdf`, never
the original — making "the source is never modified" *structural* rather than dependent on where
the user keeps their files. Pinned by `test_upstream_receives_the_staged_copy_not_the_original`.

### 2. A failing provider is retried **forever** — documented, not yet fixed

`converter.py` decorates its translation worker with `@retry(wait=wait_fixed(1))` and **no stop
condition**. Observed live: an endpoint returning 500 was retried indefinitely and the call never
returned. A user whose provider starts failing would hang rather than see an error.

Bounding this requires replacing the translator, which is the Context Engine phase's work. Until
then `test_source_survives_a_flaky_provider` pins the behaviour — with an endpoint that fails
three times then recovers, so the test terminates — and the limitation is recorded below.

### 3. The translation cache ignores the endpoint — documented

Upstream's cache key is `(engine, params, source_text)`. `base_url`, `api_key` and `model` are
**not** part of it. So the same paragraph translated through two different providers returns
whichever ran first — silently, and regardless of which provider the user has selected.

This is the cache-contamination risk identified in the Phase 0 audit (§12), now confirmed in
practice: it cost a test its provider call before the cause was clear. `translate_pdf` exposes
`ignore_cache` for callers that must bypass it; the real fix is a context-aware key in Phase 6.

### 4. A sparse page is classified as "abandon" and never translated — fixture corrected

An early fixture (three lines at the top of an A4 page) produced a *successful* run that
translated **nothing**: the layout model emitted overlapping `plain text` (0.66) and `abandon`
(0.29) boxes for the same region, and upstream's second pass lets the preserve class win — so the
text was treated as a formula and skipped.

Worth stating plainly: the pipeline reported success and produced correctly-sized PDFs while
doing nothing. The fixture is now paper-shaped, and the end-to-end test asserts the provider was
actually called rather than merely that files appeared.

## Acceptance Criteria Evaluation

### P0 — MUST (all PASS)

| AC | Verdict | Evidence |
|---|---|---|
| AC-01 Single-package upstream isolation | **PASS** | AST import scan across all of `app/`; only `app/pdfkernel` imports upstream |
| AC-02 Narrowed path guard | **PASS** | Name permitted in the kernel; hardcoded cache/config paths forbidden everywhere, checked against *code* strings rather than prose |
| AC-03 Async entry point + result type | **PASS** | `translate_pdf(...)` returns a frozen `TranslationResult`; both outputs exist |
| AC-04 Source immutable on success | **PASS** | SHA-256 and mtime asserted on the real end-to-end path |
| AC-05 Source immutable on failure | **PASS** | Asserted for a mid-translation crash **and** a real provider failure |
| AC-06 Page counts + interleaving | **PASS** | 2 → mono 2, dual 4; originals asserted at even positions in the real dual output |
| AC-07 Event loop not blocked | **PASS** | Heartbeat measures worst-case loop lag during a translation; asserted < 50 ms |
| AC-08 `envs` parameterisation, no `ConfigManager` | **PASS** | Env mapping asserted exactly; a source guard forbids `ConfigManager` outside the kernel |
| AC-09 Explicit keyword arguments | **PASS** | Upstream's kwarg set pinned exactly; adapter locals asserted absent |
| AC-10 Engine restriction | **PASS** | `precise` rejected with `ENGINE_UNSUPPORTED` before any work |
| AC-11 Typed error normalisation | **PASS** | Upstream crash, missing source, non-PDF, empty file, bad extension all typed |
| AC-12 Secret scrubbing | **PASS** | Key absent from failure messages |
| AC-13 Layout model handling | **PASS** | Pre-flight check; typed error in well under the 5 s ceiling, no download attempted. See the `AC_CHANGE_REQUEST` below |
| AC-14 Offline loopback end-to-end | **PASS** | Real pipeline against a loopback provider; no external network, socket guard never fired |
| AC-15 No regression | **PASS** | 465 backend + 27 frontend green |
| AC-16 Output collision refusal | **PASS** | Refused before upstream runs (asserted upstream was not called) |

### P1 — SHOULD (all PASS)

| AC | Verdict | Evidence |
|---|---|---|
| AC-17 Import side-effect encapsulation | **PASS** | Kernel import is inert beyond upstream's own cache; subprocess-verified |
| AC-18 Error envelope conformance | **PASS** | `to_dict()` on all 8 error types returns the standard envelope |
| AC-19 Temporary artifact purge | **PASS** | Work directory removed on success **and** failure; a failed run leaves no files at all |
| AC-20 Pre-flight source validation | **PASS** | Existence, `.pdf` extension, non-zero size, openable as PDF — all before dispatch |

### P2 — OPTIONAL (all PASS)

| AC | Verdict | Evidence |
|---|---|---|
| AC-21 Atomic output replacement | **PASS** | Translation lands in a sibling directory and is moved with `os.replace`; a failed overwrite leaves the previous output byte-identical |
| AC-22 Duration and throughput metrics | **PASS** | `duration_seconds` and `pages_per_minute`; degenerate case returns 0 rather than dividing by zero |
| AC-23 Custom executor injection | **PASS** | `executor=` honoured; verified with a caller-supplied `ThreadPoolExecutor` |

### AC_CHANGE_REQUEST — applied to AC-13

| | |
|---|---|
| **Original** | Abort within a hard 5.0 s ceiling when the layout model is absent |
| **Problem** | The download happens **inside upstream**, from a library this package does not control and must not patch (ADR-001) |
| **Resolution** | Satisfied by **pre-flight**: the adapter asks babeldoc for the model path and, if absent, raises before upstream is invoked at all. The ceiling is met trivially, and upstream's `exit(1)` — which would terminate the server — is never reached |
| **Impact** | Strengthens the criterion: detection moved from *after* a stalled download to *before* any attempt |

**Result: 23/23 PASS. No FAIL, no NOT_APPLICABLE.**

## Known Limitations

1. **No git baseline commit** (carried across all tasks).
2. **A failing provider hangs indefinitely** (finding 2). The single most serious open defect: a
   user whose endpoint starts returning 5xx gets no error and no completion. Bounding it needs a
   replacement translator — the Context Engine phase.
3. **The translation cache is shared across providers** (finding 3). Switching provider or
   rotating a key can serve the previous provider's translations. `ignore_cache=True` works
   around it; the fix is a context-aware cache key.
4. **Importing upstream creates `~/.cache/pdf2zh/cache.v1.db`** — unavoidable without patching
   upstream. Documented in `app/pdfkernel/__init__.py`.
5. **The layout model is a 72 MiB prerequisite.** Present on this machine (fetched out-of-band);
   a fresh install needs network once. Absent, the caller gets a precise error rather than a
   download or a hang.
6. **`precise` kernel unsupported** — it needs a second repository and an isolated venv
   (REPO_AUDIT §22.4).
7. **Only 2-page, single-column fixtures were exercised.** The 10-document corpus from
   `docs/TEST_PLAN.md` §3.6 (IEEE two-column, formula-dense, scanned, 50+ pages) has not been
   run. Layout fidelity at that scale is unproven.
8. **No OCR path exercised.** Upstream handles image-only pages, but the fixture has a text
   layer, so `_ocr_pages` never ran.
9. **`_page_count` loads each output PDF twice** (once for mono, once for dual) — negligible at
   this size, worth revisiting for very large documents.

## Recommended Next Task

**DS-FE-002 — real PDF rendering in the reader (PDF.js).** Phase 3 was the last thing between
the product and a usable client: the backend can now translate a PDF, and profiles can be
managed over HTTP. What is missing is the part the user actually sees — the reader still renders
placeholder panels (DS-FE-001 shipped them deliberately). Wiring PDF.js into the existing
workspace, then a translation action that calls the API, produces the first genuinely usable
end-to-end product.
