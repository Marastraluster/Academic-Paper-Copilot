"""DS-BE-002 — LLMProvider interface and the Chat Completions adapter.

Everything here runs offline. The SDK is replaced at its boundary: either a fake
client is injected, or ``AsyncOpenAI`` itself is substituted so the constructor
arguments can be inspected. No test opens a socket (the autouse guard in
conftest would fail it if one tried).
"""

from __future__ import annotations

import ast
import asyncio
import json
import logging
import os
import subprocess
import sys
from types import SimpleNamespace
from typing import Any

import httpx
import openai
import pytest
from pydantic import ValidationError

from app.config import BACKEND_DIR
from app.llm import (
    KEYLESS_API_KEY_PLACEHOLDER,
    LLMAPIError,
    LLMAuthenticationError,
    LLMBadRequestError,
    LLMConnectionError,
    LLMError,
    LLMInvalidResponseError,
    LLMNotFoundError,
    LLMPermissionDeniedError,
    LLMProvider,
    LLMRateLimitError,
    LLMRequest,
    LLMResult,
    LLMServerError,
    LLMTimeoutError,
    OpenAIChatCompletionsProvider,
    ProviderConfig,
    build_client,
)
from app.llm import chat_completions as chat_completions_module

SECRET = "sk-live-SUPERSECRET-1234567890"


# --- Fakes ------------------------------------------------------------------


