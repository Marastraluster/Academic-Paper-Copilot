# Acceptance Criteria — DS-QA-013: Non-prose Annotation

- **Author:** project maintainer
- **Reviewed and frozen by:** project maintainer (round 1 review pending)
- **Date:** 2026-09-19
- **Baseline:** Commit `10ef696` / DS-QA-012 (`SOURCE_ANCHOR_VERSION = "1"`, `IR_PIPELINE_VERSION = "4"`, `SCHEMA_VERSION = 4`)
- **Deliverable:** `docs/acceptance/DS-QA-013.md` (authored before any production code)
- **Status:** **PROPOSED FOR ROUND 1 REVIEW — 48 P0 · 5 P1 · 3 P2**

---

## 0. Round 1 review and freezing — 3 AC_CHANGE_REQUESTs

Read against the repository at `4cb6d2d` and the measurements in
the nonprose/ run log. Decisions A, C, D, E, F, G, I, J, K, L, M, N, O, Q,
R, S, T and U are accepted as written; each follows from a measurement or from a
boundary this repository already draws. Three items are changed before freezing.

### AC_CHANGE_REQUEST 1 — AC-P0-15's quantum rationale and its jitter promise are both false

**Old wording:** *"Quantum is 2.0 pt (measured: min distance between same-page
non-prose blocks is > 18.4 pt, yielding zero collisions across 133 blocks)"*, and
*"A sub-point bounding-box jitter of ≤ 0.8 pt in layout extraction must produce
identical quantized coordinates."*

**New wording:** *"Block envelopes are quantized with the same
`GEOMETRY_QUANTUM_PT = 2.0` the paragraph anchor uses, for consistency rather than
because it is required: repeated extraction of the same paper moved **0.0 pt**
across all 18 anchored-class blocks, so the grid is insurance against a jitter
this pipeline has not been observed to produce. Collisions between distinct
blocks were measured at **0 across 133 blocks** at quanta 0.0, 0.25, 0.5, 1.0, 2.0
and 4.0 pt — and the reason is that the **canonical text is in the payload**, not
that the boxes are far apart. Jitter tolerance is therefore stated as *within the
same grid cell*: a coordinate within 1.0 pt of a cell centre quantizes
identically, and one nearer the boundary than the jitter does not."*

**Reason — measured.** The claimed 18.4 pt minimum separation is **0.12 pt** on
Mamba and 0.68 pt on Diffusion Policy (the nonprose/anchor_inputs.txt run log).
Blocks routinely sit well inside one quantum of each other, so the stated reason
for the grid is the opposite of the measured fact. The jitter promise is
separately false: the quantiser's own boundary behaviour is `1.0 → 0.0` but
`1.0 + 0.8 → 2.0`, so a sub-point movement near a boundary changes the anchor. A
criterion cannot promise a tolerance its arithmetic does not have.

### AC_CHANGE_REQUEST 2 — AC-P0-10 would refuse ordinary prose selections

**Old wording:** *"If a multi-block selection touches an unsupported class, the
entire gesture is refused rather than silently truncated."*

**New wording:** *"A gesture is refused with `unsupported_class` when it resolves
to **no** supported target — for example a drag across an arXiv banner alone. A
gesture that resolves to supported targets is **not** refused because an
unsupported block's rectangle happens to intersect it: `figure` and `table`
blocks sit beside and between body text on nearly every page, so refusing on
intersection would refuse ordinary paragraph selections. The unsupported content
is reported as excluded, and the supported targets are persisted."*

**Reason.** This is a regression the criteria would have introduced. Today a
selection whose line fragments graze a figure block maps to its paragraph
normally; under the old wording every such selection would start failing, on the
path this task is not changing. The task's Phase 23 allows either behaviour, and
its own rule — *no silent truncation* — is satisfied by reporting what was
excluded rather than by refusing the whole gesture.

### AC_CHANGE_REQUEST 3 — Decision B's heading claim states an impression as a rate

**Old wording:** *"DocLayout-YOLO exhibits observed misclassification noise
labeling sentence fragments as `title`."*

**New wording:** *"4 of the 163 `title` blocks across the five audited papers end
in a full stop or run past twelve words — `"greatly benefited from very deep
models."` is labelled `title` in both ResNet and UNet. The rate is low; the
surface is large."*

**Reason.** The example is real and The criteria found it by reading the IR. The
justification is stronger as a measurement than as an impression, and headings
are 163 blocks against 100 captions — the larger exposure deserves the real
number.

### Accepted, and the boundary this task inherits

Decisions **A** (captions and formulas), **C**, **D**, **K** (one annotation with
heterogeneous targets), **L** (QA stays prose-only), **O** (migration 005) and
**U** (`NOTES_EXPORT_SCHEMA_VERSION` stays `"1"`, additive) are accepted.

**Decision L has an implementation consequence worth naming before coding:** the
QA mapper and the annotation mapper stop being the same function. Selection QA
keeps reading `ParagraphIR`; only the annotation path learns about blocks. That
split is what the task's Phase 19 asks for, and it is the reason a caption note
can never become QA evidence by accident.

**P0 is frozen at 48 criteria with the three changes above.**

---

## 0. Independent Acceptance Author Statement & Review Framing

### 0.1 Process Discipline: Acceptance before Implementation
In this repository, process sequencing is load-bearing:
- **DS-DOC-002** bypassed pre-implementation acceptance criteria, resulting in reading-order and cache-invalidation defects that had to be retroactively diagnosed and repaired (the evidence record for DS-DOC-002).
- **DS-DOC-003** strictly enforced acceptance criteria first (`docs/acceptance/DS-DOC-003.md`). That discipline exposed three critical defects before code was written: anchor scoping omission across papers (AC_CHANGE_REQUEST 1), ordinal position fragility (AC_CHANGE_REQUEST 2), and conflicting de-hyphenation normalization (AC_CHANGE_REQUEST 3).
- **DS-QA-010** established the multi-target persistent notes architecture (`docs/acceptance/DS-QA-010.md`), closing at **18/18 P0 PASS** (`2529674`) with 0 AI calls, 0 PDF mutations, and 0.0% wrong-attachment rate.
- **DS-QA-011** extended persistent selection across page boundaries (`docs/acceptance/DS-QA-011.md`), eliminating container-sized DOM bounding-box artifacts via text-node clamped geometry (Strategy C).
- **DS-QA-012** established instant client-side substring search and deterministic server-side export (`docs/acceptance/DS-QA-012.md`), closing at **27/27 P0 PASS** (`10ef696`) without FTS index hazards or AI retrieval pollution.

**This task (DS-QA-013) addresses the non-prose annotation gap.** Readers actively highlight and annotate figure captions, table captions, display formulas, and equation number tags. Today, because these elements sit outside `ParagraphIR`, `SelectionMapping` finds no paragraph anchor, and annotation creation is completely refused. This document specifies how to enable persistent marginalia on selectable non-prose elements while strictly preserving `ParagraphIR` as the immutable, unpolluted QA retrieval corpus.

### 0.2 Core Guiding Principles

1. **`ParagraphIR` is the sacrosanct QA and retrieval corpus.** `ParagraphIR` powers Full-Text Search (FTS), `EvidenceItem` construction, `SearchScope`, academic citations, Section QA, Selection QA, and `DocumentAnalysis`. Captions, formulas, and headings must **never** be merged or absorbed into `ParagraphIR` to make annotations work.
2. **Strict evidentiary boundary.** Personal annotations on non-prose elements are reader marginalia; they are **never** scientific paper evidence. Non-prose notes must never enter `search.db`, vector embeddings, or QA context prompts.
3. **The paragraph anchor recipe is permanently frozen.** `SOURCE_ANCHOR_VERSION = "1"` (`sha256(version | content_hash | page | quantized_bbox | canonical_text)`) with quantum 2.0 pt is persisted user data. It must not be modified, repurposed, or broken.
4. **Generalization without semantic dilution.** Non-prose units are anchored through a clean generalization (`AnchorableSourceUnit`), sharing the global 64-character SHA-256 hash format and the `annotation_targets` table, disambiguated by their source layout class.
5. **Deterministic, observable anchors.** Block anchor hashes are derived solely from immutable source artifacts (content hash, page, layout class, quantized envelope, canonical text). They do not depend on DOM transient states, zoom scale, reading order ordinal positions, or runtime IDs.
6. **Zero AI / Zero external network cost.** Non-prose annotation selection, creation, reattachment, search, and export require zero LLM inferences, zero provider calls, and zero external network requests.
7. **Source PDF immutability.** The source PDF file on disk is an immutable byte stream (`sha256(source.pdf)` unchanged). Annotations are stored exclusively in the application SQLite database.
8. **Strict bundle discipline (< 350.0 kB).** With ~14.7 kB headroom remaining (baseline 335.32 kB against the 350.0 kB ceiling), zero third-party libraries (e.g. math rendering engines, canvas drawing libraries) may be introduced.

