# ROADMAP.md — Academic PDF Copilot

- **Status:** Phase 2 starting
- **Updated:** 2026-09-15
- **Planning policy:** Rolling Wave (brief §85) — current phase detailed, later phases outlined.
- **Phase order:** per brief §81. Updated from the earlier ordering, which placed the PDF
  adapter before the provider layer.

## Phase status

| Phase | Name | Status |
|---|---|---|
| 0 | Repository Audit | ✅ **Complete** — `docs/REPO_AUDIT.md` |
| 1 | Architecture Review | ✅ **Complete** — `ARCHITECTURE.md`, `API_CONTRACT.md`, `TEST_PLAN.md`, ADR-001/002 |
| — | Frontend shell (DS-FE-001) | ✅ **Complete** — 38/38 AC PASS, 27/27 tests green |
| 2 | **LLM Provider** | 🔄 **Current** |
| 3 | PDFMathTranslate Adapter | ⏳ |
| 4 | PDF Reader | ⏳ |
| 5 | Document Intelligence | ⏳ |
| 6 | Academic Context Translation | ⏳ |
| 7 | Translation Task System | ⏳ |
| 8 | AI Paper Assistant | ⏳ |
| 9 | UI Polish | ⏳ |
| 10 | Desktop Packaging | ⏳ **gated on ADR-002 + Rust toolchain** |

DS-FE-001 delivered the application shell ahead of Phase 4 so that every later feature has a
place to land. It is not redone.

## Settled constraints (do not re-litigate per phase)

1. **Python 3.12.13** for the backend (`backend/.venv`). The machine default (3.14.6) is
   outside `pdf2zh`'s `>=3.11,<3.13` range.
2. **`pdf2zh` is a pinned dependency, never a fork.** All upstream imports live in
   `backend/app/pdfkernel/` (ADR-001).
3. **`fast` kernel only** for MVP; `precise` is unsuitable, not merely unavailable
   (`REPO_AUDIT` §22.4).
4. **License: local/personal use only** (ADR-002). No distribution, so AGPL imposes no
   obligation. This forbids shipping binaries — reopening ADR-002 is a precondition for
   Phase 10.
5. **Placeholders are `{vN}` single-brace** — the `{{vN}}` form in earlier briefs does not
   exist in the live pipeline (`REPO_AUDIT` §2.1).
6. **Every task: acceptance criteria are written and frozen before implementation** (brief §70).
7. **Credentials go to the OS keyring** via `keyring`, never SQLite/logs/`ConfigManager`.
8. **No `cargo` installed** — Phase 10 requires provisioning Rust first.

## Phase 2 — LLM Provider (current, detailed)

Goal: a working, testable provider layer that can talk to any OpenAI-compatible endpoint over
either protocol, with user-owned endpoint/key/model and no secret leakage.

Prerequisite: the backend does not exist yet (`backend/app/` is empty), so Phase 2 opens with
a minimal FastAPI foundation.

| Task | Scope |
|---|---|
| **DS-BE-001** | Backend foundation: FastAPI app, settings, SQLite bootstrap, error envelope, structured logging, `/api/health` |
| DS-BE-002 | `LLMProvider` interface + `LLMResult` + **Chat Completions** adapter |
| DS-BE-003 | **Responses API** adapter |
| DS-BE-004 | **Auto** protocol detection (cached per profile) + `Test Connection` |
| DS-BE-005 | Provider profile CRUD + **keyring** credential storage + key masking |
| DS-BE-006 | Retry policy (backoff on 429/5xx/timeout; no retry on 401/403) |

Ordering rationale: the interface and Chat Completions must land and be verified **before**
Responses, so the Chat Completions regression surface (brief §76) is fixed and observable.

**Design constraints carried from the audit:**
- Base URL used **verbatim**; a suspected missing `/v1` produces a warning, never a rewrite
  (brief §40).
- Retry is owned here, not inherited from upstream (upstream retries *only* 429, up to 100
  times — `REPO_AUDIT` §3).
- Detection runs once at save/test time, never per translation block (brief §41).
- Nothing above the adapters may depend on a protocol-specific response shape (brief §42).

## Phase 3 — PDFMathTranslate Adapter (outline)

`backend/app/pdfkernel/`. First goal is deliberately modest:

```
Input PDF → translated mono PDF → dual PDF
```

**No** context engine, no glossary, no prompt engineering. This isolates integration risk
from intelligence risk. Ships the fast kernel only. `original + mono` is the side-by-side
source pair; `dual` is the export artifact.

## Phase 4 — PDF Reader (outline)

PDF.js rendering into the existing shell panels: Original / Translation / Bilingual, with
page, scroll, zoom and jump sync (toggleable).

## Phase 5 — Document Intelligence (outline)

One parse per document, shared by translation and QA: metadata, pages, sections, paragraphs,
page mapping, summaries. Cached by content hash.

## Phase 6 — Academic Context Translation (outline)

Document pre-analysis → glossary → context builder → neighbour context → placeholder
validator → **context-aware cache keys**. This is where the cache-contamination risk
(`REPO_AUDIT` §12) must be closed.

## Phase 7 — Translation Task System (outline)

Task states, SSE progress, cancel, retry-failed, resume.

## Phase 8 — AI Paper Assistant (outline)

Selection / Page / Section / Whole-paper scopes, FTS5+BM25 retrieval, grounded answers with
verified citations, page jump.

## Phase 9 — UI Polish (outline)

Settings, glossary editor, translation dialog, and the full loading/error/empty state matrix.

## Phase 10 — Desktop Packaging (outline, gated)

Gated on: ADR-002 reopened (distribution changes the license analysis) **and** a Rust
toolchain being installed.

## MVP closure (brief §82)

Open app → drop PDF → read immediately → AI translate → continue reading → switch to
bilingual → select text → Ask AI → click citation → jump to page.

## Non-goals for v1 (brief §84)

No cloud account, SaaS, sync, collaboration, mobile, browser extension, cloud PDF storage,
enterprise permissions, vector-DB cluster, or self-hosted inference platform.
