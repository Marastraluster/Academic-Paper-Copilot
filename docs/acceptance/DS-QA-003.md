# Acceptance Criteria — DS-QA-003: Paper QA Sidebar + Citation Jumping

- **Author:** project maintainer
- **Reviewed and frozen by:** project maintainer, before implementation
- **Date:** 2026-09-18
- **Baseline:** `1732024` (DS-QA-002 committed; 768 backend tests, 78 frontend tests pass) — corrected by AC_CHANGE_REQUEST 1
- **Status:** **FROZEN**, with **4 `AC_CHANGE_REQUEST`s** raised in review below. **19 P0 · 6 P1 · 3 P2.**
- **Scope:** Frontend & reader-side integration of the frozen grounded Paper QA backend (`POST /api/documents/{document_id}/answer`).

---

## Review before implementation

Four things in this document could not be implemented as written. All four are resolved
before any production code, and none of them touches a P0's substance.

### AC_CHANGE_REQUEST 1 — the baseline line names the wrong commit and the wrong test count

| | |
|---|---|
| **As written** | `Baseline: 3438e5a (DS-QA-002 committed; 718 backend tests …)` |
| **Problem** | `3438e5a` is the DS-QA-001 P0-9 disposition, not DS-QA-002. DS-QA-002 is `1732024`, and it took the backend from 718 to **768** passing tests. A baseline that names the wrong commit is the kind of detail a later reader trusts and is misled by — and this project has already had one task reconstructed because its recorded state did not match the repository. |
| **Resolution** | Corrected in the header. The count is re-run before it is reported anywhere in the evidence, per the standing rule. |

### AC_CHANGE_REQUEST 2 — the pending banner claims indexing that is not happening

| | |
|---|---|
| **As written** | AC-P0-02: while backend registration is in flight, show `"正在建立论文检索索引…"`. |
| **Problem** | Registration is an **upload**. Nothing is indexed during it: the `DocumentIR` is extracted lazily by the first request that needs it, and the FTS index is built lazily by the first search. A banner promising index construction describes a phase that does not exist at that moment, which is exactly the invented-progress the brief forbids in §17 and §61 — and this project has refused it consistently, down to the Composer's own tooltip, which says `"正在把文档注册到后端…"`. |
| **Resolution** | The banner reads `"正在把文档注册到后端…"`, matching the wording already in `TopBar`. If indexing turns out to be slow enough to be worth reporting, that is a later measurement, not a guess made now. |

### AC_CHANGE_REQUEST 3 — the "action link to settings" links to a control that does nothing

| | |
|---|---|
| **As written** | AC-P0-08: when no provider profile exists, show an alert "with an action link to settings". |
| **Problem** | There is no settings surface. `TopBar` renders a `<Settings />` button with no `onClick` — it is decoration from DS-FE-001, and provider profiles are created by `scripts/configure_provider.py`, not by the UI. A link would have to open nothing, or open a dialog that does not exist. |
| **Resolution** | The empty-profile state renders as an alert naming the command that actually configures a provider (`python scripts/configure_provider.py`), which is true and actionable on this desktop app. No link, and no settings dialog invented for it. |

### AC_CHANGE_REQUEST 4 — the bbox transform is only correct on an unrotated page

| | |
|---|---|
| **As written** | AC-P1-01: `left = x0 * scale`, `top = y0 * scale`, `width = (x1 - x0) * scale`, `height = (y1 - y0) * scale`. |
| **Problem** | That is the correct transform for **rotation 0**, and only for rotation 0. `PageIR` carries a `rotation` field, and a page with `/Rotate 90` gives a viewport whose dimensions are swapped and whose mapping from source points is not a pure scale. Applying the formula there draws a rectangle in the wrong place — a confidently wrong highlight, which is worse than none, because it points the reader at text that does not support the claim. |
| **Resolution** | The formula stands as written for rotation 0. When the page's rotation is not 0, **the highlight is not drawn**; the page jump still happens, and the citation's snippet is still shown. The limitation is recorded rather than papered over with a transform that has not been verified against a rotated page. |

### Confirmations

* **AC-P0-12's re-query is a user action, not an automatic widening.** The button appears
  only when `diagnostics.suggest_scope_expansion` is true, which the backend sets only for a
  `page` or `section` scope — so the scope being widened is always narrower than the whole
  paper, and the widening never happens without a click.
