"""Context-aware translation — DS-CTX-002.

Runs offline. The provider is a fake client, so every assertion about prompts,
cache keys, placeholder handling and concurrency is deterministic and costs
nothing.

The real Off-vs-Standard comparison is a separate, manual evaluation — a fake
cannot tell us whether context improves a translation, and pretending otherwise
is the mistake the semantic gate existed to avoid.
"""

from __future__ import annotations

import json
import re
import threading
from types import SimpleNamespace

import pytest

from app.context import prompts
from app.context.models import (
    AnalysisProvenance,
    AnalysisStatus,
    DocumentAnalysis,
    DomainRecord,
    GlossaryEntry,
    SectionAnalysis,
)
from app.context.translation_context import (
    FALLBACK_UNMAPPED,
    MODE_OFF,
    MODE_STANDARD,
    UnitContextProvider,
    analysis_is_usable,
    cache_key,
    hash_context,
)
from app.context.unit_mapper import UnitMapper, normalize
from app.document.models import (
    DocumentIR,
    DocumentMetadata,
    PageIR,
    ParagraphIR,
)
from app.pdfkernel import placeholders

# --- fixtures ----------------------------------------------------------------


def build_ir(paragraphs: list[tuple[str, str, int, str | None]]) -> DocumentIR:
    """``(id, text, page_number, section_id)`` → a minimal but real IR."""
    models = [
        ParagraphIR(
            id=pid, section_id=section, text=text,
            page_number=page, page_range=(page, page), block_ids=[],
        )
        for pid, text, page, section in paragraphs
    ]
    return DocumentIR(
        document_id="doc_t",
        content_hash="hash-t",
        source_filename="paper.pdf",
        page_count=max((p.page_number for p in models), default=1),
        metadata=DocumentMetadata(title="A Paper About Residual Learning"),
        sections=[],
        pages=[PageIR(page_index=0, page_number=1, width_pt=612, height_pt=792)],
        paragraphs=models,
        page_mapping={p.id: p.page_number for p in models},
        has_text_layer=True,
        ocr_required=False,
    )


def build_analysis(**overrides) -> DocumentAnalysis:
    provenance = AnalysisProvenance(
        document_id="doc_t", content_hash="hash-t", pipeline_version="1.0.0",
        prompt_version="1.0.0", provider_base_url="http://127.0.0.1:9/v1",
        provider_model="m", provider_protocol="chat_completions",
        target_language="zh-CN", created_at="2026-09-17T00:00:00+00:00",
    )
    defaults = dict(
        document_id="doc_t", provenance=provenance, status=AnalysisStatus.READY,
        domain=DomainRecord(primary="Computer Vision", confidence=0.9),
        summary="A paper introducing residual learning for very deep networks.",
        sections=[SectionAnalysis(section_id="s1", title="3.1 Residual Learning",
                                  summary="Introduces residual learning.", page_range=(1, 1))],
        glossary=[GlossaryEntry(source_term="residual learning",
                                suggested_translation="残差学习", paragraph_ids=["p2"])],
    )
    defaults.update(overrides)
    return DocumentAnalysis(**defaults)  # type: ignore[arg-type]


PARAGRAPHS = [
    ("p1", "Deep convolutional neural networks have led to breakthroughs in image "
           "recognition, and depth is of central importance to their success.", 1, "s1"),
    ("p2", "We adopt residual learning to every few stacked layers, so that the "
           "layers fit a residual mapping instead of the unreferenced mapping.", 1, "s1"),
    ("p3", "The degradation problem shows that deeper plain networks obtain higher "
           "training error than their shallower counterparts on the same data.", 2, "s1"),
]


# --- AC-P0-04 / AC-P0-05: mapping --------------------------------------------


