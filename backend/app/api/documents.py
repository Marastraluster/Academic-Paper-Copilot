"""Document and translation HTTP surface (docs/API_CONTRACT.md §2, §5).

Three properties are load-bearing here:

* **The user's file is never touched.** An upload is copied into a managed
  directory; a path import is only ever read. Deleting a document removes our
  copy and derived artifacts, never a file the user owns.
* **Starting a translation returns immediately.** The kernel takes minutes, so
  the request that starts it cannot be the one that waits for it.
* **Progress and status are honest.** Only states the kernel distinguishes are
  reported, and block counts are omitted rather than fabricated.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import fitz
from fastapi import APIRouter, File, Request, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from app.api.profiles import get_profile_store
from app.documents.store import (
    DocumentBusyError,
    DocumentNotFoundError,
    DocumentStore,
    TaskAlreadyTerminalError,
    TaskNotFoundError,
)
from app.documents.tasks import TaskRunner
from app.errors import error_response

router = APIRouter(tags=["documents"])

PDF_MAGIC = b"%PDF-"
SSE_KEEPALIVE_SECONDS = 15.0


# --- dependencies ------------------------------------------------------------


def get_document_store(request: Request) -> DocumentStore:
    store = getattr(request.app.state, "document_store", None)
    if store is None:
        raise RuntimeError("DocumentStore is not initialized; the lifespan did not execute.")
    return store


def get_task_runner(request: Request) -> TaskRunner:
    runner = getattr(request.app.state, "task_runner", None)
    if runner is None:
        raise RuntimeError("TaskRunner is not initialized; the lifespan did not execute.")
    return runner


# --- models ------------------------------------------------------------------


class DocumentResponse(BaseModel):
    """A document as returned to a client. Never carries a filesystem path."""

    document_id: str
    name: str
    page_count: int
    source: str  # "upload" | "path"
    has_translation: bool
    created_at: str


class ImportByPathRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str


class TranslateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    profile_id: str
    lang_in: str = "en"
    lang_out: str = "zh"
    engine: str = "fast"
    #: "off" translates each unit on its own, exactly as before. "standard"
    #: supplies bounded academic context. There is no "deep": in a pipeline that
    #: translates units independently and in parallel there is nothing for it to
    #: mean beyond spending more tokens.
    context_mode: str = "off"


class TaskResponse(BaseModel):
    task_id: str
    document_id: str
    status: str
    lang_in: str
    lang_out: str
    engine: str
    progress: dict[str, int] | None
    error: dict[str, str] | None
    created_at: str
    updated_at: str


def task_payload(task: Any) -> dict[str, Any]:
    """Render a task without inventing anything it does not have."""
    progress = None
    if task.progress_page is not None and task.progress_page_count is not None:
        # Per-page only. Block counters are deliberately absent: the kernel does
        # not produce them, and a fabricated 0/0 would be worse than nothing.
        progress = {"page": task.progress_page, "page_count": task.progress_page_count}

    error = None
    if task.error_code:
        error = {"code": task.error_code, "message": task.error_message or ""}

    return {
        "task_id": task.id,
        "document_id": task.document_id,
        "status": task.status,
        "lang_in": task.lang_in,
        "lang_out": task.lang_out,
        "engine": task.engine,
        "progress": progress,
        "error": error,
        "created_at": task.created_at,
        "updated_at": task.updated_at,
    }


def document_payload(
    store: DocumentStore,
    record: Any,
    *,
    tasks: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """One row of the library, and what is honestly known about its translation.

    `translation_record` reports the **last successful translation** — its
    language pair, its engine and when it ran — because that is what is in the
    database (`translation_tasks`) and nothing else is. The model that produced
    the artifact is deliberately *not* reported: a profile can be edited or
    deleted afterwards, and a row claiming the model a profile uses today would
    be describing a run that may have used a different one. Tokens and latency
    are not recorded anywhere and are therefore not shown; see DS-DOC-005 §2.5.

    `tasks` lets a caller rendering many rows hand in one lookup
    (`latest_succeeded_tasks`); a caller rendering one row may omit it.
    """
    task = (tasks.get(record.id) if tasks is not None
            else store.latest_succeeded_tasks().get(record.id))
    translation_record = None
    if task is not None:
        translation_record = {
            "lang_in": task.lang_in,
            "lang_out": task.lang_out,
            "engine": task.engine,
            "translated_at": task.updated_at,
            "profile_id": task.profile_id,
        }
    return {
        "document_id": record.id,
        "name": record.name,
        "page_count": record.page_count,
        "source": "upload" if record.is_upload else "path",
        "has_translation": store.mono_file(record.id).is_file(),
        "created_at": record.created_at,
        "translation_record": translation_record,
    }


# --- error handlers ----------------------------------------------------------


def register_document_error_handlers(app: Any) -> None:
    from app.errors import error_response as _envelope

    @app.exception_handler(DocumentNotFoundError)
    async def _missing(request: Request, exc: DocumentNotFoundError) -> Any:
        return _envelope(404, "NOT_FOUND", str(exc))

    @app.exception_handler(TaskNotFoundError)
    async def _missing_task(request: Request, exc: TaskNotFoundError) -> Any:
        return _envelope(404, "NOT_FOUND", str(exc))

    @app.exception_handler(DocumentBusyError)
    async def _busy(request: Request, exc: DocumentBusyError) -> Any:
        return _envelope(409, "DOCUMENT_BUSY", str(exc))

    @app.exception_handler(TaskAlreadyTerminalError)
    async def _terminal(request: Request, exc: TaskAlreadyTerminalError) -> Any:
        return _envelope(409, "TASK_ALREADY_TERMINAL", str(exc))


# --- import ------------------------------------------------------------------


def _validate_pdf_bytes(data: bytes) -> tuple[bool, str, str]:
    """Return ``(ok, code, message)`` for an upload, without writing it."""
    if len(data) == 0:
        return False, "EMPTY_FILE", "The uploaded file is empty."
    if not data.startswith(PDF_MAGIC):
        return False, "UNSUPPORTED_MEDIA_TYPE", "The uploaded file is not a PDF."
    try:
        with fitz.open(stream=data, filetype="pdf") as document:
            page_count = document.page_count
    except Exception:  # noqa: BLE001
        return False, "SOURCE_INVALID", "The PDF could not be read."
    if page_count < 1:
        return False, "SOURCE_INVALID", "The PDF contains no pages."
    return True, "", str(page_count)


@router.post("/documents", status_code=201)
async def import_document(
    request: Request,
    file: UploadFile | None = File(default=None),
) -> Any:
    """Import a PDF.

    Multipart upload is the browser's path — it holds a `File`, never a
    filesystem path. The JSON `{path}` form imports a file in place, for local
    callers, and never copies or modifies it.
    """
    store = get_document_store(request)
    settings = request.app.state.settings

    if file is not None:
        data = await file.read()
        if len(data) > settings.max_upload_bytes:
            return error_response(
                413,
                "PAYLOAD_TOO_LARGE",
                f"The file exceeds the {settings.max_upload_bytes // (1024 * 1024)} MiB limit.",
            )
        ok, code, detail = _validate_pdf_bytes(data)
        if not ok:
            status = {"EMPTY_FILE": 400, "UNSUPPORTED_MEDIA_TYPE": 415}.get(code, 422)
            return error_response(status, code, detail)

        name = Path(file.filename or "document.pdf").name  # strip any directory part
        record = store.create_document(
            name=name, page_count=int(detail), is_upload=True
        )
        store.source_file(record.id).write_bytes(data)
        return document_payload(store, record)

    # --- path import ------------------------------------------------------
    body = await request.json()
    try:
        payload = ImportByPathRequest.model_validate(body)
    except Exception:
        return error_response(400, "BAD_REQUEST", "Provide either a file upload or a path.")

    source = Path(payload.path)
    if not source.is_file():
        return error_response(404, "NOT_FOUND", "No file exists at the given path.")

    try:
        with fitz.open(str(source)) as document:
            page_count = document.page_count
    except Exception:  # noqa: BLE001
        return error_response(422, "SOURCE_INVALID", "The file could not be read as a PDF.")

    record = store.create_document(
        name=source.name, page_count=page_count, is_upload=False, source_path=source
    )
    return document_payload(store, record)


@router.get("/documents")
async def list_documents(request: Request) -> list[dict[str, Any]]:
    store = get_document_store(request)
    # One lookup for the whole list, not one per row.
    tasks = store.latest_succeeded_tasks()
    return [document_payload(store, record, tasks=tasks) for record in store.list_documents()]


@router.get("/documents/{document_id}")
async def get_document(request: Request, document_id: str) -> dict[str, Any]:
    store = get_document_store(request)
    return document_payload(store, store.get_document(document_id))


@router.get("/documents/{document_id}/file")
async def original_file(request: Request, document_id: str) -> Any:
    """Stream the original, read-only. The user's copy is never modified."""
    store = get_document_store(request)
    record = store.get_document(document_id)

    path = store.source_file(record.id) if record.is_upload else record.source_path
    if path is None or not Path(path).is_file():
        return error_response(404, "NOT_FOUND", "The source file is no longer available.")
    return FileResponse(path, media_type="application/pdf", filename=record.name)


