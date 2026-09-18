"""DS-QA-011 — one annotation whose targets live on two pages.

The persistence layer already stores N ordered targets, so most of what this
suite asserts is that nothing *new* was needed: the ordering the browser emits is
the ordering that survives, each page keeps its own rectangles, and the whole set
is still one user object for editing and deleting.

The two things that are genuinely new here are the boundary the frontend cannot
enforce on its own — a target's rectangles must lie inside its own envelope — and
the heterogeneous case, where one page resolves exactly and the other does not
and the annotation must remain one annotation anyway.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.annotations.store import AnnotationStore
from app.annotations.service import resolve_annotation
from app.document.anchors import AnchorState
from tests.test_annotations import (
    FINGERPRINT,
    ir_with,
    paragraph,
    source_anchor_id_for,
    store,  # noqa: F401 — re-exported fixture
    target_for,
)

# Page 1's last paragraph and page 2's first — the pair a boundary selection
# reaches, and the pair the browser probe measured.
TAIL = (72.0, 690.0, 500.0, 704.0)
HEAD = (72.0, 100.0, 520.0, 114.0)


def page_one() -> object:
    return paragraph("p_0001", "the last line of page one", page=1, bbox=TAIL)


def page_two() -> object:
    return paragraph("p_0002", "the first line of page two", page=2, bbox=HEAD)


class TestCrossPageTargets:
    def test_a_two_page_selection_is_one_annotation_with_ordered_targets(
        self, store: AnnotationStore
    ) -> None:
        a, b = page_one(), page_two()
        created = store.create(
            content_hash=FINGERPRINT, document_id="doc_1", kind="highlight",
            quote="the last line of page one the first line of page two",
            comment="spans the boundary", targets=[target_for(a), target_for(b)],
        )

        assert len(created.targets) == 2
        assert [t.page_number for t in created.targets] == [1, 2]
        assert [t.target_order for t in created.targets] == [0, 1]
        # The span the reader sees, not just the pieces.
        assert created.quote.endswith("the first line of page two")

    def test_each_target_keeps_its_own_page_and_rectangles(
        self, store: AnnotationStore
    ) -> None:
        a, b = page_one(), page_two()
        created = store.create(
            content_hash=FINGERPRINT, document_id="doc_1", kind="highlight",
            quote="q", comment=None, targets=[target_for(a), target_for(b)],
        )

        first, second = created.targets
        assert first.page_number == 1 and second.page_number == 2
        # Never page 2's rectangles under page 1's target.
        assert tuple(first.rects[0]) == TAIL
        assert tuple(second.rects[0]) == HEAD

    def test_the_order_the_client_sent_is_the_order_that_survives(
        self, store: AnnotationStore
    ) -> None:
        """Canonical order is decided by the mapper, not by the database.

        Sorting by anchor or by insertion accident would reorder a backward drag
        — the reader selected page 2 then page 1, and the note must still read
        the way the paper does.
        """
        a, b = page_one(), page_two()
        created = store.create(
            content_hash=FINGERPRINT, document_id="doc_1", kind="highlight",
            quote="q", comment=None, targets=[target_for(b), target_for(a)],
        )

        assert [t.page_number for t in created.targets] == [2, 1]

    def test_a_failure_on_the_second_page_leaves_no_first_page_highlight(
        self, store: AnnotationStore
    ) -> None:
        """Atomicity is what stops a half-saved annotation.

        A page-1 highlight with its page-2 half missing is worse than a save that
        visibly failed: the reader sees a mark, believes the span was kept, and
        only finds out on reload.
        """
        a, b = page_one(), page_two()
        # The failure is on the *second* target, so the annotation row and page
        # 1's target have already been written when it fires. Only the rollback
        # can take them back.
        broken = target_for(b)
        del broken["exact_quote"]

        with pytest.raises(Exception):
            store.create(
                content_hash=FINGERPRINT, document_id="doc_1", kind="highlight",
                quote="q", comment=None, targets=[target_for(a), broken],
            )

        assert store.list_for_content(FINGERPRINT) == []

    def test_both_pages_come_back_on_a_reload(self, store: AnnotationStore) -> None:
        a, b = page_one(), page_two()
        store.create(
            content_hash=FINGERPRINT, document_id="doc_1", kind="highlight",
            quote="q", comment="mine", targets=[target_for(a), target_for(b)],
        )

        listed = store.list_for_content(FINGERPRINT)
        assert len(listed) == 1
        assert [t.page_number for t in listed[0].targets] == [1, 2]

    def test_editing_and_deleting_act_on_the_whole_span(
        self, store: AnnotationStore
    ) -> None:
        a, b = page_one(), page_two()
        created = store.create(
            content_hash=FINGERPRINT, document_id="doc_1", kind="highlight",
            quote="q", comment=None, targets=[target_for(a), target_for(b)],
        )

        edited = store.update_comment(created.id, "still mine")
        assert edited is not None
        assert [t.page_number for t in edited.targets] == [1, 2]

        store.delete(created.id)
        assert store.list_for_content(FINGERPRINT) == []

    def test_the_whole_span_is_scoped_to_one_document(
        self, store: AnnotationStore
    ) -> None:
        a, b = page_one(), page_two()
        store.create(
            content_hash=FINGERPRINT, document_id="doc_1", kind="highlight",
            quote="q", comment=None, targets=[target_for(a), target_for(b)],
        )

        assert store.list_for_content("a-different-pdf") == []
        assert len(store.list_for_content(FINGERPRINT)) == 1


class TestHeterogeneousResolution:
    def test_one_page_exact_and_the_other_orphaned_is_still_one_annotation(
        self, store: AnnotationStore
    ) -> None:
        """Resolution is per target, and it must stay per target.

        The extraction that produced page 2's paragraph changed; page 1's did
        not. The user's span is still one span, and reporting a single
        annotation-level verdict would erase which half is certain.
        """
        a, b = page_one(), page_two()
        created = store.create(
            content_hash=FINGERPRINT, document_id="doc_1", kind="highlight",
            quote="q", comment=None, targets=[target_for(a), target_for(b)],
        )

        # A re-extraction that kept page 1 and lost page 2 entirely.
        current = ir_with(page_one())
        resolved = resolve_annotation(current, created, store=store)

        assert len(resolved) == 2
        assert resolved[0].state is AnchorState.EXACT
        assert resolved[1].state is AnchorState.ORPHANED
        # The failed half keeps its page and its geometry: those belong to the
        # immutable PDF, not to the extraction that moved.
        assert resolved[1].target.page_number == 2
        assert tuple(resolved[1].target.rects[0]) == HEAD

    def test_the_anchor_of_the_orphaned_page_survives_the_miss(
        self, store: AnnotationStore
    ) -> None:
        a, b = page_one(), page_two()
        created = store.create(
            content_hash=FINGERPRINT, document_id="doc_1", kind="highlight",
            quote="q", comment=None, targets=[target_for(a), target_for(b)],
        )
        anchor_of_b = created.targets[1].source_anchor_id
        assert anchor_of_b == source_anchor_id_for(page_two(), FINGERPRINT)

        resolve_annotation(ir_with(page_one()), created, store=store)

        after = store.get(created.id)
        assert after is not None
        assert after.targets[1].source_anchor_id == anchor_of_b
