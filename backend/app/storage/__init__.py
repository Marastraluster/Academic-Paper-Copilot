"""Persistence.

Currently: provider profiles. Secrets are *not* persisted here — they live in the
OS credential store (:mod:`app.security`), and this package keeps only an opaque
reference.
"""

from app.storage.profiles import (
    Profile,
    ProfileNameExistsError,
    ProfileNotFoundError,
    ProfileStore,
    ProfileStoreError,
    ProfileValidationError,
)

__all__ = [
    "Profile",
    "ProfileStore",
    "ProfileStoreError",
    "ProfileNotFoundError",
    "ProfileNameExistsError",
    "ProfileValidationError",
]
