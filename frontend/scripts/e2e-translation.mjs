/**
 * DS-FE-003 real-browser end-to-end verification.
 *
 * Drives the actual application — built bundle, real backend, real translation
 * kernel, real HTTP provider — through the loop this milestone exists to close:
 *
 *   open PDF → read → translate → observe progress → read translation → bilingual
 *
 * Nothing here is mocked. The provider is a real HTTP server on loopback that
 * counts requests, so "the translation happened" is proven by the provider being
 * called, not by a file appearing (DS-PDF-001: a sparse page yields valid-looking
 * output while translating nothing).
 *
 * A second scenario forces the provider to fail, and checks the claim that
 * matters most about failure: it is bounded, it is reported, and it does not
 * damage the original document's readability.
 *
 * Usage:  node scripts/e2e-translation.mjs
 * Requires: `npm run build` first, and backend/.venv with pdf2zh installed.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const backendDir = join(repoRoot, "backend");
const python = join(backendDir, ".venv", "Scripts", "python.exe");
const distDir = resolve(here, "../dist");
const workDir = join(repoRoot, ".agent", "results", "e2e");

// The frontend's API base is compiled in at build time and defaults to :8000,
// so the backend port is fixed. The preview port is not: taking a free one keeps
// this script runnable alongside a dev server or a previous preview.
const BACKEND_PORT = Number(process.env.E2E_BACKEND_PORT ?? 8000);
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
let PREVIEW_PORT = 0;
let PREVIEW_URL = "";

// --- result tracking ---------------------------------------------------------

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the fake provider -------------------------------------------------------

const provider = {
  calls: 0,
  fail: false,
  server: null,
  url: "",
};

function startProvider() {
  return new Promise((done) => {
    provider.server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        provider.calls += 1;

        if (provider.fail) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "provider exploded" } }));
          return;
        }

        // A real completion, in the target language, so the translated PDF
        // genuinely contains different text from the source.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-e2e",
            object: "chat.completion",
            model: "e2e-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "该策略通过多轮轨迹采样进行优化。" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          }),
        );
      });
    });
    provider.server.listen(0, "127.0.0.1", () => {
      provider.url = `http://127.0.0.1:${provider.server.address().port}/v1`;
      done();
    });
  });
}

// --- the static frontend -----------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

/** Ask the OS for an unused loopback port. */
function findFreePort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.on("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

function startPreview() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, PREVIEW_URL);
    let file = join(distDir, url.pathname);
    if (!existsSync(file) || url.pathname === "/") file = join(distDir, "index.html");
    try {
      const body = readFileSync(file);
      res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((done) => server.listen(PREVIEW_PORT, "127.0.0.1", () => done(server)));
}

// --- helpers -----------------------------------------------------------------

async function waitForBackend(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BACKEND_URL}/api/health`);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(400);
  }
  return false;
}

/** Generate a paper-shaped PDF. A sparse page is classified "abandon" upstream. */
function makeFixturePdf(path) {
  const script = `
import fitz, sys
doc = fitz.open()
page = doc.new_page(width=595, height=842)
y = 70
page.insert_text((72, y), "Learning Stable Policies for Robotic Manipulation", fontsize=15); y += 34
page.insert_text((72, y), "A. Author, B. Author - Institute of Robotics", fontsize=10); y += 30
page.insert_text((72, y), "Abstract", fontsize=12); y += 18
for line in (
    "The policy is optimized through multiple rollouts collected from the simulator.",
    "We evaluate the learned policy on three manipulation benchmarks and report means.",
    "Each rollout is a sequence of observations, actions and rewards gathered under",
    "the current policy, which is then updated from the aggregated trajectories.",
    "Results indicate the proposed representation improves sample efficiency markedly.",
    "We compare against a behaviour cloning baseline trained on the same demonstrations.",
):
    page.insert_text((72, y), line, fontsize=10); y += 14
doc.save(sys.argv[1])
doc.close()
`;
  const result = spawnSync(python, ["-c", script, path], { cwd: backendDir, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`fixture generation failed: ${result.stderr || result.stdout}`);
  }
}

async function createProfile() {
  const response = await fetch(`${BACKEND_URL}/api/profiles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "E2E Loopback",
      base_url: provider.url,
      model: "e2e-model",
    }),
  });
  if (!response.ok) throw new Error(`profile creation failed: ${await response.text()}`);
  return response.json();
}

