"""MinerU's middle JSON → the canonical :class:`DocumentIR`.

Everything above the IR — QA, outline, notes, overview, the reflowed reading —
keeps working unchanged, because this module produces the same structure the
in-house extractor does, with the same id scheme and the same source anchors.
What MinerU adds rides in fields the in-house extractor leaves ``None``:
`TextBlockIR.latex`, `.html` and `.image_path`.

Two input formats are read:

* **MinerU 4 (`docvortex.middle`, schema 2.0)** — ``pages[].blocks[]`` with
  coordinates normalised to 0–1 of the page, prose as inline spans
  (``text`` / ``equation_inline`` / ``code_inline`` / ``hyperlink``), and
  ``continues_prev`` marking a paragraph that carries on from the previous
  column or page.
* **MinerU 2.x/3.x (`pdf_info`)** — ``pdf_info[].para_blocks[]`` with
  ``lines[].spans[]`` and coordinates in the page's own points. Still produced by
  older self-hosted servers and by results a reader may already have on disk.

Rules that matter downstream:

* **Inline math is kept as ``$…$`` in the paragraph text.** Retrieval reads it
  as text; the reader renders it with KaTeX; the translator protects it with
  placeholders (`app.bilingual.mathguard`). A formula is never translated.
* **Running headers, footers and page numbers are ``abandon``**, exactly like the
  in-house extractor, so they never reach a model or a citation.
* **Coordinates are PDF points, top-left origin**, measured against the page
  sizes PyMuPDF reports — the space notes, highlights and citation boxes use.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from app.document import anchors
from app.document.models import (
    LAYOUT_ABANDON,
    LAYOUT_CODE,
    LAYOUT_FIGURE,
    LAYOUT_FIGURE_CAPTION,
    LAYOUT_ISOLATE_FORMULA,
    LAYOUT_PLAIN_TEXT,
    LAYOUT_TABLE,
    LAYOUT_TABLE_CAPTION,
    LAYOUT_TABLE_FOOTNOTE,
    LAYOUT_TITLE,
    BoundingBox,
    DocumentIR,
    DocumentMetadata,
    InlineRun,
    PageIR,
    ParagraphIR,
    SectionIR,
    TextBlockIR,
)

#: Stored as `DocumentIR.pipeline_version`. Distinct from the in-house
#: extractor's numeric versions, so a reader of the IR can tell which parser
#: produced it, and bumping one never invalidates the other.
#: mineru-2: a paragraph continued past a floating figure or table, or over a
#: column or page break MinerU left unmarked, is one paragraph again (mineru-1
#: cut it in two there).
#: mineru-3: a label printed inside a figure is no longer a paragraph, and the
#: paper's bold and superscript runs are carried beside the text.
MINERU_PIPELINE_VERSION = "mineru-3"

_HEADING_NUMBER = re.compile(
    r"^\s*((?:\d+|[A-Z])(?:\.\d+)*)\.?\s+\S", re.IGNORECASE
)
_REFERENCES_HEADING = re.compile(
    r"^\s*(?:\d+\.?\s*)?(references|bibliography|参考文献)\b", re.IGNORECASE
)
_ABSTRACT_HEADING = re.compile(r"^\s*(?:\d+\.?\s*)?abstract\b", re.IGNORECASE)
_ABSTRACT_LEAD = re.compile(r"^\s*abstract\b\s*[—\-–:.]?", re.IGNORECASE)
_CJK = re.compile(r"[　-〿぀-ヿ㐀-鿿＀-￯]")


class MinerUConversionError(ValueError):
    """The middle JSON is not something this module can read."""


@dataclass(frozen=True)
class PageGeometry:
    width_pt: float
    height_pt: float
    rotation: int = 0


@dataclass
class _Unit:
    """One thing a reader meets, in reading order, before ids are assigned."""

    kind: str
    page_index: int
    bbox: BoundingBox
    text: str = ""
    level: int | None = None
    latex: str | None = None
    html: str | None = None
    image_path: str | None = None
    continues: bool = False
    #: Units from one figure/table share a group; captions point at its body.
    group: int | None = None
    is_body: bool = False
    block_id: str = ""
    #: Styled stretches of `text`, as ``(start, end, styles)``.
    runs: list[tuple[int, int, tuple[str, ...]]] = field(default_factory=list)


_LAYOUT_BY_KIND = {
    "doc_title": LAYOUT_TITLE,
    "heading": LAYOUT_TITLE,
    "text": LAYOUT_PLAIN_TEXT,
    "ref": LAYOUT_PLAIN_TEXT,
    "equation": LAYOUT_ISOLATE_FORMULA,
    "figure": LAYOUT_FIGURE,
    "figure_caption": LAYOUT_FIGURE_CAPTION,
    "table": LAYOUT_TABLE,
    "table_caption": LAYOUT_TABLE_CAPTION,
    "table_footnote": LAYOUT_TABLE_FOOTNOTE,
    "code": LAYOUT_CODE,
    "abandon": LAYOUT_ABANDON,
}


# --- inline text -------------------------------------------------------------


#: What MinerU names a span's style, and nothing else is carried.
_STYLES = frozenset({"bold", "italic", "superscript", "subscript", "underline", "code"})

Run = tuple[int, int, tuple[str, ...]]


def _join_styled(pieces: list[tuple[str, bool, tuple[str, ...]]]) -> tuple[str, list[Run]]:
    """Join inline runs, and say where the styled ones ended up.

    ``pieces`` are ``(text, is_math, styles)``. Text runs are joined as they
    come — MinerU carries the spaces between them — but a formula glued to a word
    (``where$x$is``) reads wrong and renders wrong, so one space is put on each
    side where Latin text meets it. Runs of spaces are collapsed afterwards, so
    the positions are tracked through that rather than searched for: a
    superscript ``1`` cannot be found again by looking for a "1".
    """
    out = ""
    previous_math = False
    marks: list[Run] = []
    for text, is_math, styles in pieces:
        if not text:
            continue
        if out and (is_math or previous_math):
            left, right = out[-1], text[0]
            if not left.isspace() and not right.isspace() and not (
                _CJK.match(left) or _CJK.match(right)
            ) and right not in ",.;:)]}" and left not in "([{":
                out += " "
        if styles and not is_math:
            marks.append((len(out), len(out) + len(text), styles))
        out += text
        previous_math = is_math

    # Collapse spaces and tabs to one space, remembering where each character went.
    kept: list[str] = []
    moved: list[int] = []
    for char in out:
        moved.append(len(kept))
        if char in " \t":
            if kept and kept[-1] == " ":
                continue
            kept.append(" ")
        else:
            kept.append(char)
    moved.append(len(kept))
    collapsed = "".join(kept)
    lead = len(collapsed) - len(collapsed.lstrip())
    final = collapsed.strip()

    runs: list[Run] = []
    for start, end, styles in marks:
        a = max(0, moved[start] - lead)
        b = min(len(final), moved[end] - lead)
        while a < b and final[a].isspace():
            a += 1
        while b > a and final[b - 1].isspace():
            b -= 1
        if a < b:
            runs.append((a, b, styles))
    return final, runs


def _join_pieces(pieces: list[tuple[str, bool]]) -> str:
    """`_join_styled` for runs that carry no style (the legacy format)."""
    return _join_styled([(text, is_math, ()) for text, is_math in pieces])[0]


def _spans_styled(spans: Any) -> tuple[str, list[Run]]:
    """MinerU 4 inline spans → text with ``$…$`` math, and its styled stretches."""
    pieces: list[tuple[str, bool, tuple[str, ...]]] = []

    def walk(items: Any, inherited: tuple[str, ...] = ()) -> None:
        if isinstance(items, str):
            pieces.append((items, False, inherited))
            return
        if not isinstance(items, list):
            return
        for span in items:
            if not isinstance(span, dict):
                continue
            kind = span.get("type")
            content = span.get("content")
            raw = span.get("styles")
            styles = tuple(
                dict.fromkeys(
                    [*inherited, *(s for s in raw if isinstance(s, str) and s in _STYLES)]
                    if isinstance(raw, list) else inherited
                )
            )
            if kind == "equation_inline" and isinstance(content, str) and content.strip():
                pieces.append((f"${content.strip()}$", True, ()))
            elif kind == "hyperlink":
                walk(content, styles)
            elif kind == "code_inline" and isinstance(content, str):
                pieces.append((content, False, tuple(dict.fromkeys([*styles, "code"]))))
            elif isinstance(content, str):
                pieces.append((content, False, styles))

    walk(spans)
    return _join_styled(pieces)


def _spans_text(spans: Any) -> str:
    """MinerU 4 inline spans → text with ``$…$`` math."""
    return _spans_styled(spans)[0]


def _legacy_lines_text(lines: Any) -> str:
    """MinerU 2/3 ``lines[].spans[]`` → text with ``$…$`` math.

    Lines are joined with a space, except after a hyphenated line break before a
    lower-case continuation (``recog-`` / ``nition``) and between CJK characters,
    where a space would be an error.
    """
    rendered: list[str] = []
    for line in lines or []:
        if not isinstance(line, dict):
            continue
        pieces: list[tuple[str, bool]] = []
        for span in line.get("spans") or []:
            if not isinstance(span, dict):
                continue
            kind = span.get("type")
            content = span.get("content")
            if not isinstance(content, str) or not content:
                continue
            if kind == "inline_equation":
                pieces.append((f"${content.strip()}$", True))
            elif kind in ("text", None):
                pieces.append((content, False))
        text = _join_pieces(pieces)
        if text:
            rendered.append(text)

    out = ""
    for text in rendered:
        if not out:
            out = text
        elif out.endswith("-") and text[:1].islower():
            out = out[:-1] + text
        elif _CJK.match(out[-1]) and _CJK.match(text[0]):
            out += text
        else:
            out += " " + text
    return out.strip()


# --- coordinates -------------------------------------------------------------


def _to_points_normalized(raw: Any, page: PageGeometry) -> BoundingBox:
    if not isinstance(raw, (list, tuple)) or len(raw) != 4:
        return (0.0, 0.0, page.width_pt, page.height_pt)
    x0, y0, x1, y1 = (float(v) for v in raw)
    return (
        round(x0 * page.width_pt, 2),
        round(y0 * page.height_pt, 2),
        round(x1 * page.width_pt, 2),
        round(y1 * page.height_pt, 2),
    )


def _to_points_scaled(raw: Any, page: PageGeometry, source_size: Any) -> BoundingBox:
    if not isinstance(raw, (list, tuple)) or len(raw) != 4:
        return (0.0, 0.0, page.width_pt, page.height_pt)
    sx = sy = 1.0
    if isinstance(source_size, (list, tuple)) and len(source_size) == 2:
        sw, sh = float(source_size[0] or 0), float(source_size[1] or 0)
        if sw > 0 and sh > 0:
            sx, sy = page.width_pt / sw, page.height_pt / sh
    x0, y0, x1, y1 = (float(v) for v in raw)
    return (round(x0 * sx, 2), round(y0 * sy, 2), round(x1 * sx, 2), round(y1 * sy, 2))


# --- MinerU 4 ----------------------------------------------------------------

_AUX_TYPES = {"header", "footer", "page_number", "aside_text", "page_footnote", "index"}
_VISUAL_KINDS = {
    "image": ("figure", "figure_caption", "figure_caption"),
    "chart": ("figure", "figure_caption", "figure_caption"),
    "table": ("table", "table_caption", "table_footnote"),
    "code": ("code", "figure_caption", "figure_caption"),
}


def _units_v4(middle: dict[str, Any], pages: list[PageGeometry]) -> list[_Unit]:
    units: list[_Unit] = []
    group_counter = 0

    for page_info in middle.get("pages") or []:
        if not isinstance(page_info, dict):
            continue
        page_index = int(page_info.get("page_idx", 0))
        if page_index < 0 or page_index >= len(pages):
            continue
        geometry = pages[page_index]

        def box(block: dict[str, Any]) -> BoundingBox:
            return _to_points_normalized(block.get("bbox"), geometry)

        for block in page_info.get("blocks") or []:
            if not isinstance(block, dict):
                continue
            kind = block.get("type")
            continues = bool(block.get("continues_prev"))

            if kind == "doc_title":
                units.append(_Unit("doc_title", page_index, box(block), _spans_text(block.get("content")), level=1))
            elif kind == "paragraph_title":
                level = block.get("level")
                units.append(
                    _Unit(
                        "heading", page_index, box(block), _spans_text(block.get("content")),
                        level=max(1, int(level) - 1) if isinstance(level, int) else None,
                    )
                )
            elif kind in ("text", "ref_text"):
                text, runs = _spans_styled(block.get("content"))
                units.append(
                    _Unit(
                        "ref" if kind == "ref_text" else "text",
                        page_index, box(block), text,
                        continues=continues, runs=runs,
                    )
                )
            elif kind == "list":
                is_refs = block.get("sub_type") == "ref_text"
                first = True
                stack = list(block.get("content") or [])
                while stack:
                    child = stack.pop(0)
                    if not isinstance(child, dict):
                        continue
                    if child.get("type") == "list":
                        stack[0:0] = list(child.get("content") or [])
                        continue
                    text, runs = _spans_styled(child.get("content"))
                    units.append(
                        _Unit(
                            "ref" if is_refs or child.get("type") == "ref_text" else "text",
                            page_index,
                            box(child) if child.get("bbox") else box(block),
                            text,
                            continues=continues and first, runs=runs,
                        )
                    )
                    first = False
            elif kind == "equation":
                latex = block.get("content") if isinstance(block.get("content"), str) else None
                units.append(
                    _Unit(
                        "equation", page_index, box(block), latex or "",
                        latex=latex, image_path=block.get("image_path"),
                    )
                )
            elif kind in _VISUAL_KINDS:
                body_kind, caption_kind, footnote_kind = _VISUAL_KINDS[kind]
                group_counter += 1
                for child in block.get("content") or []:
                    if not isinstance(child, dict):
                        continue
                    child_type = str(child.get("type") or "")
                    if child_type.endswith("_body"):
                        content = child.get("content")
                        units.append(
                            _Unit(
                                body_kind, page_index, box(child) if child.get("bbox") else box(block),
                                content if body_kind == "code" and isinstance(content, str)
                                else _spans_text(content) if child_type == "algorithm_body" else "",
                                html=content if body_kind == "table" and isinstance(content, str) else None,
                                image_path=child.get("image_path"),
                                group=group_counter, is_body=True,
                            )
                        )
                    elif child_type.endswith("_caption") or child_type.endswith("_footnote"):
                        units.append(
                            _Unit(
                                caption_kind if child_type.endswith("_caption") else footnote_kind,
                                page_index,
                                box(child) if child.get("bbox") else box(block),
                                _spans_text(child.get("content")),
                                group=group_counter,
                            )
                        )
            elif kind in _AUX_TYPES:
                text = _spans_text(block.get("content")) if kind != "index" else ""
                units.append(_Unit("abandon", page_index, box(block), text))
    return units


# --- MinerU 2/3 --------------------------------------------------------------


def _units_legacy(middle: dict[str, Any], pages: list[PageGeometry]) -> list[_Unit]:
    units: list[_Unit] = []
    group_counter = 0

    for page_info in middle.get("pdf_info") or []:
        if not isinstance(page_info, dict):
            continue
        page_index = int(page_info.get("page_idx", 0))
        if page_index < 0 or page_index >= len(pages):
            continue
        geometry = pages[page_index]
        size = page_info.get("page_size")

        def box(block: dict[str, Any]) -> BoundingBox:
            return _to_points_scaled(block.get("bbox"), geometry, size)

        for block in page_info.get("para_blocks") or []:
            if not isinstance(block, dict):
                continue
            kind = block.get("type")
            if block.get("lines_deleted") and not block.get("lines"):
                # MinerU already merged this block into the previous one.
                continue
            if kind == "title":
                level = block.get("level")
                units.append(
                    _Unit("heading", page_index, box(block), _legacy_lines_text(block.get("lines")),
                          level=int(level) if isinstance(level, int) else None)
                )
            elif kind in ("text", "ref_text"):
                units.append(
                    _Unit("ref" if kind == "ref_text" else "text", page_index, box(block),
                          _legacy_lines_text(block.get("lines")))
                )
            elif kind == "list":
                children = block.get("blocks") or []
                if children:
                    for child in children:
                        if isinstance(child, dict):
                            units.append(_Unit("text", page_index, box(child), _legacy_lines_text(child.get("lines"))))
                else:
                    units.append(_Unit("text", page_index, box(block), _legacy_lines_text(block.get("lines"))))
            elif kind == "interline_equation":
                latex = None
                image_path = None
                for line in block.get("lines") or []:
                    for span in (line or {}).get("spans") or []:
                        if isinstance(span, dict) and span.get("type") == "interline_equation":
                            latex = latex or span.get("content")
                            image_path = image_path or span.get("image_path")
                units.append(_Unit("equation", page_index, box(block), latex or "", latex=latex, image_path=image_path))
            elif kind in ("image", "table", "chart", "code"):
                body_kind, caption_kind, footnote_kind = _VISUAL_KINDS[kind]
                group_counter += 1
                for child in block.get("blocks") or []:
                    if not isinstance(child, dict):
                        continue
                    child_type = str(child.get("type") or "")
                    if child_type.endswith("_body"):
                        html = image_path = None
                        for line in child.get("lines") or []:
                            for span in (line or {}).get("spans") or []:
                                if not isinstance(span, dict):
                                    continue
                                image_path = image_path or span.get("image_path")
                                html = html or span.get("html")
                        units.append(
                            _Unit(body_kind, page_index, box(child), "", html=html,
                                  image_path=image_path, group=group_counter, is_body=True)
                        )
                    elif child_type.endswith("_caption") or child_type.endswith("_footnote"):
                        units.append(
                            _Unit(
                                caption_kind if child_type.endswith("_caption") else footnote_kind,
                                page_index, box(child), _legacy_lines_text(child.get("lines")),
                                group=group_counter,
                            )
                        )
            elif kind == "index":
                units.append(_Unit("abandon", page_index, box(block), ""))
        for block in page_info.get("discarded_blocks") or []:
            if isinstance(block, dict):
                units.append(_Unit("abandon", page_index, box(block), _legacy_lines_text(block.get("lines"))))
    return units


# --- assembly ----------------------------------------------------------------


def _union(boxes: list[BoundingBox]) -> BoundingBox:
    return (
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    )


def _build_hierarchy(sections: list[SectionIR]) -> None:
    """Parent links from numbering first, then from reading order and level.

    The same rule as the in-house extractor: a section's own number (``3.2``)
    is the paper stating where it belongs, and wins over position.
    """
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
        if number and "." in number:
            numbered = by_number.get(number.rsplit(".", 1)[0].upper())
            if numbered is not None and numbered is not section:
                parent = numbered
        section.parent_id = parent.id if parent is not None else None
        stack.append(section)


_LABEL_MAX_CHARS = 40


def _absorb_figure_labels(units: list[_Unit]) -> None:
    """A label printed in a figure is part of the picture, not a paragraph.

    Seen on a real paper: "VGG-19", "34-layer plain" and "34-layer residual" head
    the three columns of an architecture diagram, and MinerU returns each as a
    text block. As prose they are three one-word paragraphs sent to be
    translated. They are recognised by where they are — short, and mostly inside
    a figure's own rectangle on the same page — and set aside with the page's
    other furniture; the figure, with its crop one click away, still shows them.
    """
    figures: dict[int, list[BoundingBox]] = {}
    for unit in units:
        if unit.kind == "figure" and unit.is_body:
            figures.setdefault(unit.page_index, []).append(unit.bbox)
    if not figures:
        return
    for unit in units:
        if unit.kind != "text" or unit.continues or len(unit.text) > _LABEL_MAX_CHARS:
            continue
        if re.search(r"[.!?。！？:：]$", unit.text):
            continue  # a sentence, however short, is prose
        x0, y0, x1, y1 = unit.bbox
        area = max(0.0, x1 - x0) * max(0.0, y1 - y0)
        if area <= 0:
            continue
        for fx0, fy0, fx1, fy1 in figures.get(unit.page_index, []):
            overlap = max(0.0, min(x1, fx1) - max(x0, fx0)) * max(0.0, min(y1, fy1) - max(y0, fy0))
            if overlap / area >= 0.5:
                unit.kind = "abandon"
                unit.runs = []
                break


_UNFINISHED = re.compile(r"[A-Za-z,\-–—]$")


def _runs_on(paragraph: ParagraphIR, unit: _Unit) -> bool:
    """A column or page break MinerU did not mark as one paragraph continuing.

    Seen on a real paper: "…the degradation problem - the" closes a page and
    "34-layer plain net has…" opens the next, unmarked. Joined only when both
    signs are there — the text stops without ending a sentence, *and* the next
    block starts a new column or page rather than sitting below it — so two
    paragraphs in one column are never run together.
    """
    if unit.kind != "text" or not _UNFINISHED.search(paragraph.text):
        return False
    if len(paragraph.text) < 80:
        return False  # an author line or a label, not prose cut short
    last_page = paragraph.page_range[1]
    last_box = paragraph.bboxes[-1]
    new_page = unit.page_index + 1 > last_page
    new_column = unit.page_index + 1 == last_page and unit.bbox[1] < last_box[1] and unit.bbox[0] > last_box[0]
    return new_page or new_column


def is_mineru_middle_json(middle: Any) -> bool:
    return isinstance(middle, dict) and (
        isinstance(middle.get("pages"), list) or isinstance(middle.get("pdf_info"), list)
    )


def middle_json_to_ir(
    middle: dict[str, Any],
    *,
    document_id: str,
    content_hash: str,
    source_filename: str,
    pages: list[PageGeometry],
    metadata: DocumentMetadata | None = None,
) -> DocumentIR:
    """Build the IR from a MinerU result and the source's page geometry."""
    if isinstance(middle.get("pages"), list):
        units = _units_v4(middle, pages)
    elif isinstance(middle.get("pdf_info"), list):
        units = _units_legacy(middle, pages)
    else:
        raise MinerUConversionError("Not a MinerU middle JSON: no `pages` or `pdf_info`.")

    _absorb_figure_labels(units)
    metadata = metadata.model_copy() if metadata is not None else DocumentMetadata()

    # Blocks, numbered per page in reading order.
    blocks_by_page: dict[int, list[TextBlockIR]] = {index: [] for index in range(len(pages))}
    bodies: dict[int, str] = {}
    for unit in units:
        page_blocks = blocks_by_page[unit.page_index]
        page_number = unit.page_index + 1
        unit.block_id = f"b_{document_id}_p{page_number}_{len(page_blocks) + 1:03d}"
        page_blocks.append(
            TextBlockIR(
                id=unit.block_id,
                page_index=unit.page_index,
                page_number=page_number,
                layout_class=_LAYOUT_BY_KIND[unit.kind],
                bbox=unit.bbox,
                text=unit.text,
                latex=unit.latex,
                html=unit.html,
                image_path=unit.image_path,
            )
        )
        if unit.is_body and unit.group is not None:
            bodies[unit.group] = unit.block_id

    block_index = {block.id: block for page_blocks in blocks_by_page.values() for block in page_blocks}
    for unit in units:
        if unit.group is not None and not unit.is_body and unit.group in bodies:
            block_index[unit.block_id].caption_of = bodies[unit.group]

    # Sections and paragraphs, in one reading-order pass.
    sections: list[SectionIR] = []
    heading_units: list[tuple[SectionIR, _Unit]] = []
    paragraphs: list[ParagraphIR] = []
    current_section: SectionIR | None = None
    last_paragraph: ParagraphIR | None = None
    refs_section: SectionIR | None = None

    def new_section(title: str, level: int | None, unit: _Unit | None) -> SectionIR:
        number = _HEADING_NUMBER.match(title)
        resolved = len(number.group(1).split(".")) if number else (level or 1)
        section = SectionIR(
            id=f"sec_{document_id}_{len(sections) + 1:03d}",
            title=title,
            level=resolved,
            page_range=((unit.page_index + 1) if unit else 1,) * 2,  # type: ignore[arg-type]
            heading_block_id=unit.block_id if unit else None,
            is_references=bool(_REFERENCES_HEADING.match(title)),
        )
        sections.append(section)
        if unit is not None:
            heading_units.append((section, unit))
        return section

    for unit in units:
        if unit.kind == "doc_title":
            if metadata.title is None and unit.text:
                metadata.title = unit.text
            last_paragraph = None
            continue
        if unit.kind == "heading":
            if not unit.text:
                continue
            current_section = new_section(unit.text, unit.level, unit)
            if current_section.is_references:
                refs_section = current_section
            last_paragraph = None
            continue
        if unit.kind not in ("text", "ref"):
            # Display formulas sit *inside* a paragraph's flow, and a figure or
            # table floats wherever the page had room — often between the two
            # halves of a paragraph broken by a column. Neither ends the
            # paragraph: text after one that MinerU marks as continuing still
            # joins the paragraph before it, and unmarked text starts a new one.
            continue
        if not unit.text:
            continue

        if unit.kind == "ref" and (current_section is None or not current_section.is_references):
            # MinerU typed these as bibliography entries; when the paper's own
            # heading was not detected they still must not be read as prose.
            if refs_section is None:
                refs_section = new_section("References", 1, None)
                refs_section.page_range = (unit.page_index + 1, unit.page_index + 1)
            current_section = refs_section

        if last_paragraph is not None and (unit.continues or _runs_on(last_paragraph, unit)):
            joiner = "" if (
                last_paragraph.text.endswith("-") and unit.text[:1].islower()
            ) else ("" if _CJK.match(last_paragraph.text[-1:] or "a") and _CJK.match(unit.text[:1]) else " ")
            base = last_paragraph.text[:-1] if joiner == "" and last_paragraph.text.endswith("-") else last_paragraph.text
            shift = len(base) + len(joiner)
            last_paragraph.runs.extend(
                InlineRun(start=start + shift, end=end + shift, styles=list(styles))
                for start, end, styles in unit.runs
            )
            last_paragraph.text = (base + joiner + unit.text).strip()
            last_paragraph.block_ids.append(unit.block_id)
            last_paragraph.bboxes.append(unit.bbox)
            first, _last = last_paragraph.page_range
            last_paragraph.page_range = (first, unit.page_index + 1)
            continue

        paragraph = ParagraphIR(
            id=f"p_{document_id}_{len(paragraphs) + 1:04d}",
            section_id=current_section.id if current_section else None,
            text=unit.text,
            page_number=unit.page_index + 1,
            page_range=(unit.page_index + 1, unit.page_index + 1),
            block_ids=[unit.block_id],
            bboxes=[unit.bbox],
            runs=[InlineRun(start=start, end=end, styles=list(styles)) for start, end, styles in unit.runs],
        )
        paragraphs.append(paragraph)
        last_paragraph = paragraph

    # Section page ranges: to the page before the next heading, or the end.
    page_count = len(pages)
    for index, section in enumerate(sections):
        start = section.page_range[0]
        if index + 1 < len(sections):
            end = max(start, sections[index + 1].page_range[0] - 1)
        else:
            end = page_count
        section.page_range = (start, max(start, end))
    _build_hierarchy(sections)

    # The abstract: under an "Abstract" heading, or — when the paper sets it as
    # a run-in lead ("Abstract—Training very deep …") — the paragraph itself.
    abstract_section = next((s for s in sections if _ABSTRACT_HEADING.match(s.title)), None)
    if abstract_section is not None:
        for paragraph in paragraphs:
            if paragraph.section_id == abstract_section.id:
                paragraph.is_abstract = True
    else:
        for paragraph in paragraphs[:8]:
            if _ABSTRACT_LEAD.match(paragraph.text):
                paragraph.is_abstract = True
                break

    for paragraph in paragraphs:
        paragraph.source_anchor_id = anchors.source_anchor_id_for(content_hash, paragraph)

    page_irs: list[PageIR] = []
    for index, geometry in enumerate(pages):
        page_blocks = blocks_by_page[index]
        for block in page_blocks:
            if block.layout_class in anchors.ANCHORABLE_CLASSES and (
                block.text.strip() or block.latex or block.html or block.image_path
            ):
                block.source_anchor_id = anchors.block_source_anchor_id_for(content_hash, block)
        page_irs.append(
            PageIR(
                page_index=index,
                page_number=index + 1,
                width_pt=geometry.width_pt,
                height_pt=geometry.height_pt,
                rotation=geometry.rotation,
                has_text=any(
                    block.text.strip() for block in page_blocks if block.layout_class != LAYOUT_ABANDON
                ),
                blocks=page_blocks,
            )
        )

    has_text = any(page.has_text for page in page_irs)
    return DocumentIR(
        document_id=document_id,
        content_hash=content_hash,
        pipeline_version=MINERU_PIPELINE_VERSION,
        source_filename=source_filename,
        page_count=page_count,
        metadata=metadata,
        sections=sections,
        pages=page_irs,
        paragraphs=paragraphs,
        page_mapping={p.id: p.page_number for p in paragraphs},
        # MinerU OCRs a scan, so text recovered from one is real text: the
        # document is readable even when the PDF had no text layer.
        has_text_layer=has_text,
        ocr_required=False,
    )
