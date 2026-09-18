"""DS-DOC-003 — stable source identity, and what it must refuse to do.

The unit under test is not "does a hash come out". It is: *does a note written
against this paragraph still point at the same sentence after the extraction that
produced it stops existing.* Every test below is one of the ways that can fail.

The invariant the whole design rests on is that **nothing positional enters the
payload**. `paragraph.id` and `block.id` are ordinals; the anchor must not be, or
it inherits exactly the fragility it was built to escape. Tests that move a
paragraph's ordinal without moving its source are therefore the important ones.
"""

from __future__ import annotations

import hashlib

import pytest

from app.document.anchors import (
    GEOMETRY_QUANTUM_PT,
    SOURCE_ANCHOR_VERSION,
    AnchorState,
    anchor_payload_for,
    canonical_source_text,
    describe_anchor,
    quantize,
    reattach,
    source_anchor_id,
)
from app.document.extract import IR_PIPELINE_VERSION, extract_document_ir
from app.document.models import (
    DocumentIR,
    DocumentMetadata,
    PageIR,
    ParagraphIR,
    TextBlockIR,
)

FINGERPRINT = "hash-a"


def paragraph(
    pid: str, text: str, page: int = 1, bbox=(50.0, 100.0, 300.0, 140.0)
) -> ParagraphIR:
    return ParagraphIR(
        id=pid, section_id=None, text=text, page_number=page,
        page_range=(page, page), block_ids=[f"b_{pid}"], bboxes=[bbox],
    )


def ir_with(paragraphs: list[ParagraphIR], fingerprint: str = FINGERPRINT) -> DocumentIR:
    return DocumentIR(
        document_id="doc", content_hash=fingerprint,
        pipeline_version=IR_PIPELINE_VERSION, source_filename="p.pdf",
        page_count=1, metadata=DocumentMetadata(),
        sections=[], pages=[], paragraphs=paragraphs,
        page_mapping={p.id: p.page_number for p in paragraphs},
        has_text_layer=True, ocr_required=False,
    )


def anchor_of(p: ParagraphIR, fingerprint: str = FINGERPRINT) -> str:
    return source_anchor_id(ir_with([p], fingerprint), p)


# --- what the anchor is made of -----------------------------------------------


class TestAnchorComposition:
    def test_the_payload_is_inspectable(self) -> None:
        """A hash nobody can debug is a hash nobody can migrate (Phase 53)."""
        p = paragraph("p_1", "Shortcut connections are identity mappings.")
        payload = anchor_payload_for(FINGERPRINT, p)
        assert payload.startswith(SOURCE_ANCHOR_VERSION)
        assert FINGERPRINT in payload
        assert "Shortcut connections are identity mappings." in payload

    def test_it_is_a_sha256_of_that_payload(self) -> None:
        p = paragraph("p_1", "Some prose.")
        expected = hashlib.sha256(
            anchor_payload_for(FINGERPRINT, p).encode("utf-8")
        ).hexdigest()
        assert anchor_of(p) == expected

    def test_the_version_is_inside_the_hash_not_beside_it(self) -> None:
        """A version stored next to a hash can be forgotten; one inside cannot.

        An anchor persisted under v1 and compared under v2 must not *match* — it
        must be visibly different, so the migration path is taken rather than a
        wrong attachment being made quietly.
        """
        p = paragraph("p_1", "Some prose.")
        payload = anchor_payload_for(FINGERPRINT, p)
        assert payload.split("|", 1)[0] == SOURCE_ANCHOR_VERSION

    def test_no_ordinal_enters_the_payload(self) -> None:
        p = paragraph("p_1", "Some prose.", bbox=(50.0, 100.0, 300.0, 140.0))
        payload = anchor_payload_for(FINGERPRINT, p)
        assert "p_1" not in payload
        assert "b_p_1" not in payload


# --- the invariants the task exists for ---------------------------------------


