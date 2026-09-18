"""What retrieval returns, and the scopes it can be asked for.

Two rules shape these types.

**Citation identity comes from the index, never from a model.** Every item carries
the real `page_number`, `page_range`, `section_id` and `paragraph_id` that the
`DocumentIR` recorded. A later answer generator will cite `[E1]`; the application
resolves that to a page. Asking a model to count pages is how citations go wrong.

**`page_range` is exported alongside `page_number`.** A paragraph starting at the
foot of page 3 and finishing on page 4 cited only as page 3 sends the reader to a
page where the text is not visible.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

#: The four scopes. `selection` is an absolute constraint, not a boost.
ScopeType = Literal["whole_paper", "section", "page", "selection"]

#: A retrieved unit is either a prose paragraph or a caption. Captions are
#: first-class evidence — "what does Figure 3 show?" is a real question — but they
#: are tagged so a caller can tell them apart from prose.
ChunkKind = Literal["paragraph", "caption"]


class Scope(BaseModel):
    """Which part of the document a query may draw evidence from."""

    model_config = ConfigDict(extra="forbid")

    type: ScopeType
    #: Required for `page`, 1-based.
    page: int | None = Field(default=None, ge=1)
    #: Required for `section`.
    section_id: str | None = None
    #: Required for `selection` — the canonical paragraph ids the user selected.
    paragraph_ids: list[str] | None = None

    def describe(self) -> str:
        """A short label for logs. Never contains document text."""
        return self.type


class EvidenceItem(BaseModel):
    """One piece of source evidence, with its citation identity attached."""

    model_config = ConfigDict(extra="forbid")

    #: Local identifier the answer model will cite — `E1`, `E2`, … assigned by rank.
    id: str
    chunk_id: str
    kind: ChunkKind = "paragraph"
    paragraph_id: str
    section_id: str | None = None
    section_title: str | None = None
    page_number: int = Field(ge=1)
    page_range: list[int] = Field(default_factory=list)
    #: The blocks this text came from, so a reader could highlight it later.
    block_ids: list[str] = Field(default_factory=list)
    #: Verbatim from `DocumentIR`. Never rewritten, never paraphrased.
    text: str
    #: BM25 score, or `None` for a neighbour that was expanded in rather than ranked.
    score: float | None = None
    #: True when retrieval ranked this; False when it is surrounding context.
    is_direct_hit: bool = True
    is_caption: bool = False


class ExpansionApplied(BaseModel):
    """One query expansion, so a result can be explained rather than trusted."""

    model_config = ConfigDict(extra="forbid")

    term: str
    expanded_to: str
    source: str  # "glossary" | "acronym"


class Diagnostics(BaseModel):
    """Why a bundle looks the way it does. No document text."""

    model_config = ConfigDict(extra="forbid")

    code: str = "SUCCESS"
    execution_time_ms: float = 0.0
    total_candidates_scored: int = 0
    expansions: list[ExpansionApplied] = Field(default_factory=list)
    index_rebuilt: bool = False

    @property
    def explanation(self) -> str:  # pragma: no cover - convenience for callers
        return self.code


class EvidenceBundle(BaseModel):
    """Everything a later answer generator needs, and nothing it does not."""

    model_config = ConfigDict(extra="forbid")

    document_id: str
    query: str
    query_normalized: str
    scope: Scope
    items: list[EvidenceItem] = Field(default_factory=list)
    diagnostics: Diagnostics = Field(default_factory=Diagnostics)

    #: Rough token estimate for the whole bundle, so a caller can bound a prompt.
    #: `len(text) // 4` — convenient and **optimistic**, which is why the answer
    #: budget does not use it (see `app.qa.answering`). It is a published field of
    #: a frozen interface, so it stays as it is.
    token_estimate: int = 0


# --- answering (DS-QA-002) ----------------------------------------------------

#: The three answerability states. `PARTIAL` is deliberately not a flavour of
#: `ANSWERED`: a question with three facets where the evidence covers one is a
#: different product outcome from one that was answered, and collapsing it either
#: way loses something real — into `ANSWERED` it invites the model to invent the
#: missing facets, into `INSUFFICIENT_EVIDENCE` it discards a grounded answer.
ANSWERED = "answered"
PARTIAL = "partial"
INSUFFICIENT_EVIDENCE = "insufficient_evidence"

AnswerStatus = Literal["answered", "partial", "insufficient_evidence"]

#: `diagnostics.code` values this layer produces. Provider failures do not appear
#: here: they are raised as errors, because "the provider timed out" and "the
#: evidence does not answer this" are different outcomes and must not be
#: reported as the same one.
CODE_OK = "SUCCESS"
CODE_NO_EVIDENCE = "NO_EVIDENCE"
CODE_MALFORMED_OUTPUT = "MALFORMED_OUTPUT"
CODE_UNGROUNDED_OUTPUT = "UNGROUNDED_MODEL_OUTPUT"


class ResolvedCitation(BaseModel):
    """A citation the model asked for, resolved to a real place in the paper.

    Every field except `citation_id` and `snippet` is read from the `DocumentIR`
    by the application. The model names `E1`; it never sees or produces a page
    number, and it has no way to influence one.
    """

    model_config = ConfigDict(extra="forbid")

    #: The marker as it appeared in the answer: `E1`.
    citation_id: str
    paragraph_id: str
    section_id: str | None = None
    section_title: str | None = None
    #: 1-based, from the IR.
    page_number: int = Field(ge=1)
    page_range: list[int] = Field(default_factory=list)
    block_ids: list[str] = Field(default_factory=list)
    #: `[x0, y0, x1, y1]` per block, top-left origin — enough for DS-QA-003 to
    #: scroll to and highlight the source without walking the IR in the browser.
    bboxes: list[list[float]] = Field(default_factory=list)
    #: A verbatim prefix of the evidence text, cut at a sentence boundary. Never
    #: a model paraphrase: an excerpt that the model wrote would be a quotation
    #: the paper does not contain.
    snippet: str = ""
    is_caption: bool = False


class AnswerDiagnostics(BaseModel):
    """Why an answer looks the way it does. No paper prose, no question text."""

    model_config = ConfigDict(extra="forbid")

    code: str = CODE_OK
    execution_time_ms: float = 0.0
    #: Provider calls actually made — 0 on the deterministic fast path.
    requests_made: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    repair_attempted: bool = False
    #: Evidence rendered into the prompt after pruning, and what pruning removed.
    evidence_items: int = 0
    evidence_dropped: int = 0
    #: Markers the model emitted that named no evidence item in this bundle.
    dropped_citations: list[str] = Field(default_factory=list)
    #: Set when a page- or section-scoped question was answered with
    #: `insufficient_evidence` and the same question does retrieve evidence from
    #: the whole paper. The scope was honoured; the caller may want to say so.
    suggest_scope_expansion: bool = False


class AnswerResult(BaseModel):
    """A grounded answer, or an honest refusal to give one."""

    model_config = ConfigDict(extra="forbid")

    document_id: str
    question: str
    status: AnswerStatus
    #: Markdown with inline `[E1]` markers. Empty only when the status is
    #: `insufficient_evidence`.
    answer: str = ""
    #: Derived from the markers in `answer`, in first-appearance order and
    #: deduplicated — so the list and the text cannot disagree.
    citations: list[ResolvedCitation] = Field(default_factory=list)
    #: Required when `PARTIAL`: which parts of the question the evidence could not
    #: answer. Empty otherwise.
    unanswered_aspects: list[str] = Field(default_factory=list)
    #: Why the evidence was insufficient. The model's own words when it abstained
    #: itself; the application's when a grounding check forced the demotion.
    missing_evidence_rationale: str | None = None
    diagnostics: AnswerDiagnostics = Field(default_factory=AnswerDiagnostics)
