"""Persistent user annotations: notes and highlights.

The first *user-authored* data this application stores. Everything else under
`documents/` is derived from the PDF and can be rebuilt; a note cannot, so the
rules here are stricter than anywhere else in the codebase — transactional
writes, soft deletion, and a durable key that survives the document record.

Public surface:

* :class:`~app.annotations.models.Annotation` and
  :class:`~app.annotations.models.AnnotationTarget` — what is stored.
* :class:`~app.annotations.store.AnnotationStore` — the database.
* :func:`~app.annotations.service.resolve_annotation` — where a stored target
  lives in the *current* extraction.
"""

from app.annotations.models import (
    Annotation,
    AnnotationKind,
    AnnotationTarget,
    ResolvedTarget,
)
from app.annotations.service import resolve_annotation, resolve_target, summary
from app.annotations.store import AnnotationStore

__all__ = [
    "Annotation",
    "AnnotationKind",
    "AnnotationStore",
    "AnnotationTarget",
    "ResolvedTarget",
    "resolve_annotation",
    "resolve_target",
    "summary",
]
