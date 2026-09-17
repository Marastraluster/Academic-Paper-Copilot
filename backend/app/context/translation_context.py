"""What one translation unit is given, and the identity of that gift.

Two jobs, and the second is the reason this is a module rather than a function.

**Assemble** the bounded context for a unit: resolve which IR paragraph it is,
ask the `ContextBuilder` for that paragraph's context, and fall back honestly
when it cannot be resolved.

**Name it.** The effective-context hash is what makes the translation cache
correct. A cache keyed on source text alone, plus some document-level hash, would
serve whichever translation ran first to every later unit with the same words —
and identical generic strings recur across a paper ("Method", a caption, a page
header) in sections that mean different things by them. Hashing the *actual*
context handed over gives each unit its own identity, and gives an unchanged
section its cache hits when a different section's summary is edited.

It also means the hash is computed from what was really sent. A hash over
"the analysis" would change whenever any part of the paper changed, invalidating
149 units to correct one.
"""

from __future__ import annotations

import hashlib
import json
import threading
from dataclasses import dataclass, field

from app.context.context_builder import ContextBuilder
from app.context.models import AnalysisStatus, DocumentAnalysis, TranslationContext
from app.context.unit_mapper import Mapping, UnitMapper
from app.document.models import DocumentIR

#: Context modes the pipeline distinguishes. `DEEP` is deliberately absent: in a
#: pipeline that translates units independently and in parallel there is no
#: mechanism for it beyond spending more tokens, and a mode that means "try
#: harder" is a label rather than a capability.
MODE_OFF = "off"
MODE_STANDARD = "standard"
VALID_MODES = (MODE_OFF, MODE_STANDARD)

#: Why a unit received no context. Recorded rather than discarded, so a task can
#: report how much of a document was actually translated with context.
FALLBACK_UNMAPPED = "UNMAPPED"

#: Separates the context hash from the source text inside a cache key. A NUL
#: cannot occur in either, so no text can forge a different unit's key.
_KEY_SEPARATOR = "\x00"


@dataclass(frozen=True)
class UnitContext:
    """The context for one translation unit, and how it was arrived at."""

    context: TranslationContext | None
    #: `None` when the unit could not be matched to a paragraph.
    paragraph_id: str | None
    mapping_score: float
    #: `None` when context was applied in full; otherwise why it was reduced.
    fallback: str | None
    #: Identity of the semantic inputs. Part of the cache key.
    effective_context_hash: str
    cache_key: str

    @property
    def is_contextual(self) -> bool:
        """True when paragraph-level context was actually attached."""
        return self.context is not None and self.fallback is None


def _canonical(context: TranslationContext) -> str:
    """A deterministic serialisation of exactly what the model will be given.

    Sorted keys and a fixed separator so two builds of the same context hash
    identically, and any change to a summary, a glossary term or a neighbour
    changes the hash. Glossary order is preserved rather than sorted — it carries
    meaning (in-paragraph terms first) and reordering it changes the prompt.
    """
    payload = {
        "domain": context.academic_domain,
        "document_summary": context.document_summary,
        "section_id": context.section_id,
        "section_title": context.section_title,
        "section_summary": context.section_summary,
        "glossary": [
            [term.source_term, term.suggested_translation, term.is_translatable]
            for term in context.glossary
        ],
        "previous_paragraph": context.previous_paragraph,
        "next_paragraph": context.next_paragraph,
    }
    return json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def hash_context(context: TranslationContext | None, *, prompt_version: str) -> str:
    """The hash that names this unit's semantic inputs.

    The prompt version is folded in because the same context rendered by a
    different prompt is a different request; a unit translated under v1 must not
    satisfy v2.
    """
    if context is None:
        material = "no-context"
    else:
        material = _canonical(context)
    digest = hashlib.sha256()
    digest.update(prompt_version.encode("utf-8"))
    digest.update(b"\x00")
    digest.update(material.encode("utf-8"))
    return digest.hexdigest()[:32]


def cache_key(text: str, context_hash: str) -> str:
    """The string upstream's cache is keyed on for this unit.

    Upstream keys its table on ``(engine, params, original_text)``. The params
    are *shared instance state* — mutating them per unit from four worker threads
    would race, and upstream's own comment concedes it assumes configuration
    happens before translation starts. So per-unit identity travels in the text
    instead, which is a local argument to `cache.get`/`cache.set` and cannot race.
    """
    return f"{context_hash}{_KEY_SEPARATOR}{text}"