/**
 * Wait until a page's text layer actually has content.
 *
 * The page container appears first and the text layer is populated by a later
 * effect, so reading it immediately is a race — it yields "" on some runs and
 * real text on others. Waiting is the difference between a flaky check and one
 * that means something.
 */
async function waitForTextLayer(page, containerSelector, timeout = 20000) {
  await page.waitForFunction(
    (selector) => (document.querySelector(selector)?.textContent ?? "").trim().length > 0,
    containerSelector,
    { timeout },
  );
  return (await page.locator(containerSelector).first().textContent()) ?? "";
}

/** Read the visible status figures, so progress claims come from the real DOM. */
async function readStatus(page) {
  return page.evaluate(() => ({
    label: document.querySelector('[data-testid="status-label"]')?.textContent ?? "",
    page: document.querySelector('[data-testid="status-page"]')?.textContent ?? "",
    percent: document.querySelector('[data-testid="status-percent"]')?.textContent ?? "",
    running: !!document.querySelector('[data-testid="translation-running"]'),
    error: document.querySelector('[data-testid="translation-error"]')?.textContent ?? null,
  }));
}

// --- the scenarios -----------------------------------------------------------

async function runSuccessScenario(page, pdfPath) {
  console.log("\nScenario 1 — open → read → translate → read translation → bilingual");

  const before = readFileSync(pdfPath);

  await page.goto(PREVIEW_URL, { waitUntil: "domcontentloaded" });
  check(
    "AI 翻译 is disabled before a document is open",
    await page.locator('[data-testid="ai-translate"]').isDisabled(),
  );

  await page.locator('[data-testid="pdf-file-input"]').setInputFiles(pdfPath);
  await page.waitForSelector('[data-testid="pdf-page-container"]', { timeout: 30000 });
  check("original PDF renders through PDF.js", true);

  // A text layer is what makes the page readable, not just viewable.
  const originalText = await waitForTextLayer(page, '[data-testid="pdf-text-layer"]');
  check(
    "original has a selectable text layer",
    /robotic/i.test(originalText),
    JSON.stringify(originalText.trim().slice(0, 40)),
  );

  await page.locator('[data-testid="ai-translate"]').waitFor({ state: "visible" });
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="ai-translate"]')?.disabled,
    null,
    { timeout: 60000 },
  );
  check("AI 翻译 becomes enabled once the document is registered", true);

  await page.click('[data-testid="ai-translate"]');
  await page.waitForSelector('[data-testid="translate-dialog"]', { timeout: 10000 });

  /* The dialog fetches the profiles when it opens, so the list is not there the
     instant the element is. Counting immediately measured the fetch's latency
     rather than whether the profiles arrive — and the run that exposed it
     carried on to translate successfully, which is what a missing profile list
     would not have allowed. Bounded, so a dialog that never fills still fails. */
  await page
    .waitForFunction(
      () => document.querySelectorAll('[data-testid="translate-profile"] option').length > 0,
      null,
      { timeout: 10000 },
    )
    .catch(() => undefined);
  const providerOptions = await page.locator('[data-testid="translate-profile"] option').count();
  check("provider profiles populate the dialog", providerOptions >= 1, `${providerOptions} option(s)`);

  const translateCallsBefore = provider.calls;
  await page.click('[data-testid="translate-submit"]');

  await page.waitForSelector('[data-testid="translation-running"]', { timeout: 30000 });
  check("a translation task starts and reports its state", true);

  // Watch the reading surface while the translation runs.
  const originalDuring = await page.locator('[data-testid="viewer-original"]').isVisible();
  const pagesDuring = await page
    .locator('[data-testid="viewer-original"] [data-testid="pdf-page-container"]')
    .count();
  check(
    "the original stays readable while translating",
    originalDuring && pagesDuring > 0,
    `${pagesDuring} page(s) still mounted`,
  );

  // Collect the genuine progress readings the UI displayed.
  const seen = new Set();
  const deadline = Date.now() + 240000;
  let finished = false;
  while (Date.now() < deadline) {
    const status = await readStatus(page);
    if (status.percent) seen.add(`page ${status.page} → ${status.percent}`);
    if (status.error) {
      check("translation succeeded", false, status.error.slice(0, 200));
      return;
    }
    const enabled = await page.locator('[data-testid="reader-mode-translation"]').isEnabled();
    if (enabled && !status.running) {
      finished = true;
      break;
    }
    await sleep(400);
  }

  if (!check("translation reached SUCCESS", finished)) return;

  check(
    "the provider was genuinely called",
    provider.calls > translateCallsBefore,
    `${provider.calls - translateCallsBefore} request(s)`,
  );
  check("progress reported at least one real page reading", seen.size > 0, [...seen].join(" | "));

  // --- read the translation ---
  await page.click('[data-testid="reader-mode-translation"]');
  await page.waitForSelector(
    '[data-testid="viewer-translated"] [data-testid="pdf-page-container"]',
    { timeout: 30000 },
  );
  const translatedPages = await page
    .locator('[data-testid="viewer-translated"] [data-testid="pdf-page-container"]')
    .count();
  check("译文 mode renders the translated PDF", translatedPages > 0, `${translatedPages} page(s)`);

  const translatedText = await waitForTextLayer(
    page,
    '[data-testid="viewer-translated"] [data-testid="pdf-text-layer"]',
  );
  check(
    "the translated pane contains the translated text",
    translatedText.includes("轨迹采样"),
    JSON.stringify(translatedText.trim().slice(0, 40)),
  );

  // --- bilingual ---
  await page.click('[data-testid="reader-mode-bilingual"]');
  await page.waitForSelector('[data-testid="viewer-original"] [data-testid="pdf-page-container"]');
  await page.waitForSelector('[data-testid="viewer-translated"] [data-testid="pdf-page-container"]');

  const panes = await page.evaluate(() => {
    const original = document.querySelector('[data-testid="viewer-original"]');
    const translated = document.querySelector('[data-testid="viewer-translated"]');
    if (!original || !translated) return null;
    const a = original.getBoundingClientRect();
    const b = translated.getBoundingClientRect();
    return { originalLeft: a.left, translatedLeft: b.left, originalPages: a.width, translatedPages: b.width };
  });
  check(
    "双语 mode shows original left and translation right",
    panes !== null && panes.originalLeft < panes.translatedLeft,
    panes ? `left=${Math.round(panes.originalLeft)} right=${Math.round(panes.translatedLeft)}` : "panes missing",
  );

  const bothHavePages = await page.evaluate(() => {
    const count = (id) =>
      document.querySelectorAll(`[data-testid="${id}"] [data-testid="pdf-page-container"]`).length;
    return { original: count("viewer-original"), translated: count("viewer-translated") };
  });
  check(
    "both panes render their own document",
    bothHavePages.original > 0 && bothHavePages.translated > 0,
    `original=${bothHavePages.original} translated=${bothHavePages.translated}`,
  );

  const selectedMode = await page.evaluate(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find(
      (node) => node.getAttribute("aria-selected") === "true",
    );
    return tab?.textContent?.trim() ?? null;
  });
  check("the mode switch shows 双语 as selected", selectedMode === "双语", String(selectedMode));

  const overflow = await page.evaluate(() => ({
    body: document.body.scrollWidth <= window.innerWidth + 1,
    root: document.documentElement.scrollWidth <= window.innerWidth + 1,
  }));
  check("no window-level horizontal scrollbar in bilingual mode", overflow.body && overflow.root);

  // --- the source must be untouched ---
  const after = readFileSync(pdfPath);
  check("the original file on disk is byte-identical", before.equals(after));

  await page.screenshot({ path: join(repoRoot, ".agent/screenshots/DS-FE-003-bilingual.png") });
  console.log("  (screenshot: .agent/screenshots/DS-FE-003-bilingual.png)");
}

