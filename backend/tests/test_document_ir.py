"""Document IR — DS-DOC-001.

Two kinds of test live here, and the split is deliberate.

**Algorithm tests** build `TextBlockIR` lists by hand. The rules that matter most
— column ordering, paragraph assembly, section assignment — are pure functions
over blocks, so they can be pinned exactly, in milliseconds, without a vision
model in the loop. If two-column ordering were only tested through the model, a
detection difference would look like an ordering bug.

**Integration tests** run the real model on a real PDF. They are slower, and
there are fewer of them, because what they prove is different: that the model's
boxes arrive in a coordinate space we map correctly, and that the classes it
emits (`abandon`, `title`, `figure`) actually drive the behaviour the criteria
require.

The layout model is loaded once per process and cached, so the marginal cost of
the integration tests is detection time, not model time.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import fitz
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.document import extract_and_store, load_ir
from app.document.extract import DocumentExtractionError, extract_document_ir, order_blocks
from app.document.models import (
    LAYOUT_ABANDON,
    LAYOUT_FIGURE,
    LAYOUT_FIGURE_CAPTION,
    LAYOUT_ISOLATE_FORMULA,
    LAYOUT_PLAIN_TEXT,
    LAYOUT_TITLE,
    TextBlockIR,
)
from app.document.normalize import citations_in, join_wrapped_lines
from app.document.persistence import TEMP_PREFIX, read_ir, write_ir

# --- fixtures ----------------------------------------------------------------


def make_block(
    block_id: str,
    text: str,
    bbox: tuple[float, float, float, float],
    layout_class: str = LAYOUT_PLAIN_TEXT,
    page_number: int = 1,
) -> TextBlockIR:
    return TextBlockIR(
        id=block_id,
        page_index=page_number - 1,
        page_number=page_number,
        layout_class=layout_class,
        bbox=bbox,
        text=text,
    )


def write_pdf(path: Path, pages: int = 1, *, two_column: bool = False) -> Path:
    """A paper-shaped PDF. Sparse pages are classified `abandon` and skipped."""
    document = fitz.open()
    for index in range(pages):
        page = document.new_page(width=595, height=842)
        y = 70
        if index == 0:
            page.insert_text((150, y), "Learning Stable Policies for Manipulation", fontsize=15)
            y += 34
            page.insert_text((72, y), "Abstract", fontsize=11)
            y += 16
        for line in (
            "The policy is optimized through multiple rollouts collected from the simulator.",
            "We evaluate the learned policy on three manipulation benchmarks and report means.",
            "Each rollout is a sequence of observations, actions and rewards gathered under",
            "the current policy, which is then updated from the aggregated trajectories.",
        ):
            page.insert_text((72, y), line, fontsize=10)
            y += 14
        if two_column:
            page.insert_text((316, 160), "1 Introduction", fontsize=11)
            page.insert_text((316, 182), "LEFT COLUMN MARKER alpha", fontsize=10)
            page.insert_text((316, 196), "left but on the right half", fontsize=10)
    document.save(str(path))
    document.close()
    return path


def write_two_column_pdf(path: Path) -> Path:
    """One page, two columns, with a running header and a page number."""
    document = fitz.open()
    page = document.new_page(width=595, height=842)
    page.insert_text((72, 40), "Proceedings of the Test Conference 2025", fontsize=8)
    page.insert_text((523, 40), "7", fontsize=8)
    page.insert_text((150, 90), "Learning Stable Policies", fontsize=16)
    page.insert_text((72, 150), "Abstract", fontsize=11)
    page.insert_text((316, 150), "1 Introduction", fontsize=11)
    for line in range(12):
        page.insert_text((72, 170 + line * 12), f"LEFTCOL content line {line}", fontsize=9)
        page.insert_text((316, 170 + line * 12), f"RIGHTCOL content line {line}", fontsize=9)
    document.save(str(path))
    document.close()
    return path


@pytest.fixture(scope="module")
def two_column_ir(tmp_path_factory: pytest.TempPathFactory):
    """Real extraction of a real two-column page. Shared — the model is slow."""
    directory = tmp_path_factory.mktemp("doc001")
    source = write_two_column_pdf(directory / "two-col.pdf")
    return extract_document_ir(source, "doc_twocol")


# --- AC-DOC-01: schema --------------------------------------------------------


def test_ir_schema_serialization_roundtrip(two_column_ir):
    """AC-DOC-01 — the IR survives JSON losslessly."""
    from app.document.models import DocumentIR

    payload = two_column_ir.model_dump_json()
    restored = DocumentIR.model_validate_json(payload)

    assert restored == two_column_ir
    # Tuples must come back as tuples, not lists, or every bbox comparison in a
    # later phase would quietly be a list-versus-tuple comparison.
    assert isinstance(restored.pages[0].blocks[0].bbox, tuple)
    assert isinstance(restored.paragraphs[0].page_range, tuple)


# --- AC-DOC-04 / AC-DOC-06: real extraction ----------------------------------


def test_two_column_reading_order_not_interleaved(two_column_ir):
    """AC-DOC-04 — the P0 that justifies this whole module.

    The naive y-then-x sort would produce left line 0, right line 0, left line 1,
    right line 1. Reading order must exhaust the left column first.
    """
    text = "\n".join(paragraph.text for paragraph in two_column_ir.paragraphs)

    first_left = text.index("LEFTCOL content line 0")
    last_left = text.index("LEFTCOL content line 11")
    first_right = text.index("RIGHTCOL content line 0")

    assert last_left < first_right, (
        "columns are interleaved: the last left-column line appears after the "
        "first right-column line"
    )
    assert first_left < last_left < first_right


def test_abandon_headers_and_footers_excluded_from_paragraphs(two_column_ir):
    """AC-DOC-06 — running headers must not reach retrieval or a prompt."""
    paragraph_text = "\n".join(paragraph.text for paragraph in two_column_ir.paragraphs)

    assert "Proceedings of the Test Conference" not in paragraph_text

    # Retained in the page's blocks, though: coordinates stay complete, and the
    # decision not to *use* it is separable from the decision to *record* it.
    abandon = [
        block
        for page in two_column_ir.pages
        for block in page.blocks
        if block.layout_class == LAYOUT_ABANDON
    ]
    assert abandon, "the running header should still be present as a block"


def test_real_extraction_produces_sections_and_stable_ids(two_column_ir):
    """AC-DOC-10 — ids are deterministic and ordered by reading position."""
    titles = [section.title for section in two_column_ir.sections]
    assert "Abstract" in titles
    assert any(title.startswith("1 Introduction") for title in titles)

    assert all(
        paragraph.id == f"p_doc_twocol_{index:04d}"
        for index, paragraph in enumerate(two_column_ir.paragraphs, start=1)
    )


def test_real_extraction_is_deterministic(tmp_path: Path):
    """AC-DOC-10 — two runs produce byte-identical output."""
    source = write_two_column_pdf(tmp_path / "det.pdf")
    first = extract_document_ir(source, "doc_det")
    second = extract_document_ir(source, "doc_det")
    assert first.model_dump_json() == second.model_dump_json()


# --- AC-DOC-04 / AC-DOC-05 / AC-DOC-06: algorithms over synthetic blocks -------


def test_blocks_are_ordered_column_by_column():
    """AC-DOC-04, isolated from detection."""
    blocks = [
        make_block("l1", "left one", (72, 200, 290, 212)),
        make_block("r1", "right one", (316, 200, 540, 212)),
        make_block("l2", "left two", (72, 214, 290, 226)),
        make_block("r2", "right two", (316, 214, 540, 226)),
    ]

    ordered = [block.id for block in order_blocks(blocks, page_width_pt=595)]

    assert ordered == ["l1", "l2", "r1", "r2"]


def test_full_width_blocks_precede_the_columns():
    """A title spanning the page is read before either column."""
    blocks = [
        make_block("l1", "left", (72, 200, 290, 212)),
        make_block("r1", "right", (316, 200, 540, 212)),
        make_block("wide", "A Full Width Title", (72, 100, 540, 120), LAYOUT_TITLE),
    ]

    ordered = [block.id for block in order_blocks(blocks, page_width_pt=595)]

    assert ordered[0] == "wide"
    assert ordered.index("l1") < ordered.index("r1")


def test_a_full_width_figure_splits_the_page_into_bands():
    """Two column runs separated by a full-width region keep their own order."""
    blocks = [
        make_block("a1", "a1", (72, 200, 290, 212)),
        make_block("b1", "b1", (316, 200, 540, 212)),
        make_block("fig", "wide figure", (72, 300, 540, 400), LAYOUT_FIGURE),
        make_block("a2", "a2", (72, 420, 290, 432)),
        make_block("b2", "b2", (316, 420, 540, 432)),
    ]

    ordered = [block.id for block in order_blocks(blocks, page_width_pt=595)]

    assert ordered.index("a1") < ordered.index("b1")
    assert ordered.index("a2") < ordered.index("b2")
    assert ordered.index("b1") < ordered.index("fig") < ordered.index("a2")


def test_physical_blocks_merged_into_semantic_paragraphs(two_column_ir):
    """AC-DOC-05 — an unterminated block continues into the next."""
    # The fixture's left column is a run of lines that never end a sentence, so
    # it should arrive as one paragraph rather than twelve.
    left = [p for p in two_column_ir.paragraphs if "LEFTCOL content line 0" in p.text]
    assert len(left) == 1
    assert "LEFTCOL content line 11" in left[0].text


def test_a_finished_sentence_is_not_merged():
    """AC-DOC-05 — a block that ends its sentence starts a new paragraph."""
    from app.document.extract import _assemble_paragraphs

    blocks = [
        make_block("b1", "This sentence is complete.", (72, 200, 290, 212)),
        make_block("b2", "another block that stands alone.", (72, 214, 290, 226)),
    ]

    paragraphs = _assemble_paragraphs(blocks, "doc_x")

    assert len(paragraphs) == 2


def test_non_prose_blocks_never_join_a_paragraph():
    """AC-DOC-07 / AC-DOC-08 — captions and formulas break the prose chain."""
    from app.document.extract import _assemble_paragraphs

    blocks = [
        make_block("p1", "The method is described below and", (72, 200, 290, 212)),
        make_block("f1", "E = mc^2", (72, 220, 290, 240), LAYOUT_ISOLATE_FORMULA),
        make_block("p2", "then the results follow.", (72, 250, 290, 262)),
    ]

    paragraphs = _assemble_paragraphs(blocks, "doc_x")
    joined = " ".join(paragraph.text for paragraph in paragraphs)

    assert "E = mc^2" not in joined
    assert len(paragraphs) == 2


# --- AC-DOC-09: normalization -------------------------------------------------


def test_dehyphenation_joins_wrapped_words_but_keeps_compounds():
    """AC-DOC-09 — the ambiguous case, resolved conservatively and stated."""
    assert join_wrapped_lines(["The algo-", "rithm converges."]) == "The algorithm converges."
    assert join_wrapped_lines(["We use self-", "attention layers."]) == "We use self-attention layers."


def test_citations_preserved_verbatim(two_column_ir):
    """AC-DOC-09 / FC-05 — citations survive normalization untouched."""
    source = "As shown in [12], [3, 4] and [7-9], prior work (Smith et al., 2024) agrees."
    assert join_wrapped_lines([source]) == source
    assert citations_in(source) == ["[12]", "[3, 4]", "[7-9]", "(Smith et al., 2024)"]


def test_unicode_ligatures_normalized():
    """AC-DOC-09 — the ﬁ ligature becomes the two characters it represents."""
    assert "fi" in join_wrapped_lines(["The ﬁnal conﬁguration"])


# --- AC-DOC-11: page mapping --------------------------------------------------


def test_page_mapping_resolves_all_paragraphs_to_1based_pages(two_column_ir):
    """AC-DOC-11 — every citation target is a real, 1-based page."""
    for paragraph in two_column_ir.paragraphs:
        assert paragraph.page_number >= 1
        assert paragraph.page_number <= two_column_ir.page_count
        assert paragraph.page_range[0] == paragraph.page_number
        assert two_column_ir.page_mapping[paragraph.id] == paragraph.page_number

    assert set(two_column_ir.page_mapping) == {p.id for p in two_column_ir.paragraphs}


def test_page_index_is_zero_based_and_never_confused(two_column_ir):
    """Settled question 1 — the two numbering schemes stay distinct."""
    for page in two_column_ir.pages:
        assert page.page_index == page.page_number - 1
    assert two_column_ir.pages[0].page_index == 0
    assert two_column_ir.pages[0].page_number == 1


# --- AC-DOC-12 / AC-DOC-13: persistence ---------------------------------------


def test_ir_persistence_writes_atomic_json_file(tmp_path: Path):
    """AC-DOC-12 — the file lands, and no temporary survives."""
    source = write_two_column_pdf(tmp_path / "p.pdf")
    ir = extract_document_ir(source, "doc_p")
    directory = tmp_path / "document"
    write_ir(directory, ir)

    assert (directory / "ir.json").is_file()
    assert json.loads((directory / "ir.json").read_text(encoding="utf-8"))
    assert not list(directory.glob(f"{TEMP_PREFIX}*.json"))


def test_a_failed_write_leaves_no_partial_file(tmp_path: Path, monkeypatch):
    """AC-DOC-12 — better no cache than a truncated one."""
    from app.document import persistence

    directory = tmp_path / "document"
    directory.mkdir()
    source = write_two_column_pdf(tmp_path / "p.pdf")
    ir = extract_document_ir(source, "doc_p")

    def explode(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(persistence.os, "replace", explode)

    with pytest.raises(OSError):
        write_ir(directory, ir)

    assert not (directory / "ir.json").exists()
    assert not list(directory.glob(f"{TEMP_PREFIX}*.json"))


def test_cached_read_does_not_run_extraction(two_column_ir, tmp_path: Path):
    """AC-DOC-13 — a second read is a file read, not a model run."""
    source = write_two_column_pdf(tmp_path / "c.pdf")
    directory = tmp_path / "document"
    write_ir(directory, two_column_ir)

    started = time.perf_counter()
    cached, summary = extract_and_store(directory, source, "doc_twocol")
    elapsed = time.perf_counter() - started

    assert summary.reused is True
    assert cached == two_column_ir
    assert elapsed < 0.05, f"a cached read took {elapsed:.3f}s"

    # And the plain reader never touches the model at all.
    assert load_ir(directory) == two_column_ir


def test_extraction_is_idempotent(tmp_path: Path):
    """AC-DOC-14 — running it twice changes nothing on disk."""
    source = write_two_column_pdf(tmp_path / "i.pdf")
    directory = tmp_path / "document"

    first, first_summary = extract_and_store(directory, source, "doc_i")
    before = (directory / "ir.json").read_text(encoding="utf-8")
    second, second_summary = extract_and_store(directory, source, "doc_i")
    after = (directory / "ir.json").read_text(encoding="utf-8")

    assert first.model_dump_json() == second.model_dump_json()
    assert before == after
    assert first_summary.reused is False
    assert second_summary.reused is True


# --- AC-DOC-15 / AC-DOC-29: the source is never touched -----------------------


def test_source_pdf_unmodified_during_extraction(tmp_path: Path):
    """AC-DOC-15 — hash *and* mtime, because a rewrite could preserve neither."""
    source = write_two_column_pdf(tmp_path / "s.pdf")
    before_stat = source.stat()
    before_bytes = source.read_bytes()

    extract_document_ir(source, "doc_s")

    after_stat = source.stat()
    assert source.read_bytes() == before_bytes
    assert after_stat.st_mtime == before_stat.st_mtime
    assert after_stat.st_size == before_stat.st_size


# --- AC-DOC-16 / AC-DOC-17 / AC-DOC-18 / AC-DOC-19: degenerate inputs ---------


def test_corrupt_pdf_raises_source_invalid(tmp_path: Path):
    """AC-DOC-16."""
    broken = tmp_path / "broken.pdf"
    broken.write_bytes(b"%PDF-1.4\nthis is not a real pdf at all\n")

    with pytest.raises(DocumentExtractionError) as caught:
        extract_document_ir(broken, "doc_broken")

    assert caught.value.code == "SOURCE_INVALID"


def test_encrypted_pdf_raises_pdf_encrypted(tmp_path: Path):
    """AC-DOC-17."""
    document = fitz.open()
    page = document.new_page()
    page.insert_text((72, 72), "secret", fontsize=12)
    encrypted = tmp_path / "locked.pdf"
    document.save(
        str(encrypted),
        encryption=fitz.PDF_ENCRYPT_AES_256,
        owner_pw="owner",
        user_pw="user",
    )
    document.close()

    with pytest.raises(DocumentExtractionError) as caught:
        extract_document_ir(encrypted, "doc_locked")

    assert caught.value.code == "PDF_ENCRYPTED"


def test_scanned_pdf_reports_no_text_layer_and_ocr_required(tmp_path: Path):
    """AC-DOC-18 — a scan is reported honestly; OCR is not attempted."""
    document = fitz.open()
    page = document.new_page(width=595, height=842)
    # An image with no text layer at all.
    page.insert_image(fitz.Rect(50, 50, 545, 792), pixmap=fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 40, 50)))
    scanned = tmp_path / "scan.pdf"
    document.save(str(scanned))
    document.close()

    ir = extract_document_ir(scanned, "doc_scan")

    assert ir.has_text_layer is False
    assert ir.ocr_required is True
    assert ir.paragraphs == []
    assert all(page.has_text is False for page in ir.pages)


def test_sparse_and_blank_pages_handled_gracefully(tmp_path: Path):
    """AC-DOC-19 — a blank leaf is a page with no blocks, not an exception."""
    document = fitz.open()
    document.new_page(width=595, height=842)  # entirely blank
    document.save(str(tmp_path / "blank.pdf"))
    document.close()

    ir = extract_document_ir(tmp_path / "blank.pdf", "doc_blank")

    assert ir.page_count == 1
    assert ir.pages[0].blocks == []
    assert ir.pages[0].has_text is False


def test_a_missing_source_is_reported_not_crashed(tmp_path: Path):
    with pytest.raises(DocumentExtractionError) as caught:
        extract_document_ir(tmp_path / "nope.pdf", "doc_nope")
    assert caught.value.code == "SOURCE_NOT_FOUND"


# --- AC-DOC-27 / AC-DOC-28 / AC-DOC-29: sections ------------------------------


def test_heading_hierarchy_detection_with_regex():
    """AC-DOC-27 — levels come from the heading's own numbering."""
    blocks = [
        make_block("t", "A Paper Title", (72, 60, 540, 90), LAYOUT_TITLE),
        make_block("h1", "1 Introduction", (72, 120, 300, 140), LAYOUT_TITLE),
        make_block("b1", "Body text.", (72, 150, 540, 170)),
        make_block("h2", "2.1 Encoder", (72, 200, 300, 220), LAYOUT_TITLE),
        make_block("b2", "More text.", (72, 230, 540, 250)),
    ]

    from app.document.extract import _detect_sections

    # Returns (sections, heading→section map): the assignment pass needs to know
    # which block opened which section, so it can place a paragraph by reading
    # order rather than by page.
    sections, _headings = _detect_sections(blocks, "doc_h", page_count=1)

    levels = {section.title: section.level for section in sections}
    assert levels["1 Introduction"] == 1
    assert levels["2.1 Encoder"] == 2


