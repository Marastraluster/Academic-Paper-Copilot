"""The bounded source a reader overview is allowed to be made from.

## Why the packet exists at all

The measured baseline sent *every section, unconditionally, one serial provider
call each, fed the accumulated prior summaries* — eleven calls and 26 minutes for
ResNet. It also summarised the **References**, because a bibliography is a section
with paragraphs, and produced a card for **"Unsectioned Content (Pages 1-1)"**,
because paragraphs with no `section_id` are grouped into synthetic partitions.
Those are not prompt defects. They are what happens when "the document" is handed
to a model without deciding what part of it is the paper.

So this decides, deterministically and without a model:

    which sections are the paper's substance
    which paragraphs inside them fit a bounded request
    what identifier each paragraph is called by

## Evidence ids belong to the backend

The provider is given `[E17] <text>` and answers with `E17`. It never sees a
paragraph id, a page number or a rectangle, and it cannot invent one — everything
a reader clicks resolves from the id the *backend* assigned. This is the same
asymmetry Paper QA uses, applied to a different corpus; the answering pipeline is
not reused.

## What is excluded, and how the decision is made

`SectionIR.is_references` is a property of the extraction, so the bibliography is
excluded by a fact rather than by matching the English word "References" here.
For the rest, headings are classified by a small role vocabulary; **anything
unrecognised is treated as substance**, because including a section the reader did
not need costs a paragraph of budget while dropping one hides the paper's method.
A paper whose headings are all unfamiliar therefore still yields an overview.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.document.models import DocumentIR, ParagraphIR, SectionIR

#: Roughly four characters to a token. The budget is on characters because that
#: is what can be counted here without a tokeniser; the frozen criterion bounds
#: the *prompt* at 8,000 tokens and this leaves room for the instructions.
DEFAULT_CHAR_BUDGET = 24_000

#: No single section may take more than this share of the packet. Without it a
#: paper whose method runs to thirty pages crowds out its own abstract.
SECTION_SHARE = 0.30

#: Headings that are *not* the paper's substance. Deliberately short and
#: role-shaped: a heading is matched when it *is* one of these things, never when
#: it merely contains a word that appears in one.
_ACKNOWLEDGEMENTS = re.compile(
    r"^(?:\d+[.)]\s*)?(?:acknowledge?ments?|funding|author contributions)\s*$", re.I
)
#: The bibliography by its other common name. `SectionIR.is_references` is the
#: primary signal — a fact the extraction establishes — and this catches a paper
#: whose heading the extractor did not classify.
_BIBLIOGRAPHY = re.compile(
    r"^(?:\d+[.)]\s*)?(?:bibliography|references|works cited|参考文献)\s*(?:[:：].*)?$", re.I
)
_APPENDIX = re.compile(r"^(?:appendix|supplementar|supplementary|附录)\b", re.I)
_FRONT_MATTER = re.compile(
    r"^(?:\d+[.)]\s*)?(?:contents|table of contents|list of (?:figures|tables)|"
    r"keywords?|index terms|abstract|摘要)\s*(?:[:：].*)?$",
    re.I,
)

#: A section is worth the reader's attention and the packet's budget.
_ROLE_SUBSTANTIVE = "substantive"
_ROLE_EXCLUDED = "excluded"

#: The abstract is its own role because it is the best evidence for the research
#: question and the core idea — the authors' own one-paragraph summary of both.
_ROLE_ABSTRACT = "abstract"


@dataclass(frozen=True)
class EvidenceUnit:
    """One paragraph the provider may cite, and the id it is called by."""

    id: str
    paragraph_id: str
    page_number: int
    section_title: str
    text: str


@dataclass(frozen=True)
class EvidencePacket:
    """The bounded source, and enough about it to say what was left out."""

    units: list[EvidenceUnit]
    #: Sections that contributed, in order.
    sections: list[str]
    #: Sections that were skipped and why, so a reader can be told rather than
    #: left wondering whether a paper has a method section at all.
    excluded: list[str]

    def id_index(self) -> dict[str, EvidenceUnit]:
        return {unit.id: unit for unit in self.units}

    def text_for_prompt(self) -> str:
        """The packet as the model sees it: an id, a page, and the words.

        The section title is included because it is the paper's own statement of
        what the passage is *for*, and it is what lets a contribution be
        attributed to the introduction rather than to the appendix.
        """
        lines: list[str] = []
        for unit in self.units:
            lines.append(f"[{unit.id}] ({unit.section_title}, p.{unit.page_number})")
            lines.append(unit.text)
            lines.append("")
        return "\n".join(lines).strip()

    def char_count(self) -> int:
        return sum(len(unit.text) for unit in self.units)


def classify_section(section: SectionIR) -> str:
    """What this heading is, in the reader's terms.

    A *role*, not a title. `Introduction`, `1. Introduction` and `I. INTRODUCTION`
    are one role; `Appendix A: Proofs` and `Supplementary Material` are another.
    """
    title = section.title.strip()
    if section.is_references:
        return _ROLE_EXCLUDED
    if _ACKNOWLEDGEMENTS.match(title) or _APPENDIX.match(title):
        return _ROLE_EXCLUDED
    if _BIBLIOGRAPHY.match(title):
        return _ROLE_EXCLUDED
    if _FRONT_MATTER.match(title):
        # The abstract is front matter a reader does need; a table of contents
        # is front matter nobody reads twice.
        return _ROLE_ABSTRACT if re.match(r"^(?:\d+[.)]\s*)?(?:abstract|摘要)", title, re.I) \
            else _ROLE_EXCLUDED
    return _ROLE_SUBSTANTIVE


def is_front_matter_paragraph(
    paragraph: ParagraphIR,
    index: int,
    abstract_pages: set[int],
    first_abstract_index: int | None,
) -> bool:
    """Is this unsectioned paragraph the paper's stationery?

    Public because it is not only this packet's rule: the paragraph-level reading
    column (DS-DOC-006) must not translate an author list either, and two
    definitions of "front matter" would drift apart at the first paper that
    sits differently on its first page.

    Measured: a real extraction produces with no `section_id` the arXiv stamp,
    the author list, the affiliations, and the abstract itself — all on page 1.
    Calling those "Unsectioned Content (Pages 1-1)" and summarising them as if
    they were the paper's substance is what DS-QA-014 recorded.

    The rule is positional and not textual: an unsectioned paragraph that sits on
    a page the abstract occupies **and before the abstract** is stationery.
    Everything else unsectioned is body — which matters, because a paper whose
    headings the extractor missed has *every* paragraph unsectioned, and a
    text-matching rule would then throw the whole paper away.
    """
    if paragraph.is_abstract:
        return True
    if not abstract_pages or first_abstract_index is None:
        return False
    # On a page the abstract occupies, and *before* it: the title block, the
    # author list, the affiliations, the arXiv stamp. A paragraph after the
    # abstract on the same page is body text that simply has no heading.
    return paragraph.page_number in abstract_pages and index < first_abstract_index


def build_evidence_packet(
    ir: DocumentIR,
    *,
    char_budget: int = DEFAULT_CHAR_BUDGET,
) -> EvidencePacket:
    """Select the bounded source an overview may be made from.

    Order is the document's own — sections in reading order, paragraphs within
    them — so the packet reads as the paper does and the ids ascend with it.
    """
    by_section: dict[str, list[ParagraphIR]] = {}
    unsectioned: list[ParagraphIR] = []
    for paragraph in ir.paragraphs:
        if paragraph.section_id:
            by_section.setdefault(paragraph.section_id, []).append(paragraph)
        else:
            unsectioned.append(paragraph)

    abstract_pages = {
        paragraph.page_number for paragraph in ir.paragraphs if paragraph.is_abstract
    }
    first_abstract = next(
        (index for index, p in enumerate(ir.paragraphs) if p.is_abstract), None
    )

    # --- assemble the eligible paragraphs, in document order ------------------
    selected: list[tuple[str, ParagraphIR]] = []
    excluded: list[str] = []
    contributing: list[str] = []

    for section in ir.sections:
        role = classify_section(section)
        if role == _ROLE_EXCLUDED:
            excluded.append(section.title)
            continue
        paragraphs = by_section.get(section.id, [])
        if not paragraphs:
            continue
        # The abstract is included first and in full: it is the authors' own
        # summary and the strongest evidence a question or an idea can rest on.
        contributing.append(section.title)
        for paragraph in paragraphs:
            selected.append((section.title, paragraph))

    unsectioned_title = "Body"
    positions = {id(paragraph): index for index, paragraph in enumerate(ir.paragraphs)}
    for paragraph in unsectioned:
        if is_front_matter_paragraph(
            paragraph, positions.get(id(paragraph), 0), abstract_pages, first_abstract
        ):
            continue
        if unsectioned_title not in contributing:
            contributing.append(unsectioned_title)
        selected.append((unsectioned_title, paragraph))

    # --- bound it -------------------------------------------------------------
    # Per-section shares first, so a long method cannot crowd out the abstract,
    # then the global budget. Both are applied in document order, which keeps the
    # selection deterministic and the ids ascending with the paper.
    per_section_cap = max(int(char_budget * SECTION_SHARE), 1_000)
    spent_by_section: dict[str, int] = {}
    units: list[EvidenceUnit] = []
    total = 0
    for title, paragraph in selected:
        text = paragraph.text.strip()
        if not text:
            continue
        used = spent_by_section.get(title, 0)
        if used + len(text) > per_section_cap:
            continue
        if total + len(text) > char_budget:
            continue
        spent_by_section[title] = used + len(text)
        total += len(text)
        units.append(EvidenceUnit(
            id=f"E{len(units) + 1}",
            paragraph_id=paragraph.id,
            page_number=paragraph.page_number,
            section_title=title,
            text=text,
        ))

    return EvidencePacket(
        units=units,
        sections=[title for title in contributing if title in spent_by_section],
        excluded=excluded,
    )
