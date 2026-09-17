"""The only place in this backend that touches the upstream PDF library.

Everything above this package speaks :class:`TranslationResult` and
:class:`PDFKernelError`; nothing above it imports ``pdf2zh``.

Three behaviours here are deliberate and worth stating plainly:

1. **Pre-flight, then work.** The layout model is checked *before* upstream is
   invoked. Upstream would otherwise attempt a ~72 MiB download and, if it cannot
   reach a mirror, call ``exit(1)`` — which in a server process means the whole
   process dies.
2. **Outputs land atomically.** Upstream writes into a temporary directory beside
   the target; the finished files are then moved into place. A failed or
   interrupted translation therefore leaves no half-written PDF that a later run
   would mistake for a finished one.
3. **The source is opened read-only, always.** It is read for hashing and page
   counting, and handed to upstream as a path; it is never written to.
"""

from __future__ import annotations

import asyncio
import functools
import os
import shutil
import tempfile
import threading
import time
from collections.abc import Callable
from concurrent.futures import Executor
from pathlib import Path
from typing import Any

import fitz  # PyMuPDF — already a dependency, used for page counting and validation

from app.llm.errors import sanitize_message
from app.llm.models import ProviderConfig
from app.llm.client import KEYLESS_API_KEY_PLACEHOLDER
from app.pdfkernel.abort import TranslationAbortSentinel
from app.pdfkernel.errors import (
    LayoutModelUnavailableError,
    OutputFileExistsError,
    PDFEngineUnsupportedError,
    PDFSourceInvalidError,
    PDFSourceNotFoundError,
    TranslationOutputMissingError,
    TranslationServiceError,
)
from app.pdfkernel.models import TranslationResult

#: Only the in-process kernel is supported. ``precise`` needs a second repository
#: and an isolated venv (docs/REPO_AUDIT.md §22.4), and is unavailable here.
SUPPORTED_ENGINES = ("fast",)

#: Reports ``(pages_done, pages_total)``. Upstream emits this once per page; it
#: is the only progress signal the fast kernel produces, so it is the only one
#: callers are given.
ProgressCallback = Callable[[int, int], None]

DEFAULT_THREADS = 4

LAYOUT_MODEL_FILENAME = "doclayout_yolo_docstructbench_imgsz1024.onnx"
#: Anything smaller than this cannot be the real model, so a truncated download
#: is treated as absent rather than as a corrupt file discovered mid-translation.
_MIN_PLAUSIBLE_MODEL_BYTES = 1024 * 1024


def layout_model_path() -> Path:
    """Where the layout model would live. Does not download."""
    from babeldoc.assets.assets import get_cache_file_path

    return get_cache_file_path(LAYOUT_MODEL_FILENAME, "models")


def ensure_layout_model() -> Path:
    """Verify the layout model is cached locally, without attempting a download."""
    try:
        path = layout_model_path()
    except Exception as exc:  # noqa: BLE001 - any failure means "cannot use it"
        raise LayoutModelUnavailableError(
            "Could not determine the layout model location.", cause=exc
        ) from exc

    if not path.exists() or path.stat().st_size < _MIN_PLAUSIBLE_MODEL_BYTES:
        raise LayoutModelUnavailableError(
            f"The layout detection model is not cached at {path}. It is a ~72 MiB "
            "one-time download; run the application once with network access to "
            "fetch it. Translation cannot proceed without it."
        )
    return path


def _page_count(path: Path) -> int:
    try:
        with fitz.open(str(path)) as document:
            return document.page_count
    except Exception as exc:  # noqa: BLE001
        raise PDFSourceInvalidError(f"{path.name} could not be opened as a PDF.", cause=exc) from exc


_PATCH_LOCK = threading.Lock()
_UPSTREAM_PATCHED = False


def _ensure_upstream_patched() -> None:
    """Substitute our bounded translator into upstream's construction path.

    Upstream builds its translator by matching a service name against classes it
    imported, so substituting the class on ``pdf2zh.converter`` is the only way
    to supply our own without editing upstream — which ADR-001 forbids.

    Deferred until the first translation (so ``import app.pdfkernel`` stays free
    of the PDF stack) and idempotent under concurrency.
    """
    global _UPSTREAM_PATCHED
    if _UPSTREAM_PATCHED:
        return

    with _PATCH_LOCK:
        if _UPSTREAM_PATCHED:
            return
        import pdf2zh.converter as converter

        from app.pdfkernel.bounded_translator import BoundedOpenAIlikedTranslator

        converter.OpenAIlikedTranslator = BoundedOpenAIlikedTranslator
        _UPSTREAM_PATCHED = True


def _abort_message(sentinel: TranslationAbortSentinel, api_key: str) -> str:
    """A sanitised description of why the translation was aborted."""
    error = sentinel.error
    detail = getattr(error, "message", None) or (str(error) if error else "unknown error")
    code = getattr(error, "code", None)
    prefix = f"{code}: " if code else ""
    return sanitize_message(f"Translation aborted after a provider failure — {prefix}{detail}", api_key)


