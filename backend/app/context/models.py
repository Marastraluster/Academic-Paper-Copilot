"""AI-derived analysis of a document — kept strictly apart from the source IR.

`DocumentIR` describes what the PDF physically contains. Everything in this
module describes **what a model made of it**, which is a different kind of claim:
it can be wrong, it can be regenerated, and it must never be mistaken for the
paper's own words.

Two consequences shape these models.

**Nothing here is written back into the IR.** Analysis is derived, replaceable
and rebuildable; the source structure is none of those things. A single field
added to `DocumentIR` "just for the summary" would couple layout extraction to
LLM semantics permanently.

**Language-independent understanding and target-language translation are
separate.** Domain, summaries, entities and acronyms are properties of the paper.
A glossary translation is a property of the paper *and* a target language. Merging
them would mean a glossary generated for Chinese invalidates understanding that
had nothing to do with Chinese.

Evidence is anchored by `paragraph_id`, never by quotation. A model asked to
quote a paper will paraphrase, normalise hyphens and drop commas; judging it on
exact string equality would reject honest output while still not preventing a
fabrication. A paragraph id either exists in the IR or it does not.
"""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, ConfigDict, Field

#: Bumped when the analysis *pipeline* changes in a way that alters results:
#: chunking rules, evidence validation, merge behaviour. Not for a prompt edit.
PIPELINE_VERSION = "1.0.0"


class AnalysisStatus(str, Enum):
    """How much of the document was successfully analysed.

    THE STATES THE IMPLEMENTATION ACTUALLY DISTINGUISHES. `QUEUED` and `RUNNING`
    are deliberately absent: analysis runs inside the request that asks for it,
    so there is no moment at which either could be truthfully reported. Adding
    them for a progress bar would be inventing a phase to display.
    """

    READY = "READY"
    PARTIAL = "PARTIAL"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


class AnalysisProvenance(BaseModel):
    """What produced this analysis, and from what.

    Exactly the fields needed to answer "is this analysis still valid?" without
    re-running anything. Note what is absent: no key, no credential reference, no
    filesystem path.
    """

    model_config = ConfigDict(extra="forbid")

    document_id: str
    #: sha256 of the source PDF. If the file changes, this analysis describes a
    #: document that no longer exists.
    content_hash: str
    pipeline_version: str
    #: Which *extraction* produced the paragraphs this analysis points at.
    #:
    #: `content_hash` sees the PDF and `pipeline_version` sees the analysis
    #: prompts; neither sees the IR. DS-DOC-002 made that a real gap: correcting
    #: reading order re-segments paragraphs, and paragraph ids are reading
    #: positions, so `GlossaryEntry.paragraph_ids` and its siblings come to name
    #: different paragraphs — an entity attributed to text that no longer
    #: mentions it. Defaulted so stored analyses parse; they then fail the check.
    ir_pipeline_version: str = "0"
    prompt_version: str
    #: Where the model was reached and which one was asked — the provider's
    #: identity. A profile's *display name* is recorded below for a human, and is
    #: deliberately not part of identity: it is free text the user may rename,
    #: and two profiles for different endpoints may share a name.
    provider_base_url: str
    provider_model: str
    provider_protocol: str
    #: For display only. Never used to decide validity.
    provider_profile_name: str | None = None
    target_language: str = "zh-CN"
    created_at: str


class DomainRecord(BaseModel):
    """An interpretation, and it says so.

    `confidence` is required rather than optional because the whole point of the
    record is to carry the model's own uncertainty alongside its answer.
    """

    model_config = ConfigDict(extra="forbid")

    primary: str
    secondary: list[str] = Field(default_factory=list)
    confidence: float = Field(ge=0.0, le=1.0)
    rationale: str = ""
    arxiv_category: str | None = None


