"""Disassembling an answer, checking its citations, and resolving them.

The model writes prose containing `[E2]` markers. This module answers three
questions about it, in increasing order of difficulty:

1. **Do the markers name evidence that exists?** Mechanical, exact, and the one
   check that cannot be approximately right: `E99` either is in the bundle or is
   not.
2. **Is every claim attached to one?** Mechanical *if* the sentence splitter is
   honest about abbreviations — see `split_sentences`, which exists because
   `Fig. 3` is not the end of a sentence and treating it as one manufactures a
   citationless fragment out of a correctly cited answer.
3. **Does the cited evidence actually contain the claim's specifics?** Only
   partly mechanisable, and the limits matter. Numbers and identifiers can be
   checked against the source text exactly; ordinary words cannot, because
   verifying that "the authors found improvements" is supported by "we observe
   consistent gains" requires understanding, not string matching. So only the
   checkable tokens are checked. Prose is left to the reader, and saying so is
   more honest than a similarity score dressed up as a guarantee.

The module also resolves markers into `ResolvedCitation`s by joining against the
`DocumentIR` — page, section, block ids and bounding boxes. That join is the
reason a citation's page number can be trusted: it is read from the document, not
from the answer.
"""

from __future__ import annotations

import re

from app.context.evidence import normalize_for_matching
from app.document.models import DocumentIR
from app.qa.models import EvidenceItem, ResolvedCitation

#: `[E1]`, the only citation form the prompt asks for.
MARKER_RE = re.compile(r"\[(E\d+)\]")

#: A fragment that is nothing but markers, i.e. a citation that landed after the
#: sentence's full stop rather than inside it.
_MARKERS_ONLY = re.compile(r"^(?:\s*\[E\d+\]\s*)+$")

#: Markers sitting at the head of a sentence, which belong to the one before it.
_LEADING_MARKERS = re.compile(r"^(?:\s*\[E\d+\]\s*)+")

#: A sentence shorter than this is not treated as a claim. Headings, labels,
#: list markers and one-word replies are all legitimately uncited, and demanding
#: a citation from them would reject honest answers.
#:
#: Counted in **weighted** characters, not characters: a Chinese sentence carries
#: several times the content of a Latin one of the same length, so a flat
#: character threshold silently exempts every short Chinese claim — in a feature
#: whose primary use case is a Chinese question against an English paper. The
#: weight is the length at which the two say the same thing: `我们采用残差学习。`
#: (9 characters) states what `We adopt residual learning.` (26) states.
MIN_CLAIM_CHARS = 25
CJK_WEIGHT = 3.0


def _is_cjk(character: str) -> bool:
    codepoint = ord(character)
    return (
        0x4E00 <= codepoint <= 0x9FFF
        or 0x3040 <= codepoint <= 0x30FF
        or 0xAC00 <= codepoint <= 0xD7AF
        or 0x3000 <= codepoint <= 0x303F
        or 0xFF00 <= codepoint <= 0xFFEF
    )


def claim_weight(text: str) -> float:
    """Characters, with CJK counted at the weight of what it says."""
    cjk = sum(1 for character in text if _is_cjk(character))
    return cjk * CJK_WEIGHT + (len(text) - cjk)

#: Sentence-ending punctuation. The two alternatives are not redundant: Latin
#: text separates sentences with whitespace, and CJK text does not — `。这` is a
#: boundary with nothing between the characters. Requiring whitespace after every
#: terminator would leave a Chinese answer as one enormous sentence, and every
#: claim-check downstream would see a single claim.
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+|(?<=[。！？])")

#: Words whose full stop is not a sentence boundary. Left unprotected, `Fig. 3
#: shows ...` splits into a two-character "sentence" and a claim that appears to
#: have no citation — so a correct answer gets rejected for a reason that is an
#: artefact of the checker.
_ABBREVIATIONS = (
    "e.g.", "i.e.", "et al.", "al.", "Fig.", "Figs.", "Eq.", "Eqs.", "Sec.",
    "Secs.", "Tab.", "vs.", "cf.", "approx.", "Ref.", "Refs.", "No.", "Nos.",
    "Mr.", "Ms.", "Dr.", "Prof.", "St.", "Inc.", "Ltd.", "i.e", "e.g",
)