def _abort_detail(error: BaseException | None) -> dict:
    """Structured diagnostics for the error envelope.

    Deliberately narrow: a stable code and whether retrying could have helped.
    Provider response text is *not* included — it can echo request content.
    """
    if error is None:
        return {}
    return {
        "failed_phase": "paragraph_translation",
        "provider_error_code": getattr(error, "code", "UNKNOWN"),
        "retryable": bool(getattr(error, "retryable", False)),
    }


def _progress_bridge(
    on_progress: ProgressCallback | None,
) -> Callable[[Any], None] | None:
    """Adapt upstream's per-page tqdm callback to a plain ``(page, total)`` call.

    Upstream reports progress by handing a ``tqdm`` object to the callback, once
    per page. Callers should not have to know that. Returns ``None`` when there is
    no listener, so upstream does no work at all.
    """
    if on_progress is None:
        return None

    def report(progress: Any) -> None:
        try:
            on_progress(int(progress.n), int(progress.total))
        except Exception:  # noqa: BLE001 - progress must never fail a translation
            pass

    return report


def _upstream_envs(config: ProviderConfig) -> dict[str, str]:
    """Map a neutral provider configuration onto upstream's ``openailiked`` service.

    Passed per call. Upstream's ``ConfigManager`` is never used — it writes API
    keys to a plaintext config file (docs/REPO_AUDIT.md §16).
    """
    # Every key the service reads is supplied, not just the three we care about.
    #
    # Upstream reads `self.envs.get("OPENAILIKED_STOP_TOKENS", "")` and then
    # calls `.split()` on it — but `dict.get`'s default applies only when the key
    # is *absent*. A persisted value of `null` reaches `.split()` and raises
    # `'NoneType' object has no attribute 'split'`. Supplying explicit non-null
    # values means upstream's config file can never inject one, and also stops
    # our runs from depending on whatever it happens to have stored.
    api_key = config.api_key.get_secret_value()

    return {
        "OPENAILIKED_BASE_URL": config.base_url,
        "OPENAILIKED_API_KEY": api_key,
        "OPENAILIKED_MODEL": config.model,
        "OPENAILIKED_STOP_TOKENS": "",
        "OPENAILIKED_MAX_TOKENS": "-1",
        "OPENAILIKED_STREAM": "false",
        # The plain `openai` aliases are set as well, because upstream reads them
        # as a *fallback*: `api_key or self.envs["OPENAI_API_KEY"]`. A keyless
        # profile — a local server, a supported configuration — leaves the first
        # operand empty, so without these the fallback raises KeyError.
        "OPENAI_BASE_URL": config.base_url,
        "OPENAI_API_KEY": api_key or KEYLESS_API_KEY_PLACEHOLDER,
        "OPENAI_MODEL": config.model,
    }


def _run_upstream(
    source: Path,
    work_dir: Path,
    lang_in: str,
    lang_out: str,
    config: ProviderConfig,
    threads: int,
    ignore_cache: bool,
    on_progress: ProgressCallback | None = None,
    cancellation_event: asyncio.Event | None = None,
) -> None:
    """Invoke upstream synchronously. Called on a worker thread."""
    # Imported here, not at module scope, so that merely importing this package
    # does not drag in onnxruntime, OpenCV and the rest of the PDF stack.
    from pdf2zh.doclayout import ModelInstance, OnnxModel
    from pdf2zh.high_level import translate as upstream_translate

    _ensure_upstream_patched()

    if ModelInstance.value is None:
        ModelInstance.value = OnnxModel.load_available()

    api_key = config.api_key.get_secret_value()

    try:
        # Explicit keyword arguments only. Upstream's `translate_stream` forwards
        # `**locals()` internally, so a stray local variable in *this* function
        # could otherwise be picked up as an upstream parameter (REPO_AUDIT §9).
        upstream_translate(
            files=[str(source)],
            output=str(work_dir),
            lang_in=lang_in,
            lang_out=lang_out,
            service="openailiked",
            thread=threads,
            envs=_upstream_envs(config),
            model=ModelInstance.value,
            ignore_cache=ignore_cache,
            callback=_progress_bridge(on_progress),
            # Upstream polls this once per page, so cancellation takes effect at
            # a page boundary and never mid-page.
            cancellation_event=cancellation_event,
        )
    except TranslationAbortSentinel as exc:
        # Our bounded translator gave up: a provider failure, not an upstream bug.
        # This clause MUST precede `except BaseException` — the sentinel is one.
        raise TranslationServiceError(
            _abort_message(exc, api_key),
            cause=exc.error,
            detail=_abort_detail(exc.error),
        ) from exc
    except Exception as exc:
        raise TranslationServiceError(
            sanitize_message(f"Upstream translation failed: {exc}", api_key), cause=exc
        ) from exc
    except BaseException as exc:
        # Upstream calls `exit(1)` when it cannot reach a model mirror, which
        # raises SystemExit. Letting that escape would terminate the server.
        raise TranslationServiceError(
            sanitize_message(
                f"Upstream translation aborted ({type(exc).__name__})", api_key
            ),
            cause=exc,
        ) from exc

    # Defence in depth: if upstream ever stops re-raising BaseException, the
    # sentinel would be swallowed and the call would return normally with an
    # untranslated document. The translator still recorded the failure, so check
    # for it rather than trusting the absence of an exception.
    from app.pdfkernel.bounded_translator import current_translator

    translator = current_translator()
    if translator is not None and translator.terminal_error is not None:
        raise TranslationServiceError(
            translator.failure_message(), cause=translator.terminal_error
        )