* **AC-P0-14 renders the answer inside a distinctly labelled card**, not with answered
  styling. An unrecognised status means we cannot say the answer is grounded, so it is shown
  as unrecognised while still giving the reader what came back.
* **AC-P0-19's abort is a client-side decision.** The backend has no cancellation for this
  endpoint; aborting stops *waiting*, and the server may still finish. The criteria do not
  claim otherwise, and neither will the code or the evidence.
* **Decision F's history is presentation only.** Every request stays a single independent
  turn; no previous question, answer or citation is sent to the backend.

---

## Baselines this task must not regress

```
backend  → 718 passed (zero new endpoints, zero schema migrations)
frontend →  78 passed (modified/expanded for real QA integration)
initial bundle → < 350 kB (measured 275 kB; PDF.js in lazy async chunk; strict < 500 kB budget)
```

---

## Section 1 — Critique of the Brief & Premise Corrections

Before specifying criteria, The criteria audits the brief against the repository architecture, backend contracts, and reader mechanics. Four false premises and architectural gaps are identified and resolved below:

### Critique 1: Frontend Scope `"document"` vs. Backend `"whole_paper"` & Undefined Scope Payloads

| | |
|---|---|
| **Brief premise** | The brief notes the scope selector offers `"document"`, while the backend requires `"whole_paper"`. It suggests supporting the four scopes without addressing how scope payloads are assembled. |
| **Problem** | The backend `POST /api/documents/{document_id}/answer` accepts `Scope` with `model_config = ConfigDict(extra="forbid")`. Passing `{"type": "document"}` results in an immediate HTTP `422 VALIDATION_ERROR`. Furthermore, `Scope(type="page")` requires `page: int >= 1`, and `Scope(type="section")` requires `section_id: str`. In the current frontend, `workspace.ts` does not track the active page of the reader, and section metadata has never been fetched. Sending invalid or incomplete scope objects causes unavoidable 422 crashes. |
| **Resolution** | 1. UI value `"document"` is strictly mapped to payload `{"type": "whole_paper"}`.<br>2. When scope is `"page"`, the payload is dynamically constructed using the original reader's active `currentPage`: `{"type": "page", "page": activePage}`.<br>3. For `"section"`, the client fetches `GET /api/documents/{document_id}/sections` on document open. If the document has no sections (empty list), `"section"` is **disabled** in the UI. If sections exist, the client resolves the active section for `currentPage` (the latest section where `section.page_number <= activePage`).<br>4. For `"selection"`, see Decision D (deferred). |
| **Not accepted** | Passing raw frontend string `"document"` to the API, or permitting the user to submit `"page"` or `"section"` scopes without valid identifiers. |

### Critique 2: The "Zero Markdown Dependency" vs. "Markdown with Inline `[E1]`" Paradox

| | |
|---|---|
| **Brief premise** | The brief requires: *"The answer text arrives as Markdown with inline `[E1]` markers. Normal users must not see E1 or raw paragraph ids."* Simultaneously, the brief notes: *"There is no Markdown renderer and no math renderer in package.json"* and *"Do not specify anything that needs ... a new dependency unless you say plainly that it is new."* |
| **Problem** | Leaving this unspecified forces the engineer to either: (a) render raw markdown as plain text (exposing markdown syntax like `###`, `**bold**`, `- item` directly to the user, violating academic polish), or (b) import a heavy markdown library that risks blowing up the initial JS bundle (> 500 kB budget). |
| **Resolution** | The implementation is authorized to either: (1) implement a lightweight, zero-dependency tokenizing renderer for the clean academic subset emitted by DS-QA-002 (paragraphs, bullet lists, bold, inline code, and code blocks) that replaces `\[(E\d+)\]` with interactive citation buttons; OR (2) introduce a vetted, ultra-lightweight markdown parser (e.g. `snarkdown` at ~1 kB or `marked` at ~30 kB) with bundle-size verification. The initial bundle must strictly remain `< 350 kB`. Math rendering remains deferred. |
| **Not accepted** | Rendering unparsed markdown source code, or importing heavyweight markdown ecosystems (e.g. `react-markdown` + `rehype` + `remark` tree) that exceed the bundle budget. |

### Critique 3: Viewer Isolation vs. Global Navigation Coordination

