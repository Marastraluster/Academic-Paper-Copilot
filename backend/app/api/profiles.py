"""Provider profile HTTP surface (docs/API_CONTRACT.md §3).

Two rules shape this module:

* **No response ever carries an API key.** The response model simply has no such
  field, so a leak would require adding one rather than forgetting to remove it.
  A request may *accept* a key; nothing ever hands one back.
* **The store comes from the lifespan.** No endpoint opens its own connection or
  builds its own store — one connection, one store, created at startup.

Errors from the store and from provider probing are translated onto the existing
error envelope with stable codes, rather than re-implementing rules the store
already enforces.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.errors import error_response
from app.llm import LLMError, test_endpoint_connection
from app.llm.errors import (
    LLMAuthenticationError,
    LLMBadRequestError,
    LLMConnectionError,
    LLMInvalidResponseError,
    LLMNotFoundError,
    LLMPermissionDeniedError,
    LLMRateLimitError,
    LLMOutputTruncatedError,
    LLMServerError,
    LLMTimeoutError,
    sanitize_message,
)
from app.security.credentials import CredentialStoreUnavailableError
from app.storage.profiles import (
    Profile,
    ProfileNameExistsError,
    ProfileNotFoundError,
    ProfileStore,
    ProfileStoreError,
    ProfileValidationError,
)

router = APIRouter(prefix="/profiles", tags=["profiles"])


# --- dependencies ------------------------------------------------------------


def get_profile_store(request: Request) -> ProfileStore:
    """The store created during lifespan startup.

    Built once, not per request. If the lifespan did not run there is no store,
    and saying so explicitly beats opening an ad-hoc connection.
    """
    store = getattr(request.app.state, "profile_store", None)
    if store is None:
        raise RuntimeError("ProfileStore is not initialized; the lifespan did not execute.")
    return store


# --- request / response models ----------------------------------------------


class ProfileCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    base_url: str
    model: str
    protocol: str = "auto"
    temperature: float | None = None
    max_output_tokens: int | None = None
    timeout_s: float = Field(default=60.0, gt=0)
    custom_headers: dict[str, str] | None = None
    api_key: str | None = None


class ProfileUpdateRequest(BaseModel):
    """Every field optional; only those supplied are applied.

    ``api_key`` has three intents, and they must stay distinguishable:

    * **absent** — leave the stored credential alone;
    * ``""`` — clear it;
    * a value — replace it.

    Explicit ``null`` is rejected rather than treated as "clear", because the
    two readings are equally plausible and guessing wrong destroys a user's key.
    """

    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    base_url: str | None = None
    model: str | None = None
    protocol: str | None = None
    temperature: float | None = None
    max_output_tokens: int | None = None
    timeout_s: float | None = Field(default=None, gt=0)
    custom_headers: dict[str, str] | None = None
    api_key: str | None = None

    @model_validator(mode="after")
    def _reject_explicit_null_api_key(self) -> ProfileUpdateRequest:
        if "api_key" in self.model_fields_set and self.api_key is None:
            raise ValueError(
                "api_key must be a string. Omit it to keep the current key, or "
                'send "" to clear it.'
            )
        return self


class ProfileResponse(BaseModel):
    """A profile as returned to a client.

    Deliberately has no key-bearing field of any kind — not the key, not the
    credential reference. What a client may know is *whether* a key is set and a
    masked rendering of it.
    """

    id: str
    name: str
    base_url: str
    model: str
    protocol: str
    temperature: float | None
    max_output_tokens: int | None
    timeout_s: float
    custom_headers: dict[str, str] | None
    has_key: bool
    api_key_masked: str
    created_at: str
    updated_at: str

    @classmethod
    def from_profile(cls, profile: Profile) -> ProfileResponse:
        return cls(
            id=profile.id,
            name=profile.name,
            base_url=profile.base_url,
            model=profile.model,
            protocol=profile.protocol,
            temperature=profile.temperature,
            max_output_tokens=profile.max_output_tokens,
            timeout_s=profile.timeout_s,
            custom_headers=profile.custom_headers,
            has_key=profile.has_key,
            api_key_masked=profile.api_key_masked,
            created_at=profile.created_at,
            updated_at=profile.updated_at,
        )


class ConnectionTestResponse(BaseModel):
    ok: bool
    protocol: str
    model: str | None
    latency_ms: float | None


# --- provider failure mapping ------------------------------------------------


def _provider_error_response(exc: LLMError) -> Any:
    """Map a probe failure onto the contract's PROVIDER_* codes.

    The endpoint reports a failure as a 5xx envelope rather than a 200 carrying
    ``ok=false``: a caller must not be able to mistake an unreachable provider for
    a working one by checking the status code alone.
    """
    mapping: list[tuple[type[LLMError], int, str, dict[str, Any]]] = [
        (LLMAuthenticationError, 502, "PROVIDER_AUTH_FAILED", {"http_status": 401}),
        (LLMPermissionDeniedError, 502, "PROVIDER_AUTH_FAILED", {"http_status": 403}),
        (LLMRateLimitError, 502, "PROVIDER_RATE_LIMITED", {"http_status": 429}),
        (LLMNotFoundError, 502, "PROVIDER_MODEL_NOT_FOUND", {"http_status": 404}),
        # Truncation is not the provider failing — the budget given to it was
        # too small. Reported as such so the fix is obvious.
        (LLMOutputTruncatedError, 502, "PROVIDER_OUTPUT_TRUNCATED", {}),
        (LLMTimeoutError, 504, "PROVIDER_TIMEOUT", {}),
        (LLMConnectionError, 502, "PROVIDER_UNREACHABLE", {}),
        (LLMServerError, 502, "PROVIDER_ERROR", {}),
        (LLMBadRequestError, 502, "PROVIDER_ERROR", {}),
        (LLMInvalidResponseError, 502, "PROVIDER_ERROR", {}),
    ]

    status, code, detail = 502, "PROVIDER_ERROR", {}
    for error_type, mapped_status, mapped_code, mapped_detail in mapping:
        if isinstance(exc, error_type):
            status, code, detail = mapped_status, mapped_code, mapped_detail
            break

    # The message is already sanitised by the LLM layer; scrub again so a future
    # path that forgets cannot leak.
    return error_response(status, code, sanitize_message(exc.message), detail)


# --- exception handlers ------------------------------------------------------


def register_profile_error_handlers(app: Any) -> None:
    """Translate store and credential failures onto the shared envelope."""

    @app.exception_handler(ProfileNotFoundError)
    async def _not_found(request: Request, exc: ProfileNotFoundError) -> Any:
        return error_response(404, "NOT_FOUND", str(exc))

    @app.exception_handler(ProfileNameExistsError)
    async def _duplicate(request: Request, exc: ProfileNameExistsError) -> Any:
        return error_response(400, "BAD_REQUEST", str(exc))

    @app.exception_handler(ProfileValidationError)
    async def _invalid(request: Request, exc: ProfileValidationError) -> Any:
        return error_response(400, "BAD_REQUEST", str(exc))

    @app.exception_handler(CredentialStoreUnavailableError)
    async def _no_store(request: Request, exc: CredentialStoreUnavailableError) -> Any:
        return error_response(503, "SERVICE_UNAVAILABLE", str(exc))

    @app.exception_handler(ProfileStoreError)
    async def _store_error(request: Request, exc: ProfileStoreError) -> Any:
        # Any remaining store failure — e.g. a dangling credential reference.
        return error_response(500, "INTERNAL_ERROR", "An internal error occurred.")


# --- routes ------------------------------------------------------------------


@router.get("", response_model=list[ProfileResponse])
async def list_profiles(request: Request) -> list[ProfileResponse]:
    store = get_profile_store(request)
    return [ProfileResponse.from_profile(p) for p in store.list_profiles()]


@router.post("", response_model=ProfileResponse, status_code=201)
async def create_profile(request: Request, payload: ProfileCreateRequest) -> ProfileResponse:
    """Create a profile. A credential-store failure aborts before any row is written."""
    store = get_profile_store(request)
    profile = store.create_profile(
        name=payload.name,
        base_url=payload.base_url,
        model=payload.model,
        protocol=payload.protocol,
        temperature=payload.temperature,
        max_output_tokens=payload.max_output_tokens,
        timeout_s=payload.timeout_s,
        custom_headers=payload.custom_headers,
        api_key=payload.api_key,
    )
    return ProfileResponse.from_profile(profile)


@router.get("/{profile_id}", response_model=ProfileResponse)
async def get_profile(request: Request, profile_id: str) -> ProfileResponse:
    store = get_profile_store(request)
    return ProfileResponse.from_profile(store.get_profile(profile_id))


@router.patch("/{profile_id}", response_model=ProfileResponse)
async def update_profile(
    request: Request, profile_id: str, payload: ProfileUpdateRequest
) -> ProfileResponse:
    store = get_profile_store(request)
    supplied = payload.model_fields_set

    fields: dict[str, Any] = {}
    for field in ("name", "base_url", "model", "protocol", "temperature",
                  "max_output_tokens", "timeout_s"):
        if field in supplied:
            fields[field] = getattr(payload, field)

    if "custom_headers" in supplied:
        # An empty mapping and an explicit null both mean "no custom headers".
        fields["custom_headers"] = payload.custom_headers or None

    # Three-way semantics: absent -> None (unchanged); "" -> clear; value -> replace.
    api_key = payload.api_key if "api_key" in supplied else None

    profile = store.update_profile(profile_id, api_key=api_key, **fields)
    return ProfileResponse.from_profile(profile)


@router.delete("/{profile_id}", status_code=204)
async def delete_profile(request: Request, profile_id: str) -> Response:
    store = get_profile_store(request)
    store.delete_profile(profile_id)
    return Response(status_code=204)


@router.post("/{profile_id}/test", response_model=ConnectionTestResponse)
async def test_profile(request: Request, profile_id: str) -> Any:
    """Probe the configured endpoint and report what was found.

    Existence is checked first, so a bad id costs nothing: no credential lookup,
    no client construction, no network attempt.
    """
    store = get_profile_store(request)
    profile = store.get_profile(profile_id)

    config = store.to_provider_config(profile_id)

    try:
        protocol, report = await test_endpoint_connection(
            config, profile.protocol, force_probe=True
        )
    except LLMError as exc:
        return _provider_error_response(exc)

    return ConnectionTestResponse(
        ok=report.ok,
        protocol=protocol,
        model=report.model,
        latency_ms=report.latency_ms,
    )


@router.post("/{profile_id}/detect-protocol")
async def detect_protocol(request: Request, profile_id: str) -> Any:
    """Resolve and report the concrete protocol for a profile.

    Existence is checked first, so an unknown id costs no credential lookup and
    no network attempt.
    """
    store = get_profile_store(request)
    profile = store.get_profile(profile_id)

    config = store.to_provider_config(profile_id)

    try:
        protocol, _report = await test_endpoint_connection(
            config, profile.protocol, force_probe=True
        )
    except LLMError as exc:
        return _provider_error_response(exc)

    return {"protocol": protocol}
