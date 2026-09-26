/**
 * DS-DOC-008 — the reflowed reading, in a real browser.
 *
 * The paper unrolled into one column: prose set as prose, each paragraph with
 * its translation under it, and the paper's figures, tables and formulas carried
 * as crops of its own pages. So the checks here are about what is on the screen:
 * that the prose is text and the formulas are never text, that a caption sits
 * with the crop it belongs to rather than where the block order put it, that a
 * real drag copies the prose without the chrome, and that opening the reading —
 * again, and again — costs the reader nothing.
 *
 * What this exists for is what a component test cannot reach: a **real drag**
 * producing a real selection (the clipboard half of AC-P0-19), the jump that puts
 * the reader back in the PDF, and the whole pipeline running end to end —
 * batching, prompts, parsing, validation, the cache — against a provider that
 * answers on loopback.
 *
 * That last part is the point of the stub. A real provider would cost nine calls
 * and a few tens of thousands of tokens; a stub that answers the prompt's own
 * shape exercises the same code for nothing, and the ledger still proves that the
 * *reader's* actions — opening, reading, reopening — cost zero.
 *
 * Usage: node scripts/e2e-bilingual-reading.mjs
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
const workDir = join(repoRoot, ".agent", "results", "e2e-reflow-bilingual");
const BACKEND_PORT = 8000;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const PAPER = join(repoRoot, ".agent", "results", "e2e-qa", "resnet.pdf");

let PREVIEW_URL = "";
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * A provider that translates, on loopback
 * ------------------------------------------------------------------ */

/**
 * Answers the translation prompt's own shape: every id it was given, once.
 *
 * It is not a translator — it prefixes a marker — and it does not need to be: the
 * pipeline under test is the one that plans batches, builds prompts, parses
 * answers, validates them and assembles an artifact, and this exercises all of
 * it. What a real model would add is wording, and no criterion here is about
 * wording.
 */
function startStubProvider(port) {
  let calls = 0;
  const server = createHttpServer((request, response) => {
    const url = request.url ?? "";
    if (url.endsWith("/chat/completions") && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => { body += String(chunk); });
      request.on("end", () => {
        calls += 1;
        let prompt = "";
        try {
          const parsed = JSON.parse(body);
          prompt = (parsed.messages ?? [])
            .map((message) => message.content ?? "")
            .join("\n");
        } catch { /* answered empty; the pipeline will call it a failed batch */ }

        const headingPart = prompt.split("Paragraphs:")[0] ?? "";
        const paragraphPart = prompt.split("Paragraphs:")[1] ?? "";
        const ids = (text) => [...text.matchAll(/^\[([^\]]+)\]/gm)].map((match) => match[1]);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          id: "chatcmpl-stub", object: "chat.completion", created: 1, model: "stub-translator",
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                headings: ids(headingPart).map((id) => ({ id, text: `【译】${id}` })),
                paragraphs: ids(paragraphPart).map((id) => ({ id, text: `【译】${id}` })),
              }),
            },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }));
      });
      return;
    }
    if (url.endsWith("/models")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: "stub-translator", object: "model" }] }));
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not found" } }));
  });
  return new Promise((done) => {
    server.listen(port, "127.0.0.1", () => done({ server, calls: () => calls }));
  });
}

/* ------------------------------------------------------------------ *
 * Fixtures and servers
 * ------------------------------------------------------------------ */

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

/** The document the page has open, as the backend knows it. */
let documentId = "";

