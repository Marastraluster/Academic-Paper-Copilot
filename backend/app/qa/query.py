"""Turning a question into FTS5 queries, and expanding it from what the paper says.

## Why sanitisation is not optional

A raw query handed to FTS5 is a **query expression**, not text. Measured against
SQLite 3.53.1:

    MATCH 'ResNet-50'   -> OperationalError: no such column: 50
    MATCH 'F(x)'        -> fts5: syntax error near "F"
    MATCH 'p < 0.05'    -> fts5: syntax error near "<"
    MATCH 'AND NOT'     -> fts5: syntax error near "AND"

Which is to say: the ordinary vocabulary of an academic question raises an
unhandled exception. The tokenizer being harmless at *index* time says nothing
about the *query* parser, and conflating the two is the mistake this module exists
to prevent.

## Why variants, and not one big OR

Expansion used to concatenate everything into a single
`(base) OR (exp1) OR (exp2)` expression, and that is wrong for a reason worth
recording: within one MATCH, every term contributes to the same score, so
appending common words to a query **dilutes the IDF of the words that matter** and
lets them outvote the paragraph that actually answers the question. It was
measured, not theorised — on the PPO paper, the paragraph titled "Algorithm 1 PPO"
loses to four ordinary words in the question "What is Algorithm 1 in this paper?".

So each expansion is now its own **independent FTS5 query**, and the results are
fused by rank afterwards (`app.qa.fusion`). A query that matches nothing simply
contributes nothing; it cannot drag another one down.

The rule inside each variant is unchanged: **OR, not AND**. Requiring every word
turns BM25 into a boolean filter, and `degradation problem residual` matches no
single paragraph because one passage discusses the degradation problem and another
the residual mapping.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from app.context.models import DocumentAnalysis

#: Characters that separate words. A hyphen and a dot are deliberately **not**
#: separators: `ResNet-50` and `0.05` mean something as units, and splitting them
#: would trade a precise match for a loose one.
_SEPARATORS = re.compile(r"[^\w\-.]+", re.UNICODE)

#: Leading and trailing punctuation that carries no meaning once separated.
_EDGE = re.compile(r"^[^\w]+|[^\w]+$", re.UNICODE)

#: How many entities of one type may join a query.
#:
#: Three, and the bound matters more than the number. Appending every entity of a
#: type turns the variant into a list of everything the paper mentions, which is
#: the IDF dilution this module's variants exist to avoid — the paragraph that
#: answers "which datasets" is the one naming a few of them, not the one naming
#: all of them.
MAX_ENTITY_EXPANSIONS = 3

#: An entity mentioned in one paragraph only is usually a citation or a passing
#: comparison, not something the paper actually uses.
MIN_ENTITY_PARAGRAPHS = 2

#: Where a variant came from. Reported in diagnostics so an evaluation can say
#: which path produced a hit, and so a regression can be attributed.
SOURCE_RAW = "raw"
SOURCE_GLOSSARY = "glossary"
SOURCE_ACRONYM = "acronym"
SOURCE_ENTITY = "entity"
SOURCE_REWRITE = "rewrite"


@dataclass(frozen=True)
class QueryVariant:
    """One independent FTS5 query, and where it came from."""

    match: str
    source: str


@dataclass(frozen=True)
class PreparedQuery:
    """The queries to run, and what was added to the user's own."""

    #: Every query to run, the user's original first. Fusion order does not
    #: depend on this, but diagnostics read better with the raw one leading.
    variants: tuple[QueryVariant, ...] = ()
    #: The original, for echoing back. Never logged.
    original: str = ""
    #: `(term, expanded_to, source)` for each expansion applied.
    expansions: tuple[tuple[str, str, str], ...] = ()
    #: Why the caller may want to reach for a query rewriter, if it can.
    needs_rewrite: bool = False
    #: Human-readable reasons, for diagnostics only.
    rewrite_reasons: tuple[str, ...] = field(default_factory=tuple)

    @property
    def match(self) -> str:
        """The user's own query expression.

        Kept because `EvidenceBundle.query_normalized` publishes it and because
        "what did the user actually ask, as a query" is worth being able to read.
        It is the *first* variant, not a concatenation of all of them.
        """
        return self.variants[0].match if self.variants else ""

    @property
    def is_empty(self) -> bool:
        """True when nothing searchable was asked at all."""
        return not any(variant.match for variant in self.variants)

    @property
    def sources(self) -> tuple[str, ...]:
        return tuple(variant.source for variant in self.variants)


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


def phrase(term: str) -> str:
    """One adjacency-preserving FTS5 phrase.

    The previous version ANDed the words of a term together, which does not mean
    what its comment claimed: `"degradation" AND "problem"` matches a paragraph
    where they appear pages apart. An expansion is a term, so it is searched as
    one.
    """
    return f'"{term.strip()}"' if term.strip() else ""


