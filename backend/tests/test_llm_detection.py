"""DS-BE-004 — protocol auto-detection.

Runs offline. The probe seam (`detection._probe`) is substituted so the routing,
caching and concurrency logic is exercised directly; providers themselves are
built for real, since constructing a client opens no connection.
"""

from __future__ import annotations

import ast
import asyncio
import hashlib
import json
import logging
import os
import subprocess
import sys
from typing import Any

import pytest

from app.config import BACKEND_DIR
from app.llm import (
    LLMAPIError,
    LLMAuthenticationError,
    LLMBadRequestError,
    LLMConnectionError,
    LLMInvalidResponseError,
    LLMNotFoundError,
    LLMPermissionDeniedError,
    LLMRateLimitError,
    LLMServerError,
    LLMTimeoutError,
    OpenAIChatCompletionsProvider,
    OpenAIResponsesProvider,
    ProviderConfig,
    clear_detection_cache,
    get_detection_cache_stats,
    invalidate_detection_cache,
    resolve_provider,
)
# Aliased: a module-level name starting with `test_` would be collected by
# pytest as a test case in its own right.
from app.llm import test_endpoint_connection as check_endpoint_connection
from app.llm import detection
from app.llm.client import PROBE_MAX_TOKENS, PROBE_PROMPT

SECRET = "sk-live-DETECTION-SECRET-4242"