class FakeCompletions:
    """Stands in for ``client.chat.completions``."""

    def __init__(self, *, response: Any = None, error: BaseException | None = None) -> None:
        self.response = response
        self.error = error
        self.calls: list[dict[str, Any]] = []

    async def create(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return self.response


class FakeClient:
    def __init__(self, *, response: Any = None, error: BaseException | None = None) -> None:
        self.completions = FakeCompletions(response=response, error=error)
        self.chat = SimpleNamespace(completions=self.completions)


def make_response(
    *,
    content: Any = "hello",
    model: str | None = "test-model",
    usage: Any = "default",
    choices: Any = "default",
) -> Any:
    if choices == "default":
        message = SimpleNamespace(content=content)
        choices = [SimpleNamespace(message=message)]
    if usage == "default":
        usage = SimpleNamespace(prompt_tokens=11, completion_tokens=7, total_tokens=18)
    return SimpleNamespace(choices=choices, model=model, usage=usage)


def config(**overrides: Any) -> ProviderConfig:
    base: dict[str, Any] = {
        "base_url": "https://api.example.com/v1",
        "api_key": SECRET,
        "model": "some-model",
        "timeout_s": 30.0,
    }
    base.update(overrides)
    return ProviderConfig(**base)


def sdk_status_error(cls: type[Exception], status: int, message: str = "upstream failure") -> Exception:
    request = httpx.Request("POST", "https://api.example.com/v1/chat/completions")
    response = httpx.Response(status, request=request, json={"error": {"message": message}})
    return cls(message, response=response, body=None)


def provider_with(**kwargs: Any) -> tuple[OpenAIChatCompletionsProvider, FakeClient]:
    client = FakeClient(**kwargs)
    return OpenAIChatCompletionsProvider(config(), client=client), client


async def ask(provider: OpenAIChatCompletionsProvider, **request_kwargs: Any) -> LLMResult:
    request = LLMRequest(
        messages=[{"role": "user", "content": "hi"}], **request_kwargs
    )
    return await provider.generate(request)


# --- AC-35.1 / AC-01: inert import ------------------------------------------


def test_llm_package_import_is_inert(tmp_path) -> None:
    """AC-01 / AC-35.1 — importing the package does nothing observable."""
    env = {**os.environ, "DATABASE_PATH": str(tmp_path / "must-not-appear.sqlite3")}

    result = subprocess.run(
        [sys.executable, "-c", "import app.llm; print('imported')"],
        cwd=BACKEND_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )

    assert result.returncode == 0, result.stderr
    assert "imported" in result.stdout
    assert result.stdout.strip() == "imported", "import produced unexpected output"
    assert not (tmp_path / "must-not-appear.sqlite3").exists()


def test_llm_exports_the_public_contract() -> None:
    """AC-01 — every name callers depend on is importable from the package root."""
    import app.llm as llm

    for name in (
        "LLMProvider", "LLMRequest", "ChatMessage", "LLMResult", "LLMUsage",
        "ProviderConfig", "ConnectionReport", "OpenAIChatCompletionsProvider",
        "LLMError", "LLMAuthenticationError", "LLMPermissionDeniedError",
        "LLMRateLimitError", "LLMTimeoutError", "LLMConnectionError",
        "LLMServerError", "LLMBadRequestError", "LLMNotFoundError",
        "LLMInvalidResponseError", "LLMAPIError",
    ):
        assert hasattr(llm, name), f"{name} is not exported from app.llm"


def test_provider_implements_the_interface() -> None:
    """AC-02 — the adapter satisfies the shared contract."""
    assert issubclass(OpenAIChatCompletionsProvider, LLMProvider)
    provider, _ = provider_with()
    assert provider.protocol == "chat_completions"
    assert isinstance(provider, LLMProvider)


# --- AC-03: request models --------------------------------------------------


def test_request_accepts_plain_dicts() -> None:
    """Callers may write a prompt inline without importing a model class."""
    request = LLMRequest(messages=[{"role": "user", "content": "Explain Bellman's equation."}])

    assert request.messages[0].role == "user"
    assert request.messages[0].content == "Explain Bellman's equation."


def test_request_rejects_an_empty_message_list() -> None:
    """AC-03 — ValidationError subclasses ValueError."""
    with pytest.raises(ValidationError):
        LLMRequest(messages=[])


def test_request_is_immutable() -> None:
    request = LLMRequest(messages=[{"role": "user", "content": "hi"}])

    with pytest.raises(ValidationError):
        request.temperature = 0.5  # type: ignore[misc]


def test_request_has_no_protocol_specific_fields() -> None:
    """AC-03 — nothing Chat-Completions-shaped leaks into the shared model."""
    fields = set(LLMRequest.model_fields)
    assert fields == {"messages", "temperature", "max_output_tokens", "timeout_s"}


# --- AC-04 / AC-35.3: configuration validation ------------------------------


@pytest.mark.parametrize("field", ["base_url", "model"])
def test_blank_required_fields_are_rejected(field: str) -> None:
    """AC-35.3."""
    with pytest.raises(ValidationError):
        config(**{field: ""})

    with pytest.raises(ValidationError):
        config(**{field: "   "})


@pytest.mark.parametrize("timeout", [0, -1, -0.5])
def test_non_positive_timeout_is_rejected(timeout: float) -> None:
    """AC-04 / AC-35.3."""
    with pytest.raises(ValidationError):
        config(timeout_s=timeout)


@pytest.mark.parametrize("temperature", [-0.1, 2.5])
def test_temperature_outside_range_is_rejected(temperature: float) -> None:
    """AC-04."""
    with pytest.raises(ValidationError):
        config(temperature=temperature)


def test_non_positive_max_output_tokens_is_rejected() -> None:
    with pytest.raises(ValidationError):
        config(max_output_tokens=0)


def test_config_is_immutable() -> None:
    configured = config()
    with pytest.raises(ValidationError):
        configured.model = "other"  # type: ignore[misc]


# --- AC-05 / AC-27: API key handling ----------------------------------------


def test_api_key_is_never_revealed_by_repr_str_or_dump() -> None:
    """AC-05 / AC-35.2 / FC-02."""
    configured = config()

    surfaces = [
        repr(configured),
        str(configured),
        json.dumps(configured.model_dump(), default=str),
        json.dumps(configured.model_dump(mode="json"), default=str),
    ]

    for surface in surfaces:
        assert SECRET not in surface, f"API key leaked via: {surface[:80]}"


def test_api_key_is_retrievable_only_explicitly() -> None:
    assert config().api_key.get_secret_value() == SECRET


def test_empty_api_key_is_permitted_for_local_servers() -> None:
    """AC-27 — keyless local endpoints are a supported configuration."""
    configured = config(api_key="", base_url="http://127.0.0.1:11434/v1")

    assert configured.api_key.get_secret_value() == ""

    client = build_client(configured)  # must not raise
    assert client is not None


def test_empty_api_key_is_replaced_for_the_sdk() -> None:
    """The SDK refuses a literal empty key, so a documented placeholder is used."""
    fake_key = _capture_client_kwargs(config(api_key=""))

    assert fake_key["api_key"] == KEYLESS_API_KEY_PLACEHOLDER


def test_real_api_key_is_passed_through_unchanged() -> None:
    assert _capture_client_kwargs(config())["api_key"] == SECRET


def _capture_client_kwargs(configured: ProviderConfig) -> dict[str, Any]:
    """Run ``build_client`` with a recording stub and return its keyword args."""
    captured: dict[str, Any] = {}

    class Recorder:
        def __init__(self, **kwargs: Any) -> None:
            captured.update(kwargs)

    original = chat_completions_module.AsyncOpenAI
    chat_completions_module.AsyncOpenAI = Recorder  # type: ignore[assignment]
    try:
        build_client(configured)
    finally:
        chat_completions_module.AsyncOpenAI = original  # type: ignore[assignment]

    return captured


# --- AC-06 / AC-35.6: base URL is used verbatim -----------------------------


@pytest.mark.parametrize(
    "base_url",
    [
        "https://api.deepseek.com/v1",
        "https://openrouter.ai/api/v1/",
        "http://127.0.0.1:11434",
        "https://gateway.internal.example.com/openai",
        "https://example.com/v1//",
    ],
)
def test_base_url_is_passed_through_verbatim(base_url: str) -> None:
    """AC-06 / AC-35.6 / FC-03 — no trimming, no trailing slash, no /v1 appending."""
    assert _capture_client_kwargs(config(base_url=base_url))["base_url"] == base_url


def test_base_url_is_not_rewritten_when_v1_is_missing() -> None:
    """The specific mistake the brief calls out."""
    captured = _capture_client_kwargs(config(base_url="https://example.com"))

    assert captured["base_url"] == "https://example.com"
    assert not captured["base_url"].endswith("/v1")


# --- AC-09 / AC-35.8: no silent SDK retries ---------------------------------


def test_client_is_built_with_retries_disabled() -> None:
    """AC-09 / FC-06 — retry policy belongs to a later layer."""
    assert _capture_client_kwargs(config())["max_retries"] == 0


def test_real_client_reports_zero_retries() -> None:
    """AC-35.8 — asserted on the genuine SDK object, not a stub."""
    client = build_client(config())

    assert client.max_retries == 0


def test_configured_timeout_reaches_the_client() -> None:
    """§18 — an infinite timeout must not be possible."""
    assert _capture_client_kwargs(config(timeout_s=12.5))["timeout"] == 12.5


# --- AC-30 / AC-35.25: custom headers ---------------------------------------


def test_custom_headers_are_forwarded() -> None:
    """AC-30 / AC-35.25 — needed by gateways and OpenRouter-style proxies."""
    headers = {"HTTP-Referer": "https://example.com", "X-Title": "PDF Copilot"}

    assert _capture_client_kwargs(config(custom_headers=headers))["default_headers"] == headers


def test_no_custom_headers_passes_none() -> None:
    assert _capture_client_kwargs(config())["default_headers"] is None


# --- AC-10 / AC-11: normalised results --------------------------------------


async def test_successful_generation_is_normalised() -> None:
    """AC-10 / AC-35.4."""
    provider, client = provider_with(response=make_response(content="Bellman.", model="m-1"))

    result = await ask(provider)

    assert isinstance(result, LLMResult)
    assert result.text == "Bellman."
    assert result.model == "m-1"
    assert result.protocol == "chat_completions"
    assert result.usage is not None
    assert (result.usage.prompt_tokens, result.usage.completion_tokens, result.usage.total_tokens) == (11, 7, 18)
    assert len(client.completions.calls) == 1


async def test_no_sdk_object_escapes_to_the_caller() -> None:
    """AC-10 — the result is ours, not the SDK's."""
    provider, _ = provider_with(response=make_response())

    result = await ask(provider)

    assert type(result) is LLMResult
    assert not hasattr(result, "choices")


async def test_missing_usage_is_tolerated() -> None:
    """AC-11 / AC-35.5 — common for local models and proxies."""
    provider, _ = provider_with(response=make_response(usage=None))

    result = await ask(provider)

    assert result.text == "hello"
    assert result.usage is None


async def test_absent_usage_attribute_is_tolerated() -> None:
    response = SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content="ok"))], model="m"
    )
    provider, _ = provider_with(response=response)

    assert (await ask(provider)).usage is None


