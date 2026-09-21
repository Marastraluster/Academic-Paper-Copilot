# Acceptance Criteria — DS-FE-004: Provider Settings

- **Author:** project maintainer
- **Reviewed and frozen by:** project maintainer (round 1 review pending)
- **Date:** 2026-09-21
- **Baseline:** Commit `5d7f719` / Post-DS-DOC-004 (`SCHEMA_VERSION = 5`, initial bundle headroom `1.11 kB` under amended `310.0 kB` ceiling)
- **Deliverable:** `docs/acceptance/DS-FE-004.md` (authored before any production code)
- **Status:** **PROPOSED FOR ROUND 1 REVIEW — 20 P0 · 5 P1 · 2 P2**

---

## 0. Independent Acceptance Author Statement & Review Framing

### 0.1 Process Discipline: Acceptance Before Implementation
In the Academic PDF Copilot repository, process sequencing is load-bearing:
- **DS-BE-005** established the provider profile store and OS keyring storage contract (`docs/acceptance/DS-BE-005.md`), freezing 22 P0 criteria before implementation.
- **DS-FE-001** built the application shell with placeholder controls, leaving the TopBar "设置" (Settings) button without an `onClick` handler.
- **DS-FE-003** implemented the translation flow and `TranslateDialog` with lazy code splitting (`docs/acceptance/DS-FE-003.md`), closing at 20 P0 criteria and adhering to the bundle ceiling.
- **DS-DOC-004** established reading session continuity across browser reloads (`docs/acceptance/DS-DOC-004.md`) without any new dependencies or router additions.

**This task continues that discipline.** The criteria below were written and frozen before any implementation, and not a single line of production code in `frontend/src/` or `backend/app/` is written until this contract is reviewed.

### 0.2 The Core Problem & The Reader's Inquiries
The reader reported the defect directly:
> *"设置部分点不开，是没有做自己配置 endpoint 地址和 api key 的界面吗?"*  
> *(The Settings section cannot be opened. Is there no interface to configure endpoint addresses and API keys?)*

And asked the crucial durability question:
> *"测试是否真的能写到配置文件中调整"*  
> *(Test whether configuring something here actually writes to a config file and takes effect.)*

Today:
1. In `frontend/src/app/TopBar.tsx:154-166`, the "设置" button renders an icon inside a tooltip with **zero `onClick` handler**. It is a dead control.
2. The user has no UI affordance to add, view, edit, test, or delete provider configurations.
3. The backend profile CRUD and probe endpoints (`backend/app/api/profiles.py`), SQLite storage (`backend/app/storage/profiles.py`), and OS keyring security module (`backend/app/security/credentials.py`) are **already complete and tested** (`backend/tests/test_api_profiles.py`, `backend/tests/test_profiles.py`).
4. What is missing is the frontend screen, its validation, its integration with the backend surface, and the empirical proof that configured profiles survive a full application restart and take effect.

### 0.3 The Architectural Reality of Storage: Why There Is No "Config File"
The reader asks whether settings write to a "configuration file". The criteria must address this honestly:
- **There is no configuration file (`config.json`, `config.yaml`, `.env`), and that is a deliberate security decision.** Plaintext configuration files leak API keys into backups, git trees, terminal logs, and desktop syncs.
- **Profile metadata** (name, `base_url`, `model`, `protocol`, `timeout_s`, `temperature`, `max_output_tokens`, `custom_headers`) is stored as a row in SQLite: `<documents_dir>/../db.sqlite3`, table `profiles`.
- **API keys never touch the database or any file.** Secrets go directly into the **operating system credential store** via `keyring` (service `AcademicPDFCopilot.profiles`, account `credential_ref = "cred_" + uuid4().hex`).
- **Clients never receive a key-bearing field.** `GET /api/profiles` and `GET /api/profiles/{id}` return `has_key: bool` and `api_key_masked: str` (e.g. `sk-••••••••ab12`) and nothing else.

Therefore, the honest verification of *"did it really save and take effect?"* is:
> **After saving a profile, terminating the backend process, restarting it, and hard-reloading the browser (`F5`), the profile remains listed with identical metadata, `has_key: true`, and a probe or translation request made with it resolves the key from the OS credential store and succeeds — with zero raw key bytes found in the database, WAL, localStorage, DOM, logs, or error messages.**

### 0.4 Verified Starting Constraints

