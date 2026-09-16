"""AC-03, AC-07, AC-09, AC-16, AC-28, AC-31 — settings and their safety rails."""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from app.config import APP_NAME, LOOPBACK_HOSTS, Settings, default_data_dir


# --- Safe defaults (AC-03, AC-09) -------------------------------------------


def test_defaults_bind_to_loopback_only() -> None:
    """AC-03 — the default must never be 0.0.0.0 or ::."""
    settings = Settings(_env_file=None)

    assert settings.host == "127.0.0.1"
    assert settings.host in LOOPBACK_HOSTS
    assert settings.port == 8000
    assert settings.log_level == "INFO"


def test_default_database_path_is_per_user() -> None:
    """AC-07."""
    settings = Settings(_env_file=None)

    assert settings.database_path.name.endswith(".sqlite3")
    assert APP_NAME in str(settings.database_path)
    assert settings.database_path == default_data_dir() / "db.sqlite3"


# --- Non-loopback is refused outright (AC-28) -------------------------------


@pytest.mark.parametrize("host", ["0.0.0.0", "::", "192.168.1.10", "example.com", "10.0.0.1"])
def test_non_loopback_hosts_are_rejected(host: str) -> None:
    """AC-28 — refuse at configuration time, not merely by convention."""
    with pytest.raises(ValidationError) as excinfo:
        Settings(host=host, _env_file=None)

    assert "loopback" in str(excinfo.value).lower()


@pytest.mark.parametrize("host", ["127.0.0.1", "::1", "localhost"])
def test_loopback_hosts_are_accepted(host: str) -> None:
    assert Settings(host=host, _env_file=None).host == host


def test_host_from_environment_is_validated_too(monkeypatch: pytest.MonkeyPatch) -> None:
    """The guard must apply to the real env-var path, not just explicit kwargs."""
    monkeypatch.setenv("HOST", "0.0.0.0")

    with pytest.raises(ValidationError):
        Settings()


# --- Fail fast on malformed values (AC-16) ----------------------------------


def test_invalid_port_is_rejected() -> None:
    with pytest.raises(ValidationError):
        Settings(port="not-a-number", _env_file=None)


@pytest.mark.parametrize("port", [0, -1, 70000])
def test_out_of_range_port_is_rejected(port: int) -> None:
    with pytest.raises(ValidationError):
        Settings(port=port, _env_file=None)


def test_invalid_log_level_is_rejected() -> None:
    with pytest.raises(ValidationError):
        Settings(log_level="CHATTY", _env_file=None)


def test_malformed_env_var_fails_at_startup(monkeypatch: pytest.MonkeyPatch) -> None:
    """AC-16 — via the environment, the way a user would actually hit it."""
    monkeypatch.setenv("PORT", "invalid_int")

    with pytest.raises(ValidationError):
        Settings()


# --- CORS (AC-31) -----------------------------------------------------------


def test_wildcard_cors_origin_is_rejected() -> None:
    """AC-31 — a wildcard would undo the loopback guarantee."""
    with pytest.raises(ValidationError) as excinfo:
        Settings(cors_origins="*", _env_file=None)

    assert "wildcard" in str(excinfo.value).lower()


def test_wildcard_in_a_list_is_also_rejected() -> None:
    with pytest.raises(ValidationError):
        Settings(cors_origins="http://localhost:5173,*", _env_file=None)


def test_default_cors_origins_are_local_only() -> None:
    origins = Settings(_env_file=None).cors_origin_list

    assert origins
    for origin in origins:
        assert "*" not in origin
        assert "localhost" in origin or "127.0.0.1" in origin


def test_cors_origins_are_split_and_trimmed() -> None:
    settings = Settings(cors_origins="http://localhost:5173 , http://127.0.0.1:5173", _env_file=None)

    assert settings.cors_origin_list == ["http://localhost:5173", "http://127.0.0.1:5173"]


# --- Environment-driven settings (AC-09) ------------------------------------


def test_settings_read_from_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PORT", "9123")
    monkeypatch.setenv("LOG_LEVEL", "debug")

    settings = Settings()

    assert settings.port == 9123
    assert settings.log_level == "DEBUG"  # normalised


def test_database_path_from_environment(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    target = tmp_path / "custom" / "store.sqlite3"
    monkeypatch.setenv("DATABASE_PATH", str(target))

    assert Settings().database_path == target


def test_constructor_arguments_beat_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PORT", "9999")

    assert Settings(port=8000, _env_file=None).port == 8000


def test_no_credential_shaped_defaults_exist() -> None:
    """AC-30 — defaults must contain nothing secret-shaped."""
    dumped = Settings(_env_file=None).model_dump()

    for key, value in dumped.items():
        assert "api_key" not in key.lower()
        assert "password" not in key.lower()
        assert "token" not in key.lower()
        assert value not in ("sk-", ""), f"{key} has a suspicious default"
