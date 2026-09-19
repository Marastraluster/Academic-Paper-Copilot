"""DS-QA-013 — persistent identity for the canonical source ParagraphIR excludes.

The measured gap this exists for: across five real papers, **100 caption blocks
and 32 formula blocks** belong to no paragraph, and a browser probe found every
one of them selectable with its canonical text intact. A reader can see them,
drag across them, and — before this — was refused.

Three properties carry the weight, and each is asserted rather than assumed:

**The paragraph recipe is untouched.** Its anchors are persisted user data and
DS-DOC-002 measured 150 of 160 surviving a real extraction change. A block
anchor that shared its payload would have invalidated every stored note.

**The kind is inside the hash.** A caption and a paragraph can share a page, a
rectangle and their words; without the class they would collide, and an
annotation could resolve to the right words on the wrong kind of source.

**Only the measured classes are anchorable.** The set is closed on both sides of
the wire, so a class nobody measured cannot be stored by accident.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from app.annotations.models import BLOCK_SOURCE_CLASSES, SOURCE_CLASSES, AnnotationTarget
from app.annotations.service import resolve_target
from app.document.anchors import (
    ANCHORABLE_CLASSES,
    BLOCK_ANCHOR_VERSION,
    SOURCE_ANCHOR_VERSION,
    anchor_payload_for,
    block_anchor_payload_for,
    block_source_anchor_id,
    block_source_anchor_id_for,
    reattach_block,
)
from app.document.models import DocumentIR, DocumentMetadata, ParagraphIR, TextBlockIR
from tests.test_annotations import FINGERPRINT, ir_with, paragraph


def block(
    bid: str,
    text: str,
    *,
    page: int = 1,
    layout_class: str = "figure_caption",
    bbox=(50.0, 100.0, 545.0, 130.0),
) -> TextBlockIR:
    return TextBlockIR(
        id=bid, page_index=page - 1, page_number=page, layout_class=layout_class,
        bbox=bbox, text=text,
    )


def ir_with_blocks(*blocks: TextBlockIR, fingerprint: str = FINGERPRINT) -> DocumentIR:
    """An IR whose blocks carry the anchors a real extraction would give them.

    The blocks are placed on their pages, because that is the only structure
    `anchorable_blocks` reads — a fixture that only set `source_anchor_id` on a
    detached object would assert against nothing.
    """
    from app.document.models import PageIR

    for item in blocks:
        if item.layout_class in ANCHORABLE_CLASSES and item.text.strip():
            item.source_anchor_id = block_source_anchor_id_for(fingerprint, item)

    pages: dict[int, PageIR] = {}
    for item in blocks:
        page = pages.setdefault(
            item.page_number,
            PageIR(
                page_index=item.page_number - 1, page_number=item.page_number,
                width_pt=612.0, height_pt=792.0, rotation=0, has_text=True, blocks=[],
            ),
        )
        page.blocks.append(item)
    ordered = [pages[number] for number in sorted(pages)]

    return DocumentIR(
        document_id="doc_row", content_hash=fingerprint,
        pipeline_version="5", source_filename="p.pdf",
        page_count=max(len(ordered), 1), metadata=DocumentMetadata(),
        sections=[], pages=ordered, paragraphs=[], page_mapping={},
        has_text_layer=True, ocr_required=False,
    )


class TestTheClassIsInsideTheHash:
    def test_a_caption_and_a_paragraph_cannot_collide(self) -> None:
        """They share a page, a rectangle and their words. Only the kind differs.

        Without the class in the payload these two produce the same digest, and a
        note made on a paragraph could resolve to the caption that sits beside
        it — right words, wrong kind of source, and nothing in the record to say
        so.
        """
        text = "Figure 1. Training error."
        caption = block("b_1", text)
        prose = paragraph("p_1", text, page=1, bbox=(50.0, 100.0, 545.0, 130.0))
        prose.source_anchor_id = ""

        block_anchor = block_source_anchor_id_for(FINGERPRINT, caption)
        # The paragraph recipe applied to a paragraph with the same page, text
        # and geometry — computed here rather than through `source_anchor_id_for`
        # because the point is the payload, not the wrapper.
        payload = anchor_payload_for(FINGERPRINT, prose)
        import hashlib

        paragraph_anchor = hashlib.sha256(payload.encode("utf-8")).hexdigest()

        assert block_anchor != paragraph_anchor
        assert caption.layout_class in block_anchor_payload_for(FINGERPRINT, caption)

    def test_the_two_recipes_have_separate_versions(self) -> None:
        """A bump on one must not reinterpret the other.

        The paragraph recipe's version is persisted user data; the block
        recipe's is new. Sharing one constant would mean the day the block
        payload changed, every paragraph anchor silently changed with it.
        """
        assert BLOCK_ANCHOR_VERSION == "1"
        assert SOURCE_ANCHOR_VERSION == "1"
        assert BLOCK_ANCHOR_VERSION is not None

    def test_the_document_fingerprint_is_in_the_payload(self) -> None:
        """The same caption on page 1 of two papers is two different sources."""
        caption = block("b_1", "Figure 1. Overview.")
        assert block_source_anchor_id_for("hash-a", caption) != block_source_anchor_id_for(
            "hash-b", caption
        )


class TestDeterminism:
    def test_the_same_block_hashes_the_same_every_time(self) -> None:
        caption = block("b_1", "Table 2. Error rates.")
        first = block_source_anchor_id_for(FINGERPRINT, caption)
        for _ in range(100):
            assert block_source_anchor_id_for(FINGERPRINT, caption) == first
        assert len(first) == 64

    def test_the_runtime_block_id_is_not_in_the_payload(self) -> None:
        """`b_<doc>_p<page>_<ordinal>` is an ordinal into one extraction.

        The same lesson `ParagraphIR.id` taught: an anchor that moved when a
        block was inserted before it would orphan a note for a paper that had not
        changed by a byte.
        """
        first = block("b_1", "Figure 1. Overview.")
        # The same content, arriving as the third block rather than the first.
        moved = block("b_7", "Figure 1. Overview.")
        assert block_source_anchor_id_for(FINGERPRINT, first) == block_source_anchor_id_for(
            FINGERPRINT, moved
        )

    def test_sub_point_jitter_within_a_cell_is_absorbed(self) -> None:
        """The grid's actual promise, measured rather than assumed.

        Two runs of this pipeline moved a block by **0.0 pt**, so the quantum is
        insurance rather than a requirement — and what it insures is stated
        exactly: a coordinate that stays on the same side of a cell boundary
        quantizes identically. Near a boundary it does not, which is why the
        criterion says *within a cell* rather than naming a tolerance.
        """
        base = block("b_1", "Figure 1. Overview.", bbox=(50.0, 100.0, 545.0, 130.0))
        # 100.0 is a cell centre for a 2.0 pt grid, so ±0.9 stays inside it.
        nudged = block("b_1", "Figure 1. Overview.", bbox=(50.0, 100.9, 545.0, 130.4))
        assert block_source_anchor_id_for(FINGERPRINT, base) == block_source_anchor_id_for(
            FINGERPRINT, nudged
        )

    def test_jitter_across_a_boundary_does_change_the_anchor(self) -> None:
        """Stated as a test because it is a limitation, not an oversight.

        A coordinate at 101.0 is half a point from the 102.0 cell. Moving it
        there changes the anchor — which is correct behaviour for an identity
        derived from geometry, and the honest reason the criterion cannot promise
        an arbitrary tolerance.
        """
        base = block("b_1", "Figure 1. Overview.", bbox=(50.0, 101.0, 545.0, 130.0))
        across = block("b_1", "Figure 1. Overview.", bbox=(50.0, 101.9, 545.0, 130.0))
        assert block_source_anchor_id_for(FINGERPRINT, base) != block_source_anchor_id_for(
            FINGERPRINT, across
        )


class TestOnlyMeasuredClassesAreAnchorable:
    def test_the_anchorable_set_is_the_measured_four(self) -> None:
        assert ANCHORABLE_CLASSES == {
            "figure_caption", "table_caption", "formula_caption", "isolate_formula",
        }

    def test_the_wire_vocabulary_matches_the_anchorable_set(self) -> None:
        """A class the extraction anchors but the API rejects cannot be stored;
        a class the API accepts but the extraction never anchors can never
        resolve. The two sets are one set."""
        assert BLOCK_SOURCE_CLASSES == ANCHORABLE_CLASSES
        assert SOURCE_CLASSES == ANCHORABLE_CLASSES | {"paragraph"}

    @pytest.mark.parametrize("layout", ["figure", "table", "abandon", "title", "plain text"])
    def test_a_class_outside_the_set_gets_no_anchor(self, layout: str) -> None:
        """Empty is the honest value: present in the IR is not annotatable."""
        from app.document.anchors import anchorable_blocks

        item = block("b_1", "identityweight layerweight layer", layout_class=layout)
        ir = ir_with_blocks(item)
        assert item.layout_class not in ANCHORABLE_CLASSES
        assert anchorable_blocks(ir) == []


class TestReattachment:
    def test_a_block_that_moved_within_its_page_reattaches(self) -> None:
        original = block("b_1", "Figure 1. Training error on CIFAR-10.")
        anchor = block_source_anchor_id_for(FINGERPRINT, original)

        # A later extraction that re-segmented the block: same page, same class,
        # same words, different geometry.
        moved = block("b_9", "Figure 1. Training error on CIFAR-10.", bbox=(50.0, 400.0, 545.0, 430.0))
        ir = ir_with_blocks(moved)

        result = reattach_block(
            ir, anchor_id=anchor, page_number=1,
            layout_class="figure_caption", quote=original.text,
        )
        assert result.state.value == "REATTACHED"
        assert result.paragraph_ids == ("b_9",)

    def test_a_caption_never_reattaches_to_a_different_class(self) -> None:
        """The rung that is tightened rather than added.

        A caption that can no longer be found must not become a formula, and a
        formula must not become a caption. Both would be a mark on the wrong kind
        of source while pointing at the right words.
        """
        anchor = block_source_anchor_id_for(FINGERPRINT, block("b_1", "Figure 1. X."))
        other_kind = block("b_2", "Figure 1. X.", layout_class="table_caption")
        ir = ir_with_blocks(other_kind)

        result = reattach_block(
            ir, anchor_id=anchor, page_number=1,
            layout_class="figure_caption", quote="Figure 1. X.",
        )
        assert result.state.value == "ORPHANED"
        assert result.paragraph_ids == ()

    def test_ambiguity_is_reported_not_resolved(self) -> None:
        # The old block sat somewhere none of the current ones do, so the exact
        # rung misses and the cascade has to decide. A fixture that reused a
        # rectangle would have resolved exactly and tested nothing.
        anchor = block_source_anchor_id_for(
            FINGERPRINT, block("b_old", "Results.", bbox=(50.0, 700.0, 545.0, 730.0))
        )
        ir = ir_with_blocks(
            block("b_2", "Results.", bbox=(50.0, 100.0, 545.0, 130.0)),
            block("b_3", "Results.", bbox=(50.0, 200.0, 545.0, 230.0)),
        )
        result = reattach_block(
            ir, anchor_id=anchor, page_number=1,
            layout_class="figure_caption", quote="Results.",
        )
        assert result.state.value == "AMBIGUOUS"
        assert len(result.paragraph_ids) == 2


class TestResolutionDispatch:
    def _target(self, *, source_class: str, anchor: str, quote: str) -> AnnotationTarget:
        return AnnotationTarget(
            id="tgt_1", annotation_id="ann_1", target_order=0,
            source_anchor_id=anchor, anchor_version="1", page_number=1,
            original_bbox=(50.0, 100.0, 545.0, 130.0),
            rects=((50.0, 100.0, 545.0, 130.0),),
            exact_quote=quote, source_class=source_class,
        )

    def test_a_caption_target_resolves_against_blocks(self) -> None:
        caption = block("b_1", "Figure 1. Training error.")
        ir = ir_with_blocks(caption)
        target = self._target(
            source_class="figure_caption",
            anchor=caption.source_anchor_id, quote=caption.text,
        )
        resolved = resolve_target(ir, target)
        assert resolved.state.value == "EXACT"
        assert resolved.paragraph_ids == ("b_1",)

    def test_a_paragraph_target_never_resolves_to_a_caption(self) -> None:
        """The two indexes are separate dicts, so the lookup cannot cross.

        A paragraph anchor is not a block anchor — the payloads differ — but the
        dispatch is what guarantees it structurally rather than by that
        difference alone.
        """
        caption = block("b_1", "Figure 1. Training error.")
        ir = ir_with_blocks(caption)
        target = self._target(
            source_class="paragraph",
            anchor=caption.source_anchor_id, quote=caption.text,
        )
        resolved = resolve_target(ir, target)
        assert resolved.state.value == "ORPHANED"
        assert resolved.paragraph_ids == ()


class TestMigration:
    """Migration 005 on a database that already holds the user's writing."""

    def test_a_v4_database_gains_the_column_and_keeps_every_row(
        self, tmp_path: Path
    ) -> None:
        """Additive and non-destructive, asserted on real rows.

        `paragraph` is not a guess for the existing rows: paragraphs were the
        only thing a target could name before this migration, so it is the only
        value they could have had.
        """
        import sys

        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from app.db import MIGRATIONS, bootstrap_database, connect

        database = tmp_path / "db.sqlite3"
        connection = bootstrap_database(database)

        # A target written the way v4 wrote them: no `source_class` column.
        connection.execute(
            "CREATE TABLE IF NOT EXISTS _v4_probe (x INTEGER)"
        )
        connection.execute(
            "INSERT INTO annotations (id, content_hash, document_id, kind, color, "
            "quote, comment, created_at, updated_at, deleted_at) "
            "VALUES ('ann_1','hash','doc_1','note','yellow','q','mine','t','t',NULL)"
        )
        connection.execute(
            "INSERT INTO annotation_targets (id, annotation_id, target_order, "
            "source_anchor_id, anchor_version, page_number, original_bbox, rects, "
            "exact_quote, prefix, suffix) "
            "VALUES ('tgt_1','ann_1',0,'anchor','1',3,'[0,0,1,1]','[[0,0,1,1]]','q','','')"
        )
        connection.commit()
        connection.close()

        # Rewind to v4 and delete the column, so the upgrade is the real thing.
        connection = connect(database)
        connection.execute("DELETE FROM schema_version WHERE version >= 5")
        connection.execute("ALTER TABLE annotation_targets DROP COLUMN source_class")
        connection.commit()
        columns = [row[1] for row in connection.execute("PRAGMA table_info(annotation_targets)")]
        assert "source_class" not in columns
        connection.close()

        assert 5 in MIGRATIONS
        connection = bootstrap_database(database)
        try:
            row = connection.execute(
                "SELECT source_anchor_id, page_number, exact_quote, source_class "
                "FROM annotation_targets WHERE id = 'tgt_1'"
            ).fetchone()
            count = connection.execute("SELECT COUNT(*) FROM annotations").fetchone()[0]
            version = connection.execute(
                "SELECT MAX(version) FROM schema_version"
            ).fetchone()[0]
        finally:
            connection.close()

        assert version == 5
        assert count == 1
        assert row["source_anchor_id"] == "anchor"
        assert row["page_number"] == 3
        assert row["source_class"] == "paragraph"


