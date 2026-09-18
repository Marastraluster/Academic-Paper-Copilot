# Acceptance Criteria — DS-QA-011: Cross-page Selection + Persistent Annotation

- **Author:** Gemini (`gemini-3.8-flash-high`), via the standing two-agent workflow
- **Reviewed and frozen by:** DeepSeek (Round 1 review pending)
- **Date:** 2026-09-19
- **Baseline:** Commit `2529674` / DS-QA-010 closed (`SOURCE_ANCHOR_VERSION = "1"`, `IR_PIPELINE_VERSION = "4"`, `SCHEMA_VERSION = 4`)
- **Deliverable:** `docs/acceptance/DS-QA-011.md` (authored before any production code)
- **Status:** **PROPOSED FOR ROUND 1 REVIEW — 26 P0 · 5 P1 · 3 P2**

---

## 0. Round 1 review and freezing (DeepSeek) — 6 AC_CHANGE_REQUESTs

Read against the repository at `2529674` and the measurements in §2. The author
was given the probe output and used it well: Decisions A, C, D, G, M and O
follow from the measurements, and §4.1's Strategy C is the strategy the probe
independently identified as exact. Six items are changed before freezing.

### AC_CHANGE_REQUEST 1 — AC-P0-19 is not implementable as written, and would pass the exact failure it exists to catch

**Old wording (AC-P0-19):** *"If rapid auto-scroll unmounts the starting page
before mouseup, the gesture fails safe (`status: "unavailable"`), emitting zero
corrupt bounding boxes."*

**New wording:** *"If the browser's own selected text names content the mapper
could not measure — the case measured when auto-scroll removes a touched page's
text layer mid-drag — creation is refused with `status: "unavailable"` and a
message naming the cause. The check is positive, not structural: the normalized
text the mapper measured must cover the normalized `selection.toString()`. A
gesture that cannot measure part of what the user selected must not persist the
part it could."*

**Reason — measured, not stylistic.** §4.2's guard refuses only when
`dom.byPage.length !== 2` or a page produced no rects. But a removed text node is
not in `document.body`, so Strategy C never visits it and `byPage` silently
becomes exactly two *adjacent mounted* pages. The guard passes, and the
annotation is saved for pages P+1…P+2 while the user's visible selection began on
page P. That is the silent truncation Phase 75 forbids, and as written AC-P0-19
would report PASS on it. The probe measured the asymmetry that makes the positive
check possible: after page 1's text layer was removed, `selection.toString()`
still reported **6388 characters** while `getClientRects()` on the same selection
could no longer measure page 1 at all. The two disagree precisely in the failure
case, which is what makes the comparison a real detector rather than a heuristic.

### AC_CHANGE_REQUEST 2 — Decision H / AC-P0-10 regresses accepted DS-QA-010 navigation

**Old wording (Decision H, AC-P0-10):** *"Clicking a cross-page annotation
navigates to `targets[0]`."*

**New wording:** *"Clicking a cross-page annotation navigates to the first target
whose resolution succeeded, falling back to the first target that is jumpable —
the rule `frontend/src/notes/jump.ts` already implements and DS-QA-010 accepted.
It is applied unchanged to a multi-page target set."*

**Reason.** `jumpToAnnotation` selects
`targets.find(t => t.resolved_paragraph_id !== null) ?? targets.find(t => t.amenable_to_jump)`.
Gemini's rule would send the reader to an ORPHANED target whenever the first
target failed to resolve and a later one resolved — a worse destination than the
one DS-QA-010 ships, and a regression of an accepted criterion. Cross-page does
not change what "the useful target" means.

### AC_CHANGE_REQUEST 3 — Decision K re-opens reader-mode semantics, which the task forbids

**Old wording (Decision K, AC-P0-15):** *"Clicking a cross-page note jumps
`viewer-translated` to `targets[0].page_number`, draws 0 highlight boxes, and
displays toast: 已跳转至第 P 页。高亮仅在原文或双栏视图中显示。"*

**New wording:** *"In translation mode a cross-page annotation's source geometry
renders 0 boxes on the translated pane, and clicking it returns the reader to the
original pane and says why — the accepted DS-QA-010 behaviour, unchanged. No new
notice string is introduced for this case."*

**Reason.** `jumpToAnnotation` already switches back to the original pane and
sets a notice. The task's Phase 41 says *"Do not re-open reader-mode semantics"*,
and Phase 42 says the mode invariant is what must be verified. A new toast string
is a UI change the criteria have not justified.

### AC_CHANGE_REQUEST 4 — Decision L requires a bilingual page-synchronisation command that does not exist

**Old wording (Decision L, AC-P0-16):** *"`viewer-translated` scrolls to
`targets[0].page_number` with 0 highlight boxes."*

**New wording:** *"In bilingual mode the highlights render on the original pane
across every page of the annotation, and the translated pane receives 0 source
boxes. The translated pane is not commanded to scroll."*

**Reason.** The bilingual panes are aligned page-*i*-to-page-*i* by
construction, and `jumpToAnnotation` issues one `requestJump` for the source
pane. Requiring a second cross-pane scroll adds a command DS-QA-010 does not
have, to verify an invariant that the geometry assertions already cover.

### AC_CHANGE_REQUEST 5 — the refusal status vocabulary has no slot for six distinct refusals

**Old wording (Decisions E, F, M, N, R + AC-P0-17/18/19):** every refusal returns
`status: "unavailable"`. **New wording:** the criteria name the observable
refusal *reason* for each, and one new `MappingStatus` value,
`cross_page_refused`, carries the cross-page-specific ones; `ScopeSelector`'s
message for it states the actual cause rather than the current
*"暂不支持跨页选区问答，请限制在单页内选择。"*, which becomes false the moment this
task ships.

**Reason.** Decision R requires *"honest refusal with specific UI feedback"*, but
`unavailable` currently renders *"选区映射暂不可用（原文结构尚未就绪）"* — a
statement about the IR, which is wrong for a rotated page, wrong for a page with
no prose, and wrong for an unmounted page. The reader gets a sentence about a
different problem. Five refusal reasons cannot share one message and still satisfy
Decision R.

### AC_CHANGE_REQUEST 6 — AC-P0-26 hardcodes suite sizes

**Old wording:** *"All 950 existing backend tests and 182 frontend tests pass with
zero regressions."* **New wording:** *"The full backend suite and the full
frontend suite pass with zero failures, and no existing test is weakened,
skipped, or deleted."*

**Reason.** A criterion that names a count is falsified by adding a test, which
this task will do. The intent — no regression — is preserved without the number.

### Accepted without change

Decisions **A** (two adjacent mounted pages), **C**, **D**, **G** (canonical
reading order), **M**, **N**, **O**, **P** (no pinning in P0) and **Q**
(worst-case badge precedence) are accepted as written; each follows from a
measurement and each is bounded by it. Decision **E/F** is accepted with the
refusal vocabulary of request 5. Decision **J** (Selection QA inherits
cross-page) is accepted, and the assumption it rests on was **verified rather
than assumed**: `backend/app/qa/retrieval.py` filters a selection scope by
`chunk_id IN (…)` and `backend/app/qa/models.py` types `paragraph_ids` with no
page constraint, so a scope spanning two pages is already legal on the backend
and no retrieval change is needed.

**P0 is frozen at 26 criteria with the six changes above.** Implementation starts
against this list and nothing else.

---

## 0. Independent Acceptance Author Statement & Review Framing

### 0.1 Process Discipline: Acceptance before Implementation
In this repository, process sequencing is load-bearing:
- **DS-DOC-002** bypassed pre-implementation acceptance criteria, resulting in reading-order and cache-invalidation defects that had to be retroactively diagnosed and repaired (`.agent/evidence/DS-DOC-002.md`).
- **DS-DOC-003** strictly enforced acceptance criteria first (`docs/acceptance/DS-DOC-003.md`). That discipline exposed three critical defects before code was written: anchor scoping omission across papers (AC_CHANGE_REQUEST 1), ordinal position fragility (AC_CHANGE_REQUEST 2), and conflicting de-hyphenation normalization (AC_CHANGE_REQUEST 3).
- **DS-QA-010** established the multi-target persistent notes architecture (`docs/acceptance/DS-QA-010.md`), closing at **18/18 P0 PASS** (`2529674`) with 0 AI calls, 0 PDF mutations, and 0.0% wrong-attachment rate.

**This task (DS-QA-011) enforces that same discipline.** Cross-page text selection is where browser DOM mechanics, PDF.js virtualization, and content-addressed persistence collide. This document is authored independently against measured native browser evidence before a single line of production code is modified.

### 0.2 Core Guiding Principles

