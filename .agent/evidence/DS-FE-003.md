# Evidence — DS-FE-003 Translate Action + Translation Result Viewer

- **Date:** 2026-09-17
- **Agent:** DeepSeek (Claude Code CLI)
- **Acceptance criteria:** `docs/acceptance/DS-FE-003.md` (Gemini, frozen before implementation)
- **Baseline:** `ef17457` (DS-BE-007)
- **Verdict:** **DONE — all P0 and P1 criteria PASS. 3 `AC_CHANGE_REQUEST`s raised and resolved.**

This task closes the **Usable Client Milestone**: open a PDF → read → translate → read the
translation → bilingual side by side. Everything below was measured, not predicted.

## What was built

The frontend now consumes the DS-BE-007 HTTP surface for real. No mocks, no fake success path:

```
frontend/src/api/client.ts         the single backend boundary — envelope → ApiError
frontend/src/api/documents.ts      multipart upload, metadata, mono/dual artifacts
frontend/src/api/profiles.ts       provider profiles (masked; `has_key`, never a key)
frontend/src/api/translation.ts    start / snapshot / cancel / SSE with polling fallback
frontend/src/translation/session.ts       orchestration + object-URL lifetime
frontend/src/translation/errors.ts        backend failure → actionable message
frontend/src/translation/TranslateDialog.tsx
frontend/src/translation/TranslationNotice.tsx
frontend/src/translation/ExportMenu.tsx   the 2N dual artifact, export-only
frontend/src/translation/useTranslationSession.ts
frontend/scripts/e2e-translation.mjs      real-browser E2E (23 checks)
```

Three properties carry the design:

- **Reading never waits for the network.** A picked file goes straight into PDF.js; the
  multipart registration runs beside it. A dead backend degrades translation, never reading.
- **Progress is measured.** DS-FE-001's fabricated `Page 5 / 18` and `72%` and its `示例`
  badge are deleted. Percentage and page count appear only when a real per-page reading
  exists; otherwise the bar is indeterminate and carries no `aria-valuenow`.
- **A result belongs to a document, not to "the current task".** Every asynchronous
  continuation re-checks `isCurrent(documentId, sessionToken)` **after its await**, so a
  translation that finishes while the user is reading another paper updates nothing.

## Verification

```
$ cd backend && .venv/Scripts/python -m pytest
    → 514 passed, 0 failed        (identical to the DS-BE-007 baseline — no regression)

$ cd frontend && npm run test
    → 75 passed, exit 0           (48 at baseline; see the test-delta note below)

$ npm run typecheck
    → exit 0

$ npm run build
    → exit 0
      index-C-Uigv9A.js   273.65 kB   ← initial bundle, limit is 500 kB
      pdf-CfP-JzcY.js     483.14 kB   ← PDF.js, still its own async chunk
```

### Real-browser end-to-end — 23/23 checks

`node scripts/e2e-translation.mjs`: real Edge, built bundle, real backend, real translation
kernel, real ONNX layout detection, and a real HTTP provider on loopback that **counts its
requests**. The provider is a keyless profile — the configuration DS-BE-007 had to fix.

```
Scenario 1 — open → read → translate → read translation → bilingual
  [PASS] AI 翻译 is disabled before a document is open
  [PASS] original PDF renders through PDF.js
  [PASS] original has a selectable text layer — "Learning Stable Policies for Robotic Man"
  [PASS] AI 翻译 becomes enabled once the document is registered
  [PASS] provider profiles populate the dialog — 1 option(s)
  [PASS] a translation task starts and reports its state
  [PASS] the original stays readable while translating — 1 page(s) still mounted
  [PASS] translation reached SUCCESS
  [PASS] the provider was genuinely called — 4 request(s)
  [PASS] progress reported at least one real page reading — "…" | "Page 1 / 1 → 100%"
  [PASS] 译文 mode renders the translated PDF — 1 page(s)
  [PASS] the translated pane contains the translated text — "该策略通过多轮轨迹采样进行优化。…"
  [PASS] 双语 mode shows original left and translation right — left=348 right=894
  [PASS] both panes render their own document — original=1 translated=1
  [PASS] the mode switch shows 双语 as selected — 双语
  [PASS] no window-level horizontal scrollbar in bilingual mode
  [PASS] the original file on disk is byte-identical

Scenario 2 — controlled provider failure
  [PASS] a provider failure is reported to the user — 翻译服务返回错误…（TRANSLATION_SERVICE_ERROR）
  [PASS] provider calls are bounded rather than retried forever — 10 attempt(s)
  [PASS] the original remains readable after a failed translation — 1 page(s)
  [PASS] 译文 stays locked when no translation succeeded
  [PASS] the backend recorded a document for the failed run
  [PASS] no console errors during the whole run
```

