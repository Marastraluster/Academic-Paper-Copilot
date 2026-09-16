"""AC-04 — health endpoint contract."""

from __future__ import annotations

import re

import pytest
from fastapi.testclient import TestClient

SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+.*$")


def test_health_returns_200_with_expected_body(client: TestClient) -> None:
    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")

    body = response.json()
    assert body["status"] == "ok"
    assert SEMVER_RE.match(body["version"]), f"version {body['version']!r} is not semver"


def test_health_body_has_exactly_the_contract_keys(client: TestClient) -> None:
    """The response must not grow extra keys that clients might start to rely on."""
    body = client.get("/api/health").json()
    assert set(body) == {"status", "version"}


@pytest.mark.parametrize("attempt", range(3))
def test_health_is_stable_across_repeated_calls(client: TestClient, attempt: int) -> None:
    assert client.get("/api/health").json()["status"] == "ok"


def test_interactive_docs_follow_the_debug_flag(tmp_path) -> None:
    """AC-37 — docs are a development convenience, off by default."""
    from app.config import Settings
    from app.main import create_app

    def build(debug: bool):
        return create_app(
            Settings(
                host="127.0.0.1",
                port=8000,
                database_path=tmp_path / f"db-{debug}.sqlite3",
                log_level="INFO",
                cors_origins="http://localhost:5173",
                debug=debug,
            )
        )

    with TestClient(build(debug=True)) as dev_client:
        assert dev_client.get("/docs").status_code == 200

    with TestClient(build(debug=False)) as prod_client:
        assert prod_client.get("/docs").status_code == 404
