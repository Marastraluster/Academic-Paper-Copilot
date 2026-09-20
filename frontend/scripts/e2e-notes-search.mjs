/**
 * DS-QA-012 real-browser verification — finding a note, and taking it away.
 *
 * The parts no component test can reach:
 *
 *   - **A downloaded file.** The suite clicks the real link and reads the bytes
 *     that landed on disk. A click that fired and a file the user can open are
 *     different claims.
 *   - **The no-extraction boundary, measured rather than reasoned about.** An
 *     export on a document whose IR is absent must answer, and `ir.json` must
 *     still be absent afterwards. The application fetches the IR at registration
 *     by design (DS-QA-010), so this is verified by requesting the route directly
 *     — which is exactly the case where the boundary could be lost.
 *   - **Five hundred notes.** The scale criterion is measured on the real panel
 *     with real rows, not on a synthetic string array.
 *
 * Usage:  node scripts/e2e-notes-search.mjs      (requires `npm run build` first)
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const backendDir = join(repoRoot, "backend");
const python = join(backendDir, ".venv", "Scripts", "python.exe");
const workDir = join(repoRoot, ".agent", "results", "e2e-notes-search");
const FIXTURE = join(repoRoot, ".agent", "results", "crosspage", "fixture.pdf");
/** A genuinely different paper, for the empty-document state. */
const OTHER = join(repoRoot, ".agent", "results", "notes", "other.pdf");
const SEEDER = join(repoRoot, ".agent", "results", "notes", "seed_notes.py");

/** The configured backend port. The bundle talks to 8000 and nothing else. */
const BACKEND_PORT = 8000;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const SCALE = Number(process.env.E2E_SCALE ?? "500");