def test_unnumbered_heading_defaults_to_level_one():
    """AC-DOC-27 — no numbering means level 1, not an invented depth."""
    blocks = [
        make_block("t", "A Paper Title", (72, 60, 540, 90), LAYOUT_TITLE),
        make_block("h", "Conclusion", (72, 120, 300, 140), LAYOUT_TITLE),
        make_block("b", "Body.", (72, 150, 540, 170)),
    ]

    from app.document.extract import _detect_sections

    # Returns (sections, heading→section map): the assignment pass needs to know
    # which block opened which section, so it can place a paragraph by reading
    # order rather than by page.
    sections, _headings = _detect_sections(blocks, "doc_h", page_count=1)
    assert sections[0].level == 1


def test_title_block_at_body_size_is_not_a_heading():
    """Gate 0 regression — a `title` block set at body size is a label, not a heading.

    Found on a real 12-page paper: the layout model labels the paper title, all
    17 genuine section headings, *and* five table sub-labels such as "PASCAL VOC"
    as `title`. Promoting those produced five phantom sections. Font size is what
    separates them — the headings were all ≥ 1pt larger than body text, the
    sub-labels were exactly body size.
    """
    blocks = [
        make_block("t", "A Paper Title", (72, 60, 540, 90), LAYOUT_TITLE).model_copy(
            update={"font_size": 14.0}
        ),
        make_block("body", "Ordinary body prose here.", (72, 100, 540, 120)).model_copy(
            update={"font_size": 10.0}
        ),
        make_block("h", "1. A Real Section", (72, 140, 300, 160), LAYOUT_TITLE).model_copy(
            update={"font_size": 12.0}
        ),
        make_block("label", "PASCAL VOC", (72, 180, 200, 196), LAYOUT_TITLE).model_copy(
            update={"font_size": 10.0}
        ),
    ]

    from app.document.extract import _detect_sections

    # Returns (sections, heading→section map): the assignment pass needs to know
    # which block opened which section, so it can place a paragraph by reading
    # order rather than by page.
    sections, _headings = _detect_sections(blocks, "doc_h", page_count=1)
    titles = [section.title for section in sections]

    assert "1. A Real Section" in titles
    assert "PASCAL VOC" not in titles, "a body-size label was promoted to a section"


