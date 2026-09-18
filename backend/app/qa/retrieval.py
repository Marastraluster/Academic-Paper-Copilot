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
from app.qa.fusion import PER_QUERY_CANDIDATES, fuse
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


def _is_cjk(character: str) -> bool:
    codepoint = ord(character)
    return (
        0x4E00 <= codepoint <= 0x9FFF
        or 0x3040 <= codepoint <= 0x30FF
        or 0xAC00 <= codepoint <= 0xD7AF
        or 0x3000 <= codepoint <= 0x303F
    )


def needs_rewrite(query: str, items: list[EvidenceItem]) -> tuple[bool, list[str]]:
    """Whether the local paths have already failed, and why.

    Two conditions, both observable without asking a model anything:

    * **Nothing matched.** No expansion, no entity, no user word found a row.
    * **The scripts do not meet.** The question is written in characters the
      indexed text does not contain — answerable only by rewriting it into the
      paper's language, and the reason a Chinese question against an English
      paper retrieves *zero* rows rather than poor ones.

    Deliberately not a BM25 threshold. The scores are uncalibrated across queries,
    and this repository has twice refused to treat them as a confidence signal;
    "did anything come back at all" needs no calibration.
    """
    if not items:
        return True, ["no_match"]

    if any(_is_cjk(character) for character in query) and not any(
        _is_cjk(character) for item in items for character in item.text
    ):
        return True, ["script_mismatch"]

    return False, []


def retrieve(
    ir: DocumentIR,
    document_dir: Path,
    *,
    query: str,
    scope: Scope,
    analysis: DocumentAnalysis | None = None,
    top_k: int = DEFAULT_TOP_K,
    max_items: int | None = None,
    rewrites: list[str] | None = None,
) -> EvidenceBundle:
    """Retrieve source evidence for a question within a scope.

    Needs only the `DocumentIR`. `analysis` is optional and, when present, may
    add glossary, acronym and entity expansions — never evidence, which comes
    from the document and nowhere else.

    `rewrites` are extra lexical queries, produced by a caller that decided the
    local paths were not going to work (see `needs_rewrite`). They are searched
    exactly like the deterministic ones, under the same scope, and fused with
    them by rank.
    """
    started = time.perf_counter()
    top_k = max(1, min(top_k, 50))
    limit = max_items if max_items is not None else top_k * (1 + 2 * NEIGHBOUR_RADIUS)

    stats = ensure_index(document_dir, ir)

    # AC-06: a selection is a fast path. The selected paragraphs *are* the
    # evidence, so analysis-driven expansion adds nothing to search for and a
    # rewrite could not widen it — the scope forbids that by construction. Both
    # are bypassed, explicitly rather than incidentally: they used to be skipped
    # only because the selection branch happened to fill `items`, which stopped
    # being true the moment a selection named an id the document does not have —
    # and that is exactly when a wasted provider call is least affordable.
    selection_scope = scope.type == "selection"
    prepared = prepare(
        query, None if selection_scope else analysis, rewrites=rewrites
    )

    diagnostics = Diagnostics(
        expansions=[
            ExpansionApplied(term=term, expanded_to=expanded, source=source)
            for term, expanded, source in prepared.expansions
        ],
        index_rebuilt=stats.rebuilt,
        query_variants=list(prepared.sources),
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
    rankings: dict[str, list[str]] = {}
    rows_by_key: dict[str, sqlite3.Row] = {}
    best_rank: dict[str, int] = {}

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
            # **Each variant is its own query.** Running them as one expression
            # would put every expansion's terms into a single BM25 score, where
            # common ones dilute the rare ones that identify the answer — measured
            # on the PPO paper, where "Algorithm 1 PPO" lost to four ordinary
            # words. Fused by rank afterwards instead: see `app.qa.fusion`.
            for variant in prepared.variants:
                try:
                    rows = connection.execute(
                        sql, [variant.match, *parameters, PER_QUERY_CANDIDATES]
                    ).fetchall()
                except sqlite3.OperationalError as exc:
                    # Sanitisation should make this unreachable; if it is reached,
                    # saying so beats an unhandled 500.
                    raise RetrievalError(
                        "QUERY_INVALID", f"The query could not be run: {exc}"
                    ) from exc

                label = f"{variant.source}:{len(rankings)}"
                rankings[label] = [row["chunk_id"] for row in rows]
                for position, row in enumerate(rows, start=1):
                    key = row["chunk_id"]
                    rows_by_key.setdefault(key, row)
                    best_rank[key] = min(best_rank.get(key, position), position)
                candidates += len(rows)

            fused = fuse(rankings)
            items = [
                _row_to_item(rows_by_key[key], score=score)
                for key, score, _contributors in fused[:top_k]
            ]
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

    # Whether a caller with a model available should try rewriting. Decided from
    # what actually came back, never from a score: BM25 scores are uncalibrated,
    # which is why DS-QA-001 forbade them as a sufficiency signal and DS-QA-002
    # forbade them as a truth oracle. Never under a selection — a rewrite cannot
    # reach outside the selection, and the scope must not be widened to let it.
    diagnostics.suggest_rewrite, diagnostics.rewrite_reasons = (
        (False, []) if selection_scope else needs_rewrite(query, items)
    )

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