| | |
|---|---|
| **Brief premise** | The brief points out that `PdfWorkspace` manages `currentPage`, `pageCount`, and `viewerRef` internally and exposes nothing to its parent `ReaderWorkspace`, while `AssistantSidebar` is a sibling in `AppShell`. |
| **Problem** | Citation jumping requires a user clicking a citation in `AssistantSidebar` to imperatively navigate the PDF viewer in `ReaderWorkspace`. Without an explicit coordination mechanism, an engineer would be forced to resort to messy ref-forwarding chains or DOM query selectors (`document.querySelector`). |
| **Resolution** | Introduce a centralized reader navigation state in `workspace.ts` (or a dedicated navigation slice):<br>- `PdfWorkspace` reports its visible page to `workspace.activePage` via `onCurrentPageChange`.<br>- Citation clicks dispatch a jump action: `jumpToCitation({ pageNumber: number, bboxes?: list })`.<br>- The original `PdfWorkspace` listens to this jump request and executes `viewerRef.current.scrollToPage(pageNumber)`. |
| **Not accepted** | Uncontrolled DOM hacks (e.g. `window.scroll` or direct element querying across component boundaries). |

### Critique 4: Chat History Affordance vs. Stateless Single-Turn Backend

| | |
|---|---|
| **Brief premise** | The brief asks whether to keep a visible list of questions and answers, noting that every backend request is independent and single-turn. |
| **Problem** | Rendering questions and answers as a standard messaging chat thread (with speech bubbles) falsely conveys conversational memory to the user. A user asking a follow-up ("Why?" or "Expand on point 2") will receive an answer based only on keyword retrieval of "Why?", resulting in confusion or false hallucinations. |
| **Resolution** | The UI maintains a visible query history for the open document, but presents entries as distinct, self-contained **Academic Q&A Cards** (Question + Scope Tag + Grounded Answer + Citation Bibliography). Above the composer, an explicit hint is displayed: *"每次提问基于选定范围独立检索 (单轮精准问答)"* (Each question is answered independently based on the selected scope). |
| **Not accepted** | A chat bubble aesthetic that mimics multi-turn conversational agents, or wiping the previous answer on each new submission. |

---

## Section 2 — Explicit Decisions on Questions A–F

### Decision A: Citation Click in Translation Mode
- **Decision:** **Switch reader mode to `original` AND navigate to `citation.page_number`.**
- **Rationale:** The translated mono PDF is re-typeset and re-paginated by `pdf2zh`; source page numbers and bounding boxes from `DocumentIR` are physically meaningless on the translated canvas. The fundamental promise of DS-QA-003 is: *"click a citation, land on the real page in the original PDF"*. Merely showing a preview leaves the user trapped without access to the actual document page. Switching to `original` mode brings the authoritative source into full view. A non-intrusive status toast/banner is displayed: `"已切换至原文第 N 页查看引用，可随时在顶部切回译文"` ("Switched to original page N to view citation; switch back to translation anytime from the top bar").

### Decision B: Citation Click in Bilingual Mode
- **Decision:** **Scroll ONLY the Original viewer (`viewer-original`). The Translated viewer (`viewer-translated`) remains stationary.**
- **Rationale:** Bilingual mode in this application consists of two independent viewers without scroll lockstep (`AC-P1-01` in DS-FE-003). Because translation alters geometry, forcing both panes to the same numerical page would misalign the translated reading context and violate the independent-viewer architecture. Moving only the original pane preserves the user's reading position in the translation on the right while bringing the cited primary evidence into view on the left.

### Decision C: Bounding Box (BBox) Highlighting Priority
- **Decision:** **P1 (Page Jump is P0; BBox Highlighting is P1).**
- **Rationale:** Landing on the real PDF page (`scrollToPage(citation.page_number)`) combined with the citation snippet in the preview card provides 100% of the functional grounding required for MVP. BBox highlighting requires PDF-point-to-viewport coordinate transforms (`scale * point`), container offset calculations, HiDPI scaling, and rendering an overlay layer that must *never* bleed into `viewer-translated`. Setting BBox highlighting to P1 ensures that citation jumping is rock-solid and verified at P0 without being held hostage to canvas overlay edge cases.

### Decision D: Selection Scope Priority
- **Decision:** **DEFERRED TO DEDICATED TASK (DS-QA-004).**
- **Rationale:** The frontend currently possesses zero selection models, zero `window.getSelection()` listeners, and zero mappings from DOM text nodes to `ParagraphIR.id` or bounding boxes. Inventing this DOM-to-IR geometry engine in this task would double its scope and destabilize the viewer. In DS-QA-003, `"selection"` is rendered as **disabled** in `ScopeSelector` (`disabled={true}`, label: `"选中内容 (暂未支持)"`), and the quick action `"解释选中内容"` is disabled.

