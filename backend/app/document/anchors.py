"""Stable canonical source identity, for artifacts that outlive an extraction.

## The problem this exists for

`ParagraphIR.id` is `p_<document>_<ordinal>` — *the Nth paragraph in this
extraction*. It is a fine runtime identity and a terrible persistent one, and
DS-DOC-002 measured how bad: lowering one gutter constant re-segmented **145 of
160 paragraphs** of Diffusion Policy while leaving five other papers untouched.

A user's note must survive that. It must mean *"this text, here, in this PDF"*,
not *"paragraph number 42"*.

## Two layers, and why both

**Runtime identity** (`ParagraphIR.id`) stays exactly as it is. It is what QA,
retrieval, citations and the DOM use, it is opaque to all of them, and changing
it would churn every stored artifact for no product gain.

**Source identity** (`ParagraphIR.source_anchor_id`) is this module. It is
derived from the immutable source and nothing else:

    sha256( version | content_hash | page | quantized bbox | canonical text )

Nothing in that payload is positional. Reorder the pages, insert a paragraph
before it, delete one after it, and the anchor is unchanged — measured, not
asserted: on the real Diffusion Policy extraction change, **150 of 160 anchors
were bit-identical**, and the ten that moved are the ones whose *text* genuinely
re-segmented.

## What it does not promise

An anchor identifies a paragraph. It cannot identify a claim. If extraction
re-segments a paragraph into two, the old anchor is no longer exact — that is what
`reattach` is for, and an anchor that refuses to resolve is better than one that
resolves to the wrong sentence. `WRONG` is the only outcome this module treats as
a failure; `AMBIGUOUS` and `ORPHANED` are honest results a caller can present.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from enum import Enum

from app.document.models import BoundingBox, DocumentIR, ParagraphIR
from app.document.normalize import join_wrapped_lines

#: Bumped whenever the canonical payload changes — a normalization rule, the
#: quantum, an input. **Never silently**: an anchor persisted under one version
#: and compared under another is a wrong attachment waiting to happen, which is
#: why the version is inside the hash rather than beside it.
SOURCE_ANCHOR_VERSION = "1"

#: Geometry grid, in PDF points. Measured: identical results at 0.0, 0.25, 0.5,
#: 1.0, 2.0 and 4.0 on 577 paragraphs across six papers, with **zero collisions
#: at every one**. The grid is therefore not load-bearing here; it is insurance
#: against a future extraction whose block boxes shift by a fraction of a point,
#: which nothing in this repository has yet produced and which would silently
#: orphan every annotation if the payload used raw floats.
GEOMETRY_QUANTUM_PT = 2.0


def canonical_source_text(text: str) -> str:
    """The text of a source region, normalized for comparison.

    Delegates to `normalize.join_wrapped_lines` — the repository's own rule, and
    the only one. It carries a decision a naive `re.sub(r"-\n", "")` gets wrong:
    a line-final hyphen followed by a lowercase word is a *wrap* unless the
    fragment before it is a compound prefix, in which case the hyphen belongs to
    the word and only the break is closed. Measured difference:
    `"a self-\ncontaining module"` is `"a self-containing module"` under this
    rule and `"a selfcontaining module"` under the naive one.

    Nothing here folds case, punctuation or digits. `ResNet-50`, `CIFAR-10`,
    `Eq. 4` and `F(x)` are the characters academic identity is made of, and a
    normalization that erases them is wrong quietly rather than loudly.

    **One addition to the repository's rule: the soft hyphen is removed.** U+00AD
    is a *break hint* — a typesetter's instruction about where a word may wrap,
    carrying no content of its own — so its presence must not change an anchor.
    It is not in `normalize._WHITESPACE` (its category is `Cf`, not whitespace),
    and it does not occur in any of the 577 paragraphs of the benchmark corpus,
    so this is robustness against a document rather than a fix for one.
    """
    return join_wrapped_lines(text.replace("\u00ad", "").split("\n"))


def quantize(value: float, quantum: float = GEOMETRY_QUANTUM_PT) -> float:
    """Snap a coordinate to the grid, deterministically and symmetrically."""
    if quantum <= 0:
        return round(value, 4)
    return round(round(value / quantum) * quantum, 4)


def _envelope(paragraph: ParagraphIR) -> BoundingBox | None:
    """The paragraph's own bounding box, or the union of its blocks'.

    A paragraph normally carries one box per contributing block; the envelope is
    the union, which is what a highlight would draw. Falls back to the blocks'
    extent because a paragraph with no recorded `bboxes` still has a place.
    """
    if paragraph.bboxes:
        return (
            min(b[0] for b in paragraph.bboxes),
            min(b[1] for b in paragraph.bboxes),
            max(b[2] for b in paragraph.bboxes),
            max(b[3] for b in paragraph.bboxes),
        )
    return None


def anchor_payload_for(content_hash: str, paragraph: ParagraphIR) -> str:
    """`anchor_payload` from a fingerprint rather than a whole IR.

    Extraction needs the payload before a `DocumentIR` exists — the anchor is
    derived from the source, and building the IR first would make it derived from
    the IR instead.
    """
    envelope = _envelope(paragraph)
    geometry = (
        "|".join(str(quantize(value)) for value in envelope)
        if envelope is not None
        else "none"
    )
    return "|".join([
        SOURCE_ANCHOR_VERSION,
        content_hash,
        str(paragraph.page_number),
        geometry,
        canonical_source_text(paragraph.text),
    ])


def source_anchor_id_for(content_hash: str, paragraph: ParagraphIR) -> str:
    return hashlib.sha256(
        anchor_payload_for(content_hash, paragraph).encode("utf-8")
    ).hexdigest()


def anchor_payload(ir: DocumentIR, paragraph: ParagraphIR) -> str:
    """The exact bytes an anchor hashes. Exposed so a test can assert them.

    A hash whose inputs cannot be inspected is a hash nobody can debug, and this
    one has to survive versions.
    """
    return anchor_payload_for(ir.content_hash, paragraph)


def source_anchor_id(ir: DocumentIR, paragraph: ParagraphIR) -> str:
    """The stable identity of one paragraph's source region.

    Scoped by the document fingerprint: the same sentence on page 1 of two
    different papers must not share an anchor, and brief Phase 5 is explicit that
    it must not. Disambiguated by geometry rather than by an occurrence counter —
    two identical captions on one page sit in different places, and a counter
    would renumber them the moment a third appeared above.
    """
    return source_anchor_id_for(ir.content_hash, paragraph)


def describe_anchor(
    ir: DocumentIR, paragraph: ParagraphIR
) -> dict[str, object]:
    """Developer-readable form of an anchor, for diagnostics only.

    Deliberately derived rather than stored: the page, the box and the version are
    already on the paragraph or in this module, and a second copy in the IR would
    be storage spent on a debugging convenience (brief Phase 55/56). No UI shows
    any of this.
    """
    return {
        "anchor_id": paragraph.source_anchor_id,
        "anchor_version": SOURCE_ANCHOR_VERSION,
        "document_id": ir.document_id,
        "page_number": paragraph.page_number,
        "bbox": _envelope(paragraph),
        "quantum_pt": GEOMETRY_QUANTUM_PT,
        "text_digest": hashlib.sha256(
            canonical_source_text(paragraph.text).encode("utf-8")
        ).hexdigest()[:16],
        "text_prefix": canonical_source_text(paragraph.text)[:60],
    }


# --- reattachment -------------------------------------------------------------


class AnchorState(str, Enum):
    """What became of an old anchor when it was looked for again.

    Four states, not a `None`: a caller migrating annotations has to tell "this
    moved slightly" from "there are two places this could be" from "this text is
    gone", because the product response differs for each.
    """

    EXACT = "EXACT"
    REATTACHED = "REATTACHED"
    AMBIGUOUS = "AMBIGUOUS"
    ORPHANED = "ORPHANED"


@dataclass(frozen=True)
class AnchorResolution:
    """The outcome, and what it found."""

    state: AnchorState
    paragraph_ids: tuple[str, ...]
    detail: str = ""

    @property
    def resolved(self) -> bool:
        return self.state in (AnchorState.EXACT, AnchorState.REATTACHED)


#: How much of a paragraph's text must be found in a candidate before it counts.
#: Not a tuned constant: it is the difference between "this text is here" and
#: "some of these words are here", and the conservative direction is the whole
#: point (brief Phase 79 — an orphan beats a wrong attachment).
MIN_REATTACH_COVERAGE = 0.5


def _coverage(needle: str, haystack: str) -> float:
    if not needle:
        return 0.0
    return 1.0 if needle in haystack else 0.0


def reattach(
    ir: DocumentIR,
    *,
    anchor_id: str,
    page_number: int,
    quote: str,
) -> AnchorResolution:
    """Find where an old anchor's source went, conservatively.

    Only called when an exact anchor no longer resolves, so the cost is paid on
    migration rather than on every read.

    The cascade is deliberately short, and every rung is a *page-scoped* lookup:
    the brief forbids searching another document (Phase 27) and warns against
    wandering to nearby pages, so this does not. A paragraph whose text moved to
    another page is reported ORPHANED rather than guessed at — that is a real
    outcome for a re-laid-out paper and the product can say so.

    **Ambiguity is returned, never broken.** If two paragraphs on the page could
    hold the quote, the answer is AMBIGUOUS and the caller decides; picking the
    better-scoring one would be this module choosing on the user's behalf.
    """
    for paragraph in ir.paragraphs:
        if paragraph.source_anchor_id == anchor_id:
            return AnchorResolution(AnchorState.EXACT, (paragraph.id,), "exact anchor")

    needle = canonical_source_text(quote)
    if not needle:
        return AnchorResolution(AnchorState.ORPHANED, (), "no quote to search for")

    same_page = [p for p in ir.paragraphs if p.page_number == page_number]
    holding = [
        p for p in same_page
        if _coverage(needle, canonical_source_text(p.text)) >= MIN_REATTACH_COVERAGE
    ]
    if len(holding) == 1:
        return AnchorResolution(
            AnchorState.REATTACHED, (holding[0].id,), "quote found on the page"
        )
    if len(holding) > 1:
        return AnchorResolution(
            AnchorState.AMBIGUOUS,
            tuple(p.id for p in holding),
            f"{len(holding)} paragraphs on the page hold the quote",
        )

    # The quote may be a fragment of a paragraph that grew (a merge) rather than
    # the whole of one. Searched in the same page-scoped set for the same reason.
    contained_by = [
        p for p in same_page
        if canonical_source_text(p.text) and canonical_source_text(p.text) in needle
    ]
    if len(contained_by) == 1:
        return AnchorResolution(
            AnchorState.REATTACHED, (contained_by[0].id,), "source merged into this"
        )
    if len(contained_by) > 1:
        return AnchorResolution(
            AnchorState.AMBIGUOUS,
            tuple(p.id for p in contained_by),
            f"{len(contained_by)} paragraphs could hold the source",
        )
    return AnchorResolution(AnchorState.ORPHANED, (), "no paragraph on this page holds it")
