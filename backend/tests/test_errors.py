"""AC-19 … AC-23 — every error leaves through one envelope, and 500s leak nothing."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi import FastAPI, Query
from fastapi.testclient import TestClient

# A value that must never reach a client, used to prove the 500 path is clean.
LEAKED_SECRET = "sk-live-DEADBEEF1234567890"


@pytest.fixture
def error_client(app: FastAPI) -> Iterator[TestClient]:
    """Client with routes that deliberately fail, mounted for these tests only."""

    @app.get("/api/_test/boom")
    async def boom() -> dict[str, str]:
        raise RuntimeError(f"internal detail with {LEAKED_SECRET} and C:\\secret\\path.py")

    @app.get("/api/_test/validated")
    async def validated(limit: int = Query(ge=1)) -> dict[str, int]:
        return {"limit": limit}

    # raise_server_exceptions=False so we assert on the real HTTP response
    # rather than letting the test client re-raise.
    with TestClient(app, raise_server_exceptions=False) as test_client:
        yield test_client


def assert_envelope(payload: dict) -> dict:
    """Assert the envelope shape from docs/API_CONTRACT.md §0 and return it."""
    assert set(payload) == {"error"}, f"unexpected top-level keys: {set(payload)}"
    error = payload["error"]
    assert set(error) == {"code", "message", "detail"}
    assert isinstance(error["code"], str) and error["code"]
    assert isinstance(error["message"], str) and error["message"]
    assert "detail" in error
    return error


def test_404_uses_envelope(error_client: TestClient) -> None:
    """AC-20."""
    response = error_client.get("/api/unknown")

    assert response.status_code == 404
    error = assert_envelope(response.json())
    assert error["code"] == "NOT_FOUND"


def test_404_does_not_use_fastapi_default_shape(error_client: TestClient) -> None:
    """The default `{"detail": "Not Found"}` must be gone (AC-19)."""
    body = error_client.get("/api/unknown").json()
    assert body != {"detail": "Not Found"}
    assert "detail" not in body


def test_405_uses_envelope(error_client: TestClient) -> None:
    """AC-21."""
    response = error_client.post("/api/health")

    assert response.status_code == 405
    error = assert_envelope(response.json())
    assert error["code"] == "METHOD_NOT_ALLOWED"


def test_422_uses_envelope_with_structured_detail(error_client: TestClient) -> None:
    """AC-22."""
    response = error_client.get("/api/_test/validated", params={"limit": 0})

    assert response.status_code == 422
    error = assert_envelope(response.json())
    assert error["code"] == "VALIDATION_ERROR"
    assert isinstance(error["detail"], dict)
    assert error["detail"].get("errors"), "validation detail should list the failures"


def test_unhandled_exception_returns_500_envelope(error_client: TestClient) -> None:
    """AC-23."""
    response = error_client.get("/api/_test/boom")

    assert response.status_code == 500
    error = assert_envelope(response.json())
    assert error["code"] == "INTERNAL_ERROR"
    assert error["message"] == "An internal error occurred."
    assert error["detail"] == {}


def test_500_response_leaks_no_internals(error_client: TestClient) -> None:
    """AC-23 — no secret, path, or traceback in body or headers."""
    response = error_client.get("/api/_test/boom")
    haystack = response.text + "\n" + "\n".join(f"{k}: {v}" for k, v in response.headers.items())

    assert LEAKED_SECRET not in haystack
    assert "Traceback" not in haystack
    assert "RuntimeError" not in haystack
    assert "secret\\path.py" not in haystack
    assert "site-packages" not in haystack


def test_error_responses_still_carry_request_id(error_client: TestClient) -> None:
    """AC-15 — including the 500 path, which bypasses the request middleware."""
    for path in ("/api/unknown", "/api/_test/boom"):
        response = error_client.get(path, headers={"X-Request-ID": "err-trace-7"})
        assert response.headers.get("X-Request-ID") == "err-trace-7", f"{path} lost the id"
