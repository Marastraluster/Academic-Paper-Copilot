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

from app.bilingual import glossary as paper_glossary
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
                "latex": block.latex,
                "html": block.html,
                "image_path": block.image_path,
                "caption_of": block.caption_of,
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

    from app.bilingual import jobs

    target_language = request.query_params.get("target_language", "zh-CN")
    directory = request.app.state.settings.documents_dir
    job = jobs.get(ir.content_hash, target_language)
    # While a background job runs, what it has so far is the reading: the
    # column fills in batch by batch instead of waiting for the whole paper.
    if job is not None and job.status in jobs.ACTIVE:
        live = jobs.snapshot(ir, directory, target_language)
        if live is not None:
            body = _payload(live, cached=False)
            body["job"] = job.payload()
            return body

    artifact = read_bilingual(
        directory,
        content_hash=ir.content_hash,
        ir_pipeline_version=ir.pipeline_version,
        target_language=target_language,
    )
    if artifact is None:
        # A job that stopped short (closed app, refused key) left its batches.
        stopped = jobs.snapshot(ir, directory, target_language)
        if stopped is not None and stopped.paragraphs:
            body = _payload(stopped, cached=True)
            body["job"] = job.payload() if job is not None else None
            body["resumable"] = True
            return body
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
    from app.bilingual import jobs

    async with _IN_FLIGHT_LOCK:
        if key in _IN_FLIGHT or jobs.is_running(*key):
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
                terms=paper_glossary.read_terms(directory, ir.content_hash, payload.target_language),
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



# --- background jobs ------------------------------------------------------------


class StartJob(BaseModel):
    model_config = ConfigDict(extra="forbid")
    profile_id: str
    target_language: str = "zh-CN"
    #: Start over even though a finished reading exists.
    force: bool = False
    #: Batches in flight at once; bounded by `jobs.MAX_CONCURRENCY`.
    concurrency: int = 2


class Retranslate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    profile_id: str
    target_language: str = "zh-CN"


async def _provider_for(request: Request, profile_id: str):
    """``(provider, profile)`` or ``(None, error_response)``."""
    from app.api.profiles import get_profile_store
    from app.llm.detection import resolve_provider
    from app.llm.errors import LLMError, sanitize_message

    profiles = get_profile_store(request)
    try:
        profile = profiles.get_profile(profile_id)
        if profile.kind != "llm":
            return None, error_response(400, "BAD_REQUEST", "That profile is not a chat model.")
        config = profiles.to_provider_config(profile_id)
    except Exception:  # noqa: BLE001 - unknown profile, or the credential store is down
        return None, error_response(404, "NOT_FOUND", "No such provider profile.")
    try:
        provider = await resolve_provider(config, profile.protocol)
    except LLMError as exc:
        return None, error_response(_STATUS.get(exc.code, 502), exc.code, sanitize_message(exc.message))
    return (provider, profile), None


@router.post("/documents/{document_id}/bilingual-text/jobs", status_code=202)
async def start_bilingual_job(request: Request, document_id: str, payload: StartJob) -> Any:
    """Translate in the background; ``GET …/bilingual-text`` shows it filling in.

    Started again after a stop, it resumes: only batches with a paragraph still
    missing are sent.
    """
    from app.api.documents import _require_ir
    from app.bilingual import jobs
    from app.bilingual.cache import delete_partial

    result, failure = await _require_ir(request, document_id)
    if failure is not None:
        return failure
    ir, _summary = result
    directory = request.app.state.settings.documents_dir
    key = (ir.content_hash, payload.target_language)

    running = jobs.get(*key)
    if running is not None and running.status in jobs.ACTIVE:
        return running.payload()
    async with _IN_FLIGHT_LOCK:
        if key in _IN_FLIGHT:
            return error_response(
                409, "GENERATION_ALREADY_IN_PROGRESS",
                "A paragraph translation for this paper is already running.",
            )

    if payload.force:
        delete_partial(directory, ir.content_hash, payload.target_language)
    else:
        cached = read_bilingual(
            directory, content_hash=ir.content_hash,
            ir_pipeline_version=ir.pipeline_version, target_language=payload.target_language,
        )
        if cached is not None and cached.status == "READY":
            return {"status": "completed", "cached": True, "document_id": document_id}

    resolved, failure = await _provider_for(request, payload.profile_id)
    if failure is not None:
        return failure
    provider, profile = resolved
    job = jobs.start(
        document_id=document_id,
        ir=ir,
        provider=provider,
        documents_dir=directory,
        target_language=payload.target_language,
        provider_base_url=profile.base_url,
        glossary=read_glossary(request, document_id),
        concurrency=payload.concurrency,
        make_glossary=True,
    )
    return job.payload()


