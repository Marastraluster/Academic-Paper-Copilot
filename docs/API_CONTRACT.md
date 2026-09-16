# API_CONTRACT.md — Backend HTTP + SSE Surface

- **Status:** Phase 1 baseline
- **Date:** 2026-09-15
- **Base URL:** `http://127.0.0.1:<port>/api` — bound to loopback only.
  This is a local-first application; the API is never exposed beyond the machine.

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
| `POST` | `/api/documents` | Import a PDF by path. Returns metadata + `document_id`. |
| `GET` | `/api/documents` | List imported documents. |
| `GET` | `/api/documents/{id}` | Metadata, page count, section index. |
| `GET` | `/api/documents/{id}/file` | Stream the **original** file, read-only. |
| `GET` | `/api/documents/{id}/translated` | Stream `mono` output (N pages). |
| `GET` | `/api/documents/{id}/bilingual` | Stream `dual` output (2N pages). |
| `DELETE` | `/api/documents/{id}` | Remove from library. **Deletes derived artifacts only** — never the user's source file. |

`POST /api/documents` request:

```json
{ "path": "D:\\papers\\policy.pdf" }
```

Response:

```json
{ "document_id": "doc_7f3a", "title": "…", "page_count": 18,
  "has_text_layer": true, "ocr_required": false }
```

`ocr_required: true` when the document has no usable text layer — the UI must surface this
rather than silently producing an empty translation (brief §69).

> **Reader sync depends on this contract.** Side-by-side mode uses `/file` (N pages) and
> `/translated` (N pages) so that page *i* maps to page *i* with no arithmetic. `/bilingual`
> is the 2N interleaved artifact for export (REPO_AUDIT §15).

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

Profile shape as returned to the client:

```json
{ "id": "prof_1", "name": "DeepSeek", "base_url": "https://api.deepseek.com/v1",
  "model": "deepseek-chat", "protocol": "chat_completions",
  "temperature": 0, "max_output_tokens": 4096, "timeout_s": 60, "concurrency": 4,
  "streaming": true, "api_key_masked": "sk-••••••••ab12" }
```

`protocol` ∈ `auto | chat_completions | responses`. When `auto`, detection runs **once** at
save or test time and the resolved value is cached — never per translation block
(brief §49).

`POST /api/profiles/{id}/test` success:

```json
{ "ok": true, "protocol": "responses", "model": "…", "latency_ms": 840 }
```

Failure returns the error envelope with a normalized code — `PROVIDER_AUTH_FAILED`,
`PROVIDER_RATE_LIMITED`, `PROVIDER_TIMEOUT`, `PROVIDER_MODEL_NOT_FOUND`,
`PROVIDER_UNREACHABLE` — and never the raw provider response body.

**Base URL is used verbatim.** If it appears to be missing a `/v1` suffix the response may
carry a non-fatal `warning`, but the server must **not** rewrite it (brief §48).

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
| `POST` | `/api/documents/{id}/translate` | Start a task. Returns `task_id` immediately. |
| `GET` | `/api/tasks/{task_id}` | Snapshot: status, progress, error, counts. |
| `GET` | `/api/tasks/{task_id}/events` | **SSE** progress stream. |
| `POST` | `/api/tasks/{task_id}/cancel` | Request cancellation. |
| `POST` | `/api/tasks/{task_id}/retry` | Retry failed blocks only. |

Request:

```json
{ "profile_id": "prof_1", "lang_in": "en", "lang_out": "zh",
  "engine": "fast", "context_mode": "standard",
  "pages": null, "scope": "document" }
```

`scope` ∈ `document | pages | page | paragraph`; `context_mode` ∈ `off | standard | deep`.

Status ∈ `PENDING | ANALYZING | TRANSLATING | RENDERING | SUCCESS | FAILED | CANCELLED`
(brief §64).

SSE event stream:

```
event: progress
data: {"stage":"TRANSLATING","page":5,"page_count":18,"blocks_done":81,"blocks_total":342}

event: error
data: {"code":"PLACEHOLDER_MISMATCH","page":6,"block_id":"p6-b12","action":"kept_source"}

event: done
data: {"status":"SUCCESS","mono_path":"…","dual_path":"…","failed_blocks":0}
```

> **Honesty constraint on progress.** Upstream reports progress **per page** and polls
> cancellation **once per page** (`REPO_AUDIT` §7, §14). `blocks_*` counters must therefore
> be produced by our own instrumentation. If per-block counting is not yet implemented,
> the field must be **omitted** rather than fabricated — the UI must not display a progress
> bar that is not measuring anything real.

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
