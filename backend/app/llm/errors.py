"""Normalised provider errors (AC-12 … AC-22, AC-29).

Callers must never see an `openai.*` exception, an HTTP status code, or a
primitive `AttributeError` from response parsing. Everything that can go wrong
funnels into one of these types, each carrying:

* ``code``       — stable, machine-readable, safe to match on
* ``retryable``  — whether a later retry layer may re-issue the request
* ``cause``      — the original exception, kept for local debugging only

Every message is sanitised. Upstream SDK text is passed through
``redact_text``, and the provider's own key literal is stripped outright — the
latter matters because ``redact_text`` only recognises ``Bearer <token>`` and
``key=value`` shapes, and an unanchored key would otherwise survive.
"""

from __future__ import annotations

import asyncio

import openai

from app.logging import REDACTED, redact_text


def sanitize_message(text: str, api_key: str | None = None) -> str:
    """Strip credential-shaped content, and the known key, from ``text``."""
    cleaned = redact_text(text)
    if api_key:
        cleaned = cleaned.replace(api_key, REDACTED)
    return cleaned


class LLMError(Exception):
    """Base class for every failure raised by the LLM layer."""

    code: str = "LLM_ERROR"
    retryable: bool = False

    def __init__(self, message: str, *, cause: BaseException | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.cause = cause


# --- Not retryable ----------------------------------------------------------


class LLMAuthenticationError(LLMError):
    code = "LLM_AUTHENTICATION_ERROR"
    retryable = False


class LLMPermissionDeniedError(LLMError):
    code = "LLM_PERMISSION_DENIED"
    retryable = False


class LLMBadRequestError(LLMError):
    code = "LLM_BAD_REQUEST"
    retryable = False


class LLMNotFoundError(LLMError):
    """Upstream returned 404 — usually an unknown model or a wrong base URL."""

    code = "LLM_NOT_FOUND"
    retryable = False


class LLMInvalidResponseError(LLMError):
    """The provider answered, but not with a usable completion."""

    code = "LLM_INVALID_RESPONSE"
    retryable = False


# --- Retryable --------------------------------------------------------------


class LLMRateLimitError(LLMError):
    code = "LLM_RATE_LIMIT"
    retryable = True


class LLMTimeoutError(LLMError):
    code = "LLM_TIMEOUT"
    retryable = True


class LLMConnectionError(LLMError):
    code = "LLM_CONNECTION_ERROR"
    retryable = True


class LLMServerError(LLMError):
    code = "LLM_SERVER_ERROR"
    retryable = True


# --- Catch-all --------------------------------------------------------------


class LLMAPIError(LLMError):
    """Fallback for an SDK error with no more specific mapping.

    Retryability is inferred from the HTTP status when one is available: a 5xx
    is worth retrying, anything else is not assumed safe to repeat.
    """

    code = "LLM_API_ERROR"

    def __init__(
        self,
        message: str,
        *,
        cause: BaseException | None = None,
        retryable: bool = False,
    ) -> None:
        super().__init__(message, cause=cause)
        self.retryable = retryable


def _status_of(exc: BaseException) -> int | None:
    status = getattr(exc, "status_code", None)
    return status if isinstance(status, int) else None


def normalize_exception(exc: BaseException, *, api_key: str | None = None) -> LLMError:
    """Translate any exception into an :class:`LLMError`.

    ``api_key`` is the provider's own key, used to strip that exact literal from
    the message. It is never included in the output.
    """
    if isinstance(exc, LLMError):
        return exc

    message = sanitize_message(str(exc), api_key) or exc.__class__.__name__

    # Order matters. `APITimeoutError` derives from `APIConnectionError`, and the
    # status-carrying errors all derive from `APIStatusError`, so the most
    # specific types are matched first.
    if isinstance(exc, openai.APIResponseValidationError):
        return LLMInvalidResponseError(message, cause=exc)

    if isinstance(exc, (openai.APITimeoutError, asyncio.TimeoutError, TimeoutError)):
        return LLMTimeoutError(message, cause=exc)

    if isinstance(exc, openai.APIConnectionError):
        return LLMConnectionError(message, cause=exc)

    if isinstance(exc, openai.AuthenticationError):
        return LLMAuthenticationError(message, cause=exc)

    if isinstance(exc, openai.PermissionDeniedError):
        return LLMPermissionDeniedError(message, cause=exc)

    if isinstance(exc, openai.RateLimitError):
        return LLMRateLimitError(message, cause=exc)

    if isinstance(exc, openai.NotFoundError):
        return LLMNotFoundError(message, cause=exc)

    if isinstance(exc, (openai.BadRequestError, openai.UnprocessableEntityError)):
        return LLMBadRequestError(message, cause=exc)

    if isinstance(exc, openai.InternalServerError):
        return LLMServerError(message, cause=exc)

    if isinstance(exc, openai.APIStatusError):
        status = _status_of(exc)
        if status is not None and status >= 500:
            return LLMServerError(message, cause=exc)
        return LLMAPIError(message, cause=exc, retryable=False)

    if isinstance(exc, openai.APIError):
        status = _status_of(exc)
        return LLMAPIError(
            message, cause=exc, retryable=status is not None and status >= 500
        )

    # Anything else: an unexpected failure inside this layer or the SDK. Wrapped
    # so callers never have to reason about foreign exception types, and so no
    # primitive error escapes (FC-07).
    return LLMAPIError(message, cause=exc, retryable=False)
