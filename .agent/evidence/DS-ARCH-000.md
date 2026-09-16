# Evidence — DS-ARCH-000 (Phase 0: Repository Audit)

Date: 2026-09-15
Agent: DeepSeek (Claude Code CLI)
Tasks: Phase 0 Steps 1-4 (health check, agent confirmation, repo audit)

## Modified Files

| File | Change |
|---|---|
| `docs/REPO_AUDIT.md` | New — Phase 0 audit, 21 sections |
| `.gitignore` | New — secrets, `_reference/`, runtime artifacts, agent scratch |
| `.agent/evidence/DS-ARCH-000.md` | New — this file |
| `git init` | Repository initialised (was not one) |
| `_reference/PDFMathTranslate/` | Cloned upstream (gitignored, not vendored) |

No production code written in this task (correct for Phase 0).

## Step 1 — CLI Health Check

| Command | Result |
|---|---|
| `claude --version` | `2.1.218 (Claude Code)` |
| `agy --version` | `1.2.3` at `/c/Users/marti/AppData/Local/agy/bin/agy` |
| `agy models` | `gemini-3.8-flash-high` / `-medium` / `-low` all present |
| `git status` | **fatal: not a git repository** → `git init` performed |
| `git --version` | `2.55.0.windows.3` |
| `python --version` | `3.14.6` ← **outside pdf2zh's supported range** |
| `node --version` | `v24.18.0` |
| `npm --version` | `11.16.0` |
| `uv --version` | `0.11.32` |
| `cargo --version` | **not found** ← Tauri cannot build on this machine today |

Working directory `D:\marti\SciPrograms` was **empty** on entry. No pre-existing code,
no git history, no inherited decisions.

## Step 2 — Agent Smoke Tests

| Harness | Command | Expected | Actual | Verdict |
|---|---|---|---|---|
| DeepSeek (Claude Code) | `claude -p "Return exactly CODE_AGENT_OK"` | `CODE_AGENT_OK` | `CODE_AGENT_OK` | PASS |
| Gemini (Antigravity) | `agy -p "Return exactly ACCEPTANCE_AGENT_OK"` | `ACCEPTANCE_AGENT_OK` | `ACCEPTANCE_AGENT_OK` | PASS |

Both agents are reachable. No silent fallback was used.

## Step 3 — Environment Resolution

The default interpreter (3.14.6) cannot run pdf2zh (`requires-python >=3.11,<3.13`).
Resolved by pinning to the uv-provided **CPython 3.12.13**:

```
$ uv venv --python 3.12 backend/.venv     → Using CPython 3.12.13
$ uv pip install -e _reference/PDFMathTranslate   → exit 0
```

**Verified by execution:**

```
$ backend/.venv/Scripts/python.exe -c "import pdf2zh; print(pdf2zh.__version__)"
not in git repo            ← benign; emitted by pdf2zh/__init__.py during import
pdf2zh version: 1.9.12
OK: all core imports succeed
```

`high_level.translate`, `translate_stream`, `BaseTranslator`, `OpenAITranslator`,
`OpenAIlikedTranslator`, and `TranslateConverter` all import successfully.

## Step 3b — Package Availability Finding

| Source | Version |
|---|---|
| GitHub `main` (cloned) | **1.9.12** |
| PyPI latest | **1.9.11** |

`pdf2zh==1.9.12` does **not** exist on PyPI — the first install attempt failed with
*"no version of pdf2zh==1.9.12"* (`uv` reported this but exited 0; the non-zero signal was
absent, so the failure was confirmed by a follow-up import check rather than by exit code).

Consequence: the audited code is **not** the published package, which is a direct input to
the fork-vs-dependency decision (REPO_AUDIT §8).

## Step 3c — Subsystem Deep Dive (delegated read-only audit)

A read-only subagent audited `kernel/`, `ocr.py`, `backend.py`, `doclayout.py` and their call
sites. Findings folded into `docs/REPO_AUDIT.md` §22. Material results:

