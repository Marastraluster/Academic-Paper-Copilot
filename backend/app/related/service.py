"""Find the open paper in an index, and what surrounds it.

1. **Identify.** A DOI or arXiv id printed on the first pages is unambiguous and
   is tried first; the title is the fallback, accepted only when the index's top
   hit matches it closely. A paper that cannot be identified says so — showing
   another paper's references would be worse than showing none.
2. **Gather** three lists: what it cites (*参考文献*), what cites it (*后续工作*,
   most-cited first), and what the index considers similar (*主题相似*).
3. **Tie references to the text.** Each reference is matched to the paper's own
   bibliography entry by title, and through its ``[n]`` marker to the first body
   paragraph that cites it — so "本文引用处" can put the reader on the sentence.

Results are cached per paper and index; a refresh is the reader's choice.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.document.models import DocumentIR
from app.related.sources import MATCH_THRESHOLD, SearchError, Work, normalize_title, title_similarity

REFERENCE_LIMIT = 60
CITING_LIMIT = 15
SIMILAR_LIMIT = 15

_DOI = re.compile(r"\b(10\.\d{4,9}/[^\s\"<>,;]+[^\s\"<>,;.)\]])", re.IGNORECASE)
_ARXIV = re.compile(r"arXiv:\s*(\d{4}\.\d{4,5})(?:v\d+)?", re.IGNORECASE)
_LEAD_MARKER = re.compile(r"^\s*\[(\d{1,4})\]")
_ENTRY_MARKER = re.compile(r"(?:^|\s)\[(\d{1,4})\]\s")
_CITATION = re.compile(r"\[([\d\s,–\-]+)\]")


def find_identifier(ir: DocumentIR) -> str | None:
    """A DOI the paper prints about itself, from metadata or its first two pages."""
    texts: list[str] = []
    for value in (ir.metadata.subject, ir.metadata.title):
        if value:
            texts.append(value)
    for page in ir.pages[:2]:
        for block in page.blocks:
            texts.append(block.text or "")
    joined = "\n".join(texts)
    match = _DOI.search(joined)
    if match:
        return match.group(1).rstrip(".")
    arxiv = _ARXIV.search(joined)
    if arxiv:
        # arXiv registers a DOI for every paper; both indexes resolve it.
        return f"10.48550/arXiv.{arxiv.group(1)}"
    return None


def paper_title(ir: DocumentIR) -> str | None:
    if ir.metadata.title:
        return ir.metadata.title
    return None


def _expand(marker: str) -> set[int]:
    numbers: set[int] = set()
    for part in re.split(r"[,\s]+", marker.strip()):
        if not part:
            continue
        span = re.split(r"[–\-]", part)
        try:
            if len(span) == 2 and span[0] and span[1]:
                low, high = int(span[0]), int(span[1])
                if 0 < high - low < 50:
                    numbers.update(range(low, high + 1))
            else:
                numbers.add(int(span[0]))
        except ValueError:
            continue
    return numbers


def _overlap(title: str, entry: str) -> float:
    """How much of the title's words appear in the bibliography entry."""
    words = [w for w in normalize_title(title).split() if len(w) > 2]
    if not words:
        return 0.0
    haystack = set(normalize_title(entry).split())
    return sum(1 for w in words if w in haystack) / len(words)


@dataclass
class TextLinks:
    """Where a reference lives in the paper: its entry, and the first citation."""

    entry_paragraph_id: str | None = None
    marker: int | None = None
    cited_in_paragraph_id: str | None = None


@dataclass(frozen=True)
class _Entry:
    """One bibliography entry, and the paragraph it was read from."""

    id: str
    text: str


def _bibliography_entries(paragraphs: list[Any]) -> list[_Entry]:
    """One entry per reference, even when extraction ran a column of them together.

    The built-in extractor can return a whole column of ``[1] … [2] …`` as one
    paragraph. Matched whole, every title lands on that paragraph and takes its
    first marker — so it is cut at its markers, where they count upwards.
    """
    entries: list[_Entry] = []
    for paragraph in paragraphs:
        text = paragraph.text
        starts: list[int] = []
        last = 0
        for match in _ENTRY_MARKER.finditer(text):
            number = int(match.group(1))
            if (not starts and text[:match.start(1) - 1].strip()) or number <= last:
                continue  # prose before the first marker, or a citation inside an entry
            starts.append(match.start(1) - 1)
            last = number
        if len(starts) < 2:
            entries.append(_Entry(paragraph.id, text))
            continue
        for begin, end in zip(starts, [*starts[1:], len(text)]):
            entries.append(_Entry(paragraph.id, text[begin:end].strip()))
    return entries


def link_references(ir: DocumentIR, works: list[Work]) -> dict[str, TextLinks]:
    references = {s.id for s in ir.sections if s.is_references}
    entries = _bibliography_entries([p for p in ir.paragraphs if p.section_id in references])
    body = [p for p in ir.paragraphs if p.section_id not in references]

    first_citation: dict[int, str] = {}
    for paragraph in body:
        for match in _CITATION.finditer(paragraph.text):
            for number in _expand(match.group(1)):
                first_citation.setdefault(number, paragraph.id)

    links: dict[str, TextLinks] = {}
    for work in works:
        best, score = None, 0.0
        for entry in entries:
            s = _overlap(work.title, entry.text)
            if s > score:
                best, score = entry, s
        if best is None or score < 0.6:
            continue
        lead = _LEAD_MARKER.match(best.text)
        marker = int(lead.group(1)) if lead else None
        links[work.key] = TextLinks(
            entry_paragraph_id=best.id,
            marker=marker,
            cited_in_paragraph_id=first_citation.get(marker) if marker is not None else None,
        )
    return links


