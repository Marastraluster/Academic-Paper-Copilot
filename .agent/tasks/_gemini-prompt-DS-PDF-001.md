You are the independent Acceptance Criteria Agent for task DS-PDF-001.

You are NOT implementing this task. You are NOT writing production code.

Define objective, testable acceptance criteria BEFORE implementation begins.

Scope:
- a thin adapter around the ALREADY-INSTALLED upstream PDF translation library
- input PDF -> translated (mono) PDF + bilingual (dual) PDF
- source file immutability
- running the blocking upstream API off the event loop
- typed error normalisation
- tests that run offline

Explicitly exclude:
- context-aware translation, glossary, document intelligence (later phases)
- translation task system / SSE / cancel (later phase)
- Paper QA, frontend, Tauri
- provider profiles and credentials (DS-BE-005, complete)
- modifying upstream in any way

Return criteria grouped as P0 MUST / P1 SHOULD / P2 OPTIONAL, numbered AC-01, AC-02, ...
Tag every criterion. Only P0 blocks completion.

=====================================================================
TASK_DESCRIPTION
=====================================================================

# DS-PDF-001 — PDFMathTranslate Adapter (Phase 3)

## Goal
Prove the integration end to end, with no intelligence layered on top:
    input PDF -> translated PDF (mono) -> bilingual PDF (dual)
Nothing else: no context engine, no glossary, no prompt engineering, no task system.
This task isolates INTEGRATION risk from INTELLIGENCE risk — if translation quality is poor
later, we will know it is the context engine, not the plumbing.

## Product Context
The product's core promise is a LOSSLESS bilingual translation of an academic PDF, with the
original never modified. This is where that promise first becomes real.

## Technical Context (established by a source-level audit of the upstream library)
- Upstream (PDFMathTranslate, version 1.9.12) is installed in backend/.venv from a PINNED
  COMMIT. It is consumed as a dependency; it is never forked, vendored, or edited.
- requires-python >=3.11,<3.13. The venv is 3.12.13. The machine default (3.14) cannot run it.
- high_level.translate() is the public API.
- translate_stream propagates **locals() implicitly — an extra local variable can silently
  become a kernel argument, so the adapter must call upstream with EXPLICIT named arguments.
- The upstream API is SYNCHRONOUS AND BLOCKING.
- pdf2zh.cache.init_db() runs AT IMPORT TIME, creating ~/.cache/pdf2zh/. This is an unavoidable
  import side effect.
- Output naming is {stem}-mono.pdf / {stem}-dual.pdf. mono = N pages translated;
  dual = 2N pages interleaved [orig0, trans0, orig1, trans1, ...].
- The layout model is an ONNX file (~72 MiB) lazily downloaded from HuggingFace on first use.
- Upstream's ConfigManager writes API keys in PLAINTEXT to ~/.config/PDFMathTranslate/. It must
  NEVER be used; configuration is passed explicitly per call via `envs`.
- The upstream `openailiked` service accepts an arbitrary base URL, API key and model, and
  speaks OpenAI Chat Completions. That is the integration point for a user-configured profile.

## Requirements
R1.  app/pdfkernel/ is the ONLY package that imports pdf2zh. A test enforces this.
R2.  One entry point: given a source PDF path, an output directory, a target language and a
     provider configuration, produce mono and dual outputs and return their paths.
R3.  THE SOURCE FILE IS NEVER MODIFIED. Asserted by content hash before and after — INCLUDING
     on the failure path.
R4.  Runs OFF the event loop (worker thread / executor); an async wrapper must not block.
R5.  Provider configuration maps onto upstream `envs` for the `openailiked` service. Never
     ConfigManager.
R6.  Upstream failures surface as TYPED errors, never raw upstream exceptions, and never carry
     the API key.
R7.  Engine selection is explicit: `fast` only. Anything else is a typed error, not a silent
     fallback.
R8.  Importing app.pdfkernel has no side effects BEYOND what importing pdf2zh itself forces.
     That unavoidable side effect is documented, not hidden.
