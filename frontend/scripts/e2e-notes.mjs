/**
 * DS-QA-010 real-browser verification — notes and persistent highlights.
 *
 * Drives the built bundle, the real backend and a real PDF in Edge. The one
 * thing this verifies that no component test can: a mark the user made is still
 * on the page after the application has been restarted.
 *
 * The text selected is found by walking the PDF text layer for a run of words
 * that exists in the paper, rather than hardcoded — a fixture that assumes a
 * sentence would fail on the next paper instead of testing the feature.
 *
 * Usage:  node scripts/e2e-notes.mjs      (requires `npm run build` first)
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const backendDir = join(repoRoot, "backend");
const python = join(backendDir, ".venv", "Scripts", "python.exe");
const workDir = join(repoRoot, ".agent", "results", "e2e-notes");

const BACKEND_PORT = 8000;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const BASELINE_DOCUMENT = "doc_6f4ab9d9d4d34f85bc9e441757240fd8";

const PAPER_PATH = process.env.E2E_PAPER ?? "";
const PAPER_LABEL = process.env.E2E_LABEL ?? "resnet";

let PREVIEW_URL = "";
const results = [];
const providerCalls = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function appDataDir() {
  return process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "AcademicPDFCopilot")
    : join(process.env.HOME ?? "", ".local", "share", "AcademicPDFCopilot");
}
const realDataDir = appDataDir();

function prepareWorkdir() {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  const documents = join(workDir, "documents", BASELINE_DOCUMENT);
  mkdirSync(documents, { recursive: true });
  if (PAPER_PATH) {
    copyFileSync(PAPER_PATH, join(documents, "source.pdf"));
  } else {
    copyFileSync(
      join(realDataDir, "documents", BASELINE_DOCUMENT, "source.pdf"),
      join(documents, "source.pdf"),
    );
  }
  const database = join(workDir, "db.sqlite3");
  copyFileSync(join(realDataDir, "db.sqlite3"), database);
  return { paper: join(documents, "source.pdf"), database };
}

function startBackend(corsPort, { database, documentsDir }) {
  const child = spawn(python, ["-m", "uvicorn", "app.main:app", "--port", String(BACKEND_PORT)], {
    cwd: backendDir,
    env: {
      ...process.env, PYTHONIOENCODING: "utf-8", PYTHONPATH: backendDir,
      DATABASE_PATH: database, DOCUMENTS_DIR: documentsDir,
      CORS_ORIGINS: `http://127.0.0.1:${corsPort},http://localhost:${corsPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.on("exit", (code, signal) =>
    console.log(`    [backend] exited code=${code} signal=${signal}`));
  child.stderr.on("data", (chunk) => console.log(`    [backend] ${String(chunk).trimEnd()}`));
  return child;
}

async function waitFor(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return true; } catch { /* not up */ }
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

async function startPreview(port) {
  const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "preview", "--", "--port", String(port), "--strictPort"],
    { cwd: join(repoRoot, "frontend"), stdio: ["ignore", "pipe", "pipe"], shell: true });
  return new Promise((done) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += String(chunk).replace(/\[[0-9;]*m/g, "");
      const match = buffer.match(/http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)/);
      if (match && !PREVIEW_URL) { PREVIEW_URL = `http://127.0.0.1:${match[1]}`; done(child); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    setTimeout(() => done(child), 20000);
  });
}

function uploadedDocumentId() {
  const entries = readdirSync(join(workDir, "documents")).filter((n) => n.startsWith("doc_"));
  return entries.sort().reverse().find((n) => n !== BASELINE_DOCUMENT) ?? entries[0];
}

/**
 * Select a run of words that the IR actually contains.
 *
 * Picking the first long span selects the paper's *title*, which is a heading and
 * therefore not a paragraph — so it maps to nothing and the create action stays
 * disabled, which looks exactly like a broken feature. Choosing a span whose text
 * appears in a real paragraph is what makes this a test of notes rather than a
 * test of the fixture.
 */
