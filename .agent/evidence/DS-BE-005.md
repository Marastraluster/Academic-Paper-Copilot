# Evidence — DS-BE-005 Provider Profile Store + Credential Storage

- **Date:** 2026-09-16
- **Agent:** DeepSeek (Claude Code CLI)
- **Acceptance criteria:** `docs/acceptance/DS-BE-005.md` (Gemini, frozen before implementation)
- **Verdict:** **DONE — 27/29 PASS, 2 NOT_APPLICABLE (P2, deferred by design), 11/11 failure
  conditions avoided. All 22 P0 PASS.**

## Implementation Summary

Provider profiles persist to SQLite; their API keys go to the **OS credential store** via
`keyring`. The database holds only an opaque `credential_ref`, so a profile listing can show
*that* a key is set without ever holding one — and the raw database file provably contains no
key bytes.

Three design points carry most of the weight:

- **Addressing by opaque reference.** Neither the profile name (mutable) nor its row id
  (guessable) addresses the credential, which makes rename a pure metadata update that cannot
  orphan or sever a secret.
- **No fallback, ever.** An unavailable credential store raises a typed error. A fallback that
  "works" would look like success while undoing the entire design.
- **Three-way update semantics.** `api_key` omitted → keep; `""` → clear; value → set.
  Collapsing "omitted" and "empty" would let an unrelated edit silently destroy a user's key.

## Modified Files

| File | Change |
|---|---|
| `backend/app/db.py` | Sequential migration mechanism; `SCHEMA_VERSION` 1 → 2; `profiles` table; `DatabaseVersionError` |
| `backend/app/security/{__init__,credentials}.py` | **New** — keyring wrapper, masking, typed errors |
| `backend/app/storage/{__init__,profiles}.py` | **New** — profile CRUD, `to_provider_config` |
| `backend/tests/{test_credentials,test_profiles}.py` | **New** — 72 tests |
| `backend/tests/conftest.py` | Autouse in-memory keyring (AC-22) |
| `backend/tests/test_db.py` | Table guard updated (AC-04) |
| `backend/tests/test_isolation.py` | Same guard, second location (AC-04) |
| `docs/acceptance/DS-BE-005.md` | Frozen criteria + review |

`backend/app/llm/**` untouched. Frontend untouched (newest file 12:36).

### Corrections to the task file

The task file named `test_isolation.py` as the home of the "no product tables" guard; the
assertion actually lives in **`test_db.py`**, with a second copy in `test_isolation.py`.
`conftest.py` is also required, for the fake-keyring fixture. The task file records the
correction rather than quietly widening scope.

**Both guards were updated to pin an exact table set** (`["profiles", "schema_version"]`)
rather than simply removing `profiles` from a forbidden list — so a table for a phase that has
not started still fails the suite, which was the original guard's whole purpose.

## Automated Tests Run

```
$ cd backend && .venv/Scripts/python -m pytest
    → 377 passed, 1 warning in 7.80s
      (305 pre-existing + 72 new)

$ cd frontend && npm run test
    → 5 files, 27 tests, all passed
```

## Manual Verification — real credential store (read-only)

Deliberately **read-only**: writing to the user's actual Windows Credential Manager to prove a
point is not a trade I should make unilaterally. The backend resolution is what needed
confirming, and that is observable without writing:

```
backend          : keyring.backends.Windows.WinVaultKeyring
priority         : 5
store available  : True
service name     : AcademicPDFCopilot.profiles
(no writes performed - the real credential store was not modified)
```

All write/read/delete behaviour is exercised against the in-memory fake, which the autouse
fixture makes mandatory (asserted, not assumed).

## Defect found — pre-existing, not introduced here **(not fixed; blocked by task scope)**

While verifying masking, I reproduced a **latent logging defect on this machine**:

```
$ python -c "import logging,sys; logging.basicConfig(handlers=[logging.StreamHandler(sys.stdout)]);
             logging.getLogger('t').info('{\"api_key_masked\": \"sk-••••ab12\"}')" > out.txt
--- Logging error ---
UnicodeEncodeError: 'gbk' codec can't encode character '•' in position 30: illegal multibyte sequence
```

**Impact.** This machine's console encoding is **GBK**, which cannot represent `•` (U+2022) —
the character AC-09 mandates for masking. Any log line containing a masked key, or any other
character GBK cannot encode, is **lost**: `logging` swallows the exception, emits a
`--- Logging error ---` traceback, and the record never reaches the stream.

