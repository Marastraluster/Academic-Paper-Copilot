"""Provider profile persistence.

A profile is everything needed to reach an endpoint *except* the credential: the
name, URL, model, protocol and generation settings. The secret itself lives in
the OS credential store, addressed by an opaque ``credential_ref``.

Reads return a :class:`Profile` carrying ``has_key`` and a **masked** key. The
plaintext is reachable only through :meth:`ProfileStore.to_provider_config`,
which exists solely to build a client.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from app.llm.errors import sanitize_message
from app.llm.models import ProviderConfig
from app.security.credentials import (
    delete_credential,
    get_credential,
    mask_api_key,
    new_credential_ref,
    set_credential,
)

VALID_PROTOCOLS = ("auto", "chat_completions", "responses")

DEFAULT_PROTOCOL = "auto"
DEFAULT_TIMEOUT_S = 60.0

#: What a profile configures. A chat model was the only kind until document
#: parsing and literature search arrived; both are an endpoint plus an optional
#: key, so they live in the same table and the same credential store.
KIND_LLM = "llm"
KIND_PARSER = "parser"
KIND_SEARCH = "search"
VALID_KINDS = (KIND_LLM, KIND_PARSER, KIND_SEARCH)

#: The protocols each kind understands. MinerU 4 serves one "v1" API whether it
#: runs on this machine, on a lab server or as mineru.net, so the deployment is
#: the URL, not the protocol.
PROTOCOLS_BY_KIND: dict[str, tuple[str, ...]] = {
    KIND_LLM: VALID_PROTOCOLS,
    KIND_PARSER: ("mineru_v1",),
    KIND_SEARCH: ("semantic_scholar", "openalex", "llm_web"),
}
DEFAULT_PROTOCOL_BY_KIND = {
    KIND_LLM: DEFAULT_PROTOCOL,
    KIND_PARSER: "mineru_v1",
    KIND_SEARCH: "openalex",
}

#: For a parser profile `model` holds MinerU's `tier`. Empty lets the server
#: decide — its default is `standard`, which needs a VLM; a CPU-only machine
#: wants `flash` or `basic`.
MINERU_TIERS = ("", "flash", "basic", "standard", "advanced")

#: For an ``llm_web`` search profile `model` holds the id of the chat profile
#: whose endpoint and key it borrows; `base_url` is display-only.

PROFILE_ID_PREFIX = "prof_"


class ProfileStoreError(Exception):
    """Base class for profile-store failures."""


class ProfileNotFoundError(ProfileStoreError):
    """No profile exists with the given id."""


class ProfileNameExistsError(ProfileStoreError):
    """A profile with that name already exists (compared case-insensitively)."""


class ProfileValidationError(ProfileStoreError):
    """A supplied field value is not acceptable."""


@dataclass(frozen=True)
class Profile:
    """A profile as seen by callers.

    Note the absence of any plaintext key: ``api_key_masked`` is display-only and
    ``has_key`` reports whether a credential exists without revealing it.
    """

    id: str
    name: str
    base_url: str
    model: str
    protocol: str
    temperature: float | None
    max_output_tokens: int | None
    timeout_s: float
    custom_headers: dict[str, str] | None
    credential_ref: str | None
    created_at: str
    updated_at: str
    has_key: bool
    api_key_masked: str
    kind: str = KIND_LLM


@dataclass(frozen=True)
class ServiceConfig:
    """Everything a non-LLM client needs, key included.

    The counterpart of `ProviderConfig` for parsing and search profiles, built by
    `ProfileStore.to_service_config` — the only other path by which a plaintext
    key leaves this package.
    """

    kind: str
    protocol: str
    base_url: str
    model: str
    api_key: str
    timeout_s: float
    custom_headers: dict[str, str] | None


def _utc_now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def _new_profile_id() -> str:
    return f"{PROFILE_ID_PREFIX}{uuid.uuid4().hex}"


def _encode_headers(headers: dict[str, str] | None) -> str | None:
    return json.dumps(headers) if headers else None


def _decode_headers(raw: str | None) -> dict[str, str] | None:
    if not raw:
        return None
    try:
        decoded = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return decoded if isinstance(decoded, dict) else None


class ProfileStore:
    """CRUD over provider profiles, backed by a bootstrapped SQLite connection."""

    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    # -- internal -----------------------------------------------------------

    def _row_to_profile(self, row: sqlite3.Row) -> Profile:
        credential_ref = row["credential_ref"]
        has_key = credential_ref is not None
        masked = ""
        if has_key:
            try:
                masked = mask_api_key(get_credential(credential_ref))
            except Exception:  # noqa: BLE001
                # The reference exists but the secret does not. Report the
                # inconsistency as "no key shown" rather than failing a read.
                masked = ""

        return Profile(
            id=row["id"],
            name=row["name"],
            base_url=row["base_url"],
            model=row["model"],
            protocol=row["protocol"],
            temperature=row["temperature"],
            max_output_tokens=row["max_output_tokens"],
            timeout_s=row["timeout_s"],
            custom_headers=_decode_headers(row["custom_headers"]),
            credential_ref=credential_ref,
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            has_key=has_key,
            api_key_masked=masked,
            kind=row["kind"] if "kind" in row.keys() else KIND_LLM,
        )

    def _fetch_row(self, profile_id: str) -> sqlite3.Row:
        row = self._connection.execute(
            "SELECT * FROM profiles WHERE id = ?", (profile_id,)
        ).fetchone()
        if row is None:
            raise ProfileNotFoundError(f"No profile with id {profile_id!r}.")
        return row

    @staticmethod
    def _validate_kind(kind: str) -> str:
        normalized = (kind or "").strip().lower()
        if normalized not in VALID_KINDS:
            raise ProfileValidationError(
                f"Unsupported kind {kind!r}; expected one of {VALID_KINDS}."
            )
        return normalized

    @staticmethod
    def _validate_protocol(protocol: str, kind: str = KIND_LLM) -> str:
        allowed = PROTOCOLS_BY_KIND[kind]
        normalized = (protocol or "").strip().lower()
        if normalized not in allowed:
            raise ProfileValidationError(
                f"Unsupported protocol {protocol!r}; expected one of {allowed}."
            )
        return normalized

    @staticmethod
    def _validate_model(model: str, kind: str) -> str:
        value = (model or "").strip()
        if kind == KIND_LLM and not value:
            raise ProfileValidationError("Model must not be blank.")
        if kind == KIND_PARSER and value.lower() not in MINERU_TIERS:
            raise ProfileValidationError(
                f"Unsupported MinerU tier {model!r}; expected one of {MINERU_TIERS[1:]} or empty."
            )
        return value.lower() if kind == KIND_PARSER else value

    def _assert_name_available(self, name: str, *, excluding_id: str | None = None) -> None:
        row = self._connection.execute(
            "SELECT id FROM profiles WHERE name = ? COLLATE NOCASE", (name,)
        ).fetchone()
        if row is not None and row["id"] != excluding_id:
            raise ProfileNameExistsError(f"A profile named {name!r} already exists.")

    # -- CRUD ---------------------------------------------------------------

    def create_profile(
        self,
        *,
        name: str,
        base_url: str,
        model: str = "",
        protocol: str | None = None,
        kind: str = KIND_LLM,
        temperature: float | None = None,
        max_output_tokens: int | None = None,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        custom_headers: dict[str, str] | None = None,
        api_key: str | None = None,
    ) -> Profile:
        """Create a profile.

        ``api_key=None`` and ``api_key=""`` both mean *keyless* — a legitimate
        configuration for a local server — and write nothing to the credential
        store.
        """
        if not (name or "").strip():
            raise ProfileValidationError("Profile name must not be blank.")
        if not (base_url or "").strip():
            raise ProfileValidationError("Base URL must not be blank.")
        resolved_kind = self._validate_kind(kind)
        model = self._validate_model(model, resolved_kind)

        self._assert_name_available(name)
        resolved_protocol = self._validate_protocol(
            protocol if protocol is not None else DEFAULT_PROTOCOL_BY_KIND[resolved_kind],
            resolved_kind,
        )

        credential_ref: str | None = None
        if api_key:
            credential_ref = new_credential_ref()
            set_credential(credential_ref, api_key)

        profile_id = _new_profile_id()
        now = _utc_now_iso()
        try:
            self._connection.execute(
                """
                INSERT INTO profiles (
                    id, name, base_url, model, protocol, temperature,
                    max_output_tokens, timeout_s, custom_headers, credential_ref,
                    created_at, updated_at, kind
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    profile_id, name, base_url, model, resolved_protocol, temperature,
                    max_output_tokens, timeout_s, _encode_headers(custom_headers),
                    credential_ref, now, now, resolved_kind,
                ),
            )
            self._connection.commit()
        except sqlite3.IntegrityError as exc:
            # Backstop for a race between the check above and the insert.
            if credential_ref is not None:
                delete_credential(credential_ref)
            raise ProfileNameExistsError(f"A profile named {name!r} already exists.") from exc

        return self.get_profile(profile_id)

    def get_profile(self, profile_id: str) -> Profile:
        return self._row_to_profile(self._fetch_row(profile_id))

    def get_profile_by_name(self, name: str) -> Profile:
        row = self._connection.execute(
            "SELECT * FROM profiles WHERE name = ? COLLATE NOCASE", (name,)
        ).fetchone()
        if row is None:
            raise ProfileNotFoundError(f"No profile named {name!r}.")
        return self._row_to_profile(row)

    def list_profiles(self, kind: str | None = None) -> list[Profile]:
        if kind is None:
            rows = self._connection.execute(
                "SELECT * FROM profiles ORDER BY name COLLATE NOCASE"
            ).fetchall()
        else:
            rows = self._connection.execute(
                "SELECT * FROM profiles WHERE kind = ? ORDER BY name COLLATE NOCASE",
                (self._validate_kind(kind),),
            ).fetchall()
        return [self._row_to_profile(row) for row in rows]

    def update_profile(
        self,
        profile_id: str,
        *,
        api_key: str | None = None,
        **fields: object,
    ) -> Profile:
        """Update a profile.

        ``api_key`` semantics are deliberately three-way:

        * omitted or ``None`` — leave the stored credential untouched;
        * ``""`` — clear it;
        * any other value — store it.

        Collapsing "omitted" and "empty" would mean an unrelated edit silently
        destroyed the user's key.
        """
        row = self._fetch_row(profile_id)
        credential_ref = row["credential_ref"]

        updates: dict[str, object] = {}

        for field in (
            "name", "base_url", "model", "protocol",
            "temperature", "max_output_tokens", "timeout_s",
        ):
            if field in fields:
                updates[field] = fields[field]

        # A profile's kind is fixed at creation: a parser endpoint does not become
        # a chat model by editing it, and every validation below depends on it.
        kind = row["kind"] if "kind" in row.keys() else KIND_LLM
        if "protocol" in updates:
            updates["protocol"] = self._validate_protocol(str(updates["protocol"]), kind)
        if "model" in updates:
            updates["model"] = self._validate_model(str(updates["model"] or ""), kind)

        if "custom_headers" in fields:
            headers = fields["custom_headers"]
            updates["custom_headers"] = _encode_headers(headers if isinstance(headers, dict) else None)

        if "name" in updates:
            self._assert_name_available(str(updates["name"]), excluding_id=profile_id)

        if api_key == "":
            # Explicitly cleared.
            if credential_ref is not None:
                delete_credential(credential_ref)
            credential_ref = None
            updates["credential_ref"] = None
        elif api_key:
            if credential_ref is None:
                credential_ref = new_credential_ref()
                updates["credential_ref"] = credential_ref
            set_credential(credential_ref, api_key)

        updates["updated_at"] = _utc_now_iso()

        assignments = ", ".join(f"{column} = ?" for column in updates)
        try:
            self._connection.execute(
                f"UPDATE profiles SET {assignments} WHERE id = ?",  # noqa: S608 - column names are from a closed set
                (*updates.values(), profile_id),
            )
            self._connection.commit()
        except sqlite3.IntegrityError as exc:
            raise ProfileNameExistsError(
                f"A profile named {updates.get('name')!r} already exists."
            ) from exc

        return self.get_profile(profile_id)

    def delete_profile(self, profile_id: str) -> None:
        """Delete a profile and its credential — no orphaned secrets."""
        row = self._fetch_row(profile_id)
        credential_ref = row["credential_ref"]

        self._connection.execute("DELETE FROM profiles WHERE id = ?", (profile_id,))
        self._connection.commit()

        if credential_ref is not None:
            # Tolerates an already-absent secret.
            delete_credential(credential_ref)

    # -- provider configuration --------------------------------------------

    def to_provider_config(self, profile_id: str) -> ProviderConfig:
        """Build the frozen config the LLM layer consumes.

        The only path by which a plaintext key leaves this package.
        """
        profile = self.get_profile(profile_id)

        api_key = ""
        if profile.credential_ref is not None:
            try:
                api_key = get_credential(profile.credential_ref)
            except Exception as exc:  # noqa: BLE001
                raise ProfileStoreError(
                    sanitize_message(
                        f"Profile {profile.name!r} references credential "
                        f"{profile.credential_ref!r}, which could not be read: {exc}"
                    )
                ) from exc

        return ProviderConfig(
            base_url=profile.base_url,
            api_key=api_key,
            model=profile.model,
            timeout_s=profile.timeout_s,
            temperature=profile.temperature,
            max_output_tokens=profile.max_output_tokens,
            custom_headers=profile.custom_headers,
        )

    def to_service_config(self, profile_id: str, *, kind: str | None = None) -> ServiceConfig:
        """Build the config a parsing or search client consumes, key included.

        ``kind`` asserts what the caller expects, so a chat profile handed to the
        parser by mistake fails here with a clear message rather than as an HTTP
        error from the wrong kind of server.
        """
        profile = self.get_profile(profile_id)
        if kind is not None and profile.kind != kind:
            raise ProfileValidationError(
                f"Profile {profile.name!r} is a {profile.kind!r} profile, not {kind!r}."
            )
        api_key = ""
        if profile.credential_ref is not None:
            try:
                api_key = get_credential(profile.credential_ref)
            except Exception as exc:  # noqa: BLE001
                raise ProfileStoreError(
                    sanitize_message(
                        f"Profile {profile.name!r} references a credential that could not be read: {exc}"
                    )
                ) from exc
        return ServiceConfig(
            kind=profile.kind,
            protocol=profile.protocol,
            base_url=profile.base_url,
            model=profile.model,
            api_key=api_key,
            timeout_s=profile.timeout_s,
            custom_headers=profile.custom_headers,
        )