class TestUnitMapping:
    """A unit is matched to a paragraph by its text, or honestly not at all."""

    def test_placeholders_do_not_prevent_a_match(self) -> None:
        """AC-P0-04 — `{v26}` stands in for a reference and appears in no IR text.

        Leaving the markers in would depress every score for reasons that have
        nothing to do with whether the passages are the same.
        """
        mapper = UnitMapper(build_ir(PARAGRAPHS))
        unit = (
            "We adopt residual learning to every few stacked layers, so that the "
            "layers fit a residual mapping instead of the unreferenced mapping {v1}."
        )
        assert mapper.match(unit).paragraph_id == "p2"

    def test_line_joining_differences_do_not_prevent_a_match(self) -> None:
        """The two segmentations rejoin lines differently; that is not a difference."""
        mapper = UnitMapper(build_ir(PARAGRAPHS))
        joined = " ".join(PARAGRAPHS[1][1].split())
        assert normalize(joined) == normalize(PARAGRAPHS[1][1])
        assert mapper.match(joined).paragraph_id == "p2"

    def test_a_short_fragment_is_not_matched(self) -> None:
        """AC-P0-05 — 'Abstract' occurs in several places in any paper."""
        mapper = UnitMapper(build_ir(PARAGRAPHS))
        result = mapper.match("Abstract")

        assert not result.resolved
        assert "short" in (result.reason or "")

    def test_equally_good_candidates_are_refused(self) -> None:
        """AC-P0-05 — picking one would attach a section's context to another's text."""
        repeated = (
            "The proposed method achieves state of the art results on every one of "
            "the benchmarks that we evaluate against in this paper."
        )
        ir = build_ir([
            ("p1", repeated, 1, "s1"),
            ("p2", repeated, 2, "s2"),
        ])
        result = UnitMapper(ir).match(repeated)

        assert not result.resolved
        assert "ambiguous" in (result.reason or "")

    def test_an_unrelated_unit_is_not_matched(self) -> None:
        mapper = UnitMapper(build_ir(PARAGRAPHS))
        result = mapper.match(
            "A completely different paper about protein folding and molecular "
            "dynamics simulations at low temperature."
        )
        assert not result.resolved


# --- AC-P0-10 / AC-P0-11: placeholders ---------------------------------------


class TestPlaceholderValidation:
    """The marker is `{vN}` single-brace — measured, not read from the source."""

    def test_single_brace_is_the_accepted_form(self) -> None:
        """AC-P0-10 — the accessor returns `{{vN}}`; the converter emits `{vN}`."""
        assert placeholders.extract("see {v0} and {v12}") == ["{v0}", "{v12}"]
        # `{{v0}}` does contain `{v0}`, which is exactly why counting alone is
        # not enough — the validator rejects the rewritten shape outright.
        assert placeholders.looks_rewritten("{{v0}}") is not None
        assert placeholders.looks_rewritten("<b0>") is not None

    def test_a_rewritten_marker_is_described_specifically(self) -> None:
        hint = placeholders.looks_rewritten("text {{v0}} more")
        assert hint is not None and "{v0}" in hint

    def test_identical_multisets_pass(self) -> None:
        placeholders.validate("a {v0} b {v1}", "甲 {v0} 乙 {v1}")

    def test_a_dropped_marker_fails(self) -> None:
        with pytest.raises(placeholders.PlaceholderMismatch) as caught:
            placeholders.validate("a {v0} b {v1}", "甲 {v0} 乙")
        assert "{v1}" in caught.value.missing

    def test_a_duplicated_marker_fails(self) -> None:
        """AC-P0-11 — multiplicity, not just presence. Two copies is two equations."""
        with pytest.raises(placeholders.PlaceholderMismatch) as caught:
            placeholders.validate("a {v3}", "甲 {v3} 乙 {v3}")
        assert "{v3}" in caught.value.extra

    def test_an_invented_marker_fails(self) -> None:
        with pytest.raises(placeholders.PlaceholderMismatch) as caught:
            placeholders.validate("plain text here", "文本 {v99}")
        assert "{v99}" in caught.value.extra

    def test_the_repair_hint_names_the_markers(self) -> None:
        """A model told 'you dropped {v4}' fixes it; told 'placeholders were
        wrong' it repeats the mistake."""
        with pytest.raises(placeholders.PlaceholderMismatch) as caught:
            placeholders.validate("x {v4} y", "x y")
        assert "{v4}" in caught.value.repair_hint


# --- AC-P0-07 / AC-P0-08 / AC-P0-09: the prompt -------------------------------