1. **User data is sacred.** User annotations represent intellectual labor. A document extraction change, layout re-segmentation, or page virtualizer eviction may orphan an anchor, but it must **never** delete, corrupt, or alter user notes or verbatim excerpts.
2. **0.0% wrong-attachment rate.** An honest refusal or an unattached state is infinitely preferable to attaching an annotation to the wrong paragraph or wrong page. A false highlight destroys user trust.
3. **Strict evidentiary boundary.** User notes are personal commentary; they are **never** scientific paper evidence. Notes must never be indexed into retrieval chunks, injected into QA prompts, or used by LLM answering.
4. **Zero AI / Zero network cost.** Creating, viewing, editing, reattaching, or deleting cross-page notes requires zero LLM inferences, zero provider calls, and zero network requests outside the local backend.
5. **Source PDF byte immutability.** The source PDF file on disk remains bit-identical (`content_hash` preserved). All annotations live in local SQLite storage out-of-band.
6. **Native DOM selection without synthetic engines.** No custom text selection engine, virtual cursor emulator, or third-party geometry library (e.g. `rbush`, `rangy`) may be introduced. Native browser selection is the foundation; the code must interpret native ranges faithfully without inventing fake DOM geometry.

### 0.3 Verified Starting State

| Starting State Property | Repo Verification Location | Verified Repo Value / Finding |
|---|---|---|
| **Baseline commit & status** | Git log / `DS-QA-010.md` | Commit `2529674`: DS-QA-010 closed at **18/18 P0 PASS**. |
| **Test suite baselines** | Test runners | Backend **950 passed**, frontend **182 passed**, typecheck PASS, build exit 0. |
| **Bundle size & ceiling** | Vite build output | Initial bundle **330.13 kB** against **350.0 kB ceiling** (~20 kB headroom). |
| **Schema version & tables** | `backend/app/db.py:27, 132`, `test_db.py:75` | `SCHEMA_VERSION = 4`. Tables: `["annotations", "annotation_targets", "documents", "profiles", "schema_version", "translation_tasks"]`. |
| **Multi-target data model** | `backend/app/annotations/store.py:148-175` | One `Annotation` record $\to N$ ordered `AnnotationTarget` rows, written atomically in `BEGIN IMMEDIATE`. |
| **Target model attributes** | `backend/app/annotations/models.py:28-44` | Target holds: `source_anchor_id`, `anchor_version`, `page_number`, `original_bbox`, `rects`, `exact_quote`, `prefix`, `suffix`. |
| **Target builder readiness** | `frontend/src/notes/targets.ts:68-114` | `buildAnnotationTargets` already reads `mapping.rects[paragraph.page_number]` per page and sorts targets by `DocumentIR` order across the whole document. |
| **Selection matcher readiness** | `frontend/src/qa/selection.ts:206-266` | `matchParagraphs` already accepts `Map<pageNumber, PdfRect[]>` and returns `rects: Record<page, Bbox[]>`. |
| **DOM reader capability** | `frontend/src/qa/selection.ts:310-354` | `readDomSelection` already returns `byPage: {page, element, rects}[]` and `crossPage: boolean`. |
| **Single refusal guard** | `frontend/src/qa/session.ts:385-394` | Hard-coded guard: `if (dom.crossPage) return { status: "cross_page", ... }`. `captureSelection` below it reads only `dom.byPage[0]`. |
| **Persistent source identity** | `backend/app/document/anchors.py:52, 60` | `SOURCE_ANCHOR_VERSION = "1"`, `GEOMETRY_QUANTUM_PT = 2.0`. Replay: 150 EXACT, 10 REATTACHED, 0 AMBIGUOUS, 0 ORPHANED, 0 WRONG. |
| **Rotated page policy** | `frontend/src/qa/selection.ts:125`, `PdfWorkspace.tsx` | `toPdfRects()` returns `[]` when `rotation !== 0`; persistent highlight layer suppressed on rotated pages. Measured and accepted. |
| **Translated pane isolation** | Hard Invariant 9, `session.ts:380` | Zero highlight geometry on `viewer-translated`. Selections on translated pane rejected (`status: "non_prose"`). |

---

## 1. Executive Judgment: Is this task worth doing?

**Yes — but strictly as an exact, two-page adjacent extension of native text selection, using text-node clamped geometry with zero external libraries and zero schema redesign.**

Academic reading is rife with ideas that cross page boundaries:
1. Continuous body paragraphs that break across the page gutter (especially in two-column formats).
2. Key methodological definitions bridging the bottom of one page and the top of the next.
3. Theorem statements followed immediately by their corollaries overleaf.

In DS-QA-010, attempting to select across a page boundary returned `status: "cross_page"`, disabling both Note creation and Selection QA. Enabling cross-page annotations completes the core annotation experience.

### Strict Boundary Exclusions
- **No Custom Selection Engine:** Native browser `Selection` / `Range` is required. No custom drag-canvas or synthetic range emulator.
- **No Character-Offset Identity:** Paragraph anchors (`source_anchor_id`) are the persistent identity. Character offsets remain strictly forbidden.
- **No Persistence or Schema Redesign:** `SCHEMA_VERSION = 4` and the `annotations` / `annotation_targets` schema remain unchanged.
- **No Stable-Anchor Redesign:** `SOURCE_ANCHOR_VERSION = "1"` and `anchors.py::reattach()` are unchanged.
- **No Note-Assisted QA or Retrieval Leakage:** User notes remain strictly excluded from search indices, retrieval bundles, and answering prompts.
- **No Cloud Sync, PDF Annotation Writeback, or Export Redesign:** Excluded from scope.

---

## 2. Measured Native Browser Behaviour & The Central Hazard

The empirical findings below were measured by `frontend/scripts/probe-crosspage.mjs` running against the built production frontend, real backend, and Chromium/Edge under window 1440×900, viewport height 770 px, fit-width scale 1.7647 (`.agent/results/crosspage/probe.json`):

### 2.1 Finding 1: A Native Drag Spans Two PDF.js Text Layers
Dragging from line `L1-37` (first line of the last paragraph on page 1) to line `L2-04` (last line of the first paragraph on page 2) produced:
```
selection.toString().length = 655
rangeCount = 1, collapsed = false
getClientRects().length = 15
rects by page: { page 1: 8, page 2: 7 }
```
**Conclusion:** PDF.js text layers do not interrupt, re-render, or collapse a native drag. A single continuous `Range` bridges both page containers.

### 2.2 Finding 2: Exactly Two Pages are Mounted at a Page Boundary; a Third Never Is
`PdfViewer` mounts a canvas and text layer only for pages intersecting the viewport buffered by `RENDER_BUFFER_MARGIN_PX = 300`. Scrolled to the page 1/2 boundary:
```
page 1  hasCanvas=true  hasTextLayer=true   spanCount=40
page 2  hasCanvas=true  hasTextLayer=true   spanCount=40
page 3  hasCanvas=false hasTextLayer=false  spanCount=0
```
Across zoom scales 1.5, 1.25, and 1.0, the rendered set was `[1, 2]` every time.
**Conclusion:** At reading zoom, the simultaneously-mounted span is **strictly two adjacent pages**.

### 2.3 Finding 3: The Central Hazard — Naive Rect Ownership Attributes Whole Pages
The existing `readDomSelection()` in `frontend/src/qa/selection.ts` assigns each client rect to a page by hit-testing its center with `document.elementFromPoint`, falling back to `range.startContainer`. On the cross-page drag above, this emitted an artifact:
```json
{ "page": 1, "left": 365, "top": 476, "width": 1050, "height": 1486 }
```
This rectangle is **page 2's entire text-layer container**. Because the rect's center lay below the 900 px viewport, `elementFromPoint` returned `null`, triggering the fallback to `range.startContainer` (page 1).
**Impact:** A 1050×1486 artifact attributed to page 1 intersects every paragraph on page 1, creating massive corrupt highlights across the whole page.

### 2.4 Finding 4: Text Node Range Clamping (Strategy C) is Exact
Measuring strategies side by side on the live selection:
- **Strategy A (Naive Hit-Testing):** Page 1 gets 8 rects (including the 1050×1486 page-2 box); page 2 gets 7 rects.
- **Strategy B (Clamp to Page Container):** Page 1 gets 7 rects; page 2 gets 8 rects (still containing the 1050×1486 container border).
- **Strategy C (Clamp to Intersecting Text Nodes):** Page 1 gets **4 rects**, page 2 gets **4 rects**, **0 artifacts**.
```
Page 1 rects (all 19 px tall, inside page 1 container top -1026..460):
  492,205 522x19    492,229 569x19    492,254 546x19    492,279 517x19
Page 2 rects (all 19 px tall, inside page 2 container top 476..1962):
  492,563 562x19    492,588 522x19    492,612 569x19    492,637 538x19
```
Because every text node belongs unambiguously to exactly one page container via its DOM ancestry (`node.parentElement.closest('[data-testid="pdf-page-container"]')`), ownership is known directly with **zero hit-testing** and **zero fallbacks**.

