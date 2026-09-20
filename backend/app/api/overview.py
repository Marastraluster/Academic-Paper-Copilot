"""The reader overview over HTTP.

Two routes, and the split is the product rule:

    GET   reads the cache, and **never reaches a provider**
    POST  generates, validates, caches, and is the only thing that costs anything

A GET that silently spent several minutes and someone's quota would be a
surprise, and opening the panel would become an expense. The panel is opened by
putting the cursor on a tab; generation is a button.

Deliberately **not** an overload of the analysis routes. Those serve the
translation-context artifact, whose prompt, cache and audience are different, and
a reader overview returned from a translation endpoint would be the DS-QA-014
defect reintroduced at the API.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict

from app.errors import error_response
from app.overview.cache import read_overview, write_overview
from app.overview.models import EvidenceRef, ReaderOverview
from app.overview.pipeline import generate_overview

router = APIRouter(tags=["overview"])


class GenerateOverview(BaseModel):
    model_config = ConfigDict(extra="forbid")

    profile_id: str
    target_language: str = "zh-CN"
    #: Regenerate even though a compatible overview exists. Explicit, and never
    #: implied: a cached overview is a fact about an unchanged paper, and
    #: replacing it should be the reader's decision rather than a side effect.
    force: bool = False


def _evidence_payload(evidence: Sequence[EvidenceRef]) -> list[dict[str, Any]]:
    """Where an item came from, in the two forms the page can use.

    The **page** is what a jump needs and what belongs to the immutable PDF. The
    **paragraph id** is the key into the document the reader is already looking
    at — the client resolves that paragraph's rectangle from its own IR, which is
    the only geometry anyone has: the model was never shown a coordinate, so a
    rectangle in an artifact would be a rectangle nobody measured.

    No paragraph text travels here. It is already in the client, and sending it
    again would put paper prose in a second place that has to be kept true.
    """
    return [
        {"paragraph_id": ref.paragraph_id, "page_number": ref.page_number}
        for ref in evidence
    ]


def _payload(overview: ReaderOverview, *, cached: bool) -> dict[str, Any]:
    """Everything the panel renders, and nothing that is not the reader's."""
    return {
        "status": overview.status,
        "cached": cached,
        "content_hash": overview.content_hash,
        "target_language": overview.target_language,
        "provider_model": overview.provider_model,
        "created_at": overview.created_at,
        # Provider-reported, or `None`. The panel renders the second as
        # "Token 统计不可用"; it never renders an estimate.
        "input_tokens": overview.input_tokens,
        "output_tokens": overview.output_tokens,
        "source_sections": list(overview.source_sections),
        "notes": list(overview.notes),
        "items": [
            {
                "category": item.category,
                "text": item.text,
                "inferred": item.inferred,
                "partial": item.partial,
                "evidence": _evidence_payload(item.evidence),
            }
            for item in overview.items
        ],
        "key_terms": [
            {
                "term": term.term,
                "definition": term.definition,
                "evidence": _evidence_payload(term.evidence),
            }
            for term in overview.key_terms
        ],
    }


def _documents_dir(request: Request) -> Any:
    return request.app.state.settings.documents_dir


@router.get("/documents/{document_id}/overview")
async def get_overview(request: Request, document_id: str) -> Any:
    """The stored overview, or a 404 that says none exists. Generates nothing."""
    from app.api.documents import _require_ir

    # The IR is needed for its `content_hash` and `pipeline_version` — the two
    # halves of the cache address — and for nothing else. `_require_ir` extracts
    # when there is no cached IR, which is the same cost the reader already paid
    # to see the paper; no provider is involved either way.
    result, failure = await _require_ir(request, document_id)
    if failure is not None:
        return failure
    ir, _summary = result

    overview = read_overview(
        _documents_dir(request),
        content_hash=ir.content_hash,
        ir_pipeline_version=ir.pipeline_version,
        target_language=request.query_params.get("target_language", "zh-CN"),
    )
    if overview is None:
        return error_response(
            404, "OVERVIEW_NOT_FOUND",
            "This paper has no reader overview yet.",
        )
    return _payload(overview, cached=True)


@router.post("/documents/{document_id}/overview")
async def create_overview(
    request: Request, document_id: str, payload: GenerateOverview
) -> Any:
    """Generate one. **The only route in the application that spends on a reader's behalf.**"""
    from app.api.documents import _require_ir
    from app.llm.detection import resolve_provider
    from app.llm.errors import LLMError, sanitize_message

    result, failure = await _require_ir(request, document_id)
    if failure is not None:
        return failure
    ir, _summary = result

    directory = _documents_dir(request)
    if not payload.force:
        cached = read_overview(
            directory,
            content_hash=ir.content_hash,
            ir_pipeline_version=ir.pipeline_version,
            target_language=payload.target_language,
        )
        if cached is not None:
            # Already paid for, and the paper has not changed. Returning it is
            # both cheaper and more honest than producing a second opinion.
            return _payload(cached, cached=True)

    from app.api.profiles import get_profile_store

    profiles = get_profile_store(request)
    try:
        profile = profiles.get_profile(payload.profile_id)
        config = profiles.to_provider_config(payload.profile_id)
    except Exception:  # noqa: BLE001 - unknown profile, or the credential store is down
        return error_response(404, "NOT_FOUND", "No such provider profile.")

    provider = await resolve_provider(config, profile.protocol)
    from app.llm import accounting

    try:
        with accounting.operation("reader_overview"):
            outcome = await generate_overview(
                ir, provider,
                target_language=payload.target_language,
                provider_base_url=profile.base_url,
            )
    except LLMError as exc:
        return error_response(
            _STATUS.get(exc.code, 502), exc.code, sanitize_message(exc.message)
        )

    from datetime import datetime, timezone

    overview = outcome.overview
    overview.created_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()

    if overview.is_usable():
        write_overview(directory, overview)
    return _payload(overview, cached=False)


_STATUS = {"AUTHENTICATION": 401, "PERMISSION": 403, "RATE_LIMIT": 429,
           "BAD_REQUEST": 400, "TIMEOUT": 504, "NETWORK": 502}