**Why the existing tests miss it.** `test_secret_never_reaches_the_log_stream` asserts the
secret is *absent*; a log line that vanished entirely trivially satisfies that. A test that can
only check for absence cannot detect lost output.

**Why it is not fixed here.** The fix belongs in `backend/app/logging.py`, which this task's
file list explicitly forbids. The defect is *latent* — nothing currently logs a masked key — so
it blocks no criterion. Widening scope to a forbidden file to fix a non-blocking issue is
exactly the behaviour the constraint exists to prevent.

**Recommended fix (one line, next task):** in `configure_logging`, reconfigure the stream with
`errors="backslashreplace"` so an unencodable character degrades to a `\uXXXX` escape instead
of destroying the whole record — plus a regression test asserting a masked-key line actually
*arrives*, not merely that the secret is absent.

## Acceptance Criteria Evaluation

### P0 — MUST (all PASS)

| AC | Verdict | Evidence |
|---|---|---|
| AC-01 Migration to v2, idempotent | **PASS** | `profiles` created, versions `[1, 2]`; repeat run leaves rows byte-identical |
| AC-02 Forward migration preserves data | **PASS** | Hand-built v1 DB upgraded; the v1 row's original timestamp is intact |
| AC-03 Newer schema refused | **PASS** | Version 99 → `DatabaseVersionError` naming both versions; nothing modified |
| AC-04 Baseline guards updated | **PASS** | Both guards now pin `["profiles", "schema_version"]`; speculative tables still forbidden; 305 pre-existing tests pass |
| AC-05 Table schema, zero secret columns | **PASS** | Column set pinned exactly; no secret-bearing name (two documented exemptions) |
| AC-06 Raw file contains no key | **PASS** | `.sqlite3`, `-wal` and `-shm` all inspected after a WAL checkpoint |
| AC-07 Keyring addressing/namespacing | **PASS** | `AcademicPDFCopilot.profiles` + `credential_ref`, observed in the fake store |
| AC-08 Opaque reference format | **PASS** | `^cred_[0-9a-f]{32}$`, 37 chars; asserted to embed no name, URL, model or id |
| AC-09 Deterministic masking | **PASS** | 7-case parametrization plus a structural check on reveal length |
| AC-10 Reads never return the key | **PASS** | `get_profile`, `get_profile_by_name`, `list_profiles` all masked; repr/str clean |
| AC-11 Keyless profiles | **PASS** | `None` and `""` both → `credential_ref IS NULL`, keyring untouched |
| AC-12 Update without key | **PASS** | Credential unchanged by value *and* by call count |
| AC-13 Update with new key | **PASS** | Existing reference reused; keyless profile gains one |
| AC-14 Update with empty key clears | **PASS** | Secret deleted, `credential_ref` nulled, `has_key` False |
| AC-15 Delete removes credential | **PASS** | Row and secret both gone; tolerates an already-removed secret |
| AC-16 Rename preserves credential | **PASS** | Reference unchanged, key still resolves, and keyring is **not called at all** |
| AC-17 Duplicate name rejected | **PASS** | Case-insensitive (4 variants), covers create *and* rename; self-rename allowed |
| AC-18 Non-existent profile | **PASS** | Get/update/delete/get-by-name all raise `ProfileNotFoundError` |
| AC-19 Unavailable store, no fallback | **PASS** | Typed error on set/get/delete; nothing half-written; source-level guard against reintroducing a fallback path |
| AC-20 No secret in logs/repr/exceptions | **PASS** | Profile repr/str clean; unavailable-store error message clean |
| AC-21 `to_provider_config` | **PASS** | Real key in `SecretStr`, all settings carried; keyless → `""`; dangling reference raises |
| AC-22 Mandatory test isolation | **PASS** | Autouse fake; asserted by class name (not by importing the fake, which would compare a class to itself) |

### P1 — SHOULD (all PASS)

