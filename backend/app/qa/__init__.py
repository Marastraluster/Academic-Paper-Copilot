"""Paper QA — deterministic retrieval and citation grounding.

The foundation a later answer generator consumes. Its whole purpose is that
**citation identity comes from the index, never from a model**: every returned
page, section and paragraph id is read out of the canonical `DocumentIR`, so an
answer can cite `[E1]` and the application resolves it to a real page rather than
trusting a model to count pages correctly.

Retrieval needs only the `DocumentIR`. `DocumentAnalysis` is optional and may add
glossary and acronym expansions to a query — it never supplies evidence.

Public surface:

* :class:`~app.qa.models.EvidenceBundle` — what a caller receives.
* :func:`~app.qa.retrieval.retrieve` — run a scoped query.
"""

from app.qa.models import (
    Diagnostics,
    EvidenceBundle,
    EvidenceItem,
    ExpansionApplied,
    Scope,
)
from app.qa.retrieval import DEFAULT_TOP_K, RetrievalError, retrieve

__all__ = [
    "DEFAULT_TOP_K",
    "Diagnostics",
    "EvidenceBundle",
    "EvidenceItem",
    "ExpansionApplied",
    "RetrievalError",
    "Scope",
    "retrieve",
]
