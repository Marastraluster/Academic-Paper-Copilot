"""DS-DOC-006 — the paragraph-aligned reading: batching, honesty, and the cache.

Everything here is deterministic and provider-free except one scripted provider
that behaves like a model doing its job. The interesting rules are about *what a
failed batch is allowed to become* — an untranslated paragraph that says so, not
prose nobody wrote — and about which units are never sent at all: a formula has no
language, and a bibliography is not translated.
"""

from __future__ import annotations

import json

import pytest

from app.bilingual.cache import (
    cache_is_compatible,
    delete_bilingual,
    read_bilingual,
    write_bilingual,
)
from app.bilingual.models import (
    BILINGUAL_SCHEMA_VERSION,
    BilingualArtifact,
    BilingualParagraph,
    BilingualSection,
)
from app.bilingual.pipeline import generate_bilingual, non_prose_blocks, plan
from app.bilingual.prompt import MAX_BATCH_CHARS, MAX_PARAGRAPHS_PER_BATCH
from app.document.models import (
    DocumentIR,
    DocumentMetadata,
    PageIR,
    ParagraphIR,
    SectionIR,
    TextBlockIR,
)
from app.llm.base import LLMProvider
from app.llm.models import LLMRequest, LLMResult, LLMUsage


def block(identifier: str, page: int, text: str, layout_class: str = "plain text") -> TextBlockIR:
    return TextBlockIR(
        id=identifier, page_index=page - 1, page_number=page,
        layout_class=layout_class, bbox=(0.0, 0.0, 100.0, 20.0), text=text,
    )


def paragraph(
    identifier: str, text: str, *, page: int = 1, section: str | None = None,
    is_abstract: bool = False, block_id: str | None = None,
) -> ParagraphIR:
    return ParagraphIR(
        id=identifier, section_id=section, text=text, page_number=page,
        page_range=(page, page), block_ids=[block_id] if block_id else [],
        bboxes=[(0.0, 0.0, 100.0, 20.0)], is_abstract=is_abstract,
    )


def section(identifier: str, title: str, page: int = 1, *, references: bool = False) -> SectionIR:
    return SectionIR(
        id=identifier, title=title, level=1, page_range=(page, page),
        is_references=references,
    )


def an_ir(paragraphs, sections, *, blocks=None, pages=1) -> DocumentIR:
    return DocumentIR(
        document_id="doc_1", content_hash="hash_" + "b" * 60, pipeline_version="5",
        source_filename="paper.pdf", page_count=pages,
        metadata=DocumentMetadata(title="A Paper"), sections=sections,
        pages=[
            PageIR(
                page_index=page - 1, page_number=page, width_pt=612, height_pt=792,
                rotation=0, has_text=True,
                blocks=[item for item in (blocks or []) if item.page_number == page],
            )
            for page in range(1, pages + 1)
        ],
        paragraphs=list(paragraphs), page_mapping={},
        has_text_layer=True, ocr_required=False,
    )


class ScriptedProvider(LLMProvider):
    """A model that does its job: every id it is given, translated."""

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
        """Translate whatever ids the request carries — the shape a real model
        is asked for, so a batch's ids come back exactly once."""
        import re

        # The *first* message carrying the paragraphs, not the last: a repair
        # request appends to the conversation, and the paragraphs are still in the
        # original turn — which is exactly what the repair relies on.
        content = next(
            (message.content for message in request.messages if "Paragraphs:" in message.content),
            "",
        )
        # The two lists are separate blocks in the request, so the stub can tell a
        # heading from a paragraph without knowing the id convention.
        heading_part, _, paragraph_part = content.partition("Paragraphs:")
        heading_ids = re.findall(r"^\[([^\]]+)\]", heading_part, re.MULTILINE)
        paragraph_ids = re.findall(r"^\[([^\]]+)\]", paragraph_part, re.MULTILINE)
        return json.dumps({
            "headings": [{"id": key, "text": f"{key} 的标题"} for key in heading_ids],
            "paragraphs": [{"id": key, "text": f"{key} 的译文"} for key in paragraph_ids],
        })

    async def test_connection(self):  # pragma: no cover - not exercised
        raise NotImplementedError


