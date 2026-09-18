"""DS-QA-008 — the outline: hierarchy, heading geometry, and cache invalidation.

Runs offline on a hand-built `DocumentIR`, like `test_qa_retrieval.py`. The
unit under test is not "does the tree render" — that is the browser run's job —
but whether the structure the frontend receives is *canonical*: derived from the
paper's own numbering and reading order, carrying the id the rest of the system
already uses, and never inventing a location it cannot support.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.document.extract import (
    IR_PIPELINE_VERSION,
    _build_hierarchy,
    _detect_sections,
    _HEADING_NUMBER,
)
from app.document.models import (
    DocumentIR,
    DocumentMetadata,
    PageIR,
    ParagraphIR,
    SectionIR,
    TextBlockIR,
)
from app.document.outline import ANCHOR_HEADING, ANCHOR_PAGE, ANCHOR_PARAGRAPH, build_outline
from app.document.service import is_reusable

# --- the numbering rule -------------------------------------------------------


class TestHeadingNumbering:
    @pytest.mark.parametrize(
        "title,expected_level",
        [
            ("1 Introduction", 1),
            ("3.1 Motivation", 2),
            ("4.2.1 Details", 3),
            ("A.1 Normalization", 2),
            ("B.1 S4 Variants", 2),
            ("E.2 Language Modeling", 2),
            ("C.1.2 Evaluation", 3),
            ("Appendix A Details", 1),
            ("B Performance on More Atari Games", 1),
            ("Abstract", 1),
            ("References", 1),
            ("Mechanics of Selective SSMs", 1),
            ("the degradation problem", 1),
        ],
    )
    def test_levels(self, title: str, expected_level: int) -> None:
        """Letter-prefixed numbering is numbering.

        Omitting it flattened every appendix subsection to level 1, so `A.1`
        became a sibling of `A` instead of its child. Measured on Diffusion
        Policy and Mamba, and corroborated by those papers' own PDF bookmark
        trees, which place `A.1` and `B.1` at level 2.
        """
        match = _HEADING_NUMBER.match(title)
        level = len(match.group(1).split(".")) if match else 1
        assert level == expected_level


# --- hierarchy ----------------------------------------------------------------


def section(section_id: str, title: str, level: int) -> SectionIR:
    return SectionIR(id=section_id, title=title, level=level, page_range=(1, 1))


class TestHierarchy:
    def test_a_numbered_child_nests_under_its_number(self) -> None:
        sections = [
            section("s1", "3 Key Design Decisions", 1),
            section("s2", "3.1 Network Architecture", 2),
            section("s3", "3.2 Visual Encoder", 2),
        ]
        _build_hierarchy(sections)
        assert [s.parent_id for s in sections] == [None, "s1", "s1"]

    def test_the_number_beats_reading_order_when_they_disagree(self) -> None:
        """The measured Diffusion Policy case.

        `3.2. Visual Encoder` is printed *after* `4.1`, so a pure level stack
        makes it a child of section 4. The paper's own numbering says otherwise,
        and the numbering is the paper stating its own structure.
        """
        sections = [
            section("s3", "3 Key Design Decisions", 1),
            section("s4", "4 Intriguing Properties", 1),
            section("s41", "4.1 Model Multi-Modal Action Distributions", 2),
            section("s32", "3.2 Visual Encoder", 2),
        ]
        _build_hierarchy(sections)
        assert sections[3].parent_id == "s3"

    def test_an_unnumbered_heading_falls_back_to_the_stack(self) -> None:
        sections = [
            section("s1", "1 Introduction", 1),
            section("s2", "Related Work", 2),
        ]
        _build_hierarchy(sections)
        assert sections[1].parent_id == "s1"

    def test_a_child_whose_parent_is_absent_stays_a_root(self) -> None:
        """An appendix `C.1` with no `C` heading is not attached to a guess."""
        sections = [section("s1", "C.1 Details", 2)]
        _build_hierarchy(sections)
        assert sections[0].parent_id is None

    def test_deeper_levels_nest_correctly(self) -> None:
        sections = [
            section("a", "1 Method", 1),
            section("b", "1.1 Encoder", 2),
            section("c", "1.1.1 Blocks", 3),
            section("d", "1.2 Decoder", 2),
        ]
        _build_hierarchy(sections)
        assert [s.parent_id for s in sections] == [None, "a", "b", "a"]


# --- heading geometry and the navigation ladder -------------------------------


def blocks() -> list[TextBlockIR]:
    return [
        TextBlockIR(id="b_abs", page_index=0, page_number=1, layout_class="title",
                    bbox=(50, 60, 200, 74), text="Abstract"),
        TextBlockIR(id="b_intro", page_index=0, page_number=1, layout_class="title",
                    bbox=(50, 300, 200, 314), text="1 Introduction"),
        TextBlockIR(id="b_p1", page_index=0, page_number=1, layout_class="plain text",
                    bbox=(50, 320, 545, 400), text="Body text of the introduction."),
    ]


def make_ir(*, heading_block_id: str | None, paragraphs: list[ParagraphIR]) -> DocumentIR:
    page = PageIR(page_index=0, page_number=1, width_pt=595, height_pt=842,
                  has_text=True, blocks=blocks())
    return DocumentIR(
        document_id="doc_outline", content_hash="hash", pipeline_version=IR_PIPELINE_VERSION,
        source_filename="p.pdf", page_count=1, metadata=DocumentMetadata(),
        sections=[
            SectionIR(id="sec_1", title="1 Introduction", level=1, page_range=(1, 1),
                      heading_block_id=heading_block_id),
        ],
        pages=[page], paragraphs=paragraphs,
        page_mapping={p.id: p.page_number for p in paragraphs},
        has_text_layer=True, ocr_required=False,
    )


class TestNavigationLadder:
    def test_the_heading_block_wins_when_it_resolves(self) -> None:
        ir = make_ir(heading_block_id="b_intro", paragraphs=[])
        row = build_outline(ir)[0]
        assert row["anchor"] == ANCHOR_HEADING
        assert row["page_number"] == 1
        assert row["bbox"] == [50.0, 300.0, 200.0, 314.0]

    def test_it_falls_back_to_the_first_paragraph(self) -> None:
        """No heading block, so the first paragraph in reading order is used."""
        paragraph = ParagraphIR(
            id="p1", section_id="sec_1", text="Body text.", page_number=1,
            page_range=(1, 1), block_ids=["b_p1"], bboxes=[(50, 320, 545, 400)],
        )
        row = build_outline(make_ir(heading_block_id=None, paragraphs=[paragraph]))[0]
        assert row["anchor"] == ANCHOR_PARAGRAPH
        assert row["bbox"] == [50.0, 320.0, 545.0, 400.0]

    def test_it_falls_back_to_the_page_and_draws_no_box(self) -> None:
        """The end of the ladder: a real destination, and no invented geometry."""
        row = build_outline(make_ir(heading_block_id=None, paragraphs=[]))[0]
        assert row["anchor"] == ANCHOR_PAGE
        assert row["page_number"] == 1
        assert row["bbox"] is None

    def test_every_row_carries_the_canonical_id(self) -> None:
        row = build_outline(make_ir(heading_block_id="b_intro", paragraphs=[]))[0]
        assert row["id"] == "sec_1"
        # No paragraph text: the outline describes the document, it does not
        # carry it (brief Phase 52).
        assert "text" not in row


# --- the cache guard ----------------------------------------------------------


class TestPipelineVersion:
    def test_a_current_ir_is_reusable(self) -> None:
        ir = make_ir(heading_block_id="b_intro", paragraphs=[])
        assert is_reusable(ir, "doc_outline") is True

    def test_a_stale_pipeline_is_not_reusable(self) -> None:
        """The defect this guard exists for.

        The reading-order section fix reached every new extraction and no cached
        one: a stored IR could describe a document with eight sections owning
        nothing while the code that produced it had already been corrected.
        Nothing could tell, because the only question asked was "is this the
        right document".
        """
        ir = make_ir(heading_block_id="b_intro", paragraphs=[]).model_copy(
            update={"pipeline_version": "1"}
        )
        assert is_reusable(ir, "doc_outline") is False

    def test_another_document_is_not_reusable(self) -> None:
        ir = make_ir(heading_block_id="b_intro", paragraphs=[])
        assert is_reusable(ir, "some_other_doc") is False

    def test_absent_is_not_reusable(self) -> None:
        assert is_reusable(None, "doc_outline") is False


# --- detection sets the heading block ----------------------------------------


class TestDetectedSectionsCarryGeometry:
    def test_a_detected_section_names_its_heading_block(self) -> None:
        """`_detect_sections` already knew this and threw it away.

        The map existed only to assign paragraphs; keeping the block id on the
        section is what makes heading geometry reachable without a second
        detector or a re-extraction.
        """
        sections, heading_sections = _detect_sections(blocks(), "doc_x", 1)
        assert sections, "the fixture has two headings"
        for detected in sections:
            assert detected.heading_block_id is not None
            assert detected.heading_block_id in heading_sections

    def test_the_paper_title_is_not_a_section(self) -> None:
        page = PageIR(page_index=0, page_number=1, width_pt=595, height_pt=842,
                      has_text=True, blocks=blocks())
        sections, _ = _detect_sections([b for b in page.blocks], "doc_x", 1)
        assert all("Abstract" in s.title or "Introduction" in s.title for s in sections)