def test_heading_sized_blocks_are_accepted_when_font_evidence_is_absent():
    """A hand-built block carries no font size; it must not be silently dropped."""
    blocks = [
        make_block("t", "A Paper Title", (72, 60, 540, 90), LAYOUT_TITLE),
        make_block("h", "1. Introduction", (72, 120, 300, 140), LAYOUT_TITLE),
        make_block("b", "Body.", (72, 150, 540, 170)),
    ]

    from app.document.extract import _detect_sections

    # Returns (sections, heading→section map): the assignment pass needs to know
    # which block opened which section, so it can place a paragraph by reading
    # order rather than by page.
    sections, _headings = _detect_sections(blocks, "doc_h", page_count=1)
    assert [section.title for section in sections] == ["1. Introduction"]


def test_narrow_block_crossing_the_gutter_keeps_its_position():
    """Gate 0 regression — a line spanning both columns is read where it sits.

    Measured on a real paper: an author-email line at y=184, between the byline
    and the abstract, was ordered *after* prose at y=555 because it fitted
    neither column and so became a column of its own, sorted last by x.
    """
    blocks = [
        make_block("t", "Title", (152, 100, 443, 118), LAYOUT_TITLE),
        make_block("byline", "A. Author", (136, 130, 459, 142)),
        make_block("email", "a@b.com and c@d.com", (195, 150, 401, 162)),
        make_block("abstract", "Abstract", (146, 180, 191, 192), LAYOUT_TITLE),
        make_block("left1", "Left column prose one.", (49, 200, 287, 400)),
        make_block("left2", "Left column prose two.", (49, 410, 287, 600)),
        make_block("right1", "Right column prose one.", (308, 200, 546, 400)),
        make_block("right2", "Right column prose two.", (308, 410, 546, 600)),
    ]

    ordered = [block.id for block in order_blocks(blocks, page_width_pt=612)]

    assert ordered.index("email") < ordered.index("abstract"), (
        "a gutter-crossing line was swept out of its reading position"
    )
    assert ordered.index("left2") < ordered.index("right1")