class UnitContextProvider:
    """Builds the context for units of one document.

    One instance per translation run: it holds that document's IR, analysis and
    mapper, and is handed to the translator through the run registry. Nothing
    here is mutated after construction, so concurrent units cannot interfere.
    """

    def __init__(
        self,
        ir: DocumentIR,
        analysis: DocumentAnalysis | None,
        *,
        prompt_version: str,
        mode: str = MODE_STANDARD,
        max_context_tokens: int = 1500,
    ) -> None:
        if mode not in VALID_MODES:
            raise ValueError(f"unknown context mode {mode!r}; expected one of {VALID_MODES}")
        self._mode = mode
        self._prompt_version = prompt_version
        self._max_tokens = max_context_tokens
        self._mapper = UnitMapper(ir)
        self._builder = ContextBuilder(ir, analysis)
        self._analysis = analysis
        #: What the run actually did. Lives here because the translator that
        #: produces these numbers is built on a worker thread upstream owns, and
        #: this object is the one thing both sides already share.
        self.diagnostics: dict[str, int] = {
            "units": 0, "units_context_aware": 0, "units_fallback": 0,
            "cache_hits": 0, "repairs_attempted": 0, "repairs_succeeded": 0,
            "source_preserved": 0,
        }
        self._diagnostics_lock = threading.Lock()

    def note(self, **deltas: int) -> None:
        """Add to the run's counters. Safe from the worker threads."""
        with self._diagnostics_lock:
            for key, delta in deltas.items():
                self.diagnostics[key] = self.diagnostics.get(key, 0) + delta

    @property
    def mode(self) -> str:
        return self._mode

    def for_unit(self, text: str) -> UnitContext:
        """Resolve a unit's context, or say honestly that it has none."""
        if self._mode == MODE_OFF or self._analysis is None:
            digest = hash_context(None, prompt_version=self._prompt_version)
            return UnitContext(
                context=None,
                paragraph_id=None,
                mapping_score=0.0,
                fallback=FALLBACK_UNMAPPED if self._mode != MODE_OFF else None,
                effective_context_hash=digest,
                cache_key=cache_key(text, digest),
            )

        mapping = self._mapper.match(text)
        if not mapping.resolved:
            return self._without_context(text, mapping)

        try:
            context = self._builder.build_context(
                mapping.paragraph_id, max_tokens=self._max_tokens
            )
        except KeyError:
            # Resolved, but its context could not be assembled. Treated the same
            # as unmatched: the alternative is inventing one.
            return self._without_context(text, mapping)

        digest = hash_context(context, prompt_version=self._prompt_version)
        return UnitContext(
            context=context,
            paragraph_id=mapping.paragraph_id,
            mapping_score=mapping.score,
            fallback=None,
            effective_context_hash=digest,
            cache_key=cache_key(text, digest),
        )

    def _without_context(self, text: str, mapping: "Mapping") -> UnitContext:
        """A unit that gets no academic context at all.

        **This is a deliberate reversal of the first design**, which gave
        unmatched units the document summary and domain. Measuring where the
        unmapped units come from showed why that was wrong: of 121 unmatched
        units across three real papers, 111 were captions, headings, tables,
        references and running headers.

        Attaching a 250-word summary to a five-word table cell is prompt
        asymmetry with no disambiguation value — the summary cannot tell a
        fragment which sense of a word it means — and it doubles the token cost
        of a unit where context cannot help. For the 9 genuine prose misses it
        might have helped, but optimising for those means degrading the other
        111, and a caption translated through the lens of the paper's thesis is
        exactly the overtranslation this is meant to avoid.

        The hash is the same one off-mode produces, so an unmatched unit shares
        the off-mode cache entry rather than paying for a second translation.
        """
        digest = hash_context(None, prompt_version=self._prompt_version)
        return UnitContext(
            context=None,
            paragraph_id=None,
            mapping_score=mapping.score,
            fallback=FALLBACK_UNMAPPED,
            effective_context_hash=digest,
            cache_key=cache_key(text, digest),
        )


def analysis_is_usable(analysis: DocumentAnalysis | None) -> bool:
    """Whether an analysis can back a Standard-mode translation.

    `PARTIAL` counts: most of the paper is understood, and refusing to use it
    because two sections were truncated would throw away work the user paid for.
    `FAILED` and `CANCELLED` do not.
    """
    return analysis is not None and analysis.status in (
        AnalysisStatus.READY,
        AnalysisStatus.PARTIAL,
    )
