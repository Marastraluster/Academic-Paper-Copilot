"""Translation that knows what the paper is about.

Extends :class:`BoundedOpenAIlikedTranslator` — keeping its finite retry budget
and document-wide fast abort — with three things: academic context, a cache key
that can tell two contexts apart, and a check that the formulas survived.

## Where each responsibility lives, and why

`translate()` — not `do_translate()`. Upstream's `translate()` consults the cache
*before* calling `do_translate`, so context resolved inside `do_translate` would
arrive after the cache decision had already been made on unaugmented parameters.
That would leave the existing cross-provider defect in place while appearing to
fix it.

**The cache key is namespaced text, not extra cache parameters.** Upstream's table
is keyed on `(engine, params, original_text)`, and `params` is a single string on
a shared instance — `add_cache_impact_parameters` mutates it. Four worker threads
calling it per unit would race, and upstream's own comment concedes it assumes
configuration happens before translation starts. So document-wide identity
(endpoint, model, prompt version, mode) is registered **once at construction**,
and per-unit identity travels in the text passed to `cache.get`/`cache.set`, which
is a local argument and cannot race.

**Context reaches the prompt through a thread-local.** Upstream gives each unit a
thread for the duration of its call, so a value set in `translate()` and read in
`prompt()` on the same thread is safe — and it avoids reimplementing
`do_translate`'s model call, think-tag stripping and streaming just to thread an
argument through.
"""

from __future__ import annotations

import re
import threading

from app.context import prompts
from app.context.translation_context import MODE_ACADEMIC, MODE_OFF, MODE_STANDARD
from app.pdfkernel import placeholders
from app.pdfkernel.abort import TranslationAbortSentinel
from app.pdfkernel.bounded_translator import BoundedOpenAIlikedTranslator
from app.pdfkernel.context_registry import MODE_ENV, RUN_ID_ENV, lookup
from app.logging import get_logger

logger = get_logger(__name__)

#: The context for the unit this thread is currently translating. Thread-local
#: rather than instance state: one translator serves four concurrent workers.
_UNIT_CONTEXT = threading.local()

#: Messages to send instead of the normal prompt, for the placeholder repair.
_MESSAGE_OVERRIDE = threading.local()

#: Conversational openings a model adds despite being asked not to. Removed
#: rather than rejected: the translation underneath is usually correct, and a
#: PDF whose glyph layout is computed per character cannot absorb a preamble.
_FILLER = re.compile(
    r"^\s*(?:here(?:'s| is) the translation[:\-]?|translation[:\-]|"
    r"translated (?:text|translation)[:\-]|译文[：:]|翻译[：:])\s*",
    re.IGNORECASE,
)

#: A whole response wrapped in a fence. Unwrapped, not rejected.
_FENCE = re.compile(r"^\s*```[a-zA-Z]*\s*\n(.*?)\n?```\s*$", re.DOTALL)


def strip_filler(text: str) -> str:
    """Remove a conversational wrapper, keeping the translation."""
    cleaned = text.strip()
    fenced = _FENCE.match(cleaned)
    if fenced:
        cleaned = fenced.group(1).strip()
    # Once, not in a loop: a translation that legitimately begins "Translation:"
    # is vanishingly rare, and looping would eat a second real line.
    return _FILLER.sub("", cleaned).strip()


class _NoCache:
    """A cache that stores and returns nothing.

    Upstream's `translate()` gates the *lookup* on `ignore_cache` but writes the
    result **unconditionally** — so calling it with `ignore_cache=True` still
    leaves a bare-text entry behind. This translator never reads that entry, so
    it is not a correctness problem, but it is the very key the cross-provider
    defect lives on, sitting in the table looking authoritative. Suppressing the
    write means the cache contains exactly what this class put in it: one entry
    per unit, keyed on that unit's own context.
    """

    def get(self, text: str):
        return None

    def set(self, text: str, translation: str) -> None:
        return None

    def add_params(self, key, value):  # pragma: no cover - never reached
        return None