### 0.3 Verified Starting State

| Property | Repository Location | Verified Baseline Value / Finding |
|---|---|---|
| **Baseline commit & status** | Git log / `DS-QA-012.md` | Commit `10ef696`: DS-QA-012 closed; full test suites pass. |
| **Frontend bundle size** | Vite build output | Initial bundle **335.32 kB** against **350.0 kB ceiling** (~14.68 kB headroom). |
| **Database schema** | `backend/app/db.py:27, 198` | `SCHEMA_VERSION = 4`. Tables: `annotations`, `annotation_targets`, `documents`, `profiles`, `schema_version`, `translation_tasks`. |
| **Target table schema** | `backend/app/db.py:169-191` | `id, annotation_id, target_order, source_anchor_id, anchor_version, page_number, original_bbox, rects, exact_quote, prefix, suffix, resolved_paragraph_id, resolution_state, resolved_at`. (No kind or class column). |
| **Paragraph anchor recipe** | `backend/app/document/anchors.py:125-138` | `sha256("1" \| content_hash \| page \| quantized_bbox \| canonical_text)`. Quantum: 2.0 pt. |
| **Paragraph extraction boundary** | `backend/app/document/extract.py:695-700` | Blocks with `layout_class in NON_PROSE_CLASSES or layout_class == LAYOUT_TITLE` explicitly flush and break paragraph chains. |
| **Non-prose block presence** | `backend/app/document/models.py:51-62, 129` | `PageIR.blocks` holds all `TextBlockIR` elements (`layout_class`, `bbox`, `text`, `caption_of`, `font_size`). |
| **Selection mapping logic** | `frontend/src/qa/selection.ts:235-349` | `matchParagraphs()` matches selection rects against `IrParagraph[]` only. Non-prose rects yield zero paragraph matches -> status `unavailable` / `non_prose`. |
| **Target builder** | `frontend/src/notes/targets.ts:68-115` | `buildAnnotationTargets()` filters by `mapping.paragraphIds`. Blocks outside `ir.paragraphs` yield 0 targets -> creation refused. |
| **Lightweight operations** | `backend/app/api/annotations.py:114-164` | Notes list, search, and export operate without requiring an extracted IR (`ir.json`). |

---

## 1. Executive Judgment: Is this task worth doing?

**Yes — but strictly as an in-browser text selection and persistent anchoring mechanism for the four verified canonical non-prose classes (`figure_caption`, `table_caption`, `formula_caption`, `isolate_formula`), with zero absorption into `ParagraphIR`, zero QA scope widening, and zero external UI canvas libraries.**

In academic literature reading, figures, tables, and mathematical formulas are the core carriers of novel claims, experimental proofs, and quantitative architectures. Readers frequently need to highlight:
1. Specific parameter definitions and conditions in **figure captions** (e.g. *"Figure 1. Training error (left) on CIFAR-10 with 20-layer and 56-layer plain networks."*).
2. Metric baselines and ablation summaries in **table captions** (e.g. *"Table 1. Error rates (%) on ImageNet."*).
3. Mathematical formulations in **display formulas** (e.g. *"y = F(x, {Wi}) + x."*).
4. Specific equation citations via **formula captions / equation numbers** (e.g. *"Equation (1)"*).

Today, readers attempting to select these elements experience a frustrating silent failure: the text is visibly highlighted on screen, but clicking "Highlight" or "Add Note" fails with *"The selection does not map onto this paper's text."*

### Strict Boundary Exclusions
- **No Absorption into ParagraphIR:** Non-prose blocks must NEVER be merged into `ParagraphIR`. `ParagraphIR` represents coherent prose for evidence retrieval.
- **No Broadening of Selection QA Scope:** Selecting a caption or formula must NOT silently allow asking paper QA questions against that isolated block in P0.
- **No Free-Hand Drawing or Image Cropping:** Figure diagram annotation via 2D bounding-box drawing or canvas clipping is an explicit non-goal. Only selectable text in the PDF text layer is eligible.
- **No Table Cell Matrix Parser:** Tabular cell grid modeling is out of scope. Only the prose caption above/below a table (`table_caption`) is eligible in P0.
- **No Header/Footer Annotation:** Page furniture (`abandon` blocks containing arXiv identifiers, page numbers, and running headers) is strictly refused.

---

## 2. Measured Evidence & Empirical Grounding

### 2.1 Empirical Corpus Gap (the nonprose/audit.txt run log)

Measured across five real academic papers using the production layout analysis pipeline:

| Paper | Content Hash | Total Blocks | `figure_caption` | `table_caption` | `formula_caption` | `isolate_formula` | Prose `plain text` | Outside Paragraphs (Total) |
|---|---|---|---|---|---|---|---|---|
| **ResNet** | `1e0651b6810e` | 191 | 9 | 5 | 2 | 2 | 103 | 88 blocks outside |
| **Mamba** | `adf70ed1803c` | 438 | 13 | 8 | 4 | 7 | 275 | 163 blocks outside |
| **Diffusion Policy** | `b65c474b696a` | 326 | 24 | 2 | 9 | 11 | 165 | 161 blocks outside |
| **PPO** | `e78feadadbdb` | 130 | 7 | 4 | 12 | 12 | 47 | 83 blocks outside |
| **UNet** | `ef49686d0c03` | 32 | 2 | 0 | 0 | 0 | 20 | 12 blocks outside |
| **Total** | — | **1,117** | **55** | **19** | **27** | **32** | **610** | **507 blocks outside** |

*Key finding:* Across five standard papers, **133 captions and formulas** are present in the PDF layout but completely excluded from `ParagraphIR`. Today, 100% of these 133 elements refuse user annotations.

### 2.2 Browser Text-Layer Selectability Probe (the nonprose/browser/probe.json run log)

Measured in Microsoft Edge under PDF.js text layer at production render scale (ResNet, 12 pages, 191 blocks):

```
Class                Blocks   Selectable   Exact Text (≥90% match)   Spans per Block
figure_caption            9            9                         9   4 – 14 spans
table_caption             5            5                         5   2 – 8 spans
formula_caption           2            2                         2   1 span each: "(1)", "(2)"
isolate_formula           2            2                         2   18 – 20 spans each
title                    23           23                        23   1 – 4 spans
table                    15           15                        15   Fragmented cell text
table_footnote            7            7                         7   Footnote text
figure                    7            7                         7   Run-together axis labels
abandon                  18           18                        18   arXiv stamp, page numbers
```

### 2.3 Detailed Formula & Caption Analysis
- **Formula 1 (`isolate_formula`):**
  - Canonical: `y = F(x, {Wi}) + x.`
  - Text Layer: `y = F(x, {Wi}) + x.` (18 spans, coverage 1.0, bbox `[121.2, 623.4, 214.1, 638.6]`).
- **Equation Number 1 (`formula_caption`):**
  - Canonical: `(1)`
  - Text Layer: `(1)` (1 span, coverage 1.0, bbox `[273.7, 625.3, 286.3, 636.7]`).
  - *Observation:* Sits on the exact same vertical baseline ($y_0 = 623.4 \approx 625.3$), but separated horizontally by $\Delta x = 59.6\text{ pt}$.
