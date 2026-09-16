"""DS-BE-005 — credential storage.

Every test runs against the in-memory fake installed by ``conftest``'s autouse
fixture. Nothing here may touch Windows Credential Manager; AC-30.24 asserts that
directly rather than trusting the fixture to have been applied.
"""

from __future__ import annotations

import re

import keyring
import pytest
from keyring.backends import fail as fail_backend

from app.security.credentials import (
    KEYRING_SERVICE_NAME,
    CredentialNotFoundError,
    CredentialStoreUnavailableError,
    delete_credential,
    get_credential,
    is_credential_store_available,
    mask_api_key,
    new_credential_ref,
    set_credential,
)


# --- AC-30.24 / AC-22 / FC-10: isolation ------------------------------------


def test_test_session_uses_the_fake_credential_store() -> None:
    """AC-22 / AC-30.24 / FC-10 — the real OS store must never be active here.

    Inspected by name rather than by importing the fake, so this cannot
    accidentally pass by comparing a class to itself.
    """
    active = keyring.get_keyring()

    assert type(active).__name__ == "FakeKeyring"
    assert "WinVault" not in type(active).__name__
    assert getattr(active, "priority", 0) > 0


def test_writing_a_credential_does_not_reach_the_os_store(fake_credential_store) -> None:
    """The strongest form of the same guarantee: observe where it lands."""
    set_credential("cred_test", "sk-live-SHOULD-NOT-ESCAPE")

    assert (
        fake_credential_store.get_password(KEYRING_SERVICE_NAME, "cred_test")
        == "sk-live-SHOULD-NOT-ESCAPE"
    )


# --- AC-30.10 / AC-09: masking ----------------------------------------------


@pytest.mark.parametrize(
    ("key", "expected"),
    [
        ("", ""),
        ("a", "••••••••"),
        ("ab", "••••••••"),
        ("abc", "••••bc"),
        ("abcdefgh", "••••gh"),
        ("sk-1234567890ab12", "sk-••••••••ab12"),
        ("sk-proj-abcdefghijklmnop", "sk-••••••••mnop"),
    ],
)
def test_mask_api_key(key: str, expected: str) -> None:
    """AC-09 / AC-30.10 — at most 3 leading and 4 trailing characters survive."""
    assert mask_api_key(key) == expected


def test_mask_reveals_no_more_than_the_documented_amount() -> None:
    """AC-09 — checked structurally, not just by example."""
    key = "sk-live-VERY-LONG-SECRET-VALUE-1234567890"
    masked = mask_api_key(key)

    assert not masked.endswith(key[-5:])
    assert key not in masked
    assert masked[:3] == key[:3]
    assert masked[-4:] == key[-4:]


def test_mask_never_returns_the_whole_key() -> None:
    for key in ("sk-short", "sk-a-much-longer-credential-value"):
        assert mask_api_key(key) != key


# --- references --------------------------------------------------------------


def test_credential_ref_format() -> None:
    """AC-08 / Q2 — opaque, prefixed, fixed shape."""
    ref = new_credential_ref()

    assert re.fullmatch(r"cred_[0-9a-f]{32}", ref), ref
    assert len(ref) == 37


def test_credential_refs_are_unique() -> None:
    refs = {new_credential_ref() for _ in range(100)}

    assert len(refs) == 100


def test_credential_ref_reveals_nothing() -> None:
    """AC-08 — it must not embed a name, URL, model, or row id."""
    ref = new_credential_ref()

    for fragment in ("http", "@", "openai", "model", "profile"):
        assert fragment not in ref


# --- round trip --------------------------------------------------------------


def test_set_and_get_round_trip() -> None:
    ref = new_credential_ref()
    set_credential(ref, "sk-live-round-trip")

    assert get_credential(ref) == "sk-live-round-trip"


def test_get_missing_credential_raises() -> None:
    """A dangling reference is an inconsistency, not an empty key."""
    with pytest.raises(CredentialNotFoundError):
        get_credential("cred_does_not_exist")


def test_delete_removes_the_secret() -> None:
    ref = new_credential_ref()
    set_credential(ref, "sk-live-delete-me")

    assert delete_credential(ref) is True
    with pytest.raises(CredentialNotFoundError):
        get_credential(ref)


def test_deleting_an_absent_credential_is_not_an_error() -> None:
    """Deleting an already-deleted profile must succeed (AC-15)."""
    assert delete_credential("cred_never_existed") is False


def test_updating_a_credential_overwrites() -> None:
    ref = new_credential_ref()
    set_credential(ref, "sk-first")
    set_credential(ref, "sk-second")

    assert get_credential(ref) == "sk-second"


# --- AC-19 / AC-30.20 / AC-23 / AC-30.25: unavailable store -----------------


@pytest.fixture
def broken_store(monkeypatch: pytest.MonkeyPatch) -> None:
    """Simulate a machine with no usable credential store."""
    monkeypatch.setattr(keyring, "get_keyring", lambda: fail_backend.Keyring())


def test_availability_probe_with_fake_store(fake_credential_store) -> None:
    """AC-23 / AC-30.25."""
    assert is_credential_store_available() is True


def test_availability_probe_with_failed_store(broken_store: None) -> None:
    """AC-23 / AC-30.25 — reports False rather than raising."""
    assert is_credential_store_available() is False


def test_availability_probe_is_false_when_get_keyring_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    def explode() -> None:
        raise RuntimeError("keyring is broken")

    monkeypatch.setattr(keyring, "get_keyring", explode)

    assert is_credential_store_available() is False


def test_storing_a_credential_without_a_store_raises(broken_store: None) -> None:
    """AC-19 / AC-30.20 / FC-04 — and there is no fallback."""
    with pytest.raises(CredentialStoreUnavailableError):
        set_credential("cred_x", "sk-live-must-not-be-written")


def test_reading_a_credential_without_a_store_raises(broken_store: None) -> None:
    """AC-19."""
    with pytest.raises(CredentialStoreUnavailableError):
        get_credential("cred_x")


def test_deleting_a_credential_without_a_store_raises(broken_store: None) -> None:
    """AC-19 — silently reporting success would hide a real problem."""
    with pytest.raises(CredentialStoreUnavailableError):
        delete_credential("cred_x")


def test_unavailable_store_error_is_typed_and_explains_itself(broken_store: None) -> None:
    """AC-19 — the message must make the refusal to fall back explicit."""
    with pytest.raises(CredentialStoreUnavailableError) as excinfo:
        set_credential("cred_x", "sk-live-x")

    message = str(excinfo.value).lower()
    assert "credential store" in message
    assert "plaintext" in message
    assert "sk-live-x" not in str(excinfo.value)


def test_no_fallback_path_exists_in_source() -> None:
    """FC-04 — a source-level guard against reintroducing a fallback later."""
    from app.config import BACKEND_DIR

    source = (BACKEND_DIR / "app" / "security" / "credentials.py").read_text(encoding="utf-8")

    for forbidden in ("open(", "sqlite3", "os.environ[", "tempfile", "write_text"):
        assert forbidden not in source, f"credentials.py appears able to fall back via {forbidden!r}"
