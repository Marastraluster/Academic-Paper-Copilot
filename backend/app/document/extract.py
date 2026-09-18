"""Building the Document IR from a source PDF.

The pipeline, in order, with the reason each step exists:

1. **Open the source read-only** and hash it. The hash is taken before any work
   and re-checked after, so "the original is never modified" is verified rather
   than asserted.
2. **Detect layout per page** with the ONNX model (``layout.py``).
3. **Assign text to boxes** from PyMuPDF's span stream. Every character must land
   somewhere; anything the model missed becomes a block of its own rather than
   disappearing.
4. **Order the blocks** for reading (``reading_order`` below) — column by column,
   never interleaved.
5. **Assemble paragraphs** from consecutive prose blocks that continue each
   other.
6. **Find sections** from headings and the numbering they carry.
7. **Assign identifiers** in reading order, which is what makes them stable
   across runs.

Steps 4 and 5 are the ones that are easy to get subtly wrong, and both are the
subject of a P0 criterion.
"""

from __future__ import annotations

import hashlib
import re
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

import fitz

from app.document.layout import LayoutBox, get_layout_model
from app.document.models import (
    LAYOUT_ABANDON,
    LAYOUT_FIGURE,
    LAYOUT_FIGURE_CAPTION,
    LAYOUT_FORMULA_CAPTION,
    LAYOUT_ISOLATE_FORMULA,
    LAYOUT_PLAIN_TEXT,
    LAYOUT_TABLE,
    LAYOUT_TABLE_CAPTION,
    LAYOUT_TABLE_FOOTNOTE,
    LAYOUT_TITLE,
    NON_PROSE_CLASSES,
    BoundingBox,
    DocumentIR,
    DocumentMetadata,
    PageIR,
    ParagraphIR,
    SectionIR,
    TextBlockIR,
)
from app.document.normalize import ends_sentence, join_wrapped_lines, looks_like_prose

#: A block occupying this fraction of the text width or more is treated as
#: spanning the page rather than belonging to a column.
FULL_WIDTH_RATIO = 0.62

#: Bumped when extraction output changes in a way stored IRs must not be reused
#: for. `content_hash` answers "did the PDF change"; this answers "did the code
#: change". Both invalidate.
#:
#: 2 — reading-order section assignment correction reached cached documents, and
#:     sections gained ``parent_id`` and ``heading_block_id``.
#: 3 — the column-gutter floor was lowered, so multi-column pages whose gutter
#:     measured under 7.5 pt are no longer y-sorted. This **re-segments
#:     paragraphs** on the documents it affects: block ids and paragraph ids are
#:     reading positions, so correcting an order renumbers both. Any consumer
#:     holding a stored id — the FTS index, `analysis.json`, a citation in a saved
#:     answer — is pointing at a different paragraph afterwards and must be
#:     invalidated rather than reused.
IR_PIPELINE_VERSION = "3"

#: Numbered heading, e.g. "3 Method", "3.1 Encoder", "4.2.1 Details",
#: "A.1 Normalization", "C.1.2 Evaluation".
#:
#: The leading component may be a **letter**, which is how appendices are
#: numbered. Omitting that case flattened every appendix subsection to level 1:
#: `A.1`, `B.1`, `E.2` all became siblings of `A`, `B`, `E` rather than children,
#: measured on Diffusion Policy and Mamba. Their own PDF bookmark trees place
#: those headings at level 2, so the correction is corroborated by a source
#: outside this pipeline rather than invented here.
#:
#: `appendix` is consumed as a prefix so "Appendix A Details" yields `A` and
#: stays a root. Checked against all 112 distinct real section titles in the
#: benchmark corpus: this changes exactly 21 levels, every one `1 -> 2`, every one
#: a letter-prefixed appendix subsection, and no other heading at all.
_HEADING_NUMBER = re.compile(
    r"^(?:appendix\s+)?((?:[A-Z]|\d+)(?:\.(?:[A-Z]|\d+)){0,3})\.?\s+\S",
    re.IGNORECASE,
)

_REFERENCES_HEADING = re.compile(
    r"^\s*(?:\d+\.?\s*)?(references|bibliography|works\s+cited|literature\s+cited)\s*$",
    re.IGNORECASE,
)

_ABSTRACT_HEADING = re.compile(r"^\s*(?:\d+\.?\s*)?abstract\b", re.IGNORECASE)

#: Metadata values that name a tool rather than the document.
_GENERIC_METADATA = frozenset(
    {
        "", "untitled", "unknown", "none", "null", "no title",
        "microsoft word", "latex", "latex2e", "pdftex", "tex", "word",
        "acrobat distiller", "printer", "document", "paper", "thesis",
    }
)