| Dimension | Repo Baseline & Constraint | Verification Finding |
|---|---|---|
| **TopBar Settings Button** | `frontend/src/app/TopBar.tsx:154-166` | Button has `aria-label="设置"`, tooltip "设置", but no `onClick` prop. |
| **Initial Bundle Headroom** | `docs/acceptance/DS-QA-015.md` §0.1, AC_CHANGE_REQUEST 4 | Initial bundle chunk ceiling is **310.0 kB**. Measured chunk is **308.89 kB**. Remaining headroom is **1.11 kB**. |
| **Code Splitting Requirement** | `frontend/src/app/TopBar.tsx:25-29` (`TranslateDialog`) | Settings UI must load via `lazy()` + `Suspense` so 0 bytes enter the initial chunk. |
| **No Router** | `frontend/package.json`, `frontend/src/app/App.tsx` | No router library exists. UI must be an in-place modal dialog, not a page. |
| **Existing UI Primitives** | `frontend/src/components/ui/` | Button, separator, tooltip. Icons via `lucide-react`. No new UI or form libraries. |
| **Keyless Provider Validity** | `backend/app/storage/profiles.py:178`, DS-BE-007 | `has_key: false` is fully valid (e.g. local Ollama / vLLM). UI must not require a key. |
| **Three-Way PATCH Semantics** | `backend/app/api/profiles.py:83-115` | `api_key` omitted: keep key; `api_key=""`: clear key; `api_key="val"`: set key; explicit `null`: rejected. |
| **Probe Quota Safety** | `backend/app/api/profiles.py:294-320` | `/test` issues real provider requests. UI must probe only on explicit user click. |
| **Session Isolation** | `frontend/src/session/types.ts:36-47` | Reading session stores document reading place only. Secrets must never enter `localStorage`. |

---

## 0.5 Round 1 review and freezing — 2 AC_CHANGE_REQUESTs