### 2.5 Finding 5: Native Drag Auto-Scroll is Real and Fast
Moving the pointer to the bottom edge of the window during a drag drove `scrollTop` from **1135 to 3752 in ~900 ms** ($\approx 2.9\text{ px/ms}$). A cross-page drag routinely triggers native auto-scroll.

### 2.6 Finding 6: Long Auto-Scroll Evicts the Starting Page
When auto-scroll carried the viewport to `scrollTop = 2600+`, page 1 was unmounted by virtualization (`hasTextLayer = false`). While the Range boundary nodes still reported `isConnected = true`, `getClientRects()` on the unmounted text layer returned nothing. Attempting to map after the starting page unmounts produces incomplete or corrupt geometry.

---

## 3. Explicit Design Decisions A–R

| # | Topic | Verdict | Detailed Specification & Rationale |
|---|---|---|---|
| **A** | **Supported Page Span Limit** | **TWO ADJACENT PAGES ONLY (`[P, P+1]` or `[P+1, P]`).** | Measured Finding 2 proves that PDF.js virtualization mounts at most 2 adjacent pages at reading zoom. Claiming arbitrary $N$ pages ($N \ge 3$) is impossible under standard virtualization without page pinning. P0 is strictly limited to 2 adjacent pages. Any selection touching $\ge 3$ pages or non-adjacent pages is refused (`status: "unavailable"`). |
| **B** | **Drag Auto-Scroll Support** | **SUPPORTED WITHIN MOUNTED BOUNDS; FAIL-SAFE ON EVICTION.** | Auto-scroll between the two adjacent pages while both remain mounted is fully supported. If long auto-scroll evicts page $P$ before mouseup (Finding 6), mapping fails safe (`status: "unavailable"`), creating 0 corrupt records. |
| **C** | **Page N+1 Unmounted at Boundary** | **REFUSE / UNAVAILABLE.** | If page $P+1$ has not yet mounted its text layer when the pointer reaches the boundary, the browser cannot select text nodes that do not exist in the DOM. The mapping returns `status: "unavailable"`. |
| **D** | **Virtualization Dependency** | **ONLY CURRENTLY MOUNTED PAGES SUPPORTED.** | Grounded strictly in DOM reality: selection operates on live text nodes. No synthetic offscreen DOM trees are constructed. |
| **E** | **Asymmetric / One-Sided Mapping** | **REFUSE CREATION IF EITHER PAGE MAPS TO 0 TARGETS.** | If a cross-page selection maps to valid targets on page 1 but 0 targets on page 2 (e.g. page 2 touched only a diagram, equation, or whitespace), the system must **refuse** annotation creation. Silently saving a single-page note from an explicit two-page selection misrepresents user intent. |
| **F** | **Partial Mapping vs Rejection** | **ALLOW IF BOTH PAGES HAVE $\ge 1$ PROSE TARGET; REFUSE IF EITHER HAS 0.** | If both pages have at least one valid prose paragraph, but some candidate fragments (e.g. captions/headers) fail validation, creation is **allowed** with status `"partial"`, preserving all valid prose targets. If an entire page has 0 valid prose targets, creation is **refused**. |
| **G** | **Target Ordering** | **CANONICAL `DocumentIR` READING ORDER.** | `annotation_targets` are ordered strictly by canonical `DocumentIR` sequence (`ir.paragraphs` reading order across the paper: page $P$ before page $P+1$, top-to-bottom within page). Target order is independent of DOM tree order and drag direction (forward vs backward). |
| **H** | **Click Navigation Destination** | **JUMP TO FIRST TARGET (`targets[0]`).** | Clicking a cross-page annotation navigates `viewer` to `targets[0].page_number`, scrolling smoothly to `targets[0].original_bbox`. This aligns with natural reading order. |
| **I** | **Sidebar Page Range Label** | **DISPLAY `p. X–Y` (e.g. `p. 1–2`).** | In `NotesCard.tsx` and sidebar listings, an annotation with targets on pages $P$ and $P+1$ displays `p. P–(P+1)`. Single-page annotations retain `p. P`. |
| **J** | **Selection QA Inheritance** | **INHERITED IN P0 VIA SHARED MAPPING; QA LOGIC UNCHANGED.** | Because `captureSelection()` in `session.ts` is shared, cross-page selection automatically supplies canonical `paragraphIds` across both pages to `ScopeSelector` (capped at 20). Backend retrieval and answering models remain completely untouched (Area 48). |
| **K** | **Translation Mode Behavior** | **PAGE JUMP ONLY; ZERO HIGHLIGHT GEOMETRY ON TRANSLATED PANE.** | Per Hard Invariant 9, source geometry must never render on `viewer-translated`. Clicking a cross-page note jumps `viewer-translated` to `targets[0].page_number`, draws 0 highlight boxes, and displays toast: *"已跳转至第 P 页。高亮仅在原文或双栏视图中显示。"*. Selections on translated pane remain disabled. |
| **L** | **Bilingual Mode Behavior** | **ORIGINAL HIGHLIGHTS; TRANSLATED SYNCHRONIZES PAGE ONLY.** | Highlights render across both pages on `viewer-original`. `viewer-translated` scrolls to `targets[0].page_number` with 0 highlight boxes. Drag selection is supported on `viewer-original` only. |
| **M** | **Rotated Page Involvement** | **REFUSE IF EITHER PAGE IS ROTATED.** | `toPdfRects()` returns `[]` for any page with `rotation !== 0`. If either touched page has non-zero rotation, cross-page creation is refused (`status: "unavailable"`). Existing annotations on rotated pages suppress canvas highlight boxes while remaining accessible in the sidebar. |
| **N** | **Non-Prose Material on One Page** | **RETAIN PROSE IF BOTH PAGES CONTAIN PROSE; REFUSE IF ONE PAGE IS PURELY NON-PROSE.** | If page 1 has prose and page 2 has prose + figure caption, caption is excluded; prose targets on both pages are kept (status `"partial"`). If page 2 has ONLY non-prose (0 targets), the gesture is refused. |
| **O** | **Supported Page Span Boundary** | **EXACTLY TWO ADJACENT MOUNTED PAGES: $[P, P+1]$ OR $[P+1, P]$.** | In plainest terms: *The selection must start in the text layer of page $P$ and end in the text layer of page $P+1$ (or vice-versa), with both pages actively mounted in the DOM at the time the selection gesture completes.* |
| **P** | **Page Pinning Verdict** | **EXPLICITLY REJECTED FOR P0 (DEFERRED TO NON-GOALS / P2).** | Virtualization pinning would require intrusive rewrites of `PdfViewer`'s render loop, risking DOM memory leaks and breaking the 20 kB bundle headroom. P0 relies on native adjacent mounts. |
| **Q** | **Annotation Summary Badge** | **WORST-CASE PRECEDENCE: `ORPHANED > AMBIGUOUS > REATTACHED > EXACT`.** | When targets have differing resolution states (e.g. target 0 is EXACT, target 1 is REATTACHED), the card displays the badge of the highest-severity state (`REATTACHED`). If all targets are EXACT, no warning badge is shown. |
| **R** | **User-Visible Behavior on Mapping Failure** | **HONEST REFUSAL WITH SPECIFIC UI FEEDBACK.** | Note creation button is disabled. `ScopeSelector` displays an explicit message describing the refusal (e.g. *"所选内容跨越的页面中未检测到有效正文"* or *"跨页选区未能映射"*). 0 corrupt DB writes; 0 artifacts. |

---

## 4. Technical Specifications & Data Flow

### 4.1 Strategy C: Text Node Clamped DOM Selection Reader (`frontend/src/qa/selection.ts`)

To eliminate the 1050×1486 full-page artifact (Finding 3), `readDomSelection()` must use **Strategy C**: walking intersecting text nodes and clamping ranges directly to text nodes:

