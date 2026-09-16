# DS-PDF-001 — PDFMathTranslate Adapter (Phase 3)

- **Phase:** 3
- **Status:** AC authoring — implementation NOT started
- **Owner:** DeepSeek (implementation) · Gemini (acceptance criteria)
- **Created:** 2026-09-16

## Goal

Prove the integration end to end, with no intelligence layered on top:

```
input PDF  →  translated PDF (mono)  →  bilingual PDF (dual)
```

Nothing else. No context engine, no glossary, no prompt engineering, no task system. This task
exists to isolate **integration risk** from **intelligence risk** — if translation quality is
poor later, we will know it is the context engine, not the plumbing.

## Product Context

The product's core promise is a *lossless* bilingual translation of an academic PDF, with the
original never modified. This task is where that promise first becomes real.

## Technical Context

Established by the Phase 0 audit (`docs/REPO_AUDIT.md` Part II) and ADR-001:

| Fact | Consequence |
|---|---|
| `pdf2zh` 1.9.12 is installed in `backend/.venv` from a **pinned commit** | Consumed as a dependency; never forked, never edited |
| `requires-python >=3.11,<3.13` | The venv is 3.12.13; the machine default (3.14) cannot run it |
| `high_level.translate()` is the public API | Call it with **explicit named arguments** |
| `translate_stream` propagates `**locals()` implicitly | An extra local variable can silently become a kernel argument — never rely on it |
| The API is **synchronous and blocking** | Must run off the event loop |
| `pdf2zh.cache.init_db()` runs **at import time** | Importing creates `~/.cache/pdf2zh/` — a side effect to contain |
| Output naming is `{stem}-mono.pdf` / `{stem}-dual.pdf` | mono = N pages translated; dual = 2N interleaved |
| The ONNX layout model is a **~72 MiB lazy download** | First translation may need network and time |
| Upstream `ConfigManager` writes keys in **plaintext** | Never use it; pass `envs` explicitly per call |
| `openailiked` service accepts arbitrary base URL + key + model | The integration point for a user profile |

## Files Allowed To Modify

```
backend/app/pdfkernel/**              (new — the only package that may import pdf2zh)
backend/tests/test_pdfkernel.py       (new)
backend/tests/test_isolation.py      (narrow one guard — see below)
.agent/tasks/DS-PDF-001.md
.agent/evidence/DS-PDF-001.md
```

## Files Forbidden To Modify

```
backend/app/llm/**, backend/app/storage/**, backend/app/security/**
backend/app/{main,config,db,errors,logging}.py
backend/app/api/**
backend/tests/** other than the listed files
_reference/**            (upstream clone — read only, never edited)
frontend/**              (must keep passing 27 tests)
```

### The guard that must be narrowed

`backend/tests/test_isolation.py::test_source_does_not_reference_upstream_paths` forbids any
backend source from mentioning `pdf2zh` or `PDFMathTranslate`. That was correct while nothing
imported upstream; this task makes the import legitimate.

The guard's **intent** is that the backend must never touch upstream's cache or config
directories (FC-06 of DS-BE-001). It must be narrowed to that intent — e.g. forbid the *paths*
`~/.cache/pdf2zh` / `~/.config/PDFMathTranslate` — rather than deleted. `app/pdfkernel/` is the
one package exempt from the name check. Recorded here so the change is planned, not a surprise.

## Requirements

R1. `app/pdfkernel/` is the **only** package that imports `pdf2zh`. A test enforces this.
R2. One entry point: given a source PDF path, an output directory, a target language, and a
    provider configuration, produce mono and dual outputs and return their paths.
R3. **The source file is never modified.** Asserted by content hash before and after — including
    on the failure path.
R4. Runs **off the event loop** (worker thread or executor); an async wrapper must not block.
R5. Provider configuration maps onto upstream's `envs` for the `openailiked` service. Never
    `ConfigManager`.
R6. Upstream failures surface as **typed** errors, not raw upstream exceptions, and never carry
    the API key.
R7. Unsupported/absent kernel choice is explicit: `fast` only. Requesting anything else is a
    typed error, not a silent fallback.
R8. Importing `app.pdfkernel` has no side effects beyond what importing `pdf2zh` itself forces
    (its cache DB). That unavoidable side effect is documented, not hidden.
R9. No secret in any log or error.
R10. Tests run offline against a **loopback** endpoint standing in for an LLM provider.

## Design questions the acceptance criteria should settle

1. **How is the adapter exercised offline?** A loopback server implementing the Chat
   Completions shape lets the real upstream pipeline run for real with no external network.
   Is that required, or is mocking `pdf2zh` acceptable?
2. **What happens when the layout model is absent and cannot be downloaded?** The first run
   needs ~72 MiB from HuggingFace. What is the typed error, and how long should it wait?
3. **Page-count guarantees.** mono must have the same page count as the source; dual must have
   twice. Confirm these are asserted.
4. **Original-file immutability on failure** — confirm the assertion covers a mid-translation
   failure, not just success.
5. **Where does the translated output live?** A caller-supplied directory, or an app-managed
   one? And must the adapter refuse to overwrite an existing output?

## Expected Tests

- A real PDF translates end to end against a loopback provider, producing mono and dual.
- **Source hash unchanged** after success and after an induced failure.
- mono page count == source page count; dual == 2×.
- Output opens as a valid PDF.
- Typed error when the provider is unreachable.
- Typed error for an unsupported engine.
- The API key is absent from logs and error messages.
- Import isolation: only `app/pdfkernel` imports `pdf2zh`.
- The narrowed path guard still forbids upstream cache/config directories.
- Existing 379 backend + 27 frontend tests still pass.

## Dependencies

DS-BE-002/003/004/005 (provider layer and profiles). ADR-001 (pinned dependency).

## Known Risks

- **The ~72 MiB model download** makes the first real translation slow and network-dependent.
  Tests must not depend on it being present, nor trigger it in a way that hangs CI.
- **`init_db()` at import** writes to the user's home directory. Unavoidable without patching
  upstream; must be documented rather than pretended away.
- **Silent `**locals()` kwarg leakage** if the adapter calls upstream carelessly.
- **Output naming collisions** if two documents share a stem in one output directory.
- **This is the first task that executes upstream code**, which a permission classifier may
  treat as high-risk. Resolved by explicit user decision; noted so a future block is not
  mistaken for a code defect.
