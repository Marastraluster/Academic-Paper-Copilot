"""Combining the ranked lists from several queries into one.

Reciprocal Rank Fusion, and the reason it is the right tool here rather than
adding scores together: BM25 scores from *different query strings* are not
comparable. A query with one rare term produces scores on a different scale from a
query with six common ones, so `score_a + score_b` ranks by which query happened
to be broader. RRF uses only the **rank** each query assigned, which is comparable
across queries by construction.

    RRF(d) = Σ over queries q of  1 / (k + rank_q(d))

`k = 60`, from Cormack et al. (2009). It damps the top of each list: with a small
k, a document that one query ranked first and no other query found at all beats a
document that three queries all ranked second. Sixty is the standard value and
there is no measurement here that would justify deviating from it.

**Identity is the indexed chunk, never the text.** A paper repeats its own
sentences — "We evaluate on ImageNet" appears in more than one paragraph — and
merging by text would collapse two real locations into one, losing a page, a
section and a citation. Two identical paragraphs are two pieces of evidence.
"""

from __future__ import annotations

from dataclasses import dataclass

#: Damping constant. See the module docstring.
RRF_K = 60

#: How many candidates each query contributes before fusion. Bounded because the
#: fusion is over ranks, so a query's 400th result contributes as little as any
#: other query's 400th, and carrying them all costs memory to reorder nothing.
PER_QUERY_CANDIDATES = 20


@dataclass(frozen=True)
class Ranked:
    """One query's opinion of one chunk."""

    key: str
    rank: int
    score: float


#: How much one unit of term coverage is worth against the fused rank score.
#:
#: **Coverage outranks rank consensus at this value, and that is deliberate.** The
#: whole RRF band is narrow — measured across the benchmark, min 0.0125, median
#: 0.0143, max 0.0313 — while a full coverage unit is worth 0.05. So a candidate
#: matching every content word beats one that matched none even from twelve ranks
#: behind. An earlier note here claimed this was "a nudge within" the fused score;
#: it is not, and the test that now asserts the real behaviour is what caught the
#: difference. Gemini's criteria asked for exactly this: coverage "reliably
#: elevates a candidate across BM25 frequency-inflated noise".
#:
#: Measured: every value from 0.01 to 1.0 regresses none of the twenty-one
#: questions that already ranked in the top five. 0.05 is the smallest value in
#: that range comfortably above the fused band rather than a tuned one, and it is
#: recorded that way — no sweep chose it.
COVERAGE_ALPHA = 0.05


def fuse(
    rankings: dict[str, list[str]],
    *,
    coverage: dict[str, float] | None = None,
) -> list[tuple[str, float, tuple[str, ...]]]:
    """Fuse ranked key lists into one, best first.

    ``rankings`` maps a query's label to its ranked chunk keys. Returns
    ``(key, fused_score, contributing_labels)`` in descending score order, with
    ties broken by key so the order is identical on every run — a fusion that
    varies between runs would make every benchmark unreproducible.

    ``coverage`` maps a key to its term-coverage against the question, and is added
    to the fused score rather than replacing it. Two things are deliberately *not*
    done here: no per-path weighting (measured inert — rewrites only ever fire when
    the raw query returned nothing, so there is nothing to protect), and no
    diversity stage (measured inert — no low-ranked miss is caused by duplicate
    crowding).
    """
    scores: dict[str, float] = {}
    contributors: dict[str, list[str]] = {}

    for label in sorted(rankings):
        for position, key in enumerate(rankings[label][:PER_QUERY_CANDIDATES], start=1):
            scores[key] = scores.get(key, 0.0) + 1.0 / (RRF_K + position)
            contributors.setdefault(key, []).append(label)

    if coverage:
        for key, value in coverage.items():
            if key in scores:
                scores[key] += COVERAGE_ALPHA * value

    ordered = sorted(scores.items(), key=lambda item: (-item[1], item[0]))
    return [(key, score, tuple(contributors[key])) for key, score in ordered]