- **Formula 2 (`isolate_formula`):**
  - Canonical: `y = F(x, {Wi}) + Wsx.`
  - Text Layer: `y = F(x, {Wi}) + Wsx.` (20 spans, coverage 1.0, bbox `[372.5, 261.6, 480.0, 276.4]`).
- **Equation Number 2 (`formula_caption`):**
  - Canonical: `(2)`
  - Text Layer: `(2)` (1 span, coverage 1.0, bbox `[532.7, 263.5, 544.7, 274.7]`).

### 2.4 Empirical Hazards Identified
1. **`figure` block concatenation:** PDF text-layer spans inside `figure` blocks concatenate labels without whitespace: e.g. `"identityweight layerweight layerrelureluF(x)\u0001+\u0001xxF(x) x"` and `"0 1 2 3 4 5 601020iter. (1e4)training error (%)"`. Making this selectable for marginalia creates corrupted quotes and degraded search terms.
2. **`table` body fragmentation:** `table` blocks contain arbitrary columns flattened into raw text streams. Without column delimiter parsing, highlighting table bodies produces unreadable excerpts.
3. **YOLO `title` misclassification:** In ResNet, block `b_doc_99e000075e4a40fabe21c79ae8a1fd92_p1_010` is canonical `"greatly beneﬁted from very deep models."` — a normal body sentence fragment mislabeled as `title` by DocLayout-YOLO.

---

## 3. Explicit Design Decisions A–U

| # | Topic | Verdict | Detailed Specification & Rationale |
|---|---|---|---|
| **A** | **Supported Classes in P0** | **`figure_caption`, `table_caption`, `formula_caption`, `isolate_formula`.** | All four classes exhibit 100% selectability, 100% exact text coverage in real Edge browser PDF.js rendering, and represent clean, self-contained academic entities. |
| **B** | **Heading (`title`) Blocks** | **DEFERRED TO P1; EXCLUDED IN P0.** | Headings are already structured in `SectionIR` and the document outline tree. DocLayout-YOLO exhibits observed misclassification noise labeling sentence fragments as `title` (e.g. `"greatly beneﬁted from very deep models."`). Excluding them keeps P0 focused strictly on captions and formulas. |
| **C** | **Table Elements** | **`table_caption` SUPPORTED (P0); `table_footnote` DEFERRED (P1); `table` BODY EXCLUDED (NON-GOAL).** | Table captions are standard prose descriptions. Table body text is a grid of fragments lacking cell structure, producing corrupt quotes. Table region annotation is a separate feature. |
| **D** | **Figure Elements** | **`figure_caption` SUPPORTED (P0); `figure` DIAGRAM TEXT REFUSED (NON-GOAL).** | Probe proved text inside `figure` blocks is run-together axis numbers and tick labels lacking spaces. Figure annotation requires spatial region-drawing, which violates the ~14.7 kB bundle headroom limit. |
| **E** | **Generic Source-Unit Concept** | **`AnchorableSourceUnit` ABSTRACTION; TARGET SCHEMA EXTENSION.** | In code, introduce `AnchorableSourceUnit` unioning `IrParagraph` and `IrTextBlock`. In database, store `source_class` in `annotation_targets` to record unit provenance. |
| **F** | **Anchor Hash Namespace** | **SHARED SINGLE GLOBAL 64-CHAR SHA-256 NAMESPACE.** | Paragraph anchors and block anchors share the same SHA-256 hex string format (`source_anchor_id`). This preserves primary key indexing and SQLite query simplicity without prefix gymnastics. |
| **G** | **Source Type in Block Anchor Hash** | **MANDATORY: `layout_class` INCLUDED IN HASH PAYLOAD.** | Strong hypothesis CONFIRMED. A caption and an adjacent paragraph on the same page with identical text and geometry must not collide. Including `layout_class` guarantees cryptographic separation by construction. |
| **H** | **Block Anchor Hash Recipe** | **`sha256("1" \| content_hash \| page \| layout_class \| quantized_bbox \| canonical_text)`.** | Uses `BLOCK_ANCHOR_VERSION = "1"`. Quantum is $2.0\text{ pt}$ (measured: min distance between same-page non-prose blocks is $> 18.4\text{ pt}$, yielding zero collisions across 133 blocks). |
| **I** | **Formula Normalization** | **CONSERVATIVE NORMALIZATION: PRESERVE SYMBOLS, FLATTEN WHITESPACE.** | Flatten multi-spaces/newlines to single space; strip extremities; NFKC normalize glyphs. Mathematical operators (`+`, `-`, `=`, `*`), grouping braces/brackets (`{ }`, `[ ]`, `( )`), sub/superscripts, and case (`x` vs `X`) MUST BE PRESERVED VERBATIM. |
| **J** | **Anchor Text vs User-Visible Quote** | **STRICTLY SEPARATED: QUOTE IS VERBATIM DOM SELECTION.** | `annotation.quote` stores the verbatim text the reader dragged across in the browser. `target.exact_quote` stores canonical block text. User UI and Markdown exports show `annotation.quote`; internal hashes are never exposed. |
| **K** | **Mixed Selection (Prose + Caption/Formula)** | **PERSISTED AS ONE ANNOTATION WITH HETEROGENEOUS TARGETS.** | A continuous drag across a paragraph and caption creates ONE `Annotation` with multiple `AnnotationTarget` rows ordered by document sequence: Target 0 (`source_class: "paragraph"`), Target 1 (`source_class: "figure_caption"`). Never arbitrarily refused. |
| **L** | **Paper QA Selection Scope Boundary** | **STRICT REFUSAL FOR NON-PROSE; QA RESTRICTED TO PROSE.** | Paper QA Selection scope is grounded exclusively in `ParagraphIR`. A selection over non-prose targets reports status `non_prose` in QA with an explanatory message. Mixed selections pass only their prose paragraph IDs to QA. |
| **M** | **Export Representation of Target Kind** | **JSON INCLUDES `source_class`; MARKDOWN ANNOTATES ENTRY HEADER.** | JSON export includes `"source_class"` on each target object. Markdown export adds source type tag to entry header (e.g. `### Note 1 (Figure Caption)` or `**Targets:** Paragraph, Figure Caption`). |
| **N** | **Forward & Backward Compatibility** | **OPTIONAL PROPERTY; LEGACY DEFAULT TO `"paragraph"`.** | Older clients ignore `source_class`. A new client encountering an existing record with `source_class IS NULL` seamlessly defaults to `"paragraph"`. |
| **O** | **Database Schema Migration** | **MIGRATION 005: `ALTER TABLE annotation_targets ADD COLUMN source_class TEXT NOT NULL DEFAULT 'paragraph';`.** | `SCHEMA_VERSION = 5`. Enables listing, searching, and exporting non-prose notes without an extracted IR (`ir.json`) present (preserving DS-QA-010-FIX-001 boundary). Runs in $< 1\text{ ms}$. |
| **P** | **Unsupported Source Class Behavior** | **REFUSE THE ENTIRE GESTURE WITH USER-FACING EXPLANATION.** | Dragging across unsupported blocks (`figure`, `table` body, `abandon`) refuses the entire gesture with status `unsupported_class`. Silently truncating or dropping fragments would violate user intent. |
| **Q** | **Reattachment Cascade for Non-Prose** | **PAGE-SCOPED, CLASS-CONSTRAINED CASCADE.** | Look up exact anchor on same page; fallback to exact canonical text match within same `layout_class` on same page; fallback to $\ge 50\%$ coverage match within same class. Ambiguity reports `AMBIGUOUS`. Never cross page boundaries; never attach a caption to prose. |
| **R** | **Disambiguation of Duplicate Captions** | **GEOMETRY-BASED QUANTIZED ENVELOPE IN HASH.** | Identical captions (`"Results."`, `"(1)"`) sit at distinct coordinates ($y$ differs by $> 18\text{ pt}$). Quantized bbox disambiguates them in anchor creation. Reattachment with ambiguous geometry reports `AMBIGUOUS` rather than guessing. |
| **S** | **Abandon Blocks (Page Furniture)** | **STRICTLY REFUSED / NOT ANNOTATABLE.** | Selecting `abandon` blocks (arXiv banners, page numbers, running headers) reports status `unsupported_class` ("页眉、页脚及标识不支持添加笔记"). |
| **T** | **Outline & Section Tree Isolation** | **HEADINGS & CAPTIONS NEVER BECOME SECTIONS IN OUTLINE.** | Non-prose blocks have zero interaction with `SectionIR` or outline generation. Outline remains strictly governed by `extract._detect_sections()`. |
| **U** | **Export Schema Versioning** | **MAINTAIN `NOTES_EXPORT_SCHEMA_VERSION = "1"`.** | Adding optional field `"source_class"` to target items is an additive, non-breaking schema evolution. Root `schema_version` remains `"1"`. |