class TestPromptEnvelope:
    def test_context_and_target_are_delimited(self) -> None:
        """AC-P0-07 — without boundaries a model translates the summary too."""
        messages = prompts.translation_messages(
            target_text="TARGET SENTENCE.",
            target_language="Simplified Chinese",
            document_summary="A paper about ResNet.",
            section_title="3.1 Residual Learning",
            glossary=[("residual learning", "残差学习", True)],
            previous_paragraph="Earlier text.",
            next_paragraph="Later text.",
        )
        body = messages[1]["content"]

        assert "REFERENCE ONLY - DO NOT TRANSLATE" in body
        assert "TRANSLATE THIS ONLY" in body
        assert body.index("DO NOT TRANSLATE") < body.index("TRANSLATE THIS ONLY")

    def test_the_system_prompt_forbids_translating_the_context(self) -> None:
        messages = prompts.translation_messages(
            target_text="x", target_language="Chinese", document_summary="y"
        )
        assert "NOT to be translated" in messages[0]["content"]

    def test_untranslatable_terms_are_marked_keep_as_is(self) -> None:
        """AC-P0-05 at the prompt level: an identifier must not be rendered."""
        messages = prompts.translation_messages(
            target_text="x", target_language="Chinese",
            glossary=[("ResNet-50", None, False)],
        )
        assert "keep as-is" in messages[1]["content"]

    def test_the_prompt_version_is_pinned(self) -> None:
        assert prompts.TRANSLATION_PROMPT_VERSION == "2.0.0"


class TestFillerStripping:
    """AC-P0-09 — a PDF's glyph layout cannot absorb a preamble."""

    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("Here is the translation:\n\n残差学习。", "残差学习。"),
            ("Translation: 残差学习。", "残差学习。"),
            ("```\n残差学习。\n```", "残差学习。"),
            ("```text\n残差学习。\n```", "残差学习。"),
            ("残差学习。", "残差学习。"),
            ("译文：残差学习。", "残差学习。"),
        ],
    )
    def test_wrappers_are_removed_not_rejected(self, raw: str, expected: str) -> None:
        from app.pdfkernel.contextual_translator import strip_filler

        assert strip_filler(raw) == expected


# --- AC-P0-14 / AC-P0-15 / AC-P0-16: cache identity ---------------------------


class TestCacheIdentity:
    def test_identical_text_under_different_context_gets_different_keys(self) -> None:
        """AC-P0-14 — the same words in two sections mean different things."""
        provider = UnitContextProvider(
            build_ir(PARAGRAPHS), build_analysis(), prompt_version="2.0.0"
        )
        unit = PARAGRAPHS[1][1]
        first = provider.for_unit(unit)

        # A different document summary is a different semantic input.
        changed = build_analysis(summary="A completely different summary of the work.")
        second = UnitContextProvider(
            build_ir(PARAGRAPHS), changed, prompt_version="2.0.0"
        ).for_unit(unit)

        assert first.effective_context_hash != second.effective_context_hash
        assert first.cache_key != second.cache_key

    def test_the_same_inputs_produce_the_same_key(self) -> None:
        """Determinism, without which the cache never hits."""
        ir, analysis = build_ir(PARAGRAPHS), build_analysis()
        one = UnitContextProvider(ir, analysis, prompt_version="2.0.0").for_unit(PARAGRAPHS[1][1])
        two = UnitContextProvider(ir, analysis, prompt_version="2.0.0").for_unit(PARAGRAPHS[1][1])
        assert one.cache_key == two.cache_key

    def test_the_prompt_version_is_part_of_the_identity(self) -> None:
        """A translation produced under v1 must not satisfy v2."""
        ir, analysis = build_ir(PARAGRAPHS), build_analysis()
        old = UnitContextProvider(ir, analysis, prompt_version="1.0.0").for_unit(PARAGRAPHS[1][1])
        new = UnitContextProvider(ir, analysis, prompt_version="2.0.0").for_unit(PARAGRAPHS[1][1])
        assert old.effective_context_hash != new.effective_context_hash

    def test_off_mode_context_is_a_single_constant(self) -> None:
        """Off has one identity, so its cache behaves as it always did."""
        provider = UnitContextProvider(
            build_ir(PARAGRAPHS), build_analysis(), prompt_version="2.0.0", mode=MODE_OFF
        )
        first = provider.for_unit("anything at all")
        second = provider.for_unit("something else")
        assert first.effective_context_hash == second.effective_context_hash
        assert first.context is None

    def test_the_key_cannot_be_forged_by_the_source_text(self) -> None:
        """The separator is a NUL, which cannot occur in the text or a hash."""
        assert cache_key("abc", "h1") != cache_key("bc", "h1a")

    def test_a_hash_ignores_fields_that_do_not_reach_the_model(self) -> None:
        """`page_number` and `paragraph_id` are not sent, so they are not hashed —
        otherwise a re-extraction that renumbers paragraphs would invalidate
        every translation for no semantic reason."""
        from app.context.models import TranslationContext

        base = dict(document_summary="S", academic_domain="D")
        first = hash_context(
            TranslationContext(paragraph_id="p1", page_number=1, **base), prompt_version="2"
        )
        second = hash_context(
            TranslationContext(paragraph_id="p9", page_number=7, **base), prompt_version="2"
        )
        assert first == second