class TestThePlan:
    def test_it_batches_inside_the_bounds(self) -> None:
        ir = an_ir(
            [paragraph(f"p{i}", "word " * 200, section="s1") for i in range(1, 40)],
            [section("s1", "1. Introduction")],
        )
        work = plan(ir)
        for batch in work.batches:
            assert len(batch.paragraphs) <= MAX_PARAGRAPHS_PER_BATCH
            assert batch.characters() <= MAX_BATCH_CHARS

    def test_it_is_deterministic(self) -> None:
        """The pre-generation disclosure is a fact only if the plan is stable."""
        ir = an_ir(
            [paragraph(f"p{i}", "text " * 50, section="s1") for i in range(1, 12)],
            [section("s1", "1. Introduction")],
        )
        first, second = plan(ir), plan(ir)
        assert [b.characters() for b in first.batches] == [b.characters() for b in second.batches]
        assert first.batch_count == second.batch_count

    def test_the_bibliography_is_never_sent(self) -> None:
        ir = an_ir(
            [paragraph("p1", "Body text " * 20, section="s1"),
             paragraph("p2", "Vaswani et al. 2017. " * 20, page=2, section="s2")],
            [section("s1", "1. Introduction"), section("s2", "References", 2, references=True)],
        )
        work = plan(ir)
        assert "p2" in work.skipped
        sent = "\n".join(
            item.text for batch in work.batches for item in batch.paragraphs
        )
        assert "Vaswani" not in sent
        assert all(entry.title != "References" for entry in work.headings)

    def test_the_title_block_is_not_translated(self) -> None:
        """Measured: page one carries the authors and the arXiv stamp before the
        abstract. Translating an author list is not a service."""
        ir = an_ir(
            [paragraph("p0", "Kaiming He, Microsoft Research", page=1),
             paragraph("p1", "Abstract text " * 20, page=1, is_abstract=True, section="s1")],
            [section("s1", "Abstract")],
        )
        work = plan(ir)
        assert work.skipped["p0"] == "文档题头信息"
        assert work.paragraph_count == 1

    def test_a_paper_with_no_sections_still_plans(self) -> None:
        ir = an_ir([paragraph("p1", "Substance with no heading. " * 10)], [])
        work = plan(ir)
        assert work.batch_count == 1
        assert work.paragraph_count == 1
        assert work.headings == []

    def test_one_paragraph_is_one_batch(self) -> None:
        ir = an_ir([paragraph("p1", "Only one paragraph.", section="s1")], [section("s1", "1. Intro")])
        work = plan(ir)
        assert work.batch_count == 1
        assert work.character_count == len("Only one paragraph.")


class TestWhatTheColumnCarries:
    def test_formulas_and_captions_travel_as_blocks(self) -> None:
        ir = an_ir(
            [paragraph("p1", "Body text " * 10, section="s1", block_id="b1")],
            [section("s1", "1. Introduction")],
            blocks=[
                block("b1", 1, "Body text " * 10),
                block("b2", 1, "y = F(x, {Wi}) + x", layout_class="isolate_formula"),
                block("b3", 1, "Figure 1. Training error.", layout_class="figure_caption"),
            ],
        )
        carried = non_prose_blocks(ir)
        assert [item.layout_class for item in carried] == ["isolate_formula", "figure_caption"]
        assert "F(x" in carried[0].text

    @pytest.mark.asyncio
    async def test_a_formula_is_never_in_a_prompt(self) -> None:
        ir = an_ir(
            [paragraph("p1", "Body text " * 10, section="s1")],
            [section("s1", "1. Introduction")],
            blocks=[block("b2", 1, "FORMULA_MARKER", layout_class="isolate_formula")],
        )
        provider = ScriptedProvider()
        await generate_bilingual(ir, provider, target_language="zh-CN")
        sent = "\n".join(
            message.content for request in provider.requests for message in request.messages
        )
        assert "FORMULA_MARKER" not in sent