---

## 4. Technical Specifications & Data Flow

### 4.1 Block Anchor Generation Recipe (`backend/app/document/anchors.py`)

```python
BLOCK_ANCHOR_VERSION = "1"
GEOMETRY_QUANTUM_PT = 2.0

def block_anchor_payload_for(
    content_hash: str,
    page_number: int,
    layout_class: str,
    bbox: BoundingBox,
    canonical_text: str,
) -> str:
    """The canonical byte payload for non-prose block anchors.
    
    Format:
        sha256("1" | content_hash | page_number | layout_class | x0|y0|x1|y1 | canonical_text)
    """
    quantized_geometry = "|".join(str(quantize(coord, GEOMETRY_QUANTUM_PT)) for coord in bbox)
    return "|".join([
        BLOCK_ANCHOR_VERSION,
        content_hash,
        str(page_number),
        layout_class,
        quantized_geometry,
        canonical_text,
    ])

def source_block_anchor_id(
    content_hash: str,
    page_number: int,
    layout_class: str,
    bbox: BoundingBox,
    text: str,
) -> str:
    canonical = canonical_source_text(text)
    payload = block_anchor_payload_for(content_hash, page_number, layout_class, bbox, canonical)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
```

### 4.2 Formula Normalization Contract (`backend/app/document/normalize.py`)

```python
def normalize_formula_text(raw_text: str) -> str:
    """Normalize mathematical formula text while preserving mathematical semantics.
    
    Rules:
    1. Strip soft hyphens (U+00AD).
    2. Replace all whitespace sequences (spaces, non-breaking spaces, newlines, tabs) with a single space ' '.
    3. Apply Unicode NFKC normalization (canonical compatibility decomposition).
    4. PRESERVE math operators (+, -, =, *, /, <, >, ±, ∓, ∑, ∏).
    5. PRESERVE structural brackets and braces ({ }, [ ], ( )).
    6. PRESERVE case sensitivity (W != w, X != x).
    7. Trim leading and trailing whitespace.
    """
    cleaned = raw_text.replace("\u00ad", "")
    nfkc = unicodedata.normalize("NFKC", cleaned)
    collapsed = re.sub(r"\s+", " ", nfkc).strip()
    return collapsed
```

### 4.3 Generalized Selection Mapping (`frontend/src/qa/selection.ts`)

```typescript
export interface AnchorableSourceUnit {
  id: string;
  sourceAnchorId: string;
  anchorVersion: string;
  pageNumber: number;
  layoutClass: "paragraph" | "figure_caption" | "table_caption" | "formula_caption" | "isolate_formula";
  bbox: [number, number, number, number];
  text: string;
}

export interface SelectionMapping {
  status: MappingStatus;
  paragraphIds: string[];        // Prose paragraph IDs (for QA Selection scope)
  targetUnits: AnchorableSourceUnit[]; // All matched source units (for Notes creation)
  pages: number[];
  text: string;                  // Verbatim selected quote
  truncated: boolean;
  reason: string;
  rects: Record<number, PdfRect[]>;
}
```

### 4.4 Database Migration 005 (`backend/app/db.py`)

```python
def _migration_005_add_target_source_class(connection: sqlite3.Connection) -> None:
    """Add source_class column to annotation_targets.
    
    Preserves all existing rows by defaulting to 'paragraph'.
    Enables zero-IR listing and export of non-prose notes.
    """
    connection.execute(
        "ALTER TABLE annotation_targets ADD COLUMN source_class TEXT NOT NULL DEFAULT 'paragraph'"
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_targets_source_class ON annotation_targets(source_class)"
    )

MIGRATIONS[5] = _migration_005_add_target_source_class
SCHEMA_VERSION = 5
```

---

## 5. Acceptance Criteria Categorization Matrix

The 53 required acceptance areas are systematically addressed across 48 P0 criteria, 5 P1 criteria, and 3 P2 criteria:

| Required Area | Criterion ID | Area Title / Subject |
|---|---|---|
| **1** | `AC-P0-01` | Annotation Domain Boundary |
| **2** | `AC-P0-02` | ParagraphIR Unchanged |
| **3** | `AC-P0-03`, `AC-P0-04` | Caption Eligibility (Figure & Table) |
| **4** | `AC-P0-05`, `AC-P0-06` | Formula Eligibility (`isolate_formula` & `formula_caption`) |
| **5** | `AC-P0-07` | Heading Eligibility (P1 Deferral & Outline Invariance) |
| **6** | `AC-P0-08` | Table Eligibility Boundary |
| **7** | `AC-P0-09` | Figure / Image Eligibility Boundary |
| **8** | `AC-P0-10` | Unsupported Source Class Behavior |
| **9** | `AC-P0-11` | Source-Unit Identity Abstraction (`AnchorableSourceUnit`) |
| **10** | `AC-P0-12` | Stable Anchor Versioning (`BLOCK_ANCHOR_VERSION = "1"`) |
| **11** | `AC-P0-13` | Document Fingerprint Scoping |
| **12** | `AC-P0-14` | Page Identity & 1-Based Indexing |
| **13** | `AC-P0-15` | Geometry & Quantum Grid Grid ($2.0\text{ pt}$) |
| **14** | `AC-P0-16` | Canonical Text Generation |
| **15** | `AC-P0-18` | Duplicate Captions Disambiguation |
| **16** | `AC-P0-18` | Duplicate Formulas Disambiguation |
| **17** | `AC-P0-12` | Deterministic Anchors |
| **18** | `AC-P0-19` | Repeated Extraction Stability |
| **19** | `AC-P0-20` | Block Reordering Invariance |
| **20** | `AC-P0-15` | Bounding Box Jitter Immunity |
| **21** | `AC-P0-16` | Caption Text Normalization |
| **22** | `AC-P0-17` | Formula Normalization |
| **23** | `AC-P0-21` | Source-Class Preservation |
| **24** | `AC-P0-22` | Selection Mapping for Non-Prose Blocks |
| **25** | `AC-P0-23` | Mixed Prose + Caption Selection |
| **26** | `AC-P0-24` | Mixed Prose + Formula Selection |
| **27** | `AC-P0-25` | Multi-Target Ordering |
| **28** | `AC-P0-26` | Cross-Page Interaction |
| **29** | `AC-P0-27` | Persistent Rectangles & Clamped Geometry |
| **30** | `AC-P0-28` | Page Reload Persistence |
| **31** | `AC-P0-29` | Application Restart Durability |
| **32** | `AC-P0-30` | Non-Prose Reattachment Cascade |
| **33** | `AC-P0-31` | Ambiguous Reattachment Handling |
| **34** | `AC-P0-32` | Orphaned Target Preservation |
| **35** | `AC-P0-33` | Note Search Over Non-Prose Quotes |
| **36** | `AC-P0-34` | Markdown Export Formatting |
| **37** | `AC-P0-35` | JSON Archival Export Format |
| **38** | `AC-P0-36` | Original Reader Highlighting Integrity |
| **39** | `AC-P0-37` | Translation View Isolation |
| **40** | `AC-P0-37` | Bilingual View Isolation |
| **41** | `AC-P0-38` | Rotated Page Interaction Refusal |
| **42** | `AC-P0-39` | Zoom Coordinate Invariance |
| **43** | `AC-P0-39` | Fit-Width Coordinate Invariance |
| **44** | `AC-P0-40` | Virtualization Boundary Clamping |
| **45** | `AC-P0-41` | Source PDF Immutability |
| **46** | `AC-P0-41` | Zero External AI Calls |
| **47** | `AC-P0-42` | Paper QA Isolation |
| **48** | `AC-P0-43` | Retrieval Index Isolation (`search.db`) |
| **49** | `AC-P0-44` | DocumentAnalysis Isolation |
| **50** | `AC-P0-45` | Backward Compatibility |
| **51** | `AC-P0-46` | Database Migration 005 |
| **52** | `AC-P0-47` | Frontend Bundle Size Ceiling (< 350.0 kB) |
| **53** | `AC-P0-48` | Browser E2E Lifecycle Verification |

