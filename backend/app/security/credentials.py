"""API-key storage in the OS credential store.

Three rules shape this module:

1. **Keys go to the OS credential store, or nowhere.** There is no fallback. A
   silent fallback to a plaintext file would look like success while quietly
   undoing the entire point of the design, so an unavailable store raises
   :class:`CredentialStoreUnavailableError` and the caller surfaces it.
2. **Addressing is by an opaque reference**, never the profile's name (mutable)
   or its row id (guessable). Renaming a profile therefore cannot orphan or sever
   its credential.
3. **Reads never hand back a raw key to the layer above.** Callers in the storage
   layer may fetch one to build a provider config; anything user-facing sees only
   :func:`mask_api_key` output.
"""

from __future__ import annotations

import uuid

import keyring
from keyring.backends import fail as _fail_backend
from keyring.backends import null as _null_backend

#: Namespaced service identifier under which every profile credential is filed.
KEYRING_SERVICE_NAME = "AcademicPDFCopilot.profiles"

#: Reference format: opaque, and revealing nothing about the profile it belongs to.
CREDENTIAL_REF_PREFIX = "cred_"

#: Shown in place of the middle of a key.
_MASK = "••••••••"


class CredentialStoreError(Exception):
    """Base class for credential-store failures."""


class CredentialStoreUnavailableError(CredentialStoreError):
    """No usable OS credential store is present.

    Deliberately fatal rather than recoverable-by-fallback: the only safe
    response is to tell the user, not to write their key somewhere insecure.
    """


class CredentialNotFoundError(CredentialStoreError):
    """A credential reference has no corresponding stored secret."""


def new_credential_ref() -> str:
    """Generate an opaque reference for a new credential."""
    return f"{CREDENTIAL_REF_PREFIX}{uuid.uuid4().hex}"


def _active_backend() -> object | None:
    try:
        return keyring.get_keyring()
    except Exception:  # noqa: BLE001 - any failure means "no usable backend"
        return None


def is_credential_store_available() -> bool:
    """Whether a functional credential store is present.

    ``fail.Keyring`` reports priority 0 and ``null.Keyring`` reports -1, so a
    non-positive priority is the signal that keyring has fallen back to
    doing nothing.
    """
    backend = _active_backend()
    if backend is None:
        return False
    if isinstance(backend, (_fail_backend.Keyring, _null_backend.Keyring)):
        return False
    return getattr(backend, "priority", 0) > 0


def _require_store() -> None:
    if not is_credential_store_available():
        raise CredentialStoreUnavailableError(
            "No usable OS credential store is available, so the API key cannot "
            "be stored securely. Refusing to fall back to plaintext storage."
        )


def mask_api_key(key: str) -> str:
    """Render a key for display, revealing at most 3 leading and 4 trailing chars.

    ``"sk-1234567890ab12"`` becomes ``"sk-••••••••ab12"``.
    """
    if not key:
        return ""
    if len(key) <= 2:
        return _MASK
    if len(key) <= 8:
        return f"••••{key[-2:]}"
    return f"{key[:3]}{_MASK}{key[-4:]}"


def set_credential(credential_ref: str, api_key: str) -> None:
    """Store a secret under ``credential_ref``."""
    _require_store()
    keyring.set_password(KEYRING_SERVICE_NAME, credential_ref, api_key)


def get_credential(credential_ref: str) -> str:
    """Retrieve the secret for ``credential_ref``.

    Raises :class:`CredentialNotFoundError` if the reference has no secret —
    a profile pointing at a missing credential is a real inconsistency, not an
    empty key.
    """
    _require_store()
    secret = keyring.get_password(KEYRING_SERVICE_NAME, credential_ref)
    if secret is None:
        raise CredentialNotFoundError(
            f"No stored credential for reference {credential_ref!r}."
        )
    return secret


def delete_credential(credential_ref: str) -> bool:
    """Remove a secret. Returns whether one was there.

    Absence is not an error: deleting an already-deleted profile must succeed.
    """
    _require_store()
    try:
        keyring.delete_password(KEYRING_SERVICE_NAME, credential_ref)
        return True
    except Exception:  # noqa: BLE001 - keyring raises its own PasswordDeleteError
        return False
