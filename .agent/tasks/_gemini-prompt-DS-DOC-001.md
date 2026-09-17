You are the independent Acceptance Criteria author for a local-first academic PDF
reader + bilingual translator ("Academic PDF Copilot").

Define objective P0 / P1 / P2 acceptance criteria for the next task.

**Do NOT write production code.** Return acceptance criteria only.

---

# TASK — DS-DOC-001: Document IR + Page / Section / Paragraph Mapping

## Goal

Establish the canonical structured representation of an academic PDF that every later
feature shares: context-aware translation, Paper QA, page citations, glossary
generation, section and document summaries, and "selection → ask AI".

**Parse once, reuse everywhere.** Translation and Paper QA must not build independent,
incompatible views of the same document.

This task is **deterministic document-structure extraction**. It must NOT perform LLM
summarisation, glossary generation, terminology translation, Paper QA, embedding, vector
search, or context-aware translation. Those come later.

## Where the project is now

The first usable-client milestone is complete and accepted. All of this works today and
**must not be redesigned**:

```
Open PDF → Read → Translate → Read translation → Bilingual side by side
```

Verified state:

```
backend              514 passed
frontend              75 passed
production build      PASS
initial bundle        273.65 kB of a 500 kB limit
PDF.js                separate async chunk (483 kB)
```

DS-DOC-001 is **Phase 5, the first task after that milestone**.

---

# VERIFIED GROUND TRUTH (measured in this repository — treat as authoritative)

## The document model as it actually exists

`backend/app/db.py` — SQLite, sequential additive migrations, `SCHEMA_VERSION = 3`.

```sql
CREATE TABLE documents (
    id          TEXT PRIMARY KEY,       -- opaque, "doc_" + uuid4 hex
    name        TEXT NOT NULL,          -- original filename, display only
    page_count  INTEGER NOT NULL,
    is_upload   INTEGER NOT NULL DEFAULT 1,
    source_path TEXT,                   -- non-null only for path-imports
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE translation_tasks (          -- ON DELETE CASCADE from documents
    id, document_id, profile_id, status, lang_in, lang_out, engine,
    progress_page, progress_page_count, error_code, error_message,
    created_at, updated_at
);
```

Conventions that must be preserved:

* **A document's files live under a directory named by its opaque id**
  (`DocumentStore.document_dir`), so no caller-supplied filename ever becomes a path.
  `source_file(id)` is `<docs_dir>/<id>/source.pdf`; artifacts are `mono.pdf`/`dual.pdf`.
* **The user's original is never modified.** An upload is copied in; a path import is
  only read. Deleting a document removes *our* copy and derived artifacts, never a file
  the user owns. There is a test asserting the source is byte-identical after a delete.
* Migrations are **additive and convergent**: a fresh database and one upgraded from v1
  end up identical. A database from a newer build refuses to open.
* `list_tables()` exists specifically so the suite can assert that **no speculative
  table has crept in**.

## The HTTP surface (DS-BE-007) — documents

```
POST   /api/documents                    201  multipart `file` (browser) | JSON {path}
GET    /api/documents/{id}               200  {document_id,name,page_count,source,has_translation,created_at}
GET    /api/documents/{id}/file          200  the original, read-only
GET    /api/documents/{id}/translated    200  mono, N pages
GET    /api/documents/{id}/bilingual     200  dual, 2N pages (export only)
POST   /api/documents/{id}/translate     202  returns immediately with a task id
GET    /api/tasks/{task_id}              200
GET    /api/tasks/{task_id}/events       200  SSE: snapshot|progress|done|error|cancelled
POST   /api/tasks/{task_id}/cancel       200
POST   /api/tasks/{task_id}/retry        501  deliberately unimplemented
GET    /api/profiles                     200  keys masked, never returned
```

Error envelope, everywhere: `{"error": {"code", "message", "detail"}}`.

**No response ever carries a filesystem path**, and none carries credential material.
Those are frozen invariants with tests behind them.

Honesty conventions already established and enforced by tests:

* Task status vocabulary is exactly `PENDING | TRANSLATING | SUCCESS | FAILED | CANCELLED`.
  **`ANALYZING` and `RENDERING` are never emitted** — the fast kernel runs one unified
  pipeline and reports progress per page. Fabricated phases were explicitly refused.
* Block counters are **omitted rather than faked**; a test asserts `blocks_done` appears
  nowhere in a task payload.
