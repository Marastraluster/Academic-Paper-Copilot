# Development

This document is for someone about to change the code. It describes the order work happens in,
which layer can see what, the exact commands, and the rules that catch the mistakes this
repository has already made once.

Three rules, in the order they apply:

1. **The order of work.** A written, falsifiable statement of what "done" means exists before the
   implementation does.
2. **The evidence rule.** Every number in a document traces to a named command. If something was
   not measured, the document says so.
3. **The dependency rule.** A measurement before a dependency.

Every command and count in this file was run at revision `cb6a5c1` (2026-10-11) unless it says
otherwise.

## 1. The order of work: criteria before code

A non-trivial change starts with an acceptance document, written and frozen **before** the
implementation, in `docs/acceptance/`. It states numbered criteria, each naming the evidence it
requires — the test, the route, the build output, the ledger snapshot — so that "done" is a claim
someone else can check rather than an assertion the author makes about their own work. The
criteria are falsifiable on purpose: a criterion that cannot fail is not a criterion.

`docs/acceptance/` holds 43 files. `docs/acceptance/DS-DOC-004.md` is the readable example: it
opens with the defect in the reporter's own words, records the verified starting state as a table
of routes and files with line numbers, then states its criteria.

When a criterion turns out to be wrong once the repository is actually in front of you, it is
amended **in the open**: the old wording, the new wording, and the reason, all three. It is never
silently reinterpreted. Two examples are worth reading in full, because they are the two ways
this goes wrong:

- `docs/acceptance/DS-QA-015.md:21-103` records three round-one change requests. The first is a
  pair of decisions that contradict each other; the third is a criterion that counted a thing
  ("meta-claims") no test could define, so a fixed vocabulary was named instead. The frozen text
  stays visible and the amendment sits beside it.
- `docs/acceptance/DS-QA-015.md:107-224` records a fourth change request raised **after**
  implementation, against the measured bundle. It proposes an amendment without applying it, and
  the disposition beside it accepts the amendment on the recorded decomposition. The document
  still carries AC-P0-52's frozen 300.0 kB and reports it FAIL at 304.54 kB rather than quietly
  rewriting the number.

The habit that makes this work is boring: write down the number before you attempt the thing, and
if the attempt disagrees with the number, record the disagreement.

## 2. When an ADR is required

An Architecture Decision Record is required when a choice constrains future work and would be
expensive to reverse: adopting a dependency, accepting a licence obligation, adding a second way
to do something the repository already does one way. `docs/decisions/` holds three, and their
statuses are not the same thing:

| File | Status (as written in the file) |
|---|---|
| `docs/decisions/ADR-001-pdfmathTranslate-integration.md` | Accepted |
| `docs/decisions/ADR-002-license-AGPL.md` | Decided — local / personal use only |
| `docs/decisions/ADR-003-extraction-backend.md` | Proposed — the maintainer chose an *optional* extraction backend on 2026-09-27; this ADR fixes the rules that choice implies and is awaiting signature on them |

**A status describes the decision, not the code.** A Proposed ADR records a choice that has *not*
been implemented, and it is not a description of shipped behaviour. Reading ADR-003 as prose about
the application would mislead you in the specific way the option exists to prevent: the feature it
discusses is optional and never the default, and the rules the ADR would freeze are not in force
until it is signed. Likewise an Accepted ADR is a decision that was made — whether the code
matches it is a separate question that reading the code answers. This document asserts no ADR
matches the implementation, because that was not verified.

## 3. The test layers, and what each can see

Four layers, each blind to something the next one can see. Reach for the lowest layer that can
actually observe your change.

### Backend — pytest, offline by construction

`backend/tests/` holds 45 Python test files. The suite is offline because it is *forced* to be,
not because the authors were careful: `backend/tests/conftest.py:77-91` is an `autouse` fixture
(`block_external_network`) that replaces `socket.socket.connect` and raises `AssertionError` for
any host outside `ALLOWED_HOSTS = {"127.0.0.1", "::1", "localhost", ""}`
(`backend/tests/conftest.py:30`) with the message *"Test attempted an external network connection
to … The test suite must run entirely offline."* A test that tries to reach a provider fails
rather than passing slowly.

Two more autouse fixtures isolate the developer's machine: every test gets a `Settings` pointed at
`tmp_path`, and every test gets an in-memory fake keyring
(`backend/tests/conftest.py:62-74`), so no test writes to your real database or your real OS
credential store.

What this layer cannot see: layout, and anything a browser does.

### Frontend — vitest and tsc

`frontend/src/` holds 28 test files, run by vitest under jsdom. `npm run typecheck` is `tsc -b`
and is part of the build (`npm run build` runs it before vite), so a type error fails the build
rather than the review.

What this layer cannot see: a real drag, a real PDF text layer, the built bundle, or the backend.

### Browser harnesses — Playwright, against the built application

`frontend/scripts/` holds 21 committed `.mjs` files, run directly by node. They launch Edge
through Playwright, start the backend, and drive the **built** application — so they are the only
layer that sees what ships. They need `npm run build` first; each file's header comment states its
own usage, and the flags differ.