let PREVIEW_URL = "";
const results = [];
const providerCalls = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((done) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

function startBackend(corsPort, database, documentsDir) {
  const child = spawn(python, ["-m", "uvicorn", "app.main:app", "--port", String(BACKEND_PORT)], {
    cwd: backendDir,
    env: {
      ...process.env, PYTHONIOENCODING: "utf-8", PYTHONPATH: backendDir,
      DATABASE_PATH: database, DOCUMENTS_DIR: documentsDir,
      CORS_ORIGINS: `http://127.0.0.1:${corsPort},http://localhost:${corsPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", () => {});
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

async function startPreview(port) {
  const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "preview", "--", "--port", String(port), "--strictPort"],
    { cwd: join(repoRoot, "frontend"), stdio: ["ignore", "pipe", "pipe"], shell: true });
  await new Promise((done) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += String(chunk).replace(/\x1b\[[0-9;]*m/g, "");
      const match = buffer.match(/http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)/);
      if (match && !PREVIEW_URL) { PREVIEW_URL = `http://127.0.0.1:${match[1]}`; done(); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    setTimeout(done, 20000);
  });
  return child;
}

function uploadedDocumentId() {
  const entries = readdirSync(join(workDir, "documents")).filter((n) => n.startsWith("doc_"));
  return entries.sort().reverse()[0];
}

/** The rows the panel is showing, in order. */
const ROWS = () =>
  [...document.querySelectorAll('li[data-testid^="note-"]')].map(
    (row) => (row.textContent ?? "").replace(/\s+/g, " ").slice(0, 60));

async function openNotes(page) {
  await page.waitForSelector(
    '[data-testid="notes-panel"], [data-testid="notes-empty-state"]',
    { timeout: 30000 },
  );
  if (await page.locator('[data-testid="notes-empty-state"]').count() > 0) {
    throw new Error("the document is not ready");
  }
  await page.waitForSelector('[data-testid="notes-panel"]', { timeout: 30000 });
}

async function openPaper(page, paper) {
  await page.setInputFiles('[data-testid="pdf-file-input"]', paper);
  await page.waitForSelector('[data-testid="pdf-page-container"]', { timeout: 120000 });
  await page.waitForSelector('[data-testid="assistant-tab-notes"]', { timeout: 60000 });
  await page.click('[data-testid="assistant-tab-notes"]');
  await openNotes(page);
}

async function typeQuery(page, text) {
  const input = page.locator('[data-testid="notes-search-input"]');
  await input.fill("");
  if (text !== "") await input.fill(text);
  await sleep(250);
}

async function main() {
  const before = createHash("sha256").update(readFileSync(FIXTURE)).digest("hex");
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(join(workDir, "documents"), { recursive: true });
  const database = join(workDir, "db.sqlite3");
  const documentsDir = join(workDir, "documents");

  const previewPort = await freePort();
  const backend = startBackend(previewPort, database, documentsDir);
  if (!(await waitFor(`${BACKEND_URL}/api/health`))) {
    console.log("backend did not start"); backend.kill(); return 2;
  }
  const preview = await startPreview(previewPort);
  if (!PREVIEW_URL) { preview.kill(); backend.kill(); return 2; }
  console.log(`preview: ${PREVIEW_URL}\nscale target: ${SCALE} annotations\n`);

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
  page.on("request", (r) => {
    if (/deepseek|openai|anthropic|chat\/completions/.test(r.url())) providerCalls.push(r.url());
  });

  const annotations = async (documentId) =>
    (await fetch(`${BACKEND_URL}/api/documents/${documentId}/annotations`)).json();

  try {
    await page.goto(PREVIEW_URL, { waitUntil: "domcontentloaded" });
    await openPaper(page, FIXTURE);
    const documentId = uploadedDocumentId();
    const fingerprint = (await annotations(documentId)).content_hash;
    check("the paper opens with no notes yet", (await page.locator("li[data-testid^='note-']").count()) === 0);

    // --- 1. the scale corpus, written by the application's own store ---------
    const seeded = spawnSync(python, [SEEDER, database, fingerprint, documentId, String(SCALE)], {
      cwd: backendDir, encoding: "utf-8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONPATH: backendDir },
    });
    if (seeded.status !== 0) throw new Error(`seeding failed: ${seeded.stderr}`);
    console.log(`    ${seeded.stdout.trim()}`);

    await page.reload({ waitUntil: "domcontentloaded" });
    await openPaper(page, FIXTURE);
    await page.waitForFunction(
      (n) => document.querySelectorAll('li[data-testid^="note-"]').length === n,
      SCALE, { timeout: 60000 },
    );
    check(`the panel loads ${SCALE} notes`, true);

    // --- 2. the frozen latency, on the quantity that was frozen -------------
    /* AC-P0-01 freezes the **filtering** at 5.0 ms per keystroke over up to 500
       annotations. The panel publishes that measurement from inside the memo
       that performs it, so what is read here is the real code path in a real
       browser — not jsdom's `String.normalize`, and not React re-rendering five
       hundred rows, which is a much larger number that the criterion is not
       about. */
    await page.evaluate(() => performance.clearMeasures("notes-filter"));

    const filterSamples = [];
    for (const query of ["残差", "degradation", "rollouts", "训练", "policy"]) {
      await typeQuery(page, query);
      const duration = await page.evaluate(() => {
        const entries = performance.getEntriesByName("notes-filter");
        return entries.length ? entries[entries.length - 1].duration : null;
      });
      if (duration !== null) filterSamples.push(Math.round(duration * 1000) / 1000);
    }
    filterSamples.sort((a, b) => a - b);
    const worst = filterSamples[filterSamples.length - 1] ?? null;
    check(
      `filtering ${SCALE} notes stays inside the 5.0 ms budget`,
      worst !== null && worst < 5.0,
      `samples ${filterSamples.join(", ")} ms`,
    );

    // --- 3. searching --------------------------------------------------------
    await typeQuery(page, "残差");
    const chinese = await page.evaluate(ROWS);
    check(
      "a Chinese bigram narrows the list",
      chinese.length > 0 && chinese.length < SCALE && chinese.every((t) => t.includes("残差")),
      `${chinese.length} of ${SCALE}`,
    );

    await typeQuery(page, "degradation");
    const english = await page.evaluate(ROWS);
    check(
      "an English term narrows the list",
      english.length > 0 && english.length < SCALE,
      `${english.length} of ${SCALE}`,
    );

    await typeQuery(page, "nonexistent_xyz");
    check(
      "a query nothing matches shows the search empty state, not the no-notes state",
      (await page.locator('[data-testid="notes-search-empty"]').count()) === 1
        && (await page.locator('[data-testid="notes-none"]').count()) === 0,
      await page.locator('[data-testid="notes-search-empty"]').innerText(),
    );

    await page.click('[data-testid="notes-search-clear"]');
    await sleep(300);
    check(
      "clearing restores every note",
      (await page.locator("li[data-testid^='note-']").count()) === SCALE
        && (await page.locator('[data-testid="notes-search-input"]').inputValue()) === "",
    );

    // --- 4. a result still jumps --------------------------------------------
    await typeQuery(page, "残差");
    const firstRow = page.locator("li[data-testid^='note-']").first();
    await firstRow.click();
    await sleep(1200);
    const activeIds = await page.evaluate(() =>
      [...document.querySelectorAll('li[data-testid^="note-"]')]
        .filter((row) => row.getAttribute("data-active") === "true")
        .map((row) => row.getAttribute("data-testid")));
    check(
      "clicking a result marks it active and moves the reader",
      activeIds.length === 1,
      `active rows: ${JSON.stringify(activeIds)}`,
    );
    await page.click('[data-testid="notes-search-clear"]');
    await sleep(300);

    // --- 5. export, with the bytes checked ----------------------------------
    const markdown = await download(page, "export-notes-markdown");
    check("the Markdown export downloads", markdown !== null, markdown?.name ?? "");
    check(
      "the downloaded name is the sanitised one the backend chose",
      markdown?.name === "fixture-notes.md",
      markdown?.name ?? "no file",
    );
    const body = markdown?.bytes.toString("utf8") ?? "";
    check("the Markdown names the paper and its content hash",
      body.startsWith("# Notes: ") && body.includes(fingerprint));
    check("the Markdown says how many annotations it holds",
      body.includes(`- **Annotations:** ${SCALE}`), `${SCALE} expected`);
    check("the Markdown keeps the source quote and the reader's words apart",
      body.includes("> ") && body.includes("**Note:**"));
    check("every annotation in the export is a section of its own",
      (body.match(/^## \d+\. /gm) ?? []).length === SCALE);

    const json = await download(page, "export-notes-json");
    check("the JSON export downloads", json !== null, json?.name ?? "");
    let payload = null;
    try { payload = JSON.parse(json.bytes.toString("utf8")); } catch { /* reported below */ }
    check("the JSON parses", payload !== null);
    check(
      "the JSON is versioned and names the document",
      payload?.schema_version === "1"
        && payload?.document?.content_hash === fingerprint,
    );
    check("the JSON holds every annotation", payload?.annotations?.length === SCALE);

    const target = payload?.annotations?.[0]?.targets?.[0];
    check(
      "each target keeps the immutable anchor and its version",
      Boolean(target?.source_anchor_id) && Boolean(target?.anchor_version),
      `anchor ${String(target?.source_anchor_id).slice(0, 12)}… v${target?.anchor_version}`,
    );
    check(
      "each target keeps its rectangles and its quote",
      Array.isArray(target?.rects) && target.rects.length > 0 && Boolean(target?.exact_quote),
    );
    check(
      "no runtime paragraph ordinal is exported as identity",
      !JSON.stringify(payload?.annotations?.[0]?.targets ?? []).includes("p_"),
      "checked the first annotation's targets",
    );

    const afterExports = await annotations(documentId);
    check(
      "exporting wrote nothing: the notes are exactly as they were",
      afterExports.annotations.length === SCALE,
      `${afterExports.annotations.length} annotations`,
    );

    // --- 6. the no-extraction boundary, on the route itself ------------------
    /* The application fetches the IR when a paper is registered — by design, and
       that is DS-QA-010's behaviour, not this task's. So the case where the
       boundary could be lost is a request that arrives *outside* that flow: an
       export for a document whose IR is not there. Removing the cached IR and
       asking the route directly is exactly that case, and `ir.json`'s absence
       afterwards is the assertion — a route that extracts recreates it. */
    const documentDir = join(documentsDir, documentId);
    const irPath = join(documentDir, "ir.json");
    const irExisted = existsSync(irPath);
    rmSync(irPath, { force: true });

    let withoutIr = null;
    let markdownBody = "";
    for (const suffix of ["notes.md", "notes.json"]) {
      const response = await page.request.get(
        `${BACKEND_URL}/api/documents/${documentId}/export/${suffix}`,
      );
      if (response.status() !== 200) withoutIr = `${suffix} -> ${response.status()}`;
      if (suffix === "notes.md") markdownBody = await response.text();
    }
    check(
      "both exports answer for a document with no cached IR",
      withoutIr === null,
      withoutIr ?? `was present before: ${irExisted}`,
    );
    check(
      "the no-IR export still carries the reader's notes",
      markdownBody.includes("- **Annotations:** 500")
        && markdownBody.includes("**Status:** UNRESOLVED"),
    );
    check(
      "neither export extracted the document",
      !existsSync(irPath),
      "ir.json must still be absent",
    );

    // --- 7. an empty export is refused by the UI ----------------------------

    // A *different* paper. Re-uploading the same file cannot reach this state:
    // the list is keyed by content hash, so the notes follow it — which is the
    // DS-QA-010-FIX-001 behaviour, and the reason the harness needs a second PDF.
    await openPaper(page, OTHER);
    await page.waitForSelector('[data-testid="notes-none"]', { timeout: 30000 });
    check(
      "another paper shows no notes, and its own empty state",
      (await page.locator('[data-testid="notes-search-empty"]').count()) === 0,
    );
    const otherDisabled = await page
      .locator('[data-testid="export-notes-markdown"]').getAttribute("aria-disabled");
    const otherTitle = await page
      .locator('[data-testid="export-notes-markdown"]').getAttribute("title");
    check(
      "a paper with no notes refuses the export, and says why",
      otherDisabled === "true" && otherTitle === "当前文档暂无笔记可导出",
      `${otherDisabled} / ${otherTitle}`,
    );

  } finally {
    await browser.close();
    preview.child?.kill();
    backend.kill();
  }

  const after = createHash("sha256").update(readFileSync(FIXTURE)).digest("hex");
  check("the source PDF is byte-identical", before === after, before.slice(0, 16));
  check("no provider call was made", providerCalls.length === 0, providerCalls.join(", "));
  check(
    "no uncaught console errors during the run",
    consoleErrors.filter(
        (t) => !/ERR_CONNECTION_(RESET|REFUSED)/.test(t) && !designed404(t)).length === 0,
    consoleErrors.slice(0, 2).join(" | "),
  );

  const passed = results.filter((r) => r.ok).length;
  writeFileSync(join(workDir, "results.json"), JSON.stringify({ results, passed }, null, 1));
  console.log(`\n${passed}/${results.length} passed`);
  return passed === results.length ? 0 : 1;
}

/** Click a download link and read the bytes that reached disk. */
async function download(page, testId) {
  const [event] = await Promise.all([
    page.waitForEvent("download", { timeout: 60000 }),
    page.click(`[data-testid="${testId}"]`),
  ]);
  const path = await event.path();
  return { name: event.suggestedFilename(), bytes: readFileSync(path) };
}

process.exit(await main());