@router.get("/documents/{document_id}/translated")
async def translated_file(request: Request, document_id: str) -> Any:
    """Translated (mono) output — one page per source page."""
    store = get_document_store(request)
    store.get_document(document_id)
    path = store.mono_file(document_id)
    if not path.is_file():
        return error_response(404, "NOT_FOUND", "No translation exists for this document yet.")
    return FileResponse(path, media_type="application/pdf", filename="translated.pdf")


@router.get("/documents/{document_id}/bilingual")
async def bilingual_file(request: Request, document_id: str) -> Any:
    """Interleaved (dual) output — 2N pages, for export."""
    store = get_document_store(request)
    store.get_document(document_id)
    path = store.dual_file(document_id)
    if not path.is_file():
        return error_response(404, "NOT_FOUND", "No bilingual output exists yet.")
    return FileResponse(path, media_type="application/pdf", filename="bilingual.pdf")


@router.delete("/documents/{document_id}", status_code=204)
async def delete_document(request: Request, document_id: str) -> Response:
    """Remove the document and its derived artifacts.

    A file the user imported by path is left exactly where it was.
    """
    store = get_document_store(request)
    store.delete_document(document_id)
    return Response(status_code=204)


# --- document intelligence ---------------------------------------------------


#: Extraction failure codes mapped onto HTTP. A corrupt or encrypted source is
#: the client's input being unusable rather than the server failing, so both are
#: 4xx; a source that vanished is a 404; a source that changed underneath us is
#: the server's own problem and says so.
_EXTRACTION_STATUS = {
    "SOURCE_INVALID": 422,
    "PDF_ENCRYPTED": 422,
    "SOURCE_NOT_FOUND": 404,
    "SOURCE_MODIFIED": 500,
}