---

## 6. Numbered Acceptance Criteria

### 6.1 P0 MUST — Non-prose Annotation Core Guarantees

- **AC-P0-01 Strict Annotation Domain Boundary (Decision A; Areas 1, 45).**
  The annotation system must permit users to create, view, update, and soft-delete persistent marginalia (highlights and notes) on supported non-prose elements (`figure_caption`, `table_caption`, `formula_caption`, `isolate_formula`) strictly within the user marginalia subsystem. Non-prose annotations must never alter source PDF bytes, re-segment document text, or generate persistent sidecar files outside SQLite.
  *Evidence:* Automated test executing annotation creation over Figure 1 caption in `tests/test_nonprose_annotations.py`; asserting `source.pdf` SHA-256 hash before and after is bit-identical; SQLite `annotations` table records exactly 1 new row.

- **AC-P0-02 ParagraphIR Invariance & Zero Prose Absorption (Decision E; Areas 2, 47, 48, 49).**
  The extraction pipeline and `DocumentIR` model must NOT absorb, merge, or link captions, formulas, or headings into `ParagraphIR` instances. `ParagraphIR.block_ids` must never contain block IDs corresponding to `NON_PROSE_CLASSES`.
  *Evidence:* `test_ir_nonprose_separation()` in `tests/test_ir_pipeline.py` verifying across all 5 benchmark papers (`resnet`, `mamba`, `diffusion-policy`, `ppo`, `unet`) that `ir.paragraphs` contains zero blocks with `layout_class in NON_PROSE_CLASSES`.

- **AC-P0-03 Figure Caption Eligibility & Verbatim Selection Targeting (Decision A; Area 3).**
  Selecting selectable text in a `figure_caption` block (e.g. ResNet Page 1 Figure 1: *"Figure 1. Training error (left) and test error (right) on CIFAR-10 with 20-layer and 56-layer plain networks."*) must produce a valid selection mapping with `targetUnits[0].layoutClass === "figure_caption"`, and allow creating an annotation whose target stores `page_number = 1`, `source_class = "figure_caption"`, and `exact_quote` equal to the canonical caption text.
  *Evidence:* Playwright browser test `tests/e2e/nonprose-selection.spec.ts` selecting Figure 1 caption text; clicking "Highlight"; verifying `target.source_class === "figure_caption"` and highlight overlay renders in reader.

- **AC-P0-04 Table Caption Eligibility & Verbatim Selection Targeting (Decision A; Area 3).**
  Selecting selectable text in a `table_caption` block (e.g. ResNet Page 5 Table 1: *"Table 1. Error rates (%) on ImageNet."*) must produce a valid selection mapping with `targetUnits[0].layoutClass === "table_caption"`, and allow creating an annotation whose target stores `source_class = "table_caption"` and canonical table caption quote.
  *Evidence:* Playwright browser test selecting Table 1 caption; verifying annotation creation succeeds with HTTP 201 and target displays under Table 1 in the PDF viewer.

- **AC-P0-05 Display Formula (`isolate_formula`) Eligibility & Targeting (Decision A; Area 4).**
  Selecting selectable text across a display formula block (`isolate_formula`, e.g. ResNet Page 3 Formula 1: `"y = F(x, {Wi}) + x."`) must produce a valid selection mapping with `targetUnits[0].layoutClass === "isolate_formula"`, storing `source_class = "isolate_formula"`, with original bounding box enclosing the formula.
  *Evidence:* Browser test in `tests/e2e/nonprose-selection.spec.ts` selecting `"y = F(x, {Wi}) + x."`; creating a note `"Core residual equation"`; verifying note card in `NotesPanel` renders the formula quote and page 3 badge.

- **AC-P0-06 Formula Caption (Equation Number) Eligibility & Targeting (Decision A; Area 4).**
  Selecting an equation number tag (`formula_caption`, e.g. ResNet Page 3 `"(1)"` or `"(2)"`) must produce a valid selection mapping with `targetUnits[0].layoutClass === "formula_caption"`, creating a target with `source_class = "formula_caption"` and `exact_quote = "(1)"`.
  *Evidence:* Browser test selecting `"(1)"` beside Formula 1; clicking "Highlight"; asserting target created with `exact_quote = "(1)"` and `source_class = "formula_caption"`.

- **AC-P0-07 Heading (`title`) Block Deferral & Outline Tree Invariance (Decision B, T; Areas 5, 50).**
  In P0, `title` blocks (section headings and document titles) are excluded from non-prose selection mapping. Selecting heading text must NOT create a block anchor in P0, and must NEVER create a pseudo-section or modify `ir.sections` or the document outline tree.
  *Evidence:* Selection test over `"2. Related Work"` heading returns `mapping.status === "non_prose"` or refusal with reason; unit test verifying `ir.sections` hierarchy is bit-identical before and after annotation creation.

- **AC-P0-08 Table Body & Footnote Class Eligibility Boundary (Decision C; Area 6).**
  Text selection within raw table body blocks (`layout_class == "table"`) must be refused with user-facing status `unsupported_class` ("表格内容暂不支持添加文字笔记，请选择表格标题。"). `table_footnote` selection is deferred to P1 and similarly refused in P0.
  *Evidence:* Unit test in `frontend/src/tests/nonprose-selection.test.ts` providing DOM selection over ResNet Table 1 body; asserting `mapping.status === "unsupported_class"`.

- **AC-P0-09 Figure / Image Region Drawing Exclusion & Refusal (Decision D; Area 7).**
  Text selection within `layout_class == "figure"` blocks (run-together axis numbers and diagram labels) must be strictly refused with status `unsupported_class` ("图表内部文字不支持添加笔记，请选择图表标题。"). No free-hand or canvas drawing UI is permitted.
  *Evidence:* Unit test providing selection over ResNet Figure 1 internal label string `"0 1 2 3 4 5 601020iter."`; asserting `mapping.status === "unsupported_class"`.

- **AC-P0-10 Unsupported Source Class & Abandon Block Explicit Refusal (Decision P, S; Areas 8, 50).**
  Selections covering `abandon` blocks (arXiv stamps, running headers, footers, page numbers) must be refused as a whole with status `unsupported_class` and message `"页眉、页脚及标识内容不支持添加笔记。"`. If a multi-block selection touches an unsupported class, the entire gesture is refused rather than silently truncated.
  *Evidence:* Browser selection covering an arXiv banner on page 1; asserting selection tooltip displays refusal reason; Notes creation button is disabled.

- **AC-P0-11 Generalized Source-Unit Identity (`AnchorableSourceUnit`) (Decision E; Area 9).**
  The selection and targeting subsystem must treat prose paragraphs and non-prose blocks under the unified `AnchorableSourceUnit` interface. Every target source must carry `sourceAnchorId`, `anchorVersion`, `pageNumber`, `layoutClass`, `bbox`, `rects`, `quote`, `prefix`, and `suffix`.
  *Evidence:* TypeScript typecheck `tsc --noEmit` asserting `AnchorableSourceUnit` polymorphic handling in `frontend/src/notes/targets.ts`.

