"""Scope-aware retrieval over the canonical `DocumentIR`.

The shape of a query:

```
scope → candidate set → sanitised + expanded query → BM25 → ranking
      → neighbour expansion (same section, deduplicated) → evidence bundle
```

Two properties are worth stating because they are easy to get subtly wrong.

**Scope constrains candidate generation, not the results.** Filtering after BM25
looks equivalent and is not: a query whose best matches are on page 10 would fill
the top-K with out-of-scope paragraphs, and the in-scope evidence would never have
been ranked at all.

**Neighbours are added after ranking.** Concatenating three paragraphs into one
search unit inflates its length against BM25's length normalisation, which
suppresses exactly the comprehensive sections it was meant to favour — and blurs
which paragraph actually matched.
"""

from __future__ import annotations

import hashlib
import sqlite3
import time
from pathlib import Path

from app.context.models import DocumentAnalysis
from app.document.models import DocumentIR
from app.logging import get_logger
from app.qa.index import BM25_EXPRESSION, ensure_index, index_path
from app.qa.models import (
    Diagnostics,
    EvidenceBundle,
    EvidenceItem,
    ExpansionApplied,
    Scope,
)
from app.qa.query import prepare

logger = get_logger(__name__)

#: How many ranked paragraphs to retrieve before neighbour expansion. Neutral
#: between the brief's suggested 6-12; the bundle is what a caller bounds, and a
#: neighbour can only be added from a rank that was actually returned.
DEFAULT_TOP_K = 8

#: A neighbour window is one paragraph either side. Beyond that the expansion
#: stops being "the context of the hit" and starts being a section dump.
NEIGHBOUR_RADIUS = 1