def _resolve_source(store: DocumentStore, record: Any) -> Path | None:
    """The file to read. Never returned to a client."""
    path = store.source_file(record.id) if record.is_upload else record.source_path
    if path is None or not Path(path).is_file():
        return None
    return Path(path)


async def _require_ir(request: Request, document_id: str, *, force: bool = False):
    """Produce the IR for a document, or raise the normalized envelope.

    Extraction renders every page and runs a vision model, so it goes to a
    worker thread — a synchronous ONNX run on the event loop would freeze every
    other request for the duration, including the health check.
    """
    from app.document import DocumentExtractionError
    from app.document.service import extract_and_store

    store = get_document_store(request)
    record = store.get_document(document_id)
    source = _resolve_source(store, record)
    if source is None:
        return None, error_response(
            404, "NOT_FOUND", "The source file is no longer available."
        )

    try:
        ir, summary = await asyncio.to_thread(
            extract_and_store,
            store.document_dir(record.id),
            source,
            record.id,
            force=force,
        )
    except DocumentExtractionError as exc:
        return None, error_response(
            _EXTRACTION_STATUS.get(exc.code, 500), exc.code, exc.message
        )

    return (ir, summary), None


@router.get("/documents/{document_id}/ir")
async def document_ir(request: Request, document_id: str) -> Any:
    """The canonical Document IR.

    Extracts on first read. There is no separate "not extracted yet" state for a
    client to handle: the IR is a property of the document, and the first reader
    paying for it is simpler than making every client orchestrate extraction.
    """
    result, failure = await _require_ir(request, document_id)
    if failure is not None:
        return failure
    ir, _summary = result
    return json.loads(ir.model_dump_json())


