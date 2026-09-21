/**
 * DS-FE-004 — the settings screen, in a real browser, against a real backend.
 *
 * The question this exists to answer is the reader's: *does configuring
 * something here actually persist and take effect?* The only honest way to
 * answer it is to do it, then **kill the backend, start it again, reload the
 * page, and look** — which is what the middle of this run does.
 *
 * ## What it deliberately does not do by default
 *
 * A profile's API key goes to the operating system's credential store, and this
 * process runs on the reader's real machine with their real store. So the
 * default run creates a **keyless** profile: nothing secret is written anywhere,
 * and everything else — the screen, the save, the restart, the deletion — is
 * verified end to end. The key-carrying half (the mask, `has_key`, and a probe
 * that resolves the key out of the store) runs only when the operator sets
 * `E2E_ALLOW_CREDENTIAL_WRITE=1`, because it writes a throwaway credential under
 * the application's own service name and the reader should get to decide that.
 * When it does run, it deletes what it made and says whether the deletion
 * succeeded (AC-P0-21).
 *
 * The endpoint the probe talks to is a stub on loopback: a probe against a real
 * provider with a throwaway key would fail with 401, which proves nothing.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const backendDir = join(repoRoot, "backend");
const python = join(backendDir, ".venv", "Scripts", "python.exe");
const workDir = join(repoRoot, ".agent", "results", "e2e-provider-settings");
const BACKEND_PORT = 8000;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const WITH_KEY = process.env.E2E_ALLOW_CREDENTIAL_WRITE === "1";
const SECRET = "sk-live-durable-key-98765432";

let PREVIEW_URL = "";
let credentialRefForCleanup = null;
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * A provider that answers, on loopback
 * ------------------------------------------------------------------ */

/**
 * The smallest thing that speaks enough of the protocol to be believed.
 *
 * Chat Completions answers with a completion; `/responses` 404s so protocol
 * detection falls back the way it does against a service that only implements
 * one of the two. Nothing here reaches the network.
 */
function startStubProvider(port) {
  const server = createHttpServer((request, response) => {
    const url = request.url ?? "";
    if (url.endsWith("/chat/completions") && request.method === "POST") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        id: "chatcmpl-stub", object: "chat.completion", created: 1, model: "stub-model",
        choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
      return;
    }
    if (url.endsWith("/models") && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: "stub-model", object: "model" }] }));
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not found" } }));
  });
  return new Promise((done) => {
    server.listen(port, "127.0.0.1", () => done(server));
  });
}

/* ------------------------------------------------------------------ *
 * Servers and fixtures
 * ------------------------------------------------------------------ */

/** A pristine data directory: this run creates everything it looks at. */
function prepare() {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(join(workDir, "documents"), { recursive: true });
}

function startBackend(corsOrigin) {
  const child = spawn(
    python,
    ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(BACKEND_PORT)],
    {
      cwd: backendDir,
      env: {
        ...process.env,
        DATABASE_PATH: join(workDir, "db.sqlite3"),
        DOCUMENTS_DIR: join(workDir, "documents"),
        LOG_LEVEL: "INFO",
        CORS_ORIGINS: `http://127.0.0.1:${corsOrigin},http://localhost:${corsOrigin}`,
        PYTHONIOENCODING: "utf-8",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  // Captured, because AC-P0-18 scans the log stream for the secret — a key that
  // reaches a log file has leaked even if it never reached the database.
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  return { child, log: () => output };
}

function startPreview(port) {
  return spawn(process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "preview", "--", "--port", String(port), "--strictPort"],
    { cwd: join(repoRoot, "frontend"), stdio: ["ignore", "pipe", "pipe"], shell: true });
}

async function waitFor(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch { /* not up yet */ }
    await sleep(300);
  }
  return false;
}