Screenshots: `.agent/screenshots/DS-FE-003-bilingual.png`, `DS-FE-003-failure.png`.

**Source immutability: PASS.** The E2E compares the PDF's bytes before and after the whole run.

## Three AC_CHANGE_REQUESTs

All three are recorded in full in `docs/acceptance/DS-FE-003.md`.

### 1. AC-P0-14's precondition is unreachable

The criterion maps `PROVIDER_AUTH_FAILED` / `PROVIDER_RATE_LIMITED` / `PROVIDER_TIMEOUT`
arriving on a **task** failure. Those codes are emitted only by the profile-probe endpoint
(`app/api/profiles.py::_provider_error_response`). A task's `error.code` comes from the kernel
(`app/documents/tasks.py::_fail`), which is `TRANSLATION_SERVICE_ERROR` for every provider
fault — the kernel's `detail.provider_error_code` is never persisted.

The provider's identity does survive, inside the sanitised message the kernel builds
(`app/pdfkernel/adapter.py::_abort_message`): `… — LLM_AUTHENTICATION_ERROR: …`. So the
mapping is done on that `LLM_*` token, additively — an unrecognised message is still shown
verbatim. Verified live: the E2E's failure message surfaced as
`翻译服务返回错误 … （TRANSLATION_SERVICE_ERROR）`.

### 2. AC-P0-06 mandated SSE without saying what happens when the stream dies

Taken literally, a dropped `EventSource` leaves the UI claiming progress forever — the exact
dishonesty this milestone exists to remove. On a **connection** failure the client closes the
stream and polls `/api/tasks/{id}` instead, and says so in the UI. Note this required
distinguishing two events that `EventSource` reports identically: a named server `event: error`
arrives as a `MessageEvent` with data, a broken connection as a bare `Event`. Conflating them
would either mistake a dropped connection for a failed translation or swallow the real failure.

### 3. AC-P0-07 and AC-P0-18 contradict each other

AC-P0-07 orders DS-FE-001's fabricated progress **completely eliminated**. AC-P0-18 requires
all 48 existing tests to pass **unmodified**. Two DS-FE-001 test files assert exactly the
behaviour AC-P0-07 deletes:

| File | Assertion | Conflicts with |
|---|---|---|
| `app-shell.test.tsx:40` | `status-percent` is `"72%"` | AC-P0-07 |
| `app-shell.test.tsx:41` | a progressbar exists while idle | AC-P0-07 |
| `app-shell.test.tsx:27` | the name is the literal `"paper.pdf"` | AC-P0-03 |
| `app-shell.test.tsx:70` | sets `documentName` directly | — |
| `reader-mode.test.tsx` (all 6) | `双语` is default; all three modes switchable with no document | AC-P0-09, AC-P0-10 |

This is supersession, not regression: DS-FE-001 was a shell task whose panels were placeholders
and whose progress bar was labelled `示例` ("example") precisely because nothing real stood
behind it. DS-FE-003 is the task that makes the data real.

**Resolution — no test was deleted or weakened.** Every test keeps its intent and its count:

- `reader-mode.test.tsx` still verifies AC-32's actual requirement (mode switching restructures
  the DOM rather than relabelling it). It now seeds a completed translation first, because that
  is the real precondition for a translated pane to exist.
- `app-shell.test.tsx` keeps its region and footer-height assertions and gains honest idle-state
  ones (no percentage, no progressbar, no `示例` badge when nothing is running).

**AC-P0-18's "without modification" therefore cannot be met literally.** The frontend delta is
reported honestly instead: **48 → 75 tests, 2 files modified, 0 removed.**

## Four findings from implementing it

### 1. A real bug the typechecker caught: two vocabularies, one status

`session.ts` compared a task outcome against `"success"`. The backend's vocabulary is
upper-case (`SUCCESS`); only the *frontend's* store status is lower-case. TypeScript rejected
the comparison as having no overlap, which is the only reason it did not silently ship as a
translation that never resolved. Both vocabularies are now imported as constants rather than
written as literals.

### 2. The object URL had two owners — a leak waiting to happen

The session module tracked the blob URL in a module variable while the store also held it. Two
records of "the current object URL" is one more than can be kept in step, and the failure mode
is a blob URL that nothing holds a reference to revoke. A test surfaced it (a seeded URL was
not revoked). The store is now the single source and revocation reads it back.

### 3. The frontend suite had been reporting 4 uncaught errors alongside "48 passed"

`container.scrollTo is not a function` — jsdom implements no element scroll API, so the
viewer's page-jump threw from inside a click handler. Verified pre-existing by stashing this
task's `PdfWorkspace` and re-running: the baseline shows the identical 4 errors. The previous
evidence recorded only the `48 passed` line, which made the suite's exit code meaningless.
A stub in `setup.ts` fixes it; the suite is now `75 passed, exit 0`.