async function main() {
  prepare();
  const stubPort = await freePort();
  const stub = await startStubProvider(stubPort);
  console.log(`stub provider: http://127.0.0.1:${stubPort}/v1`);

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

  // A provider profile pointing at the stub. Created over the API because this
  // harness is about the reading, not about the settings screen.
  const profile = await fetch(`${BACKEND_URL}/api/profiles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Stub", base_url: `http://127.0.0.1:${stubPort}/v1`, model: "stub-translator",
    }),
  }).then((response) => response.json());
  console.log(`profile: ${profile.id}\n`);

  const browser = await chromium.launch({ channel: "msedge" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    consoleErrors.push(`${m.text()} :: ${m.location()?.url ?? ""}`);
  });
  // An exception thrown in a React effect never reaches the console handler as a
  // message this repository's filters can classify, so it is collected apart.
  page.on("pageerror", (error) => {
    consoleErrors.push(`UNCAUGHT ${error.message}`);
  });

  try {
    await page.goto(PREVIEW_URL, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="reader-workspace"]', { timeout: 30000 });
    await page.setInputFiles('[data-testid="pdf-file-input"]', PAPER);
    await page.waitForSelector('[data-testid="pdf-page-container"]', { timeout: 120000 });

    // The app needs a profile selected; the settings screen is the product path.
    await page.click('[data-testid="settings-open"]');
    await page.waitForSelector('[data-testid="settings-profile-list"] li', { timeout: 30000 });
    await page.click('[data-testid="settings-profile-list"] li button');
    await page.waitForSelector('[data-testid="settings-form"]', { timeout: 15000 });
    await page.click('[data-testid="settings-dialog"] button[aria-label="关闭"], [data-testid="settings-dialog"] >> text=取消');
    await page.keyboard.press("Escape");

    // --- 1. the mode, and the reading it will cost --------------------------
    await page.click('[data-testid="reader-mode-immersive"]');
    try {
      await page.waitForSelector('[data-testid="bilingual-not-generated"]', { timeout: 30000 });
    } catch (error) {
      // Say what was actually on screen: a bare timeout sends the next reader of
      // this log hunting for a product bug that is a wrong selector.
      const pane = await page.locator('[data-testid="reader-workspace"]').innerText().catch(() => "(none)");
      console.error("reader pane at the timeout:", pane.slice(0, 600));
      console.error("console:", consoleErrors.slice(0, 4).join(" | "));
      throw error;
    }
    const plan = await page.locator('[data-testid="bilingual-plan"]').innerText();
    check("the column says what a generation would cost before it is asked for",
      /\d+ 个段落/.test(plan) && /预计 \d+ 次模型请求/.test(plan), plan.trim());

    const beforeGenerate = await ledger();
    check("and nothing has been spent waiting to be asked", beforeGenerate.calls === 0,
      JSON.stringify(beforeGenerate));

    // --- 2. the reader asks ------------------------------------------------
    documentId = await page.evaluate(async () => {
      const response = await fetch("http://127.0.0.1:8000/api/documents");
      const documents = await response.json();
      return documents[0]?.document_id ?? "";
    });
    await page.click('[data-testid="bilingual-generate-btn"]');
    await page.waitForSelector('[data-testid="reflow-pair"]', { timeout: 300000 });

    const counts = await page.evaluate(() => ({
      pairs: document.querySelectorAll('[data-testid="reflow-pair"]').length,
      translations: document.querySelectorAll('[data-testid="reflow-translation"]').length,
      headings: document.querySelectorAll('[data-testid="reflow-heading"]').length,
      crops: document.querySelectorAll('[data-testid="reflow-crop"]').length,
      captions: document.querySelectorAll('[data-testid="reflow-caption"]').length,
    }));
    check("the paper is reflowed into one column of paragraph pairs", counts.pairs > 90,
      JSON.stringify(counts));
    check("each paragraph that has a translation shows it", counts.translations > 80,
      `${counts.translations} translation(s)`);
    check("every figure, table and formula is carried", counts.crops > 15,
      `${counts.crops} crop(s)`);

    // The paper is drawn, not re-typeset: every region carries a canvas, and the
    // canvases have real pixels in them at the live scale.
    // The prose is text now — and a formula never is: its extracted string is
    // scrambled, so the crops are the only honest way to show it.
    const reading = await page.evaluate(() => {
      const first = document.querySelector('[data-testid="reflow-source"]');
      const crops = Array.from(document.querySelectorAll('[data-testid="reflow-crop"] canvas'));
      return {
        sourceText: (first?.textContent ?? "").slice(0, 60),
        painted: crops.filter((canvas) => canvas.width > 0 && canvas.height > 0).length,
        crops: crops.length,
        widths: crops.slice(0, 3).map((canvas) => Math.round(canvas.getBoundingClientRect().width)),
      };
    });
    check("the paper's prose is selectable text", reading.sourceText.length > 30,
      JSON.stringify(reading.sourceText));
    check("every crop is painted from the page, at the live scale",
      reading.crops > 0 && reading.painted === reading.crops && reading.widths.every((w) => w > 20),
      JSON.stringify(reading));

    const artifact = await fetch(`${BACKEND_URL}/api/documents/${documentId}/bilingual-text`).then(
      (response) => response.json(),
    );
    const scrambled = (artifact.blocks ?? []).find(
      (block) => block.layout_class === "isolate_formula" && (block.text ?? "").length > 10,
    )?.text ?? "";
    const shownText = await page.locator('[data-testid="reflow-scroll"]').innerText();
    check("a formula is never shown as its extracted text",
      scrambled === "" || !shownText.includes(scrambled.slice(0, 20).trim()),
      JSON.stringify(scrambled.slice(0, 24)));

    const afterGenerate = await ledger();
    const synthesis = afterGenerate.by_operation?.bilingual_text ?? 0;
    const probes = afterGenerate.by_operation?.unlabelled ?? 0;
    check("and it cost one call per batch, within the frozen bound",
      synthesis >= 5 && synthesis <= 10,
      `${synthesis} synthesis call(s) + ${probes} protocol probe(s) = ${afterGenerate.calls} request(s)`);

    // The trap: captions sit before their targets about as often as after, so
    // this asks the DOM where each caption ended up relative to its own crop.
    const captionPlacement = await page.evaluate(() => {
      const crops = Array.from(document.querySelectorAll('[data-testid="reflow-crop"]'));
      const result = { figure: [], table: [], formula: [] };
      for (const crop of crops) {
        const kind = crop.dataset.layoutClass ?? "";
        const caption = crop.querySelector('[data-testid="reflow-caption"]');
        if (caption === null) continue;
        const side = crop.dataset.classCaption ?? "?";
        const children = Array.from(crop.children);
        const at = children.findIndex((child) => child.contains(caption));
        const canvasAt = children.findIndex((child) => child.querySelector("canvas") !== null);
        result[kind] ??= [];
        result[kind].push({ side, before: at < canvasAt, after: at > canvasAt });
      }
      return result;
    });
    const figures = captionPlacement.figure ?? [];
    const tables = captionPlacement.table ?? [];
    const formulas = captionPlacement.formula ?? [];
    check("a figure's caption is below its figure, wherever the order put it",
      figures.length > 0 && figures.every((entry) => entry.side === "below" && entry.after),
      `${figures.length} figure(s): ${JSON.stringify(figures.slice(0, 3))}`);
    check("a table's caption is above its table",
      tables.length > 0 && tables.every((entry) => entry.side === "above" && entry.before),
      `${tables.length} table(s): ${JSON.stringify(tables.slice(0, 3))}`);
    check("a formula's caption sits beside it",
      formulas.every((entry) => entry.side === "beside"),
      `${formulas.length} formula(s): ${JSON.stringify(formulas.slice(0, 3))}`);

    const headings = await page.evaluate(() => ({
      count: document.querySelectorAll('[data-testid="reflow-heading"]').length,
      translated: document.querySelectorAll('[data-testid="reflow-heading-translated"]').length,
      first: (document.querySelector('[data-testid="reflow-heading"]')?.textContent ?? "").slice(0, 40),
    }));
    check("headings come from the extractor's sections, in both languages",
      headings.count > 8 && headings.translated > 0, JSON.stringify(headings));

    const notices = await page.locator('[data-testid="reflow-references-notice"]').count();
    check("the references are kept in the paper's words and say so", notices >= 1,
      `${notices} notice(s)`);

    // --- 3. the clipboard, with a real drag ---------------------------------
    const prose = page.locator('[data-testid="reflow-translation"]').nth(1);
    await prose.scrollIntoViewIfNeeded();
    const box = await prose.boundingBox();
    if (box) {
      await page.mouse.move(box.x + 4, box.y + 4);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 4, box.y + box.height - 4, { steps: 12 });
      await page.mouse.up();
    }
    const copied = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    const proseText = (await prose.innerText()).trim();
    check("a drag across a translation selects it", copied.trim().length > 20,
      copied.trim().slice(0, 40));
    check("and the selection carries no badge, button or gap notice",
      !copied.includes("P. ") && !/未翻译/.test(copied) && !/分栏/.test(copied) && !/重新生成/.test(copied),
      copied.slice(-40));
    check("the copied text is the translation's own words",
      proseText.includes(copied.trim().slice(0, 20)), proseText.slice(0, 30));

    // --- 3b. typing is readable without zooming ------------------------------
    const type = await page.evaluate(() => {
      const source = document.querySelector('[data-testid="reflow-source"]');
      const column = source?.closest("div[class*='max-w-']");
      return {
        font: source ? Number.parseFloat(getComputedStyle(source).fontSize) : 0,
        lineHeight: source ? Number.parseFloat(getComputedStyle(source).lineHeight) : 0,
        measure: column ? Math.round(column.getBoundingClientRect().width) : 0,
      };
    });
    check("the prose is set at a readable size and measure",
      type.font >= 14 && type.lineHeight >= type.font * 1.4 && type.measure <= 700,
      `font ${type.font}px, line-height ${type.lineHeight}px, measure ${type.measure}px`);

    // --- 3b2. a crop is re-rendered on zoom, never stretched -----------------
    const measureCrop = () =>
      page.evaluate(() => {
        const canvas = document.querySelector('[data-testid="reflow-crop"] canvas');
        if (canvas === null) return null;
        return {
          pixels: canvas.width,
          css: Math.round(canvas.getBoundingClientRect().width),
          // A bitmap stretched by CSS is the failure this criterion names: the
          // backing store would be smaller than what is shown.
          stretched: canvas.width < Math.round(canvas.getBoundingClientRect().width),
        };
      });
    await page.locator('[data-testid="reflow-crop"]').first().scrollIntoViewIfNeeded();
    await sleep(1200);
    const cropBefore = await measureCrop();
    await page.click('[aria-label="放大"]');
    await sleep(2500);
    const cropAfter = await measureCrop();
    check("a crop is re-rendered at the new scale, not stretched",
      cropBefore !== null &&
        cropAfter !== null &&
        cropAfter.pixels > cropBefore.pixels &&
        cropAfter.stretched === false,
      `${JSON.stringify(cropBefore)} -> ${JSON.stringify(cropAfter)}`);

    // --- 3c. an outline click moves the reflowed column --------------------
    await page.click('[data-testid="assistant-tab-outline"]');
    await page.waitForSelector('[data-testid="outline-panel"]', { timeout: 30000 });
    const nodes = page.locator('[data-testid^="outline-node-"]');
    const nodeCount = await nodes.count();
    // A section later in the paper, so the scroll has somewhere to go.
    const target = nodes.nth(Math.min(6, nodeCount - 1));
    const label = (await target.innerText()).replace(/\s+/g, " ").trim().slice(0, 30);
    const scrollBefore = await page.evaluate(
      () => document.querySelector('[data-testid="reflow-scroll"]').scrollTop,
    );
    await target.click();
    await sleep(1200);
    const scrollAfter = await page.evaluate(
      () => document.querySelector('[data-testid="reflow-scroll"]').scrollTop,
    );
    check("a section in the outline moves the unrolled page",
      nodeCount > 1 && scrollAfter !== scrollBefore,
      `"${label}": scrollTop ${Math.round(scrollBefore)} -> ${Math.round(scrollAfter)}`);

    // --- 4. back to the paper, the way the reader does it -------------------
    // The reflowed column is one stream with no page badges; the reader gets
    // back to the paper's own pages by choosing the 原文 mode.
    await page.click('[data-testid="reader-mode-original"]');
    await page.waitForSelector('[data-testid="pdf-page-container"]', { timeout: 60000 });
    const mode = await page.getAttribute('[data-testid="reader-workspace"]', "data-reader-mode");
    check("switching to 原文 puts the reader back in the PDF", mode === "original", `mode ${mode}`);

    // --- 5. reopening is free ----------------------------------------------
    const documentIds = () =>
      page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="document-name"]'))
        .map((node) => node.textContent));
    await documentIds();
    // From here the question is what *reopening* costs, so the ledger starts
    // empty. Without this the check would report every call the session has made.
    await fetch(`${BACKEND_URL}/api/_debug/provider-ledger/reset`, { method: "POST" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="reader-workspace"]', { timeout: 120000 });
    // The step above left the reader in the PDF, which is what a reload restores;
    // the question here is what *opening the reading again* costs.
    await page.click('[data-testid="reader-mode-immersive"]');
    await page.waitForSelector('[data-testid="reflow-pair"]', { timeout: 120000 });
    const hash = createHash("sha256").update(readFileSync(PAPER)).digest("hex").slice(0, 12);
    const cached = readdirSync(join(workDir, "documents", "_cache", "bilingual"))
      .some((name) => name.startsWith(hash));
    check("the reading is cached under the paper's content hash", cached, hash);

    const reopenCalls = await ledger();
    check("reopening renders it without reaching a provider", reopenCalls.calls === 0,
      JSON.stringify(reopenCalls));

    const designed = (text) =>
      /status of 404/.test(text) && /\/(overview|analysis|bilingual-text)(\?|\s|$)/.test(text);
    check("no uncaught console errors during the run",
      consoleErrors.filter((text) => !designed(text)).length === 0,
      consoleErrors.slice(0, 2).join(" | "));
    console.log(`  [info] the stub answered ${stub.calls()} provider requests in total`);
  } finally {
    await browser.close();
    preview.kill();
    backend.kill();
    stub.server.close();
  }

  const failed = results.filter((r) => !r.ok);
  writeFileSync(join(workDir, "results.json"),
    JSON.stringify({ results, passed: results.length - failed.length }, null, 1));
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
