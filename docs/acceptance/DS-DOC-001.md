# Acceptance Criteria — DS-DOC-001: Document IR + Page / Section / Paragraph Mapping

- **Author:** project maintainer
- **Reviewed and frozen by:** project maintainer, before any implementation code was written
- **Date:** 2026-09-17
- **Baseline:** `155a887` (DS-FE-003)
- **Authoring input:** the actual repository — `app/db.py` migrations, `app/documents/store.py`,
  the DS-BE-007 routes, `tests/test_db.py`, `tests/test_isolation.py`,
  `app/pdfkernel/adapter.py`, and the DocLayout-YOLO ONNX metadata — not the Phase 1 design
  documents alone.
- **Status:** **FROZEN.** No criterion may be silently weakened or deleted.
  **26 P0 · 6 P1 · 3 P2.**

Baselines this task must not regress:

```
backend  → 514 passed
frontend →  75 passed
```

## Review before implementation

The criteria review inspected real files and cited them (`test_db.py#L74-L82`, `test_isolation.py#L190-L203`,
`adapter.py#L75-L91`). I verified both load-bearing guards directly — they are exactly as
described, and both constrain the design hard.

### Verified: the isolation rule forbids reusing `pdf2zh.doclayout`

`tests/test_isolation.py` walks every `app/**/*.py` **except** `app/pdfkernel/`, parses it with
`ast`, and fails the build if any file imports `pdf2zh` or `babeldoc`. So Document IR cannot
reuse upstream's `OnnxModel` wrapper. It must run inference itself via `onnxruntime`.

