"""DS-QA-015 — the reader-facing half: what may be asked, and what may be kept.

The provider is not involved here. Everything in this file is deterministic, and
that is deliberate: the interesting rules are about *what the model is allowed to
contribute*, and a test that needs a model to prove a rule is a test that fails
for the wrong reason.

Measured against the alternatives, for context — the previous pipeline issued
**11 serial calls and took 1565.8 seconds** for ResNet, and produced a summary of
the bibliography, a card for "Unsectioned Content (Pages 1-1)", and sentences
addressed to a translation system. Each test below pins one of those.
"""

from __future__ import annotations

import pytest

from app.document.models import (
    DocumentIR,
    DocumentMetadata,
    PageIR,
    ParagraphIR,
    SectionIR,
)
from app.llm.base import LLMProvider
from app.llm.models import LLMRequest, LLMResult
from app.overview.evidence import build_evidence_packet, classify_section
from app.overview.pipeline import build_overview, generate_overview
from app.overview.prompt import MAX_ITEMS, MAX_KEY_TERMS, build_messages


def paragraph(
    pid: str, text: str, *, page: int = 1, section: str | None = None,
    is_abstract: bool = False,
) -> ParagraphIR:
    return ParagraphIR(
        id=pid, section_id=section, text=text, page_number=page,
        page_range=(page, page), block_ids=[], bboxes=[], is_abstract=is_abstract,
    )


def section(sid: str, title: str, page: int = 1, *, references: bool = False) -> SectionIR:
    return SectionIR(
        id=sid, title=title, level=1, page_range=(page, page), is_references=references,
    )


def an_ir(paragraphs, sections) -> DocumentIR:
    return DocumentIR(
        document_id="doc_1", content_hash="hash_" + "a" * 60,
        pipeline_version="5", source_filename="paper.pdf",
        page_count=max((p.page_number for p in paragraphs), default=1),
        metadata=DocumentMetadata(title="A Paper"), sections=sections,
        pages=[PageIR(page_index=0, page_number=1, width_pt=612, height_pt=792,
                      rotation=0, has_text=True, blocks=[])],
        paragraphs=list(paragraphs), page_mapping={},
        has_text_layer=True, ocr_required=False,
    )