def test_a_sliver_in_the_gutter_does_not_hide_the_column_split():
    """Gate 0 regression — one stray numeral must not collapse a two-column page.

    A 5pt page number sitting in the gutter filled the empty channel, so no
    gutter was detected, the page read as one column, and every page interleaved.
    """
    blocks = [
        make_block("left1", "Left column prose one.", (49, 200, 287, 400)),
        make_block("left2", "Left column prose two.", (49, 410, 287, 600)),
        make_block("right1", "Right column prose one.", (308, 200, 546, 400)),
        make_block("right2", "Right column prose two.", (308, 410, 546, 600)),
        make_block("page_num", "1", (295, 730, 300, 740)),
        make_block("left3", "Left column prose three.", (49, 610, 287, 700)),
    ]

    ordered = [block.id for block in order_blocks(blocks, page_width_pt=612)]

    assert ordered.index("left3") < ordered.index("right1"), (
        "the stray numeral in the gutter collapsed the column split"
    )


def test_layout_title_fills_in_absent_pdf_metadata(tmp_path: Path):
    """Gate 0 regression — AC-DOC-30.

    arXiv PDFs routinely carry no title metadata, which is exactly when the
    title printed on the page is worth having. Only the metadata half of this
    criterion was implemented at first; the layout half is what makes it work on
    a real paper.
    """
    document = fitz.open()
    page = document.new_page(width=612, height=792)
    page.insert_text((150, 90), "Deep Residual Learning for Image Recognition", fontsize=15)
    y = 140
    for line in (
        "The policy is optimized through multiple rollouts collected from a deployed",
        "system, and we evaluate it on three benchmarks with identical settings.",
    ):
        page.insert_text((72, y), line, fontsize=10)
        y += 14
    source = tmp_path / "untitled.pdf"
    document.set_metadata({"title": "", "producer": "LaTeX2e"})
    document.save(str(source))
    document.close()

    ir = extract_document_ir(source, "doc_t")

    assert ir.metadata.title == "Deep Residual Learning for Image Recognition"


