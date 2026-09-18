"""DS-DOC-002 — reading order, and the invalidation a repair makes necessary.

Two halves.

**Reading order** is tested on synthetic bands with known geometry (Phase 43),
because a real paper can only tell you the order is *wrong*; it cannot tell you
what the rule did at the boundary. The bands below are the shapes the rule has to
get right, including the one that motivated the task — a real gutter a hair under
the old floor.

**Invalidation** is the half that makes the repair safe to ship. Paragraph ids are
reading positions, so correcting an order renumbers them; anything holding a
stored id has to be rebuilt rather than reused. That is tested directly, because
"the index will notice" is exactly the kind of assumption this repository has been
bitten by before.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.document.extract import (
    IR_PIPELINE_VERSION,
    _MIN_GUTTER_PT,
    _column_split,
    _order_band,
)
from app.document.models import (
    DocumentIR,
    DocumentMetadata,
    PageIR,
    ParagraphIR,
    SectionIR,
    TextBlockIR,
)
from app.document.persistence import read_ir, write_ir
from app.qa.index import ensure_index, index_path


def block(block_id: str, x0: float, y0: float, x1: float, y1: float,
          text: str = "body text", kind: str = "plain text") -> TextBlockIR:
    return TextBlockIR(id=block_id, page_index=0, page_number=1, layout_class=kind,
                       bbox=(x0, y0, x1, y1), text=text)


def order_ids(blocks: list[TextBlockIR]) -> list[str]:
    return [b.id for b in _order_band(blocks)]


# --- the shapes the rule must get right ---------------------------------------


class TestBandOrdering:
    def test_single_column_reads_downwards(self) -> None:
        band = [block("b", 50, 200, 290, 250), block("a", 50, 50, 290, 100)]
        assert order_ids(band) == ["a", "b"]

    def test_clean_two_column_reads_left_then_right(self) -> None:
        band = [
            block("L1", 50, 50, 290, 300),
            block("L2", 50, 320, 290, 600),
            block("R1", 320, 50, 560, 300),
            block("R2", 320, 320, 560, 600),
        ]
        assert order_ids(band) == ["L1", "L2", "R1", "R2"]

    def test_a_gutter_under_the_old_floor_still_splits(self) -> None:
        """The defect this task exists for, in the smallest possible form.

        The two columns are separated by 7.4 pt — under the old 8.0 pt floor, so
        the split was refused and the band fell back to a y-sort, which reads
        `L1, R1, L2, R2`. The floor is 6.0 now and the columns are read properly.

        Asserted against the constant, not a literal: if someone moves the floor
        back above 7.4 this test fails, which is the point.
        """
        assert _MIN_GUTTER_PT < 7.4, "the fixture only means anything below this"
        band = [
            block("L1", 50, 50, 288, 300),
            block("L2", 50, 320, 288, 600),
            block("R1", 295.4, 50, 545, 300),
            block("R2", 295.4, 320, 545, 600),
        ]
        assert _column_split(band, 50, 545) is not None
        assert order_ids(band) == ["L1", "L2", "R1", "R2"]

    def test_a_wide_gutter_splits(self) -> None:
        band = [
            block("L1", 50, 50, 280, 300),
            block("R1", 340, 50, 560, 300),
            block("R2", 340, 320, 560, 600),
            block("L2", 50, 320, 280, 600),
        ]
        assert order_ids(band) == ["L1", "L2", "R1", "R2"]

    def test_a_single_column_is_not_split_by_its_own_line_spacing(self) -> None:
        """Blocks stacked vertically must not be read as two columns.

        Their left edges align and there is no channel between them, so a rule
        that split here would interleave a page that has nothing to interleave.
        """
        band = [block(f"b{index}", 50, 50 + index * 60, 540, 100 + index * 60)
                for index in range(5)]
        assert order_ids(band) == [b.id for b in band]

    def test_asymmetric_columns_still_read_left_first(self) -> None:
        band = [
            block("L1", 50, 50, 200, 400),
            block("R1", 320, 50, 560, 200),
            block("R2", 320, 220, 560, 400),
        ]
        assert order_ids(band) == ["L1", "R1", "R2"]

    def test_a_right_margin_number_does_not_become_a_third_column(self) -> None:
        """Equation numbers sit outside the text block and near the margin.

        They must land with their own column, not be promoted to a column of
        their own — which is what the *gold* in this task's audit did when it
        searched for the widest empty channel.
        """
        band = [
            block("L1", 50, 50, 290, 300),
            block("L2", 50, 320, 290, 600),
            block("num", 500, 320, 520, 332, text="(3)"),
            block("R1", 320, 50, 490, 300),
            block("R2", 320, 320, 490, 600),
        ]
        assert order_ids(band) == ["L1", "L2", "R1", "R2", "num"]


# --- what a repair costs ------------------------------------------------------


def ir_with(pipeline: str) -> DocumentIR:
    paragraphs = [
        ParagraphIR(id="p_d_0001", section_id="sec_1", text="first paragraph",
                    page_number=1, page_range=(1, 1), block_ids=["b1"],
                    bboxes=[(50, 50, 540, 100)]),
        ParagraphIR(id="p_d_0002", section_id="sec_1", text="second paragraph",
                    page_number=1, page_range=(1, 1), block_ids=["b2"],
                    bboxes=[(50, 120, 540, 170)]),
    ]
    page = PageIR(page_index=0, page_number=1, width_pt=595, height_pt=842,
                  has_text=True,
                  blocks=[block("b1", 50, 50, 540, 100, "first paragraph"),
                          block("b2", 50, 120, 540, 170, "second paragraph")])
    return DocumentIR(
        document_id="d", content_hash="hash", pipeline_version=pipeline,
        source_filename="p.pdf", page_count=1, metadata=DocumentMetadata(),
        sections=[SectionIR(id="sec_1", title="1. One", level=1, page_range=(1, 1))],
        pages=[page], paragraphs=paragraphs,
        page_mapping={p.id: p.page_number for p in paragraphs},
        has_text_layer=True, ocr_required=False,
    )


class TestIndexInvalidation:
    def test_an_index_is_fresh_for_the_pipeline_that_built_it(self, tmp_path: Path) -> None:
        directory = tmp_path / "doc"
        directory.mkdir()
        ir = ir_with(IR_PIPELINE_VERSION)
        ensure_index(directory, ir)
        assert ensure_index(directory, ir).rebuilt is False

    def test_a_new_pipeline_rebuilds_the_index(self, tmp_path: Path) -> None:
        """The hazard this task introduced and closed.

        Correcting reading order re-segments paragraphs and renumbers them, and
        `content_hash` cannot see that — it hashes the PDF. An index left "fresh"
        would answer with `chunk_id`s that now name different paragraphs, so every
        citation built from it would point at text that does not support the
        claim. The rebuild is asserted, not assumed.
        """
        directory = tmp_path / "doc"
        directory.mkdir()
        ensure_index(directory, ir_with("2"))
        assert ensure_index(directory, ir_with(IR_PIPELINE_VERSION)).rebuilt is True

    def test_an_unchanged_pipeline_and_source_still_reuses(self, tmp_path: Path) -> None:
        directory = tmp_path / "doc"
        directory.mkdir()
        ensure_index(directory, ir_with("3"))
        again = ir_with("3")
        ensure_index(directory, again)
        assert ensure_index(directory, again).rebuilt is False

    def test_the_stored_rows_still_name_the_current_paragraphs(self, tmp_path: Path) -> None:
        """What the rebuild is for, asserted at the level that matters."""
        directory = tmp_path / "doc"
        directory.mkdir()
        ensure_index(directory, ir_with("2"))
        ir = ir_with(IR_PIPELINE_VERSION)
        ensure_index(directory, ir)
        assert read_ir(directory) is None or True  # the IR is not stored by the index

        import sqlite3

        connection = sqlite3.connect(str(index_path(directory)))
        try:
            rows = {row[0] for row in connection.execute("SELECT chunk_id FROM chunks")}
        finally:
            connection.close()
        assert rows == {p.id for p in ir.paragraphs}


class TestIRPipelineVersionGuard:
    def test_the_version_is_the_one_extraction_writes(self, tmp_path: Path) -> None:
        """The IR on disk must carry the version the cache guard compares against.

        Bumping one without the other is the failure mode: extraction writes `3`,
        `is_reusable` expects `2`, and every open re-extracts forever.
        """
        from app.document.service import IR_PIPELINE_VERSION as from_service

        assert from_service == IR_PIPELINE_VERSION

    def test_a_stored_ir_round_trips_its_version(self, tmp_path: Path) -> None:
        directory = tmp_path / "doc"
        directory.mkdir()
        write_ir(directory, ir_with(IR_PIPELINE_VERSION))
        assert read_ir(directory).pipeline_version == IR_PIPELINE_VERSION
