# Acceptance Criteria — DS-FE-003: Translate Action + Translation Result Viewer

- **Author:** project maintainer
- **Reviewed and frozen by:** project maintainer, before any implementation code was written
- **Date:** 2026-09-17
- **Baseline:** `ef17457` (DS-BE-007)
- **Authoring input:** the *actual* DS-BE-007 HTTP implementation, schemas, and tests — not the
  Phase 1 `API_CONTRACT.md`. The contract had drifted and was reconciled as part of this task.
- **Status:** **FROZEN.** P0 criteria may not be weakened after implementation begins.

Baselines this task must not regress:

```
backend  → 514 passed
frontend →  48 passed
initial bundle → < 500 kB  (measured 250 kB; PDF.js in its own 483 kB async chunk)
```

## Review before implementation

The criteria set is 20 P0, 5 P1 and 2 P2, with a traceability matrix, a traceability matrix covering all 40 requested
dimensions, 6 explicit non-applicable dimensions, and 5 premise critiques. It independently
reached the same conclusions as the audit on the four load-bearing points: multipart upload
(the browser has no path), non-blocking local rendering, **original + mono** for the bilingual
view, and deleting the DS-FE-001 placeholder progress and `示例` chip.

Two matters are recorded here rather than silently absorbed.

### AC_CHANGE_REQUEST 1 — AC-P0-14's precondition is unreachable

| | |
|---|---|
| **As written** | Given a translation task fails via SSE `error` or a `FAILED` snapshot, when the error code is `PROVIDER_AUTH_FAILED` / `PROVIDER_RATE_LIMITED` / `PROVIDER_TIMEOUT`, display the mapped message. |
| **Problem** | A **translation task** can never carry those codes. They are emitted only by `POST /api/profiles/{id}/test` (`app/api/profiles.py::_provider_error_response`). A task's `error.code` comes from the kernel (`app/documents/tasks.py::_fail`, `exc.code`), which is `TRANSLATION_SERVICE_ERROR` for every provider fault. |
| **Evidence** | `TranslationServiceError.code == "TRANSLATION_SERVICE_ERROR"` (`app/pdfkernel/errors.py:80`). The kernel's `detail.provider_error_code` is **not persisted** by the task store — `_fail` records only `code` and `message`. |
| **What the client actually receives** | `error.code = "TRANSLATION_SERVICE_ERROR"`, `error.message` = a sanitised, human-readable string of the form `Translation aborted after a provider failure — LLM_AUTHENTICATION_ERROR: …`. The provider token is `LLM_*` (`app/pdfkernel/adapter.py::_abort_message`, `app/llm/errors.py`). |
| **Proposed resolution** | Keep the mapped branches (they are correct for the profiles surface and defensive for the future). For task failures, display `error.message` — which AC-P0-14's own final bullet already requires — **and** additionally recognise the `LLM_*` token in that message to prepend an actionable hint. The user-visible intent (an auth failure reads as an auth failure) is preserved with the data that genuinely exists. |
| **Not accepted** | Silently deleting the branch, or fabricating a provider code the backend does not send. |

### AC_CHANGE_REQUEST 2 — AC-P0-06 mandates SSE, but a dead stream must not hang the UI

AC-P0-06 requires an `EventSource` and requires it to be closed on a terminal event. It does not
say what happens when the stream **fails** before reaching one. Taken literally, a dropped
connection leaves the UI claiming a translation is in progress forever — the exact dishonesty
this task exists to prevent.

**Resolution:** on an `EventSource` error the client falls back to polling `GET /api/tasks/{id}`
until a terminal state, and reports the stream degradation honestly. This is a *status-read*
fallback, not an automatic retry of the translation, so it does not conflict with AC-P0-14's
"no automatic retry loop".

### AC_CHANGE_REQUEST 3 — AC-P0-07 and AC-P0-18 contradict each other