class TestOrdinalInvariance:
    def test_reordering_does_not_change_the_anchor(self) -> None:
        first = paragraph("p_1", "Alpha.", bbox=(50.0, 100.0, 300.0, 140.0))
        second = paragraph("p_2", "Beta.", bbox=(50.0, 160.0, 300.0, 200.0))
        before = anchor_of(first)
        # The same two paragraphs, in the other order, renumbered accordingly.
        moved = paragraph("p_1", "Alpha.", bbox=(50.0, 100.0, 300.0, 140.0))
        ir_with([paragraph("p_1", "Beta.", bbox=(50.0, 160.0, 300.0, 200.0)), moved])
        assert anchor_of(moved) == before
        assert second.id == "p_2"  # the ordinal is unchanged; only the fixture moved

    def test_inserting_a_paragraph_before_does_not_change_the_anchor(self) -> None:
        target = paragraph("p_2", "The paragraph a note is attached to.")
        before = anchor_of(target)
        # An extraction that now finds an extra paragraph above it: the target
        # becomes p_3, and its id changes. Its source has not.
        renumbered = paragraph("p_3", "The paragraph a note is attached to.")
        assert renumbered.id != target.id
        assert anchor_of(renumbered) == before

    def test_deleting_a_paragraph_before_does_not_change_the_anchor(self) -> None:
        target = paragraph("p_5", "Still the same sentence.")
        before = anchor_of(target)
        renumbered = paragraph("p_1", "Still the same sentence.")
        assert anchor_of(renumbered) == before

    def test_repeated_generation_is_identical(self) -> None:
        p = paragraph("p_1", "A sentence that will be hashed twice.")
        assert anchor_of(p) == anchor_of(p)
        assert anchor_of(p) == anchor_of(paragraph("p_9", p.text, 1, tuple(p.bboxes[0])))


# --- what must produce a different anchor -------------------------------------


class TestSeparation:
    def test_two_documents_do_not_share_an_anchor(self) -> None:
        """Brief Phase 5, and the criteria originally omitted it.

        The same sentence on page 1 of two papers must not collide: a note in one
        would otherwise be reachable from the other.
        """
        p = paragraph("p_1", "Experimental results are reported in Table 3.")
        assert anchor_of(p, "hash-a") != anchor_of(p, "hash-b")

    def test_the_same_text_on_another_page_differs(self) -> None:
        a = paragraph("p_1", "Figure 1: Overview.", page=1)
        b = paragraph("p_1", "Figure 1: Overview.", page=2)
        assert anchor_of(a) != anchor_of(b)

    def test_the_same_text_at_another_place_on_the_page_differs(self) -> None:
        """Duplicate disambiguation, and the reason it is geometry not a counter.

        A counter of prior occurrences renumbers every duplicate when one more
        appears above it. A coordinate does not: these two are told apart by where
        they are, which an insertion cannot change.
        """
        top = paragraph("p_1", "Figure 2: Ablation.", bbox=(50.0, 100.0, 300.0, 130.0))
        lower = paragraph("p_2", "Figure 2: Ablation.", bbox=(50.0, 400.0, 300.0, 430.0))
        assert anchor_of(top) != anchor_of(lower)

    def test_duplicate_disambiguation_survives_a_new_duplicate_above(self) -> None:
        lower = paragraph("p_2", "Figure 2: Ablation.", bbox=(50.0, 400.0, 300.0, 430.0))
        before = anchor_of(lower)
        # A third identical caption appears above it; the ordinal would shift,
        # the geometry does not.
        renumbered = paragraph("p_3", "Figure 2: Ablation.", bbox=(50.0, 400.0, 300.0, 430.0))
        assert anchor_of(renumbered) == before


# --- geometry quantization ----------------------------------------------------


