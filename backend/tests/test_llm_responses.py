"""DS-BE-003 — OpenAI Responses adapter.

Runs offline. Well-formed responses are built as **real SDK objects** so the
adapter is exercised against the genuine schema; malformed ones use a stub whose
``output_text`` property mirrors the SDK's, so the failure modes are faithful.
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
    OpenAIResponsesProvider,
    ProviderConfig,
    build_responses_client,
)
from app.llm import responses as responses_module
from openai.types.responses import Response, ResponseUsage
from openai.types.responses.response_error import ResponseError
from openai.types.responses.response_output_message import ResponseOutputMessage
from openai.types.responses.response_output_refusal import ResponseOutputRefusal
from openai.types.responses.response_output_text import ResponseOutputText
from openai.types.responses.response_usage import InputTokensDetails, OutputTokensDetails

SECRET = "sk-live-RESPONSES-SECRET-9876"


# --- Fakes ------------------------------------------------------------------


class FakeResponses:
    """Stands in for ``client.responses``."""

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
        self.responses = FakeResponses(response=response, error=error)


class StubResponse:
    """Mirrors the SDK's ``output_text`` property, including its failure modes.

    ``output_text`` iterates ``self.output``, so a null ``output`` raises
    ``TypeError`` exactly as the real property does — which is the behaviour the
    adapter's guard exists to absorb.
    """

    def __init__(
        self,
        *,
        output: Any = None,
        status: str = "completed",
        model: str | None = "stub-model",
        usage: Any = None,
        error: Any = None,
    ) -> None:
        self.output = output
        self.status = status
        self.model = model
        self.usage = usage
        self.error = error

    @property
    def output_text(self) -> str:
        texts: list[str] = []
        for item in self.output:  # TypeError when output is None, as in the SDK
            if getattr(item, "type", None) == "message":
                for part in getattr(item, "content", None) or []:
                    if getattr(part, "type", None) == "output_text":
                        text = getattr(part, "text", None)
                        if text is not None:
                            texts.append(text)
        return "".join(texts)


def usage_of(input_tokens: int = 11, output_tokens: int = 7, total: int | None = 18) -> ResponseUsage:
    return ResponseUsage(
        input_tokens=input_tokens,
        input_tokens_details=InputTokensDetails(cached_tokens=0, cache_write_tokens=0),
        output_tokens=output_tokens,
        output_tokens_details=OutputTokensDetails(reasoning_tokens=0),
        total_tokens=total if total is not None else input_tokens + output_tokens,
    )


def build_response(
    *,
    text: str | None = "hello",
    model: str | None = "resp-model",
    status: str = "completed",
    usage: Any = "default",
    error: Any = None,
    content: list[Any] | None = None,
    output: list[Any] | None = None,
) -> Response:
    """Build a real SDK ``Response``."""
    if output is None:
        if content is None:
            content = (
                [ResponseOutputText(type="output_text", text=text, annotations=[])]
                if text is not None
                else []
            )
        output = (
            [ResponseOutputMessage(id="msg_1", type="message", role="assistant", status="completed", content=content)]
            if content
            else []
        )

    resolved_usage = usage_of() if usage == "default" else usage
    return Response(
        id="resp_1", created_at=0, model=model, object="response", output=output,
        parallel_tool_calls=False, tool_choice="auto", tools=[], status=status,
        usage=resolved_usage, error=error, incomplete_details=None, instructions=None,
        metadata=None, temperature=None, top_p=None,
    )


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
    request = httpx.Request("POST", "https://api.example.com/v1/responses")
    response = httpx.Response(status, request=request, json={"error": {"message": message}})
    return cls(message, response=response, body=None)


def provider_with(**kwargs: Any) -> tuple[OpenAIResponsesProvider, FakeClient]:
    client = FakeClient(**kwargs)
    return OpenAIResponsesProvider(config(), client=client), client


async def ask(provider: OpenAIResponsesProvider, **request_kwargs: Any) -> LLMResult:
    return await provider.generate(
        LLMRequest(messages=[{"role": "user", "content": "hi"}], **request_kwargs)
    )


def capture_client_kwargs(configured: ProviderConfig) -> dict[str, Any]:
    """Run ``build_responses_client`` with a recording stub."""
    captured: dict[str, Any] = {}

    class Recorder:
        def __init__(self, **kwargs: Any) -> None:
            captured.update(kwargs)

    original = responses_module.AsyncOpenAI
    responses_module.AsyncOpenAI = Recorder  # type: ignore[assignment]
    try:
        build_responses_client(configured)
    finally:
        responses_module.AsyncOpenAI = original  # type: ignore[assignment]

    return captured


# --- AC-29.01 … AC-29.03: contract ------------------------------------------


def test_responses_provider_export() -> None:
    """AC-01 / AC-29.01."""
    import app.llm as llm

    assert hasattr(llm, "OpenAIResponsesProvider")
    assert issubclass(llm.OpenAIResponsesProvider, LLMProvider)


def test_responses_protocol_identifier() -> None:
    """AC-02 / AC-29.03."""
    provider, _ = provider_with()
    assert provider.protocol == "responses"


def test_responses_provider_implements_the_shared_interface() -> None:
    """AC-02 — usable through the base type with no protocol awareness."""
    provider, _ = provider_with()
    assert isinstance(provider, LLMProvider)


def test_responses_package_import_is_inert(tmp_path) -> None:
    """AC-01 / AC-29.02."""
    env = {**os.environ, "DATABASE_PATH": str(tmp_path / "must-not-appear.sqlite3")}

    result = subprocess.run(
        [sys.executable, "-c", "import app.llm; print('imported')"],
        cwd=BACKEND_DIR, env=env, capture_output=True, text=True, timeout=60,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "imported"
    assert not (tmp_path / "must-not-appear.sqlite3").exists()


def test_shared_contract_modules_are_unmodified() -> None:
    """AC-03 / FC-02 — the abstraction should need no changes to absorb a protocol.

    If this fails, the DS-BE-002 design was incomplete, which is exactly what
    this task exists to discover.
    """
    for name in ("base.py", "models.py", "errors.py"):
        source = (BACKEND_DIR / "app" / "llm" / name).read_text(encoding="utf-8")
        compile(source, name, "exec")  # still valid Python, at minimum

    import app.llm.models as models
    import app.llm.errors as errors

    # No Responses-specific type was added to the shared models.
    assert not hasattr(models, "ResponsesRequest")
    assert not hasattr(errors, "LLMRefusalError"), "AC-14 forbids a new refusal error type"


# --- Q1 / AC-04, AC-05: message mapping -------------------------------------


async def test_single_system_message_becomes_instructions() -> None:
    """AC-04 / AC-29.07."""
    provider, client = provider_with(response=build_response())

    await provider.generate(
        LLMRequest(
            messages=[
                {"role": "system", "content": "be terse"},
                {"role": "user", "content": "hi"},
            ]
        )
    )

    payload = client.responses.calls[0]
    assert payload["instructions"] == "be terse"
    assert payload["input"] == [{"role": "user", "content": "hi"}]


async def test_multiple_system_messages_are_joined_in_order() -> None:
    """AC-04 / AC-29.08 — last-wins would silently destroy earlier instructions."""
    provider, client = provider_with(response=build_response())

    await provider.generate(
        LLMRequest(
            messages=[
                {"role": "system", "content": "first"},
                {"role": "user", "content": "hi"},
                {"role": "system", "content": "second"},
            ]
        )
    )

    assert client.responses.calls[0]["instructions"] == "first\n\nsecond"


async def test_no_system_message_omits_instructions() -> None:
    """AC-04 / AC-29.09 — omitted, never None or empty string."""
    provider, client = provider_with(response=build_response())

    await ask(provider)

    assert "instructions" not in client.responses.calls[0]


async def test_non_system_messages_preserve_order() -> None:
    """AC-05 / AC-29.10."""
    provider, client = provider_with(response=build_response())

    await provider.generate(
        LLMRequest(
            messages=[
                {"role": "user", "content": "one"},
                {"role": "assistant", "content": "two"},
                {"role": "user", "content": "three"},
            ]
        )
    )

    assert client.responses.calls[0]["input"] == [
        {"role": "user", "content": "one"},
        {"role": "assistant", "content": "two"},
        {"role": "user", "content": "three"},
    ]


# --- AC-06 … AC-09: configuration plumbing ----------------------------------


@pytest.mark.parametrize(
    "base_url",
    [
        "https://api.openai.com/v1",
        "http://localhost:8000",
        "https://gateway.example.com/v1/",
        "https://example.com",
    ],
)
def test_verbatim_base_url(base_url: str) -> None:
    """AC-06 / AC-29.11 / FC-04."""
    assert capture_client_kwargs(config(base_url=base_url))["base_url"] == base_url


def test_max_retries_zero() -> None:
    """AC-07 / AC-29.12 / FC-07."""
    assert capture_client_kwargs(config())["max_retries"] == 0


def test_real_client_reports_zero_retries() -> None:
    assert build_responses_client(config()).max_retries == 0


async def test_max_output_tokens_is_the_native_parameter() -> None:
    """AC-08 / AC-29.13 / FC-06 — never max_tokens or max_completion_tokens."""
    provider, client = provider_with(response=build_response())

    await ask(provider, max_output_tokens=321)

    payload = client.responses.calls[0]
    assert payload["max_output_tokens"] == 321
    assert "max_tokens" not in payload
    assert "max_completion_tokens" not in payload


async def test_request_token_limit_overrides_config() -> None:
    """AC-08 / AC-29.14."""
    client = FakeClient(response=build_response())
    provider = OpenAIResponsesProvider(config(max_output_tokens=100), client=client)

    await ask(provider, max_output_tokens=999)

    assert client.responses.calls[0]["max_output_tokens"] == 999


async def test_config_token_limit_used_when_request_omits_it() -> None:
    client = FakeClient(response=build_response())
    provider = OpenAIResponsesProvider(config(max_output_tokens=256), client=client)

    await ask(provider)

    assert client.responses.calls[0]["max_output_tokens"] == 256


async def test_token_limit_omitted_when_unset() -> None:
    """AC-08 / AC-29.15 — omitted, never None or a guessed default."""
    provider, client = provider_with(response=build_response())

    await ask(provider)

    assert "max_output_tokens" not in client.responses.calls[0]


async def test_temperature_and_timeout_forwarding() -> None:
    """AC-09 / AC-29.16."""
    client = FakeClient(response=build_response())
    provider = OpenAIResponsesProvider(config(temperature=0.2), client=client)

    await ask(provider, temperature=0.8, timeout_s=5.0)

    payload = client.responses.calls[0]
    assert payload["temperature"] == 0.8
    assert payload["timeout"] == 5.0


async def test_temperature_omitted_when_unset() -> None:
    """AC-09."""
    provider, client = provider_with(response=build_response())

    await ask(provider)

    assert "temperature" not in client.responses.calls[0]


def test_custom_headers_forwarded() -> None:
    """AC-24 / AC-29.31."""
    headers = {"HTTP-Referer": "https://example.com", "X-Title": "PDF Copilot"}

    assert capture_client_kwargs(config(custom_headers=headers))["default_headers"] == headers


def test_configured_timeout_reaches_the_client() -> None:
    assert capture_client_kwargs(config(timeout_s=12.5))["timeout"] == 12.5


def test_empty_api_key_uses_the_shared_placeholder() -> None:
    """AC-23 — keyless local gateways must still build a client."""
    from app.llm import KEYLESS_API_KEY_PLACEHOLDER

    assert capture_client_kwargs(config(api_key=""))["api_key"] == KEYLESS_API_KEY_PLACEHOLDER


# --- AC-10, AC-11: result normalisation -------------------------------------


async def test_successful_generation_is_normalised() -> None:
    """AC-10 / AC-29.04."""
    provider, _ = provider_with(response=build_response(text="Bellman.", model="m-1"))

    result = await ask(provider)

    assert isinstance(result, LLMResult)
    assert result.text == "Bellman."
    assert result.model == "m-1"
    assert result.protocol == "responses"


async def test_usage_maps_input_output_onto_prompt_completion() -> None:
    """AC-11 / AC-29.05 — the naming difference must not reach callers."""
    provider, _ = provider_with(response=build_response(usage=usage_of(11, 7, 18)))

    result = await ask(provider)

    assert result.usage is not None
    assert result.usage.prompt_tokens == 11
    assert result.usage.completion_tokens == 7
    assert result.usage.total_tokens == 18


async def test_missing_usage_is_tolerated() -> None:
    """AC-11 / AC-29.06."""
    provider, _ = provider_with(response=build_response(usage=None))

    result = await ask(provider)

    assert result.text == "hello"
    assert result.usage is None


async def test_total_tokens_computed_when_omitted() -> None:
    """AC-11 — derive the total rather than reporting 0.

    Driven through a stub because ``ResponseUsage`` insists on the detail
    sub-objects; a compatible provider is not obliged to send them.
    """
    partial = SimpleNamespace(input_tokens=5, output_tokens=3, total_tokens=None)
    response = StubResponse(
        output=[SimpleNamespace(type="message", content=[SimpleNamespace(type="output_text", text="ok")])],
        usage=partial,
    )
    provider, _ = provider_with(response=response)

    result = await ask(provider)

    assert result.usage is not None
    assert (result.usage.prompt_tokens, result.usage.completion_tokens) == (5, 3)
    assert result.usage.total_tokens == 8


async def test_usage_with_no_token_attributes_is_treated_as_absent() -> None:
    """AC-11 — an unrecognisable usage object must not crash or invent zeros."""
    provider, _ = provider_with(
        response=StubResponse(
            output=[SimpleNamespace(type="message", content=[SimpleNamespace(type="output_text", text="ok")])],
            usage=SimpleNamespace(),
        )
    )

    assert (await ask(provider)).usage is None


async def test_model_falls_back_to_configuration() -> None:
    """AC-10 — upstream may omit the model.

    A stub is used because the SDK types ``Response.model`` as non-nullable; a
    compatible provider is not bound by that.
    """
    provider, _ = provider_with(
        response=StubResponse(
            output=[SimpleNamespace(type="message", content=[SimpleNamespace(type="output_text", text="ok")])],
            model=None,
        )
    )

    assert (await ask(provider)).model == "some-model"


async def test_no_sdk_object_escapes() -> None:
    provider, _ = provider_with(response=build_response())

    result = await ask(provider)

    assert type(result) is LLMResult
    assert not hasattr(result, "output")


# --- AC-12: incomplete (Q3) -------------------------------------------------


async def test_incomplete_with_text_succeeds() -> None:
    """AC-12 / AC-29.17 — partial text at a token cap is still useful."""
    provider, _ = provider_with(response=build_response(text="partial answer", status="incomplete"))

    result = await ask(provider)

    assert result.text == "partial answer"


async def test_incomplete_without_text_raises_truncation() -> None:
    """AC-12 / AC-29.18, refined by DS-CTX-001-QA.

    An incomplete response is *truncation*, not an invalid one: the endpoint
    answered correctly and was cut off. Reported distinctly so the caller can
    give it more room and retry, rather than being told the provider is broken.

    This assertion previously pinned `LLM_INVALID_RESPONSE`. It was changed
    deliberately when a real reasoning model exposed the difference — with a
    one-token budget it returns exactly this, and calling it an invalid response
    made the endpoint look unusable when it was healthy.
    """
    from app.llm.errors import LLMOutputTruncatedError

    provider, _ = provider_with(response=build_response(text=None, status="incomplete"))

    with pytest.raises(LLMOutputTruncatedError) as excinfo:
        await ask(provider)

    assert excinfo.value.code == "LLM_OUTPUT_TRUNCATED"
    assert excinfo.value.retryable is True


async def test_a_complete_response_with_no_text_is_still_invalid() -> None:
    """The guard this replaced is intact: only *truncation* changed meaning.

    A response that finished normally and still carries no text is a provider
    returning nothing, and that remains an invalid response rather than
    something to retry with a bigger budget.
    """
    provider, _ = provider_with(response=build_response(text=None, status="completed"))

    with pytest.raises(LLMInvalidResponseError) as excinfo:
        await ask(provider)

    assert excinfo.value.code == "LLM_INVALID_RESPONSE"


# --- AC-13: failed status (Q2) ----------------------------------------------


@pytest.mark.parametrize(
    ("error_code", "expected_type", "expected_code", "retryable"),
    [
        ("server_error", LLMServerError, "LLM_SERVER_ERROR", True),
        ("rate_limit_exceeded", LLMRateLimitError, "LLM_RATE_LIMIT", True),
        ("vector_store_timeout", LLMTimeoutError, "LLM_TIMEOUT", True),
        ("invalid_prompt", LLMBadRequestError, "LLM_BAD_REQUEST", False),
        ("bio_policy", LLMBadRequestError, "LLM_BAD_REQUEST", False),
    ],
)
async def test_failed_status_maps_error_codes(
    error_code: str, expected_type: type[LLMError], expected_code: str, retryable: bool
) -> None:
    """AC-13 / AC-29.19 … AC-29.22 — using the real SDK ``ResponseError``."""
    response = build_response(text=None, status="failed", error=ResponseError(code=error_code, message="boom"))
    provider, _ = provider_with(response=response)

    with pytest.raises(expected_type) as excinfo:
        await ask(provider)

    assert excinfo.value.code == expected_code
    assert excinfo.value.retryable is retryable


async def test_failed_status_with_unmapped_code_falls_back() -> None:
    """AC-13 — an unrecognised code must not be mistaken for a known one.

    Driven through a stub: ``ResponseError.code`` is a closed ``Literal``, so the
    SDK cannot even represent a code we have not listed. A compatible provider is
    not bound by that type, which is exactly why the fallback exists.
    """
    response = StubResponse(
        output=[], status="failed", error=SimpleNamespace(code="something_unmapped", message="boom")
    )
    provider, _ = provider_with(response=response)

    with pytest.raises(LLMAPIError) as excinfo:
        await ask(provider)

    assert excinfo.value.code == "LLM_API_ERROR"
    assert excinfo.value.retryable is False


async def test_failed_without_error_details_raises_invalid_response() -> None:
    """AC-13."""
    provider, _ = provider_with(response=build_response(text=None, status="failed", error=None))

    with pytest.raises(LLMInvalidResponseError):
        await ask(provider)


async def test_failed_error_message_is_sanitised() -> None:
    """AC-17 — an in-band error message is still scrubbed."""
    response = build_response(
        text=None,
        status="failed",
        error=ResponseError(code="server_error", message=f"upstream rejected Bearer {SECRET}"),
    )
    provider, _ = provider_with(response=response)

    with pytest.raises(LLMServerError) as excinfo:
        await ask(provider)

    assert SECRET not in f"{excinfo.value} {excinfo.value.message}"


# --- AC-14: refusals (Q4) ---------------------------------------------------


async def test_refusal_raises_invalid_response() -> None:
    """AC-14 / AC-29.23 — no new error type is introduced."""
    refusal_part = ResponseOutputRefusal(type="refusal", refusal="I cannot help with that")
    provider, _ = provider_with(response=build_response(content=[refusal_part]))

    with pytest.raises(LLMInvalidResponseError) as excinfo:
        await ask(provider)

    assert excinfo.value.code == "LLM_INVALID_RESPONSE"
    assert excinfo.value.retryable is False
    assert "refused" in excinfo.value.message.lower()


async def test_refusal_is_not_reported_as_empty_content() -> None:
    """AC-14 — a refusal is a distinct, actionable outcome."""
    refusal_part = ResponseOutputRefusal(type="refusal", refusal="policy")
    provider, _ = provider_with(response=build_response(content=[refusal_part]))

    with pytest.raises(LLMInvalidResponseError) as excinfo:
        await ask(provider)

    assert excinfo.value.message != "Provider returned empty content"


# --- AC-15: malformed responses ---------------------------------------------


@pytest.mark.parametrize(
    ("label", "response"),
    [
        ("output is None", StubResponse(output=None)),
        ("empty output list", StubResponse(output=[])),
        ("message with no content", StubResponse(output=[SimpleNamespace(type="message", content=None)])),
        ("message with empty content", StubResponse(output=[SimpleNamespace(type="message", content=[])])),
        ("non-text part", StubResponse(output=[SimpleNamespace(type="message", content=[SimpleNamespace(type="output_text", text=123)])])),
        ("only non-message items", StubResponse(output=[SimpleNamespace(type="reasoning")])),
        ("whitespace only", StubResponse(output=[SimpleNamespace(type="message", content=[SimpleNamespace(type="output_text", text="   \n\t ")])])),
    ],
)
async def test_malformed_responses_raise_invalid_response(label: str, response: Any) -> None:
    """AC-15 / AC-25 / AC-29.24 / FC-08 — never a primitive exception."""
    provider, _ = provider_with(response=response)

    with pytest.raises(LLMInvalidResponseError) as excinfo:
        await ask(provider)

    assert excinfo.value.code == "LLM_INVALID_RESPONSE"
    assert excinfo.value.retryable is False


async def test_sdk_response_validation_error_is_normalised() -> None:
    """AC-15."""
    request = httpx.Request("POST", "https://api.example.com/v1/responses")
    response = httpx.Response(200, request=request, json={})
    provider, _ = provider_with(error=openai.APIResponseValidationError(response=response, body=None))

    with pytest.raises(LLMInvalidResponseError):
        await ask(provider)


# --- AC-16: SDK/HTTP error normalisation ------------------------------------


@pytest.mark.parametrize(
    ("exception", "expected_type", "expected_code", "retryable"),
    [
        (openai.AuthenticationError, LLMAuthenticationError, "LLM_AUTHENTICATION_ERROR", False),
        (openai.PermissionDeniedError, LLMPermissionDeniedError, "LLM_PERMISSION_DENIED", False),
        (openai.RateLimitError, LLMRateLimitError, "LLM_RATE_LIMIT", True),
        (openai.BadRequestError, LLMBadRequestError, "LLM_BAD_REQUEST", False),
        (openai.NotFoundError, LLMNotFoundError, "LLM_NOT_FOUND", False),
        (openai.InternalServerError, LLMServerError, "LLM_SERVER_ERROR", True),
    ],
)
async def test_sdk_status_errors_are_normalised(
    exception: type[Exception], expected_type: type[LLMError], expected_code: str, retryable: bool
) -> None:
    """AC-16 / AC-29.25 — identical codes to the Chat Completions adapter."""
    status = getattr(exception, "status_code", 500)
    provider, _ = provider_with(error=sdk_status_error(exception, status))

    with pytest.raises(expected_type) as excinfo:
        await ask(provider)

    assert excinfo.value.code == expected_code
    assert excinfo.value.retryable is retryable


async def test_timeout_is_normalised() -> None:
    """AC-16."""
    request = httpx.Request("POST", "https://api.example.com/v1/responses")
    provider, _ = provider_with(error=openai.APITimeoutError(request=request))

    with pytest.raises(LLMTimeoutError) as excinfo:
        await ask(provider)

    assert excinfo.value.retryable is True


async def test_connection_failure_is_normalised() -> None:
    """AC-16."""
    request = httpx.Request("POST", "https://api.example.com/v1/responses")
    provider, _ = provider_with(error=openai.APIConnectionError(request=request))

    with pytest.raises(LLMConnectionError):
        await ask(provider)


# --- AC-17: secrets ---------------------------------------------------------


async def test_secret_redacted_in_errors_and_repr() -> None:
    """AC-17 / AC-29.26 / FC-03."""
    provider, _ = provider_with(
        error=sdk_status_error(openai.AuthenticationError, 401, f"Invalid key: Bearer {SECRET}")
    )

    with pytest.raises(LLMAuthenticationError) as excinfo:
        await ask(provider)

    surfaces = [str(excinfo.value), repr(excinfo.value), excinfo.value.message, repr(provider.config), str(provider.config)]
    for surface in surfaces:
        assert SECRET not in surface


async def test_secret_never_reaches_the_log_stream(caplog: pytest.LogCaptureFixture) -> None:
    """AC-17."""
    provider, _ = provider_with(error=sdk_status_error(openai.AuthenticationError, 401, f"Bearer {SECRET}"))

    with caplog.at_level(logging.DEBUG):
        with pytest.raises(LLMAuthenticationError):
            await ask(provider)

    assert SECRET not in caplog.text


# --- AC-18: cancellation ----------------------------------------------------


async def test_cancellation_propagates_from_generate() -> None:
    """AC-18 / AC-29.27 / FC-09."""
    started = asyncio.Event()

    async def slow_create(**kwargs: Any) -> Any:
        started.set()
        await asyncio.sleep(30)
        return build_response()

    client = FakeClient()
    client.responses.create = slow_create  # type: ignore[method-assign]
    provider = OpenAIResponsesProvider(config(), client=client)

    task = asyncio.create_task(ask(provider))
    await started.wait()
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task


async def test_cancellation_propagates_from_test_connection() -> None:
    """AC-18."""
    started = asyncio.Event()

    async def slow_create(**kwargs: Any) -> Any:
        started.set()
        await asyncio.sleep(30)

    client = FakeClient()
    client.responses.create = slow_create  # type: ignore[method-assign]
    provider = OpenAIResponsesProvider(config(), client=client)

    task = asyncio.create_task(provider.test_connection())
    await started.wait()
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task


# --- AC-19: no vendor branching ---------------------------------------------


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
            and node.func.attr == "startswith"
        ):
            for argument in node.args:
                if isinstance(argument, ast.Constant) and references_vendor(argument.value):
                    offenders.append(f"line {node.lineno}: startswith({argument.value!r})")
    return offenders


def test_no_vendor_branching() -> None:
    """AC-19 / AC-29.28 / FC-05."""
    package = BACKEND_DIR / "app" / "llm"

    offenders: list[str] = []
    for source in package.rglob("*.py"):
        tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
        offenders += [f"{source.name} {item}" for item in _vendor_specific_expressions(tree)]

    assert not offenders, f"vendor-specific branching found: {offenders}"


# --- AC-22: connection probe -------------------------------------------------


async def test_connection_probe_success() -> None:
    """AC-22 / AC-29.29."""
    provider, client = provider_with(response=build_response(text="OK", model="probe-model"))

    report = await provider.test_connection()

    assert report.ok is True
    assert report.latency_ms is not None and report.latency_ms >= 0
    assert report.message == "Connection successful"
    assert report.model == "probe-model"

    payload = client.responses.calls[0]
    assert payload["max_output_tokens"] == 1
    assert len(payload["input"]) == 1


async def test_connection_probe_failure_does_not_raise() -> None:
    """AC-22 / AC-29.30."""
    provider, _ = provider_with(error=sdk_status_error(openai.AuthenticationError, 401, "bad key"))

    report = await provider.test_connection()

    assert report.ok is False
    assert report.latency_ms is None
    assert "LLM_AUTHENTICATION_ERROR" in report.message


async def test_connection_probe_failure_hides_the_key() -> None:
    """AC-22 / AC-17."""
    provider, _ = provider_with(error=sdk_status_error(openai.AuthenticationError, 401, f"Bearer {SECRET}"))

    report = await provider.test_connection()

    assert SECRET not in report.message


# --- AC-26: cross-protocol interchangeability --------------------------------


async def test_cross_protocol_caller_interchangeability() -> None:
    """AC-26 / AC-29.32 — the criterion that justifies this task.

    One caller, written only against ``LLMProvider``, runs against both protocols
    with zero branching and receives identical result shapes.
    """
    from app.llm import OpenAIChatCompletionsProvider

    async def caller(provider: LLMProvider, prompt: str) -> LLMResult:
        """Knows nothing about protocols."""
        return await provider.generate(LLMRequest(messages=[{"role": "user", "content": prompt}]))

    chat_result = await caller(
        OpenAIChatCompletionsProvider(config(), client=_ChatFake()),
        "hi",
    )
    responses_result = await caller(provider_with(response=build_response())[0], "hi")

    assert type(chat_result) is type(responses_result) is LLMResult
    assert chat_result.text == responses_result.text
    assert (chat_result.protocol, responses_result.protocol) == ("chat_completions", "responses")
    assert type(chat_result.usage) is type(responses_result.usage)
    assert chat_result.usage == responses_result.usage


async def test_cross_protocol_error_codes_match() -> None:
    """AC-26 — identical failures produce identical codes across protocols."""
    from app.llm import OpenAIChatCompletionsProvider

    chat, _ = _chat_provider_with_error(sdk_status_error(openai.RateLimitError, 429))
    responses, _ = provider_with(error=sdk_status_error(openai.RateLimitError, 429))

    async def code_of(provider: LLMProvider) -> str:
        try:
            await provider.generate(LLMRequest(messages=[{"role": "user", "content": "hi"}]))
        except LLMError as exc:
            return exc.code
        raise AssertionError("expected a failure")

    assert await code_of(chat) == await code_of(responses) == "LLM_RATE_LIMIT"


class _ChatFake:
    """A Chat Completions client returning the same text as the Responses fake."""

    def __init__(self) -> None:
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))
        self.calls: list[dict[str, Any]] = []

    async def _create(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="hello"))],
            model="resp-model",
            usage=SimpleNamespace(prompt_tokens=11, completion_tokens=7, total_tokens=18),
        )


def _chat_provider_with_error(error: BaseException) -> tuple[LLMProvider, Any]:
    from app.llm import OpenAIChatCompletionsProvider

    class FailingChat:
        def __init__(self) -> None:
            self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

        async def _create(self, **kwargs: Any) -> Any:
            raise error

    return OpenAIChatCompletionsProvider(config(), client=FailingChat()), None


# --- AC-27: streaming hook ---------------------------------------------------


async def test_streaming_hook_is_declared_but_unimplemented() -> None:
    """AC-27."""
    provider, _ = provider_with()

    with pytest.raises(NotImplementedError):
        async for _ in provider.generate_stream(
            LLMRequest(messages=[{"role": "user", "content": "hi"}])
        ):
            pass


# --- AC-28: client builder hook ----------------------------------------------


def test_responses_client_builder_is_exposed() -> None:
    """AC-28."""
    assert callable(build_responses_client)
    assert callable(getattr(responses_module, "build_responses_client", None))