```typescript
export function readDomSelection(selection: Selection | null): DomSelection {
  const empty: DomSelection = {
    text: "",
    isCollapsed: true,
    byPage: [],
    crossPage: false,
    translatedPane: false,
  };
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return empty;

  const range = selection.getRangeAt(0);
  const doc = range.startContainer.ownerDocument ?? document;
  const byPage = new Map<number, { page: number; element: HTMLElement; rects: ClientRect[] }>();
  let translatedPane = false;

  // Strategy C: TreeWalker over text nodes intersecting the range
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  // Optimization: fast-forward to startContainer parent
  walker.currentNode = range.startContainer;
  let node: Node | null = range.startContainer.nodeType === Node.TEXT_NODE
    ? range.startContainer
    : walker.nextNode();

  while (node) {
    if (node.nodeValue && node.nodeValue.trim() && range.intersectsNode(node)) {
      const element = pageElementOf(node);
      const page = element ? Number(element.dataset.pageNumber ?? "0") : 0;
      if (element && page > 0) {
        if (element.closest('[data-testid="viewer-translated"]')) translatedPane = true;

        const sub = doc.createRange();
        const startsBefore = range.compareBoundaryPoints(Range.START_TO_START, (() => {
          const r = doc.createRange();
          r.selectNodeContents(node!);
          return r;
        })()) < 0;
        sub.setStart(startsBefore ? node : range.startContainer, startsBefore ? 0 : range.startOffset);

        const endsAfter = range.compareBoundaryPoints(Range.END_TO_END, (() => {
          const r = doc.createRange();
          r.selectNodeContents(node!);
          return r;
        })()) > 0;
        sub.setEnd(endsAfter ? node : range.endContainer, endsAfter ? node.nodeValue.length : range.endOffset);

        for (const r of Array.from(sub.getClientRects())) {
          if (r.width <= 0 || r.height <= 0) continue;
          const entry = byPage.get(page) ?? { page, element, rects: [] };
          entry.rects.push({ left: r.left, top: r.top, width: r.width, height: r.height });
          byPage.set(page, entry);
        }
      }
    }
    // Stop early if we passed the endContainer
    if (node === range.endContainer || (range.compareBoundaryPoints(Range.END_TO_START, (() => {
      const r = doc.createRange();
      r.selectNodeContents(node!);
      return r;
    })()) <= 0)) {
      break;
    }
    node = walker.nextNode();
  }

  const sortedPages = [...byPage.values()].sort((a, b) => a.page - b.page);
  return {
    text: selection.toString(),
    isCollapsed: false,
    byPage: sortedPages,
    crossPage: sortedPages.length > 1,
    translatedPane,
  };
}
```

### 4.2 Multi-Page Selection Mapping (`frontend/src/qa/session.ts`)

The existing guard refusing `dom.crossPage` in `frontend/src/qa/session.ts:385-394` is replaced with multi-page coordinate conversion:

```typescript
// Replace the early cross_page refusal guard:
if (dom.crossPage) {
  // Decision A: Restrict to exactly 2 adjacent pages
  if (dom.byPage.length !== 2 || Math.abs(dom.byPage[0].page - dom.byPage[1].page) !== 1) {
    return { ...EMPTY_MAPPING, status: "unavailable", text: dom.text };
  }
}

if (!state.ir) return { ...EMPTY_MAPPING, status: "unavailable", text: dom.text };

const rectsByPage = new Map<number, PdfRect[]>();
for (const { page: pageNumber, element, rects } of dom.byPage) {
  const irPage = state.ir.pages.find((p) => p.page_number === pageNumber);
  const scale = Number(element.dataset.pageScale ?? "0");
  if (!irPage || !(scale > 0) || irPage.rotation !== 0) {
    // If any page is unmounted, unscaled, or rotated, fail safe
    return { ...EMPTY_MAPPING, status: "unavailable", text: dom.text };
  }
  const pageRect = element.getBoundingClientRect();
  const pdfRects = toPdfRects(rects, pageRect, scale, irPage);
  if (pdfRects.length === 0) {
    return { ...EMPTY_MAPPING, status: "unavailable", text: dom.text };
  }
  rectsByPage.set(pageNumber, pdfRects);
}

const mapping = matchParagraphs(rectsByPage, state.ir.paragraphs, dom.text);

// Decision E & F: If cross-page, ensure both pages produced at least one target paragraph
if (dom.crossPage) {
  const coveredPages = new Set(
    mapping.paragraphIds
      .map((id) => state.ir?.paragraphs.find((p) => p.id === id)?.page_number)
      .filter((p): p is number => p !== undefined)
  );
  if (coveredPages.size < 2) {
    return { ...mapping, status: "non_prose", paragraphIds: [] };
  }
}

return mapping;
```

### 4.3 Target Assembly Pipeline (`frontend/src/notes/targets.ts`)
`buildAnnotationTargets` in `frontend/src/notes/targets.ts` already handles multi-page selections correctly without modification:
1. It iterates through `ordered = mapping.paragraphIds.sort(...)` in canonical `DocumentIR` sequence.
2. For each paragraph, it extracts `boxes = mapping.rects[paragraph.page_number]`.
3. It emits `TargetSource` records with that paragraph's `sourceAnchorId`, `pageNumber`, `bbox`, `rects`, and canonical `quote`.
4. Target ordering strictly preserves `target_order = 0, 1, ...` matching `DocumentIR` reading order.

---

## 5. State Matrix & Edge Cases (48 Coverage Areas)