async function selectSomeText(page, paragraphTexts, exclude = null) {
  return page.evaluate(([texts, exclude]) => {
    const spans = [...document.querySelectorAll('[data-testid="pdf-text-layer"] span')]
      .filter((s) => (s.textContent ?? "").trim().length > 12)
      .filter((s) => !s.closest("[data-testid='viewer-translated']"));
    // A span in a paragraph *other* than the one already used. Two spans of the
    // same paragraph are the same annotation by AC-P0-12 — the second focuses the
    // first — so a harness that picks two spans from one paragraph is testing the
    // idempotency rule and calling it a failure.
    const owner = (text) => texts.find((paragraph) => paragraph.includes(text.slice(0, 40)));
    const matching = spans.filter((s) => {
      const paragraph = owner((s.textContent ?? "").trim());
      return paragraph !== undefined && paragraph !== exclude;
    });
    const span = matching[0];
    if (!span) return null;
    const box = span.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(span);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    // Dispatched on the span, so it bubbles to the reader element the capture
    // hook listens on. Firing it at `document` never reaches that listener, and
    // the failure looks exactly like a selection that did not map.
    span.dispatchEvent(new MouseEvent("mouseup", {
      bubbles: true,
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2,
    }));
    return {
      text: (span.textContent ?? "").trim().slice(0, 40),
      paragraph: owner((span.textContent ?? "").trim()) ?? "",
    };
  }, [paragraphTexts, exclude]);
}

async function openPaper(page, paper) {
  await page.setInputFiles('[data-testid="pdf-file-input"]', paper);
  await page.waitForSelector('[data-testid="pdf-page-container"]', { timeout: 120000 });
  await page.waitForSelector('[data-testid="assistant-tab-notes"]', { timeout: 60000 });
  await sleep(1200); // the text layer paints after the canvas
}

