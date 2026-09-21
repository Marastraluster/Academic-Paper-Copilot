# REPO_AUDIT.md

**Auditor:** project maintainer · **Date:** 2026-09-15

This document has two parts:

- **Part I — Product State Audit.** What product functionality actually exists in this
  repository right now. Answers the §107 questions.
- **Part II — PDFMathTranslate Upstream Audit** (DS-ARCH-000). Source-level analysis of the
  dependency we build on.

---

# Part I — Product State Audit

**Method:** direct inspection (`git status`, `git log`, `find`, `npm run test`). Every claim
below was executed, not assumed. File counts are literal.

## I.1 Measured state

| Question | Answer | Evidence |
|---|---|---|
| Git commits | **None.** Branch `master` has no commits. | `git log` → *"does not have any commits yet"* |
| Tracked/untracked files | 56 untracked, 0 tracked | `git status --short` → 4 top-level `??` entries |
| Python source outside `_reference/` | **0 files** | `find . -name '*.py' -not -path './_reference/*' -not -path '*/.venv/*'` → 0 |
| `backend/app/` | **0 files** | `find backend/app -type f` → 0 |
| Frontend source | 29 files under `frontend/src` | `find frontend/src -type f` |
| Tests | **27 passing, 5 files** | `npm run test` → `5 passed (5)`, `27 passed (27)` |
| Documentation | 8 files under `docs/` | `find docs -type f` |
| Agent state | tasks + evidence + screenshots | `find .agent -type f` |

## I.2 What already exists (verify, keep, build on)

| Capability | Status | Where |
|---|---|---|
| Acceptance-before-implementation (task → frozen criteria → implement → evidence) | **Working** | the local working directory, `docs/acceptance/` |
| Both CLI harnesses | **Healthy** | `claude` 2.1.218, `agy` 1.2.3, `gemini-3.8-flash-*` |
| Architecture / roadmap / API contract / test plan | **Written** | `docs/*.md` |
| Upstream dependency audited, pinned, installable | **Verified** | `docs/REPO_AUDIT.md` Part II |
| Frontend application shell (DS-FE-001) | **Complete, 38/38 AC PASS** | `frontend/`, the evidence record for DS-FE-001 |
| React + TS + Vite + Tailwind + shadcn/ui + Zustand | **Configured** | `frontend/package.json` |
| Four-region workspace layout, reader-mode state, collapsible sidebar | **Working** | `frontend/src/{app,reader,assistant}` |
| Automated browser verification harness | **Working** | `frontend/scripts/capture.mjs` |

## I.3 What is missing entirely

| Capability | Phase (brief §81) |
|---|---|
| FastAPI backend of any kind | 2 |
| LLM Provider layer (Chat Completions, Responses, Auto) | **2** |
| Provider profiles + credential storage | 2 |
| SQLite schema / persistence | 2 |
| PDFMathTranslate adapter (`pdfkernel/`) | 3 |
| Real PDF rendering in the reader (PDF.js) | 4 |
| Document Intelligence (sections, paragraphs, page mapping) | 5 |
| Academic Context Engine (glossary, neighbours, validator) | 6 |
| Translation task system (SSE, cancel, retry) | 7 |
| Paper QA + citations | 8 |
| UI polish (settings, glossary, dialogs, states) | 9 |
| Tauri packaging | 10 |

## I.4 What is partially implemented

| Capability | State | Gap |
|---|---|---|
| Reader modes | Zustand state + panel layout works | Panels are **placeholders**; no PDF.js, no real document |
| AI sidebar | Full structure, quick actions, composer | Replies are a fixed "backend not connected" notice |
| Status bar | Renders per AC-08 | Values are placeholder sample data (marked 示例) |
| API client | `src/api/config.ts` centralises base URL | Nothing calls it — no backend to call |
| Provider settings UI | Not started | Depends on Phase 2 backend |

## I.5 Highest-value unfinished feature

**Phase 2 — LLM Provider.**

Rationale: every remaining phase depends on it. Translation (3), context translation (6),
and Paper QA (8) all route through the provider layer, and none can be built or tested
before it exists. It is also the only phase that is fully self-contained and testable without
PDF assets: protocols can be exercised against recorded fixtures, so it can reach a genuinely
verified state early.

The provider layer cannot be built without a backend to host it, so Phase 2 opens with a
minimal FastAPI foundation.

## I.6 Structural blockers

1. **No git baseline commit.** Zero commits means `git diff` — designated the source of truth
   by brief §74 and §112 — currently reports nothing for any task. Task review is therefore
   not meaningful until a baseline exists. **Requires a user decision to commit.**
2. **Executing the cloned upstream library was denied** by the permission classifier.
   Resolved by user decision (permission granted for the pinned clone); Phase 3 is unblocked.
3. **Python 3.14.6 is the machine default** but outside `pdf2zh`'s `>=3.11,<3.13` range.
   Backend work uses the pinned `backend/.venv` on **3.12.13**.

---

# Part II — PDFMathTranslate Upstream Audit

**Task:** DS-ARCH-000 (Phase 0)
**Method:** direct source reading of a fresh clone. No finding below is inferred from README prose.

