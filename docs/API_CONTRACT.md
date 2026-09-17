# API_CONTRACT.md — Backend HTTP + SSE Surface

- **Status:** Phase 1 baseline, reconciled against the implementation at `ef17457`
- **Date:** 2026-09-15 (reconciled 2026-09-17)
- **Base URL:** `http://127.0.0.1:<port>/api` — bound to loopback only.
  This is a local-first application; the API is never exposed beyond the machine.

## Implementation status

This document was written in Phase 1 as a *design*. It has since diverged from what was
actually built, in ways that matter — most sharply, §5's example request body **would be
rejected with a 422** by the implementation, because the request model forbids unknown
fields. Where the two disagreed, this document has been corrected to match the code.

| Section | State |
|---|---|
| §0 Conventions | **Implemented** — envelope, masking and opaque ids are all live. |
| §1 Health | **Implemented** (`/api/health`). `/health/kernel` is **not implemented**. |
| §2 Documents | **Implemented**, with differences recorded inline below. |
| §3 Provider profiles | **Implemented** (DS-BE-005/006). |
| §4 Glossary | **Not implemented.** Phase 5. |
| §5 Translation tasks | **Implemented**, with differences recorded inline below. |
| §6 Paper QA | **Not implemented.** Phase 8. |
| §7 Chat | **Not implemented.** Phase 8. |
| §8 Settings | **Not implemented.** No endpoint exists. |

**The implementation and its tests are the source of truth.** Where a later phase needs a
capability this document describes but the code does not have, the code is what is real.

## 0. Conventions

**Error envelope** — every non-2xx response has this shape. No bare strings, no stack traces,
no secret material.

```json
{ "error": { "code": "PROVIDER_AUTH_FAILED", "message": "Authentication failed",
             "detail": { "http_status": 401 } } }
```

`:code` is a stable machine-readable identifier; `:message` is human-facing. `detail` is
optional and **must never contain key material, full URLs with credentials, or raw provider
bodies** (brief §53).

**Secret rule** — no endpoint in this document ever returns an API key. The only
representation a client may receive is a masked form such as `sk-••••••••ab12`.

**IDs** — `document_id` is a server-generated opaque string. File paths are never used as
identifiers in the API surface.

---

## 1. Health

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Liveness. Returns `{"status":"ok","version":"..."}`. |
| `GET` | `/api/health/kernel` | Kernel readiness: model present/loaded, OCR data present. |

`/health/kernel` exists because the ONNX layout model and Tesseract data are
**first-run network downloads** (`REPO_AUDIT` §14). The UI needs to distinguish
"backend up" from "translation actually possible", so it can show a preparing state rather
than failing at translate time.

---

## 2. Documents

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/documents` | Import a PDF. **Two request forms** — see below. Returns `201` + metadata + `document_id`. |
| `GET` | `/api/documents` | List imported documents. |
| `GET` | `/api/documents/{id}` | Metadata and page count. |
| `GET` | `/api/documents/{id}/file` | Stream the **original** file, read-only. |
| `GET` | `/api/documents/{id}/translated` | Stream `mono` output (N pages). |
| `GET` | `/api/documents/{id}/bilingual` | Stream `dual` output (2N pages). |
| `DELETE` | `/api/documents/{id}` | Remove from library. **Deletes derived artifacts only** — never the user's source file. Returns `204`. |

### `POST /api/documents` — two forms

**Multipart upload** — field name `file`. This is *the browser's form*: a browser holds a
`File`, never a filesystem path, so the path form is unusable from the frontend.

```
Content-Type: multipart/form-data
file=<bytes>
```

**JSON path import** — for local callers that genuinely have a path. Read-only: the file is
never copied, moved, or modified.

```json
{ "path": "D:\\papers\\policy.pdf" }
```

### Response — the actual shape

```json
{ "document_id": "doc_7f3a…", "name": "policy.pdf", "page_count": 18,
  "source": "upload", "has_translation": false, "created_at": "2026-09-17T…" }
