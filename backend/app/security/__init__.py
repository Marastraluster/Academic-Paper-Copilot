"""Security primitives.

Currently: the credential store. API keys live in the operating system's
credential store — Windows Credential Manager via ``keyring`` — and never in the
database, a config file, an environment variable, or a log.

The upstream project this product builds on stores keys in plaintext JSON and
even writes environment-supplied keys to disk as a side effect
(`docs/REPO_AUDIT.md` §16). That finding is why this package exists.
"""

from app.security.credentials import (
    KEYRING_SERVICE_NAME,
    CredentialNotFoundError,
    CredentialStoreError,
    CredentialStoreUnavailableError,
    delete_credential,
    get_credential,
    is_credential_store_available,
    mask_api_key,
    new_credential_ref,
    set_credential,
)

__all__ = [
    "KEYRING_SERVICE_NAME",
    "CredentialStoreError",
    "CredentialNotFoundError",
    "CredentialStoreUnavailableError",
    "delete_credential",
    "get_credential",
    "is_credential_store_available",
    "mask_api_key",
    "new_credential_ref",
    "set_credential",
]