## 0. Artifact Under Audit

| Item | Value |
|---|---|
| Upstream | `https://github.com/PDFMathTranslate/PDFMathTranslate` |
| Commit | `c0fa967` (main) |
| Declared version | `1.9.12` (`pdf2zh/__init__.py`, `pyproject.toml`) |
| **Latest on PyPI** | **`1.9.11`** — the clone is *ahead* of the published package |
| License | **AGPL-3.0** (`LICENSE`, 661 lines; `pyproject.toml` → `license = "AGPL-3.0"`) |
| Python support (repo) | `>=3.11,<3.13` |
| Python support (PyPI 1.9.11) | `>=3.10,<3.13` |
| Source size | 5,902 LOC across `pdf2zh/` (23 modules) |
| Tests | 10 files under `test/`, incl. `test_kernel.py` (16 test classes) |

> **Environment consequence.** This machine's default interpreter is Python 3.14.6, which is
> *outside* the supported range. Python **3.12.13** is available via uv
> (`cpython-3.12.13-windows-x86_64-none`) and is the pinned interpreter for the backend.
> This is a hard constraint, not a preference: `pyproject.toml` declares `<3.13`.

---

## 1. Complete Translation Pipeline (Q1)

Verified call chain for CLI mode `--mode fast`:

```
pdf2zh.main()                                  pdf2zh.py:255
  └─ KernelRegistry.switch(mode); .get()       pdf2zh.py:343-344
  └─ kernel.translate(TranslateRequest)        pdf2zh.py:375
       └─ [legacy kernel] high_level.translate()          kernel/legacy.py
            └─ per file: read raw bytes → doc_raw.read()  high_level.py:484
            └─ translate_stream(s_raw, **locals())        high_level.py:498
                 ├─ _ocr_pages(doc_zh, ...)               high_level.py:304, 216
                 │    (image-only pages only; no-op otherwise)
                 ├─ font injection: "tiro" + NOTO into every page/xref  high_level.py:308-334
                 ├─ translate_patch(fp, **locals())        high_level.py:339, 72
                 │    ├─ TranslateConverter(...)           high_level.py:95
                 │    ├─ PDFPageInterpreterEx(...)         high_level.py:113
                 │    └─ per page:
                 │         ├─ render page → np image       high_level.py:131-134
                 │         ├─ model.predict(image)         high_level.py:135   (ONNX layout)
                 │         ├─ build `layout` class-map     high_level.py:149-172
                 │         └─ interpreter.process_page()   high_level.py:178
                 │              └─ TranslateConverter.receive_layout()   converter.py:170
                 │                   ├─ A. paragraph segmentation + formula grouping
                 │                   ├─ B. ThreadPoolExecutor → translator.translate(s)  converter.py:361-364
                 │                   └─ C. re-layout → new content-stream ops   converter.py:366-529
                 └─ apply obj_patch → doc_zh.update_stream()   high_level.py:341-346
                 └─ doc_en.insert_file(doc_zh); move_page()    high_level.py:348-350  (dual assembly)
                 └─ write mono + dual                          high_level.py:354-357
```

Output naming: `{stem}-mono.pdf` (translated only) and `{stem}-dual.pdf` (interleaved).
See `high_level.py:502-503`.

**The original file is never written to.** `high_level.translate()` opens the source read-only
(`doc_raw = open(file, "rb")`, `high_level.py:483`) and only ever creates new files. The
*Original PDF is immutable* principle is therefore satisfied by the architecture itself — we
must simply not break it.

---

## 2. BaseTranslator (Q2)

`pdf2zh/translator.py:39-163`.

```python
class BaseTranslator:
    name = "base"; envs = {}; lang_map = {}; CustomPrompt = False

    def __init__(self, lang_in, lang_out, model, ignore_cache): ...
    def set_envs(self, envs): ...
    def add_cache_impact_parameters(self, k, v): ...
    def translate(self, text, ignore_cache=False) -> str:   # cache-fronted
    def do_translate(self, text) -> str:                    # subclass hook
    def prompt(self, text, prompt_template=None) -> list[dict]: ...
```

Key contracts:

- `translate()` is the **only** entry point the pipeline uses. It is
  **synchronous** (`translator.py:89`): cache lookup → `do_translate()` → cache store.
- `do_translate(self, text) -> str` **receives text and nothing else.** There is no
  context parameter anywhere in the translator contract. This is the central fact for §6.
- `prompt()` builds a single `user` message. With a `Template` it substitutes `lang_in`,
  `lang_out`, `text`; the built-in fallback prompt (`translator.py:133-149`) instructs:
  *"Keep the formula notation {v*} unchanged."*
- `set_envs()` (`translator.py:62-79`) merges, in order: class `envs` → **`ConfigManager`
  on-disk config** → `os.environ` → explicit `envs`, and **persists the result to disk**.
- Config is per-`translate_engine` name, stored as `{"name": ..., "envs": {...}}` in the
  config JSON (`config.py:137-152`).

### 2.1 Placeholder reality — spec correction required

The task brief (§42) states placeholders are `{{v0}}` / `<b0>`. **Both are wrong for the
actual pipeline.** Verified:

