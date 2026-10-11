# Contributing

Thanks for looking. This project has a small number of rules, and they are not decoration —
they are what the codebase's reliability rests on.

## The two house rules

**1. Acceptance criteria before implementation.** Every non-trivial change starts with a
written, falsifiable statement of what "done" means: numbered criteria, each naming the
evidence it requires, frozen before the code is written. `docs/acceptance/` is the record;
`docs/acceptance/DS-DOC-004.md` is a good one to read first. If a criterion turns out to be
wrong once the repository is in front of you, it is amended **in the open**, with the old
wording, the new wording and the reason — never silently reinterpreted.

**2. Report measurements, not adjectives.** "Fast", "small" and "works" are not reviewable.
Provider calls come from the backend ledger; bundle size from the production build; cache
behaviour from files on disk; selection behaviour from a real Chromium drag. If something was
not measured, say it was not measured.

## Before you open a pull request

```bash
# Backend: 1276 tests, offline by construction (measured on cb6a5c1: 233.93 s)
cd backend && .venv/Scripts/python -m pytest          # .venv/bin/python on macOS/Linux
# The summary line is already suppressed by addopts = "-q" in backend/pyproject.toml.
# Adding another -q makes it -qq and swallows the "N passed" line entirely.

# Frontend: types, 424 tests in 28 files, production build
cd frontend && npm run typecheck && npx vitest run && npm run build
```

One rule about running them: **never both at once.** Running both suites at once produced 13
failures — `test_llm_responses`, `test_llm_detection`, `test_db`, `test_isolation`,
`test_pdfkernel`, `test_context_analysis`, `test_context_translation`, `test_qa_retrieval`,
`test_qa_answer` and `test_qa_expansion` — none of which reproduced when the same tests were run
alone. They were resource contention; a failure that disappears on a quiet machine is not a
regression, and treating it as one costs a day.

`docs/development.md` documents each layer, the exact commands, and what each layer can see.

If you touched the reader, the sidebar, the store, the session or the library, run the browser
harnesses too — they are the only layer that sees the built application. Every harness lives in
`frontend/scripts/`, they all need `npm run build` first, and each one documents its own flags in
its header comment:

```bash
cd frontend && node scripts/e2e-overview.mjs       # add --generate to spend one real call
node scripts/e2e-session-continuity.mjs
node scripts/e2e-document-library.mjs
```

Those three are the ones most changes need. The other eighteen `.mjs` files committed under
`frontend/scripts/` — six more `e2e-` harnesses, the five `probe-` measurement scripts, the two
fixture generators and `capture.mjs` — are listed with their flags and environment variables in
[docs/development.md](docs/development.md).

They point the backend at a scratch directory (`DATABASE_PATH` and `DOCUMENTS_DIR`), so a run
never touches your library or your database.

## Non-negotiables

- **Loopback only.** The backend binds `127.0.0.1` and refuses a non-loopback host. No feature
  may expose the service to a network.
- **No secrets outside the credential store.** API keys go to the operating system's keyring
  and nowhere else — not SQLite, not `localStorage`, not a log line, not an error envelope,
  not a screenshot. The client is only ever told *whether* a key is set, plus a mask.
- **No telemetry, no external CDNs, no analytics.** The application ships no analytics, no CDN
  and no cloud sync. Three things can leave this machine, and never by themselves: the model
  calls you press a button for; a paper you hand to a MinerU parser, if you configure one (a local
  one keeps it on your machine); and the DOI or title of the paper you are reading, plus any
  search terms you type, if you switch related-paper search on. The browser talks to a loopback
  backend, the backend talks to the endpoints you configured — and the README states this the same
  way, so the two files must keep agreeing.
- **A measurement before a dependency.** A new package needs a reason that survives review:
  what it replaces, what it costs in the initial bundle (the ceiling and the current
  measurement are in `docs/acceptance/DS-QA-015.md`), and why the platform cannot do it.
- **No automatic provider calls.** Opening a paper, switching tabs, restoring a session,
  listing the library and reading a cached artifact are all measured to cost zero. Spending
  the reader's quota is a button press, and the button says so before it is pressed.

## Style

Match the file you are editing — comment density, naming, and idiom. Comments in this
repository explain *why*, usually by naming the alternative that was rejected and what went
wrong when it was tried. A comment that restates the code is noise; a comment that records a
decision is the reason the next person does not undo it.

Python targets 3.12 and is typed. TypeScript is strict, and `npm run typecheck` is part of the
build.

## Reporting a bug

A useful report says what you did, what happened, and what you expected — and, where you can,
the numbers: the page, the provider and model, whether the paper had a translation, and what
the browser console said. If the application did something *expensive* unexpectedly, say so
first: that is the defect class this project cares about most.