class DocumentExtractionError(Exception):
    """The source could not be turned into an IR.

    Carries a stable ``code`` so the API layer can map it onto the shared error
    envelope without re-deriving what went wrong.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class _Placed:
    """A layout box with the text that fell inside it."""

    box: LayoutBox
    lines: list[str]


def extract_document_ir(
    source_path: Path | str,
    document_id: str,
    *,
    source_filename: str | None = None,
) -> DocumentIR:
    """Build the IR for a source PDF. Never writes to the source."""
    source = Path(source_path)
    if not source.is_file():
        raise DocumentExtractionError("SOURCE_NOT_FOUND", "The source file is no longer available.")

    before = _fingerprint(source)

    try:
        document = fitz.open(str(source))
    except Exception as exc:  # noqa: BLE001
        raise DocumentExtractionError("SOURCE_INVALID", "The PDF could not be read.") from exc

    try:
        if document.needs_pass:
            raise DocumentExtractionError(
                "PDF_ENCRYPTED", "Password-protected PDFs are not supported."
            )

        model = get_layout_model()
        pages: list[PageIR] = []
        ordered_blocks: list[TextBlockIR] = []

        for page_index in range(document.page_count):
            page = document[page_index]
            page_number = page_index + 1

            blocks = _extract_page_blocks(
                page, page_index, page_number, document_id, model
            )
            ordered = order_blocks(blocks, page_width_pt=page.rect.width)
            # Renumbered once the reading order is settled, so a block's ordinal
            # reflects where a reader meets it rather than the order a vision
            # model happened to emit rectangles. Both are deterministic; this one
            # is meaningful.
            _renumber_blocks(ordered, document_id, page_number)

            pages.append(
                PageIR(
                    page_index=page_index,
                    page_number=page_number,
                    width_pt=float(page.rect.width),
                    height_pt=float(page.rect.height),
                    rotation=int(page.rotation),
                    has_text=any(block.text.strip() for block in blocks),
                    blocks=ordered,
                )
            )
            ordered_blocks.extend(ordered)

        paragraphs = _assemble_paragraphs(ordered_blocks, document_id)
        _link_captions(pages)
        sections, heading_sections = _detect_sections(
            ordered_blocks, document_id, document.page_count
        )
        _assign_sections(paragraphs, sections, ordered_blocks, heading_sections)

        metadata = _read_metadata(document)
        if metadata.title is None:
            # PDF metadata has no usable title (or only a generator's name), so
            # fall back to what the page itself shows. Measured on a real paper:
            # arXiv PDFs routinely carry no title metadata at all, which is
            # exactly when the layout title is worth having.
            title_block = layout_title_block(ordered_blocks)
            if title_block is not None:
                metadata.title = join_wrapped_lines(title_block.text.split("\n")) or None

        has_text_layer = any(page.has_text for page in pages)

        ir = DocumentIR(
            document_id=document_id,
            content_hash=before[0],
            pipeline_version=IR_PIPELINE_VERSION,
            source_filename=source_filename or source.name,
            page_count=document.page_count,
            metadata=metadata,
            sections=sections,
            pages=pages,
            paragraphs=paragraphs,
            page_mapping={p.id: p.page_number for p in paragraphs},
            has_text_layer=has_text_layer,
            # No text at all is the signature of a scan. Saying so is the honest
            # minimum; running OCR is a different task.
            ocr_required=not has_text_layer and document.page_count > 0,
        )
    finally:
        document.close()

    after = _fingerprint(source)
    if after != before:
        # Nothing in this module opens the source for writing, so this can only
        # mean something outside it did — worth failing loudly over.
        raise DocumentExtractionError(
            "SOURCE_MODIFIED", "The source PDF changed during extraction."
        )

    return ir


# --- fingerprints -------------------------------------------------------------


def _fingerprint(path: Path) -> tuple[str, int, float]:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    stat = path.stat()
    return digest.hexdigest(), stat.st_size, stat.st_mtime


# --- page extraction ----------------------------------------------------------


def _read_text_lines(page: fitz.Page) -> list[tuple[str, BoundingBox, float]]:
    """Every text line on the page, with its bbox and dominant font size.

    Font size is kept because it is the only reliable way to tell a heading from
    a table sub-label — both arrive from the layout model labelled `title`, and
    neither geometry nor the surrounding blocks separate them. Measured on a real
    paper: a heading is set larger than body text, a table label is set at body
    size. Weighted by character count so one oversized glyph in a line does not
    decide the line's size.
    """
    lines: list[tuple[str, BoundingBox, float]] = []
    for block in page.get_text("dict").get("blocks", []):
        if block.get("type") != 0:  # 0 = text; 1 = image
            continue
        for line in block.get("lines", []):
            text = "".join(span.get("text", "") for span in line.get("spans", []))
            if not text.strip():
                continue
            sizes: defaultdict[float, int] = defaultdict(int)
            for span in line.get("spans", []):
                if span.get("text", "").strip():
                    sizes[round(float(span.get("size", 0.0)), 1)] += len(span["text"])
            size = max(sizes, key=lambda value: sizes[value]) if sizes else 0.0
            x0, y0, x1, y1 = line["bbox"]
            lines.append((text, (float(x0), float(y0), float(x1), float(y1)), size))
    return lines


def _extract_page_blocks(
    page: fitz.Page,
    page_index: int,
    page_number: int,
    document_id: str,
    model: object,
) -> list[TextBlockIR]:
    """One block per detected region, plus a block for anything left over."""
    pixmap = page.get_pixmap(alpha=False)
    image = _pixmap_to_rgb(pixmap)

    detected = model.detect(image, float(page.rect.width), float(page.rect.height))
    text_lines = _read_text_lines(page)

    # Assign each line to the detected region containing its centre. A line
    # straddling two regions goes to the first match; a line in no region is
    # collected below rather than dropped, because AC-DOC-03 forbids losing text.
    buckets: dict[int, list[tuple[str, float]]] = {
        index: [] for index in range(len(detected))
    }
    orphans: list[tuple[str, BoundingBox, float]] = []

    for text, bbox, size in text_lines:
        centre_x = (bbox[0] + bbox[2]) / 2
        centre_y = (bbox[1] + bbox[3]) / 2
        owner = None
        for index, box in enumerate(detected):
            x0, y0, x1, y1 = box.bbox
            if x0 <= centre_x <= x1 and y0 <= centre_y <= y1:
                owner = index
                break
        if owner is None:
            orphans.append((text, bbox, size))
        else:
            buckets[owner].append((text, size))

    blocks: list[TextBlockIR] = []
    for index, box in enumerate(detected):
        collected = buckets[index]
        if not collected:
            # A detected region with no text is still recorded: a figure has
            # geometry worth keeping even when it has no extractable words.
            if box.label == LAYOUT_FIGURE or box.label == LAYOUT_TABLE:
                blocks.append(
                    _block(
                        document_id, page_index, page_number, len(blocks),
                        box.label, box.bbox, "", None,
                    )
                )
            continue
        blocks.append(
            _block(
                document_id, page_index, page_number, len(blocks),
                box.label, box.bbox,
                "\n".join(text for text, _ in collected),
                _dominant_size(collected),
            )
        )

    if orphans:
        # Text the model did not account for. Treating it as ordinary body text
        # is the conservative choice: promoting it to a heading or a caption
        # would be inventing structure from an absence of evidence.
        blocks.append(
            _block(
                document_id, page_index, page_number, len(blocks),
                LAYOUT_PLAIN_TEXT,
                _union([bbox for _, bbox, _ in orphans]),
                "\n".join(text for text, _, _ in orphans),
                _dominant_size([(text, size) for text, _, size in orphans]),
            )
        )

    return blocks


def _dominant_size(lines: list[tuple[str, float]]) -> float | None:
    """The font size most of the text is set in, weighted by character count."""
    weights: defaultdict[float, int] = defaultdict(int)
    for text, size in lines:
        if size:
            weights[size] += len(text)
    if not weights:
        return None
    return max(weights, key=lambda value: weights[value])


def _block(
    document_id: str,
    page_index: int,
    page_number: int,
    ordinal: int,
    layout_class: str,
    bbox: BoundingBox,
    text: str,
    font_size: float | None,
) -> TextBlockIR:
    return TextBlockIR(
        id=f"b_{document_id}_p{page_number}_{ordinal:03d}",
        page_index=page_index,
        page_number=page_number,
        layout_class=layout_class,
        bbox=bbox,
        text=text,
        font_size=font_size,
    )


def _renumber_blocks(
    ordered: list[TextBlockIR], document_id: str, page_number: int
) -> None:
    """Give every block on a page an id matching its reading position."""
    for ordinal, block in enumerate(ordered):
        block.id = f"b_{document_id}_p{page_number}_{ordinal:03d}"


def _pixmap_to_rgb(pixmap: fitz.Pixmap) -> "object":
    import numpy as np

    array = np.frombuffer(pixmap.samples, dtype=np.uint8)
    array = array.reshape(pixmap.height, pixmap.width, pixmap.n)
    if pixmap.n == 4:
        return array[:, :, :3]
    if pixmap.n == 1:
        return np.repeat(array, 3, axis=2)
    return array


def _union(boxes: list[BoundingBox]) -> BoundingBox:
    return (
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    )


# --- reading order ------------------------------------------------------------


def order_blocks(blocks: list[TextBlockIR], *, page_width_pt: float) -> list[TextBlockIR]:
    """Order a page's blocks the way a person reads them.

    The naive answer — sort by y, then by x — produces the classic multi-column
    failure: line 1 of the left column, line 1 of the right column, line 2 of the
    left, and so on. That is the single most likely defect in this task and the
    reason AC-DOC-04 exists.

    Instead the page is split into *bands* by full-width blocks. Within a band,
    blocks are grouped into columns and read column by column. An academic paper
    is typically: a full-width title and abstract, then two columns — possibly
    interrupted mid-page by a full-width figure — then two more.
    """
    if not blocks:
        return []

    text_blocks = [block for block in blocks if block.layout_class != LAYOUT_ABANDON]
    if not text_blocks:
        return list(blocks)

    left = min(block.bbox[0] for block in text_blocks)
    right = max(block.bbox[2] for block in text_blocks)
    span = max(right - left, 1.0)
    full_width_threshold = FULL_WIDTH_RATIO * span

    # A block can also span the page without being wide relative to it: a line
    # that crosses the gutter between two columns does. Measured on a real paper,
    # an author-email line at y=184 between the byline and the abstract was
    # ordered *after* prose at y=555 — it fitted neither column and became a
    # column of its own, sorted last by x. Such a block belongs at its own
    # vertical position, so it is treated the same way as a full-width one.
    narrow = [
        block
        for block in text_blocks
        if block.bbox[2] - block.bbox[0] < full_width_threshold
    ]
    gutter = (
        _column_split(
            narrow,
            min(block.bbox[0] for block in narrow),
            max(block.bbox[2] for block in narrow),
        )
        if len(narrow) >= 2
        else None
    )

    def is_wide(block: TextBlockIR) -> bool:
        if block.bbox[2] - block.bbox[0] >= full_width_threshold:
            return True
        if gutter is None:
            return False
        x0, _, x1, _ = block.bbox
        return x0 < gutter - _GUTTER_REACH_PT and x1 > gutter + _GUTTER_REACH_PT

    ordered: list[TextBlockIR] = []
    band: list[TextBlockIR] = []

    def flush() -> None:
        if band:
            ordered.extend(_order_band(band))
            band.clear()

    for block in sorted(text_blocks, key=lambda b: (b.bbox[1], b.bbox[0])):
        if is_wide(block) and len(band) > 0:
            flush()
        if is_wide(block):
            ordered.append(block)
        else:
            band.append(block)
    flush()

    # Non-prose regions keep their place for coordinates but never join a
    # paragraph, so their position among the prose is not load-bearing. Putting
    # them last keeps the prose sequence intact and the output stable.
    ordered.extend(block for block in blocks if block.layout_class == LAYOUT_ABANDON)
    return ordered


#: How far a block must reach across the gutter on each side before it is
#: treated as spanning the columns. Large enough that a block merely touching a
#: neighbouring column's edge is not counted as crossing.
_GUTTER_REACH_PT = 12.0

#: Narrower than this, an empty vertical channel is a gap between words rather
#: than a gutter between columns.
#:
#: **6.0, lowered from 8.0 by DS-DOC-002, on measurement.** The floor was
#: rejecting real gutters: on Diffusion Policy twelve of fifteen two-column bands
#: had their gutter measured just under 7.5 pt, the split was refused, and
#: `_order_band` fell back to a y-sort that interleaves the columns.
#:
#: Swept over the four development papers and six more (two of them held-out
#: two-column camera-ready papers), every value from 2.0 to 12.0 produces the
#: *same* false-split count — the failures there are gold disagreements, not
#: threshold artefacts — while missed splits fall from 13 to 0 at 7.0 and stay
#: there. 6.0 sits below the observed cliff (between 7.0 and 7.5) rather than on
#: it, which is deliberate: a floor placed exactly at the observed boundary would
#: be fitted to these papers.
#:
#: The corpus cannot distinguish this from a *normalized* rule — every paper in it
#: is 595-612 pt wide and set at 10 pt, so `page width x 0.010` gives an identical
#: floor and identical results. Normalization is the better rule in principle and
#: is recorded as unmeasured rather than adopted on an argument; see
#: `.agent/evidence/DS-DOC-002.md`.
_MIN_GUTTER_PT = 6.0

#: Resolution of the horizontal occupancy profile used to find the gutter.
_PROFILE_CELLS = 200


def _column_split(
    blocks: list[TextBlockIR], left: float, right: float
) -> float | None:
    """The x of the gutter between two columns, or ``None`` if there is one column.

    Found from an occupancy profile: project every block onto the x axis and look
    for the widest empty vertical channel near the middle of the content. A
    genuine gutter is a channel no text crosses.

    This replaced a greedy "merge overlapping rectangles" grouping, which failed
    on a real paper: a full-width line overlaps *both* columns, so it was merged
    into whichever it happened to touch first, dragging the title, the byline and
    the author emails into the right-hand column and interleaving the whole page.

    Only two columns are resolved. That covers academic papers, which is what
    this is for; a three-column layout degrades to "left half, right half"
    rather than being mis-ordered in some more inventive way.
    """
    width = right - left
    if width <= 0 or len(blocks) < 2:
        return None

    # The profile counts how many *distinct blocks* cover each x position, and the
    # gutter is where that count is lowest — not necessarily zero.
    #
    # Requiring an empty channel fails on real papers. A title, a byline and an
    # author-email line all cross the middle without being column content, so a
    # strictly-empty test finds no gutter at all and collapses the page into one
    # column; a 5pt page number sitting in the channel does the same. The gutter
    # is instead the place fewest things cross.
    minimum_column_width = max(10.0, 0.02 * width)
    banner_width = 0.9 * width

    counts = [0] * _PROFILE_CELLS
    contributors = 0
    for block in blocks:
        block_width = block.bbox[2] - block.bbox[0]
        # Slivers cannot be columns, and a near-full-width banner spans
        # everything, so neither tells us anything about where a gutter is.
        if block_width < minimum_column_width or block_width >= banner_width:
            continue
        contributors += 1
        start = int((block.bbox[0] - left) / width * _PROFILE_CELLS)
        end = int((block.bbox[2] - left) / width * _PROFILE_CELLS + 0.5)
        for cell in range(max(0, start), min(_PROFILE_CELLS, max(end, start + 1))):
            counts[cell] += 1

    if contributors < 4:
        return None

    # Only the middle 60% is considered: the outer fifths are ragged from
    # justification, and treating that as a gutter would split nothing.
    lo, hi = _PROFILE_CELLS // 5, _PROFILE_CELLS * 4 // 5
    lowest = min(counts[lo:hi])

    # If even the quietest channel is crossed by most of the page, this is a
    # single-column layout and there is nothing to split.
    if lowest > max(1, int(0.35 * contributors)):
        return None

    best: tuple[int, int] | None = None
    run_start: int | None = None
    for cell in range(lo, hi + 1):
        at_minimum = cell < hi and counts[cell] == lowest
        if at_minimum:
            if run_start is None:
                run_start = cell
        elif run_start is not None:
            best = _wider(best, (run_start, cell))
            run_start = None

    if best is None or (best[1] - best[0]) / _PROFILE_CELLS * width < _MIN_GUTTER_PT:
        return None

    return left + (best[0] + best[1]) / 2 / _PROFILE_CELLS * width


def _wider(current: tuple[int, int] | None, candidate: tuple[int, int]) -> tuple[int, int]:
    if current is None:
        return candidate
    return candidate if (candidate[1] - candidate[0]) > (current[1] - current[0]) else current


def _order_band(band: list[TextBlockIR]) -> list[TextBlockIR]:
    """Read one band column by column, left to right."""
    left = min(block.bbox[0] for block in band)
    right = max(block.bbox[2] for block in band)
    split = _column_split(band, left, right)

    if split is None:
        return sorted(band, key=lambda b: (b.bbox[1], b.bbox[0]))

    first: list[TextBlockIR] = []
    second: list[TextBlockIR] = []
    for block in band:
        centre = (block.bbox[0] + block.bbox[2]) / 2
        (first if centre < split else second).append(block)

    return sorted(first, key=lambda b: (b.bbox[1], b.bbox[0])) + sorted(
        second, key=lambda b: (b.bbox[1], b.bbox[0])
    )


# --- paragraphs ---------------------------------------------------------------


def _assemble_paragraphs(blocks: list[TextBlockIR], document_id: str) -> list[ParagraphIR]:
    """Join consecutive prose blocks that are really one paragraph.

    A paragraph ends when the text ends a sentence, or when a non-prose region
    interrupts it, or when the next block starts a new thought. Merging is the
    conservative direction: the criteria forbid splitting a paragraph across a
    column or page break, and a wrongly merged pair is visible in the text while
    a wrongly split one silently truncates a sentence.

    Identifiers are assigned here, in the order paragraphs are produced, because
    this order *is* reading order — which is what makes them stable across runs.
    """
    paragraphs: list[ParagraphIR] = []
    current: list[TextBlockIR] = []

    def flush() -> None:
        if not current:
            return
        lines: list[str] = []
        for block in current:
            lines.extend(block.text.split("\n"))
        text = join_wrapped_lines(lines)
        if text:
            paragraphs.append(
                ParagraphIR(
                    id=f"p_{document_id}_{len(paragraphs) + 1:04d}",
                    text=text,
                    page_number=current[0].page_number,
                    page_range=(current[0].page_number, current[-1].page_number),
                    block_ids=[block.id for block in current],
                    bboxes=[block.bbox for block in current],
                )
            )
        current.clear()

    for block in blocks:
        if block.layout_class in NON_PROSE_CLASSES or block.layout_class == LAYOUT_TITLE:
            # Anything that is not body prose breaks the chain. A heading starts
            # a new section rather than continuing the previous sentence, and a
            # figure or caption must never be welded onto a paragraph.
            flush()
            continue

        if not looks_like_prose(block.text):
            continue

        if current and _continues(current[-1], block):
            current.append(block)
        else:
            flush()
            current.append(block)
    flush()

    return paragraphs


def _continues(previous: TextBlockIR, following: TextBlockIR) -> bool:
    """Whether ``following`` continues the sentence ``previous`` was writing."""
    if not previous.text.strip():
        return False
    if ends_sentence(previous.text.strip()):
        return False
    # A new column is a normal place for a sentence to continue; a new *page* is
    # too. Neither breaks the paragraph on its own. What does break it is the
    # previous block having finished its sentence.
    first = following.text.lstrip()[:1]
    return bool(first) and (first.islower() or first in "([")
    # An upper-case opening after an unterminated sentence is far more often a
    # new heading or a caption than a continuation, so it is not merged.


# --- captions -----------------------------------------------------------------


def _link_captions(pages: list[PageIR]) -> None:
    """Attach each caption to the figure or table it labels.

    Captions are matched to the nearest figure/table region on the same page by
    the vertical gap between them. A caption with no plausible target keeps
    ``caption_of = None`` rather than being attached to whatever is closest.
    """
    targets = {LAYOUT_FIGURE_CAPTION: {LAYOUT_FIGURE, LAYOUT_TABLE},
               LAYOUT_TABLE_CAPTION: {LAYOUT_TABLE},
               LAYOUT_FORMULA_CAPTION: {LAYOUT_ISOLATE_FORMULA}}

    for page in pages:
        elements = [
            block for block in page.blocks
            if block.layout_class in {LAYOUT_FIGURE, LAYOUT_TABLE, LAYOUT_ISOLATE_FORMULA}
        ]
        if not elements:
            continue
        for block in page.blocks:
            wanted = targets.get(block.layout_class)
            if not wanted:
                continue
            candidates = [e for e in elements if e.layout_class in wanted]
            if not candidates:
                continue
            nearest = min(candidates, key=lambda e: abs(e.bbox[1] - block.bbox[3]))
            block.caption_of = nearest.id


# --- sections -----------------------------------------------------------------

#: How much larger than body text a `title` block must be set to count as a
#: heading. Measured on a real paper: every genuine heading was at least 1pt
#: larger, every table sub-label was exactly body size — so the gap is not a
#: judgement call, and a small margin is enough to absorb rounding.
_HEADING_SIZE_MARGIN = 0.4


def _body_size_by_page(blocks: list[TextBlockIR]) -> dict[int, float]:
    """The size a page's body prose is set in, weighted by character count.

    Derived from the blocks the layout model called `plain text`, which is the
    most direct evidence available for "what body text looks like here".
    """
    weights: dict[int, defaultdict[float, int]] = defaultdict(lambda: defaultdict(int))
    for block in blocks:
        if block.layout_class != LAYOUT_PLAIN_TEXT or block.font_size is None:
            continue
        weights[block.page_number][block.font_size] += len(block.text)

    result: dict[int, float] = {}
    for page_number, sizes in weights.items():
        if sizes:
            result[page_number] = max(sizes, key=lambda value: sizes[value])
    return result


def _is_heading_sized(block: TextBlockIR, body_sizes: dict[int, float]) -> bool:
    """Whether a `title`-classified block is typographically a heading.

    The layout model labels the paper's title, every section heading, *and*
    table sub-labels such as "PASCAL VOC" as `title`. Geometry does not separate
    them — measured, and both obvious heuristics failed: a table label sat within
    zero points of a table while "Abstract" did too, and "followed by prose"
    matched every one of the six spurious headings on a real paper.

    Font size does separate them, cleanly: a heading is set larger than body
    text, a sub-label is set at body size. On the paper this was validated
    against, the rule accepted all 17 real headings and rejected all 6 spurious
    ones.

    Where the evidence is missing — a caller constructing blocks by hand, or a
    PDF with no usable font metrics — the block is accepted. Rejecting on absent
    evidence would silently drop real sections.
    """
    body = body_sizes.get(block.page_number)
    if block.font_size is None or body is None:
        return True
    return block.font_size > body + _HEADING_SIZE_MARGIN


def layout_title_block(blocks: list[TextBlockIR]) -> TextBlockIR | None:
    """The largest `title` block on page one — the paper's own title.

    Preferred over PDF metadata, which is frequently absent and occasionally
    wrong. Font size decides, because the title is the largest thing on the
    first page; the bounding-box height is only a tie-break.
    """
    first_page = [
        block
        for block in blocks
        if block.page_number == 1 and block.layout_class == LAYOUT_TITLE and block.text.strip()
    ]
    if not first_page:
        return None
    return max(
        first_page,
        key=lambda block: (block.font_size or 0.0, block.bbox[3] - block.bbox[1]),
    )


def _detect_sections(
    blocks: list[TextBlockIR],
    document_id: str,
    page_count: int,
) -> tuple[list[SectionIR], dict[str, str]]:
    """Headings, their levels, and the pages they cover.

    The layout model marks both the paper's title and its section headings as
    ``title`` — it has no notion of hierarchy. Levels therefore come from the
    heading's own numbering where there is any, and default to 1 where there is
    not. Where neither numbering nor a recognisable heading exists, no section is
    invented; the paragraphs simply belong to none.

    A heading's page range runs to the page before the next heading, or to the
    end of the document for the last one. Blocks are in reading order, so the
    "next heading" is simply the next one in the list.
    """
    headings = [
        block
        for block in blocks
        if block.layout_class == LAYOUT_TITLE
        and block.text.strip()
        and _is_heading_sized(block, _body_size_by_page(blocks))
    ]
    if not headings:
        return [], {}

    title_block = layout_title_block(blocks)
    section_headings = [heading for heading in headings if heading is not title_block]

    sections: list[SectionIR] = []
    #: Which heading block opened which section. The assignment pass needs this
    #: to place a paragraph by reading order rather than by page.
    heading_sections: dict[str, str] = {}
    for index, heading in enumerate(section_headings):
        title = join_wrapped_lines(heading.text.split("\n"))
        if not title:
            continue

        number = _HEADING_NUMBER.match(title)
        level = len(number.group(1).split(".")) if number else 1

        if index + 1 < len(section_headings):
            last_page = max(heading.page_number, section_headings[index + 1].page_number - 1)
        else:
            last_page = page_count

        section_id = f"sec_{document_id}_{len(sections) + 1:03d}"
        heading_sections[heading.id] = section_id
        sections.append(
            SectionIR(
                id=section_id,
                title=title,
                level=level,
                page_range=(heading.page_number, max(heading.page_number, last_page)),
                heading_block_id=heading.id,
                is_references=bool(_REFERENCES_HEADING.match(title)),
            )
        )

    _build_hierarchy(sections)
    return sections, heading_sections


def _build_hierarchy(sections: list[SectionIR]) -> None:
    """Give each section its parent, from the nesting the paper itself states.

    The layout model marks every heading ``title`` and has no notion of hierarchy,
    so nesting has to come from somewhere else. Two signals exist, and they
    disagree on real papers:

    * **Reading order plus level** — a level-2 heading nests under the nearest
      preceding level-1 heading. Correct on the great majority of papers, and
      wrong when the layout puts a subsection heading after the next section's:
      measured on Diffusion Policy, where ``3.2. Visual Encoder`` appears after
      ``4.1 Model Multi-Modal Action Distributions``, so a pure stack makes
      ``3.2`` a child of ``4``.
    * **The section's own number** — ``3.2`` belongs to ``3``, wherever the
      heading happens to be printed. This is the paper stating its own structure,
      and it is decisive when present.

    So the number wins when it can, and the stack is the fallback for unnumbered
    headings (which have no number to be right about). Neither signal is invented:
    both are read off the document.

    A section whose parent is not found — an appendix ``C.1`` with no ``C``
    heading, because the layout model dropped it — stays a root rather than
    being attached to a guess.
    """
    #: Every numbered section, so a child's prefix can find its parent at any
    #: depth: "3.2" -> "3", and "1.1.1" -> "1.1". Keying only on top-level
    #: numbers put `1.1.1` under `1` instead of under `1.1` — a defect no
    #: benchmark paper exposed, because none of them nests three deep.
    by_number: dict[str, SectionIR] = {}
    for section in sections:
        match = _HEADING_NUMBER.match(section.title)
        if match:
            by_number.setdefault(match.group(1).upper(), section)

    stack: list[SectionIR] = []
    for section in sections:
        match = _HEADING_NUMBER.match(section.title)
        number = match.group(1) if match else None
        level = section.level or 1

        while stack and (stack[-1].level or 1) >= level:
            stack.pop()
        parent = stack[-1] if stack else None

        # The number is the paper's own statement of nesting, so it overrides the
        # stack when it names a section that exists. This is the Diffusion Policy
        # case: "3.2" printed after "4.1" still belongs to "3".
        if number and "." in number:
            numbered_parent = by_number.get(number.rsplit(".", 1)[0].upper())
            if numbered_parent is not None and numbered_parent is not section:
                parent = numbered_parent

        section.parent_id = parent.id if parent is not None else None
        stack.append(section)


def _assign_sections(
    paragraphs: list[ParagraphIR],
    sections: list[SectionIR],
    blocks: list[TextBlockIR],
    heading_sections: dict[str, str],
) -> None:
    """Attach each paragraph to the section that governs it.

    A paragraph belongs to the **last heading that appeared before it in reading
    order** — and that is what this now does, having previously compared *pages*.

    The page-based version was wrong in a way that took a downstream task to
    expose. Academic sections frequently share a page: on a real paper three
    headings fall on page 3, so every paragraph on that page was assigned to the
    last of them. Eight of sixteen sections ended up owning no paragraphs at all
    — including the Abstract and the References — and nothing noticed, because
    the reading order, the headings and the page mapping were all still correct.

    Paragraphs before the first heading keep ``section_id = None``; the criteria
    prefer an honest gap to a fabricated section.
    """
    if not sections:
        return

    positions = {block.id: index for index, block in enumerate(blocks)}
    # Headings in the order a reader meets them, paired with the section each one
    # opened. Sections are built from these blocks in this same order, so a
    # paragraph's section is simply the last heading before it.
    ordered_headings = sorted(
        (positions[block_id], section_id)
        for block_id, section_id in heading_sections.items()
        if block_id in positions
    )

    for paragraph in paragraphs:
        if not paragraph.block_ids:
            continue
        start = positions.get(paragraph.block_ids[0])
        if start is None:
            continue

        governing: str | None = None
        for position, section_id in ordered_headings:
            if position >= start:
                break
            governing = section_id
        if governing is not None:
            paragraph.section_id = governing

    # Abstract detection: a heading beginning "Abstract" governs everything until
    # the next heading, and those paragraphs are flagged as the abstract.
    for section in sections:
        if _ABSTRACT_HEADING.match(section.title):
            for paragraph in paragraphs:
                if paragraph.section_id == section.id:
                    paragraph.is_abstract = True
            break


# --- metadata -----------------------------------------------------------------


def _read_metadata(document: fitz.Document) -> DocumentMetadata:
    """PDF metadata, with the values that are not really answers removed.

    A `title` of "untitled" or a `producer` of "LaTeX2e" tells a later feature
    nothing, and would be worse than nothing if rendered as the paper's name.
    Those become ``None``; so does anything absent.
    """
    raw = document.metadata or {}

    def clean(value: object) -> str | None:
        if not isinstance(value, str):
            return None
        stripped = value.strip()
        if stripped.lower() in _GENERIC_METADATA:
            return None
        return stripped or None

    keywords = clean(raw.get("keywords"))
    author = clean(raw.get("author"))

    return DocumentMetadata(
        title=clean(raw.get("title")),
        authors=[part.strip() for part in re.split(r"[;,]|\band\b", author) if part.strip()]
        if author
        else None,
        subject=clean(raw.get("subject")),
        keywords=[part.strip() for part in re.split(r"[;,]", keywords) if part.strip()]
        if keywords
        else None,
        creator=clean(raw.get("creator")),
        producer=clean(raw.get("producer")),
        creation_date=clean(raw.get("creationDate")),
    )
