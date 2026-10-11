"""Keep inline formulas out of a translator's hands.

A paragraph parsed by MinerU carries its inline math as ``$…$`` LaTeX. Sent as
is, a model "translates" it: it rewrites ``$\\mathcal{F}(x)$`` as prose, drops a
brace, or turns ``$W_i$`` into ``$W_{i}$`` — and the reader gets a formula that
renders as something the authors never wrote. So each formula is swapped for an
opaque placeholder before the paragraph is sent, and swapped back after.

The placeholders are checked on the way back: every one must return **exactly
once**. A translation that lost one has lost a formula, and one that repeats or
invents one has made one up; either way it is rejected and the paragraph is
reported untranslated rather than shown wrong — the same rule the pipeline
applies to a missing paragraph id.
"""

from __future__ import annotations

import re

#: ``$…$`` not preceded by a backslash, and not ``$$`` (display math never
#: appears inside a paragraph; a stray ``$$`` is left alone).
_INLINE_MATH = re.compile(r"(?<![\\$])\$(?!\$)((?:\\.|[^$\\])+?)\$(?!\$)")

#: Brackets a model has no reason to translate or reflow, with an index.
_TOKEN = "⟦m{0}⟧"
_TOKEN_PATTERN = re.compile(r"⟦\s*m\s*(\d+)\s*⟧")


def protect(text: str) -> tuple[str, list[str]]:
    """``text`` with each inline formula replaced, and the formulas in order."""
    formulas: list[str] = []

    def swap(match: re.Match[str]) -> str:
        formulas.append(match.group(0))
        return _TOKEN.format(len(formulas))

    return _INLINE_MATH.sub(swap, text), formulas


def restore(translated: str, formulas: list[str]) -> str | None:
    """Put the formulas back, or ``None`` if any went missing or multiplied."""
    if not formulas:
        return None if _TOKEN_PATTERN.search(translated) else translated
    found = [int(match.group(1)) for match in _TOKEN_PATTERN.finditer(translated)]
    if sorted(found) != list(range(1, len(formulas) + 1)):
        return None
    return _TOKEN_PATTERN.sub(lambda m: formulas[int(m.group(1)) - 1], translated)