- **AC-P0-12 Deterministic Block Anchor Recipe & Versioning (Decision F, G, H; Areas 10, 17).**
  Every non-prose block anchor must be computed using `BLOCK_ANCHOR_VERSION = "1"` via `sha256("1" | content_hash | page_number | layout_class | quantized_bbox | canonical_text)`. Two extractions of the same document producing the same block must yield bit-identical 64-character hex strings.
  *Evidence:* Python test `test_block_anchor_determinism()` in `tests/test_anchors.py` asserting identical hash across 100 iterations.

- **AC-P0-13 Document Fingerprint Scoping & Cross-Paper Collision Immunity (Decision H; Area 11).**
  Block anchors must be scoped by the document's SHA-256 `content_hash`. An identical caption (e.g. `"Figure 1. Architecture."`) on page 1 of two different PDFs must yield distinct `source_anchor_id` hashes.
  *Evidence:* Unit test computing block anchor for `"Figure 1. Overview."` on Document A (`hash_a`) and Document B (`hash_b`); asserting `anchor_a != anchor_b`.

- **AC-P0-14 Page-Scoped Target Identity & 1-Based Page Indexing (Area 12).**
  Block targets must record 1-based `page_number` ($\ge 1$). Zero-based page indices (`page_index`) must never be stored in `annotation_targets.page_number`.
  *Evidence:* SQLite query `SELECT COUNT(*) FROM annotation_targets WHERE page_number < 1`; strictly returns 0.

- **AC-P0-15 Coordinate Quantization & Tolerance Grid ($2.0\text{ pt}$) (Decision H; Areas 13, 20).**
  Block bounding boxes in the anchor payload must be quantized using `GEOMETRY_QUANTUM_PT = 2.0` via `round(round(coord / 2.0) * 2.0, 4)`. A sub-point bounding-box jitter of $\le 0.8\text{ pt}$ in layout extraction must produce identical quantized coordinates and an identical anchor hash.
  *Evidence:* Unit test perturbing ResNet Figure 1 caption bbox by $(+0.4, -0.3, +0.2, -0.5)\text{ pt}$; verifying `source_block_anchor_id()` remains identical.

- **AC-P0-16 Canonical Block Text Generation & Whitespace Normalization (Areas 14, 21).**
  Canonical block text must remove soft hyphens (`\u00ad`), resolve hyphenated line-wraps via `join_wrapped_lines`, and collapse whitespace. Case, punctuation, and digits must be preserved verbatim.
  *Evidence:* Caption text `"Figure 1. Deep convolu-\ntional networks."` yields canonical `"Figure 1. Deep convolutional networks."`.

- **AC-P0-17 Formula Text Normalization & Mathematical Symbol Preservation (Decision I; Area 22).**
  Normalization of `isolate_formula` and `formula_caption` text must collapse multiple whitespace characters to a single space and apply NFKC normalization, while strictly preserving mathematical symbols (`+`, `-`, `=`, `{`, `}`, `(`, `)`, `[`, `]`, `_`, `^`, `/`, `*`) and case sensitivity (`x` vs `X`).
  *Evidence:* Formula `"y  =  F(x, {Wi}) \n+ x."` normalizes to `"y = F(x, {Wi}) + x."`; unit test verifies `Wi` retains uppercase `W` and lowercase `i`.

- **AC-P0-18 Disambiguation of Duplicate Captions & Duplicate Formulas (Decision R; Areas 15, 16).**
  When a document contains identical caption text on the same page (e.g. subfigures labeled `"(a)"` and `"(a)"` or two equations numbered `"(1)"`), distinct quantized bounding boxes must guarantee distinct anchor hashes.
  *Evidence:* Unit test creating two blocks on page 2 with text `"(a)"` at $y=100$ and $y=400$; asserting their generated `source_anchor_id` values are distinct.

- **AC-P0-19 Anchor Stability Across Repeated Extractions (Area 18).**
  Re-extracting an un-modified PDF file must generate bit-identical `source_anchor_id` values for 100% of non-prose blocks.
  *Evidence:* Running extraction twice on `resnet.pdf`; verifying all 18 caption/formula anchors match 100.0%.

- **AC-P0-20 Reading-Order Invariance Across Block Reordering (Area 19).**
  A non-prose block anchor's hash must NOT contain block index, ordinal position, or reading order sequence number. Swapping the extraction list order of two blocks on a page must leave both anchor hashes unchanged.
  *Evidence:* Unit test computing anchor with block passed first vs second in list; anchor hash is bit-identical.

- **AC-P0-21 Source Class Preservation in Schema & Storage (Decision G, O; Areas 23, 51).**
  The target database schema must record `source_class` in `annotation_targets` (allowed values: `'paragraph'`, `'figure_caption'`, `'table_caption'`, `'formula_caption'`, `'isolate_formula'`). Existing targets default to `'paragraph'`.
  *Evidence:* SQLite query `SELECT DISTINCT source_class FROM annotation_targets` on seeded database returns valid enumerated values only.

- **AC-P0-22 Selection Mapping & Geometric Intersection for Non-Prose Blocks (Area 24).**
  When a reader drags across a non-prose block, `matchNonProseBlocks()` must intersect the selection line rectangles with `irPage.blocks` bboxes, applying horizontal overlap $\ge 4.0\text{ pt}$ and vertical coverage $\ge 0.5$, successfully producing target source objects.
  *Evidence:* Frontend unit test `frontend/src/tests/nonprose-selection.test.ts` asserting selection over ResNet Page 3 Formula 1 produces non-empty rects and matching block ID.

- **AC-P0-23 Mixed Prose + Caption Heterogeneous Target Assembly (Decision K; Area 25).**
  A selection spanning from the end of a body paragraph across an adjacent figure caption must produce a single `Annotation` containing two targets: Target 0 (`source_class: "paragraph"`), Target 1 (`source_class: "figure_caption"`), ordered by document reading sequence.
  *Evidence:* Unit test simulating cross-block drag in `frontend/src/tests/targets.test.ts`; verifying resulting annotation payload has 2 targets with distinct `source_class` values.

- **AC-P0-24 Mixed Prose + Formula Heterogeneous Target Assembly (Decision K; Area 26).**
  A selection spanning from a display formula into the following explanatory paragraph must produce a single `Annotation` with Target 0 (`source_class: "isolate_formula"`) and Target 1 (`source_class: "paragraph"`).
  *Evidence:* Unit test verifying target list order and class assignments for mixed formula+prose selection.

- **AC-P0-25 Multi-Target Reading Order & Sequence Determinism (Area 27).**
  Targets in a multi-target non-prose annotation must be deterministically sorted by canonical document reading order: primary sort `page_number ASC`, secondary sort $y_0\text{ ASC}$, tertiary sort $x_0\text{ ASC}$. Target orders ($0, 1, \dots$) must strictly reflect this sequence regardless of whether the user dragged forward or backward.
  *Evidence:* Test creating annotation via backward drag (caption to preceding paragraph); verifying `targets[0]` is the paragraph and `targets[1]` is the caption.

- **AC-P0-26 Cross-Page Selection Interaction Involving Non-Prose Units (Area 28).**
  A cross-page selection spanning from a caption or formula at the bottom of Page $P$ to a paragraph at the top of Page $P+1$ must create valid targets for both pages, with clamped text-node geometry on each page.
  *Evidence:* Unit test in `frontend/src/tests/crosspage-selection.test.ts` executing cross-page selection from page 1 caption to page 2 prose; verifying HTTP 201 with targets across pages 1 and 2.

- **AC-P0-27 Clamped Persistent Geometry & Anti-Container Bbox Defense (Area 29).**
  Per-target `rects` for non-prose annotations must be clamped to the individual line/character bounding rects from `getClientRects()`. A target's `rects` must NEVER span the full page or full text-layer container ($1050 \times 1486$). Every rect must satisfy $rx_0 \ge x_0 - 0.5$ and $ry_1 \le y_1 + 0.5$ against `original_bbox`.
  *Evidence:* Unit test asserting `TargetPayload` validator rejects rects exceeding `original_bbox`; verifying all generated rects have width $< 550\text{ pt}$ and height $< 50\text{ pt}$.

