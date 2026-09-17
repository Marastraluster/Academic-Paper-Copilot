"""The canonical Document IR.

This is the single structured view of a source paper that every later feature
shares — context-aware translation, Paper QA, citations, glossary, summaries.
It describes **the source document only**. It deliberately has no place for
translated text, answers, or embeddings: those are derived from it, and mixing
them in would tie one representation to one consumer.

Two distinctions carry the design:

* **`page_index` (0-based) and `page_number` (1-based) are separate fields.**
  Citations are user-facing and 1-based; array access is 0-based. Naming both
  explicitly is the only defence against an off-by-one that silently cites the
  wrong page, so the bare word ``page`` is not used as a field name anywhere.

* **`TextBlock` is physical; `Paragraph` is semantic.** A layout box is a
  rectangle the vision model found. A paragraph is prose a reader would read as
  one unit, which may be split across boxes, columns and pages — or, equally
  often, be only part of one box. Treating a bounding box as a paragraph is the
  error this separation exists to prevent.

Nothing here is persisted to SQLite. The IR is a derived artifact, written
alongside ``mono.pdf`` and ``dual.pdf`` in the document's own directory, so it
is deleted with the document and needs no migration.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

#: ``[x0, y0, x1, y1]`` in PDF points, **top-left origin**, matching the
#: convention PyMuPDF uses for text rectangles.
BoundingBox = tuple[float, float, float, float]

#: Layout classes the DocLayout-YOLO model can emit. Kept as one place so a
#: caller never has to spell a label as a bare string.
LAYOUT_TITLE = "title"
LAYOUT_PLAIN_TEXT = "plain text"
LAYOUT_ABANDON = "abandon"
LAYOUT_FIGURE = "figure"
LAYOUT_FIGURE_CAPTION = "figure_caption"
LAYOUT_TABLE = "table"
LAYOUT_TABLE_CAPTION = "table_caption"
LAYOUT_TABLE_FOOTNOTE = "table_footnote"
LAYOUT_ISOLATE_FORMULA = "isolate_formula"
LAYOUT_FORMULA_CAPTION = "formula_caption"

#: Classes that are *not* prose. None of these may be merged into a paragraph:
#: figures and tables are not sentences, captions belong with their element, and
#: `abandon` is running header/footer noise that must not reach retrieval.
NON_PROSE_CLASSES = frozenset(
    {
        LAYOUT_ABANDON,
        LAYOUT_FIGURE,
        LAYOUT_FIGURE_CAPTION,
        LAYOUT_TABLE,
        LAYOUT_TABLE_CAPTION,
        LAYOUT_TABLE_FOOTNOTE,
        LAYOUT_ISOLATE_FORMULA,
        LAYOUT_FORMULA_CAPTION,
    }
)

#: Classes that continue a paragraph's prose.
PROSE_CLASSES = frozenset({LAYOUT_PLAIN_TEXT, LAYOUT_TITLE})


class DocumentMetadata(BaseModel):
    """What the PDF itself claims, with absence represented honestly.

    PDF metadata is frequently missing, and when present is frequently wrong —
    a title of "untitled" or a producer of "LaTeX2e" is a tool's name, not the
    paper's. Anything not established is ``None``; a guess is worse than a gap
    because a later feature cannot tell the difference.
    """

    model_config = ConfigDict(extra="forbid")

    title: str | None = None
    authors: list[str] | None = None
    subject: str | None = None
    keywords: list[str] | None = None
    creator: str | None = None
    producer: str | None = None
    creation_date: str | None = None


class TextBlockIR(BaseModel):
    """One physical layout region on one page.

    Retains even non-prose regions — ``abandon`` headers, figures, captions —
    so coordinates stay complete and a later feature can still ask what was
    there. Being *present in the IR* and *being part of a paragraph* are
    different things, and only the second is restricted.
    """

    model_config = ConfigDict(extra="forbid")

    id: str
    page_index: int = Field(ge=0)
    page_number: int = Field(ge=1)
    layout_class: str
    bbox: BoundingBox
    text: str

    #: Set on a caption, naming the figure/table block it belongs to.
    caption_of: str | None = None


class PageIR(BaseModel):
    model_config = ConfigDict(extra="forbid")

    page_index: int = Field(ge=0)
    page_number: int = Field(ge=1)
    width_pt: float
    height_pt: float
    rotation: int = 0
    #: False for a page with no extractable text — a scanned leaf, or a blank.
    has_text: bool = False
    blocks: list[TextBlockIR] = Field(default_factory=list)


class SectionIR(BaseModel):
    """A heading and the region it governs.

    ``level`` is ``None`` when the heading carries no numbering and no reliable
    typographic signal — an honest gap, never a fabricated hierarchy.
    """

    model_config = ConfigDict(extra="forbid")

    id: str
    title: str
    level: int | None = None
    page_range: tuple[int, int]
    parent_id: str | None = None
    is_references: bool = False


class ParagraphIR(BaseModel):
    """A semantic prose unit, assembled from one or more physical blocks."""

    model_config = ConfigDict(extra="forbid")

    id: str
    section_id: str | None = None
    text: str
    #: The page the paragraph *starts* on, 1-based.
    page_number: int = Field(ge=1)
    #: ``(first, last)`` page numbers this paragraph touches.
    page_range: tuple[int, int]
    #: Every physical block that contributed — the traceability back to source.
    block_ids: list[str] = Field(default_factory=list)
    bboxes: list[BoundingBox] = Field(default_factory=list)
    is_abstract: bool = False


class DocumentIR(BaseModel):
    """The whole document."""

    model_config = ConfigDict(extra="forbid")

    document_id: str
    #: sha256 of the source PDF. Ties the IR to the exact bytes it describes, so
    #: a replaced source is detectable rather than silently mismatched.
    content_hash: str
    source_filename: str
    page_count: int = Field(ge=0)
    metadata: DocumentMetadata = Field(default_factory=DocumentMetadata)
    sections: list[SectionIR] = Field(default_factory=list)
    pages: list[PageIR] = Field(default_factory=list)
    paragraphs: list[ParagraphIR] = Field(default_factory=list)
    #: ``paragraph_id`` → 1-based page number, for citation jumps.
    page_mapping: dict[str, int] = Field(default_factory=dict)
    #: False when no page yielded text: the document is likely a scan. OCR is
    #: *not* attempted here — recording the fact is the honest minimum.
    has_text_layer: bool = True
    ocr_required: bool = False

    def section_of(self, paragraph: ParagraphIR) -> SectionIR | None:
        if paragraph.section_id is None:
            return None
        for section in self.sections:
            if section.id == paragraph.section_id:
                return section
        return None