class TestGeneration:
    def _ir(self):
        return an_ir(
            [paragraph("p1", "The paper introduces a residual framework. " * 3,
                       is_abstract=True, section="s1"),
             paragraph("p2", "It is evaluated on CIFAR-10. " * 3, page=2, section="s2")],
            [section("s1", "Abstract"), section("s2", "2. Method", 2)],
        )

    @pytest.mark.asyncio
    async def test_every_paragraph_comes_back_translated(self) -> None:
        provider = ScriptedProvider()
        outcome = await generate_bilingual(self._ir(), provider, target_language="zh-CN")
        assert outcome.artifact.status == "READY"
        assert outcome.artifact.translated_count() == 2
        assert outcome.provider_calls == len(plan(self._ir()).batches)

    @pytest.mark.asyncio
    async def test_the_equality_the_criterion_freezes(self) -> None:
        """AC-P0-06: exactly the IR's non-empty paragraphs, in order."""
        ir = self._ir()
        outcome = await generate_bilingual(ir, ScriptedProvider(), target_language="zh-CN")
        assert [item.paragraph_id for item in outcome.artifact.paragraphs] == [
            item.id for item in ir.paragraphs if item.text.strip()
        ]
        assert all(item.source_text for item in outcome.artifact.paragraphs)

    @pytest.mark.asyncio
    async def test_headings_are_translated_and_ordered(self) -> None:
        outcome = await generate_bilingual(self._ir(), ScriptedProvider(), target_language="zh-CN")
        titles = [section.title for section in outcome.artifact.sections]
        assert titles == ["Abstract", "2. Method"]
        assert all(section.title_translated for section in outcome.artifact.sections)

    @pytest.mark.asyncio
    async def test_a_failed_batch_leaves_honest_gaps(self) -> None:
        """Two unusable answers: one repair, then the batch is reported missing
        rather than filled in."""
        provider = ScriptedProvider("not json", "still not json")
        outcome = await generate_bilingual(self._ir(), provider, target_language="zh-CN")

        assert outcome.artifact.status == "PARTIAL"
        assert outcome.failed_batches == 1
        assert all(not item.is_readable() for item in outcome.artifact.paragraphs)
        assert all(item.status == "untranslated" for item in outcome.artifact.paragraphs)
        assert outcome.provider_calls == 2, "one call and one repair, not a loop"

    @pytest.mark.asyncio
    async def test_a_repair_rescues_the_batch(self) -> None:
        provider = ScriptedProvider("not json")  # then the scripted answer
        outcome = await generate_bilingual(self._ir(), provider, target_language="zh-CN")
        assert outcome.artifact.status == "READY"
        assert outcome.repaired == 1
        assert outcome.provider_calls == len(plan(self._ir()).batches) + 1

    @pytest.mark.asyncio
    async def test_a_translator_directed_paragraph_is_refused(self) -> None:
        answer = json.dumps({
            "headings": [],
            "paragraphs": [
                {"id": "p1", "text": "It is useful for preserving author spelling during translation."},
                {"id": "p2", "text": "这是一个正常的译文。"},
            ],
        })
        outcome = await generate_bilingual(self._ir(), ScriptedProvider(answer), target_language="zh-CN")
        first = outcome.artifact.paragraphs[0]
        assert not first.is_readable()
        assert first.status == "untranslated"

    @pytest.mark.asyncio
    async def test_an_invented_id_is_not_a_translation(self) -> None:
        answer = json.dumps({"headings": [], "paragraphs": [{"id": "p_9999", "text": "x"}]})
        outcome = await generate_bilingual(self._ir(), ScriptedProvider(answer), target_language="zh-CN")
        assert outcome.artifact.translated_count() == 0

    @pytest.mark.asyncio
    async def test_reported_usage_is_recorded_and_unreported_is_not(self) -> None:
        usage = LLMUsage(prompt_tokens=1200, completion_tokens=340, total_tokens=1540)
        reported = await generate_bilingual(
            self._ir(), ScriptedProvider(usage=usage), target_language="zh-CN"
        )
        assert reported.artifact.input_tokens == 1200 * reported.provider_calls
        assert reported.artifact.output_tokens == 340 * reported.provider_calls

        silent = await generate_bilingual(self._ir(), ScriptedProvider(), target_language="zh-CN")
        assert silent.artifact.input_tokens is None
        assert silent.artifact.output_tokens is None


class TestEdgePapers:
    @pytest.mark.asyncio
    async def test_one_paragraph_is_a_reading(self) -> None:
        """One paragraph, one batch, no divide-by-zero and no slicing defect."""
        ir = an_ir(
            [paragraph("p1", "Only one paragraph.", section="s1")],
            [section("s1", "1. Introduction")],
        )
        outcome = await generate_bilingual(ir, ScriptedProvider(), target_language="zh-CN")
        assert outcome.artifact.status == "READY"
        assert outcome.provider_calls == 1
        assert outcome.artifact.paragraphs[0].is_readable()

    @pytest.mark.asyncio
    async def test_a_paper_with_no_sections_still_reads(self) -> None:
        """Every paragraph unsectioned: the extraction found no headings, and the
        column still has to be a reading of the paper."""
        ir = an_ir(
            [paragraph("p1", "Substance with no heading. " * 5, is_abstract=True),
             paragraph("p2", "More substance, still unheaded. " * 5, page=2)],
            [],
        )
        outcome = await generate_bilingual(ir, ScriptedProvider(), target_language="zh-CN")
        assert outcome.artifact.status == "READY"
        assert outcome.artifact.sections == []
        assert outcome.artifact.translated_count() == 2


