# DS-FE-003 — Translate Action + Translation Result Viewer

- **Phase:** 4 (closes the first usable product loop)
- **Status:** Ready — DS-BE-007 has landed; criteria frozen before implementation
- **Owner:** DeepSeek (implementation) · Gemini (acceptance criteria)
- **Created:** 2026-09-17
- **Baseline:** `ef17457`

## Premise correction (recorded before any code)

This task was originally specified as frontend integration against "the existing real backend
translation endpoint". **No such endpoint existed.** The backend exposed only `/api/health` and
`/api/profiles/*`; the document and task routes were specified in `docs/API_CONTRACT.md` but had
never been implemented. `translate_pdf` was real and verified — as a Python API, not over HTTP.

Since this task explicitly forbids mocking, its prerequisite was built as its own task:
**DS-BE-007** (document + translation HTTP API, `ef17457`). Nothing here is built on a fake
success path.

The audit also found that the contract document itself had drifted from what was later built —
§5's example request body would be **rejected with a 422** by the implementation, because the
request model forbids unknown fields. `docs/API_CONTRACT.md` has been reconciled to the code as
part of this task.

## Goal

Close the loop: open a PDF → read it → translate it → read the translation → see both side by
side. This is the first task where the frontend consumes the real translation backend, and the
point at which the software becomes minimally usable rather than a prototype.

## Product Context

The reader is real (DS-FE-002): continuous scrolling, zoom, fit-width, a selectable text layer,
and two independent panes. The backend translates real PDFs and cannot hang (DS-BE-FIX-002).
What is missing is only the connection between them.

## Technical Context

| Piece | State |
|---|---|
| Reader | `src/pdf/PdfWorkspace` — self-contained, two instances already proven side by side |
| Reader modes | `ReaderModeSwitch` (`原文 / 双语 / 译文`) exists from DS-FE-001; panes swap |
| PDF.js | Lazy, in its own 483 kB async chunk; initial bundle 250 kB. **Frozen: < 500 kB.** |
| Profiles | `/api/profiles` CRUD; `has_key` + `api_key_masked` only, never the key |
| Translation | DS-BE-007's HTTP surface (documents, tasks, SSE, artifacts) |
| Store | Zustand (`src/stores/workspace.ts`) |
| API layer | Only `src/api/config.ts` (`apiUrl`) exists — the client itself must be written |

## The actual backend surface (verified at `ef17457`)

```
POST   /api/documents                    201  multipart `file` (browser) | JSON {path}
GET    /api/documents/{id}               200  {document_id,name,page_count,source,has_translation,created_at}
GET    /api/documents/{id}/file          200  original, N pages
GET    /api/documents/{id}/translated    200  mono, N pages
GET    /api/documents/{id}/bilingual     200  dual, 2N pages (export only)
POST   /api/documents/{id}/translate     202  {profile_id,lang_in,lang_out,engine} → {task_id,...}
GET    /api/tasks/{task_id}              200  status/progress/error
GET    /api/tasks/{task_id}/events       200  SSE: snapshot|progress|done|error|cancelled
POST   /api/tasks/{task_id}/cancel       200  CANCELLING (page boundary)
POST   /api/tasks/{task_id}/retry        501  deliberately unimplemented
GET    /api/profiles                     200  has_key, api_key_masked
```

Status vocabulary is exactly `PENDING | TRANSLATING | SUCCESS | FAILED | CANCELLED`. `progress`
is `null` or `{page, page_count}`. The request model is `extra="forbid"`.