| | |
|---|---|
| **As written** | AC-P0-07: the placeholder progress (`currentPage: 5, pageCount: 18, percent: 72`), the `示例` chip, and the fabricated states must be **completely eliminated**. AC-P0-18: all existing 48 frontend tests pass **without modification or breakage**. |
| **Problem** | Two DS-FE-001 test files assert precisely the placeholder behaviour AC-P0-07 orders deleted. Both cannot hold. |
| **Evidence** | `src/tests/app-shell.test.tsx:40` — `expect(getByTestId("status-percent")).toHaveTextContent("72%")`; `:41` — a progressbar is present while idle; `:27` — the document name is the literal `"paper.pdf"`; `:70` — the test sets `documentName` directly. `src/tests/reader-mode.test.tsx` — all six tests render `<App />` with no document and require `双语` to be the default and all three modes to be switchable. AC-P0-09 and AC-P0-10 require the two translated modes to be **disabled** until a translation exists, and the default to be `原文`. |
| **Why it happened** | DS-FE-001 was a shell task. Its panels were placeholders and its progress bar was explicitly labelled `示例` ("example") because there was nothing real behind it. DS-FE-003 is the task that makes the data real, so the placeholder expectations cannot survive it — this is supersession, not regression. |
| **Proposed resolution** | Update the affected assertions to the new contract while **preserving every test's intent and count**; no test is deleted. `reader-mode.test.tsx` keeps all six DOM-restructuring assertions, but seeds a completed translation first — so AC-32's actual requirement (mode switching restructures the DOM rather than relabelling it) is still verified, under a precondition that is now real. `app-shell.test.tsx` keeps its region/height assertions and gains honest idle-state ones. |
| **Not accepted** | Keeping a fabricated `72%`, or deleting the reader-mode tests to obtain a green run. |
| **Consequence** | AC-P0-18's "without modification" cannot be met literally. Frontend tests after this task are therefore reported as *modified-and-expanded*, with the delta stated explicitly in the evidence — never as "48 passed, unchanged". |

### Confirmations

- The `document_id` is server-generated per upload, so re-opening the same file yields a new
  identity. AC-P0-11's guard is therefore structural, not merely a comparison.
- `zh`/`zh-TW`/`en`/`fr`/`de`/`ja`/`ko`/`ru`/`es`/`it` are upstream's canonical language set
  (`pdf2zh/gui.py:102`). **No "auto" exists** — the language string is interpolated verbatim
  into the translation prompt, so the dialog offers only these ten.
- AC-P2-01/02 (export) are P2 and will be implemented only if P0 and P1 are complete.

---

# Section 1 — Architectural decisions (Resolutions to the 13 open questions)

1. **Local `File` → backend document.** `POST /api/documents` with `multipart/form-data`, field
   `file`. The JSON `{path}` form is for local headless callers and **must not** be used by the
   browser client.
2. **Zero-latency local rendering.** The reader **must not** wait for registration. The picked
   file loads into PDF.js immediately via `file.arrayBuffer()`; registration runs concurrently.
3. **Translate disabled when:** no document; registration in flight; a task is active
   (`PENDING`/`TRANSLATING`/`CANCELLING`). **Enabled when** registration succeeded and no task is
   in flight — including after a terminal failure, to allow a deliberate re-run. With zero
   profiles, the dialog opens showing an empty-state warning and disables its submit.
4. **Identity & race prevention.** State tracks an immutable pair: `documentId` (backend) and a
   client-side `sessionToken` generated per document load. Translation requests, SSE connections
   and artifact downloads are tagged with both; anything mismatched is dropped.
5. **Modes before translation.** `原文` active; `双语` and `译文` rendered but disabled
   (`aria-disabled`, dimmed, explanatory tooltip). Both unlock on success.
6. **Switching documents mid-translation never blocks.** The switch unbinds the viewer, closes
   the SSE connection, revokes blob URLs and moves to the new document. The backend task is left
   to finish server-side.
7. **Bilingual = original + mono.** The dual artifact is 2N interleaved pages; using it side by
   side would duplicate and misalign.
8. **Honest progress.** `PENDING`/`progress: null` → indeterminate, no fake phases or block
   counts. `{page: p, page_count: N}` → "Translating page p of N", `round(p/N*100)%`. The
   placeholder `currentPage: 5, pageCount: 18, percent: 72` and the `示例` chip are **deleted**.
9. **Differentiated errors.** See AC_CHANGE_REQUEST 1 for what is reachable; an unreachable
   backend names the API base URL so the user knows what to start.
10. **Independent panes.** The translated pane is its own `PdfWorkspace` — own toolbar, zoom,
    scroll, `PDFDocumentProxy`. No shared PDF.js singleton.
11. **Teardown.** `revokeObjectURL` on retranslation, document switch, and unmount;
    `loadingTask.destroy()` before a new load and on unmount.
12. **Mismatched page counts.** The translated viewer renders its *actual* count honestly, adds
    an informational warning, and neither crashes nor clamps the viewer.
13. **"No credential leakage" is testable** across five surfaces: rendered DOM, request payload,
    request headers, console output, and store contents.

---

# Section 2 — P0 criteria (all must pass)

## 1. Registration & local-first ingestion (dims 1, 32)

**AC-P0-01 — Non-blocking local PDF opening.**
*Given* a local `.pdf` is selected by picker or drag-drop, *then* `PdfWorkspace` parses and
displays it locally via `file.arrayBuffer()` **without waiting for any network response**.

