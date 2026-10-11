"""Two scholarly indexes behind one interface.

* **OpenAlex** (`api.openalex.org`). Since February 2026 nearly every request
  wants an API key — a free one carries a daily budget, and keyless calls get a
  much smaller one. The key goes in ``Authorization: Bearer``. Lookups by id or
  DOI are free; list and search calls draw on the budget, so this module fetches
  references in one batched ``filter=openalex_id:A|B|…`` call, not one each.
* **Semantic Scholar** (`api.semanticscholar.org`). Works without a key from a
  shared, heavily throttled pool; a key (``x-api-key``) gets a dedicated rate.

Both return :class:`Work`. Failures are named — a refused key, an exhausted
budget, an unreachable host — because each has a different fix.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from typing import Any
from urllib.parse import quote

import httpx

from app.llm.errors import sanitize_message
from app.storage.profiles import ServiceConfig

#: Tests replace this with an `httpx.MockTransport`; production leaves it None.
TRANSPORT: httpx.AsyncBaseTransport | None = None

OPENALEX_DEFAULT = "https://api.openalex.org"
S2_DEFAULT = "https://api.semanticscholar.org"


class SearchError(Exception):
    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = sanitize_message(message)
        super().__init__(f"{code}: {self.message}")


@dataclass
class Work:
    """One paper as an index describes it."""

    key: str
    title: str
    authors: list[str] = field(default_factory=list)
    year: int | None = None
    venue: str | None = None
    doi: str | None = None
    url: str | None = None
    abstract: str | None = None
    cited_by: int | None = None
    #: A PDF the index says is openly available — the only thing "import" fetches.
    oa_pdf_url: str | None = None
    #: Ids the index lists as this work's references / related works (OpenAlex).
    reference_keys: list[str] = field(default_factory=list)
    related_keys: list[str] = field(default_factory=list)
    #: Indexes leave this None. A web-searching model sets True only when the
    #: paper's link or DOI was among the pages its search actually returned.
    verified: bool | None = None

    def payload(self) -> dict[str, Any]:
        return {
            "key": self.key, "title": self.title, "authors": self.authors, "year": self.year,
            "venue": self.venue, "doi": self.doi, "url": self.url, "abstract": self.abstract,
            "cited_by": self.cited_by, "oa_pdf_url": self.oa_pdf_url, "verified": self.verified,
        }


def normalize_title(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (text or "").lower()).strip()


def title_similarity(a: str, b: str) -> float:
    return SequenceMatcher(None, normalize_title(a), normalize_title(b)).ratio()


#: Below this a title search's top hit is a different paper, and the reader is
#: told the paper could not be identified rather than shown someone else's.
MATCH_THRESHOLD = 0.88


class _Http:
    def __init__(self, service: ServiceConfig, base_default: str, auth: dict[str, str]) -> None:
        self.base = (service.base_url or base_default).rstrip("/")
        self.headers = {**(service.custom_headers or {}), **auth}
        self.timeout = max(10.0, float(service.timeout_s or 30.0))

    async def get(self, path: str, params: dict[str, Any] | None = None, *, allow_404: bool = False) -> Any:
        try:
            async with httpx.AsyncClient(
                transport=TRANSPORT, timeout=httpx.Timeout(self.timeout, connect=10.0),
                follow_redirects=True,
            ) as client:
                response = await client.get(f"{self.base}{path}", params=params, headers=self.headers)
        except httpx.TimeoutException as exc:
            raise SearchError("SEARCH_TIMEOUT", "The literature index timed out.") from exc
        except httpx.TransportError as exc:
            raise SearchError(
                "SEARCH_UNREACHABLE", f"Could not reach {self.base}: {type(exc).__name__}."
            ) from exc
        if response.status_code == 404 and allow_404:
            return None
        if response.status_code in (401, 403):
            raise SearchError("SEARCH_AUTH_FAILED", "The literature index refused the API key.")
        if response.status_code == 429:
            raise SearchError(
                "SEARCH_RATE_LIMITED",
                "The literature index's budget or rate limit is used up for now. "
                "A (free) API key raises it.",
            )
        if response.status_code >= 400:
            raise SearchError("SEARCH_ERROR", f"The literature index answered HTTP {response.status_code}.")
        try:
            return response.json()
        except ValueError as exc:
            raise SearchError("SEARCH_ERROR", "The literature index answered with something that is not JSON.") from exc


# --- OpenAlex -------------------------------------------------------------------

_OA_SELECT = (
    "id,display_name,publication_year,authorships,primary_location,doi,cited_by_count,"
    "abstract_inverted_index,best_oa_location,referenced_works,related_works"
)


def _short_oa(identifier: str) -> str:
    return identifier.rsplit("/", 1)[-1]


def _oa_abstract(index: Any) -> str | None:
    if not isinstance(index, dict) or not index:
        return None
    positions: list[tuple[int, str]] = []
    for word, places in index.items():
        for place in places or []:
            positions.append((int(place), word))
    return " ".join(word for _, word in sorted(positions)) or None


def _oa_work(raw: dict[str, Any]) -> Work:
    location = raw.get("primary_location") or {}
    source = location.get("source") or {}
    best = raw.get("best_oa_location") or {}
    doi = raw.get("doi")
    return Work(
        key=_short_oa(str(raw.get("id") or "")),
        title=str(raw.get("display_name") or raw.get("title") or ""),
        authors=[
            str((a.get("author") or {}).get("display_name"))
            for a in raw.get("authorships") or []
            if (a.get("author") or {}).get("display_name")
        ],
        year=raw.get("publication_year"),
        venue=source.get("display_name"),
        doi=doi.replace("https://doi.org/", "") if isinstance(doi, str) else None,
        url=doi if isinstance(doi, str) else raw.get("id"),
        abstract=_oa_abstract(raw.get("abstract_inverted_index")),
        cited_by=raw.get("cited_by_count"),
        oa_pdf_url=best.get("pdf_url"),
        reference_keys=[_short_oa(r) for r in raw.get("referenced_works") or []],
        related_keys=[_short_oa(r) for r in raw.get("related_works") or []],
    )


class OpenAlexSource:
    name = "openalex"

    def __init__(self, service: ServiceConfig) -> None:
        auth = {"Authorization": f"Bearer {service.api_key}"} if service.api_key else {}
        self.http = _Http(service, OPENALEX_DEFAULT, auth)

    async def identify(self, title: str | None, doi: str | None) -> Work | None:
        if doi:
            raw = await self.http.get(f"/works/doi:{quote(doi, safe='/')}", {"select": _OA_SELECT}, allow_404=True)
            if raw:
                return _oa_work(raw)
        if title:
            data = await self.http.get("/works", {"search": title, "per-page": 5, "select": _OA_SELECT})
            best = max(
                (_oa_work(r) for r in (data or {}).get("results") or []),
                key=lambda w: title_similarity(w.title, title),
                default=None,
            )
            if best is not None and title_similarity(best.title, title) >= MATCH_THRESHOLD:
                return best
        return None

    async def _batch(self, keys: list[str]) -> list[Work]:
        out: list[Work] = []
        for start in range(0, len(keys), 100):
            chunk = keys[start:start + 100]
            data = await self.http.get(
                "/works",
                {"filter": "openalex_id:" + "|".join(chunk), "per-page": 100, "select": _OA_SELECT},
            )
            out.extend(_oa_work(r) for r in (data or {}).get("results") or [])
        order = {key: i for i, key in enumerate(keys)}
        return sorted(out, key=lambda w: order.get(w.key, 1 << 30))

    async def references(self, work: Work, limit: int) -> list[Work]:
        return await self._batch(work.reference_keys[:limit])

    async def citing(self, work: Work, limit: int) -> list[Work]:
        data = await self.http.get(
            "/works",
            {"filter": f"cites:{work.key}", "sort": "cited_by_count:desc", "per-page": limit, "select": _OA_SELECT},
        )
        return [_oa_work(r) for r in (data or {}).get("results") or []]

    async def similar(self, work: Work, limit: int) -> list[Work]:
        return await self._batch(work.related_keys[:limit])

    async def search(self, query: str, limit: int) -> list[Work]:
        data = await self.http.get("/works", {"search": query, "per-page": limit, "select": _OA_SELECT})
        return [_oa_work(r) for r in (data or {}).get("results") or []]


# --- Semantic Scholar -------------------------------------------------------------

_S2_FIELDS = "paperId,title,authors,year,venue,externalIds,abstract,citationCount,openAccessPdf,url"


def _s2_work(raw: dict[str, Any]) -> Work:
    ids = raw.get("externalIds") or {}
    pdf = raw.get("openAccessPdf") or {}
    return Work(
        key=str(raw.get("paperId") or ""),
        title=str(raw.get("title") or ""),
        authors=[str(a.get("name")) for a in raw.get("authors") or [] if a.get("name")],
        year=raw.get("year"),
        venue=raw.get("venue") or None,
        doi=ids.get("DOI"),
        url=raw.get("url"),
        abstract=raw.get("abstract"),
        cited_by=raw.get("citationCount"),
        oa_pdf_url=pdf.get("url") or None,
    )


class SemanticScholarSource:
    name = "semantic_scholar"

    def __init__(self, service: ServiceConfig) -> None:
        auth = {"x-api-key": service.api_key} if service.api_key else {}
        self.http = _Http(service, S2_DEFAULT, auth)

    async def identify(self, title: str | None, doi: str | None) -> Work | None:
        if doi:
            raw = await self.http.get(f"/graph/v1/paper/DOI:{quote(doi, safe='/')}", {"fields": _S2_FIELDS}, allow_404=True)
            if raw and raw.get("paperId"):
                return _s2_work(raw)
        if title:
            data = await self.http.get(
                "/graph/v1/paper/search", {"query": title, "limit": 5, "fields": _S2_FIELDS}
            )
            best = max(
                (_s2_work(r) for r in (data or {}).get("data") or []),
                key=lambda w: title_similarity(w.title, title),
                default=None,
            )
            if best is not None and title_similarity(best.title, title) >= MATCH_THRESHOLD:
                return best
        return None

    async def references(self, work: Work, limit: int) -> list[Work]:
        data = await self.http.get(
            f"/graph/v1/paper/{work.key}/references", {"fields": _S2_FIELDS, "limit": limit}
        )
        return [_s2_work(r["citedPaper"]) for r in (data or {}).get("data") or []
                if (r.get("citedPaper") or {}).get("paperId")]

    async def citing(self, work: Work, limit: int) -> list[Work]:
        data = await self.http.get(
            f"/graph/v1/paper/{work.key}/citations", {"fields": _S2_FIELDS, "limit": 100}
        )
        found = [_s2_work(r["citingPaper"]) for r in (data or {}).get("data") or []
                 if (r.get("citingPaper") or {}).get("paperId")]
        return sorted(found, key=lambda w: -(w.cited_by or 0))[:limit]

    async def similar(self, work: Work, limit: int) -> list[Work]:
        data = await self.http.get(
            f"/recommendations/v1/papers/forpaper/{work.key}", {"fields": _S2_FIELDS, "limit": limit},
            allow_404=True,
        )
        return [_s2_work(r) for r in (data or {}).get("recommendedPapers") or []]

    async def search(self, query: str, limit: int) -> list[Work]:
        data = await self.http.get(
            "/graph/v1/paper/search", {"query": query, "limit": limit, "fields": _S2_FIELDS}
        )
        return [_s2_work(r) for r in (data or {}).get("data") or []]


def source_for(service: Any) -> Any:
    if service.protocol == "llm_web":
        from app.related.llm_web import LLMWebSource

        return LLMWebSource(service)
    if service.protocol == "semantic_scholar":
        return SemanticScholarSource(service)
    return OpenAlexSource(service)


def resolve_search_service(store: Any, profile_id: str) -> Any:
    """The config a source is built from: the profile's own, or — for an
    ``llm_web`` profile — the chat profile it points at."""
    service = store.to_service_config(profile_id, kind="search")
    if service.protocol == "llm_web":
        from app.related.llm_web import resolve

        return resolve(store, service)
    return service
