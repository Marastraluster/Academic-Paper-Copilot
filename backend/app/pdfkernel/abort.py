"""The signal that escapes upstream's unbounded retry loop.

Upstream wraps its per-paragraph worker in ``@retry(wait=wait_fixed(1))`` with no
stop condition, so any ``Exception`` raised from a translation is retried
forever. tenacity's default predicate catches ``Exception`` — and *not*
``BaseException``.

So the only way to break the loop without editing upstream is to raise something
that is not an ``Exception``. :class:`TranslationAbortSentinel` is exactly that,
and nothing more: it carries the normalised provider error and exists purely to
travel from the translator, through tenacity, through upstream's re-raise, and
out to our adapter — which converts it into a proper failure.

**This type must never escape** :mod:`app.pdfkernel`. Callers see an
:class:`~app.pdfkernel.errors.PDFKernelError`, which *is* an ``Exception``.

No upstream import here on purpose: importing this module must stay cheap, so
that ``import app.pdfkernel`` does not drag in the PDF stack.
"""

from __future__ import annotations


class TranslationAbortSentinel(BaseException):
    """Escape hatch for a terminal provider failure.

    Deliberately inherits from ``BaseException`` rather than ``Exception``: that
    is the entire mechanism. See the module docstring.
    """

    def __init__(self, error: BaseException | None = None) -> None:
        super().__init__(str(error) if error is not None else "translation aborted")
        self.error = error
