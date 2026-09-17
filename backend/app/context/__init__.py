"""AI-derived understanding of a document, built on the canonical IR.

The boundary this package maintains, and the reason it is a package rather than
a few functions on `DocumentIR`:

```
DocumentIR         what the PDF physically contains — source truth, immutable
DocumentAnalysis   what a model made of it — derived, replaceable, rebuildable
```

Nothing here writes into the IR. Nothing here opens the PDF. A document's source
structure is extracted once, from the file, and read by everyone afterwards.

Public surface:

* :class:`~app.context.models.DocumentAnalysis` and friends — the schema.
* :func:`~app.context.service.get_or_create_analysis` — analyse, or reuse.
* :class:`~app.context.context_builder.ContextBuilder` — the bounded context
  package a future translation call will receive.
"""

from app.context.context_builder import ContextBuilder
from app.context.models import (
    AcronymEntry,
    AnalysisProvenance,
    AnalysisStatus,
    DocumentAnalysis,
    DomainRecord,
    EntityEntry,
    GlossaryEntry,
    SectionAnalysis,
    TranslationContext,
)
from app.context.service import (
    AnalysisUnavailableError,
    ProviderIdentity,
    get_or_create_analysis,
)

__all__ = [
    "AcronymEntry",
    "AnalysisProvenance",
    "AnalysisStatus",
    "AnalysisUnavailableError",
    "ContextBuilder",
    "DocumentAnalysis",
    "DomainRecord",
    "EntityEntry",
    "GlossaryEntry",
    "ProviderIdentity",
    "SectionAnalysis",
    "TranslationContext",
    "get_or_create_analysis",
]
