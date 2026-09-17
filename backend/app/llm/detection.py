"""Protocol auto-detection.

The user configures an endpoint; they should not have to know whether it speaks
Responses or Chat Completions. This decides for them, once.

Two properties matter more than anything else here:

* **It runs once per profile, not per request.** Translating a 300-block document
  must not issue 300 probes. The network is touched on the first resolve for a
  given profile; every later resolve is a dictionary lookup.
* **It distinguishes "protocol absent" from "protocol rejected us".** A 404 means
  the endpoint is not there, so trying the other protocol is sensible. A 401
  means credentials were refused — falling through would only produce a second,
  misleading error and, for a 429, hammer an endpoint that is already throttled.
"""

from __future__ import annotations

import asyncio
import hashlib
from typing import Any

from app.llm.base import LLMProvider
from app.llm.chat_completions import OpenAIChatCompletionsProvider
from app.llm.client import PROBE_MAX_TOKENS, PROBE_PROMPT
from app.llm.errors import (
    LLMAPIError,
    LLMAuthenticationError,
    LLMConnectionError,
    LLMError,
    LLMOutputTruncatedError,
    LLMPermissionDeniedError,
    LLMRateLimitError,
    LLMTimeoutError,
    sanitize_message,
)
from app.llm.models import ConnectionReport, LLMRequest, ProviderConfig
from app.llm.responses import OpenAIResponsesProvider

AUTO = "auto"
CHAT_COMPLETIONS = "chat_completions"
RESPONSES = "responses"

_VALID_PROTOCOLS = (AUTO, RESPONSES, CHAT_COMPLETIONS)

#: Failures meaning "this protocol exists but rejected us". Detection stops and
#: surfaces the real cause rather than trying the other protocol, which would
#: report a misleading second failure.
_ABORT_ERRORS = (
    LLMAuthenticationError,
    LLMPermissionDeniedError,
    LLMRateLimitError,
    LLMConnectionError,
    LLMTimeoutError,
)

#: resolved protocol per cache key.
_CACHE: dict[tuple[str, str, str], str] = {}
#: In-flight detection per cache key. Concurrent callers await the *same* task
#: rather than each starting their own probe — including when it fails, since a
#: burst of failing probes against a throttled or misconfigured endpoint is
#: exactly what must not happen.
_INFLIGHT: dict[tuple[str, str, str], asyncio.Task[str]] = {}
_REGISTRY_LOCK = asyncio.Lock()

_HITS = 0
_MISSES = 0


def cache_key(config: ProviderConfig) -> tuple[str, str, str]:
    """Identify a profile for caching.

    Includes a **hash** of the key rather than the key itself: rotating a
    credential — or pointing at a multi-tenant gateway that routes by key —
    yields a distinct entry, while the plaintext never enters a data structure.
    """
    digest = hashlib.sha256(config.api_key.get_secret_value().encode("utf-8")).hexdigest()
    return (config.base_url, config.model, digest)


def _build_provider(config: ProviderConfig, protocol: str) -> LLMProvider:
    if protocol == RESPONSES:
        return OpenAIResponsesProvider(config)
    if protocol == CHAT_COMPLETIONS:
        return OpenAIChatCompletionsProvider(config)
    raise ValueError(f"Unsupported protocol {protocol!r}; expected one of {_VALID_PROTOCOLS}")


async def _probe(config: ProviderConfig, protocol: str) -> bool:
    """Send the minimal probe. Returns whether it produced usable *text*.

    Deliberately not ``provider.test_connection()``: that returns a report rather
    than raising, which discards the error *type* — and the type is exactly what
    decides abort-versus-fall-through.

    One error is *not* a failure of the protocol. The probe asks for a single
    token; a reasoning model spends it thinking and is then cut off, returning a
    perfectly well-formed completion with no text. That is evidence the endpoint
    speaks the protocol — weak evidence. A probe that produces text is strong
    evidence, and the caller prefers it, because an endpoint can implement a
    protocol nominally without it being the right one to use.
    """
    provider = _build_provider(config, protocol)
    try:
        await provider.generate(
            LLMRequest(
                messages=[{"role": "user", "content": PROBE_PROMPT}],
                max_output_tokens=PROBE_MAX_TOKENS,
            )
        )
        return True
    except LLMOutputTruncatedError:
        # Answered correctly; the one-token budget went on reasoning.
        return False


async def _detect(config: ProviderConfig) -> str:
    """Probe Responses first, then Chat Completions — but stop early.

    Detection must cost **one** request when the first protocol works, which is
    the common case and a property tests pin. It only pays for a second probe
    when the first answered without producing text.

    That second case is not hypothetical: a reasoning model given the one-token
    probe spends it thinking and is cut off, so *any* protocol it speaks looks
    equally inconclusive. Falling through then lets real text be the tie-breaker,
    rather than whichever shape happened to be tried first — which is how an
    endpoint that nominally implements both ends up on the wrong one.
    """
    try:
        if await _probe(config, RESPONSES):
            return RESPONSES
        responses_answered = True
        responses_error: LLMError | None = None
    except _ABORT_ERRORS:
        raise
    except LLMError as exc:
        responses_answered = False
        responses_error = exc

    try:
        if await _probe(config, CHAT_COMPLETIONS):
            return CHAT_COMPLETIONS
        # Answered, but produced no text either. Chat Completions is by far the
        # more widely implemented shape, so it is the safer of two weak answers.
        return CHAT_COMPLETIONS
    except _ABORT_ERRORS:
        raise
    except LLMError as chat_error:
        if responses_answered:
            # Responses answered correctly and only lacked text; it is the better
            # supported of the two here.
            return RESPONSES

        message = sanitize_message(
            "Auto-detection failed: "
            f"Responses probe failed ({responses_error.code}: {responses_error.message}); "
            f"Chat Completions probe failed ({chat_error.code}: {chat_error.message})",
            config.api_key.get_secret_value(),
        )
        raise LLMAPIError(message, retryable=False) from chat_error