async def test_model_falls_back_to_configuration() -> None:
    """AC-10 — upstream may omit the model."""
    provider, _ = provider_with(response=make_response(model=None))

    assert (await ask(provider)).model == "some-model"


async def test_partial_usage_is_completed() -> None:
    usage = SimpleNamespace(prompt_tokens=5, completion_tokens=3, total_tokens=None)
    provider, _ = provider_with(response=make_response(usage=usage))

    result = await ask(provider)

    assert result.usage is not None
    assert result.usage.total_tokens == 8


# --- AC-07 / AC-35.7: token limit parameter ---------------------------------


async def test_max_output_tokens_maps_to_max_tokens() -> None:
    """AC-07 / AC-35.7 / FC-05."""
    provider, client = provider_with(response=make_response())

    await ask(provider, max_output_tokens=500)

    payload = client.completions.calls[0]
    assert payload["max_tokens"] == 500
    assert "max_completion_tokens" not in payload


async def test_request_token_limit_overrides_config() -> None:
    """AC-07."""
    provider = OpenAIChatCompletionsProvider(config(max_output_tokens=100), client=(client := FakeClient(response=make_response())))

    await ask(provider, max_output_tokens=999)

    assert client.completions.calls[0]["max_tokens"] == 999


async def test_config_token_limit_is_used_when_request_omits_it() -> None:
    provider = OpenAIChatCompletionsProvider(config(max_output_tokens=256), client=(client := FakeClient(response=make_response())))

    await ask(provider)

    assert client.completions.calls[0]["max_tokens"] == 256


