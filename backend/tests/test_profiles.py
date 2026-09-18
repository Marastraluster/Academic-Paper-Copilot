"""DS-BE-005 — provider profile persistence.

The interesting assertions here are the negative ones: that a key reaches the OS
credential store and *not* the database, its logs, its reprs, or its errors.
"""

from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path

import keyring
import pytest
from keyring.backends import fail as fail_backend

from app.db import SCHEMA_VERSION, DatabaseVersionError, bootstrap_database, connect
from app.security.credentials import KEYRING_SERVICE_NAME, CredentialStoreUnavailableError
from app.storage.profiles import (
    ProfileNameExistsError,
    ProfileNotFoundError,
    ProfileStore,
    ProfileStoreError,
    ProfileValidationError,
)

SECRET = "sk-live-secret-never-touch-disk-xyz987654321"


@pytest.fixture
def db_path(tmp_path: Path) -> Path:
    return tmp_path / "profiles.sqlite3"


@pytest.fixture
def store(db_path: Path):
    connection = bootstrap_database(db_path)
    try:
        yield ProfileStore(connection)
    finally:
        connection.close()


def make_profile(store: ProfileStore, **overrides):
    fields = {
        "name": "OpenAI",
        "base_url": "https://api.openai.com/v1",
        "model": "gpt-x",
        "api_key": SECRET,
    }
    fields.update(overrides)
    return store.create_profile(**fields)


# --- AC-30.01 … AC-30.04 / AC-01 … AC-03: migration --------------------------


