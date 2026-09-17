You are the independent Acceptance Criteria Agent for task DS-BE-007.

You are NOT implementing this task. You are NOT writing production code.

Define objective, testable acceptance criteria BEFORE implementation begins.

=====================================================================
WHY THIS TASK EXISTS (important context)
=====================================================================

A frontend task (DS-FE-003) was specified as "wire the reader to the existing real backend
translation endpoint". On inspection, THAT ENDPOINT DOES NOT EXIST. The backend exposes only
/api/health and /api/profiles/*. docs/API_CONTRACT.md §2 and §5 SPECIFY documents and
translation tasks, but they were never implemented.

The translation kernel itself is real and verified end to end (a 2-page paper translated to
Chinese, correct page counts, source byte-identical). It exists as a PYTHON API:
app.pdfkernel.translate_pdf(...). It has no HTTP surface.

DS-FE-003 forbids mocking, so this prerequisite must be built first.

=====================================================================
TASK_DESCRIPTION
=====================================================================

# DS-BE-007 — Document + Translation HTTP API

## Goal
Expose the existing, verified translation kernel over HTTP so a browser client can import a
document, start a translation, observe progress, and fetch results — without kernel internals
leaking upward.

## Technical Context
- Kernel: app.pdfkernel.translate_pdf(source_pdf, output_dir, target_lang, provider_config, *,
  source_lang, engine, overwrite, threads, ignore_cache, executor) -> TranslationResult
  (mono_path, dual_path, source_page_count, mono_page_count, dual_page_count, duration_seconds).
  Raises PDFKernelError subclasses, each with .code and .to_dict() returning
  {"error": {"code", "message", "detail"}}.
- The kernel is SYNCHRONOUS, CPU-HEAVY AND BLOCKING. A translation takes minutes. It must run
  off the event loop, and the request that STARTS it must not be the request that WAITS for it.
- The kernel reports progress PER PAGE via a tqdm-shaped callback, and checks cancellation once
  per page. An in-flight page cannot be interrupted.
- Providers: /api/profiles CRUD exists; ProfileStore.to_provider_config(profile_id) builds the
  config the kernel consumes. Keys live in the OS credential store and are never returned.
- Persistence: SQLite, SCHEMA_VERSION = 2, with a numbered-migration mechanism already in place.
- HTTP conventions: loopback only; error envelope {"error": {code, message, detail}}; structured
  JSON logging that redacts fields named api_key/authorization/token/secret/password; importing
  app modules must have no side effects.
- A layout model (~72 MiB) is required by the kernel and is already cached locally.

## Requirements
R1.  Import a PDF and return a stable document_id. The browser holds a File, not a path, so
     MULTIPART UPLOAD must work; the JSON-path form in the contract may be supported too.
R2.  Serve the original file read-only. Never modify it.
R3.  POST /api/documents/{id}/translate returns immediately with a task_id; the translation runs
     in the background.
R4.  A task snapshot endpoint reports status, progress, and a normalised error.
R5.  Serve the produced mono and dual artifacts.
R6.  Kernel errors map onto the envelope with stable codes — no upstream exception text.
R7.  The provider's API key is never returned, logged, or stored with the document.
R8.  Progress is HONEST: the kernel reports per page. Block counts must be OMITTED rather than
     fabricated (docs/API_CONTRACT.md §5 says this explicitly).
R9.  Concurrent tasks are isolated; one document's failure cannot corrupt another's state.
R10. Tests never touch the user's real database, files, or credential store.

## Known Risks
- A long task holding state in memory is lost on restart. Acceptable for a local single-user app,
  but it must be a stated limitation rather than a surprise.
- PROGRESS INFLATION: it is tempting to report ANALYZING/RENDERING because the contract lists
  them. Reporting a phase the kernel does not distinguish is fabrication.
- Path traversal via a caller-supplied path or filename.
- Leaking filesystem paths into responses in a way the frontend might treat as durable.

=====================================================================
DESIGN QUESTIONS THE CRITERIA MUST SETTLE
=====================================================================

Give an explicit, verifiable rule for each:

Q1. WHERE DO UPLOADED FILES AND OUTPUTS LIVE? A per-document directory under a configurable
    root. Must DELETE ever remove the user's ORIGINAL — and if the original was uploaded (not a
    user-owned path on disk), is that different from a path-imported one?

Q2. TASK EXECUTION MODEL. A background thread, an asyncio task, or a worker? The kernel blocks,
    so it cannot run on the event loop. What happens to a task when the process exits, and what
    does a client see for a task that no longer exists?

Q3. STATUS VOCABULARY. The contract lists PENDING | ANALYZING | TRANSLATING | RENDERING |
    SUCCESS | FAILED | CANCELLED. The kernel exposes only per-page progress. Which of these can
    be reported TRUTHFULLY, and which would be invented? State the exact set to implement.

Q4. PROGRESS TRANSPORT. SSE (per the contract) or polling? State which and why, given the
    kernel's callback fires once per page and polls cancellation once per page.

Q5. CANCELLATION. The kernel checks an asyncio.Event once per page and an in-flight page cannot
    be interrupted. What can POST /cancel honestly promise, and what should the API say?

Q6. RETRY SEMANTICS. POST /retry is specified as "retry failed blocks only". Nothing in the
    kernel supports block-level retry. Should the endpoint exist, be narrowed, or be omitted?

Q7. UPLOAD LIMITS. Maximum size, and the failure mode when exceeded.

=====================================================================
PRODUCT_ARCHITECTURE
=====================================================================

  Browser (two independent PDF.js panes, DS-FE-002)
      ↓  multipart upload / fetch
  THIS TASK: /api/documents, /api/tasks
      ↓  runs off the event loop
  app.pdfkernel.translate_pdf()      (verified, bounded failure)
      ↓
  user's own provider profile        (key from the OS credential store)

Relevant frozen contract (docs/API_CONTRACT.md §2, §5):
  POST   /api/documents                    import; returns document_id + metadata
  GET    /api/documents/{id}/file          original, read-only
  GET    /api/documents/{id}/translated    mono output (N pages)
  GET    /api/documents/{id}/bilingual     dual output (2N pages)
  DELETE /api/documents/{id}               derived artifacts only — never the user's source
  POST   /api/documents/{id}/translate     -> task_id immediately
  GET    /api/tasks/{task_id}              status, progress, error
  GET    /api/tasks/{task_id}/events       SSE progress
  POST   /api/tasks/{task_id}/cancel
  POST   /api/tasks/{task_id}/retry

Reader sync depends on /file and /translated both having N pages so page i maps to page i.

=====================================================================
RELEVANT_EXISTING_BEHAVIOR
=====================================================================

- backend has 488 passing tests; frontend has 48. All must still pass.
- The kernel's bounded failure (DS-BE-FIX-002) is verified: 3 provider calls for a persistent
  500, 1 for 401, then a typed TranslationServiceError. The API must surface that promptly, not
  hang.
- Uploaded originals are copied again by the kernel before upstream sees them (upstream deletes
  input files under the system temp directory).
- The kernel needs the ~72 MiB layout model cached; if absent it raises
  LayoutModelUnavailableError quickly rather than downloading.
- The upstream translation cache is keyed without the endpoint, so the same text translated via
  two providers returns whichever ran first. `ignore_cache=True` is the current workaround and
  the API should be able to request it.
- Existing migrations are numbered; SCHEMA_VERSION is 2. A migration that fails mid-way must not
  leave a half-applied schema.

=====================================================================

Now produce the acceptance criteria document in Markdown. Use a table with columns
ID | Priority | Description & Verification Target. Prefer concrete values (exact status codes,
exact field names, exact state transitions, byte-identity assertions) over adjectives.
Give an explicit answer to each of Q1-Q7.
