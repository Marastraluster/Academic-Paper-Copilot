"""Structural parsing (MinerU) over HTTP.

    POST /documents/{id}/parse            start parsing with a `parser` profile
    GET  /documents/{id}/parse            where it is, or what produced the IR
    GET  /documents/{id}/assets/{path}    an image MinerU cut out of the paper

The in-house extractor still runs on first read when nothing better exists, so a
paper is readable the moment it is opened; parsing with MinerU is the upgrade a
reader asks for (or the frontend asks for on their behalf when a parser profile
is configured), and when it finishes it replaces that IR.
"""

from __future__ import annotations

from pathlib import Path, PurePosixPath
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict

from app.errors import error_response
from app.mineru import jobs

router = APIRouter(tags=["parsing"])

_ASSET_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
}


class ParseRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    profile_id: str


@router.post("/documents/{document_id}/parse", status_code=202)
async def start_parse(request: Request, document_id: str, payload: ParseRequest) -> Any:
    from app.api.documents import _resolve_source, get_document_store
    from app.api.profiles import get_profile_store

    store = get_document_store(request)
    record = store.get_document(document_id)
    source = _resolve_source(store, record)
    if source is None:
        return error_response(404, "NOT_FOUND", "The source file is no longer available.")

    service = get_profile_store(request).to_service_config(payload.profile_id, kind="parser")
    state = jobs.start(
        document_id=record.id,
        document_dir=store.document_dir(record.id),
        source=source,
        source_filename=record.name,
        service=service,
    )
    return state.payload()


@router.get("/documents/{document_id}/parse")
async def parse_status(request: Request, document_id: str) -> Any:
    """The running or last parse; after a restart, what the stored IR came from."""
    from app.api.documents import get_document_store
    from app.document.persistence import read_ir
    from app.mineru.convert import MINERU_PIPELINE_VERSION

    store = get_document_store(request)
    record = store.get_document(document_id)
    current = jobs.state(record.id)
    if current is not None:
        return current.payload()

    ir = read_ir(store.document_dir(record.id))
    parser = "none"
    if ir is not None:
        parser = "mineru" if ir.pipeline_version == MINERU_PIPELINE_VERSION else "builtin"
    return {
        "document_id": record.id,
        "status": "completed" if parser == "mineru" else "idle",
        "parser": parser,
    }


@router.get("/documents/{document_id}/assets/{asset_path:path}")
async def parse_asset(request: Request, document_id: str, asset_path: str) -> Any:
    """Serve one image from the document's MinerU result, and nothing else."""
    from app.api.documents import get_document_store

    store = get_document_store(request)
    record = store.get_document(document_id)
    relative = PurePosixPath(asset_path)
    if relative.is_absolute() or ".." in relative.parts or "\\" in asset_path:
        return error_response(400, "BAD_REQUEST", "Invalid asset path.")
    suffix = relative.suffix.lower()
    if suffix not in _ASSET_TYPES:
        return error_response(404, "NOT_FOUND", "No such asset.")

    root = jobs.mineru_dir(store.document_dir(record.id)).resolve()
    target = root.joinpath(*relative.parts).resolve()
    if root not in target.parents or not Path(target).is_file():
        return error_response(404, "NOT_FOUND", "No such asset.")
    return FileResponse(
        target,
        media_type=_ASSET_TYPES[suffix],
        headers={"Cache-Control": "private, max-age=31536000, immutable"},
    )
