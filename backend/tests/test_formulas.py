"""DS-DOC-010 — display formulas typeset from reconstructed LaTeX.

Everything here is deterministic and provider-free except one scripted provider
that behaves like a model doing its job. The interesting rules are about *what a
failed answer is allowed to become* — a refusal or a failed item that says so,
not mathematics nobody wrote — and about what this pipeline never does: pair
equation numbers. That is the reading column's view, assembled by the frontend's
reflow stream where the IR's blocks already live, and a rule implemented in two
places is a rule that will disagree in one of them.
"""

from __future__ import annotations

import json

import pytest

from app.document.models import TextBlockIR
from app.formulas.cache import (
    cache_is_compatible,
    formulas_path,
    read_formulas,
    write_formulas,
)
from app.formulas.models import (
    FORMULA_SCHEMA_VERSION,
    FormulaArtifact,
    FormulaItemView,
)
from app.formulas.pipeline import generate_formulas, plan, prose_window
from app.formulas.prompt import (
    MAX_FORMULAS_PER_BATCH,
    PROSE_WINDOW_CHARS,
    build_messages,
)
from app.llm.base import LLMProvider
from app.llm.models import LLMRequest, LLMResult, LLMUsage
from tests.test_bilingual import an_ir, paragraph, section


def formula(
    identifier: str,
    page: int,
    soup: str,
    *,
    font_size: float | None = 9.3,
    bbox: tuple[float, float, float, float] = (72.0, 300.0, 400.0, 330.0),
) -> TextBlockIR:
    """An isolate_formula block the way the reader's paper carries them: a
    persistent anchor, a dominant font size, and soup for text."""
    return TextBlockIR(
        id=identifier, page_index=page - 1, page_number=page,
        layout_class="isolate_formula", bbox=bbox, text=soup,
        font_size=font_size, source_anchor_id=f"fx_{identifier}",
    )


def number(
    identifier: str,
    page: int,
    text: str,
    *,
    bbox: tuple[float, float, float, float] = (500.0, 310.0, 540.0, 330.0),
    layout_class: str = "formula_caption",
    caption_of: str | None = None,
) -> TextBlockIR:
    return TextBlockIR(
        id=identifier, page_index=page - 1, page_number=page,
        layout_class=layout_class, bbox=bbox, text=text, caption_of=caption_of,
    )


class ScriptedProvider(LLMProvider):
    """A model that reconstructs every formula it is given."""

    protocol = "scripted"

    def __init__(self, *answers: str, usage: LLMUsage | None = None) -> None:
        self._answers = list(answers)
        self._usage = usage
        self.requests: list[LLMRequest] = []

    async def generate(self, request: LLMRequest) -> LLMResult:
        self.requests.append(request)
        text = self._answers.pop(0) if self._answers else self._answer_for(request)
        return LLMResult(text=text, model="scripted", protocol=self.protocol, usage=self._usage)

    @staticmethod
    def _answer_for(request: LLMRequest) -> str:
        """Reconstruct whatever ids the request carries — the shape a real model
        is asked for, so a batch's ids come back exactly once."""
        import re

        # The *first* message carrying the formulas, not the last: a repair
        # request appends to the conversation, and the formulas are still in the
        # original turn — which is exactly what the repair relies on. Keyed on
        # the user message's opening line, which the system prompt never
        # carries, so its example ids can never be read as input.
        content = next(
            (message.content for message in request.messages
             if "Formulas to reconstruct:" in message.content),
            "",
        )
        identifiers = re.findall(r'"block_id":\s*"([^"]+)"', content)
        return json.dumps({
            "formulas": [
                {"block_id": key, "status": "reconstructed", "latex": f"y_{key} = x + 1"}
                for key in identifiers
            ],
        })

    async def test_connection(self):  # pragma: no cover - not exercised
        raise NotImplementedError