class ContextualOpenAIlikedTranslator(BoundedOpenAIlikedTranslator):
    """OpenAI-compatible translation with bounded context and a correct cache."""

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)

        envs = self.envs or {}
        self._provider = lookup(envs.get(RUN_ID_ENV)) if envs.get(RUN_ID_ENV) else None
        self._run_id = envs.get(RUN_ID_ENV)
        # The mode travels in `envs`, not on the provider. Academic and basic have
        # no provider at all — that is the point of academic mode — so deriving
        # the mode from one could not express "the academic prompt, without
        # touching the document".
        mode = envs.get(MODE_ENV) or ("off" if self._provider is None else self._provider.mode)
        self._mode = mode

        # Registered here, once, before any worker starts — which is exactly the
        # point upstream's comment says configuration must happen at. Doing this
        # per unit would race.
        self.add_cache_impact_parameters("base_url", envs.get("OPENAILIKED_BASE_URL"))
        self.add_cache_impact_parameters("model", envs.get("OPENAILIKED_MODEL"))
        self.add_cache_impact_parameters("prompt_version", prompts.TRANSLATION_PROMPT_VERSION)
        self.add_cache_impact_parameters("context_mode", mode)

        self._stats = {"units": 0, "units_context_aware": 0, "units_fallback": 0,
                       "cache_hits": 0, "repairs_attempted": 0,
                       "repairs_succeeded": 0, "source_preserved": 0}

    def _note(self, **deltas: int) -> None:
        """Count something, locally and on the run.

        Local so a translator built without a provider is still inspectable;
        on the provider because this instance lives on a worker thread the task
        runner cannot reach afterwards.
        """
        for key, delta in deltas.items():
            self._stats[key] = self._stats.get(key, 0) + delta
        if self._provider is not None:
            self._provider.note(**deltas)

    # -- diagnostics --------------------------------------------------------

    @property
    def stats(self) -> dict[str, int]:
        """Counts for the task record. Reported, never invented."""
        return dict(self._stats)

    # -- the contract upstream calls ----------------------------------------

    def translate(self, text: str, ignore_cache: bool = False) -> str:
        if self._aborted:
            raise TranslationAbortSentinel(self._terminal_error)

        unit = (
            self._provider.for_unit(text)
            if self._provider is not None
            else None
        )
        if unit is not None and unit.is_contextual:
            self._note(units=1, units_context_aware=1)
        elif unit is not None and self._provider.mode != "off":
            self._note(units=1, units_fallback=1)
        else:
            self._note(units=1)

        # Only contextual mode has per-unit identity to namespace. Academic and
        # basic consume no document analysis, so prefixing their key would make a
        # translation expire whenever an analysis they never read was regenerated
        # — the trap this design exists to avoid. The mode itself is a registered
        # cache *parameter*, so the three still cannot return each other's work.
        key = unit.cache_key if (unit is not None and self._mode == MODE_STANDARD) else text

        if not (self.ignore_cache or ignore_cache):
            hit = self.cache.get(key)
            if hit is not None:
                self._note(cache_hits=1)
                return hit

        _UNIT_CONTEXT.value = unit.context if unit is not None else None
        real_cache = self.cache
        try:
            # Upstream's own cache is swapped out for the duration of the call:
            # `ignore_cache=True` stops it being *read*, but it is still written,
            # and a bare-text entry is precisely the key the cross-provider
            # defect is made of. This method is the only thing that decides what
            # is a hit, so it is the only thing that should write.
            self.cache = _NoCache()
            try:
                translation = super().translate(text, ignore_cache=True)
            finally:
                self.cache = real_cache
        finally:
            _UNIT_CONTEXT.value = None

        translation = self._guard_placeholders(text, translation)

        self.cache.set(key, translation)
        return translation

    def _guard_placeholders(self, source: str, translation: str) -> str:
        """Ensure every formula marker survived; repair once, then fall back.

        Formula correctness outranks translation completeness. A unit left in its
        original language still lays out — the glyphs are the glyphs — while a
        unit whose markers are wrong places the wrong equation, or crashes the
        renderer. Given the choice, this returns the source.
        """
        cleaned = strip_filler(translation)
        try:
            placeholders.validate(source, cleaned)
            return cleaned
        except placeholders.PlaceholderMismatch as failure:
            # Bound to a new name deliberately: Python unbinds an `except ... as`
            # target when the block exits, so `failure` would be gone by the time
            # the repair below needs it, and every repair would raise
            # UnboundLocalError instead of running.
            mismatch = failure
            self._note(repairs_attempted=1)
            logger.warning(
                "placeholder mismatch; attempting one repair",
                extra={"run_id": self._run_id, "missing": sorted(set(mismatch.missing)),
                       "extra": sorted(set(mismatch.extra))},
            )

        repaired = self._repair(source, cleaned, mismatch)
        if repaired is not None:
            self._note(repairs_succeeded=1)
            return repaired

        self._note(source_preserved=1)
        logger.warning(
            "placeholder repair failed; preserving the source unit",
            extra={"run_id": self._run_id},
        )
        return source

    def _repair(
        self, source: str, translation: str, mismatch: placeholders.PlaceholderMismatch
    ) -> str | None:
        """One targeted attempt. Returns ``None`` if it does not succeed."""
        messages = prompts.placeholder_repair_messages(
            target_text=source,
            bad_translation=translation,
            hint=mismatch.repair_hint,
            target_language=self.lang_out,
        )
        try:
            _MESSAGE_OVERRIDE.value = messages
            try:
                candidate = strip_filler(self.do_translate(source))
            finally:
                _MESSAGE_OVERRIDE.value = None
        except Exception:  # noqa: BLE001 - a failed repair is a fallback, not a crash
            return None

        try:
            placeholders.validate(source, candidate)
        except placeholders.PlaceholderMismatch:
            return None
        return candidate

    # -- prompt construction -------------------------------------------------

    def prompt(self, text: str, prompt_template=None) -> list[dict[str, str]]:
        """Build the messages for this unit.

        Three cases, in order: an explicit override (the repair), a unit with
        context (the delimited envelope), and everything else — which must be
        byte-identical to the baseline, because that is what `context_mode="off"`
        promises.
        """
        override = getattr(_MESSAGE_OVERRIDE, "value", None)
        if override is not None:
            return override

        # `getattr` rather than `self._mode`: upstream's own constructor calls
        # this method — `add_cache_impact_parameters("prompt", self.prompt("",
        # self.prompttext))` — before any of our attributes exist. Falling back
        # to the baseline envelope there is correct: upstream is capturing the
        # *template* for the cache key, and the mode is registered separately.
        mode = getattr(self, "_mode", MODE_OFF)
        if mode == MODE_ACADEMIC:
            # The academic envelope with no payload. Every context argument is
            # left out, so the reference, glossary and neighbour sections are
            # simply absent rather than empty — a header with nothing under it
            # would still cost tokens and still imply context exists.
            return prompts.translation_messages(
                target_text=text, target_language=self.lang_out
            )

        context = getattr(_UNIT_CONTEXT, "value", None)
        if context is None:
            return super().prompt(text, prompt_template)

        glossary = [
            (term.source_term, term.suggested_translation, term.is_translatable)
            for term in context.glossary
        ]
        return prompts.translation_messages(
            target_text=text,
            target_language=self.lang_out,
            document_summary=context.document_summary,
            academic_domain=context.academic_domain,
            section_title=context.section_title,
            section_summary=context.section_summary,
            glossary=glossary,
            previous_paragraph=context.previous_paragraph,
            next_paragraph=context.next_paragraph,
        )

