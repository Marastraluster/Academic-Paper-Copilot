"""OpenAI-compatible Responses adapter (``POST /v1/responses``).

The second implementation of :class:`~app.llm.base.LLMProvider`. That it reuses
the DS-BE-002 request models, result type, error taxonomy and configuration
**without altering any of them** is the point of this task: it demonstrates the
abstraction is real rather than Chat-Completions-shaped in disguise.

Where Responses genuinely differs from Chat Completions, the difference is
absorbed here so callers never see it:

===========================  ==============================  ====================
Concept                      Chat Completions                Responses
===========================  ==============================  ====================
Token limit parameter        ``max_tokens``                  ``max_output_tokens``
Token accounting             ``prompt_tokens``               ``input_tokens``
                             ``completion_tokens``           ``output_tokens``
System prompt                a ``system`` message            ``instructions``
Output text                  ``choices[0].message.content``  ``output_text``
===========================  ==============================  ====================

Both adapters return the same :class:`~app.llm.models.LLMResult` and raise the
same error types with the same codes.
"""

from __future__ import annotations

import time
from typing import Any

from openai import AsyncOpenAI

from app.llm.base import LLMProvider
from app.llm.client import (
    KEYLESS_API_KEY_PLACEHOLDER,
    PROBE_MAX_TOKENS,
    PROBE_PROMPT,
)
from app.llm.client import build_client as _build_client
from app.llm.errors import (
    LLMAPIError,
    LLMBadRequestError,
    LLMError,
    LLMInvalidResponseError,
    LLMOutputTruncatedError,
    LLMRateLimitError,
    LLMServerError,
    LLMTimeoutError,
    normalize_exception,
    sanitize_message,
)
from app.llm.models import (
    ConnectionReport,
    LLMRequest,
    LLMResult,
    LLMUsage,
    ProviderConfig,
)

#: Failure codes a Responses payload may carry in ``error.code``. Responses
#: reports some failures *in-band* (HTTP 200 with ``status="failed"``) rather than
#: as an HTTP error, so they never reach :func:`normalize_exception` and need
#: their own mapping. The sets are explicit so the mapping is deterministic
#: rather than depending on which codes happen to be listed in a spec.
_SERVER_ERROR_CODES = frozenset({"server_error"})
_RATE_LIMIT_CODES = frozenset({"rate_limit_exceeded"})
#: Client-side / policy failures that re-issuing the request cannot fix.
_BAD_REQUEST_CODES = frozenset(
    {
        "invalid_prompt",
        "data_residency_mismatch",
        "bio_policy",
        "misalignment_policy_violation",
        "invalid_image",
        "invalid_image_format",
        "invalid_base64_image",
        "invalid_image_url",
        "image_too_large",
        "image_too_small",
        "invalid_image_mode",
        "unsupported_image_media_type",
        "empty_image_file",
        "image_file_not_found",
        "failed_to_download_image",
    }
)


def build_responses_client(config: ProviderConfig) -> AsyncOpenAI:
    """Construct the SDK client for this adapter.

    Resolves ``AsyncOpenAI`` from *this* module so tests can substitute it here
    independently of the Chat Completions adapter.
    """
    return _build_client(config, AsyncOpenAI)


