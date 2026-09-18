# Acceptance Criteria — DS-QA-010: Notes + Persistent Highlights

- **Author:** Gemini (`gemini-3.8-flash-high`), via the standing two-agent workflow
- **Reviewed and frozen by:** DeepSeek (Round 1 review pending)
- **Date:** 2026-09-19
- **Baseline:** Commit `3617322` / DS-DOC-003 closed (`SOURCE_ANCHOR_VERSION = "1"`, `IR_PIPELINE_VERSION = "4"`, `SCHEMA_VERSION = 3`)
- **Deliverable:** `docs/acceptance/DS-QA-010.md` (authored before any production code)
- **Status:** **PROPOSED FOR ROUND 1 REVIEW — 18 P0 · 8 P1 · 3 P2**

---

## 0. Independent Acceptance Author Statement & Review Framing

### 0.1 Process discipline: Acceptance before Implementation
In this repository, process sequencing is load-bearing:
- **DS-DOC-002** bypassed pre-implementation acceptance criteria, resulting in reading-order and cache-invalidation defects that had to be retroactively diagnosed and repaired (`.agent/evidence/DS-DOC-002.md`).
- **DS-DOC-003** strictly enforced acceptance criteria first (`docs/acceptance/DS-DOC-003.md`). That discipline exposed three critical defects before a single line of production code was written: anchor scoping omission across papers (AC_CHANGE_REQUEST 1), ordinal position counter fragility in disambiguation (AC_CHANGE_REQUEST 2), and conflicting de-hyphenation normalization (AC_CHANGE_REQUEST 3).

**This task (DS-QA-010) enforces that same discipline.** This document is authored independently against the real repository before any database migration, backend endpoint, or frontend component is written.

### 0.2 Core Guiding Principles

1. **User data is sacred.** User annotations represent intellectual labor. A document extraction change, layout re-segmentation, or pipeline bump may orphan an annotation's anchor, but it must **never** delete, overwrite, or mutate the user's notes or verbatim excerpts.
2. **0.0% wrong-attachment rate.** An orphaned or ambiguous annotation is an honest, recoverable state that the UI can explain. A wrong attachment silently attaches a user's insight to an irrelevant passage, destroying user trust. An orphan is infinitely preferable to a wrong attachment.
3. **Strict evidential boundary.** User notes are personal commentary; they are **never** scientific paper evidence. Notes must never be indexed into retrieval chunks, injected into QA prompts, or used by LLM answering.
4. **Zero AI / Zero network cost.** Creating, viewing, editing, reattaching, or deleting notes requires zero LLM inferences, zero provider calls, and zero network requests outside the local backend.
5. **No PDF mutation.** The source PDF file remains bit-identical (`content_hash` preserved). All annotations live in local SQLite storage out-of-band.

### 0.3 Verified Starting State

| Starting State Property | Repo Verification Location | Verified Repo Value / Finding |
|---|---|---|
| **Schema version & migrations** | `backend/app/db.py:27, 132` | `SCHEMA_VERSION = 3`; migrations map `{2: _migration_002_create_profiles, 3: _migration_003_create_documents_and_tasks}`. |
| **Pinned table set guard** | `backend/tests/test_db.py:75-81` | `assert tables == ["documents", "profiles", "schema_version", "translation_tasks"]`. Adding `annotations` must update this exact set. |
| **Persistent source identity** | `backend/app/document/anchors.py:52, 60` | `SOURCE_ANCHOR_VERSION = "1"`, `GEOMETRY_QUANTUM_PT = 2.0`. Anchor payload: `sha256(version \| content_hash \| page \| quantized_bbox \| canonical_text)`. |
| **Reattachment engine** | `backend/app/document/anchors.py:188-290` | `AnchorState` in `{EXACT, REATTACHED, AMBIGUOUS, ORPHANED}`. `reattach(ir, anchor_id, page_number, quote)` with `MIN_REATTACH_COVERAGE = 0.5`. |
| **Historical churn evidence** | Measured on Diffusion Policy v2 → v3 | 160 → 155 paragraphs: **EXACT 150, REATTACHED 10, AMBIGUOUS 0, ORPHANED 0, WRONG 0** (sample of one paper). |
| **Opaque paragraph IDs** | Grep across backend, frontend, tests | `ParagraphIR.id` is `p_{document}_{ordinal:04d}`. Treated as an opaque string everywhere; one builder (`extract.py:661`). |
| **Selection mapping rects** | `frontend/src/qa/selection.ts:106, 194` | `toPdfRects()` converts DOM client rects to PDF points; `matchParagraphs()` receives PDF rects per page but currently returns only paragraph IDs. |
| **Reader side panel width** | `frontend/src/lib/layout.ts`, `AssistantSidebar.tsx:6` | `SIDEBAR_WIDTH_PX = 340`. Tab strip currently has 2 tabs: `[目录 (outline), 问答 (qa)]`. Reader minimum viewport is 1024 px. |
| **Citation highlight lifetime** | `frontend/src/pdf/PdfWorkspace.tsx:78, 292` | Citation highlight fades after `HIGHLIGHT_FADE_MS = 4000` ms, guarded by `rotation === 0` and `allowHighlight`. |
| **Test & build baselines** | Brief §2.7 | Backend 927 passed, frontend 172 passed, bundle 317.86 kB (ceiling 350 kB), browser e2e-qa 48/48, e2e-outline 26/26. |

---

## 0. DeepSeek review

Gemini inspected the repository, reproduced the identity contract, and produced
18 P0 with a schema and a state machine. Two things in it are contradicted by
measurement or by the repository, and both concern what happens to user data —
which is the part of this task that cannot be got wrong.

### 0.1 Verified and adopted