class TestTheCache:
    def an_artifact(self, **over) -> BilingualArtifact:
        base = dict(
            content_hash="a" * 64, target_language="zh-CN", status="READY",
            ir_pipeline_version="5", provider_model="some-model",
            created_at="2026-09-23T00:00:00+00:00",
            paragraphs=[BilingualParagraph(
                paragraph_id="p_1", page_number=1, source_text="Text.",
                translated_text="译文。",
            )],
            sections=[BilingualSection(section_id="s_1", title="Intro", title_translated="引言")],
        )
        base.update(over)
        return BilingualArtifact(**base)

    def test_it_lives_beside_the_document_directories(self, tmp_path) -> None:
        from app.bilingual.cache import bilingual_dir, bilingual_path

        path = bilingual_path(tmp_path, "a" * 64, "zh-CN")
        assert path.parent == bilingual_dir(tmp_path)
        assert path.name == f"{'a' * 64}_zh-CN.json"

    def test_every_invalidation_dimension_is_checked(self, tmp_path) -> None:
        store = {"content_hash": "a" * 64, "ir_pipeline_version": "5", "target_language": "zh-CN"}
        good = self.an_artifact()
        assert cache_is_compatible(good, **store) is True

        for changed in (
            {"content_hash": "b" * 64},
            {"ir_pipeline_version": "4"},
            {"target_language": "en"},
        ):
            assert cache_is_compatible(good, **{**store, **changed}) is False, changed
        for changed in (
            {"prompt_version": "0.9.0"},
            {"pipeline_version": "0.9.0"},
            {"schema_version": "0"},
        ):
            assert cache_is_compatible(self.an_artifact(**changed), **store) is False, changed

    def test_another_model_does_not_invalidate(self, tmp_path) -> None:
        store = {"content_hash": "a" * 64, "ir_pipeline_version": "5", "target_language": "zh-CN"}
        write_bilingual(tmp_path, self.an_artifact(provider_model="some-old-model"))
        found = read_bilingual(tmp_path, **store)
        assert found is not None and found.provider_model == "some-old-model"
        assert found.schema_version == BILINGUAL_SCHEMA_VERSION

    def test_a_corrupt_cache_reads_as_absent(self, tmp_path) -> None:
        from app.bilingual.cache import bilingual_path

        path = bilingual_path(tmp_path, "a" * 64, "zh-CN")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{not json", encoding="utf-8")
        assert read_bilingual(
            tmp_path, content_hash="a" * 64, ir_pipeline_version="5", target_language="zh-CN"
        ) is None

    def test_usage_and_blocks_survive_a_round_trip(self, tmp_path) -> None:
        from app.bilingual.models import BilingualBlock

        write_bilingual(tmp_path, self.an_artifact(
            input_tokens=1200, output_tokens=340,
            blocks=[BilingualBlock(
                block_id="b1", page_number=2, layout_class="isolate_formula",
                text="y = F(x) + x", bbox=(1.0, 2.0, 3.0, 4.0),
            )],
        ))
        found = read_bilingual(
            tmp_path, content_hash="a" * 64, ir_pipeline_version="5", target_language="zh-CN"
        )
        assert found is not None
        assert (found.input_tokens, found.output_tokens) == (1200, 340)
        assert found.blocks[0].layout_class == "isolate_formula"
        assert found.blocks[0].bbox == (1.0, 2.0, 3.0, 4.0)

    def test_deleting_removes_only_that_language(self, tmp_path) -> None:
        write_bilingual(tmp_path, self.an_artifact(target_language="zh-CN"))
        write_bilingual(tmp_path, self.an_artifact(target_language="en"))
        delete_bilingual(tmp_path, "a" * 64, "zh-CN")
        assert read_bilingual(
            tmp_path, content_hash="a" * 64, ir_pipeline_version="5", target_language="zh-CN"
        ) is None
        assert read_bilingual(
            tmp_path, content_hash="a" * 64, ir_pipeline_version="5", target_language="en"
        ) is not None

    def test_a_failure_is_not_a_reading(self, tmp_path) -> None:
        store = {"content_hash": "a" * 64, "ir_pipeline_version": "5", "target_language": "zh-CN"}
        write_bilingual(tmp_path, self.an_artifact(status="FAILED"))
        assert read_bilingual(tmp_path, **store) is None