class TestThePacketIsBoundedAndClassified:
    def test_the_bibliography_is_excluded(self) -> None:
        """`is_references` is a fact the extraction establishes, not a word this
        code matches. The measured baseline summarised References because a
        bibliography is a section with paragraphs."""
        ir = an_ir(
            [paragraph("p1", "Body text " * 20, section="s1"),
             paragraph("p2", "Vaswani et al. 2017. " * 20, page=2, section="s2")],
            [section("s1", "1. Introduction"), section("s2", "References", 2, references=True)],
        )
        packet = build_evidence_packet(ir)
        assert "References" in packet.excluded
        assert all("Vaswani" not in unit.text for unit in packet.units)

    def test_the_abstract_is_kept_and_labeled(self) -> None:
        ir = an_ir(
            [paragraph("p1", "We solve everything. " * 10, is_abstract=True, section="s1")],
            [section("s1", "Abstract")],
        )
        packet = build_evidence_packet(ir)
        assert [unit.id for unit in packet.units] == ["E1"]

    def test_page_one_stationery_does_not_become_a_section(self) -> None:
        """The measured baseline produced a card called *Unsectioned Content
        (Pages 1-1)* from an arXiv stamp and an author list."""
        ir = an_ir(
            [paragraph("p0", "arXiv:1512.03385v1  [cs.CV]  10 Dec 2015", page=1),
             paragraph("p1", "Abstract text we wrote.", page=1,
                       is_abstract=True, section="s1"),
             paragraph("p2", "Legitimate body with no heading at all, several words long.",
                       page=1)],
            [section("s1", "Abstract")],
        )
        packet = build_evidence_packet(ir)
        texts = [unit.text for unit in packet.units]
        assert not any("arXiv:1512" in text for text in texts)
        # ...and the body paragraph that merely lacks a heading is kept.
        assert any("Legitimate body" in text for text in texts)

    def test_a_paper_with_no_sections_still_yields_a_packet(self) -> None:
        """The rule that could have emptied the Overview.

        A paper whose headings the extractor missed has *every* paragraph
        unsectioned. Excluding the unsectioned ones would then produce nothing,
        which passes a one-sided check and shows the reader an empty panel.
        """
        ir = an_ir(
            [paragraph("p1", "The paper's substance, with no heading over it. " * 5,
                       is_abstract=True),
             paragraph("p2", "More substance, still unheaded but clearly body. " * 5,
                       page=2)],
            [],
        )
        packet = build_evidence_packet(ir)
        assert len(packet.units) >= 1
        assert any("More substance" in unit.text for unit in packet.units)

    def test_the_packet_stays_inside_its_budget(self) -> None:
        ir = an_ir(
            [paragraph(f"p{i}", "word " * 400, section="s1") for i in range(1, 40)],
            [section("s1", "1. Introduction")],
        )
        packet = build_evidence_packet(ir, char_budget=5_000)
        assert packet.char_count() <= 5_000

    def test_no_single_section_crowds_out_the_rest(self) -> None:
        """Without a per-section share, a method running to thirty pages eats the
        abstract, which is the best evidence the overview has."""
        ir = an_ir(
            [paragraph("a", "abstract words " * 30, is_abstract=True, section="s1")] +
            [paragraph(f"m{i}", "method words " * 300, section="s2") for i in range(30)],
            [section("s1", "Abstract"), section("s2", "2. Method")],
        )
        packet = build_evidence_packet(ir, char_budget=20_000)
        from_abstract = sum(1 for u in packet.units if u.section_title == "Abstract")
        assert from_abstract >= 1

    def test_evidence_ids_ascend_with_the_paper(self) -> None:
        ir = an_ir(
            [paragraph("p1", "One. " * 10, section="s1"),
             paragraph("p2", "Two. " * 10, page=2, section="s2")],
            [section("s1", "1. Introduction"), section("s2", "2. Method", 2)],
        )
        packet = build_evidence_packet(ir)
        assert [unit.id for unit in packet.units] == ["E1", "E2"]
        assert [unit.page_number for unit in packet.units] == [1, 2]


class TestSectionRoles:
    @pytest.mark.parametrize("title", [
        "References", "Bibliography", "Acknowledgements", "Acknowledgments",
        "Appendix A: Proofs", "Supplementary Material", "Table of Contents",
    ])
    def test_non_substance_headings_are_excluded(self, title: str) -> None:
        assert classify_section(section("s", title, references=title == "References")) == "excluded"

    @pytest.mark.parametrize("title", [
        "1. Introduction", "I. INTRODUCTION", "2. Method", "3. Experiments",
        "4. Results", "5. Conclusion", "Deep Residual Learning",
    ])
    def test_substance_headings_are_kept(self, title: str) -> None:
        assert classify_section(section("s", title)) == "substantive"

    def test_an_unfamiliar_heading_is_kept_rather_than_dropped(self) -> None:
        """Including a section the reader did not need costs a paragraph of
        budget. Dropping one hides the paper's method."""
        assert classify_section(section("s", "Something Nobody Predicted")) == "substantive"


