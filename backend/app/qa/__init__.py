"""Paper QA — deterministic retrieval, grounded answering, and citations.

Two layers, and the separation between them is the point.

**Retrieval** (DS-QA-001) is lexical, local and deterministic. It decides *what
evidence is available*, and it is allowed to come back empty or without the
paragraph that answers the question. Its whole purpose is that **citation identity
comes from the index, never from a model**: every returned page, section and
paragraph id is read out of the canonical `DocumentIR`.

**Answering** (DS-QA-002) decides *what can be concluded from that evidence*. It
may return a grounded answer, a partial answer, or `insufficient_evidence` — and
that third outcome is a successful product result, not a failure. A paper whose
retrieval misses the answer must produce an abstention, not a confident answer
assembled from whatever ranking happened to return.

The application resolves `[E1]` markers to real pages and bounding boxes. The
model never produces a page number.

Public surface:

* :class:`~app.qa.models.EvidenceBundle` — what retrieval returns.
* :class:`~app.qa.models.AnswerResult` — what answering returns.
* :func:`~app.qa.retrieval.retrieve` — run a scoped query.
* :func:`~app.qa.answering.generate_answer` — answer from evidence, or decline.
"""

from app.qa.answering import AnswerError, generate_answer
from app.qa.models import (
    ANSWERED,
    INSUFFICIENT_EVIDENCE,
    PARTIAL,
    AnswerDiagnostics,
    AnswerResult,
    AnswerStatus,
    Diagnostics,
    EvidenceBundle,
    EvidenceItem,
    ExpansionApplied,
    ResolvedCitation,
    Scope,
)
from app.qa.retrieval import DEFAULT_TOP_K, RetrievalError, retrieve

__all__ = [
    "ANSWERED",
    "DEFAULT_TOP_K",
    "INSUFFICIENT_EVIDENCE",
    "PARTIAL",
    "AnswerDiagnostics",
    "AnswerError",
    "AnswerResult",
    "AnswerStatus",
    "Diagnostics",
    "EvidenceBundle",
    "EvidenceItem",
    "ExpansionApplied",
    "ResolvedCitation",
    "RetrievalError",
    "Scope",
    "generate_answer",
    "retrieve",
]
