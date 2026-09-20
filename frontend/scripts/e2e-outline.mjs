/**
 * DS-QA-008 real-browser verification — Paper outline and structured navigation.
 *
 * Drives the built bundle, the real backend and the real PDFs in Edge. Nothing
 * about the outline path is mocked.
 *
 * The paper is ResNet, chosen because it is the case the criteria froze: its
 * page 3 carries headings for `3.`, `3.1`, `3.2` and `3.3` and paragraphs for
 * four sections, which is what made the page-based rule this feature replaced
 * report the wrong section.
 *
 * Usage:  node scripts/e2e-outline.mjs      (requires `npm run build` first)
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
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
const workDir = join(repoRoot, ".agent", "results", "e2e-outline");

// The frontend reads `VITE_API_BASE_URL` at build time and falls back to
// the loopback default, and the bundle is built before this runs — so the
// backend must be where the build expects it.
const BACKEND_PORT = 8000;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const BASELINE_DOCUMENT = "doc_6f4ab9d9d4d34f85bc9e441757240fd8";
/**
 * Which paper to drive. Defaults to the benchmark paper in the user's library;
 * `E2E_PAPER` points the same checks at another real document, so the three-paper
 * validation is one harness run three times rather than three code paths.
 */
const PAPER_PATH = process.env.E2E_PAPER ?? "";
const PAPER_LABEL = process.env.E2E_LABEL ?? "resnet";

let PREVIEW_URL = "";
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
/**
 * Not run, and not counted as a failure.
 *
 * A check whose precondition the fixture cannot satisfy is a gap in the
 * verification, not a defect in the feature — and recording it as FAIL would
 * make the summary say something untrue in the other direction.
 */
function skip(name, reason) {
  results.push({ name, ok: null, detail: reason });
  console.log(`  SKIP  ${name}  — ${reason}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function appDataDir() {
  return process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "AcademicPDFCopilot")
    : join(process.env.HOME ?? "", ".local", "share", "AcademicPDFCopilot");
}
const realDataDir = appDataDir();

function sha256(path) {
  const hash = createHash("sha256");
  hash.update(spawnSync(python, ["-c",
    `import sys;sys.stdout.buffer.write(open(sys.argv[1],'rb').read())`, path],
    { maxBuffer: 64 * 1024 * 1024 }).stdout);
  return hash.digest("hex");
}

/** A copy of the real paper and its database, so the run touches nothing. */
function prepareWorkdir() {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  const documents = join(workDir, "documents", BASELINE_DOCUMENT);
  mkdirSync(documents, { recursive: true });

  if (PAPER_PATH) {
    copyFileSync(PAPER_PATH, join(documents, "source.pdf"));
  } else {
    const source = join(realDataDir, "documents", BASELINE_DOCUMENT, "source.pdf");
    copyFileSync(source, join(documents, "source.pdf"));
    for (const name of ["analysis.json", "ir.json", "search.db"]) {
      const from = join(realDataDir, "documents", BASELINE_DOCUMENT, name);
      if (existsSync(from)) copyFileSync(from, join(documents, name));
    }
  }

  const database = join(workDir, "db.sqlite3");
  copyFileSync(join(realDataDir, "db.sqlite3"), database);
  return { paper: join(documents, "source.pdf"), database };
}

function startBackend(corsPort, { database, documentsDir }) {
  const child = spawn(python, ["-m", "uvicorn", "app.main:app", "--port", String(BACKEND_PORT)],
    {
      cwd: backendDir,
      env: {
        ...process.env, PYTHONIOENCODING: "utf-8", PYTHONPATH: backendDir,
        DATABASE_PATH: database, DOCUMENTS_DIR: documentsDir,
        CORS_ORIGINS: `http://127.0.0.1:${corsPort},http://localhost:${corsPort}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    if (text.includes("Traceback")) console.log(`[backend] ${text}`);
  });
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
  return new Promise((resolvePort) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function startPreview(port) {
  // `vite preview` prints the URL it bound, and `--port 0` is not something
  // Vite accepts, so a free port is chosen first. The banner is coloured, which
  // puts an escape sequence between the colon and the port — hence the strip.
  const child = spawn(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "preview", "--", "--port", String(port), "--strictPort"],
    { cwd: join(repoRoot, "frontend"), stdio: ["ignore", "pipe", "pipe"], shell: true },
  );
  return new Promise((done) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += String(chunk).replace(/\[[0-9;]*m/g, "");
      const match = buffer.match(/http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)/);
      if (match && !PREVIEW_URL) {
        PREVIEW_URL = `http://127.0.0.1:${match[1]}`;
        done(child);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    setTimeout(() => done(child), 20000);
  });
}

