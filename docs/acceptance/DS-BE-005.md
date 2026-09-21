# DS-BE-005 — Acceptance Criteria (FROZEN)

> **Author:** project maintainer
> **Authored:** 2026-09-16, **before any implementation code was written**
> **Prompt:** the task brief
> **Raw model output:** the task brief
> *(The generation exceeded the CLI's 5-minute print window and returned partial output; the
> document is nonetheless complete through FC-11, verified by inspection.)*
>
> **FROZEN.** No criterion may be silently weakened or deleted (brief §10).

## Acceptance criteria review (before implementation)

**Verdict: accepted as-is. No `AC_CHANGE_REQUEST`.** 29 criteria (22 P0, 5 P1, 2 P2),
28 specified tests, 11 failure conditions.

All six design questions were settled explicitly. The load-bearing answers:

- **Q1/Q2 — addressing.** Keyring service `AcademicPDFCopilot.profiles`, account = an opaque
  `cred_<uuid4hex>` reference stored in SQLite. Deliberately *not* the profile id and *not* the
  name, which makes rename a pure metadata update that never touches the credential store.
  That closes off two of the likeliest ways to orphan or sever a secret.
- **Q3 — unavailable store.** Typed `CredentialStoreUnavailableError`, with explicit
  prohibition of every silent fallback. This is the single most important rule in the task: a
  fallback that "works" is worse than a failure that is visible.
- **Q4 — empty vs absent.** `None` on update means *leave the key alone*; `""` means *clear it*.
  Distinguishing those two is what stops an edit from silently wiping a user's key.

### Corrections applied to the task file

The task file I wrote named `test_isolation.py` as the home of the "no product tables" guard.
The assertion actually lives in **`test_db.py`**, with a second copy in `test_isolation.py`;
the criteria require both. `conftest.py` is also required, for the mandatory fake-keyring
fixture. All three are now listed as allowed modifications, and the task file records the
correction rather than quietly widening scope.

### Implementation notes recorded at review time

1. **AC-06 asserts on WAL and SHM bytes too.** Not just the main database file — a secret that
   only reached a WAL page would still be a leak. The test reads all three.
2. **AC-04 pins exact expected table sets** (`["profiles", "schema_version"]`) rather than
   simply relaxing the old guard, so the anti-speculative-schema guarantee survives the change
   instead of being deleted.
3. **Migration is sequential, not "drop and recreate".** v1 databases keep their
   `schema_version` row and gain a second one; a database *newer* than the code refuses to
   start rather than corrupting itself.
4. `sanitize_message` from `app.llm.errors` is reused for exception scrubbing, keeping one
   redaction implementation rather than growing a second.

---

# Acceptance Criteria: DS-BE-005 — Provider Profile Store + Credential Storage