function freePort() {
  return new Promise((done) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

const listProfiles = async () => (await (await fetch(`${BACKEND_URL}/api/profiles`)).json());
const rawProfiles = async () => await (await fetch(`${BACKEND_URL}/api/profiles`)).text();

/**
 * Ask the machine's real credential store about one account.
 *
 * Read-only, and it never prints a secret — only whether one is there. This is
 * the only instrument that can answer "did the key really go to the operating
 * system, and did deleting the profile take it away again"; `cmdkey /list` does
 * not surface vault entries, and the API deliberately exposes no credential
 * reference at all.
 */
function keyringProbe(script) {
  return new Promise((done) => {
    const child = spawn(python, ["-c", script], {
      cwd: backendDir, env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => { out += String(chunk); });
    child.on("close", () => done(out.trim()));
    child.stderr.on("data", () => {});
  });
}

/** The credential reference the database holds for a profile — not the key. */
async function credentialRefOf(profileId) {
  const script = `
import json, sqlite3
connection = sqlite3.connect(r"${join(workDir, "db.sqlite3")}")
row = connection.execute("SELECT credential_ref FROM profiles WHERE id = ?", ("${profileId}",)).fetchone()
print(json.dumps({"ref": row[0] if row and row[0] else None}))
`;
  try {
    return JSON.parse(await keyringProbe(script)).ref;
  } catch {
    return null;
  }
}

async function credentialIsPresent(ref) {
  const script = `
import json, keyring
print(json.dumps({"present": keyring.get_password("AcademicPDFCopilot.profiles", "${ref}") is not None}))
`;
  try {
    return JSON.parse(await keyringProbe(script)).present;
  } catch {
    return null;
  }
}

async function main() {
  prepare();
  const stubPort = await freePort();
  const stub = await startStubProvider(stubPort);
  const endpoint = `http://127.0.0.1:${stubPort}/v1`;
  console.log(`stub provider: ${endpoint}`);
  console.log(`credential-store writes: ${WITH_KEY ? "ENABLED (throwaway, cleaned up)" : "disabled"}\n`);

  const previewPort = await freePort();
  let backend = startBackend(previewPort);
  if (!(await waitFor(`${BACKEND_URL}/api/health`))) {
    console.error("backend did not start");
    backend.child.kill();
    process.exit(2);
  }
  const preview = startPreview(previewPort);
  PREVIEW_URL = `http://127.0.0.1:${previewPort}`;
  if (!(await waitFor(PREVIEW_URL))) {
    console.error("preview did not start");
    preview.kill();
    backend.child.kill();
    process.exit(2);
  }

  const browser = await chromium.launch({ channel: "msedge" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    consoleErrors.push(`${m.text()} :: ${m.location()?.url ?? ""}`);
  });

  const openSettings = async () => {
    await page.click('[data-testid="settings-open"]');
    await page.waitForSelector('[data-testid="settings-dialog"]', { timeout: 30000 });
  };
  const fill = async ({ name, key }) => {
    await page.click('[data-testid="settings-new"]');
    await page.fill('[data-testid="settings-name"]', name);
    await page.fill('[data-testid="settings-base-url"]', endpoint);
    await page.fill('[data-testid="settings-model"]', "stub-model");
    if (key) await page.fill('[data-testid="settings-api-key"]', key);
    await page.click('[data-testid="settings-save"]');
    await page.waitForSelector('[data-testid="settings-profile-list"] li', { timeout: 15000 });
  };

  try {
    // --- 1. the screen, which until now opened nothing ---------------------
    await page.goto(PREVIEW_URL, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="reader-workspace"]', { timeout: 30000 });
    await openSettings();
    check("the settings button opens a screen",
      (await page.locator('[data-testid="settings-dialog"]').count()) === 1);
    check("which is empty on a machine with no provider",
      (await page.locator('[data-testid="settings-empty"]').count()) === 1);

    // --- 2. configuring a service ------------------------------------------
    await fill({ name: WITH_KEY ? "Stub-With-Key" : "Stub-Keyless", key: WITH_KEY ? SECRET : undefined });
    check("a new service appears in the list",
      (await page.locator('[data-testid="settings-profile-list"] li').count()) === 1);
    const created = (await listProfiles())[0];
    check("with the endpoint and model it was given",
      created.base_url === endpoint && created.model === "stub-model",
      `${created.base_url} · ${created.model}`);
    if (WITH_KEY) {
      check("a stored key is reported, and only as a mask",
        created.has_key === true && created.api_key_masked.endsWith("5432"),
        created.api_key_masked);
      check("and the raw key is nowhere in the response body",
        !(await rawProfiles()).includes(SECRET));
      // Where it actually went: not the profile row, but the operating system's
      // credential store, under a reference this harness now knows.
      const ref = await credentialRefOf(created.id);
      check("the key is in the operating system's credential store",
        ref !== null && (await credentialIsPresent(ref)) === true,
        ref === null ? "no credential reference" : `reference ${ref.slice(0, 9)}…`);
      credentialRefForCleanup = ref;
    } else {
      check("and a key was not required to save it", created.has_key === false);
      check("the list marks it as keyless",
        (await page.locator('[data-testid="settings-keyless-badge"]').count()) === 1);
    }

    // --- 3. the probe is a click, and it works ------------------------------
    await page.click('[data-testid="settings-profile-list"] li button');
    await page.waitForSelector('[data-testid="settings-form"]', { timeout: 15000 });
    await page.click('[data-testid="settings-test"]');
    await page.waitForSelector('[data-testid="settings-probe-result"]', { timeout: 60000 });
    const probe = await page.locator('[data-testid="settings-probe-result"]').innerText();
    check("testing the connection reaches the endpoint and says so",
      probe.includes("连接成功"), probe.trim().slice(0, 60));

    // --- 4. the reader's question: kill it, restart it, look ---------------
    const beforeRestart = await listProfiles();
    backend.child.kill();
    await sleep(1500);
    backend = startBackend(previewPort);
    if (!(await waitFor(`${BACKEND_URL}/api/health`))) {
      throw new Error("the restarted backend never came up");
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="reader-workspace"]', { timeout: 30000 });
    await openSettings();
    await page.waitForSelector('[data-testid="settings-profile-list"] li', { timeout: 15000 });

    const afterRestart = await listProfiles();
    check("the service survived a backend restart, reload and reopen",
      afterRestart.length === 1 &&
        afterRestart[0].name === beforeRestart[0].name &&
        afterRestart[0].base_url === beforeRestart[0].base_url &&
        afterRestart[0].model === beforeRestart[0].model,
      `${afterRestart.length} profile(s)`);
    if (WITH_KEY) {
      check("and the key came back from the operating system's store",
        afterRestart[0].has_key === true &&
          afterRestart[0].api_key_masked === beforeRestart[0].api_key_masked,
        afterRestart[0].api_key_masked);
      // The one that matters: the credential is not in the profile row, so a
      // probe only succeeds if the store still resolves it.
      await page.click('[data-testid="settings-profile-list"] li button');
      await page.waitForSelector('[data-testid="settings-form"]', { timeout: 15000 });
      await page.click('[data-testid="settings-test"]');
      await page.waitForSelector('[data-testid="settings-probe-result"]', { timeout: 60000 });
      const after = await page.locator('[data-testid="settings-probe-result"]').innerText();
      check("a probe after the restart still resolves the stored key",
        after.includes("连接成功"), after.trim().slice(0, 60));
    } else {
      check("and no key exists to come back", afterRestart[0].has_key === false);
    }

    // --- 5. no secret anywhere --------------------------------------------
    if (WITH_KEY) {
      const dbBytes = ["db.sqlite3", "db.sqlite3-wal", "db.sqlite3-shm"]
        .map((name) => join(workDir, name))
        .filter((path) => existsSync(path))
        .map((path) => readFileSync(path).toString("latin1"))
        .join("");
      const storage = await page.evaluate(() => {
        const out = [];
        for (let index = 0; index < window.localStorage.length; index += 1) {
          const key = window.localStorage.key(index);
          out.push(key, window.localStorage.getItem(key) ?? "");
        }
        return out.join("\n");
      });
      const html = await page.content();
      check("the key is not in the database", !dbBytes.includes(SECRET));
      check("the key is not in localStorage", !storage.includes(SECRET));
      check("the key is not in the rendered page", !html.includes(SECRET));
      check("the key is not in the backend's log stream", !backend.log().includes(SECRET));
      check("the key is not in any console output",
        !consoleErrors.some((text) => text.includes(SECRET)));
    }

    // --- 6. deleting, and leaving nothing behind (AC-P0-21) ----------------
    // The dialog reopened on a list rather than on the profile it had selected,
    // so the delete affordance lives behind selecting one again.
    await page.click('[data-testid="settings-profile-list"] li button');
    await page.waitForSelector('[data-testid="settings-delete"]', { timeout: 15000 });
    await page.click('[data-testid="settings-delete"]');
    await page.click('[data-testid="settings-delete-confirm"]');
    await page.waitForSelector('[data-testid="settings-empty"]', { timeout: 15000 });
    const remaining = await listProfiles();
    check("deleting removes the service", remaining.length === 0, `${remaining.length} left`);
    if (credentialRefForCleanup !== null) {
      check("and takes its credential out of the operating system's store",
        (await credentialIsPresent(credentialRefForCleanup)) === false,
        "the same reference reads as absent");
    }
    const digest = createHash("sha256").update(readFileSync(join(workDir, "db.sqlite3"))).digest("hex");
    check("and leaves a database with no trace of it",
      !readFileSync(join(workDir, "db.sqlite3")).toString("latin1").includes("Stub-"),
      `db sha256 ${digest.slice(0, 12)}`);

    check("no uncaught console errors during the run", consoleErrors.length === 0,
      consoleErrors.slice(0, 2).join(" | "));
  } finally {
    await browser.close();
    preview.kill();
    backend.child.kill();
    stub.close();
  }

  const failed = results.filter((r) => !r.ok);
  mkdirSync(workDir, { recursive: true });
  writeFileSync(join(workDir, "results.json"),
    JSON.stringify({ with_key: WITH_KEY, results, passed: results.length - failed.length }, null, 1));
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