### Decision E: Source Evidence Preview Presentation
- **Decision:** **Dual-Layer Presentation: Inline Tooltip/Popover + Bottom Bibliography Card List.**
- **Rationale:**
  1. **Inline Tooltip (Instant Context):** Hovering or focusing an inline citation pill (`[1]`, `[2]`) displays a lightweight tooltip showing: `第 N 页 · {section_title}` and the verbatim snippet with prompt `"点击跳转至原文"`.
  2. **Bottom References List (Structured Overview):** Beneath the answer markdown, a dedicated `"参考来源"` section lists compact, numbered evidence cards. Each card displays the citation number, page number, section title, and the full verbatim snippet. Clicking either the inline pill or the bottom card executes the page jump.
  3. **Rejected:** Inline accordion expansion inside the prose (disrupts reading flow of academic arguments).

### Decision F: Visible Q&A History
- **Decision:** **YES, maintain visible document-scoped Q&A history cards.**
- **Rationale:** Researchers frequently compare results across multiple questions (e.g. comparing methodology and baseline metrics). Clearing the screen on each query destroys research continuity. However, to prevent users from expecting conversational memory, each entry is rendered as an independent **Q&A Report Card** with its own scope badge and citations. History is bound to the document's `sessionToken`; switching documents resets the view.

---

## Section 3 — Acceptance Criteria

### P0 — Must Pass (19 criteria)

#### Lifecycle & No-Document State
- **AC-P0-01: No-Document Idle State.**
  When no document is open (`document === null`):
  - `AssistantSidebar` remains collapsible/expandable via TopBar toggle.
  - When expanded, `ScopeSelector` is disabled (`disabled={true}`).
  - All `QuickActions` buttons are disabled (`disabled={true}`).
  - `Composer` textarea is disabled with placeholder `"请先打开 PDF 论文..."`, and send button is disabled.
  - `ConversationArea` displays a calm empty state: `"未打开文档。请打开一篇 PDF 论文以启用问答助手。"`

- **AC-P0-02: Registration Pending & Failed States.**
  When a document is loaded locally but backend registration is in flight (`document.registration === "pending"` or `document.documentId === null`):
  - `ScopeSelector`, `QuickActions`, and `Composer` remain disabled.
  - A subtle status banner displays: `"正在把文档注册到后端…"` (AC_CHANGE_REQUEST 2 — registration is an upload; indexing happens lazily on the first question and is not claimed here).
  - When registration fails (`document.registration === "failed"`): controls remain disabled and an error message is displayed: `"文档注册失败"` with `"问答服务暂不可用。请重新打开该论文，或确认后端服务正在运行。"` (AC_CHANGE_REQUEST 2 — the same correction as the pending banner: nothing was being indexed, so nothing failed to index).

- **AC-P0-03: Document Ready State & Session Binding.**
  When `document.registration === "ready"` and `document.documentId !== null`:
  - `Composer`, `ScopeSelector`, and valid `QuickActions` unlock immediately.
  - All QA state (history, active queries, errors) is tagged with `{ documentId, sessionToken }`.

#### Scope Handling & Identity Resolution
- **AC-P0-04: Scope Selector Mapping & Options.**
  The `ScopeSelector` renders the following options:
  1. `"当前论文"` (Whole Paper) → maps to API payload `{"type": "whole_paper"}`.
  2. `"当前页"` (Current Page) → maps to API payload `{"type": "page", "page": activePage}`. The UI label dynamically displays `"当前页 (第 N 页)"` matching the original viewer's active page.
  3. `"当前章节"` (Current Section) → maps to API payload `{"type": "section", "section_id": activeSectionId}`. If `/api/documents/{id}/sections` returns an empty array, this option is disabled (`disabled={true}`) with label `"当前章节 (无目录结构)"`.
  4. `"选中内容"` (Selection) → disabled (`disabled={true}`) with label `"选中内容 (暂未支持)"`.

- **AC-P0-05: Missing Scope Identity Protection.**
  The client MUST NOT send an HTTP request with an ungrounded or incomplete scope:
  - If `"page"` scope is selected while `activePage` is null or invalid, submission is prevented client-side.
  - If `"section"` scope is selected while no section can be resolved, submission is prevented client-side.
  - The API payload MUST conform strictly to `Scope` with `extra="forbid"`. The disallowed key `"document"` is NEVER sent.