| Mechanism | Location | Status |
|---|---|---|
| Real formula marker `{vN}` (single brace) | built `converter.py:275`, `:334`; matched `converter.py:411` | **LIVE** |
| Pure-formula paragraph skip `^\{v\d+\}$` | `converter.py:350` | **LIVE** |
| `BaseTranslator.get_rich_text_left_placeholder` → `<bN>` | `translator.py:154-163` | **DEAD CODE** |
| `OpenAITranslator.get_formular_placeholder` → `{{vN}}` | `translator.py:493-500` | **DEAD CODE** |

A repo-wide grep for the three placeholder helper methods returns **only their own
definitions** — they are never called. The pipeline inserts literal `{v0}`, `{v1}`, … into the
source string before handing it to the translator.

**Consequence for AC:** the Placeholder Validator must validate the **single-brace `{vN}`
sequence**, not `{{vN}}`. Correcting this now prevents building a validator against a
non-existent format. This is recorded as a spec correction, not a silent change (see §10 of
the brief → `docs/decisions/`).

Note `converter.py:416-420`: the pipeline already tolerates a translator inventing
**out-of-range** formula markers and `continue`s past them — i.e. upstream silently degrades
on placeholder corruption rather than detecting it. Our validator is a genuine improvement,
not a duplicate.

---

## 3. OpenAITranslator (Q3)

`pdf2zh/translator.py:400-500`.

```python
envs = {OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL,
        OPENAI_STREAM, OPENAI_STOP_TOKENS, OPENAI_MAX_TOKENS}
CustomPrompt = True
client = openai.OpenAI(base_url=..., api_key=...)
options = {"temperature": 0}   # comment: 随机采样可能会打断公式标记
```

- `do_translate` calls **`client.chat.completions.create(...)`** hardcoded
  (`translator.py:473`). **There is no Responses API support anywhere in the repo.**
- Streaming is toggled by `OPENAI_STREAM`, collected and joined (`translator.py:479-484`).
- A `<think>…</think>` filter regex strips reasoning-model preamble (`translator.py:456-458`).
- Retry policy (`translator.py:463-471`): `retry_if_exception_type(openai.RateLimitError)`,
  `stop_after_attempt(100)`, `wait_exponential(multiplier=1, min=1, max=15)`.
  **Only 429 is retried.** 5xx / timeouts are *not* retried; 401/403 are *not* retried
  (which happens to be correct). This does not match the brief's §51 retry policy, so our
  provider layer must own retry and treat the upstream translator as retry-free.
- Cache impact params registered: `temperature`, `stop`, `max_tokens`, **the rendered prompt
  for empty text**, and the think-filter regex (`translator.py:452-457`). This is our
  template for adding glossary/context hashes.

---

## 4. OpenAIlikedTranslator (Q4)

`pdf2zh/translator.py:1058-1122`. Subclass of `OpenAITranslator`.

- Requires `OPENAILIKED_BASE_URL`, else `ValueError` (`:1074-1077`).
- Requires model via arg or `OPENAILIKED_MODEL`, else `ValueError` (`:1078-1082`).
- **If no API key is set it passes the literal string `"openailiked"`** (`:1083-1086`) —
  a deliberate placeholder to satisfy the OpenAI SDK for keyless local endpoints.
- `stream` defaults to **False** here (vs True for `OpenAITranslator`).
- Overrides `do_translate` with the same body but **without** the tenacity retry decorator.

**This class is the natural seam for "user owns endpoint / model / key."** It already accepts
arbitrary base URL + model + key and speaks Chat Completions. What it lacks is: Responses
protocol, editable profile management, keyring-backed secrets, and connection testing.

---

## 5. mono / dual PDF generation (Q5)

`translate_stream` returns a 2-tuple `(mono_bytes, dual_bytes)` (`high_level.py:354-357`).

- **mono** = `doc_zh` → translated text only, **same page count N** as the source.
- **dual** = `doc_en` (a byte-copy of the original) with `doc_zh` appended via
  `insert_file`, then pages interleaved by `move_page(page_count + id, id*2 + 1)`
  (`high_level.py:348-350`) → **page count 2N**, ordered
  `[orig₀, trans₀, orig₁, trans₁, …]`.

Both are written with `deflate=True, garbage=3, use_objstms=1`. Font subsetting runs unless
`skip_subset_fonts` is set (`high_level.py:351-353`).

---

## 6. Where the Context Engine belongs (Q6)

The pipeline reaches the translator at exactly **two** call sites:

| Call site | Context available there |
|---|---|
| `converter.py:353` — `self.translator.translate(s)` in `worker()` | none (only `s`) |
| `ocr.py:119` — `translator.translate(paragraph[1])` | none (only text) |

`worker()` is defined inside `receive_layout`, so it *does* close over `sstk` (the page's
paragraph list) and `ltpage.pageid`. **Previous/next paragraph within the same page is
therefore reachable with no plumbing.** Page number, section, glossary, and document summary
are **not** reachable — nothing above the page level is threaded down.

