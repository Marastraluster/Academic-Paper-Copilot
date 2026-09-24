"""One paper, read twice: every paragraph, and its translation beneath it.

This is the artifact behind 逐段对照 — the reading column where the source
paragraph stays in place and its Chinese follows it. It is **not** the translated
PDF: `mono.pdf` is a *laid-out* document, its text reflowed into the original
boxes, so the paragraph boundaries in it are the layout's and not the paper's.
Aligning those fragments back onto the IR produces pairs that are wrong in a way
that reads as checked, and the whole point of this artifact is that a pair is
evidence of itself: this paragraph, this translation, this page.

So the pairs are produced by translating the paragraphs, and this module is what
they are stored as.

## What is recorded, and what is not

The three version axes the reader overview already uses are here for the same
reasons — the schema (what a stored file means), the pipeline (what this code
produces) and the prompt (what was asked) — beside the source identity, the
extraction it points into, and the language. Everything else about the run is
*provenance*: the model, the endpoint, when it ran, what the provider said it
cost. A different model's artifact is still a true reading of a paper that has
not changed, and it is shown rather than silently regenerated.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

#: Distinguishes this artifact from the reader overview and from the translated
#: PDF wherever either is described. They are not interchangeable files.
BILINGUAL_ARTIFACT_KIND = "bilingual_reading"

#: The artifact's own shape. Bumped when a stored file stops meaning what it
#: meant — not when the generation changes (that is `pipeline_version`) and not
#: when the extraction does (that is `ir_pipeline_version`).
BILINGUAL_SCHEMA_VERSION = "1"

#: The generation pipeline's version: this module, the batching, the repair.
BILINGUAL_PIPELINE_VERSION = "1.0.0"

#: How the paragraphs are asked for. Bumped when the prompt changes materially.
BILINGUAL_PROMPT_VERSION = "1.0.0"

BilingualStatus = Literal["READY", "PARTIAL", "FAILED"]

#: A paragraph is translated, deliberately left alone, or failed. The second is
#: a real answer — a formula, a reference line, a title block — and the third is
#: what a batch that could not be repaired leaves behind. Neither is ever shown
#: as prose nobody wrote.
ParagraphStatus = Literal["translated", "skipped", "untranslated"]


@dataclass(frozen=True)
class BilingualSection:
    """A heading, in both languages."""

    section_id: str
    title: str
    title_translated: str
    level: int | None = None
    page_number: int = 1
    #: References are shown in the source and never sent to a model.
    is_references: bool = False


@dataclass(frozen=True)
class BilingualParagraph:
    """One paragraph, its translation, and where it came from.

    `source_text` is verbatim from the IR — the column shows the paper's own
    words, not a re-extraction of them — and `bboxes` are the source geometry, so
    a click can put the reader on the paragraph in the PDF.
    """

    paragraph_id: str
    page_number: int
    source_text: str
    translated_text: str = ""
    status: ParagraphStatus = "translated"
    section_id: str | None = None
    bboxes: tuple[tuple[float, float, float, float], ...] = ()
    #: Why this paragraph has no translation, when it has none.
    note: str = ""

    def is_readable(self) -> bool:
        """Is there a translation to show under this paragraph?"""
        return self.status == "translated" and self.translated_text.strip() != ""


@dataclass(frozen=True)
class BilingualBlock:
    """A non-prose unit the column shows in the source and never translates.

    Measured on this repository's ResNet IR: paragraphs are built **only** from
    `plain text` blocks, so a formula or a caption never reaches a paragraph and
    can never reach a prompt. It still belongs in the reading flow — a method
    section that says "as shown in Figure 1" without the caption is a hole — so
    it travels here, in its own list, source-only.

    Kept out of `paragraphs` on purpose: that list is *exactly* the IR's
    paragraphs (DS-DOC-006 AC-P0-06's equality), and mixing units into it would
    make the equality untestable and the two kinds indistinguishable.
    """

    block_id: str
    page_number: int
    layout_class: str
    text: str
    bbox: tuple[float, float, float, float] | None = None


@dataclass
class BilingualArtifact:
    """Everything the reading column renders, and where it came from."""

    content_hash: str
    target_language: str
    status: BilingualStatus = "FAILED"
    paragraphs: list[BilingualParagraph] = field(default_factory=list)
    sections: list[BilingualSection] = field(default_factory=list)
    #: Formulas and captions, source-only, in reading order.
    blocks: list[BilingualBlock] = field(default_factory=list)

    # --- provenance -----------------------------------------------------------
    #: Which extraction the paragraph ids point into. Part of the key: a
    #: re-extraction renumbers paragraphs, and this artifact names them.
    ir_pipeline_version: str = ""
    artifact_kind: str = BILINGUAL_ARTIFACT_KIND
    schema_version: str = BILINGUAL_SCHEMA_VERSION
    pipeline_version: str = BILINGUAL_PIPELINE_VERSION
    prompt_version: str = BILINGUAL_PROMPT_VERSION
    #: Recorded for the reader, not part of the key — see the module docstring.
    provider_model: str = ""
    provider_base_url: str = ""
    created_at: str = ""
    input_tokens: int | None = None
    output_tokens: int | None = None
    #: Why a PARTIAL or FAILED run is not complete. Never empty for those.
    notes: list[str] = field(default_factory=list)

    def translated_count(self) -> int:
        return sum(1 for paragraph in self.paragraphs if paragraph.is_readable())

    def translatable_count(self) -> int:
        """Paragraphs the column can show an original of, whether or not it has
        a translation — the denominator the reader sees."""
        return sum(1 for paragraph in self.paragraphs if paragraph.source_text.strip())

    def is_usable(self) -> bool:
        """READY and PARTIAL are worth showing; nothing else is a reading."""
        return self.status in ("READY", "PARTIAL") and bool(self.paragraphs)
