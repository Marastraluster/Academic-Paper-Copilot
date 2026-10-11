"""Parsing a document with MinerU as a background job.

MinerU takes from seconds (a GPU, the ``flash`` tier) to minutes (a CPU, a long
paper), so a parse is never done inside a request. ``start`` schedules it and
returns at once; ``state`` reports where it is; when it finishes, the IR it
produced replaces the in-house one in ``ir.json`` and everything keyed on the IR
(QA index, overview, paragraph translation) sees a new ``pipeline_version`` and
rebuilds on its next use instead of answering from the old parse.

What is kept on disk, under the document's own directory so it is deleted with
it:

    mineru/middle.json   the raw result, so the IR can be rebuilt without paying
                         the service again when this converter improves
    mineru/images/…      figures, tables and formulas as MinerU cut them
"""

from __future__ import annotations

import asyncio
import json
import shutil
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

import fitz

from app.document.extract import _fingerprint, _read_metadata
from app.document.models import DocumentIR
from app.document.persistence import write_ir
from app.logging import get_logger
from app.mineru.client import MinerUClient, MinerUError
from app.mineru.convert import MinerUConversionError, PageGeometry, middle_json_to_ir
from app.storage.profiles import ServiceConfig

logger = get_logger(__name__)

MINERU_DIRNAME = "mineru"
MIDDLE_FILENAME = "middle.json"

#: Statuses a client sees. ``queued``/``running`` come from MinerU itself;
#: ``uploading`` and ``converting`` are this side of the wire.
ACTIVE = frozenset({"pending", "uploading", "queued", "running", "converting"})


def _now() -> str:
    return datetime.now(tz=timezone.utc).replace(microsecond=0).isoformat()


@dataclass
class ParseState:
    document_id: str
    status: str = "pending"
    started_at: str = field(default_factory=_now)
    finished_at: str | None = None
    #: MinerU's own status when it last answered — useful when ``status`` is
    #: ``running`` for a long time on a busy shared server.
    remote_status: str | None = None
    tier: str | None = None
    code: str | None = None
    message: str | None = None
    paragraphs: int | None = None
    sections: int | None = None
    #: ``partial`` when MinerU reported some pages failed.
    partial: bool = False

    def payload(self) -> dict[str, Any]:
        return asdict(self)


_states: dict[str, ParseState] = {}
_tasks: dict[str, asyncio.Task[None]] = {}


def mineru_dir(document_dir: Path) -> Path:
    return Path(document_dir) / MINERU_DIRNAME


def state(document_id: str) -> ParseState | None:
    return _states.get(document_id)


def is_running(document_id: str) -> bool:
    current = _states.get(document_id)
    return current is not None and current.status in ACTIVE


def page_geometry(source: Path) -> list[PageGeometry]:
    with fitz.open(str(source)) as document:
        return [
            PageGeometry(
                width_pt=float(page.rect.width),
                height_pt=float(page.rect.height),
                rotation=int(page.rotation),
            )
            for page in document
        ]


def build_ir_from_result(
    middle: dict[str, Any],
    *,
    source: Path,
    document_id: str,
    source_filename: str,
) -> DocumentIR:
    """Convert a stored or freshly downloaded result against the source PDF."""
    content_hash = _fingerprint(source)[0]
    with fitz.open(str(source)) as document:
        metadata = _read_metadata(document)
    return middle_json_to_ir(
        middle,
        document_id=document_id,
        content_hash=content_hash,
        source_filename=source_filename,
        pages=page_geometry(source),
        metadata=metadata,
    )


def _store_result(target: Path, middle: dict[str, Any], assets: dict[str, bytes]) -> None:
    """Write the result beside the document, replacing any earlier one whole."""
    staging = target.parent / f".{MINERU_DIRNAME}-{uuid.uuid4().hex}"
    staging.mkdir(parents=True)
    try:
        (staging / MIDDLE_FILENAME).write_text(
            json.dumps(middle, ensure_ascii=False), encoding="utf-8"
        )
        for relative, data in assets.items():
            path = PurePosixPath(relative)
            if path.is_absolute() or ".." in path.parts:
                continue
            destination = staging.joinpath(*path.parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
        if target.exists():
            shutil.rmtree(target)
        staging.rename(target)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise


async def run_parse(
    *,
    document_id: str,
    document_dir: Path,
    source: Path,
    source_filename: str,
    service: ServiceConfig,
    client: MinerUClient | None = None,
) -> ParseState:
    """Do the whole parse now. ``start`` runs this in the background."""
    current = _states.setdefault(document_id, ParseState(document_id=document_id))
    current.tier = service.model or None

    def on_status(remote: str) -> None:
        current.remote_status = remote
        if remote in ("uploading", "queued", "running"):
            current.status = remote

    try:
        result = await (client or MinerUClient(service)).parse(source, on_status=on_status)
        current.status = "converting"
        current.partial = result.status == "partial"
        current.tier = result.tier or current.tier

        def convert_and_store() -> DocumentIR:
            ir = build_ir_from_result(
                result.middle_json,
                source=source,
                document_id=document_id,
                source_filename=source_filename,
            )
            _store_result(mineru_dir(document_dir), result.middle_json, result.assets)
            write_ir(document_dir, ir)
            return ir

        ir = await asyncio.to_thread(convert_and_store)
    except MinerUError as exc:
        current.status, current.code, current.message = "failed", exc.code, exc.message
    except MinerUConversionError as exc:
        current.status, current.code, current.message = "failed", "MINERU_INVALID_RESPONSE", str(exc)
    except asyncio.CancelledError:
        current.status, current.code, current.message = "failed", "CANCELLED", "Parsing was cancelled."
        current.finished_at = _now()
        raise
    except Exception as exc:  # noqa: BLE001 - reported, never swallowed silently
        logger.exception("mineru parse failed", extra={"document_id": document_id})
        current.status, current.code = "failed", "INTERNAL_ERROR"
        current.message = f"Parsing failed: {type(exc).__name__}."
    else:
        current.status = "completed"
        current.paragraphs = len(ir.paragraphs)
        current.sections = len(ir.sections)
        logger.info(
            "mineru parse completed",
            extra={"document_id": document_id, "paragraphs": len(ir.paragraphs)},
        )
    current.finished_at = _now()
    return current


def start(
    *,
    document_id: str,
    document_dir: Path,
    source: Path,
    source_filename: str,
    service: ServiceConfig,
    client: MinerUClient | None = None,
) -> ParseState:
    """Schedule a parse; a second request while one runs gets the running one."""
    if is_running(document_id):
        return _states[document_id]
    _states[document_id] = ParseState(document_id=document_id)
    task = asyncio.create_task(
        run_parse(
            document_id=document_id,
            document_dir=document_dir,
            source=source,
            source_filename=source_filename,
            service=service,
            client=client,
        )
    )
    _tasks[document_id] = task
    task.add_done_callback(lambda _t: _tasks.pop(document_id, None))
    return _states[document_id]


async def cancel_all() -> None:
    """Stop every running parse (application shutdown)."""
    for task in list(_tasks.values()):
        task.cancel()
    for task in list(_tasks.values()):
        try:
            await task
        except BaseException:  # noqa: BLE001
            pass