R9.  No secret in any log or error.
R10. Tests run offline against a LOOPBACK endpoint standing in for an LLM provider.

## Known Risks
- The ~72 MiB model download makes the first real translation slow and network-dependent.
  Tests must not depend on it being present nor hang waiting for it.
- init_db() at import writes to the user's home directory. Unavoidable without patching
  upstream; must be documented rather than pretended away.
- Silent **locals() kwarg leakage if the adapter calls upstream carelessly.
- Output naming collisions if two documents share a stem in one output directory.

=====================================================================
DESIGN QUESTIONS THE CRITERIA MUST SETTLE
=====================================================================

Give an explicit, verifiable rule for each:

Q1. HOW IS THE ADAPTER EXERCISED OFFLINE? A loopback HTTP server implementing the Chat
    Completions response shape would let the REAL upstream pipeline run for real with no
    external network. Is that required, or is mocking pdf2zh acceptable? State which, and
    what the resulting test must prove.

Q2. THE LAYOUT MODEL. The first run needs ~72 MiB from HuggingFace. What is the typed error
    when it is absent and cannot be downloaded? How long may the adapter wait? How do tests
    avoid triggering a download or hanging on one?

Q3. PAGE-COUNT GUARANTEES. Confirm mono == source page count and dual == 2x source, and state
    the assertion.

Q4. ORIGINAL-FILE IMMUTABILITY ON FAILURE. Confirm the assertion covers a mid-translation
    failure, not only success.

Q5. OUTPUT LOCATION. Caller-supplied directory or app-managed? Must the adapter refuse to
    overwrite an existing output, or replace it?

=====================================================================
PRODUCT_ARCHITECTURE
=====================================================================

  Application (translation task system — LATER)
      ↓
  app/pdfkernel/            <- THIS TASK: the only package importing upstream
      ↓
  pdf2zh.high_level.translate()   (pinned dependency, called with explicit named args)
      ↓
  OpenAI-compatible endpoint (the user's own provider profile)

Existing backend conventions that must be followed:
- Error envelope for HTTP: {"error": {"code", "message", "detail"}}.
- Structured JSON logging; fields named api_key/authorization/token/secret/password are
  redacted to "[REDACTED]"; free text is scrubbed for "Bearer <token>" and "key=value".
- The key literal is ALSO stripped from error messages explicitly (app.llm.errors.sanitize_message).
- Importing app modules must have no side effects (with the one documented pdf2zh exception).
- The test suite runs entirely offline under an autouse socket guard that fails any NON-LOOPBACK
  connection. Loopback is therefore permitted and is the intended test seam.

=====================================================================
RELEVANT_EXISTING_BEHAVIOR
=====================================================================

- backend has 379 passing tests. frontend has 27. All must still pass.
- app/llm/ exposes ProviderConfig (frozen pydantic: base_url, api_key SecretStr, model,
  timeout_s, temperature, max_output_tokens, custom_headers) and two adapters.
- app/storage/ exposes ProfileStore.to_provider_config(id) -> ProviderConfig.
- app/security/ stores keys in the OS credential store.
- An existing test, tests/test_isolation.py::test_source_does_not_reference_upstream_paths,
  currently forbids ANY backend source from mentioning `pdf2zh` or `PDFMathTranslate`. That was
  correct while nothing imported upstream; THIS task makes the import legitimate. Its INTENT is
  that the backend must never touch upstream's cache or config directories. It must therefore be
  NARROWED (forbid the paths) rather than deleted, with app/pdfkernel/ exempt from the name
  check. The criteria should state what the narrowed guard must assert so the original
  protection is preserved rather than lost.
- A prior permission decision explicitly allows executing the pinned upstream clone; this is not
  a security exception but a reviewed one.

=====================================================================

Now produce the acceptance criteria document in Markdown. Use a table with columns
ID | Priority | Description & Verification Target. Be specific and objectively verifiable —
prefer concrete values (page counts, hashes, exception types, file names) over adjectives.
Give an explicit answer to each of Q1-Q5.