class TestThePlan:
    def test_seven_formulas_are_one_batch(self) -> None:
        ir = an_ir([], [], blocks=[formula(f"b{i}", 1, f"L_{i}") for i in range(1, 8)])
        work = plan(ir)
        assert work.formula_count == 7
        assert work.batch_count == 1
        assert len(work.batches[0].entries) == 7 <= MAX_FORMULAS_PER_BATCH
        # The character volume the 404 discloses is the glyph soup the calls
        # will actually carry: seven soups of three characters each.
        assert work.character_volume == 21

    def test_sixty_six_formulas_are_five_batches(self) -> None:
        ir = an_ir([], [], blocks=[formula(f"b{i}", 1, f"L_{i}") for i in range(1, 67)])
        work = plan(ir)
        assert work.batch_count == 5
        assert [len(batch.entries) for batch in work.batches] == [15, 15, 15, 15, 6]

    def test_only_isolate_formula_blocks_are_planned(self) -> None:
        ir = an_ir([], [], blocks=[
            formula("b1", 1, "L = x"),
            number("n1", 1, "(1)"),
            TextBlockIR(
                id="c1", page_index=0, page_number=1, layout_class="figure_caption",
                bbox=(0.0, 0.0, 1.0, 1.0), text="Figure 1.",
            ),
        ])
        assert [entry.block_id for entry in plan(ir).batches[0].entries] == ["b1"]

    def test_reading_order_is_page_order(self) -> None:
        ir = an_ir([], [], pages=2, blocks=[
            formula("b3", 2, "z"),  # page 2, listed first on purpose
            formula("b1", 1, "x"),
            formula("b2", 1, "y"),
        ])
        assert [entry.block_id for entry in plan(ir).batches[0].entries] == ["b1", "b2", "b3"]


class TestThePrompt:
    def test_the_prompt_carries_everything_the_criterion_names(self) -> None:
        """AC-P0-04: the id, the soup, the font size, the page and bbox, and the
        prose window — each formula's own."""
        ir = an_ir(
            [paragraph(
                "p1", "NEAR_MARKER where tau is the temperature parameter. " * 20,
                section="s1",
            )],
            [section("s1", "1. Introduction")],
            blocks=[formula("b2", 1, "LInfoNCE = -1 / 2B / B / X / i=1")],
        )
        messages = build_messages(plan(ir).batches[0].entries)
        user = messages[1]["content"]
        assert '"block_id": "b2"' in user
        assert '"source_anchor_id": "fx_b2"' in user
        assert "LInfoNCE = -1 / 2B / B / X / i=1" in user  # the soup itself
        assert '"font_size": 9.3' in user
        assert '"page_number": 1' in user
        assert '"bbox": [72.0, 300.0, 400.0, 330.0]' in user
        assert "NEAR_MARKER" in user  # the prose window

    def test_the_window_is_the_nearest_prose_and_nothing_distant(self) -> None:
        near = "NEAR_MARKER the contrastive loss uses a temperature parameter tau. " * 20
        far = "FAR_MARKER " * 200
        block = formula("b2", 1, "L = -1/2B")
        ir = an_ir(
            [paragraph("p1", near, section="s1"), paragraph("p2", far, section="s1")],
            [section("s1", "1. Introduction")],
            blocks=[block],
        )
        window = prose_window(ir, block)
        assert "NEAR_MARKER" in window
        assert "FAR_MARKER" not in window
        assert window == near, "the distant paragraph is beyond ±800 characters"

    def test_the_window_is_bounded_by_the_radius(self) -> None:
        block = formula("b2", 1, "L = -1/2B")
        ir = an_ir(
            [paragraph("p1", "word " * 30, section="s1") for _ in range(30)],
            [section("s1", "1. Introduction")],
            blocks=[block],
        )
        window = prose_window(ir, block)
        # Snapping to paragraph boundaries may overshoot by the largest
        # paragraph on each side, but the window is the radius, not the paper.
        assert len(window) <= 2 * PROSE_WINDOW_CHARS + 2 * len("word " * 30)


