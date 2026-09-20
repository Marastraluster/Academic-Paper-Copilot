/**
 * DS-QA-013 real-browser verification — annotating a real formula and caption.
 *
 * The measurement that made this task worth doing was a browser probe, so the
 * acceptance has to be a browser too. A backend fixture can prove an anchor
 * hashes deterministically; only a real drag over a real PDF.js text layer can
 * prove that a reader can put one there.
 *
 * The formula is the harder half and the reason the task's own Phase 11 listed
 * four possible representations. Measured on this paper, `y = F(x, {Wi}) + x.`
 * arrives as **18 text-layer spans** with the canonical characters intact — so
 * it is genuinely selectable, and this drags across it for real.
 *
 * Usage: node scripts/e2e-nonprose.mjs [paper.pdf]   (needs `npm run build`)
 */
import { spawn } from "node:child_process";
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
const workDir = join(repoRoot, ".agent", "results", "e2e-nonprose");
const BACKEND_PORT = 8000;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;

const PAPER = process.argv[2] ?? join(
  repoRoot, ".agent", "results", "e2e-notes", "documents",
  "doc_5e6aaca5ea5d4109b4f3a33a75df043d", "source.pdf",
);
const LABEL = process.env.E2E_LABEL ?? "resnet";

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

async function waitFor(url, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return true; } catch { /* not up */ }
    await sleep(400);
  }
  return false;
}

function uploadedDocumentId() {
  const entries = readdirSync(join(workDir, "documents")).filter((n) => n.startsWith("doc_"));
  return entries.sort().reverse()[0];
}

/** Put a block on screen and report where its text-layer spans are. */
async function anchorFor(page, block) {
  /* Bring the **block** into view, not the top of its page.
   *
   * Measured: scrolling to the page top left a formula at y=1187 in a 900 px
   * window — its text layer measured correctly, because
   * `getBoundingClientRect()` works off-screen, and a drag at those coordinates
   * hit nothing at all. The measurement was right and the gesture was aimed at
   * empty space. */
  await page.evaluate((wanted) => {
    const viewer = document.querySelector('[data-testid="pdf-viewer"]');
    const container = document.querySelector(`[data-page-number="${wanted.page_number}"]`);
    if (!viewer || !container) return;
    const scale = Number(container.dataset.pageScale ?? "0");
    const into = wanted.bbox[1] * (scale > 0 ? scale : 1);
    viewer.scrollTop = Math.max(
      0,
      container.offsetTop + into - viewer.clientHeight * 0.45,
    );
  }, block);
  await sleep(1600);

  return page.evaluate((wanted) => {
    const container = document.querySelector(`[data-page-number="${wanted.page_number}"]`);
    if (!container) return null;
    const layer = container.querySelector('[data-testid="pdf-text-layer"]');
    const scale = Number(container.dataset.pageScale ?? "0");
    if (!layer || !(scale > 0)) return null;
    const box = container.getBoundingClientRect();
    const [x0, y0, x1, y1] = wanted.bbox;
    const left = box.left + x0 * scale, top = box.top + y0 * scale;
    const right = box.left + x1 * scale, bottom = box.top + y1 * scale;

    /* **DOM order, not a geometric sort.** Measured: sorting these spans by
       (top, left) produces `"=F(,{W}) +.yxxi"` for a formula whose DOM order
       reads `"y = F(x, {Wi}) + x."` — the text layer already carries the
       reading order, and a sort re-derives it wrongly. The probe that made this
       task worth doing joined them in DOM order, which is why it measured
       coverage 1.0 and this harness measured a jumble. */
    const hits = [...layer.querySelectorAll("span")]
      .map((span) => ({ rect: span.getBoundingClientRect(), text: span.textContent ?? "" }))
      .filter((item) =>
        Math.min(item.rect.right, right) - Math.max(item.rect.left, left) > 1
        && Math.min(item.rect.bottom, bottom) - Math.max(item.rect.top, top) > 1)
      .filter((item) => item.text.trim() !== "");

    if (hits.length === 0) return null;
    const first = hits[0].rect, last = hits[hits.length - 1].rect;
    const at = (x, y) => {
      const el = document.elementFromPoint(x, y);
      return el ? `${el.tagName}.${String(el.className).split(" ")[0]}` : null;
    };
    void { first, last };
    return {
      spans: hits.length,
      text: hits.map((item) => item.text).join("").replace(/\s+/g, " ").trim().slice(0, 60),
      start: { x: first.left + 2, y: first.top + first.height / 2 },
      end: { x: last.right - 2, y: last.top + last.height / 2 },
      // Returned rather than logged: `console.log` inside `page.evaluate` goes to
      // the browser console, where a harness reading process stdout never sees it.
      diagnose: {
        first: { l: Math.round(first.left), t: Math.round(first.top), r: Math.round(first.right) },
        last: { l: Math.round(last.left), t: Math.round(last.top), r: Math.round(last.right) },
        underStart: at(first.left + 2, first.top + first.height / 2),
        underEnd: at(last.right - 2, last.top + last.height / 2),
      },
    };
  }, block);
}

