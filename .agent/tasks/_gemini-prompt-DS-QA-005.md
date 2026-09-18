You are the independent Acceptance Criteria author for a local-first academic PDF
reader + bilingual translator ("Academic PDF Copilot"). You are Gemini; the lead
engineer is DeepSeek, who will implement what you specify. You define the criteria;
you do not write production code.

Your criteria for the previous sixteen tasks have been used as written, and you have
corrected a false premise in our briefs more than once. Do that again if you find one
here.

# The task

DS-QA-005 — Selection → ParagraphIR mapping, and Selection QA.

A reader selects source text in the original PDF and asks a question constrained to
exactly that selection. Today **Selection scope is disabled in the UI**, because no
selection → `ParagraphIR` mapping exists. The task is to build that mapping, or to
find that it cannot be built honestly.

This task must not implement: embeddings, retrieval redesign, query-rewrite redesign,
answer-generation redesign, multi-turn chat, OCR, web search, or any annotation system.

# What exists

## The backend Selection contract — already built, do not redesign

```python
class Scope(BaseModel):            # extra="forbid"
    type: Literal["whole_paper", "section", "page", "selection"]
    paragraph_ids: list[str] | None = None   # for "selection"
```

`retrieve()` applies the scope **inside the SQL MATCH**, so an out-of-selection
paragraph is never scored. Under `selection` it also:

* skips neighbour expansion (a selection is an absolute boundary);
* with an **empty query**, returns the selected paragraphs themselves in reading
  order — the "explain what I highlighted" case, bypassing FTS entirely;
* never runs analysis expansion or reaches for a query rewrite (AC-06 of DS-QA-004,
  fixed two commits ago precisely because this task will send browser-derived ids);
* returns hits whose `paragraph_id`, `page_number`, `section_id`, `block_ids`,
  `bboxes` and `snippet` all come from the `DocumentIR`.

A paragraph id the document does not have simply yields nothing. There is no
error and no fallback to the whole paper.

## The canonical IR, already exposed

```
GET /api/documents/{id}/ir            the full DocumentIR — 258 kB for the ResNet paper
GET /api/documents/{id}/sections      outline
GET /api/documents/{id}/page-mapping  paragraph_id -> 1-based page
```

```python
class ParagraphIR(BaseModel):   id; section_id; text; page_number (1-based);
                                page_range; block_ids; bboxes: list[tuple[float,float,float,float]]
                                is_abstract
class TextBlockIR(BaseModel):   id; page_index; page_number; layout_class; bbox; text;
                                font_size; caption_of
class PageIR(BaseModel):        page_index; page_number; width_pt; height_pt; rotation; has_text; blocks
```

`bboxes` are **PDF points, top-left origin** — the same convention PyMuPDF uses for
text rectangles. A paragraph may have several boxes (it can span columns or pages).

Layout classes: `title`, `plain text`, `abandon`, `figure`, `figure_caption`,
`table`, `table_caption`, `table_footnote`, `isolate_formula`, `formula_caption`.
Prose paragraphs are assembled from `plain text` and `title` blocks only; the rest
are present in the IR but are not paragraphs. Captions **are** indexed as retrieval
evidence in DS-QA-001 (`kind="caption"`, their own block id), and are not
`ParagraphIR` records.

## The reader, and the geometry, measured rather than assumed

`PdfPage` renders a canvas and a real PDF.js `TextLayer` per page, inside a
container carrying `data-testid="pdf-page-container"` and `data-page-number`.
`PdfViewer` windows pages with an `IntersectionObserver` and tracks the current page
by visible area.

I ran a probe against the real application (Edge, the built bundle, the real ResNet
paper at fit-width) and measured the actual DOM rather than guessing its convention:

```
.textLayer                     transform: none, --scale-factor: 1.7156862745098038
page container rect            x=365  y=109  width=1050  height=1358.8125
canvas CSS size                1050 x 1358.82
first span                     left: 263.234px  top: 180.438px   (CSS px)
its client rect                x=628.234       y=289.4375
628.234 - 365 = 263.234        289.4375 - 109 = 180.4375   → exactly the CSS left/top
1050 / 1.7156862 = 612.0       1358.82 / 1.7156862 = 792.0  → the page is 612x792 pt
```

So the transform is the exact inverse of the one `PdfPage` already uses to draw a
citation highlight (`left = x0 * scale`):

```
page_local_css = client_rect - page_element_rect      (CSS px, top-left origin)
pdf_points     = page_local_css / scale                (PDF pt, top-left origin)
```

and it is scale-independent by construction, since both the layer and the rects are
laid out at the live scale.

Two more measurements from the same probe, both of which shape the criteria:

* **A page has 165 spans for 12 paragraphs.** Spans are neither words nor
  paragraphs nor lines. A range crossing four *adjacent DOM spans* picked up
  `"http://mscoco.org/dataset/#detections-challenge2015.0 1 2 3 4 5 6 0 10 20
  iter. (1e4) training error (%)"` — it walked into a figure's axis labels, because
  DOM order is not reading order. **Geometry has to drive the mapping; DOM order
  cannot.**
