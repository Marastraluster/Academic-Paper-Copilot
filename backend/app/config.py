"""Application settings, loaded from the environment (AC-09).

No secrets live here. Provider credentials are held in the OS credential store,
never in settings or in the database (docs/ARCHITECTURE.md §4.7).
"""

from __future__ import annotations

import os
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

APP_NAME = "AcademicPDFCopilot"

#: Anchor the optional ``.env`` to the backend directory rather than the current
#: working directory, so behaviour does not depend on where the process was
#: launched from.
BACKEND_DIR = Path(__file__).resolve().parent.parent

#: Hosts a local-first application is permitted to bind to. Anything else would
#: expose the service beyond this machine (AC-03, AC-28).
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})

#: The local origins the frontend is served from. Never a wildcard (AC-31).
DEFAULT_CORS_ORIGINS = (
    "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173"
)


def default_data_dir() -> Path:
    """Per-user application data directory (AC-07)."""
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA")
        if base:
            return Path(base) / APP_NAME
    return Path.home() / ".local" / "share" / APP_NAME


class Settings(BaseSettings):
    """Environment-driven configuration with safe defaults.

    Invalid values raise at construction time, so a malformed ``PORT`` stops the
    process at startup rather than leaving it running in a degraded state
    (AC-16).
    """

    # Precedence: constructor arguments > real environment > backend/.env > defaults.
    model_config = SettingsConfigDict(
        env_file=BACKEND_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    host: str = "127.0.0.1"
    port: int = Field(default=8000, ge=1, le=65535)
    database_path: Path = Field(default_factory=lambda: default_data_dir() / "db.sqlite3")
    log_level: str = "INFO"
    cors_origins: str = DEFAULT_CORS_ORIGINS
    debug: bool = False

    @field_validator("host")
    @classmethod
    def _reject_non_loopback(cls, value: str) -> str:
        """Refuse to bind anywhere but loopback (AC-03, AC-28)."""
        if value not in LOOPBACK_HOSTS:
            raise ValueError(
                f"host must be a loopback address, one of {sorted(LOOPBACK_HOSTS)}; "
                f"got {value!r}. This backend is local-only and must never be "
                "exposed on a network interface."
            )
        return value

    @field_validator("log_level")
    @classmethod
    def _normalise_log_level(cls, value: str) -> str:
        level = value.strip().upper()
        allowed = {"CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG"}
        if level not in allowed:
            raise ValueError(f"log_level must be one of {sorted(allowed)}; got {value!r}")
        return level

    @field_validator("cors_origins")
    @classmethod
    def _reject_cors_wildcard(cls, value: str) -> str:
        """A wildcard origin would undo the loopback-only guarantee (AC-31)."""
        if "*" in value:
            raise ValueError(
                "cors_origins must not contain a wildcard '*'; "
                "list the local frontend origins explicitly."
            )
        return value

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]