class TestThePromptSpeaksToAReader:
    def _system(self, language: str = "zh-CN") -> str:
        ir = an_ir([paragraph("p1", "text", is_abstract=True, section="s1")],
                   [section("s1", "Abstract")])
        return build_messages(ir, "E1 text", target_language=language)[0]["content"]

    def test_the_language_is_an_instruction(self) -> None:
        """The DS-QA-014 defect: `target_language` was passed as context and the
        model answered in English."""
        system = self._system("zh-CN")
        assert "Simplified Chinese" in system
        assert "required" in system.lower()

    def test_it_never_addresses_a_translator(self) -> None:
        """The prohibition, not the absence of the words.

        A prompt that forbids translation *has* to name it — asserting the words
        do not appear would forbid writing the rule. What is checked is that the
        instruction is the negative one, and the enforcement is the `meta_claims`
        filter, which counts what actually comes back.
        """
        system = self._system().lower()
        assert "do not mention translation" in system
        assert "the reader is not translating" in system
        assert "translation system" not in system

    def test_it_forbids_inventing_provenance(self) -> None:
        system = self._system().lower()
        assert "never write a page number" in system

    def test_it_bounds_the_items(self) -> None:
        assert MAX_ITEMS["contributions"] <= 5
        assert MAX_KEY_TERMS <= 15


class TestValidation:
    def _packet(self):
        ir = an_ir(
            [paragraph("p1", "The paper introduces a residual framework. " * 3,
                       is_abstract=True, section="s1"),
             paragraph("p2", "It is evaluated on CIFAR-10. " * 3, page=2, section="s2")],
            [section("s1", "Abstract"), section("s2", "2. Method", 2)],
        )
        return build_evidence_packet(ir)

    def _build(self, payload: dict):
        return build_overview(
            payload, self._packet(),
            content_hash="h", ir_pipeline_version="5", target_language="zh-CN",
            provider_model="m", provider_base_url="u", created_at="t",
        )

    def _full_payload(self, **over) -> dict:
        items = [
            {"category": name, "text": f"{name} 的中文说明。", "evidence": ["E1"]}
            for name in MAX_ITEMS
        ]
        return {"items": items, "key_terms": [
            {"term": "ResNet", "definition": "残差网络。", "evidence": ["E1"]},
        ], **over}

    def test_a_complete_answer_is_ready(self) -> None:
        overview, dropped = self._build(self._full_payload())
        assert overview.status == "READY"
        assert dropped == []

    def test_an_unknown_evidence_id_is_dropped_not_trusted(self) -> None:
        payload = self._full_payload()
        payload["items"][0]["evidence"] = ["E99"]
        overview, dropped = self._build(payload)
        assert any("ungrounded" in reason for reason in dropped)
        assert overview.items_in("research_question") == []

    def test_a_partially_invented_citation_keeps_the_real_half(self) -> None:
        """An item resting on two good excerpts and one invented id is still
        supported by the two; discarding it would lose a true claim."""
        payload = self._full_payload()
        payload["items"][0]["evidence"] = ["E1", "E99"]
        overview, _ = self._build(payload)
        assert len(overview.items_in("research_question")[0].evidence) == 1

    def test_a_translator_directed_item_is_dropped(self) -> None:
        """Not softened and not repaired. This is the measured defect."""
        payload = self._full_payload()
        payload["items"][0]["text"] = "It is useful for preserving author spelling during translation."
        overview, dropped = self._build(payload)
        assert any("translator" in reason for reason in dropped)
        assert overview.items_in("research_question") == []

    def test_an_ungrounded_item_is_dropped(self) -> None:
        payload = self._full_payload()
        payload["items"][0]["evidence"] = []
        _, dropped = self._build(payload)
        assert any("ungrounded" in reason for reason in dropped)

    def test_an_unknown_category_is_dropped(self) -> None:
        payload = self._full_payload()
        payload["items"].append({"category": "vibes", "text": "x", "evidence": ["E1"]})
        _, dropped = self._build(payload)
        assert any("unknown category" in reason for reason in dropped)

    def test_the_category_bounds_are_enforced(self) -> None:
        payload = self._full_payload()
        for index in range(10):
            payload["items"].append(
                {"category": "contributions", "text": f"extra {index}", "evidence": ["E1"]}
            )
        overview, dropped = self._build(payload)
        assert len(overview.items_in("contributions")) == MAX_ITEMS["contributions"]
        assert any("beyond the" in reason for reason in dropped)

    def test_key_terms_are_bounded(self) -> None:
        payload = self._full_payload()
        payload["key_terms"] = [
            {"term": f"T{i}", "definition": "定义。", "evidence": ["E1"]}
            for i in range(50)
        ]
        overview, _ = self._build(payload)
        assert len(overview.key_terms) == MAX_KEY_TERMS

    def test_a_missing_category_makes_it_partial_rather_than_ready(self) -> None:
        payload = self._full_payload()
        payload["items"] = [i for i in payload["items"] if i["category"] != "findings"]
        overview, _ = self._build(payload)
        assert overview.status == "PARTIAL"
        assert any("findings" in note for note in overview.notes)

    def test_a_paper_with_no_limitations_is_still_ready(self) -> None:
        """A paper that states no limitations is a paper with none to report.
        Calling that incomplete would be a lie about the paper."""
        payload = self._full_payload()
        payload["items"] = [i for i in payload["items"] if i["category"] != "limitations"]
        overview, _ = self._build(payload)
        assert overview.status == "READY"