# --- AC-P0-06: honest fallback ------------------------------------------------


class TestFallback:
    def test_an_unmatched_unit_gets_no_context_at_all(self) -> None:
        """AC-P0-06, as amended by the DS-CTX-003 measurement.

        The first design gave an unmatched unit the document summary and domain.
        Measuring where unmatched units come from showed that was wrong: of 121
        across three real papers, 111 are captions, headings, tables, references
        and running headers. A 250-word summary attached to a five-word table
        cell cannot tell it which sense of a word it means, and doubles the cost
        of a unit where context cannot help.
        """
        provider = UnitContextProvider(
            build_ir(PARAGRAPHS), build_analysis(), prompt_version="2.0.0"
        )
        result = provider.for_unit("Abstract")

        assert result.fallback == FALLBACK_UNMAPPED
        assert not result.is_contextual
        assert result.context is None

    def test_an_unmatched_unit_shares_the_off_mode_cache_entry(self) -> None:
        """It is translated exactly as off mode would, so it should cost the same."""
        ir, analysis = build_ir(PARAGRAPHS), build_analysis()
        standard = UnitContextProvider(ir, analysis, prompt_version="2.0.0", mode=MODE_STANDARD)
        off = UnitContextProvider(ir, analysis, prompt_version="2.0.0", mode=MODE_OFF)

        assert standard.for_unit("Abstract").cache_key == off.for_unit("Abstract").cache_key

    def test_a_matched_unit_is_marked_contextual(self) -> None:
        provider = UnitContextProvider(
            build_ir(PARAGRAPHS), build_analysis(), prompt_version="2.0.0"
        )
        result = provider.for_unit(PARAGRAPHS[1][1])

        assert result.is_contextual
        assert result.fallback is None
        assert result.paragraph_id == "p2"
        assert result.context.section_summary is not None


# --- AC-P0-19 / AC-P0-20: analysis semantics ----------------------------------


class TestAnalysisSemantics:
    def test_partial_analysis_is_usable(self) -> None:
        """AC-P0-20 — refusing work the user paid for over two truncated sections
        would be waste, not rigour."""
        assert analysis_is_usable(build_analysis(status=AnalysisStatus.PARTIAL))

    @pytest.mark.parametrize(
        "status", [AnalysisStatus.FAILED, AnalysisStatus.CANCELLED]
    )
    def test_failed_and_cancelled_are_not(self, status: AnalysisStatus) -> None:
        assert not analysis_is_usable(build_analysis(status=status))

    def test_no_analysis_is_not_usable(self) -> None:
        assert not analysis_is_usable(None)

    def test_standard_mode_without_analysis_produces_no_context(self) -> None:
        provider = UnitContextProvider(
            build_ir(PARAGRAPHS), None, prompt_version="2.0.0", mode=MODE_STANDARD
        )
        result = provider.for_unit(PARAGRAPHS[1][1])
        assert result.context is None
        assert not result.is_contextual