#### Question Input & Chinese IME Safeguard
- **AC-P0-06: Chinese IME Composition Safeguard.**
  In `Composer`:
  - Typing in an Input Method Editor (IME) for Chinese/Japanese/Korean triggers composition events (`compositionstart`, `compositionend`).
  - Pressing `Enter` to confirm phonetic composition (Pinyin) while `event.nativeEvent.isComposing === true` MUST NOT submit the question.
  - Submission on `Enter` occurs ONLY when `event.key === "Enter" && !event.shiftKey && !isComposing && !event.nativeEvent.isComposing`.
  - `Shift+Enter` inserts a newline without submitting.

- **AC-P0-07: Whitespace and In-Flight Submission Guard.**
  - Submitting an empty or whitespace-only query (`composerValue.trim() === ""`) is strictly prevented; the send button remains disabled (`disabled={true}`).
  - While a query is in-flight (`isSubmitting === true`):
    * The send button is disabled, displaying a spinning loader (`Loader2`).
    * The textarea is disabled or ignores submission keystrokes.
    * `ScopeSelector` and `QuickActions` buttons are disabled.
    * Duplicate requests cannot be triggered.

#### Provider Profile Resolution
- **AC-P0-08: Provider Profile Binding & Empty State.**
  - When submitting `POST /api/documents/{document_id}/answer`, `profile_id` must be populated.
  - The assistant uses the selected profile ID from `useWorkspaceStore` or the first available profile from `GET /api/profiles`.
  - If `GET /api/profiles` returns an empty list (`[]`), the composer is disabled and an alert is displayed naming the command that configures one: `"未检测到可用的模型配置。请在项目目录运行 python scripts/configure_provider.py 添加 Provider Profile。"` (AC_CHANGE_REQUEST 3 — there is no settings surface to link to).

#### Execution & Loading State
- **AC-P0-09: Calm Academic Loading Presentation.**
  While awaiting backend answer generation:
  - An in-progress card is added to the conversation area displaying:
    * The user's question.
    * A scope badge (e.g. `[整篇论文]` or `[第 3 页]`).
    * A calm loading indicator with label `"正在检索文献并生成回答…"` (no chat bubbles, no decorative bouncing dots, no fake progress percentages).

#### Semantic Response States (Backend 200 vs. Transport 502)
- **AC-P0-10: State 1 — `answered` (Full Grounded Answer).**
  When backend returns HTTP 200 with `status: "answered"`:
  - The answer body is rendered in clean markdown.
  - Inline markers `[E1]`, `[E2]` are parsed and replaced with interactive citation pills `[1]`, `[2]`.
  - Normal users NEVER see raw `E1` or raw paragraph IDs.
  - A compact References section is rendered below the answer listing all citations in first-appearance order.

- **AC-P0-11: State 2 — `partial` (Partial Grounded Answer).**
  When backend returns HTTP 200 with `status: "partial"`:
  - Renders the answer body and citation chips identically to `answered`.
  - Renders an amber/subtle callout banner immediately below the answer:
    * Title: `"部分回答 (以下方面文献缺乏依据)"`
    * Content: Bulleted list of `unanswered_aspects`.

- **AC-P0-12: State 3 — `insufficient_evidence` (Honest Abstention).**
  When backend returns HTTP 200 with `status: "insufficient_evidence"`:
  - This is treated as a **successful, honest response**, NEVER as an error.
  - No red error styling or failure banners are shown.
  - Renders a neutral academic card:
    * Title: `"未找到充分证据"`
    * Description: Renders `missing_evidence_rationale` (or fallback `"论文在指定范围内未包含回答此问题的依据"`).
  - If `diagnostics.suggest_scope_expansion === true`:
    * Render an actionable button: `"在「整篇论文」范围内重新检索"`.
    * Clicking this button automatically sets scope to `"whole_paper"` and immediately re-submits the question.