- **AC-P0-28 Annotation Persistence, Page Reload & Store Hydration (Area 30).**
  Creating a non-prose annotation, refreshing the browser page (`location.reload()`), and waiting for workspace hydration must restore the annotation in `workspaceStore.annotations` with full targets, correct quotes, and active highlight overlays.
  *Evidence:* Playwright test creating caption highlight; reloading page; asserting `data-testid="highlight-layer"` renders overlay on Page 1 at the caption's coordinates.

- **AC-P0-29 Application Restart Durability & SQLite Transaction Safety (Area 31).**
  Non-prose annotations and targets must be persisted in SQLite within a single atomic transaction. Restarting the backend server process must reload all non-prose annotations without data loss or integrity errors.
  *Evidence:* Integration test stopping FastAPI test server; restarting server; calling `GET /api/documents/{id}/annotations`; verifying all created non-prose notes returned with HTTP 200.

- **AC-P0-30 Page-Scoped Reattachment Cascade for Non-Prose Anchors (Decision Q; Area 32).**
  When reattaching annotations against a re-extracted IR:
  1. Look up exact anchor ID on the recorded `page_number`. If found -> `EXACT`.
  2. Fallback to exact canonical text match within the same `layout_class` on the same page. If 1 match -> `REATTACHED`.
  3. Fallback to $\ge 50\%$ coverage text match within the same `layout_class` on the same page. If 1 match -> `REATTACHED`.
  4. Never search across page boundaries. Never match a caption against a prose paragraph.
  *Evidence:* Unit test in `tests/test_reattach.py` verifying caption reattachment with shifted bbox resolves to `REATTACHED` on the same page.

- **AC-P0-31 Ambiguous Reattachment Handling & State Notification (Decision R; Area 33).**
  If multiple non-prose blocks of the same `layout_class` on the page match the quote during reattachment (e.g. duplicate subcaptions `"(a)"`), resolution must return `AnchorState.AMBIGUOUS` with candidate block IDs. The system must NEVER arbitrarily pick one candidate.
  *Evidence:* Unit test setting up two identical captions on page 2 with perturbed bboxes; asserting `reattach()` returns `AMBIGUOUS`.

- **AC-P0-32 Orphaned Target Preservation & Zero Data Loss (Area 34).**
  If a non-prose block is removed in re-extraction (0 matches on page), reattachment must report `AnchorState.ORPHANED`. The annotation row and all target data must remain intact in the database and visible in the Notes panel with an `ORPHANED` warning badge.
  *Evidence:* Test reattaching note whose caption text was deleted; verifying target `resolution_state == "ORPHANED"`, note remains in `list_for_document()`.

- **AC-P0-33 In-Memory Note Substring Search Over Caption & Formula Quotes (Area 35).**
  Client-side substring search in `filterAnnotations()` must match against `annotation.quote` and target quotes for non-prose notes. Searching a formula substring (e.g. `"Wsx"` or `"CIFAR-10"`) must filter the list instantly ($< 5.0\text{ ms}$) to matching notes.
  *Evidence:* Frontend unit test searching `"Wsx"`; verifying ResNet Formula 2 note matches and non-matching notes are filtered out.

- **AC-P0-34 Markdown Export Formatting for Non-Prose Notes (Decision M; Area 36).**
  Markdown export (`/api/documents/{id}/export/notes.md`) must include source class indicators in entry headers for non-prose notes (e.g. `### Note 1 (Figure Caption)` or `**Type:** Formula`), rendering the verbatim formula/caption quote in blockquotes.
  *Evidence:* Test calling markdown export endpoint; inspecting response body for `### Note 1 (Figure Caption)` and `> Figure 1. Training error...`.

- **AC-P0-35 JSON Archival Export Format Preserving Block Anchors & `source_class` (Decision J, M, U; Area 37).**
  JSON export (`/api/documents/{id}/export/notes.json`) must maintain `schema_version = "1"`. Each target in `targets` must include `source_anchor_id`, `anchor_version`, `source_class`, `original_bbox`, `rects`, `exact_quote`, and `resolution_state`.
  *Evidence:* Automated test executing `json.loads(response.text)`; verifying `targets[0].source_class === "figure_caption"` and valid JSON schema validation.

- **AC-P0-36 Original PDF Viewer Rendering & Highlighting Integrity (Area 38).**
  Highlight overlays for non-prose annotations in the Original PDF viewer must render at the exact geometric coordinates of the selected caption or formula text, matching the visual appearance of prose highlights.
  *Evidence:* Browser test measuring DOM bounding box of rendered highlight overlay element; asserting distance to underlying caption text span is $< 1.0\text{ pt}$.

- **AC-P0-37 Translation & Bilingual View Isolation (Areas 39, 40).**
  Non-prose annotations must be anchored exclusively to source PDF geometry. Selections in the translated pane or bilingual translated column must be refused with status `non_prose`. Translation tasks must ignore non-prose annotations.
  *Evidence:* Browser test attempting text selection in right-hand translated pane; asserting `captureSelection().translatedPane === true` and status `non_prose`.

- **AC-P0-38 Rotated Page Refusal & Geometry Transform Safety (Area 41).**
  Selecting text on a rotated PDF page (`PageIR.rotation != 0`) must be refused whole with message `"选区内有页面无法映射（页面旋转或原文结构尚未就绪）。"`. No corrupted un-rotated coordinates may be stored.
  *Evidence:* Unit test with page having `rotation = 90`; asserting `captureSelection()` returns `cross_page_refused` status.

- **AC-P0-39 Viewport Zoom & Fit-Width Coordinate Invariance (Areas 42, 43).**
  Changing viewer zoom (50%, 100%, 150%, 200%, or fit-width) must NOT alter the canonical PDF point coordinates of created or rendered non-prose annotations. Viewport-to-PDF transform must divide by current `pageScale`.
  *Evidence:* Creating a note on Figure 1 caption at 100% zoom; zooming to 200%; verifying stored `original_bbox` and `rects` are bit-identical; overlay scales proportionally.

- **AC-P0-40 Virtualized DOM Scroll & Boundary Clamping Completeness (Area 44).**
  If a user drags across a caption while scrolling and the virtualizer unmounts a page container mid-gesture, `readDomSelection()` must detect `measuredChars < reportedChars` and refuse with status `unmeasurable` rather than silently saving truncated geometry.
  *Evidence:* Unit test setting `reportedChars = 50, measuredChars = 20`; asserting `captureSelection()` returns status `unmeasurable`.

- **AC-P0-41 Source PDF Immutability & Zero External AI Calls (Areas 45, 46).**
  All non-prose selection, mapping, creation, listing, search, and export operations must execute 100% locally. Zero LLM inferences, zero provider calls, and zero PDF disk modifications are permitted.
  *Evidence:* Network inspection during full non-prose test execution verifying provider call counter strictly equals 0; `source.pdf` file hash unchanged.

- **AC-P0-42 Paper QA Selection Scope Isolation — Zero Non-Prose Contamination (Decision L; Area 47).**
  Paper QA Selection scope must refuse questions asked solely against non-prose targets, reporting status `non_prose` ("选区仅包含图表标题或公式，暂不支持针对非正文内容进行学术问答"). Mixed selections pass only their prose paragraph IDs to QA context.
  *Evidence:* Unit test in `frontend/src/tests/qa-selection.test.ts` providing selection mapping containing only `figure_caption`; asserting QA composer Selection chip displays disabled status with tooltip.

- **AC-P0-43 FTS & Vector Retrieval Corpus Immutability (Area 48).**
  Non-prose annotations, user comments, and captions must NEVER be indexed into `search.db` (FTS chunks), must never be returned in `EvidenceItem` bundles by `retrieve_evidence()`, and must never be cited in whole-paper or section QA.
  *Evidence:* AST check verifying `backend/app/qa` modules never import non-prose annotation targets; querying `search.db` confirms no caption annotations indexed.