**Supported languages** are upstream's canonical set — `zh, zh-TW, en, fr, de, ja, ko, ru, es,
it`. There is **no "auto"**; the language string is interpolated verbatim into the prompt.

## Files Allowed To Modify

```
frontend/src/api/**           (new client + document/profile/translation calls)
frontend/src/translation/**   (new — dialog, state, view-model)
frontend/src/stores/**        (translation state)
frontend/src/pdf/**           (accept a document source; no reader rewrite)
frontend/src/app/**           (toolbar action, status bar)
frontend/src/reader/**        (mode gating, pane wiring)
frontend/src/tests/**
docs/API_CONTRACT.md          (reconcile against the implementation)
.agent/tasks/DS-FE-003.md
.agent/evidence/DS-FE-003.md
```

## Files Forbidden To Modify

```
backend/**        (DS-BE-007 owns the API; if it needs a change, that is its own task)
_reference/**
```

## Requirements

R1. **AI Translate** action: disabled with no document, enabled with one, and **not silently
     duplicated** while a task is active.
R2. A compact dialog: source language, target language, provider, model, engine.
     **No fake Context Mode, Glossary, or page-range control** — none exist server-side.
R3. Provider list comes from the existing `/api/profiles`; the default profile is preselected.
     With no usable profile, say so plainly instead of attempting translation.
R4. **The frontend never receives, displays, or logs an API key.** It references a profile.
R5. Translation targets **exactly the currently open document**.
R6. The request surfaces real backend state: submitting → translating → success/failure.
R7. **The original stays readable while translating.** No full-screen blocking spinner.
R8. Progress is **honest** — whatever the backend actually reports, including indeterminate.
     The DS-FE-001 placeholder figures and the `示例` chip must go.
R9. Failure leaves the original usable and the message actionable (auth, rate-limit, timeout,
     unreachable, kernel error distinguished where the backend distinguishes them).
R10. Success loads the **mono** PDF into the translation pane. `dual` is for export, never the
     interactive bilingual reader (API_CONTRACT §2).
R11. Modes: Original always; Translation and Bilingual **disabled until a translation exists**.
R12. Independent viewer state per pane: document, loading task, zoom, scroll, current page.
R13. **Document identity guards everything.** Opening a new document clears the previous
     translation; a late result for document A must never appear as document B's translation.
R14. Re-translate replaces the previous result and cleans up its resources.
R15. Object URLs revoked; PDF.js teardown stays with the **loading task** (never
     `PDFDocumentProxy.destroy()` — it does not exist in PDF.js 6).
R16. **PDF.js stays lazily loaded**; the initial bundle stays under 500 kB.
R17. Page counts compared: a mismatch between original and translated is surfaced, not hidden,
     and must not break bilingual mode.

## Known Constraints

- Do **not** build the Context Engine (summary, glossary, neighbours, context modes) or the
  cache-identity fix. Those are later phases with their own criteria.
- Do **not** build Paper QA, retrieval, citations, or chat.
- Do **not** start Tauri packaging.
- No automatic frontend retry loop — DS-BE-FIX-002 bounds backend retries already.
- No password-entry UI for encrypted PDFs.

## Design decisions settled while authoring criteria

| Question | Decision | Grounding |
|---|---|---|
| How does a local `File` reach the backend? | `multipart/form-data`, field `file` | The browser has no path; the JSON form is for local callers |
| Does reading wait for registration? | **No.** PDF.js renders first; registration runs concurrently | Product premise: start reading immediately |
| Which artifact drives bilingual mode? | Original + **mono**, never dual | Dual is 2N interleaved pages; it cannot align 1:1 |
| How is cross-document leakage prevented? | State is keyed by backend `document_id`, so another document's entry is not reachable | Structural, not a guarded `if` |
| What does `Pages` map to? | Nothing — the field does not exist and would be a 422 | `extra="forbid"` |
| Which languages are offered? | Upstream's canonical ten | No "auto" exists upstream |

## Expected Tests

- Translate disabled without a document, enabled with one.
- Registration via multipart; failure to register is surfaced, reading still works.
- Dialog opens, loads providers, shows defaults, submits the correct payload.
- Keyless profile is accepted, not rejected.
- Progress mapping: `null`, `(0,N)`, `(1,1)`, `(p,N)`.
- Success enables Translation and Bilingual modes; mono loads into the pane.
- Failure renders an error and leaves the original viewer usable.
- Mode switching across all three.
- **Document switching clears the previous translation** (R13).
- **A late result for document A does not become document B's translation** (R13).
- Re-translation replaces and cleans up the old result.
- Blob URL revocation on switch / retranslate / teardown.
- No API key in any rendered state or request payload.

## Dependencies

DS-BE-007 (translation HTTP API, `ef17457`), DS-FE-002 (reader, `82e296d`),
DS-BE-006 (profiles).

## Known Risks

- **Cross-document leakage** — the single most likely defect in this task, and the reason R13
  and its two tests exist.
- **Dishonest progress.** A progress bar that measures nothing is worse than none.
- **Blocking the reader** while translating, which would undo the product's premise that you can
  keep reading.
- **Reintroducing an eager PDF.js import**, undoing DS-FE-002's bundle work.
- **Stale artifact bytes after retranslation** — re-fetching the same artifact URL can be served
  from the browser cache.