class ScriptedProvider(LLMProvider):
    protocol = "scripted"

    def __init__(self, *answers: str) -> None:
        self._answers = list(answers)
        self.requests: list[LLMRequest] = []

    async def generate(self, request: LLMRequest) -> LLMResult:
        self.requests.append(request)
        text = self._answers.pop(0) if self._answers else ""
        return LLMResult(text=text, model="scripted", protocol=self.protocol)

    async def test_connection(self):
        raise NotImplementedError


class TestGeneration:
    def _ir(self) -> DocumentIR:
        return an_ir(
            [paragraph("p1", "The paper introduces a residual framework. " * 3,
                       is_abstract=True, section="s1")],
            [section("s1", "Abstract")],
        )

    def _answer(self) -> str:
        import json

        return json.dumps({
            "items": [
                {"category": name, "text": f"{name} 说明。", "evidence": ["E1"]}
                for name in MAX_ITEMS
            ],
            "key_terms": [],
        })

    @pytest.mark.asyncio
    async def test_one_call_when_the_first_answer_is_usable(self) -> None:
        provider = ScriptedProvider(self._answer())
        outcome = await generate_overview(self._ir(), provider, target_language="zh-CN")
        assert outcome.provider_calls == 1
        assert outcome.repaired is False
        assert outcome.overview.status == "READY"

    @pytest.mark.asyncio
    async def test_json_wrapped_in_prose_is_still_usable(self) -> None:
        """Models fence their JSON often enough that refusing anything but a bare
        object would throw away good answers."""
        provider = ScriptedProvider("Here you go:\n```json\n" + self._answer() + "\n```\nEnjoy!")
        outcome = await generate_overview(self._ir(), provider, target_language="zh-CN")
        assert outcome.provider_calls == 1
        assert outcome.overview.status == "READY"

    @pytest.mark.asyncio
    async def test_one_bounded_repair_when_the_answer_is_unusable(self) -> None:
        provider = ScriptedProvider("not json at all", self._answer())
        outcome = await generate_overview(self._ir(), provider, target_language="zh-CN")
        assert outcome.provider_calls == 2
        assert outcome.repaired is True
        assert outcome.overview.status == "READY"

    @pytest.mark.asyncio
    async def test_a_second_failure_is_not_retried_a_third_time(self) -> None:
        """A model that has produced unusable output twice will produce it a
        third time, and each attempt is the reader's money."""
        provider = ScriptedProvider("nope", "still nope", self._answer())
        outcome = await generate_overview(self._ir(), provider, target_language="zh-CN")
        assert outcome.provider_calls == 2
        assert outcome.overview.status == "FAILED"
        assert len(provider.requests) == 2, "the third answer was never asked for"