That reading is consistent with AC-DOC-25 ("an isolated layout helper within
`backend/app/document/`") and with AC-DOC-02, which asks for `ensure_layout_model()` — the
existing *pre-flight* helper that resolves and validates the cached model path. The intended
split is therefore: **`ensure_layout_model()` for the path, our own ONNX wrapper for inference.**
Recorded because AC-DOC-02 alone could be misread as "call upstream's loader".

### Verified: the speculative-table guard pins an exact set

`tests/test_db.py` asserts `tables == ["documents", "profiles", "schema_version",
"translation_tasks"]` — an *exact* set — plus an explicit forbidden set that already names
`pages`, `sections`, `paragraphs`. AC-DOC-24 permits an optional migration 004 but requires
those assertions to keep passing, which an added table would break. So this task takes
AC-DOC-24's own final branch: **no database change at all**, `ir.json` on disk, `SCHEMA_VERSION`
stays 3. That is also the better design — the IR is a derived artifact, exactly like
`mono.pdf` and `dual.pdf`, and deleting the document directory already cleans it up.

### AC_CHANGE_REQUEST 1 — `pyproject.toml` must be modified, and the criteria's file list omits it

| | |
|---|---|
| **Problem** | DS-DOC-001 programs directly against `onnxruntime` and `numpy`, and both are present **only transitively** via the upstream PDF library. |
| **Evidence** | `backend/pyproject.toml` declares five direct dependencies, under a comment headed *"Deliberately minimal (AC-11)"*, and DS-BE-002 set the precedent explicitly: **"Declared explicitly as of DS-BE-002. It was previously only present transitively (via the upstream PDF library), which meant a dependency we actively program against could move without us choosing it."** |
| **Additional finding** | `pymupdf` is already a direct dependency of our code — `app/api/documents.py` imports `fitz` — and was **never declared**. The rule was already being broken before this task. |
| **Proposed change** | Add `pymupdf`, `onnxruntime` and `numpy` to `pyproject.toml`. |
| **Not accepted** | Relying on a transitive dependency the project has a written rule against relying on, or leaving a pre-existing undeclared import in place once found. |

### AC_CHANGE_REQUEST 2 — AC-DOC-21 offers two mutually exclusive behaviours

AC-DOC-21 says a not-yet-extracted document either "extracts on demand **or** returns HTTP 404
`IR_NOT_FOUND`". Both cannot be a criterion.

**Resolution — lazy extraction on first read.** It is the only choice under which the P0 set is
self-consistent: AC-DOC-31 (`POST /extract-ir`, the explicit trigger) is only **P1**, so if GET
returned 404 there would be no P0 path by which a document ever acquires an IR. Extraction runs
off the event loop (AC-DOC-20) and only the first read pays for it; subsequent reads hit the
cache in < 50 ms (AC-DOC-13). AC-DOC-31 is implemented as well, giving explicit control and a
`force` re-extract.

### AC_CHANGE_REQUEST 3 — AC-DOC-24/25/26 require the isolation tests to pass *unmodified*, and one of them forbids the dependency this task needs

| | |
|---|---|
| **Requirement** | AC-DOC-25 says no code outside `app/pdfkernel/` imports the upstream library; AC-DOC-24 pins the database table set; AC-DOC-26 requires the existing suites to pass **unmodified**. |
| **Conflict** | `tests/test_isolation.py::test_dependency_manifest_declares_expected_packages` asserts a list of forbidden packages that **explicitly includes `onnxruntime`**, on the grounds that it belongs to "a backend phase that has not started". DS-DOC-001 *is* that phase: the layout model is an ONNX graph, and the isolation rule forbids reaching it through the upstream library. There is no way to satisfy AC-DOC-25 and this guard simultaneously without either declaring the dependency or re-importing upstream. |
| **Precedent, from the guard itself** | Its own comment records the identical situation: **"`openai` was removed from this guard by DS-BE-002/AC-31, which requires it to be declared."** The rule the removals follow is the guard's stated rationale — a package stops being speculative when a started phase depends on it. |
| **Proposed change** | Remove `onnxruntime` from the forbidden list, with the precedent recorded in place. `torch`, `opencv`, `chromadb`, `anthropic` and `pdf2zh` remain forbidden. No other assertion in the file changes, and the exact-table-set guard is untouched. |
| **Not accepted** | Depending on a transitive package the project has a written rule against depending on, or importing the upstream library outside the kernel to avoid declaring the dependency. |

Additionally, `test_source_does_not_reference_upstream_paths` scans the raw text of every
non-kernel module for the upstream project's name and fired on a **docstring** in
`app/document/layout.py`. That guard's intent is sound — outside the kernel, upstream should not
be named at all — so the module was reworded to say "the upstream PDF library", matching how the
rest of the non-kernel codebase refers to it. The guard was not touched.

### Confirmed design decisions

- **Page numbering** is disambiguated by *field name*: `page_index` (0-based) and `page_number`
  (1-based). The bare word `page` is banned from IR schemas. Citations depend on this.
- **`TextBlock` (physical) and `Paragraph` (semantic) stay distinct types.** A layout box is not
  a paragraph — one box may hold several paragraphs, and one paragraph may be split across
  columns, pages, and boxes. This is the honest reading the task asked for.
- **`abandon` regions are retained in `blocks` but excluded from `paragraphs`.** Headers,
  footers and page stamps stay available for coordinates and debugging without polluting
  summaries, retrieval, or translation.
- **Formulas are segregated, never merged into prose.** Formula safety is a standing product
  principle.
- **Honest uncertainty**: `None` beats a guess for titles, abstracts, levels, and sections.

### Note on the input specification

The DS-DOC-001 task text supplied to this workflow was truncated mid-sentence in §29
("Implement conservative detection if suppo…"). §1–§29 were complete, and the §4 acceptance
scope — the block the criteria are built from — was complete and self-contained, so authoring
proceeded on that basis. Anything beyond §29 was not available and is not reflected here.

---

# Flawed premises (accepted)

1. **DocLayout-YOLO does not output section hierarchies.** The label set is
   `{0: title, 1: plain text, 2: abandon, 3: figure, 4: figure_caption, 5: table,
   6: table_caption, 7: table_footnote, 8: isolate_formula, 9: formula_caption}`. Both the
   document title *and* section headings are class `title`. Hierarchy needs deterministic
   typographic heuristics plus numbering regexes, and where numbering is absent the level must
   be `1` or `None` — never invented.
2. **Upstream translation cannot consume this IR in this task.** `high_level.translate()` runs
   its own layout loop and exposes no injection point; modifying it violates ADR-001. Deferred
   to Phase 6, stated explicitly rather than promised.
3. **Coordinate spaces differ and must be standardised.** PyMuPDF text rects use PDF points,
   top-left origin, y down. The ONNX model runs on pixel images letterboxed to a multiple of 32.
   **The IR standardises on PDF points, top-left origin, `[x0, y0, x1, y1]`.**

   *Measured during a pre-implementation probe, because the distinction is easy to get
   backwards:* the model's output is **already top-left origin and needs no y-flip**. Its
   output tensor is `(1, 300, 6)` — NMS is performed inside the graph, and each row is
   `[x0, y0, x1, y1, conf, cls]`. The `h - y1 - 1` flip seen in upstream's `high_level.py`
   belongs to upstream's *internal per-pixel mask*, which is indexed with pdfminer
   bottom-left coordinates — it is not a property of the model. A detected header box at
   pixel `y = 32…42` corresponds to text drawn at PDF `y = 40` from the top. So image pixels
   map to PDF points by a **scale factor alone** (`page_width_pt / image_width_px`).
4. **Layout boxes are not paragraphs.** See above.
5. **Abstract and References cannot be found by layout class alone** — both are `plain text`.
   They need keyword anchors. Absent an anchor, `is_abstract` stays false.
6. **No speculative tables.** `ir.json` in the document directory, matching the
   `source.pdf` / `mono.pdf` / `dual.pdf` artifact convention.

---

# Settled questions

| # | Decision |
|---|---|
| 1 | `page_index` 0-based internal; `page_number` 1-based user-facing. Never mixed; `page` banned as a field name. |
| 2 | Multi-column: gutter detected from horizontal distribution; full-width blocks first, then Column 1 top-to-bottom, then Column 2 top-to-bottom. Verified by `text.index(col1_end) < text.index(col2_start)`. |
| 3 | `TextBlock` is physical (one page, one bbox). `Paragraph` is semantic and references multiple `block_ids` across columns and pages. |
| 4 | IDs are ordinal and content-addressed: `p_{doc_id}_{ordinal:04d}`, `sec_{doc_id}_{ordinal:03d}`, `b_{doc_id}_p{page_number}_{ordinal:03d}`. Two runs must be byte-identical. |
| 5 | Re-extraction replaces `ir.json` atomically. No duplicates, no orphans. |
| 6 | Persisted to `<documents_dir>/<document_id>/ir.json`. Avoids re-running ONNX per read; deleted automatically with the document directory. |
| 7 | `abandon` blocks retained in `blocks`, excluded from `paragraphs`, sections, and search corpora. |
| 8 | `isolate_formula` / `formula_caption` segregated into formula blocks; never merged into prose. |
| 9 | Safe normalization: soft line breaks → space, line-end de-hyphenation preserving true compounds, NFKC. Citations preserved verbatim; bbox provenance retained. |
| 10 | Nullable metadata; generic generator strings (`untitled`, `LaTeX`, `Word`) rejected; `None` rather than a guess. |
| 11 | Corrupt → 422 `SOURCE_INVALID`. Encrypted → 422 `PDF_ENCRYPTED`. Scanned → `has_text_layer=false`, `ocr_required=true`, `paragraphs=[]`, no OCR attempted. Sparse pages → valid empty page records. |
| 12 | ≤ 1.5 s/page extraction; < 50 ms cached read; extraction off the event loop. |
| 13 | Cached on disk for Document Intelligence and Paper QA. Upstream translation reuse deferred to Phase 6. |
| 14 | Exposes `GET /ir`, `GET /sections`, `GET /page-mapping`, plus `POST /extract-ir`. |

---

# P0 — must pass (26)

| ID | Requirement | Verification |
|---|---|---|
| **AC-DOC-01** | Canonical immutable IR schema: `DocumentIR` (`document_id`, `content_hash`, `page_count`, `metadata`, `sections`, `pages`, `paragraphs`, `page_mapping`, `has_text_layer`, `ocr_required`), `PageIR` (`page_index`, `page_number`, `width_pt`, `height_pt`, `blocks`), `SectionIR` (`id`, `title`, `level`, `page_range`, `parent_id`), `ParagraphIR` (`id`, `section_id`, `text`, `page_number`, `page_range`, `block_ids`, `bboxes`), `TextBlockIR` (`id`, `page_index`, `page_number`, `layout_class`, `bbox`, `text`). | JSON round-trip is lossless. |
| **AC-DOC-02** | Layout inference over the 10 classes, using the cached ONNX model resolved through `ensure_layout_model()`, with boxes mapped to PDF-point top-left coordinates. | Runs with no network; labels match the model's own metadata. |
| **AC-DOC-03** | PyMuPDF `page.get_text("dict")` supplies spans, fonts, sizes, bboxes; every span maps to its intersecting layout box; unclassified text defaults to `plain text`; **no character in the text layer is discarded**. | Every char is accounted for in some block. |
| **AC-DOC-04** | Multi-column reading order: full-width headers first, then left column top-to-bottom, then right column top-to-bottom. **No interleaving.** | `text.index(col1_end) < text.index(col2_start)` on a two-column fixture. |
| **AC-DOC-05** | Physical blocks merge into semantic paragraphs where continuation is evidenced (no terminal punctuation followed by a lowercase continuation), including across columns and pages, with all `block_ids` retained. | A paragraph split across a column/page boundary is one `ParagraphIR`. |
| **AC-DOC-06** | `abandon` blocks retained in `PageIR.blocks` but **strictly excluded** from `paragraphs`, section text, and citation mappings. | Running header text appears in no `paragraph.text`. |
| **AC-DOC-07** | `isolate_formula` and `formula_caption` segregated from prose; surrounding paragraphs break cleanly around them; no glyph mangling into body text. | A formula between paragraphs A and B yields a distinct formula block and A ≠ B. |
| **AC-DOC-08** | `figure`, `table`, `figure_caption`, `table_caption`, `table_footnote` segregated from prose; captions associated by proximity. | None appear inside a `ParagraphIR`. |
| **AC-DOC-09** | Safe normalization (line-break unwrap, de-hyphenation preserving `state-of-the-art`, NFKC ligatures) **with citations `[N]`, `[N, M]`, `[N-M]`, `(Author et al., YYYY)` preserved verbatim**. | Every citation regex match in the source also appears in the paragraph text. |
| **AC-DOC-10** | Deterministic, stable identifiers as specified in settled question 4. | Parsing twice yields identical IDs. |
| **AC-DOC-11** | `page_mapping: paragraph_id → page_number` (1-based); multi-page paragraphs report their start page in the mapping and `(start, end)` in `page_range`. | Every `paragraph_id` resolves to a valid 1-based page. |
| **AC-DOC-12** | Persistence to `<documents_dir>/<document_id>/ir.json`, UTF-8, written atomically via a sibling temp file and `os.replace`. A failure leaves no partial file. | File exists; no `.ir-*` temp files remain. |
| **AC-DOC-13** | Cached reads bypass PyMuPDF and ONNX entirely and complete in < 50 ms. | Repeated `GET /ir` does not re-run inference. |
| **AC-DOC-14** | Re-extraction is idempotent: same structure, atomic overwrite, no orphans or duplicates. | Two runs produce identical payloads. |
| **AC-DOC-15** | Source PDF `sha256` **and** `st_mtime` unchanged across extraction; the file is never opened for writing, moved, or deleted. | Hashes compared before/after. |
| **AC-DOC-16** | Corrupt or truncated PDF → 422 `SOURCE_INVALID`; no partial `ir.json`. | Normalized envelope. |
| **AC-DOC-17** | Encrypted PDF → 422 `PDF_ENCRYPTED` with an honest message. | Normalized envelope. |
| **AC-DOC-18** | Scanned / zero-text PDF → succeeds with `has_text_layer=false`, `ocr_required=true`, `paragraphs=[]`, per-page `has_text=false`. **OCR is not attempted.** | No crash, no invented text. |
| **AC-DOC-19** | Sparse and blank pages produce valid `PageIR` records with empty or single-element block lists. | No exception on a blank page. |
| **AC-DOC-20** | Extraction runs off the event loop (`asyncio.to_thread` or an executor). | `/api/health` answers in < 10 ms while extraction is running. |
| **AC-DOC-21** | `GET /api/documents/{id}/ir` returns 200 with the full IR, **extracting lazily on first read** (AC_CHANGE_REQUEST 2). Unknown id → 404 `NOT_FOUND`. | No filesystem path in any response. |
| **AC-DOC-22** | `GET /api/documents/{id}/sections` returns a lightweight outline `[{id, title, level, page_number}]`, or `[]` when none were identified. | Assessed shape. |
| **AC-DOC-23** | `GET /api/documents/{id}/page-mapping` returns `{document_id, page_mapping}`. | Assessed shape. |
| **AC-DOC-24** | Database isolation: `SCHEMA_VERSION` stays 3; no speculative tables; `test_db.py` and `test_isolation.py` pass unmodified. | Exact table set unchanged. |
| **AC-DOC-25** | No file in `app/pdfkernel/` is modified; **no code outside it imports `pdf2zh` or `babeldoc`**; `test_isolation.py` reports zero offenders. | The AST guard passes. |
| **AC-DOC-26** | Zero regression: 514 backend and 75 frontend tests pass unmodified. | Full suites green. |

---

# P1 — should pass (6)

| ID | Requirement |
|---|---|
| **AC-DOC-27** | Heading and hierarchy extraction: class `title` plus font-size and numbering regexes (`^(\d+\.){1,3}\s+[A-Z]`). Numbered headings get `level` 1–3; unnumbered top-level headings get `level = 1`; preamble/abstract prose keeps `section_id = null`. |
| **AC-DOC-28** | Abstract detection from a `title` block beginning "Abstract" (case-insensitive), tagging following paragraphs `is_abstract = true` until the first numbered heading. Absent the anchor, `metadata.abstract = null`. |
| **AC-DOC-29** | References boundary from a heading matching `^(References|Bibliography|Works Cited)`, marking subsequent blocks `is_references = true`. |
| **AC-DOC-30** | Title from the largest-font `title` class block on page 1, falling back to non-generic PDF metadata, else `null`. |
| **AC-DOC-31** | `POST /api/documents/{id}/extract-ir` with optional `{force}`, running off-loop and returning `{page_count, paragraph_count, section_count, duration_seconds}`. |
| **AC-DOC-32** | Real-paper verification against a genuine multi-column academic paper. |

---

# P2 — optional (3)

| ID | Requirement |
|---|---|
| **AC-DOC-33** | Repeated watermark / header detection: identical text in identical geometry across > 3 consecutive pages that YOLO did not mark `abandon`. |
| **AC-DOC-34** | Native PDF outline (`doc.get_toc()`) used to cross-check section titles and page ranges. |
| **AC-DOC-35** | Character-level span mapping `char_spans: [(start_char, end_char, bbox)]` for selection and highlighting. |

---

# Explicitly not applicable

| Dimension | Why |
|---|---|
| **25. OCR execution** | Out of scope. No text layer ⇒ report `has_text_layer=false` / `ocr_required=true`; running Tesseract is a later task. |
| LLM summarisation / QA | Phase 6/8. |
| Embeddings / vector search | Phase 8. |
| Glossary generation | Phase 6. |
| Translation-kernel retooling | The kernel is frozen; consuming this IR in translation is Phase 6. |

---

# Failure conditions

**FC-01** LLM or cloud call during extraction · **FC-02** two-column interleaving ·
**FC-03** header/footer pollution of paragraphs · **FC-04** formula mangling ·
**FC-05** citation stripping · **FC-06** source-file mutation · **FC-07** event-loop stall ·
**FC-08** unstable identifiers · **FC-09** speculative table creation ·
**FC-10** kernel tampering · **FC-11** invented structure · **FC-12** path leakage.

---

# Expected tests (`backend/tests/test_document_ir.py`, offline)

Schema round-trip · two-column order not interleaved · blocks merged into semantic paragraphs ·
`abandon` excluded from paragraphs · formulas segregated · citations preserved verbatim ·
deterministic IDs across re-runs · every paragraph resolves to a valid 1-based page ·
atomic `ir.json` with no temp files left · cached read under 50 ms without inference ·
source `sha256` and `mtime` unchanged · corrupt → 422 `SOURCE_INVALID` · encrypted → 422
`PDF_ENCRYPTED` · scanned → no text layer and `ocr_required` · sparse/blank pages graceful ·
`GET /ir` 200 + schema and 404 for unknown · `GET /sections` shape · `GET /page-mapping` shape ·
event loop responsive during extraction · no speculative tables, isolation preserved ·
*(P1)* heading levels from numbering · *(P1)* references segregated.
