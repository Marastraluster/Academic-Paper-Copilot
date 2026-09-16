"""PDF translation kernel — the adapter around the upstream PDF library.

**This is the only package in the backend permitted to import `pdf2zh`.** A test
enforces that, so the rest of the application can be reasoned about without
knowing anything about upstream's API, its threading, or its failure modes.

Importing this package is light: the heavy upstream modules (ONNX Runtime, OpenCV,
the layout model) are imported inside the worker function, not at module scope.

**One side effect cannot be avoided.** Importing upstream runs
``pdf2zh.cache.init_db()`` at import time, which creates and opens
``~/.cache/pdf2zh/cache.v1.db``. That is upstream's own behaviour, it happens on
first use rather than on import of this package, and suppressing it would mean
patching a library we deliberately do not modify (ADR-001). It is documented
rather than hidden. Note also that this cache is keyed on
``(engine, params, source_text)`` and **not** on the endpoint, so the same
paragraph translated through two different providers reuses whichever ran first
(docs/REPO_AUDIT.md §12) — the Context Engine phase supplies a context-aware key.

Nothing else in the backend may import upstream; a test enforces that.
"""

from app.pdfkernel.adapter import (
    SUPPORTED_ENGINES,
    ensure_layout_model,
    layout_model_path,
    translate_pdf,
)
from app.pdfkernel.errors import (
    LayoutModelUnavailableError,
    OutputFileExistsError,
    PDFEngineUnsupportedError,
    PDFKernelError,
    PDFSourceInvalidError,
    PDFSourceNotFoundError,
    TranslationOutputMissingError,
    TranslationServiceError,
)
from app.pdfkernel.models import TranslationResult

__all__ = [
    # Entry point
    "translate_pdf",
    "TranslationResult",
    "SUPPORTED_ENGINES",
    # Model lifecycle
    "ensure_layout_model",
    "layout_model_path",
    # Errors
    "PDFKernelError",
    "PDFEngineUnsupportedError",
    "PDFSourceNotFoundError",
    "PDFSourceInvalidError",
    "OutputFileExistsError",
    "LayoutModelUnavailableError",
    "TranslationServiceError",
    "TranslationOutputMissingError",
]