async def test_max_tokens_is_omitted_when_unset() -> None:
    """AC-07 — omit rather than send a guess."""
    provider, client = provider_with(response=make_response())

    await ask(provider)

    payload = client.completions.calls[0]
    assert "max_tokens" not in payload
    assert "max_completion_tokens" not in payload


async def test_temperature_is_forwarded() -> None:
    provider = OpenAIChatCompletionsProvider(config(temperature=0.3), client=(client := FakeClient(response=make_response())))

    await ask(provider, temperature=0.9)

    assert client.completions.calls[0]["temperature"] == 0.9


async def test_request_timeout_override_is_forwarded() -> None:
    """AC-33 (P2)."""
    provider, client = provider_with(response=make_response())

    await ask(provider, timeout_s=5.0)

    assert client.completions.calls[0]["timeout"] == 5.0


async def test_messages_are_forwarded_in_order() -> None:
    provider, client = provider_with(response=make_response())

    await provider.generate(
        LLMRequest(
            messages=[
                {"role": "system", "content": "be terse"},
                {"role": "user", "content": "hi"},
            ]
        )
    )

    assert client.completions.calls[0]["messages"] == [
        {"role": "system", "content": "be terse"},
        {"role": "user", "content": "hi"},
    ]
    assert client.completions.calls[0]["model"] == "some-model"


# --- AC-08 / AC-35.9: no vendor branching -----------------------------------


async def test_payload_is_identical_across_vendors() -> None:
    """AC-08 / FC-04 — behaviour must not depend on the endpoint or model name."""
    urls_and_models = [
        ("https://api.deepseek.com/v1", "deepseek-chat"),
        ("https://openrouter.ai/api/v1", "openai/gpt-4o"),
        ("http://127.0.0.1:11434/v1", "llama3"),
        ("https://api.siliconflow.cn/v1", "Qwen/Qwen2.5-7B-Instruct"),
    ]

    payloads = []
    for url, model in urls_and_models:
        client = FakeClient(response=make_response())
        provider = OpenAIChatCompletionsProvider(config(base_url=url, model=model), client=client)
        await ask(provider, max_output_tokens=64, temperature=0.2)
        payloads.append(client.completions.calls[0])

    first = payloads[0]
    for payload in payloads[1:]:
        assert set(payload) == set(first), "parameter set varies by vendor"
        # Only `model` legitimately differs; everything else must be identical.
        assert {k: v for k, v in payload.items() if k != "model"} == {
            k: v for k, v in first.items() if k != "model"
        }


VENDOR_WORDS = ("deepseek", "openrouter", "siliconflow", "ollama", "anthropic",
                "gpt", "claude", "qwen", "gemini", "mistral")


