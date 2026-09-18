"""A user's annotation, and the source it is attached to.

The distinction this module exists to hold:

    an annotation is the user's writing — theirs, stable, never derived
    a target is where in the paper it was attached — canonical, and re-resolvable

They are separate records because they have separate lifetimes. Editing a note
changes the annotation; re-extracting a paper changes what its targets resolve to
and must not touch the annotation at all.

**Nothing here is derived from the current extraction.** A target stores the
anchor DS-DOC-003 froze, the page, the rectangles and the quote as they were when
the user made the selection. Resolution adds a current paragraph id *beside* them
and never replaces them, so an annotation that has been reattached twice can still
say what it was originally attached to.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from app.document.anchors import AnchorState

#: Two kinds, and no more. A highlight is a region the user marked; a note is that
#: plus their own words. Anyone who wants a third kind has to say what it means
#: for reattachment, which is the part that is not obvious.
AnnotationKind = Literal["highlight", "note"]

#: The palette is a fixed set of tokens, never a user-supplied CSS string.
DEFAULT_COLOR = "yellow"


@dataclass(frozen=True)
class AnnotationTarget:
    """One source region an annotation is attached to.

    A multi-paragraph selection produces several of these, in reading order —
    because DS-DOC-002 measured that the paragraph is the unit that survives an
    extraction change, and a span across three of them is not.
    """

    id: str
    annotation_id: str
    target_order: int
    #: The anchor as it was computed when the selection was made. Immutable.
    source_anchor_id: str
    anchor_version: str
    page_number: int
    #: `[x0, y0, x1, y1]` in source-PDF points — the paragraph envelope.
    original_bbox: tuple[float, float, float, float]
    #: The line rectangles the selection actually covered, same space. A
    #: multi-line selection is several boxes, not one envelope: a single box would
    #: highlight the margins beside a short last line.
    rects: tuple[tuple[float, float, float, float], ...]
    #: The part of the user's selection that falls in this paragraph, and bounded
    #: context either side, all from canonical source text.
    exact_quote: str
    prefix: str = ""
    suffix: str = ""

    # --- resolution: written beside the original, never over it ---------------
    #: The paragraph this target currently resolves to, as a *runtime* id. A hint
    #: for navigation; never the thing that identifies the source.
    resolved_paragraph_id: str | None = None
    resolution_state: AnchorState | None = None
    resolved_at: str | None = None


@dataclass(frozen=True)
class Annotation:
    """A user's mark, and everything needed to put it back on the page."""

    id: str
    #: The durable boundary. Not the document row's id — that is a UUID that a
    #: re-import replaces; this is the sha256 of the file the user wrote on.
    content_hash: str
    #: Routing only. The document currently open, if any.
    document_id: str
    kind: AnnotationKind
    color: str
    #: The user's whole selection, for display and search.
    quote: str
    #: The user's words. `None` for a bare highlight.
    comment: str | None
    created_at: str
    updated_at: str
    targets: tuple[AnnotationTarget, ...] = field(default_factory=tuple)

    @property
    def is_deleted(self) -> bool:
        return self.deleted_at is not None

    deleted_at: str | None = None


@dataclass(frozen=True)
class ResolvedTarget:
    """One target, and what became of it against the current extraction."""

    target: AnnotationTarget
    state: AnchorState
    paragraph_ids: tuple[str, ...]
    detail: str = ""

    @property
    def navigable(self) -> bool:
        """Whether the reader can still be sent somewhere defensible.

        True for EXACT and REATTACHED, which name a paragraph. AMBIGUOUS does
        not — sending the reader to one of two equally good candidates would be
        this code choosing for them. ORPHANED does not either, though the stored
        page and rects remain valid against the immutable PDF and the UI may still
        offer the page (brief Phase 42/70).
        """
        return self.state in (AnchorState.EXACT, AnchorState.REATTACHED)
