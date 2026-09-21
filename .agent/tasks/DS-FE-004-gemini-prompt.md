# DS-FE-004 — Acceptance Criteria authoring task (Gemini)

You are the independent Acceptance Criteria author for the Academic PDF Copilot
repository at `D:\marti\SciPrograms`. DeepSeek owns all production code. **You do
not write production code.** Your only deliverable is one document.

## Your deliverable

Write:

    D:\marti\SciPrograms\docs\acceptance\DS-FE-004.md

P0 MUST / P1 SHOULD / P2 OPTIONAL criteria, each numbered, each independently
verifiable, each stating its evidence. Follow the structure of
`docs/acceptance/DS-FE-003.md` and `docs/acceptance/DS-DOC-004.md` (both recent,
both written by you, both frozen).

## Time budget — read before you start

Hard 25-minute wall clock. **Do not run the test suites, the build, `pytest` or
any browser harness.** Read source, decide, write.

## The task

**DS-FE-004 · Provider Settings.** The application has no way, anywhere in its
interface, to see or change which model service it talks to. The 设置 button in
`frontend/src/app/TopBar.tsx` renders a tooltip and **has no `onClick`**: it is a
dead control that has been in the tab order since DS-FE-001 without ever opening
anything. The reader reported it in one sentence: *"设置部分点不开，是没有做自己配置
endpoint 地址和 api key 的界面吗?"* — and then asked the question this task must
answer with evidence: *"测试是否真的能写到配置文件中调整"* — does configuring
something here actually **persist and take effect**?

The backend for this already exists and is complete. What is missing is the
screen, its validation, and the proof that what it writes survives.

## Where a profile actually lives — read this before writing criteria

There is **no configuration file**, and that is deliberate. Do not write a
criterion that requires one, and do not let a criterion imply one.

- The profile (name, `base_url`, `model`, `protocol`, timeout, temperature,
  custom headers) is a **row in SQLite**, `<documents_dir>/../db.sqlite3`, table
  `profiles`. `docs/acceptance/DS-BE-005.md` owns that storage and its rules.
- The **API key is never stored in the database**. It goes to the **operating
  system credential store** through `keyring`, service
  `AcademicPDFCopilot.profiles` (`backend/app/security/`). DS-BE-005 requires
  zero secret leakage across database bytes, logs, `repr`, and error envelopes.
- A client therefore never receives a key-bearing field: `GET /api/profiles`
  returns `has_key: bool` and `api_key_masked` (e.g. `sk-••••••••ab12`) and
  nothing else.

So the honest form of the reader's question — *did it really save?* — is not a
file check. It is: **after the backend process is restarted and the page is
reloaded, the profile is still listed with the same fields, `has_key` still true,
and a request made with it still works.** Your criteria must say how that is
evidenced, and must say what must never be true (the raw key in the database, in
`localStorage`, in the DOM, in a log line, or in an error message).

## The backend surface that already exists — verify by reading

`backend/app/api/profiles.py`:

| Route | Purpose |
|---|---|
| `GET /api/profiles` | list, `ProfileResponse` |
| `POST /api/profiles` | create (201), `ProfileCreateRequest` |
| `GET /api/profiles/{id}` | one profile |
| `PATCH /api/profiles/{id}` | partial update, `ProfileUpdateRequest` |
| `DELETE /api/profiles/{id}` | delete (204) |
| `POST /api/profiles/{id}/test` | one probe, `ConnectionTestResponse{ok, protocol, model, latency_ms}` |
| `POST /api/profiles/{id}/detect-protocol` | which protocol the endpoint speaks |

Two rules in that module that the UI must not contradict:

- **`api_key` on PATCH has three intents**: *absent* (leave the stored key
  alone), `""` (clear it), a value (replace it). Explicit `null` is rejected
  because "leave it" and "clear it" are equally plausible readings and guessing
  wrong destroys a user's key. Your criteria must say what the screen does when
  the reader edits a profile **without touching the key field** — the answer is
  that the key survives.
- **A profile with no key is valid.** `has_key: false` is the local
  OpenAI-compatible server case, and DS-BE-007 had to fix a bug where the
  frontend refused it. The screen must not require a key.

## Repository facts you must not get wrong

- **Initial bundle headroom is 1.11 kB.** The frozen ceiling is 310.0 kB
  (`docs/acceptance/DS-QA-015.md` §0.1, AC_CHANGE_REQUEST 4) and the measured
  chunk is **308.89 kB**. Therefore the settings screen **must be behind a
  dynamic import** the way `translation/TranslateDialog.tsx` is (`lazy()` +
  `Suspense`, its bytes in their own chunk). A criterion must measure this: the
  initial chunk does not grow past the ceiling, and the dialog's code is not in
  it.
- **No new dependencies.** No form library, no schema validator, no toast
  library. The existing primitives are `components/ui/*` (button, separator,
  tooltip) and `lucide-react` icons.
- **The modal pattern already exists**: `TranslateDialog` is the precedent for
  a dialog in this shell — read it for focus handling, Escape, and the backdrop.
- **The session record must not grow a key.** `frontend/src/session/types.ts`
  stores reading state only, in `localStorage`. Nothing credential-shaped may
  ever be added to it.
- **A provider probe costs requests.** `POST /{id}/test` and
  `detect-protocol` make real calls to the endpoint (protocol detection probes
  first, then the probe itself). Whatever the screen offers must be an explicit
  reader action, and the criteria must not require any automatic call on mount,
  on dialog open, or on save.
- Test layers: `pytest` (`backend/tests/`), `vitest` + jsdom
  (`frontend/src/tests/`), and the Chromium harnesses
  (`frontend/scripts/e2e-*.mjs`), each of which starts a real backend and a real
  production preview and writes `.agent/results/<name>/results.json`. **Only the
  harness layer can restart the backend process**, so the durability criterion
  belongs there.

## What your criteria must decide explicitly

1. **The screen's shape**: a dialog from the 设置 button, a panel, or a page.
   Decide, and say why (the bundle constraint and the existing precedent both
   bear on this).
2. **Create, edit, delete, test** — which are P0 and which are not. Deleting the
   profile the application is currently using has a consequence: name it and
   require it, or exclude it explicitly.
3. **Validation**: which fields are required, what an invalid `base_url` means
   (the backend accepts a string; a reader typing `httpx://` must learn
   something), and what the screen shows for a failed save.
4. **What the reader sees about a stored key**: the mask, and what happens when
   they type a new one — including how they can tell "the key I saved yesterday
   is still there" from "there is no key".
5. **Failure and partial states**: the credential store unavailable (DS-BE-005
   has an error for that), a duplicate profile name, an endpoint that does not
   answer the probe.
6. **Accessibility and dismissal**: the button is already a keyboard stop;
   Escape, backdrop, focus return, and the fact that the dialog is not mounted
   until it is opened.

## Out of scope — state these as non-goals

Cloud accounts and sync; a model catalogue or pricing data; per-document or
per-task provider overrides; editing the application's own configuration
(`DATABASE_PATH`, `DOCUMENTS_DIR`, ports — environment, not reader settings); any
plain-text file holding a secret; multi-user anything.

## Format

Follow `DS-FE-003.md`: an independent-author statement, a decisions table, the
numbered criteria grouped P0 / P1 / P2, a verification protocol, non-goals, and
the P0 count in the header. A criterion that cannot fail is worse than one that
is missing — do not pad the set.
