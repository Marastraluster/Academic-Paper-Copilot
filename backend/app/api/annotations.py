"""Notes and highlights over HTTP.

Two kinds of route, and the split is the design: the ones under `/documents/`
are about *the paper being read*, and the ones under `/annotations/` are about
*a thing the user made*. An annotation outlives the document record it was made
against — that is the whole point of keying it to the fingerprint — so it cannot
be addressed only through the document that happened to be open.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.annotations.service import resolve_annotation, summary, summary_unresolved
from app.annotations.store import AnnotationStore
from app.document.persistence import read_ir
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

    @model_validator(mode="after")
    def _rects_belong_to_their_envelope(self) -> "TargetPayload":
        """Every line rectangle must lie inside the target's own envelope.

        This is the cheap half of "a target's rects belong to its declared
        page". The frontend builds a target by intersecting the selection with
        that paragraph's boxes, so the containment is an invariant of the
        payload rather than a coincidence — and it is exactly what a
        cross-page mistake breaks. A target carrying page 2's rectangles under
        a page 1 envelope would otherwise be stored, rendered at page 2's
        coordinates on page 1, and look to the reader like a highlight pointing
        at text that does not support it.

        Deliberately not checked against the IR: reading the extraction to
        validate a mark is the round trip that cost fourteen seconds on every
        reopen (DS-QA-010-FIX-001). Containment needs only the payload.
        """
        if not self.rects:
            raise ValueError("A target needs the rectangles the selection covered.")
        x0, y0, x1, y1 = self.original_bbox
        if x1 <= x0 or y1 <= y0:
            raise ValueError("A target's envelope must have a positive area.")
        for rect in self.rects:
            rx0, ry0, rx1, ry1 = rect
            if rx1 <= rx0 or ry1 <= ry0:
                raise ValueError("A target rectangle must have a positive area.")
            # Half a point of slack: the sources are floats measured by two
            # different tools, and a rounding artefact is not a misplaced mark.
            if (
                rx0 < x0 - 0.5 or ry0 < y0 - 0.5
                or rx1 > x1 + 0.5 or ry1 > y1 + 0.5
            ):
                raise ValueError(
                    "A target's rectangles must lie inside its own envelope."
                )
        return self


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
    """Every annotation on this paper, resolved if the document has been read.

    **This route does not extract the document, and that is the whole point.**
    It used to call `_require_ir`, which runs the full ONNX extraction on first
    read — fourteen seconds for a real paper. Reopening a PDF creates a new
    document record, so every reopen paid that cost before a single note could be
    listed, and the reader saw an empty panel for as long as it took. The list
    needs the *fingerprint*, and a fingerprint is a file hash.

    Resolution is what needs the IR, and it is genuinely optional here: a target
    carries the page and rectangles it was made with, which belong to the
    immutable PDF and stay true whether or not the current extraction has been
    computed. When there is no IR the targets are reported `UNRESOLVED` — the
    honest answer — and the list still renders. The brief asks for exactly this
    separation: a note's existence does not depend on its resolution.
    """
    store = _store(request)
    if store is None:
        return error_response("UNAVAILABLE", "Annotations are not available.", 503)

    document_store = request.app.state.document_store
    record = document_store.get_document(document_id)
    if record is None:
        return error_response("NOT_FOUND", "No such document.", 404)

    directory = document_store.document_dir(document_id)
    ir = read_ir(directory)  # a file read; never an extraction

    content_hash = ir.content_hash if ir is not None else _fingerprint_of(directory)
    if content_hash is None:
        return error_response(
            "NOT_FOUND", "The source file is no longer available.", 404
        )

    # Listed by **fingerprint**, not by the document row. Document ids are
    # `uuid4().hex`, so reopening the same PDF produces a new row; the content
    # hash is the boundary the user's writing belongs to.
    annotations = store.list_for_content(content_hash)
    return {
        "document_id": document_id,
        "content_hash": content_hash,
        "resolved": ir is not None,
        "annotations": [
            summary(annotation, resolve_annotation(ir, annotation, store=store))
            if ir is not None
            else summary_unresolved(annotation)
            for annotation in annotations
        ],
    }


def _fingerprint_of(directory) -> str | None:
    """The source PDF's content hash, without reading its IR.

    The document's own identity, available in the time it takes to hash a file —
    which is what lets the notes list answer before the paper has been read.
    """
    from app.document.extract import _fingerprint

    source = Path(directory) / "source.pdf"
    if not source.is_file():
        return None
    try:
        return str(_fingerprint(source)[0])
    except OSError:
        return None


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