class ProbeRecorder:
    """Stands in for the network probe, recording what detection tried."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.failures: dict[str, BaseException] = {}
        self.delay = 0.0

    async def __call__(self, config: ProviderConfig, protocol: str) -> None:
        self.calls.append(protocol)
        if self.delay:
            await asyncio.sleep(self.delay)
        failure = self.failures.get(protocol)
        if failure is not None:
            raise failure

    @property
    def response_calls(self) -> int:
        return self.calls.count("responses")

    @property
    def chat_calls(self) -> int:
        return self.calls.count("chat_completions")


@pytest.fixture
def probe(monkeypatch: pytest.MonkeyPatch) -> ProbeRecorder:
    """Substitute the probe and isolate the cache between tests."""
    recorder = ProbeRecorder()
    monkeypatch.setattr(detection, "_probe", recorder)
    clear_detection_cache()
    yield recorder
    clear_detection_cache()


def config(**overrides: Any) -> ProviderConfig:
    base: dict[str, Any] = {
        "base_url": "https://api.example.com/v1",
        "api_key": SECRET,
        "model": "some-model",
        "timeout_s": 30.0,
    }
    base.update(overrides)
    return ProviderConfig(**base)


# --- AC-27.01 … AC-27.03: exports and cleanup -------------------------------


def test_detection_package_exports() -> None:
    """AC-01 / AC-27.01."""
    import app.llm as llm

    for name in (
        "resolve_provider",
        "clear_detection_cache",
        "invalidate_detection_cache",
        "PROBE_PROMPT",
        "PROBE_MAX_TOKENS",
    ):
        assert hasattr(llm, name), f"{name} is not exported"


def test_detection_package_import_is_inert(tmp_path) -> None:
    """AC-01 / AC-27.02."""
    env = {**os.environ, "DATABASE_PATH": str(tmp_path / "must-not-appear.sqlite3")}

    result = subprocess.run(
        [sys.executable, "-c", "import app.llm; print('imported')"],
        cwd=BACKEND_DIR, env=env, capture_output=True, text=True, timeout=60,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "imported"
    assert not (tmp_path / "must-not-appear.sqlite3").exists()


def test_probe_constants_relocated_to_client() -> None:
    """AC-02 / AC-27.03 — one shared home, with backward compatibility kept."""
    from app.llm import chat_completions, client

    assert client.PROBE_PROMPT == "ping"
    assert client.PROBE_MAX_TOKENS == 1
    # chat_completions still exposes them for any existing caller.
    assert chat_completions.PROBE_PROMPT == client.PROBE_PROMPT
    assert chat_completions.PROBE_MAX_TOKENS == client.PROBE_MAX_TOKENS


def test_detection_uses_the_shared_probe_constants() -> None:
    assert PROBE_PROMPT == "ping"
    assert PROBE_MAX_TOKENS == 1


# --- AC-04 / AC-27.04, AC-27.05: explicit protocol bypass -------------------


async def test_explicit_chat_completions_bypasses_probe(probe: ProbeRecorder) -> None:
    """AC-04 / AC-27.04 — no network, and the cache is untouched."""
    provider = await resolve_provider(config(), protocol="chat_completions")

    assert isinstance(provider, OpenAIChatCompletionsProvider)
    assert provider.protocol == "chat_completions"
    assert probe.calls == []
    assert get_detection_cache_stats()["entries"] == 0


async def test_explicit_responses_bypasses_probe(probe: ProbeRecorder) -> None:
    """AC-04 / AC-27.05."""
    provider = await resolve_provider(config(), protocol="responses")

    assert isinstance(provider, OpenAIResponsesProvider)
    assert provider.protocol == "responses"
    assert probe.calls == []
    assert get_detection_cache_stats()["entries"] == 0


# --- AC-05 / AC-27.06: responses first --------------------------------------


async def test_auto_detection_prefers_responses(probe: ProbeRecorder) -> None:
    """AC-05 / AC-27.06 — Chat Completions must not be probed at all."""
    provider = await resolve_provider(config())

    assert isinstance(provider, OpenAIResponsesProvider)
    assert provider.protocol == "responses"
    assert probe.calls == ["responses"]


# --- AC-06 / AC-27.07 … AC-27.10: fall-through ------------------------------


@pytest.mark.parametrize(
    ("label", "failure"),
    [
        ("not found (404)", LLMNotFoundError("no such route")),
        ("bad request (400)", LLMBadRequestError("unknown schema")),
        ("invalid response", LLMInvalidResponseError("not json")),
        ("server error (500)", LLMServerError("gateway blew up")),
        ("api error (405)", LLMAPIError("method not allowed")),
    ],
)
async def test_falls_through_when_responses_is_absent(
    probe: ProbeRecorder, label: str, failure: LLMError
) -> None:
    """AC-06 / AC-27.07 … AC-27.10 — these mean "no Responses endpoint here"."""
    probe.failures["responses"] = failure

    provider = await resolve_provider(config())

    assert isinstance(provider, OpenAIChatCompletionsProvider)
    assert provider.protocol == "chat_completions"
    assert probe.calls == ["responses", "chat_completions"]


# --- AC-07, AC-08 / AC-27.11 … AC-27.15: terminal abort ---------------------


@pytest.mark.parametrize(
    ("label", "failure"),
    [
        ("authentication (401)", LLMAuthenticationError("bad key")),
        ("permission (403)", LLMPermissionDeniedError("forbidden")),
        ("rate limit (429)", LLMRateLimitError("slow down")),
        ("connection", LLMConnectionError("host unreachable")),
        ("timeout", LLMTimeoutError("too slow")),
    ],
)
async def test_aborts_without_falling_through(
    probe: ProbeRecorder, label: str, failure: LLMError
) -> None:
    """AC-07 / AC-08 — the protocol exists but rejected us; trying the other one
    would report a misleading second error and, for 429, hammer a throttled host."""
    probe.failures["responses"] = failure

    with pytest.raises(type(failure)) as excinfo:
        await resolve_provider(config())

    assert excinfo.value is failure
    assert probe.chat_calls == 0, "Chat Completions must not be probed"
    assert get_detection_cache_stats()["entries"] == 0, "a failure must not be cached"


# --- AC-09 / AC-27.16: dual failure -----------------------------------------


async def test_both_failing_raises_a_composite_error(probe: ProbeRecorder) -> None:
    """AC-09 / AC-27.16 — the message must name both attempts."""
    probe.failures["responses"] = LLMNotFoundError("no responses route")
    probe.failures["chat_completions"] = LLMServerError("gateway down")

    with pytest.raises(LLMAPIError) as excinfo:
        await resolve_provider(config())

    error = excinfo.value
    assert error.code == "LLM_API_ERROR"
    assert error.retryable is False
    assert "LLM_NOT_FOUND" in error.message
    assert "LLM_SERVER_ERROR" in error.message
    assert "Responses" in error.message and "Chat Completions" in error.message
    assert get_detection_cache_stats()["entries"] == 0


async def test_composite_error_does_not_leak_the_key(probe: ProbeRecorder) -> None:
    """AC-15 / AC-27.23."""
    probe.failures["responses"] = LLMAPIError(f"upstream said Bearer {SECRET}")
    probe.failures["chat_completions"] = LLMAPIError(f"and key={SECRET} too")

    with pytest.raises(LLMAPIError) as excinfo:
        await resolve_provider(config())

    assert SECRET not in f"{excinfo.value} {excinfo.value.message}"


# --- AC-10 … AC-13 / AC-27.17 … AC-27.21: caching ---------------------------


async def test_second_resolve_does_not_reprobe(probe: ProbeRecorder) -> None:
    """AC-11 / AC-27.17 — the property that keeps detection off the hot path."""
    configured = config()

    first = await resolve_provider(configured)
    second = await resolve_provider(configured)

    assert probe.calls == ["responses"], "exactly one probe in total"
    assert first.protocol == second.protocol == "responses"


async def test_cache_key_separates_models(probe: ProbeRecorder) -> None:
    """AC-10 / AC-12 / AC-27.18 — a gateway may support one model but not another."""
    await resolve_provider(config(model="m1"))
    await resolve_provider(config(model="m2"))

    assert probe.response_calls == 2, "distinct models must probe independently"


async def test_cache_key_separates_rotated_keys(probe: ProbeRecorder) -> None:
    """AC-10 / AC-27.19 — key rotation must not serve a stale resolution."""
    await resolve_provider(config(api_key="sk-first"))
    await resolve_provider(config(api_key="sk-second"))

    assert probe.response_calls == 2


async def test_cache_key_separates_base_urls(probe: ProbeRecorder) -> None:
    """AC-12 — no cross-talk between profiles."""
    await resolve_provider(config(base_url="https://host-a/v1"))
    await resolve_provider(config(base_url="https://host-b/v1"))

    assert probe.response_calls == 2
    assert get_detection_cache_stats()["entries"] == 2


def test_cache_key_contains_no_plaintext_key() -> None:
    """AC-10 / AC-15 — only a digest may enter the key."""
    key = detection.cache_key(config())

    assert SECRET not in repr(key)
    assert key[2] == hashlib.sha256(SECRET.encode("utf-8")).hexdigest()
    assert len(key) == 3


def test_cache_key_for_a_keyless_endpoint_is_deterministic() -> None:
    """AC-24 — an empty key hashes to the empty-string digest."""
    key = detection.cache_key(config(api_key=""))

    assert key[2] == hashlib.sha256(b"").hexdigest()


async def test_clear_cache_forces_reprobe(probe: ProbeRecorder) -> None:
    """AC-13 / AC-27.20."""
    await resolve_provider(config())
    assert probe.response_calls == 1

    clear_detection_cache()
    await resolve_provider(config())

    assert probe.response_calls == 2


async def test_invalidate_specific_entry(probe: ProbeRecorder) -> None:
    """AC-13."""
    configured = config()
    await resolve_provider(configured)

    assert invalidate_detection_cache(configured) is True
    assert invalidate_detection_cache(configured) is False, "second removal has nothing to do"

    await resolve_provider(configured)
    assert probe.response_calls == 2


async def test_force_probe_bypasses_a_cached_entry(probe: ProbeRecorder) -> None:
    """AC-13 / AC-27.21."""
    configured = config()
    await resolve_provider(configured)

    provider = await resolve_provider(configured, force_probe=True)

    assert provider.protocol == "responses"
    assert probe.response_calls == 2, "force_probe must re-probe"
    # The refreshed outcome is what is now cached.
    await resolve_provider(configured)
    assert probe.response_calls == 2


async def test_force_probe_updates_a_changed_outcome(probe: ProbeRecorder) -> None:
    """AC-13 — a re-probe must overwrite, not append."""
    configured = config()
    await resolve_provider(configured)
    assert get_detection_cache_stats()["entries"] == 1

    probe.failures["responses"] = LLMNotFoundError("route removed")
    provider = await resolve_provider(configured, force_probe=True)

    assert provider.protocol == "chat_completions"
    assert get_detection_cache_stats()["entries"] == 1


def test_cache_stats_are_reported() -> None:
    """AC-25 (P2)."""
    stats = get_detection_cache_stats()

    assert set(stats) == {"entries", "hits", "misses"}


async def test_cache_stats_count_hits_and_misses(probe: ProbeRecorder) -> None:
    """AC-25."""
    configured = config()

    await resolve_provider(configured)  # miss
    await resolve_provider(configured)  # hit

    stats = get_detection_cache_stats()
    assert stats["misses"] == 1
    assert stats["hits"] == 1
    assert stats["entries"] == 1


# --- AC-14 / AC-27.22: anti-stampede ----------------------------------------


async def test_concurrent_resolves_issue_one_probe(probe: ProbeRecorder) -> None:
    """AC-14 / AC-27.22 / FC-06 — N callers, one probe."""
    probe.delay = 0.02  # let the coroutines genuinely overlap
    configured = config()

    providers = await asyncio.gather(*(resolve_provider(configured) for _ in range(10)))

    assert probe.calls == ["responses"], f"expected one probe, got {probe.calls}"
    assert all(p.protocol == "responses" for p in providers)


async def test_concurrent_resolves_of_different_keys_do_not_block(probe: ProbeRecorder) -> None:
    """AC-14 — per-key locking must not serialise unrelated profiles."""
    probe.delay = 0.01
    configs = [config(base_url=f"https://host-{i}/v1") for i in range(5)]

    await asyncio.gather(*(resolve_provider(c) for c in configs))

    assert probe.response_calls == 5
    assert get_detection_cache_stats()["entries"] == 5


async def test_concurrent_failures_reach_every_waiter(probe: ProbeRecorder) -> None:
    """AC-14 — and the failure is not cached."""
    probe.delay = 0.01
    probe.failures["responses"] = LLMAuthenticationError("bad key")
    configured = config()

    results = await asyncio.gather(
        *(resolve_provider(configured) for _ in range(5)), return_exceptions=True
    )

    assert all(isinstance(r, LLMAuthenticationError) for r in results)
    assert probe.calls == ["responses"]
    assert get_detection_cache_stats()["entries"] == 0


# --- AC-17 / AC-27.25: cancellation -----------------------------------------


async def test_cancellation_propagates_and_leaves_the_key_usable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """AC-17 / AC-27.25 / FC-09 — a cancelled resolve must not wedge the key."""
    clear_detection_cache()
    started = asyncio.Event()
    release = asyncio.Event()

    async def slow_probe(config: ProviderConfig, protocol: str) -> None:
        started.set()
        await release.wait()

    monkeypatch.setattr(detection, "_probe", slow_probe)
    configured = config()

    task = asyncio.create_task(resolve_provider(configured))
    await started.wait()
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task

    # Cancelling the *waiter* must not abandon the in-flight slot: once the probe
    # settles, the key has to be resolvable again rather than wedged.
    release.set()
    await asyncio.sleep(0.05)
    clear_detection_cache()
    assert detection.get_detection_cache_stats()["entries"] == 0

    async def quick_probe(config: ProviderConfig, protocol: str) -> None:
        return None

    monkeypatch.setattr(detection, "_probe", quick_probe)
    assert (await resolve_provider(configured)).protocol == "responses"


async def test_cancelling_one_waiter_does_not_cancel_the_others(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """AC-14 + AC-17 — the shared probe serves remaining waiters."""
    clear_detection_cache()
    started = asyncio.Event()
    release = asyncio.Event()

    async def slow_probe(config: ProviderConfig, protocol: str) -> None:
        started.set()
        await release.wait()

    monkeypatch.setattr(detection, "_probe", slow_probe)
    configured = config()

    first = asyncio.create_task(resolve_provider(configured))
    await started.wait()
    second = asyncio.create_task(resolve_provider(configured))
    await asyncio.sleep(0.01)  # let the second join the in-flight probe

    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first

    release.set()
    assert (await second).protocol == "responses"
    clear_detection_cache()


# --- AC-16 / AC-27.24: connection diagnostics -------------------------------


async def test_resolved_provider_reports_diagnostics(probe: ProbeRecorder) -> None:
    """AC-16 / AC-27.24 — protocol, model and latency for the settings screen."""
    protocol, report = await check_endpoint_connection(config())

    assert protocol == "responses"
    assert hasattr(report, "ok") and hasattr(report, "latency_ms")
    assert hasattr(report, "message") and hasattr(report, "model")


# --- AC-21, AC-22 / AC-27.27, AC-27.28: protocol argument -------------------


@pytest.mark.parametrize("value", ["Auto", "AUTO", " auto ", ""])
async def test_protocol_argument_is_case_insensitive(probe: ProbeRecorder, value: str) -> None:
    """AC-21 / AC-27.27."""
    provider = await resolve_provider(config(), protocol=value)
    assert provider.protocol in ("responses", "chat_completions")


@pytest.mark.parametrize("value", ["RESPONSES", "Responses", " responses "])
async def test_explicit_protocol_is_case_insensitive(probe: ProbeRecorder, value: str) -> None:
    """AC-21."""
    assert isinstance(await resolve_provider(config(), protocol=value), OpenAIResponsesProvider)


@pytest.mark.parametrize("value", ["CHAT_COMPLETIONS", "Chat_Completions"])
async def test_explicit_chat_protocol_is_case_insensitive(probe: ProbeRecorder, value: str) -> None:
    """AC-21."""
    assert isinstance(await resolve_provider(config(), protocol=value), OpenAIChatCompletionsProvider)


async def test_invalid_protocol_raises_value_error(probe: ProbeRecorder) -> None:
    """AC-22 / AC-27.28 — and issues no probe."""
    with pytest.raises(ValueError) as excinfo:
        await resolve_provider(config(), protocol="grpc")

    message = str(excinfo.value)
    assert "auto" in message and "responses" in message and "chat_completions" in message
    assert probe.calls == []


# --- AC-24 / AC-27.29: keyless endpoints ------------------------------------


async def test_keyless_endpoint_detects_normally(probe: ProbeRecorder) -> None:
    """AC-24 / AC-27.29 — a local server with no key is a supported setup."""
    provider = await resolve_provider(config(api_key="", base_url="http://127.0.0.1:11434/v1"))

    assert provider.protocol == "responses"
    assert get_detection_cache_stats()["entries"] == 1


# --- AC-26: duck-typed config protocol --------------------------------------


async def test_config_declared_protocol_takes_precedence(probe: ProbeRecorder) -> None:
    """AC-26 (P2) — a config carrying its own protocol skips detection."""
    configured = config()
    object.__setattr__(configured, "protocol", "chat_completions")

    provider = await resolve_provider(configured)

    assert provider.protocol == "chat_completions"
    assert probe.calls == [], "a declared protocol must not be probed"


# --- AC-18 / AC-27.26: no vendor branching ----------------------------------


VENDOR_WORDS = ("deepseek", "openrouter", "siliconflow", "ollama", "anthropic",
                "gpt", "claude", "qwen", "gemini", "mistral")


def _vendor_specific_expressions(tree: ast.AST) -> list[str]:
    offenders: list[str] = []

    def references_vendor(value: object) -> bool:
        return isinstance(value, str) and any(word in value.lower() for word in VENDOR_WORDS)

    for node in ast.walk(tree):
        if isinstance(node, ast.Compare):
            for operand in (node.left, *node.comparators):
                if isinstance(operand, ast.Constant) and references_vendor(operand.value):
                    offenders.append(f"line {node.lineno}: comparison against {operand.value!r}")
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr in ("startswith", "endswith")
        ):
            for argument in node.args:
                if isinstance(argument, ast.Constant) and references_vendor(argument.value):
                    offenders.append(f"line {node.lineno}: {node.func.attr}({argument.value!r})")
    return offenders


def test_detection_has_no_vendor_branching() -> None:
    """AC-18 / AC-27.26 / FC-07 — selection must be behavioural, not name-based."""
    source = (BACKEND_DIR / "app" / "llm" / "detection.py").read_text(encoding="utf-8")
    tree = ast.parse(source, filename="detection.py")

    assert not _vendor_specific_expressions(tree)


def test_detection_does_not_inspect_the_url_or_model_directly() -> None:
    """AC-18 — a second, cruder guard: no substring checks on config fields."""
    source = (BACKEND_DIR / "app" / "llm" / "detection.py").read_text(encoding="utf-8")

    for suspicious in ("base_url in", "model in", "config.base_url ==", "config.model =="):
        assert suspicious not in source, f"detection inspects {suspicious!r}"


# --- logging hygiene ---------------------------------------------------------


async def test_detection_logs_no_secret(probe: ProbeRecorder, caplog: pytest.LogCaptureFixture) -> None:
    """AC-15 — a detection cycle must not put the key in the log stream."""
    with caplog.at_level(logging.DEBUG):
        await resolve_provider(config())

    assert SECRET not in caplog.text
    assert SECRET not in json.dumps(get_detection_cache_stats())