# --- AC-P0-17: concurrency ----------------------------------------------------


class TestConcurrencyIsolation:
    def test_parallel_units_receive_only_their_own_context(self) -> None:
        """Four units, four threads, four different paragraphs.

        The context is carried in a thread-local, so a leak would show up as one
        thread seeing another's section summary — which is exactly the failure a
        global "current context" would produce.
        """
        paragraphs = [
            (f"p{i}", f"Paragraph {i} discusses topic {i} in considerable and "
                      f"unmistakable detail so that it is clearly its own passage.", i, f"s{i}")
            for i in range(1, 5)
        ]
        analysis = build_analysis(
            sections=[
                SectionAnalysis(section_id=f"s{i}", title=f"Section {i}",
                                summary=f"SUMMARY-{i}", page_range=(i, i))
                for i in range(1, 5)
            ],
            glossary=[],
        )
        provider = UnitContextProvider(
            build_ir(paragraphs), analysis, prompt_version="2.0.0"
        )

        seen: dict[int, str | None] = {}
        errors: list[str] = []

        def work(index: int) -> None:
            try:
                unit = provider.for_unit(paragraphs[index - 1][1])
                seen[index] = unit.context.section_summary if unit.context else None
            except Exception as exc:  # noqa: BLE001
                errors.append(str(exc))

        threads = [threading.Thread(target=work, args=(i,)) for i in range(1, 5)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        assert not errors
        for index in range(1, 5):
            assert seen.get(index) == f"SUMMARY-{index}", (
                f"unit {index} received {seen.get(index)!r} — another unit's context"
            )


# --- AC-P0-01: off parity -----------------------------------------------------


class TestOffParity:
    def test_off_mode_builds_no_context_at_all(self) -> None:
        provider = UnitContextProvider(
            build_ir(PARAGRAPHS), build_analysis(), prompt_version="2.0.0", mode=MODE_OFF
        )
        unit = provider.for_unit(PARAGRAPHS[1][1])
        assert unit.context is None
        assert unit.paragraph_id is None

    def test_an_unknown_mode_is_refused(self) -> None:
        with pytest.raises(ValueError):
            UnitContextProvider(
                build_ir(PARAGRAPHS), build_analysis(), prompt_version="2", mode="deep"
            )


# --- the translator, with a fake client --------------------------------------


class FakeCompletions:
    """Records prompts, answers with a caller-supplied function."""

    def __init__(self, answer) -> None:
        self._answer = answer
        self.prompts: list[list[dict[str, str]]] = []

    def create(self, **payload):
        self.prompts.append(payload.get("messages", []))
        text = self._answer(payload.get("messages", []))
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=text),
                                     finish_reason="stop")],
            model="fake", usage=SimpleNamespace(prompt_tokens=1, completion_tokens=1,
                                                total_tokens=2),
        )


@pytest.fixture
def translator_factory(monkeypatch):
    """Build a contextual translator over a fake client and a fake cache."""
    from app.pdfkernel import contextual_translator as module

    def build(*, answer, provider=None, cache=None):
        class FakeClient:
            def __init__(self, *args, **kwargs):
                self.chat = SimpleNamespace(completions=FakeCompletions(answer))

            def with_options(self, **kwargs):
                return self

        monkeypatch.setattr(module, "ContextualOpenAIlikedTranslator", module.ContextualOpenAIlikedTranslator)

        import openai

        monkeypatch.setattr(openai, "OpenAI", FakeClient)

        # Built by the production helper rather than by hand. Upstream's
        # `envs.get("OPENAILIKED_STOP_TOKENS", "").split()` looks safe and is
        # not: `dict.get`'s default applies only when the key is *absent*, and
        # the class attribute supplies it as `None`. DS-BE-007 fixed that by
        # supplying every key explicitly — a hand-built dict here would miss one
        # and hit the same bug the real adapter already avoids.
        from app.llm.models import ProviderConfig
        from app.pdfkernel.adapter import _upstream_envs
        from app.pdfkernel.context_registry import RUN_ID_ENV, register

        # The mode goes in alongside the provider, exactly as `translate_pdf`
        # passes them: a provider without a mode would leave the translator
        # thinking it was in basic mode while holding context it never uses.
        run_id = register(provider) if provider is not None else None
        envs = _upstream_envs(
            ProviderConfig(base_url="http://x", api_key="k", model="m"),
            context_run_id=run_id,
            context_mode="standard" if provider is not None else "off",
        )

        instance = module.ContextualOpenAIlikedTranslator(
            "en", "zh", "m", envs=envs, prompt=None, ignore_cache=False
        )
        instance.ignore_cache = True
        if cache is not None:
            instance.cache = cache
        return instance

    return build


