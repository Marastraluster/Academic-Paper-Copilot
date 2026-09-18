"""Notes and highlights over HTTP.

Two kinds of route, and the split is the design: the ones under `/documents/`
are about *the paper being read*, and the ones under `/annotations/` are about
*a thing the user made*. An annotation outlives the document record it was made
against — that is the whole point of keying it to the fingerprint — so it cannot
be addressed only through the document that happened to be open.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from app.annotations.service import resolve_annotation, summary
from app.annotations.store import AnnotationStore
from app.errors import error_response

router = APIRouter(tags=["annotations"])

#: How much source either side of a quote is kept. Short on purpose: it exists so
#: a reattachment has something to disambiguate with, not to store the paper.
CONTEXT_CHARS = 64


class TargetPayload(BaseModel):
    """One source region the user selected, as the browser measured it."""

    model_config = ConfigDict(extra="forbid")

    source_anchor_id: str
    anchor_version: str = "1"
    page_number: int = Field(ge=1)
    #: `[x0, y0, x1, y1]` in source-PDF points — the paragraph envelope.
    original_bbox: tuple[float, float, float, float]
    #: The line rectangles the selection covered, in the same space.
    rects: list[tuple[float, float, float, float]] = Field(default_factory=list)
    exact_quote: str
    prefix: str = ""
    suffix: str = ""


class CreateAnnotation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: str = "highlight"
    quote: str
    comment: str | None = None
    color: str = "yellow"
    targets: list[TargetPayload]


class UpdateAnnotation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    comment: str | None = None


def _store(request: Request) -> AnnotationStore | None:
    connection = getattr(request.app.state, "annotation_connection", None)
    return AnnotationStore(connection) if connection is not None else None


def _require_ir(request: Request, document_id: str):
    """The IR and the record, or the shared error envelope."""
    from app.api.documents import _require_ir as require

    return require(request, document_id)


@router.get("/documents/{document_id}/annotations")
async def list_annotations(request: Request, document_id: str) -> Any:
    """Every annotation on this paper, each target resolved against the current IR.

    Resolution happens here, on read, rather than being baked in at write time:
    the target stores the anchor the user made and this asks where that anchor is
    *now*. A target that resolved last week and not today is a fact about the
    extraction, and reading is when the reader needs to know it.
    """
    store = _store(request)
    if store is None:
        return error_response("UNAVAILABLE", "Annotations are not available.", 503)

    result, failure = await _require_ir(request, document_id)
    if failure is not None:
        return failure
    ir, _summary = result

    # Listed by **fingerprint**, not by the document row.
    #
    # Document ids are `uuid4().hex`, so reopening the same PDF — even from the
    # same file on disk — produces a new row and a new id. Listing by that id
    # meant a reload showed an empty panel while the rows sat in the database,
    # which is what this line was changed from after the browser test found it.
    # The content hash is the boundary the user's writing belongs to.
    annotations = store.list_for_content(ir.content_hash)
    return {
        "document_id": document_id,
        "content_hash": ir.content_hash,
        "annotations": [
            summary(annotation, resolve_annotation(ir, annotation, store=store))
            for annotation in annotations
        ],
    }


@router.post("/documents/{document_id}/annotations", status_code=201)
async def create_annotation(
    request: Request, document_id: str, payload: CreateAnnotation
) -> Any:
    """Persist a highlight or note against the paper's content fingerprint.

    No model is consulted, no retrieval runs, and no provider is reached: the
    quote is the user's own selection and the anchors were computed in the
    browser from the IR it already holds.
    """
    store = _store(request)
    if store is None:
        return error_response("UNAVAILABLE", "Annotations are not available.", 503)

    result, failure = await _require_ir(request, document_id)
    if failure is not None:
        return failure
    ir, _summary = result

    if payload.kind not in ("highlight", "note"):
        return error_response("BAD_REQUEST", "Unknown annotation kind.", 400)
    if not payload.targets:
        return error_response(
            "BAD_REQUEST", "An annotation needs at least one source target.", 400
        )

    known = {p.source_anchor_id for p in ir.paragraphs if p.source_anchor_id}
    unknown = [
        target.source_anchor_id
        for target in payload.targets
        if target.source_anchor_id not in known
    ]
    if unknown:
        # Refused rather than stored. A target whose anchor does not exist in the
        # paper it names could never resolve, and would sit in the user's panel
        # looking like a bug they caused.
        return error_response(
            "BAD_REQUEST",
            "The selection does not match this paper's current extraction. "
            "Re-select and try again.",
            400,
        )

    try:
        annotation = store.create(
            content_hash=ir.content_hash,
            document_id=document_id,
            kind=payload.kind,
            quote=payload.quote,
            comment=payload.comment,
            color=payload.color,
            targets=[target.model_dump() for target in payload.targets],
        )
    except sqlite3.Error:
        return error_response("STORAGE_FAILED", "The annotation could not be saved.", 500)

    return summary(annotation, resolve_annotation(ir, annotation, store=store))


@router.patch("/annotations/{annotation_id}")
async def update_annotation(
    request: Request, annotation_id: str, payload: UpdateAnnotation
) -> Any:
    """Edit the user's words. Touches no target."""
    store = _store(request)
    if store is None:
        return error_response("UNAVAILABLE", "Annotations are not available.", 503)

    existing = store.get(annotation_id)
    if existing is None or existing.is_deleted:
        return error_response("NOT_FOUND", "No such annotation.", 404)

    updated = store.update_comment(annotation_id, payload.comment)
    if updated is None:
        return error_response("NOT_FOUND", "No such annotation.", 404)

    result, failure = await _require_ir(request, updated.document_id)
    if failure is not None:
        return {"id": updated.id, "comment": updated.comment, "updated_at": updated.updated_at}
    ir, _summary = result
    return summary(updated, resolve_annotation(ir, updated, store=store))


@router.delete("/annotations/{annotation_id}", status_code=204)
async def delete_annotation(request: Request, annotation_id: str) -> Response:
    """Soft delete: the row stays, `deleted_at` is set.

    A user's writing is not a cache. There is no retention policy here that would
    justify destroying it, and a mistaken delete should be recoverable.
    """
    store = _store(request)
    if store is None:
        return error_response("UNAVAILABLE", "Annotations are not available.", 503)
    if not store.delete(annotation_id):
        return error_response("NOT_FOUND", "No such annotation.", 404)
    return Response(status_code=204)