- **AC-P0-44 DocumentAnalysis Scope & Hierarchy Invariance (Area 49).**
  Document structure analysis (`analysis.json`, generated by `DocumentAnalysis`) must remain strictly derived from `DocumentIR` prose structure. Creating non-prose annotations must not trigger or modify `analysis.json`.
  *Evidence:* Comparing `analysis.json` checksum before and after creating 10 caption and formula annotations; checksum is bit-identical.

- **AC-P0-45 Backward Compatibility & Legacy Anchor Hydration (Decision N; Area 50).**
  Existing annotations created under `SCHEMA_VERSION = 4` with `source_class IS NULL` must load seamlessly in both backend and frontend, defaulting `source_class = "paragraph"` without errors.
  *Evidence:* Fixture test loading database with legacy targets; calling `GET /api/documents/{id}/annotations`; asserting all targets return `source_class: "paragraph"`.

- **AC-P0-46 Additive Database Migration (`SCHEMA_VERSION = 5`) (Decision O; Area 51).**
  The database migration `_migration_005_add_target_source_class` must execute cleanly on existing databases, adding `source_class TEXT NOT NULL DEFAULT 'paragraph'` to `annotation_targets` and updating `schema_version` to 5.
  *Evidence:* Running `bootstrap_database()` on a version 4 SQLite file; verifying `SELECT MAX(version) FROM schema_version` returns 5.

- **AC-P0-47 Frontend Production Bundle Size Ceiling (< 350.0 kB) (Area 52).**
  Implementing non-prose selection mapping and target construction must NOT add external libraries (`katex`, `mathjax`, `fabric`, `konva`). Production build (`npm run build`) must remain strictly under the **350.0 kB** initial bundle ceiling (maintaining headroom over baseline 335.32 kB).
  *Evidence:* Vite production build output confirms initial bundle size $\le 350.0\text{ kB}$.

- **AC-P0-48 Browser E2E Lifecycle Verification (Area 53).**
  End-to-end browser test in real Chromium/Edge verifying full user lifecycle: open ResNet; select Figure 1 caption; create note; select Formula 1; create highlight; search note in NotesPanel; export Markdown; verify exported file contains both entries with correct source classes.
  *Evidence:* Playwright test `tests/e2e/nonprose-full-lifecycle.spec.ts` passes with exit code 0.

---

### 6.2 P1 SHOULD — Usability & Extended Classes

- **AC-P1-01 Table Footnote Eligibility (`table_footnote`) (Decision C; Area 6).**
  Extend selection mapping to support `table_footnote` blocks (e.g. ResNet Table 1 footnote: `"* denotes models with 10-crop testing"`), creating targets with `source_class: "table_footnote"`.
  *Evidence:* Browser test selecting Table 1 footnote creates persistent highlight.

- **AC-P1-02 Section Heading Block Targeting (`title`) (Decision B; Area 5).**
  Extend selection mapping to support verified `title` blocks (section headings larger than body text), creating targets with `source_class: "heading"`.
  *Evidence:* Browser test selecting `"3. Deep Residual Learning"` heading creates persistent highlight.

- **AC-P1-03 Visual Formula KaTeX Math Preview in Notes Card (Decision I).**
  In the Notes panel card, render mathematical formula quotes using KaTeX or lightweight MathML rendering if available, falling back to verbatim text.
  *Evidence:* Note card for Formula 1 displays formatted mathematical symbols.

- **AC-P1-04 Filter Notes by Source Class in Notes Panel.**
  Provide a filter pill in `NotesPanel.tsx` allowing users to filter notes by source class: All, Prose, Captions, Formulas.
  *Evidence:* Clicking "Formulas" filter displays only notes attached to `isolate_formula` or `formula_caption`.

- **AC-P1-05 Server-Side Reattachment Batch Optimization for Documents with > 100 Notes.**
  Pre-index page blocks into a lookup map by `layout_class` during document reattachment to achieve reattachment latency $< 20.0\text{ ms}$ for 100 non-prose notes.
  *Evidence:* Benchmark test reattaching 100 caption notes runs in $< 20\text{ ms}$.

---

### 6.3 P2 OPTIONAL — Advanced Region & Tabular Marginalia

- **AC-P2-01 2D Spatial Region-Box Drawing for Diagram Figures (`figure`) (Decision D; Area 7).**
  Add a dedicated "Region Highlight" tool in PDF toolbar enabling readers to draw a 2D rectangular box over diagram figures, storing normalized bounding box coordinates.
  *Evidence:* Drawing box over ResNet Figure 1 diagram creates spatial region annotation.

- **AC-P2-02 Tabular Cell Grid Selection for Tables (`table`) (Decision C; Area 6).**
  Introduce table cell extraction model allowing readers to click and highlight individual tabular cells.
  *Evidence:* Selecting cell `(Row 3, Col 2)` in Table 1 creates structured table-cell target.

- **AC-P2-03 Multi-Document Non-Prose Marginalia Aggregation Shelf.**
  A global researcher view listing all formulas and figure captions annotated across all papers in the local library.
  *Evidence:* Library shelf displays aggregate list of 45 formula annotations.

---

## 7. Verification Protocol

Every verification step below is executable, non-tautological, and capable of failing.

### 7.1 Block Anchor Hash Verification (`tests/test_anchors.py`)
```python
def test_block_anchor_hashing():
    content_hash = "1e0651b6810e"
    page = 1
    layout_class = "figure_caption"
    bbox = (307.3, 304.1, 546.2, 347.7)
    text = "Figure 1. Training error (left) and test error (right) on CIFAR-10."
    
    anchor1 = source_block_anchor_id(content_hash, page, layout_class, bbox, text)
    anchor2 = source_block_anchor_id(content_hash, page, layout_class, bbox, text)
    assert anchor1 == anchor2
    assert len(anchor1) == 64
    
    # Verify different layout_class produces different anchor
    anchor_table = source_block_anchor_id(content_hash, page, "table_caption", bbox, text)
    assert anchor1 != anchor_table
```

### 7.2 Database Migration 005 Verification (`tests/test_db_migration.py`)
```python
def test_migration_005_applied(tmp_path):
    db_path = tmp_path / "test.db"
    conn = bootstrap_database(db_path)
    cur = conn.cursor()
    cur.execute("PRAGMA table_info(annotation_targets)")
    columns = {row[1]: row[2] for row in cur.fetchall()}
    assert "source_class" in columns
    assert columns["source_class"] == "TEXT"
```

### 7.3 Frontend Selection Mapping Verification (`frontend/src/tests/nonprose-selection.test.ts`)
```typescript
it("maps figure_caption text selection to AnchorableSourceUnit", () => {
  const ir = mockResNetIr();
  const mapping = captureNonProseSelection(ir, mockFigureSelection());
  expect(mapping.status).toBe("valid");
  expect(mapping.targetUnits).toHaveLength(1);
  expect(mapping.targetUnits[0].layoutClass).toBe("figure_caption");
  expect(mapping.targetUnits[0].pageNumber).toBe(1);
});
```

---

## 8. Non-Goals & Explicit Boundary Exclusions

To ensure strict execution focus and prevent architectural scope creep, the following areas are designated as **explicit non-goals** for DS-QA-013:

1. **Absorption into `ParagraphIR`:** Captions, formulas, and headings will never be converted into `ParagraphIR` or merged into body prose.
2. **Paper QA Corpus Expansion:** Non-prose elements will not be added to Paper QA evidence retrieval or FTS index chunks in `search.db`.
3. **Diagram Free-Hand / Canvas Drawing:** No free-hand drawing, polygon lassos, or image clipping tools will be introduced for `figure` blocks.
4. **Tabular Cell Matrix Parsing:** No cell-level table grid segmentation or matrix table editing will be built in P0.
5. **Abandon Block Annotation:** Page furniture (`abandon` blocks containing arXiv banners, headers, footers) is permanently non-annotatable.
6. **Annotation Import / PDF Writeback:** No Adobe Acrobat XFDF import/export or PDF byte writeback will be performed.
7. **External Bundle Expansion:** Zero third-party math rendering, search, or drawing libraries will be added to `package.json`.