def test_references_section_flagged():
    """AC-DOC-29."""
    blocks = [
        make_block("t", "A Paper Title", (72, 60, 540, 90), LAYOUT_TITLE),
        make_block("h", "References", (72, 120, 300, 140), LAYOUT_TITLE),
        make_block("b", "[1] A. Author. A paper. 2024.", (72, 150, 540, 170)),
    ]

    from app.document.extract import _detect_sections

    # Returns (sections, heading→section map): the assignment pass needs to know
    # which block opened which section, so it can place a paragraph by reading
    # order rather than by page.
    sections, _headings = _detect_sections(blocks, "doc_h", page_count=1)
    assert sections[0].is_references is True


def test_abstract_detection_is_keyword_anchored(two_column_ir):
    """AC-DOC-28 — flagged only where an "Abstract" heading exists."""
    assert any(section.title.lower().startswith("abstract") for section in two_column_ir.sections)

    # A document with no such heading must not invent one.
    blocks = [
        make_block("t", "A Paper Title", (72, 60, 540, 90), LAYOUT_TITLE),
        make_block("h", "1 Introduction", (72, 120, 300, 140), LAYOUT_TITLE),
        make_block("b", "Body.", (72, 150, 540, 170)),
    ]

    from app.document.extract import _detect_sections

    # Returns (sections, heading→section map): the assignment pass needs to know
    # which block opened which section, so it can place a paragraph by reading
    # order rather than by page.
    sections, _headings = _detect_sections(blocks, "doc_h", page_count=1)
    assert all(not section.title.lower().startswith("abstract") for section in sections)