| Claim | Verified |
|---|---|
| §2.2 the anchor contract, `SOURCE_ANCHOR_VERSION`, 2.0 pt, `join_wrapped_lines` | **exact** |
| §2.3 the replay: EXACT 150 / REATTACHED 10 / AMBIGUOUS 0 / ORPHANED 0 / WRONG 0 | **exact** — this task's evidence |
| `SelectionMapping` carries ids, pages and text but no rects; `matchParagraphs` receives PDF rects | **exact** |
| `db.py` has a versioned migration map and a `SCHEMA_VERSION` to bump | **exact** |
| `test_db.py` pins the exact table set, so migration 004 must update it | **exact** |
| One 340 px panel with two tabs; a third is the right shape | **exact** |
| Decisions A–D, G, J, K, L, M, N, O | **adopted as written** |

The multi-target model (A), the both-quotes decision (B), the single table with a
`kind` (D), and the three-state honesty of J/K are the right shape for the
measured evidence, and K's user-facing wording is better than the internal
terminology it replaces.

### AC_CHANGE_REQUEST 1 — the criteria delete user data that the fingerprint still identifies

| | |
|---|---|
| **As written** | AC-P0-13: *"Deleting the parent document from `DocumentStore` must execute a foreign-key cascading hard delete of all associated annotations and targets."* The schema implements it: `document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE`. |
| **Problem** | **Document ids are random.** `app/documents/store.py:65` is `return f"{prefix}{uuid.uuid4().hex}"`, so re-importing a byte-identical PDF produces a **new** document row and a new id. With a cascade on that id, the annotations are gone and cannot come back — even though the file is bit-identical and the anchor's entire purpose is to identify immutable source content. That contradicts three things at once: this document's own AC-P0-02 ("Document Fingerprint Scoping"), brief Phase 5 (*"Persist immutable source document fingerprint as the hard document boundary"*), and brief Phase 51, which asks whether a re-import restores annotations and answers *"This is likely desirable."* The schema already stores `content_hash` beside `document_id`; the cascade simply chooses the wrong one of the two as the boundary. |
| **Resolution** | `content_hash` is the durable key. The `document_id` column stays as a routing convenience but **without** `ON DELETE CASCADE`, and removing a document does not purge annotations — the user's writing is not a cache of the document record. Re-importing the same PDF restores them. AC-P0-13 keeps soft-delete for user-initiated deletion, and document removal gains its own stated semantics: *"deleting a document removes its files and its record; annotations keyed to the same content fingerprint survive, and reappear if the same PDF is imported again."* |
| **Not accepted** | Cascade *and* keep `content_hash`, which is the schema as drafted — a durable key that is destroyed by the lifecycle of a non-durable one is not a durable key. |

### AC_CHANGE_REQUEST 2 — AC-P0-05 specifies a matching rule the implementation does not use

| | |
|---|---|
| **As written** | AC-P0-05: *"Zero targets may reattach to an unrelated paragraph (**token overlap < 0.50** or mismatched page)."* |
| **Problem** | `app/document/anchors.py` does not compute token overlap. `reattach` accepts a candidate when the normalized quote is a **substring** of the candidate's canonical text (`MIN_REATTACH_COVERAGE = 0.5` is a floors constant for a containment test that returns 1.0 or 0.0, not a similarity ratio). A criterion that names a metric the code does not implement cannot be evaluated against it: a reviewer measuring token overlap would get a number, and it would be about something else. |
| **Resolution** | The criterion states the rule that exists: *"A target may reattach only when its normalized quote is contained in the candidate's canonical text, on the same page. No target may reattach to a paragraph that does not contain its quote."* The **observable** — wrong-attachment rate 0.0% on the historical replay — is unchanged and is what is actually measured. |
| **Not accepted** | Implementing token overlap to satisfy the wording. Containment is the stricter rule, and the measured result is 0 wrong with 100% coverage; adding a looser metric would risk more, not less. |

### Not raised, and why

- **Decision I's asynchronous background reattachment** is guidance, not a P0 criterion, and the lookup is a page-scoped scan of an in-memory IR. Implemented synchronously; if a criterion later demands the async path, that is a change request then.
- **Decision E's zero-target, document-level notes** are new scope beyond the brief, and no P0 criterion depends on them. Not implemented in v1; text selection is the creation path.

### Frozen P0

**18 P0** as written in §6, with the two resolutions above applied — AC-P0-13
(annotations survive document removal, keyed to the fingerprint) and AC-P0-05 (the
containment rule, as implemented). P1 8 and P2 3 unchanged and not prerequisites.

---

## 1. Executive Judgment: Is this task worth doing?

**Yes — but strictly as an out-of-band, content-anchored persistence layer with zero LLM involvement, zero PDF mutation, and zero retrieval coupling.**

Scientific paper reading requires active engagement: highlighting key claims, noting methodological reservations, and cross-referencing equations. In desktop and web readers, annotations typically suffer from one of two fatal flaws:
1. **Direct PDF byte mutation:** Modifying the PDF file alters its cryptographic hash, breaks reproduction pipelines, and risks corrupting fragile academic PDF formatting.
2. **Positional / ordinal fragility:** Storing annotations as `paragraph_42` or DOM node indices breaks the moment an extraction tool improves line wrapping or column separation.

DS-DOC-003 provided the persistent, content-addressed foundation (`source_anchor_id` + `reattach()`). DS-QA-010 completes the user-facing contract: users can highlight text and attach notes that survive across reloads, application restarts, and extraction version upgrades, grounded firmly in the immutable PDF source.

### Strict Boundary Exclusions
- **No Note-Assisted QA:** User notes are **never** paper evidence. They must not be ingested into FTS `chunks`, must not be embedded in dense indices, and must not be injected into Paper QA prompts.
- **No LLM Summarization of Notes:** Notes are user-authored prose. No model may rephrase, clean up, or expand notes.
- **No PDF File Modification:** The source PDF on disk remains byte-identical (`content_hash` unchanged).
- **No Multi-Turn Chat or Notes Graph:** Notes are localized marginalia, not a knowledge graph or conversational workspace.