#: Numbers, including decimals, thousands separators and percentages, and
#: identifiers that contain a digit (`ResNet-50`, `CIFAR-10`, `V100`, `GPT-4`).
#: These are the tokens a model is most likely to fabricate and the only ones
#: that can be verified without judgement: either the source contains "152" or it
#: does not.
_NUMBER = re.compile(r"\d+(?:[.,]\d+)*")
_IDENTIFIER = re.compile(r"[A-Za-z][A-Za-z0-9-]*\d[A-Za-z0-9-]*")


def extract_markers(text: str) -> list[str]:
    """Every `[Ek]` marker, in the order it appears."""
    return MARKER_RE.findall(text)


def dedupe_in_order(values: list[str]) -> list[str]:
    """Unique, keeping first appearance — the order the answer cites them in."""
    seen: set[str] = set()
    ordered: list[str] = []
    for value in values:
        if value not in seen:
            seen.add(value)
            ordered.append(value)
    return ordered


def split_sentences(text: str) -> list[str]:
    """Split into sentences, without splitting on abbreviations or decimals."""
    protected = re.sub(r"(?<=\d)[.](?=\d)", "\x00", text)
    for index, abbreviation in enumerate(_ABBREVIATIONS):
        token = f"\x01{index}\x01"
        protected = re.sub(re.escape(abbreviation), token, protected, flags=re.IGNORECASE)
    parts = _SENTENCE_END.split(protected)
    restored = [
        re.sub(r"\x01(\d+)\x01", lambda m: _ABBREVIATIONS[int(m.group(1))], part)
        .replace("\x00", ".")
        .strip()
        for part in parts
    ]

    # **A citation follows the claim it supports.** Splitting leaves two shapes
    # that broke that rule, and both reject an answer that cited correctly — the
    # failure mode that matters most, because it looks like a broken feature
    # rather than a broken guard.
    #
    #   `…solves the problem. [E1]`  → the marker lands in a fragment of its own
    #   `Claim one. [E1] Claim two.` → the marker lands at the head of the *next*
    #                                  sentence, which is not what it cites
    #
    # So a marker that sits before a sentence's first word moves back to the
    # previous one. A marker at the very start of the answer stays where it is.
    # A genuine trailing bibliography still fails: its markers land on the last
    # sentence, and the claims before it stay bare.
    merged: list[str] = []
    for part in restored:
        if not part:
            continue
        if _MARKERS_ONLY.match(part) and merged:
            merged[-1] = f"{merged[-1]} {part}"
            continue
        leading = _LEADING_MARKERS.match(part)
        if leading and merged:
            merged[-1] = f"{merged[-1]} {leading.group(0).strip()}"
            part = part[leading.end() :].strip()
            if not part:
                continue
        merged.append(part)
    return merged


def claim_sentences(text: str) -> list[str]:
    """The sentences that assert something about the paper."""
    return [
        sentence
        for sentence in split_sentences(text)
        if claim_weight(sentence) >= MIN_CLAIM_CHARS and any(ch.isalpha() for ch in sentence)
    ]


def anchors(text: str) -> list[str]:
    """The checkable tokens in ``text``: numbers and digit-bearing identifiers.

    Markers are stripped first, and that is not a detail: `E1` matches the
    identifier pattern, so leaving them in makes every correctly cited sentence
    cite evidence that does not contain "E1" — an answer rejected for its own
    citations.
    """
    body = MARKER_RE.sub(" ", text)
    found = _NUMBER.findall(body) + _IDENTIFIER.findall(body)
    return [token for token in found if token]


def _canonical(token: str) -> str:
    """Fold a number so `1,000` and `1000` compare equal."""
    return token.replace(",", "").casefold()


