"""What a reader is shown about a paper, and what it was made from.

A dedicated artifact, not a view over `DocumentAnalysis`. The two answer
different questions — one orients a translation system choosing the right sense
of a term, the other orients a person deciding whether to read the paper — and
DS-QA-014 measured what happens when the first is shown as the second: summaries
of the bibliography, a card for "Unsectioned Content (Pages 1-1)", and sentences
like *"It is useful for preserving author names and affiliation spelling during
translation."*

## Every item carries its own evidence

Not one citation under a paragraph containing five claims. A long paragraph under
one reference cannot be audited, cannot be corrected, and cannot tell a reader
which sentence the paper actually supports. Each item is a short claim with the
canonical source units it came from, which is what makes the audit in
`docs/acceptance/DS-QA-015.md` a measurement rather than a reading.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

#: Distinguishes this artifact from `DocumentAnalysis` in the cache and wherever
#: either is described. They are not interchangeable files.
OVERVIEW_ARTIFACT_KIND = "reader_overview"

#: The artifact's own shape. Bumped when a stored file stops meaning what it
#: meant — separate from the prompt version, which changes when the *generation*
#: changes, and from the IR pipeline version, which changes what the evidence IDs
#: point at.
OVERVIEW_SCHEMA_VERSION = "1"

#: How the reader synthesis is asked. Bumped when the prompt changes materially;
#: a stored overview under an older version is not reused.
READER_OVERVIEW_PROMPT_VERSION = "1.0.0"

OverviewStatus = Literal["READY", "PARTIAL", "FAILED"]

#: The categories a reader sees, in the order they are shown.
CATEGORIES = (
    "research_question",
    "core_idea",
    "contributions",
    "method",
    "experiments",
    "findings",
    "limitations",
    "key_terms",
)


@dataclass(frozen=True)
class EvidenceRef:
    """One canonical source unit an item rests on.

    The id is a **runtime paragraph id** from the current extraction. It is not
    persisted as identity — the cache is keyed on `ir_pipeline_version`, so an
    overview whose ids no longer point at the same paragraphs is invalidated
    rather than silently mis-resolved. What is persisted for the long term is the
    page, which belongs to the immutable PDF.
    """

    paragraph_id: str
    page_number: int


@dataclass(frozen=True)
class OverviewItem:
    """One short, independently auditable claim."""

    category: str
    text: str
    evidence: tuple[EvidenceRef, ...] = ()
    #: True when the synthesis drew a conclusion the authors did not state in one
    #: sentence — an organisation of the paper's own material rather than a
    #: quotation of its claim. Shown to the reader as such.
    inferred: bool = False
    #: True when the evidence supports part of the claim rather than all of it.
    partial: bool = False


@dataclass(frozen=True)
class KeyTerm:
    """A term the reader needs, defined as *this paper* uses it."""

    term: str
    definition: str
    evidence: tuple[EvidenceRef, ...] = ()


@dataclass
class ReaderOverview:
    """Everything the Overview panel renders, and where it came from."""

    content_hash: str
    target_language: str
    status: OverviewStatus
    items: list[OverviewItem] = field(default_factory=list)
    key_terms: list[KeyTerm] = field(default_factory=list)

    # --- provenance -----------------------------------------------------------
    #: Which extraction the evidence ids point into. Part of the invalidation
    #: key, because a re-extraction renumbers paragraphs.
    ir_pipeline_version: str = ""
    artifact_kind: str = OVERVIEW_ARTIFACT_KIND
    schema_version: str = OVERVIEW_SCHEMA_VERSION
    prompt_version: str = READER_OVERVIEW_PROMPT_VERSION
    #: Recorded for the reader to see, **not** part of the invalidation key: a
    #: different model produces a different overview, but the one already made is
    #: still a true description of a paper that has not changed.
    provider_model: str = ""
    provider_base_url: str = ""
    created_at: str = ""
    #: Sections that were eligible and actually contributed, for the reader and
    #: for the audit. Empty is a real answer: a paper with no usable structure.
    source_sections: list[str] = field(default_factory=list)
    #: Why a PARTIAL or FAILED run is not complete. Never empty for those.
    notes: list[str] = field(default_factory=list)

    def items_in(self, category: str) -> list[OverviewItem]:
        return [item for item in self.items if item.category == category]

    def is_usable(self) -> bool:
        """READY and PARTIAL are worth showing; FAILED is not an overview."""
        return self.status in ("READY", "PARTIAL")