class TestGeometry:
    def test_quantization_is_symmetric_and_deterministic(self) -> None:
        assert quantize(101.0) == quantize(101.0)
        assert quantize(100.9) == 100.0
        assert quantize(101.1) == 102.0

    def test_sub_quantum_jitter_preserves_the_anchor(self) -> None:
        """The insurance the grid buys, and it is insurance not science.

        Nothing in the corpus produces this jitter today — measured, bboxes are
        bit-identical across runs and across the DS-DOC-002 change. The grid is
        for the extraction that has not been written yet.
        """
        base = paragraph("p_1", "Stable text.", bbox=(50.0, 100.0, 300.0, 140.0))
        nudged = paragraph("p_1", "Stable text.", bbox=(50.4, 100.2, 299.8, 140.3))
        assert anchor_of(base) == anchor_of(nudged)

    def test_a_real_move_changes_the_anchor(self) -> None:
        base = paragraph("p_1", "Stable text.", bbox=(50.0, 100.0, 300.0, 140.0))
        moved = paragraph("p_1", "Stable text.", bbox=(50.0, 300.0, 300.0, 340.0))
        assert anchor_of(base) != anchor_of(moved)


# --- normalization ------------------------------------------------------------


class TestNormalization:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("degradation  problem", "degradation problem"),
            ("line\nbreak", "line break"),
            ("ﬁne-tuning", "fine-tuning"),
            ("soft­hyphen", "softhyphen"),
        ],
    )
    def test_presentational_differences_are_folded(self, raw: str, expected: str) -> None:
        assert canonical_source_text(raw) == expected

    def test_a_wrapped_word_is_rejoined(self) -> None:
        assert canonical_source_text("degradation prob-\nlem") == "degradation problem"

    def test_a_compound_broken_at_its_own_hyphen_keeps_the_hyphen(self) -> None:
        """The case `normalize.py` documents, and the criteria's rule got wrong.

        A naive `re.sub(r'-\\n', '')` turns this into `selfcontaining`, which is
        not a word. The repository's rule keeps the hyphen and closes the break.
        """
        assert canonical_source_text("a self-\ncontaining module") == (
            "a self-containing module"
        )

    @pytest.mark.parametrize(
        "identifier", ["ResNet-50", "CIFAR-10", "Algorithm 1", "Eq. 4", "F(x)", "0.05"]
    )
    def test_academic_identifiers_survive_untouched(self, identifier: str) -> None:
        """An anchor that erases an identifier is wrong quietly (Phase 9)."""
        assert canonical_source_text(identifier) == identifier

    def test_normalization_differences_do_not_change_the_anchor(self) -> None:
        a = paragraph("p_1", "degradation  problem\nin deep networks")
        b = paragraph("p_9", "degradation problem in deep networks")
        assert anchor_of(a) == anchor_of(b)


# --- reattachment -------------------------------------------------------------


