"""Shared test fixtures.

Three guarantees these fixtures exist to enforce:

* **AC-26 / FC-05** — no test touches the developer's real database. Every test
  gets a ``Settings`` pointing into ``tmp_path``, and the app is constructed with
  that object, so the lifespan bootstraps a throwaway file.
* **AC-38.13** — the suite runs completely offline. An autouse socket guard fails
  loudly if any code under test tries to reach the network.
* **DS-BE-005 AC-22 / FC-10** — no test touches the developer's real OS
  credential store. An autouse fake keyring is installed for every test.
"""

from __future__ import annotations

import socket
from collections.abc import Iterator
from pathlib import Path

import keyring
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from keyring.backend import KeyringBackend
from keyring.errors import PasswordDeleteError

from app.config import Settings
from app.main import create_app

ALLOWED_HOSTS = {"127.0.0.1", "::1", "localhost", ""}


class FakeKeyring(KeyringBackend):
    """In-memory credential store.

    Never touches Windows Credential Manager. Tests that write an API key would
    otherwise leave real entries in the developer's OS keyring — and worse,
    read whatever real secrets happen to be there.
    """

    priority = 1  # positive, so availability checks treat it as usable

    def __init__(self) -> None:
        super().__init__()
        self._store: dict[tuple[str, str], str] = {}

    def set_password(self, service: str, username: str, password: str) -> None:
        self._store[(service, username)] = password

    def get_password(self, service: str, username: str) -> str | None:
        return self._store.get((service, username))

    def delete_password(self, service: str, username: str) -> None:
        if (service, username) not in self._store:
            raise PasswordDeleteError("no such password")
        del self._store[(service, username)]

    def clear(self) -> None:
        self._store.clear()


@pytest.fixture(autouse=True)
def fake_credential_store(monkeypatch: pytest.MonkeyPatch) -> Iterator[FakeKeyring]:
    """Install an in-memory credential store for every test (DS-BE-005 AC-22).

    Autouse and global on purpose: opting in per test would mean a single
    forgotten decorator silently writes a real secret to the developer's machine.
    """
    fake = FakeKeyring()
    monkeypatch.setattr(keyring, "get_keyring", lambda: fake)
    monkeypatch.setattr(keyring, "set_password", fake.set_password)
    monkeypatch.setattr(keyring, "get_password", fake.get_password)
    monkeypatch.setattr(keyring, "delete_password", fake.delete_password)
    yield fake


@pytest.fixture(autouse=True)
def block_external_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fail any test that opens a non-loopback socket (AC-12, AC-38.13)."""
    real_connect = socket.socket.connect

    def guarded_connect(self: socket.socket, address):  # type: ignore[no-untyped-def]
        host = address[0] if isinstance(address, tuple) else str(address)
        if host not in ALLOWED_HOSTS:
            raise AssertionError(
                f"Test attempted an external network connection to {address!r}. "
                "The test suite must run entirely offline."
            )
        return real_connect(self, address)

    monkeypatch.setattr(socket.socket, "connect", guarded_connect)


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    """Settings isolated to a temporary database (AC-26)."""
    # Every value is passed explicitly so a stray .env or ambient environment
    # variable cannot make the suite behave differently on another machine.
    return Settings(
        host="127.0.0.1",
        port=8000,
        database_path=tmp_path / "test-db.sqlite3",
        log_level="INFO",
        cors_origins="http://localhost:5173",
        debug=True,
    )


@pytest.fixture
def app(settings: Settings) -> FastAPI:
    return create_app(settings)


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    """Client with the lifespan running, so startup really executes."""
    with TestClient(app) as test_client:
        yield test_client