* `/retry` returns `501` rather than pretending block-level retry exists.
* **Never invent progress, counts, or structure that was not measured.** This principle
  has governed every task so far and applies directly to section detection.

## What the existing PDF stack provides (measured)

The translation kernel is upstream PDFMathTranslate (pinned, `_reference/`, AGPL-3.0,
local/personal use only). **Relevant facts for reuse:**

### Layout detection is a standalone step — it does not require translating

```python
# pdf2zh/high_level.py
pix = doc_zh[page.pageno].get_pixmap()
image = np.frombuffer(pix.samples, ...)
page_layout = model.predict(image, imgsz=int(pix.height / 32) * 32)[0]
```

`model` is `DocLayout-YOLO` (ONNX, ~72 MiB, **already cached locally** at
`~/.cache/babeldoc/models/doclayout_yolo_docstructbench_imgsz1024.onnx`).
`page_layout` is a `YoloResult(boxes, names)`; each box exposes `xyxy`, `cls`, `conf`.

**The label set, read verbatim from the model's own ONNX metadata:**

```
{0: 'title',            1: 'plain text',
 2: 'abandon',          3: 'figure',          4: 'figure_caption',
 5: 'table',            6: 'table_caption',   7: 'table_footnote',
 8: 'isolate_formula',  9: 'formula_caption'}
```

This matters a great deal: headings, body text, headers/footers, figures, tables and
equations are already classified **deterministically, with no LLM and no new model**.

### A subtlety that is easy to get wrong

Upstream builds a per-pixel mask to group characters into paragraphs:

```python
box = np.ones((pix.height, pix.width))      # default 1
vcls = ["abandon", "figure", "table", "isolate_formula", "formula_caption"]
for i, d in enumerate(page_layout.boxes):
    if page_layout.names[int(d.cls)] not in vcls:
        box[y0:y1, x0:x1] = i + 2           # ← BOX INDEX + 2, not the class index
for i, d in enumerate(page_layout.boxes):
    if page_layout.names[int(d.cls)] in vcls:
        box[y0:y1, x0:x1] = 0               # ← 0 means "reserved region"
```

So in the mask: `0` = reserved (figure/table/formula/abandon), `1` = uncovered
background, `>= 2` = **a specific layout box**, identified by `index + 2`. Upstream groups
characters into paragraphs by *box identity* (`cls == xt_cls`), not by class label. To
recover the class you look up `names[cls - 2]`.

Also note the mask is in **image space with y flipped** (`h - y1 - 1`), while text
coordinates are in PDF space. Coordinate spaces differ and any mapping must be defined
and tested rather than assumed.

### Text extraction available to us

`PyMuPDF` (`fitz`) is already a dependency of our backend (used for page counting).
`page.get_text("dict")` yields blocks → lines → spans, each with a bbox, font name, size
and flags. Upstream uses `pdfminer.six` internally; **we are not required to**, and
PyMuPDF alone may suffice.

`ensure_layout_model()` already exists in `backend/app/pdfkernel/adapter.py` and refuses
to run without the cached model — a ~72 MiB one-time download that, if attempted in a
process that cannot reach a mirror, makes upstream call `exit(1)`.

---

# CONSTRAINTS THE CRITERIA MUST RESPECT

* **No LLM calls.** No embeddings, no summaries, no glossary, no Paper QA, no Context
  Engine.
* **Build the IR from the ORIGINAL source PDF, never the translated one.** Their geometry
  genuinely differs — measured on a real run: original ≈595×842 pt, translated ≈437×850 pt.
  Source semantics must not depend on translated-page coordinates.
* **Document Intelligence must work without translating.** A user must be able to open a
  PDF and ask about it without ever running a translation. Do not couple IR generation to
  a translation having happened.
* **Honest uncertainty beats invented structure.** If the PDF does not contain enough
  evidence to identify a section, the IR must say so (null / unsectioned) rather than
  guess. This is the same principle that made the project refuse fake progress bars and
  fake retry endpoints.
* **Source immutability** is a frozen product invariant with tests behind it.
* **Do not add speculative tables.** `list_tables()` exists to catch exactly that, so any
  new table must be justified by this task's requirements.
* **Migration safety**: additive, convergent, and a newer database must still refuse to
  open.
* The existing translation pipeline must keep working unchanged (**514 backend tests**).