async def translate_pdf(
    source_pdf: Path | str,
    output_dir: Path | str,
    target_lang: str,
    provider_config: ProviderConfig,
    *,
    source_lang: str = "en",
    engine: str = "fast",
    overwrite: bool = False,
    threads: int = DEFAULT_THREADS,
    ignore_cache: bool = False,
    executor: Executor | None = None,
    on_progress: ProgressCallback | None = None,
    cancellation_event: asyncio.Event | None = None,
) -> TranslationResult:
    """Translate a PDF, producing translated and bilingual copies.

    The source file is never modified. Runs off the event loop.

    ``ignore_cache`` forces fresh translations. Note that upstream's cache key is
    ``(engine, params, source_text)`` and **does not include the endpoint**
    (docs/REPO_AUDIT.md §12): the same paragraph translated through two different
    providers returns whichever ran first. Until the Context Engine supplies a
    context-aware cache key, treat the cache as shared across providers — which
    matters most when a user switches provider or rotates a key.
    """
    if engine not in SUPPORTED_ENGINES:
        raise PDFEngineUnsupportedError(
            f"Unsupported engine {engine!r}; this build supports {SUPPORTED_ENGINES}."
        )

    source = Path(source_pdf)
    output = Path(output_dir)

    # Cheap checks first, so an obviously bad input never reaches upstream or
    # costs a model load.
    if not source.is_file():
        raise PDFSourceNotFoundError(f"No such file: {source}")
    if source.suffix.lower() != ".pdf":
        raise PDFSourceInvalidError(f"{source.name} is not a .pdf file.")
    if source.stat().st_size == 0:
        raise PDFSourceInvalidError(f"{source.name} is empty.")

    mono = output / f"{source.stem}-mono.pdf"
    dual = output / f"{source.stem}-dual.pdf"

    # Checked before any expensive work, so a collision costs nothing.
    if not overwrite:
        for candidate in (mono, dual):
            if candidate.exists():
                raise OutputFileExistsError(
                    f"{candidate.name} already exists in {output}. Pass overwrite=True "
                    "to replace it."
                )

    # Before upstream: it would try to download, and may exit the process.
    ensure_layout_model()
    source_pages = _page_count(source)

    output.mkdir(parents=True, exist_ok=True)

    # Translate into a sibling directory so a failure leaves no partial output,
    # and so the final move is a same-volume atomic rename.
    work_dir = Path(tempfile.mkdtemp(dir=output, prefix=".pdfkernel-"))
    try:
        # Upstream *deletes* an input file that lives under the system temp
        # directory, assuming it must have created it itself:
        #
        #     if file_path.resolve().is_relative_to(temp_dir.resolve()):
        #         file_path.unlink(missing_ok=True)
        #
        # (Discovered by running the real pipeline; a source under the temp
        # directory vanished mid-test.) A user's PDF can legitimately live there,
        # and "the original is never modified" is this product's first promise.
        # Handing upstream a copy makes that guarantee structural rather than
        # dependent on where the user keeps their files.
        staged_source = work_dir / source.name
        shutil.copy2(source, staged_source)

        work = functools.partial(
            _run_upstream,
            staged_source,
            work_dir,
            source_lang,
            target_lang,
            provider_config,
            threads,
            ignore_cache,
            on_progress,
            cancellation_event,
        )
        started = time.perf_counter()
        if executor is not None:
            await asyncio.get_running_loop().run_in_executor(executor, work)
        else:
            await asyncio.to_thread(work)
        elapsed = time.perf_counter() - started

        produced_mono = work_dir / mono.name
        produced_dual = work_dir / dual.name
        for produced in (produced_mono, produced_dual):
            if not produced.is_file():
                raise TranslationOutputMissingError(
                    f"Translation reported success but produced no {produced.name}."
                )

        os.replace(produced_mono, mono)
        os.replace(produced_dual, dual)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)

    return TranslationResult(
        mono_path=mono,
        dual_path=dual,
        source_page_count=source_pages,
        mono_page_count=_page_count(mono),
        dual_page_count=_page_count(dual),
        duration_seconds=elapsed,
    )
