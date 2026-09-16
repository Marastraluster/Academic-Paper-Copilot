"""Typed errors for the PDF kernel.

Upstream raises a wide assortment of exception types, and in at least one case
does not raise at all — it calls ``exit(1)``. Letting any of that reach a request
handler would mean the API layer had to know about the upstream library, which is
exactly what this package exists to prevent.

Every failure therefore leaves here as a :class:`PDFKernelError` with a stable
``code``.
"""

from __future__ import annotations


class PDFKernelError(Exception):
    """Base class for every failure raised by the PDF kernel."""

    code = "PDF_KERNEL_ERROR"

    def __init__(self, message: str, *, cause: BaseException | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.cause = cause

    def to_dict(self) -> dict:
        """Render as the backend's standard error envelope.

        Present so the HTTP layer can translate a kernel failure directly, without
        every route handler growing its own mapping (docs/API_CONTRACT.md §0).
        """
        return {"error": {"code": self.code, "message": self.message, "detail": {}}}


class PDFEngineUnsupportedError(PDFKernelError):
    """The requested translation engine is not one this adapter offers."""

    code = "ENGINE_UNSUPPORTED"


class PDFSourceNotFoundError(PDFKernelError):
    code = "SOURCE_NOT_FOUND"


class PDFSourceInvalidError(PDFKernelError):
    """The source is not a usable PDF file."""

    code = "SOURCE_INVALID"


class OutputFileExistsError(PDFKernelError):
    """An output file is already present and ``overwrite`` was not requested."""

    code = "OUTPUT_FILE_ALREADY_EXISTS"


class LayoutModelUnavailableError(PDFKernelError):
    """The layout-detection model is not in the local cache.

    Raised from a pre-flight check, *before* upstream is invoked. Upstream would
    otherwise attempt a ~72 MiB download; worse, if it cannot reach a download
    mirror it calls ``exit(1)``, terminating the process. A precise error beats
    both an unexplained hang and a silent exit.
    """

    code = "LAYOUT_MODEL_UNAVAILABLE"


class TranslationServiceError(PDFKernelError):
    """The upstream translation pipeline failed."""

    code = "TRANSLATION_SERVICE_ERROR"


class TranslationOutputMissingError(PDFKernelError):
    """Upstream reported success but did not produce the expected files."""

    code = "TRANSLATION_OUTPUT_MISSING"
