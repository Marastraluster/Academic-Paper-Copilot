# Evidence — DS-DOC-001 Document IR + Page / Section / Paragraph Mapping

- **Date:** 2026-09-17
- **Agent:** DeepSeek (Claude Code CLI)
- **Acceptance criteria:** `docs/acceptance/DS-DOC-001.md` (Gemini, frozen before implementation)
- **Baseline:** `155a887` (DS-FE-003)
- **Verdict:** **DONE — all 26 P0 criteria PASS. 5 of 6 P1 PASS, 1 PARTIAL (stated below).
  3 P2 not implemented (optional). 3 `AC_CHANGE_REQUEST`s raised and resolved.**

Phase 5 begins here. The point of this task is not the extraction itself but that every later
feature — context-aware translation, Paper QA, citations, glossary, summaries — reads the *same*
structure instead of each building its own.

## What was built

```
backend/app/document/models.py        the IR schema, and why it is shaped that way
backend/app/document/layout.py        ONNX layout detection, run directly
backend/app/document/normalize.py     line joining, de-hyphenation, citation preservation
backend/app/document/extract.py       the pipeline: detect → assign → order → merge → section
backend/app/document/persistence.py   atomic ir.json read/write
backend/app/document/service.py       extract once, reuse, and do not race
backend/scripts … (none)              —
backend/tests/test_document_ir.py     41 tests
```

Four new endpoints on the existing documents router:

```
GET  /api/documents/{id}/ir             full canonical IR (extracts on first read)
GET  /api/documents/{id}/sections       outline for a table of contents
GET  /api/documents/{id}/page-mapping   paragraph_id → 1-based page, for citation jumps
POST /api/documents/{id}/extract-ir     explicit trigger, optionally forcing a re-run
```

Three decisions carry the design:

- **`TextBlock` (physical) and `Paragraph` (semantic) are separate types.** A layout box is a
  rectangle a vision model found; a paragraph is prose a person would read as one unit. A box can
  hold several paragraphs, and a paragraph can span boxes, columns and pages. Calling a bounding
  box a paragraph is the error this separation prevents.
- **The IR is a file, not a table.** `<documents_dir>/<id>/ir.json`, beside `mono.pdf` and
  `dual.pdf`. It is deleted with the document, needs no migration, and does not contend with the
  database while a translation is running.
- **Honest uncertainty.** Where the evidence does not support a section, a level, a title or an
  abstract, the field is `None` rather than a plausible guess.

## Verification

```
$ cd backend && .venv/Scripts/python -m pytest
    → 555 passed, 0 failed        (514 at baseline, +41 new — no regression)

$ cd frontend && npm run test
    → 75 passed, exit 0           (untouched by this task)
```

### Measured behaviour, on real PDFs

Extraction over three PDFs from the upstream project's own test corpus — produced by different
tooling than anything in this repository, so they exercise generalisation rather than a fixture
written to pass:

```
translate.cli.font.unknown.pdf     1 page   5 paragraphs, title + abandon detected
translate.cli.plain.text.pdf       1 page   1 paragraph,  abandon detected
translate.cli.text.with.figure.pdf 1 page   5 paragraphs, title + figure + figure_caption + abandon
```

The first is a genuine academic article (Michael Schudson, *University of California, San Diego*);
its prose extracts as readable paragraphs and its running header is correctly classified away.

Performance, measured rather than assumed:

```
model load (once per process)      2.32 s
10-page dense document            10.64 s  →  1.06 s/page     (AC-DOC-12 budget: 1.5 s/page)
cached read                       < 0.05 s                    (AC-DOC-13 budget: 0.05 s)
```

### The two P0 behaviours, observed

On a two-column page with a running header, a footer page number, a figure, a caption and two
section headings:

```
blocks by class: {'plain text': 5, 'title': 3, 'figure': 1, 'figure_caption': 1, 'abandon': 2}

--- paragraphs in reading order ---
  p_doc_probe_0001 'A. Author, B. Author'
  p_doc_probe_0002 'Left column line 0: the policy is optimized from rollouts. …'
  p_doc_probe_0003 'Right column line 0: we evaluate on three benchmarks. …'

sections: [('Abstract', 1), ('1 Introduction', 1)]
```

The left column is exhausted before the right begins — the ordering that AC-DOC-04 exists to
enforce, and the one a naive y-then-x sort gets wrong. The header (`Proceedings of …`) is
classified `abandon` and appears in no paragraph.

## Three AC_CHANGE_REQUESTs

Recorded in full in `docs/acceptance/DS-DOC-001.md`.

### 1. `pyproject.toml` had to change, and the criteria's file list omitted it

DS-DOC-001 programs directly against `onnxruntime` and `numpy`, both present **only
transitively** through the upstream PDF library — which `pyproject.toml` has a written rule
against, headed *"Deliberately minimal (AC-11)"*, with DS-BE-002's precedent stated inline:
*"Declared explicitly as of DS-BE-002. It was previously only present transitively …, which meant
a dependency we actively program against could move without us choosing it."*

**Found while doing it:** `pymupdf` was already a direct dependency — `app/api/documents.py`
imports `fitz` — and had never been declared. The rule was being broken before this task existed.
All three are now declared.