class OpenAIResponsesProvider(LLMProvider):
    """Responses API for any endpoint that implements it."""

    protocol = "responses"

    def __init__(self, config: ProviderConfig, *, client: Any | None = None) -> None:
        self._config = config
        # Injectable so tests never touch the network.
        self._client = client if client is not None else build_responses_client(config)

    @property
    def config(self) -> ProviderConfig:
        """Safe to repr — the key is a ``SecretStr``."""
        return self._config

    # -- public contract ----------------------------------------------------

    async def generate(self, request: LLMRequest) -> LLMResult:
        payload = self._build_payload(request)

        try:
            response = await self._client.responses.create(**payload)
        except LLMError:
            raise
        except Exception as exc:
            # `except Exception` cannot swallow asyncio.CancelledError, which
            # derives from BaseException — cancellation propagates untouched.
            raise normalize_exception(
                exc, api_key=self._config.api_key.get_secret_value()
            ) from exc

        return self._to_result(response)

    async def test_connection(self) -> ConnectionReport:
        """Cheap probe: does this endpoint accept our key and model?"""
        request = LLMRequest(
            messages=[{"role": "user", "content": PROBE_PROMPT}],
            max_output_tokens=PROBE_MAX_TOKENS,
        )
        started = time.perf_counter()

        try:
            result = await self.generate(request)
        except LLMOutputTruncatedError:
            # The endpoint answered in the right schema and was cut off by the
            # one-token probe budget — which is what a reasoning model does.
            # Speaking the protocol is the question a probe asks, and it did.
            return ConnectionReport(
                ok=True,
                latency_ms=(time.perf_counter() - started) * 1000.0,
                message=(
                    "Connection successful. The probe returned no text within one "
                    "token — expected for a reasoning model, whose thinking is "
                    "counted against the output budget."
                ),
                model=self._config.model,
            )
        except LLMError as exc:
            return ConnectionReport(ok=False, latency_ms=None, message=f"{exc.code}: {exc.message}")

        return ConnectionReport(
            ok=True,
            latency_ms=(time.perf_counter() - started) * 1000.0,
            message="Connection successful",
            model=result.model,
        )

    # -- internals ----------------------------------------------------------

    def _build_payload(self, request: LLMRequest) -> dict[str, Any]:
        """Map a protocol-neutral request onto Responses parameters."""
        # Responses has no `system` role: system turns become `instructions`.
        # Multiple system messages are joined rather than last-wins, because
        # silently discarding earlier instructions would change the caller's
        # meaning.
        system_parts = [m.content for m in request.messages if m.role == "system"]
        input_items = [
            {"role": message.role, "content": message.content}
            for message in request.messages
            if message.role != "system"
        ]

        payload: dict[str, Any] = {
            "model": self._config.model,
            "input": input_items,
        }
        if system_parts:
            payload["instructions"] = "\n\n".join(system_parts)

        # Per-request values win over provider defaults.
        temperature = (
            request.temperature if request.temperature is not None else self._config.temperature
        )
        if temperature is not None:
            payload["temperature"] = temperature

        # `max_output_tokens` is already this protocol's native name — no aliasing
        # is required, unlike Chat Completions' `max_tokens`.
        max_output_tokens = (
            request.max_output_tokens
            if request.max_output_tokens is not None
            else self._config.max_output_tokens
        )
        if max_output_tokens is not None:
            payload["max_output_tokens"] = max_output_tokens

        if request.timeout_s is not None:
            payload["timeout"] = request.timeout_s

        return payload

    def _to_result(self, response: Any) -> LLMResult:
        """Convert the SDK response into the internal result type.

        Every access is guarded: a provider returning a null ``output``, an item
        without content, or non-string text must produce a normalised error
        rather than an AttributeError/TypeError reaching the caller.
        """
        # A failed response is HTTP 200 with status="failed" — there is no HTTP
        # error to normalise, so the in-band error is mapped here.
        if getattr(response, "status", None) == "failed":
            self._raise_for_failed_response(response)

        text = self._extract_text(response)
        if text is not None and text.strip():
            return LLMResult(
                text=text,
                model=getattr(response, "model", None) or self._config.model,
                protocol=self.protocol,
                usage=self._extract_usage(getattr(response, "usage", None)),
            )

        # No usable text. Distinguish *why*, so the caller gets an actionable
        # message rather than a blanket "empty response".
        refusal = self._extract_refusal(response)
        if refusal:
            raise LLMInvalidResponseError(f"Provider refused request: {refusal}")

        if getattr(response, "status", None) == "incomplete":
            # Incomplete is truncation, not an empty answer: the response was cut
            # short before it produced text. Reported distinctly so a caller can
            # raise the budget and retry instead of concluding the provider is
            # broken — see `LLMOutputTruncatedError`.
            details = getattr(response, "incomplete_details", None)
            reason = getattr(details, "reason", None) or "unknown"
            raise LLMOutputTruncatedError(
                f"The model's response was incomplete ({reason}) before it produced "
                "any usable content. Raise the output allowance and try again."
            )

        raise LLMInvalidResponseError("Provider returned empty content")

    def _extract_text(self, response: Any) -> str | None:
        """Read the aggregated output text, tolerating a missing/null ``output``.

        ``Response.output_text`` is an SDK convenience property that iterates
        ``output`` — it raises if ``output`` is null, so it cannot simply be
        called blind.
        """
        try:
            text = response.output_text
        except Exception as exc:  # noqa: BLE001 - re-raised as a normalised error
            raise LLMInvalidResponseError(
                "Provider returned a response with malformed output"
            ) from exc

        if text is None:
            return None
        if not isinstance(text, str):
            raise LLMInvalidResponseError(
                f"Provider returned non-text content ({type(text).__name__})"
            )
        return text

    @staticmethod
    def _extract_refusal(response: Any) -> str | None:
        """Find refusal text inside the output content parts, if any."""
        for item in getattr(response, "output", None) or []:
            if getattr(item, "type", None) != "message":
                continue
            for part in getattr(item, "content", None) or []:
                if getattr(part, "type", None) == "refusal":
                    refusal = getattr(part, "refusal", None)
                    if refusal:
                        return str(refusal)
        return None

    def _raise_for_failed_response(self, response: Any) -> None:
        """Map an in-band ``status="failed"`` payload onto the shared taxonomy."""
        error = getattr(response, "error", None)
        if error is None:
            raise LLMInvalidResponseError(
                "Provider response marked as failed without error details"
            )

        api_key = self._config.api_key.get_secret_value()
        raw_code = getattr(error, "code", None) or ""
        code = str(raw_code).lower()
        message = sanitize_message(
            str(getattr(error, "message", "") or "Provider reported a failure"), api_key
        )

        if code in _SERVER_ERROR_CODES or "server_error" in code:
            raise LLMServerError(message)
        if code in _RATE_LIMIT_CODES or "rate_limit" in code:
            raise LLMRateLimitError(message)
        if "timeout" in code:
            raise LLMTimeoutError(message)
        if code in _BAD_REQUEST_CODES:
            raise LLMBadRequestError(message)

        raise LLMAPIError(message, retryable=False)

    @staticmethod
    def _extract_usage(usage: Any) -> LLMUsage | None:
        """Normalise token accounting onto the shared shape.

        Responses names these ``input_tokens``/``output_tokens`` where Chat
        Completions uses ``prompt_tokens``/``completion_tokens``; mapping them is
        precisely what stops the difference reaching callers.
        """
        if usage is None:
            return None

        prompt = getattr(usage, "input_tokens", None)
        completion = getattr(usage, "output_tokens", None)
        total = getattr(usage, "total_tokens", None)

        if prompt is None and completion is None and total is None:
            return None

        prompt_tokens = prompt or 0
        completion_tokens = completion or 0
        return LLMUsage(
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=total if total is not None else prompt_tokens + completion_tokens,
        )


__all__ = [
    "OpenAIResponsesProvider",
    "build_responses_client",
    "KEYLESS_API_KEY_PLACEHOLDER",
]