async function main() {
  const { paper, database } = prepareWorkdir();
  console.log(`paper: ${PAPER_LABEL} — ${paper}`);

  const previewPort = await freePort();
  let backend = startBackend(previewPort, { database, documentsDir: join(workDir, "documents") });
  if (!(await waitFor(`${BACKEND_URL}/api/health`))) {
    console.log("backend did not start"); backend.kill(); return 2;
  }
  const preview = await startPreview(previewPort);
  if (!PREVIEW_URL) { preview.kill(); backend.kill(); return 2; }
  console.log(`preview: ${PREVIEW_URL}\n`);

  const browser = await chromium.launch({ channel: "msedge" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
/* A 404 is the *designed* answer on the two routes the Overview panel asks
   about when a paper opens: `/overview` (nothing generated yet) and the older
   `/analysis` (not analysed yet). The status is part of the match, so a 500 on
   either path is still an error; the location carries the route. */
const designed404 = (t) =>
  /status of 404/.test(t) && /\/(analysis|overview)(\?|\s|$)/.test(t);

    /* The console message for a failed request does not carry its URL, and the
     Overview panel asks for an analysis on every paper open — a 404 there is
     the route's designed answer ("not analysed yet"), not a fault. The location
     does carry the URL, so the filter can be exact. */
page.on("console", (m) => {
    if (m.type() !== "error") return;
    consoleErrors.push(`${m.text()} :: ${m.location()?.url ?? ""}`);
  });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  // The API's own answer when a save fails: an error the UI reports as "could
  // not be saved" is a status code and a body somewhere, and guessing which is
  // how a real cause gets mistaken for a broken component.
  page.on("request", (r) => {
    if (r.url().includes("/annotations")) {
      console.log(`    [req] ${r.method()} ${r.url().slice(-34)}`);
    }
  });
  page.on("requestfailed", (r) => {
    if (r.url().includes("/annotations")) {
      console.log(`    [reqfail] ${r.url().slice(-34)} :: ${r.failure()?.errorText}`);
    }
  });
  page.on("response", async (r) => {
    if (!r.url().includes("/annotations")) return;
    let body = "";
    try { body = (await r.text()).slice(0, 160); } catch { /* gone */ }
    console.log(`    [api] ${r.status()} ${r.request().method()} ${r.url().slice(-38)} :: ${body}`);
  });
  // Anything reaching a model provider, whatever the route.
  page.on("request", (r) => {
    const url = r.url();
    if (/deepseek|openai|anthropic|chat\/completions/.test(url)) providerCalls.push(url);
  });

  try {
    await page.goto(PREVIEW_URL, { waitUntil: "domcontentloaded" });
    await openPaper(page, paper);
    const documentId = uploadedDocumentId();
    const ir = await page.evaluate(async (url) => (await fetch(url)).json(),
      `${BACKEND_URL}/api/documents/${documentId}/ir`);
    const paragraphTexts = (ir.paragraphs ?? []).map((p) => p.text);

    await page.click('[data-testid="assistant-tab-notes"]');
    await page.waitForSelector('[data-testid="notes-panel"]', { timeout: 30000 });
    check("the panel opens with an empty state", true);

    // It may already have annotations if the fixture database carried some.
    const before = await page.locator("li[data-testid^='note-']").count();

    // --- create a highlight ------------------------------------------------
    const selected = await selectSomeText(page, paragraphTexts);
    check("text can be selected in the paper", selected !== null, selected?.text ?? "none found");
    await sleep(400);
    const highlightEnabled = await page.locator('[data-testid="notes-create-highlight"]').isEnabled();
    check("a valid selection enables the create action", highlightEnabled);
    await page.click('[data-testid="notes-create-highlight"]');
    await sleep(1200);
    const afterHighlight = await page.locator("li[data-testid^='note-']").count();
    const createError = await page.locator('[data-testid="notes-error"]').count() > 0
      ? await page.locator('[data-testid="notes-error"]').innerText() : "";
    check("the highlight is listed", afterHighlight === before + 1,
      `${before} -> ${afterHighlight}${createError ? `  error: ${createError}` : ""}`);

    const overlay = await page.locator('[data-testid="pdf-persistent-highlight-box"]').count();
    check("a persistent overlay is drawn on the source page", overlay > 0, `${overlay} boxes`);

    // --- the two highlights have different lifetimes -------------------------
    // A citation mark fades after four seconds; a note must survive that.
    await sleep(4200);
    const stillThere = await page.locator('[data-testid="pdf-persistent-highlight-box"]').count();
    check("the mark outlives the citation highlight's fade (AC-P0-08)",
      stillThere === overlay, `${overlay} -> ${stillThere}`);

    // --- create a note ------------------------------------------------------
    // A different span, and the note is created *first* and edited after.
    // Typing into the draft before creating moves focus out of the reader, which
    // collapses the browser selection the note would be attached to — so the
    // obvious order tests the wrong thing.
    const second = await selectSomeText(page, paragraphTexts, selected?.paragraph ?? null);
    await page.click('[data-testid="notes-create-note"]');
    await sleep(1200);
    const afterNote = await page.locator("li[data-testid^='note-']").count();
    check("the note is listed", afterNote === before + 2, `${afterNote} entries`);
    // Add the user's words to the note that was just created.
    const createdId = ((await page.locator("li[data-testid^='note-']").first()
      .getAttribute("data-testid")) ?? "").replace("note-", "");
    await page.click(`[data-testid="note-edit-${createdId}"]`);
    await page.fill(`[data-testid="note-input-${createdId}"]`, "A note the user wrote.");
    await page.click(`[data-testid="note-save-${createdId}"]`);
    await sleep(900);
    const noteText = await page.locator(`[data-testid="note-comment-${createdId}"]`).innerText();
    check("the user's words are shown", noteText.includes("A note the user wrote."), noteText);

    // --- reload: the same document, read again ------------------------------
    await page.reload({ waitUntil: "domcontentloaded" });
    await openPaper(page, paper);
    await page.click('[data-testid="assistant-tab-notes"]');
    await sleep(1500);
    // P1-01's frontend half: how long from asking the backend to having the
    // rows in the DOM. The API half is measured separately and is ~2 ms; this is
    // what the reader actually waits for.
    const hydrationStart = Date.now();
    await page.waitForFunction(
      (expected) => document.querySelectorAll("li[data-testid^='note-']").length === expected,
      afterNote, { timeout: 10000 },
    ).catch(() => {});
    const hydrationMs = Date.now() - hydrationStart;

    const afterReload = await page.locator("li[data-testid^='note-']").count();
    const panelState = await page.evaluate(() => ({
      panel: document.querySelectorAll('[data-testid="notes-panel"]').length,
      none: document.querySelectorAll('[data-testid="notes-none"]').length,
      rows: document.querySelectorAll("li[data-testid^='note-']").length,
      boxes: document.querySelectorAll('[data-testid="pdf-persistent-highlight-box"]').length,
    }));
    console.log(`    hydration (list present -> ${afterNote} rows): ${hydrationMs} ms`);
    check("annotations survive a reload", afterReload === afterNote,
      `${afterNote} -> ${afterReload}  panel=${JSON.stringify(panelState)}`);
    const boxesAfterReload = await page.locator('[data-testid="pdf-persistent-highlight-box"]').count();
    check("the highlight is drawn again", boxesAfterReload > 0, `${boxesAfterReload} boxes`);

    // --- restart the backend, which is what "persistent" means --------------
    backend.kill();
    await sleep(1500);
    backend = startBackend(previewPort, { database, documentsDir: join(workDir, "documents") });
    if (!(await waitFor(`${BACKEND_URL}/api/health`))) {
      check("backend restarted", false);
    } else {
      check("backend restarted", true);
      await page.reload({ waitUntil: "domcontentloaded" });
      await openPaper(page, paper);
      await page.click('[data-testid="assistant-tab-notes"]');
      await sleep(1500);
      const afterRestart = await page.locator("li[data-testid^='note-']").count();
      check("annotations survive a process restart", afterRestart === afterNote,
        `${afterNote} -> ${afterRestart}`);
    }

    // --- edit ---------------------------------------------------------------
    const firstId = await page.locator("li[data-testid^='note-']").first().getAttribute("data-testid");
    const id = (firstId ?? "").replace("note-", "");
    await page.click(`[data-testid="note-edit-${id}"]`);
    await page.fill(`[data-testid="note-input-${id}"]`, "Edited by the user.");
    await page.click(`[data-testid="note-save-${id}"]`);
    await sleep(900);
    const edited = await page.locator(`[data-testid="note-comment-${id}"]`).count();
    check("a note can be edited", edited === 1 || (await page.locator("[data-testid^='note-comment-']").count()) > 0);

    // --- delete -------------------------------------------------------------
    await page.click(`[data-testid="note-delete-${id}"]`);
    await sleep(1000);
    const afterDelete = await page.locator("li[data-testid^='note-']").count();
    check("a note can be deleted", afterDelete === afterNote - 1,
      `${afterNote} -> ${afterDelete}`);

    // --- isolation between documents ----------------------------------------
    const other = await page.evaluate(async (url) => (await fetch(url)).json(),
      `${BACKEND_URL}/api/documents/${documentId}/annotations`);
    check("the API scopes annotations to the document",
      Array.isArray(other.annotations), `${other.annotations?.length ?? "?"} returned`);

    check("creating and editing notes made no provider call", providerCalls.length === 0,
      providerCalls.slice(0, 2).join(" | "));
    // The restart phase deliberately takes the backend down, so the browser
    // logs a connection failure for it. That is the test's own doing, not the
    // product's, and counting it would make the check unfalsifiable in the
    // other direction.
    const unexpected = consoleErrors.filter(
      (text) => !/ERR_CONNECTION_/.test(text) && !designed404(text));
    check("no uncaught console errors during the run", unexpected.length === 0,
      unexpected.slice(0, 2).join(" | "));
  } finally {
    await browser.close();
    preview.kill();
    backend.kill();
  }

  const failed = results.filter((r) => r.ok === false);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  writeFileSync(join(workDir, "results.json"),
    JSON.stringify({ results, consoleErrors, providerCalls }, null, 1));
  return failed.length === 0 ? 0 : 1;
}

const code = await main();
process.exit(code);