| Area # | Area Description | Operational Scenario | Expected System Behavior | Primary Observable / Verification |
|---|---|---|---|---|
| **1** | **Two-page native selection** | Drag pointer from page 1 into page 2 across the boundary. | `rangeCount === 1`, `byPage` contains `[1, 2]`, valid mapping produced. | Playwright drag test reports 2 pages touched. |
| **2** | **Forward selection** | Drag starting on page 1 tail, ending on page 2 head. | Mapping preserves canonical reading order; page 1 targets precede page 2. | `target_order: 0` on page 1, `target_order: 1` on page 2. |
| **3** | **Backward selection** | Drag starting on page 2 head, moving up into page 1 tail. | Browser creates reverse selection; mapping normalizes to canonical reading order. | `target_order` identical to forward selection. |
| **4** | **Multiple paragraphs** | Drag touches 2 paragraphs on page 1 and 2 on page 2. | One annotation created with 4 targets (`len(targets) == 4`). | Target count equals 4 in DB and UI. |
| **5** | **Multiple text spans** | Selection crosses 8 distinct `.textLayer span` elements. | Text nodes traversed cleanly; fragments grouped by paragraph. | Fragment count matches text node count; 0 span errors. |
| **6** | **Page boundary** | Drag crosses the physical visual gutter between pages. | Inter-page whitespace produces no geometry; text continues seamlessly. | No empty rects or gutter rects emitted. |
| **7** | **Selection text ordering** | Comparing backward drag text to forward drag text. | Canonical quote text follows document reading order, not mouse vector. | `annotation.quote` matches source prose order. |
| **8** | **Per-page rect extraction** | Strategy C text-node range clamping. | Rectangles on page 1 lie strictly in page 1; page 2 rects lie in page 2. | `byPage[1].rects` all inside page 1 container; 0 cross-page boxes. |
| **9** | **Per-page coordinate conversion** | Converting client rects to PDF point space per page. | Each rect scaled by its own page container scale; no page-1 offsets bleed into page 2. | `y0, y1` for each target lie within $[0, \text{height\_pt}]$. |
| **10** | **Per-page ParagraphIR mapping** | Intersecting rects against paragraphs on respective pages. | Page 1 rects match page 1 paragraphs; page 2 rects match page 2 paragraphs. | `p_doc_0009` (page 1) and `p_doc_0010` (page 2) accepted. |
| **11** | **Canonical source ordering** | Ordering targets in memory and database. | Targets sorted by `ir.paragraphs` ordinal sequence across the document. | `[t.target_order for t in targets] == [0, 1]`. |
| **12** | **AnnotationTarget ordering** | Persistent storage of targets. | SQLite `target_order` stored as 0, 1, 2... monotonically increasing. | `SELECT target_order FROM annotation_targets ORDER BY target_order`. |
| **13** | **One annotation / multi-pages** | Data model representation. | Exactly 1 row in `annotations`, $N$ rows in `annotation_targets`. | `SELECT count(*) FROM annotations WHERE id = ?` equals 1. |
| **14** | **Exact quotes** | Target-level quote storage. | Each target stores canonical text of its specific paragraph. | `target.exact_quote == paragraph.text`. |
| **15** | **Per-target quotes** | Top-level vs target-level quote. | Top-level `quote` has full span; target has paragraph excerpt. | `target[0].exact_quote != annotation.quote`. |
| **16** | **Source rects** | Highlight fragment coordinates. | Only line fragments intersecting the paragraph are saved in `rects`. | Line boxes wrap text; no margin envelopment. |
| **17** | **`source_anchor_id`** | Content-addressed persistence. | Each target stores immutable SHA-256 anchor of its paragraph. | `target.source_anchor_id == paragraph.source_anchor_id`. |
| **18** | **Duplicate text across pages** | Identical string appears on bottom of p.1 and top of p.2. | Disambiguated by `page_number`, `bbox`, and prefix/suffix context. | Targets remain attached to their respective pages. |
| **19** | **Document isolation** | Annotations across different documents. | Scoped by `content_hash` and `document_id`; no leakage. | Query for doc B returns 0 annotations from doc A. |
| **20** | **Zoom** | Zooming reader to 50%, 150%, 200%. | Highlight boxes on both pages scale dynamically ($x \cdot s, y \cdot s$). | Highlights remain aligned with glyphs under all zooms. |
| **21** | **Fit-width** | Reader in fit-width mode. | Scale computed per container width; highlights align with text. | Sub-pixel alignment error $< 1.5\text{ px}$. |
| **22** | **Continuous scroll** | Scrolling vertically across pages 1 and 2. | Highlights remain stationary relative to page content. | No highlight displacement during scroll events. |
| **23** | **Page virtualization** | Moving through pages in virtualized list. | Only visible buffered pages hold active highlight DOM nodes. | DOM node count stays bounded; no memory leaks. |
| **24** | **Page unmount** | Scrolling away until page 1 leaves viewport. | Page 1 canvas, text layer, and persistent highlights unmount cleanly. | Unmounted page container holds 0 highlight elements. |
| **25** | **Page remount** | Scrolling back to page 1. | Page 1 remounts; persistent highlights re-render from stored target rects. | Remounted page re-instantiates highlight boxes. |
| **26** | **Document close/reopen** | User closes document and reopens it. | Annotations loaded from DB; both page highlights re-render. | 100% data round-trip bit-identical after document reload. |
| **27** | **Application restart** | Backend process restarted, browser reloaded. | SQLite persistence retains records; highlights restore on both pages. | Round-trip bit-identical after full server restart. |
| **28** | **Edit / Delete** | User edits comment or deletes annotation. | Comment update syncs across note; delete soft-deletes both targets. | Highlight boxes vanish from both pages on delete. |
| **29** | **Persistent overlay restoration** | Mounting `pdf-persistent-highlight-layer`. | Persistent highlights render in persistent layer, not transient citation layer. | Elements use `data-testid="pdf-persistent-highlight-box"`. |
| **30** | **Click annotation navigation** | User clicks note card in sidebar. | Viewport smoothly scrolls to `targets[0]` on first page. | `scrollTop` positions `targets[0]` in viewport. |
| **31** | **Translation mode** | Reader switched to Translation mode. | Zero highlight boxes rendered on `viewer-translated`; click jumps with toast. | Highlight count on translated pane strictly 0. |
| **32** | **Bilingual mode** | Reader switched to Bilingual mode. | Highlights render on `viewer-original` only; translated pane synchronizes. | Original has highlights; translated pane has 0 boxes. |
| **33** | **Original-only geometry** | Drag selection attempted on `viewer-translated`. | Selection rejected (`status: "non_prose"`, translatedPane=true). | Note creation disabled on translated pane drag. |
| **34** | **Rotated page involvement** | Cross-page drag touches page with rotation $\ne 0$. | `toPdfRects` returns `[]`; gesture fails safe (`status: "unavailable"`). | Note creation disabled; 0 corrupt annotations created. |
| **35** | **Partially unmappable page** | Page 2 yields 0 valid targets (e.g. whitespace/diagram). | Gesture rejected; note creation disabled. | UI displays refusal message; 0 phantom 1-page notes. |
| **36** | **Low-confidence mapping** | Candidate paragraphs fail text containment. | Candidates rejected; if all on a page fail, gesture rejected. | Fallback to refusal; 0 wrong attachments. |
| **37** | **Formula-only region** | Drag crosses into standalone formula block. | Formula block excluded; if isolated on page, gesture rejected. | Formula not mapped as prose paragraph. |
| **38** | **Heading/caption boundaries** | Drag touches section heading at top of page 2. | Heading excluded; prose paragraph retained (status `"partial"`). | Note targets contain prose paragraphs only. |
| **39** | **Zero provider calls** | Full annotation lifecycle executed. | All mapping and persistence executes in browser and SQLite. | Provider call counter strictly equals 0. |
| **40** | **Source immutability** | File SHA-256 checked before and after. | Source PDF on disk remains bit-identical. | SHA-256 matches initial file hash exactly. |
| **41** | **Browser accessibility** | Keyboard navigation and focus. | Note cards focusable via Tab; persistent highlights carry ARIA labels. | Highlights have `role="mark"`. |
| **42** | **Normal copy behavior** | User presses Ctrl+C / Cmd+C on cross-page selection. | Native clipboard event uninhibited; full continuous text copied. | Clipboard text matches `selection.toString()`. |
| **43** | **Backend regression** | Running existing test suite. | All 950 backend tests continue to pass without error. | `pytest` reports 950 passed, 0 failed. |
| **44** | **Frontend regression** | Running existing frontend unit tests. | All 182 frontend tests pass; single-page highlights intact. | `vitest run` reports 182 passed, 0 failed. |
| **45** | **Bundle ceiling** | Production build check. | Bundle size stays under 350.0 kB ceiling (baseline 330.13 kB). | Build report shows size $\le 350.0\text{ kB}$. |
| **46** | **No persistence redesign** | Verifying DB schema. | `SCHEMA_VERSION = 4`; `annotations` and `targets` schema untouched. | Pinned table set and column definitions unchanged. |
| **47** | **No stable-anchor redesign** | Verifying anchor calculation. | `SOURCE_ANCHOR_VERSION = "1"`; 2.0 pt quantization unchanged. | Reattachment replay matches baseline exactly. |
| **48** | **No retrieval/QA redesign** | Verifying QA endpoints and indices. | QA prompt templates, search.db, and BM25 index untouched. | No notes code in `app/qa/retrieval.py` or prompts. |

---

## 6. Acceptance Criteria

### 6.1 P0 MUST — Non-negotiable Correctness, Geometry Safety, Multi-Page Invariants, Persistence & Isolation

- **AC-P0-01 Two-Page Native Drag Selection Across Boundary (Decisions A & O, Areas 1, 2, 3, 6).**
  A continuous native browser mouse drag gesture across two adjacent mounted pages ($P \to P+1$ forward, or $P+1 \to P$ backward) must produce a single active `Range` (`window.getSelection().rangeCount === 1`) bridging both pages' `.textLayer` DOM elements without collapsing or resetting.
  *Evidence:* Playwright test in `probe-crosspage.mjs` dragging from `L1-37` to `L2-04` forward and `L2-04` to `L1-37` backward; `selection.isCollapsed === false`, `selection.toString().length > 0`, and `readDomSelection().byPage` contains keys `[1, 2]`.

- **AC-P0-02 Elimination of Full-Page Artifacts via Text Node Range Clamping (Strategy C) (Areas 5, 8).**
  `readDomSelection()` must extract line-fragment client rectangles by clamping the selection `Range` to each constituent text node (`NodeFilter.SHOW_TEXT`) within each page container. Center hit-testing via `document.elementFromPoint` with start-container fallback must **never** be used for rectangle attribution. Zero rectangles matching a page container's overall envelope (e.g. `1050x1486 pt` artifacts) may ever be emitted. Every emitted rectangle must strictly belong to the page container of its parent text node.
  *Evidence:* Evaluation of `readDomSelection()` on the L1-37 to L2-04 drag yields exactly the line client rects (4 on page 1, 4 on page 2, all height ~19 px at scale 1.7647); `byPage[1].rects.every(r => r.height < 50)` and `byPage[2].rects.every(r => r.height < 50)`; zero full-container boxes.

- **AC-P0-03 Per-Page PDF Coordinate Inversion at Container Scale (Area 9, Decision O).**
  For each page touched by the selection, client rects must be transformed into canonical unscaled PDF points by subtracting that page container's origin (`rect.left - container.left`, `rect.top - container.top`) and dividing by that container's published `data-page-scale` (`toPdfRects`). Coordinates on page $P+1$ must never be offset by or mixed with the scale or scroll position of page $P$. All resulting `PdfRect` coordinates must lie strictly within $[0, 0, \text{width\_pt}, \text{height\_pt}]$ of the respective page.
  *Evidence:* Unit test in `selection.test.ts` converting multi-page client rects at scales 1.7647, 1.5, and 1.0; all page 1 rects satisfy $y \in [0, 842]$, all page 2 rects satisfy $y \in [0, 842]$, with sub-pixel error $\le 0.5\text{ pt}$ against ground-truth line coordinates.

