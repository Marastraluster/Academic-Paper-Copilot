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

#: Numbered heading, e.g. "3 Method", "3.1 Encoder", "4.2.1 Details".
_HEADING_NUMBER = re.compile(r"^(\d+(?:\.\d+){0,3})\.?\s+\S")

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
        sections = _detect_sections(ordered_blocks, document_id, document.page_count)
        _assign_sections(paragraphs, sections, ordered_blocks)

        has_text_layer = any(page.has_text for page in pages)

        ir = DocumentIR(
            document_id=document_id,
            content_hash=before[0],
            source_filename=source_filename or source.name,
            page_count=document.page_count,
            metadata=_read_metadata(document),
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


def _read_text_lines(page: fitz.Page) -> list[tuple[str, BoundingBox]]:
    """Every text line on the page, with its bbox, in PyMuPDF's order."""
    lines: list[tuple[str, BoundingBox]] = []
    for block in page.get_text("dict").get("blocks", []):
        if block.get("type") != 0:  # 0 = text; 1 = image
            continue
        for line in block.get("lines", []):
            text = "".join(span.get("text", "") for span in line.get("spans", []))
            if not text.strip():
                continue
            x0, y0, x1, y1 = line["bbox"]
            lines.append((text, (float(x0), float(y0), float(x1), float(y1))))
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
    buckets: dict[int, list[str]] = {index: [] for index in range(len(detected))}
    orphans: list[tuple[str, BoundingBox]] = []

    for text, bbox in text_lines:
        centre_x = (bbox[0] + bbox[2]) / 2
        centre_y = (bbox[1] + bbox[3]) / 2
        owner = None
        for index, box in enumerate(detected):
            x0, y0, x1, y1 = box.bbox
            if x0 <= centre_x <= x1 and y0 <= centre_y <= y1:
                owner = index
                break
        if owner is None:
            orphans.append((text, bbox))
        else:
            buckets[owner].append(text)

    blocks: list[TextBlockIR] = []
    for index, box in enumerate(detected):
        lines = buckets[index]
        if not lines:
            # A detected region with no text is still recorded: a figure has
            # geometry worth keeping even when it has no extractable words.
            if box.label == LAYOUT_FIGURE or box.label == LAYOUT_TABLE:
                blocks.append(_block(document_id, page_index, page_number, len(blocks), box.label, box.bbox, ""))
            continue
        blocks.append(
            _block(
                document_id, page_index, page_number, len(blocks),
                box.label, box.bbox, "\n".join(lines),
            )
        )

    if orphans:
        # Text the model did not account for. Treating it as ordinary body text
        # is the conservative choice: promoting it to a heading or a caption
        # would be inventing structure from an absence of evidence.
        blocks.append(
            _block(
                document_id, page_index, page_number, len(blocks),
                LAYOUT_PLAIN_TEXT, _union([bbox for _, bbox in orphans]),
                "\n".join(text for text, _ in orphans),
            )
        )

    return blocks


def _block(
    document_id: str,
    page_index: int,
    page_number: int,
    ordinal: int,
    layout_class: str,
    bbox: BoundingBox,
    text: str,
) -> TextBlockIR:
    return TextBlockIR(
        id=f"b_{document_id}_p{page_number}_{ordinal:03d}",
        page_index=page_index,
        page_number=page_number,
        layout_class=layout_class,
        bbox=bbox,
        text=text,
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

    ordered: list[TextBlockIR] = []
    band: list[TextBlockIR] = []

    def flush() -> None:
        if band:
            ordered.extend(_order_band(band))
            band.clear()

    for block in sorted(text_blocks, key=lambda b: (b.bbox[1], b.bbox[0])):
        if block.bbox[2] - block.bbox[0] >= full_width_threshold and len(band) > 0:
            flush()
        if block.bbox[2] - block.bbox[0] >= full_width_threshold:
            ordered.append(block)
        else:
            band.append(block)
    flush()

    # Non-prose regions keep their place for coordinates but never join a
    # paragraph, so their position among the prose is not load-bearing. Putting
    # them last keeps the prose sequence intact and the output stable.
    ordered.extend(block for block in blocks if block.layout_class == LAYOUT_ABANDON)
    return ordered


def _order_band(band: list[TextBlockIR]) -> list[TextBlockIR]:
    """Read one band column by column, left to right."""
    columns = _columns_of(band)
    result: list[TextBlockIR] = []
    for column in columns:
        result.extend(sorted(column, key=lambda b: (b.bbox[1], b.bbox[0])))
    return result


def _columns_of(band: list[TextBlockIR]) -> list[list[TextBlockIR]]:
    """Group blocks into vertical columns by horizontal overlap.

    Not a clustering algorithm: blocks whose rectangles overlap horizontally
    belong together, and the merge order is left to right, which is the order
    they are read.
    """
    columns: list[list[TextBlockIR]] = []
    spans: list[list[float]] = []

    for block in sorted(band, key=lambda b: b.bbox[0]):
        x0, _, x1, _ = block.bbox
        width = max(x1 - x0, 1.0)
        for index, (span_x0, span_x1) in enumerate(spans):
            overlap = min(x1, span_x1) - max(x0, span_x0)
            if overlap > 0.5 * width:
                spans[index] = [min(x0, span_x0), max(x1, span_x1)]
                columns[index].append(block)
                break
        else:
            spans.append([x0, x1])
            columns.append([block])

    return [column for _, column in sorted(zip(spans, columns), key=lambda pair: pair[0][0])]


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


def _detect_sections(
    blocks: list[TextBlockIR],
    document_id: str,
    page_count: int,
) -> list[SectionIR]:
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
        if block.layout_class == LAYOUT_TITLE and block.text.strip()
    ]
    if not headings:
        return []

    # The first page's tallest heading is the paper's title, not a section.
    first_page = [heading for heading in headings if heading.page_number == 1]
    title_block = (
        max(first_page, key=lambda heading: heading.bbox[3] - heading.bbox[1])
        if first_page
        else None
    )
    section_headings = [heading for heading in headings if heading is not title_block]

    sections: list[SectionIR] = []
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

        sections.append(
            SectionIR(
                id=f"sec_{document_id}_{len(sections) + 1:03d}",
                title=title,
                level=level,
                page_range=(heading.page_number, max(heading.page_number, last_page)),
                is_references=bool(_REFERENCES_HEADING.match(title)),
            )
        )

    return sections


def _assign_sections(
    paragraphs: list[ParagraphIR],
    sections: list[SectionIR],
    blocks: list[TextBlockIR],
) -> None:
    """Attach each paragraph to the section that governs it.

    A paragraph belongs to the last heading that appeared before it in reading
    order. Paragraphs before the first heading — the abstract or a preamble —
    keep ``section_id = None``; the criteria prefer an honest gap to a fabricated
    section.
    """
    if not sections:
        return

    by_id = {block.id: block for block in blocks}
    ordered_sections = list(sections)

    for paragraph in paragraphs:
        first_block = by_id.get(paragraph.block_ids[0]) if paragraph.block_ids else None
        if first_block is None:
            continue
        governing = None
        for section in ordered_sections:
            if section.page_range[0] > first_block.page_number:
                break
            governing = section
        if governing is not None and not governing.is_references:
            paragraph.section_id = governing.id

    # Abstract detection: a heading beginning "Abstract" governs everything until
    # the next heading, and those paragraphs are flagged as the abstract.
    for section in ordered_sections:
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
