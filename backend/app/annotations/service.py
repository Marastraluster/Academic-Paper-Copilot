"""Putting annotations back on the page after the extraction underneath them moved.

The whole feature rests on one asymmetry, and it is worth stating plainly because
everything else follows from it:

    **the source PDF never changes; the extraction of it does.**

So a target always keeps the page and the rectangles the user's selection actually
covered, and those stay *visually* valid forever. What can stop being valid is
which current `ParagraphIR` that region corresponds to — and that is the only
question resolution answers.

Which is why a failed resolution is not a failed annotation. An ORPHANED target
can still be shown, still be jumped to, and still carry the user's words; what it
cannot do is claim a paragraph association it does not have.
"""

from __future__ import annotations

from app.annotations.models import Annotation, AnnotationTarget, ResolvedTarget
from app.annotations.store import AnnotationStore
from app.document.anchors import AnchorState, reattach
from app.document.models import DocumentIR


def _index_by_anchor(ir: DocumentIR) -> dict[str, str]:
    return {p.source_anchor_id: p.id for p in ir.paragraphs if p.source_anchor_id}


def resolve_target(ir: DocumentIR, target: AnnotationTarget) -> ResolvedTarget:
    """Where does this target's source live in the current extraction?

    Exact first, and it is the common case — measured at 150 of 160 on the real
    historical change — so the cheap path is the one almost every lookup takes.
    Only a miss pays for the page-scoped scan in `reattach`, and it is a scan of
    one page of an in-memory IR, not a search.
    """
    index = _index_by_anchor(ir)
    current = index.get(target.source_anchor_id)
    if current is not None:
        return ResolvedTarget(target, AnchorState.EXACT, (current,), "exact anchor")

    result = reattach(
        ir,
        anchor_id=target.source_anchor_id,
        page_number=target.page_number,
        quote=target.exact_quote,
    )
    return ResolvedTarget(target, result.state, result.paragraph_ids, result.detail)


def resolve_annotation(
    ir: DocumentIR, annotation: Annotation, *, store: AnnotationStore | None = None
) -> tuple[ResolvedTarget, ...]:
    """Resolve every target, and record what was found.

    The recording is a cache for the panel and the reader; it is never the input
    to the next resolution. `set_resolution` writes beside the original anchor, so
    a target that resolved wrongly once is re-derived from the anchor the user
    made rather than from the mistake — a wrong attachment cannot compound.
    """
    resolved: list[ResolvedTarget] = []
    for target in annotation.targets:
        outcome = resolve_target(ir, target)
        resolved.append(outcome)
        if store is not None and target.resolution_state is not outcome.state:
            store.set_resolution(
                target.id,
                paragraph_id=outcome.paragraph_ids[0] if outcome.paragraph_ids else None,
                state=outcome.state,
            )
    return tuple(resolved)


def summary(annotation: Annotation, resolved: tuple[ResolvedTarget, ...]) -> dict:
    """What the reader needs to draw this annotation, and nothing else.

    Deliberately derived per request rather than stored: a section title is
    presentation, and persisting it would freeze a value that re-extraction is
    allowed to change (brief Phase 69). No anchor hash reaches the client — a user
    has no use for one and it is not their data.
    """
    return {
        "id": annotation.id,
        "kind": annotation.kind,
        "color": annotation.color,
        "quote": annotation.quote,
        "comment": annotation.comment,
        "created_at": annotation.created_at,
        "updated_at": annotation.updated_at,
        "targets": [
            {
                "order": item.target.target_order,
                "page_number": item.target.page_number,
                "rects": [list(r) for r in item.target.rects],
                "quote": item.target.exact_quote,
                "state": item.state.value,
                "paragraph_id": (
                    item.paragraph_ids[0] if item.state is AnchorState.EXACT
                    and item.paragraph_ids else None
                ),
                "resolved_paragraph_id": (
                    item.paragraph_ids[0] if item.navigable and item.paragraph_ids
                    else None
                ),
                "detail": item.detail,
                # Whether the source can still be *shown*, which is a different
                # question from whether it can be *resolved*. The geometry belongs
                # to the immutable PDF, so it survives an orphan — a distinction
                # the brief asks for and the UI depends on.
                "showable": bool(item.target.rects),
                "amenable_to_jump": item.navigable or bool(item.target.page_number),
            }
            for item in resolved
        ],
    }