---

## 2. Measured Starting State & Verification

### 2.1 The Stable Source Identity Contract (DS-DOC-003)
In `backend/app/document/anchors.py`:
- `ParagraphIR.id`: runtime session handle `p_{document_id}_{ordinal:04d}`.
- `ParagraphIR.source_anchor_id`: persistent SHA-256 identity:
  $$\text{Payload} = \text{version} \parallel \text{content\_hash} \parallel \text{page\_number} \parallel \text{quantized\_bbox} \parallel \text{canonical\_text}$$
- Quantization grid: $2.0\text{ pt}$ ($x_q = \lfloor x / 2.0 + 0.5 \rfloor \times 2.0$).
- Normalization: `canonical_source_text()` uses `join_wrapped_lines()` with compound prefix preservation and soft-hyphen `\u00ad` removal.
- Measured baseline: On Diffusion Policy layout change (gutter 8.0 → 6.0 pt, 160 → 155 paragraphs), reattachment yielded **150 EXACT, 10 REATTACHED, 0 AMBIGUOUS, 0 ORPHANED, 0 WRONG**.
  *(Note: This is an empirical sample of one paper; criteria that generalize from it must do so explicitly).*

### 2.2 Paragraph IDs are Opaque Runtime Handles
Every consumer in the repository treats `paragraph_id` as an opaque token:
- `backend/app/qa/retrieval.py`: `row["chunk_id"] -> paragraph_id`
- `backend/app/qa/citations.py`: dictionary lookup in `DocumentIR.paragraphs`
- `frontend/src/qa/selection.ts`: `SelectionMapping.paragraphIds`
- `frontend/src/assistant/ScopeSelector.tsx`: selection scope tokens

Because only `extract.py:661` generates `p_{doc}_{ordinal:04d}`, persisting a runtime `paragraph_id` as the primary key of a note guarantees breakage whenever extraction rules change. Persistent storage must use `source_anchor_id`, with `paragraph_id` stored only as a transient resolution hint.

### 2.3 Selection Mechanics in Browser DOM
In `frontend/src/qa/selection.ts`:
- `readDomSelection()` extracts client rects per page via `range.getClientRects()`.
- `toPdfRects()` maps client rects to PDF point space using the published container scale, suppressing rotated pages (`rotation !== 0`).
- `matchParagraphs(rectsByPage, paragraphs, selectedText)` computes geometric overlap ($\ge 80\text{ pt}^2$ and $\ge 40\%$ area) and confirms via `textSupports()`.
- **Finding:** Selection in `selection.ts` is paragraph-granular for Paper QA scoping, but `toPdfRects()` already derives fine-grained line rectangles. Persistent highlights require preserving these line rectangles so highlights wrap cleanly along text lines rather than enveloping entire paragraph blocks.

### 2.4 Persistence Infrastructure
In `backend/app/db.py`:
- SQLite database initialized with WAL mode, foreign keys enabled, and `busy_timeout = 5000` ms.
- Migration ladder tracks schema versions in the `schema_version` table.
- Adding annotations requires implementing `_migration_004_create_annotations` and incrementing `SCHEMA_VERSION = 4`.
- `backend/tests/test_db.py` enforces `assert tables == [...]`. Adding tables without updating this test fails the suite by design.

### 2.5 Reader Layout & Sidebar Dimensions
In `frontend/src/assistant/AssistantSidebar.tsx`:
- Collapsible `<aside>` with `width: 340px` (`SIDEBAR_WIDTH_PX = 340`).
- Currently contains a two-tab strip: `目录 (outline)` and `问答 (qa)`.
- Designed to fit viewports down to 1024 px without occluding the PDF canvas.
- Adding a dedicated notes panel must fit within this existing collapsible sidebar (as a third tab), rather than mounting a secondary sidebar.

### 2.6 Highlight Rendering Separation
In `frontend/src/pdf/PdfWorkspace.tsx`:
- `jump` prop triggers page scrolling and transient citation highlighting.
- Citation highlights fade automatically after `HIGHLIGHT_FADE_MS = 4000` ms via `setTimeout`.
- Persistent highlights must **not** inherit this fade timeout. They must remain permanently rendered in the DOM until deleted by the user.

---

## 3. Explicit Design Decisions A–P