def _vendor_specific_expressions(tree: ast.AST) -> list[str]:
    """Vendor names appearing in actual comparisons, ignoring prose.

    The package docstring deliberately quotes ``if "deepseek" in base_url`` as an
    example of what not to do, so a text search would flag the documentation. This
    walks the AST and only reports vendor names used by real branching code.
    """
    offenders: list[str] = []

    def references_vendor(value: object) -> bool:
        return isinstance(value, str) and any(word in value.lower() for word in VENDOR_WORDS)

    for node in ast.walk(tree):
        # `<vendor>` in base_url, or model == "<vendor>", etc.
        if isinstance(node, ast.Compare):
            for operand in (node.left, *node.comparators):
                if isinstance(operand, ast.Constant) and references_vendor(operand.value):
                    offenders.append(f"line {node.lineno}: comparison against {operand.value!r}")

        # model.startswith("gpt")
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "startswith"
        ):
            for argument in node.args:
                if isinstance(argument, ast.Constant) and references_vendor(argument.value):
                    offenders.append(f"line {node.lineno}: startswith({argument.value!r})")

    return offenders


def test_package_contains_no_vendor_branching() -> None:
    """AC-08 / FC-04 — a source-level guard so this cannot regress."""
    package = BACKEND_DIR / "app" / "llm"

    offenders: list[str] = []
    for source in package.rglob("*.py"):
        tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
        offenders += [f"{source.name} {item}" for item in _vendor_specific_expressions(tree)]

    assert not offenders, f"vendor-specific branching found: {offenders}"


# --- AC-13 … AC-20 / AC-35.10…35.17: error normalisation --------------------


@pytest.mark.parametrize(
    ("exception", "expected_type", "expected_code", "retryable"),
    [
        (openai.AuthenticationError, LLMAuthenticationError, "LLM_AUTHENTICATION_ERROR", False),
        (openai.PermissionDeniedError, LLMPermissionDeniedError, "LLM_PERMISSION_DENIED", False),
        (openai.RateLimitError, LLMRateLimitError, "LLM_RATE_LIMIT", True),
        (openai.BadRequestError, LLMBadRequestError, "LLM_BAD_REQUEST", False),
        (openai.UnprocessableEntityError, LLMBadRequestError, "LLM_BAD_REQUEST", False),
        (openai.NotFoundError, LLMNotFoundError, "LLM_NOT_FOUND", False),
        (openai.InternalServerError, LLMServerError, "LLM_SERVER_ERROR", True),
    ],
)
async def test_status_errors_are_normalised(
    exception: type[Exception], expected_type: type[LLMError], expected_code: str, retryable: bool
) -> None:
    """AC-13 … AC-20 / AC-35.10 … AC-35.17."""
    status = getattr(exception, "status_code", 500)
    provider, _ = provider_with(error=sdk_status_error(exception, status))

    with pytest.raises(expected_type) as excinfo:
        await ask(provider)

    error = excinfo.value
    assert error.code == expected_code
    assert error.retryable is retryable
    assert error.message
    assert error.cause is not None


@pytest.mark.parametrize("status", [500, 502, 503, 504])
async def test_every_5xx_is_a_server_error(status: int) -> None:
    """AC-18."""
    provider, _ = provider_with(error=sdk_status_error(openai.InternalServerError, status))

    with pytest.raises(LLMServerError) as excinfo:
        await ask(provider)

    assert excinfo.value.code == "LLM_SERVER_ERROR"
    assert excinfo.value.retryable is True


async def test_timeout_is_normalised() -> None:
    """AC-16 / AC-35.13."""
    request = httpx.Request("POST", "https://api.example.com/v1/chat/completions")
    provider, _ = provider_with(error=openai.APITimeoutError(request=request))

    with pytest.raises(LLMTimeoutError) as excinfo:
        await ask(provider)

    assert excinfo.value.code == "LLM_TIMEOUT"
    assert excinfo.value.retryable is True


async def test_asyncio_timeout_is_normalised() -> None:
    """AC-16 — a plain asyncio timeout maps the same way."""
    provider, _ = provider_with(error=asyncio.TimeoutError())

    with pytest.raises(LLMTimeoutError):
        await ask(provider)


