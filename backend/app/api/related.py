"""Related papers over HTTP.

    GET  /documents/{id}/related           references, citing and similar work
    GET  /documents/{id}/related/search    a free-text search
    POST /documents/{id}/related/explain   one sentence each on how they relate
    POST /documents/{id}/related/import    fetch an open-access PDF into the library

All of it needs a `search` profile; without one the answer is
`409 SEARCH_NOT_CONFIGURED`, and nothing leaves the machine.
"""

from __future__ import annotations

import ipaddress
from typing import Any
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict

from app.errors import error_response
from app.related import sources as related_sources
from app.related.service import gather, link_references, read_cache, write_cache
from app.related.sources import SearchError, resolve_search_service, source_for

router = APIRouter(tags=["related"])

_STATUS = {
    "SEARCH_AUTH_FAILED": 502,
    "SEARCH_RATE_LIMITED": 429,
    "SEARCH_TIMEOUT": 504,
    "SEARCH_UNREACHABLE": 502,
    "SEARCH_ERROR": 502,
    "SEARCH_UNSUPPORTED": 422,
}


def _search_service(request: Request, profile_id: str | None):
    from app.api.profiles import get_profile_store

    store = get_profile_store(request)
    if not profile_id:
        candidates = store.list_profiles("search")
        if not candidates:
            return None, error_response(
                409, "SEARCH_NOT_CONFIGURED",
                "Related-paper search is off. Add a literature-search profile in settings to turn it on.",
            )
        profile_id = candidates[0].id
    try:
        return resolve_search_service(store, profile_id), None
    except SearchError as exc:
        return None, _search_failure(exc)


def _search_failure(exc: SearchError) -> Any:
    return error_response(_STATUS.get(exc.code, 502), exc.code, exc.message)


@router.get("/documents/{document_id}/related")
async def related(request: Request, document_id: str) -> Any:
    from app.api.documents import _require_ir

    result, failure = await _require_ir(request, document_id)
    if failure is not None:
        return failure
    ir, _summary = result
    service, failure = _search_service(request, request.query_params.get("profile_id"))
    if failure is not None:
        return failure

    directory = request.app.state.settings.documents_dir
    refresh = request.query_params.get("refresh") in ("1", "true")
    if not refresh:
        cached = read_cache(directory, ir.content_hash, service.protocol)
        if cached is not None:
            # Paragraph ids belong to one extraction. The paper may have been
            # parsed again since (MinerU replacing the built-in reading), and
            # stored links would then put "本文引用处" on the wrong sentence.
            cached.links = link_references(ir, cached.references)
            return {**cached.payload(), "cached": True}
    try:
        found = await gather(ir, source_for(service))
    except SearchError as exc:
        return _search_failure(exc)
    old = read_cache(directory, ir.content_hash, service.protocol)
    if old is not None:
        # Explanations already paid for survive a refresh.
        found.relations = {k: v for k, v in old.relations.items() if found.find(k) is not None}
    write_cache(directory, ir.content_hash, found)
    return {**found.payload(), "cached": False}


@router.get("/documents/{document_id}/related/search")
async def related_search(request: Request, document_id: str) -> Any:
    query = (request.query_params.get("q") or "").strip()
    if not query:
        return error_response(400, "BAD_REQUEST", "Say what to search for.")
    if len(query) > 300:
        return error_response(400, "BAD_REQUEST", "The query is too long.")
    service, failure = _search_service(request, request.query_params.get("profile_id"))
    if failure is not None:
        return failure
    try:
        works = await source_for(service).search(query, 15)
    except SearchError as exc:
        return _search_failure(exc)
    return {"source": service.protocol, "query": query,
            "papers": [{**w.payload(), "kind": "search"} for w in works]}


class ExplainRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    profile_id: str
    keys: list[str]
    search_profile_id: str | None = None