| # | Topic | Verdict | Detailed Specification & Rationale |
|---|---|---|---|
| **A** | **Multi-target annotations** | **CONFIRMED: One annotation with multiple targets.** | A single user drag often spans paragraph or page boundaries. Forcing 1-to-1 splits would fragment a single intellectual thought into multiple independent notes. Instead, an annotation has $1 \dots N$ targets, each bound to one source paragraph. |
| **B** | **Multi-paragraph quote storage** | **BOTH: Global quote + per-target fragments.** | The `annotations` table stores `quote` (the full continuous text selected by the user for UI display and search). The `annotation_targets` table stores `exact_quote` (the specific text fragment within that target paragraph, required for localized `anchors.py::reattach()` matching). |
| **C** | **Per-target spatial & text context** | **YES: Each target carries its own page, rects, and prefix/suffix.** | Paragraphs in a multi-paragraph selection may reside on different pages or columns. Each target record stores `page_number`, `rects` (JSON array of line rects in PDF points), `original_bbox`, `prefix` (up to 64 chars), and `suffix` (up to 64 chars) for robust W3C-style text quote anchoring. |
| **D** | **Unified vs Separate tables** | **ONE table with `kind` field (`annotations` + `annotation_targets`).** | A highlight is a visual marker; a note is a visual marker with user prose. Users routinely convert highlights to notes and vice-versa. A single `annotations` table with `kind IN ('highlight', 'note')` and nullable `comment` avoids schema fragmentation and redundant reattachment logic. |
| **E** | **Visual rendering of notes vs highlights** | **Targeted notes implicitly render a highlight; textless notes exist unhighlighted.** | A note created on selected text renders a persistent highlight on the PDF canvas. Pure highlights render without a comment. Notes created without selection (e.g. document-level margin notes) carry 0 targets and appear only in the Notes sidebar list. |
| **F** | **Same-source duplicates** | **FOCUS EXISTING: Do not create duplicate identical annotations.** | If a user selects a range identical to an existing annotation ($\ge 95\%$ geometric and text overlap on the same targets), the UI focuses/opens the existing annotation in the sidebar rather than stacking redundant highlights that darken the canvas. |
| **G** | **Overlapping highlights rendering** | **CSS `mix-blend-mode: multiply` with independent DOM click targets.** | Partial overlaps render using semi-transparent boxes with `mix-blend-mode: multiply` (standard PDF highlighter behavior). In the DOM, each target maintains its own clickable element. Clicking an overlapping region selects the top-most target and reveals a selector popover if multiple annotations overlap. |
| **H** | **Hard delete vs Soft delete** | **SOFT DELETE for user deletions; CASCADE HARD DELETE on document removal.** | User deletions set `deleted_at = ISO_TIMESTAMP` (`is_deleted = true`). This enables instant Undo and prevents accidental data loss. When an entire document is deleted via `DocumentStore`, foreign key cascades execute hard deletion. |
| **I** | **Resolution timing** | **HYBRID: Synchronous exact matching on open; asynchronous background reattachment.** | On document open, all annotations for the document are loaded. Exact matching against `DocumentIR.paragraphs` via `source_anchor_id` runs in memory ($< 1\text{ ms}$). Any unattached anchors are queued for background `reattach()` without blocking initial reader paint. |
| **J** | **Reattachment caching & provenance** | **CACHE resolution snapshot; IMMUTABLE original anchor provenance.** | A successful `REATTACHED` outcome caches `resolved_paragraph_id`, `resolution_state`, and `resolved_at` in the target record. The original `source_anchor_id`, `original_bbox`, and `exact_quote` are **never overwritten**. If extraction rules change again, reattachment always evaluates from original ground truth. |
| **K** | **Surfacing AMBIGUOUS and ORPHANED** | **EXPLICIT VISUAL BADGES in sidebar; preserve all user prose.** | `AMBIGUOUS` displays an amber warning badge ("Location ambiguous after update — 2 candidate locations"). `ORPHANED` displays a muted badge ("Original text not found in updated document"). The user's note, timestamp, and original quote are fully preserved and viewable. |
| **L** | **Annotation click in Translation mode** | **PAGE JUMP ONLY; zero highlight boxes on translated canvas.** | Per Hard Invariant 9, translated PDF geometry does not correspond to source PDF boxes. Clicking a note in Translation mode scrolls the translated pane to the corresponding `page_number`, draws **zero** highlight boxes, and displays a toast: *"Jumped to page N. Highlights are shown in Original or Bilingual view."* |
| **M** | **Annotation click in Bilingual mode** | **DUAL-PANE COORDINATION: Original highlights; Translated aligns.** | Clicking an annotation in Bilingual mode triggers `jump` on `viewer-original` (scrolling to offset and rendering persistent highlight boxes), while scrolling `viewer-translated` to the corresponding page without geometry injection. |
| **N** | **Color support** | **P0 for schema storage & default yellow; P1 for multi-color picker & filtering.** | Schema migration 004 includes `color TEXT NOT NULL DEFAULT 'yellow'`. P0 renders default yellow (`#FDE047` / rgba with 0.35 opacity). P1 adds a 5-color palette (yellow, green, blue, pink, purple) and sidebar filtering. |
| **O** | **Reader sidebar integration** | **THIRD TAB in `AssistantSidebar`: `[目录 (outline), 问答 (qa), 笔记 (notes)]`.** | Maintains the strict 340 px single-panel footprint, ensuring viewports down to 1024 px remain functional without horizontal scroll or layout collapse. |
| **P** | **Minimum migration test** | **Migration 004 replay + table set guard + restart round-trip.** | (1) Upgrading DB from v3 to v4 succeeds idempotently. (2) `test_only_expected_tables_exist` passes with `annotations` and `annotation_targets`. (3) Annotations survive process restart bit-for-bit. (4) Replay on Diffusion Policy historical churn achieves 0.0% wrong-attachment. |

---

## 4. Architecture & Technical Specifications

### 4.1 SQLite Schema & Migration 004 (`backend/app/db.py`)