# --- AC-DOC-30: metadata honesty ----------------------------------------------


def test_generic_metadata_is_rejected(tmp_path: Path):
    """AC-DOC-30 — a producer of "LaTeX2e" is not the paper's title."""
    document = fitz.open()
    document.new_page(width=595, height=842).insert_text((72, 72), "Body text here.", fontsize=11)
    document.set_metadata({"title": "untitled", "producer": "LaTeX2e", "author": ""})
    source = tmp_path / "meta.pdf"
    document.save(str(source))
    document.close()

    ir = extract_document_ir(source, "doc_meta")

    assert ir.metadata.title is None
    assert ir.metadata.producer is None
    assert ir.metadata.authors is None


# --- AC-DOC-21 / AC-DOC-22 / AC-DOC-23 / AC-DOC-31: HTTP ----------------------


@pytest.fixture
def document_id(client: TestClient, tmp_path: Path) -> str:
    """Import a real PDF through the real upload endpoint."""
    source = write_two_column_pdf(tmp_path / "upload.pdf")
    response = client.post(
        "/api/documents",
        files={"file": ("upload.pdf", source.read_bytes(), "application/pdf")},
    )
    assert response.status_code == 201, response.text
    return response.json()["document_id"]


def test_api_get_ir_returns_200_and_schema(client: TestClient, document_id: str):
    """AC-DOC-21 — the first read extracts; the schema comes back whole."""
    response = client.get(f"/api/documents/{document_id}/ir")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["document_id"] == document_id
    assert body["page_count"] == 1
    assert isinstance(body["paragraphs"], list)
    assert isinstance(body["page_mapping"], dict)

    # No filesystem path may appear anywhere in the payload (FC-12).
    assert "/" not in body["source_filename"]
    assert "documents" not in json.dumps(body)