def _entity_kinds_wanted(query: str, analysis: DocumentAnalysis) -> list[str]:
    """Entity kinds the question is asking about, by its own words.

    Deliberately a small vocabulary match — singularise, compare against the
    kinds the analysis actually used — rather than a taxonomy. Building an
    academic type system is not this task, and a general ontology would be a
    larger claim than the evidence supports.
    """
    kinds = {entry.kind.casefold() for entry in analysis.entities if entry.kind}
    if not kinds:
        return []

    words = {word.strip('"').casefold() for word in normalize_terms(query)}
    # `datasets` -> `dataset`, `models` -> `model`. Not a stemmer: enough for the
    # plural of a type noun, which is the only shape a question uses.
    singular = {word[:-1] if word.endswith("s") and len(word) > 3 else word for word in words}
    singular |= words

    return sorted(kind for kind in kinds if kind in singular)


def expand_entities(query: str, analysis: DocumentAnalysis) -> list[tuple[str, str, str]]:
    """Entities of a type the question asked for, most-mentioned first.

    Returns `(entity_name, entity_name, "entity")` triples so the shape matches
    the other expansion kinds at the call site.
    """
    wanted = _entity_kinds_wanted(query, analysis)
    if not wanted:
        return []

    candidates = [
        entry
        for entry in analysis.entities
        if entry.kind.casefold() in wanted
        and len(entry.paragraph_ids) >= MIN_ENTITY_PARAGRAPHS
        and entry.name.strip()
    ]
    # Most-mentioned first, then alphabetical: a deterministic order, because a
    # cap of three is only reproducible if ties are broken the same way every run.
    candidates.sort(key=lambda entry: (-len(entry.paragraph_ids), entry.name.casefold()))

    chosen = candidates[:MAX_ENTITY_EXPANSIONS]
    return [(entry.name, entry.name, SOURCE_ENTITY) for entry in chosen]


def expand(query: str, analysis: DocumentAnalysis | None) -> list[tuple[str, str, str]]:
    """Deterministic expansions from evidence the paper itself supplies.

    Three kinds, all lookups rather than generation:

    * **Cross-lingual, both ways.** A user may ask in Chinese about an English
      paper, in which case the glossary's suggested translation appears in the
      question and the source term is what the paper uses. The reverse also
      happens: a reader who has seen 中文 in the translation asks in English.
    * **Acronyms, both ways.** Only where the paper itself states the expansion.
      The analysis leaves 24 of 29 acronyms unexpanded because the paper never
      spells them out; inventing one would be a fabrication, so `None` expands to
      nothing. The reverse direction is what makes "Proximal Policy Optimization"
      find the paragraphs that say "PPO".
    * **Entities of a type the question names**, capped and ranked by how often the
      paper mentions them.

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
        if not entry.suggested_translation:
            continue
        candidates.append((entry.suggested_translation, entry.source_term, SOURCE_GLOSSARY))
        # The reader may hold either word. Both directions are evidenced by the
        # same row, so neither direction invents anything.
        candidates.append((entry.source_term, entry.suggested_translation, SOURCE_GLOSSARY))
    for entry in analysis.acronyms:
        if not entry.expansion:
            continue
        candidates.append((entry.acronym, entry.expansion, SOURCE_ACRONYM))
        candidates.append((entry.expansion, entry.acronym, SOURCE_ACRONYM))

    # Longest first, so a specific term is preferred over a substring of it.
    for term, expansion, source in sorted(candidates, key=lambda c: -len(c[0])):
        needle = term.casefold().strip()
        if len(needle) < 2 or needle not in folded:
            continue
        if overlaps(needle):
            continue
        taken.append(needle)
        found.append((term, expansion, source))

    found.extend(expand_entities(query, analysis))
    return found


def prepare(
    query: str, analysis: DocumentAnalysis | None = None, *, rewrites: list[str] | None = None
) -> PreparedQuery:
    """Build the independent queries to run for one question.

    The user's own query is always first and always kept: a rewrite supplements
    retrieval, it does not replace the direct lexical search, which is what gets
    an exact model name or identifier found.
    """
    variants: list[QueryVariant] = []
    base = " OR ".join(normalize_terms(query))
    if base:
        variants.append(QueryVariant(match=base, source=SOURCE_RAW))

    expansions = expand(query, analysis)
    for _term, expansion, source in expansions:
        expression = _expression_for(expansion)
        if expression:
            variants.append(QueryVariant(match=expression, source=source))

    for rewrite in rewrites or []:
        expression = " OR ".join(normalize_terms(rewrite))
        if expression:
            variants.append(QueryVariant(match=expression, source=SOURCE_REWRITE))

    # Deduplicate identical expressions, keeping the earliest source: an
    # expansion that happens to reproduce the raw query adds nothing, and running
    # it twice would double its weight in the fusion.
    seen: set[str] = set()
    unique: list[QueryVariant] = []
    for variant in variants:
        if variant.match in seen:
            continue
        seen.add(variant.match)
        unique.append(variant)

    return PreparedQuery(
        variants=tuple(unique),
        original=query,
        expansions=tuple(expansions),
    )


def _expression_for(expansion: str) -> str:
    """How one expansion becomes its own query: as a phrase.

    Every expansion — glossary, acronym, entity — is a term the paper uses, so it
    is searched as one adjacency-preserving phrase. Entities are separate
    variants rather than one ORed list for the same reason the variants exist at
    all: each is an independent retriever, and RRF assumes that. Folding three
    entities into one expression would score a paragraph matching all three above
    one matching the term a question is actually about.
    """
    return phrase(expansion)
