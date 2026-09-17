# DS-DOC-001 — Document IR + Page / Section / Paragraph Mapping

- **Phase:** 5 (Document Intelligence) — first task after the Usable Client Milestone
- **Status:** Ready — criteria frozen in `docs/acceptance/DS-DOC-001.md` before implementation
- **Owner:** DeepSeek (implementation) · Gemini (acceptance criteria)
- **Created:** 2026-09-17
- **Baseline:** `155a887` (DS-FE-003)

## Goal

Convert a locally opened academic PDF into the canonical structured representation every later
feature shares — context-aware translation, Paper QA, page citations, glossary generation,
summaries, and selection → ask AI. **Parse once, reuse everywhere.**

This is deterministic structure extraction. No LLM, no embeddings, no summaries, no glossary,
no Paper QA, no context engine.

## Why it exists

The application can open, translate and render a PDF, but has no canonical semantic structure for
the source paper. Later features all need the same answers to the same questions: which page is
this text from, which section owns it, what precedes it, which heading governs it, where should a
citation jump. Those questions must have **one** answer, not one per feature.

## Technical context (verified)

| Piece | State |
|---|---|
| Storage | SQLite; `documents` + `translation_tasks`; `SCHEMA_VERSION = 3` |
| Artifacts | `<documents_dir>/<id>/{source.pdf,mono.pdf,dual.pdf}` — derived files live on disk |
| Layout model | DocLayout-YOLO ONNX, ~72 MiB, **already cached locally** |
| Labels | `title, plain text, abandon, figure, figure_caption, table, table_caption, table_footnote, isolate_formula, formula_caption` |
| Text | PyMuPDF `page.get_text("dict")` — already a dependency, spans with bbox/font/size |
| Isolation | `test_isolation.py` fails any `pdf2zh`/`babeldoc` import outside `app/pdfkernel/` |
| DB guard | `test_db.py` pins the table set **exactly**; `pages`/`sections`/`paragraphs` are named as forbidden |

## Files allowed to modify

```
backend/app/document/**        (new package: models, layout, extract, normalize, sections)
backend/app/documents/store.py (add ir_file(document_id))
backend/app/api/documents.py   (add the four IR routes)
backend/pyproject.toml         (AC_CHANGE_REQUEST 1 — declare pymupdf, onnxruntime, numpy)
backend/tests/test_document_ir.py
.agent/tasks/DS-DOC-001.md
.agent/evidence/DS-DOC-001.md
```

## Files forbidden to modify

```
backend/app/pdfkernel/**   (frozen by AC-DOC-25)
backend/app/db.py          (AC-DOC-24: no schema change; SCHEMA_VERSION stays 3)
backend/tests/test_db.py, backend/tests/test_isolation.py  (must pass unmodified)
_reference/**
```

## Requirements (condensed from the frozen criteria)

R1. One immutable IR schema, losslessly JSON-serialisable.
R2. Deterministic layout over the 10 classes, boxes in PDF points, top-left origin.
R3. No character in the text layer is discarded.
R4. **Two-column reading order — never interleaved.** A P0 failure if it is.
R5. `TextBlock` (physical) and `Paragraph` (semantic) are distinct types.
R6. `abandon` regions retained in blocks, excluded from paragraphs.
R7. Formulas and captions segregated, never merged into prose.
R8. Citations preserved verbatim through normalization.
R9. Stable ordinal IDs; two runs produce identical output.
R10. Persisted atomically to `ir.json` in the document directory.
R11. Cached reads < 50 ms, no model inference.
R12. Source file byte- and mtime-identical after extraction.
R13. Degenerate inputs handled honestly: corrupt, encrypted, scanned, sparse.
R14. Extraction off the event loop.
R15. Honest uncertainty — `None` beats an invented section or title.

## Known constraints

- Do **not** build the Context Engine, glossary, summaries, Paper QA, embeddings, or OCR.
- Do **not** modify the translation kernel or wire the IR into translation — Phase 6.
- Do **not** add SQLite tables.
- Do **not** import `pdf2zh` or `babeldoc` outside `app/pdfkernel/`.

## Known risks

- **Two-column interleaving** is the single most likely defect and the reason AC-DOC-04 exists.
- **Formula mangling** — merging display math into prose, which the product's standing formula
  safety principle forbids.
- **Invented structure** — a plausible-looking section tree with no evidence behind it. The
  criteria require `None` instead.
- **Duplicate layout boxes.** Measured during a pre-implementation probe: the model emits
  identical bounding boxes with different confidences (observed 0.63/0.59 and 0.66/0.40 on the
  same rect). Undeduplicated, these would double-count text.

## Dependencies

DS-BE-007 (`ef17457`, document API), DS-FE-003 (`155a887`), DS-PDF-001 (kernel verification).