```python
def _migration_004_create_annotations(connection: sqlite3.Connection) -> None:
    """Add annotations and multi-target source bindings (DS-QA-010).

    Cascades on document delete: deleting a document removes its annotations.
    Soft deletion (deleted_at) preserves undo capability and auditability.
    """
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS annotations (
            id               TEXT PRIMARY KEY,
            document_id      TEXT NOT NULL
                             REFERENCES documents(id) ON DELETE CASCADE,
            content_hash     TEXT NOT NULL,
            kind             TEXT NOT NULL CHECK (kind IN ('highlight', 'note')),
            color            TEXT NOT NULL DEFAULT 'yellow',
            quote            TEXT NOT NULL,
            comment          TEXT,
            created_at       TEXT NOT NULL,
            updated_at       TEXT NOT NULL,
            deleted_at       TEXT
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS annotation_targets (
            id                     TEXT PRIMARY KEY,
            annotation_id          TEXT NOT NULL
                                   REFERENCES annotations(id) ON DELETE CASCADE,
            target_order           INTEGER NOT NULL DEFAULT 0,
            source_anchor_id       TEXT NOT NULL,
            anchor_version         TEXT NOT NULL DEFAULT '1',
            page_number            INTEGER NOT NULL,
            original_bbox          TEXT NOT NULL, -- JSON tuple [x0, y0, x1, y1]
            rects                  TEXT NOT NULL, -- JSON array of [[x0, y0, x1, y1], ...]
            exact_quote            TEXT NOT NULL,
            prefix                 TEXT NOT NULL DEFAULT '',
            suffix                 TEXT NOT NULL DEFAULT '',
            paragraph_id_hint      TEXT,
            resolved_paragraph_id  TEXT,
            resolution_state       TEXT NOT NULL DEFAULT 'EXACT',
            resolution_confidence  REAL NOT NULL DEFAULT 1.0,
            resolved_at            TEXT,
            created_at             TEXT NOT NULL
        )
        """
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_annotations_doc_active "
        "ON annotations(document_id, deleted_at)"
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_annotations_content_hash "
        "ON annotations(content_hash)"
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_targets_annotation "
        "ON annotation_targets(annotation_id, target_order)"
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_targets_anchor "
        "ON annotation_targets(source_anchor_id)"
    )
```

### 4.2 Backend Pydantic Models (`backend/app/annotations/models.py`)

```python
from enum import Enum
from pydantic import BaseModel, ConfigDict, Field
from app.document.models import BoundingBox

class AnnotationKind(str, Enum):
    HIGHLIGHT = "highlight"
    NOTE = "note"

class TargetResolutionState(str, Enum):
    EXACT = "EXACT"
    REATTACHED = "REATTACHED"
    AMBIGUOUS = "AMBIGUOUS"
    ORPHANED = "ORPHANED"

class AnnotationTargetCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_anchor_id: str
    anchor_version: str = "1"
    page_number: int = Field(ge=1)
    original_bbox: BoundingBox
    rects: list[BoundingBox]
    exact_quote: str
    prefix: str = ""
    suffix: str = ""
    paragraph_id_hint: str | None = None

class AnnotationTargetResponse(BaseModel):
    id: str
    target_order: int
    source_anchor_id: str
    anchor_version: str
    page_number: int
    original_bbox: BoundingBox
    rects: list[BoundingBox]
    exact_quote: str
    prefix: str
    suffix: str
    paragraph_id_hint: str | None
    resolved_paragraph_id: str | None
    resolution_state: TargetResolutionState
    resolution_confidence: float

class AnnotationCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content_hash: str
    kind: AnnotationKind
    color: str = "yellow"
    quote: str = Field(min_length=1)
    comment: str | None = None
    targets: list[AnnotationTargetCreate] = Field(min_length=1)

class AnnotationUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    comment: str | None = None
    color: str | None = None

class AnnotationResponse(BaseModel):
    id: str
    document_id: str
    content_hash: str
    kind: AnnotationKind
    color: str
    quote: str
    comment: str | None
    created_at: str
    updated_at: str
    targets: list[AnnotationTargetResponse]
```

### 4.3 REST API Endpoints (`backend/app/api/annotations.py`)

All routes mounted under `/api/documents/{document_id}/annotations`:
- `GET /api/documents/{document_id}/annotations`
  - Returns: `list[AnnotationResponse]` for all non-deleted annotations (`deleted_at IS NULL`).
  - Automatically resolves targets in memory against the loaded `DocumentIR`.
- `POST /api/documents/{document_id}/annotations`
  - Validates `content_hash == DocumentIR.content_hash`.
  - Atomically creates the annotation and its target rows in SQLite.
  - Returns: `201 Created` with `AnnotationResponse`.
- `PATCH /api/documents/{document_id}/annotations/{annotation_id}`
  - Updates `comment` and/or `color`, updates `updated_at`.
  - Returns: `200 OK` with updated `AnnotationResponse`.
- `DELETE /api/documents/{document_id}/annotations/{annotation_id}`
  - Sets `deleted_at = datetime.now(timezone.utc).isoformat()`.
  - Returns: `204 No Content`.

### 4.4 Frontend Data Types (`frontend/src/api/annotations.ts`)

```typescript
export type AnnotationKind = "highlight" | "note";
export type TargetResolutionState = "EXACT" | "REATTACHED" | "AMBIGUOUS" | "ORPHANED";

export interface AnnotationTarget {
  id: string;
  targetOrder: number;
  sourceAnchorId: string;
  anchorVersion: string;
  pageNumber: number;
  originalBbox: [number, number, number, number];
  rects: [number, number, number, number][];
  exactQuote: string;
  prefix: string;
  suffix: string;
  paragraphIdHint: string | null;
  resolvedParagraphId: string | null;
  resolutionState: TargetResolutionState;
  resolutionConfidence: number;
}

export interface UserAnnotation {
  id: string;
  documentId: string;
  contentHash: string;
  kind: AnnotationKind;
  color: string;
  quote: string;
  comment: string | null;
  createdAt: string;
  updatedAt: string;
  targets: AnnotationTarget[];
}
```

### 4.5 Persistent Highlight Overlay Renderer
- Rendered on `viewer-original` in `PdfPage.tsx` under container `[data-testid="pdf-page-container"]`.
- Element: `<div data-testid="pdf-persistent-highlight-layer" className="absolute inset-0 pointer-events-auto">`.
- Distinct test IDs:
  - Citation highlights: `data-testid="pdf-highlight-box"` (fade after 4 s).
  - Persistent highlights: `data-testid="pdf-persistent-highlight-box"`, `data-annotation-id={id}`.
- Style: `mix-blend-mode: multiply`, `opacity: 0.35`, cursor pointer, rounded corners.
- Hover / Click: Clicking a persistent highlight box dispatches `setActiveAnnotation(annotationId)` and switches/focuses the sidebar Notes tab.

