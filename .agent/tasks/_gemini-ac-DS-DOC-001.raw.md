# DS-DOC-001 — Acceptance Criteria (FROZEN)

> **Author:** Gemini 3.8 Flash (High) via Antigravity CLI — *independent Acceptance Criteria Agent*  
> **Authored:** 2026-09-17, **before any implementation code was written**  
> **Scope:** Canonical Document Intermediate Representation (IR), deterministic layout and structure extraction, page / section / paragraph mapping, two-column reading order resolution, equation and figure isolation, persistent IR serialization, and retrieval-ready citation coordinates for academic PDFs.  
>
> **FROZEN.** No criterion may be silently weakened or deleted. Only `[P0]` criteria block completion.

---

# Acceptance Criteria: DS-DOC-001 — Document IR + Page / Section / Paragraph Mapping

- **Task ID**: `DS-DOC-001`
- **Role**: Independent Acceptance Criteria Agent
- **Status**: Defined prior to implementation (**FROZEN**)
- **Scope**:
  - Establish the canonical, deterministic structured representation (`DocumentIR`) of an academic PDF that every subsequent feature shares: context-aware translation, Paper QA, page citations, glossary generation, section and document summaries, and "selection → ask AI".
  - Extract physical layout blocks via the cached local `DocLayout-YOLO` ONNX model (~72 MiB) and PyMuPDF (`fitz`), classifying `title`, `plain text`, `abandon`, `figure`, `figure_caption`, `table`, `table_caption`, `table_footnote`, `isolate_formula`, and `formula_caption`.
  - Perform deterministic two-column reading order reconstruction without interleaving left and right columns.
  - Distinguish physical `TextBlock` layout elements from semantic `Paragraph` units; merge cross-line, cross-column, and cross-page continuous text.
  - Generate stable, content-addressable identifiers (`document_id`, `page_number`, `section_id`, `paragraph_id`, `block_id`) that remain 100% identical across repeated runs.
  - Exclude headers, running footers, and page numbers marked as `abandon` from semantic paragraphs and retrieval corpora.
  - Isolate display formulas (`isolate_formula`) and captions so mathematics is not mangled into surrounding prose.
  - Normalize whitespace and hyphenated line breaks safely while preserving exact citations (`[12]`, `(Smith et al., 2025)`), Unicode mathematics, and scientific symbols.
  - Persist the canonical IR to disk as `<documents_dir>/<document_id>/ir.json` via atomic writes, guarded by source hash verification.
  - Expose read-only HTTP endpoints: `GET /api/documents/{id}/ir`, `GET /api/documents/{id}/sections`, and `GET /api/documents/{id}/page-mapping` conforming to [`docs/API_CONTRACT.md`](file:///D:/marti/SciPrograms/docs/API_CONTRACT.md).
  - Handle corrupt, encrypted, scanned (image-only), and sparse PDFs honestly without crashing.
- **Explicit Exclusions**:
  - **No LLM calls**: No summaries, no glossary generation, no entity extraction, no Paper QA, no translation.
  - **No vector databases or embeddings**: No Chroma, FAISS, sqlite-vec, or embedding model invocations.
  - **No OCR execution**: Scanned PDFs with no text layer report `has_text_layer = false` and `ocr_required = true`; OCR execution is deferred.
  - **No modification of the frozen translation kernel**: [`backend/app/pdfkernel/`](file:///D:/marti/SciPrograms/backend/app/pdfkernel/) remains frozen. Upstream kernel integration for layout reuse is deferred to Phase 6.
- **Permitted File Modifications**:
  - `backend/app/document/**` (new package for Document IR models, parser, layout adapter, reading order, normalizer, and serializer)
  - `backend/app/documents/store.py` (adding `ir_file(document_id)` path helper to [`DocumentStore`](file:///D:/marti/SciPrograms/backend/app/documents/store.py#L96-L176))
  - `backend/app/api/documents.py` (adding `GET /api/documents/{id}/ir`, `GET /api/documents/{id}/sections`, `GET /api/documents/{id}/page-mapping`)
  - `backend/app/db.py` (optional migration 004 only if an additive SQLite tracking table is introduced, updating [`SCHEMA_VERSION`](file:///D:/marti/SciPrograms/backend/app/db.py#L26-L28))
  - `backend/tests/test_document_ir.py` (comprehensive offline test suite)
  - `backend/tests/test_db.py`, `backend/tests/test_isolation.py` (only if migration 004 is added)
- **Target Runtime**: Python 3.12.13 (`backend/.venv`) on Windows 11.
- **Priority Tags**:
  - `[P0]`: **MUST** — Blocks completion of this task.
  - `[P1]`: **SHOULD** — Important operational capability; does not block completion if deferred with documented rationale.
  - `[P2]`: **OPTIONAL** — Desirable polish or architectural hook.

---

# Flawed Premises & Technical Reality Checks

Before establishing criteria, six critical technical realities and misconceptions must be stated plainly:

1. **DocLayout-YOLO does NOT output section hierarchies or levels.**
   *Flawed premise:* Expecting the YOLO ONNX model to output `level: 1`, `level: 2`, or hierarchical sub-headings.  
   *Reality:* The model's label set is strictly:
   `{0: 'title', 1: 'plain text', 2: 'abandon', 3: 'figure', 4: 'figure_caption', 5: 'table', 6: 'table_caption', 7: 'table_footnote', 8: 'isolate_formula', 9: 'formula_caption'}`.
   Both document titles and section headings are detected as class `0: 'title'`. Discerning section hierarchy (`1. Introduction` vs `1.1 Background`) requires deterministic typographic heuristics (font size, bold flags, line spacing from PyMuPDF) combined with numbering regexes. Where numbering is absent, hierarchical levels cannot be hallucinated; the IR must record `level: 1` or `level: null`.
2. **Upstream PDFMathTranslate cannot immediately reuse this IR without modifying the frozen kernel.**
   *Flawed premise:* Assuming DS-DOC-001 will immediately stop upstream `translate()` from re-running YOLO layout detection.  
   *Reality:* Upstream `pdf2zh.high_level.translate()` executes its own internal layout prediction loop in Python (`layout[page.pageno] = box`). Upstream provides no public parameter to inject external layout boxes. Modifying upstream violates ADR-001. Therefore, wiring translation to consume this cached IR is deferred to Phase 6. In DS-DOC-001, Document IR is cached for Document Intelligence, Paper QA, reader navigation, and future context translation.
3. **Coordinate systems are inverted between image space, PDF points, and upstream masks.**
   *Flawed premise:* Assuming bounding boxes from DocLayout-YOLO, PyMuPDF, and upstream mask arrays share the same coordinate space.  
   *Reality:* PyMuPDF text rectangles use PDF points with top-left origin $(0, 0)$ where $y$ increases downwards. The ONNX model runs on pixel images resized to multiples of 32. Upstream's mask flips $y$ (`h - y1 - 1`) to match bottom-left PDF space. The canonical IR must strictly standardize on **PDF point coordinates with top-left origin** `[x0, y0, x1, y1]`, scaled to page width and height in points (`pt`).
4. **Layout bounding boxes are NOT semantic paragraphs.**
   *Flawed premise:* Equating one YOLO bounding box to one paragraph.  
   *Reality:* A single `plain text` bounding box frequently contains multiple paragraphs separated by indents or vertical margins. Conversely, a single academic paragraph is often severed into multiple bounding boxes across column boundaries or page breaks. Semantic paragraph assembly must merge physical blocks based on sentence continuity and typographic cues.
5. **Abstract and References cannot be guaranteed purely by layout classification.**
   *Flawed premise:* Expecting layout detection alone to segment the abstract or bibliography.  
   *Reality:* DocLayout classifies abstract paragraphs and references as generic `plain text`. Abstract and reference boundaries must be identified deterministically using keyword anchors (e.g., `^Abstract`, `^References`, `^Bibliography`) matched against `title` or heading blocks. If no anchor exists, the IR must remain honest and leave `is_abstract = false` rather than guessing.
6. **No SQLite table proliferation.**
   *Flawed premise:* Creating separate relational tables for `pages`, `sections`, `paragraphs`, `text_blocks`, `citations`.  
   *Reality:* [`test_db.py`](file:///D:/marti/SciPrograms/backend/tests/test_db.py#L77-L82) explicitly asserts that speculative tables (`pages`, `sections`, `paragraphs`) are forbidden. Persisting canonical IR as `<documents_dir>/<document_id>/ir.json` matches the repository's file-based artifact convention (`source.pdf`, `mono.pdf`, `dual.pdf`), avoids DB lock contention, and eliminates schema migration churn.

---

# Design Decisions (Settling Q1 – Q14)

### Q1. Page Numbering Conventions
- **Internal / Indexing**: `page_index` is strictly **0-based** ($0 \le \text{page\_index} < \text{page\_count}$), matching Python indexing, PyMuPDF `doc[page_index]`, and array access.
- **User-Facing / Citations / Reader**: `page_number` is strictly **1-based** ($1 \le \text{page\_number} \le \text{page\_count}$), matching PDF reader UI, citations, and user perception.
- **Inviolable Rule**: In all IR data models, JSON schemas, and citations, the fields must be explicitly named `page_index` or `page_number`. The bare word `page` is prohibited in IR schemas to prevent off-by-one errors.

### Q2. Two-Column Reading Order Resolution
- On multi-column pages, blocks must be partitioned into column streams based on horizontal distribution ($x$-span relative to page median or column gutters).
- Blocks spanning across columns (e.g., paper titles, author blocks, full-width abstracts) are processed first in top-to-bottom order.
- Within column regions, reading order flows strictly **top-to-bottom through Column 1 (left)**, then **top-to-bottom through Column 2 (right)**.
- **Verification Rule**: In an objective test with a 2-column page, the text index of the last line of Column 1 must be strictly less than the text index of the first line of Column 2 (`text.index(col1_end) < text.index(col2_start)`). Interleaving is a P0 failure.

### Q3. Block vs. Paragraph Separation
- **`TextBlock` (Physical)**: Direct output of layout extraction representing a rectangular region on a specific page: `(block_id, page_index, page_number, bbox, text, layout_class)`.
- **`Paragraph` (Semantic)**: Coherent prose unit consisting of one or more `TextBlock` fragments: `(paragraph_id, section_id, text, block_ids, page_range, bounding_boxes)`.
- Semantic paragraphs bridge column breaks and page breaks where a sentence continues across the physical boundary without terminal punctuation.

### Q4. Stable IDs Across Re-Parses
- All identifiers are content-addressable and deterministic:
  - Document: `doc_id` (from store)
  - Section: `sec_{doc_id}_{ordinal:03d}` (or `sec_{doc_id}_{slug}` when numbered, e.g. `sec_1_intro`)
  - Paragraph: `p_{doc_id}_{ordinal:04d}` (assigned strictly in reading order sequence)
  - Block: `b_{doc_id}_p{page_number}_{ordinal:03d}`
- **Verification Rule**: Running the IR extraction pipeline twice on the same source PDF must produce byte-identical JSON IDs.

### Q5. Idempotency
- Running extraction on an already-parsed document produces the exact same IR payload and does not create duplicate entries or duplicate files.
- Re-parsing replaces `<documents_dir>/<document_id>/ir.json` atomically via a temporary file write and rename.

### Q6. Persistence vs. In-Memory
- **Canonical Storage**: The IR is persisted to disk at `<documents_dir>/<document_id>/ir.json` (UTF-8, formatted JSON).
- **Rationale**: Layout inference takes several seconds per document. Persisting `ir.json` in the document directory aligns with `mono.pdf`/`dual.pdf`, guarantees automatic cleanup on document deletion, prevents SQLite bloat, and avoids violating `list_tables()` guards.
- Subsequent reads load `ir.json` in $< 50\text{ ms}$ without running ONNX or PyMuPDF.

### Q7. Handling of `abandon` Regions
- Bounding boxes classified by DocLayout-YOLO as `abandon` (running headers, footers, page numbers) are retained in `blocks` with `layout_class: "abandon"` for debugging and coordinate completeness.
- **Exclusion Rule**: `abandon` blocks are strictly **excluded from semantic `Paragraph`s, section text, and Paper QA search corpora**. They must never contaminate downstream summaries or translations.

### Q8. Formulas and Equations
- Layout boxes classified as `isolate_formula` (display equations) are segregated into dedicated `FormulaBlock` objects with coordinates and extracted text/tokens.
- Formulas are never merged into adjacent prose paragraphs.
- Surrounding paragraphs maintain structural pointers to formula IDs rather than embedding broken glyph sequences into text.

### Q9. Text Fidelity, Normalization & Citation Preservation
- **Allowed Normalization**:
  - Unwrapping soft line breaks within a paragraph with a single space.
  - Removing soft hyphens and de-hyphenating words broken across lines (e.g. `trans-\nlation` $\rightarrow$ `translation`), while preserving true compound hyphens (e.g. `state-of-the-art`).
  - Unicode NFKC normalization (converting ligatures `ﬁ` $\rightarrow$ `fi`).
- **Strict Invariants**:
  - In-text academic citations (`[1]`, `[12-15]`, `(Author et al., 2024)`) MUST be preserved verbatim.
  - Every character span in a normalized paragraph must maintain traceable mapping back to its physical page and bounding box.

### Q10. Representation of Metadata Uncertainty
- Metadata fields use explicit nullable types: `title: str | None`, `authors: list[str] | None`, `abstract: str | None`, `doi: str | None`.
- Generic PDF generator tags (e.g., `"untitled"`, `"Microsoft Word"`, `"LaTeX2e"`) are rejected and mapped to `None`.
- If a document title cannot be determined with high confidence from layout class `title` or font hierarchy, it is set to `None`. No guessing is permitted.

### Q11. Degenerate Input Handling
- **Corrupt PDF**: Fails fast with HTTP **422 Unprocessable Entity**, `code: "SOURCE_INVALID"`.
- **Encrypted / Password-protected PDF**: Fails fast with HTTP **422 Unprocessable Entity**, `code: "PDF_ENCRYPTED"`.
- **Scanned PDF (No text layer)**: Generates valid IR with `has_text_layer = false`, `ocr_required = true`, `paragraphs = []`, and per-page `has_text = false`. Does NOT crash and does NOT attempt OCR.
- **Sparse / Empty Pages**: Emits empty page records without error.

### Q12. Performance Bounds
- **Extraction Bound**: Full IR extraction executes in $\le 1.5\text{ seconds per page}$ on standard CPU (e.g., $\le 15\text{ seconds}$ for a 10-page academic paper).
- **Read Bound**: `GET /api/documents/{id}/ir` executes in $< 50\text{ ms}$ for already-extracted documents.
- **Extraction Concurrency**: Extraction runs off the FastAPI event loop in a worker thread (`asyncio.to_thread`).

### Q13. Reuse vs. Re-run Strategy
- In this task, Document IR results are cached in `ir.json` for Document Intelligence and Paper QA.
- Upstream translation reuse of precomputed layout is explicitly documented as **deferred to Phase 6**, respecting the frozen state of [`backend/app/pdfkernel/`](file:///D:/marti/SciPrograms/backend/app/pdfkernel/).

### Q14. HTTP API Surface
- To allow the reader UI to render document outlines, support text selection, and enable citation jumps, this task exposes:
  - `GET /api/documents/{id}/ir` — Full canonical IR payload (JSON).
  - `GET /api/documents/{id}/sections` — Lightweight hierarchical table of contents.
  - `GET /api/documents/{id}/page-mapping` — Direct paragraph-to-page citation mapping.
  - `POST /api/documents/{id}/extract-ir` — Explicit extraction trigger (or lazy extraction on first read).

---

# Evaluation Dimensions Assignment

| Dimension | Priority | Handling & Justification |
| :--- | :--- | :--- |
| **1. Deterministic Extraction** | `[P0]` | Core goal. 100% deterministic, zero LLM or stochastic dependency. |
| **2. Document Identity** | `[P0]` | Anchored strictly to opaque `doc_id` and source file hash `sha256(source.pdf)`. |
| **3. Stable Page Numbering** | `[P0]` | Disambiguated `page_index` (0-based) and `page_number` (1-based); never mixed. |
| **4. Paragraph IDs** | `[P0]` | Deterministic identifiers (`p_{doc_id}_{ordinal:04d}`) preserved across re-runs. |
| **5. Section IDs** | `[P0]` | Deterministic hierarchy and identifiers (`sec_{doc_id}_{ordinal:03d}`). |
| **6. Reading Order** | `[P0]` | Natural semantic reading sequence; blocks follow document prose order. |
| **7. Multi-Column PDFs** | `[P0]` | Left column precedes right column; zero horizontal interleaving. |
| **8. Headings** | `[P0]` | Classified via DocLayout class `title` + PyMuPDF font size/weight heuristics. |
| **9. Paragraphs** | `[P0]` | Semantic grouping of text blocks; line unwrapping without breaking semantics. |
| **10. Sparse Pages** | `[P0]` | Blank, cover, or figure-only pages processed gracefully without errors. |
| **11. Figures / Tables / Captions** | `[P0]` | Segregated from prose; captions associated with respective element boxes. |
| **12. Equations / Formula-Heavy** | `[P0]` | Display formulas isolated; mathematical symbols preserved without corrupting prose. |
| **13. Page Coordinates** | `[P0]` | Explicitly defined PDF point coordinates `[x0, y0, x1, y1]` with top-left origin. |
| **14. Text Normalization** | `[P0]` | Safe whitespace / hyphen collapse; character offsets preserved. |
| **15. Preservation of Source Text** | `[P0]` | Raw text preserved; citations (`[12]`) retained verbatim. |
| **16. Unicode** | `[P0]` | CJK, Greek math symbols, diacritics, and ligatures correctly normalized. |
| **17. Duplicated Text** | `[P1]` | Filtering repeated watermarks or running headers across pages. |
| **18. Headers / Footers** | `[P0]` | Class `abandon` excluded from semantic paragraphs and search corpora. |
| **19. References Section** | `[P1]` | Deterministic detection of bibliography boundaries via heading regex. |
| **20. Title / Abstract Detection** | `[P1]` | Honest extraction if deterministic anchors exist; `None` if absent. |
| **21. Failure Handling** | `[P0]` | Normalized error envelope on all failure modes. |
| **22. Corrupt PDFs** | `[P0]` | Fast rejection with HTTP 422 `SOURCE_INVALID`. |
| **23. Encrypted PDFs** | `[P0]` | Fast rejection with HTTP 422 `PDF_ENCRYPTED`. |
| **24. Scanned PDFs** | `[P0]` | Honest metadata `has_text_layer = false`, `ocr_required = true`. |
| **25. OCR Compatibility** | **N/A** | **Out of scope for DS-DOC-001.** OCR execution is deferred to a future task. |
| **26. Persistence** | `[P0]` | Atomic write of `ir.json` in document directory; zero SQLite table bloat. |
| **27. Re-Opening Documents** | `[P0]` | Fast disk load ($< 50\text{ ms}$) yielding byte-identical IR. |
| **28. Idempotency** | `[P0]` | Re-extraction produces identical results without duplicating data. |
| **29. Source Immutability** | `[P0]` | Source PDF is opened read-only; hash and mtime verified unchanged. |
| **30. Performance** | `[P0]` | $\le 1.5\text{s / page}$ extraction; $< 50\text{ ms}$ cached retrieval; runs off event loop. |
| **31. DB Migration Safety** | `[P0]` | Additive and convergent if touched; zero speculative tables. |
| **32. Regression Protection** | `[P0]` | All 514 backend tests and 75 frontend tests continue to pass. |
| **33. Translation Compatibility**| `[P0]` | Translation pipeline remains 100% functional and unmodified. |
| **34. Automated Tests** | `[P0]` | Comprehensive offline pytest suite covering all layout conditions. |
| **35. Real-Paper Verification** | `[P1]` | Verification on multi-page dual-column arXiv / IEEE / ACM papers. |

---

# 1. Priority P0 (MUST) — Core Acceptance Criteria (Blocks Completion)

| ID | Priority | Description & Objective Verification Target | Rationale |
| :--- | :--- | :--- | :--- |
| **AC-DOC-01** | `[P0]` | **Canonical Document IR Data Model**<br>Define the immutable Document IR schema as Pydantic models or frozen dataclasses:<br>- `DocumentIR`: `document_id`, `content_hash`, `page_count`, `metadata`, `sections: list[SectionIR]`, `pages: list[PageIR]`, `paragraphs: list[ParagraphIR]`, `page_mapping: dict[str, int]`, `has_text_layer: bool`, `ocr_required: bool`.<br>- `PageIR`: `page_index` (0-based), `page_number` (1-based), `width_pt`, `height_pt`, `blocks: list[TextBlockIR]`.<br>- `SectionIR`: `id`, `title`, `level: int \| None`, `page_range: tuple[int, int]`, `parent_id: str \| None`.<br>- `ParagraphIR`: `id`, `section_id: str \| None`, `text: str`, `page_number: int`, `page_range: tuple[int, int]`, `block_ids: list[str]`, `bboxes: list[BoundingBox]`.<br>- `TextBlockIR`: `id`, `page_index: int`, `page_number: int`, `layout_class: str`, `bbox: tuple[float, float, float, float]`, `text: str`.<br>Model serialization and deserialization via `.model_dump_json()` / `.model_validate_json()` is lossless. | Establishes the single shared schema for translation, QA, and citations across all phases. |
| **AC-DOC-02** | `[P0]` | **Deterministic DocLayout-YOLO Layout Inference**<br>The layout engine loads the local cached ONNX model via [`ensure_layout_model()`](file:///D:/marti/SciPrograms/backend/app/pdfkernel/adapter.py#L75-L91). For each page, PyMuPDF renders an RGB pixmap; YOLO predicts bounding boxes with classification across the 10 supported classes (`title`, `plain text`, `abandon`, `figure`, `figure_caption`, `table`, `table_caption`, `table_footnote`, `isolate_formula`, `formula_caption`). Bounding boxes are deterministically mapped to PDF point coordinates `[x0, y0, x1, y1]` with top-left origin. | Employs the existing local vision model without new network dependencies or LLMs. |
| **AC-DOC-03** | `[P0]` | **PyMuPDF Text Extraction & Layout Association**<br>PyMuPDF extracts text spans, fonts, sizes, and bounding boxes via `page.get_text("dict")`. Every extracted text span is mapped to its intersecting layout bounding box. Text unclassified by YOLO is assigned to `plain text` by default. Zero characters present in the PDF text layer are discarded. | Anchors layout boxes to real text streams with font metadata. |
| **AC-DOC-04** | `[P0]` | **Multi-Column Reading Order Resolution**<br>On multi-column pages (detected via vertical gutters and block distribution), full-width header blocks (e.g. title, abstract) precede column blocks. Column blocks are sorted strictly column-by-column: all Column 1 (left) blocks in top-to-bottom order, followed by all Column 2 (right) blocks in top-to-bottom order.<br>*Verification Target*: On a two-column test PDF with distinct text in each column, `text.index("Left Column End") < text.index("Right Column Start")`. Interleaving of left/right text fails this criterion. | Prevents academic multi-column papers from degrading into unreadable, interleaved gibberish. |
| **AC-DOC-05** | `[P0]` | **Physical Block to Semantic Paragraph Assembly**<br>Adjacent physical `plain text` blocks within the same column and section are evaluated for paragraph continuation. A block ending without terminal punctuation (`.`, `!`, `?`, `。`) followed by a block starting with a lowercase character or standard continuation is merged into a single `ParagraphIR`. Cross-column and cross-page continuous paragraphs are merged into a single semantic unit referencing multiple source `block_ids`. | Layout boxes are physical; translation and Paper QA require semantic sentences and paragraphs. |
| **AC-DOC-06** | `[P0]` | **Header & Footer Noise Elimination (`abandon`)**<br>Blocks classified by DocLayout-YOLO as `abandon` (running headers, running footers, page numbering stamps) are retained in `PageIR.blocks` with `layout_class = "abandon"`, but are strictly **excluded from `paragraphs`**, section text, and citation mappings.<br>*Verification Target*: Running header strings appearing across pages do not appear in `[p.text for p in ir.paragraphs]`. | Prevents repetitive headers and copyright notices from polluting LLM context, search, and translation. |
| **AC-DOC-07** | `[P0]` | **Formula & Equation Isolation**<br>Blocks classified as `isolate_formula` (display math) and `formula_caption` are segregated from prose. They are never merged into `plain text` paragraphs. Surrounding text paragraphs are broken cleanly before and after the formula block. Mathematical glyphs and symbols are preserved without mangling into body prose. | Formula safety is a non-negotiable architectural principle (ARCHITECTURE.md §2). |
| **AC-DOC-08** | `[P0]` | **Figure & Table Segregation**<br>Blocks classified as `figure`, `table`, `figure_caption`, `table_caption`, and `table_footnote` are segregated from body prose paragraphs. Captions are associated with their corresponding figure/table element by proximity. Tables and figures are never concatenated into prose paragraphs. | Preserves document hierarchy and isolates tabular data from prose translation. |
| **AC-DOC-09** | `[P0]` | **Safe Text Normalization & Citation Preservation**<br>Within paragraphs:<br>1. Soft line breaks are replaced with a single ASCII space.<br>2. Hyphenated word wraps at line ends (e.g., `algo-\nrithm`) are rejoined (`algorithm`), while true compound hyphens (`state-of-the-art`, `self-attention`) are preserved.<br>3. Unicode NFKC normalization is applied (normalizing `ﬁ` ligatures to `fi`).<br>4. Citations formatted as `[N]`, `[N, M]`, `[N-M]`, or `(Author et al., YYYY)` are preserved verbatim without alteration.<br>*Verification Target*: Assert all citation regex matches in the source text blocks exist in `paragraph.text`. | Normalizes clean prose for translation/QA while preserving academic citation anchors. |
| **AC-DOC-10** | `[P0]` | **Stable Content-Addressable Identifiers**<br>Identifiers are generated deterministically:<br>- `page_number`: 1-indexed integer.<br>- `page_index`: 0-indexed integer.<br>- `paragraph_id`: `p_{doc_id}_{ordinal:04d}` in reading order sequence.<br>- `section_id`: `sec_{doc_id}_{ordinal:03d}`.<br>- `block_id`: `b_{doc_id}_p{page_number}_{ordinal:03d}`.<br>*Verification Target*: Parsing the same document twice produces identical IDs for all entities (`ir1.model_dump() == ir2.model_dump()`). | Ensures bookmarks, citations, embeddings, and chat sessions remain valid across re-opens. |
| **AC-DOC-11** | `[P0]` | **Citation Page Mapping (`page_mapping`)**<br>The IR constructs a bidirectional mapping between semantic paragraphs and user-facing page numbers: `page_mapping: dict[str, int]` mapping `paragraph_id` $\rightarrow$ `page_number`. For paragraphs spanning multiple pages, `page_mapping[p_id]` returns the starting `page_number`, and `ParagraphIR.page_range` records `(start_page, end_page)`.<br>*Verification Target*: Every `paragraph_id` in `paragraphs` resolves to a valid 1-based page number. | Required for Paper QA citations to reliably jump to the source page in the reader (API_CONTRACT.md §6). |
| **AC-DOC-12** | `[P0]` | **Canonical IR Persistence (`ir.json`)**<br>The generated `DocumentIR` is serialized to UTF-8 JSON and saved at `<documents_dir>/<document_id>/ir.json`. The write is atomic: serialized to a sibling temporary file (`.ir-<uuid>.json`) and renamed via `os.replace`. If extraction fails, no corrupt or partial `ir.json` is left on disk. | Conforms to local file artifact convention without modifying database schemas or causing DB locks. |
| **AC-DOC-13** | `[P0]` | **Fast Cached IR Retrieval**<br>When `DocumentStore.get_document_ir(document_id)` or `GET /api/documents/{id}/ir` is called on a document with an existing `ir.json`, the payload is read directly from disk without invoking PyMuPDF or ONNX. Execution time is $< 50\text{ ms}$ for documents up to 50 pages. | Prevents redundant model execution on every UI open or Paper QA query. |
| **AC-DOC-14** | `[P0]` | **Idempotent Re-Extraction**<br>Triggering extraction multiple times on the same document overwrites `ir.json` atomically and returns the exact same data structure. No orphan files, duplicate database rows, or memory leaks are created. | Guarantees reliability and safe recovery. |
| **AC-DOC-15** | `[P0]` | **Cryptographic Source PDF Immutability**<br>The original source PDF file hash (`sha256`) and file modification time (`st_mtime`) are verified before and after extraction. Under no circumstance is the source PDF opened in write mode, altered, moved, or deleted. | Core product invariant (ARCHITECTURE.md §2). |
| **AC-DOC-16** | `[P0]` | **Degenerate Input: Corrupt PDF Handling**<br>If a corrupt or truncated PDF is submitted for extraction, the pipeline raises a normalized error mapping to HTTP **422 Unprocessable Entity** (`code: "SOURCE_INVALID"`). No half-initialized IR file is written. | Prevents crashes on damaged user inputs. |
| **AC-DOC-17** | `[P0]` | **Degenerate Input: Encrypted PDF Handling**<br>If a password-protected or encrypted PDF is submitted, the pipeline rejects it with HTTP **422 Unprocessable Entity** (`code: "PDF_ENCRYPTED"`, `message: "Password-protected PDFs are not supported."`). | Fails fast and honestly when PDF access is restricted. |
| **AC-DOC-18** | `[P0]` | **Degenerate Input: Scanned / Zero-Text PDF Handling**<br>If a PDF contains only scanned bitmap images with no text layer, extraction completes successfully without crashing: `has_text_layer = false`, `ocr_required = true`, `paragraphs = []`, and each page reports `has_text = false`. OCR is NOT attempted. | Honest detection of scanned material without hallucinating empty text. |
| **AC-DOC-19** | `[P0]` | **Sparse and Empty Page Handling**<br>Pages with zero text blocks or sparse content (e.g. cover page with title only, blank trailing page) produce valid `PageIR` entries with empty or single-element block lists. The pipeline does not throw null-pointer or index errors. | Prevents extraction crashes on common academic cover pages and blank leaves. |
| **AC-DOC-20** | `[P0]` | **Non-Blocking Execution Off Event Loop**<br>Extraction operations triggered via HTTP run off the asyncio event loop using `asyncio.to_thread` or an executor thread. FastAPI's event loop remains responsive; `GET /api/health` responds in $< 10\text{ ms}$ while extraction is actively executing in the background. | Prevents synchronous CPU/ONNX tasks from freezing the server. |
| **AC-DOC-21** | `[P0]` | **HTTP Endpoint: `GET /api/documents/{id}/ir`**<br>Returns HTTP **200 OK** with the complete `DocumentIR` JSON schema. If the IR has not yet been extracted, it extracts on demand (or returns HTTP **404 Not Found** with `code: "IR_NOT_FOUND"` if lazy extraction is disabled). Unknown `id` returns HTTP **404 Not Found** (`code: "NOT_FOUND"`). Raw filesystem paths are never returned. | Exposes canonical IR to the frontend reader and Paper QA module. |
| **AC-DOC-22** | `[P0]` | **HTTP Endpoint: `GET /api/documents/{id}/sections`**<br>Returns HTTP **200 OK** with a lightweight JSON list of document sections: `[{"id": "sec_001", "title": "1. Introduction", "level": 1, "page_number": 1}, ...]`. If no sections could be identified, returns `[]`. | Allows frontend reader to render the outline/TOC sidebar immediately. |
| **AC-DOC-23** | `[P0]` | **HTTP Endpoint: `GET /api/documents/{id}/page-mapping`**<br>Returns HTTP **200 OK** with JSON mapping: `{"document_id": "doc_...", "page_mapping": {"p_0001": 1, "p_0002": 1, ...}}`. | Lightweight endpoint dedicated to citation jump resolution. |
| **AC-DOC-24** | `[P0]` | **Database Isolation & Zero Speculative Tables**<br>If SQLite is touched, migration `004` is additive, transactional, and convergent. Table assertions in [`backend/tests/test_db.py`](file:///D:/marti/SciPrograms/backend/tests/test_db.py#L75) and [`backend/tests/test_isolation.py`](file:///D:/marti/SciPrograms/backend/tests/test_isolation.py#L230) pass. Speculative tables (`pages`, `sections`, `paragraphs`) remain strictly forbidden. If `ir.json` file storage is used without DB changes, `SCHEMA_VERSION` remains 3. | Preserves repo guard-rails against speculative schema expansion. |
| **AC-DOC-25** | `[P0]` | **Frozen Kernel & Isolation Preservation**<br>No file inside [`backend/app/pdfkernel/`](file:///D:/marti/SciPrograms/backend/app/pdfkernel/) is modified. No code outside `backend/app/pdfkernel/` imports `pdf2zh` or `babeldoc` directly; layout extraction uses standard PyMuPDF and `onnxruntime` (or an isolated layout helper within `backend/app/document/`). [`test_isolation.py`](file:///D:/marti/SciPrograms/backend/tests/test_isolation.py#L203) passes with zero offenders. | Preserves architectural boundary ADR-001 and audit isolation rules. |
| **AC-DOC-26** | `[P0]` | **Zero Regression Across Existing Suites**<br>All 514 existing backend tests (`pytest backend/tests`) and 75 frontend tests (`npm test`) continue to pass without error or modification. | Inviolable milestone rule: existing features must not break. |

---

# 2. Priority P1 (SHOULD) — Important Quality Criteria (Non-Blocking)

| ID | Priority | Description & Objective Verification Target |
| :--- | :--- | :--- |
| **AC-DOC-27** | `[P1]` | **Deterministic Heading & Section Hierarchy Extraction**<br>Sections are identified by combining DocLayout class `0: 'title'` with PyMuPDF font size thresholds and numbering regexes (e.g. `^(\d+\.){1,3}\s+[A-Z]`). Where hierarchical numbering is present (e.g. `1`, `1.1`, `1.1.1`), `level` is set to `1`, `2`, or `3`. Where numbering is absent, top-level headings receive `level = 1`. Unsectioned initial prose (e.g. abstract, preamble) has `section_id = null`. |
| **AC-DOC-28** | `[P1]` | **Deterministic Abstract Detection**<br>If a `title` block contains the word `"Abstract"` (case-insensitive) at the beginning of the text, subsequent paragraphs up to the first numbered section heading are tagged with `is_abstract = true`. If no "Abstract" heading is found, `metadata.abstract` is set to `null` rather than guessing. |
| **AC-DOC-29** | `[P1]` | **References / Bibliography Boundary Detection**<br>If a heading matches `^(References\|Bibliography\|Works Cited)` (case-insensitive), all subsequent blocks are assigned to a dedicated section `sec_{doc_id}_references` with `is_references = true`. This prevents reference lists from being merged into main body sections. |
| **AC-DOC-30** | `[P1]` | **Deterministic Document Title & Author Extraction**<br>The document title is extracted from the first page using the layout block with class `title` having the largest font size, falling back to PDF metadata `title` if non-generic, or `null`. Generic PDF generator tags (`"untitled"`, `"LaTeX"`, `"Word"`) are rejected. |
| **AC-DOC-31** | `[P1]` | **Explicit Trigger Endpoint: `POST /api/documents/{id}/extract-ir`**<br>Accepts `POST /api/documents/{id}/extract-ir` with optional `{"force": bool}`. Runs extraction asynchronously in a worker thread and returns HTTP **200 OK** with extraction summary (`page_count`, `paragraph_count`, `section_count`, `duration_seconds`). |
| **AC-DOC-32** | `[P1]` | **Real-Paper Multi-Column Benchmark Verification**<br>Verify the extraction pipeline against a sample real-world academic paper (e.g. 2-column arXiv paper in `tests/fixtures/`). Verify that text flow, section headings, and display formulas match expected human reading order without column interleaving. |

---

# 3. Priority P2 (OPTIONAL) — Polish & Architectural Hooks (Non-Blocking)

| ID | Priority | Description & Objective Verification Target |
| :--- | :--- | :--- |
| **AC-DOC-33** | `[P2]` | **Repeated Watermark / Header Cross-Page Deduplication**<br>Detect identical text lines appearing in identical geometric bounding box coordinates across $> 3$ consecutive pages (e.g., `"PREPRINT ACCEPTED AT ICML 2025"`) that may have been missed by YOLO `abandon`, and flag them as recurring artifacts. |
| **AC-DOC-34** | `[P2]` | **Table of Contents (PDF Outline Bookmark) Fallback**<br>If the PDF includes a native PDF outline/bookmarks tree (`doc.get_toc()`), use the bookmark titles and page numbers to cross-verify and enrich detected section headings and page ranges. |
| **AC-DOC-35** | `[P2]` | **Character-Level Coordinate Span Mapping**<br>For advanced UI selection and highlighting, each `ParagraphIR` includes exact character offset mappings: `char_spans: list[tuple[int, int, BoundingBox]]` mapping `[start_char, end_char]` to a physical bounding box on the page. |

---

# 4. Explicitly Not Applicable

| Dimension | Justification |
| :--- | :--- |
| **25. OCR Execution** | **Explicitly out of scope for DS-DOC-001.** If a PDF has no text layer, this task requires reporting `has_text_layer = false` and `ocr_required = true`. Running Tesseract OCR or downloading OCR model files is deferred to a future dedicated OCR task. |
| **LLM Summarisation & QA** | Out of scope. DS-DOC-001 is deterministic structural extraction. Context Engine, LLM summaries, and Paper QA belong to Phases 6 and 8. |
| **Vector Embeddings / Search** | Out of scope. Retrieval-augmented generation and BM25/vector indexing belong to Phase 8. |
| **Glossary Generation** | Out of scope. Belongs to Phase 6 (`context/glossary.py`). |
| **Translation Kernel Retooling** | Out of scope. The translation kernel [`backend/app/pdfkernel/`](file:///D:/marti/SciPrograms/backend/app/pdfkernel/) is frozen and passes 514 tests. Wiring kernel translation to consume this IR is deferred to Phase 6. |

---

# 5. Answers to the 14 Settled Questions

1. **Page numbering**: Internal logic strictly uses `page_index` (0-based, $0 \le i < N$). User-facing APIs, citations, and reader navigation strictly use `page_number` (1-based, $1 \le p \le N$). Field names must never be ambiguously named `page`.
2. **Two-column reading order**: Column gutters are detected via horizontal coordinate distribution. Full-width blocks are read first; then Column 1 (left) is read completely from top to bottom; then Column 2 (right) is read completely from top to bottom. Verified by asserting `text.index(col1_end) < text.index(col2_start)`.
3. **Block vs. paragraph**: Distinct in schema. `TextBlock` is a physical bounding box on a single page. `Paragraph` is a semantic prose unit that can span across lines, columns, and pages, holding references to multiple underlying `block_ids`.
4. **Stable IDs across re-opens**: Generated deterministically using ordinal reading-order positions (`p_{doc_id}_{ordinal:04d}`). Running extraction twice produces byte-identical JSON payloads.
5. **Idempotency**: Re-parsing an already-parsed document replaces `<documents_dir>/<document_id>/ir.json` atomically. No duplicate database records or file leaks occur.
6. **Persistence vs. in-memory**: Persisted to disk as `<documents_dir>/<document_id>/ir.json`. Rationale: Avoids 5–15 second ONNX recalculations on every API read, guarantees instant deletion when the document directory is removed, and prevents SQLite bloat and schema lockups.
7. **`abandon` regions**: YOLO `abandon` blocks (headers, footers, page stamps) are retained in `blocks` for coordinate completeness but are strictly excluded from semantic `paragraphs`, sections, and search text.
8. **Formulas**: Bounding boxes classified as `isolate_formula` and `formula_caption` are isolated into dedicated formula blocks. They are never concatenated into prose paragraphs.
9. **Text fidelity and normalization**: Safe whitespace unwrapping, line de-hyphenation, and NFKC Unicode normalization are permitted. Citations like `[12]` and `(Author, 2024)` must never be stripped. Bounding box provenance is preserved.
10. **Metadata uncertainty**: Fields use nullable types (`title: str | None`). Generic PDF generator strings (`"untitled"`, `"LaTeX"`) are rejected. If evidence is ambiguous, fields are set to `null` rather than guessed.
11. **Degenerate inputs**: Corrupt PDFs return 422 `SOURCE_INVALID`. Encrypted PDFs return 422 `PDF_ENCRYPTED`. Scanned PDFs set `has_text_layer = false` and `ocr_required = true` without crashing. Sparse pages produce empty block arrays without error.
12. **Performance bounds**: Extraction takes $\le 1.5\text{s per page}$ on CPU. Reading existing IR from disk takes $< 50\text{ ms}$. Extraction runs asynchronously off the event loop via `asyncio.to_thread`.
13. **Reuse vs. re-run**: DS-DOC-001 caches IR on disk for Document Intelligence and Paper QA. Upstream translation reuse is explicitly deferred to Phase 6 to preserve the frozen translation kernel.
14. **API surface**: Exposes `GET /api/documents/{id}/ir`, `GET /api/documents/{id}/sections`, and `GET /api/documents/{id}/page-mapping`. This provides the frontend with table-of-contents navigation and citation jumping without over-promising unimplemented LLM features.

---

# 6. Expected Automated Tests (`backend/tests/test_document_ir.py`)

All tests must run 100% offline via `pytest`:

| Test Function | Purpose / Assertions | Priority |
| :--- | :--- | :--- |
| `test_ir_schema_serialization_roundtrip` | Serializes and deserializes `DocumentIR` model to/from JSON; asserts lossless equality. | `[P0]` |
| `test_two_column_reading_order_not_interleaved` | Extracts synthetic 2-column PDF; asserts `text.index(col1_end) < text.index(col2_start)`. | `[P0]` |
| `test_physical_blocks_merged_into_semantic_paragraphs` | Multi-line paragraph spanning column/line boundaries merges into single `ParagraphIR`. | `[P0]` |
| `test_abandon_headers_and_footers_excluded_from_paragraphs` | Header/footer text classified as `abandon` does not appear in `paragraphs`. | `[P0]` |
| `test_isolate_formulas_segregated_from_prose` | Display equation between paragraph A and B creates distinct formula block; A and B are not merged. | `[P0]` |
| `test_citations_preserved_verbatim` | Verifies in-text citations `[1]`, `[12-15]`, and `(Vaswani et al., 2017)` exist unaltered in `paragraph.text`. | `[P0]` |
| `test_deterministic_id_generation_across_reruns` | Extracts same PDF twice; asserts all paragraph, section, and block IDs match byte-for-byte. | `[P0]` |
| `test_page_mapping_resolves_all_paragraphs_to_1based_pages` | Every `paragraph_id` in `page_mapping` points to a valid 1-based page number $\le \text{page\_count}$. | `[P0]` |
| `test_ir_persistence_writes_atomic_json_file` | Asserts `<documents_dir>/<id>/ir.json` is created; no `.ir-*` temp files remain. | `[P0]` |
| `test_get_ir_returns_cached_file_in_under_50ms` | Repeated call to `get_document_ir` reads disk cache in $< 50\text{ ms}$ without model inference. | `[P0]` |
| `test_source_pdf_unmodified_during_extraction` | Cryptographic `sha256` and `st_mtime` of source PDF are identical before and after extraction. | `[P0]` |
| `test_corrupt_pdf_returns_422_source_invalid` | Submitting corrupt PDF raises normalized 422 error envelope; no partial `ir.json` written. | `[P0]` |
| `test_encrypted_pdf_returns_422_pdf_encrypted` | Password-protected PDF raises 422 `PDF_ENCRYPTED`. | `[P0]` |
| `test_scanned_pdf_reports_no_text_layer_and_ocr_required` | Image-only PDF returns `has_text_layer == false`, `ocr_required == true`, `paragraphs == []`. | `[P0]` |
| `test_sparse_and_blank_pages_handled_gracefully` | Blank page produces valid `PageIR` with empty block list without exception. | `[P0]` |
| `test_api_get_ir_returns_200_and_schema` | `GET /api/documents/{id}/ir` returns 200 OK with valid IR schema; 404 on missing doc. | `[P0]` |
| `test_api_get_sections_returns_toc_list` | `GET /api/documents/{id}/sections` returns list of sections with title and page number. | `[P0]` |
| `test_api_get_page_mapping_returns_citations_dict` | `GET /api/documents/{id}/page-mapping` returns valid paragraph-to-page dictionary. | `[P0]` |
| `test_extraction_runs_off_event_loop` | Verifies `/api/health` responds in $< 10\text{ ms}$ while extraction is actively executing. | `[P0]` |
| `test_zero_speculative_tables_and_isolation_preserved` | [`test_db.py`](file:///D:/marti/SciPrograms/backend/tests/test_db.py#L75) and [`test_isolation.py`](file:///D:/marti/SciPrograms/backend/tests/test_isolation.py#L203) continue to pass with zero offenders. | `[P0]` |
| `test_heading_hierarchy_detection_with_regex` | Numbered sections `1`, `1.1`, `2` receive appropriate `level` values 1 and 2. | `[P1]` |
| `test_references_section_segregated_from_body` | "References" heading marks subsequent blocks as `is_references = true`. | `[P1]` |

---

# 7. Failure Conditions (FCs) — Anti-Patterns & Prohibitions

Any of the following behaviors constitutes an immediate failure of task DS-DOC-001:

- **FC-01 (LLM or Cloud Leakage)**: Calling an LLM provider, embedding API, or external network service during document extraction.
- **FC-02 (Two-Column Text Interleaving)**: Merging multi-column text horizontally line-by-line rather than column-by-column.
- **FC-03 (Header/Footer Pollution)**: Including running headers, footers, or page numbers in semantic `ParagraphIR` text.
- **FC-04 (Formula Mangling)**: Concatenating display formulas (`isolate_formula`) directly into prose paragraphs.
- **FC-05 (Citation Stripping)**: Removing or altering in-text academic citations (`[12]`, `(Author, 2024)`) during text normalization.
- **FC-06 (Source File Mutation)**: Modifying, renaming, or deleting the user's original source PDF.
- **FC-07 (Event Loop Stall)**: Executing synchronous ONNX prediction or PyMuPDF rendering directly on the async event loop thread.
- **FC-08 (Unstable Identifiers)**: Generating random UUIDs for paragraphs or sections that change upon subsequent parsing.
- **FC-09 (Speculative Table Creation)**: Adding speculative tables (`pages`, `sections`, `paragraphs`) to SQLite, violating [`test_db.py`](file:///D:/marti/SciPrograms/backend/tests/test_db.py#L77-L82).
- **FC-10 (Kernel Code Tampering)**: Modifying any code inside [`backend/app/pdfkernel/`](file:///D:/marti/SciPrograms/backend/app/pdfkernel/).
- **FC-11 (Invented Structure)**: Guessing or hallucinating section titles, abstracts, or heading levels when deterministic evidence is absent.
- **FC-12 (Path Leakage)**: Exposing internal server filesystem paths in API response payloads.