@router.post("/documents/{document_id}/related/explain")
async def related_explain(request: Request, document_id: str, payload: ExplainRequest) -> Any:
    """Explain the given candidates — one model call per eight, cached."""
    from app.api.bilingual import _provider_for
    from app.api.documents import _require_ir
    from app.llm.errors import LLMError, sanitize_message
    from app.related.explain import explain

    result, failure = await _require_ir(request, document_id)
    if failure is not None:
        return failure
    ir, _summary = result
    service, failure = _search_service(request, payload.search_profile_id)
    if failure is not None:
        return failure
    directory = request.app.state.settings.documents_dir
    cached = read_cache(directory, ir.content_hash, service.protocol)
    if cached is None:
        return error_response(409, "RELATED_NOT_LOADED", "Load the related papers first.")

    wanted = [w for key in payload.keys[:24] if (w := cached.find(key)) is not None and key not in cached.relations]
    if wanted:
        resolved, failure = await _provider_for(request, payload.profile_id)
        if failure is not None:
            return failure
        provider, _profile = resolved
        try:
            cached.relations.update(await explain(ir, wanted, provider))
        except LLMError as exc:
            return error_response(502, exc.code, sanitize_message(exc.message))
        write_cache(directory, ir.content_hash, cached)
    return {"relations": {k: cached.relations[k] for k in payload.keys if k in cached.relations}}


class ImportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: str
    search_profile_id: str | None = None


def _public_http_url(url: str) -> bool:
    """Only a public http(s) address — never this machine or a private network."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return False
    host = parsed.hostname.lower()
    if host in ("localhost",) or host.endswith(".local"):
        return False
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return True
    return address.is_global


@router.post("/documents/{document_id}/related/import", status_code=201)
async def related_import(request: Request, document_id: str, payload: ImportRequest) -> Any:
    """Fetch a candidate's open-access PDF and add it to the library.

    Only a URL the index itself returned for a paper in this document's cached
    results can be fetched — the client never names a URL.
    """
    from app.api.documents import _require_ir, _validate_pdf_bytes, document_payload, get_document_store

    result, failure = await _require_ir(request, document_id)
    if failure is not None:
        return failure
    ir, _summary = result
    service, failure = _search_service(request, payload.search_profile_id)
    if failure is not None:
        return failure
    settings = request.app.state.settings
    cached = read_cache(settings.documents_dir, ir.content_hash, service.protocol)
    work = cached.find(payload.key) if cached is not None else None
    if work is None:
        return error_response(404, "NOT_FOUND", "That paper is not among this document's related papers.")
    if not work.oa_pdf_url or not _public_http_url(work.oa_pdf_url):
        return error_response(
            409, "NO_OPEN_ACCESS_PDF",
            "No open-access PDF is listed for this paper. Open its page to get it.",
        )

    limit = settings.max_upload_bytes
    try:
        async with httpx.AsyncClient(
            transport=related_sources.TRANSPORT, timeout=httpx.Timeout(60.0, connect=15.0),
            follow_redirects=True, headers={"User-Agent": "AcademicPDFCopilot/0.1 (local reader)"},
        ) as client:
            async with client.stream("GET", work.oa_pdf_url) as response:
                if response.status_code >= 400:
                    return error_response(502, "DOWNLOAD_FAILED", f"The PDF host answered HTTP {response.status_code}.")
                if not _public_http_url(str(response.url)):
                    return error_response(502, "DOWNLOAD_FAILED", "The PDF link redirected somewhere it may not go.")
                chunks: list[bytes] = []
                size = 0
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > limit:
                        return error_response(413, "PAYLOAD_TOO_LARGE", "The PDF is larger than the import limit.")
                    chunks.append(chunk)
    except httpx.HTTPError as exc:
        return error_response(502, "DOWNLOAD_FAILED", f"Could not download the PDF: {type(exc).__name__}.")

    data = b"".join(chunks)
    ok, code, detail = _validate_pdf_bytes(data)
    if not ok:
        return error_response(422, "NOT_A_PDF", "The link did not lead to a PDF (often a publisher's login page).")
    store = get_document_store(request)
    safe = "".join(c for c in work.title if c.isalnum() or c in " -_")[:80].strip() or "paper"
    record = store.create_document(name=f"{safe}.pdf", page_count=int(detail), is_upload=True)
    store.source_file(record.id).write_bytes(data)
    return document_payload(store, record)


@router.get("/related/web-models")
async def related_web_models(request: Request) -> Any:
    """The reader's chat profiles whose service can search the web itself.

    Answered from the URLs alone — nothing is sent anywhere.
    """
    from app.api.profiles import get_profile_store
    from app.related.llm_web import DIALECT_LABELS, detect_dialect

    models = []
    for profile in get_profile_store(request).list_profiles("llm"):
        found = detect_dialect(profile.base_url, profile.protocol)
        models.append({
            "profile_id": profile.id,
            "name": profile.name,
            "model": profile.model,
            "base_url": profile.base_url,
            "supported": found is not None,
            "via": DIALECT_LABELS[found[0]] if found else None,
        })
    return {"models": models}