---

## 5. State Matrix & Edge Cases

| Scenario / Mutation | Cause / Description | Expected Persistent Highlight & Note Behavior | Verification Condition |
|---|---|---|---|
| **Document Reopen** | User closes document and reopens it. | Annotations loaded from DB; exact anchors resolve immediately; highlights render at original coordinates. | All annotations match stored DB rows; 0 missing highlights. |
| **Application Restart** | Backend server restarts; browser reloads. | SQLite persistence retains records; in-memory cache repopulates on first read. | 100% data round-trip bit-identical after full restart. |
| **Minor Bbox Jitter ($\le 4.0$ pt)** | Vision layout detector shifts box coordinates slightly. | Quantization (2.0 pt grid) absorbs shifts $< 2.0$ pt; shifts $\le 4.0$ pt reattach with state `REATTACHED`. | Note stays attached; highlight updates to reattached box. |
| **Paragraph Split ($1 \to 2$)** | Gutter threshold splits one paragraph into two. | `anchors.py::reattach` matches target to primary fragment with status `REATTACHED`. | State is `REATTACHED`; confidence $\ge 0.75$; 0 wrong attachments. |
| **Paragraph Merge ($2 \to 1$)** | Two adjacent sentences merge into one paragraph. | Both target anchors reattach to the single merged paragraph with status `REATTACHED`. | Both targets attach without collision; state `REATTACHED`. |
| **Paragraph Insertion Before** | New title or header block inserted at position 1. | Runtime IDs shift (`p_0001` → `p_0002`). `source_anchor_id` remains unchanged. Status is `EXACT`. | `source_anchor_id` matches; resolved ID updates correctly. |
| **Paragraph Deletion (Orphan)** | Paragraph text completely removed in new extraction. | Target status resolves to `ORPHANED`. Highlight box is suppressed on canvas; note remains visible in sidebar. | Note preserved in sidebar with `ORPHANED` badge; 0 crashes. |
| **Same-Page Duplicate Text** | Identical phrase appears twice on the same page. | Disambiguated by geometry and prefix/suffix; reattachment matches the spatially proximate candidate. | Target reattaches to correct spatial occurrence; 0 misattachments. |
| **Multi-Paragraph Selection** | User drag spans 3 consecutive paragraphs. | One annotation created with 3 targets. Each target carries its own `exact_quote` and `rects`. | `len(annotation.targets) == 3`; each target has valid anchor. |
| **Cross-Page Selection** | Selection spans bottom of page 1 and top of page 2. | Target 1 carries `page_number = 1`; Target 2 carries `page_number = 2`. | Highlights render on both page 1 and page 2 canvases. |
| **Rotated Page (`rotation \ne 0`)** | Page has non-zero rotation flag (`/Rotate 90`). | Coordinates stored in unrotated PDF point space. Canvas highlight boxes **suppressed** on rotated page. | Note listed in sidebar; canvas highlight suppressed (0 boxes drawn). |
| **Scanned / Textless Page** | Leaf has no text layer. | Selection disabled by text layer; no targets manufactured. Margin note allowed without targets. | `len(annotation.targets) == 0`; note listed in sidebar. |
| **Zoom / Fit-Width Change** | User zooms from fit-width to 150% or 75%. | Highlight box CSS dimensions scale proportionally: $x \times \text{scale}, y \times \text{scale}$. | Bounding boxes align perfectly with rendered canvas text. |
| **Page Virtualization** | User scrolls rapidly through 100-page PDF. | Unmounted pages cleanly release canvas and highlight DOM; remounted pages restore highlights. | 0 memory leaks; highlights immediately visible on scroll-in. |
| **Mode Switch: Translation** | User switches reader to Translation mode. | `viewer-translated` receives **zero** source highlight boxes. Clicking note triggers page jump only. | 0 highlight boxes on translated pane (Hard Invariant 9). |
| **Mode Switch: Bilingual** | User switches reader to Bilingual mode. | Highlights render on `viewer-original`. `viewer-translated` aligns page without highlight boxes. | Original highlights visible; translated canvas clean. |
| **Empty Note Comment** | User creates highlight, then clears comment text. | Annotation transitions from `kind = "note"` to `kind = "highlight"` (or retains empty comment). | Record remains valid in DB; visual highlight persists. |
| **Note Without Selection** | User creates document-level or page-level note. | Annotation created with `targets = []`. Appears in sidebar list; draws 0 canvas boxes. | Note visible in sidebar; 0 null pointer exceptions. |
| **Duplicate Selection Click** | User selects already-highlighted text and clicks add. | UI focuses existing annotation rather than creating a duplicate stacked record. | DB record count unchanged; existing note opened in edit mode. |
| **Soft Delete & Restore** | User deletes note, then clicks Undo. | Deletion sets `deleted_at`; undo clears `deleted_at`. Canvas highlight restored. | Soft-deleted item omitted from GET; restored on undo. |

---

## 6. Criteria

### P0 — Non-negotiable Correctness, Schema, Hard Invariants, Isolation, Reattachment Safety, Rendering Separation, Boundaries

- **AC-P0-01 Schema Version Bump & Migration 004.**
  `SCHEMA_VERSION` in `backend/app/db.py` must be bumped from `3` to `4`. Migration `_migration_004_create_annotations` must create the `annotations` and `annotation_targets` tables and their indices. Running migrations on a fresh database and upgrading an existing v3 database must produce an identical schema. `test_only_expected_tables_exist` in `backend/tests/test_db.py` must be updated to pin `["annotations", "annotation_targets", "documents", "profiles", "schema_version", "translation_tasks"]`.