- **AC-P0-13: State 4 — Transport & Provider Error Handling (HTTP 502/4xx/Network).**
  When the backend returns an error envelope (`{"error": {"code", "message", "detail"}}`) or network failure occurs:
  - Displays a dedicated error card in the conversation area (with subtle red/alert styling).
  - Recognizes standard provider error codes and displays actionable messages:
    * `LLM_AUTHENTICATION_ERROR` → `"模型服务认证失败，请检查 API Key 配置"`
    * `LLM_RATE_LIMIT` → `"模型调用频率受限 (Rate Limit)，请稍后重试"`
    * `LLM_TIMEOUT` → `"模型响应超时，请检查网络或更换模型"`
    * `LLM_CONNECTION_ERROR` → `"无法连接至模型服务提供方"`
    * `404 NOT_FOUND` → `"未找到指定的论文或模型配置"`
    * `422 VALIDATION_ERROR` → `"请求参数校验失败"`
    * Generic/Network → Displays `error.message` or `"网络连接异常，请确保后端服务正常运行"`
  - Provides a `"重试"` (Retry) button that re-executes the query without requiring the user to re-type it.

- **AC-P0-14: Malformed Response Resilience.**
  If the backend returns HTTP 200 with an unknown `status` string or malformed JSON payload:
  - The UI does not crash or throw unhandled React exceptions.
  - If an `answer` string exists, it is displayed with a degraded badge: `"应答状态异常: [status]"`.
  - If unparseable, an error card is rendered cleanly within the conversation area.

#### Citation Jumping & Reader Mode Interplay
- **AC-P0-15: 1-Based Page Coordinate Preservation.**
  - `page_number` in `ResolvedCitation` is 1-based (`Field(ge=1)`).
  - `PdfViewer` and `PdfWorkspace` operate on 1-based page indexes (`1 .. pageCount`).
  - Page numbers must be passed between `ResolvedCitation`, the store, and `PdfViewerHandle.scrollToPage` **verbatim with zero offset modification** (no `page - 1`, no `page + 1`).

- **AC-P0-16: Citation Jump in Original Mode.**
  When the reader is in `original` mode:
  - Clicking an inline citation pill `[k]` or its corresponding References card invokes `scrollToPage(citation.page_number)` on the original viewer.
  - The original viewer smoothly scrolls to position page `citation.page_number` at the top of the viewport.

- **AC-P0-17: Citation Jump in Bilingual Mode (Decision B).**
  When the reader is in `bilingual` mode:
  - Clicking an inline citation pill `[k]` or References card scrolls **ONLY the original pane (`viewer-original`)**.
  - The translated pane (`viewer-translated`) remains at its current scroll position without movement.

- **AC-P0-18: Citation Jump in Translation Mode (Decision A).**
  When the reader is in `translation` mode:
  - Clicking an inline citation pill `[k]` or References card:
    1. Switches reader mode to `original` (`useWorkspaceStore.getState().setReaderMode("original")`).
    2. Navigates the newly focused original viewer to `citation.page_number`.
    3. Displays a brief status toast: `"已切换至原文第 N 页查看引用，可随时在顶部切回译文"`.

#### Race Conditions & Concurrency
- **AC-P0-19: Document Switch Race Cancellation.**
  If a user opens a new document (or switches files) while a QA query is in-flight:
  - The active `AbortController` aborts the HTTP request immediately.
  - When any late response arrives, the client compares the response's `{ documentId, sessionToken }` with the store's current `document.documentId` and `document.sessionToken`.
  - Any mismatched response is silently dropped.
  - The conversation area is reset to the new document's session context; queries or answers from the previous document are NEVER rendered under the new document.

---

### P1 — Should Pass (6 criteria)

- **AC-P1-01: Bounding Box (BBox) Highlighting Overlay (Decision C).**
  When a citation jump is triggered and `citation.bboxes` contains one or more bounding boxes (`[x0, y0, x1, y1]` in PDF points, top-left origin):
  - On the target page in the original PDF viewer, render an overlay layer containing highlight rectangles:
    * `left = x0 * scale`
    * `top = y0 * scale`
    * `width = (x1 - x0) * scale`
    * `height = (y1 - y0) * scale`
  - The highlight is styled with academic yellow/primary tint (e.g. `bg-primary/20 border border-primary/40 rounded-sm`).
  - The highlight automatically fades out after 4 seconds (or upon user scrolling).
  - Highlighting is NEVER rendered on `viewer-translated`.
  - **A page whose `rotation` is not 0 draws no highlight** (AC_CHANGE_REQUEST 4 — the scale-only transform is correct for rotation 0 and wrong otherwise, and a wrongly placed highlight points the reader at text that does not support the claim). The page jump and the snippet still happen.

- **AC-P1-02: Citation Hover Tooltip / Popover (Decision E).**
  Hovering or focusing an inline citation pill `[k]` displays a Radix Tooltip containing:
  - Header: `第 {citation.page_number} 页` · `{citation.section_title ?? "正文"}`
  - Body: Verbatim excerpt `citation.snippet` (cut at sentence boundary).
  - Footer hint: `"点击跳转至原文对应页面"`.