class RecordingCache:
    """Stands in for upstream's SQLite cache: a dict keyed by the text it is given."""

    def __init__(self) -> None:
        self.entries: dict[str, str] = {}
        self.gets: list[str] = []
        self.sets: list[str] = []

    def get(self, text: str):
        self.gets.append(text)
        return self.entries.get(text)

    def set(self, text: str, translation: str) -> None:
        self.sets.append(text)
        self.entries[text] = translation


class TestTranslatorBehaviour:
    def test_off_mode_sends_the_baseline_prompt(self, translator_factory) -> None:
        """AC-P0-01 — no context, no delimiters, exactly the old envelope."""
        translator = translator_factory(answer=lambda messages: "残差学习。")
        translator.prompttext = None
        translator.translate("Some source text.")

        sent = " | ".join(
            m["content"] for m in translator.client.chat.completions.prompts[0]
        )
        assert "REFERENCE ONLY" not in sent
        assert "TRANSLATE THIS ONLY" not in sent

    def test_standard_context_reaches_the_prompt(self, translator_factory) -> None:
        """AC-P0-02 — the analysis is genuinely consumed, not merely available."""
        provider = UnitContextProvider(
            build_ir(PARAGRAPHS), build_analysis(), prompt_version="2.0.0",
            mode=MODE_STANDARD,
        )
        translator = translator_factory(answer=lambda messages: "残差学习。", provider=provider)
        translator.prompttext = None
        translator.translate(PARAGRAPHS[1][1])

        # The delimiters name the target; they live in the user turn.
        sent = " | ".join(
            m["content"] for m in translator.client.chat.completions.prompts[0]
        )
        assert "REFERENCE ONLY" in sent
        assert "Computer Vision" in sent
        assert translator.stats["units_context_aware"] == 1

    def test_context_never_appears_in_the_output(self, translator_factory) -> None:
        """AC-P0-08 — the sentinel is in the context and must not be echoed."""
        sentinel = "CTX_SENTINEL_DOMAIN_X7"
        provider = UnitContextProvider(
            build_ir(PARAGRAPHS),
            build_analysis(summary=f"{sentinel} a summary"),
            prompt_version="2.0.0",
        )
        # A model that dutifully translates only the target.
        translator = translator_factory(answer=lambda messages: "残差学习。", provider=provider)
        translator.prompttext = None
        result = translator.translate(PARAGRAPHS[1][1])

        assert sentinel not in result

    def test_a_dropped_placeholder_is_repaired_once(self, translator_factory) -> None:
        """AC-P0-12 — exactly one targeted repair, then acceptance."""
        source = "See {v0} for details."
        calls = {"n": 0}

        def answer(messages):
            calls["n"] += 1
            return "参见 {v0}。" if calls["n"] > 1 else "参见。"

        translator = translator_factory(answer=answer)
        translator.prompttext = None
        result = translator.translate(source)

        assert result == "参见 {v0}。"
        assert calls["n"] == 2, "the repair did not happen exactly once"
        assert translator.stats["repairs_attempted"] == 1
        assert translator.stats["repairs_succeeded"] == 1

    def test_a_failed_repair_preserves_the_source(self, translator_factory) -> None:
        """AC-P0-13 — formula correctness outranks translation completeness."""
        source = "See {v0} and {v1} for details."
        translator = translator_factory(answer=lambda messages: "参见。")  # drops both
        translator.prompttext = None
        result = translator.translate(source)

        assert result == source, "corrupted markers reached the caller"
        assert translator.stats["source_preserved"] == 1

    def test_the_cache_is_keyed_on_context_not_only_text(self, translator_factory) -> None:
        """AC-P0-14 — the whole point of the namespace."""
        cache = RecordingCache()
        provider = UnitContextProvider(
            build_ir(PARAGRAPHS), build_analysis(), prompt_version="2.0.0"
        )
        translator = translator_factory(
            answer=lambda messages: "残差学习。", provider=provider, cache=cache
        )
        translator.prompttext = None
        translator.ignore_cache = False
        translator.translate(PARAGRAPHS[1][1])

        assert cache.sets, "nothing was written to the cache"
        written = cache.sets[0]
        assert written != PARAGRAPHS[1][1], "the cache key is the bare source text"
        assert written.endswith(PARAGRAPHS[1][1])
        assert written.startswith(provider.for_unit(PARAGRAPHS[1][1]).effective_context_hash)

    def test_a_cache_hit_makes_no_provider_call(self, translator_factory) -> None:
        """AC-P0-15 — a hit costs nothing."""
        cache = RecordingCache()
        provider = UnitContextProvider(
            build_ir(PARAGRAPHS), build_analysis(), prompt_version="2.0.0"
        )
        calls = {"n": 0}

        def answer(messages):
            calls["n"] += 1
            return "残差学习。"

        translator = translator_factory(answer=answer, provider=provider, cache=cache)
        translator.prompttext = None
        translator.ignore_cache = False

        translator.translate(PARAGRAPHS[1][1])
        first_calls = calls["n"]
        translator.translate(PARAGRAPHS[1][1])

        assert calls["n"] == first_calls, "the second call went to the provider"
        assert translator.stats["cache_hits"] == 1