def test_migration_creates_the_profiles_table(db_path: Path) -> None:
    """AC-01 / AC-30.01."""
    connection = bootstrap_database(db_path)
    try:
        tables = {
            row[0]
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        versions = [row[0] for row in connection.execute("SELECT version FROM schema_version ORDER BY version")]
    finally:
        connection.close()

    assert "profiles" in tables
    # DS-BE-007 added documents and translation_tasks, raising this to 3.
    assert versions[-1] == SCHEMA_VERSION == 4


def test_migration_preserves_existing_v1_data(tmp_path: Path) -> None:
    """AC-02 / AC-30.02 — an upgrade must not destroy what was already there."""
    db_path = tmp_path / "legacy.sqlite3"

    # Build a v1-shaped database by hand.
    connection = connect(db_path)
    connection.execute("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)")
    connection.execute("INSERT INTO schema_version VALUES (1, '2026-01-01T00:00:00+00:00')")
    connection.commit()
    connection.close()

    connection = bootstrap_database(db_path)
    try:
        rows = connection.execute("SELECT version, applied_at FROM schema_version ORDER BY version").fetchall()
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    finally:
        connection.close()

    # Every migration in order, one row each: v1 was stamped at creation and each
    # later step appended its own. DS-QA-010 added the fourth.
    assert [row["version"] for row in rows] == [1, 2, 3, 4]
    assert rows[0]["applied_at"] == "2026-01-01T00:00:00+00:00", "the original v1 row was altered"
    assert "profiles" in tables


def test_migration_is_idempotent(db_path: Path) -> None:
    """AC-01 / AC-30.03."""
    first = bootstrap_database(db_path)
    before = [tuple(r) for r in first.execute("SELECT version, applied_at FROM schema_version ORDER BY version")]
    first.close()

    second = bootstrap_database(db_path)
    after = [tuple(r) for r in second.execute("SELECT version, applied_at FROM schema_version ORDER BY version")]
    second.close()

    assert before == after


def test_newer_database_version_is_rejected(tmp_path: Path) -> None:
    """AC-03 / AC-30.04 — refuse rather than read a schema we do not understand."""
    db_path = tmp_path / "future.sqlite3"

    connection = connect(db_path)
    connection.execute("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)")
    connection.execute("INSERT INTO schema_version VALUES (99, '2030-01-01T00:00:00+00:00')")
    connection.commit()
    connection.close()

    with pytest.raises(DatabaseVersionError) as excinfo:
        bootstrap_database(db_path)

    assert "99" in str(excinfo.value)
    assert "newer" in str(excinfo.value).lower()


def test_a_fresh_database_matches_an_upgraded_one(tmp_path: Path) -> None:
    """AC-01/AC-02 — the property that makes an upgrade path trustworthy."""
    fresh_path = tmp_path / "fresh.sqlite3"
    upgraded_path = tmp_path / "upgraded.sqlite3"

    legacy = connect(upgraded_path)
    legacy.execute("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)")
    legacy.execute("INSERT INTO schema_version VALUES (1, '2026-01-01T00:00:00+00:00')")
    legacy.commit()
    legacy.close()

    fresh = bootstrap_database(fresh_path)
    upgraded = bootstrap_database(upgraded_path)
    try:
        def schema(connection):
            return sorted(
                (row[0], row[1])
                for row in connection.execute(
                    "SELECT name, sql FROM sqlite_master WHERE type='table' AND name != 'schema_version'"
                )
            )

        assert schema(fresh) == schema(upgraded)
    finally:
        fresh.close()
        upgraded.close()


# --- AC-30.06 / AC-05: no secret columns -------------------------------------


def test_profiles_schema_has_no_secret_columns(store: ProfileStore, db_path: Path) -> None:
    """AC-05 / AC-30.06 — no column can hold secret material.

    Two exemptions, both load-bearing rather than conveniences:

    * ``credential_ref`` — an opaque pointer with no secret in it, and the whole
      mechanism by which the key stays out of the database.
    * ``max_output_tokens`` — matched only because the substring "token" appears
      in a generation-setting name. AC-05 *requires* this column, so a literal
      substring ban would contradict the schema the same criterion mandates.
      Its value is an integer token *count*, never a credential.
    """
    connection = sqlite3.connect(str(db_path))
    try:
        columns = [row[1] for row in connection.execute("PRAGMA table_info(profiles)")]
    finally:
        connection.close()

    exempt = {"credential_ref", "max_output_tokens"}
    for column in columns:
        if column in exempt:
            continue
        lowered = column.lower()
        for marker in ("key", "secret", "token", "password", "auth"):
            assert marker not in lowered, f"column {column!r} looks secret-bearing"

    # The exemptions must not become a hiding place: neither column is textual
    # free-form data that could carry a credential.
    connection = sqlite3.connect(str(db_path))
    try:
        types = {row[1]: row[2] for row in connection.execute("PRAGMA table_info(profiles)")}
    finally:
        connection.close()

    assert types["max_output_tokens"] == "INTEGER"
    assert types["credential_ref"] == "TEXT"


def test_profiles_table_has_the_expected_columns(store: ProfileStore, db_path: Path) -> None:
    """AC-05 — pinned exactly, so a stray column is a failure not a surprise."""
    connection = sqlite3.connect(str(db_path))
    try:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(profiles)")}
    finally:
        connection.close()

    assert columns == {
        "id", "name", "base_url", "model", "protocol", "temperature",
        "max_output_tokens", "timeout_s", "custom_headers", "credential_ref",
        "created_at", "updated_at",
    }


# --- AC-30.09 / AC-06 / FC-02: the key never reaches disk --------------------


def test_raw_database_bytes_contain_no_key(store: ProfileStore, db_path: Path) -> None:
    """AC-06 / AC-30.09 / FC-02 — the assertion this whole task exists for.

    Reads the main file *and* the WAL and SHM companions: a secret that only ever
    reached a WAL page would still be sitting on the user's disk.
    """
    profile = make_profile(store, name="DiskCheck")
    assert profile.has_key

    # Force the writes out of any in-process cache.
    store._connection.commit()  # noqa: SLF001 - deliberate, to make the bytes real
    store._connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")  # noqa: SLF001

    candidates = [db_path, db_path.with_name(db_path.name + "-wal"), db_path.with_name(db_path.name + "-shm")]

    inspected = 0
    for candidate in candidates:
        if not candidate.exists():
            continue
        inspected += 1
        assert SECRET.encode("utf-8") not in candidate.read_bytes(), f"key found in {candidate.name}"

    assert inspected >= 1, "no database file was actually inspected"


def test_the_key_is_actually_retrievable_so_the_previous_test_means_something(
    store: ProfileStore, fake_credential_store
) -> None:
    """Guards against the byte test passing merely because nothing was stored."""
    profile = make_profile(store, name="Retrievable")

    assert (
        fake_credential_store.get_password(KEYRING_SERVICE_NAME, profile.credential_ref) == SECRET
    )


# --- AC-30.07, AC-30.08 / AC-07, AC-08: keyring addressing -------------------


def test_key_is_stored_under_the_namespaced_service(store: ProfileStore, fake_credential_store) -> None:
    """AC-07 / AC-30.07."""
    profile = make_profile(store)

    assert KEYRING_SERVICE_NAME == "AcademicPDFCopilot.profiles"
    assert fake_credential_store.get_password(KEYRING_SERVICE_NAME, profile.credential_ref) == SECRET


def test_credential_ref_format(store: ProfileStore) -> None:
    """AC-08 / AC-30.08."""
    profile = make_profile(store)

    assert profile.credential_ref is not None
    assert re.fullmatch(r"cred_[0-9a-f]{32}", profile.credential_ref)


def test_credential_ref_does_not_use_the_name_or_id(store: ProfileStore) -> None:
    """AC-08 / FC-07 — the two mutable or guessable alternatives."""
    profile = make_profile(store, name="MyVeryDistinctiveProfileName")

    assert profile.credential_ref != profile.name
    assert profile.credential_ref != profile.id
    assert profile.name not in profile.credential_ref


# --- AC-30.11 / AC-10: reads never return the key ----------------------------


def test_read_returns_masked_key_only(store: ProfileStore) -> None:
    """AC-10 / AC-30.11."""
    created = make_profile(store)

    for profile in (store.get_profile(created.id), store.get_profile_by_name(created.name), *store.list_profiles()):
        assert profile.has_key is True
        assert profile.api_key_masked == "sk-••••••••4321"
        assert SECRET not in repr(profile)
        assert SECRET not in str(profile)


def test_profile_repr_contains_no_secret(store: ProfileStore) -> None:
    """AC-20 / AC-30.21."""
    profile = make_profile(store)

    rendered = f"{profile!r} {profile}"

    assert SECRET not in rendered
    assert "••••" in rendered or profile.api_key_masked in rendered


# --- AC-30.12 / AC-11: keyless profiles --------------------------------------


@pytest.mark.parametrize("key", [None, ""])
def test_keyless_profile_creates_no_credential(store: ProfileStore, fake_credential_store, key) -> None:
    """AC-11 / AC-30.12 — a local server with no key is legitimate."""
    profile = store.create_profile(
        name=f"Local-{key}", base_url="http://127.0.0.1:11434/v1", model="llama3", api_key=key
    )

    assert profile.credential_ref is None
    assert profile.has_key is False
    assert profile.api_key_masked == ""
    assert fake_credential_store._store == {}


# --- AC-30.13 … AC-30.15 / AC-12 … AC-14: update semantics -------------------


def test_update_without_key_leaves_the_credential_alone(store: ProfileStore, fake_credential_store) -> None:
    """AC-12 / AC-30.13 — collapsing this with "clear" would destroy user keys."""
    created = make_profile(store)
    before = fake_credential_store.get_password(KEYRING_SERVICE_NAME, created.credential_ref)

    updated = store.update_profile(created.id, model="gpt-y")

    assert updated.model == "gpt-y"
    assert updated.credential_ref == created.credential_ref
    assert fake_credential_store.get_password(KEYRING_SERVICE_NAME, created.credential_ref) == before


def test_update_with_a_new_key_replaces_it(store: ProfileStore, fake_credential_store) -> None:
    """AC-13 / AC-30.14."""
    created = make_profile(store)

    updated = store.update_profile(created.id, api_key="sk-live-rotated-9999")

    assert updated.credential_ref == created.credential_ref, "rotation should reuse the reference"
    assert fake_credential_store.get_password(KEYRING_SERVICE_NAME, created.credential_ref) == "sk-live-rotated-9999"


def test_update_adding_a_key_to_a_keyless_profile(store: ProfileStore) -> None:
    """AC-13 — a keyless profile gains a reference when a key arrives."""
    created = store.create_profile(name="Keyless", base_url="http://localhost/v1", model="m")

    updated = store.update_profile(created.id, api_key="sk-live-added")

    assert created.credential_ref is None
    assert updated.credential_ref is not None
    assert updated.has_key is True


def test_update_with_an_empty_key_clears_the_credential(store: ProfileStore, fake_credential_store) -> None:
    """AC-14 / AC-30.15."""
    created = make_profile(store)
    ref = created.credential_ref

    updated = store.update_profile(created.id, api_key="")

    assert updated.credential_ref is None
    assert updated.has_key is False
    assert fake_credential_store.get_password(KEYRING_SERVICE_NAME, ref) is None


# --- AC-30.16 / AC-15: delete removes the credential -------------------------


def test_delete_removes_profile_and_credential(store: ProfileStore, fake_credential_store) -> None:
    """AC-15 / AC-30.16 / FC-05 — no orphaned secrets."""
    created = make_profile(store)
    ref = created.credential_ref

    store.delete_profile(created.id)

    with pytest.raises(ProfileNotFoundError):
        store.get_profile(created.id)
    assert fake_credential_store.get_password(KEYRING_SERVICE_NAME, ref) is None


def test_delete_tolerates_an_already_removed_credential(store: ProfileStore, fake_credential_store) -> None:
    """AC-15 — deleting must not fail because the secret vanished first."""
    created = make_profile(store)
    fake_credential_store.delete_password(KEYRING_SERVICE_NAME, created.credential_ref)

    store.delete_profile(created.id)  # must not raise

    with pytest.raises(ProfileNotFoundError):
        store.get_profile(created.id)


# --- AC-30.17 / AC-16 / FC-06: rename preserves the credential --------------


def test_rename_preserves_the_credential(store: ProfileStore, fake_credential_store) -> None:
    """AC-16 / AC-30.17 / FC-06."""
    created = make_profile(store)
    ref = created.credential_ref

    renamed = store.update_profile(created.id, name="Renamed Endpoint")

    assert renamed.name == "Renamed Endpoint"
    assert renamed.credential_ref == ref
    assert fake_credential_store.get_password(KEYRING_SERVICE_NAME, ref) == SECRET
    assert renamed.api_key_masked == created.api_key_masked


def test_rename_does_not_write_to_the_keyring(store: ProfileStore, fake_credential_store, monkeypatch) -> None:
    """AC-16 — the keyring is not merely unchanged in value, it is not touched."""
    created = make_profile(store)

    calls: list[str] = []
    monkeypatch.setattr(keyring, "set_password", lambda *a, **k: calls.append("set"))
    monkeypatch.setattr(keyring, "delete_password", lambda *a, **k: calls.append("delete"))

    store.update_profile(created.id, name="Renamed Again")

    assert calls == []


# --- AC-30.18, AC-30.19 / AC-17, AC-18: typed failures -----------------------


def test_duplicate_name_is_rejected(store: ProfileStore) -> None:
    """AC-17 / AC-30.18."""
    make_profile(store, name="Duplicate")

    with pytest.raises(ProfileNameExistsError):
        make_profile(store, name="Duplicate")


@pytest.mark.parametrize("name", ["duplicate", "DUPLICATE", "DuPlIcAtE"])
def test_duplicate_name_is_case_insensitive(store: ProfileStore, name: str) -> None:
    """AC-17."""
    make_profile(store, name="Duplicate")

    with pytest.raises(ProfileNameExistsError):
        make_profile(store, name=name)


def test_rename_onto_an_existing_name_is_rejected(store: ProfileStore) -> None:
    """AC-17."""
    make_profile(store, name="First")
    second = make_profile(store, name="Second")

    with pytest.raises(ProfileNameExistsError):
        store.update_profile(second.id, name="First")


def test_renaming_a_profile_to_its_own_name_is_allowed(store: ProfileStore) -> None:
    """A no-op rename must not trip the uniqueness check."""
    created = make_profile(store, name="Self")

    assert store.update_profile(created.id, name="Self").name == "Self"


def test_missing_profile_raises_not_found(store: ProfileStore) -> None:
    """AC-18 / AC-30.19."""
    with pytest.raises(ProfileNotFoundError):
        store.get_profile("prof_does_not_exist")
    with pytest.raises(ProfileNotFoundError):
        store.update_profile("prof_does_not_exist", model="m")
    with pytest.raises(ProfileNotFoundError):
        store.delete_profile("prof_does_not_exist")
    with pytest.raises(ProfileNotFoundError):
        store.get_profile_by_name("no such name")


# --- AC-30.20 / AC-19: unavailable store -------------------------------------


def test_creating_a_profile_with_a_key_fails_loudly_without_a_store(store: ProfileStore, monkeypatch) -> None:
    """AC-19 / AC-30.20 / FC-04 — never a silent fallback to plaintext."""
    monkeypatch.setattr(keyring, "get_keyring", lambda: fail_backend.Keyring())

    with pytest.raises(CredentialStoreUnavailableError):
        make_profile(store, name="NoStore")

    # And nothing was half-written.
    assert store.list_profiles() == []


# --- AC-30.22, AC-30.23 / AC-21: provider config -----------------------------


def test_to_provider_config_carries_the_real_key(store: ProfileStore) -> None:
    """AC-21 / AC-30.22."""
    created = make_profile(store, temperature=0.3, max_output_tokens=512, timeout_s=45.0)

    config = store.to_provider_config(created.id)

    assert config.api_key.get_secret_value() == SECRET
    assert config.base_url == created.base_url
    assert config.model == created.model
    assert config.temperature == 0.3
    assert config.max_output_tokens == 512
    assert config.timeout_s == 45.0


def test_to_provider_config_for_a_keyless_profile(store: ProfileStore) -> None:
    """AC-21 / AC-30.23 — resolves to an empty key, which the LLM layer maps to
    its keyless placeholder."""
    created = store.create_profile(name="Local", base_url="http://localhost:11434/v1", model="llama3")

    assert store.to_provider_config(created.id).api_key.get_secret_value() == ""


def test_to_provider_config_raises_when_the_credential_is_missing(store: ProfileStore, fake_credential_store) -> None:
    """AC-21 — a dangling reference is reported, not silently treated as keyless."""
    created = make_profile(store)
    fake_credential_store.delete_password(KEYRING_SERVICE_NAME, created.credential_ref)

    with pytest.raises(ProfileStoreError):
        store.to_provider_config(created.id)


# --- AC-30.26 / AC-24: custom headers ----------------------------------------


def test_custom_headers_round_trip(store: ProfileStore) -> None:
    """AC-24 / AC-30.26."""
    headers = {"HTTP-Referer": "https://example.com", "X-Title": "PDF Copilot"}
    created = make_profile(store, custom_headers=headers)

    assert created.custom_headers == headers
    assert store.get_profile(created.id).custom_headers == headers


def test_absent_custom_headers_stay_none(store: ProfileStore) -> None:
    """AC-24."""
    created = make_profile(store)

    assert created.custom_headers is None
    assert store.get_profile(created.id).custom_headers is None


# --- AC-30.27 / AC-25: protocol validation -----------------------------------


@pytest.mark.parametrize("protocol", ["auto", "chat_completions", "responses"])
def test_valid_protocols_are_accepted(store: ProfileStore, protocol: str) -> None:
    """AC-25."""
    assert make_profile(store, name=f"P-{protocol}", protocol=protocol).protocol == protocol


def test_invalid_protocol_is_rejected(store: ProfileStore) -> None:
    """AC-25 / AC-30.27."""
    with pytest.raises(ProfileValidationError):
        make_profile(store, name="Bad", protocol="grpc")

    with pytest.raises(ProfileValidationError):
        store.create_profile(name="AlsoBad", base_url="http://x/v1", model="m", protocol="carrier-pigeon")


@pytest.mark.parametrize(("field", "value"), [("name", "  "), ("base_url", ""), ("model", " ")])
def test_blank_required_fields_are_rejected(store: ProfileStore, field: str, value: str) -> None:
    fields = {"name": "Valid", "base_url": "http://x/v1", "model": "m"}
    fields[field] = value

    with pytest.raises(ProfileValidationError):
        store.create_profile(**fields)


# --- AC-30.28 / AC-27: timestamps --------------------------------------------


def test_timestamps_are_utc_and_audited(store: ProfileStore) -> None:
    """AC-27 / AC-30.28."""
    created = make_profile(store)
    assert created.created_at.endswith("+00:00")

    updated = store.update_profile(created.id, model="gpt-z")

    assert updated.created_at == created.created_at
    assert updated.updated_at >= created.updated_at
