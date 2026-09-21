/**
 * DS-DOC-005 — the library, in a real browser, against a real backend.
 *
 * What this exists for is the pair of claims a component test cannot make: that
 * switching papers in the browser **adopts** the row it was already given (no
 * second registration, no second extraction, no provider request), and that
 * deleting a paper removes its artifacts while leaving the reader's notes alone —
 * because the notes are keyed to the bytes and the row is not.
 *
 * The translated artifact and its task row are **seeded**, not produced: making
 * one would mean paying for a translation, and verifying a list must not. Both
 * are read back through the product's own routes.
 *
 * Usage: node scripts/e2e-document-library.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const backendDir = join(repoRoot, "backend");
const python = join(backendDir, ".venv", "Scripts", "python.exe");
const workDir = join(repoRoot, ".agent", "results", "e2e-document-library");
const BACKEND_PORT = 8000;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const FIRST = join(repoRoot, ".agent", "results", "e2e-qa", "resnet.pdf");
const SECOND = join(repoRoot, ".agent", "results", "crosspage", "fixture.pdf");

let PREVIEW_URL = "";
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function prepare() {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(join(workDir, "documents"), { recursive: true });
}

/** A python one-liner against this run's own database — never a secret. */
function py(script) {
  return new Promise((done) => {
    const child = spawn(python, ["-c", script], {
      cwd: backendDir,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONPATH: backendDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => { out += String(chunk); });
    child.stderr.on("data", () => {});
    child.on("close", () => done(out.trim()));
  });
}

const dbPath = join(workDir, "db.sqlite3");

/** A translated artifact and the successful task row that explains it. */
async function seedTranslation(documentId, contentHash) {
  const donor = (() => {
    for (const suite of readdirSync(join(repoRoot, ".agent", "results"), { withFileTypes: true })) {
      const documents = join(repoRoot, ".agent", "results", suite.name, "documents");
      if (!suite.isDirectory() || !existsSync(documents)) continue;
      for (const entry of readdirSync(documents, { withFileTypes: true })) {
        const candidate = join(documents, entry.name, "mono.pdf");
        if (entry.isDirectory() && existsSync(candidate)) return candidate;
      }
    }
    return null;
  })();
  if (!donor) return false;
  copyFileSync(donor, join(workDir, "documents", documentId, "mono.pdf"));

  const now = new Date().toISOString();
  await py(`
import sqlite3, uuid
connection = sqlite3.connect(r"${dbPath}")
connection.execute(
    "INSERT INTO translation_tasks (id, document_id, profile_id, status, lang_in, lang_out,"
    " engine, created_at, updated_at) VALUES (?, ?, ?, 'SUCCESS', 'en', 'zh-CN', 'fast', ?, ?)",
    ("task_" + uuid.uuid4().hex, "${documentId}", "prof_seeded", r"${now}", r"${now}"),
)
connection.commit()
print("seeded")
`);
  return true;
}

/** A note the reader wrote, keyed to the paper's bytes. */
async function seedNote(contentHash, documentId, quote) {
  return await py(`
import sqlite3, uuid, datetime
connection = sqlite3.connect(r"${dbPath}")
now = datetime.datetime.now(datetime.timezone.utc).isoformat()
annotation = "ann_" + uuid.uuid4().hex
connection.execute(
    "INSERT INTO annotations (id, content_hash, document_id, kind, color, quote, comment,"
    " created_at, updated_at) VALUES (?, ?, ?, 'note', '#fff', ?, 'my own note', ?, ?)",
    (annotation, "${contentHash}", "${documentId}", r"${quote}", now, now),
)
connection.execute(
    "INSERT INTO annotation_targets (id, annotation_id, source_anchor_id, anchor_version,"
    " page_number, original_bbox, rects, exact_quote, prefix, suffix)"
    " VALUES (?, ?, 'a1', '1', 1, '0,0,1,1', '0,0,1,1', ?, '', '')",
    ("tgt_" + uuid.uuid4().hex, annotation, r"${quote}"),
)
connection.commit()
print("noted")
`);
}

const notesFor = async (contentHash) =>
  Number(await py(`
import sqlite3
print(sqlite3.connect(r"${dbPath}").execute(
    "SELECT COUNT(*) FROM annotations WHERE content_hash = ?", ("${contentHash}",)).fetchone()[0])
`));

function startBackend(corsOrigin) {
  const child = spawn(
    python,
    ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(BACKEND_PORT)],
    {
      cwd: backendDir,
      env: {
        ...process.env,
        DATABASE_PATH: dbPath,
        DOCUMENTS_DIR: join(workDir, "documents"),
        LOG_LEVEL: "WARNING",
        CORS_ORIGINS: `http://127.0.0.1:${corsOrigin},http://localhost:${corsOrigin}`,
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

const ledger = async () => (await fetch(`${BACKEND_URL}/api/_debug/provider-ledger`)).json();
const rows = async () => (await (await fetch(`${BACKEND_URL}/api/documents`)).json());

async function main() {
  prepare();
  const previewPort = await freePort();
  const backend = startBackend(previewPort);
  if (!(await waitFor(`${BACKEND_URL}/api/health`))) {
    console.error("backend did not start");
    backend.kill();
    process.exit(2);
  }
  const preview = spawn(process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "preview", "--", "--port", String(previewPort), "--strictPort"],
    { cwd: join(repoRoot, "frontend"), stdio: ["ignore", "pipe", "pipe"], shell: true });
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

  /* Opening the second paper cannot wait on the page stack — the first paper's
     is still there — so it waits on what actually changes: a new row. */
  const openPaper = async (path) => {
    const before = (await rows()).length;
    await page.setInputFiles('[data-testid="pdf-file-input"]', path);
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      if ((await rows()).length > before) return;
      await sleep(250);
    }
    throw new Error(`opening ${path} registered no document`);
  };
  const openLibrary = async () => {
    await page.click('[data-testid="library-open"]');
    await page.waitForSelector('[data-testid="library-dialog"]', { timeout: 30000 });
    await page.waitForSelector('[data-testid="library-list"], [data-testid="library-empty"]', { timeout: 30000 });
  };

  try {
    // --- 1. two papers, registered the only way that exists ----------------
    await page.goto(PREVIEW_URL, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="reader-workspace"]', { timeout: 30000 });
    await openPaper(FIRST);
    const first = (await rows()).find((row) => row.page_count === 12) ?? (await rows())[0];
    await openPaper(SECOND);
    const all = await rows();
    check("two papers are registered", all.length === 2, `${all.length} row(s)`);

    // --- 2. the list, and what a row says ----------------------------------
    await openLibrary();
    const listing = await page.locator('[data-testid="library-list"] li').count();
    check("the library lists both", listing === 2, `${listing} row(s)`);
    const current = await page.locator('[data-current="true"]').count();
    check("and marks the one on screen as the one being read", current === 1, `${current} marked`);

    // The second paper is the one open; open the first from the list.
    const before = (await rows()).length;
    await page.click(`[data-testid="library-open-${first.document_id}"]`);
    await page.waitForSelector('[data-testid="library-dialog"]', { state: "detached", timeout: 60000 });
    await page.waitForFunction(
      (name) => document.querySelector('[data-testid="document-name"]')?.textContent?.includes(name.slice(0, 8)),
      first.name,
      { timeout: 60000 },
    );
    check("switching papers from the library opens that paper",
      (await page.locator('[data-testid="document-name"]').innerText()).includes(first.name.slice(0, 8)),
      first.name);

    const afterSwitch = await rows();
    check("and adopts the row instead of registering a new one",
      afterSwitch.length === before, `${before} -> ${afterSwitch.length}`);
    const calls = await ledger();
    check("switching reached no provider", calls.calls === 0, JSON.stringify(calls));

    // --- 3. the record, seeded rather than paid for -------------------------
    const hash = await py(`
import json, pathlib
print(json.loads(pathlib.Path(r"${join(workDir, "documents", first.document_id, "ir.json")}").read_text(encoding="utf-8"))["content_hash"])
`);
    const seeded = await seedTranslation(first.document_id, hash);
    check("a translated artifact and its task row exist to read", seeded);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="pdf-page-container"]', { timeout: 90000 });
    await openLibrary();
    const line = page.locator(`[data-testid="library-row-${first.document_id}"]`);
    check("the row reports the translation", (await line.locator('[data-testid="library-translated"]').count()) === 1);
    const record = await line.locator('[data-testid="library-record"]').innerText();
    check("with the language pair, the engine and when", record.includes("en → zh") && record.includes("fast"),
      record.trim());
    const rowText = await line.innerText();
    check("and it claims no model, no tokens and no latency",
      !/token|ms\b/i.test(rowText) && !/deepseek/i.test(rowText), rowText.replace(/\s+/g, " ").slice(0, 80));

    // --- 4. the notes a deletion must not take -----------------------------
    await seedNote(hash, first.document_id, "the sentence I underlined");
    const notesBefore = await notesFor(hash);
    check("a note is on that paper", notesBefore === 1, `${notesBefore}`);

    await page.click(`[data-testid="library-delete-${first.document_id}"]`);
    const confirm = await page.locator(`[data-testid="library-confirm-${first.document_id}"]`).innerText();
    check("the confirmation says the notes and the overview cache survive",
      confirm.includes("笔记与概览缓存会保留"));
    await page.click(`[data-testid="library-delete-confirm-${first.document_id}"]`);
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="library-list"] li').length === 1,
      null,
      { timeout: 30000 },
    );
    check("deleting removes the row", (await rows()).length === 1, `${(await rows()).length} left`);
    check("and the artifact with it",
      !existsSync(join(workDir, "documents", first.document_id, "mono.pdf")));
    const notesAfter = await notesFor(hash);
    check("but not the reader's notes", notesAfter === notesBefore, `${notesBefore} -> ${notesAfter}`);

    await page.keyboard.press("Escape");
    await sleep(300);

    // --- 5. the other door: the top bar's search field ----------------------
    await page.click('[data-testid="paper-search"]');
    await page.waitForSelector('[data-testid="library-dialog"]', { timeout: 15000 });
    const typed = await page.locator('[data-testid="library-search-input"]').count();
    check("the top bar's search field opens the library", typed === 1);
    await page.fill('[data-testid="library-search-input"]', "zzz-no-such-paper");
    await page.waitForSelector('[data-testid="library-no-match"]', { timeout: 15000 });
    check("and typing in the list filters it", true);

    const finalCalls = await ledger();
    check("nothing in the whole run reached a provider", finalCalls.calls === 0, JSON.stringify(finalCalls));
    /* The Overview panel's designed "nothing generated yet" answer, on both
       papers this run opens. Status and route are both matched, so a 500 there
       still fails the run. */
    const designed = (text) =>
      /status of 404/.test(text) && /\/(overview|analysis)(\?|\s|$)/.test(text);
    check("no uncaught console errors during the run",
      consoleErrors.filter((text) => !designed(text)).length === 0,
      consoleErrors.slice(0, 2).join(" | "));
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
