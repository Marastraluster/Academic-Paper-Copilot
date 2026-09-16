"""AC-05, AC-06, AC-07, AC-13, AC-14, AC-17 — SQLite bootstrap behaviour."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.db import BUSY_TIMEOUT_MS, SCHEMA_VERSION, bootstrap_database, connect, list_tables


def test_bootstrap_enables_wal_and_foreign_keys(tmp_path: Path) -> None:
    """AC-05."""
    connection = bootstrap_database(tmp_path / "db.sqlite3")
    try:
        journal_mode = connection.execute("PRAGMA journal_mode;").fetchone()[0]
        foreign_keys = connection.execute("PRAGMA foreign_keys;").fetchone()[0]
    finally:
        connection.close()

    assert journal_mode.lower() == "wal"
    assert foreign_keys == 1


def test_bootstrap_records_every_migration_version(tmp_path: Path) -> None:
    """DS-BE-001 AC-05, extended by DS-BE-005.

    A fresh database is stamped with the baseline and then each migration in
    turn, so "created fresh" and "upgraded from v1" leave identical history.
    """
    connection = bootstrap_database(tmp_path / "db.sqlite3")
    try:
        rows = connection.execute(
            "SELECT version, applied_at FROM schema_version ORDER BY version"
        ).fetchall()
    finally:
        connection.close()

    assert [row["version"] for row in rows] == list(range(1, SCHEMA_VERSION + 1))
    assert all(row["applied_at"] for row in rows)
    assert rows[-1]["version"] == SCHEMA_VERSION


def test_bootstrap_is_idempotent(tmp_path: Path) -> None:
    """AC-05 / AC-38.7 — repeat runs must not error or disturb existing data."""
    database = tmp_path / "db.sqlite3"

    first = bootstrap_database(database)
    before = first.execute("SELECT version, applied_at FROM schema_version").fetchall()
    first.close()

    second = bootstrap_database(database)  # must not raise
    after = second.execute("SELECT version, applied_at FROM schema_version").fetchall()
    second.close()

    assert [tuple(r) for r in before] == [tuple(r) for r in after]


def test_only_expected_tables_exist(tmp_path: Path) -> None:
    """AC-06 / AC-38.8, narrowed by DS-BE-005 AC-04.

    ``profiles`` joined the expected set when DS-BE-005 added its migration. The
    guard is *pinned to an exact set* rather than loosened, so a table for a phase
    that has not started still fails the suite — which was the whole point of the
    original assertion.
    """
    connection = bootstrap_database(tmp_path / "db.sqlite3")
    try:
        tables = list_tables(connection)
    finally:
        connection.close()

    assert tables == ["profiles", "schema_version"]

    forbidden = {
        "documents", "pages", "sections", "paragraphs", "glossary",
        "translation_tasks", "tasks", "chat_sessions", "chat_messages", "chunks_fts",
    }
    assert not forbidden & set(tables), f"speculative tables present: {forbidden & set(tables)}"


def test_creates_missing_parent_directories(tmp_path: Path) -> None:
    """AC-13 / AC-38.9."""
    nested = tmp_path / "deep" / "nested" / "db.sqlite3"
    assert not nested.parent.exists()

    connection = bootstrap_database(nested)
    connection.close()

    assert nested.exists()


def test_handles_spaces_and_unicode_in_path(tmp_path: Path) -> None:
    """AC-14."""
    awkward = tmp_path / "张 伟" / "my documents" / "db.sqlite3"

    connection = bootstrap_database(awkward)
    try:
        assert connection.execute("PRAGMA journal_mode;").fetchone()[0].lower() == "wal"
    finally:
        connection.close()

    assert awkward.exists()


def test_busy_timeout_is_at_least_five_seconds(tmp_path: Path) -> None:
    """AC-17."""
    connection = connect(tmp_path / "db.sqlite3")
    try:
        busy_timeout = connection.execute("PRAGMA busy_timeout;").fetchone()[0]
    finally:
        connection.close()

    assert busy_timeout >= 5000
    assert BUSY_TIMEOUT_MS >= 5000


def test_concurrent_reads_do_not_raise_database_locked(tmp_path: Path) -> None:
    """AC-17 — a reader alongside an open writer must not fail."""
    database = tmp_path / "db.sqlite3"
    writer = bootstrap_database(database)
    reader = connect(database)
    try:
        for _ in range(25):
            assert reader.execute("SELECT COUNT(*) FROM schema_version").fetchone()[0] >= 1
    finally:
        reader.close()
        writer.close()


def test_app_startup_creates_the_configured_database(app, settings) -> None:
    """AC-05 — bootstrap runs on startup, not at import (AC-01)."""
    from fastapi.testclient import TestClient

    assert not settings.database_path.exists(), "database existed before startup"

    # Entering the TestClient context runs the lifespan.
    with TestClient(app):
        assert settings.database_path.exists()


def test_shutdown_closes_the_database_connection(app, settings) -> None:
    """AC-18 — the lifespan releases the connection on the way out.

    Driven directly rather than through ``TestClient``: the test client runs the
    lifespan on its own portal thread, and a SQLite connection is thread-affine,
    so the connection could not be exercised from the test body. Running the
    lifespan with ``asyncio.run`` keeps everything on one thread.
    """
    import asyncio
    import sqlite3

    async def scenario() -> sqlite3.Connection:
        async with app.router.lifespan_context(app):
            connection = app.state.db
            assert connection.execute("SELECT 1").fetchone()[0] == 1
        return connection

    closed_connection = asyncio.run(scenario())

    with pytest.raises(sqlite3.ProgrammingError, match="closed"):
        closed_connection.execute("SELECT 1")


def test_database_connection_is_confined_to_one_thread(app) -> None:
    """Records a constraint future phases must respect.

    The connection is created on the lifespan's thread and SQLite refuses to use
    it from another. Every current endpoint is ``async def`` and therefore runs on
    the event loop, which is the same context. A future *synchronous* (``def``)
    endpoint would be dispatched to a worker thread and hit this immediately —
    such an endpoint must open its own connection.
    """
    import asyncio
    import sqlite3
    import threading

    async def scenario() -> None:
        async with app.router.lifespan_context(app):
            connection = app.state.db
            captured: list[BaseException] = []

            def use_from_other_thread() -> None:
                try:
                    connection.execute("SELECT 1")
                except BaseException as exc:  # noqa: BLE001 - recorded, then asserted
                    captured.append(exc)

            worker = threading.Thread(target=use_from_other_thread)
            worker.start()
            worker.join()

            assert captured, "expected SQLite to refuse cross-thread use"
            assert isinstance(captured[0], sqlite3.ProgrammingError)

    asyncio.run(scenario())
