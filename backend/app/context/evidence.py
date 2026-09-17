"""Checking that what the model claims came from the paper actually did.

A model asked to cite its sources will cite them, and will occasionally cite
paragraphs that do not exist or quote sentences it composed itself. Both are
worse than an omission, because both look like evidence.

Two checks, in order of strength:

* **Paragraph ids must exist in the IR.** This is the load-bearing one. An id
  either names a paragraph in this document or it does not, and there is no way
  to be approximately right about it.
* **A quoted snippet must appear in the text of one of the cited paragraphs.**
  Secondary, and deliberately lenient: models normalise whitespace, hyphens and
  dashes, so a strict equality test would reject honest quotations while doing
  nothing to stop a determined fabrication. Snippets are optional; ids are not.

What this cannot do is check whether the model *understood* the paper. It checks
that the model did not invent its evidence, which is the part that can be
verified mechanically.
"""

from __future__ import annotations

import re
import unicodedata

#: Collapses every kind of whitespace, so a quotation that differs only in
#: spacing still matches.
_WHITESPACE = re.compile(r"\s+")

#: Dash and quote variants a model may substitute for the ones in the source.
_DASHES = str.maketrans({"—": "-", "–": "-", "−": "-", "‐": "-", "‑": "-"})


class AnalysisValidationError(Exception):
    """Model output that cannot be accepted, with a code the API can report."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def normalize_for_matching(text: str) -> str:
    """Fold text to a form where honest variation does not look like invention."""
    folded = unicodedata.normalize("NFKC", text).translate(_DASHES)
    return _WHITESPACE.sub(" ", folded).strip().casefold()


class EvidenceValidator:
    """Validates citations against the document they claim to come from."""

    def __init__(self, paragraph_texts: dict[str, str]) -> None:
        self._texts = paragraph_texts
        self._normalized = {
            paragraph_id: normalize_for_matching(text)
            for paragraph_id, text in paragraph_texts.items()
        }
        #: How many ids were dropped across the run. Reported rather than
        #: silently swallowed: a model citing many nonexistent ids is a signal
        #: that the prompt or the model is wrong, not just noise to filter.
        self.dropped_ids = 0

    def known(self, paragraph_id: str) -> bool:
        return paragraph_id in self._texts

    def text_of(self, paragraph_id: str) -> str:
        """The source text of a paragraph, or an empty string if unknown."""
        return self._texts.get(paragraph_id, "")

    def filter_ids(self, paragraph_ids: list[str]) -> list[str]:
        """Keep the ids that name a real paragraph, in order, without repeats."""
        kept: list[str] = []
        for paragraph_id in paragraph_ids:
            if not isinstance(paragraph_id, str):
                self.dropped_ids += 1
                continue
            if paragraph_id in kept:
                continue
            if paragraph_id not in self._texts:
                self.dropped_ids += 1
                continue
            kept.append(paragraph_id)
        return kept

    def snippet_is_supported(self, snippet: str, paragraph_ids: list[str]) -> bool:
        """Whether ``snippet`` really occurs in one of the cited paragraphs."""
        if not snippet or not snippet.strip():
            return True  # nothing claimed, nothing to check

        needle = normalize_for_matching(snippet)
        if len(needle) < 8:
            # Too short to be evidence of anything, and short fragments match by
            # accident. Treated as absent rather than as a fabrication.
            return True

        for paragraph_id in paragraph_ids:
            haystack = self._normalized.get(paragraph_id)
            if haystack and needle in haystack:
                return True
        return False
