# DS-BE-005 — Provider Profile Store + Credential Storage

- **Phase:** 2 (LLM Provider)
- **Status:** AC authoring — implementation NOT started
- **Owner:** DeepSeek (implementation) · Gemini (acceptance criteria)
- **Created:** 2026-09-16

## Goal

Persist provider profiles, and store their API keys where they belong — the **operating
system's credential store**, not in the database, not in a config file, not in a log.

This is the task that makes the product's "user owns their endpoint, key and model" principle
real, and the one where a mistake is unrecoverable: a leaked key cannot be un-leaked.

## Product Context

Users create, edit and switch between provider profiles (OpenAI, DeepSeek, OpenRouter, a local
server…). Each has a name, endpoint, model, protocol, and its own credential. The settings
screen lists them and must be able to show *that* a key is set without ever showing the key.

The upstream project this product is built on stores keys in **plaintext JSON** and even writes
environment-supplied keys to disk as a side effect (`docs/REPO_AUDIT.md` §16). That finding is
the direct reason this task exists.

## Technical Context

| Piece | State |
|---|---|
| Backend | FastAPI + SQLite, `app/db.py` bootstraps a `schema_version` table only |
| LLM layer | Two adapters behind `LLMProvider`, plus detection (DS-BE-004) |
| Credentials | `keyring` 25.7.0 installed; **`WinVaultKeyring` verified active** on this machine |
| Logging | `app/logging.py` redacts sensitive keys and scrubs `Bearer`/`key=value` text |

**The database currently has no product tables** — DS-BE-001 deliberately created none, and a
test asserts `['schema_version']` is all that exists. This task adds the first real table and
therefore the first real migration.

## Files Allowed To Modify

```
backend/app/storage/**              (new — profile persistence)
backend/app/security/**             (new — credential store)
backend/app/db.py                   (add a migration; bump schema version)
backend/tests/test_profiles.py      (new)
backend/tests/test_credentials.py   (new)
backend/tests/conftest.py           (autouse fake-keyring fixture — required by AC-22)
backend/tests/test_db.py            (one guard: the "no product tables" assertion)
backend/tests/test_isolation.py     (one guard: same assertion, second location)
.agent/tasks/DS-BE-005.md
.agent/evidence/DS-BE-005.md
```

> **Correction to the original task file.** It named `test_isolation.py` as the home of the
> "no product tables" guard; that assertion actually lives in **`test_db.py`**, and a second
> copy sits in `test_isolation.py`. The frozen criteria require both to be updated, so both are
> listed above. `conftest.py` is also required, for the mandatory fake-keyring fixture. These
> are guard updates and a test fixture — not production code — and each is recorded in the
> evidence.

## Files Forbidden To Modify

```
backend/app/llm/**                  (the provider layer — unchanged)
backend/app/{main,config,errors,logging}.py, backend/app/api/**
backend/tests/** other than the listed files
frontend/**        (untouched; must keep passing 27 tests)
docs/** other than this task's acceptance file
_reference/**
```

## Requirements

R1. A `profiles` table holding everything **except** secret material: name, base_url, model,
    protocol, temperature, max_output_tokens, timeout_s, custom_headers, and a **credential
    reference**. No column may ever hold a key.
R2. Credentials live in the OS credential store via `keyring`. The database holds only an
    alias/reference that is meaningless on its own.
R3. Reading a profile never returns the key. The only representation available to any caller
    above this layer is a **masked** form (e.g. `sk-••••••••ab12`).
R4. Updating a profile without supplying a key leaves the stored key unchanged.
R5. Deleting a profile deletes its credential from the keyring — no orphaned secrets.
R6. The database file must contain no key material. This must be assertable by reading the
    file's bytes and finding no key.
R7. No key in any log line, error message, repr, or exception produced by this code.
R8. A migration adds the table to an existing database without destroying it, and is
    idempotent (matching `app/db.py`'s existing bootstrap contract).
R9. When the OS credential store is unavailable, the failure is explicit and typed — never a
    silent fallback to writing the key somewhere insecure.
R10. Profile names are unique; attempting a duplicate is a typed, non-crashing error.
R11. Tests never touch the real OS credential store or the real user database.

## Design questions the acceptance criteria should settle

1. **Keyring addressing.** What service name and account name? Is the account the profile's
   database id, its name, or a generated opaque reference? (Name is user-editable, which makes
   rename a migration; id is stable. State the rule and what happens on rename.)
2. **The reference column.** What exactly is stored — the profile id, a UUID, a namespaced
   string? Must survive a profile rename without orphaning the credential.
3. **Unavailable keyring.** What is the exact behaviour and error type when `keyring` has no
   usable backend (headless CI, a machine with no credential store)? R9 requires it be explicit;
   the criteria should say *how*.
4. **Empty vs absent key.** A local keyless server is a supported configuration (DS-BE-002
   AC-27). Is "no key" distinct from "empty key", and how is each represented?
5. **Migration mechanism.** `db.py` currently just creates `schema_version`. How are numbered
   migrations applied, and what does bumping to version 2 do to an existing database?
6. **Test isolation.** How do tests avoid the real credential store? (A fake keyring backend is
   the obvious answer; the criteria should make it mandatory rather than optional.)

## Expected Tests

- Create / read / update / delete a profile round-trips through SQLite.
- A stored key is retrievable through the credential layer but absent from the database file,
  every log line, and every repr.
- Masking produces the documented shape and never the full key.
- Update without a key preserves the existing credential.
- Delete removes the credential from the store.
- Rename preserves the credential (per Q1).
- Duplicate name is rejected with a typed error.
- Migration: an existing v1 database gains the table and keeps its data; running it twice is safe.
- Unavailable keyring produces the documented typed failure, not silent degradation.
- Existing 253 backend + 27 frontend tests still pass.

## Dependencies

DS-BE-001 (schema bootstrap), DS-BE-002/003/004 (the config shape being persisted).

## Known Risks

- **Leaking a key into the database, a log, or an error message.** R6/R7 exist because this is
  the one failure that cannot be undone.
- **Orphaned credentials** after a delete or rename.
- **Silent fallback** to insecure storage when keyring is unavailable — the worst outcome,
  because it looks like success.
- **Breaking the existing "no product tables" guarantee** without updating the DS-BE-001 test
  that asserts it.