@router.get("/documents/{document_id}/sections")
async def document_sections(request: Request, document_id: str) -> Any:
    """The outline, for a table of contents. Empty when nothing was identified.

    Carries navigation metadata only — no paragraph text, no summaries. `bbox` is
    the heading's box in PDF points, or `null` when the ladder in
    `app.document.outline` had to fall back; `anchor` says which rung produced it.
    """
    from app.document.outline import build_outline

    result, failure = await _require_ir(request, document_id)
    if failure is not None:
        return failure
    ir, _summary = result
    return build_outline(ir)


@router.get("/documents/{document_id}/page-mapping")
async def document_page_mapping(request: Request, document_id: str) -> Any:
    """``paragraph_id`` → 1-based page number, for citation jumps."""
    result, failure = await _require_ir(request, document_id)
    if failure is not None:
        return failure
    ir, _summary = result
    return {"document_id": ir.document_id, "page_mapping": ir.page_mapping}


@router.post("/documents/{document_id}/extract-ir")
async def extract_document_ir_route(request: Request, document_id: str) -> Any:
    """Extract explicitly, optionally re-running an existing IR.

    ``{"force": true}`` re-extracts. Without it this is a no-op returning the
    cached summary, which is what makes it safe for a caller to invoke without
    knowing whether extraction has happened.
    """
    body = {}
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 - an empty body means "no options"
        body = {}

    force = bool(body.get("force", False)) if isinstance(body, dict) else False

    result, failure = await _require_ir(request, document_id, force=force)
    if failure is not None:
        return failure
    ir, summary = result
    return {
        "document_id": ir.document_id,
        "page_count": summary.page_count,
        "paragraph_count": summary.paragraph_count,
        "section_count": summary.section_count,
        "duration_seconds": round(summary.duration_seconds, 3),
        "reused": summary.reused,
        "has_text_layer": ir.has_text_layer,
        "ocr_required": ir.ocr_required,
    }


# --- academic context (AI-derived) -------------------------------------------


class AnalysisRequest(BaseModel):
    """Start an analysis.

    ``profile_id`` is the only credential reference, exactly as for translation.
    """

    model_config = ConfigDict(extra="forbid")

    profile_id: str
    target_language: str = "zh-CN"
    force: bool = False


def _analysis_payload(analysis: Any) -> dict[str, Any]:
    payload = json.loads(analysis.model_dump_json())
    # `provider_profile_name` is for a human reading the record; it is not part of
    # identity and carries nothing sensitive. Everything else in provenance is a
    # hash, a version or an endpoint.
    return payload


@router.post("/documents/{document_id}/analysis")
async def create_analysis(
    request: Request, document_id: str, payload: AnalysisRequest
) -> Any:
    """Analyse a document, or return the existing analysis if it is still valid.

    Runs off the event loop only where it must: the provider calls are async, but
    the IR read is not. A long paper means several sequential provider calls, so
    this can take a while — and it says so by being a POST the client waits on,
    rather than pretending a background task exists.
    """
    from app.context import AnalysisUnavailableError, ProviderIdentity, get_or_create_analysis
    from app.llm.errors import LLMError, sanitize_message
    from app.llm.detection import resolve_provider

    profiles = get_profile_store(request)
    store = get_document_store(request)
    record = store.get_document(document_id)

    # The analysis is built on the IR, and the IR is built on the file. Reusing
    # the same lazy extraction here means analysis costs no extra parsing and
    # cannot disagree with the structure everything else sees.
    result, failure = await _require_ir(request, document_id)
    if failure is not None:
        return failure
    ir, _summary = result

    try:
        profile = profiles.get_profile(payload.profile_id)
        config = profiles.to_provider_config(payload.profile_id)
    except Exception:  # noqa: BLE001 - unknown profile, or the credential store is down
        return error_response(404, "NOT_FOUND", "No such provider profile.")

    identity = ProviderIdentity(
        base_url=profile.base_url,
        model=profile.model,
        protocol=profile.protocol,
        profile_name=profile.name,
    )

    try:
        provider = await resolve_provider(config, profile.protocol)
        analysis, reused = await get_or_create_analysis(
            store.document_dir(record.id),
            ir,
            provider=provider,
            identity=identity,
            target_language=payload.target_language,
            force=payload.force,
        )
    except AnalysisUnavailableError as exc:
        return error_response(502, exc.code, sanitize_message(exc.message))
    except LLMError as exc:
        return error_response(
            502, getattr(exc, "code", "PROVIDER_ERROR"), sanitize_message(exc.message)
        )

    body = _analysis_payload(analysis)
    body["reused"] = reused
    return body