- **Task ID**: `DS-BE-005`
- **Role**: Independent Acceptance Criteria Agent
- **Status**: Defined prior to implementation (**FROZEN**)
- **Scope**: Provider profile persistence in SQLite ([`backend/app/storage/`](file:///D:/marti/SciPrograms/backend/app/storage)), secure API key storage in the OS credential store via `keyring` ([`backend/app/security/`](file:///D:/marti/SciPrograms/backend/app/security)), masked API key representation, database schema migration mechanism bumping version from `1` to `2` ([`backend/app/db.py`](file:///D:/marti/SciPrograms/backend/app/db.py)), zero secret leakage across database bytes, logs, representations, and errors, and offline isolated tests using a mandatory fake credential backend ([`backend/tests/test_credentials.py`](file:///D:/marti/SciPrograms/backend/tests/test_credentials.py), [`backend/tests/test_profiles.py`](file:///D:/marti/SciPrograms/backend/tests/test_profiles.py)).
- **Explicit Exclusions**: HTTP endpoints and FastAPI routes (deferred to a later API task), LLM adapters themselves (DS-BE-002/003, complete), PDF translation, Paper QA, Document Intelligence, frontend, and Tauri packaging.
- **Target Runtime**: Python 3.12.13 (`backend/.venv`) on Windows 11 (`keyring` 25.7.0 with `WinVaultKeyring`).
- **Priority Tags**:
  - `[P0]`: **MUST** — Blocks completion of this task.
  - `[P1]`: **SHOULD** — Strongly recommended; does not block completion if deferred with documented rationale.
  - `[P2]`: **OPTIONAL** — Architectural hooks or future-facing extension items.

---

## Design Decisions (Settling Q1 – Q6)

The following explicit, verifiable rules settle the design questions and ambiguities:

### Q1. Keyring Addressing & Renames
- **Service Name**: Keyring entries are stored under the fixed, namespaced service identifier:
  `KEYRING_SERVICE_NAME = "AcademicPDFCopilot.profiles"`
  *(Derived from `app.config.APP_NAME = "AcademicPDFCopilot"`).*
- **Account Name**: The keyring account name is the profile's **`credential_ref`** token string (e.g., `"cred_9b1deb4d3b7d4bad9bdd2b0d7b3dcb6d"`). It is NEVER the user-facing profile `name` and NEVER the database integer/primary `id`.
- **Rename Behavior**: Renaming a profile executes `UPDATE profiles SET name = :new_name, updated_at = :now WHERE id = :id`. The `credential_ref` column remains completely UNCHANGED. The keyring is NOT accessed, written to, or deleted during a rename. The credential remains valid and mapped without any migration or risk of orphaned secrets.

### Q2. The Reference Column
- **Format & Specification**: The `credential_ref` column in SQLite is `TEXT UNIQUE NULL`. When populated, it contains an opaque, generated token string matching the exact format:
  `"cred_" + uuid.uuid4().hex` (e.g. `"cred_c8a74e5f6d1b4a8e9f2a0b1c2d3e4f5a"`, 37 characters total).
- **Decoupling**: The reference string is completely opaque: it carries no profile name, model, endpoint, or database row ID. It is meaningless on its own and reveals zero secret or architectural metadata.
- **Nullability**: For keyless profiles (e.g., local endpoints requiring no key), `credential_ref` is `NULL`.

### Q3. Unavailable Keyring Detection & Typed Failure
- **Detection**: Availability of the OS credential store is probed using `keyring.get_keyring()`. A backend is classified as **unavailable** if:
  1. `backend is None`, OR
  2. `getattr(backend, "priority", 0) <= 0`, OR
  3. `isinstance(backend, (keyring.backends.fail.Keyring, keyring.backends.null.Keyring))` (or any backend from `keyring.backends.fail`).
- **Typed Error**: Any attempt to save, retrieve, or delete a credential when no usable backend is active MUST raise a typed exception:
  [`CredentialStoreUnavailableError`](file:///D:/marti/SciPrograms/backend/app/security/credentials.py) (subclass of [`CredentialStoreError`](file:///D:/marti/SciPrograms/backend/app/security/credentials.py)).
- **Zero Fallback**: Silent fallback to writing the plaintext key to SQLite, a `.env` or configuration file, an environment variable, a temporary file, or an insecure fallback store is **STRICTLY FORBIDDEN**.
- **Readiness Check**: The security module must expose `is_credential_store_available() -> bool` to allow callers (and future health endpoints) to detect store availability before attempting writes.

### Q4. Empty vs. Absent Key Representation
- **Keyless Profile**: Both "absent key" (`None`) and "empty key" (`""`) passed during profile creation designate a keyless provider configuration (DS-BE-002 AC-27).
- **Persistence State**:
  - In SQLite: `credential_ref` is stored as `NULL`.
  - In Keyring: No call to `keyring.set_password` is made (zero keyring overhead).
- **Public Profile Representation**:
  - `has_key: bool = False`
  - `api_key_masked: str = ""` (empty string)
- **Construction of `ProviderConfig`**:
  - When `credential_ref IS NULL`, the profile constructs [`ProviderConfig`](file:///D:/marti/SciPrograms/backend/app/llm/models.py#L90-L117) with `api_key=SecretStr("")`, directly triggering the existing LLM client layer substitution: `KEYLESS_API_KEY_PLACEHOLDER = "no-key-required"`.
- **Profile Update Semantics**:
  - `api_key is None` (omitted from update payload) $\rightarrow$ Retain existing key: `credential_ref` and keyring secret remain untouched.
  - `api_key == ""` (explicitly cleared) $\rightarrow$ Remove key: delete existing secret from keyring if `credential_ref` exists, and set `credential_ref = NULL` in SQLite.
  - `api_key == "<non-empty-string>"` $\rightarrow$ Store/update key: if `credential_ref` is `NULL`, generate a new `cred_<uuid4_hex>`; write secret to keyring with `keyring.set_password(KEYRING_SERVICE_NAME, credential_ref, key)`.

### Q5. Migration Mechanism & Schema Versioning
- **Target Schema Version**: `SCHEMA_VERSION` in [`backend/app/db.py`](file:///D:/marti/SciPrograms/backend/app/db.py#L23) is bumped from `1` to `2`.
- **Sequential Migration Execution**:
  - [`bootstrap_database(path)`](file:///D:/marti/SciPrograms/backend/app/db.py#L41-L74) inspects `schema_version`: `current_version = connection.execute("SELECT MAX(version) FROM schema_version").fetchone()[0]`.
  - When `current_version == 1`: runs migration step `002_create_profiles` within a database transaction:
    1. Executes `CREATE TABLE IF NOT EXISTS profiles (...)` with all specified non-secret columns and constraints.
    2. Records the bump: `INSERT INTO schema_version (version, applied_at) VALUES (2, _utc_now_iso())`.
    3. Commits transaction.
  - When `current_version == 2`: migration is a no-op (idempotent).
  - Existing database contents (in `schema_version` or future tables) are preserved without destruction.
- **Newer Version Guard**:
  - If `current_version > SCHEMA_VERSION` (i.e. database was created by a newer binary), `bootstrap_database` MUST raise [`DatabaseVersionError`](file:///D:/marti/SciPrograms/backend/app/db.py) with a message specifying the incompatibility (e.g. `f"Database schema version {current_version} is newer than supported version {SCHEMA_VERSION}. Please upgrade the application."`).

### Q6. Test Isolation & Fake Keyring Backend
- **Mandatory Isolation**: Automated tests MUST NEVER touch the developer's live OS credential store (`WinVaultKeyring` on Windows).
- **Autouse Pytest Fixture**: An autouse fixture installed in [`backend/tests/conftest.py`](file:///D:/marti/SciPrograms/backend/tests/conftest.py) enforces that every test runs with an in-memory `FakeKeyring` backend (subclassing `keyring.backend.KeyringBackend`) storing secrets strictly in a Python dictionary.
- **Fail-Closed Guard**: Any attempt by test code to invoke real `keyring.backends.Windows.WinVaultKeyring` or any non-isolated backend immediately fails the test with an `AssertionError`.

---

## 1. Priority P0 (MUST) — Core Functional, Security & Migration Criteria (Blocks Completion)

| ID | Priority | Description & Verification Target |
| :--- | :--- | :--- |
| **AC-01** | `[P0]` | **Schema Migration to Version 2 & Idempotency (Q5)**<br>[`backend/app/db.py`](file:///D:/marti/SciPrograms/backend/app/db.py) sets `SCHEMA_VERSION = 2`. Calling `bootstrap_database(db_path)` against a new or existing database applies migration `002`, creates the `profiles` table, and ensures `schema_version` contains `version = 2`. Repeated calls against the same database are idempotent, commit cleanly without error, and do not duplicate version rows. |
| **AC-02** | `[P0]` | **Forward Migration Data Preservation (Q5)**<br>Calling `bootstrap_database(db_path)` on an existing v1 database (which contains only `schema_version` with `version = 1`) elevates the database to `version = 2` without destroying the existing `schema_version` record for version 1. Both version 1 and version 2 rows exist in `schema_version`. |
| **AC-03** | `[P0]` | **Newer Schema Version Protection (Q5)**<br>If `bootstrap_database(db_path)` encounters a database where `MAX(version) > SCHEMA_VERSION` (e.g. `version = 3`), it refuses to run and raises [`DatabaseVersionError`](file:///D:/marti/SciPrograms/backend/app/db.py) with exit code / exception indicating the database is newer than the code. No tables or data are modified. |
| **AC-04** | `[P0]` | **Baseline Test Updates & Anti-Speculative Schema Verification**<br>The existing tests asserting database structure are updated strictly to accommodate the newly introduced table:<br>1. In [`backend/tests/test_db.py`](file:///D:/marti/SciPrograms/backend/tests/test_db.py#L53-L68) (`test_no_product_tables_exist`): asserts `list_tables(connection) == ["profiles", "schema_version"]`. `"profiles"` is removed from `forbidden`, while `"documents"`, `"pages"`, `"sections"`, `"paragraphs"`, `"glossary"`, `"translation_tasks"`, `"tasks"`, `"chat_sessions"`, `"chat_messages"`, and `"chunks_fts"` remain strictly forbidden.<br>2. In [`backend/tests/test_isolation.py`](file:///D:/marti/SciPrograms/backend/tests/test_isolation.py#L139-L150) (`test_test_database_contains_only_the_metadata_table`): asserts `sorted(names) == ["profiles", "schema_version"]`.<br>All 253 existing backend tests and 27 frontend tests continue to pass. |
| **AC-05** | `[P0]` | **`profiles` Table Schema & Zero Secret Columns (R1)**<br>The `profiles` table contains the following columns with exact SQLite types and constraints:<br>- `id TEXT PRIMARY KEY`<br>- `name TEXT NOT NULL UNIQUE COLLATE NOCASE`<br>- `base_url TEXT NOT NULL`<br>- `model TEXT NOT NULL`<br>- `protocol TEXT NOT NULL DEFAULT 'auto'`<br>- `temperature REAL`<br>- `max_output_tokens INTEGER`<br>- `timeout_s REAL NOT NULL DEFAULT 60.0`<br>- `custom_headers TEXT`<br>- `credential_ref TEXT UNIQUE`<br>- `created_at TEXT NOT NULL`<br>- `updated_at TEXT NOT NULL`<br>Schema inspection verifies that NO column has a name containing `key`, `secret`, `token`, `password`, or `auth` (except `credential_ref`), and no key material is stored in SQLite. |
| **AC-06** | `[P0]` | **Raw Database File Secret-Free Byte Assertion (R6)**<br>A dedicated automated test creates and updates a profile with a distinct, high-entropy test API key (e.g. `"sk-live-secret-never-touch-disk-xyz987654321"`). After committing and closing the connection, the test reads the raw byte content of the `.sqlite3` file, as well as any existing `-wal` and `-shm` companion files. The byte assertion `b"sk-live-secret-never-touch-disk-xyz987654321" not in db_bytes` MUST pass unconditionally. |
| **AC-07** | `[P0]` | **Keyring Storage Addressing & Namespacing (Q1, R2)**<br>When an API key is stored, it is written to the OS credential store via `keyring.set_password(service_name, username, password)` where:<br>- `service_name == "AcademicPDFCopilot.profiles"`<br>- `username == credential_ref`<br>- `password == <plaintext_api_key>`<br>Inspecting the keyring backend confirms the key is stored under this exact service and account. |
| **AC-08** | `[P0]` | **Credential Reference Generation & Opaque Decoupling (Q2)**<br>When a profile with an API key is created, a unique reference token is generated with format `"cred_" + uuid.uuid4().hex` (37 characters) and stored in `profiles.credential_ref`. The token reveals no profile name, user identity, endpoint, or model. |
| **AC-09** | `[P0]` | **Deterministic Masked Key Representation (R3)**<br>The credential subsystem exposes a deterministic masking function `mask_api_key(key: str) -> str` adhering to the following rules:<br>- If `not key`: returns `""`<br>- If `len(key) <= 8`: returns `"••••" + key[-2:]` (or `"••••••••"` if `len(key) <= 2`)<br>- If `len(key) > 8`: returns `key[:3] + "••••••••" + key[-4:]`<br>Example: `"sk-1234567890ab12"` $\rightarrow$ `"sk-••••••••ab12"`. No more than 3 leading and 4 trailing characters are ever revealed. |
| **AC-10** | `[P0]` | **Profile Read Operations Never Return Raw Secret (R3)**<br>All read queries and domain models returned by the profile store (e.g. `get_profile(id)`, `list_profiles()`, `get_profile_by_name(name)`) return a profile representation containing:<br>- `has_key: bool` (`True` if credential exists, `False` if keyless)<br>- `api_key_masked: str` (the masked key per AC-09, or `""` if keyless)<br>The raw API key is NEVER returned in the profile record. |
| **AC-11** | `[P0]` | **Keyless / Local Provider Profile Support (Q4)**<br>Creating a profile with `api_key=None` or `api_key=""` succeeds. In SQLite, `credential_ref` is set to `NULL`. No entry is written to `keyring`. Read operations report `has_key = False` and `api_key_masked = ""`. |
| **AC-12** | `[P0]` | **Update Profile Without Key Leaves Keyring Unchanged (R4)**<br>Calling `update_profile(id, data)` where `api_key` is omitted (i.e. `None`) updates modified metadata fields in SQLite (e.g. `model`, `base_url`, `temperature`, `updated_at`), but leaves `credential_ref` and the existing key in the credential store completely unchanged. |
| **AC-13** | `[P0]` | **Update Profile With New Key Updates Keyring**<br>Calling `update_profile(id, data, api_key="<new_key>")` writes the new secret to the credential store. If the profile was previously keyless (`credential_ref IS NULL`), a new `credential_ref` is generated, assigned, and persisted to SQLite. |
| **AC-14** | `[P0]` | **Update Profile With Empty Key Clears Stored Secret (Q4)**<br>Calling `update_profile(id, data, api_key="")` on a profile that previously held a key deletes the password from the credential store, sets `credential_ref = NULL` in SQLite, and updates `has_key` to `False`. |
| **AC-15** | `[P0]` | **Delete Profile Deletes Credential (Zero Orphaned Secrets) (R5)**<br>Calling `delete_profile(id)` deletes the SQLite row and deletes the corresponding password from the credential store via `keyring.delete_password("AcademicPDFCopilot.profiles", credential_ref)`. Inspecting the keyring after profile deletion confirms the credential is completely removed. Deleting a profile whose keyring entry was already removed succeeds gracefully without error. |
| **AC-16** | `[P0]` | **Profile Rename Preserves Credential Without Keyring Mutation (Q1)**<br>Renaming a profile (`update_profile(id, {"name": "NewName"})`) updates only the `name` and `updated_at` columns in SQLite. `credential_ref` remains identical. Keyring is NOT modified or accessed. Reading the credential via the renamed profile resolves the original API key. |
| **AC-17** | `[P0]` | **Duplicate Profile Name Rejection (R10)**<br>Attempting to create a profile or rename an existing profile to a `name` that already exists (evaluated case-insensitively, e.g. `"OpenAI"` vs `"openai"`) raises a typed [`ProfileNameExistsError`](file:///D:/marti/SciPrograms/backend/app/storage/profiles.py) (subclass of [`ProfileStoreError`](file:///D:/marti/SciPrograms/backend/app/storage/profiles.py)). The operation aborts cleanly without corrupting state or crashing the process. |
| **AC-18** | `[P0]` | **Non-Existent Profile Handling**<br>Attempting to retrieve, update, or delete a profile with an unknown `id` raises a typed [`ProfileNotFoundError`](file:///D:/marti/SciPrograms/backend/app/storage/profiles.py) (or returns `None` for optional get queries). |
| **AC-19** | `[P0]` | **Explicit Unavailable Keyring Failure & Zero Insecure Fallback (Q3, R9)**<br>When the active keyring backend is unavailable (e.g. `keyring.backends.fail.Keyring` or priority <= 0), attempting to store or retrieve a profile key raises [`CredentialStoreUnavailableError`](file:///D:/marti/SciPrograms/backend/app/security/credentials.py). The system NEVER falls back to storing the key in SQLite, a plaintext file, an environment variable, or any unencrypted medium. |
| **AC-20** | `[P0]` | **Zero Secret Leakage in Logs, Exceptions, and Object Representations (R7)**<br>- `str()` and `repr()` of profile models, credential objects, and error instances NEVER contain the plaintext API key.<br>- All exception messages are scrubbed with `sanitize_message(msg, api_key)` and `redact_text()`.<br>- Structured logging emitted during profile creation, update, retrieval, or deletion contains `[REDACTED]` for any secret field. |
| **AC-21** | `[P0]` | **`ProviderConfig` Factory Method**<br>The profile store provides a method `to_provider_config(profile_id: str) -> ProviderConfig` (or `profile_store.get_provider_config(id)`):<br>- Resolves the profile's non-secret attributes (`base_url`, `model`, `timeout_s`, `temperature`, `max_output_tokens`, `custom_headers`).<br>- Fetches the secret from the credential store (or uses `""` if `credential_ref IS NULL`).<br>- Returns a frozen [`ProviderConfig`](file:///D:/marti/SciPrograms/backend/app/llm/models.py#L90-L117) with `api_key: SecretStr`.<br>- Raises [`CredentialNotFoundError`](file:///D:/marti/SciPrograms/backend/app/security/credentials.py) if `credential_ref` is non-null but missing from the keyring. |
| **AC-22** | `[P0]` | **Mandatory Offline Test Isolation via Fake Keyring Backend (Q6, R11)**<br>All tests in [`backend/tests/test_credentials.py`](file:///D:/marti/SciPrograms/backend/tests/test_credentials.py) and [`backend/tests/test_profiles.py`](file:///D:/marti/SciPrograms/backend/tests/test_profiles.py) execute under an autouse fixture installing a `FakeKeyring` in-memory backend. No test writes to, reads from, or deletes entries in the real Windows Credential Manager or any live OS store. |

---

## 2. Priority P1 (SHOULD) — Robustness & Operational Quality (Non-Blocking)

| ID | Priority | Description & Verification Target |
| :--- | :--- | :--- |
| **AC-23** | `[P1]` | **Credential Store Readiness Probe (Q3)**<br>[`backend/app/security/credentials.py`](file:///D:/marti/SciPrograms/backend/app/security/credentials.py) exposes `is_credential_store_available() -> bool`. Returns `True` when a functional keyring backend is configured and active; returns `False` without raising an exception when keyring is non-functional, headless, or null. |
| **AC-24** | `[P1]` | **Custom Headers JSON Serialization & Deserialization**<br>When [`custom_headers`](file:///D:/marti/SciPrograms/backend/app/llm/models.py#L107) (`dict[str, str]`) is supplied, it is serialized to a JSON string before inserting into SQLite. Reading the profile deserializes the JSON back into a typed dictionary `dict[str, str]`. If `custom_headers` is `None` or omitted, it is stored as `NULL` and returned as `None`. |
| **AC-25** | `[P1]` | **Protocol Value Validation**<br>Profile creation and updates validate that `protocol` is one of `'auto'`, `'chat_completions'`, or `'responses'`. Supplying an unrecognized protocol string raises a typed [`ProfileValidationError`](file:///D:/marti/SciPrograms/backend/app/storage/profiles.py) (subclass of [`ProfileStoreError`](file:///D:/marti/SciPrograms/backend/app/storage/profiles.py)). |
| **AC-26** | `[P1]` | **Database WAL & Concurrency Pragmas Adherence**<br>All profile operations execute through connections created via [`app.db.connect`](file:///D:/marti/SciPrograms/backend/app/db.py#L32-L38) with `PRAGMA busy_timeout=5000`, `PRAGMA foreign_keys=ON`, and `PRAGMA journal_mode=WAL`. Profile writes do not block concurrent readers. |
| **AC-27** | `[P1]` | **Timestamp Auditing (UTC ISO 8601)**<br>`created_at` and `updated_at` are stored as UTC ISO 8601 strings (`datetime.now(tz=timezone.utc).isoformat()`). Updates modify `updated_at` while preserving `created_at`. |

---

## 3. Priority P2 (OPTIONAL) — Future Extensions & Hooks (Non-Blocking)

| ID | Priority | Description & Verification Target |
| :--- | :--- | :--- |
| **AC-28** | `[P2]` | **Sanitized Profile Export / Import Helper**<br>A helper method `export_profile(id)` produces a dictionary with all profile parameters but with `credential_ref` stripped and `api_key_masked` included. Importing a profile dictionary requires supplying the key explicitly and generates a fresh `credential_ref`. |
| **AC-29** | `[P2]` | **Default Profile Indicator**<br>A column or helper function identifying an active or default profile (e.g. `is_default INTEGER NOT NULL DEFAULT 0`) with a constraint ensuring at most one default profile exists. |

---

## 4. Expected Automated Tests

The test suite in [`backend/tests/test_credentials.py`](file:///D:/marti/SciPrograms/backend/tests/test_credentials.py) and [`backend/tests/test_profiles.py`](file:///D:/marti/SciPrograms/backend/tests/test_profiles.py) must be runnable via `pytest` and include at minimum the following automated test cases:

| ID | Test Name | Purpose / Assertions | Priority |
| :--- | :--- | :--- | :--- |
| **AC-30.01** | `test_migration_002_creates_profiles_table` | Asserts `bootstrap_database` creates `profiles` and bumps `schema_version` to 2. | `[P0]` |
| **AC-30.02** | `test_migration_002_preserves_existing_v1_data` | Bootstraps v1, sets data, migrates to v2; asserts v1 records and data preserved. | `[P0]` |
| **AC-30.03** | `test_migration_is_idempotent` | Runs `bootstrap_database` twice on v2 database; asserts no error and schema unchanged. | `[P0]` |
| **AC-30.04** | `test_newer_database_version_raises_typed_error` | Inserts version 99 into `schema_version`; asserts `bootstrap_database` raises `DatabaseVersionError`. | `[P0]` |
| **AC-30.05** | `test_no_product_tables_guard_updated` | Verifies `test_no_product_tables_exist` and isolation test allow only `["profiles", "schema_version"]`. | `[P0]` |
| **AC-30.06** | `test_profiles_schema_has_no_secret_columns` | Inspects `PRAGMA table_info(profiles)`; asserts no column names contain secret markers. | `[P0]` |
| **AC-30.07** | `test_create_profile_with_key_stores_in_keyring` | Creates profile with key; asserts key stored in fake keyring under `AcademicPDFCopilot.profiles`. | `[P0]` |
| **AC-30.08** | `test_create_profile_reference_format` | Asserts `credential_ref` matches `^cred_[0-9a-f]{32}$`. | `[P0]` |
| **AC-30.09** | `test_raw_database_file_contains_no_key_bytes` | Reads raw `.sqlite3`, `-wal`, and `-shm` bytes; asserts test secret string is completely absent. | `[P0]` |
| **AC-30.10** | `test_mask_api_key_formatting` | Parametrized test checking `mask_api_key` for short keys, standard keys (`sk-...`), and empty strings. | `[P0]` |
| **AC-30.11** | `test_read_profile_never_returns_plaintext_key` | Reads profile; asserts record contains `api_key_masked` and `has_key=True`, but no plaintext key. | `[P0]` |
| **AC-30.12** | `test_create_keyless_profile` | Creates profile with `api_key=""` or `None`; asserts `credential_ref IS NULL`, keyring untouched. | `[P0]` |
| **AC-30.13** | `test_update_profile_without_key_leaves_credential_intact` | Updates profile base_url without passing key; asserts credential in keyring remains unchanged. | `[P0]` |
| **AC-30.14** | `test_update_profile_with_new_key_updates_keyring` | Updates profile with new key; asserts keyring updated with new secret under existing/new reference. | `[P0]` |
| **AC-30.15** | `test_update_profile_with_empty_key_clears_credential` | Updates profile with `api_key=""`; asserts secret deleted from keyring and `credential_ref IS NULL`. | `[P0]` |
| **AC-30.16** | `test_delete_profile_removes_keyring_credential` | Deletes profile; asserts row removed from SQLite and credential removed from keyring. | `[P0]` |
| **AC-30.17** | `test_rename_profile_retains_credential` | Renames profile; asserts `credential_ref` unchanged, keyring untouched, and key still resolvable. | `[P0]` |
| **AC-30.18** | `test_duplicate_profile_name_raises_typed_error` | Creates two profiles with same name (and varying case); asserts `ProfileNameExistsError`. | `[P0]` |
| **AC-30.19** | `test_get_or_update_non_existent_profile_raises_not_found` | Asserts updating or deleting non-existent ID raises `ProfileNotFoundError`. | `[P0]` |
| **AC-30.20** | `test_unavailable_keyring_raises_typed_error` | Configures `fail.Keyring`; asserts write raises `CredentialStoreUnavailableError` without fallback. | `[P0]` |
| **AC-30.21** | `test_secret_redacted_in_repr_and_exceptions` | Asserts `repr(profile)`, `str(profile)`, and raised exception strings contain no secret key. | `[P0]` |
| **AC-30.22** | `test_to_provider_config_success` | Calls `to_provider_config(id)`; asserts valid `ProviderConfig` returned with real key in `SecretStr`. | `[P0]` |
| **AC-30.23** | `test_to_provider_config_keyless` | Calls `to_provider_config` on keyless profile; asserts `api_key.get_secret_value() == ""`. | `[P0]` |
| **AC-30.24** | `test_test_isolation_fixture_blocks_real_keyring` | Asserts active keyring in test session is `FakeKeyring` and NOT `WinVaultKeyring`. | `[P0]` |
| **AC-30.25** | `test_credential_store_availability_probe` | Verifies `is_credential_store_available()` returns True with fake keyring, False with fail keyring. | `[P1]` |
| **AC-30.26** | `test_custom_headers_json_roundtrip` | Creates profile with custom headers dict; asserts persisted and retrieved correctly. | `[P1]` |
| **AC-30.27** | `test_protocol_validation_rejects_invalid_protocol` | Attempts to set protocol to `"invalid_proto"`; asserts `ProfileValidationError`. | `[P1]` |
| **AC-30.28** | `test_timestamp_auditing_on_update` | Asserts `created_at` stays fixed while `updated_at` increases upon update. | `[P1]` |

---

## 5. Explicit Failure Conditions

The implementation **FAILS** if any of the following conditions occur:

- **FC-01 (Scope Creep)**: The implementation creates HTTP endpoints or FastAPI route handlers, modifies LLM provider adapters, or touches PDF processing, Paper QA, frontend, or Tauri code.
- **FC-02 (Secret in SQLite)**: The plaintext API key appears anywhere in the `profiles` table, in any SQLite column, or in the raw binary contents of the SQLite database file (`.sqlite3`, `-wal`, `-shm`).
- **FC-03 (Secret Leakage in Outputs)**: The plaintext API key is exposed in `str()`, `repr()`, logs, console outputs, or error/exception messages.
- **FC-04 (Silent Insecure Fallback)**: When the OS credential store is unavailable, the implementation silently writes credentials to a plaintext file, database, environment variable, or insecure cache instead of raising `CredentialStoreUnavailableError`.
- **FC-05 (Orphaned Credentials on Delete)**: Deleting a profile from SQLite leaves its secret key behind in the OS credential store.
- **FC-06 (Credential Loss on Rename)**: Renaming a profile severs its connection to its credential or fails to resolve the stored API key.
- **FC-07 (Unkeyed / Unstable Keyring Addressing)**: The keyring account name uses the profile's mutable user-facing name instead of the immutable `credential_ref`.
- **FC-08 (Destructive or Non-Idempotent Migration)**: Bumping the database schema destroys existing `schema_version` data, fails when run repeatedly, or fails to raise `DatabaseVersionError` when a database is newer than the code.
- **FC-09 (Speculative Schema Creep)**: The migration creates tables other than `profiles` (e.g. creating `documents`, `tasks`, `glossary`), violating the anti-speculative schema guarantee.
- **FC-10 (Real Credential Store Contamination)**: A test executes against the real Windows Credential Manager (`WinVaultKeyring`) instead of the mandatory in-memory `FakeKeyring`.
- **FC-11 (Regression)**: Any of the 253 existing backend tests (outside the explicitly allowed schema guard updates) or 27 frontend tests fail.