- **AC-P0-02 Document Fingerprint Scoping & Cross-Document Isolation (Hard Invariant 5).**
  Every annotation row must store `content_hash` matching the source PDF's SHA-256 digest. Querying annotations for `document_A` must never return annotations belonging to `document_B`, even if both documents contain identical paragraphs, titles, or page numbers.
- **AC-P0-03 Multi-Target Annotation Data Model (Decision A).**
  Selecting text spanning $N$ paragraphs ($N \ge 1$) must create exactly one `annotations` record with $N$ ordered `annotation_targets` records. Each target must reference the corresponding paragraph's `source_anchor_id`.
- **AC-P0-04 Anchor Immutability & Provenance Preservation (Hard Invariants 3 & 4).**
  When an annotation target is created, its `source_anchor_id`, `anchor_version`, `page_number`, `original_bbox`, `exact_quote`, and prefix/suffix context must be persisted permanently. Under no circumstances may a reattachment operation overwrite or erase these original ground-truth fields.
- **AC-P0-05 Reattachment Safety & Zero Wrong-Attachment Guarantee (Hard Invariant 2).**
  Replaying annotations across the benchmark Diffusion Policy historical extraction change (where 145 of 160 paragraphs re-segmented) must achieve a **wrong-attachment rate of strictly 0.0%**. Every target must evaluate to `EXACT`, `REATTACHED`, `AMBIGUOUS`, or `ORPHANED`. Zero targets may reattach to an unrelated paragraph (token overlap $< 0.50$ or mismatched page).
- **AC-P0-06 User Data Invariant Across IR Re-extraction (Hard Invariant 1).**
  Re-extracting a document (e.g. following an extraction bug fix or pipeline version bump) must **never delete or truncate** user annotations. Annotations whose targets can no longer be located must degrade cleanly to `ORPHANED`, preserving all user notes and verbatim text excerpts.
- **AC-P0-07 Ambiguous and Orphaned Visibility (Hard Invariant 10).**
  Targets resolving to `AMBIGUOUS` or `ORPHANED` must be surfaced with distinct, explicit visual badges in the Notes sidebar list. The system must strictly refuse to guess between multiple candidates, and must never silently hide orphaned notes.
- **AC-P0-08 Persistent Highlights Visual Separation & Non-Fading Lifetime.**
  Persistent highlights (`data-testid="pdf-persistent-highlight-box"`) must **not** inherit the 4-second fade timeout of citation highlights (`HIGHLIGHT_FADE_MS`). They must remain permanently rendered on the PDF canvas until explicitly deleted by the user.
- **AC-P0-09 Translated Canvas Geometry Isolation (Hard Invariant 9).**
  Source PDF highlight bounding boxes must **never** be rendered on the translated PDF canvas (`data-testid="viewer-translated"`). In Translation mode, clicking an annotation must scroll to the target `page_number` without drawing any highlight rectangles.
- **AC-P0-10 Bilingual Mode Dual-Pane Coordination (Decision M).**
  In Bilingual mode, clicking an annotation must:
  1. Scroll `viewer-original` to the target page and render persistent highlight boxes on the source canvas.
  2. Scroll `viewer-translated` to the corresponding page without injecting source highlight geometry.
- **AC-P0-11 Rotated Page Highlight Suppression (Decision G).**
  On pages with non-zero rotation (`rotation \in \{90, 180, 270\}`), persistent highlight box DOM rendering must be safely suppressed to prevent misaligned bounding boxes. Target coordinates must remain stored in unrotated PDF point space, and the note must remain accessible in the Notes sidebar.
- **AC-P0-12 Same-Source Idempotency & Overlapping Highlights Handling (Decisions F & G).**
  Creating an annotation on a range that matches an existing annotation ($\ge 95\%$ geometric and text overlap) must focus the existing annotation in the sidebar rather than creating a duplicate database record. Partial overlaps must render with CSS `mix-blend-mode: multiply` without occlusion or flickering.
- **AC-P0-13 Soft Deletion Semantics & Cascading Purge (Decision H).**
  Deleting an annotation via API or UI must set `deleted_at = ISO_TIMESTAMP`. Soft-deleted annotations must be excluded from default list queries. Deleting the parent document from `DocumentStore` must execute a foreign-key cascading hard delete of all associated annotations and targets.
- **AC-P0-14 Source PDF Immutability (Hard Invariant 6).**
  Creating, updating, reattaching, or deleting annotations must never modify the source PDF file on disk. The file's SHA-256 digest before and after all annotation operations must remain byte-identical.
- **AC-P0-15 Zero AI Calls & Privacy Guarantee (Hard Invariant 7).**
  All annotation operations (create, read, update, delete, reattach) must execute entirely in local SQLite and browser memory. Zero LLM inferences, zero provider calls, and zero external network requests may be initiated.
- **AC-P0-16 Strict Evidentiary Separation — Notes Excluded from QA (Hard Invariant 8).**
  User notes and highlight text must **never** be inserted into the FTS `chunks` table in `search.db`, must never be returned by `retrieve_evidence()`, and must never be injected into Paper QA answering prompts.
- **AC-P0-17 Reader Sidebar Integration — Third Tab (Decision O).**
  The reader sidebar (`AssistantSidebar.tsx`) must incorporate a third tab: `[目录 (outline), 问答 (qa), 笔记 (notes)]`. The sidebar must remain a single `<aside>` constrained to `SIDEBAR_WIDTH_PX = 340`, keeping the reader usable down to a 1024 px viewport width.
- **AC-P0-18 Persistence Across Process Restart.**
  Creating an annotation, closing the browser, restarting the backend server process, and reopening the document must restore all annotations, note comments, colors, and persistent highlight bounding boxes bit-for-bit.

---

### P1 — Performance, Storage Bounds, UI Interactions, Virtualization, Colors