- **AC-P1-03: Scope Expansion Shortcut from Abstention.**
  When status is `insufficient_evidence` and `diagnostics.suggest_scope_expansion === true`, the action button `"扩大至整篇论文重新提问"` triggers an instant re-query with scope `{"type": "whole_paper"}` using the same question, without clearing the composer.

- **AC-P1-04: Academic Quick Actions Wiring.**
  The standard academic quick actions are wired to real question templates:
  - `"总结本页"` → Submits with scope `{"type": "page", "page": activePage}`, question: `"请总结本页的核心内容与关键结论。"`
  - `"总结方法"` → Submits with scope `{"type": "whole_paper"}`, question: `"请详细总结本文提出的方法、模型架构与核心算法。"`
  - `"提取创新点"` → Submits with scope `{"type": "whole_paper"}`, question: `"本文的主要创新点与核心贡献是什么？"`
  - `"总结实验结果"` → Submits with scope `{"type": "whole_paper"}`, question: `"请总结本文的实验设置、基线对比及主要实验结果。"`
  - `"解释公式"` → Submits with current scope, question: `"请解释此处的数学公式及各变量的物理含义。"`
  - `"解释选中内容"` → Disabled until DS-QA-004.

- **AC-P1-05: Copy Citation & Snippet Action.**
  Each reference card in the bottom bibliography section includes a small `"复制引文"` (Copy) icon button that copies `{citation.snippet} (Page {citation.page_number})` to the clipboard.

- **AC-P1-06: Keyboard Accessibility for Citations.**
  Inline citation pills `[k]` are standard HTML `<button>` elements with `tabIndex={0}` and `aria-label="查看第 N 页引用"`. Pressing `Enter` or `Space` triggers the citation jump and closes any active tooltip.

---

### P2 — Nice to Have (3 criteria)

- **AC-P2-01: Collapsible References Bibliography.**
  When an answer contains more than 3 citations, the bottom References section is rendered with an expand/collapse toggle (`"展开全部 N 条引用来源"`), defaulting to showing the first 3 cards to keep the sidebar compact.

- **AC-P2-02: QA History Clear & Export.**
  The sidebar header includes a subtle dropdown menu with actions:
  - `"清空问答记录"` (Clear QA History) — resets the conversation area for the current document.
  - `"导出问答记录 (Markdown)"` — exports all questions, answers, and citation metadata as a formatted Markdown file.

- **AC-P2-03: Diagnostics Metadata Inspection.**
  A subtle disclosure button (`"问答诊断"`) at the bottom of an answer card allows developers/researchers to inspect `diagnostics.execution_time_ms`, `prompt_tokens`, `completion_tokens`, and `requests_made` without cluttering the normal academic reading view.

---

## Section 4 — Traceability Matrix

| Dimension Required by Brief | Primary Criteria | Verification Method |
|---|---|---|
| 1. Sidebar lifecycle & no-document state | `AC-P0-01`, `AC-P0-02`, `AC-P0-03` | Vitest: render without document; check disabled states |
| 2. Four scopes & missing identity | `AC-P0-04`, `AC-P0-05`, `AC-P1-04` | Vitest: inspect payload per scope; check 422 avoidance |
| 3. Question input & Chinese IME | `AC-P0-06`, `AC-P0-07` | Vitest: fire composition events; assert Enter blocked |
| 4. Submit button & duplicate in-flight | `AC-P0-07`, `AC-P0-19` | Vitest: rapid clicks; verify single fetch dispatched |
| 5. Loading presentation | `AC-P0-09` | Vitest: assert aria-busy and calm academic spinner |
| 6. Four semantic states (200 vs 502) | `AC-P0-10`, `AC-P0-11`, `AC-P0-12`, `AC-P0-13` | Vitest: mock each status response; verify UI cards |
| 7. Unknown statuses & malformed response | `AC-P0-14` | Vitest: mock unknown status; verify no React crash |
| 8. Citation rendering, preview & click | `AC-P0-10`, `AC-P1-02`, `AC-P1-05`, `AC-P1-06` | Vitest: verify `[E1]` replaced by `[1]`; tooltip exists |
| 9. Page number 1-based conversion | `AC-P0-15`, `AC-P0-16` | Vitest: assert `scrollToPage` called with exact page |
| 10. Three reader modes interplay | `AC-P0-16`, `AC-P0-17`, `AC-P0-18` | Vitest: test jump under original, bilingual, translation |
| 11. Document-switch & scope-switch races | `AC-P0-19` | Vitest: abort controller & sessionToken mismatch test |
| 12. Accessibility & keyboard navigation | `AC-P0-06`, `AC-P1-06` | Vitest: keyboard focus and Enter key activation |
| 13. Layout at 1024 / 1440 / 1920 | `AC-P0-01`, `AC-P0-09` | Vitest + Playwright: verify `overflow-hidden`, zero scrollbar |
| 14. Bundle regression discipline | Bundle Ceiling (< 350 kB) | Vite build size audit: `dist/assets/index-*.js` |
| 15. Frontend unit tests | Section 5 (Vitest) | Vitest test suite run (all green) |
| 16. Real-browser end-to-end checks | Section 5 (Playwright) | Playwright E2E test against ResNet sample |