## Questions the criteria should settle explicitly

1. **Page numbering.** Internal 0-based `page_index` vs user-facing 1-based
   `page_number` — pick one convention and require that they are never mixed silently.
   Citations will depend on this.
2. **Two-column reading order.** This is called out as P0-important. Academic papers are
   commonly two-column; extraction must not interleave left/right line by line. What is
   the objective test that proves column-wise order was achieved?
3. **Block vs paragraph.** Layout units are physical; paragraphs are semantic. Should the
   IR keep `TextBlock` and derive `Paragraph`, or call layout boxes paragraphs? The task
   prefers the distinction be preserved rather than every bounding box being called a
   paragraph. What is objectively checkable here?
4. **Stable IDs across re-opens.** IDs must not be regenerated on every read. What is the
   required property, and how is it tested (parse twice → identical IDs)?
5. **Idempotency.** Re-parsing the same document must not duplicate rows or change
   results. What proves it?
6. **Persistence vs in-memory.** Is the IR persisted (new table(s)/JSON) or derived on
   demand? What are the consequences the criteria should pin down either way?
7. **`abandon` regions.** The layout model already marks headers, footers and other noise
   as `abandon`. Should those be excluded from paragraphs, retained with a type, or both?
   What is required so repeated headers/footers cannot pollute later retrieval and
   summaries?
8. **Formulas.** `isolate_formula` / `formula_caption` are available. What must the IR do
   so a formula is not mangled into prose, and how is that verified?
9. **Text fidelity and normalization.** Safe normalization (whitespace, line-break
   joining, Unicode) is allowed, but meaning must not change and traceability to source
   blocks must survive if normalization happens. Citations like `[12]` / `(Smith et al.,
   2025)` must not be stripped. How is fidelity objectively checked?
10. **Metadata uncertainty.** PDF metadata may be absent or simply wrong. How must the IR
    represent "unknown" versus "known"?
11. **Degenerate inputs** — corrupt PDFs, encrypted PDFs, scanned/image-only PDFs with no
    text layer, and sparse pages. What must happen, and what must be reported honestly?
    Note OCR is out of scope for this task; if a page has no text layer, saying so is the
    requirement.
12. **Performance bounds.** Layout detection renders every page and runs a model. What
    bound is acceptable, and what must not happen (e.g. re-running detection on every API
    read)?
13. **Reuse vs re-run.** If a translation later runs, layout detection would otherwise
    happen twice for the same document. Is caching or reuse required in this task, or is
    it acceptable to note it as future work? Be explicit.
14. **API surface.** Does this task expose anything over HTTP, or is it internal-only?
    Justify either way. (Note the existing honesty convention: an endpoint should not
    promise more than it delivers.)

---

# EVALUATION DIMENSIONS

Assign each P0 / P1 / P2, or state explicitly that it does not apply:

1. deterministic extraction  2. document identity  3. stable page numbering
4. paragraph IDs  5. section IDs  6. reading order  7. multi-column PDFs
8. headings  9. paragraphs  10. sparse pages  11. figures/tables/captions
12. equations / formula-heavy pages  13. page coordinates  14. text normalization
15. preservation of source text  16. Unicode  17. duplicated text
18. headers/footers  19. references section  20. title/abstract detection where
deterministic  21. failure handling  22. corrupt PDFs  23. encrypted PDFs
24. scanned PDFs  25. OCR compatibility  26. persistence  27. re-opening documents
28. idempotency  29. source immutability  30. performance  31. database migration safety
32. regression protection  33. existing translation pipeline compatibility
34. automated tests  35. real-paper verification

---

# OUTPUT FORMAT

Return:

1. **P0 criteria** — numbered, each objectively verifiable, each with a short rationale.
   P0 means: the task is not DONE if this fails.
2. **P1 criteria** — important, but acceptable without.
3. **P2 criteria** — desirable polish.
4. **Explicitly not applicable** — dimensions that do not apply, and why.
5. **Answers to the questions above** where a criterion settles them.
6. **Any premise you believe is wrong**, stated plainly — including anything in the ground
   truth above that you think is a mistake, or any requirement you believe cannot be met
   with deterministic methods.

Be specific about observable behaviour. Avoid criteria that cannot be checked by a test or
by inspecting a real academic paper. Where deterministic detection genuinely cannot reach
a conclusion, require an honest "unknown" over a plausible guess, and say so explicitly.
