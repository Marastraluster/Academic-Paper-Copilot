"""DS-QA-010 — persistent annotations, and the promises they must not break.

Two things make this suite different from the others in this repository.

**The data is the user's.** Everything else the application stores is derived
from a PDF and can be rebuilt; a note cannot. So the tests that matter most are
the ones about *not losing it*: across a migration, across a document removal,
across an extraction change, and across a restart.

**Identity is two-layered.** A target keeps the anchor the user's selection
produced, and resolution writes a current paragraph beside it. Every test that
moves the second must show the first did not move.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from app.annotations.models import AnnotationTarget
from app.annotations.service import resolve_annotation, resolve_target, summary
from app.annotations.store import AnnotationStore
from app.db import bootstrap_database
from app.document.anchors import AnchorState, source_anchor_id
from app.document.models import (
    DocumentIR,
    DocumentMetadata,
    ParagraphIR,
)
from app.document.extract import IR_PIPELINE_VERSION

FINGERPRINT = "sha-of-the-pdf"


def paragraph(
    pid: str, text: str, page: int = 1, bbox=(50.0, 100.0, 300.0, 140.0)
) -> ParagraphIR:
    p = ParagraphIR(
        id=pid, section_id=None, text=text, page_number=page,
        page_range=(page, page), block_ids=[f"b_{pid}"], bboxes=[bbox],
    )
    return p


def ir_with(*paragraphs: ParagraphIR, fingerprint: str = FINGERPRINT) -> DocumentIR:
    """An IR whose paragraphs carry the anchors a real extraction would give them."""
    for p in paragraphs:
        p.source_anchor_id = source_anchor_id_for(p, fingerprint)
    return DocumentIR(
        document_id="doc_row", content_hash=fingerprint,
        pipeline_version=IR_PIPELINE_VERSION, source_filename="p.pdf",
        page_count=1, metadata=DocumentMetadata(), sections=[], pages=[],
        paragraphs=list(paragraphs),
        page_mapping={p.id: p.page_number for p in paragraphs},
        has_text_layer=True, ocr_required=False,
    )


def source_anchor_id_for(p: ParagraphIR, fingerprint: str) -> str:
    from app.document.anchors import source_anchor_id_for as make

    return make(fingerprint, p)


def target_for(p: ParagraphIR, fingerprint: str = FINGERPRINT, **over) -> dict:
    anchor = source_anchor_id_for(p, fingerprint)
    payload = {
        "source_anchor_id": anchor,
        "anchor_version": "1",
        "page_number": p.page_number,
        "original_bbox": p.bboxes[0],
        "rects": [p.bboxes[0]],
        "exact_quote": p.text,
        "prefix": "",
        "suffix": "",
    }
    payload.update(over)
    return payload


@pytest.fixture
def store(tmp_path: Path) -> AnnotationStore:
    return AnnotationStore(bootstrap_database(tmp_path / "db.sqlite3"))


# --- migration ----------------------------------------------------------------


class TestMigration:
    def test_a_v3_database_migrates_without_losing_rows(self, tmp_path: Path) -> None:
        """The whole point of a migration: the old data is still there after it.

        Built here as a v3 database — profiles, documents, translation_tasks and
        no annotation tables — then upgraded by the normal bootstrap path.
        """
        path = tmp_path / "old.sqlite3"
        old = sqlite3.connect(path)
        old.executescript(
            """
            CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
            CREATE TABLE profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL);
            CREATE TABLE documents (id TEXT PRIMARY KEY, name TEXT NOT NULL);
            CREATE TABLE translation_tasks (id TEXT PRIMARY KEY, document_id TEXT NOT NULL);
            INSERT INTO schema_version VALUES (3, '2026-01-01T00:00:00+00:00');
            INSERT INTO profiles VALUES ('p1', 'My Provider');
            INSERT INTO documents VALUES ('d1', 'A Paper');
            INSERT INTO translation_tasks VALUES ('t1', 'd1');
            """
        )
        old.commit()
        old.close()

        connection = bootstrap_database(path)
        try:
            assert connection.execute(
                "SELECT COUNT(*) FROM profiles"
            ).fetchone()[0] == 1
            assert connection.execute(
                "SELECT COUNT(*) FROM documents"
            ).fetchone()[0] == 1
            assert connection.execute(
                "SELECT COUNT(*) FROM translation_tasks"
            ).fetchone()[0] == 1
            tables = {
                row[0] for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
            assert {"annotations", "annotation_targets"} <= tables
        finally:
            connection.close()

    def test_bootstrap_is_idempotent(self, tmp_path: Path) -> None:
        path = tmp_path / "db.sqlite3"
        bootstrap_database(path).close()
        connection = bootstrap_database(path)
        try:
            assert connection.execute(
                "SELECT COUNT(*) FROM annotations"
            ).fetchone()[0] == 0
        finally:
            connection.close()


# --- creating -----------------------------------------------------------------


class TestCreation:
    def test_a_highlight_is_stored_with_its_targets(self, store: AnnotationStore) -> None:
        p = paragraph("p_1", "Shortcut connections are identity mappings.")
        created = store.create(
            content_hash=FINGERPRINT, document_id="doc_row", kind="highlight",
            quote=p.text, comment=None, targets=[target_for(p)],
        )
        assert created.kind == "highlight"
        assert created.comment is None
        assert len(created.targets) == 1
        assert created.targets[0].exact_quote == p.text

    def test_a_multi_paragraph_selection_is_one_annotation_with_many_targets(
        self, store: AnnotationStore
    ) -> None:
        """Decision A, and the reason it is the right shape.

        Three paragraphs the user dragged across are one thought. Splitting them
        into three annotations would put three entries in the panel for one
        selection and three things to delete.
        """
        a = paragraph("p_1", "First paragraph.", bbox=(50.0, 100.0, 300.0, 140.0))
        b = paragraph("p_2", "Second paragraph.", bbox=(50.0, 160.0, 300.0, 200.0))
        c = paragraph("p_3", "Third paragraph.", bbox=(50.0, 220.0, 300.0, 260.0))
        created = store.create(
            content_hash=FINGERPRINT, document_id="doc_row", kind="note",
            quote="First paragraph. Second paragraph. Third paragraph.",
            comment="The overview I keep coming back to.",
            targets=[target_for(a), target_for(b), target_for(c)],
        )
        assert len(created.targets) == 1 + 2
        assert [t.target_order for t in created.targets] == [0, 1, 2]
        assert [t.exact_quote for t in created.targets] == [
            "First paragraph.", "Second paragraph.", "Third paragraph."
        ]

    def test_an_annotation_without_targets_is_refused(self, store: AnnotationStore) -> None:
        with pytest.raises(ValueError):
            store.create(
                content_hash=FINGERPRINT, document_id="doc_row", kind="highlight",
                quote="x", comment=None, targets=[],
            )

    def test_a_failed_target_write_leaves_no_annotation(
        self, store: AnnotationStore
    ) -> None:
        """Atomicity, asserted rather than assumed.

        A half-written annotation would list in the panel, resolve to nothing and
        look to the user like their note had been corrupted — worse than a save
        that visibly failed.
        """
        p = paragraph("p_1", "Some text.")
        bad = target_for(p)
        del bad["exact_quote"]  # the insert will raise
        with pytest.raises(Exception):
            store.create(
                content_hash=FINGERPRINT, document_id="doc_row", kind="highlight",
                quote=p.text, comment=None, targets=[target_for(p), bad],
            )
        assert store.list_for_document("doc_row") == []

    def test_the_same_selection_twice_is_two_annotations(
        self, store: AnnotationStore
    ) -> None:
        """A user may mark the same sentence twice, and both are theirs.

        Deduplicating by quote would silently discard the second — and two
        identical sentences in one paper are exactly where an identity by content
        alone is wrong.
        """
        p = paragraph("p_1", "A sentence.")
        first = store.create(content_hash=FINGERPRINT, document_id="doc_row",
                             kind="highlight", quote=p.text, comment=None,
                             targets=[target_for(p)])
        second = store.create(content_hash=FINGERPRINT, document_id="doc_row",
                              kind="highlight", quote=p.text, comment=None,
                              targets=[target_for(p)])
        assert first.id != second.id
        assert len(store.list_for_document("doc_row")) == 2


# --- editing and deleting -----------------------------------------------------


class TestEditingAndDeleting:
    def test_editing_the_note_moves_no_target(self, store: AnnotationStore) -> None:
        p = paragraph("p_1", "Marked text.")
        created = store.create(content_hash=FINGERPRINT, document_id="doc_row",
                               kind="note", quote=p.text, comment="first",
                               targets=[target_for(p)])
        before = created.targets[0]
        updated = store.update_comment(created.id, "second")
        assert updated is not None and updated.comment == "second"
        after = updated.targets[0]
        assert after.source_anchor_id == before.source_anchor_id
        assert after.rects == before.rects
        assert updated.updated_at >= created.updated_at

    def test_deleting_is_soft_and_hides_from_the_default_list(
        self, store: AnnotationStore
    ) -> None:
        """User writing is not a cache; a mistaken delete should be recoverable."""
        p = paragraph("p_1", "Marked text.")
        created = store.create(content_hash=FINGERPRINT, document_id="doc_row",
                               kind="highlight", quote=p.text, comment=None,
                               targets=[target_for(p)])
        assert store.delete(created.id) is True
        assert store.list_for_document("doc_row") == []
        assert [a.id for a in store.list_for_document("doc_row", include_deleted=True)] == [
            created.id
        ]


# --- document boundaries ------------------------------------------------------


class TestDocumentBoundary:
    def test_annotations_are_scoped_to_the_document_being_read(
        self, store: AnnotationStore
    ) -> None:
        p = paragraph("p_1", "Text.")
        store.create(content_hash=FINGERPRINT, document_id="doc_a", kind="highlight",
                     quote=p.text, comment=None, targets=[target_for(p)])
        assert len(store.list_for_document("doc_a")) == 1
        assert store.list_for_document("doc_b") == []

    def test_the_same_text_in_another_pdf_is_a_different_source(self) -> None:
        """Brief Phase 5. The fingerprint is what makes the two incomparable."""
        p = paragraph("p_1", "Experimental results are reported in Table 3.")
        assert source_anchor_id_for(p, "hash-a") != source_anchor_id_for(p, "hash-b")

    def test_annotations_survive_the_document_record(self, store: AnnotationStore) -> None:
        """AC_CHANGE_REQUEST 1, and the reason the criterion was rewritten.

        Document ids are `uuid4().hex`, so a re-imported identical PDF gets a new
        row. Keying user data to that row — with a cascade — would destroy a note
        for a file that has not changed by a byte. Here the document is deleted
        outright and the annotation is still there, findable by its fingerprint.
        """
        p = paragraph("p_1", "A sentence worth keeping a note about.")
        created = store.create(content_hash=FINGERPRINT, document_id="doc_row",
                               kind="note", quote=p.text, comment="keep me",
                               targets=[target_for(p)])

        # The structural property the resolution chose: `annotations` has **no**
        # foreign key to `documents`, so no cascade can reach user data when a
        # record is removed. Asserted on the schema, not inferred from behaviour.
        connection = store._connection
        assert connection.execute("PRAGMA foreign_key_list(annotations)").fetchall() == []

        # Removing every document record — not merely this one — and the
        # annotation is untouched, because nothing in the schema can reach it.
        connection.execute("DELETE FROM documents")
        connection.commit()

        by_content = store.list_for_content(FINGERPRINT)
        assert [a.id for a in by_content] == [created.id]
        assert by_content[0].comment == "keep me"

    def test_a_reimport_of_the_same_pdf_finds_them_again(
        self, store: AnnotationStore
    ) -> None:
        p = paragraph("p_1", "Text that will be re-imported.")
        created = store.create(content_hash=FINGERPRINT, document_id="doc_old",
                               kind="highlight", quote=p.text, comment=None,
                               targets=[target_for(p)])
        # A second import: same bytes, new row, new id.
        assert len(store.list_for_content(FINGERPRINT)) == 1
        assert store.list_for_content(FINGERPRINT)[0].id == created.id
        assert store.list_for_document("doc_new") == []


# --- resolution ---------------------------------------------------------------


class TestResolution:
    def _seeded(self, store: AnnotationStore):
        p = paragraph("p_1", "Shortcut connections are identity mappings.")
        created = store.create(content_hash=FINGERPRINT, document_id="doc_row",
                               kind="highlight", quote=p.text, comment=None,
                               targets=[target_for(p)])
        return created, p

    def test_an_unchanged_paragraph_resolves_exactly(self, store: AnnotationStore) -> None:
        created, p = self._seeded(store)
        ir = ir_with(paragraph("p_9", p.text))
        resolved = resolve_target(ir, created.targets[0])
        assert resolved.state is AnchorState.EXACT
        assert resolved.paragraph_ids == ("p_9",)

    def test_a_resegmented_paragraph_reattaches_and_keeps_its_anchor(
        self, store: AnnotationStore
    ) -> None:
        """Hard Invariant 4, and the reason resolution is written beside not over.

        The target is recorded as REATTACHED and the paragraph id is filled in —
        but the anchor the user's selection produced is still there, so the *next*
        extraction change re-resolves from the original rather than from this
        result. A wrong reattachment cannot compound.
        """
        created, p = self._seeded(store)
        grown = paragraph("p_1", p.text + " They add no parameters.")
        ir = ir_with(grown)
        resolved = resolve_annotation(ir, created, store=store)[0]
        assert resolved.state is AnchorState.REATTACHED

        reread = store.get(created.id)
        assert reread is not None
        assert reread.targets[0].source_anchor_id == created.targets[0].source_anchor_id
        assert reread.targets[0].resolution_state is AnchorState.REATTACHED
        assert reread.targets[0].exact_quote == p.text

    def test_two_candidates_are_ambiguous_and_pick_neither(
        self, store: AnnotationStore
    ) -> None:
        created, p = self._seeded(store)
        # Neither candidate is the original — both have *moved*, so the exact
        # anchor misses and the quote is found twice. That is the situation
        # AMBIGUOUS exists for; a candidate identical to the original would
        # resolve EXACT first and settle the question.
        a = paragraph("p_1", p.text, bbox=(50.0, 300.0, 300.0, 340.0))
        b = paragraph("p_2", p.text, bbox=(50.0, 600.0, 300.0, 640.0))
        resolved = resolve_target(ir_with(a, b), created.targets[0])
        assert resolved.state is AnchorState.AMBIGUOUS
        assert resolved.navigable is False
        assert set(resolved.paragraph_ids) == {"p_1", "p_2"}

    def test_a_vanished_paragraph_is_orphaned_and_the_quote_survives(
        self, store: AnnotationStore
    ) -> None:
        created, _ = self._seeded(store)
        resolved = resolve_target(ir_with(paragraph("p_1", "Different text.")),
                                  created.targets[0])
        assert resolved.state is AnchorState.ORPHANED
        assert resolved.navigable is False
        # The geometry is the user's and is still there; only the association is
        # gone. The UI can still show where it was.
        assert resolved.target.rects
        assert resolved.target.exact_quote == "Shortcut connections are identity mappings."

    def test_resolution_never_crosses_a_document(self, store: AnnotationStore) -> None:
        created, p = self._seeded(store)
        other = ir_with(paragraph("p_1", p.text), fingerprint="a-different-pdf")
        resolved = resolve_target(other, created.targets[0])
        assert resolved.state is not AnchorState.EXACT

    def test_the_summary_carries_no_anchor_hash(self, store: AnnotationStore) -> None:
        """A user has no use for a digest, and it is not their data to read."""
        created, p = self._seeded(store)
        payload = summary(created, resolve_annotation(ir_with(paragraph("p_1", p.text)),
                                                      created))
        assert created.targets[0].source_anchor_id not in json.dumps(payload)
        assert payload["targets"][0]["state"] == "EXACT"

    def test_a_summary_reports_showability_separately_from_resolution(
        self, store: AnnotationStore
    ) -> None:
        """The distinction the brief asks for: a target can be un-resolvable and
        still point at the right place in an immutable PDF."""
        created, _ = self._seeded(store)
        payload = summary(created, resolve_annotation(
            ir_with(paragraph("p_1", "Different text.")), created))
        assert payload["targets"][0]["state"] == "ORPHANED"
        assert payload["targets"][0]["showable"] is True
        assert payload["targets"][0]["amenable_to_jump"] is True