def test_api_get_ir_is_404_for_an_unknown_document(client: TestClient):
    """AC-DOC-21."""
    response = client.get("/api/documents/doc_nope/ir")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"


def test_api_get_sections_returns_toc_list(client: TestClient, document_id: str):
    """AC-DOC-22."""
    response = client.get(f"/api/documents/{document_id}/sections")

    assert response.status_code == 200
    sections = response.json()
    assert isinstance(sections, list)
    assert all({"id", "title", "level", "page_number"} <= set(s) for s in sections)


def test_api_get_page_mapping_returns_citations_dict(client: TestClient, document_id: str):
    """AC-DOC-23."""
    response = client.get(f"/api/documents/{document_id}/page-mapping")

    assert response.status_code == 200
    body = response.json()
    assert body["document_id"] == document_id
    assert isinstance(body["page_mapping"], dict)


def test_api_extract_ir_reuses_without_force(client: TestClient, document_id: str):
    """AC-DOC-31 — a second call is a no-op unless forced."""
    client.get(f"/api/documents/{document_id}/ir")

    reused = client.post(f"/api/documents/{document_id}/extract-ir", json={})
    assert reused.status_code == 200
    assert reused.json()["reused"] is True

    forced = client.post(f"/api/documents/{document_id}/extract-ir", json={"force": True})
    assert forced.status_code == 200
    assert forced.json()["reused"] is False


def test_api_ir_is_cached_on_disk(client: TestClient, document_id: str, settings):
    """AC-DOC-12 — the artifact lives beside the other derived files."""
    client.get(f"/api/documents/{document_id}/ir")

    stored = settings.documents_dir / document_id / "ir.json"
    assert stored.is_file()

    # And it is readable without touching a model.
    cached = read_ir(settings.documents_dir / document_id)
    assert cached is not None and cached.document_id == document_id


def test_api_reports_an_encrypted_document_honestly(client: TestClient, tmp_path: Path):
    """AC-DOC-17 through the API.

    An encrypted PDF is *importable* — PyMuPDF can report its page count without
    the password, and DS-BE-007's upload validation is deliberately unchanged. It
    is unreadable, which is a different thing, and the reader already says so.
    Document Intelligence is where it has to fail, because that is the first
    component that genuinely needs the content.
    """
    document = fitz.open()
    document.new_page().insert_text((72, 72), "locked", fontsize=12)
    locked = tmp_path / "locked.pdf"
    document.save(str(locked), encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw="o", user_pw="u")
    document.close()

    imported = client.post(
        "/api/documents",
        files={"file": ("locked.pdf", locked.read_bytes(), "application/pdf")},
    )
    assert imported.status_code == 201, imported.text
    document_id = imported.json()["document_id"]

    for route in ("ir", "sections", "page-mapping"):
        response = client.get(f"/api/documents/{document_id}/{route}")
        assert response.status_code == 422, route
        assert response.json()["error"]["code"] == "PDF_ENCRYPTED", route

    # And no partial cache was written for it.
    assert not (client.app.state.settings.documents_dir / document_id / "ir.json").exists()