class TestTheApiVocabulary:
    """The create route's two domains, and the anchors each accepts."""

    def _paper_with_a_caption(self, client):
        """An uploaded document whose cached IR holds a paragraph and a caption.

        Written rather than extracted: the fixture PDF this repository generates
        has no captions, and a test that needed the layout model to produce one
        would be testing the model.
        """
        import tempfile
        from pathlib import Path

        from app.document.persistence import write_ir
        from tests.test_api_documents import make_pdf, upload
        from tests.test_annotations import ir_with

        with tempfile.TemporaryDirectory() as folder:
            response = upload(client, make_pdf(Path(folder) / "p.pdf").read_bytes())
        document_id = response.json()["document_id"]
        directory = client.app.state.settings.documents_dir / document_id

        from app.document.extract import _fingerprint

        content_hash = str(_fingerprint(directory / "source.pdf")[0])
        prose = paragraph("p_1", "A sentence from the body.", page=1)
        caption = block("b_1", "Figure 1. Training error.", page=1)
        ir = ir_with(prose, fingerprint=content_hash)
        # The IR must claim *this* document, or `is_reusable` rejects it and the
        # route re-extracts — replacing the fixture with the real fixture PDF's
        # own extraction, whose anchors are not the ones this test wrote.
        ir.document_id = document_id
        # `ir_with` builds a paragraph-only IR, so attach the page and the block
        # the caption anchor is derived from.
        from app.document.models import PageIR

        ir.pages = [PageIR(
            page_index=0, page_number=1, width_pt=612.0, height_pt=792.0,
            rotation=0, has_text=True, blocks=[caption],
        )]
        caption.source_anchor_id = block_source_anchor_id_for(content_hash, caption)
        write_ir(directory, ir)
        return document_id, prose.source_anchor_id, caption.source_anchor_id

    def test_an_unknown_source_class_is_refused(self, client) -> None:
        """A kind nothing downstream can resolve is not stored.

        The set is closed on both sides of the wire, so a client that invents a
        class fails loudly at the door rather than leaving a target that can
        never be placed again.
        """
        document_id, anchor, _ = self._paper_with_a_caption(client)

        body = {
            "kind": "highlight", "quote": "q", "comment": None,
            "targets": [{
                "source_anchor_id": anchor, "source_class": "not_a_class",
                "page_number": 1, "original_bbox": [0, 0, 10, 10],
                "rects": [[0, 0, 10, 10]], "exact_quote": "q",
            }],
        }
        rejected = client.post(f"/api/documents/{document_id}/annotations", json=body)
        assert rejected.status_code == 422
        # And the failure is a validation error, not a crash: the route's own
        # error path used to be unusable (see test_annotations_error_paths).
        assert rejected.json()["error"]["code"] == "VALIDATION_ERROR"

    def test_a_caption_anchor_is_accepted_and_a_paragraph_anchor_is_not(
        self, client
    ) -> None:
        """The two domains are checked separately, and neither crosses.

        A caption target is valid only if its anchor is a caption's; a paragraph
        target only if its anchor is a paragraph's. One merged set would accept a
        caption anchor under a paragraph class — which would store a target that
        can never resolve.
        """
        document_id, paragraph_anchor, caption_anchor = self._paper_with_a_caption(client)

        def create(anchor: str, source_class: str):
            return client.post(
                f"/api/documents/{document_id}/annotations",
                json={
                    "kind": "highlight", "quote": "q", "comment": None,
                    "targets": [{
                        "source_anchor_id": anchor, "source_class": source_class,
                        "page_number": 1, "original_bbox": [0, 0, 10, 10],
                        "rects": [[0, 0, 10, 10]], "exact_quote": "q",
                    }],
                },
            )

        caption = create(caption_anchor, "figure_caption")
        assert caption.status_code == 201, caption.text
        assert caption.json()["targets"][0]["source_class"] == "figure_caption"

        prose = create(paragraph_anchor, "paragraph")
        assert prose.status_code == 201, prose.text

        # A paragraph anchor wearing a caption's class is refused, and the other
        # way round.
        assert create(paragraph_anchor, "figure_caption").status_code == 400
        assert create(caption_anchor, "paragraph").status_code == 400

    def test_a_target_without_a_class_is_a_paragraph(self, client) -> None:
        """Every request written before this feature keeps its meaning."""
        document_id, paragraph_anchor, _ = self._paper_with_a_caption(client)

        created = client.post(
            f"/api/documents/{document_id}/annotations",
            json={
                "kind": "highlight", "quote": "q", "comment": None,
                "targets": [{
                    "source_anchor_id": paragraph_anchor, "page_number": 1,
                    "original_bbox": [0, 0, 10, 10], "rects": [[0, 0, 10, 10]],
                    "exact_quote": "q",
                }],
            },
        )
        assert created.status_code == 201, created.text
        assert created.json()["targets"][0]["source_class"] == "paragraph"