Read against the repository at `f429b3f`, together with the backend's own profile
suite (`backend/tests/test_api_profiles.py`, 30 tests) and the credential store
(`backend/app/security/credentials.py`). Decisions **D1–D8** are accepted as
written. Three of them settle questions the implementation would otherwise have
guessed at, and each is grounded in something measurable: **D1** (a lazy modal,
because 1.11 kB of headroom is not enough for a page), **D4** (metadata edits
must omit `api_key` rather than send a value, because the backend distinguishes
"leave it" from "clear it" and guessing wrong destroys a key), and **D7** (a probe
is a reader's decision — `/test` issues real provider requests).

The `PROVIDER_*` codes AC-P0-16 maps are the ones `_provider_error_response`
actually emits (`app/api/profiles.py:177-191`), including
`PROVIDER_MODEL_NOT_FOUND` and `PROVIDER_UNREACHABLE`. Two points recorded
without change:

- **No dialog primitive exists.** There is no `@radix-ui/react-dialog` and adding
  one is excluded by AC-P0-03's ceiling and the no-dependencies rule, so AC-P0-02's
  focus trap is hand-written. `TranslateDialog` is the precedent for Escape and
  the backdrop; the trap is new.
- **The new profile API client functions must be imported only by the lazy
  dialog.** `listProfiles` is already eager (the translation dialog and QA call
  it); `create`/`update`/`delete`/`test` must not be, or AC-P0-03 fails on bytes
  the screen does not need until it is opened.

### AC_CHANGE_REQUEST 1 — the durability harness writes to the real credential store and never cleans up

**Old wording:** none. AC-P0-17 creates a profile carrying
`api_key="sk-live-durable-key-98765432"` and AC-P0-18 proves the key is absent
from five surfaces — but nothing removes what the harness wrote.

**New wording — a twenty-first P0:**

> **AC-P0-21 Harness Cleanup of the Real Credential Store.** The durability
> harness runs a real backend against this machine's real credential store, so
> whatever it creates it must also remove. After the final assertion it deletes
> the profiles it created and asserts that (a) `GET /api/profiles` no longer
> lists them, and (b) no credential remains in the store under the deleted
> profiles' references — the same cleanup `DELETE /api/profiles/{id}` performs
> and `test_delete_removes_profile_and_credential` pins server-side. A run that
> fails midway must still attempt the cleanup, and must report whether it
> succeeded.

**Reason.** Unlike the database and the documents directory, the credential
store is **not** copied into the harness work directory: `keyring` reaches the
real Windows Credential Manager, so a test profile is a real entry on the
reader's machine, under a service name the application also uses. Leaving it
there is not a stale test fixture — it is litter in a store the reader may open
and find. It also means the durability proof is incomplete without it: deleting a
profile is supposed to remove its credential, and a criterion that never deletes
one never checks the half of the contract that touches the OS.

### AC_CHANGE_REQUEST 2 — AC-P0-20 names a suite count that is already stale

**Old wording:** *"all existing 48+ frontend tests and all backend tests MUST
continue to pass without modification or breakage."*

**New wording:** *"The full frontend suite (`vitest run`) and the full backend
suite (`pytest`) must pass, with the counts reported as measured rather than
asserted against a number."*

**Reason.** The frontend suite is **325 tests** across 18 files, not 48+; the
figure was true around DS-FE-001 and has drifted with every tranche since. This is
the same defect this repository already corrected once — DS-QA-012's
AC_CHANGE_REQUEST 4 replaced stale counts with measured ones — and a criterion
whose threshold is a number nobody re-measures is one that quietly stops meaning
anything. The invariant worth freezing is "the suites stay green", not a number
that a future task will have to argue about.

### Recorded: this supersedes one clause of DS-DOC-004's AC-P0-18

DS-DOC-004's AC-P0-18 reads *"The 设置 button in `TopBar.tsx` must remain
untouched"* — a negative criterion written to stop that task from quietly adding
a settings screen of its own. This task exists because the button was never
wired, so **it deliberately supersedes that clause**: D1 gives the button an
`onClick`, and the only thing left standing is the part both criteria share — no
router, no URL mutation, no navigation. `src/tests/session-continuity.test.tsx`
asserted the superseded half (clicking 设置 opened nothing); it now asserts that
clicking it changes no URL, which is the claim DS-DOC-004 actually protects.
Recorded here rather than silently deleted, because a closed task's criterion
disappearing is exactly the kind of thing that should be visible.

### Accepted and recorded without change

**AC-P0-03's 310.0 kB is the amended ceiling** (DS-QA-015 §0.1), and the measured
308.89 kB leaves **1.11 kB** for the eager half of this feature — the button's
handler, the `lazy()` import, and the dialog's mount point. It is the tightest
constraint here and it will be reported as measured.

**P0 is frozen at 21 criteria with the additions above. 5 P1 · 2 P2 remain.**

---

## 1. Architectural Decisions (Settling the Core Design Questions)

| # | Topic | Decision | Load-Bearing Rationale |
|---|---|---|---|
| **D1** | **Screen Shape** | **Modal dialog** (`SettingsDialog`) opened from TopBar "设置" button, dynamically imported via `lazy()` and wrapped in `Suspense`. | Initial bundle headroom is 1.11 kB (308.89 kB vs 310.0 kB ceiling). A router or separate page is ruled out by bundle size. An in-place modal preserves reading context, mirrors `TranslateDialog`, and allows complete code splitting. |
| **D2** | **CRUD & Probe Scope** | **Create, List, Edit, Delete, and Test Probe are all P0.** | The user must be able to configure their provider, correct mistakes, remove stale configurations, and verify connectivity before initiating translations. |
| **D3** | **Keyless Local Providers** | **API key is strictly optional in UI.** Profiles with empty key save with `has_key: false`. | Local LLM runtimes (Ollama, LM Studio, vLLM) require no key. Mandating an API key breaks the core local-first scientific workflow. |
| **D4** | **Editing & Key Preservation** | **Editing metadata leaves existing key untouched by default.** | The input renders empty with placeholder `保留现有密钥 (sk-••••••••ab12)`. When submitted without text, `api_key` is omitted from the `PATCH` payload. A distinct "清除密钥" button sends `""` to clear it. |
| **D5** | **Validation Boundary** | **Client validates format; server enforces business constraints.** | Client validates non-blank `name`, `base_url`, `model`, valid URL scheme (`http://` or `https://`), and `timeout_s > 0`. Server enforces uniqueness (`ProfileNameExistsError`) and keyring availability. |
| **D6** | **Active Profile Deletion** | **Deleting active profile falls back gracefully.** | If the profile currently active in `TranslateDialog` is deleted, `TranslateDialog` drops to the first available profile, or displays empty state if 0 profiles remain. No crash or invalid state. |
| **D7** | **Probe Trigger Discipline** | **Zero automatic probes.** Probe occurs strictly upon explicit user click on "测试连接". | Every probe consumes real provider quota and network latency. Probing on mount, on dialog open, or on input change is strictly forbidden. |
| **D8** | **Zero Secret Leakage** | **Zero raw key exposure across 5 surfaces.** | Key is never written to SQLite, never written to `localStorage`, never embedded in the DOM, never printed to console, and never serialized in error envelopes. |

---

## 2. Priority P0 (MUST) — Core Functional, Security & Durability Criteria

### 2.1 Modal Lifecycle & Code Splitting (Dims 1–4)

#### AC-P0-01 — TopBar Settings Trigger & Dynamic Import
- *Given* the application shell is rendered,
- *When* the reader inspects the TopBar,
- *Then* the "设置" button is visible, rendered in keyboard tab order, carrying `aria-label="设置"` and tooltip "设置".
- *When* the button is clicked or activated with `Enter` / `Space`,
- *Then* the `SettingsDialog` component is loaded asynchronously via dynamic `import()` and mounted inside a React `Suspense` boundary.
- *When* the dialog is closed,
- *Then* the dialog component is unmounted from the DOM.
- **Evidence:** Vitest unit test verifies button click mounts dialog; build analysis verifies `SettingsDialog` is placed in an isolated async chunk and absent from initial `index-*.js`.

#### AC-P0-02 — Focus Trap, Keyboard Dismissal & Focus Restoration
- *Given* `SettingsDialog` is open,
- *Then* the dialog root carries `role="dialog"`, `aria-modal="true"`, and `aria-labelledby="settings-dialog-title"`.
- *When* the reader presses `Tab` or `Shift+Tab`,
- *Then* keyboard focus cycles strictly within the focusable elements inside the dialog (focus trap).
- *When* the reader presses `Escape` or clicks the backdrop overlay outside the dialog panel,
- *Then* the dialog closes immediately without saving pending unsubmitted edits.
- *When* the dialog unmounts,
- *Then* keyboard focus returns directly to the TopBar "设置" button that opened it.
- **Evidence:** Vitest test simulating `Escape` and backdrop clicks asserts `onClose` called; focus trap test asserts cycling; `document.activeElement` verified upon close.

#### AC-P0-03 — Initial Chunk Bundle Ceiling Compliance
- *Given* the production Vite build is executed (`npm run build`),
- *Then* the initial entry JavaScript chunk (`dist/assets/index-*.js`) MUST NOT exceed **310.0 kB** minified.
- *And* the code, templates, and styles for `SettingsDialog` MUST reside in a separate dynamically loaded chunk (e.g. `dist/assets/SettingsDialog-*.js`).
- **Evidence:** File size measurement of production build artifacts verifies `index-*.js <= 310.0 kB` (measured against the current 308.89 kB chunk).

---

### 2.2 Profile Listing & Credential Masking (Dims 5–7)

#### AC-P0-04 — Profile List Retrieval & Empty State
- *Given* `SettingsDialog` is opened,
- *Then* the client dispatches `GET /api/profiles` with an `AbortController` signal and displays a loading state while fetching.
- *When* the fetch completes with one or more profiles,
- *Then* all profiles are rendered in a sidebar/list within the dialog showing `name`, `base_url`, `model`, `protocol`, and credential status.
- *When* the fetch completes with zero profiles,
- *Then* the dialog renders an empty state indicating no providers are configured and provides a primary "新建配置" (New Profile) button.
- **Evidence:** Vitest test mocks `GET /api/profiles` returning `[]` and `[mockProfile]`, verifying empty state and populated list respectively.

#### AC-P0-05 — Credential Masking & Visual Distinction
- *Given* profiles are rendered in the list or edit view,
- *When* a profile has `has_key: true`,
- *Then* the UI displays a badge "已保存凭据" and displays the masked string from `api_key_masked` (e.g. `sk-••••••••ab12`).
- *When* a profile has `has_key: false`,
- *Then* the UI displays a badge "免密模式" and indicates that the endpoint operates without an API key.
- *And* under no condition is any plaintext key or credential reference displayed or queryable in the DOM.
- **Evidence:** DOM assertions verify `api_key_masked` presence, badge texts, and absence of raw secrets.

---

### 2.3 Profile Creation & Keyless Support (Dims 8–10)

#### AC-P0-06 — Keyless Profile Creation (Local Endpoint)
- *Given* the user opens the "新建配置" form,
- *When* the user provides `name="Ollama"`, `base_url="http://127.0.0.1:11434"`, `model="qwen2.5:7b"`, leaves `api_key` empty, and submits,
- *Then* the client dispatches `POST /api/profiles` with:
  ```json
  {
    "name": "Ollama",
    "base_url": "http://127.0.0.1:11434",
    "model": "qwen2.5:7b",
    "protocol": "auto",
    "timeout_s": 60.0,
    "api_key": null
  }
  ```
- *And* the client does NOT require an API key to be entered.
- *When* the backend returns 201 with `has_key: false`,
- *Then* the new profile appears in the profile list with the "免密模式" badge.
- **Evidence:** Vitest test submits form with empty key; verifies network request payload and UI list update.

#### AC-P0-07 — Profile Creation with API Key
- *Given* the user opens the "新建配置" form,
- *When* the user provides `name="DeepSeek"`, `base_url="https://api.deepseek.com/v1"`, `model="deepseek-chat"`, `api_key="sk-live-secret-test1234"`, and submits,
- *Then* the client dispatches `POST /api/profiles` containing the plaintext key in the request body.
- *When* the backend responds with 201 `ProfileResponse` (`has_key: true`, `api_key_masked: "sk-••••••••1234"`),
- *Then* the client resets the plaintext password input immediately, updates the profile list, and renders the masked key badge.
- **Evidence:** Network spy confirms key sent in POST; post-submit DOM inspection verifies password input cleared and masked string displayed.

#### AC-P0-08 — Client-Side URL Scheme & Required Field Validation
- *Given* the profile creation or edit form,
- *When* the user attempts to submit with any of:
  1. `name` empty or whitespace-only;
  2. `base_url` empty or whitespace-only;
  3. `model` empty or whitespace-only;
  4. `base_url` containing an unsupported scheme (e.g. `httpx://api.openai.com`, `ftp://server`, or `api.openai.com` without `http://` or `https://`);
  5. `timeout_s <= 0` or non-numeric;
- *Then* the form prevents submission, dispatches zero network requests, and renders an inline validation error message beneath the offending input (e.g. `"URL 必须以 http:// 或 https:// 开头"`).
- **Evidence:** Vitest test enters invalid inputs and asserts error text rendered and `fetch` call count is 0.

---

### 2.4 Profile Editing & Three-Way Key Semantics (Dims 11–14)

#### AC-P0-09 — Edit Profile: Metadata Update Preserves Stored Key
- *Given* an existing profile with `has_key: true` (`id="prof_123"`),
- *When* the user edits `model` to `"deepseek-reasoner"` or `timeout_s` to `90.0`, leaves the API key input untouched, and submits,
- *Then* the client dispatches `PATCH /api/profiles/prof_123` containing modified fields, and **omits `api_key` entirely from the JSON payload**:
  ```json
  {
    "model": "deepseek-reasoner",
    "timeout_s": 90.0
  }
  ```
- *And* the payload MUST NOT contain `"api_key": null` and MUST NOT contain `"api_key": ""`.
- *When* the backend responds with 200,
- *Then* `has_key` remains `true` and the existing credential in the OS keyring remains untouched.
- **Evidence:** Vitest spy inspects PATCH payload keys; verifies `"api_key"` is absent and returned profile retains `has_key: true`.

#### AC-P0-10 — Edit Profile: Replace Stored Key
- *Given* an existing profile (`id="prof_123"`),
- *When* the user types a new key `"sk-new-secret-5678"` into the API key input and submits,
- *Then* the client dispatches `PATCH /api/profiles/prof_123` with `"api_key": "sk-new-secret-5678"`.
- *When* the backend responds with 200,
- *Then* the client clears the input field and displays the new masked key representation (e.g. `"sk-••••••••5678"`).
- **Evidence:** Vitest test verifies PATCH payload contains new key; input is cleared; new mask is rendered.

#### AC-P0-11 — Edit Profile: Explicitly Clear Stored Key
- *Given* an existing profile with `has_key: true` (`id="prof_123"`),
- *When* the user clicks the "清除密钥" (Clear Key) action in the form and confirms save,
- *Then* the client dispatches `PATCH /api/profiles/prof_123` with `"api_key": ""`.
- *When* the backend responds with 200,
- *Then* the profile updates to `has_key: false`, `api_key_masked: ""`, and displays the "免密模式" badge.
- **Evidence:** Vitest test clicks clear key button; asserts PATCH body has `{"api_key": ""}`; asserts UI displays `has_key: false`.

#### AC-P0-12 — Rejection of Explicit Null API Key
- *Given* any profile update operation,
- *Then* the client MUST NEVER serialize `"api_key": null` into the `PATCH` body (which triggers backend 422 `ProfileUpdateRequest._reject_explicit_null_api_key`).
- **Evidence:** Automated contract test asserting payload serialization across all edit scenarios never emits `"api_key": null`.

---

### 2.5 Profile Deletion & Workspace Safety (Dims 15–16)

#### AC-P0-13 — Profile Deletion with Confirmation
- *Given* an existing profile in `SettingsDialog`,
- *When* the reader clicks "删除配置" (Delete Profile),
- *Then* the UI displays a confirmation prompt ("确定删除此配置吗？删除后将同时清理系统密钥。").
- *When* the reader confirms deletion,
- *Then* the client dispatches `DELETE /api/profiles/{id}`.
- *When* the backend returns 204 No Content,
- *Then* the profile is immediately removed from the dialog list, and the backend cleans up both the SQLite row and the OS keyring credential.
- **Evidence:** Vitest test clicks delete, confirms modal, verifies `DELETE` dispatched, and profile removed from list.

#### AC-P0-14 — Active Profile Deletion & TranslateDialog Fallback
- *Given* profile A was previously selected in `TranslateDialog`,
- *When* the reader deletes profile A in `SettingsDialog` and subsequently opens `TranslateDialog`,
- *Then* `TranslateDialog` re-fetches `GET /api/profiles` and automatically selects the first available remaining profile.
- *When* all profiles have been deleted (0 profiles exist),
- *Then* `TranslateDialog` displays an empty-state warning ("暂无可用翻译服务，请先在设置中添加配置") and disables the translation submit button.
- *And* under no circumstance does deleting the active profile cause a runtime exception or crash the React component tree.
- **Evidence:** Vitest test deletes selected profile; opens `TranslateDialog`; asserts fallback selection or empty warning without console error.

---

### 2.6 Endpoint Testing & Failure Resilience (Dims 17–18)

#### AC-P0-15 — Explicit On-Demand Endpoint Probing (No Automatic Probes)
- *Given* a profile in `SettingsDialog`,
- *Then* the UI renders an explicit "测试连接" (Test Connection) button.
- *And* the client MUST NOT dispatch `POST /api/profiles/{id}/test` or `detect-protocol` on dialog mount, profile selection, or form edit.
- *When* the reader clicks "测试连接",
- *Then* the client dispatches `POST /api/profiles/{id}/test` and displays a loading spinner with text "正在测试连接…".
- *When* the backend responds with 200 `ConnectionTestResponse{ok: true, protocol, model, latency_ms}`,
- *Then* the UI displays a green success badge ("连接成功"), the measured latency in milliseconds (e.g. `142 ms`), and the detected protocol.
- **Evidence:** Vitest test asserts probe endpoint is called 0 times on mount; asserts exactly 1 call on button click; asserts latency and protocol displayed on success.

#### AC-P0-16 — Probe Error Mapping & Non-Blocking Resilience
- *Given* the reader clicks "测试连接",
- *When* the backend responds with a 502 or 504 error envelope carrying a mapped `PROVIDER_*` code:
  - `PROVIDER_AUTH_FAILED` (401/403) $\rightarrow$ displays "认证失败：API Key 无效或无访问权限";
  - `PROVIDER_RATE_LIMITED` (429) $\rightarrow$ displays "请求受限：已超出服务商速率限制";
  - `PROVIDER_MODEL_NOT_FOUND` (404) $\rightarrow$ displays "模型未找到：请检查模型名称是否正确";
  - `PROVIDER_TIMEOUT` (504) $\rightarrow$ displays "连接超时：端点未在指定时间内响应";
  - `PROVIDER_UNREACHABLE` (502) $\rightarrow$ displays "服务不可达：无法连接到目标服务器地址";
  - `PROVIDER_ERROR` (502) $\rightarrow$ displays "服务商错误：" + sanitised message;
- *Then* the UI displays the error clearly with an alert badge,
- *And* a probe failure DOES NOT block the user from saving, editing, or keeping the profile.
- **Evidence:** Vitest test mocks 502 with `PROVIDER_AUTH_FAILED`; verifies mapped error message displayed; verifies form submit button remains interactive.

---

### 2.7 Storage Durability & Zero Leakage (Dims 19–20)

#### AC-P0-17 — End-to-End Durability Across Backend Restart and Reload
- *Given* the full application stack is driven via the Playwright/Chromium harness (`frontend/scripts/e2e-provider-settings.mjs`),
- *When* the harness performs the following sequence:
  1. Opens the application in Chromium;
  2. Clicks the TopBar "设置" button;
  3. Creates a new profile with name `"Persisted-DeepSeek"`, `base_url="https://api.deepseek.com/v1"`, `model="deepseek-chat"`, and `api_key="sk-live-durable-key-98765432"`;
  4. Confirms save and verifies the profile appears with `has_key: true` and `api_key_masked: "sk-••••••••5432"`;
  5. **Terminates the backend process** (`backend.kill()`);
  6. **Restarts the backend process** pointing to the same data directory;
  7. **Hard-reloads the browser page** (`page.reload({ waitUntil: "domcontentloaded" })`);
  8. Clicks TopBar "设置" again;
- *Then*:
  - The profile `"Persisted-DeepSeek"` is present in the list with identical name, URL, model, and timeout;
  - `has_key` is `true` and `api_key_masked` is `"sk-••••••••5432"`;
  - Executing a probe or translation request with this profile successfully resolves the key from the OS credential store and succeeds.
- **Evidence:** Playwright test run outputs the e2e-provider-settings/results.json run log recording `PASS` for restart durability.

#### AC-P0-18 — Zero Secret Leakage Across All Five Surfaces
- *Given* a profile configured with raw secret `"sk-live-durable-key-98765432"`,
- *Then* automated assertions must verify the raw key NEVER appears in:
  1. **SQLite database bytes**: `b"sk-live-durable-key-98765432" not in db_bytes` for `db.sqlite3`, `db.sqlite3-wal`, and `db.sqlite3-shm`;
  2. **Browser LocalStorage / SessionStorage**: `localStorage.getItem(k)` across all keys contains 0 matches for the raw secret;
  3. **Rendered HTML DOM**: `page.content()` contains 0 instances of the raw key;
  4. **Browser Console / Node Logs**: `consoleErrors` and stdout/stderr logs contain 0 instances of the raw key;
  5. **Error Envelopes & Network Queries**: failed API error responses contain only sanitised messages with raw secrets redacted.
- **Evidence:** Dedicated test assertions in `e2e-provider-settings.mjs` and Vitest suite scanning all five surfaces and asserting zero occurrences.

#### AC-P0-19 — Backend Error Envelope Handling (Store Unavailable & Duplicate Name)
- *Given* the user attempts to create or update a profile,
- *When* the backend returns 400 `ProfileNameExistsError` ("A profile named ... already exists"),
- *Then* the form displays an inline error on the name field: "该配置名称已存在，请使用其他名称".
- *When* the backend returns 503 `CredentialStoreUnavailableError` ("Credential store is unavailable"),
- *Then* the form displays an alert banner explaining that the operating system credential store is unavailable and the key could not be stored, without crashing or attempting insecure disk storage fallback.
- **Evidence:** Vitest test mocks 400 duplicate name and 503 service unavailable; verifies corresponding user-friendly error banners and no unhandled exceptions.

#### AC-P0-20 — Frontend Test Suite Non-Regression
- *Given* all newly authored tests for `SettingsDialog` and profile API client,
- *Then* all existing 48+ frontend tests and all backend tests MUST continue to pass without modification or breakage.
- **Evidence:** Full test suite execution reports green status across all test files.

---

## 3. Priority P1 (SHOULD) — Usability & Ergonomic Enhancements

#### AC-P1-01 — Protocol Auto-Detection Affordance
- *Given* the profile form with `protocol="auto"`,
- *When* the reader clicks "检测协议" (Detect Protocol),
- *Then* the client dispatches `POST /api/profiles/{id}/detect-protocol`, receives `{"protocol": "chat_completions" | "responses"}`, and updates the dropdown selection accordingly.
- **Evidence:** Vitest test verifies button click calls `/detect-protocol` and updates form state.

#### AC-P1-02 — Profile Duplicate / Clone Action
- *Given* an existing profile,
- *When* the reader clicks "克隆配置" (Clone Profile),
- *Then* the form opens pre-filled with the existing profile's `base_url`, `model`, `protocol`, `timeout_s`, and `custom_headers`, with `name` set to `"<original_name> (副本)"` and API key empty for security.
- **Evidence:** Vitest test verifies clicking clone populates draft form with expected values.

#### AC-P1-03 — Responsive Dialog Layout Across Breakpoints
- *Given* viewport widths from 1024px to 1920px,
- *Then* `SettingsDialog` renders centered with max width (e.g. `max-w-2xl`), scrollable list/form panels if needed, and all inputs, labels, and buttons remain fully readable without horizontal scrolling or clipping.
- **Evidence:** Visual and CSS assertions in browser harness at 1024x768 and 1920x1080.

#### AC-P1-04 — Empty State Quick Presets / Guidance
- *Given* zero profiles exist,
- *When* the user views the empty settings screen,
- *Then* the screen provides one-click helper presets for common configurations (e.g. "Ollama 本地服务: http://127.0.0.1:11434", "DeepSeek 官方 API: https://api.deepseek.com/v1") pre-filling the URL, protocol, and recommended model name.
- **Evidence:** Vitest test clicks preset button; verifies form fields populated.

#### AC-P1-05 — Unsaved Changes Warning on Close
- *Given* the user has modified input fields in the profile form,
- *When* the user attempts to close the dialog via `Escape` or backdrop click without saving,
- *Then* the UI requests confirmation ("您有未保存的更改，确定退出吗？") or requires explicit cancellation to prevent accidental data loss.
- **Evidence:** Vitest test verifies dirty form triggers confirmation before `onClose`.

---

## 4. Priority P2 (OPTIONAL) — Future Extensions

#### AC-P2-01 — Sanitized Profile Export & Import (JSON)
- *Given* the profile list,
- *When* the user exports profiles to JSON,
- *Then* the exported file contains non-secret metadata (`name`, `base_url`, `model`, `protocol`, `timeout_s`), and strictly strips all keys and credential references. Importing validates schema and creates keyless profiles.

#### AC-P2-02 — Advanced Custom Headers Key-Value Editor
- *Given* the profile configuration form,
- *When* the user expands "高级选项 / 自定义请求头",
- *Then* an interactive key-value table allows adding headers (e.g. `HTTP-Referer`, `X-Title`) serialized to JSON for `custom_headers`.

---

## 5. Verification Protocol & Harness Implementation Guide

To verify the reader's core question (*"does it really save and take effect?"*), an automated Chromium end-to-end test must be added at `frontend/scripts/e2e-provider-settings.mjs`.

### 5.1 Verification Script Workflow

```
[Start Backend (port 8000)]
         │
[Launch Chromium & Vite Preview]
         │
[Open Settings Dialog from TopBar]
         │
[Create Profile: URL + Model + API Key]
         │
[Verify Masked Key & UI State]
         │
[KILL Backend Process (SIGTERM)] ───► [Verify Process Terminated]
         │
[RESTART Backend Process]        ───► [Wait for 127.0.0.1:8000 ready]
         │
[Hard Reload Browser (F5)]       ───► [page.reload()]
         │
[Open Settings Dialog Again]
         │
[Assert Profile Fields & has_key: true]
         │
[Execute Probe / Test Request]   ───► [Verify Key Loaded from Keyring & Works]
         │
[Audit SQLite file, WAL, DOM, localStorage] ──► [Zero Secret Bytes Found]
         │
[Write the e2e-provider-settings/results.json run log]
```

### 5.2 Specific Assertions Matrix

| Step | Harness Action | Expected Observation | Verifies |
|---|---|---|---|
| **1. UI Trigger** | `page.click('[aria-label="设置"]')` | `[data-testid="settings-dialog"]` appears in DOM | AC-P0-01, AC-P0-02 |
| **2. Save Profile** | Fill inputs & click "保存配置" | `POST /api/profiles` returns 201; list updates | AC-P0-06, AC-P0-07 |
| **3. UI Masking** | Inspect rendered card | Displays `"sk-••••••••5432"`, raw key absent | AC-P0-04, AC-P0-05 |
| **4. Process Restart** | `backend.kill()`, spawn new Python process | Port 8000 listens again | Durability precondition |
| **5. Page Reload** | `page.reload()` | Workspace restores; settings re-queried | AC-P0-17 |
| **6. Post-Restart Persistence** | Re-open settings dialog | Profile listed with identical URL, model, `has_key: true` | AC-P0-17 |
| **7. Keyring Invocability** | Click "测试连接" | Returns 200 `ok: true`, latency reported | AC-P0-15, AC-P0-17 |
| **8. Byte Leak Audit** | `readFileSync("db.sqlite3")`, WAL, localStorage | Raw key string not found anywhere | AC-P0-18 |

---

## 6. Explicitly Not Applicable (Non-Goals)

1. **Plaintext configuration files (`.env`, `config.yaml`, `config.json`)** — strictly forbidden. Storage is SQLite `profiles` table; secrets are stored in OS Keyring.
2. **Cloud account authentication & multi-device sync** — out of scope. Local-first desktop application.
3. **External model catalog fetching / pricing scraping** — out of scope. Model names are user-specified strings.
4. **Per-document or per-task provider overrides** — out of scope. Profiles are configured at the application scope; translation tasks select a profile.
5. **Editing application infrastructure settings** (`DATABASE_PATH`, `DOCUMENTS_DIR`, port numbers) — environment configuration, not reader provider settings.
6. **Multi-user access control or role management** — out of scope. Single-user local reader.

---

## 7. Premise Critiques (Accepted & Addressed)

1. **"Settings should write to a config.yaml or .env file so the user can inspect it."**
   - *Rejected.* Plaintext files leak secrets into backups, version control, and disk caches. DS-BE-005 settled this: metadata belongs in SQLite, credentials belong in OS Keyring. The UI provides full inspection of non-secret metadata and masked keys.
2. **"An API key must be mandatory for all profiles."**
   - *Rejected.* Local models running under Ollama, LM Studio, or vLLM operate without authentication (`has_key: false`). Rejecting empty keys would break local-first workflows.
3. **"The settings dialog should automatically probe the endpoint whenever the URL or key changes."**
   - *Rejected.* Probing costs network traffic, latency, and potentially paid provider quota. All probes must be explicitly user-triggered.
4. **"Add a router (e.g. `#/settings`) for the settings page."**
   - *Rejected.* With 1.11 kB of headroom under the 310.0 kB ceiling, adding a router is impossible. An in-place modal dialog with `lazy()` dynamic import fits within the bundle ceiling without altering the shell layout.
5. **"Allow revealing the API key via a 'show password' eye icon."**
   - *Rejected.* The backend never returns the raw secret (`ProfileResponse` omits it by design). The client cannot reveal what it does not possess.

---

## 8. Traceability Matrix

| # | Dimension | Priority | Criteria |
|---|---|---|---|
| 1 | TopBar settings button trigger | P0 | AC-P0-01 |
| 2 | Code splitting & dynamic import | P0 | AC-P0-01, AC-P0-03 |
| 3 | Modal accessibility & focus trap | P0 | AC-P0-02 |
| 4 | Escape & backdrop dismissal | P0 | AC-P0-02 |
| 5 | Initial bundle ceiling (≤ 310.0 kB) | P0 | AC-P0-03 |
| 6 | Profile list retrieval (`GET /api/profiles`) | P0 | AC-P0-04 |
| 7 | Masked key display (`api_key_masked`) | P0 | AC-P0-05 |
| 8 | Visual badge distinction (Keyless vs Saved Key) | P0 | AC-P0-05 |
| 9 | Keyless profile creation (`has_key: false`) | P0 | AC-P0-06 |
| 10 | Profile creation with API key | P0 | AC-P0-07 |
| 11 | URL scheme & non-blank validation | P0 | AC-P0-08 |
| 12 | Edit profile — preserve key on metadata update | P0 | AC-P0-09 |
| 13 | Edit profile — replace key | P0 | AC-P0-10 |
| 14 | Edit profile — clear key (`api_key: ""`) | P0 | AC-P0-11 |
| 15 | Rejection of explicit `null` API key | P0 | AC-P0-12 |
| 16 | Profile deletion & keyring cleanup | P0 | AC-P0-13 |
| 17 | Active profile deletion & TranslateDialog safety | P0 | AC-P0-14 |
| 18 | Explicit on-demand probe (`POST /{id}/test`) | P0 | AC-P0-15 |
| 19 | Zero automatic probes on mount/save | P0 | AC-P0-15 |
| 20 | Provider probe error mapping (`PROVIDER_*`) | P0 | AC-P0-16 |
| 21 | End-to-end restart & reload durability | P0 | AC-P0-17 |
| 22 | Zero secret leakage across 5 surfaces | P0 | AC-P0-18 |
| 23 | Backend error envelopes (duplicate name, 503) | P0 | AC-P0-19 |
| 24 | Non-regression of existing suites | P0 | AC-P0-20 |
| 25 | Protocol auto-detection (`/detect-protocol`) | P1 | AC-P1-01 |
| 26 | Profile cloning affordance | P1 | AC-P1-02 |
| 27 | Responsive layout across desktop viewports | P1 | AC-P1-03 |
| 28 | Empty-state onboarding presets | P1 | AC-P1-04 |
| 29 | Unsaved changes dismissal guard | P1 | AC-P1-05 |
| 30 | Sanitized JSON export / import | P2 | AC-P2-01 |
| 31 | Custom headers editor | P2 | AC-P2-02 |
