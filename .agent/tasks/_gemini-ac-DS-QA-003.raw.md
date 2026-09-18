# Acceptance Criteria — DS-QA-003: Paper QA Sidebar + Citation Jumping

- **Author:** Gemini (`gemini-3.8-flash-high`), via the standing two-agent workflow
- **Reviewed and frozen by:** DeepSeek, before implementation
- **Date:** 2026-09-18
- **Baseline:** `3438e5a` (DS-QA-002 committed; 718 backend tests, 78 frontend tests pass)
- **Specification Artifact:** [`DS-QA-003.md`](file:///D:/marti/SciPrograms/docs/acceptance/DS-QA-003.md)
- **Status:** **FROZEN. 19 P0 · 6 P1 · 3 P2.**

---

## 1. Critique of the Brief & Premise Corrections

Before specifying criteria, the brief was audited against the codebase and backend invariants. Four false premises and architectural gaps were identified and resolved:

### Critique 1: Frontend Scope `"document"` vs. Backend `"whole_paper"` & Undefined Scope Payloads
* **Brief premise:** The brief notes that [`ScopeSelector`](file:///D:/marti/SciPrograms/frontend/src/assistant/ScopeSelector.tsx) offers `"document"`, while the backend accepts `Literal["whole_paper", "section", "page", "selection"]`. It asks to wire the four scopes without defining how scope payloads are assembled.
* **Problem:** [`POST /api/documents/{id}/answer`](file:///D:/marti/SciPrograms/backend/app/api/documents.py#L681-L753) validates against [`Scope`](file:///D:/marti/SciPrograms/backend/app/qa/models.py#L30-L46) with `extra="forbid"`. Sending `{"type": "document"}` causes an immediate HTTP `422 VALIDATION_ERROR`. Furthermore, `type="page"` requires `page: int >= 1`, and `type="section"` requires `section_id: str`. In the existing frontend, [`workspace.ts`](file:///D:/marti/SciPrograms/frontend/src/stores/workspace.ts) does not track the active page of the viewer, and section metadata has never been fetched. Sending incomplete payloads causes 422 errors.
* **Resolution:** 
  1. Frontend `"document"` is strictly mapped to payload `{"type": "whole_paper"}`.
  2. For `"page"`, the payload is dynamically derived from the primary viewer's visible page: `{"type": "page", "page": activePage}`.
  3. For `"section"`, the client fetches [`GET /api/documents/{id}/sections`](file:///D:/marti/SciPrograms/backend/app/api/documents.py#L372-L389). If empty, `"section"` is disabled in the UI. If sections exist, the client resolves the active section where `section.page_number <= activePage`.
  4. For `"selection"`, see Decision D (deferred).

### Critique 2: The "Zero Markdown Dependency" vs. "Markdown with Inline `[E1]`" Paradox
* **Brief premise:** The brief states: *"The answer text arrives as Markdown with inline `[E1]` markers. Normal users must not see E1 or raw paragraph ids"* while simultaneously emphasizing: *"There is no Markdown renderer and no math renderer in package.json"* and *"Do not specify anything that needs ... a new dependency unless you say plainly that it is new."*
* **Problem:** Leaving this unspecified forces the engineer to either: (a) render raw markdown source as plain text (exposing `###`, `**bold**`, `- list` verbatim in the UI, ruining academic polish), or (b) import a heavy markdown suite that violates the `< 500 kB` bundle ceiling.
* **Resolution:** DeepSeek is authorized to either: (1) implement a lightweight, zero-dependency tokenizing renderer for the clean academic subset emitted by DS-QA-002 (paragraphs, bullet lists, bold, inline code, and code blocks) that replaces `\[(E\d+)\]` with interactive citation buttons; OR (2) import a vetted, ultra-lightweight parser (e.g. `snarkdown` at ~1 kB or `marked` at ~30 kB) with bundle verification. Initial bundle must strictly remain `< 350 kB`. Math rendering remains deferred.

### Critique 3: Viewer Isolation vs. Global Navigation Coordination
* **Brief premise:** [`PdfWorkspace`](file:///D:/marti/SciPrograms/frontend/src/pdf/PdfWorkspace.tsx) manages `currentPage`, `pageCount`, and `viewerRef` internally and exposes nothing to [`ReaderWorkspace`](file:///D:/marti/SciPrograms/frontend/src/reader/ReaderWorkspace.tsx), while [`AssistantSidebar`](file:///D:/marti/SciPrograms/frontend/src/assistant/AssistantSidebar.tsx) is a sibling in [`AppShell`](file:///D:/marti/SciPrograms/frontend/src/app/AppShell.tsx).
* **Problem:** Citation jumping requires clicking a citation in [`AssistantSidebar`](file:///D:/marti/SciPrograms/frontend/src/assistant/AssistantSidebar.tsx) to imperatively scroll the viewer in [`ReaderWorkspace`](file:///D:/marti/SciPrograms/frontend/src/reader/ReaderWorkspace.tsx). Without coordination, the engineer would be forced to resort to DOM queries or brittle ref-drilling.
* **Resolution:** Lift navigation synchronization to [`useWorkspaceStore`](file:///D:/marti/SciPrograms/frontend/src/stores/workspace.ts): [`PdfWorkspace`](file:///D:/marti/SciPrograms/frontend/src/pdf/PdfWorkspace.tsx) reports `onCurrentPageChange` to `workspace.activePage` when active, and subscribes to a global navigation action `jumpToCitation({ pageNumber, bboxes })` which triggers [`PdfViewerHandle.scrollToPage`](file:///D:/marti/SciPrograms/frontend/src/pdf/PdfViewer.tsx#L25-L27).

### Critique 4: Chat History Affordance vs. Stateless Single-Turn Backend
* **Brief premise:** The existing [`ConversationArea`](file:///D:/marti/SciPrograms/frontend/src/assistant/ConversationArea.tsx) renders a chat log, while the backend is strictly single-turn and stateless.
* **Problem:** A standard chat bubble UI strongly signals conversational memory to users. Follow-up questions like *"Why?"* will fail or retrieve irrelevant content because the backend has no multi-turn context.
* **Resolution:** Redesign [`ConversationArea`](file:///D:/marti/SciPrograms/frontend/src/assistant/ConversationArea.tsx) as an **Academic Q&A History**: each entry is rendered as an independent **Q&A Report Card** (Question + Scope Tag + Grounded Answer + Citation Bibliography). The sidebar displays an explicit hint: *"每次提问基于选定范围独立检索 (单轮精准问答)"*.

---

## 2. Explicit Resolutions to Decisions A–F

* **A. Citation Click in Translation Mode:**
  * **Decision:** **Switch reader mode to `original` AND navigate to `citation.page_number`.**
  * **Rationale:** The translated mono PDF is re-typeset by `pdf2zh`; source page numbers and bounding boxes from [`DocumentIR`](file:///D:/marti/SciPrograms/backend/app/qa/models.py) do not match the translated canvas. The core task contract is *"click a citation, land on the real page in the original PDF"*. Merely showing a preview traps the user without access to the actual document page. Switching to `original` brings the authoritative source into view. A non-intrusive status toast/banner is displayed: *"已切换至原文第 N 页查看引用，可随时在顶部切回译文"*.
* **B. Citation Click in Bilingual Mode:**
  * **Decision:** **Scroll ONLY the Original viewer (`viewer-original`). The Translated viewer (`viewer-translated`) remains stationary.**
  * **Rationale:** In DS-FE-003 (`AC-P1-01`), Bilingual mode was specified as two independent viewers without scroll lockstep. Because translation alters layout geometry, forcing both panes to the same page number creates desynchronization. Moving only the original pane preserves the user's reading position in the translation while displaying the cited evidence in the left pane.
* **C. Bounding Box (BBox) Highlighting Priority:**
  * **Decision:** **P1 (Page Jump is P0; BBox Highlighting is P1).**
  * **Rationale:** Navigating to the cited page ([`scrollToPage`](file:///D:/marti/SciPrograms/frontend/src/pdf/PdfViewer.tsx#L152-L157)) combined with the verbatim snippet in the citation card satisfies 100% of the functional grounding requirement for MVP. BBox highlighting requires PDF-point-to-viewport coordinate transforms (`scale * point`), container offset calculations, and ensuring overlays never render on `viewer-translated`. Setting BBox highlighting to P1 ensures citation navigation is rock-solid at P0 without being delayed by canvas overlay edge cases.
* **D. Selection Scope Priority:**
  * **Decision:** **DEFERRED TO DEDICATED TASK (DS-QA-004).**
  * **Rationale:** The frontend currently lacks a selection model, `window.getSelection()` integration, and DOM-to-paragraph mapping. Inventing this DOM-to-IR geometry engine in this task would double its scope. In DS-QA-003, `"selection"` is rendered as **disabled** in [`ScopeSelector`](file:///D:/marti/SciPrograms/frontend/src/assistant/ScopeSelector.tsx) (`disabled={true}`, label: `"选中内容 (暂未支持)"`), and `"解释选中内容"` is disabled.
* **E. Source Evidence Preview Presentation:**
  * **Decision:** **Dual-Layer: Inline Tooltip/Popover + Bottom Bibliography Card List.**
  * **Rationale:**
    1. *Inline Tooltip (Instant Context):* Hovering or focusing an inline citation pill (`[1]`, `[2]`) displays a tooltip with `第 N 页 · {section_title}`, verbatim snippet, and `"点击跳转至原文"`.
    2. *Bottom References List (Structured Overview):* Below the answer markdown, a dedicated *"参考来源"* section renders compact, numbered cards with full verbatim snippets. Clicking either the inline pill or the card executes the jump.
    3. *Rejected:* Inline accordion expansion within the prose, which disrupts academic reading flow.
* **F. Visible Q&A History:**
  * **Decision:** **YES, maintain visible document-scoped Q&A history cards.**
  * **Rationale:** Researchers compare results across questions (e.g. comparing methodology with baseline metrics). Clearing the screen on each query destroys research continuity. Each turn is rendered as a standalone **Q&A Report Card** tagged with its query scope. History is bound to the document's `sessionToken`; switching documents resets the view.

---

## 3. Acceptance Criteria Summary

The full criteria specification is frozen in [`docs/acceptance/DS-QA-003.md`](file:///D:/marti/SciPrograms/docs/acceptance/DS-QA-003.md).

### P0 — Must Pass (19 criteria)

| ID | Category | Requirement Summary |
|---|---|---|
| **AC-P0-01** | Lifecycle | **No-Document Idle State:** Sidebar is operable; scope, quick actions, composer are disabled; empty state shown. |
| **AC-P0-02** | Lifecycle | **Registration Pending/Failed:** Disabled during registration with banner `"正在建立论文检索索引…"`; failure displays retryable error. |
| **AC-P0-03** | Lifecycle | **Document Ready:** Controls unlock immediately; all state bound to `{ documentId, sessionToken }`. |
| **AC-P0-04** | Scope | **Scope Mapping:** `"当前论文"` → `whole_paper`; `"当前页"` → `page: activePage`; `"当前章节"` → `section: activeSectionId` (disabled if no sections); `"选中内容"` disabled. |
| **AC-P0-05** | Scope | **Scope Validation:** Never emit `extra="forbid"` fields like `"document"`; prevent submit when page/section identity is unresolved. |
| **AC-P0-06** | IME Input | **Chinese IME Guard:** Track composition events (`isComposing`); Enter during IME candidate confirmation **never** submits; Enter submits only when not composing; Shift+Enter inserts newline. |
| **AC-P0-07** | Submission | **Submit Guard:** Whitespace-only input disabled; in-flight locks composer, scope selector, and quick actions; prevents duplicate requests. |
| **AC-P0-08** | Profile | **Profile Resolution:** Uses selected/default profile ID from [`GET /api/profiles`](file:///D:/marti/SciPrograms/frontend/src/api/profiles.ts#L33-L35); if no profiles exist, displays alert and disables submission. |
| **AC-P0-09** | Loading | **Calm Loading:** Displays in-progress card with question, scope badge, and calm label `"正在检索文献并生成回答…"`. |
| **AC-P0-10** | Semantic State | **State 1 — `answered`:** Renders clean markdown; replaces `[E1]` with clickable `[1]` chips; renders bottom References list in first-appearance order; users never see raw `E1` or paragraph IDs. |
| **AC-P0-11** | Semantic State | **State 2 — `partial`:** Renders answer and citations; displays amber callout with bulleted [`unanswered_aspects`](file:///D:/marti/SciPrograms/backend/app/qa/models.py#L209). |
| **AC-P0-12** | Semantic State | **State 3 — `insufficient_evidence`:** Treated as honest 200 outcome, **not** an error; displays neutral card with [`missing_evidence_rationale`](file:///D:/marti/SciPrograms/backend/app/qa/models.py#L212); if [`suggest_scope_expansion`](file:///D:/marti/SciPrograms/backend/app/qa/models.py#L190), renders shortcut button to re-query whole paper. |
| **AC-P0-13** | Transport Error | **State 4 — Errors (502/4xx/Network):** Distinct destructive alert with mapped error messages (`LLM_AUTHENTICATION_ERROR`, `LLM_RATE_LIMIT`, `LLM_TIMEOUT`, `404`, `422`, network down) and Retry button. |
| **AC-P0-14** | Resilience | **Malformed Responses:** Unknown status or malformed JSON does not crash React; displays degraded answer or clean error card. |
| **AC-P0-15** | Coordinate | **1-Based Page Invariant:** Backend [`page_number`](file:///D:/marti/SciPrograms/backend/app/qa/models.py#L157), store `currentPage`, and [`PdfViewer`](file:///D:/marti/SciPrograms/frontend/src/pdf/PdfViewer.tsx) are all 1-based. Zero `+1` / `-1` conversions. |
| **AC-P0-16** | Jump Mode | **Original Mode Jump:** Clicking citation calls [`scrollToPage(citation.page_number)`](file:///D:/marti/SciPrograms/frontend/src/pdf/PdfViewer.tsx#L152-L157) on the original viewer. |
| **AC-P0-17** | Jump Mode | **Bilingual Mode Jump:** Clicking citation scrolls **only** `viewer-original`; `viewer-translated` remains stationary. |
| **AC-P0-18** | Jump Mode | **Translation Mode Jump:** Clicking citation switches mode to `original` and scrolls original viewer to `citation.page_number`; displays switch notification. |
| **AC-P0-19** | Concurrency | **Document Switch Race:** Opening a new document aborts in-flight fetch via `AbortController`; late responses matching previous `sessionToken` are dropped. |

### P1 — Should Pass (6 criteria)
* **AC-P1-01:** **BBox Highlighting Overlay:** Renders highlight box on original page using `x0 * scale, y0 * scale, (x1-x0) * scale, (y1-y0) * scale`; fades after 4s; never drawn on `viewer-translated`.
* **AC-P1-02:** **Citation Tooltip/Popover:** Hovering/focusing `[k]` chip shows page number, section title, and verbatim snippet.
* **AC-P1-03:** **Scope Expansion Shortcut:** One-click re-query with `whole_paper` when abstention suggests expansion.
* **AC-P1-04:** **Quick Actions Wiring:** Academic quick actions submit real question templates (`总结本页`, `总结方法`, `提取创新点`, `总结实验结果`, `解释公式`).
* **AC-P1-05:** **Copy Snippet Action:** Copy button on citation cards copying snippet and page number to clipboard.
* **AC-P1-06:** **Keyboard Accessibility:** Citation chips are keyboard-focusable `<button>` elements activatable with Enter/Space.

### P2 — Nice to Have (3 criteria)
* **AC-P2-01:** **Collapsible Bibliography:** Collapse/expand toggle when answer has >3 citations.
* **AC-P2-02:** **History Clear & Export:** Sidebar menu action to clear history or export as Markdown.
* **AC-P2-03:** **Diagnostics Metadata Inspection:** Optional disclosure button to inspect execution time, tokens, and requests made.

---

## 4. Verification & Guard Baselines

1. **Unit & Integration Suite (`src/tests/qa-sidebar.test.tsx`):**
   - 14 dedicated test cases covering no-document states, Chinese IME composition blocking, scope payloads, all 4 response states, citation clicks across all 3 reader modes, and document-switch race cancellation.
   - All existing 78 frontend tests must remain green.
2. **Real-Browser E2E (`playwright`):**
   - Verified against real ResNet PDF: ask grounded question, verify `[1]` chip, verify hover snippet, click citation, verify original viewer scrolls to cited page.
   - Verified in Bilingual mode (original scrolls, translated remains still) and Translation mode (switches to original and scrolls).
3. **Bundle Discipline:**
   - `dist/assets/index-*.js` initial chunk must strictly remain **`< 350 kB`** (current is 275 kB; ceiling is 500 kB).

The criteria document is recorded in [`docs/acceptance/DS-QA-003.md`](file:///D:/marti/SciPrograms/docs/acceptance/DS-QA-003.md) and frozen for DeepSeek's implementation.