---

## Section 5 — Verification & Test Plan

### 1. Frontend Unit & Integration Tests (`src/tests/qa-sidebar.test.tsx`)
The implementation must include a dedicated test suite with at least the following test cases:
1. **`test_idle_when_no_document`**: Renders sidebar with `document: null`. Asserts composer, scope selector, and quick actions are disabled.
2. **`test_chinese_ime_enter_key_does_not_submit`**: Types with `compositionstart` event, triggers `keydown` with `Enter`, verifies `fetch` is NOT called. Then triggers `compositionend` and `Enter`, verifies `fetch` is called.
3. **`test_empty_whitespace_cannot_submit`**: Enters spaces in composer, verifies send button is disabled.
4. **`test_scope_whole_paper_payload`**: Selects `"当前论文"`, verifies body contains `scope: {"type": "whole_paper"}`.
5. **`test_scope_page_payload`**: Mocks active page as 4, selects `"当前页"`, verifies body contains `scope: {"type": "page", "page": 4}`.
6. **`test_scope_section_empty_disabled`**: When `/sections` returns `[]`, `"当前章节"` option has `disabled` attribute.
7. **`test_status_answered_renders_citations`**: Mocks 200 `answered` with answer containing `[E1]`. Verifies text renders `[1]` chip and does not contain `E1`.
8. **`test_status_partial_renders_unanswered_aspects`**: Mocks 200 `partial`. Verifies `unanswered_aspects` banner is rendered.
9. **`test_status_insufficient_evidence_abstains`**: Mocks 200 `insufficient_evidence`. Verifies no error styling, rationale is displayed, and scope expansion button appears.
10. **`test_transport_error_502_renders_retry`**: Mocks 502 `LLM_RATE_LIMIT`. Verifies rate limit message and retry button.
11. **`test_citation_click_in_original_mode`**: Clicks citation `[1]` (page 3). Verifies `scrollToPage(3)` called on original viewer.
12. **`test_citation_click_in_bilingual_mode`**: In bilingual mode, clicks citation. Verifies original viewer scrolls to page 3, translated viewer does not scroll.
13. **`test_citation_click_in_translation_mode`**: In translation mode, clicks citation. Verifies store calls `setReaderMode("original")` and scrolls to page 3.
14. **`test_document_switch_drops_late_response`**: Submits query on Doc A, switches to Doc B before fetch resolves. Verifies Doc A answer is never rendered.

### 2. Real-Browser End-to-End Test (`playwright`)
1. Launch application in Playwright test runner.
2. Open ResNet PDF (`fixtures/resnet.pdf`).
3. Verify sidebar scope displays `"当前页 (第 1 页)"`.
4. Type question: `"What problem do residual networks solve?"`.
5. Click send; verify composer is disabled and loading state appears.
6. Await grounded answer response; verify inline citation `[1]` is rendered.
7. Hover over `[1]`; verify snippet tooltip displays text mentioning degradation problem.
8. Click `[1]`; verify original viewer scrolls to the page cited (Page 1 or 2).
9. Switch to Bilingual mode; click citation again; verify only the original viewer scrolls.
10. Switch to Translation mode; click citation; verify reader switches to `original` mode and displays target page.

### 3. Bundle Size Audit
Run `npm run build` and inspect chunk sizes:
- `dist/assets/index-*.js` must be strictly `< 350 kB` (leaving ample margin under the 500 kB project ceiling).
- PDF.js chunk remains lazy-loaded on first open.