They keep their hands off your library by pointing the backend at a scratch directory:
`DATABASE_PATH` and `DOCUMENTS_DIR` are set to paths under `.agent/results/<harness>/`, which is
the whole of the mechanism — no harness writes to `%LOCALAPPDATA%`. Several of them additionally
*copy* your database (and, in some cases, a document's already-translated `mono.pdf`) into that
scratch directory, because they need a provider profile or a translation to exist and verifying a
restore must not require paying for a translation. One harness, `e2e-provider-settings.mjs`, will
write a throwaway credential to your real OS store, and only when you set
`E2E_ALLOW_CREDENTIAL_WRITE=1`; it deletes what it made and says whether the deletion worked. The
default run creates a keyless profile and touches no secret.

What this layer cannot see: the ledger directly. A page cannot observe a model call — it talks to
localhost and localhost talks to the provider — so the provider-call claims are read back from the
backend's `CountingProvider` ledger through a route that exists for the harnesses.

### Acceptance evidence documents

The record itself: `docs/acceptance/*.md` carries the criteria and the measured results, with the
command that produced each number. These are documents, not an executable layer; their value is
that they were written before the code and amended in the open.

## 4. The exact commands

Run each from the stated directory. Do not run the backend and the frontend suites at the same
time.

### Backend

```powershell
cd backend
.\.venv\Scripts\python.exe -m pytest                      # macOS/Linux: .venv/bin/python
.\.venv\Scripts\python.exe -m pytest --tb=short -p no:warnings
```

Run from `backend/`, not from the repository root: `backend/pyproject.toml:56-60` sets
`pythonpath = ["."]` and `testpaths = ["tests"]`, so `import app` resolves only there.

**The `-q` caveat.** `backend/pyproject.toml:60` already sets `addopts = "-q"`. Adding another
`-q` on the command line gives `-qq`, which suppresses the final `N passed` summary line — you
lose the count, which is the one thing the run exists to tell you. Use `--tb=short -p no:warnings`
when you want the short traceback, not a second `-q`.

Measured at `cb6a5c1` (2026-10-11), exit code 0:

```
1276 passed in 233.93s (0:03:53)
```

### Frontend

```powershell
cd frontend
npm run typecheck                 # tsc -b
npx vitest run                    # the whole suite, ~15 s
npm run build                     # tsc -b && vite build
```

Measured at `cb6a5c1` (2026-10-11), all exit code 0:

```
Test Files  28 passed (28)
     Tests  424 passed (424)
dist/assets/index-CQGL8Wq2.js   313.89 kB │ gzip: 103.59 kB
```

### Browser harnesses

```powershell
cd frontend
npm run build                     # every harness needs the built bundle first
node scripts/e2e-overview.mjs [paper.pdf] [--generate]
```

The 12 `e2e-` harnesses, the screenshot tool `capture-readme.mjs`, and `capture.mjs`, each
requiring `npm run build` first:

| Harness | Measured flags and environment |
|---|---|
| `capture.mjs` | `PREVIEW_URL` (default `http://127.0.0.1:4173`), `CAPTURE_PDF`; runs against `npm run preview` |
| `capture-readme.mjs` | `PREVIEW_URL` (default `http://127.0.0.1:5173`), `API_URL`, `CAPTURE_SOURCE` (default `resnet.pdf`), `KEEP_SCRATCH=1`; registers its own copy of a library paper through the UI, writes `docs/screenshots/*.png`, and deletes the copy again |
| `e2e-crosspage.mjs` | `E2E_PAPER`, `E2E_LABEL`, `E2E_BOUNDARY` (default `1`) |
| `e2e-document-library.mjs` | none |
| `e2e-nonprose.mjs` | `[paper.pdf]`, `E2E_PAPER`, `E2E_LABEL` |
| `e2e-notes.mjs` | `E2E_PAPER`, `E2E_LABEL` |
| `e2e-notes-search.mjs` | `E2E_SCALE` (default `500`) |
| `e2e-outline.mjs` | `E2E_PAPER`, `E2E_LABEL`, `E2E_ROTATED=1` |
| `e2e-overview.mjs` | `[paper.pdf]`, `--generate` (spends one real call), `E2E_BACKEND_PORT` |
| `e2e-provider-settings.mjs` | `E2E_ALLOW_CREDENTIAL_WRITE=1` |
| `e2e-qa.mjs` | `E2E_BACKEND_PORT`, `E2E_PAPER`; needs a configured provider profile |
| `e2e-reflow-bilingual.mjs` | none; its header comment prints the wrong filename (`e2e-bilingual-reading.mjs`) |
| `e2e-session-continuity.mjs` | reads `LOCALAPPDATA` to find the real data directory it copies |
| `e2e-translation.mjs` | `E2E_BACKEND_PORT`, `E2E_CHANNEL` (default `msedge`); needs `backend/.venv` with `pdf2zh` installed |

The thirteenth `e2e-` file, `e2e-selection.mjs`, is **not** a harness: it exports
`runSelectionChecks(page, { backendUrl, check, ask, ir })` and has no driver of its own, so
`node scripts/e2e-selection.mjs` exits 0 having done nothing. `e2e-qa.mjs` drives it.

The five `probe-` scripts measure rather than assert, and two of them exist only to answer a
question a criterion depended on: `probe-crosspage.mjs`, `probe-nonprose.mjs`,
`probe-overlap.mjs`, `probe-rotation.mjs` and `probe-selection.mjs`. They print numbers; they do
not exit non-zero on a finding.

Two generators produce fixture PDFs: `make-fixture-pdf.mjs` (multi-page, deliberately mixed page
geometry) and `make-crosspage-pdf.mjs <output.pdf> [pages]` (prose reaching both page edges, every
line prefixed `L<page>-<nn>` so a harness can name the source lines a drag crossed).

### Do not run the backend and frontend suites concurrently

Running them at once produced 13 failures — `test_llm_responses`, `test_llm_detection`, `test_db`,
`test_isolation`, `test_pdfkernel`, `test_context_analysis`, `test_context_translation`,
`test_qa_retrieval`, `test_qa_answer` and `test_qa_expansion` — none of which reproduced when the
same tests were run alone. They were resource contention, not regressions. A failure that
disappears on a quiet machine is not a regression, and treating it as one costs a day.

## 5. The evidence rule

Every number in a document traces to a named command. "Fast", "small" and "works" are not
reviewable; `1276 passed in 233.93s` is. State the revision the number was measured on, because a
number without a revision is a rumour. When something was not measured, the document says it was
not measured — the README's Testing section states the rule in the same words.

The rest of the counts in this file are one command, against the committed tree:

```powershell
git ls-tree -r --name-only cb6a5c1 docs/ | Where-Object { $_ -like '*.md' }   # 52
git ls-tree --name-only cb6a5c1 frontend/scripts/ | Where-Object { $_ -like '*.mjs' }   # 21
```

At `cb6a5c1`: `docs/acceptance/` holds 43 files, `docs/decisions/` holds 3, `docs/` holds 52
`.md` files, `frontend/scripts/` holds 21 committed `.mjs` files, `backend/tests/` holds 45
`.py` files, `frontend/src/` holds 28 test files, and `docs/screenshots/` holds 4 PNGs. Counted from
the working tree rather than the committed tree they can disagree, because a harness or a document
being written right now is untracked — and here they do: the tree carries 22 `.mjs` files and 8
screenshots, the eight the README displays.

## 6. The dependency rule: a measurement before a dependency

A new package needs a reason that survives review: what it replaces, what it costs in the initial
bundle, and why the platform cannot do it. The bundle ceiling is recorded in
`docs/acceptance/DS-QA-015.md`, in a section that is a *proposal* as much as a record:

- AC-P0-52 was frozen at **≤ 300.0 kB** minified for the initial `index-*.js` chunk.
- `docs/acceptance/DS-QA-015.md:199` proposes amending it to **≤ 310.0 kB**, and
  `docs/acceptance/DS-QA-015.md:212` records the disposition accepting that amendment. The
  criterion text itself keeps the unamended 300.0 kB, and its own §6.1 states it that way.

So the ceiling to measure against is 310.0 kB, and **the build measured at `cb6a5c1` is already
above it**: `index-CQGL8Wq2.js` is 313.89 kB. There is no headroom to spend on a dependency today,
and that is a fact about this revision rather than a judgement of the proposal — the proposal's
5.46 kB of headroom has been consumed since it was written. Adding a package means recovering the
difference first.

The other headroom number in that document, the 350.0 kB total ceiling, is the one AC-P0-52 was
written to regain headroom under; this file does not restate the current total, because it was
not measured here.

## 7. Where things live

| Path | What is in it |
|---|---|
| `backend/app/` | the service: FastAPI routes, extraction, translation kernel adapter, LLM providers and the accounting ledger |
| `backend/tests/` | 45 pytest files, offline by construction |
| `frontend/src/` | the React application; 28 test files sit beside the code they test |
| `frontend/scripts/` | 22 `.mjs` Playwright harnesses, probes, fixture generators and the README screenshot tool |
| `docs/acceptance/` | 43 acceptance documents — criteria written before implementation, with their measured results |
| `docs/decisions/` | 3 ADRs, with the statuses listed in §2 |
| `docs/screenshots/` | 8 PNGs, the ones the README displays, produced by `frontend/scripts/capture-readme.mjs` (not by `capture.mjs`) |
| `docs/` (top level) | `ARCHITECTURE.md`, `API_CONTRACT.md`, `TEST_PLAN.md`, `ROADMAP.md`, `REPO_AUDIT.md`, and `context/` |
| `%LOCALAPPDATA%\AcademicPDFCopilot\` | the runtime data directory: `db.sqlite3` and `documents/` (one directory per document, plus the content-addressed `_cache/`) — created by `backend/app/config.py:32-38`, which falls back to `~/.local/share/AcademicPDFCopilot` off Windows |

The harnesses' scratch output goes to `.agent/results/<harness>/`, and screenshots a harness takes
go to `.agent/screenshots/` — which is not the same directory as `docs/screenshots/`.
