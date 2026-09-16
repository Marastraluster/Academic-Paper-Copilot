"""SQLite bootstrap and migrations.

Migrations are **sequential and additive**. Version 1 is the baseline
(schema-version tracking only); version 2 introduces the first real table,
``profiles``. A database created fresh and one upgraded from v1 end up in an
identical state, which is the property that makes an upgrade path trustworthy.

A database written by a *newer* build refuses to open rather than being read with
assumptions that no longer hold.

The connection is opened with:

* ``journal_mode=WAL`` — concurrent readers alongside a writer.
* ``foreign_keys=ON`` — SQLite disables them per-connection by default.
* ``busy_timeout=5000`` — wait rather than immediately raising
  "database is locked" (AC-17 of DS-BE-001).
"""

from __future__ import annotations

import sqlite3
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path

#: Current schema version. Bump when adding a migration below.
SCHEMA_VERSION = 2

#: The version every database starts at, before any migration runs.
BASELINE_VERSION = 1

BUSY_TIMEOUT_MS = 5000


class DatabaseVersionError(RuntimeError):
    """The database was created by a newer build than this one."""


def _utc_now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def connect(path: Path) -> sqlite3.Connection:
    """Open a connection with the project's pragmas applied."""
    connection = sqlite3.connect(str(path), timeout=BUSY_TIMEOUT_MS / 1000.0)
    connection.row_factory = sqlite3.Row
    connection.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS};")
    connection.execute("PRAGMA foreign_keys=ON;")
    return connection


# --- migrations -------------------------------------------------------------


def _migration_002_create_profiles(connection: sqlite3.Connection) -> None:
    """Add the provider-profile table.

    Note what is **absent**: no column holds key material. Credentials live in
    the OS credential store; this table keeps only an opaque ``credential_ref``
    that is meaningless on its own.
    """
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS profiles (
            id               TEXT PRIMARY KEY,
            name             TEXT NOT NULL UNIQUE COLLATE NOCASE,
            base_url         TEXT NOT NULL,
            model            TEXT NOT NULL,
            protocol         TEXT NOT NULL DEFAULT 'auto',
            temperature      REAL,
            max_output_tokens INTEGER,
            timeout_s        REAL NOT NULL DEFAULT 60.0,
            custom_headers   TEXT,
            credential_ref   TEXT UNIQUE,
            created_at       TEXT NOT NULL,
            updated_at       TEXT NOT NULL
        )
        """
    )


#: version -> migration. Each entry upgrades the database *to* that version.
MIGRATIONS: dict[int, Callable[[sqlite3.Connection], None]] = {
    2: _migration_002_create_profiles,
}


def _ensure_schema_version_table(connection: sqlite3.Connection) -> None:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_version (
            version    INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL
        )
        """
    )


def _current_version(connection: sqlite3.Connection) -> int | None:
    row = connection.execute("SELECT MAX(version) FROM schema_version").fetchone()
    return None if row is None or row[0] is None else int(row[0])


def bootstrap_database(path: Path) -> sqlite3.Connection:
    """Create (or open) the database and bring its schema up to date.

    Idempotent: running it repeatedly against the same file is safe and does not
    disturb existing rows. Parent directories are created as needed.
    """
    path = Path(path)
    if path.parent and not path.parent.exists():
        path.parent.mkdir(parents=True, exist_ok=True)

    connection = connect(path)

    # WAL is persistent, but setting it is a no-op when already enabled.
    connection.execute("PRAGMA journal_mode=WAL;")
    _ensure_schema_version_table(connection)

    current = _current_version(connection)

    if current is None:
        # A brand-new database is explicitly stamped as v1 before migrating, so
        # that "fresh" and "upgraded" converge on the same state and the history
        # is the same either way.
        connection.execute(
            "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
            (BASELINE_VERSION, _utc_now_iso()),
        )
        current = BASELINE_VERSION

    if current > SCHEMA_VERSION:
        connection.close()
        raise DatabaseVersionError(
            f"Database schema version {current} is newer than supported version "
            f"{SCHEMA_VERSION}. Please upgrade the application."
        )

    for version in range(current + 1, SCHEMA_VERSION + 1):
        migration = MIGRATIONS.get(version)
        if migration is None:  # pragma: no cover - guards a mis-edited table
            connection.close()
            raise DatabaseVersionError(f"No migration registered for version {version}")
        migration(connection)
        connection.execute(
            "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
            (version, _utc_now_iso()),
        )

    connection.commit()
    return connection


def list_tables(connection: sqlite3.Connection) -> list[str]:
    """User tables present in the database, sorted.

    Used by the test suite to assert that no *speculative* table has crept in.
    """
    rows = connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).fetchall()
    return [row["name"] for row in rows]
