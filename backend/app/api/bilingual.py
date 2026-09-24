"""Paragraph-aligned bilingual reading over HTTP.

Three routes, and the split is the product rule:

    GET  /bilingual-text        reads the cache, and **never reaches a provider**
    POST /bilingual-text        generates, validates, caches — and costs money

A `GET` that finds nothing answers 404 with the *plan* in its detail — how many
paragraphs, how many calls, how many characters — so the column can tell the
reader what making one would cost without a second request, and without guessing:
the numbers come from the same `plan()` the pipeline runs.

**Not `/api/documents/{id}/bilingual`**: that path already serves the 2N-page dual
*PDF* ("Interleaved (dual) output — for export", `app/api/documents.py`), which
the export menu downloads and two tests of an earlier task pin. The artifact here
is the *text* sibling of that PDF, and the name says so rather than making one URL
mean two things.

"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict

from app.bilingual.cache import read_bilingual, write_bilingual
from app.bilingual.models import BilingualArtifact
from app.bilingual.pipeline import generate_bilingual, plan
from app.errors import error_response

router = APIRouter(tags=["bilingual"])

#: Generations currently running, keyed by (content_hash, target_language).
#: A reader who presses the button twice — or two tabs doing the same thing —
#: must not pay twice for the same paper, and a second run would also race the
#: first one's write.
_IN_FLIGHT: set[tuple[str, str]] = set()
_IN_FLIGHT_LOCK = asyncio.Lock()


class GenerateBilingual(BaseModel):
    model_config = ConfigDict(extra="forbid")

    profile_id: str
    target_language: str = "zh-CN"
    #: Regenerate even though a compatible artifact exists.
    force: bool = False


def _payload(artifact: BilingualArtifact, *, cached: bool) -> dict[str, Any]:
    """Everything the column renders, and nothing that is not the reader's.

    The source text travels with each paragraph because the column shows it
    verbatim beside the translation — it is the same text the client already has
    in its IR, and sending it again is what lets a pair be rendered without the
    two halves arriving from different places.
    """
    return {
        "status": artifact.status,
        "cached": cached,
        "content_hash": artifact.content_hash,
        "target_language": artifact.target_language,
        "provider_model": artifact.provider_model,
        "created_at": artifact.created_at,
        "input_tokens": artifact.input_tokens,
        "output_tokens": artifact.output_tokens,
        "notes": list(artifact.notes),
        "total_paragraphs": artifact.translatable_count(),
        "translated_paragraphs": artifact.translated_count(),
        "sections": [
            {
                "section_id": section.section_id,
                "title": section.title,
                "title_translated": section.title_translated,
                "level": section.level,
                "page_number": section.page_number,
                "is_references": section.is_references,
            }
            for section in artifact.sections
        ],
        "paragraphs": [
            {
                "paragraph_id": paragraph.paragraph_id,
                "page_number": paragraph.page_number,
                "section_id": paragraph.section_id,
                "source_text": paragraph.source_text,
                "translated_text": paragraph.translated_text,
                "status": paragraph.status,
                "note": paragraph.note,
                # PDF points, so the client can draw and scroll to the paragraph
                # it already has — never a rectangle a model supplied.
                "bboxes": [list(box) for box in paragraph.bboxes],
            }
            for paragraph in artifact.paragraphs
        ],
        "blocks": [
            {
                "block_id": block.block_id,
                "page_number": block.page_number,
                "layout_class": block.layout_class,
                "text": block.text,
                "bbox": list(block.bbox) if block.bbox else None,
            }
            for block in artifact.blocks
        ],
    }


@router.get("/documents/{document_id}/bilingual-text")
async def get_bilingual_text(request: Request, document_id: str) -> Any:
    """The stored artifact, or a 404 that says none exists. Generates nothing."""
    from app.api.documents import _require_ir

    result, failure = await _require_ir(request, document_id)
    if failure is not None:
        return failure
    ir, _summary = result

    artifact = read_bilingual(
        request.app.state.settings.documents_dir,
        content_hash=ir.content_hash,
        ir_pipeline_version=ir.pipeline_version,
        target_language=request.query_params.get("target_language", "zh-CN"),
    )
    if artifact is None:
        # The plan rides with the answer that there is nothing yet: the column
        # can then tell the reader what making one would cost from the single
        # read it already made, rather than asking a second time (DS-DOC-006
        # AC-P0-15), and the numbers come from the same `plan()` the pipeline
        # runs — the work itself, not an estimate of it.
        work = plan(ir)
        return error_response(
            404,
            "BILINGUAL_TEXT_NOT_FOUND",
            "This paper has no paragraph-aligned reading yet.",
            {
                "plan": {
                    "paragraphs": work.paragraph_count,
                    "batches": work.batch_count,
                    "characters": work.character_count,
                    "sections": len(work.headings),
                    "skipped": len(work.skipped),
                }
            },
        )
    return _payload(artifact, cached=True)


@router.post("/documents/{document_id}/bilingual-text")
async def create_bilingual_text(
    request: Request, document_id: str, payload: GenerateBilingual
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
        cached = read_bilingual(
            directory,
            content_hash=ir.content_hash,
            ir_pipeline_version=ir.pipeline_version,
            target_language=payload.target_language,
        )
        if cached is not None:
            # Already paid for, and the paper has not changed.
            return _payload(cached, cached=True)

    key = (ir.content_hash, payload.target_language)
    async with _IN_FLIGHT_LOCK:
        if key in _IN_FLIGHT:
            return error_response(
                409,
                "GENERATION_ALREADY_IN_PROGRESS",
                "A paragraph translation for this paper is already running.",
            )
        _IN_FLIGHT.add(key)

    from app.api.profiles import get_profile_store

    profiles = get_profile_store(request)
    try:
        profile = profiles.get_profile(payload.profile_id)
        config = profiles.to_provider_config(payload.profile_id)
    except Exception:  # noqa: BLE001 - unknown profile, or the credential store is down
        async with _IN_FLIGHT_LOCK:
            _IN_FLIGHT.discard(key)
        return error_response(404, "NOT_FOUND", "No such provider profile.")

    try:
        provider = await resolve_provider(config, profile.protocol)
        from app.llm import accounting

        with accounting.operation("bilingual_text"):
            outcome = await generate_bilingual(
                ir, provider,
                target_language=payload.target_language,
                provider_base_url=profile.base_url,
                glossary=read_glossary(request, document_id),
            )
    except LLMError as exc:
        return error_response(
            _STATUS.get(exc.code, 502), exc.code, sanitize_message(exc.message)
        )
    finally:
        async with _IN_FLIGHT_LOCK:
            _IN_FLIGHT.discard(key)

    from datetime import datetime, timezone

    artifact = outcome.artifact
    artifact.created_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    if artifact.is_usable():
        write_bilingual(directory, artifact)
    return _payload(artifact, cached=False)


def read_glossary(request: Request, document_id: str) -> list[str] | None:
    """The context pipeline's terminology, when that artifact happens to exist.

    Best effort and non-binding: it was produced for a *translation engine*
    choosing the right sense of a term, so the prompt offers it as a hint and the
    paper's own wording is what wins. Absent is the normal case — that artifact is
    made by a different pipeline the reader may never have run.
    """
    try:
        from app.api.documents import get_document_store
        from app.context.persistence import read_analysis

        store = get_document_store(request)
        analysis = read_analysis(store.document_dir(document_id))
    except Exception:  # noqa: BLE001 - no artifact, or an unreadable one
        return None
    if analysis is None:
        return None

    entries: list[str] = []
    for term in analysis.glossary or []:
        source = term.source_term
        if not source:
            continue
        # An identifier the paper itself says must survive translation is a rule,
        # not a suggestion — those are the ones a model most often mangles.
        if not term.is_translatable:
            entries.append(f"{source} (keep exactly as written)")
            continue
        if term.suggested_translation:
            entries.append(f"{source} → {term.suggested_translation}")
    for acronym in analysis.acronyms or []:
        if acronym.acronym and acronym.expansion:
            entries.append(f"{acronym.acronym} = {acronym.expansion}")
    return entries or None


_STATUS = {"AUTHENTICATION": 401, "PERMISSION": 403, "RATE_LIMIT": 429,
           "BAD_REQUEST": 400, "TIMEOUT": 504, "NETWORK": 502}
