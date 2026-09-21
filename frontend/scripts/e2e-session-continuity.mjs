/**
 * DS-DOC-004 — reloading, in a real browser, against a real backend.
 *
 * The criteria this exists for are the ones nothing else can measure: that a
 * reload brings the paper and its translation back, that it costs **zero provider
 * requests** (read from the backend's ledger, because the page cannot see a model
 * call), that it does not mint a second document row, and that a session whose
 * paper is gone lands in an empty workspace rather than a broken one.
 *
 * The translated artifact is not produced here. It is copied — the data
 * directory is a snapshot of a real one, and one of its documents already has a
 * `mono.pdf`. Verifying a restore must not require paying for a translation.
 *
 * Usage: node scripts/e2e-session-continuity.mjs
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const backendDir = join(repoRoot, "backend");
const python = join(backendDir, ".venv", "Scripts", "python.exe");
const workDir = join(repoRoot, ".agent", "results", "e2e-session-continuity");
const BACKEND_PORT = 8000;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const SESSION_KEY = "copilot:active_session_v1";

let PREVIEW_URL = "";
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function appDataDir() {
  return join(process.env.LOCALAPPDATA ?? "", "AcademicPDFCopilot");
}

/** The copy the harness runs against: real rows, real artifacts, no writes back. */
function prepare() {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(join(workDir, "documents"), { recursive: true });
  const real = appDataDir();
  for (const suffix of ["", "-wal", "-shm"]) {
    const from = join(real, `db.sqlite3${suffix}`);
    if (existsSync(from)) copyFileSync(from, join(workDir, `db.sqlite3${suffix}`));
  }
  const root = join(real, "documents");
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const target = join(workDir, "documents", entry.name);
    mkdirSync(target, { recursive: true });
    for (const name of ["source.pdf", "mono.pdf", "ir.json"]) {
      const from = join(root, entry.name, name);
      if (existsSync(from)) copyFileSync(from, join(target, name));
    }
  }
}

