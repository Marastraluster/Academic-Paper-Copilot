"""DS-BE-006 — provider profile HTTP API.

Runs offline against the in-memory credential store and a temporary database.
The provider probe is substituted; no test reaches an LLM.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from fastapi.testclient import TestClient
from keyring.backends import fail as fail_backend

from app.llm import (
    LLMAuthenticationError,
    LLMConnectionError,
    LLMNotFoundError,
    LLMRateLimitError,
    LLMServerError,
    LLMTimeoutError,
)
from app.llm.models import ConnectionReport
from app.security.credentials import KEYRING_SERVICE_NAME

SECRET = "sk-live-api-SECRET-abcdef123456"

BASE_PAYLOAD: dict[str, Any] = {
    "name": "OpenAI",
    "base_url": "https://api.openai.com/v1",
    "model": "gpt-x",
}


def create(client: TestClient, **overrides: Any) -> dict[str, Any]:
    payload = {**BASE_PAYLOAD, **overrides}
    response = client.post("/api/profiles", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def assert_envelope(payload: dict) -> dict:
    assert set(payload) == {"error"}
    error = payload["error"]
    assert {"code", "message", "detail"} <= set(error)
    return error


def assert_no_secret(payload: Any, secret: str = SECRET) -> None:
    """No response may carry the plaintext key, wherever it hides."""
    assert secret not in json.dumps(payload, default=str)


# --- AC-02 / AC-03 / AC-04: CRUD basics --------------------------------------


def test_create_returns_201_and_the_documented_shape(client: TestClient) -> None:
    """AC-02."""
    body = create(client, api_key=SECRET)

    assert set(body) == {
        "id", "name", "base_url", "model", "protocol", "temperature",
        "max_output_tokens", "timeout_s", "custom_headers", "has_key",
        "api_key_masked", "created_at", "updated_at",
    }
    assert body["has_key"] is True
    assert body["api_key_masked"] == "sk-••••••••3456"
    assert_no_secret(body)


def test_create_without_a_key_is_keyless(client: TestClient) -> None:
    """AC-02 / AC-20 — a local server with no key is legitimate."""
    body = create(client, name="Local", base_url="http://127.0.0.1:11434/v1", model="llama3")

    assert body["has_key"] is False
    assert body["api_key_masked"] == ""


def test_list_returns_every_profile_sorted(client: TestClient) -> None:
    """AC-03 — ordered case-insensitively by name."""
    create(client, name="zeta")
    create(client, name="Alpha")
    create(client, name="beta")

    body = client.get("/api/profiles").json()

    assert [p["name"] for p in body] == ["Alpha", "beta", "zeta"]


def test_list_is_empty_when_there_are_no_profiles(client: TestClient) -> None:
    """AC-03."""
    response = client.get("/api/profiles")

    assert response.status_code == 200
    assert response.json() == []


def test_get_single_profile(client: TestClient) -> None:
    """AC-04."""
    created = create(client, api_key=SECRET)

    body = client.get(f"/api/profiles/{created['id']}").json()

    assert body["id"] == created["id"]
    assert body["name"] == "OpenAI"
    assert_no_secret(body)


def test_get_unknown_profile_is_404(client: TestClient) -> None:
    """AC-04."""
    response = client.get("/api/profiles/prof_nope")

    assert response.status_code == 404
    assert assert_envelope(response.json())["code"] == "NOT_FOUND"


# --- AC-09 / AC-10: secret containment ---------------------------------------


def test_no_response_body_ever_contains_the_key(client: TestClient) -> None:
    """AC-09 / AC-10 — every endpoint, checked as a whole."""
    created = create(client, api_key=SECRET)
    pid = created["id"]

    responses = [
        client.get("/api/profiles"),
        client.get(f"/api/profiles/{pid}"),
        client.patch(f"/api/profiles/{pid}", json={"model": "gpt-y"}),
        client.get("/api/profiles/prof_missing"),
        client.patch(f"/api/profiles/{pid}", json={"api_key": "sk-live-ROTATED-zzz999"}),
    ]
    for response in responses:
        assert_no_secret(response.json())
        assert "sk-live-ROTATED-zzz999" not in json.dumps(response.json())
        assert SECRET not in json.dumps(response.json())

    # And headers carry nothing either.
    for response in responses:
        assert SECRET not in json.dumps(dict(response.headers))


def test_openapi_schema_exposes_no_api_key_field(client: TestClient) -> None:
    """AC-10 — a leaking response model would be visible in the schema."""
    schema = client.get("/openapi.json").json()

    profile_response = schema["components"]["schemas"]["ProfileResponse"]
    assert "api_key" not in profile_response["properties"]
    assert "credential_ref" not in profile_response["properties"]


def test_key_never_reaches_the_log_stream(client: TestClient) -> None:
    """AC-10 — including the request body, which contains the key."""
    import logging

    records: list[str] = []

    class Collect(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            records.append(record.getMessage())

    handler = Collect()
    root = logging.getLogger()
    root.addHandler(handler)
    try:
        create(client, api_key=SECRET)
    finally:
        root.removeHandler(handler)

    assert not any(SECRET in message for message in records)


# --- AC-05 / AC-12 / AC-17: PATCH semantics ----------------------------------


def test_patch_without_a_key_leaves_the_credential_alone(
    client: TestClient, fake_credential_store, settings
) -> None:
    """AC-05 (omitted) — an unrelated edit must not destroy the key."""
    created = create(client, api_key=SECRET)
    stored = fake_credential_store.get_password(
        KEYRING_SERVICE_NAME, _ref(settings, created["id"])
    )

    body = client.patch(f"/api/profiles/{created['id']}", json={"model": "gpt-y"}).json()

    assert body["model"] == "gpt-y"
    assert body["has_key"] is True
    assert (
        fake_credential_store.get_password(KEYRING_SERVICE_NAME, _ref(settings, created["id"]))
        == stored
    )


def test_patch_with_empty_string_clears_the_credential(
    client: TestClient, fake_credential_store, settings
) -> None:
    """AC-05 (empty)."""
    created = create(client, api_key=SECRET)
    ref = _ref(settings, created["id"])

    body = client.patch(f"/api/profiles/{created['id']}", json={"api_key": ""}).json()

    assert body["has_key"] is False
    assert body["api_key_masked"] == ""
    assert fake_credential_store.get_password(KEYRING_SERVICE_NAME, ref) is None


def test_patch_with_a_value_rotates_the_key(
    client: TestClient, fake_credential_store, settings
) -> None:
    """AC-05 (value)."""
    created = create(client, api_key=SECRET)

    body = client.patch(
        f"/api/profiles/{created['id']}", json={"api_key": "sk-live-NEWKEY-778899"}
    ).json()

    assert body["has_key"] is True
    assert body["api_key_masked"] == "sk-••••••••8899"
    assert (
        fake_credential_store.get_password(KEYRING_SERVICE_NAME, _ref(settings, created["id"]))
        == "sk-live-NEWKEY-778899"
    )


def test_patch_with_explicit_null_is_rejected(client: TestClient) -> None:
    """AC-17 — null is ambiguous; guessing wrong destroys a key."""
    created = create(client, api_key=SECRET)

    response = client.patch(f"/api/profiles/{created['id']}", json={"api_key": None})

    assert response.status_code == 422
    assert assert_envelope(response.json())["code"] == "VALIDATION_ERROR"


def test_patch_unknown_profile_is_404(client: TestClient) -> None:
    """AC-05."""
    response = client.patch("/api/profiles/prof_nope", json={"model": "m"})

    assert response.status_code == 404


def test_patch_nullable_metadata_may_be_cleared(client: TestClient) -> None:
    """AC-17 — null is allowed for genuinely nullable fields."""
    created = create(client, api_key=SECRET, temperature=0.5, max_output_tokens=100)

    body = client.patch(
        f"/api/profiles/{created['id']}", json={"temperature": None, "max_output_tokens": None}
    ).json()

    assert body["temperature"] is None
    assert body["max_output_tokens"] is None


# --- AC-18: custom headers ---------------------------------------------------


def test_custom_headers_round_trip_over_http(client: TestClient) -> None:
    """AC-18."""
    headers = {"X-Org": "Acme", "HTTP-Referer": "https://test.com"}

    created = create(client, custom_headers=headers)

    assert created["custom_headers"] == headers
    assert client.get(f"/api/profiles/{created['id']}").json()["custom_headers"] == headers


def test_empty_custom_headers_clear_to_none(client: TestClient) -> None:
    """AC-18."""
    created = create(client, custom_headers={"X-A": "1"})

    body = client.patch(f"/api/profiles/{created['id']}", json={"custom_headers": {}}).json()

    assert body["custom_headers"] is None


# --- AC-11 / AC-12: rejection paths ------------------------------------------


def test_duplicate_name_is_400(client: TestClient) -> None:
    """AC-11."""
    create(client, name="Duplicate")

    response = client.post("/api/profiles", json={**BASE_PAYLOAD, "name": "duplicate"})

    assert response.status_code == 400
    assert assert_envelope(response.json())["code"] == "BAD_REQUEST"


def test_renaming_onto_an_existing_name_is_400(client: TestClient) -> None:
    """AC-11."""
    create(client, name="First")
    second = create(client, name="Second")

    response = client.patch(f"/api/profiles/{second['id']}", json={"name": "First"})

    assert response.status_code == 400


@pytest.mark.parametrize(
    ("label", "payload"),
    [
        ("blank name", {**BASE_PAYLOAD, "name": "   "}),
        ("invalid protocol", {**BASE_PAYLOAD, "protocol": "grpc"}),
        ("unknown field", {**BASE_PAYLOAD, "colour": "blue"}),
        ("negative timeout", {**BASE_PAYLOAD, "timeout_s": -1}),
        ("missing name", {"base_url": "http://x/v1", "model": "m"}),
        ("missing base_url", {"name": "n", "model": "m"}),
    ],
)
def test_invalid_payloads_use_the_validation_envelope(
    client: TestClient, label: str, payload: dict[str, Any]
) -> None:
    """AC-12 — never a raw pydantic traceback or FastAPI's default shape."""
    response = client.post("/api/profiles", json=payload)

    assert response.status_code in (400, 422), f"{label}: {response.status_code}"
    error = assert_envelope(response.json())
    assert error["code"] in ("VALIDATION_ERROR", "BAD_REQUEST")
    assert "detail" in error and error["message"]