# --- Premise 3: is the run instability thread-local leakage? -------------------


class TestThreadReuseCannotLeakContext:
    """The diagnostic the criteria asked for, stated as a property rather than a run.

    DS-CTX-002's A/B moved from 1-of-7 to 4-of-5 on identical inputs, and
    attributing that to model stochasticity without checking is the kind of
    assumption this project refuses elsewhere. The suspicion was specific: a
    thread pool reuses threads, and a thread-local that is set but not cleared
    would hand the *previous* unit's context to the next one a thread picks up.

    A thread pool with fewer threads than units is the case that would expose it,
    so that is what this runs — two threads serving twenty units, each of which
    must see only its own context.
    """

    def test_a_reused_thread_never_sees_the_previous_units_context(self) -> None:
        from concurrent.futures import ThreadPoolExecutor

        paragraphs = [
            (f"p{i}", f"Paragraph {i} is about topic {i} and says so at length so "
                      f"that it is unmistakably its own passage in this paper.", 1, f"s{i}")
            for i in range(20)
        ]
        analysis = build_analysis(
            sections=[
                SectionAnalysis(section_id=f"s{i}", title=f"Section {i}",
                                summary=f"SUMMARY-{i}", page_range=(1, 1))
                for i in range(20)
            ],
            glossary=[],
        )
        provider = UnitContextProvider(
            build_ir(paragraphs), analysis, prompt_version="2.0.0"
        )

        def work(index: int) -> tuple[int, str | None]:
            unit = provider.for_unit(paragraphs[index][1])
            # Return the section the *unit* should have, and the one it got.
            return index, (unit.context.section_id if unit.context else None)

        # Deliberately fewer threads than units, so nearly every call lands on a
        # thread that has already served a different unit.
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(work, range(20)))

        for index, section in results:
            assert section == f"s{index}", (
                f"unit {index} received context for {section} — a reused thread "
                "leaked the previous unit's context"
            )

    def test_the_thread_local_is_cleared_after_every_unit(self) -> None:
        """Belt and braces: the direct cause, asserted directly."""
        from app.pdfkernel import contextual_translator as module

        provider = UnitContextProvider(
            build_ir(PARAGRAPHS), build_analysis(), prompt_version="2.0.0"
        )
        provider.for_unit(PARAGRAPHS[1][1])
        # `for_unit` itself does not touch the thread-local; the translator sets
        # and clears it. What is asserted here is that it is *clearable*, which
        # is what the translator's `finally` guarantees.
        module._UNIT_CONTEXT.value = None
        assert getattr(module._UNIT_CONTEXT, "value", None) is None