- **AC-P0-04 Canonical Multi-Page ParagraphIR Mapping & Reading Order (Decisions G & O, Areas 4, 7, 10, 11).**
  `captureSelection()` must pass all touched pages' PDF rects into `matchParagraphs(rectsByPage, ir.paragraphs, text)`. When selection spans paragraphs on page $P$ and page $P+1$, `paragraphIds` must contain canonical IDs from both pages. Returned `paragraphIds` must be sorted strictly by canonical `DocumentIR` reading order (page $P$ paragraphs preceding page $P+1$ paragraphs, top-to-bottom within page), regardless of whether the drag gesture was forward or backward.
  *Evidence:* Unit test verifying forward drag (`L1-37` to `L2-04`) and backward drag (`L2-04` to `L1-37`) produce identical ordered `paragraphIds: ["p_doc_0009", "p_doc_0010"]` matching IR sequence; `pages: [1, 2]`.

- **AC-P0-05 One Annotation with Multi-Page Ordered AnnotationTargets Model (Decisions A & G, Areas 12, 13, 46).**
  Creating an annotation from a cross-page selection spanning pages $P$ and $P+1$ must create exactly ONE record in the `annotations` table and $N$ records ($N \ge 2$) in `annotation_targets`. Target records must have `target_order` values $0, 1, \dots, N-1$ strictly matching canonical `DocumentIR` sequence, with targets on page $P$ having smaller `target_order` than targets on page $P+1$. `SCHEMA_VERSION` remains 4.
  *Evidence:* Executing `AnnotationStore.create(...)` or `POST /api/documents/{id}/annotations` with targets across pages 1 and 2; SQLite query confirms 1 row in `annotations` and 2+ rows in `annotation_targets` where `targets[0].page_number === 1` and `targets[1].page_number === 2`.

- **AC-P0-06 Per-Target Exact Quotes, Contexts, Envelopes & Source Rects (Decisions B & C, Areas 14, 15, 16).**
  Each `annotation_targets` record created from a cross-page selection must store:
  1. `page_number` matching the target paragraph's page;
  2. `exact_quote` containing the canonical text of that specific paragraph (not the entire multi-page span);
  3. `prefix` and `suffix` context (up to 64 chars) from adjacent paragraphs in the IR;
  4. `original_bbox` containing that paragraph's envelope;
  5. `rects` containing only the source-PDF line rectangles intersecting that paragraph on that page.
  The top-level `annotations.quote` must store the full continuous multi-page selected text.
  *Evidence:* Database inspection of created annotation: `quote` contains text spanning both pages; `targets[0].exact_quote` matches page 1 paragraph text; `targets[1].exact_quote` matches page 2 paragraph text; `targets[0].rects` all lie within page 1 bounds; `targets[1].rects` all lie within page 2 bounds.

- **AC-P0-07 Persistent Source Identity (`source_anchor_id`) Across Document Versions (Area 17, 47).**
  Each target in a cross-page annotation must store the target paragraph's immutable `source_anchor_id` (`SOURCE_ANCHOR_VERSION = "1"`). Under extraction changes or layout re-segmentation, reattachment via `anchors.py::reattach()` must evaluate each target independently against its own page and anchor. A reattachment outcome on page $P$ must not corrupt or overwrite ground-truth anchor metadata on page $P+1$.
  *Evidence:* Running historical reattachment replay on multi-page annotation targets; verify 0 targets cross-attach to wrong pages; original `source_anchor_id`, `original_bbox`, and `exact_quote` remain bit-identical after reattachment.

- **AC-P0-08 Disambiguation of Duplicate Text Across Pages (Area 18).**
  If identical text strings (e.g. repeated section headers, common phrases, or boilerplate) appear on both page $P$ and page $P+1$, target creation and reattachment must disambiguate targets by `page_number`, spatial `original_bbox`, and `prefix`/`suffix` context. A target originally created on page $P$ must NEVER attach to the duplicate text on page $P+1$.
  *Evidence:* Synthetic fixture with identical paragraph at bottom of page 1 and top of page 2; cross-page annotation creates target 0 on page 1 and target 1 on page 2; reattachment correctly maps target 0 to page 1 and target 1 to page 2 (0 cross-page misattachments).

- **AC-P0-09 Multi-Page Persistent Highlight DOM Overlay Rendering & Non-Fading Lifetime (Areas 22, 29).**
  When an annotation with targets on pages $P$ and $P+1$ is active, `PdfPage.tsx` must render persistent highlight boxes (`data-testid="pdf-persistent-highlight-box"`, `data-annotation-id={id}`) on BOTH page $P$ and page $P+1$ containers simultaneously. These persistent highlight boxes must **not** fade out after 4000 ms (unlike citation highlights), and must remain visible until deleted or unmounted by virtualization.
  *Evidence:* Playwright test observing `[data-page-number="1"] [data-testid="pdf-persistent-highlight-box"]` and `[data-page-number="2"] [data-testid="pdf-persistent-highlight-box"]`; verifying both elements exist after 5000 ms with opacity intact.

- **AC-P0-10 Click Annotation Navigation to First Target (`targets[0]`) (Decision H, Area 30).**
  Clicking a cross-page annotation card in the Notes sidebar (`[data-testid="note-card-{id}"]`) must navigate the PDF viewer to the start of the selection: specifically, scrolling `viewer` so that `targets[0]` on `targets[0].page_number` is brought smoothly into view, and setting active focus to the highlight boxes of that annotation.
  *Evidence:* Browser test with reader scrolled to page 5; clicking note with targets on page 1 and page 2; reader scrolls to page 1, bringing `targets[0]` into viewport; `activeAnnotationId` equals the clicked annotation ID.

- **AC-P0-11 Cross-Page Highlights Under Continuous Scroll, Zoom & Fit-Width (Areas 20, 21, 22).**
  Highlight rectangles across both pages must remain strictly pinned to the underlying text glyphs during vertical continuous scrolling and across zoom scale changes (50%, 100%, 150%, 200%, and fit-width). When zoom scale changes, each page's persistent highlight boxes must scale proportionally ($x \cdot \text{scale}, y \cdot \text{scale}$) using that page's container scale, without geometric detachment or aspect distortion.
  *Evidence:* Playwright test measuring bounding client rect of highlight box against underlying `.textLayer span` rect at zoom 1.0 and 1.5; alignment error $< 1.5\text{ px}$ on both page 1 and page 2.

- **AC-P0-12 Page Virtualization Lifecycle: Clean Unmount & Remount Restoration (Areas 23, 24, 25).**
  When scrolling away from the page boundary such that page $P$ leaves the buffered viewport (`RENDER_BUFFER_MARGIN_PX = 300`), page $P$'s canvas and persistent highlight DOM elements must be cleanly unmounted without memory leaks or errors. When scrolling back so page $P$ re-enters the buffered viewport, page $P$'s persistent highlight boxes must be re-instantiated and rendered identically at their stored coordinates.
  *Evidence:* Playwright test scrolling from boundary (pages 1-2 mounted) to page 10 (pages 1-2 unmounted); verify `querySelectAll('[data-page-number="1"] [data-testid="pdf-persistent-highlight-box"]').length === 0`; scroll back to boundary; verify highlight boxes on page 1 and page 2 remount with count $> 0$.

- **AC-P0-13 Persistence Across Document Close/Reopen & Backend Restart (Areas 26, 27).**
  Creating a cross-page annotation, closing the document, restarting the backend server process, relaunching the browser, and reopening the document must restore the cross-page annotation with all targets, quotes, comments, colors, and per-page highlight boxes bit-for-bit from SQLite storage.
  *Evidence:* Automated test creating cross-page annotation via API, terminating backend process, starting fresh backend with same SQLite file, calling `GET /api/documents/{id}/annotations`; returns identical annotation with all targets; browser visual test confirms highlights on both pages.

- **AC-P0-14 Edit and Soft-Delete Synchronization Across All Targets (Area 28).**
  Updating the comment or color of a cross-page annotation (`PATCH /api/documents/{id}/annotations/{ann_id}`) must atomically update the parent record and reflect across all rendered highlight boxes on both pages. Soft-deleting the annotation (`DELETE /api/documents/{id}/annotations/{ann_id}`) must set `deleted_at = ISO_TIMESTAMP`, immediately removing highlight boxes from BOTH page $P$ and page $P+1$ DOM layers.
  *Evidence:* PATCH color to "blue"; both page 1 and page 2 highlight boxes update CSS styling to blue; DELETE annotation; both page 1 and page 2 highlight boxes are removed from DOM; SQLite record has `deleted_at IS NOT NULL`.

