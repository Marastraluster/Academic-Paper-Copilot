# DS-DOC-005 — Acceptance Criteria authoring task (Gemini)

You are the independent Acceptance Criteria author for the Academic PDF Copilot
repository at `D:\marti\SciPrograms`. DeepSeek owns all production code. **You do
not write production code.** Your only deliverable is one document.

## Your deliverable

Write:

    D:\marti\SciPrograms\docs\acceptance\DS-DOC-005.md

P0 MUST / P1 SHOULD / P2 OPTIONAL criteria, each numbered, each independently
verifiable, each stating its evidence. Follow `docs/acceptance/DS-DOC-004.md` and
`docs/acceptance/DS-FE-004.md` — the two most recent, both written by you, both
frozen, both covering pieces of the machinery this task must reuse.

## Time budget — read before you start

Hard 25-minute wall clock. **Do not run the test suites, the build, `pytest` or
any browser harness.** Read source, decide, write.

## The task

**DS-DOC-005 · Document Library and Translation Record.** Two capabilities the
reader asked for in one sentence, and they are two halves of the same screen:

> *"就是目前网上有一个很流行的插件是沉浸式翻译这个插件那种效果"* — what they want
> eventually is paragraph-level bilingual reading. **That is explicitly out of
> scope here** (it needs a second translation pass; it has its own task).
> *"还有就是这样的话，还有一个翻译记录和换论文的方法?"* — and at the same time,
> a way to **switch papers** and a **record of what has been translated**.

So this task is: **a library of the papers this application has registered, and
what is known about each of them.**

Today the reader can only open a paper by handing over a file again. The
frontend has **never called `GET /api/documents`** — verified: no `listDocuments`
exists in `frontend/src/`. The application remembers exactly one paper, the one
DS-DOC-004 restored, and nothing else.

## What already exists — verify by reading, do not assume

**Backend** (`backend/app/api/documents.py`, `app/documents/store.py`):

| Route | Gives |
|---|---|
| `GET /api/documents` | every row, `created_at DESC`: `document_id`, `name`, `page_count`, `source` (`upload`/`path`), `has_translation`, `created_at` |
| `GET /api/documents/{id}` | one row, same shape |
| `GET /api/documents/{id}/file` | the original PDF bytes |
| `GET /api/documents/{id}/translated` | the translated PDF (mono) |
| `GET /api/documents/{id}/bilingual` | the interleaved 2N-page PDF |
| `GET /api/documents/{id}/ir`, `/sections`, `/page-mapping`, `/annotations`, `/overview` | everything downstream of the bytes |
| `DELETE /api/documents/{id}` | 204; removes the row and its derived artifacts |

**SQLite** (`backend/app/db.py`): `documents`; `translation_tasks`
(`document_id`, `profile_id`, `status`, `lang_in`, `lang_out`, `engine`,
`progress_page`, `error_code`, `created_at`, `updated_at`, **cascade on document
delete**); `annotations` + `annotation_targets` (keyed by **content hash**, no
foreign key to `documents`).

**Frontend**: `translation/session.ts::openDocument` (the picker path — it always
mints a new row), and `session/restore.ts`, which DS-DOC-004 wrote and which
already does the hard part: **adopt an existing row, fetch its bytes, fetch its
translation, fire the five loads, restore page and panel.** A library that opens
a chosen row is that same path with the row chosen by a click instead of by
`localStorage`. Reusing it is a requirement, not a suggestion — a second loader
would drift from the first.

## Facts and constraints the criteria must respect

- **Opening a paper costs 0 provider calls** (DS-QA-015 AC-P0-15/16, DS-DOC-004
  AC-P0-06, ledger-measured). A library must not change that: listing and opening
  are reads.
- **Opening bytes that are already registered must not mint a new row**
  (DS-DOC-004 AC-P0-19). DS-QA-015 AC-P0-02 pins the opposite for the *picker*
  path — a file handed over again is a new registration — and both stay true.
- **Notes, highlights and the reader overview are keyed to the PDF's content
  hash, not to a row** (DS-QA-010-FIX-001, DS-QA-015 Decision R). So a paper that
  is deleted and re-imported gets its notes and its cached overview back for
  free (DS-QA-015 AC-P0-54). A library must not present a row as "owning" notes,
  and deleting a row must not be described as deleting them.
- **The initial bundle has 40 bytes of headroom** under the frozen 310.0 kB
  ceiling, measured at 309.96 kB. Any new panel or dialog **must** be a dynamic
  import, and a criterion must measure it.
- **No router, no URL mutation** (DS-DOC-004 AC-P0-18; DS-FE-004 §0.5 records the
  rest of that clause). Navigation between papers is application state.
- **The session record in `localStorage` holds reading state only** — documentId,
  name, page, mode, panel. Nothing credential-shaped, and nothing new without a
  reason.
- **No new dependencies**; the UI primitives are `components/ui/*` plus
  `lucide-react`.
- A document imported by **path** (`source: "path"`) may have lost its file.
  DS-DOC-004 already defines that failure (empty workspace + a notice, session
  cleared); a library row pointing at a paper whose bytes are gone has the same
  problem and needs its own answer.

## What your criteria must decide explicitly

1. **Where the library lives**: a fifth sidebar tab, a dialog from the top bar
   (the pattern `TranslateDialog` and `SettingsDialog` established), or the
   overview panel's empty state. Decide, and justify it against the 40 bytes and
   the fixed-width sidebar (`SIDEBAR_WIDTH_PX = 340`, and a fourth column is a
   standing non-goal).
2. **What a row shows**: name, page count, when it was registered, what it has
   (translation? overview? notes? a chosen language pair?), and how the reader
   knows which one is open right now.
3. **What "打开" does** — including for a row whose bytes are missing, and
   including while another paper is open with unsaved… (there is no unsaved
   state; say so or say what there is).
4. **The translation record**: which of these are P0 and which are not —
   *this paper has a translation*, *translated on date X*, *between language A
   and B*, *with engine E*, *with model M*, *cost N tokens*, *took T seconds*.
   The first four come from tables that exist. **Model is derivable only through
   the profile row**, which may have been deleted or edited since; **tokens and
   latency are not persisted at all** — the provider ledger lives in the process
   (`app/llm/accounting.py`) and is reset on restart. If you require them, say
   what has to be persisted and where, and accept that it is a schema change
   (`schema_version` is at 5); if you do not, say that explicitly so the absence
   is a decision rather than an oversight.
5. **Deletion from the library**, and what the reader is told it does and does
   not remove (the row and its artifacts, versus notes and the overview cache,
   which are keyed to the bytes).
6. **What happens to the reading session** (DS-DOC-004) when the library opens a
   different paper, and what the session records afterwards.
7. **Scale**: how many rows the screen must stay usable with, and what it does
   beyond that (there is no pagination on the route today).

## Out of scope — state as non-goals

Paragraph-level or sentence-level bilingual reading (the reader's eventual wish,
deferred); the immersive/对照 view; any second translation pass; cloud sync,
accounts, or a shared library; a router; PDF writeback; conversation history;
and anything credential-shaped in the list or in `localStorage`.

## Format

Follow `DS-DOC-004.md`: an independent-author statement, a decisions table, the
numbered criteria grouped P0 / P1 / P2, a verification protocol, non-goals, and
the P0 count in the header. A criterion that cannot fail is worse than one that
is missing.