async def test_connection_failure_is_normalised() -> None:
    """AC-17 / AC-35.14."""
    request = httpx.Request("POST", "https://api.example.com/v1/chat/completions")
    provider, _ = provider_with(error=openai.APIConnectionError(request=request))

    with pytest.raises(LLMConnectionError) as excinfo:
        await ask(provider)

    assert excinfo.value.code == "LLM_CONNECTION_ERROR"
    assert excinfo.value.retryable is True


async def test_unmapped_status_error_falls_back() -> None:
    """AC-29 — an SDK error with no specific mapping still normalises."""
    provider, _ = provider_with(error=sdk_status_error(openai.APIStatusError, 418, "teapot"))

    with pytest.raises(LLMAPIError) as excinfo:
        await ask(provider)

    assert excinfo.value.code == "LLM_API_ERROR"
    assert excinfo.value.retryable is False


async def test_unmapped_5xx_status_error_is_retryable() -> None:
    """AC-29 — retryability inferred from status."""
    provider, _ = provider_with(error=sdk_status_error(openai.APIStatusError, 599, "weird"))

    with pytest.raises(LLMError) as excinfo:
        await ask(provider)

    assert excinfo.value.retryable is True


async def test_unexpected_exception_is_wrapped_not_leaked() -> None:
    """FC-07 — even a non-SDK failure must arrive as an LLMError."""
    provider, _ = provider_with(error=RuntimeError("internal boom"))

    with pytest.raises(LLMAPIError) as excinfo:
        await ask(provider)

    assert excinfo.value.cause is not None


@pytest.mark.parametrize("error_type", [LLMError, LLMAuthenticationError, LLMRateLimitError])
async def test_existing_llm_errors_pass_through_unwrapped(error_type: type[LLMError]) -> None:
    provider, _ = provider_with(error=error_type("already normalised"))

    with pytest.raises(error_type):
        await ask(provider)


# --- AC-22 / AC-35.21: secret redaction in errors ---------------------------


async def test_secret_in_upstream_error_is_redacted() -> None:
    """AC-22 / AC-35.21 / FC-02."""
    provider, _ = provider_with(
        error=sdk_status_error(
            openai.AuthenticationError, 401, f"Invalid key: Bearer {SECRET}"
        )
    )

    with pytest.raises(LLMAuthenticationError) as excinfo:
        await ask(provider)

    rendered = f"{excinfo.value} {excinfo.value.message} {excinfo.value!r}"
    assert SECRET not in rendered
    assert "[REDACTED]" in excinfo.value.message


async def test_bare_secret_in_upstream_error_is_redacted() -> None:
    """The key literal is stripped even without a `Bearer`/`key=` wrapper."""
    provider, _ = provider_with(
        error=sdk_status_error(openai.BadRequestError, 400, f"rejected credential {SECRET}")
    )

    with pytest.raises(LLMBadRequestError) as excinfo:
        await ask(provider)

    assert SECRET not in str(excinfo.value)


async def test_secret_never_reaches_the_log_stream(caplog: pytest.LogCaptureFixture) -> None:
    """FC-02 — a failing call must not log the key."""
    provider, _ = provider_with(error=sdk_status_error(openai.AuthenticationError, 401, f"Bearer {SECRET}"))

    with caplog.at_level(logging.DEBUG):
        with pytest.raises(LLMAuthenticationError):
            await ask(provider)

    assert SECRET not in caplog.text


def test_provider_repr_does_not_leak_the_key() -> None:
    provider, _ = provider_with()

    rendered = f"{provider.config!r} {provider.config}"

    assert SECRET not in rendered


# --- AC-21 / AC-28 / AC-35.18…35.20: malformed responses --------------------


@pytest.mark.parametrize(
    ("label", "response"),
    [
        ("empty choices", make_response(choices=[])),
        ("choices None", make_response(choices=None)),
        ("message None", make_response(choices=[SimpleNamespace(message=None)])),
        ("content None", make_response(content=None)),
        ("content empty", make_response(content="")),
        ("content whitespace", make_response(content="   \n\t  ")),
        ("content not a string", make_response(content={"unexpected": "shape"})),
        ("choice without message attr", make_response(choices=[SimpleNamespace()])),
    ],
)
async def test_malformed_responses_raise_invalid_response(label: str, response: Any) -> None:
    """AC-21 / AC-28 / FC-07 — never an IndexError/AttributeError/TypeError."""
    provider, _ = provider_with(response=response)

    with pytest.raises(LLMInvalidResponseError) as excinfo:
        await ask(provider)

    assert excinfo.value.code == "LLM_INVALID_RESPONSE"
    assert excinfo.value.retryable is False