@dataclass
class RelatedResult:
    source: str
    identified: Work | None
    references: list[Work] = field(default_factory=list)
    citing: list[Work] = field(default_factory=list)
    similar: list[Work] = field(default_factory=list)
    links: dict[str, TextLinks] = field(default_factory=dict)
    relations: dict[str, str] = field(default_factory=dict)
    fetched_at: float = field(default_factory=time.time)
    #: How the paper was looked up — shown so the reader knows what was sent.
    query: dict[str, str | None] = field(default_factory=dict)

    def all_works(self) -> list[Work]:
        return [*self.references, *self.citing, *self.similar]

    def find(self, key: str) -> Work | None:
        return next((w for w in self.all_works() if w.key == key), None)

    def payload(self) -> dict[str, Any]:
        def row(work: Work, kind: str) -> dict[str, Any]:
            link = self.links.get(work.key)
            return {
                **work.payload(),
                "kind": kind,
                "entry_paragraph_id": link.entry_paragraph_id if link else None,
                "cited_in_paragraph_id": link.cited_in_paragraph_id if link else None,
                "marker": link.marker if link else None,
                "relation": self.relations.get(work.key),
            }

        return {
            "source": self.source,
            "identified": self.identified.payload() if self.identified else None,
            "query": self.query,
            "fetched_at": self.fetched_at,
            "papers": [
                *(row(w, "reference") for w in self.references),
                *(row(w, "citing") for w in self.citing),
                *(row(w, "similar") for w in self.similar),
            ],
        }


async def gather(ir: DocumentIR, source: Any) -> RelatedResult:
    doi = find_identifier(ir)
    title = paper_title(ir)
    result = RelatedResult(source=source.name, identified=None, query={"doi": doi, "title": title})
    if not doi and not title:
        return result
    if hasattr(source, "overview"):
        return await _gather_overview(ir, source, result, title, doi)
    work = await source.identify(title, doi)
    result.identified = work
    if work is None:
        return result
    result.references = await source.references(work, REFERENCE_LIMIT)
    result.citing = await source.citing(work, CITING_LIMIT)
    try:
        result.similar = await source.similar(work, SIMILAR_LIMIT)
    except SearchError:
        # Recommendations are the most rate-limited call; the other two lists
        # are still worth showing without them.
        result.similar = []
    seen = {w.key for w in result.references} | {w.key for w in result.citing} | {work.key}
    result.similar = [w for w in result.similar if w.key not in seen]
    result.links = link_references(ir, result.references)
    return result


async def _gather_overview(
    ir: DocumentIR, source: Any, result: RelatedResult, title: str | None, doi: str | None
) -> RelatedResult:
    """One web-searching model call, then checked against the paper itself."""
    work, references, citing, similar = await source.overview(title, doi, (40, CITING_LIMIT, SIMILAR_LIMIT))
    if work is not None and title and not doi and title_similarity(work.title, title) < MATCH_THRESHOLD:
        work = None  # it found some other paper
    result.identified = work
    if work is not None and doi and work.doi and work.doi.lower() != doi.lower():
        if not title or title_similarity(work.title, title) < MATCH_THRESHOLD:
            work = None
    links = link_references(ir, references)
    if any(s.is_references for s in ir.sections):
        # A reference the paper does not list is not one of its references.
        references = [w for w in references if w.key in links]
        for reference in references:
            # The paper's own bibliography vouches for it, whatever the search
            # returned: it exists, though its link is still the model's word.
            reference.verified = True
    result.references = references
    seen = {w.key for w in references} | ({work.key} if work else set())
    result.citing = [w for w in citing if w.key not in seen]
    seen |= {w.key for w in result.citing}
    result.similar = [w for w in similar if w.key not in seen]
    result.links = links
    return result


# --- cache ------------------------------------------------------------------


def cache_path(documents_dir: Path, content_hash: str, source: str) -> Path:
    return Path(documents_dir) / "_cache" / "related" / f"{content_hash}_{source}.json"


def _work_from(raw: dict[str, Any]) -> Work:
    return Work(**{k: raw.get(k) for k in (
        "key", "title", "authors", "year", "venue", "doi", "url", "abstract", "cited_by", "oa_pdf_url",
        "verified",
    )})


def write_cache(documents_dir: Path, content_hash: str, result: RelatedResult) -> None:
    path = cache_path(documents_dir, content_hash, result.source)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {
        "source": result.source,
        "identified": result.identified.payload() if result.identified else None,
        "references": [w.payload() for w in result.references],
        "citing": [w.payload() for w in result.citing],
        "similar": [w.payload() for w in result.similar],
        "links": {k: vars(v) for k, v in result.links.items()},
        "relations": result.relations,
        "fetched_at": result.fetched_at,
        "query": result.query,
    }
    handle, temporary = tempfile.mkstemp(prefix=".related-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as file:
            json.dump(data, file, ensure_ascii=False)
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def read_cache(documents_dir: Path, content_hash: str, source: str) -> RelatedResult | None:
    path = cache_path(documents_dir, content_hash, source)
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return RelatedResult(
            source=data["source"],
            identified=_work_from(data["identified"]) if data.get("identified") else None,
            references=[_work_from(w) for w in data.get("references", [])],
            citing=[_work_from(w) for w in data.get("citing", [])],
            similar=[_work_from(w) for w in data.get("similar", [])],
            links={k: TextLinks(**v) for k, v in (data.get("links") or {}).items()},
            relations=dict(data.get("relations") or {}),
            fetched_at=float(data.get("fetched_at") or 0),
            query=dict(data.get("query") or {}),
        )
    except (OSError, ValueError, KeyError, TypeError):
        return None