class TestGeneration:
    def _ir(self):
        first = formula("b1", 1, "LInfoNCE = -1 / 2B ...")
        second = formula("b2", 1, "LSigLIP = -1 / B ...", bbox=(72.0, 420.0, 400.0, 450.0))
        return an_ir(
            [paragraph(
                "p1", "The contrastive loss uses a temperature parameter. " * 10,
                section="s1",
            )],
            [section("s1", "1. Introduction")],
            blocks=[
                first, number("n1", 1, "(1)"),
                second, number("n2", 1, "(2)", bbox=(500.0, 430.0, 540.0, 450.0)),
            ],
        )

    @pytest.mark.asyncio
    async def test_every_formula_comes_back_reconstructed(self) -> None:
        provider = ScriptedProvider()
        outcome = await generate_formulas(self._ir(), provider)
        assert outcome.artifact.status == "READY"
        assert outcome.artifact.reconstructed_count == 2
        assert outcome.provider_calls == plan(self._ir()).batch_count
        assert all(item.is_renderable_latex() for item in outcome.artifact.formulas)

    @pytest.mark.asyncio
    async def test_the_equation_number_slot_is_left_to_the_assembler(self) -> None:
        """Pairing is the reading column's view, not reconstruction: the model's
        answer may carry an equation number and the page carries its own blocks,
        and this pipeline trusts neither — it leaves the slot empty for the
        frontend's reflow stream to fill."""
        answer = json.dumps({"formulas": [
            {"block_id": "b1", "status": "reconstructed", "latex": "y = x", "equation_number": "(99)"},
            {"block_id": "b2", "status": "reconstructed", "latex": "z = w", "equation_number": "(99)"},
        ]})
        outcome = await generate_formulas(self._ir(), ScriptedProvider(answer))
        assert [item.equation_number for item in outcome.artifact.formulas] == [None, None]

    @pytest.mark.asyncio
    async def test_an_explicit_refusal_is_recorded(self) -> None:
        answer = json.dumps({"formulas": [
            {"block_id": "b1", "status": "refusal", "refusal_reason": "符号已无法辨认"},
            {"block_id": "b2", "status": "reconstructed", "latex": "z = w"},
        ]})
        outcome = await generate_formulas(self._ir(), ScriptedProvider(answer))
        artifact = outcome.artifact
        assert artifact.status == "PARTIAL"
        assert artifact.refused_count == 1
        refused = artifact.formulas[0]
        assert refused.status == "refusal"
        assert refused.refusal_reason == "符号已无法辨认"
        assert not refused.is_renderable_latex()

    @pytest.mark.asyncio
    async def test_a_refusal_without_a_reason_gets_the_default(self) -> None:
        answer = json.dumps({"formulas": [
            {"block_id": "b1", "status": "refusal"},
            {"block_id": "b2", "status": "reconstructed", "latex": "z = w"},
        ]})
        outcome = await generate_formulas(self._ir(), ScriptedProvider(answer))
        assert outcome.artifact.formulas[0].refusal_reason == "模型无法根据字形重建该公式"

    @pytest.mark.asyncio
    async def test_malformed_json_is_repaired_on_retry(self) -> None:
        provider = ScriptedProvider("not json")  # then the scripted answer
        outcome = await generate_formulas(self._ir(), provider)
        assert outcome.artifact.status == "READY"
        assert outcome.repaired == 1
        assert outcome.provider_calls == plan(self._ir()).batch_count + 1

    @pytest.mark.asyncio
    async def test_an_unrecoverable_failure_leaves_honest_gaps(self) -> None:
        """Two unusable answers: one repair, then the batch is reported failed
        rather than filled in."""
        provider = ScriptedProvider("not json", "still not json")
        outcome = await generate_formulas(self._ir(), provider)

        assert outcome.artifact.status == "FAILED"
        assert outcome.failed_batches == 1
        assert all(item.status == "failed" for item in outcome.artifact.formulas)
        assert all(item.error_reason for item in outcome.artifact.formulas)
        assert outcome.provider_calls == 2, "one call and one repair, not a loop"
        assert outcome.artifact.notes

    @pytest.mark.asyncio
    async def test_a_missing_entry_is_reported_not_invented(self) -> None:
        answer = json.dumps({"formulas": [
            {"block_id": "b1", "status": "reconstructed", "latex": "y = x"},
        ]})
        outcome = await generate_formulas(self._ir(), ScriptedProvider(answer))
        artifact = outcome.artifact
        assert artifact.status == "PARTIAL"
        second = artifact.formulas[1]
        assert second.status == "failed"
        assert second.error_reason == "模型未给出该公式的答案"

    @pytest.mark.asyncio
    async def test_a_schema_violation_is_reported(self) -> None:
        """An entry whose status is neither of the two the schema allows is not
        an answer, and the formula it named stays missing."""
        answer = json.dumps({"formulas": [
            {"block_id": "b1", "status": "reconstructed", "latex": "y = x"},
            {"block_id": "b2", "status": "hallucinated"},
        ]})
        outcome = await generate_formulas(self._ir(), ScriptedProvider(answer))
        second = outcome.artifact.formulas[1]
        assert second.status == "failed"
        assert second.error_reason == "模型返回的条目无效"

    @pytest.mark.asyncio
    async def test_an_invented_id_is_not_a_formula(self) -> None:
        answer = json.dumps({"formulas": [
            {"block_id": "b1", "status": "reconstructed", "latex": "y = x"},
            {"block_id": "b_9999", "status": "reconstructed", "latex": "y = 9999"},
        ]})
        outcome = await generate_formulas(self._ir(), ScriptedProvider(answer))
        assert [item.block_id for item in outcome.artifact.formulas] == ["b1", "b2"]
        assert outcome.artifact.formulas[1].status == "failed"

    @pytest.mark.asyncio
    async def test_reported_usage_is_recorded_and_unreported_is_not(self) -> None:
        usage = LLMUsage(prompt_tokens=1200, completion_tokens=340, total_tokens=1540)
        reported = await generate_formulas(self._ir(), ScriptedProvider(usage=usage))
        assert reported.artifact.input_tokens == 1200 * reported.provider_calls
        assert reported.artifact.output_tokens == 340 * reported.provider_calls

        silent = await generate_formulas(self._ir(), ScriptedProvider())
        assert silent.artifact.input_tokens is None
        assert silent.artifact.output_tokens is None

    @pytest.mark.asyncio
    async def test_a_paper_without_formulas_makes_no_calls(self) -> None:
        ir = an_ir(
            [paragraph("p1", "Prose only. " * 10, section="s1")],
            [section("s1", "1. Introduction")],
        )
        outcome = await generate_formulas(ir, ScriptedProvider())
        assert outcome.artifact.status == "FAILED"
        assert outcome.provider_calls == 0
        assert outcome.artifact.total_formulas == 0
        assert "这篇论文没有行间公式" in outcome.artifact.notes