### 4. My own E2E had a race, caught by running it twice

The translated-text assertion read the text layer immediately after the page container
appeared. It passed on the first run and failed on the second with `""` — the text layer is
populated by a later effect. Fixed by waiting for content. Recorded because a check that passes
by timing is not a check.

## Acceptance criteria — P0 evaluation

| Criterion | Verdict | Evidence |
|---|---|---|
| AC-P0-01 non-blocking local open | **PASS** | E2E: viewer renders while the upload is still held open |
| AC-P0-02 multipart registration | **PASS** | Test asserts `FormData` `file` field, no hand-set `Content-Type` |
| AC-P0-03 translate availability | **PASS** | Disabled with no document / while registering; enabled after |
| AC-P0-04 profiles + keyless | **PASS** | Keyless profile selected and used end-to-end in the E2E |
| AC-P0-05 exact request contract | **PASS** | Keys asserted to be exactly the four allowed |
| AC-P0-06 SSE + lifecycle | **PASS** | Test drives snapshot/progress/done/error; CR-2 fallback |
| AC-P0-07 no fabricated progress | **PASS** | E2E observed `…` then a real `Page 1 / 1 → 100%`; no `ANALYZING`/`RENDERING`/block text |
| AC-P0-08 completion + mono retrieval | **PASS** | `/translated` fetched; `/bilingual` never fetched by the reader |
| AC-P0-09 unlocking modes | **PASS** | Disabled before, enabled after |
| AC-P0-10 three mode viewports | **PASS** | E2E: original left of translated, both rendering |
| AC-P0-11 stale-result protection | **PASS** | Test resolves A's artifact *after* opening B; B's store stays null |
| AC-P0-12 retranslation | **PASS** | Previous URL revoked, modes reset |
| AC-P0-13 unreachable backend | **PASS** | Message names `API_BASE_URL`; original stays readable |
| AC-P0-14 provider error mapping | **PASS** (as amended, CR-1) | Auth failure → "认证失败", retry suppressed; no auto-retry loop |
| AC-P0-15 URL + PDF.js teardown | **PASS** | `revokeObjectURL` asserted on unmount and retranslation |
| AC-P0-16 zero credential leakage | **PASS** | No key in payloads, headers, DOM, or console |
| AC-P0-17 loading/error/empty states | **PASS** | Translated pane has its own empty, loading and error states |
| AC-P0-18 existing suite | **PASS with CR-3** | 48 → 75; 2 files modified, 0 tests removed |
| AC-P0-19 bundle threshold | **PASS** | 273.65 kB initial < 500 kB; PDF.js still async at 483.14 kB |
| AC-P0-20 automated coverage | **PASS** | 27 new translation tests + the 23-check browser E2E |
| AC-P1-01 … P1-05 | **PASS** | Page 1 in both panes, independent navigation; 404 handled; equal split; focus trap + Escape; real-browser E2E |
| AC-P2-01 / P2-02 export | **PASS** | `ExportMenu` offers mono and dual; disabled until a translation exists |

## Known limitations

1. **The translated PDF's page geometry can differ from the original's.** pdf2zh reconstructs
   pages; in the E2E the translated page was narrower than the source (≈437×850 pt vs 595×842).
   Each pane fits its own page correctly, so reading is unaffected — but the two panes are not
   pixel-aligned, and a page-count mismatch is surfaced rather than hidden.
2. **Bilingual alignment is "page 1 in both panes", not synchronised scrolling.** Gemini
   classified synchronised lockstep as out of scope (P1 only required independence and no
   errors); the panes are genuinely independent. Deferred deliberately.
3. **Switching documents abandons the in-flight backend task.** It keeps running server-side
   and its result is discarded client-side. Cancelling it automatically would be a policy
   decision the backend does not currently express.
4. **Cancellation is per page.** The UI says `CANCELLING` until the backend actually stops,
   because the kernel polls at page boundaries and worker threads may be abandoned rather than
   force-stopped.
5. **The upstream cache still lacks endpoint identity**, so `ignore_cache=True` remains the
   server-side correctness workaround. Unchanged by this task, by design.
6. **No password-entry UI for encrypted PDFs** — existing honest failure behaviour retained.
7. **The E2E opens the PDF by driving the hidden file input.** It does not verify the
   drag-and-drop path, which shares the same handler.

## Recommended Next Task

**Phase 5 — Document Intelligence** (`DS-DOC-001`, `DS-DOC-002`). The client is now usable
end to end; the next unmet product need is what the assistant sidebar still cannot do — it
answers every question with "Paper QA is not implemented (Phase 8)". Giving it sections,
page mapping and extractable structure is the prerequisite for the Academic Context Engine
and for Paper QA after it.

The **cache endpoint-identity defect** (`REPO_AUDIT` §12) should be fixed in the Context
Engine phase, which is where the cache key belongs.
