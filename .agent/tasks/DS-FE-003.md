# DS-FE-003 — Translate Action + Translation Result Viewer

- **Phase:** 4 (closes the first usable product loop)
- **Status:** Blocked on DS-BE-007 — AC authoring after it lands
- **Owner:** DeepSeek (implementation) · Gemini (acceptance criteria)
- **Created:** 2026-09-17
- **Baseline:** `82e296d`

## Premise correction (recorded before any code)

This task was specified as frontend integration against "the existing real backend translation
endpoint". **No such endpoint exists.** The backend exposes only `/api/health` and
`/api/profiles/*`; the document and task routes are specified in `docs/API_CONTRACT.md` but were
never implemented. `translate_pdf` is real and verified — as a Python API, not over HTTP.

Since this task explicitly forbids mocking, its prerequisite is **DS-BE-007** (document +
translation HTTP API). Nothing here is built on a fake success path.

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
| PDF.js | Lazy, in its own 483 kB async chunk; initial bundle 250 kB |
| Profiles | `/api/profiles` CRUD; keys masked, never returned |
| Translation | DS-BE-007's HTTP surface (documents, tasks, artifacts) |
| Store | Zustand (`src/stores/workspace.ts`) |

## Files Allowed To Modify

```
frontend/src/translation/**   (new — dialog, state, API client)
frontend/src/api/**           (extend the existing client)
frontend/src/stores/**        (translation state)
frontend/src/pdf/**           (accept a document source; no reader rewrite)
frontend/src/app/**           (toolbar action, mode switch)
frontend/src/tests/**
.agent/tasks/DS-FE-003.md
.agent/evidence/DS-FE-003.md
```

## Files Forbidden To Modify

```
backend/**        (DS-BE-007 owns the API; if it needs a change, that is its own task)
docs/** other than this task's acceptance file
_reference/**
```

## Requirements

R1. **AI Translate** action: disabled with no document, enabled with one, and **not silently
     duplicated** while a task is active.
R2. A compact dialog: source language, target language, provider, model, engine, page range.
     No fake Context Mode control — the Context Engine does not exist yet.
R3. Provider list comes from the existing `/api/profiles`; the default profile is preselected.
     With no usable profile, say so plainly instead of attempting translation.
R4. **The frontend never receives, displays, or logs an API key.** It references a profile.
R5. Translation targets **exactly the currently open document**.
R6. The request surfaces real backend state: submitting → translating → success/failure.
R7. **The original stays readable while translating.** No full-screen blocking spinner.
R8. Progress is **honest** — whatever the backend actually reports, including indeterminate.
R9. Failure leaves the original usable and the message actionable (auth, timeout, unreachable,
     model-not-found distinguished where the backend distinguishes them).
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

## Design questions the acceptance criteria should settle

1. **How does a local `File` become a backend document?** The browser has no filesystem path;
   the backend API must accept what it can actually supply.
2. **Progress transport.** Whatever DS-BE-007 chose (SSE or polling) — how does the UI express
   it without inventing numbers?
3. **What happens to a translation when the user switches documents mid-flight?** Discard,
   keep for later, or block the switch?
4. **Cancel.** Whatever DS-BE-007 can honestly promise — what does the button do, and what does
   it not do?
5. **Mode-switch behaviour when a translation is loading or has failed** — is `译文` enabled,
   and what does it show?

## Expected Tests

- Translate disabled without a document, enabled with one.
- Dialog opens, loads providers, shows defaults, submits the correct payload.
- Success registers the translation, enables Translation and Bilingual modes.
- Failure renders an error and leaves the original viewer usable.
- Mode switching across all three.
- **Document switching clears the previous translation** (R13).
- **A late result for document A does not become document B's translation** (R13).
- Re-translation replaces and cleans up the old result.
- No API key in any rendered state or request payload.

## Dependencies

DS-BE-007 (translation HTTP API), DS-FE-002 (reader), DS-BE-006 (profiles).

## Known Risks

- **Cross-document leakage** — the single most likely defect in this task, and the reason R13
  and its two tests exist.
- **Dishonest progress.** A progress bar that measures nothing is worse than none.
- **Blocking the reader** while translating, which would undo the product's premise that you can
  keep reading.
- **Reintroducing an eager PDF.js import**, undoing DS-FE-002's bundle work.