```

`source` ∈ `upload | path`. `has_translation` is true once a mono artifact exists.

> **Path-import note.** `source_path` is never returned in any response.

### Rejections

| Condition | Status | Code |
|---|---|---|
| Empty upload | `400` | `EMPTY_FILE` |
| Not a PDF (magic-byte check) | `415` | `UNSUPPORTED_MEDIA_TYPE` |
| Unreadable / zero pages | `422` | `SOURCE_INVALID` |
| Larger than the configured ceiling | `413` | `PAYLOAD_TOO_LARGE` |

> **Reader sync depends on this contract.** Side-by-side mode uses `/file` (N pages) and
> `/translated` (N pages) so that page *i* maps to page *i* with no arithmetic. `/bilingual`
> is the 2N interleaved artifact for export (REPO_AUDIT §15) — **not** the interactive
> side-by-side source.

### Not implemented in this section

`title`, `has_text_layer`, `ocr_required`, and the "section index" field appeared in the
Phase 1 draft. **None exist.** OCR-required detection belongs to Document Intelligence
(Phase 5); the `documents` table has no such column.

---

## 3. Provider profiles

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/profiles` | List profiles. **Keys are masked.** |
| `POST` | `/api/profiles` | Create. Key is accepted on write only. |
| `PATCH` | `/api/profiles/{id}` | Update. Omitted key = unchanged. |
| `DELETE` | `/api/profiles/{id}` | Delete profile and its credential. |
| `POST` | `/api/profiles/{id}/test` | Connection test. |
| `POST` | `/api/profiles/{id}/detect-protocol` | Resolve `auto` → concrete protocol, then cache. |

Profile shape as returned to the client — **the actual fields**:

```json
{ "id": "prof_1", "name": "DeepSeek", "base_url": "https://api.deepseek.com/v1",
  "model": "deepseek-chat", "protocol": "chat_completions",
  "temperature": 0, "max_output_tokens": 4096, "timeout_s": 60,
  "custom_headers": null, "has_key": true, "api_key_masked": "sk-••••••••ab12",
  "created_at": "…", "updated_at": "…" }
```

The response model has **no key-bearing field of any kind** — not the key, not the
credential reference. A leak would require *adding* a field, not forgetting to remove one.

> **`has_key` is what a keyless client must consult.** A local OpenAI-compatible server is
> a fully supported configuration (`has_key: false`); a key is **not** mandatory. A client
> must not reject a profile for having no key.

`protocol` ∈ `auto | chat_completions | responses`. When `auto`, detection runs at test or
detect time and the resolved value is cached — never per translation block (brief §49).

`api_key` on **write** has three intents, and they stay distinguishable: **absent** leaves
the stored credential alone; `""` clears it; a value replaces it. Explicit `null` is
rejected. A credential-store failure aborts before any row is written.

`POST /api/profiles/{id}/test` success:

```json
{ "ok": true, "protocol": "responses", "model": "…", "latency_ms": 840 }
```

Failure returns the error envelope — **as a 5xx, never a 200 carrying `ok: false`**, so a
caller cannot mistake an unreachable provider for a working one by checking the status code
alone — with a normalized code: `PROVIDER_AUTH_FAILED` (401 **and** 403),
`PROVIDER_RATE_LIMITED` (429), `PROVIDER_TIMEOUT` (504), `PROVIDER_MODEL_NOT_FOUND`,
`PROVIDER_UNREACHABLE`, `PROVIDER_ERROR`. Never the raw provider response body.

### Not implemented in this section

`concurrency` and `streaming` appeared in the Phase 1 draft profile shape. **Neither
exists** in the response model. The base-URL `warning` field is also not implemented.

---

## 4. Glossary

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/documents/{id}/glossary` | Current glossary with origin per term. |
| `PUT` | `/api/documents/{id}/glossary` | Bulk upsert. |
| `POST` | `/api/documents/{id}/glossary/analyze` | Run AI pre-analysis to propose terms. |

```json
{ "terms": [ { "source": "policy", "target": "策略", "origin": "ai", "locked": false } ] }
```

Precedence (**Locked user term > Document glossary > AI decision**, brief §40) is resolved
server-side. `locked: true` terms are never overwritten by AI analysis.

Editing the glossary **changes the cache key**, so it must not silently reuse translations
produced under a different glossary (`REPO_AUDIT` §12).

---

## 5. Translation tasks

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/documents/{id}/translate` | Start a task. Returns `202` + `task_id` immediately. |
| `GET` | `/api/tasks/{task_id}` | Snapshot: status, progress, error. |
| `GET` | `/api/tasks/{task_id}/events` | **SSE** progress stream. |
| `POST` | `/api/tasks/{task_id}/cancel` | Request cancellation at the next page boundary. |
| `POST` | `/api/tasks/{task_id}/retry` | **Returns `501`.** See below. |

### Start request — the actual body

```json
{ "profile_id": "prof_1", "lang_in": "en", "lang_out": "zh", "engine": "fast" }
```

Defaults: `lang_in="en"`, `lang_out="zh"`, `engine="fast"`. Only `"fast"` is supported;
a second engine needs a separate repository and an isolated venv (`REPO_AUDIT` §22.4).

**The request model forbids unknown fields.** `context_mode`, `pages`, and `scope` were
part of the Phase 1 design and do **not** exist; sending them returns `422
VALIDATION_ERROR`, not a silently-ignored field. Page ranges and context modes are later
phases.