* **Zooming changed `--scale-factor` from 1.7157 to 2** and re-laid the spans. The
  same text at either scale maps to the same PDF points, because the scale divides
  out.

`PdfPage` already knows the live `scale` as a React prop; the implementation will
publish it on its own container rather than parsing PDF.js's CSS variable, so the
mapping depends on the application's contract rather than a library's internals.

## Where the mapping runs

The frontend does **not** currently hold the IR. Two options were considered:

* **(a) fetch `GET /documents/{id}/ir` once per document and map locally.** The IR
  is already an exposed artifact; the fetch happens when a document becomes ready,
  alongside the sections and profiles the app already loads; mapping then runs at
  mouse-up with no round trip.
* **(b)** a new backend endpoint taking geometry and returning paragraph ids.

**(a) is the plan**, because a mapping that needs a network round trip per selection
cannot feel instantaneous, and because the IR is a published artifact rather than a
new contract. Gemini should say if it disagrees. Note the rule this does *not*
violate: the ids still come from the `DocumentIR`, so the browser is not the source
of truth — only the *measurement* of what the user dragged across is.

# Decisions we need you to decide

**A.** A selection spans several paragraphs. Send all intersecting `paragraph_ids`?

**B.** What geometric overlap makes a `ParagraphIR` count as selected? State the
rule: intersection-over-selection, intersection-over-paragraph, centre-point
containment, or a line-overlap rule — and say why, and what its failure mode is on
a two-column page where a paragraph's box spans the full text width.

**C.** Is geometric overlap primary with text similarity as a validator, or the
reverse? The measurement above is that a DOM range can walk into a figure, and that
paragraph boxes are the geometry the IR actually recorded.

**D.** A selection covering three words inside a long paragraph: send the whole
paragraph id, the exact text plus the id, character offsets, or something else?
`DocumentIR` text is normalized differently from the PDF.js text layer, so an offset
computed in the DOM is not an offset into `paragraph.text` — a wrong offset is worse
than whole-paragraph scope.

**E.** Cross-page selection in P0, or deferred? The viewer windows pages, so both
pages must be mounted for a browser range to span them.

**F.** Headings and captions: are they selectable QA evidence? Headings are not
`ParagraphIR` records — they are the `section_title` column of the paragraphs they
govern — and captions have their own block identity rather than a paragraph id.
`Scope.paragraph_ids` takes paragraph ids, so a caption cannot be sent as one
without inventing an identity. Say what should happen.

**G.** What happens when the mapping is low-confidence or partial — some of the
selection maps and some does not? Is a `PARTIAL` mapping usable for QA, or does the
scope stay unavailable?

**H.** Is Selection QA available in Original mode only?

**I.** In Bilingual mode, may selection occur on the original pane only? The
translated pane is a re-laid-out document with different page geometry, and there is
no validated translated-text → source mapping.

**J.** Translation mode: disabled entirely, or permitted with a switch to Original
first, as citation clicking already does?

One more constraint worth stating before you decide: the existing UI disables
Selection with the label `选中内容（暂未支持）`, and that honesty is worth more than a
feature that maps approximately. If the honest answer is that some part of this
cannot be done reliably, say so and freeze the smaller thing.

# Constraints

* **Zero AI calls on selection.** Dragging across text must not reach a provider.
* No new dependency for selection geometry; `Range` and existing utilities suffice.
* No new state-management library.
* Do not persist DOM nodes or `Range` objects in state — they die on zoom, rerender
  and page remount. Resolve to canonical identity promptly.
* Do not break ordinary copy (`Ctrl+C`).
* No custom right-click menu.
* Scope enforcement stays the backend's; the frontend must not send a selection that
  is really a whole-paper search.
* Answerability semantics are frozen: `ANSWERED` / `PARTIAL` /
  `INSUFFICIENT_EVIDENCE`, citations resolved by the application, and widening the
  scope is a user action only.

Cover at least: collapsed selection; a selection inside one span; across spans;
across line breaks; across one paragraph; across paragraphs; across columns; across
pages; reversed drag; anchor/focus ordering; zoom and fit-width independence;
virtualisation; page identity; DOM→page-local geometry; geometry→paragraph mapping;
overlap threshold; text normalization as a secondary signal; duplicate text;
repeated sentences; hyphenation; ligatures; formulas; citations markers in text;
headings; captions; references; reading order; deduplication; the Selection request
payload; backend enforcement; citations restricted to the selection; no whole-paper
fallback; invalidation on document switch and mode switch; the three reader modes;
rotated pages; missing geometry; low confidence; the unavailable state; preview;
keyboard and mouse selection; copy; accessibility; stale selection; stale QA
requests; source immutability; frontend tests; backend regression; browser E2E.

Answer A–J explicitly. Where you disagree with this brief, say so and say why.