class RetrievalError(Exception):
    """Retrieval could not run, with a stable code for the API envelope."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _scope_clause(scope: Scope) -> tuple[str, list]:
    """The SQL fragment that *constrains candidates*, and its parameters.

    Applied inside the MATCH query, so an out-of-scope paragraph is never
    scored at all.
    """
    if scope.type == "whole_paper":
        return "", []
    if scope.type == "section":
        if not scope.section_id:
            raise RetrievalError("BAD_REQUEST", "A section scope needs a section_id.")
        return "AND section_id = ?", [scope.section_id]
    if scope.type == "page":
        if scope.page is None:
            raise RetrievalError("BAD_REQUEST", "A page scope needs a page number.")
        # `page_range` is stored delimited on both sides — ",3,4," — so a
        # paragraph that starts on page 3 and finishes on page 4 is found by a
        # page-4 query. Matching only the starting page would send a reader to a
        # page where the text is not visible.
        return "AND page_range LIKE ?", [f"%,{scope.page},%"]
    if scope.type == "selection":
        ids = scope.paragraph_ids or []
        if not ids:
            raise RetrievalError(
                "BAD_REQUEST", "A selection scope needs at least one paragraph id."
            )
        placeholders = ", ".join("?" for _ in ids)
        return f"AND chunk_id IN ({placeholders})", list(ids)
    raise RetrievalError("BAD_REQUEST", f"Unknown scope {scope.type!r}.")


def _row_to_item(row: sqlite3.Row, *, score: float | None) -> EvidenceItem:
    pages = [int(p) for p in str(row["page_range"]).strip(",").split(",") if p]
    block_ids = [b for b in str(row["block_ids"]).split(",") if b]
    return EvidenceItem(
        id="",  # assigned by rank in the bundle
        chunk_id=row["chunk_id"],
        kind=row["kind"],
        paragraph_id=row["chunk_id"],
        section_id=row["section_id"] or None,
        section_title=row["section_title"] or None,
        page_number=int(row["page_number"]),
        page_range=pages,
        block_ids=block_ids,
        text=row["text"],
        score=score,
        is_direct_hit=score is not None,
        is_caption=row["kind"] == "caption",
    )


def _expand_neighbours(
    ir: DocumentIR, hits: list[EvidenceItem], limit: int
) -> list[EvidenceItem]:
    """Add surrounding paragraphs *after* ranking, within the same section.

    Expansion never crosses a section boundary. In an academic PDF the paragraph
    after the Abstract is "1. Introduction", and the one after the Conclusion is
    often the bibliography — so a naive `index + 1` welds unrelated material onto
    a hit and presents it as its context.
    """
    if not hits:
        return hits

    by_id = {paragraph.id: index for index, paragraph in enumerate(ir.paragraphs)}
    paragraphs = ir.paragraphs

    additions: list[EvidenceItem] = []
    already = {item.chunk_id for item in hits}

    for hit in hits:
        position = by_id.get(hit.paragraph_id)
        if position is None:
            continue
        anchor = paragraphs[position]
        for offset in range(1, NEIGHBOUR_RADIUS + 1):
            for candidate_position in (position - offset, position + offset):
                if not 0 <= candidate_position < len(paragraphs):
                    continue
                neighbour = paragraphs[candidate_position]
                if neighbour.id in already:
                    continue
                if neighbour.section_id != anchor.section_id:
                    continue
                already.add(neighbour.id)
                additions.append(
                    EvidenceItem(
                        id="",
                        chunk_id=neighbour.id,
                        kind="paragraph",
                        paragraph_id=neighbour.id,
                        section_id=neighbour.section_id,
                        section_title=hit.section_title,
                        page_number=neighbour.page_number,
                        page_range=list(neighbour.page_range),
                        block_ids=list(neighbour.block_ids),
                        text=neighbour.text,
                        score=None,
                        is_direct_hit=False,
                    )
                )
                if len(already) >= limit:
                    return hits + additions
    return hits + additions


def retrieve(
    ir: DocumentIR,
    document_dir: Path,
    *,
    query: str,
    scope: Scope,
    analysis: DocumentAnalysis | None = None,
    top_k: int = DEFAULT_TOP_K,
    max_items: int | None = None,
) -> EvidenceBundle:
    """Retrieve source evidence for a question within a scope.

    Needs only the `DocumentIR`. `analysis` is optional and, when present, may
    add glossary and acronym expansions — never evidence, which comes from the
    document and nowhere else.
    """
    started = time.perf_counter()
    top_k = max(1, min(top_k, 50))
    limit = max_items if max_items is not None else top_k * (1 + 2 * NEIGHBOUR_RADIUS)

    stats = ensure_index(document_dir, ir)
    prepared = prepare(query, analysis)

    diagnostics = Diagnostics(
        expansions=[
            ExpansionApplied(term=term, expanded_to=expanded, source=source)
            for term, expanded, source in prepared.expansions
        ],
        index_rebuilt=stats.rebuilt,
    )

    if prepared.is_empty:
        # Nothing searchable was asked. An empty query under `selection` still has
        # an answer — the selection itself — which is handled below.
        if scope.type != "selection":
            diagnostics.code = "NO_MATCH_TOKEN"
            diagnostics.execution_time_ms = (time.perf_counter() - started) * 1000
            return EvidenceBundle(
                document_id=ir.document_id, query=query, query_normalized="",
                scope=scope, items=[], diagnostics=diagnostics,
            )

    clause, parameters = _scope_clause(scope)
    items: list[EvidenceItem] = []
    candidates = 0

    if not prepared.is_empty:
        path = index_path(Path(document_dir))
        connection = sqlite3.connect(str(path))
        connection.row_factory = sqlite3.Row
        try:
            sql = (
                "SELECT chunk_id, kind, section_id, page_number, page_range, "
                "       block_ids, section_title, text, "
                f"       {BM25_EXPRESSION} AS score "
                "FROM chunks WHERE chunks MATCH ? " + clause + " "
                "ORDER BY score LIMIT ?"
            )
            rows = connection.execute(sql, [prepared.match, *parameters, top_k]).fetchall()
            candidates = len(rows)
            items = [_row_to_item(row, score=float(row["score"])) for row in rows]
        except sqlite3.OperationalError as exc:
            # Sanitisation should make this unreachable; if it is reached, saying so
            # beats an unhandled 500.
            raise RetrievalError("QUERY_INVALID", f"The query could not be run: {exc}") from exc
        finally:
            connection.close()

    # Neighbour expansion is skipped under a selection scope. The selection is an
    # absolute boundary, and the paragraph either side of a highlight is *not*
    # what the user highlighted — returning it would answer a question they did
    # not ask, about text they did not choose.
    if items and scope.type != "selection":
        items = _expand_neighbours(ir, items, limit)
    elif scope.type == "selection":
        # A selection with no matching query is still an answer: the selected
        # paragraphs themselves, in reading order. This is the "explain what I
        # highlighted" case, where there is no search to run.
        wanted = set(scope.paragraph_ids or [])
        items = [
            EvidenceItem(
                id="", chunk_id=paragraph.id, kind="paragraph",
                paragraph_id=paragraph.id, section_id=paragraph.section_id,
                section_title=next(
                    (s.title for s in ir.sections if s.id == paragraph.section_id), None
                ),
                page_number=paragraph.page_number,
                page_range=list(paragraph.page_range),
                block_ids=list(paragraph.block_ids),
                text=paragraph.text,
            )
            for paragraph in ir.paragraphs
            if paragraph.id in wanted
        ]

    if not items and diagnostics.code == "SUCCESS":
        diagnostics.code = "NO_MATCH_TOKEN"

    for index, item in enumerate(items, start=1):
        item.id = f"E{index}"

    diagnostics.total_candidates_scored = candidates
    diagnostics.execution_time_ms = round((time.perf_counter() - started) * 1000, 2)

    bundle = EvidenceBundle(
        document_id=ir.document_id,
        query=query,
        query_normalized=prepared.match,
        scope=scope,
        items=items,
        diagnostics=diagnostics,
    )
    # A rough bound so a caller can size a prompt. Four characters per token is
    # the same conservative estimate the context layer uses.
    bundle.token_estimate = sum(len(item.text) for item in items) // 4

    logger.info(
        "retrieval",
        extra={
            "document_id": ir.document_id,
            "scope": scope.describe(),
            "top_k": top_k,
            "hits": len(items),
            "latency_ms": diagnostics.execution_time_ms,
            # P1-6: a digest and a length, never the question — and never any of
            # the retrieved text. The digest is for correlating repeated searches
            # within a log, not for anonymising them: a short query can be guessed
            # from its hash, which is exactly why the raw text is never written
            # beside it.
            "query_sha256": hashlib.sha256(query.encode("utf-8")).hexdigest(),
            "query_length": len(query),
        },
    )
    return bundle
