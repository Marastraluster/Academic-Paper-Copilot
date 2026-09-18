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
    token_estimate: int = 0