class TestTheCache:
    def an_artifact(self, **over) -> FormulaArtifact:
        base = {
            "content_hash": "a" * 64, "status": "READY", "ir_pipeline_version": "5",
            "provider_model": "some-model", "created_at": "2026-09-23T00:00:00+00:00",
            "total_formulas": 1, "reconstructed_count": 1,
            "formulas": [FormulaItemView(
                block_id="b_1", source_anchor_id="fx_b_1", page_number=1,
                bbox=(1.0, 2.0, 3.0, 4.0), raw_soup="L = x", font_size=9.3,
                status="reconstructed", latex="L = x", equation_number="(1)",
            )],
        }
        base.update(over)
        return FormulaArtifact(**base)

    def test_it_lives_in_its_own_directory_beside_the_bilingual_one(self, tmp_path) -> None:
        from app.formulas.cache import formulas_dir

        path = formulas_path(tmp_path, "a" * 64)
        assert path.parent == formulas_dir(tmp_path)
        assert path.parent.name == "formulas"
        assert path.name == f"{'a' * 64}.json"

    def test_every_invalidation_dimension_is_checked(self, tmp_path) -> None:
        store = {"content_hash": "a" * 64, "ir_pipeline_version": "5"}
        good = self.an_artifact()
        assert cache_is_compatible(good, **store) is True

        for changed in (
            {"content_hash": "b" * 64},
            {"ir_pipeline_version": "4"},
        ):
            assert cache_is_compatible(good, **{**store, **changed}) is False, changed
        for changed in (
            {"prompt_version": "0.9.0"},
            {"pipeline_version": "0.9.0"},
            {"schema_version": "0"},
            {"artifact_kind": "something_else"},
        ):
            assert cache_is_compatible(self.an_artifact(**changed), **store) is False, changed

    def test_another_model_does_not_invalidate(self, tmp_path) -> None:
        store = {"content_hash": "a" * 64, "ir_pipeline_version": "5"}
        write_formulas(tmp_path, self.an_artifact(provider_model="some-old-model"))
        found = read_formulas(tmp_path, **store)
        assert found is not None and found.provider_model == "some-old-model"
        assert found.schema_version == FORMULA_SCHEMA_VERSION

    def test_a_corrupt_cache_reads_as_absent(self, tmp_path) -> None:
        path = formulas_path(tmp_path, "a" * 64)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{not json", encoding="utf-8")
        assert read_formulas(
            tmp_path, content_hash="a" * 64, ir_pipeline_version="5"
        ) is None

    def test_a_round_trip_preserves_the_items(self, tmp_path) -> None:
        write_formulas(tmp_path, self.an_artifact(
            status="PARTIAL", refused_count=1,
            formulas=[
                FormulaItemView(
                    block_id="b_1", source_anchor_id="fx_b_1", page_number=2,
                    bbox=(1.0, 2.0, 3.0, 4.0), raw_soup="soup", font_size=6.5,
                    status="reconstructed", latex="y = x", equation_number="(3)",
                ),
                FormulaItemView(
                    block_id="b_2", source_anchor_id="fx_b_2", page_number=2,
                    bbox=(5.0, 6.0, 7.0, 8.0), raw_soup="soup2",
                    status="refusal", refusal_reason="unresolvable",
                ),
            ],
        ))
        found = read_formulas(tmp_path, content_hash="a" * 64, ir_pipeline_version="5")
        assert found is not None
        assert found.status == "PARTIAL"
        assert found.schema_version == FORMULA_SCHEMA_VERSION
        first, second = found.formulas
        assert first.equation_number == "(3)"
        assert first.bbox == (1.0, 2.0, 3.0, 4.0)
        assert first.font_size == 6.5
        assert first.source_anchor_id == "fx_b_1"
        assert second.status == "refusal"
        assert second.refusal_reason == "unresolvable"

    def test_a_failure_is_not_a_reading(self, tmp_path) -> None:
        store = {"content_hash": "a" * 64, "ir_pipeline_version": "5"}
        write_formulas(tmp_path, self.an_artifact(status="FAILED"))
        assert read_formulas(tmp_path, **store) is None

    def test_writing_formulas_leaves_the_bilingual_artifact_untouched(self, tmp_path) -> None:
        """AC-P0-01: the formulas' own directory, and not one byte of the
        reader's paid-for translation moves."""
        from app.bilingual.cache import bilingual_path, write_bilingual
        from app.bilingual.models import BilingualArtifact, BilingualParagraph

        write_bilingual(tmp_path, BilingualArtifact(
            content_hash="a" * 64, target_language="zh-CN", status="READY",
            ir_pipeline_version="5",
            paragraphs=[BilingualParagraph(
                paragraph_id="p_1", page_number=1, source_text="Prose.",
                translated_text="译文。",
            )],
        ))
        bilingual = bilingual_path(tmp_path, "a" * 64, "zh-CN")
        before_bytes = bilingual.read_bytes()
        before_mtime = bilingual.stat().st_mtime_ns

        write_formulas(tmp_path, self.an_artifact())

        assert bilingual.read_bytes() == before_bytes
        assert bilingual.stat().st_mtime_ns == before_mtime
        assert formulas_path(tmp_path, "a" * 64).is_file()