@router.get("/documents/{document_id}/analysis")
async def get_analysis(request: Request, document_id: str) -> Any:
    """Return a stored analysis. Never generates one.

    A GET that silently spends several minutes and someone's API quota would be a
    surprise; asking for the analysis and getting a 404 that says none exists is
    the honest answer, and the client decides what to do about it.
    """
    from app.context.persistence import read_analysis

    store = get_document_store(request)
    record = store.get_document(document_id)

    analysis = read_analysis(store.document_dir(record.id))
    if analysis is None:
        return error_response(
            404,
            "ANALYSIS_NOT_FOUND",
            "This document has not been analysed yet.",
        )
    return _analysis_payload(analysis)


@router.delete("/documents/{document_id}/analysis", status_code=204)
async def delete_document_analysis(request: Request, document_id: str) -> Response:
    """Discard the analysis. Source, IR and translation artifacts are untouched."""
    from app.context.persistence import delete_analysis

    store = get_document_store(request)
    record = store.get_document(document_id)
    delete_analysis(store.document_dir(record.id))
    return Response(status_code=204)


@router.get("/documents/{document_id}/context-preview")
async def context_preview(request: Request, document_id: str, paragraph_id: str) -> Any:
    """The context a translation call would receive for one paragraph.

    A debug view, and the only way to inspect the ContextBuilder without running
    a translation. It returns context *for* the named paragraph and never its
    text, which is the same rule the real caller follows.
    """
    from app.context import ContextBuilder
    from app.context.persistence import read_analysis

    store = get_document_store(request)
    record = store.get_document(document_id)

    result, failure = await _require_ir(request, document_id)
    if failure is not None:
        return failure
    ir, _summary = result

    if paragraph_id not in {paragraph.id for paragraph in ir.paragraphs}:
        return error_response(404, "NOT_FOUND", "No such paragraph in this document.")

    builder = ContextBuilder(ir, read_analysis(store.document_dir(record.id)))
    budget = request.query_params.get("max_tokens")
    try:
        limit = int(budget) if budget else 1500
    except ValueError:
        return error_response(400, "BAD_REQUEST", "max_tokens must be an integer.")

    return json.loads(builder.build_context(paragraph_id, max_tokens=limit).model_dump_json())


# --- paper QA retrieval ------------------------------------------------------


class RetrieveRequest(BaseModel):
    """A scoped question. The scope is enforced by the engine, not by the client."""

    model_config = ConfigDict(extra="forbid")

    query: str = ""
    scope: dict[str, Any] = Field(default_factory=lambda: {"type": "whole_paper"})
    top_k: int = Field(default=8, ge=1, le=50)


