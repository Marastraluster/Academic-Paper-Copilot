"""The document outline, built from the canonical `DocumentIR`.

This is a **view of the IR**, not a second structure: every field is read out of
`sections`, `paragraphs` and `pages`, and nothing here is stored. A separate
persisted outline would be a second answer to a question the IR has already
answered, and the two would drift.

The only thing the IR does not carry directly is the heading's geometry. It is
recovered through `SectionIR.heading_block_id`, which points at the `TextBlockIR`
the heading came from — so a heading's page and bbox have exactly one home and
cannot disagree with the block they describe.

## The navigation ladder

A node's location degrades rather than failing, and never invents coordinates
(brief Phase 13):

1. the **heading block's** page and bbox, when the heading resolved;
2. otherwise the section's **first paragraph** in canonical reading order;
3. otherwise the section's **start page**, with no box.

Step 3 is a real answer: `page_range[0]` is always present, so every node can be
navigated to. What degrades is the precision of the landing, and the `anchor`
field says which step produced it so a caller can decide whether to draw a box
rather than having to guess from a null.
"""

from __future__ import annotations

from app.document.models import DocumentIR, SectionIR, TextBlockIR

#: Which rung of the ladder a node's location came from.
ANCHOR_HEADING = "heading"
ANCHOR_PARAGRAPH = "paragraph"
ANCHOR_PAGE = "page"


def _block_index(ir: DocumentIR) -> dict[str, TextBlockIR]:
    return {block.id: block for page in ir.pages for block in page.blocks}


def _anchor(
    ir: DocumentIR, section: SectionIR, blocks: dict[str, TextBlockIR]
) -> tuple[str, int, list[float] | None]:
    """`(anchor, page_number, bbox)` for one section, by the ladder above."""
    heading = blocks.get(section.heading_block_id) if section.heading_block_id else None
    if heading is not None:
        return ANCHOR_HEADING, heading.page_number, [float(v) for v in heading.bbox]

    for paragraph in ir.paragraphs:
        if paragraph.section_id != section.id:
            continue
        if paragraph.bboxes:
            return (
                ANCHOR_PARAGRAPH,
                paragraph.page_number,
                [float(v) for v in paragraph.bboxes[0]],
            )
        return ANCHOR_PARAGRAPH, paragraph.page_number, None

    return ANCHOR_PAGE, section.page_range[0], None


def build_outline(ir: DocumentIR) -> list[dict]:
    """One row per section, in reading order, with its navigation anchor.

    Deliberately no paragraph text, no summaries and no analysis: this is
    navigation metadata, and the brief's Phase 52 is explicit that an outline must
    not carry the document to describe it.
    """
    blocks = _block_index(ir)
    rows: list[dict] = []
    for section in ir.sections:
        anchor, page_number, bbox = _anchor(ir, section, blocks)
        rows.append(
            {
                "id": section.id,
                "title": section.title,
                "level": section.level,
                "parent_id": section.parent_id,
                "page_number": page_number,
                "page_range": list(section.page_range),
                "bbox": bbox,
                "anchor": anchor,
                "is_references": section.is_references,
            }
        )
    return rows
