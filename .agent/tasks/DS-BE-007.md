# DS-BE-007 — Document + Translation HTTP API

- **Phase:** 3 (completes the backend surface DS-FE-003 needs)
- **Status:** AC authoring — implementation NOT started
- **Owner:** DeepSeek (implementation) · Gemini (acceptance criteria)
- **Created:** 2026-09-17
- **Baseline:** `82e296d`

## Why this task exists

DS-FE-003 was specified as frontend integration against "the existing real backend translation
endpoint". **That endpoint does not exist.** The backend currently exposes only `/api/health`
and `/api/profiles/*`; `docs/API_CONTRACT.md` §2 and §5 *specify* documents and translation
tasks, but they were never implemented. `translate_pdf` is real and verified — as a Python API
(DS-PDF-001), not over HTTP.

DS-FE-003 explicitly forbids mocking, so this prerequisite has to be built first. Recorded here
rather than silently widening the frontend task's scope.

## Goal

Expose the existing, verified translation kernel over HTTP so a browser client can import a
document, start a translation, observe its progress, and fetch the results — without any of the
kernel's internals leaking upward.

## Technical Context

| Piece | State |
|---|---|
| Kernel | `app/pdfkernel.translate_pdf(...)` — real, verified end to end, bounded failure |
| Error taxonomy | `PDFKernelError` subclasses with `code` + `to_dict()` for the envelope |
| Providers | `/api/profiles` CRUD; `ProfileStore.to_provider_config(id)` |
| Persistence | SQLite, `SCHEMA_VERSION = 2` (profiles); numbered migrations exist |
| HTTP conventions | Envelope `{"error": {code, message, detail}}`; loopback only; structured logs with redaction |
| Frontend | Two independent PDF.js panes; already holds a local `File` |

**The kernel is synchronous, CPU-heavy, and blocking.** A translation takes minutes. It must run
off the event loop, and the HTTP request that starts it must not be the request that waits for it.

## Files Allowed To Modify

```
backend/app/api/documents.py        (new)
backend/app/documents/**            (new — document store + task registry)
backend/app/db.py                   (migration 3: documents + translation_tasks)
backend/app/config.py               (add documents_dir + max_upload_bytes)
backend/app/api/__init__.py, backend/app/main.py
backend/tests/test_api_documents.py (new)
.agent/tasks/DS-BE-007.md
.agent/evidence/DS-BE-007.md
```

> **Correction.** The first draft of this list forbade `config.py`. The frozen criteria require
> `Settings.documents_dir` and `Settings.max_upload_bytes`, so two additive settings are needed
> there. No existing setting changes.

## Files Forbidden To Modify

```
backend/app/pdfkernel/**   (the kernel is verified; this task wraps it, never changes it)
backend/app/llm/**, backend/app/storage/**, backend/app/security/**
backend/app/{config,errors,logging}.py
backend/tests/** other than the new file
frontend/**
_reference/**
```

## Requirements

R1. Import a PDF and return a stable `document_id`. The browser holds a `File`, not a path, so
    **multipart upload** must work; the JSON-path form in the contract may be supported too.
R2. Serve the original file read-only. Never modify it.
R3. **`POST /api/documents/{id}/translate` returns immediately** with a `task_id`; the
    translation runs in the background.
R4. A task snapshot endpoint reports status, progress, and a normalised error.
R5. Serve the produced `mono` and `dual` artifacts.
R6. Kernel errors map onto the envelope with stable codes — no upstream exception text.
R7. The provider's API key is never returned, logged, or stored with the document.
R8. Progress is **honest**: the kernel reports per page. Block counts must be omitted rather
    than fabricated (API_CONTRACT §5).
R9. Concurrent tasks are isolated; one document's failure cannot corrupt another's state.
R10. Tests never touch the user's real database, files, or credential store.

## Design questions the acceptance criteria should settle

1. **Where do uploaded files and outputs live?** A per-document directory under a configurable
    root. Must `DELETE` ever remove the user's *original* — and if the original was uploaded
    (not a user-owned path), is that different?
2. **Task execution model.** A background thread, an `asyncio` task, or a worker? The kernel
    blocks, so it cannot run on the event loop. What happens to a task when the process exits?
3. **Status vocabulary.** The contract lists `PENDING | ANALYZING | TRANSLATING | RENDERING |
    SUCCESS | FAILED | CANCELLED`. The kernel exposes only per-page progress; which of these
    can be reported truthfully, and which would be invented?
4. **Progress transport.** SSE (per the contract) or polling? State which, and why — given the
    kernel's callback fires once per page and polls cancellation once per page.
5. **Cancellation.** The kernel checks an `asyncio.Event` once per page, and an in-flight page
    cannot be interrupted. What can `POST /cancel` honestly promise?
6. **Retry semantics.** `POST /retry` is specified as "retry failed blocks only". Nothing in the
    kernel supports block-level retry. Should the endpoint exist, be narrowed, or be omitted?
7. **Upload limits.** Maximum size, and the failure mode when exceeded.

## Expected Tests

- Upload → id; fetch the original back byte-identical.
- Translate returns a task id immediately, without blocking.
- Task reaches a terminal state; success exposes retrievable artifacts.
- A provider failure produces a normalised failure, promptly (bounded, per DS-BE-FIX-002).
- Kernel errors map to the envelope with no upstream text.
- The API key never appears in any response or log line.
- Deleting a document does not delete a user-owned source file.
- No test touches real user data.

## Dependencies

DS-PDF-001 (kernel), DS-BE-005/006 (profiles + credential-backed config), DS-BE-FIX-002 (bounded
failure).

## Known Risks

- **A long task holding state in memory** is lost on restart. Acceptable for a local single-user
  app, but it must be a stated limitation rather than a surprise.
- **Progress inflation.** It is tempting to report `ANALYZING`/`RENDERING` because the contract
  lists them. Reporting a phase the kernel does not distinguish is fabrication.
- **Path traversal** via a caller-supplied path or filename.
- **Leaking filesystem paths** into responses in a way the frontend might treat as durable.
