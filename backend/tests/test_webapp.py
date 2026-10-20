"""Desktop mode — the backend serves the built frontend (``app/webapp.py``).

These tests fix the four properties the desktop shell depends on, and one that
protects the web deployment from the desktop change:

1. the shell is served at ``/`` with ``no-store``, so an update is picked up;
2. hashed assets are served from ``/assets``;
3. ``/api`` still belongs to the API — an unknown path is a 404, never the shell
   (a fetch that receives HTML fails as a parse error, which is a worse bug);
4. a path cannot leave the asset directory;
5. without ``frontend_dir`` nothing is mounted, so ``/`` stays a 404 in web mode
   and the Vite dev server remains the only thing serving the shell.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app

INDEX_HTML = b"<!doctype html><html><body><div id=\"root\"></div></body></html>"


@pytest.fixture
def frontend_dir(tmp_path: Path) -> Path:
    directory = tmp_path / "web"
    (directory / "assets").mkdir(parents=True)
    (directory / "index.html").write_bytes(INDEX_HTML)
    (directory / "favicon.svg").write_text("<svg/>", encoding="utf-8")
    (directory / "assets" / "app-abc123.js").write_text("console.log('hi')", encoding="utf-8")
    return directory


def _app(tmp_path: Path, frontend_dir: Path | None) -> FastAPI:
    return create_app(
        Settings(
            host="127.0.0.1",
            port=8000,
            database_path=tmp_path / "desktop-db.sqlite3",
            documents_dir=tmp_path / "documents",
            log_level="INFO",
            cors_origins="http://localhost:5173",
            debug=False,
            frontend_dir=frontend_dir,
        )
    )


def test_root_serves_the_shell_uncached(tmp_path: Path, frontend_dir: Path) -> None:
    with TestClient(_app(tmp_path, frontend_dir)) as client:
        response = client.get("/")

    assert response.status_code == 200
    assert response.content == INDEX_HTML
    assert "no-store" in response.headers["cache-control"]


def test_hashed_assets_are_served(tmp_path: Path, frontend_dir: Path) -> None:
    with TestClient(_app(tmp_path, frontend_dir)) as client:
        response = client.get("/assets/app-abc123.js")

    assert response.status_code == 200
    assert response.text == "console.log('hi')"


def test_unknown_api_path_is_a_404_not_the_shell(tmp_path: Path, frontend_dir: Path) -> None:
    with TestClient(_app(tmp_path, frontend_dir)) as client:
        response = client.get("/api/does-not-exist")

    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/json")


def test_api_routes_still_answer_in_desktop_mode(tmp_path: Path, frontend_dir: Path) -> None:
    with TestClient(_app(tmp_path, frontend_dir)) as client:
        response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_a_path_cannot_escape_the_asset_directory(tmp_path: Path, frontend_dir: Path) -> None:
    secret = tmp_path / "secret.txt"
    secret.write_text("do not serve me", encoding="utf-8")

    with TestClient(_app(tmp_path, frontend_dir)) as client:
        response = client.get("/../secret.txt")

    assert b"do not serve me" not in response.content


def test_web_mode_mounts_nothing(tmp_path: Path) -> None:
    """No ``frontend_dir``: the backend keeps its pre-desktop behaviour."""
    with TestClient(_app(tmp_path, None)) as client:
        assert client.get("/").status_code == 404


def test_desktop_shutdown_requires_the_launch_token(
    tmp_path: Path, frontend_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("APC_SHUTDOWN_TOKEN", "launch-token")
    app = _app(tmp_path, frontend_dir)
    stops: list[bool] = []
    app.state.request_shutdown = lambda: stops.append(True)

    with TestClient(app) as client:
        assert client.post("/api/desktop/shutdown").status_code == 404
        assert client.post(
            "/api/desktop/shutdown", headers={"X-Desktop-Token": "wrong"}
        ).status_code == 404
        assert stops == []

        accepted = client.post(
            "/api/desktop/shutdown", headers={"X-Desktop-Token": "launch-token"}
        )

    assert accepted.status_code == 200
    assert accepted.json() == {"status": "stopping"}
    assert stops == [True]


def test_no_shutdown_route_without_a_token(
    tmp_path: Path, frontend_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A web-mode process must not expose a remote stop, even behind a token."""
    monkeypatch.delenv("APC_SHUTDOWN_TOKEN", raising=False)
    app = _app(tmp_path, frontend_dir)
    stops: list[bool] = []
    app.state.request_shutdown = lambda: stops.append(True)

    with TestClient(app) as client:
        response = client.post("/api/desktop/shutdown")

    # 405 rather than 404: the route is not registered, and the only thing that
    # matches the path is the GET-only shell fallback. Either way the request
    # stops nothing — which is the property that matters.
    assert response.status_code == 405
    assert stops == []
