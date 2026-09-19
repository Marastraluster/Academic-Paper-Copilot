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
from app.document.anchors import AnchorState, anchorable_blocks, reattach, reattach_block
from app.annotations.models import BLOCK_SOURCE_CLASSES
from app.document.models import DocumentIR


def _index_by_anchor(ir: DocumentIR) -> dict[str, str]:
    return {p.source_anchor_id: p.id for p in ir.paragraphs if p.source_anchor_id}


def _block_index(ir: DocumentIR) -> dict[str, str]:
    """Non-prose anchors, keyed exactly as the paragraph ones are.

    One dict per kind rather than one merged dict, so a paragraph anchor can
    never be found under a caption's key even if a future recipe made the two
    payloads coincide. The lookup that matters is the one that cannot cross.
    """
    return {
        block.source_anchor_id: block.id
        for block in anchorable_blocks(ir)
        if block.source_anchor_id
    }


def resolve_target(ir: DocumentIR, target: AnnotationTarget) -> ResolvedTarget:
    """Where does this target's source live in the current extraction?

    Exact first, and it is the common case — measured at 150 of 160 on the real
    historical change — so the cheap path is the one almost every lookup takes.
    Only a miss pays for the page-scoped scan in `reattach`, and it is a scan of
    one page of an in-memory IR, not a search.
    """
    block_backed = target.source_class in BLOCK_SOURCE_CLASSES

    if block_backed:
        current = _block_index(ir).get(target.source_anchor_id)
        if current is not None:
            return ResolvedTarget(
                target, AnchorState.EXACT, (current,), "exact block anchor"
            )
        result = reattach_block(
            ir,
            anchor_id=target.source_anchor_id,
            page_number=target.page_number,
            layout_class=target.source_class,
            quote=target.exact_quote,
        )
        return ResolvedTarget(target, result.state, result.paragraph_ids, result.detail)

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


def summary_unresolved(annotation: Annotation) -> dict:
    """The same shape as `summary`, from what is *stored* rather than resolved.

    Used when the document's extraction is not available yet. Nothing here is a
    guess: the page, the rectangles and the quote were recorded when the user made
    the annotation, they belong to the immutable PDF, and they are still true.

    What is absent is the EXACT/REATTACHED/AMBIGUOUS/ORPHANED verdict, which is a
    statement about the current extraction and cannot be made without one. It is
    reported as `UNRESOLVED` rather than omitted, so the reader is told what the
    system does not yet know instead of being shown a confident default.
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
                "order": target.target_order,
                "page_number": target.page_number,
                "source_class": target.source_class,
                "rects": [list(r) for r in target.rects],
                "quote": target.exact_quote,
                "state": "UNRESOLVED",
                "paragraph_id": None,
                "resolved_paragraph_id": None,
                "detail": "the document has not been read yet",
                "showable": bool(target.rects),
                "amenable_to_jump": target.page_number >= 1,
            }
            for target in annotation.targets
        ],
    }


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
                "source_class": item.target.source_class,
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
