# DS-DOC-004 — Acceptance Criteria authoring task (Gemini)

You are the independent Acceptance Criteria author for the Academic PDF Copilot
repository at `D:\marti\SciPrograms`. DeepSeek owns all production code. **You do
not write production code.** Your only deliverable is one document.

## Your deliverable

Write:

    D:\marti\SciPrograms\docs\acceptance\DS-DOC-004.md

P0 MUST / P1 SHOULD / P2 OPTIONAL criteria, each numbered, each independently
verifiable, each stating its evidence. Follow the structure of
`docs/acceptance/DS-DOC-003.md` and `docs/acceptance/DS-QA-015.md`.

## Time budget — read before you start

Hard 25-minute wall clock. **Do not run the test suites, the build, `pytest`, or
any browser harness.** A previous round was lost to an agent that spent its
budget launching suites and returned no document. Read source, decide, write.

## The task

**DS-DOC-004 · Reading Session Continuity.** Today, a browser reload destroys the
reading session: the open paper closes, the workspace returns to empty, and the
translation has to be fetched and opened again. The paper itself, its extracted
structure, its annotations and its translation are all still there — on disk and
in SQLite — so this is a *session* defect, not a data-loss defect. It is the same
shape as the defect DS-DOC-003 and DS-QA-010-FIX-001 removed for notes: the data
was never lost, the identity that reached it was.

The user reported it in one sentence: **"刷新的话，论文就直接关掉了，翻译也要重新打开了"**
(refresh closes the paper, and the translation has to be opened again).

## What exists — verify by reading, do not assume

**Backend routes that already exist** (`backend/app/api/documents.py`):

- `GET /api/documents` — `document_payload()` per row, ordered
  `ORDER BY created_at DESC` (`app/documents/store.py`). Fields: `document_id`,
  `name`, `page_count`, `source` (`"upload"` / `"path"`), `has_translation`,
  `created_at`.
- `GET /api/documents/{id}/file` — the original PDF bytes.
- `GET /api/documents/{id}/translated` — the translated artifact, already on disk.
- `GET /api/documents/{id}/ir`, `/sections`, `/page-mapping`, `/annotations`,
  `/overview`.

**Frontend** (`frontend/src/`): `app/App.tsx`, `app/AppShell.tsx`,
`translation/session.ts::openDocument` (the registration path and its teardowns),
`stores/workspace.ts` (`document` with its `sessionToken` and `registration`
state, `translation` with its `monoUrl`), `reader/ReaderWorkspace.tsx`,
`overview/session.ts`, `notes/session.ts`.

**Standing constraints that already exist and that your criteria must respect:**

- `docs/acceptance/DS-QA-015.md` AC-P0-15: **opening a paper must incur 0 provider
  calls**, verified against the backend ledger (`app/llm/accounting.py`, readable
  over `GET /api/_debug/provider-ledger` when `ENABLE_PROVIDER_LEDGER=1`).
  Reopening a cached overview is AC-P0-16 and is also 0 calls.
- Annotations and highlights are keyed to the **content hash** of the PDF, never
  to the document row (`DS-QA-010-FIX-001`) — a reopened row with the same bytes
  must find the same notes.
- The frontend never receives a credential: no API key, no Authorization header,
  no keyring secret (`docs/acceptance/DS-BE-005.md`).
- Local-first: no PDF writeback, no cloud sync, no external network.

## What your criteria must decide and freeze

You are the acceptance author; these are yours to decide, but each one must be
decided **explicitly** rather than left implicit:

1. **What "the last opened paper" means.** The newest row, or an identity the
   client persists? (There is no settings UI in this application — see below — so
   an opt-in switch is not available unless you require one.)
2. **What happens when a reader has already started doing something** — picking a
   file, dropping one on the workspace — while the restore is in flight. State the
   required outcome and how it is evidenced.
3. **Failure modes**, each with its required behaviour: the document row exists
   but its bytes are gone; the backend is not running; the stored artifact is
   corrupt; the restore itself is interrupted by a reload. What must the reader
   see, and what must they never see?
4. **How the translation comes back.** It is on disk; re-running the task is a
   product and cost regression. Say what must be true about provider calls here,
   and how that is measured.
5. **What must *not* be restored** — be explicit about the boundary (notes and
   overview come back because they are keyed by content; a chat history, a
   selection, a scroll position are separate questions you should either include
   with a stated requirement or exclude as a named non-goal).
6. **Whether the URL or history plays any part** — the application has no router
   today. If you require one, say so and say why it is worth it.

## Repository facts you must not get wrong

- **There is no settings screen.** The 设置 button in `frontend/src/app/TopBar.tsx`
  renders a tooltip and has no `onClick`; no acceptance document has ever required
  a configuration UI. Do not write criteria that assume one exists, and do not
  quietly require building one as part of this task.
- The application is a single page with no router; `App.tsx` mounts the shell, and
  a document is a `File` held in memory, obtained from the browser's file picker.
  A reload cannot re-open a local file without either the user's gesture or the
  backend's stored copy.
- Test layers available: `pytest` (`backend/tests/`), `vitest` + jsdom
  (`frontend/src/tests/`, 300 tests), and Chromium harnesses
  (`frontend/scripts/e2e-*.mjs`, each starting a real backend and a real production
  preview and writing `.agent/results/<name>/results.json`).
- Every criterion must name evidence that can actually be produced here, and must
  be capable of failing. A criterion whose evidence is "it feels right" is not a
  criterion.

## Explicitly out of scope for this task

Multi-tab synchronisation, conversation/QA history restore, cloud sync, PDF
writeback, and any change to the Paper QA retrieval contract. If you think one of
these must be included, say so and defend it — but the default is exclusion, and
each exclusion belongs in a non-goals section.

## Format

Follow `DS-DOC-003.md`: a short independent-author statement, the frozen
decisions table, the numbered criteria grouped P0 / P1 / P2, a verification
protocol, and non-goals. State the P0 count in the header. Do not pad the P0 set
to reach a number — a criterion that cannot fail is worse than one that is
missing.