/** The one paper the snapshot holds: a real, registered ResNet. */
function sourcePaper() {
  const root = join(workDir, "documents");
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const candidate = join(root, entry.name, "source.pdf");
    if (entry.isDirectory() && existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * A translated artifact to stand in for one this run did not pay for.
 *
 * Restoring a translation must not require *making* one — that is the whole
 * point of the feature — so a `mono.pdf` produced by an earlier run is copied
 * onto the document this run registers. Real bytes from a real translation,
 * fetched back through the route the product uses.
 */
function donorTranslation() {
  const root = join(repoRoot, ".agent", "results");
  for (const suite of readdirSync(root, { withFileTypes: true })) {
    if (!suite.isDirectory()) continue;
    const documents = join(root, suite.name, "documents");
    if (!existsSync(documents)) continue;
    for (const entry of readdirSync(documents, { withFileTypes: true })) {
      const candidate = join(documents, entry.name, "mono.pdf");
      if (entry.isDirectory() && existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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
        LOG_LEVEL: "WARNING",
        CORS_ORIGINS: `http://127.0.0.1:${corsOrigin},http://localhost:${corsOrigin}`,
        // The ledger route exists only because this harness asked for it.
        ENABLE_PROVIDER_LEDGER: "1",
        PYTHONIOENCODING: "utf-8",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  return child;
}

function startPreview(port) {
  const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "preview", "--", "--port", String(port), "--strictPort"],
    { cwd: join(repoRoot, "frontend"), stdio: ["ignore", "pipe", "pipe"], shell: true });
  return child;
}

async function waitFor(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
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

const ledger = async () => (await fetch(`${BACKEND_URL}/api/_debug/provider-ledger`)).json();
const resetLedger = () => fetch(`${BACKEND_URL}/api/_debug/provider-ledger/reset`, { method: "POST" });
const documentCount = async () => (await (await fetch(`${BACKEND_URL}/api/documents`)).json()).length;

async function main() {
  prepare();
  const paper = sourcePaper();
  const donor = donorTranslation();
  if (!paper) {
    console.error("the snapshot holds no document to restore");
    process.exit(2);
  }
  if (!donor) {
    console.error("no translated artifact anywhere under .agent/results to seed with");
    process.exit(2);
  }
  console.log(`paper: ${paper}`);
  console.log(`translated artifact to seed with: ${donor}`);

  const previewPort = await freePort();
  const backend = startBackend(previewPort);
  if (!(await waitFor(`${BACKEND_URL}/api/health`))) {
    console.error("backend did not start");
    backend.kill();
    process.exit(2);
  }
  const preview = startPreview(previewPort);
  PREVIEW_URL = `http://127.0.0.1:${previewPort}`;
  if (!(await waitFor(PREVIEW_URL))) {
    console.error("preview did not start");
    preview.kill();
    backend.kill();
    process.exit(2);
  }
  console.log(`preview: ${PREVIEW_URL}\n`);

  const browser = await chromium.launch({ channel: "msedge" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    consoleErrors.push(`${m.text()} :: ${m.location()?.url ?? ""}`);
  });

  const seedSession = (record) => page.evaluate(
    ([key, value]) => window.localStorage.setItem(key, value),
    [SESSION_KEY, JSON.stringify(record)],
  );
  const storedSession = () => page.evaluate(
    (key) => window.localStorage.getItem(key), SESSION_KEY,
  );

  try {
    // --- 1. a window that has never opened anything ------------------------
    await page.goto(PREVIEW_URL, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="reader-workspace"]', { timeout: 30000 });
    check("a first visit opens on an empty workspace",
      (await page.locator('[data-testid="pdf-empty-state"]').count()) === 1);
    check("and stores nothing", (await storedSession()) === null);

    // --- 2. the reader opens the paper (a real registration) ----------------
    const sourceBefore = sha256(paper);
    await page.setInputFiles('[data-testid="pdf-file-input"]', paper);
    await page.waitForSelector('[data-testid="pdf-page-container"]', { timeout: 90000 });
    await page.waitForFunction(
      (key) => window.localStorage.getItem(key) !== null, SESSION_KEY, { timeout: 30000 },
    );
    const opened = JSON.parse(await storedSession());
    check("opening a paper writes the session down (AC-P0-01)",
      typeof opened.documentId === "string" && opened.documentId.startsWith("doc_"),
      opened.documentId);
    check("with the panel the reader is on", opened.outlinePanel === "overview");

    // Give the row a translated artifact without paying for one: the bytes come
    // from a translation an earlier run produced.
    copyFileSync(donor, join(workDir, "documents", opened.documentId, "mono.pdf"));

    // --- 3. the reader was in this paper, on page 3, in bilingual ----------
    // Opening the paper extracted it (the application loads the IR on
    // registration). Touching this file after the reload would mean the second
    // visit paid for the first visit's work again.
    const irPath = join(workDir, "documents", opened.documentId, "ir.json");
    for (let attempt = 0; attempt < 100 && !existsSync(irPath); attempt += 1) await sleep(300);
    const irBefore = statSync(irPath).mtimeMs;

    const rowsBefore = await documentCount();
    await resetLedger();
    await seedSession({
      schemaVersion: 1,
      documentId: opened.documentId,
      name: "resnet.pdf",
      activePage: 3,
      readerMode: "bilingual",
      outlinePanel: "notes",
      lastActiveAt: new Date().toISOString(),
    });
    const reloadStartedAt = Date.now();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="pdf-page-container"]', { timeout: 90000 });
    const reloadMs = Date.now() - reloadStartedAt;
    // Reported, not asserted: AC-P1-01's 300 ms covers page load, PDF.js parsing
    // and first paint of two documents, only one of which this task owns.
    console.log(`  [info] reload -> first page painted: ${reloadMs} ms`);

    const restored = await page.evaluate(
      (key) => {
        const raw = window.localStorage.getItem(key);
        return raw === null ? null : JSON.parse(raw);
      }, SESSION_KEY,
    );
    check("the paper is back without a gesture", restored?.documentId === opened.documentId,
      `${restored?.documentId}`);
    // The panel they left is notes, so the entry is not mounted yet — switching
    // to it is both the check for AC-P0-15 below and the fastest way to prove
    // the restored document has a reading entry at all.
    check("the panel they were on is the one that came back",
      (await page.locator('[data-testid="assistant-tabpanel-notes"]').count()) === 1);
    await page.click('[data-testid="assistant-tab-overview"]');
    await page.waitForSelector('[data-testid="overview-title"]', { timeout: 15000 });
    check("the reading entry renders for the restored paper",
      (await page.locator('[data-testid="overview-title"]').innerText()).length > 4);

    const calls = await ledger();
    check("restoring reached no provider", calls.calls === 0, JSON.stringify(calls));

    const rowsAfter = await documentCount();
    check("and minted no second document row", rowsAfter === rowsBefore,
      `${rowsBefore} -> ${rowsAfter}`);
    // Re-extraction would be invisible in the ledger (it is local inference, not
    // a provider call) and would make every reload cost seconds of CPU.
    const extractedAt = statSync(join(workDir, "documents", opened.documentId, "ir.json")).mtimeMs;
    check("and did not re-extract the paper", extractedAt === irBefore,
      `${Math.round(extractedAt)} vs ${Math.round(irBefore)}`);

    // --- 3. the translation came back, not a new one ------------------------
    await page.waitForSelector('[data-testid="viewer-translated"]', { timeout: 60000 });
    check("the translated pane is restored",
      (await page.locator('[data-testid="viewer-translated"]').count()) === 1);
    check("the reader is back in the mode they left",
      (await page.getAttribute('[data-testid="reader-workspace"]', "data-reader-mode")) === "bilingual");
    const restore = await ledger();
    check("and no translation was requested",
      restore.calls === 0, JSON.stringify(restore));

    // --- 4. the rest of the place ------------------------------------------
    // The original pane: the restored page belongs to the paper the reader was
    // reading, not to the translation's own pane.
    const pageInput = await page
      .locator('[data-testid="viewer-original"] [data-testid="page-number-input"]')
      .inputValue();
    check("the page they were on", Number(pageInput) === 3, `page ${pageInput}`);

    // --- 5. a session whose paper is gone ----------------------------------
    await seedSession({
      schemaVersion: 1, documentId: "doc_does_not_exist", name: "gone.pdf",
      activePage: 1, readerMode: "original", outlinePanel: "overview",
      lastActiveAt: new Date().toISOString(),
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="pdf-empty-state"]', { timeout: 30000 });
    check("a paper that is gone leaves an empty workspace",
      (await page.locator('[data-testid="pdf-empty-state"]').count()) === 1);
    check("and the stale session is cleared", (await storedSession()) === null);
    const notice = await page.locator('[data-testid="qa-jump-notice"]').innerText().catch(() => "");
    check("and the reader is told why", notice.includes("源文件已不可用"), notice.trim().slice(0, 40));

    // --- 6. the local service is not running --------------------------------
    await seedSession({
      schemaVersion: 1, documentId: opened.documentId, name: "resnet.pdf",
      activePage: 1, readerMode: "original", outlinePanel: "overview",
      lastActiveAt: new Date().toISOString(),
    });
    backend.kill();
    await sleep(1200);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="pdf-empty-state"]', { timeout: 30000 });
    check("an unreachable backend still renders the shell",
      (await page.locator('[data-testid="reader-workspace"]').count()) === 1);
    check("and keeps the session for the next reload", (await storedSession()) !== null);
    const engine = await page.locator('[data-testid="engine-status"]').innerText().catch(() => "");
    check("and says the local service is not connected", engine.includes("未连接"), engine.trim());

    /* Two scenarios below exist to make a request fail on purpose — a session
       whose paper is gone, and a backend that is not running — and the browser
       logs both. The filter names those two and nothing else, so a 404 on a
       document that *should* exist still fails the run. */
    const designed = (text) =>
      /ERR_CONNECTION_(RESET|REFUSED)/.test(text) ||
      text.includes("/api/documents/doc_does_not_exist") ||
      // The Overview panel's "nothing generated yet": a 404 that is the route's
      // answer, on both the session that has an overview and the one that does
      // not. The status and the route are both matched, so a 500 there fails.
      (/status of 404/.test(text) && /\/(overview|analysis)(\?|\s|$)/.test(text));
    check("no uncaught console errors during the run",
      consoleErrors.filter((text) => !designed(text)).length === 0,
      consoleErrors.slice(0, 2).join(" | "));
    check("the source PDF is byte-identical afterwards", sha256(paper) === sourceBefore);
  } finally {
    await browser.close();
    preview.kill();
    backend.kill();
  }

  const failed = results.filter((r) => !r.ok);
  writeFileSync(join(workDir, "results.json"),
    JSON.stringify({ results, passed: results.length - failed.length }, null, 1));
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
