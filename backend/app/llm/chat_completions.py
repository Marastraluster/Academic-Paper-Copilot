"""OpenAI-compatible Chat Completions adapter.

Speaks the plain ``POST /chat/completions`` contract that essentially every
vendor implements, so it works against OpenAI, DeepSeek, OpenRouter,
SiliconFlow, a private gateway, or a local server without any special-casing.
There is deliberately **no** vendor detection anywhere in this file — the moment
it contains `if "deepseek" in base_url`, it stops being an OpenAI-compatible
adapter and becomes a pile of vendor hacks.

Design decisions worth knowing:

* ``AsyncOpenAI``, because the backend is async; a synchronous client would block
  the event loop.
* ``max_retries=0``. The SDK otherwise retries silently with its own backoff,
  which would make both latency and error classification unpredictable. Retry
  policy belongs to a dedicated layer.
* ``max_tokens``, not ``max_completion_tokens``. The former is what compatible
  endpoints implement; the latter is OpenAI-proprietary and would break the
  vendors this product exists to support.
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
from app.llm.errors import LLMError, LLMInvalidResponseError, normalize_exception
from app.llm.models import (
    ConnectionReport,
    LLMRequest,
    LLMResult,
    LLMUsage,
    ProviderConfig,
)


def build_client(config: ProviderConfig) -> AsyncOpenAI:
    """Construct the SDK client from provider configuration.

    The construction logic is shared with the Responses adapter
    (:mod:`app.llm.client`); this thin wrapper resolves ``AsyncOpenAI`` from
    *this* module's namespace, so a test can substitute the client class here and
    inspect exactly what was passed through — which is how "the base URL is used
    verbatim" is actually proven.
    """
    return _build_client(config, AsyncOpenAI)


class OpenAIChatCompletionsProvider(LLMProvider):
    """Chat Completions for any OpenAI-compatible endpoint."""

    protocol = "chat_completions"

    def __init__(self, config: ProviderConfig, *, client: Any | None = None) -> None:
        self._config = config
        # Injectable so tests never touch the network.
        self._client = client if client is not None else build_client(config)

    @property
    def config(self) -> ProviderConfig:
        """The configuration in use. Safe to repr — the key is a ``SecretStr``."""
        return self._config

    # -- public contract ----------------------------------------------------

    async def generate(self, request: LLMRequest) -> LLMResult:
        payload = self._build_payload(request)

        try:
            response = await self._client.chat.completions.create(**payload)
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
        """Cheap probe: does this endpoint accept our key and model?

        Returns a report rather than raising, because the caller is a settings
        screen that wants to display the outcome either way.
        """
        request = LLMRequest(
            messages=[{"role": "user", "content": PROBE_PROMPT}],
            max_output_tokens=PROBE_MAX_TOKENS,
        )
        started = time.perf_counter()

        try:
            result = await self.generate(request)
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
        """Map a protocol-neutral request onto Chat Completions parameters."""
        payload: dict[str, Any] = {
            "model": self._config.model,
            "messages": [
                {"role": message.role, "content": message.content}
                for message in request.messages
            ],
        }

        # Per-request values win over provider defaults.
        temperature = (
            request.temperature if request.temperature is not None else self._config.temperature
        )
        if temperature is not None:
            payload["temperature"] = temperature

        max_tokens = (
            request.max_output_tokens
            if request.max_output_tokens is not None
            else self._config.max_output_tokens
        )
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens

        if request.timeout_s is not None:
            payload["timeout"] = request.timeout_s

        return payload

    def _to_result(self, response: Any) -> LLMResult:
        """Convert the SDK response into the internal result type.

        Every access is guarded. A provider that returns an empty ``choices``
        list, a null message, or null content must produce a normalised error
        rather than an IndexError/AttributeError leaking to the caller.
        """
        choices = getattr(response, "choices", None)
        if not choices:
            raise LLMInvalidResponseError("Provider returned no completion choices")

        message = getattr(choices[0], "message", None)
        if message is None:
            raise LLMInvalidResponseError("Provider returned a choice without a message")

        content = getattr(message, "content", None)
        if content is None:
            raise LLMInvalidResponseError("Provider returned a message with null content")
        if not isinstance(content, str):
            raise LLMInvalidResponseError(
                f"Provider returned non-text content ({type(content).__name__})"
            )
        if not content.strip():
            # An empty or whitespace-only completion is not a usable translation,
            # summary, or answer. Treating it as success would push the problem
            # downstream where the cause is much harder to see.
            raise LLMInvalidResponseError("Provider returned empty content")

        return LLMResult(
            text=content,
            model=getattr(response, "model", None) or self._config.model,
            protocol=self.protocol,
            usage=self._extract_usage(getattr(response, "usage", None)),
        )

    @staticmethod
    def _extract_usage(usage: Any) -> LLMUsage | None:
        """Normalise token accounting; ``None`` is valid and common."""
        if usage is None:
            return None

        prompt = getattr(usage, "prompt_tokens", None)
        completion = getattr(usage, "completion_tokens", None)
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