def _normalize_protocol(protocol: str | None, config: ProviderConfig) -> str:
    value = (protocol or "").strip().lower()

    if value in ("", AUTO):
        # A duck-typed or subclassed config may carry its own protocol; that is
        # more specific than the literal "auto".
        declared = getattr(config, "protocol", None)
        if isinstance(declared, str) and declared.strip():
            candidate = declared.strip().lower()
            if candidate in _VALID_PROTOCOLS and candidate != AUTO:
                return candidate
        return AUTO

    if value in _VALID_PROTOCOLS:
        return value

    raise ValueError(
        f"Unsupported protocol {protocol!r}; expected one of {_VALID_PROTOCOLS}"
    )


async def _detect_and_store(config: ProviderConfig, key: tuple[str, str, str]) -> str:
    """Run detection once, cache a success, and always clear the in-flight slot.

    A failure is deliberately **not** cached (the endpoint may be fixed), but it
    *is* shared: every caller already awaiting this task receives the same
    exception instead of launching a competing probe.
    """
    try:
        detected = await _detect(config)
    except BaseException:
        # Includes CancelledError — the slot must never be left occupied.
        _INFLIGHT.pop(key, None)
        raise
    _CACHE[key] = detected
    _INFLIGHT.pop(key, None)
    return detected


async def resolve_provider(
    config: ProviderConfig,
    protocol: str | None = AUTO,
    *,
    force_probe: bool = False,
) -> LLMProvider:
    """Return a provider for ``config``, detecting the protocol if needed.

    An explicit protocol skips detection entirely — no probe, and the cache is
    neither read nor written. ``auto`` probes once and caches the outcome;
    failures are never cached, so a fixed endpoint is retried next time.
    """
    resolved_protocol = _normalize_protocol(protocol, config)

    if resolved_protocol != AUTO:
        return _build_provider(config, resolved_protocol)

    global _HITS, _MISSES
    key = cache_key(config)

    if not force_probe:
        cached = _CACHE.get(key)
        if cached is not None:
            _HITS += 1
            return _build_provider(config, cached)

    async with _REGISTRY_LOCK:
        if not force_probe:
            # Re-check under the lock: a concurrent caller may have resolved
            # while we were waiting for it.
            cached = _CACHE.get(key)
            if cached is not None:
                _HITS += 1
                return _build_provider(config, cached)

            task = _INFLIGHT.get(key)
            if task is None:
                _MISSES += 1
                task = asyncio.create_task(_detect_and_store(config, key))
                _INFLIGHT[key] = task
        else:
            # An explicit re-probe is the caller's decision, so it does not join
            # an in-flight detection.
            _MISSES += 1
            task = asyncio.create_task(_detect_and_store(config, key))

    # Every waiter awaits the same task, so N callers cause one probe and share
    # one outcome — success or failure.
    #
    # Shielded because cancelling a task that is awaiting another task cancels
    # the inner one too: without this, one caller giving up (a closed settings
    # dialog, say) would abort the probe every other waiter is depending on.
    detected = await asyncio.shield(task)
    return _build_provider(config, detected)


def clear_detection_cache() -> None:
    """Drop every cached resolution. Primarily for tests and app reset."""
    for task in _INFLIGHT.values():
        task.cancel()
    _INFLIGHT.clear()
    _CACHE.clear()
    global _HITS, _MISSES
    _HITS = 0
    _MISSES = 0


def invalidate_detection_cache(config: ProviderConfig) -> bool:
    """Drop one profile's cached resolution. Returns whether anything was removed."""
    return _CACHE.pop(cache_key(config), None) is not None


def get_detection_cache_stats() -> dict[str, int]:
    """Cache metrics, for diagnostics and tests."""
    return {"entries": len(_CACHE), "hits": _HITS, "misses": _MISSES}


async def test_endpoint_connection(
    config: ProviderConfig,
    protocol: str | None = AUTO,
    *,
    force_probe: bool = False,
) -> tuple[str, ConnectionReport]:
    """Resolve a provider and probe it, returning the protocol and a report.

    This is what a settings screen's "Test Connection" button calls: it yields the
    three things that screen must display — protocol, model, and latency.
    """
    provider = await resolve_provider(config, protocol, force_probe=force_probe)
    report = await provider.test_connection()
    return provider.protocol, report


__all__ = [
    "AUTO",
    "CHAT_COMPLETIONS",
    "RESPONSES",
    "cache_key",
    "clear_detection_cache",
    "get_detection_cache_stats",
    "invalidate_detection_cache",
    "resolve_provider",
    "test_endpoint_connection",
]