### 2. AC-DOC-21 offered two mutually exclusive behaviours

It said a not-yet-extracted document either "extracts on demand **or** returns 404". Both cannot
be a criterion. Resolved as **lazy extraction on first read**: the explicit trigger
(`POST /extract-ir`) is only P1, so under the 404 reading there would be no P0 path by which a
document ever acquires an IR. `POST /extract-ir` is implemented anyway, for explicit control.

### 3. AC-DOC-26 requires the isolation tests to pass unmodified — and one forbids the dependency this task needs

`tests/test_isolation.py::test_dependency_manifest_declares_expected_packages` asserts a
forbidden-package list that **includes `onnxruntime`**, on the grounds that it belongs to a phase
that has not started. DS-DOC-001 *is* that phase. There was no way to satisfy both it and
AC-DOC-25 (no upstream import outside the kernel) without depending on a package the project has
a written rule against depending on.

The guard's own comment records the identical situation and its resolution: *"`openai` was removed
from this guard by DS-BE-002/AC-31, which requires it to be declared."* Following that precedent,
`onnxruntime` was removed from the list with the reasoning recorded in place. `torch`, `opencv`,
`chromadb`, `anthropic` and `pdf2zh` remain forbidden; no other assertion changed.

A second guard, `test_source_does_not_reference_upstream_paths`, fired on a **docstring** in
`app/document/layout.py` that named the upstream project. The guard's intent is sound — outside
the kernel, upstream should not be named at all — so the module was reworded to say "the upstream
PDF library", matching the rest of the non-kernel codebase. **The guard was not modified.**

## Findings from implementing it

### 1. Two coordinate spaces, and the one that looks flipped but is not

The model emits `(1, 300, 6)` — **NMS happens inside the graph** — as `[x0, y0, x1, y1, conf,
cls]` in image pixels, **top-left origin, needing no y-flip**. The `h - y1 - 1` flip visible in
the upstream pipeline belongs to its *internal per-pixel mask*, which is indexed with pdfminer's
bottom-left coordinates; it is not a property of the model. A detected header at pixel `y = 32…42`
corresponds to text drawn at PDF `y = 40` from the top.

This is recorded in the frozen criteria because it is easy to get backwards, and getting it
backwards produces boxes that are subtly wrong everywhere rather than obviously broken.

### 2. A real bug: the letterbox shape, and why "square" was wrong

My first `detect()` undid the letterbox using the **target square** rather than the actual padded
result. The upstream letterbox pads only the stride remainder, not to centre in a square, so a
tall page comes out 608×832 rather than 832×832. Using the square computed 122 px of left inset
where there was 10 — every box landed far off the page, and nine of thirteen detections silently
vanished because their text no longer fell inside them.

Found by printing raw detections against expected ones rather than by reading the code, which is
what the probe script was for.

### 3. The model emits duplicate boxes, and they would double-count text

Measured on a real page: the same rectangle at confidences 0.63/0.59 and again at 0.66/0.40. The
graph suppresses overlapping boxes of the *same* class; it does not suppress the same rectangle
found under two classes. Left in, every character in that region would belong to two blocks.
`_drop_duplicates` collapses them, highest confidence winning, and a test asserts no two blocks on
a page share a rectangle.

### 4. A pre-existing undeclared dependency

`app/api/documents.py` has imported `fitz` since DS-BE-007 while `pyproject.toml` never declared
`pymupdf`. Fixed here (AC_CHANGE_REQUEST 1). It is the kind of thing that only surfaces when
someone finally reads the manifest against the imports.

## Acceptance criteria — P0

All 26 pass. The load-bearing ones:

| Criterion | Verdict | Evidence |
|---|---|---|
| AC-DOC-01 schema | **PASS** | Round-trip equality, including tuples surviving as tuples |
| AC-DOC-02 layout inference | **PASS** | 10 classes from model metadata; boxes in PDF points top-left |
| AC-DOC-03 text association | **PASS** | Unclaimed text becomes a block; nothing is discarded |
| **AC-DOC-04 no column interleaving** | **PASS** | Last left line precedes first right line, on real extraction |
| AC-DOC-05 block → paragraph | **PASS** | Column run becomes one paragraph; finished sentences do not merge |
| AC-DOC-06 `abandon` excluded | **PASS** | Header text in no paragraph, still present as a block |
| AC-DOC-07 formula isolation | **PASS** | Formula between two paragraphs yields two paragraphs, not one |
| AC-DOC-08 figure/table segregation | **PASS** | Non-prose classes never join a paragraph; captions linked |
| AC-DOC-09 normalization | **PASS** | Wraps joined, `self-attention` preserved, citations verbatim, ligatures |
| AC-DOC-10 stable ids | **PASS** | Two runs byte-identical; ids follow reading order |
| AC-DOC-11 page mapping | **PASS** | Every paragraph resolves to a valid 1-based page |
| AC-DOC-12 atomic persistence | **PASS** | File lands; a forced write failure leaves neither file nor temp |
| AC-DOC-13 cached read | **PASS** | `< 50 ms`, asserted, and no model invocation |
| AC-DOC-14 idempotency | **PASS** | Second run reuses; `ir.json` byte-identical |
| AC-DOC-15 source immutability | **PASS** | Hash, size **and** mtime unchanged |
| AC-DOC-16 corrupt → 422 | **PASS** | `SOURCE_INVALID` |
| AC-DOC-17 encrypted → 422 | **PASS** | `PDF_ENCRYPTED` on all three IR routes; no partial cache |
| AC-DOC-18 scanned → honest | **PASS** | `has_text_layer=false`, `ocr_required=true`, no OCR attempted |
| AC-DOC-19 sparse pages | **PASS** | Blank page yields a valid empty page record |
| AC-DOC-20 off the event loop | **PASS** | Health answers while extraction runs |
| AC-DOC-21–23 the three GETs | **PASS** | Schemas asserted; no path in any payload |
| AC-DOC-24 no speculative tables | **PASS** | Table set still exactly the four |
| AC-DOC-25 isolation | **PASS** | Zero offenders; kernel untouched |
| AC-DOC-26 zero regression | **PASS** | 555 backend, 75 frontend |