def _haystack(texts: list[str]) -> str:
    """One normalized blob, so an anchor can be looked for across all citations.

    Commas are stripped so a source `0.05` matches an answer's `0.05`, and a
    source `1,000` matches an answer's `1000`.
    """
    return " ".join(normalize_for_matching(text) for text in texts).replace(",", "")


def unknown_markers(answer: str, valid_ids: set[str]) -> list[str]:
    """Markers naming evidence that is not in this bundle."""
    return dedupe_in_order(
        [marker for marker in extract_markers(answer) if marker not in valid_ids]
    )


def grounding_problems(
    answer: str, texts_by_marker: dict[str, list[str]]
) -> list[str]:
    """Every reason the answer is not grounded, phrased so the model can fix it.

    ``texts_by_marker`` maps a marker to the text of the evidence it cites. A
    sentence with no marker is a problem; a sentence whose numbers or identifiers
    appear in none of its cited evidence is a problem too.
    """
    problems: list[str] = []

    for sentence in claim_sentences(answer):
        markers = dedupe_in_order(extract_markers(sentence))
        if not markers:
            problems.append(
                "This sentence makes a claim but cites nothing: "
                f"{sentence[:160]!r}. Add the marker for the evidence that supports "
                "it, or remove the sentence."
            )
            continue

        haystack = _haystack(
            [text for marker in markers for text in texts_by_marker.get(marker, [])]
        )
        missing = [
            token for token in anchors(sentence) if _canonical(token) not in haystack
        ]
        if missing:
            problems.append(
                f"This sentence cites {markers} but {'/'.join(missing[:6])} does not "
                f"appear in that evidence: {sentence[:160]!r}. Either cite the "
                "evidence that contains it, or remove the claim."
            )

    return problems


def snippet_of(text: str, limit: int = 400) -> str:
    """A verbatim prefix of ``text``, cut at a sentence boundary where possible.

    A prefix, never a rewrite: an excerpt the model produced would be a quotation
    the paper does not contain. Cutting at a boundary keeps the fragment readable
    instead of ending mid-word.
    """
    stripped = text.strip()
    if len(stripped) <= limit:
        return stripped
    window = stripped[:limit]
    for boundary in (". ", "。", "! ", "? ", "; ", ", ", " "):
        index = window.rfind(boundary)
        if index > limit // 2:
            return window[: index + len(boundary)].strip()
    return window.strip()


def _block_boxes(ir: DocumentIR) -> dict[str, list[float]]:
    """Every block's bounding box, by block id."""
    return {
        block.id: list(block.bbox)
        for page in ir.pages
        for block in page.blocks
    }


def resolve(
    citation_ids: list[str], items: list[EvidenceItem], ir: DocumentIR
) -> list[ResolvedCitation]:
    """Join markers against the bundle and the IR, in first-appearance order.

    Everything the frontend needs to jump to a source is attached here, so the
    browser never has to walk the document structure to find a rectangle.
    """
    by_marker = {item.id: item for item in items}
    boxes = _block_boxes(ir)

    resolved: list[ResolvedCitation] = []
    for marker in dedupe_in_order(citation_ids):
        item = by_marker.get(marker)
        if item is None:
            continue
        # Paired rather than filtered independently: a block id with no box in the
        # IR would otherwise make the two lists different lengths, and a citation
        # whose geometry is half-present is worse than one that is honestly short.
        pairs = [(bid, boxes[bid]) for bid in item.block_ids if bid in boxes]
        resolved.append(
            ResolvedCitation(
                citation_id=marker,
                paragraph_id=item.paragraph_id,
                section_id=item.section_id,
                section_title=item.section_title,
                page_number=item.page_number,
                page_range=list(item.page_range),
                block_ids=[bid for bid, _ in pairs],
                bboxes=[box for _, box in pairs],
                snippet=snippet_of(item.text),
                is_caption=item.is_caption,
            )
        )
    return resolved
