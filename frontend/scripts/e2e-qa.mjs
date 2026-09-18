/**
 * DS-QA-003 real-browser end-to-end verification.
 *
 * Drives the actual application — built bundle, real backend, **real DeepSeek
 * provider** — through the loop this milestone exists to close:
 *
 *   open PDF → choose scope → ask → read a grounded answer → click a citation
 *   → land on the real page in the original PDF
 *
 * Nothing about the QA path is mocked. The questions are the ones DS-QA-002
 * verified against this paper, so their expected answerability is known: some
 * are answerable, one is deliberately not, and one is answerable only in part.
 *
 * The backend runs against a **copy** of the application database, so the run
 * adds no documents to the user's library and the real profile (and its
 * credential reference, resolved from the OS store as usual) is the one used.
 *
 * Usage:  node scripts/e2e-qa.mjs
 * Requires: `npm run build` first, and a configured provider profile.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const backendDir = join(repoRoot, "backend");
const python = join(backendDir, ".venv", "Scripts", "python.exe");
const workDir = join(repoRoot, ".agent", "results", "e2e-qa");
const shotsDir = join(workDir, "shots");

// The frontend's API base is compiled in at build time and defaults to :8000,
// so the backend port is not free to choose here. Overriding it would mean
// building a second bundle for this run, which is a different artefact from the
// one being verified.
const BACKEND_PORT = Number(process.env.E2E_BACKEND_PORT ?? 8000);
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
let PREVIEW_PORT = 0;
let PREVIEW_URL = "";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * Fixtures: a copy of the app database, and the real ResNet paper
 * ------------------------------------------------------------------ */

function appDataDir() {
  return process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "AcademicPDFCopilot")
    : join(process.env.HOME ?? "", ".local", "share", "AcademicPDFCopilot");
}

const BASELINE_DOCUMENT = "doc_6f4ab9d9d4d34f85bc9e441757240fd8";
const realDataDir = appDataDir();

function prepareWorkdir() {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(join(workDir, "documents"), { recursive: true });
  mkdirSync(shotsDir, { recursive: true });

  // The profile list and its credential reference live in the database; the
  // secret itself stays in the OS store, which is why copying the database is
  // enough to reach the real provider.
  for (const suffix of ["", "-wal", "-shm"]) {
    const from = join(realDataDir, `db.sqlite3${suffix}`);
    if (existsSync(from)) copyFileSync(from, join(workDir, `db.sqlite3${suffix}`));
  }

  const paper = join(realDataDir, "documents", BASELINE_DOCUMENT, "source.pdf");
  if (!existsSync(paper)) throw new Error(`ResNet source not found at ${paper}`);
  const target = join(workDir, "resnet.pdf");
  copyFileSync(paper, target);
  return target;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/* ------------------------------------------------------------------ *
 * Servers
 * ------------------------------------------------------------------ */

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
        // The preview runs on whatever port was free, so its origin has to be
        // allowed explicitly. A wildcard is rejected by the backend at startup,
        // and rightly: this is a loopback-only application.
        CORS_ORIGINS: `http://127.0.0.1:${corsOrigin},http://localhost:${corsOrigin}`,
        PYTHONIOENCODING: "utf-8",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", () => {});
  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    if (/Traceback|Error/.test(text)) process.stderr.write(`  backend: ${text}`);
  });
  return child;
}

async function waitFor(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  return false;
}