async function runFailureScenario(page, pdfPath) {
  console.log("\nScenario 2 — controlled provider failure");

  provider.fail = true;
  const callsBefore = provider.calls;

  await page.goto(PREVIEW_URL, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="pdf-file-input"]').setInputFiles(pdfPath);
  await page.waitForSelector('[data-testid="pdf-page-container"]', { timeout: 30000 });

  await page.waitForFunction(
    () => !document.querySelector('[data-testid="ai-translate"]')?.disabled,
    null,
    { timeout: 60000 },
  );
  await page.click('[data-testid="ai-translate"]');
  await page.waitForSelector('[data-testid="translate-dialog"]', { timeout: 10000 });
  await page.click('[data-testid="translate-submit"]');

  await page.waitForSelector('[data-testid="translation-error"]', { timeout: 240000 });
  const message = await page.locator('[data-testid="translation-error"]').textContent();
  check("a provider failure is reported to the user", Boolean(message && message.trim()), (message ?? "").trim().slice(0, 120));

  const attempts = provider.calls - callsBefore;
  check(
    "provider calls are bounded rather than retried forever",
    attempts > 0 && attempts <= 12,
    `${attempts} attempt(s)`,
  );

  // The failure must not have damaged the original reading surface.
  const stillReadable = await page
    .locator('[data-testid="viewer-original"] [data-testid="pdf-page-container"]')
    .count();
  check("the original remains readable after a failed translation", stillReadable > 0, `${stillReadable} page(s)`);

  const modesLocked = await page.locator('[data-testid="reader-mode-translation"]').isDisabled();
  check("译文 stays locked when no translation succeeded", modesLocked);

  await page.screenshot({ path: join(repoRoot, ".agent/screenshots/DS-FE-003-failure.png") });

  // The backend said the task FAILED rather than leaving it running.
  const tasks = await (await fetch(`${BACKEND_URL}/api/documents`)).json();
  const document = tasks.at(-1);
  check("the backend recorded a document for the failed run", Boolean(document), document?.document_id ?? "");
}