A repo-wide grep for `glossary|terminolog|acronym|document_summary` returns **one hit**, an
unrelated help-string in `QwenMtTranslator.envs` (`translator.py:1136`). **No context-aware
machinery exists upstream. This is 100% greenfield.**

Two viable insertion strategies:

**(a) Surgical upstream hook.** Thread an optional `context_provider` through
`translate` → `translate_stream` → `translate_patch` → `TranslateConverter.__init__` →
`worker`. Four files, ~10 lines. Gives exact per-block page/section identity.

**(b) Zero-upstream-change adapter (preferred for MVP).** `TranslateConverter.__init__`
already constructs the translator with `envs=envs` (`converter.py:166`). Supply a custom
translator subclass that receives an **immutable, document-scoped context map** at
construction, and resolves context by **source-text key** inside `translate()`. Requires no
edit to any upstream file. Thread-safe because the map is built once and only read.

Trade-off to record as a known limitation: text-keyed lookup is ambiguous when the same
paragraph string appears on two pages. Strategy (b) is sufficient for glossary + document
summary + section-level context; strategy (a) becomes necessary if we need byte-exact
per-block page attribution for citations.

**Decision: ship (b) in Phase 7, and revisit (a) only if per-block page attribution proves
necessary.** Rationale: keeps the upstream diff at zero, which protects upgradeability — the
project's stated "Do not rebuild PDFMathTranslate" principle.

---

## 7. Minimizing upstream change (Q7)

Needed capability → required upstream edit:

| Capability | Upstream change required |
|---|---|
| User endpoint/model/key | none — `OpenAIlikedTranslator` already does this |
| Responses API protocol | none — new subclass in *our* package |
| Glossaries / document context | none, via strategy (b) |
| Retry/backoff per §51 | none — we wrap, not patch |
| **Page-level progress + cancellation** | **none — already plumbed end-to-end** (§22.3) |
| Per-**block** progress/attribution | **yes** — upstream counts pages, not blocks |

---

## 8. Fork or dependency? (Q8)

Evidence:
- PyPI lags main (1.9.11 vs 1.9.12) — the released package is *not* the audited code.
- Upstream is 5.9k LOC, fast-moving, AGPL-3.0.
- Our required additions are all *additive* (new subclasses, external orchestration).
- The one thing we cannot get additively (per-block page identity) is **not needed for MVP**.

**Decision: consume as a pinned dependency, installed from a pinned commit of our reference
clone, with a thin adapter layer under `backend/app/pdfkernel/`. We do not fork and we do not
vendor a modified copy.**

Consequences to respect:
- Pin the exact commit; record it in `docs/decisions/`. Upgrades are deliberate.
- All our integration code lives in our own package and imports upstream as a library.
- If strategy (a) ever becomes necessary, we convert to a **documented patch series** rather
  than a silent fork, and record an `AC_CHANGE_REQUEST` if it affects acceptance criteria.

---

## 9. Is a Python Adapter feasible? (Q9)

**Yes — verified by execution, not inspection.** (`uv venv --python 3.12` +
`uv pip install -e _reference/PDFMathTranslate`; evidence log in
the evidence record for DS-ARCH-000.)

```
$ backend/.venv/Scripts/python.exe -c "import pdf2zh; ..."
pdf2zh version: 1.9.12
OK: all core imports succeed
translate sig: (files, output='', pages=None, lang_in='', lang_out='',
                service='', thread=0, vfont='', vchar='', callback=None,
                compatible=False, cancellation_event=None, model=...)
```

The 1.9.12 source tree installs and imports cleanly on Python 3.12.13, including
`high_level`, `translator`, `converter`, and `kernel`. An in-process Python adapter is
therefore viable, and no separate service is required for MVP.

Known frictions (not blockers):

Known frictions (not blockers):
- `high_level.translate_stream` passes `**locals()` down (`:339`) — the kwargs set is
  **implicit and fragile**; adding a parameter anywhere silently widens it. Our adapter must
  call the public `translate()` with explicit named arguments, never `**locals()`.
- `init_db()` executes **at import time** of `pdf2zh.cache` (`cache.py:141`), creating
  `~/.cache/pdf2zh/cache.v1.db` as a side effect of import. Tests must account for this.
- A global ONNX singleton `ModelInstance` (`doclayout.py:222`) is loaded once per process.
- The API is **synchronous and blocking**; our FastAPI layer must run it in a worker thread
  or process, never on the event loop.

---

## 10. Responses API (Q10) and Chat Completions (Q11)

- **Responses API: absent.** `do_translate` hardcodes `client.chat.completions.create`
  (`translator.py:473`, `:1104`). GitHub-wide there is no `/v1/responses` call.
  → We build it in `backend/app/llm/responses.py`; we do **not** patch upstream.
- **Chat Completions: present and stable**, and is the de-facto contract of the whole
  upstream translator family (AzureOpenAI, Ollama, Qwen-MT, DeepSeek, Grok, … all funnel
  through `openai` or compatible clients). Our provider layer must keep a Chat Completions
  path byte-compatible so existing profiles keep working — this is an explicit regression
  surface for the acceptance criteria (brief §76).
- The OpenAI SDK (`openai>=1.0.0`, `translator.py:12`) is already a dependency, and modern
  SDKs ship both `chat.completions` and `responses` — so adding Responses needs **no new
  dependency**.