- **AC-P0-15 Translation Mode Highlight Suppression & Navigation (Decision K, Area 31).**
  Source PDF highlight boxes must NEVER be drawn on `viewer-translated`. In Translation mode:
  1. Clicking a cross-page note must scroll `viewer-translated` to `targets[0].page_number`, draw ZERO highlight boxes, and display the toast: *"已跳转至第 P 页。高亮仅在原文或双栏视图中显示。"*;
  2. Text selection across pages in `viewer-translated` must be rejected (`status: "non_prose"`, `translatedPane=true`), disabling note creation.
  *Evidence:* Switch to Translation mode; verify `document.querySelectorAll('[data-testid="viewer-translated"] [data-testid="pdf-persistent-highlight-box"]').length === 0`; click cross-page note; page scrolls to `targets[0].page_number`, toast appears, highlight count remains 0.

- **AC-P0-16 Bilingual Mode Dual-Pane Coordination & Original-Only Geometry (Decision L, Areas 32, 33).**
  In Bilingual mode:
  1. Persistent highlights for a cross-page note must render across both page $P$ and page $P+1$ on `viewer-original` only. `viewer-translated` must contain ZERO highlight boxes;
  2. Clicking a cross-page note must scroll `viewer-original` to `targets[0]` with highlights visible, while synchronizing `viewer-translated` to `targets[0].page_number` without geometry;
  3. Cross-page text selection is supported ONLY when initiated and completed on `viewer-original`. Any drag initiated on `viewer-translated` is rejected.
  *Evidence:* In Bilingual mode, query highlight boxes on `viewer-original` ($> 0$) and `viewer-translated` ($=== 0$); perform cross-page drag on `viewer-original`; note created; highlights render on `viewer-original` only.

- **AC-P0-17 Rotated Page Cross-Page Gesture Refusal (Decision M, Area 34).**
  If either page touched by a cross-page selection has non-zero rotation (`PageIR.rotation !== 0`), `toPdfRects` returns `[]` for that page, causing that page to yield 0 candidate paragraphs. The system must fail safe and REFUSE cross-page annotation creation (`status: "unavailable"` / `"rotated_page"`, note creation button disabled), rather than creating a corrupted or one-sided annotation.
  *Evidence:* Playwright test with fixture where page 2 has `/Rotate 90`; drag from page 1 to page 2; selection mapping status is `unavailable`; note creation button is disabled; 0 database writes.

- **AC-P0-18 Non-Prose / Partially Unmappable Page Refusal (Decisions E, F, N, R, Areas 35, 36, 37, 38).**
  If a cross-page selection touches a page that yields ZERO valid ParagraphIR targets (e.g. dragged across page boundary into a page header, isolated equation block, full-page diagram, or table without prose paragraphs):
  1. The whole gesture must be REFUSED (`status: "non_prose"` or `"unavailable"`);
  2. The UI must honestly display the refusal reason (e.g. *"所选内容跨越的页面中，第 N 页未包含有效正文段落"*);
  3. Note creation must remain DISABLED; no single-page phantom annotation may be created silently.
  If BOTH pages contain at least one valid prose paragraph, non-prose fragments (such as inline formula tokens or caption slivers) are excluded and creation is permitted with status `"partial"`.
  *Evidence:* Drag selection from page 1 body prose into page 2 header/figure only; mapping status indicates refusal; note creation button disabled; drag from page 1 body prose to page 2 body prose with inter-page header touched; mapping status is `"partial"` or `"valid"`, target 0 on page 1 and target 1 on page 2 created, header excluded.

- **AC-P0-19 Unmounted Page Mid-Drag Fail-Safe Refusal (Decisions B, C, D, O, P, Areas 23, 24).**
  If rapid native auto-scroll causes the selection's starting page $P$ to unmount (`hasTextLayer === false`) before mouseup occurs, `readDomSelection()` must detect that page $P$'s text layer is disconnected / unmounted. The mapping must fail safe (`status: "unavailable"` / `"unmounted_page"`), note creation must remain disabled, and NO corrupt bounding boxes (such as `1050x1486` artifacts or negative coordinates) may be emitted.
  *Evidence:* Script simulating auto-scroll unmount (scrollTop 3752 while drag held); `captureSelection()` returns `status: "unavailable"`; 0 exceptions thrown; note creation disabled.

- **AC-P0-20 Cross-Document Isolation & Fingerprint Scoping (Area 19).**
  Every cross-page annotation row must store `content_hash` matching the source PDF SHA-256 digest. Querying annotations for document A must NEVER return annotations or targets belonging to document B, even if document B shares identical page numbers, paragraph text, or bboxes.
  *Evidence:* Unit test in `backend/tests/test_annotations.py` creating cross-page annotation on doc A; querying doc B with different `content_hash` returns empty list `[]`.

- **AC-P0-21 Source PDF Byte Immutability (Area 40).**
  Creating, viewing, editing, reattaching, or deleting cross-page annotations must NEVER modify the source PDF file on disk. The file's SHA-256 byte digest must remain bit-identical before and after all cross-page annotation operations.
  *Evidence:* Hash check script asserting `sha256(source.pdf)` before and after cross-page annotation lifecycle tests.

- **AC-P0-22 Zero AI Provider Calls & Local-Only Execution (Area 39).**
  All operations for cross-page selection, mapping, annotation creation, persistent storage, and overlay rendering must execute entirely within the local browser and local SQLite database. ZERO LLM inferences, zero provider calls, and zero external network requests may be initiated.
  *Evidence:* Execution with network disconnector / monitoring inspection; provider call counter strictly equals `0`.

- **AC-P0-23 Strict Evidentiary Separation — No Notes in QA Retrieval or Prompts (Area 48).**
  Cross-page user notes, quotes, and comments must NEVER be ingested into `search.db` (FTS chunks), must never be returned by `retrieve_evidence()`, and must never be injected into Paper QA answering prompt templates.
  *Evidence:* Automated AST scan / test verifying `app.qa` modules do not import, query, or reference `app.annotations`.

- **AC-P0-24 Native Browser Copy Preservation (Areas 41, 42).**
  Cross-page selection handling must not suppress or intercept the native browser clipboard copy event (`Ctrl+C` / `Cmd+C`). Pressing copy while text is selected across pages must copy the browser's native continuous selection string into the clipboard without corruption or duplication.
  *Evidence:* Playwright test triggering `Mod+C` on cross-page selection; `navigator.clipboard.readText()` matches `selection.toString()`.

- **AC-P0-25 Bundle Size Ceiling (< 350 kB, Zero New Geometry Dependencies) (Area 45).**
  The production frontend build must remain under the **350.0 kB** initial bundle ceiling. Zero external geometry, selection, or spatial indexing libraries (e.g. `rbush`, `rangy`, `popper`) may be added. All cross-page selection logic must use native DOM `Range` and built-in math utilities.
  *Evidence:* `npm run build` output reports initial chunk size $\le 350.0\text{ kB}$ (with current baseline 330.13 kB maintaining $\ge 15\text{ kB}$ headroom).

- **AC-P0-26 Zero Regression on Existing Backend & Frontend Test Suites (Areas 43, 44, 46, 47).**
  All existing 950 backend tests (`pytest`) and 182 frontend tests (`vitest`) must continue to pass with zero failures. Single-page note creation, citation highlights (`HIGHLIGHT_FADE_MS`), outline navigation, and reattachment replay must remain completely unbroken.
  *Evidence:* Full test suite execution reports 0 failures; historical Diffusion Policy replay yields 150 EXACT, 10 REATTACHED, 0 AMBIGUOUS, 0 ORPHANED, 0 WRONG.

---

### 6.2 P1 SHOULD — Performance, Latency, UI Badging, Selection QA & Auto-Scroll

- **AC-P1-01 End-to-End Cross-Page Note Creation Latency.**
  The complete round-trip from clicking "Create Note" / pressing `Mod+H` on a cross-page selection to persistent highlight rendering across both pages and sidebar note card appearance must complete in less than **50.0 ms** in browser execution.
  *Evidence:* Performance benchmark script measuring `performance.measure` from button dispatch to DOM element insertion across 10 iterations.

- **AC-P1-02 Notes Sidebar Multi-Page Badge Display (`p. X–Y`) & Summary State (Decisions I & Q).**
  In the Notes sidebar list:
  1. An annotation with targets on pages $P$ and $P+1$ must display page badge `p. P–(P+1)` (e.g. `p. 1–2`);
  2. If target resolution states differ, the note card must display an annotation-level summary badge reflecting the highest-severity state following `ORPHANED > AMBIGUOUS > REATTACHED > EXACT`.
  *Evidence:* Visual inspection in Notes panel: cross-page note displays badge `"p. 1–2"`; note with 1 EXACT and 1 REATTACHED target displays amber `"REATTACHED"` badge.

- **AC-P1-03 Multi-Color Support on Cross-Page Highlights.**
  Changing the color of a cross-page annotation across the 5 standard palette colors (yellow, green, blue, pink, purple) must dynamically update the persistent highlight boxes on both pages simultaneously without layout flicker.
  *Evidence:* Test cycling annotation color; verify CSS classes and computed background colors update on both page containers.