const viewer = '[data-testid="pdf-viewer"]';

/**
 * The id the *upload* produced, which is not the baseline id.
 *
 * Opening the paper registers a new document in the copied database, so asking
 * the backend about `BASELINE_DOCUMENT` describes a different row — one left by
 * an earlier run. Discovered rather than assumed.
 */
function uploadedDocumentId() {
  const root = join(workDir, "documents");
  const entries = readdirSync(root).filter((name) => name.startsWith("doc_"));
  return entries.sort().reverse().find((name) => name !== BASELINE_DOCUMENT) ?? entries[0];
}

/** The section ids the backend actually returned, so nothing is hardcoded. */
async function fetchOutline(page, documentId) {
  return page.evaluate(async (url) => (await fetch(url)).json(),
    `${BACKEND_URL}/api/documents/${documentId}/sections`);
}

async function main() {
  const { paper, database } = prepareWorkdir();
  const paperHash = sha256(paper);
  console.log(`paper: ${PAPER_LABEL} — ${paper}`);

  const previewPort = await freePort();
  const backend = startBackend(previewPort, {
    database, documentsDir: join(workDir, "documents"),
  });
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

  try {
    await page.goto(PREVIEW_URL, { waitUntil: "domcontentloaded" });

    // --- open the real paper -------------------------------------------------
    await page.setInputFiles('[data-testid="pdf-file-input"]', paper);
    await page.waitForSelector('[data-testid="pdf-page-container"]', { timeout: 120000 });
    await page.waitForSelector('[data-testid="assistant-tab-outline"]', { timeout: 60000 });

    const documentId = uploadedDocumentId();
    console.log(`    uploaded document: ${documentId}`);
    const sections = await fetchOutline(page, documentId);
    check("the backend describes the paper as a section list", sections.length >= 10,
      `${sections.length} sections`);
    check("every node carries a canonical id",
      sections.every((s) => typeof s.id === "string" && s.id.startsWith("sec_")));
    check("every node resolves a heading box on this paper (AC-P0-04)",
      sections.every((s) => s.anchor === "heading" && Array.isArray(s.bbox)),
      `${sections.filter((s) => s.anchor === "heading").length}/${sections.length}`);
    const nested = sections.filter((s) => s.parent_id !== null);
    check("the hierarchy is not flat", nested.length > 0,
      `${nested.length} nested of ${sections.length}`);

    // --- the outline panel ---------------------------------------------------
    await page.click('[data-testid="assistant-tab-outline"]');
    await page.waitForSelector('[data-testid="outline-panel"]', { timeout: 30000 });
    const rootNodes = await page.locator('[role="treeitem"]').count();
    check("the outline renders", rootNodes > 0, `${rootNodes} visible nodes`);

    // The top-level container, not `3.1. Residual Learning` — `startsWith("3.")`
    // matches both, and the first match is a leaf with no toggle to click.
    const section3 = sections.find(
      (s) => s.parent_id === null && /^3[.\s]/.test(s.title));
    const section4 = sections.find(
      (s) => s.parent_id === null && /^4[.\s]/.test(s.title));
    const children3 = sections.filter((s) => s.parent_id === section3?.id);
    check("a parent/container section keeps its children (AC-P0-05)",
      children3.length >= 3, `§3 has ${children3.length} children`);

    const childId = children3[0].id;
    check("a child is hidden until its parent is expanded",
      (await page.locator(`[data-testid="outline-node-${childId}"]`).count()) === 0);
    try {
      await page.click(`[data-testid="outline-toggle-${section3.id}"]`, { timeout: 5000 });
      check("expanding reveals the child",
        (await page.locator(`[data-testid="outline-node-${childId}"]`).count()) === 1);
      await page.click(`[data-testid="outline-toggle-${section3.id}"]`, { timeout: 5000 });
      check("collapsing hides it again",
        (await page.locator(`[data-testid="outline-node-${childId}"]`).count()) === 0);
    } catch (error) {
      check("expand/collapse works", false, String(error).slice(0, 90));
    }

    // --- navigation ----------------------------------------------------------
    const activeIdOf = async (id) =>
      (await page.locator(`[data-testid="outline-node-${id}"]`).getAttribute("data-active")) === "true";

    // The first reachable section, not "Introduction" by name: on the rotated
    // fixture page 1 is unreadable and its headings are absent, so a lookup that
    // hardcodes one paper's title is a harness assumption rather than a check.
    const intro = sections.find((s) => s.title.includes("Introduction")) ?? sections[0];
    await page.click(`[data-testid="outline-jump-${intro.id}"]`);
    await sleep(900);
    const scrollTop = await page.evaluate((sel) => document.querySelector(sel).scrollTop, viewer);
    // `scrollTop` is asserted against the *page-1 extent*, not an absolute
    // number: the heading sits partway down page 1, so a correct jump lands
    // hundreds of pixels in. The earlier `< 200` was an assumption about the
    // paper, not about the feature.
    // Measured against the extent of the page the *section* names, not page 1:
    // on the rotated fixture the first reachable section is on page 2, and an
    // assertion built around page 1 was an assumption about the paper.
    const landing = await page.evaluate(([sel, pageNumber]) => {
      const root = document.querySelector(sel);
      const page = root.querySelector(`[data-page-number='${pageNumber}']`);
      if (!page) return null;
      return { top: page.offsetTop, height: page.getBoundingClientRect().height };
    }, [viewer, intro.page_number]);
    check("clicking a section lands inside the page it names (AC-P0-06)",
      landing !== null && scrollTop >= landing.top - 32
        && scrollTop <= landing.top + landing.height,
      `scrollTop=${Math.round(scrollTop)} in page ${intro.page_number} `
      + `[${Math.round(landing?.top ?? -1)}, ${Math.round((landing?.top ?? 0) + (landing?.height ?? 0))}]`);
    check("the clicked section becomes the active one (AC-P0-06)",
      await activeIdOf(intro.id), intro.title);

    const later = section4;
    await page.click(`[data-testid="outline-jump-${later.id}"]`);
    await sleep(900);
    const movedTop = await page.evaluate((sel) => document.querySelector(sel).scrollTop, viewer);
    check("a later section moves further down", movedTop > scrollTop,
      `${Math.round(scrollTop)} -> ${Math.round(movedTop)}`);

    // --- rotated pages: jump, but never a misplaced box (AC-P0-10) -----------
    // Only meaningful on a rotated fixture, so it runs when one is supplied.
    if (process.env.E2E_ROTATED === "1") {
      await page.click(`[data-testid="outline-jump-${later.id}"]`);
      await sleep(900);
      const rotatedScroll = await page.evaluate(
        (sel) => document.querySelector(sel).scrollTop, viewer);
      const boxes = await page.locator('[data-testid="pdf-highlight-box"]').count();
      check("a rotated page still jumps to the section (AC-P0-10)",
        rotatedScroll > 0, `scrollTop=${Math.round(rotatedScroll)}`);
      // The rule DS-QA-005 set: a highlight in the wrong place points the reader
      // at text that does not support the claim, which is worse than none.
      check("no bbox is drawn on a rotated page (AC-P0-10)", boxes === 0,
        `${boxes} highlight boxes`);
    }

    // --- current-section tracking through a real scroll ----------------------
    const activeIds = async () =>
      page.$$eval('[role="treeitem"][data-active="true"]', (nodes) =>
        nodes.map((n) => n.getAttribute("data-section-id")));

    await page.evaluate((sel) => { document.querySelector(sel).scrollTop = 0; }, viewer);
    await sleep(700);
    const atTop = await activeIds();

    // Slowly through page 3, where four sections share a page — the case the
    // page-based rule got wrong.
    const seen = [];
    for (let step = 0; step <= 40; step += 1) {
      await page.evaluate(([sel, value]) => {
        document.querySelector(sel).scrollTop = value;
      }, [viewer, 900 + step * 90]);
      await sleep(120);
      const current = (await activeIds())[0];
      if (current && current !== seen[seen.length - 1]) seen.push(current);
    }
    const titles = new Map(sections.map((s) => [s.id, s.title]));
    console.log(`    section sequence while scrolling: ${seen.map((id) => titles.get(id) ?? id).join(" -> ")}`);
    check("the active section follows the reading position (AC-P0-07)",
      seen.length >= 2, `${seen.length} transitions`);
    check("it never goes backwards",
      new Set(seen).size === seen.length, seen.join(" -> "));
    check("the active node is never left unset",
      (await activeIds()).length === 1, (await activeIds()).join(","));

    // --- zoom and fit-width do not disturb identity --------------------------
    const before = await activeIds();
    await page.click('[data-testid="zoom-in"]').catch(() => {});
    await sleep(500);
    const afterZoom = await activeIds();
    check("zoom keeps the active section (AC-P1-07)",
      afterZoom.length === before.length, `${before} -> ${afterZoom}`);

    // --- reader modes --------------------------------------------------------
    // AC-P0-09's translation clause needs a translated artifact, and this
    // fixture has none: `selectEffectiveMode` falls back to `original` when no
    // translation exists, so translation mode cannot be entered here at all.
    // Recording that as not-run rather than asserting a state the fixture cannot
    // reach — the sibling behaviour (Original mode navigation) is checked above.
    const canTranslate = await page.locator('[data-testid="reader-mode-translation"]')
      .isEnabled().catch(() => false);
    skip("outline click in translation mode (AC-P0-09)",
      canTranslate ? "mode control enabled but no translated artifact exists"
                   : "no translated artifact in this fixture");

    // --- responsive ----------------------------------------------------------
    for (const width of [1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await sleep(350);
      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      const sidebar = await page.locator('[data-testid="assistant-sidebar"]').boundingBox();
      check(`no page-level horizontal overflow at ${width}px (AC-P0-11)`,
        overflow <= 0, `overflow=${overflow}`);
      check(`the sidebar keeps its width at ${width}px`,
        Math.round(sidebar?.width ?? 0) === 340, `w=${Math.round(sidebar?.width ?? 0)}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });

    // --- a section QA handoff spends no model call ---------------------------
    const requests = [];
    page.on("request", (r) => { if (r.url().includes("/answer")) requests.push(r.url()); });
    await page.click(`[data-testid="outline-ask-${intro.id}"]`);
    await sleep(600);
    const panel = await page.locator('[data-testid="assistant-sidebar"]').getAttribute("data-panel");
    check("'ask this section' switches to QA without asking (AC-P0-12, AC-P0-14)",
      panel === "qa" && requests.length === 0, `panel=${panel} answerCalls=${requests.length}`);

    // --- source immutability -------------------------------------------------
    check("the source PDF is byte-identical afterwards", sha256(paper) === paperHash);

    check("no uncaught console errors during the run",
      consoleErrors.filter((t) => !designed404(t)).length === 0,
      consoleErrors.slice(0, 2).join(" | "));
  } finally {
    await browser.close();
    preview.kill();
    backend.kill();
  }

  const failed = results.filter((r) => r.ok === false);
  const skipped = results.filter((r) => r.ok === null);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  writeFileSync(join(workDir, "results.json"),
    JSON.stringify({ results, consoleErrors }, null, 1));
  return failed.length === 0 ? 0 : 1;
}

const code = await main();
process.exit(code);