### P1

| Criterion | Verdict |
|---|---|
| AC-DOC-27 heading hierarchy | **PASS** — levels from numbering; unnumbered defaults to 1 |
| AC-DOC-28 abstract detection | **PASS** — keyword-anchored; absent an anchor, nothing is invented |
| AC-DOC-29 references boundary | **PASS** — flagged from the heading |
| AC-DOC-30 title extraction | **CORRECTED — see the Gate 0 record.** Originally reported PASS. Only the *metadata* half was implemented: generic values were rejected and `None` was preferred to a guess. But the criterion's primary clause — take the title from the largest `title`-class layout block on page one, falling back to metadata — was never implemented at all, and no test covered it. Gate 0 caught it on a real arXiv paper, whose PDF carries no title metadata, so `metadata.title` came back `None` for a paper whose title is printed plainly on page 1. Now implemented, with its own regression test. |
| AC-DOC-31 explicit trigger | **PASS** — `reused` honoured, `force` re-runs |
| **AC-DOC-32 real-paper verification** | **PARTIAL — see below** |

**AC-DOC-32 is honestly incomplete.** What *is* verified: extraction of three real-world PDFs from
an independent source, including a genuine academic article, with correct text flow, paragraph
assembly, heading detection and `abandon` classification. What is **not** verified: a large
two-column arXiv-style paper, and detection of real display formulas — the synthetic formula used
in testing was drawn as ordinary text and so was correctly classified `plain text`, which proves
nothing about formula detection. No genuine published paper was available in this environment,
and none was downloaded. Closing this properly needs a real multi-column paper with embedded math
fonts.

### P2 — not implemented (optional)

AC-DOC-33 (cross-page watermark dedup), AC-DOC-34 (PDF outline cross-check), AC-DOC-35
(character-level span mapping) are unimplemented. The 26 P0 criteria and 5 of 6 P1 are complete;
these are polish, and the criteria mark them non-blocking.

## Known limitations

1. **Formulas depend on the model recognising them.** `isolate_formula` was never observed firing
   in this environment, because no fixture with real math fonts was available. The *handling* is
   implemented and tested with synthetic blocks; the *detection* is unverified. See AC-DOC-32.
2. **De-hyphenation is a heuristic with a stated failure mode.** A line ending in a hyphen is
   joined unless the fragment before it is a known compound prefix. An unusual compound that
   breaks at its own hyphen and is not in that list will be joined — `self-attention` is
   protected, `state-of-the-art` is protected, others may not be. Documented at the top of
   `normalize.py` rather than hidden.
3. **Section levels default to 1 when unnumbered.** A paper using styling rather than numbering to
   express hierarchy will read as flat. Inventing depth was judged worse than flattening it.
4. **Extraction is ~1 s/page** and runs on the first read. The model load is 2.3 s once per
   process. Set against a translation that takes minutes, this is cheap, but a 50-page paper
   costs ~50 s on its first IR read.
5. **Column detection is geometric**, driven by horizontal overlap. A layout with three or more
   columns, or with a box straddling a gutter, is handled by the same rule rather than by a
   column-aware model, and is untested at that complexity.
6. **No frontend consumes these endpoints yet.** The criteria required the surface, not a UI;
   the reader still has no outline sidebar or citation jump. That is a frontend task.
7. **`ignore_cache=True` remains the translation workaround**, and the IR is not yet fed into
   translation — deliberately deferred to Phase 6, exactly as AC-DOC-25 requires.

## Recommended Next Task

**DS-DOC-002** — consume the IR in the reader: an outline sidebar from `/sections`, and citation
jumping from `/page-mapping`. The endpoints exist and are tested; nothing in the UI uses them
yet, so the value of this task is currently only reachable by an API client.

If the goal is instead to unblock Phase 6, the **Academic Context Engine** is the natural next
step — it is the first consumer that makes "parse once, reuse everywhere" pay off, and it is where
the upstream cache's missing endpoint identity (`REPO_AUDIT` §12) should finally be fixed.
