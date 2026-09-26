"""Display-formula reconstruction over HTTP.

Two routes, and the split is the product rule:

    GET  /formulas        reads the cache, and **never reaches a provider**
    POST /formulas        generates, validates, caches — and costs money

A `GET` that finds nothing answers 404 with the *plan* in its detail — how many
formulas, how many calls — so the column can tell the reader what making one
would cost without a second request, and without guessing: the numbers come from
the same `plan()` the pipeline runs.

The artifact is the formulas' own, in its own directory beside the bilingual
reading's: `_cache/formulas/<content_hash>.json`. Nothing here touches the
translation a reader already paid for, and mathematics has no language, so
there is no language axis on either route.
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict

from app.errors import error_response
from app.formulas.cache import read_formulas, write_formulas
from app.formulas.models import FormulaArtifact
from app.formulas.pipeline import generate_formulas, plan

router = APIRouter(tags=["formulas"])

#: Generations currently running, keyed by content hash. A reader who presses
#: the button twice — or two tabs doing the same thing — must not pay twice for
#: the same paper, and a second run would also race the first one's write.
_IN_FLIGHT: set[str] = set()
_IN_FLIGHT_LOCK = asyncio.Lock()


class GenerateFormulas(BaseModel):
    model_config = ConfigDict(extra="forbid")

    profile_id: str
    #: Regenerate even though a compatible artifact exists.
    force: bool = False


def _payload(artifact: FormulaArtifact, *, cached: bool) -> dict[str, Any]:
    """Everything the column renders, and nothing that is not the reader's.

    The glyph soup travels with each formula because the fallback surface shows
    it beside the paper's own pixels — it is the same text the client already
    has in its IR, and sending it again is what lets a crop be rendered without
    the two halves arriving from different places.
    """
    return {
        "status": artifact.status,
        "cached": cached,
        "content_hash": artifact.content_hash,
        "provider_model": artifact.provider_model,
        "created_at": artifact.created_at,
        "input_tokens": artifact.input_tokens,
        "output_tokens": artifact.output_tokens,
        "notes": list(artifact.notes),
        "total_formulas": artifact.total_formulas,
        "reconstructed_count": artifact.reconstructed_count,
        "refused_count": artifact.refused_count,
        "failed_count": artifact.failed_count,
        "formulas": [
            {
                "block_id": item.block_id,
                "source_anchor_id": item.source_anchor_id,
                "page_number": item.page_number,
                # PDF points, so the client can draw and scroll to the formula
                # it already has — never a rectangle a model supplied.
                "bbox": list(item.bbox),
                "raw_soup": item.raw_soup,
                "font_size": item.font_size,
                "status": item.status,
                "latex": item.latex,
                "equation_number": item.equation_number,
                "refusal_reason": item.refusal_reason,
                "error_reason": item.error_reason,
            }
            for item in artifact.formulas
        ],
    }


@router.get("/documents/{document_id}/formulas")
async def get_formulas(request: Request, document_id: str) -> Any:
    """The stored artifact, or a 404 that says none exists. Generates nothing."""
    from app.api.documents import _require_ir

    result, failure = await _require_ir(request, document_id)
    if failure is not None:
        return failure
    ir, _summary = result

    artifact = read_formulas(
        request.app.state.settings.documents_dir,
        content_hash=ir.content_hash,
        ir_pipeline_version=ir.pipeline_version,
    )
    if artifact is None:
        # The plan rides with the answer that there is nothing yet: the column
        # can then tell the reader what making one would cost from the single
        # read it already made, rather than asking a second time. The numbers
        # come from the same `plan()` the pipeline runs — the work itself, not
        # an estimate of it (DS-DOC-010 AC-P0-03).
        work = plan(ir)
        return error_response(
            404,
            "FORMULA_NOT_FOUND",
            "This paper has no reconstructed formulas yet.",
            {
                "plan": {
                    "total_formulas": work.formula_count,
                    "batch_count": work.batch_count,
                    "character_volume": work.character_volume,
                }
            },
        )
    return _payload(artifact, cached=True)


@router.post("/documents/{document_id}/formulas")
async def create_formulas(
    request: Request, document_id: str, payload: GenerateFormulas
) -> Any:
    """Generate one. **The only route here that spends on a reader's behalf.**"""
    from app.api.documents import _require_ir
    from app.llm.detection import resolve_provider
    from app.llm.errors import LLMError, sanitize_message

    result, failure = await _require_ir(request, document_id)
    if failure is not None:
        return failure
    ir, _summary = result

    directory = request.app.state.settings.documents_dir
    if not payload.force:
        cached = read_formulas(
            directory,
            content_hash=ir.content_hash,
            ir_pipeline_version=ir.pipeline_version,
        )
        if cached is not None:
            # Already paid for, and the paper has not changed.
            return _payload(cached, cached=True)

    async with _IN_FLIGHT_LOCK:
        if ir.content_hash in _IN_FLIGHT:
            return error_response(
                409,
                "GENERATION_ALREADY_IN_PROGRESS",
                "A formula reconstruction for this paper is already running.",
            )
        _IN_FLIGHT.add(ir.content_hash)

    from app.api.profiles import get_profile_store

    profiles = get_profile_store(request)
    try:
        profile = profiles.get_profile(payload.profile_id)
        config = profiles.to_provider_config(payload.profile_id)
    except Exception:  # noqa: BLE001 - unknown profile, or the credential store is down
        async with _IN_FLIGHT_LOCK:
            _IN_FLIGHT.discard(ir.content_hash)
        return error_response(404, "NOT_FOUND", "No such provider profile.")

    try:
        provider = await resolve_provider(config, profile.protocol)
        from app.llm import accounting

        with accounting.operation("formula_latex"):
            outcome = await generate_formulas(
                ir, provider,
                provider_base_url=profile.base_url,
            )
    except LLMError as exc:
        return error_response(
            _STATUS.get(exc.code, 502), exc.code, sanitize_message(exc.message)
        )
    finally:
        async with _IN_FLIGHT_LOCK:
            _IN_FLIGHT.discard(ir.content_hash)

    from datetime import datetime, timezone

    artifact = outcome.artifact
    artifact.created_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    if artifact.is_usable():
        write_formulas(directory, artifact)
    return _payload(artifact, cached=False)


_STATUS = {"AUTHENTICATION": 401, "PERMISSION": 403, "RATE_LIMIT": 429,
           "BAD_REQUEST": 400, "TIMEOUT": 504, "NETWORK": 502}