---

## 11. Thread safety (Q12)

Concurrency is real: `ThreadPoolExecutor(max_workers=self.thread)`,
`converter.py:361-364`, default `--thread 4` (`pdf2zh.py:99`). Every worker calls
`translator.translate(s)` on the **same translator instance**.

Shared mutable state found:

| State | Location | Assessment |
|---|---|---|
| `ModelInstance` ONNX singleton | `doclayout.py:222` | read-only after load; acceptable |
| `ConfigManager` singleton | `config.py:8-20` | guarded by `RLock`; but **mutates global config on `get()`** (`config.py:103-107`) |
| `TranslationCache` | `cache.py:44-90` | SQLite/peewee; author explicitly documents no lock needed |
| `layout` dict | `high_level.py:94`, mutated `:172` | per-conversion, single-threaded during build |
| translator instance | one per conversion | must stay **immutable** w.r.t. per-block context |

**Design rule for our Context Engine (brief §45):** the context map is built *before* the
thread pool starts, is never mutated afterwards, and is passed by constructor — never via a
module global or a mutated `self.current_*`. A text-keyed immutable dict satisfies this.
`add_cache_impact_parameters` is called at construction only (`translator.py:452-457`),
which is consistent — but note `TranslationCache.replace_params` is *not* locked, and its
comment (`cache.py:51-53`) explicitly assumes params are finalised before threading begins.
Our code must preserve that assumption.

---

## 12. Cache (Q13)

`pdf2zh/cache.py`. SQLite via peewee at `~/.cache/pdf2zh/cache.v1.db`, WAL, `busy_timeout=1000`.

```
UNIQUE (translate_engine, translate_engine_params, original_text) ON CONFLICT REPLACE
```

- `translate_engine_params` = JSON of params, **recursively key-sorted** for stability
  (`cache.py:32-42`) — so dict ordering does not perturb the key.
- The key is `(engine, params, source_text)`. `add_cache_impact_parameters` is the sanctioned
  extension point.
- **Risk:** the cache is global across documents and currently keyed on nothing
  document-specific. Once glossaries and document summaries influence translation, the *same
  English paragraph* in two different papers could legitimately need different Chinese
  output. Without adding a context hash, we would serve a stale translation from the other
  document.
  → Brief §68 anticipates this. **Our translator subclass must register
  `glossary_hash`, `document_context_hash`, and `prompt_version` as cache impact parameters.**
- Note `get()` uses `_TranslationCache.get_or_none`; `set()` swallows all exceptions
  (`cache.py:89-90`) — cache writes can fail silently, which is acceptable for a cache but
  must not be confused with translation success.

---

## 13. fast vs precise (Q14)

`pdf2zh/kernel/` — a registry-based abstraction (`registry.py`), with `--mode fast|precise`
(`pdf2zh.py:174-180`).

- **fast** → `legacy.py` → in-process `high_level.translate()`.
- **precise** → an **external repository** (`PDFMathTranslate-next`) reached over an IPC
  bridge (`v2_bridge.py` / `v2_worker.py`), provisioned into an isolated venv by
  `pdf2zh-setup-precise`.
- `.gitmodules` declares `vendor/PDFMathTranslate-next`; in our clone
  `pdf2zh/kernel/PDFMathTranslate-next.git` is an **empty, uninitialised submodule directory**.
  Precise mode is therefore **not available** without fetching a second repo and provisioning
  a separate environment.
- `pyproject.toml` marks the `precise` extra as `[]` with the comment
  *"run `pdf2zh-setup-precise` after install to provision the isolated venv"*.

**Decision: MVP ships `fast` only**, matching brief §70. Precise is deferred behind the
existing `--mode` abstraction, which costs us nothing to respect.

---

## 14. OCR (Q15)

`pdf2zh/ocr.py`.

- `_ocr_pages` (`high_level.py:216-272`) runs **before** translation and only touches pages
  where `page.get_text().strip()` is empty **and** the page has images
  (`high_level.py:241`) — i.e. native text PDFs are never OCR'd. This matches brief §69.
- Implementation uses **PyMuPDF's built-in Tesseract** via
  `page.get_pixmap(dpi=300).pdfocr_tobytes(language, tessdata)` (`high_level.py:247-250`),
  then `show_pdf_page`s the recognised layer back onto the page — a genuine invisible text
  layer, not a re-render.
- Language data is downloaded on first use via `pooch` from `tessdata_fast` 4.1.0 into
  `~/.cache/pdf2zh/tessdata/4.1.0` (`high_level.py:197-213`) unless `TESSDATA_PREFIX` is set.
  **First-run network dependency.** Overridable with `PDF2ZH_OCR_LANGUAGE`.
- Language defaults map from `lang_in` (`high_level.py:218-231`); unrecognised codes fall
  back to `"eng"`.
- Recognised pages are collected into `ocr_pages`, which `translate_patch` then routes to
  `translate_ocr_page(...)` (`high_level.py:136-146`), which calls the **same translator**
  per recognised paragraph (`ocr.py:119`).