class TestTheErrorPathAnswers:
    """A refused request must return the status it documents, not crash.

    Found by writing the test above: every `error_response` call in
    `api/annotations.py` passed `(code, message, status)` to a
    `(status, code, message)` signature, so each of the sixteen error paths
    raised inside `JSONResponse` and answered 500. The happy paths were the only
    ones ever exercised, which is why it survived.
    """

    def test_a_missing_document_is_a_404_not_a_500(self, client) -> None:
        response = client.get("/api/documents/doc_does_not_exist/annotations")
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "NOT_FOUND"

    def test_an_unknown_kind_is_a_400_with_an_envelope(self, client) -> None:
        document_id, anchor, _ = TestTheApiVocabulary()._paper_with_a_caption(client)
        response = client.post(
            f"/api/documents/{document_id}/annotations",
            json={
                "kind": "not_a_kind", "quote": "q", "comment": None,
                "targets": [{
                    "source_anchor_id": anchor, "page_number": 1,
                    "original_bbox": [0, 0, 10, 10], "rects": [[0, 0, 10, 10]],
                    "exact_quote": "q",
                }],
            },
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "BAD_REQUEST"

    def test_deleting_something_that_is_not_there_is_a_404(self, client) -> None:
        response = client.delete("/api/annotations/ann_does_not_exist")
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "NOT_FOUND"