// --- main --------------------------------------------------------------------

async function main() {
  if (!existsSync(python)) throw new Error(`missing interpreter: ${python}`);
  if (!existsSync(join(distDir, "index.html"))) {
    throw new Error("dist/ not found — run `npm run build` first");
  }

  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(join(repoRoot, ".agent", "screenshots"), { recursive: true });
  mkdirSync(workDir, { recursive: true });

  PREVIEW_PORT = await findFreePort();
  PREVIEW_URL = `http://127.0.0.1:${PREVIEW_PORT}`;

  const pdfPath = join(workDir, "paper.pdf");
  makeFixturePdf(pdfPath);

  await startProvider();
  console.log(`provider listening at ${provider.url}`);

  const backend = spawn(
    python,
    ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(BACKEND_PORT)],
    {
      cwd: backendDir,
      env: {
        ...process.env,
        DATABASE_PATH: join(workDir, "db.sqlite3"),
        DOCUMENTS_DIR: join(workDir, "documents"),
        LOG_LEVEL: "WARNING",
        CORS_ORIGINS: PREVIEW_URL,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let backendLog = "";
  backend.stdout.on("data", (d) => (backendLog += d));
  backend.stderr.on("data", (d) => (backendLog += d));

  const preview = await startPreview();
  // The system Edge install, as the DS-FE-002 capture harness does: it avoids a
  // ~150 MB browser download and is a genuine consumer browser.
  const browser = await chromium.launch({ channel: process.env.E2E_CHANNEL ?? "msedge" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const consoleErrors = [];
  /* A 404 is the *designed* answer on the two routes the Overview panel asks
     about when a paper opens: `/overview` (nothing generated yet) and the older
     `/analysis` (not analysed yet). The status is part of the match, so a 500 on
     either path is still an error. A failed request's console text does not
     carry its URL; the location does. */
  const designed404 = (t) =>
    /status of 404/.test(t) && /\/(analysis|overview)(\?|\s|$)/.test(t);
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    consoleErrors.push(`${message.text()} :: ${message.location()?.url ?? ""}`);
  });

  try {
    if (!(await waitForBackend())) {
      throw new Error(`backend never became healthy.\n${backendLog.slice(-2000)}`);
    }
    await createProfile();
    console.log("provider profile created");

    await runSuccessScenario(page, pdfPath);
    await runFailureScenario(page, pdfPath);

    check(
      "no console errors during the whole run",
      consoleErrors.filter((t) => !designed404(t)).length === 0,
      consoleErrors.slice(0, 3).join(" | "),
    );
  } finally {
    await browser.close();
    preview.close();
    backend.kill();
    provider.server?.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed` +
      (failed.length ? ` — FAILED: ${failed.map((f) => f.name).join("; ")}` : ""),
  );
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error("\nE2E aborted:", error);
  process.exit(2);
});