`profile_id` is the **only** credential reference. An API key is never sent by a client and
never returned to one.

### Response — `202`

```json
{ "task_id": "task_…", "document_id": "doc_…", "status": "PENDING" }
```

### Task snapshot

```json
{ "task_id": "task_…", "document_id": "doc_…",
  "status": "PENDING | TRANSLATING | SUCCESS | FAILED | CANCELLED",
  "lang_in": "en", "lang_out": "zh", "engine": "fast",
  "progress": { "page": 5, "page_count": 18 },
  "error": { "code": "…", "message": "…" },
  "created_at": "…", "updated_at": "…" }
```

`progress` is `null` until the first page reports. `error` is `null` unless the task failed.

**Status vocabulary, corrected.** `ANALYZING` and `RENDERING` are **never emitted**. The
fast kernel runs one unified pipeline and reports progress per page; those two states were
part of the Phase 1 design and are not distinguishable at runtime. `SUCCESS` — not
`SUCCEEDED`.

### SSE event stream — actual frames

```
event: snapshot
data: { …full task payload… }

event: progress
data: {"event":"progress","status":"TRANSLATING","progress":{"page":5,"page_count":18}}

event: error
data: {"event":"error","status":"FAILED","code":"…","message":"…"}

event: done
data: {"event":"done","status":"SUCCESS","page_count":18,"translated_page_count":18}

event: cancelled
data: {"event":"cancelled","status":"CANCELLED"}

: keepalive
```

The stream emits a `snapshot` first, so a client connecting *after* the task started still
learns the current state instead of waiting for the next page. Idle streams send a
keepalive comment every 15 s. The stream closes itself after `done`, `error`, or
`cancelled`.

> **Honesty constraint on progress.** Upstream reports progress **per page** and polls
> cancellation **once per page** (`REPO_AUDIT` §7, §14). `blocks_*` counters do not exist
> and are **omitted rather than fabricated** — the UI must not display a progress bar that
> is not measuring anything real. A test asserts the string `blocks_done` appears nowhere
> in a task payload.

### `POST /api/tasks/{task_id}/retry` — `501`, deliberately

```json
{ "error": { "code": "NOT_IMPLEMENTED",
  "message": "Block-level retry is not supported by the translation kernel. Re-run
              translation via POST /api/documents/{id}/translate." } }
```

The kernel translates whole documents; there is no block-level retry or resume. Answering
truthfully is better than an endpoint that appears to work. To re-run, start a new
translation — a **`re-translate`** action is a whole-document operation, not a retry of
failed blocks.

### `POST /api/tasks/{task_id}/cancel` — honest about its limits

```json
{ "task_id": "task_…", "status": "CANCELLING",
  "message": "Cancellation requested. The current page will finish, then translation will halt." }
```

The stored status becomes `CANCELLED` only once the kernel actually stops; returning that
immediately would claim something untrue. Cancelling an already-terminal task is refused
with `409 TASK_ALREADY_TERMINAL`. Worker threads may be **abandoned rather than
force-stopped**, so the UI must not promise instantaneous termination.

A task that was mid-flight when the process exited is reconciled to `FAILED` with
`error.code = "PROCESS_INTERRUPTED"` on the next startup, rather than appearing to still be
running.

---

## 6. Paper QA

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/documents/{id}/ask` | Ask a scoped question. |
| `GET` | `/api/documents/{id}/sessions` | List chat sessions. |
| `POST` | `/api/documents/{id}/sessions` | Create session. |
| `GET` | `/api/sessions/{sid}/messages` | Message history. |

Request:

```json
{ "scope": "selection | page | section | document",
  "question": "Why diffusion policy here?",
  "selection": { "text": "…", "page": 6, "section_id": "3.2" },
  "session_id": "sess_1" }
```

Response — structured, never a bare string (brief §60):

```json
{ "answer": "…",
  "citations": [ { "page": 6, "section": "3.2 Policy Learning" } ],
  "grounded": true }
```

`grounded: false` accompanies the fixed refusal
*"当前论文上下文中没有找到足够信息。"* when retrieved evidence is insufficient
(brief §61). The client must not render an ungrounded answer as fact.

Citation `page` values are **1-based** and MUST resolve through Document Intelligence's page
mapping — a citation the reader cannot jump to is a defect.

---

## 7. Chat

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/documents/{id}/sessions` | Sessions for a document (multiple per doc, brief §63). |
| `GET` | `/api/sessions/{sid}` | Session detail with messages. |
| `DELETE` | `/api/sessions/{sid}` | Delete session. |

---

## 8. Settings

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/settings` | Non-secret app settings (theme, defaults, context mode). |
| `PATCH` | `/api/settings` | Update. |

Settings never contain credentials — those are addressed by `profile_id` only.