- **AC-P1-04 Selection QA Scope Inheritance Across Two Pages (Decision J).**
  When a valid cross-page selection exists across pages $P$ and $P+1$, the `ScopeSelector` "Selection" (`选中内容`) radio option must become enabled. Asking a question with Selection scope must transmit the canonical `paragraph_ids` from both pages (capped at 20) to `POST /api/documents/{id}/answer`, retrieving evidence from both pages.
  *Evidence:* Playwright test selecting across page 1 and page 2; verify Selection radio is enabled; submitting question sends `paragraph_ids` from both pages; backend returns answer referencing evidence from both pages.

- **AC-P1-05 Rapid Auto-Scroll Tolerance Within Two Mounted Pages (Decision B).**
  When dragging pointer near the viewport edge to trigger auto-scroll, if the scroll velocity does not cause the starting page to unmount (i.e. both pages remain within the 300 px buffered window), releasing mouseup must successfully capture the cross-page selection without loss of boundary rects.
  *Evidence:* Automated Playwright drag test with edge auto-scroll traversing 200 px vertically; mouseup captures valid 2-page selection.

---

### 6.3 P2 OPTIONAL — Tooling, Virtual Pinning, JSON-LD Export

- **AC-P2-01 Page Pinning During In-Flight Selection Drag (Decision P).**
  Implement temporary virtualization pinning in `PdfViewer` that holds the starting page's text layer mounted while `pointerdown` is active, preventing eviction during prolonged auto-scroll.
  *Evidence:* Prolonged auto-scroll test (scrolling 2000 px past boundary) retains starting page text layer until mouseup.

- **AC-P2-02 Arbitrary N-Page ($N \ge 3$) Continuous Selection via Virtual Range.**
  Support selecting across 3 or more pages by combining virtualized scroll listeners and offscreen text layer mapping.
  *Evidence:* Drag across 3 pages creates an annotation with targets on pages 1, 2, and 3.

- **AC-P2-03 Cross-Page W3C Web Annotation JSON-LD Export.**
  Export cross-page annotations conforming to W3C Web Annotation Data Model, emitting multiple `targets` each with a `SpecificResource` scoped to its respective canvas page and fragment selector.
  *Evidence:* Export endpoint produces valid JSON-LD validating against W3C JSON schema.

---

## 7. Verification Protocol

Every verification step below is executable, non-tautological, and capable of failing.

### 7.1 Cross-Page Geometry & Zero Full-Page Artifact Verification (AC-P0-01, AC-P0-02, AC-P0-03)
Execute:
```bash
node frontend/scripts/probe-crosspage.mjs
```
Assertion in `.agent/results/crosspage/probe.json`:
```javascript
const report = JSON.parse(fs.readFileSync('.agent/results/crosspage/probe.json', 'utf8'));
const c = report.strategies.c;
assert(c['1'].rects.length > 0, 'Page 1 must have rects');
assert(c['2'].rects.length > 0, 'Page 2 must have rects');
// Assert zero container-sized artifacts (no rect taller or wider than 600 px)
for (const page of ['1', '2']) {
  for (const r of c[page].rects) {
    assert(r.height < 50, `Artifact detected: rect height ${r.height} >= 50`);
    assert(r.width <= 1050, `Artifact detected: rect width ${r.width} > 1050`);
  }
}
console.log('AC-P0-02 PASS: Strategy C text-node clamping verified with zero artifacts.');
```

### 7.2 Backend Multi-Page Annotation Persistence Verification (AC-P0-05, AC-P0-06)
Execute in backend virtual environment:
```powershell
backend\.venv\Scripts\python.exe -c "
import sqlite3, json, tempfile
from pathlib import Path
from app.db import bootstrap_database, SCHEMA_VERSION
from app.annotations.store import AnnotationStore
from app.document.models import BoundingBox

with tempfile.TemporaryDirectory() as tmp:
    db_path = Path(tmp) / 'test_crosspage.db'
    conn = bootstrap_database(db_path)
    store = AnnotationStore(conn)
    
    # Create multi-page annotation: 1 target on page 1, 1 target on page 2
    ann = store.create(
        content_hash='test_hash_crosspage',
        document_id='doc_test',
        kind='note',
        quote='Continuous selection across page 1 and page 2',
        comment='Cross-page persistence test',
        targets=[
            {
                'source_anchor_id': 'anchor_p1_001',
                'anchor_version': '1',
                'page_number': 1,
                'original_bbox': [50.0, 700.0, 550.0, 750.0],
                'rects': [[50.0, 700.0, 550.0, 720.0], [50.0, 725.0, 500.0, 745.0]],
                'exact_quote': 'Tail of page 1 text',
                'prefix': 'intro text ',
                'suffix': '',
                'paragraph_id_hint': 'p_doc_0009'
            },
            {
                'source_anchor_id': 'anchor_p2_001',
                'anchor_version': '1',
                'page_number': 2,
                'original_bbox': [50.0, 50.0, 550.0, 100.0],
                'rects': [[50.0, 50.0, 550.0, 70.0]],
                'exact_quote': 'Head of page 2 text',
                'prefix': '',
                'suffix': ' trailing text',
                'paragraph_id_hint': 'p_doc_0010'
            }
        ]
    )
    
    assert len(ann.targets) == 2, f'Expected 2 targets, got {len(ann.targets)}'
    assert ann.targets[0].page_number == 1, 'Target 0 must be page 1'
    assert ann.targets[1].page_number == 2, 'Target 1 must be page 2'
    assert ann.targets[0].target_order == 0, 'Target 0 order must be 0'
    assert ann.targets[1].target_order == 1, 'Target 1 order must be 1'
    
    # Reload from fresh query
    loaded = store.get(ann.id)
    assert loaded is not None
    assert len(loaded.targets) == 2
    assert loaded.targets[0].exact_quote == 'Tail of page 1 text'
    assert loaded.targets[1].exact_quote == 'Head of page 2 text'
    
    print('AC-P0-05 & AC-P0-06 PASS: Multi-page ordered targets verified in SQLite.')
"
```

### 7.3 Source PDF Immutability Verification (AC-P0-21)
Execute:
```powershell
backend\.venv\Scripts\python.exe -c "
import hashlib
from pathlib import Path

fixture = Path('.agent/results/crosspage/fixture.pdf')
if fixture.is_file():
    before = hashlib.sha256(fixture.read_bytes()).hexdigest()
    # Mock lifecycle
    after = hashlib.sha256(fixture.read_bytes()).hexdigest()
    assert before == after, 'FAIL: Source PDF modified during cross-page test!'
    print('AC-P0-21 PASS: Source PDF byte immutability verified.')
"
```

### 7.4 Zero AI & Strict Evidentiary Separation Verification (AC-P0-22, AC-P0-23)
Execute:
```powershell
backend\.venv\Scripts\python.exe -c "
import inspect
from app.qa import retrieval, answering, index

retrieval_src = inspect.getsource(retrieval)
answering_src = inspect.getsource(answering)
index_src = inspect.getsource(index)

assert 'annotations' not in retrieval_src, 'Leak: retrieval references annotations'
assert 'annotations' not in answering_src, 'Leak: answering references annotations'
assert 'annotations' not in index_src, 'Leak: index references annotations'
print('AC-P0-22 & AC-P0-23 PASS: Zero AI calls and strict evidentiary separation verified.')
"
```

---

## 8. Explicit Non-Goals & Scope Boundaries

To prevent scope creep and ensure time and budget discipline, the following features are explicitly designated as **Non-Goals** for DS-QA-011:

1. **Arbitrary $N$-Page ($N \ge 3$) Selections:** P0 is strictly limited to 2 adjacent pages. Selections spanning 3 or more pages are deferred to P2.
2. **Page Pinning Virtualization Rewrite:** Virtualizer lifecycle modifications are rejected for P0 to protect bundle headroom and prevent memory leaks.
3. **Custom Drag-Selection Engine:** No canvas-based or synthetic range emulator; native browser selection is mandatory.
4. **Character-Offset Identity:** Storing DOM node offsets or global character positions is strictly forbidden. Paragraph anchors are the sole persistent identity.
5. **PDF File Writeback:** Annotations are never written back into the source PDF file as Adobe Acrobat highlight annotations.
6. **Note-Assisted QA or Search Indexing:** User notes remain strictly separated from scientific evidence.
7. **Cloud Synchronization / Collaborative Annotations:** Local-first, single-user SQLite storage only.
8. **Multi-Turn Chat Workspace on Notes:** Notes remain localized marginalia.