@router.post("/documents/{document_id}/retrieve")
async def retrieve_evidence(
    request: Request, document_id: str, payload: RetrieveRequest
) -> Any:
    """Return source evidence for a question, with real citation identity.

    No model is involved. Every page, section and paragraph id comes from the
    canonical `DocumentIR`, which is what makes a later answer's citations
    verifiable rather than merely plausible.

    `DocumentAnalysis` is optional and is read from disk if it happens to exist —
    it may add glossary and acronym expansions to the query, but it is never
    evidence and is never generated on demand. A search must not cost 468 seconds
    of analysis.
    """
    from app.context.models import DocumentAnalysis
    from app.context.persistence import read_analysis
    from app.qa import RetrievalError, Scope, retrieve
    from app.document.persistence import read_ir

    store = get_document_store(request)
    record = store.get_document(document_id)
    directory = store.document_dir(record.id)

    try:
        scope = Scope.model_validate(payload.scope)
    except Exception:  # noqa: BLE001 - a malformed scope is the client's problem
        return error_response(
            422,
            "VALIDATION_ERROR",
            "scope must be one of whole_paper, section, page or selection, "
            "with the field that scope requires.",
        )

    ir = read_ir(directory)
    if ir is None:
        result, failure = await _require_ir(request, document_id)
        if failure is not None:
            return failure
        ir, _summary = result

    analysis = read_analysis(directory)

    try:
        bundle = await asyncio.to_thread(
            retrieve,
            ir,
            directory,
            query=payload.query,
            scope=scope,
            analysis=analysis,
            top_k=payload.top_k,
        )
    except RetrievalError as exc:
        return error_response(400, exc.code, exc.message)

    return json.loads(bundle.model_dump_json())


# --- paper QA answering ------------------------------------------------------


class AnswerRequest(BaseModel):
    """A question about one document.

    Note what is **absent**: there is no field for evidence. The endpoint
    retrieves for itself, always. Accepting a bundle from a client would let the
    caller choose the text the model cites, and the citations it returned would
    then resolve to real pages and real highlights — structurally perfect and
    evidentially fabricated. Offline tests drive `generate_answer` directly,
    which is where a synthetic bundle belongs.
    """

    model_config = ConfigDict(extra="forbid")

    question: str = Field(min_length=1)
    scope: dict[str, Any] = Field(default_factory=lambda: {"type": "whole_paper"})
    profile_id: str
    top_k: int = Field(default=8, ge=1, le=50)
    #: Overrides the default, which is to answer in the question's language.
    language: str | None = None


@router.post("/documents/{document_id}/answer")
async def answer_question(
    request: Request, document_id: str, payload: AnswerRequest
) -> Any:
    """Answer a question about a document, or say the evidence does not.

    `200` carries one of three statuses: `answered`, `partial`, or
    `insufficient_evidence`. The third is a successful outcome, not an error — it
    means retrieval did not find evidence that supports an answer, and the system
    declined to supply one from the model's own knowledge.

    A provider failure is different and returns `502`. The distinction is the
    point: "the paper does not say" and "the provider timed out" must never be
    reported as the same thing.
    """
    from app.context.models import DocumentAnalysis
    from app.context.persistence import read_analysis
    from app.llm.errors import LLMError, sanitize_message
    from app.llm.detection import resolve_provider
    from app.qa import AnswerError, Scope, generate_answer

    profiles = get_profile_store(request)
    store = get_document_store(request)
    record = store.get_document(document_id)

    result, failure = await _require_ir(request, document_id)
    if failure is not None:
        return failure
    ir, _summary = result
    directory = store.document_dir(record.id)

    try:
        scope = Scope.model_validate(payload.scope)
    except Exception:  # noqa: BLE001 - a malformed scope is the client's problem
        return error_response(
            422,
            "VALIDATION_ERROR",
            "scope must be one of whole_paper, section, page or selection, "
            "with the field that scope requires.",
        )

    try:
        profile = profiles.get_profile(payload.profile_id)
        config = profiles.to_provider_config(payload.profile_id)
    except Exception:  # noqa: BLE001 - unknown profile, or the credential store is down
        return error_response(404, "NOT_FOUND", "No such provider profile.")

    # Read, never generate. A question must not silently start a 468-second
    # analysis; the analysis is used if it already exists and its absence costs
    # only the query expansions it would have supplied.
    analysis: DocumentAnalysis | None = read_analysis(directory)

    try:
        provider = await resolve_provider(config, profile.protocol)
        answer = await generate_answer(
            ir,
            directory,
            question=payload.question,
            scope=scope,
            provider=provider,
            analysis=analysis,
            top_k=payload.top_k,
            language=payload.language,
        )
    except AnswerError as exc:
        return error_response(502, exc.code, sanitize_message(exc.message))
    except LLMError as exc:
        return error_response(
            502, getattr(exc, "code", "PROVIDER_ERROR"), sanitize_message(exc.message)
        )

    return json.loads(answer.model_dump_json())


