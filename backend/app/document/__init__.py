"""Document Intelligence — the canonical structured view of a source PDF.

This package turns a PDF into the :class:`~app.document.models.DocumentIR` that
every later feature reads from, so that translation, Paper QA and citations all
answer "which page, which section, which paragraph" identically instead of each
building its own incompatible view.

Deliberately independent of translation. A user must be able to open a paper and
ask about it without ever translating it, so nothing here runs the kernel or
requires it to have run. The isolation test enforces the other direction too:
nothing here may import the upstream PDF library.

Public surface:

* :class:`~app.document.models.DocumentIR` and friends — the schema.
* :func:`~app.document.service.extract_and_store` — get an IR, extracting at most
  once per document.
* :func:`~app.document.service.load_ir` — read a cached IR without extracting.
"""

from app.document.extract import DocumentExtractionError
from app.document.models import (
    DocumentIR,
    DocumentMetadata,
    PageIR,
    ParagraphIR,
    SectionIR,
    TextBlockIR,
)
from app.document.service import ExtractionSummary, extract_and_store, load_ir

__all__ = [
    "DocumentExtractionError",
    "DocumentIR",
    "DocumentMetadata",
    "ExtractionSummary",
    "PageIR",
    "ParagraphIR",
    "SectionIR",
    "TextBlockIR",
    "extract_and_store",
    "load_ir",
]