- The optional `[ocr]` extra is just `pooch`.

---

## 15. Side-by-side: original + mono, not dual (Q16)

- `dual` = **2N pages**, interleaved `[orig₀, trans₀, orig₁, trans₁, …]`.
- `mono` = **N pages**, translated only, page-for-page aligned with the source.

For a side-by-side reader with page sync, **use `original.pdf` + `mono.pdf`**: both have N
pages, so page *i* on the left maps to page *i* on the right with no arithmetic. Choosing
`dual` would force us to de-interleave *and* to render the original twice.

`dual` remains the right artifact for **export** (printing, single-file sharing, reading in
any external PDF viewer). Both are produced by one conversion pass, so we keep both.

---

## 16. API key storage (Q17)

**Upstream storage is unsafe and must not be reused.**

- `ConfigManager` writes a **plaintext JSON** file at
  `~/.config/PDFMathTranslate/config.json` (`config.py:28`), via
  `json.dump(..., indent=4)` with no encryption and no file-permission hardening
  (`config.py:54-60`).
- `set_translator_by_name` persists the whole `envs` dict — including `OPENAI_API_KEY`
  (`config.py:137-152`), and `set_envs` calls it on every translator construction
  (`translator.py:79`).
- Worse: `ConfigManager.get()` reads `os.environ` and then **writes the value back to disk**
  (`config.py:103-107`). So merely supplying a key by environment variable causes it to be
  persisted in cleartext as a side effect.
- `ConfigManager.all()` returns the raw config dict — a straightforward secret-leak vector
  if ever exposed through an HTTP endpoint.

**Our design:** secrets go to the OS credential store (Windows Credential Manager) via
`keyring`; SQLite stores only a **reference/alias**, never the key. The frontend receives only
a masked form (`sk-••••••••ab12`). `ConfigManager` is **never** used for credentials — if we
call upstream at all, we pass `envs` explicitly per conversion and keep the process
environment clean.

---

## 17. Tauri + Python sidecar risks (Q18)

- **No Rust toolchain on this machine** (`cargo: command not found`) — Tauri cannot even be
  built today. Deferring to Phase 12 (as brief §26 requires) is not merely preferred, it is
  currently mandatory.
- Packaging `onnxruntime` + `opencv-python-headless` + `pymupdf` + `gradio` into a sidecar
  via PyInstaller is heavy (hundreds of MB) and a well-known source of runtime hook breakage.
- The DocLayout **ONNX model must be fetched on first run**; a packaged app needs an offline
  story and a clear failure mode.
- Sidecar lifecycle: port allocation, crash/restart, orphaned processes on hard exit,
  and Windows firewall prompts on first bind.
- Our FastAPI layer must not import the heavy PDF stack at startup if we want a fast, robust
  desktop boot — lazy-import the kernel.

---

## 18. Biggest engineering risks (Q19)

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | Context injection without forking upstream | High | Strategy (b); revisit only if needed (§6) |
| 2 | **Cache contamination across documents once context is added** | High | Register glossary/context/prompt hashes as cache impact params (§12) |
| 3 | Global ONNX singleton + blocking sync API under FastAPI async | High | Run kernel in a worker/process; never on the event loop (§9) |
| 4 | Placeholder corruption silently degrades upstream | Medium | Our validator on the real `{vN}` format (§2.1) |
| 5 | `**locals()` implicit kwargs in `translate_stream` | Medium | Call public API with explicit named args only (§9) |
| 6 | First-run model + tessdata download | Medium | Explicit "preparing" state; offline error handling |
| 7 | Cross-page section detection needed for QA citations | Medium | Build in Document Intelligence, not in the PDF kernel |
| 8 | Upstream moves fast (main ≠ PyPI) | Medium | Pin commit; deliberate upgrades (§8) |

---

## 19. License risk (Q20)

**PDFMathTranslate is AGPL-3.0.** This is the single most consequential non-technical finding.