async def test_sdk_response_validation_error_is_normalised() -> None:
    """AC-21 — the SDK's own validation failure maps to ours."""
    request = httpx.Request("POST", "https://api.example.com/v1/chat/completions")
    response = httpx.Response(200, request=request, json={})
    provider, _ = provider_with(
        error=openai.APIResponseValidationError(response=response, body=None)
    )

    with pytest.raises(LLMInvalidResponseError):
        await ask(provider)


async def test_response_content_is_not_echoed_in_the_error() -> None:
    """A malformed payload may still contain sensitive text; do not quote it."""
    provider, _ = provider_with(response=make_response(content="   "))

    with pytest.raises(LLMInvalidResponseError) as excinfo:
        await ask(provider)

    assert "   " not in excinfo.value.message


# --- AC-23 / AC-35.22: cancellation -----------------------------------------


async def test_cancellation_propagates_untouched() -> None:
    """AC-23 / FC-08 — CancelledError must not become an LLMError."""
    started = asyncio.Event()

    async def slow_create(**kwargs: Any) -> Any:
        started.set()
        await asyncio.sleep(30)
        return make_response()

    client = FakeClient()
    client.completions.create = slow_create  # type: ignore[method-assign]
    provider = OpenAIChatCompletionsProvider(config(), client=client)

    task = asyncio.create_task(ask(provider))
    await started.wait()
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task


# --- AC-26 / AC-35.23, AC-35.24: connection probe ---------------------------


async def test_connection_probe_succeeds() -> None:
    """AC-26 / AC-35.23."""
    provider, client = provider_with(response=make_response(content="OK"))

    report = await provider.test_connection()

    assert report.ok is True
    assert report.latency_ms is not None and report.latency_ms >= 0
    assert report.message == "Connection successful"
    assert report.model == "test-model"

    # The probe must be cheap: one token, one trivial message.
    payload = client.completions.calls[0]
    assert payload["max_tokens"] == 1
    assert len(payload["messages"]) == 1


async def test_connection_probe_reports_failure_without_raising() -> None:
    """AC-26 / AC-35.24 — a settings screen needs the outcome, not an exception."""
    provider, _ = provider_with(error=sdk_status_error(openai.AuthenticationError, 401, "bad key"))

    report = await provider.test_connection()

    assert report.ok is False
    assert report.latency_ms is None
    assert "LLM_AUTHENTICATION_ERROR" in report.message


async def test_connection_probe_failure_does_not_leak_the_key() -> None:
    provider, _ = provider_with(
        error=sdk_status_error(openai.AuthenticationError, 401, f"Bearer {SECRET}")
    )

    report = await provider.test_connection()

    assert SECRET not in report.message


async def test_connection_probe_does_not_swallow_cancellation() -> None:
    """AC-23 — a cancelled probe cancels; it is not reported as a failed probe."""
    started = asyncio.Event()

    async def slow_create(**kwargs: Any) -> Any:
        started.set()
        await asyncio.sleep(30)

    client = FakeClient()
    client.completions.create = slow_create  # type: ignore[method-assign]
    provider = OpenAIChatCompletionsProvider(config(), client=client)

    task = asyncio.create_task(provider.test_connection())
    await started.wait()
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task


# --- AC-32: streaming hook --------------------------------------------------


async def test_streaming_hook_is_declared_but_unimplemented() -> None:
    """AC-32 — the contract is complete; no streaming subsystem was built."""
    provider, _ = provider_with()

    with pytest.raises(NotImplementedError):
        async for _ in provider.generate_stream(
            LLMRequest(messages=[{"role": "user", "content": "hi"}])
        ):
            pass


# --- AC-31: dependency declaration ------------------------------------------


def test_openai_is_declared_explicitly() -> None:
    """AC-31 — a dependency we program against must not be transitive."""
    manifest = (BACKEND_DIR / "pyproject.toml").read_text(encoding="utf-8")

    assert "openai" in manifest.lower()