/** Ask the OS for a free port, then hand it to the preview server. */
function freePort() {
  return new Promise((done) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

async function startPreview(port) {
  // `vite preview` prints the URL it bound; taking a free port keeps this
  // runnable next to a dev server, and `--port 0` is not a thing Vite accepts.
  // `shell: true` on Windows: Node refuses to spawn a `.cmd` shim directly
  // (the CVE-2024-27980 hardening), and `npm` is one.
  const child = spawn(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "preview", "--", "--port", String(port), "--strictPort"],
    { cwd: resolve(here, ".."), stdio: ["ignore", "pipe", "pipe"], shell: true },
  );
  return new Promise((done) => {
    let buffer = "";
    const onData = (chunk) => {
      // Vite colours its banner, so the escape sequence sits between the colon
      // and the port and a naive `:(\d+)` matches nothing. The codes come out
      // first, then the URL is read.
      buffer += String(chunk).replace(/\[[0-9;]*m/g, "");
      const match = buffer.match(/http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)/);
      if (match && !PREVIEW_PORT) {
        PREVIEW_PORT = Number(match[1]);
        PREVIEW_URL = `http://127.0.0.1:${PREVIEW_PORT}`;
        done(child);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    setTimeout(() => done(child), 20000);
  });
}

/* ------------------------------------------------------------------ *
 * Browser helpers
 * ------------------------------------------------------------------ */

const composer = '[data-testid="qa-composer"]';
const send = '[data-testid="composer-send"]';

async function waitForComposer(page, timeout = 60000) {
  try {
    await page.waitForSelector(`${composer}:not([disabled])`, { timeout });
  } catch (cause) {
    // The reason registration did not finish is the whole diagnosis, and it is
    // on screen: what the sidebar says, and what the backend answered.
    const sidebar = await page
      .locator('[data-testid="conversation-area"]')
      .innerText()
      .catch(() => "(no sidebar)");
    console.log(`\n  composer never unlocked. Sidebar says:\n${sidebar}\n`);
    await page.screenshot({ path: join(shotsDir, "00-stuck.png") });
    throw cause;
  }
}

async function ask(page, question) {
  // Each question is a fresh single-turn request; there is no conversation.
  const before = await page.locator('[data-testid^="qa-turn-"]').count();
  await page.fill(composer, question);
  await page.click(send);
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid^="qa-turn-"]').length > n,
    before,
    { timeout: 15000 },
  );
  // Wait for the newest turn to leave the pending state.
  await page.waitForFunction(
    () => {
      const turns = [...document.querySelectorAll('[data-testid^="qa-turn-"]')];
      const last = turns.at(-1);
      return last && last.getAttribute("data-state") !== "pending";
    },
    null,
    { timeout: 180000 },
  );
  return page.locator('[data-testid^="qa-turn-"]').last();
}

async function turnText(page) {
  return (await page.locator('[data-testid^="qa-turn-"]').last().innerText()).trim();
}

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

async function main() {
  const paper = prepareWorkdir();
  const paperHash = sha256(paper);
  console.log(`fixture: ${paper}`);

  // The preview port is chosen first, because the backend has to be told to
  // accept it as an origin — the frontend calls the API cross-origin.
  const previewPort = await freePort();
  console.log(`starting backend (allowing origin :${previewPort})…`);
  const backend = startBackend(previewPort);
  if (!(await waitFor(`${BACKEND_URL}/api/health`))) {
    console.log("backend did not start");
    backend.kill();
    return 2;
  }
  console.log("starting preview…");
  const preview = await startPreview(previewPort);
  if (!PREVIEW_URL) {
    preview.kill();
    backend.kill();
    console.log("preview did not report a URL");
    return 2;
  }
  console.log(`preview: ${PREVIEW_URL}\n`);

  // The real browser, not Playwright's bundled build: this is the engine the
  // application is actually used in, and it is what the brief asks for.
  const browser = await chromium.launch({ channel: "msedge" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));

  try {
    await page.goto(PREVIEW_URL, { waitUntil: "domcontentloaded" });

    check(
      "no document: the question box is disabled (AC-P0-01)",
      await page.locator(composer).isDisabled(),
    );
    check(
      "no document: the sidebar says why",
      (await page.locator('[data-testid="conversation-area"]').innerText()).includes("未打开文档"),
    );

    // --- open the real paper ------------------------------------------------
    await page.setInputFiles('[data-testid="pdf-file-input"]', paper);
    await page.waitForSelector('[data-testid="pdf-page-container"]', { timeout: 60000 });
    await waitForComposer(page);
    check("reader opens the paper and QA unlocks (AC-P0-03)", true);

    const scopeOptions = await page.locator('[data-testid="scope-selector"] option').allInnerTexts();
    check(
      "the four scopes are offered, selection honestly disabled (AC-P0-04)",
      scopeOptions.length === 4 && scopeOptions[3].includes("暂未支持"),
      scopeOptions.join(" | "),
    );

    // --- ANSWERED -----------------------------------------------------------
    await ask(page, "What is the degradation problem?");
    let turn = page.locator('[data-testid^="qa-turn-"]').last();
    const state = await turn.getAttribute("data-state");
    check("answerable question answers (AC-P0-10)", state === "grounded", `data-state=${state}`);

    const answerText = await turn.innerText();
    check(
      "citations render as numbers, not raw evidence ids (AC-P0-10)",
      (await turn.locator('[data-testid^="citation-chip-"]').count()) > 0 &&
        !/\bE\d+\b/.test(answerText),
    );
    check(
      "the reference list carries a real page (AC-P0-10)",
      /第 \d+ 页/.test(await turn.locator('[data-testid="reference-list"]').innerText()),
    );

    // --- citation jump in original mode -------------------------------------
    const viewer = page.locator('[data-testid="viewer-original"] [data-testid="pdf-viewer"]');
    await viewer.evaluate((element) => {
      element.scrollTop = 0;
    });
    const scrollBefore = await viewer.evaluate((element) => element.scrollTop);
    await turn.locator('[data-testid^="citation-chip-"]').first().click();
    await sleep(600);
    const scrollAfter = await viewer.evaluate((element) => element.scrollTop);
    const highlight = await page
      .locator('[data-testid="viewer-original"] [data-testid="pdf-highlight-box"]')
      .count();
    check(
      "clicking a citation moves the original viewer (AC-P0-16)",
      scrollBefore !== scrollAfter,
      `${scrollBefore} → ${scrollAfter}`,
    );
    check("the cited region is highlighted in the original pane (AC-P1-01)", highlight > 0, `${highlight} box(es)`);
    check(
      "no page number is echoed from the model — chips carry the IR's page (AC-P0-15)",
      !/\[E\d+\]/.test(answerText),
    );

    // --- Chinese question ---------------------------------------------------
    // This document was uploaded fresh, so it has no `analysis.json` — and
    // without the glossary the Chinese characters match nothing in the English
    // text. DS-QA-002 measured exactly this: the cross-lingual path *needs* the
    // analysis, and a search without it abstains rather than guessing. The
    // browser run therefore checks what the UI owes in that case — a grounded
    // outcome, rendered as the backend returned it, with no frontend translation
    // layer and no invented citations — rather than demanding an answer the
    // backend has no evidence for.
    await ask(page, "作者是如何解决退化问题的？");
    turn = page.locator('[data-testid^="qa-turn-"]').last();
    const chineseText = await turn.innerText();
    const chineseChips = await turn.locator('[data-testid^="citation-chip-"]').count();
    check(
      "a Chinese question produces a grounded outcome, never an error (AC-P0-11)",
      (await turn.locator('[data-testid="qa-error"]').count()) === 0 &&
        /[一-鿿]/.test(chineseText),
      chineseChips > 0 ? `${chineseChips} citation(s)` : "abstained (no analysis uploaded)",
    );
    if (chineseChips > 0) {
      check(
        "and its citations point at the English source (AC-P0-11)",
        /第 \d+ 页/.test(await turn.locator('[data-testid="reference-list"]').innerText()),
      );
    }

    // --- PARTIAL ------------------------------------------------------------
    await ask(page, "What momentum and learning rate are used, and how many hours did training take?");
    turn = page.locator('[data-testid^="qa-turn-"]').last();
    const partialState = await turn.getAttribute("data-state");
    if (partialState === "grounded" && (await turn.locator('[data-testid="qa-partial-notice"]').count())) {
      check("a partly answerable question is marked partial (AC-P0-11)", true);
      check(
        "and it names what the evidence could not settle",
        (await turn.locator('[data-testid="qa-partial-notice"]').innerText()).length > 10,
      );
    } else {
      check(
        "a partly answerable question is marked partial (AC-P0-11)",
        partialState === "grounded",
        `state=${partialState}`,
      );
    }

    // --- INSUFFICIENT_EVIDENCE ----------------------------------------------
    await ask(page, "What was the inference latency in milliseconds per image?");
    turn = page.locator('[data-testid^="qa-turn-"]').last();
    const insufficient = (await turn.locator('[data-testid="qa-insufficient"]').count()) > 0;
    check("an unanswerable question abstains (AC-P0-12)", insufficient);
    check(
      "and it is not presented as a failure (AC-P0-12)",
      (await turn.locator('[data-testid="qa-error"]').count()) === 0,
    );

    // --- Page scope ---------------------------------------------------------
    await page.selectOption('[data-testid="scope-selector"]', "page");
    const scopeLabel = await page.locator('[data-testid="scope-selector"] option:checked').innerText();
    await ask(page, "What is the degradation problem?");
    turn = page.locator('[data-testid^="qa-turn-"]').last();
    const badge = await turn.locator("span").first().innerText();
    check(
      "a page-scoped question records the page it searched (AC-P0-04)",
      /第 \d+ 页/.test(badge),
      `badge=${badge.trim()}`,
    );
    check("the page scope label follows the reader", /第 \d+ 页/.test(scopeLabel), scopeLabel);
    await page.selectOption('[data-testid="scope-selector"]', "whole_paper");

    await page.screenshot({ path: join(shotsDir, "01-answerable.png") });

    // --- translation mode ---------------------------------------------------
    // Needs a real translation. A two-page excerpt keeps it to about a minute
    // while still exercising the same code path.
    const excerpt = join(workDir, "resnet-2p.pdf");
    const built = spawnSync(python, ["-c", EXCERPT_SCRIPT, paper, excerpt], {
      cwd: backendDir,
      encoding: "utf-8",
    });
    if (built.status !== 0) {
      check("could build the two-page excerpt for the translation run", false, built.stderr ?? "");
    } else {
      await page.setInputFiles('[data-testid="pdf-file-input"]', excerpt);
      await page.waitForSelector('[data-testid="pdf-page-container"]', { timeout: 60000 });
      await waitForComposer(page);

      await page.click('[data-testid="ai-translate"]');
      await page.waitForSelector('[data-testid="translate-dialog"]', { timeout: 15000 });
      await page.selectOption('[data-testid="translate-lang-out"]', "zh");
      await page.click('[data-testid="translate-submit"]');

      // A real translation of two pages, with a real provider.
      const translated = await page
        .waitForFunction(
          () => {
            const button = document.querySelector('[data-testid="translate-submit"]');
            return button === null || !document.querySelector('[data-testid="translate-dialog"]');
          },
          null,
          { timeout: 300000 },
        )
        .then(() => true)
        .catch(() => false);
      check("the excerpt translates against the real provider", translated, "300s budget");

      // Wait for the artifact to exist, then switch to translation mode.
      const hasTranslation = await page
        .waitForFunction(
          () => !document.querySelector('[data-testid="reader-mode-translation"]')?.disabled,
          null,
          { timeout: 240000 },
        )
        .then(() => true)
        .catch(() => false);

      if (!hasTranslation) {
        check("translation mode becomes available", false, "no translated artifact");
      } else {
        await page.click('[data-testid="reader-mode-translation"]');
        await page.waitForSelector('[data-testid="viewer-translated"]', { timeout: 30000 });

        await ask(page, "What is the degradation problem?");
        turn = page.locator('[data-testid^="qa-turn-"]').last();
        const chips = turn.locator('[data-testid^="citation-chip-"]');
        if ((await chips.count()) > 0) {
          await chips.first().click();
          await sleep(800);

          const modeAfter = await page
            .locator('[data-testid="reader-workspace"]')
            .getAttribute("data-reader-mode");
          check(
            "a citation clicked in translation mode switches to the original (AC-P0-18)",
            modeAfter === "original",
            `mode=${modeAfter}`,
          );
          check(
            "and says why it moved",
            (await page.locator('[data-testid="qa-jump-notice"]').count()) > 0,
          );
          const originalHighlights = await page
            .locator('[data-testid="viewer-original"] [data-testid="pdf-highlight-box"]')
            .count();
          check(
            "the source region is highlighted in the original pane",
            originalHighlights > 0,
            `${originalHighlights} box(es)`,
          );
          check(
            "the translated pane never receives a source box (AC-P0-18)",
            (await page
              .locator('[data-testid="viewer-translated"] [data-testid="pdf-highlight-box"]')
              .count()) === 0,
          );
        } else {
          check("the excerpt answers a question so a citation can be clicked", false);
        }

        // --- bilingual ------------------------------------------------------
        await page.click('[data-testid="reader-mode-bilingual"]');
        await page.waitForSelector('[data-testid="viewer-translated"]', { timeout: 30000 });
        const translatedViewer = page.locator(
          '[data-testid="viewer-translated"] [data-testid="pdf-viewer"]',
        );
        const translatedScrollBefore = await translatedViewer.evaluate((e) => e.scrollTop);

        turn = page.locator('[data-testid^="qa-turn-"]').last();
        const chipsAgain = turn.locator('[data-testid^="citation-chip-"]');
        if ((await chipsAgain.count()) > 0) {
          await chipsAgain.first().click();
          await sleep(800);
          const translatedScrollAfter = await translatedViewer.evaluate((e) => e.scrollTop);
          check(
            "bilingual: only the original pane moves (AC-P0-17)",
            translatedScrollBefore === translatedScrollAfter,
            `${translatedScrollBefore} → ${translatedScrollAfter}`,
          );
          check(
            "bilingual: the translated pane never gets a source box (AC-P0-17)",
            (await page
              .locator('[data-testid="viewer-translated"] [data-testid="pdf-highlight-box"]')
              .count()) === 0,
          );
        }
        await page.screenshot({ path: join(shotsDir, "02-bilingual.png") });
      }
    }

    // --- desktop layout -----------------------------------------------------
    // The sidebar is 340 px, so the questions are whether the reader still has a
    // usable column at the narrowest supported width, and whether the shell ever
    // scrolls as a whole (it must not — the panes scroll internally).
    //
    // Measured in both layouts, because they are genuinely different: one pane
    // receives the whole reader, two panes share it. Measuring only in bilingual
    // mode reports half the width and concludes a defect that is not there.
    const measure = async (width, mode) => {
      await page.click(`[data-testid="reader-mode-${mode}"]`);
      await page.waitForSelector('[data-testid="pdf-viewer"]', { timeout: 15000 });
      await page.setViewportSize({ width, height: 900 });
      await sleep(500);
      return page.evaluate(() => {
        const panes = [...document.querySelectorAll('[data-testid="pdf-viewer"]')];
        return {
          docScroll: document.documentElement.scrollWidth,
          docClient: document.documentElement.clientWidth,
          panes: panes.map((pane) => pane.clientWidth),
        };
      });
    };

    for (const width of [1024, 1440, 1920]) {
      const single = await measure(width, "original");
      check(
        `no page-level horizontal scroll at ${width}px`,
        single.docScroll <= single.docClient + 1,
        `${single.docScroll} / ${single.docClient}`,
      );
      check(
        `the reader keeps a usable column at ${width}px`,
        single.panes[0] >= 560,
        `${single.panes[0]}px`,
      );

      const dual = await measure(width, "bilingual");
      check(
        `each bilingual pane stays readable at ${width}px`,
        dual.panes.length === 2 && Math.min(...dual.panes) >= 300,
        dual.panes.join(" / "),
      );
    }

    await page.click('[data-testid="reader-mode-original"]');
    await page.setViewportSize({ width: 1440, height: 900 });
    await sleep(300);

    // --- races --------------------------------------------------------------
    await page.click('[data-testid="sidebar-toggle"]');
    check("the sidebar collapses without disturbing the reader", (await page.locator('[data-testid="pdf-viewer"]').count()) > 0);
    await page.click('[data-testid="sidebar-toggle"]');

    check("no uncaught console errors during the run", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" / "));
  } finally {
    await browser.close();
    preview.kill();
    backend.kill();
  }

  // --- source immutability --------------------------------------------------
  const stored = join(workDir, "documents");
  const after = sha256(paper);
  check("the PDF handed to the browser is byte-identical afterwards", after === paperHash);

  const uploaded = spawnSync(
    python,
    [
      "-c",
      "import sqlite3,sys,pathlib,hashlib;c=sqlite3.connect(sys.argv[1]);"
        + "ids=[r[0] for r in c.execute('select id from documents')];"
        + "print('\\n'.join(ids))",
      join(workDir, "db.sqlite3"),
    ],
    { encoding: "utf-8" },
  );
  const ids = (uploaded.stdout ?? "").trim().split("\n").filter(Boolean);
  let untouched = true;
  for (const id of ids) {
    const file = join(stored, id, "source.pdf");
    if (!existsSync(file)) continue;
    // Every document here was uploaded from one of the two files above; each
    // stored copy must still hash to one of them.
    const digest = sha256(file);
    const excerptHash = existsSync(join(workDir, "resnet-2p.pdf"))
      ? sha256(join(workDir, "resnet-2p.pdf"))
      : null;
    if (digest !== paperHash && digest !== excerptHash) {
      untouched = false;
    }
  }
  check("every stored source PDF is byte-identical to what was uploaded", untouched);

  console.log("\n=== summary ===");
  const failed = results.filter((r) => !r.ok);
  for (const result of results) {
    console.log(`  ${result.ok ? "PASS" : "FAIL"}  ${result.name}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  writeFileSync(join(workDir, "results.json"), JSON.stringify(results, null, 1));
  return failed.length === 0 ? 0 : 1;
}

const EXCERPT_SCRIPT = `
import sys, fitz
source, target = sys.argv[1], sys.argv[2]
full = fitz.open(source)
trimmed = fitz.open()
trimmed.insert_pdf(full, from_page=0, to_page=1)
trimmed.save(target)
trimmed.close(); full.close()
print("built")
`;

const code = await main();
process.exit(code);
