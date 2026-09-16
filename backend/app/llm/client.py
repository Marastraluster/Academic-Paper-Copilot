"""Shared SDK-client construction for every provider adapter.

This lives apart from any single protocol because it is protocol-neutral: it
turns a :class:`~app.llm.models.ProviderConfig` into an ``AsyncOpenAI`` client
with the guarantees every adapter must honour — verbatim base URL, retries
disabled, timeout and headers forwarded.

The client class is passed in rather than imported, so each adapter resolves
``AsyncOpenAI`` from *its own* module namespace. That keeps each adapter
independently substitutable in tests instead of coupling them to one shared
patch target.
"""

from __future__ import annotations

from typing import Any

from app.llm.models import ProviderConfig

#: Sent when the user configured no key. The SDK refuses a literal empty string
#: ("Missing credentials"), but genuinely keyless local servers — Ollama, LM Studio,
#: llama.cpp — need a client to be built anyway. The upstream PDF translation
#: library solves this the same way, with a fixed placeholder (REPO_AUDIT §4).
KEYLESS_API_KEY_PLACEHOLDER = "no-key-required"

#: Minimal probe used by every adapter's connection test, and by protocol
#: detection. Kept trivial so probing costs almost nothing — and shared, so the
#: two protocols are always measured on identical terms.
PROBE_PROMPT = "ping"
PROBE_MAX_TOKENS = 1


def build_client(config: ProviderConfig, client_factory: Any) -> Any:
    """Construct an SDK client from provider configuration.

    Guarantees, all of which are asserted by tests:

    * ``base_url`` is passed **verbatim** — no trimming, no trailing-slash
      handling, no ``/v1`` appending. (The SDK applies its own internal
      normalisation afterwards; that is its business, and "correcting" it here
      would itself be a mutation of the user's input.)
    * ``max_retries=0`` — this project owns retry policy, so the SDK must not
      retry behind our back and distort latency or error classification.
    * ``timeout`` and ``default_headers`` are forwarded from configuration.
    """
    key = config.api_key.get_secret_value() or KEYLESS_API_KEY_PLACEHOLDER

    return client_factory(
        base_url=config.base_url,
        api_key=key,
        timeout=config.timeout_s,
        max_retries=0,
        default_headers=dict(config.custom_headers) if config.custom_headers else None,
    )