| Finding | Impact |
|---|---|
| `KernelProtocol` exists (`protocol.py:41-65`) with `callback` + `cancellation_event` | **Good news** — page-level progress and cooperative cancellation are already plumbed end-to-end for the fast kernel. My initial read (that neither existed) was wrong and has been corrected. |
| `callback` is typed `Any`; kernels pass **incompatible** shapes (tqdm vs dict) | Upstream bug: `gui.py:325` does `t.n / t.total` and is handed to both kernels → `AttributeError` under `--mode precise`. Our adapter must define its own event type. |
| `precise` accepts `cancellation_event` and **never reads it**; `translate_async` discards progress via `communicate()` | precise is not merely unavailable, it is **unsuitable** → strengthens the MVP `fast`-only decision |
| Layout model is **babeldoc-owned**, ~**71.9 MiB**, lazy-downloaded from HuggingFace, SHA3-256 verified, absent from the repo | First run needs an explicit, visible "preparing" step, not a silent stall |
| `ocr.py:115` `@retry(wait=wait_fixed(1))` has **no stop condition** | Unbounded retry = indistinguishable from a hang. Must be bounded in our layer. |
| `backend.py` is Flask+Celery+Redis, imports `translate_stream` directly, bypasses the kernel layer entirely | Not a foundation to build on; we build our own FastAPI layer as planned |

## Step 4 — Blocked Action → RESOLVED

Running the upstream test suite was **denied by the permission classifier**:

```
$ cd _reference/PDFMathTranslate && python -m pytest test/
→ Permission denied: executing code from a repo cloned this session from an external source
```

This is a reasonable guardrail and was **not** worked around. Impact assessment:

- **Phase 0 (audit): no impact.** All audit findings come from reading source, and the
  install/import verification above was permitted and succeeded.
- **Phase 5+ (kernel integration): blocking.** We will need to execute this library to
  translate a PDF.

**User decision (2026-09-15): permission granted for the pinned clone.** The user elected to
allow execution against `_reference/PDFMathTranslate`. Phase 5 is therefore unblocked, and we
retain the audited 1.9.12 source rather than falling back to PyPI 1.9.11.

Tests were inspected read-only. Reusable patterns found:

- `test/test_translator.py:16-23` — `AutoIncreaseTranslator`, a minimal `BaseTranslator`
  double that returns an incrementing counter. Ideal for cache assertions.
- `test/test_translator.py:26-30` — `cache.init_test_db()` / `cache.clean_test_db()`
  provide an isolated SQLite cache DB, so our tests need not touch the user's real
  `~/.cache/pdf2zh/cache.v1.db`.
- `test/test_translator.py:96` — `ConfigManager.clear()` is required in `setUp` because
  translator construction mutates global config. This is direct evidence for the
  global-state hazard recorded in REPO_AUDIT §11.

## Acceptance Criteria Evaluation

No Gemini acceptance criteria exist for DS-ARCH-000 — this task is Phase 0 reconnaissance,
and the brief does not route it through the AC workflow (brief §101 Steps 1-5 precede the
first AC'd task, DS-FE-001). Recorded as NOT_APPLICABLE with reason.

| Criterion | Verdict | Note |
|---|---|---|
| — | NOT_APPLICABLE | Phase 0 is audit-only; AC workflow begins at DS-FE-001 per brief §101 Step 7 |

Self-imposed exit criteria for Phase 0:

| Criterion | Verdict |
|---|---|
| All 20 mandated questions answered from real source | PASS — REPO_AUDIT §21 index |
| No finding derived from README prose alone | PASS |
| Both agent harnesses verified live | PASS |
| Environment blocker identified and resolved | PASS — 3.14 → 3.12.13 |
| Repository left runnable | PASS — venv installs and imports |

## Known Limitations

1. Upstream tests were **not executed** (see Step 4). No regression baseline from upstream
   exists yet. This is an open liability for Phase 5.
2. The kernel/IPC subsystem (`v2_bridge`, `v2_worker`, `precise`) was audited by a
   delegated read-only pass and cross-checked against `pyproject.toml` and `.gitmodules`;
   the precise-kernel path could not be exercised because its submodule is uninitialised.
3. Audit reflects commit `c0fa967` only. Upstream moves fast; the pin must be revisited
   deliberately.
4. Report and evidence were not independently verified by Gemini — Phase 0 is not an
   AC-gated task.