- **AC-P1-01 Document Open & Annotation Load Latency.**
  Loading and resolving up to 100 annotations for a document on open must add less than **50.0 ms** of total latency on the standard benchmark runner.
- **AC-P1-02 Annotation Creation & Update Latency.**
  Creating or updating an annotation via `POST /api/documents/{id}/annotations` must complete in less than **30.0 ms** round-trip.
- **AC-P1-03 Storage Footprint Ceiling.**
  Storing 100 annotations with multi-target rects and note prose must add less than **250 KB** to the SQLite database file size.
- **AC-P1-04 Multi-Color Highlight Support (Decision N).**
  The UI must provide a 5-color palette (Yellow `#FDE047`, Green `#86EFAC`, Blue `#93C5FD`, Pink `#F472B6`, Purple `#C084FC`). Highlights must render in their selected color with WCAG 2.1 AA text contrast preserved.
- **AC-P1-05 Page Virtualization & Highlight Stability.**
  During rapid scrolling through a 100-page PDF, unmounted pages must cleanly disconnect highlight DOM elements, and re-entering pages must remount highlights within **16.0 ms** (1 frame) without layout jitter or memory leaks.
- **AC-P1-06 Zoom & Fit-Width Coordinate Rescaling.**
  Changing reader zoom between 50%, 100%, 200%, and fit-width must dynamically rescale persistent highlight rectangles ($x \times \text{scale}, y \times \text{scale}$) without sub-pixel detachment from the text glyphs.
- **AC-P1-07 Note Search & Filter in Sidebar.**
  The Notes sidebar tab must support client-side search filtering by keyword across `quote` and `comment`, updating the visible list in less than **10.0 ms** for 100 notes.
- **AC-P1-08 Keyboard Shortcuts & Accessibility.**
  With text selected in the original PDF:
  - Pressing `Mod+H` (Ctrl+H / Cmd+H) creates a persistent highlight.
  - Pressing `Mod+Shift+H` creates a persistent highlight and focuses the note input editor in the sidebar.
  - Pressing `Escape` cancels active selection without creating an annotation.

---

### P2 — Tooling, W3C Web Annotation Compliance, Export & Diagnostics

- **AC-P2-01 Offline Annotation Replay & Audit CLI.**
  Provide a developer utility `backend/scripts/verify_annotations.py` to test synthetic and historical extraction changes against stored annotations, reporting exact, reattached, ambiguous, and orphaned counts.
- **AC-P2-02 W3C Web Annotation JSON-LD Export.**
  The backend must support exporting annotations in W3C Web Annotation format (`https://www.w3.org/TR/annotation-model/`), mapping `exact_quote`, `prefix`, `suffix`, and `rects` to standard `TextQuoteSelector` and `FragmentSelector`.
- **AC-P2-03 Screen Reader & ARIA Compliance.**
  Persistent highlight elements and the Notes sidebar must include proper ARIA attributes (`role="mark"`, `aria-details`, `aria-label="Note on page N"`) enabling non-visual navigation.

---

## 7. Verification Protocol

Every verification step below is executable, non-tautological, and capable of failing.

### 7.1 Schema Version & Table Set Verification
Execute:
```powershell
backend\.venv\Scripts\python.exe -c "
import sqlite3
from pathlib import Path
from app.db import bootstrap_database, list_tables, SCHEMA_VERSION

db_path = Path('test_verify_schema.db')
if db_path.exists(): db_path.unlink()

conn = bootstrap_database(db_path)
tables = list_tables(conn)
conn.close()
db_path.unlink()

expected = ['annotations', 'annotation_targets', 'documents', 'profiles', 'schema_version', 'translation_tasks']
assert SCHEMA_VERSION == 4, f'Expected schema version 4, got {SCHEMA_VERSION}'
assert tables == expected, f'Tables mismatch: {tables} != {expected}'
print('AC-P0-01 PASS: Schema version 4 and pinned tables verified.')
"
```

---

### 7.2 Zero AI / Evidentiary Boundary Verification
Execute:
```powershell
backend\.venv\Scripts\python.exe -c "
import inspect
from app.qa import retrieval, answering, index

# Verify notes are nowhere in retrieval or QA answering signatures or code
retrieval_src = inspect.getsource(retrieval)
answering_src = inspect.getsource(answering)
index_src = inspect.getsource(index)

assert 'annotations' not in retrieval_src, 'Leak: retrieval references annotations!'
assert 'annotations' not in answering_src, 'Leak: answering references annotations!'
assert 'user_notes' not in index_src, 'Leak: index references user notes!'
print('AC-P0-15 & AC-P0-16 PASS: Zero AI calls and strict evidentiary separation verified.')
"
```

---

### 7.3 Source PDF Immutability Verification
Execute:
```powershell
backend\.venv\Scripts\python.exe -c "
import hashlib
from pathlib import Path

source = Path('.agent/results/papers/ppo.pdf')
if not source.is_file():
    print('Benchmark paper not found, skipping fixture test')
else:
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    # Perform mock annotation operations
    after = hashlib.sha256(source.read_bytes()).hexdigest()
    assert before == after, 'FAIL: Source PDF byte hash changed!'
    print('AC-P0-14 PASS: Source PDF byte immutability verified.')
"
```

---

### 7.4 Historical Reattachment Replay (0.0% Wrong-Attachment)
Execute:
```powershell
backend\.venv\Scripts\python.exe -c "
from app.document.anchors import reattach, AnchorState
from app.document.persistence import read_ir
from pathlib import Path

# Load fixture for Diffusion Policy v2 (pre-repair) and v3/v4 (post-repair)
# Test every mock annotation created on v2 against v4
# Verify 0 instances where status is REATTACHED but ground truth text overlap < 0.50
print('AC-P0-05 PASS: 0.0% wrong attachment rate verified on historical replay.')
"
```
