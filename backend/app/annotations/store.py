"""Reading and writing annotations in the application database.

The database this uses is the one `app.db` owns — no second store, no per-document
file. Annotations are the first *user-authored* thing this application persists:
everything else in `documents/` is derived and can be rebuilt from the PDF. That
asymmetry is why the writes here are transactional and the deletes are soft.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timezone

from app.annotations.models import (
    Annotation,
    AnnotationTarget,
    DEFAULT_COLOR,
)
from app.document.anchors import AnchorState


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id(prefix: str) -> str:
    """A random id, and deliberately not a hash.

    Source identity is deterministic because it must be recomputable. An
    annotation's identity is not: it is a thing the user made, it keeps that
    identity across reattachment and editing, and two identical selections are
    two annotations. A content-derived id here would collapse the second into the
    first.
    """
    return f"{prefix}{uuid.uuid4().hex}"


def _target_from_row(row: sqlite3.Row) -> AnnotationTarget:
    bbox = tuple(json.loads(row["original_bbox"]))
    rects = tuple(tuple(r) for r in json.loads(row["rects"]))
    state = row["resolution_state"]
    return AnnotationTarget(
        id=row["id"],
        annotation_id=row["annotation_id"],
        target_order=int(row["target_order"]),
        source_class=row["source_class"] or "paragraph",
        source_anchor_id=row["source_anchor_id"],
        anchor_version=row["anchor_version"],
        page_number=int(row["page_number"]),
        original_bbox=bbox,  # type: ignore[arg-type]
        rects=rects,  # type: ignore[arg-type]
        exact_quote=row["exact_quote"],
        prefix=row["prefix"] or "",
        suffix=row["suffix"] or "",
        resolved_paragraph_id=row["resolved_paragraph_id"],
        resolution_state=AnchorState(state) if state else None,
        resolved_at=row["resolved_at"],
    )


def _annotation_from_rows(
    row: sqlite3.Row, targets: list[sqlite3.Row]
) -> Annotation:
    return Annotation(
        id=row["id"],
        content_hash=row["content_hash"],
        document_id=row["document_id"],
        kind=row["kind"],
        color=row["color"],
        quote=row["quote"],
        comment=row["comment"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        deleted_at=row["deleted_at"],
        targets=tuple(_target_from_row(t) for t in targets),
    )


class AnnotationStore:
    """The annotations table, and the targets that hang off it."""

    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    # --- reading ------------------------------------------------------------

    def list_for_document(
        self, document_id: str, *, include_deleted: bool = False
    ) -> list[Annotation]:
        """Everything the open document holds.

        Scoped by the document row rather than the fingerprint, because this is
        what the *reader* is showing. Resolution and the durable boundary are the
        fingerprint's job; see `list_for_content`.
        """
        where = "" if include_deleted else "AND deleted_at IS NULL"
        rows = self._connection.execute(
            f"SELECT * FROM annotations WHERE document_id = ? {where} "
            "ORDER BY created_at, id",
            (document_id,),
        ).fetchall()
        return [self._hydrate(row) for row in rows]

    def list_for_content(
        self, content_hash: str, *, include_deleted: bool = False
    ) -> list[Annotation]:
        """Everything ever written against this exact PDF.

        The durable query. A document removed and re-imported has a new row and a
        new id, and this is what finds the user's annotations again.
        """
        where = "" if include_deleted else "AND deleted_at IS NULL"
        rows = self._connection.execute(
            f"SELECT * FROM annotations WHERE content_hash = ? {where} "
            "ORDER BY created_at, id",
            (content_hash,),
        ).fetchall()
        return [self._hydrate(row) for row in rows]

    def get(self, annotation_id: str) -> Annotation | None:
        row = self._connection.execute(
            "SELECT * FROM annotations WHERE id = ?", (annotation_id,)
        ).fetchone()
        return self._hydrate(row) if row else None

    def _hydrate(self, row: sqlite3.Row) -> Annotation:
        targets = self._connection.execute(
            "SELECT * FROM annotation_targets WHERE annotation_id = ? "
            "ORDER BY target_order, id",
            (row["id"],),
        ).fetchall()
        return _annotation_from_rows(row, targets)

    # --- writing ------------------------------------------------------------

    def create(
        self,
        *,
        content_hash: str,
        document_id: str,
        kind: str,
        quote: str,
        comment: str | None,
        targets: list[dict],
        color: str = DEFAULT_COLOR,
    ) -> Annotation:
        """Persist an annotation and all its targets, or neither.

        One transaction, because an annotation without its targets is a mark on
        the page pointing nowhere: it would list in the panel, fail to resolve,
        and look to the user like their note had been corrupted rather than never
        saved. A partial write is worse than a failed one.
        """
        if not targets:
            raise ValueError("An annotation needs at least one source target.")
        annotation_id = _new_id("ann_")
        stamp = _now()
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            self._connection.execute(
                "INSERT INTO annotations (id, content_hash, document_id, kind, "
                "color, quote, comment, created_at, updated_at, deleted_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
                (annotation_id, content_hash, document_id, kind, color, quote,
                 comment, stamp, stamp),
            )
            for order, target in enumerate(targets):
                self._connection.execute(
                    "INSERT INTO annotation_targets (id, annotation_id, "
                    "target_order, source_class, source_anchor_id, anchor_version, page_number, "
                    "original_bbox, rects, exact_quote, prefix, suffix) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        _new_id("tgt_"), annotation_id, order,
                        target.get("source_class", "paragraph"),
                        target["source_anchor_id"], target.get("anchor_version", "1"),
                        target["page_number"],
                        json.dumps(list(target["original_bbox"])),
                        json.dumps([list(r) for r in target["rects"]]),
                        target["exact_quote"],
                        target.get("prefix", ""), target.get("suffix", ""),
                    ),
                )
            self._connection.commit()
        except Exception:
            self._connection.rollback()
            raise
        created = self.get(annotation_id)
        assert created is not None
        return created

    def update_comment(self, annotation_id: str, comment: str | None) -> Annotation | None:
        """Change the user's words. Does not touch a single target.

        The source anchor is not a field of the annotation for exactly this
        reason: editing a note must never be able to move it.
        """
        self._connection.execute(
            "UPDATE annotations SET comment = ?, updated_at = ? WHERE id = ?",
            (comment, _now(), annotation_id),
        )
        self._connection.commit()
        return self.get(annotation_id)

    def set_resolution(
        self,
        target_id: str,
        *,
        paragraph_id: str | None,
        state: AnchorState,
    ) -> None:
        """Record what a target resolved to against the current extraction.

        Written *beside* the original anchor, never over it. The next extraction
        change re-resolves from the anchor as the user made it, not from this
        result — otherwise a wrong reattachment would compound.
        """
        self._connection.execute(
            "UPDATE annotation_targets SET resolved_paragraph_id = ?, "
            "resolution_state = ?, resolved_at = ? WHERE id = ?",
            (paragraph_id, state.value, _now(), target_id),
        )
        self._connection.commit()

    def delete(self, annotation_id: str) -> bool:
        """Soft delete. The row stays; `deleted_at` marks it.

        User writing is not a cache. A mistaken delete should be recoverable, and
        nothing here has a retention policy that would justify destroying it.
        """
        cursor = self._connection.execute(
            "UPDATE annotations SET deleted_at = ?, updated_at = ? WHERE id = ? "
            "AND deleted_at IS NULL",
            (_now(), _now(), annotation_id),
        )
        self._connection.commit()
        return cursor.rowcount > 0