@router.get("/documents/{document_id}/bilingual-text/jobs")
async def bilingual_job_status(request: Request, document_id: str) -> Any:
    from app.api.documents import _require_ir
    from app.bilingual import jobs

    result, failure = await _require_ir(request, document_id)
    if failure is not None:
        return failure
    ir, _summary = result
    job = jobs.get(ir.content_hash, request.query_params.get("target_language", "zh-CN"))
    if job is None:
        return {"status": "idle", "document_id": document_id}
    return job.payload()


@router.delete("/documents/{document_id}/bilingual-text/jobs")
async def stop_bilingual_job(request: Request, document_id: str) -> Any:
    """Stop a running job. What it translated stays, and a restart resumes."""
    from app.api.documents import _require_ir
    from app.bilingual import jobs

    result, failure = await _require_ir(request, document_id)
    if failure is not None:
        return failure
    ir, _summary = result
    job = await jobs.stop(ir.content_hash, request.query_params.get("target_language", "zh-CN"))
    return job.payload() if job is not None else {"status": "idle", "document_id": document_id}


@router.post("/documents/{document_id}/bilingual-text/paragraphs/{paragraph_id}/retranslate")
async def retranslate_paragraph(
    request: Request, document_id: str, paragraph_id: str, payload: Retranslate
) -> Any:
    """Translate one paragraph again — one call — and keep the result.

    The reader's fix for one bad paragraph, without paying for the paper again.
    """
    from app.api.documents import _require_ir
    from app.bilingual import jobs
    from app.bilingual.cache import read_partial, write_partial
    from app.bilingual.pipeline import (
        Batch,
        assemble,
        heading_views_for,
        plan,
        translate_batch,
    )
    from app.llm.errors import LLMError, sanitize_message

    result, failure = await _require_ir(request, document_id)
    if failure is not None:
        return failure
    ir, _summary = result
    work = plan(ir)
    target = next(
        (p for batch in work.batches for p in batch.paragraphs if p.id == paragraph_id), None
    )
    if target is None:
        return error_response(
            400, "BAD_REQUEST", "That paragraph is not one the reading translates."
        )
    if jobs.is_running(ir.content_hash, payload.target_language):
        return error_response(
            409, "GENERATION_ALREADY_IN_PROGRESS", "Wait for the running translation to finish."
        )

    resolved, failure = await _provider_for(request, payload.profile_id)
    if failure is not None:
        return failure
    provider, profile = resolved
    heading_views = heading_views_for(work)
    try:
        outcome = await translate_batch(
            Batch(paragraphs=[target]), heading_views, provider,
            target_language=payload.target_language,
            glossary=read_glossary(request, document_id),
            terms=paper_glossary.read_terms(
                request.app.state.settings.documents_dir, ir.content_hash, payload.target_language
            ),
        )
    except LLMError as exc:
        return error_response(_STATUS.get(exc.code, 502), exc.code, sanitize_message(exc.message))
    text = outcome.translations.get(paragraph_id)
    if not text:
        return error_response(
            502, "RETRANSLATION_FAILED",
            "The model did not return a usable translation for this paragraph.",
        )

    directory = request.app.state.settings.documents_dir
    identity = dict(
        content_hash=ir.content_hash,
        ir_pipeline_version=ir.pipeline_version,
        target_language=payload.target_language,
    )
    existing = read_bilingual(directory, **identity)
    partial = read_partial(directory, **identity)
    translated: dict[str, str] = {}
    headings: dict[str, str] = {}
    if partial is not None:
        translated.update(partial["translated"])
        headings.update(partial["headings"])
    if existing is not None:
        translated.update({p.paragraph_id: p.translated_text for p in existing.paragraphs if p.is_readable()})
        headings.update({s.section_id: s.title_translated for s in existing.sections if s.title_translated})
    translated[paragraph_id] = text

    from datetime import datetime, timezone

    artifact = assemble(
        ir, work, heading_views, translated, headings,
        target_language=payload.target_language,
        provider_model=outcome.model or (existing.provider_model if existing else ""),
        provider_base_url=profile.base_url,
        created_at=datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
    )
    if existing is not None and artifact.is_usable():
        write_bilingual(directory, artifact)
    if partial is not None or existing is None:
        write_partial(directory, translated=translated, headings=headings,
                      provider_model=artifact.provider_model, **identity)
    row = next(p for p in artifact.paragraphs if p.paragraph_id == paragraph_id)
    return {
        "paragraph_id": row.paragraph_id,
        "source_text": row.source_text,
        "translated_text": row.translated_text,
        "status": row.status,
        "provider_model": artifact.provider_model,
    }