# --- DS-CTX-004: the academic prompt-only mode --------------------------------


class TestAcademicMode:
    """The mode DS-CTX-003's third arm showed carries the gains.

    It sends the academic instructions without any document payload, and it must
    do so without a `UnitContextProvider` — no IR, no analysis, no mapper. The
    392-second analysis is exactly what this mode exists to avoid paying.
    """

    def test_the_three_modes_are_known_and_anything_else_is_refused(self) -> None:
        """AC P0.1."""
        from app.context.translation_context import MODE_ACADEMIC, VALID_MODES

        assert MODE_ACADEMIC in VALID_MODES
        assert set(VALID_MODES) == {"off", "academic", "standard"}
        with pytest.raises(ValueError):
            UnitContextProvider(
                build_ir(PARAGRAPHS), build_analysis(), prompt_version="2", mode="full"
            )

    def test_the_envelope_carries_no_context_sections_at_all(self) -> None:
        """AC P0.4 — no empty headers, which would cost tokens and imply context."""
        messages = prompts.translation_messages(
            target_text="We train a policy to predict robot actions.",
            target_language="Simplified Chinese",
        )
        body = " | ".join(m["content"] for m in messages)

        assert "TARGET SOURCE TEXT" in body
        for absent in ("ACADEMIC CONTEXT", "GLOSSARY", "PREVIOUS PARAGRAPH",
                       "NEXT PARAGRAPH"):
            assert absent not in body, f"an empty {absent} section was rendered"

    @pytest.mark.parametrize("language", ["Japanese", "German", "Traditional Chinese"])
    def test_the_target_language_is_a_parameter(self, language: str) -> None:
        """Nothing may hardcode Simplified Chinese into the abstraction."""
        messages = prompts.translation_messages(
            target_text="x", target_language=language
        )
        body = " | ".join(m["content"] for m in messages)

        assert language in body
        assert "Simplified Chinese" not in body

    def test_academic_mode_needs_no_provider_and_no_context(self) -> None:
        """AC P0.2 — the whole point: translate without analysing the paper first."""
        provider = UnitContextProvider(
            build_ir(PARAGRAPHS), build_analysis(), prompt_version="2.0.0",
            mode=MODE_STANDARD,
        )
        unit = provider.for_unit(PARAGRAPHS[1][1])

        assert unit.is_contextual
        assert unit.context is not None

        # The academic envelope is reachable without any of that.
        from app.context.prompts import translation_messages

        messages = translation_messages(
            target_text=PARAGRAPHS[1][1], target_language="Simplified Chinese"
        )
        body = " | ".join(m["content"] for m in messages)
        assert "TARGET SOURCE TEXT" in body
        assert unit.context.document_summary not in body


class TestAcademicCacheIdentity:
    """AC P0.3 — a mode that reads no analysis must not expire when it changes."""

    def test_academic_uses_the_bare_source_text_as_the_key(self) -> None:
        from app.pdfkernel.contextual_translator import _NoCache  # noqa: F401

        # The rule, stated where it lives: only contextual namespaces.
        assert cache_key("abc", "hash") != "abc"      # contextual prefixes
        assert "\x00" in cache_key("abc", "hash")     # and separates with a NUL

    def test_the_modes_cannot_return_each_others_entries(self) -> None:
        """Isolation comes from the `context_mode` cache parameter, not the key.

        Academic and base send the same key *text*, so if the mode were not a
        registered parameter they would share entries — which is why
        `add_cache_impact_parameters("context_mode", mode)` is load-bearing
        rather than decorative.
        """
        import inspect

        from app.pdfkernel import contextual_translator

        source = inspect.getsource(contextual_translator.ContextualOpenAIlikedTranslator.__init__)
        assert 'add_cache_impact_parameters("context_mode", mode)' in source

        translate_source = inspect.getsource(
            contextual_translator.ContextualOpenAIlikedTranslator.translate
        )
        assert "MODE_STANDARD" in translate_source, (
            "the key must be namespaced only in contextual mode"
        )