# --- AC-06: delete -----------------------------------------------------------


def test_delete_removes_profile_and_credential(
    client: TestClient, fake_credential_store, settings
) -> None:
    """AC-06."""
    created = create(client, api_key=SECRET)
    ref = _ref(settings, created["id"])

    response = client.delete(f"/api/profiles/{created['id']}")

    assert response.status_code == 204
    assert client.get(f"/api/profiles/{created['id']}").status_code == 404
    assert fake_credential_store.get_password(KEYRING_SERVICE_NAME, ref) is None


def test_delete_unknown_profile_is_404(client: TestClient) -> None:
    """AC-06."""
    assert client.delete("/api/profiles/prof_nope").status_code == 404


# --- AC-13: unavailable credential store -------------------------------------


def test_create_without_a_credential_store_is_503_and_writes_nothing(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """AC-13 / Q5 — atomic: no half-created profile."""
    import keyring

    monkeypatch.setattr(keyring, "get_keyring", lambda: fail_backend.Keyring())

    response = client.post("/api/profiles", json={**BASE_PAYLOAD, "api_key": SECRET})

    assert response.status_code == 503
    error = assert_envelope(response.json())
    assert error["code"] == "SERVICE_UNAVAILABLE"
    assert_no_secret(response.json())
    # Nothing was written.
    assert client.get("/api/profiles").json() == []


def test_create_without_a_store_still_allows_keyless_profiles(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A keyless profile needs no credential store, so it must still work."""
    import keyring

    monkeypatch.setattr(keyring, "get_keyring", lambda: fail_backend.Keyring())

    response = client.post("/api/profiles", json={**BASE_PAYLOAD, "name": "Keyless"})

    assert response.status_code == 201
    assert response.json()["has_key"] is False


# --- AC-07 / AC-08 / AC-19: connection test ----------------------------------


@pytest.fixture
def probe(monkeypatch: pytest.MonkeyPatch):
    """Substitute the provider probe."""
    calls: list[Any] = []

    async def _probe(config, protocol, *, force_probe=False):
        calls.append((config, protocol, force_probe))
        outcome = probe.outcome
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    probe.outcome = ("responses", ConnectionReport(ok=True, latency_ms=12.5, model="probe-model"))
    probe.calls = calls
    monkeypatch.setattr("app.api.profiles.test_endpoint_connection", _probe)
    return probe


def test_connection_test_reports_protocol_model_and_latency(client: TestClient, probe) -> None:
    """AC-07."""
    created = create(client, api_key=SECRET)

    response = client.post(f"/api/profiles/{created['id']}/test")

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "protocol": "responses",
        "model": "probe-model",
        "latency_ms": 12.5,
    }
    assert_no_secret(response.json())


def test_connection_test_forces_a_fresh_probe(client: TestClient, probe) -> None:
    """A settings button must not report a cached verdict."""
    created = create(client, api_key=SECRET)

    client.post(f"/api/profiles/{created['id']}/test")

    assert probe.calls and probe.calls[0][2] is True


def test_connection_test_unknown_profile_is_404_without_probing(
    client: TestClient, probe
) -> None:
    """AC-19 — a bad id costs no credential lookup and no network attempt."""
    response = client.post("/api/profiles/prof_nope/test")

    assert response.status_code == 404
    assert probe.calls == [], "the provider must not be probed for an unknown profile"


@pytest.mark.parametrize(
    ("failure", "status", "code"),
    [
        (LLMConnectionError("refused"), 502, "PROVIDER_UNREACHABLE"),
        (LLMAuthenticationError("bad key"), 502, "PROVIDER_AUTH_FAILED"),
        (LLMRateLimitError("slow down"), 502, "PROVIDER_RATE_LIMITED"),
        (LLMNotFoundError("no model"), 502, "PROVIDER_MODEL_NOT_FOUND"),
        (LLMTimeoutError("too slow"), 504, "PROVIDER_TIMEOUT"),
        (LLMServerError("upstream broke"), 502, "PROVIDER_ERROR"),
    ],
)
def test_connection_failures_use_provider_codes_not_200(
    client: TestClient, probe, failure, status, code
) -> None:
    """AC-08 — a failure must not look like success to a status-code check."""
    created = create(client, api_key=SECRET)
    probe.outcome = failure

    response = client.post(f"/api/profiles/{created['id']}/test")

    assert response.status_code == status
    assert assert_envelope(response.json())["code"] == code
    assert_no_secret(response.json())


def test_connection_failure_does_not_leak_the_key(client: TestClient, probe) -> None:
    """AC-08 / AC-09."""
    created = create(client, api_key=SECRET)
    probe.outcome = LLMAuthenticationError(f"rejected Bearer {SECRET}")

    response = client.post(f"/api/profiles/{created['id']}/test")

    assert SECRET not in json.dumps(response.json())


def test_connection_failure_detail_carries_the_upstream_status(client: TestClient, probe) -> None:
    """AC-08 — the documented `detail.http_status`."""
    created = create(client, api_key=SECRET)
    probe.outcome = LLMAuthenticationError("bad key")

    detail = client.post(f"/api/profiles/{created['id']}/test").json()["error"]["detail"]

    assert detail == {"http_status": 401}


# --- AC-01: store provisioning ------------------------------------------------


def test_store_comes_from_the_lifespan(app, settings) -> None:
    """AC-01 — one store, created at startup, shared by every request."""
    from fastapi.testclient import TestClient

    with TestClient(app) as client:
        store = client.app.state.profile_store
        assert store is not None
        client.post("/api/profiles", json=BASE_PAYLOAD)
        assert client.app.state.profile_store is store, "the store was replaced per request"


def test_missing_lifespan_yields_a_500_envelope(app) -> None:
    """AC-01 — no ad-hoc store is created when startup did not run."""
    from fastapi.testclient import TestClient

    # NOT a context manager: the lifespan never runs, so no store exists.
    # raise_server_exceptions=False so the RuntimeError becomes a response.
    client = TestClient(app, raise_server_exceptions=False)
    response = client.get("/api/profiles")

    assert response.status_code == 500
    assert assert_envelope(response.json())["code"] == "INTERNAL_ERROR"


# --- AC-15 / AC-21: extras ----------------------------------------------------


def test_detect_protocol_endpoint(client: TestClient, probe) -> None:
    """AC-15 (P1)."""
    created = create(client, api_key=SECRET, protocol="auto")

    response = client.post(f"/api/profiles/{created['id']}/detect-protocol")

    assert response.status_code == 200
    assert response.json() == {"protocol": "responses"}


def test_detect_protocol_unknown_profile_is_404(client: TestClient, probe) -> None:
    """AC-15."""
    assert client.post("/api/profiles/prof_nope/detect-protocol").status_code == 404


def test_request_id_is_echoed_on_profile_endpoints(client: TestClient) -> None:
    """AC-21 (P2) — including on error responses."""
    ok = client.get("/api/profiles", headers={"X-Request-ID": "prof-trace-1"})
    missing = client.get("/api/profiles/prof_nope", headers={"X-Request-ID": "prof-trace-2"})

    assert ok.headers["X-Request-ID"] == "prof-trace-1"
    assert missing.status_code == 404
    assert missing.headers["X-Request-ID"] == "prof-trace-2"


def test_base_url_is_stored_verbatim(client: TestClient) -> None:
    """AC-16 (P1) — no /v1 appended, no trailing slash stripped."""
    for url in ("https://example.com", "https://api.deepseek.com/v1", "http://localhost:8000/"):
        body = create(client, name=f"P-{len(url)}-{url[-3:]}", base_url=url)
        assert body["base_url"] == url


def _ref(settings, profile_id: str) -> str | None:
    """Read the credential reference from the database, never via HTTP.

    Opens its own connection rather than going through ``app.state.profile_store``:
    SQLite connections are thread-affine, and the store's connection belongs to
    the lifespan's thread — the same constraint DS-BE-001 pinned with a test. A
    read-only connection here keeps the assertion honest without fighting it.
    """
    import sqlite3

    connection = sqlite3.connect(str(settings.database_path))
    try:
        row = connection.execute(
            "SELECT credential_ref FROM profiles WHERE id = ?", (profile_id,)
        ).fetchone()
        return row[0] if row else None
    finally:
        connection.close()
