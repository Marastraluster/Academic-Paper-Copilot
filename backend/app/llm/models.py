"""Protocol-neutral request, result, and configuration models.

Nothing here mentions Chat Completions, Responses, HTTP, or the OpenAI SDK. That
is the point: the translation engine, the context engine, and Paper QA all speak
these types, so swapping protocol later (DS-BE-003) does not touch them.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator

#: Role values shared by every OpenAI-compatible protocol. Typed as a union with
#: ``str`` so a provider introducing another role is not rejected outright.
Role = Literal["system", "user", "assistant"] | str


class ChatMessage(BaseModel):
    """One protocol-neutral message."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    role: Role
    content: str


class LLMRequest(BaseModel):
    """A single generation request.

    Deliberately small. ``stop``, response formats and metadata are not needed by
    any current caller and would be guesses; they can be added when a caller needs
    them.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    messages: list[ChatMessage] = Field(min_length=1)
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    max_output_tokens: int | None = Field(default=None, gt=0)
    #: Per-request timeout override; falls back to the provider's configured value.
    timeout_s: float | None = Field(default=None, gt=0)

    @field_validator("messages", mode="before")
    @classmethod
    def _coerce_plain_dicts(cls, value: object) -> object:
        """Accept ``[{"role": ..., "content": ...}]`` as well as model instances.

        Callers writing a prompt inline should not have to import a model class.
        """
        if isinstance(value, list):
            return [
                ChatMessage.model_validate(item) if isinstance(item, dict) else item
                for item in value
            ]
        return value


@dataclass(frozen=True)
class LLMUsage:
    """Normalised token accounting. Field names follow the Chat Completions
    convention because it is the one every compatible provider implements."""

    prompt_tokens: int
    completion_tokens: int
    total_tokens: int


@dataclass(frozen=True)
class LLMResult:
    """What callers receive. No SDK object ever reaches them."""

    text: str
    model: str | None
    protocol: str
    usage: LLMUsage | None = None


@dataclass(frozen=True)
class ConnectionReport:
    """Outcome of a connection probe."""

    ok: bool
    latency_ms: float | None = None
    message: str = "Connection successful"
    model: str | None = None


class ProviderConfig(BaseModel):
    """Everything needed to reach one OpenAI-compatible endpoint.

    Constructed at runtime; this task deliberately does not persist it.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    base_url: str = Field(min_length=1)
    #: SecretStr so that repr, str, and model_dump cannot reveal it.
    #: An empty value is permitted so genuinely keyless local servers can be
    #: configured (see the provider for how the client is built in that case).
    api_key: SecretStr = SecretStr("")
    model: str = Field(min_length=1)
    timeout_s: float = Field(default=60.0, gt=0)
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    max_output_tokens: int | None = Field(default=None, gt=0)
    custom_headers: dict[str, str] | None = None

    @field_validator("base_url", "model")
    @classmethod
    def _reject_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        # The value is returned UNCHANGED. No trimming, no trailing-slash
        # handling, no /v1 appending — the user's endpoint is theirs.
        return value