def test_extraction_runs_off_event_loop(app: FastAPI, client: TestClient, document_id: str):
    """AC-DOC-20 — the server stays responsive while extraction is running.

    Asserted by observing that the health endpoint answers while an extraction
    is in flight. If extraction ran on the event loop, the health request could
    not be served until it finished.
    """
    import threading

    done = threading.Event()
    timings: list[float] = []

    def hit_ir() -> None:
        try:
            client.get(f"/api/documents/{document_id}/ir")
        finally:
            done.set()

    worker = threading.Thread(target=hit_ir)
    worker.start()

    # Poll health while the extraction is in flight.
    for _ in range(200):
        if done.is_set():
            break
        started = time.perf_counter()
        response = client.get("/api/health")
        timings.append(time.perf_counter() - started)
        assert response.status_code == 200

    worker.join(timeout=120)
    assert done.is_set(), "extraction never completed"

    assert timings, "the extraction finished before a single health check ran"
    assert max(timings) < 1.0, f"health check blocked for {max(timings):.3f}s"


# --- AC-DOC-24 / AC-DOC-25 / AC-DOC-26: guards --------------------------------


def test_no_speculative_tables_and_isolation_preserved(client: TestClient, settings):
    """AC-DOC-24 / AC-DOC-25 — the guards the IR must not trip.

    The IR is a file artifact precisely so the database table set stays pinned;
    this asserts the set again from the document-IR side, after a full
    extraction has run through the API.
    """
    import sqlite3

    connection = sqlite3.connect(str(settings.database_path))
    try:
        tables = sorted(
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )
        )
    finally:
        connection.close()

    assert tables == ["annotation_targets", "annotations", "documents", "profiles", "schema_version", "translation_tasks"]


def test_duplicate_detections_are_collapsed(two_column_ir):
    """A measured model behaviour: the same rectangle at two confidences.

    Left in, the duplicate would put every character in the region into two
    blocks and double-count the text.
    """
    for page in two_column_ir.pages:
        seen: list[tuple[float, float, float, float]] = []
        for block in page.blocks:
            rounded = tuple(round(value, 1) for value in block.bbox)
            assert rounded not in seen, f"duplicate block rectangle: {rounded}"
            seen.append(rounded)


def test_sections_sharing_a_page_still_own_their_own_paragraphs():
    """AC-DOC-27, as a regression — the assignment must follow *reading order*.

    Found by DS-QA-001, three tasks after it shipped. `_assign_sections` chose a
    paragraph's section by **page**: a page-3 paragraph got the last section that
    *started* on page 3. Academic sections routinely share a page, so on a real
    paper every page-3 paragraph landed in one section and **eight of sixteen
    sections owned nothing at all** — including the Abstract and the References.

    Nothing upstream noticed, because the reading order, the headings and the
    page mapping were all still correct. It surfaced only when Paper QA needed to
    retrieve *within* a section and half of them were empty.
    """
    def sized(block_id, text, bbox, size):
        return make_block(block_id, text, bbox, LAYOUT_TITLE).model_copy(
            update={"font_size": size}
        )

    blocks = [
        # The paper's own title: the largest `title` block on page 1 is taken as
        # the document title and is not a section, so the fixture needs one.
        sized("t", "A Paper Title", (150, 20, 450, 44), 16.0),
        sized("h1", "1. First Section", (72, 60, 300, 80), 12.0),
        make_block("b1", "Prose belonging to the first section.", (72, 100, 540, 120)),
        # Three headings on one page — the layout that broke the page-based rule.
        sized("h2", "2. Second Section", (72, 160, 300, 180), 12.0),
        make_block("b2", "Prose belonging to the second section.", (72, 200, 540, 220)),
        sized("h3", "2.1. A Subsection", (72, 260, 300, 280), 11.0),
        make_block("b3", "Prose belonging to the subsection.", (72, 300, 540, 320)),
    ]

    from app.document.extract import _assign_sections, _assemble_paragraphs, _detect_sections

    sections, headings = _detect_sections(blocks, "doc_x", page_count=1)
    paragraphs = _assemble_paragraphs(blocks, "doc_x")
    _assign_sections(paragraphs, sections, blocks, headings)

    by_title = {section.title: section.id for section in sections}
    assigned = {p.text: p.section_id for p in paragraphs}

    assert assigned["Prose belonging to the first section."] == by_title["1. First Section"]
    assert assigned["Prose belonging to the second section."] == by_title["2. Second Section"]
    assert assigned["Prose belonging to the subsection."] == by_title["2.1. A Subsection"]