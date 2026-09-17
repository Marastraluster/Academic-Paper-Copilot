"""Associating an upstream translation unit with a canonical IR paragraph.

The two segmentations do not correspond. Upstream builds a unit by grouping
characters the layout model marked as one region; the IR builds a paragraph by
joining prose blocks that continue each other. On the paper this was measured
against, 12 pages produced **149 translation units and 101 IR paragraphs**.

And the unit arrives as **text only** — `translate(text)` is handed a string with
no page, no bounding box, no id. So the association has to be recovered from the
text itself.

Two rules make that safe rather than merely plausible:

* **Only text survives, so only text is compared** — but placeholders are removed
  first, because `{v26}` is upstream's stand-in for a reference and appears
  nowhere in the IR.
* **Ambiguity is a result, not a failure.** A unit that matches two paragraphs
  equally well is not assigned one of them. Short strings repeat across a paper —
  a heading, a caption fragment, "Introduction" — and picking whichever came
  first would attach one section's summary and neighbours to another section's
  sentence. Wrong context is worse than none, so the mapper returns `None` and
  the translator falls back honestly.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.document.models import DocumentIR

#: Placeholders are upstream's stand-ins for formulas and references. They
#: appear in units and never in IR text, so leaving them in would depress every
#: score that bit further below the threshold.
_PLACEHOLDER = re.compile(r"\{v\d+\}")

#: Anything not a letter or digit is separational. Hyphens and whitespace differ
#: freely between the two segmentations because upstream rejoins lines its own
#: way, and none of that changes what the sentence says.
_NOT_WORD = re.compile(r"[^\w]+", re.UNICODE)

#: A match must cover this much of the unit. Below it, the two texts are
#: plausibly related but not the same passage, and the context attached would be
#: a guess wearing a paragraph id.
MIN_SCORE = 0.80

#: Units shorter than this cannot be matched reliably whatever their score: a
#: three-word fragment occurs in several places in any paper. An explicit floor
#: is more honest than letting a high score on a tiny string look like confidence.
MIN_UNIT_CHARS = 40


def normalize(text: str) -> str:
    """Fold a translation unit or a paragraph to a comparable form.

    Removes placeholders, reduces every run of non-word characters to a single
    space, and case-folds. Deliberately does **not** stem or synonymise: the
    question is whether these are the same passage, not whether they are about
    the same thing.
    """
    without_markers = _PLACEHOLDER.sub(" ", text)
    return _NOT_WORD.sub(" ", without_markers).strip().casefold()


#: Categorical confidence. Deliberately not a decimal: `0.83` implies a
#: calibration nobody has performed, and a threshold on it would be a number
#: chosen for looks. What is defensible is the *kind* of evidence.
EXACT = "EXACT"           # the unit is a literal substring of the paragraph
NORMALIZED = "NORMALIZED"  # it matches after folding placeholders and whitespace
FALLBACK = "FALLBACK"     # resolved, but context could not be assembled
UNMAPPED = "UNMAPPED"     # not resolved, and no context will be attached

#: Why a unit did not resolve. Mutually exclusive, and each names something a
#: different fix would address — which is the point of classifying them rather
#: than reporting one number.
TOO_SHORT = "UNIT_TOO_SHORT"
BELOW_THRESHOLD = "BELOW_SCORE_THRESHOLD"
DUPLICATE_TEXT = "DUPLICATE_SOURCE_TEXT"
NO_CORRESPONDENCE = "NO_IR_CORRESPONDENCE"
NO_PARAGRAPHS = "NO_IR_PARAGRAPHS"


@dataclass(frozen=True)
class Mapping:
    """The outcome of matching one unit."""

    paragraph_id: str | None
    score: float
    #: Categorical, never a decimal gate. See the constants above.
    confidence: str = UNMAPPED
    #: One of the cause constants when unresolved, otherwise ``None``.
    cause: str | None = None
    #: Human-readable detail. Not used for any decision.
    reason: str | None = None

    @property
    def resolved(self) -> bool:
        return self.paragraph_id is not None


class UnitMapper:
    """Matches translation units to the paragraphs of one document."""

    def __init__(self, ir: DocumentIR) -> None:
        self._ir = ir
        self._paragraphs: list[tuple[str, str]] = []
        # The IR's own reading order is preserved, so a tie is broken by
        # position only where the criterion says it may be — and it does not.
        for paragraph in ir.paragraphs:
            normalized = normalize(paragraph.text)
            if normalized:
                self._paragraphs.append((paragraph.id, normalized))

    def match(self, unit_text: str) -> Mapping:
        """Find the IR paragraph this unit is, or say that it cannot be found."""
        unit = normalize(unit_text)
        if len(unit) < MIN_UNIT_CHARS:
            return Mapping(None, 0.0, cause=TOO_SHORT,
                           reason="unit too short to match reliably")
        if not self._paragraphs:
            return Mapping(None, 0.0, cause=NO_PARAGRAPHS,
                           reason="document has no paragraphs")

        best_score = 0.0
        best: list[str] = []

        for paragraph_id, paragraph in self._paragraphs:
            score = self._score(unit, paragraph)
            if score > best_score:
                best_score, best = score, [paragraph_id]
            elif score == best_score and score > 0.0:
                best.append(paragraph_id)

        if best_score < MIN_SCORE:
            return Mapping(None, best_score, cause=BELOW_THRESHOLD,
                           reason="no paragraph matched closely enough")
        if len(best) > 1:
            # Equally good candidates. Which one is "right" is not knowable from
            # the text, so none is chosen.
            return Mapping(None, best_score, cause=DUPLICATE_TEXT,
                           reason=f"ambiguous: {len(best)} equally good matches")

        confidence = EXACT if best_score == 1.0 else NORMALIZED
        return Mapping(best[0], best_score, confidence=confidence)

    @staticmethod
    def _score(unit: str, paragraph: str) -> float:
        """How much of the unit the paragraph contains.

        Containment first, because upstream's unit is usually a subset of the IR
        paragraph's characters and an exact substring test is both the strongest
        evidence and the cheapest. Where it does not hold — the two segmentations
        split a sentence differently — a token-overlap ratio gives a bounded,
        order-insensitive estimate.
        """
        if unit in paragraph:
            return 1.0
        if paragraph in unit:
            # The unit is a superset: still the same passage, but the IR
            # paragraph does not account for all of it. Scored by how much of the
            # *unit* the paragraph explains.
            return len(paragraph) / len(unit)

        unit_tokens = set(unit.split())
        if not unit_tokens:
            return 0.0
        paragraph_tokens = set(paragraph.split())
        shared = unit_tokens & paragraph_tokens
        return len(shared) / len(unit_tokens)
