"""Turning a user's question into something FTS5 will accept, and expanding it.

## Why sanitisation is not optional

A raw query handed to FTS5 is a **query expression**, not text. Measured against
SQLite 3.53.1:

    MATCH 'ResNet-50'   -> OperationalError: no such column: 50
    MATCH 'F(x)'        -> OperationalError: fts5: syntax error near "F"
    MATCH 'p < 0.05'    -> OperationalError: fts5: syntax error near "<"
    MATCH 'AND NOT'     -> OperationalError: fts5: syntax error near "AND"

Which is to say: the ordinary vocabulary of an academic question raises an
unhandled exception. The tokenizer being harmless at *index* time says nothing
about the *query* parser, and conflating the two is the mistake this module exists
to prevent.

The rule here is narrow and conservative. Punctuation that separates words becomes
a separator; a hyphen or dot *inside* a word is kept, so `ResNet-50` stays one
adjacent phrase and matches the identifier rather than two loose terms that happen
to co-occur. Every surviving word is quoted, so no user input can ever be read as
an operator.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.context.models import DocumentAnalysis

#: Characters that separate words. A hyphen and a dot are deliberately **not**
#: separators: `ResNet-50` and `0.05` mean something as units, and splitting them
#: would trade a precise match for a loose one.
_SEPARATORS = re.compile(r"[^\w\-.]+", re.UNICODE)

#: Leading and trailing punctuation that carries no meaning once separated.
_EDGE = re.compile(r"^[^\w]+|[^\w]+$", re.UNICODE)


@dataclass(frozen=True)
class PreparedQuery:
    """A sanitised query, and what was added to it."""

    #: The FTS5 MATCH expression. Never empty unless the query held no words.
    match: str
    #: The original, for echoing back. Never logged.
    original: str
    #: `(term, expanded_to, source)` for each expansion applied.
    expansions: tuple[tuple[str, str, str], ...] = ()

    @property
    def is_empty(self) -> bool:
        """True when the query held no searchable words at all."""
        return not self.match


def normalize_terms(query: str) -> list[str]:
    """Split a query into quoted FTS5 terms.

    Each surviving word is wrapped in quotes, which is what makes user input
    inert: `AND`, `NOT`, `NEAR`, `column:` and `*` are only operators when they
    are unquoted.
    """
    terms: list[str] = []
    for word in _SEPARATORS.sub(" ", query).split():
        cleaned = _EDGE.sub("", word)
        # A word with no letter or digit would tokenize to nothing, and an empty
        # quoted phrase is itself a syntax error.
        if cleaned and any(character.isalnum() for character in cleaned):
            terms.append(f'"{cleaned}"')
    return terms


def expand(
    query: str, analysis: DocumentAnalysis | None
) -> list[tuple[str, str, str]]:
    """Deterministic expansions from evidence the paper itself supplies.

    Two kinds, and both are lookups rather than generation:

    * **Cross-lingual.** A user may ask in Chinese about an English paper. The
      glossary already maps an evidenced source term to its translation, so a
      query containing the translation can be expanded with the term the paper
      actually uses. This is the strongest reason to reuse `DocumentAnalysis`
      here — and it costs no model call.
    * **Acronyms.** Only where the paper itself states the expansion. The
      analysis leaves 24 of 29 acronyms unexpanded because the paper never
      spells them out; inventing one would be a fabrication, so a `None`
      expansion expands to nothing.

    Longest match first, so `degradation problem` wins over `degradation` when
    both would fire — the specific term retrieves better than the general one.
    """
    if analysis is None:
        return []

    folded = query.casefold()
    found: list[tuple[str, str, str]] = []
    taken: list[str] = []

    def overlaps(term: str) -> bool:
        """Whether a longer match already covers this one."""
        return any(term in longer for longer in taken)

    candidates: list[tuple[str, str, str]] = []
    for entry in analysis.glossary:
        if entry.suggested_translation:
            candidates.append((entry.suggested_translation, entry.source_term, "glossary"))
    for entry in analysis.acronyms:
        if entry.expansion:
            candidates.append((entry.acronym, entry.expansion, "acronym"))

    # Longest first, so a specific term is preferred over a substring of it.
    for term, expansion, source in sorted(candidates, key=lambda c: -len(c[0])):
        needle = term.casefold().strip()
        if len(needle) < 2 or needle not in folded:
            continue
        if overlaps(needle):
            continue
        taken.append(needle)
        found.append((term, expansion, source))

    return found


def prepare(query: str, analysis: DocumentAnalysis | None = None) -> PreparedQuery:
    """Sanitise a query and apply whatever deterministic expansions are supported.

    **The user's words are ORed, and so are the expansions.** Both halves were
    bugs before they were decisions.

    Requiring every word turns BM25 into a boolean filter: `degradation problem
    residual` matches no single paragraph, because one passage discusses the
    degradation problem and another the residual mapping. Ranking exists to
    handle exactly that, and a paragraph matching none of the terms is simply
    absent.

    Each expansion then joins as an *alternative* to the whole group, never as a
    conjunct. Conjoining is a total failure in the one case expansion exists for:
    a Chinese question against an English paper has *zero* matches for its own
    characters, so `原句 AND 英文扩展` returns nothing — the expansion, the only
    part that could have matched, is dragged down by the part that cannot.
    """
    expansions = expand(query, analysis)

    # **OR, not AND.** Requiring every word turns BM25 into a boolean filter and
    # breaks on the first natural question: "degradation problem residual" matches
    # no single paragraph, because one passage discusses the degradation problem
    # and another the residual mapping. Ranked retrieval exists precisely to
    # handle that — a paragraph matching more, or rarer, terms scores higher, and
    # one matching none is simply absent.
    base = " OR ".join(normalize_terms(query))
    if not expansions:
        return PreparedQuery(match=base, original=query)

    alternatives = [f"({base})"] if base else []
    for _term, expansion, _source in expansions:
        # The expansion is quoted as one phrase so a multi-word term must appear
        # adjacently — "degradation problem", not "degradation" and "problem"
        # scattered through the paragraph.
        quoted = " AND ".join(normalize_terms(expansion)) or f'"{expansion}"'
        alternatives.append(f"({quoted})")

    return PreparedQuery(
        match=" OR ".join(alternatives),
        original=query,
        expansions=tuple(expansions),
    )