- **Local private use / self-hosting with no distribution → no source-disclosure obligation.**
  The MVP as specified (local-first, user's own endpoint and key) sits here.
- **Distributing the desktop application** (Phase 12) triggers AGPL §5/§13: the distributed
  combined work must carry the complete corresponding source under AGPL-3.0, and **network
  use (AGPL §13) also requires offering source to remote users.** Our own integration code
  becomes part of that combined work.
- **A proprietary/closed-source product built on this dependency is not permissible without
  complying with AGPL.** A commercial license must be obtained from the upstream authors.
- **PyMuPDF is also AGPL-3.0** (dual-licensed commercially) and is a hard dependency
  (`pymupdf<1.25.3`). It carries the same obligation independently, so the constraint is not
  avoidable by swapping one library.
- `babeldoc` is a further dependency and must have its license audited before distribution.
- Attribution: upstream copyright notice and license text must be preserved in any
  distribution.

*This is an engineering assessment, not legal advice. Distribution decisions require a real
license review.*

**Recommendation:** keep the repository's license compatible with AGPL-3.0 for now
(AGPL-3.0 for our code as well, or a compatible license), and flag the commercial-distribution
question to the user as a **decision gate before Phase 12**. This must not silently become a
problem at packaging time.

---

## 20. Corrections to the Task Brief

Recorded explicitly per brief §10 rather than silently applied:

| Brief says | Reality | Action |
|---|---|---|
| §42 placeholders are `{{v0}}` and `<b0>`/`</b0>` | Live format is **`{vN}` single-brace**; `{{vN}}` and `<bN>` helpers are dead code | Validator targets `{vN}`. `AC_CHANGE_REQUEST` to be raised when DS-CTX placeholder task is defined |
| §42 "Placeholder Validator" compares source vs translated sequences | Upstream has **no** such check; it silently skips out-of-range markers (`converter.py:416-420`) | Our validator is net-new — scope it as new code, not an upstream reuse |
| §43 "precise kernel" as an integration target | Precise needs a **separate uninitialised repo + isolated venv** | MVP = fast only (aligns with §70) |
| §53 credential storage | Upstream uses **plaintext config.json** and persists env keys to disk | We build our own keyring-backed store; do not reuse `ConfigManager` |
| §93 "Cache 如何工作" | Global, document-agnostic key | Must extend with context/glossary hash before Context Engine ships |

---

## 22. Kernel Subsystem — Deep Dive

### 22.1 The protocol

`pdf2zh/kernel/protocol.py:41-65` defines a `@runtime_checkable KernelProtocol`:

```python
def translate(self, request: TranslateRequest,
              callback: Any = None,
              cancellation_event: Optional[asyncio.Event] = None) -> list[TranslateResult]
async def translate_async(self, ...) -> list[TranslateResult]
```

Two registration warnings:

- `KernelProtocol` is **never actually used** — neither kernel inherits it, and nothing in the
  repo performs an `isinstance` check. Conformance is purely structural. Type-checking will
  not catch a drift between a kernel and its advertised protocol.
- `callback` is typed `Any`, and **the two kernels pass structurally incompatible objects**:
  `LegacyKernel` passes a `tqdm.tqdm` instance; `PreciseKernel` passes a `dict`. This is a
  live bug in upstream: `gui.py:325-329` defines `progress_bar(t: tqdm.tqdm)` as
  `t.n / t.total`, and hands that same function to both kernels (`gui.py:344`, `:376`).
  Under `--mode precise` it raises `AttributeError: 'dict' object has no attribute 'n'`.
  **Our adapter must not adopt the untyped `callback` contract** — we define our own progress
  event type and adapt at the boundary.

Dispatch: `KernelRegistry.switch(mode)` / `.get()` (`registry.py:23-42`). `get()` with no
active kernel defaults to `"fast"`.

### 22.2 fast vs precise, mechanically

- **fast** = `LegacyKernel` (`kernel/legacy.py`). In-process, `is_available()` hardcoded
  `True`. Lazily loads the ONNX model into the global slot if unset (`legacy.py:41-42`), then
  calls `pdf2zh.high_level.translate(**kwargs)` (`legacy.py:38, 71`).
- **precise** = `PreciseKernel` (`kernel/precise.py`). A **separate venv plus a separate
  subprocess**, not a library import. `is_available()` requires the submodule directory, its
  `pyproject.toml`, *and* its `.venv` python (`precise.py:59-65`). In our checkout the
  submodule directory is empty → **unavailable**.

`pdf2zh-setup-precise` → `setup_precise_cli` → `PreciseKernel().ensure_venv()`
(`precise.py:246-249`, `:67-99`), which runs `python -m venv` then
`pip install -e <submodule>` — an **unpinned editable install resolved from PyPI, no
lockfile**, with a 300 s timeout. `KernelRegistry.switch` calls `ensure_venv()` *before* the
availability check (`registry.py:35-36`), so a first `--mode precise` run can block for
minutes in `pip install` rather than failing fast.

### 22.3 Progress and cancellation are already plumbed — for fast

This is a **positive** finding that simplifies our plan. The chain is complete:

| Layer | Callback | Cancellation |
|---|---|---|
| `protocol.py:51-63` | `callback: Any` | `cancellation_event` |
| `legacy.py:31-36, 83-88` | forwards | forwards |
| `high_level.translate` (`:409-427`) | forwards | forwards |
| `high_level.translate_stream` (`:275-291`) | forwards | forwards |
| `high_level.translate_patch` (`:121-129`) | `callback(progress)` **once per page**, tqdm instance | raises `asyncio.CancelledError` per page (`:123-124`) |

Additional cancellation points: `_ocr_pages` per page (`high_level.py:235-236`), and **per
paragraph** inside OCR threads (`ocr.py:117-118`).

So for the fast kernel we get cooperative per-page cancellation and per-page progress with
**no upstream modification**. This confirms the earlier conclusion that only *per-block*
granularity needs new code — and per-block progress is our own instrumentation anyway.

**Caveats our adapter must handle:**

- **CLI drops both** (`pdf2zh.py:375` calls `kernel.translate(request)` with neither), so we
  must pass them explicitly ourselves.
- Cancellation granularity is **per page**, so a cancel cannot interrupt an in-flight page.
  The UI must not promise otherwise (see `API_CONTRACT.md` §5).
- `@retry(wait=wait_fixed(1))` in `ocr.py:115` has **no stop condition** — a persistently
  failing translator retries *forever* inside worker threads. We must bound this, since an
  unbounded retry loop is indistinguishable from a hang to the user.

### 22.4 precise: not merely unavailable, but unsuitable

Independently of the missing submodule, `precise.py` has defects that make it unusable for
our requirements:

- **`cancellation_event` is accepted and never read** (`precise.py:122-127`, `:198-203`). No
  `is_set()`, no `terminate()`, no `kill()` outside the exception path. Cancelling a precise
  job through this interface is impossible.
- **`translate_async` discards progress entirely** — it uses `await proc.communicate(...)`
  (`precise.py:220`), which buffers stderr instead of iterating it, so the callback never
  fires. Progress streaming exists only on the sync path.
- `skip_subset_fonts` is silently dropped in `v2_bridge.py` despite being honoured by the fast
  path (`legacy.py:58`).
- `thread` is mapped to v2's `--qps` (`v2_bridge.py:143-144`) — a worker-pool size
  reinterpreted as a rate limit.
- If `service` is not in `SERVICE_NAME_MAP`, **no engine flag is emitted at all** and v2
  silently falls back to its own default engine (`v2_bridge.py:124-126`).

**Decision reinforced:** MVP ships `fast` only (ADR-001, brief §70).

### 22.5 The layout model is babeldoc's, and it is a 72 MB lazy download

`OnnxModel.from_pretrained()` (`doclayout.py:127-130`) calls
`get_doclayout_onnx_model_path()` imported from **`babeldoc.assets.assets`** (`doclayout.py:8`).
The model is owned and located by the babeldoc dependency, **not by this repository**.

| Property | Value |
|---|---|
| File | `doclayout_yolo_docstructbench_imgsz1024.onnx` |
| Size | **75,324,598 bytes (~71.9 MiB)** |
| Source | HuggingFace `wybxc/DocLayout-YOLO-DocStructBench-onnx` (Apache-2.0) |
| Integrity | SHA3-256 verified by babeldoc |
| Cache | `~/.cache/babeldoc` |
| Present in repo? | **No** — no `*.onnx` exists anywhere in the tree |

It downloads lazily on first `from_pretrained()`. `Dockerfile:19,23` warms it explicitly with
`babeldoc --warmup`, which is the pattern we should follow: **make first-run preparation an
explicit, visible step**, never a silent multi-minute stall inside the user's first
translation.

Also note `doclayout.py:113-120` writes a graph-optimized cache (`<model>.optimized`) next to
the model — i.e. **into babeldoc's shared cache directory**, which the app does not own.

Global slot: `ModelInstance.value` (`doclayout.py:222-223`). Read-only after load, but it is
process-global — reinforcing the "run the kernel off the event loop" rule (ARCHITECTURE §4.1).

### 22.6 `backend.py` is not a foundation to build on

Flask + Celery + Redis (`backend.py`), with `flask`/`celery`/`redis` as *optional* extras.
Tasks take the **whole PDF as in-memory bytes** through Celery (`backend.py:39-58`) and return
the two output blobs. It imports `translate_stream` directly (`backend.py:4`), so it **never
touches the kernel layer at all** — `--mode` is meaningless through it — and it never passes
`cancellation_event`. Its only cancellation path is `AsyncResult.revoke(terminate=True)`
(`backend.py:80-84`), a hard worker kill. It persists nothing itself.

**Consequence:** we build our own FastAPI layer as planned (ARCHITECTURE §3) and do not adopt,
extend, or depend on `backend.py`.

## 21. Answers Index

| Q | Answer | Section |
|---|---|---|
| 1 | Full pipeline mapped | §1 |
| 2 | `BaseTranslator`, sync, cache-fronted, text-only `do_translate` | §2 |
| 3 | `OpenAITranslator` — Chat Completions only, 429-only retry | §3 |
| 4 | `OpenAIlikedTranslator` — the user-endpoint seam | §4 |
| 5 | mono = N pages translated; dual = 2N interleaved | §5 |
| 6 | Context belongs at `converter.py:353`; strategy (b) needs zero upstream edits | §6 |
| 7 | Only per-block progress/attribution need real edits | §7 |
| 8 | Pinned dependency + thin adapter; no fork | §8 |
| 9 | Feasible; sync/global-singleton frictions noted | §9 |
| 10 | Responses absent → build in our layer | §10 |
| 11 | Chat Completions is the compat contract | §10 |
| 12 | Immutable pre-built context map; never globals | §11 |
| 13 | SQLite, params-JSON key; **must add context hash** | §12 |
| 14 | fast = in-process; precise = external repo (unavailable) | §13 |
| 15 | Reuse PyMuPDF Tesseract; image-only pages | §14 |
| 16 | **original + mono** for side-by-side; dual for export | §15 |
| 17 | Upstream storage unsafe; use keyring; never `ConfigManager` | §16 |
| 18 | No cargo today; heavy packaging; lifecycle risks | §17 |
| 19 | Top risk = cache contamination, then context plumbing | §18 |
| 20 | **AGPL-3.0 + PyMuPDF AGPL** — distribution gate | §19 |