class GlossaryEntry(BaseModel):
    """A term worth translating consistently, with evidence for the decision."""

    model_config = ConfigDict(extra="forbid")

    #: The canonical spelling **exactly as it appears in the source**. Never
    #: lowercased or case-folded: `LeVJEPA` and `ResNet-50` are identifiers, and
    #: normalising them destroys the thing that made them worth recording.
    source_term: str
    #: Proposed translation for the analysis's target language.
    suggested_translation: str | None = None
    #: A short gloss of what the term means *in this paper*, not a dictionary
    #: definition. May be absent.
    definition: str | None = None
    #: False for identifiers that must survive translation unchanged — model
    #: names, datasets, benchmarks, acronyms.
    is_translatable: bool = True
    category: str | None = None
    #: Paragraph ids where the term occurs. The evidence anchor.
    paragraph_ids: list[str] = Field(default_factory=list)
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)


class AcronymEntry(BaseModel):
    """An acronym and the expansion the paper itself supplies."""

    model_config = ConfigDict(extra="forbid")

    acronym: str
    #: None when the paper never spells it out. Guessing from parametric memory
    #: is exactly the failure this permits us to avoid.
    expansion: str | None = None
    paragraph_ids: list[str] = Field(default_factory=list)


class EntityEntry(BaseModel):
    """A named thing the paper refers to: a model, dataset, benchmark, metric."""

    model_config = ConfigDict(extra="forbid")

    name: str
    kind: str
    paragraph_ids: list[str] = Field(default_factory=list)


class SectionAnalysis(BaseModel):
    """A summary attached to a real section, or to a synthetic partition."""

    model_config = ConfigDict(extra="forbid")

    #: A `SectionIR.id`, or a synthetic id for unsectioned content.
    section_id: str
    title: str
    summary: str
    page_range: tuple[int, int]
    #: True when this covers paragraphs the IR could not place in a section.
    synthetic: bool = False


class AnalysisErrorRecord(BaseModel):
    """One unit of work that did not succeed, and why.

    Kept per unit so a single failure does not discard an otherwise complete
    analysis — the whole reason `PARTIAL` exists.
    """

    model_config = ConfigDict(extra="forbid")

    scope: str
    code: str
    message: str


class DocumentAnalysis(BaseModel):
    """Everything a model concluded about one document."""

    model_config = ConfigDict(extra="forbid")

    document_id: str
    provenance: AnalysisProvenance
    status: AnalysisStatus
    domain: DomainRecord | None = None
    summary: str | None = None
    sections: list[SectionAnalysis] = Field(default_factory=list)
    glossary: list[GlossaryEntry] = Field(default_factory=list)
    acronyms: list[AcronymEntry] = Field(default_factory=list)
    entities: list[EntityEntry] = Field(default_factory=list)
    errors: list[AnalysisErrorRecord] = Field(default_factory=list)

    def is_usable(self) -> bool:
        """Whether this analysis can serve as context for translation.

        A partial analysis is still worth having — most of the paper is
        understood — so it counts. A failed or cancelled one does not.
        """
        return self.status in (AnalysisStatus.READY, AnalysisStatus.PARTIAL)


class ContextGlossaryTerm(BaseModel):
    """One glossary entry as it appears in a context package."""

    model_config = ConfigDict(extra="forbid")

    source_term: str
    suggested_translation: str | None = None
    is_translatable: bool = True


class TranslationContext(BaseModel):
    """The bounded package handed to a translation call.

    **It deliberately has no field for the target paragraph's own text.** The
    caller already holds that paragraph — it is what it is trying to translate —
    and passing it in twice would spend the model's attention on a duplicate
    while looking like useful context.

    Everything here is *around* the target: what the paper is about, what its
    section is about, the terms that matter in this spot, and the sentences on
    either side.
    """

    model_config = ConfigDict(extra="forbid")

    paragraph_id: str
    page_number: int = Field(ge=1)
    section_id: str | None = None
    section_title: str | None = None
    section_summary: str | None = None
    document_summary: str | None = None
    academic_domain: str | None = None
    glossary: list[ContextGlossaryTerm] = Field(default_factory=list)
    previous_paragraph: str | None = None
    next_paragraph: str | None = None

    #: What was dropped to fit the budget, so a caller can tell a thin context
    #: from a context that was shed. Silent truncation would look like the
    #: analysis simply had nothing to say.
    shed: list[str] = Field(default_factory=list)