/**
 * A real drag, in steps with a beating pause after the button goes down.
 *
 * Measured on DS-QA-011: a drag dispatched as one immediate jump after the
 * button is pressed reliably selects when it starts high in the page and
 * intermittently selects nothing when it starts low — the browser has not
 * latched the anchor yet.
 */
async function dragAcross(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await sleep(80);
  await page.mouse.move(from.x + (to.x >= from.x ? 2 : -2), from.y + (to.y >= from.y ? 2 : -2));
  await sleep(30);
  for (let i = 1; i <= 20; i += 1) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * i) / 20,
      from.y + ((to.y - from.y) * i) / 20,
    );
    await sleep(16);
  }
  await page.mouse.up();
  await sleep(900);
}

async function openPaper(page, paper) {
  await page.setInputFiles('[data-testid="pdf-file-input"]', paper);
  await page.waitForSelector('[data-testid="pdf-page-container"]', { timeout: 120000 });
  await page.waitForSelector('[data-testid="assistant-tab-notes"]', { timeout: 60000 });
  await page.click('[data-testid="assistant-tab-notes"]');
  await page.waitForSelector(
    '[data-testid="notes-panel"], [data-testid="notes-empty-state"]',
    { timeout: 30000 },
  );
}

async function main() {
  const before = createHash("sha256").update(readFileSync(PAPER)).digest("hex");
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(join(workDir, "documents"), { recursive: true });
  const database = join(workDir, "db.sqlite3");

  const previewPort = await freePort();
  const backend = spawn(python, ["-m", "uvicorn", "app.main:app", "--port", String(BACKEND_PORT)], {
    cwd: backendDir,
    env: {
      ...process.env, PYTHONIOENCODING: "utf-8", PYTHONPATH: backendDir,
      DATABASE_PATH: database, DOCUMENTS_DIR: join(workDir, "documents"),
      CORS_ORIGINS: `http://127.0.0.1:${previewPort},http://localhost:${previewPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  backend.stderr.on("data", () => {});
  if (!(await waitFor(`${BACKEND_URL}/api/health`))) {
    console.log("backend did not start"); backend.kill(); return 2;
  }
  const preview = await startPreview(previewPort);
  console.log(`paper: ${LABEL}\npreview: ${PREVIEW_URL}\n`);

  const browser = await chromium.launch({ channel: "msedge" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  /* A 404 is the *designed* answer on the two routes the Overview panel asks
     about when a paper opens: `/overview` (nothing generated yet) and the older
     `/analysis` (not analysed yet). The status is part of the match, so a 500 on
     either path is still an error. */
  const designed404 = (t) =>
    /status of 404/.test(t) && /\/(analysis|overview)(\?|\s|$)/.test(t);
  /* A failed request's console text does not carry its URL; the location does,
     which is what lets the filter above name the route. */
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
    await openPaper(page, PAPER);
    const documentId = uploadedDocumentId();
    const ir = await (await fetch(`${BACKEND_URL}/api/documents/${documentId}/ir`)).json();

    const blocks = ir.pages.flatMap((p) => p.blocks);
    const formulas = blocks.filter(
      (b) => b.layout_class === "isolate_formula" && b.source_anchor_id,
    );
    const captions = blocks.filter(
      (b) => b.layout_class === "figure_caption" && b.source_anchor_id,
    );
    console.log(`  the IR holds ${formulas.length} anchorable formulas and ` +
      `${captions.length} anchorable captions`);
    check("the paper's extraction carries anchorable non-prose blocks",
      formulas.length > 0 && captions.length > 0,
      `${formulas.length} formulas, ${captions.length} captions`);

    // --- 1. a real formula, selected by a real drag ------------------------
    const formula = formulas[0];
    const formulaAnchor = await anchorFor(page, formula);
    check("the formula's text is on the page as selectable spans",
      formulaAnchor !== null && formulaAnchor.spans > 1,
      formulaAnchor
        ? `${formulaAnchor.spans} spans: ${formulaAnchor.text} | ${JSON.stringify(formulaAnchor.diagnose)}`
        : "no spans");

    await dragAcross(page, formulaAnchor.start, formulaAnchor.end);
    const selected = await page.evaluate(() =>
      (window.getSelection()?.toString() ?? "").replace(/\s+/g, " ").trim());
    check("a drag selects the formula", selected.length > 0,
      JSON.stringify(selected.slice(0, 44)));

    await sleep(400);
    const formulaCreate = await page
      .locator('[data-testid="notes-create-highlight"]').isEnabled();
    check("a formula-only selection offers the annotation action", formulaCreate);
    if (!formulaCreate) throw new Error(`formula selection did not map: ${selected}`);

    await page.click('[data-testid="notes-create-highlight"]');
    await sleep(1500);

    let listed = await annotations(documentId);
    check("the formula produced one annotation", listed.annotations.length === 1,
      `${listed.annotations.length} listed`);
    const formulaTarget = listed.annotations[0].targets[0];
    check("its target names the formula class",
      formulaTarget.source_class === "isolate_formula",
      `source_class=${formulaTarget.source_class}`);
    check("its target is the block's own anchor",
      formulaTarget.quote.length > 0 && formulaTarget.page_number === formula.page_number,
      `page ${formulaTarget.page_number}, quote ${JSON.stringify(formulaTarget.quote.slice(0, 30))}`);

    const boxes = await page.evaluate((pageNumber) => {
      const container = document.querySelector(`[data-page-number="${pageNumber}"]`);
      return container
        ? container.querySelectorAll('[data-testid="pdf-persistent-highlight-box"]').length
        : 0;
    }, formula.page_number);
    check("the highlight is drawn on the formula's page", boxes > 0, `${boxes} boxes`);

    // --- 2. a caption, and a mixed selection -------------------------------
    const caption = captions[0];
    const captionAnchor = await anchorFor(page, caption);
    check("the caption's text is selectable", captionAnchor !== null && captionAnchor.spans > 0,
      captionAnchor ? `${captionAnchor.spans} spans: ${captionAnchor.text}` : "none");

    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await sleep(300);
    await dragAcross(page, captionAnchor.start, captionAnchor.end);
    await sleep(300);
    const captionEnabled = await page
      .locator('[data-testid="notes-create-highlight"]').isEnabled();
    check("a caption-only selection offers the annotation action", captionEnabled);
    if (captionEnabled) {
      await page.click('[data-testid="notes-create-highlight"]');
      await sleep(1500);
      listed = await annotations(documentId);
      const created = listed.annotations.find((item) =>
        item.targets.some((t) => t.source_class === "figure_caption"));
      check("a caption annotation records the caption class",
        created !== undefined,
        created ? `class ${created.targets[0].source_class}` : "not found");
    }

    // --- 3. search finds them, as the reader's own text --------------------
    await page.locator('[data-testid="notes-search-input"]').fill("F(x");
    await sleep(400);
    const searchRows = await page.locator("li[data-testid^='note-']").count();
    check("searching the formula's text finds the annotation", searchRows >= 1,
      `${searchRows} rows`);
    await page.click('[data-testid="notes-search-clear"]');
    await sleep(300);

    // --- 4. reload ---------------------------------------------------------
    const roundTrip = await page.evaluate(() =>
      [...document.querySelectorAll('li[data-testid^="note-"]')]
        .map((row) => row.getAttribute("data-testid")));
    await page.reload({ waitUntil: "domcontentloaded" });
    await openPaper(page, PAPER);
    await sleep(2500);
    const afterReload = await page.locator("li[data-testid^='note-']").count();
    check("the notes survive a reload", afterReload === roundTrip.length,
      `${roundTrip.length} -> ${afterReload}`);

    await page.evaluate((pageNumber) => {
      const container = document.querySelector(`[data-page-number="${pageNumber}"]`);
      const viewer = document.querySelector('[data-testid="pdf-viewer"]');
      if (container && viewer) viewer.scrollTop = container.offsetTop - 60;
    }, formula.page_number);
    await sleep(1800);
    const restored = await page.evaluate((pageNumber) => {
      const container = document.querySelector(`[data-page-number="${pageNumber}"]`);
      return container
        ? container.querySelectorAll('[data-testid="pdf-persistent-highlight-box"]').length
        : 0;
    }, formula.page_number);
    check("the formula's highlight returns on remount", restored > 0, `${restored} boxes`);

    // --- 5. export carries the kind ----------------------------------------
    const reloadedId = uploadedDocumentId();
    const payload = JSON.parse(
      (await (await fetch(
        `${BACKEND_URL}/api/documents/${reloadedId}/export/notes.json`,
      )).text()),
    );
    const kinds = payload.annotations.flatMap((a) => a.targets.map((t) => t.source_class));
    check("the JSON export carries a class for every target",
      kinds.length > 0 && kinds.every((kind) => typeof kind === "string"),
      kinds.join(","));
    check("the JSON export names the non-prose class",
      kinds.includes("isolate_formula") || kinds.includes("figure_caption"),
      kinds.join(","));
    check("no runtime paragraph ordinal is exported as identity",
      !JSON.stringify(payload.annotations.flatMap((a) => a.targets)).includes("p_doc_"),
      "checked every target");

    const markdown = await (await fetch(
      `${BACKEND_URL}/api/documents/${reloadedId}/export/notes.md`,
    )).text();
    check("the Markdown says the note is on non-prose source",
      markdown.includes("公式") || markdown.includes("图注"),
      markdown.split("\n").find((line) => line.startsWith("## ")) ?? "");

    // --- 6. the QA boundary ------------------------------------------------
    /* The caption is annotatable and it is not evidence. Selection QA must stay
       unavailable for it — a question about a figure caption would otherwise be
       answered from a caption that was never in the retrieval corpus. */
    await page.click('[data-testid="assistant-tab-qa"]');
    await sleep(400);
    const selectionScope = await page.evaluate(() => {
      const button = document.querySelector('[data-testid="scope-selection"]');
      return button ? button.hasAttribute("disabled") : null;
    });
    check("Selection QA is not available for a non-prose selection",
      selectionScope === true || selectionScope === null,
      `scope-selection disabled=${selectionScope}`);
    await page.click('[data-testid="assistant-tab-notes"]');
    await sleep(300);

    check("no provider call was made", providerCalls.length === 0, providerCalls.join(", "));
    check("no uncaught console errors during the run",
      consoleErrors.filter(
        (t) => !/ERR_CONNECTION_(RESET|REFUSED)/.test(t) && !designed404(t)).length === 0,
      consoleErrors.slice(0, 2).join(" | "));
  } finally {
    await browser.close();
    preview.child?.kill();
    backend.kill();
  }

  const after = createHash("sha256").update(readFileSync(PAPER)).digest("hex");
  check("the source PDF is byte-identical", before === after, before.slice(0, 16));

  const passed = results.filter((r) => r.ok).length;
  writeFileSync(join(workDir, "results.json"), JSON.stringify({ results, passed }, null, 1));
  console.log(`\n${passed}/${results.length} passed`);
  return passed === results.length ? 0 : 1;
}

process.exit(await main());