# --- the paper's glossary ---------------------------------------------------------


class GlossaryTerm(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source: str
    target: str


class SaveGlossary(BaseModel):
    model_config = ConfigDict(extra="forbid")
    terms: list[GlossaryTerm]
    target_language: str = "zh-CN"


@router.get("/documents/{document_id}/bilingual-text/glossary")
async def get_bilingual_glossary(request: Request, document_id: str) -> Any:
    """The terms this paper is translated with. Reads a file; reaches no provider."""
    from app.api.documents import _require_ir

    result, failure = await _require_ir(request, document_id)
    if failure is not None:
        return failure
    ir, _summary = result
    target_language = request.query_params.get("target_language", "zh-CN")
    terms = paper_glossary.read_terms(
        request.app.state.settings.documents_dir, ir.content_hash, target_language
    )
    return {
        "exists": terms is not None,
        "target_language": target_language,
        "terms": [term.payload() for term in terms or []],
    }


@router.post("/documents/{document_id}/bilingual-text/glossary")
async def save_bilingual_glossary(request: Request, document_id: str, payload: SaveGlossary) -> Any:
    """Keep the reader's corrections, and un-translate exactly what they touch.

    A paragraph is affected when its source contains a term that was added,
    removed or given a different translation. Those — and only those — lose
    their translation here; starting the job again translates them, with the new
    glossary, and sends nothing else. This route itself spends nothing.
    """
    from app.api.documents import _require_ir
    from app.bilingual import jobs
    from app.bilingual.cache import delete_bilingual, read_partial, write_partial

    result, failure = await _require_ir(request, document_id)
    if failure is not None:
        return failure
    ir, _summary = result
    directory = request.app.state.settings.documents_dir
    language = payload.target_language
    if jobs.is_running(ir.content_hash, language):
        return error_response(
            409, "GENERATION_ALREADY_IN_PROGRESS", "Wait for the running translation to finish."
        )
    if len(payload.terms) > paper_glossary.MAX_STORED_TERMS:
        return error_response(
            400, "BAD_REQUEST", f"A glossary holds at most {paper_glossary.MAX_STORED_TERMS} terms."
        )

    old = paper_glossary.read_terms(directory, ir.content_hash, language) or []
    new = paper_glossary.clean([term.model_dump() for term in payload.terms])
    work = plan(ir)
    affected = paper_glossary.affected_paragraph_ids(work, paper_glossary.changed_sources(old, new))

    identity = dict(
        content_hash=ir.content_hash, ir_pipeline_version=ir.pipeline_version, target_language=language
    )
    existing = read_bilingual(directory, **identity)
    partial = read_partial(directory, **identity)
    translated: dict[str, str] = {}
    headings: dict[str, str] = {}
    model = ""
    if partial is not None:
        translated.update(partial["translated"])
        headings.update(partial["headings"])
        model = str(partial.get("provider_model") or "")
    if existing is not None:
        translated.update({p.paragraph_id: p.translated_text for p in existing.paragraphs if p.is_readable()})
        headings.update({s.section_id: s.title_translated for s in existing.sections if s.title_translated})
        model = existing.provider_model or model
    stale = affected & translated.keys()

    paper_glossary.write_terms(directory, ir.content_hash, language, new)
    if stale:
        for paragraph_id in stale:
            del translated[paragraph_id]
        # The finished reading becomes work in progress again: what is kept is
        # kept as a partial, which is exactly what a resumed job fills in.
        write_partial(directory, translated=translated, headings=headings, provider_model=model, **identity)
        delete_bilingual(directory, ir.content_hash, language)
    return {
        "exists": True,
        "target_language": language,
        "terms": [term.payload() for term in new],
        "affected_paragraphs": len(stale),
    }
