"""Formula placeholders: what they look like, and whether they survived.

Upstream replaces every formula, and every rich-text span, with a marker before
asking a model to translate, then substitutes the real content back. A marker
that goes missing, or that is duplicated, or invented, produces a PDF whose
formulas are silently wrong — which the project's standing principle ranks worse
than an untranslated paragraph.

## The format is `{vN}`, single-brace, and that is not what the source suggests

`OpenAIlikedTranslator.get_formular_placeholder()` returns `"{{v" + id + "}}"` —
double braces — and the base class uses `<bN>` / `</bN>` rich-text tags. Both are
**dead code for this path**. The marker that reaches the model is built by the
converter:

    converter.py:275,334    sstk[-1] += f"{{v{len(var)}}}"

and inside an f-string `{{` and `}}` are escapes, so this evaluates to `{v` + n +
`}`. Captured from a real run, the text handed to the model reads:

    "...Deeply- supervised nets. {v26}, 2014. [25] M. Lin... {v27}..."

A validator written from the accessor would reject every valid translation and
pass every broken one. Verified two independent ways — by capture, and by the
f-string's own semantics.
"""

from __future__ import annotations

import re
from collections import Counter

#: The marker as it actually appears. Single brace, `v`, digits.
PLACEHOLDER_PATTERN = re.compile(r"\{v\d+\}")

#: Shapes that look like markers but are not. Kept so a validator can say *what*
#: it saw rather than only that something was wrong — a model that rewrote `{v0}`
#: as `{{v0}}` has made one specific, fixable mistake.
_DOUBLE_BRACE = re.compile(r"\{\{v\d+\}\}")
_TAG_BRACE = re.compile(r"</?b\d+>")


def extract(text: str) -> list[str]:
    """Every placeholder in ``text``, in order of appearance."""
    return PLACEHOLDER_PATTERN.findall(text)


def counts(text: str) -> Counter[str]:
    """Placeholders as a multiset — identity *and* multiplicity."""
    return Counter(extract(text))


def looks_rewritten(text: str) -> str | None:
    """Describe a marker-like shape that is not the real one, if any.

    Used to make a repair instruction specific: telling a model "you wrote
    ``{{v0}}``, it must be ``{v0}``" is far more likely to be obeyed than
    "placeholders were wrong".
    """
    double = _DOUBLE_BRACE.search(text)
    if double:
        return f"{double.group(0)!r} should be single-braced, e.g. {double.group(0)[1:-1]!r}"
    tag = _TAG_BRACE.search(text)
    if tag:
        return f"{tag.group(0)!r} is not a placeholder in this pipeline"
    return None


class PlaceholderMismatch(Exception):
    """The translation's placeholders do not match the source's."""

    def __init__(self, message: str, *, missing: list[str], extra: list[str]) -> None:
        super().__init__(message)
        self.message = message
        self.missing = missing
        self.extra = extra

    @property
    def repair_hint(self) -> str:
        parts = []
        if self.missing:
            parts.append(f"Missing placeholders: {sorted(set(self.missing))}")
        if self.extra:
            parts.append(f"Placeholders that must not appear: {sorted(set(self.extra))}")
        return "\n".join(parts)


def validate(source: str, translation: str) -> None:
    """Raise :class:`PlaceholderMismatch` unless the multisets are identical.

    Multiplicity matters, not just presence: a model that emits `{v3}` twice
    where the source had it once has duplicated a formula, and the renderer will
    place the same equation in two positions. Counting is the only check that
    catches it.
    """
    # A marker rewritten into another shape is rejected outright, before any
    # counting. `{{v0}}` *contains* `{v0}` as a substring, so a multiset
    # comparison would pass it while the renderer, which substitutes on the
    # single-brace form, would leave the marker sitting in the PDF as literal
    # text. Counting alone cannot see this; shape can.
    rewritten = looks_rewritten(translation)
    if rewritten:
        raise PlaceholderMismatch(
            f"The translation contains a malformed placeholder: {rewritten}",
            missing=[],
            extra=[],
        )

    expected = counts(source)
    produced = counts(translation)

    if expected == produced:
        return

    missing: list[str] = []
    for placeholder, needed in expected.items():
        shortfall = needed - produced.get(placeholder, 0)
        missing.extend([placeholder] * max(0, shortfall))

    extra: list[str] = []
    for placeholder, surplus in produced.items():
        excess = surplus - expected.get(placeholder, 0)
        extra.extend([placeholder] * max(0, excess))

    detail = []
    if missing:
        detail.append(f"missing {sorted(set(missing))}")
    if extra:
        detail.append(f"unexpected {sorted(set(extra))}")
    rewritten = looks_rewritten(translation)
    if rewritten:
        detail.append(rewritten)

    raise PlaceholderMismatch(
        "The translation's placeholders do not match the source: " + "; ".join(detail),
        missing=missing,
        extra=extra,
    )