| AC | Verdict | Evidence |
|---|---|---|
| AC-23 Availability probe | **PASS** | `True` with the fake, `False` for `fail.Keyring`, `False` when `get_keyring` raises |
| AC-24 Custom headers round-trip | **PASS** | JSON-encoded/decoded; absent stays `None` |
| AC-25 Protocol validation | **PASS** | Three valid values accepted; invalid rejected on create; blank required fields rejected |
| AC-26 WAL/concurrency pragmas | **PASS** | All operations go through the existing bootstrapped connection |
| AC-27 Timestamp auditing | **PASS** | UTC `+00:00`; `created_at` fixed across an update |

### P2 — OPTIONAL

| AC | Verdict | Reason |
|---|---|---|
| AC-28 Sanitised export/import helper | **NOT_APPLICABLE** | P2 and non-blocking. No consumer exists until the provider HTTP API task defines the response shape; implementing it now would mean guessing that shape and then changing it. Deferred deliberately, not overlooked. |
| AC-29 Default-profile indicator | **NOT_APPLICABLE** | P2 and non-blocking. "Default profile" is a product decision (is it global, or per document?) that no requirement has settled yet. Adding a column plus a uniqueness constraint for an undefined behaviour would be speculative schema — the thing the DS-BE-001 guard exists to prevent. |

### Specified tests AC-30.01 … AC-30.28

All 28 exist and pass (72 test functions including parametrizations). Two were strengthened
beyond the specification:

- **AC-30.09** inspects `-wal` and `-shm` companions, not just the main file — a secret that
  only reached a WAL page is still on disk.
- A companion test asserts the key **is retrievable** from the store, so the byte test cannot
  pass merely because nothing was stored. Without it, a no-op `set_credential` would satisfy
  the criterion.

### Failure conditions

| FC | Verdict |
|---|---|
| FC-01 Scope creep | **AVOIDED** — no HTTP endpoints, no adapter changes, no PDF/QA/frontend |
| FC-02 Secret in SQLite | **AVOIDED** — raw-byte assertion across all three files |
| FC-03 Secret in outputs | **AVOIDED** — repr, str, errors, and the unavailable-store message |
| FC-04 Silent insecure fallback | **AVOIDED** — typed error, plus a source-level guard against a fallback path |
| FC-05 Orphaned credentials on delete | **AVOIDED** — asserted in the store, not just the DB |
| FC-06 Credential loss on rename | **AVOIDED** — reference unchanged and keyring untouched |
| FC-07 Unstable keyring addressing | **AVOIDED** — reference asserted to be neither name nor id |
| FC-08 Destructive/non-idempotent migration | **AVOIDED** — data preserved, repeat-safe, newer version refused |
| FC-09 Speculative schema creep | **AVOIDED** — both guards pin an exact table set |
| FC-10 Real credential store contamination | **AVOIDED** — autouse fake, asserted by class name |
| FC-11 Regression | **AVOIDED** — 404 tests green |

**Result: 27 PASS, 0 FAIL, 2 NOT_APPLICABLE (both P2, both explained).**

## Known Limitations

1. **No git baseline commit** (carried across all tasks). `git diff` still reports nothing.
2. **The GBK logging defect above is unfixed**, by task-scope constraint. It is the highest-value
   follow-up in the repository right now: a one-line fix plus a regression test.
3. **`_row_to_profile` swallows credential-read failures**, reporting `has_key=True` with an
   empty `api_key_masked` rather than failing the read. Deliberate — listing profiles should not
   break because the credential store hiccuped — but it can mask an inconsistency, which
   `to_provider_config` then reports properly.
4. **The SQLite connection is thread-affine** (DS-BE-001 constraint). `ProfileStore` holds a
   connection, so it inherits that: synchronous (`def`) endpoints would need their own
   connection. Unchanged by this task, and still pinned by a DS-BE-001 test.
5. **No profile HTTP endpoints yet** — deliberately deferred; the store is the layer beneath them.
6. **Concurrent writes to the same profile name rely on a check-then-insert plus an
   `IntegrityError` backstop.** Correct under SQLite's locking, but worth revisiting if the API
   layer ever exposes high-concurrency profile creation.

## Recommended Next Task

**Two candidates, in priority order:**

1. **Fix the GBK logging defect** (`backend/app/logging.py` + a regression test). One line, and
   it is currently the only known unfixed defect in the repository.
2. **DS-BE-006 — provider profile HTTP API.** The store now exists; the frontend needs
   `/api/profiles` (CRUD + `test`, keys always masked) before any of the UI work can begin. This
   is the last piece of Phase 2 other than the retry policy.