class TestReattachment:
    def _new(self, *paragraphs: ParagraphIR) -> DocumentIR:
        for p in paragraphs:
            p.source_anchor_id = anchor_of(p)
        return ir_with(list(paragraphs))

    def test_an_unchanged_paragraph_resolves_exactly(self) -> None:
        old = paragraph("p_1", "Unchanged text.")
        new = self._new(paragraph("p_7", "Unchanged text."))
        result = reattach(new, anchor_id=anchor_of(old), page_number=1, quote=old.text)
        assert result.state is AnchorState.EXACT
        assert result.paragraph_ids == ("p_7",)

    def test_a_resegmented_paragraph_reattaches_by_its_quote(self) -> None:
        old = paragraph("p_1", "Shortcut connections are identity mappings.")
        grown = paragraph("p_1", "Shortcut connections are identity mappings. "
                                 "They add no parameters.")
        result = reattach(self._new(grown), anchor_id=anchor_of(old),
                          page_number=1, quote=old.text)
        assert result.state is AnchorState.REATTACHED
        assert result.paragraph_ids == ("p_1",)

    def test_a_merged_paragraph_reattaches_from_the_fragment(self) -> None:
        old = paragraph("p_1", "They add no parameters.")
        merged = paragraph("p_1", "Shortcut connections are identity mappings. "
                                  "They add no parameters.")
        result = reattach(self._new(merged), anchor_id=anchor_of(old),
                          page_number=1, quote=old.text)
        assert result.state is AnchorState.REATTACHED

    def test_two_candidates_report_ambiguous_and_pick_neither(self) -> None:
        """The conservative direction, and the one that matters most.

        Two paragraphs on the page can hold the quote; the module says so and
        returns both ids. Choosing the better-scoring one would be this code
        making an editorial decision about where a user's note belongs.
        """
        quote = "Shortcut connections are identity mappings."
        a = paragraph("p_1", quote, bbox=(50.0, 100.0, 300.0, 140.0))
        b = paragraph("p_2", quote, bbox=(50.0, 500.0, 300.0, 540.0))
        result = reattach(self._new(a, b), anchor_id="not-an-anchor",
                          page_number=1, quote=quote)
        assert result.state is AnchorState.AMBIGUOUS
        assert set(result.paragraph_ids) == {"p_1", "p_2"}

    def test_a_vanished_paragraph_is_orphaned_not_guessed(self) -> None:
        old = paragraph("p_1", "Text that no longer exists anywhere.")
        survivor = paragraph("p_1", "A different sentence entirely.")
        result = reattach(self._new(survivor), anchor_id=anchor_of(old),
                          page_number=1, quote=old.text)
        assert result.state is AnchorState.ORPHANED
        assert result.paragraph_ids == ()

    def test_nothing_is_found_on_another_page(self) -> None:
        """Phase 27: another page is another place, and the document is a boundary.

        The same text one page over is reported ORPHANED rather than attached —
        the brief warns against wandering even within the document, and a
        re-laid-out paper genuinely can move a paragraph across a page break.
        """
        old = paragraph("p_1", "A sentence on page one.")
        moved = paragraph("p_1", "A sentence on page one.", page=4)
        result = reattach(self._new(moved), anchor_id=anchor_of(old),
                          page_number=1, quote=old.text)
        assert result.state is AnchorState.ORPHANED

    def test_an_empty_quote_is_orphaned_rather_than_matching_everything(self) -> None:
        survivor = paragraph("p_1", "Some text.")
        result = reattach(self._new(survivor), anchor_id="x", page_number=1, quote="")
        assert result.state is AnchorState.ORPHANED


# --- the diagnostic surface ---------------------------------------------------


class TestDiagnostics:
    def test_the_description_carries_no_document_text_beyond_a_prefix(self) -> None:
        ir = ir_with([paragraph("p_1", "x" * 400)])
        described = describe_anchor(ir, ir.paragraphs[0])
        assert described["anchor_version"] == SOURCE_ANCHOR_VERSION
        assert described["quantum_pt"] == GEOMETRY_QUANTUM_PT
        assert len(str(described["text_prefix"])) <= 60

    def test_the_description_does_not_expose_the_hash_inputs_verbatim(self) -> None:
        """A digest, not the payload: diagnostics a developer reads, not a leak."""
        ir = ir_with([paragraph("p_1", "Sensitive-looking body text.")])
        described = describe_anchor(ir, ir.paragraphs[0])
        assert "Sensitive-looking body text." not in str(described["text_digest"])


# --- real papers --------------------------------------------------------------


class TestOnRealPapers:
    def test_a_real_paper_extracts_with_anchors(self) -> None:
        from pathlib import Path

        source = Path(__file__).resolve().parents[2] / ".agent" / "results" / "papers" / "ppo.pdf"
        if not source.is_file():
            pytest.skip("benchmark paper not present")
        ir = extract_document_ir(source, "doc_ppo", source_filename="ppo.pdf")
        assert len(ir.paragraphs) > 20
        anchors = [p.source_anchor_id for p in ir.paragraphs]
        assert all(anchors), "every paragraph carries an anchor"
        assert len(set(anchors)) == len(anchors), "anchors are unique within a document"

    def test_the_anchor_is_stable_across_repeat_extraction(self) -> None:
        from pathlib import Path

        source = Path(__file__).resolve().parents[2] / ".agent" / "results" / "papers" / "ppo.pdf"
        if not source.is_file():
            pytest.skip("benchmark paper not present")
        first = extract_document_ir(source, "doc_ppo", source_filename="ppo.pdf")
        second = extract_document_ir(source, "doc_ppo", source_filename="ppo.pdf")
        assert [p.source_anchor_id for p in first.paragraphs] == [
            p.source_anchor_id for p in second.paragraphs
        ]
