"""A translator with a finite retry budget, injected into upstream.

Upstream constructs its translator from the service name, so the only way to
supply our own without editing upstream is to substitute the class on the module
it imports from (``pdf2zh.converter``). That substitution is performed by the
adapter, lazily and once.

Two responsibilities:

* **Bound the retries.** Upstream wraps the call in an unbounded retry; this
  class does its own bounded retrying instead, and signals terminal failure with
  :class:`~app.pdfkernel.abort.TranslationAbortSentinel` — a ``BaseException``
  that upstream's retry predicate does not catch.
* **Fail the document fast.** The first terminal failure sets an abort flag on
  the instance. Every later paragraph sees it and gives up without issuing a
  request, so a provider outage costs a handful of calls rather than
  ``attempts x paragraphs``.

The abort flag is *instance* state, and upstream builds one translator per
document — so it is document-scoped by construction, and concurrent translations
stay isolated.

Loaded lazily: importing this module pulls in the upstream stack, which
``import app.pdfkernel`` must not do.
"""

from __future__ import annotations

import threading
import time

from pdf2zh.translator import OpenAIlikedTranslator

from app.llm.errors import normalize_exception, sanitize_message
from app.pdfkernel.abort import TranslationAbortSentinel

#: Captures the translator instance built for the current translation, so the
#: adapter can inspect it afterwards. Thread-local because upstream builds it on
#: the worker thread running the translation.
_current = threading.local()


def current_translator() -> BoundedOpenAIlikedTranslator | None:
    """The translator most recently constructed on this thread, if any."""
    return getattr(_current, "instance", None)


class BoundedOpenAIlikedTranslator(OpenAIlikedTranslator):
    """OpenAI-compatible translator with a finite retry budget."""

    #: Total attempts for a retryable error (1 initial + retries). Class-level so
    #: tests can zero the backoff without sleeping.
    RETRYABLE_ATTEMPTS = 3

    #: Sleep after each failed attempt, before the next.
    BACKOFF_SECONDS = (1.0, 2.0)

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)

        # Upstream builds its OpenAI client without `max_retries`, so the SDK's
        # default of 2 applies *inside* each of our attempts — turning a budget
        # of 3 into 9 HTTP requests. Our own provider adapters disable silent
        # retries for the same reason: the layer that owns the policy should be
        # the only layer retrying.
        try:
            self.client = self.client.with_options(max_retries=0)
        except Exception:  # noqa: BLE001 - an SDK without with_options is not fatal
            pass

        self._abort_lock = threading.Lock()
        self._terminal_error: BaseException | None = None
        self._aborted = False
        _current.instance = self

    # -- state --------------------------------------------------------------

    @property
    def terminal_error(self) -> BaseException | None:
        """The error that stopped this translation, if one did."""
        return self._terminal_error

    def _abort(self, error: BaseException) -> None:
        """Record the first terminal failure. Later ones do not overwrite it."""
        with self._abort_lock:
            if self._terminal_error is None:
                self._terminal_error = error
            self._aborted = True

    def _api_key(self) -> str | None:
        return (self.envs or {}).get("OPENAILIKED_API_KEY") or None

    @staticmethod
    def _sleep(seconds: float) -> None:
        if seconds > 0:
            time.sleep(seconds)

    # -- the contract upstream calls ----------------------------------------

    def translate(self, text: str, ignore_cache: bool = False) -> str:
        """Translate one paragraph, within a bounded budget.

        Raises :class:`TranslationAbortSentinel` on terminal failure. That is a
        ``BaseException`` on purpose — see :mod:`app.pdfkernel.abort`.
        """
        if self._aborted:
            # Another paragraph already failed this document. Make no request.
            raise TranslationAbortSentinel(self._terminal_error)

        last_error: BaseException | None = None

        for attempt in range(1, self.RETRYABLE_ATTEMPTS + 1):
            try:
                return super().translate(text, ignore_cache=ignore_cache)
            except TranslationAbortSentinel:
                raise
            except Exception as exc:  # noqa: BLE001 - classified immediately below
                normalized = normalize_exception(exc, api_key=self._api_key())
                last_error = normalized

                if not normalized.retryable:
                    # 401/403/400/404/invalid model: retrying cannot help.
                    self._abort(normalized)
                    raise TranslationAbortSentinel(normalized) from exc

                if attempt < self.RETRYABLE_ATTEMPTS:
                    self._sleep(self.BACKOFF_SECONDS[attempt - 1])
                    if self._aborted:  # set by another paragraph while we slept
                        raise TranslationAbortSentinel(self._terminal_error)

        # Budget exhausted on a retryable error.
        self._abort(last_error)
        raise TranslationAbortSentinel(last_error)

    # -- diagnostics --------------------------------------------------------

    def failure_message(self) -> str:
        """A sanitised, user-safe description of why this translation stopped."""
        error = self._terminal_error
        if error is None:
            return "Translation failed."
        message = getattr(error, "message", None) or str(error)
        return sanitize_message(f"Provider call failed: {message}", self._api_key())
