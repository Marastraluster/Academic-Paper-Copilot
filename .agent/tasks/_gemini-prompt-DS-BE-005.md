You are the independent Acceptance Criteria Agent for task DS-BE-005.

You are NOT implementing this task. You are NOT writing production code.

Define objective, testable acceptance criteria BEFORE implementation begins.

Scope:
- provider profile persistence (SQLite)
- API key storage in the OS credential store via `keyring`
- masked key representation
- schema migration for the first product table
- no secret leakage anywhere
- tests using a fake credential backend

Explicitly exclude:
- HTTP endpoints / API routes (later task)
- the LLM adapters themselves (DS-BE-002/003, complete)
- PDF translation, Paper QA, Document Intelligence, frontend, Tauri

Return criteria grouped as P0 MUST / P1 SHOULD / P2 OPTIONAL, numbered AC-01, AC-02, ...
Tag every criterion. Only P0 blocks completion.

=====================================================================
TASK_DESCRIPTION
=====================================================================

# DS-BE-005 — Provider Profile Store + Credential Storage

## Goal
Persist provider profiles, and store their API keys where they belong — the OPERATING SYSTEM's
credential store, not in the database, not in a config file, not in a log.
This is the task that makes the product's "user owns their endpoint, key and model" principle
real, and the one where a mistake is unrecoverable: a leaked key cannot be un-leaked.

## Product Context
Users create, edit and switch between provider profiles (OpenAI, DeepSeek, OpenRouter, a local
server…). Each has a name, endpoint, model, protocol, and its own credential. The settings
screen lists them and must be able to show THAT a key is set without ever showing the key.

The upstream project this product is built on stores keys in PLAINTEXT JSON and even writes
environment-supplied keys to disk as a side effect (docs/REPO_AUDIT.md §16). That finding is the
direct reason this task exists.

## Technical Context
  Backend      FastAPI + SQLite; app/db.py bootstraps a `schema_version` table ONLY
  LLM layer    Two adapters behind LLMProvider, plus detection
  Credentials  keyring 25.7.0 installed; WinVaultKeyring VERIFIED ACTIVE on this machine
  Logging      app/logging.py redacts sensitive keys and scrubs Bearer/key=value text

The database currently has NO product tables — DS-BE-001 deliberately created none, and an
existing test asserts ['schema_version'] is all that exists. This task adds the first real
table and therefore the first real migration.

## Requirements
R1.  A `profiles` table holding everything EXCEPT secret material: name, base_url, model,
     protocol, temperature, max_output_tokens, timeout_s, custom_headers, and a credential
     REFERENCE. No column may ever hold a key.
R2.  Credentials live in the OS credential store via keyring. The database holds only an
     alias/reference that is meaningless on its own.
R3.  Reading a profile never returns the key. The only representation available to any caller
     above this layer is a MASKED form (e.g. sk-••••••••ab12).
R4.  Updating a profile without supplying a key leaves the stored key unchanged.
R5.  Deleting a profile deletes its credential from the keyring — no orphaned secrets.
R6.  The database file must contain no key material. This must be assertable by reading the
     file's bytes and finding no key.
R7.  No key in any log line, error message, repr, or exception produced by this code.
R8.  A migration adds the table to an existing database without destroying it, and is
     idempotent (matching app/db.py's existing bootstrap contract).
R9.  When the OS credential store is unavailable, the failure is explicit and typed — never a
     silent fallback to writing the key somewhere insecure.
R10. Profile names are unique; attempting a duplicate is a typed, non-crashing error.
R11. Tests never touch the real OS credential store or the real user database.

## Known Risks
- Leaking a key into the database, a log, or an error message. R6/R7 exist because this is the
  one failure that cannot be undone.
- Orphaned credentials after a delete or rename.
- Silent fallback to insecure storage when keyring is unavailable — the worst outcome, because
  it looks like success.
- Breaking the existing "no product tables" guarantee without updating the DS-BE-001 test.

=====================================================================
DESIGN QUESTIONS THE CRITERIA MUST SETTLE
=====================================================================

Give an explicit, verifiable rule for each:

Q1. KEYRING ADDRESSING. What service name and account name? Is the account the profile's
    database id, its name, or a generated opaque reference? Name is user-editable, which makes
    rename a migration; id is stable. State the rule AND what happens on rename.

Q2. THE REFERENCE COLUMN. What exactly is stored — the profile id, a UUID, a namespaced string?
    Must survive a profile rename without orphaning the credential.

Q3. UNAVAILABLE KEYRING. What is the exact behaviour and error type when keyring has no usable
    backend (headless CI, a machine with no credential store)? R9 requires it be explicit; state
    HOW. Should this be detectable before attempting a write?

Q4. EMPTY vs ABSENT KEY. A local keyless server is a supported configuration (DS-BE-002 AC-27,
    which permits an empty API key and substitutes a placeholder at client construction). Is
    "no key" distinct from "empty key", and how is each represented and reported?

Q5. MIGRATION MECHANISM. db.py currently just creates schema_version. How are numbered migrations
    applied, and what does bumping to version 2 do to an existing database? What happens if the
    stored version is NEWER than the code understands?

Q6. TEST ISOLATION. How do tests avoid the real credential store? A fake keyring backend is the
    obvious answer; make it mandatory rather than optional, and state how the real backend is
    prevented from being reached.

=====================================================================
PRODUCT_ARCHITECTURE
=====================================================================

  Settings UI (frontend, later)  ->  HTTP API (later)  ->  THIS TASK (service + storage)
        ↓
  ProviderProfile (name, base_url, model, protocol, ...)   [non-secret -> SQLite]
  Credential reference                                      [SQLite]
        ↓
  keyring  ->  Windows Credential Manager (WinVaultKeyring)  [the key itself]

Existing backend conventions that must be followed:
- Structured JSON logging; fields named api_key/authorization/token/secret/password are redacted
  to "[REDACTED]"; free text is scrubbed for "Bearer <token>" and "key=value".
- The key literal is ALSO stripped from error messages explicitly, because redact_text only
  recognises those two shapes (established in DS-BE-002, errors.sanitize_message).
- Importing app modules must have no side effects — no database file created, nothing logged.
- The test suite runs entirely offline under an autouse socket guard.
- db.py opens SQLite with journal_mode=WAL, foreign_keys=ON, busy_timeout=5000, and creates
  missing parent directories. A `schema_version(version INTEGER PRIMARY KEY, applied_at TEXT)`
  table records the current version; the current value is 1.

=====================================================================
RELEVANT_EXISTING_BEHAVIOR
=====================================================================

- backend has 253 passing tests. frontend has 27. All must still pass.
- An existing test asserts the database contains ONLY ['schema_version']. That test MUST be
  updated by this task (it is listed as an allowed modification) — state what it should assert
  afterwards so the "no speculative schema" guarantee is preserved rather than dropped.
- app/llm/models.py defines ProviderConfig (frozen pydantic): base_url, api_key (SecretStr),
  model, timeout_s, temperature, max_output_tokens, custom_headers. It has no protocol field
  as of DS-BE-003; DS-BE-004 may add one. The profile record must be able to produce a
  ProviderConfig.
- keyring is installed and verified working. `keyring.get_keyring()` returns WinVaultKeyring
  with priority 5 on this machine.
- No credential store, no profile table, and no provider HTTP endpoints exist yet.

=====================================================================

Now produce the acceptance criteria document in Markdown. Use a table with columns
ID | Priority | Description & Verification Target. Be specific and objectively verifiable —
prefer concrete values (exact service/account strings, exact mask format, error class names)
over adjectives. Give an explicit answer to each of Q1-Q6.