# --- translation -------------------------------------------------------------


@router.post("/documents/{document_id}/translate", status_code=202)
async def start_translation(
    request: Request, document_id: str, payload: TranslateRequest
) -> Any:
    """Start a translation. Returns immediately with a task id."""
    store = get_document_store(request)
    runner = get_task_runner(request)
    store.get_document(document_id)  # 404 before anything is scheduled

    from app.context.translation_context import VALID_MODES

    if payload.context_mode not in VALID_MODES:
        return error_response(
            422,
            "VALIDATION_ERROR",
            f"context_mode must be one of {list(VALID_MODES)}, not {payload.context_mode!r}.",
        )

    try:
        task = runner.start(
            document_id=document_id,
            profile_id=payload.profile_id,
            lang_in=payload.lang_in,
            lang_out=payload.lang_out,
            engine=payload.engine,
            context_mode=payload.context_mode,
        )
    except DocumentBusyError:
        return error_response(
            409, "DOCUMENT_BUSY", "A translation is already running for this document."
        )
    except Exception as exc:  # noqa: BLE001 - e.g. credential store unavailable
        from app.llm.errors import sanitize_message

        return error_response(502, "PROVIDER_ERROR", sanitize_message(str(exc)))

    return {"task_id": task.id, "document_id": document_id, "status": task.status}


@router.get("/tasks/{task_id}")
async def get_task(request: Request, task_id: str) -> dict[str, Any]:
    store = get_document_store(request)
    return task_payload(store.get_task(task_id))


@router.get("/tasks/{task_id}/events")
async def task_events(request: Request, task_id: str) -> Any:
    """Server-sent progress. Closes once the task reaches a terminal state."""
    store = get_document_store(request)
    runner = get_task_runner(request)
    store.get_task(task_id)  # 404 before opening the stream

    async def stream() -> Any:
        queue = runner.subscribe(task_id)
        try:
            # Send the current state first, so a client that connects late is not
            # left waiting for the next page to learn where things stand.
            yield _sse("snapshot", task_payload(store.get_task(task_id)))
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=SSE_KEEPALIVE_SECONDS)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                yield _sse(event.get("event", "message"), event)
                if event.get("event") in ("done", "error", "cancelled"):
                    break
        finally:
            runner.unsubscribe(task_id, queue)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def _sse(event: str, payload: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


@router.post("/tasks/{task_id}/cancel")
async def cancel_task(request: Request, task_id: str) -> Any:
    """Request cancellation at the next page boundary.

    Honest about what it can promise: the current page finishes first, because
    the kernel polls for cancellation once per page.
    """
    runner = get_task_runner(request)
    try:
        task = runner.cancel(task_id)
    except TaskAlreadyTerminalError:
        return error_response(
            409, "TASK_ALREADY_TERMINAL", "The task has already finished."
        )

    return {
        "task_id": task.id,
        "status": "CANCELLING",
        "message": (
            "Cancellation requested. The current page will finish, then "
            "translation will halt."
        ),
    }


@router.post("/tasks/{task_id}/retry")
async def retry_task(request: Request, task_id: str) -> Any:
    """Not supported, and said so rather than pretended.

    The kernel translates whole documents; it has no block-level retry or
    resume. Re-running the document under a name that promises block retry would
    mislead the caller.
    """
    get_document_store(request).get_task(task_id)  # 404 for an unknown task
    return JSONResponse(
        status_code=501,
        content={
            "error": {
                "code": "NOT_IMPLEMENTED",
                "message": (
                    "Block-level retry is not supported by the translation kernel. "
                    "Re-run translation via POST /api/documents/{id}/translate."
                ),
                "detail": {},
            }
        },
    )