**AC-P0-02 — Multipart backend registration.**
*Given* a local file is open, *then* the client issues `POST /api/documents` as
`multipart/form-data` with field `file`, *and* stores the returned `document_id`, `name` and
`page_count`, *and* the local file is not mutated.

## 2. Translate action & configuration dialog (dims 2–7)

**AC-P0-03 — Translate action availability.**
Disabled with no document or while registration is in flight; enabled once registration
succeeds.

**AC-P0-04 — Profile selection & keyless support.**
Opening the dialog issues `GET /api/profiles` and populates the dropdown. Profiles with
`has_key: false` are **valid and selectable without prompting for a key**.

**AC-P0-05 — Exact translation request contract.**
`POST /api/documents/{document_id}/translate` with exactly
`{"profile_id","lang_in","lang_out","engine"}` — no extra fields (the model forbids them).
A 202 transitions the store to translating.

## 3. Task progress & honest status (dims 8, 9, 28)

**AC-P0-06 — SSE subscription & lifecycle.**
On 202, open `GET /api/tasks/{task_id}/events`; close it explicitly on `done`/`error`/
`cancelled`. (Plus AC_CHANGE_REQUEST 2's fallback.)

**AC-P0-07 — No fabricated progress.**
`PENDING` or `progress: null` → indeterminate, with no fake phase names or block counts.
A real `{page, page_count}` renders as "Translating page p of N" with `round(p/N*100)%`.
The mock figures and `示例` badge are **completely eliminated**.

## 4. Success & the translated viewer (dims 10, 12, 14–17)

**AC-P0-08 — Completion and mono retrieval.**
On `event: done` with `SUCCESS`: mark `has_translation`, fetch
`GET /api/documents/{id}/translated` as a blob, and `URL.createObjectURL` it.

**AC-P0-09 — Unlocking reader modes.**
`双语` and `译文` become interactive only once the mono PDF is ready.

**AC-P0-10 — Mode viewports.**
`原文` → one pane, original. `译文` → one pane, translated mono. `双语` → two panes,
**left original, right translated mono**, each with independent zoom, toolbar and scroll.

## 5. Identity, isolation, retranslation (dims 19–22)

**AC-P0-11 — Stale-result protection on document switch.**
*Given* A is translating, *when* the user opens B, *then* the context switches immediately and
**any subsequent SSE message or response for A is discarded** — it must not alter B's viewer,
progress bar or mode switch.

**AC-P0-12 — Retranslation.**
*Given* A is terminal, *when* the user re-runs, *then* the previous blob URL is revoked, a new
task is started, and modes reset to `原文` until it completes.

## 6. Honest error handling (dims 11, 23–28)

**AC-P0-13 — Backend unreachable.**
On a connection failure, an error surface names the backend URL and advises starting the local
service; the UI does not crash or hang in a loading state.

**AC-P0-14 — Provider error mapping.**
See **AC_CHANGE_REQUEST 1**. The client must **not** start an automatic retry loop, and must
re-enable `AI翻译` for a deliberate manual re-run after a terminal failure.

## 7. Teardown & security (dims 30, 31, 33)

**AC-P0-15 — Memory & PDF.js lifecycle.**
On retranslation, document switch and unmount: `revokeObjectURL` the blob URL and
`loadingTask.destroy()` the active task.

**AC-P0-16 — Zero credential leakage.**
No plaintext key in the DOM, in any request body, in any request header, or in the console; the
store holds only `profile_id` and masked strings.

## 8. Quality & regression (dims 35, 37, 38, 39)

**AC-P0-17 — Loading, error and empty states** for the translated pane.

**AC-P0-18 — Existing suite passes unmodified** (48 frontend tests).

**AC-P0-19 — Bundle threshold.** Production build keeps the initial entry chunk **< 500 kB**,
with PDF.js still in an asynchronous chunk.

**AC-P0-20 — Automated tests** covering registration dispatch, the translation request and store
updates, SSE handling (snapshot/progress/done/error), and mode locking/unlocking.

---

# Section 3 — P1 criteria

**AC-P1-01 — Page alignment in bilingual mode.** Both panes default to page 1; navigation is
independent and must not throw or lock the sister pane.

**AC-P1-02 — Graceful 404 on artifact retrieval.** A missing `/translated` shows
"Translated file could not be retrieved from server" rather than crashing the React tree.

**AC-P1-03 — Responsive split-pane layout.** Panes share the width equally at desktop sizes;
the root keeps `overflow: hidden` and scrollbars stay inside panes.

**AC-P1-04 — Keyboard & screen-reader accessibility.** Focus is trapped in the dialog and
`Escape` closes it; the mode switch and `AI翻译` carry descriptive `aria-label`s.

**AC-P1-05 — Real-browser end-to-end verification.** Drive the real app: open a PDF, translate,
wait for `done`, switch to `双语`, and confirm both panes render.

---

# Section 4 — P2 criteria

**AC-P2-01 — Export the interleaved bilingual PDF** (`GET /bilingual`) from an export menu.
**AC-P2-02 — Export the translated mono PDF** (`GET /translated`).

---

# Section 5 — Explicitly not applicable

1. **Dual PDF in the side-by-side viewer** — 2N interleaved; export artifact only.
2. **Block-level retry** — `/retry` returns 501 by design; no UI may target it.
3. **Filesystem-path registration** — a browser `File` has no usable OS path.
4. **`ANALYZING` / `RENDERING` phases** — not emitted by the unified fast kernel.
5. **Synchronized scrolling lockstep** — out of scope for this milestone.
6. **Encrypted-PDF password entry** — out of scope; existing honest failure stays.

---

# Section 6 — Premise critiques (accepted)

1. **"Bilingual should render the dual PDF"** — the dual artifact interleaves pages; the
   two-pane view would duplicate and desynchronise. Use original + mono.
2. **"The browser should register documents by path"** — a `File` does not expose a native path;
   multipart is the only web path. The JSON form is for local callers.
3. **"Offer a Retry button hitting `/tasks/{id}/retry`"** — it returns 501 unconditionally; a
   re-run must re-dispatch `POST /api/documents/{id}/translate`.
4. **"An API key is mandatory"** — keyless local providers are supported; client-side
   "key must not be empty" validation would break local-first translation.
5. **"The status bar should show granular block progress"** — the legacy mock (`percent: 72`,
   `示例` chip) is a placeholder; the kernel emits no block counters. Retaining it compromises
   the product's honesty principle.

---

# Section 7 — Traceability (all 40 dimensions)

| # | Dimension | Class | Criteria |
|---|---|---|---|
| 1 | Document registration/upload | P0 | AC-P0-01, AC-P0-02 |
| 2 | Translation action | P0 | AC-P0-03 |
| 3 | Provider profile selection | P0 | AC-P0-04 |
| 4 | Source language | P0 | AC-P0-05 |
| 5 | Target language | P0 | AC-P0-05 |
| 6 | Translation engine | P0 | AC-P0-05 |
| 7 | Actual API request structure | P0 | AC-P0-05 |
| 8 | Task polling/progress mechanism | P0 | AC-P0-06 |
| 9 | Honest progress reporting | P0 | AC-P0-07 |
| 10 | Translation success | P0 | AC-P0-08 |
| 11 | Translation failure | P0 | AC-P0-14 |
| 12 | Translated mono PDF retrieval | P0 | AC-P0-08 |
| 13 | Dual PDF availability | P2 / NA | AC-P2-01 / §5.1 |
| 14 | Translated PDF.js rendering | P0 | AC-P0-08, AC-P0-10 |
| 15 | Original mode | P0 | AC-P0-10 |
| 16 | Translation mode | P0 | AC-P0-10 |
| 17 | Bilingual mode | P0 | AC-P0-10 |
| 18 | Source/translation page association | P1 | AC-P1-01 |
| 19 | Document identity | P0 | AC-P0-11 |
| 20 | Stale async-result protection | P0 | AC-P0-11 |
| 21 | Switching documents | P0 | AC-P0-11 |
| 22 | Retranslating | P0 | AC-P0-12 |
| 23 | Backend unavailable | P0 | AC-P0-13 |
| 24 | Provider 401/403 | P0 | AC-P0-14 (+ CR1) |
| 25 | Provider 429 | P0 | AC-P0-14 (+ CR1) |
| 26 | Provider 5xx | P0 | AC-P0-14 (+ CR1) |
| 27 | Timeout | P0 | AC-P0-14 (+ CR1) |
| 28 | Bounded failure behaviour | P0 | AC-P0-14 |
| 29 | Translated-file-not-found | P1 | AC-P1-02 |
| 30 | Object URL cleanup | P0 | AC-P0-15 |
| 31 | PDF.js lifecycle cleanup | P0 | AC-P0-15 |
| 32 | Original source immutability | P0 | AC-P0-01, AC-P0-02 |
| 33 | No credential leakage | P0 | AC-P0-16 |
| 34 | Responsive desktop layout | P1 | AC-P1-03 |
| 35 | Loading/error/empty states | P0 | AC-P0-17 |
| 36 | Accessibility | P1 | AC-P1-04 |
| 37 | Regression protection | P0 | AC-P0-18 |
| 38 | Bundle-size regression | P0 | AC-P0-19 |
| 39 | Automated tests | P0 | AC-P0-20 |
| 40 | Real-browser E2E verification | P1 | AC-P1-05 |
