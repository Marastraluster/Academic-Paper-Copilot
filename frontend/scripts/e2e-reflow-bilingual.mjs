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

        const ids = (text) => [...text.matchAll(/^\[([^\]]+)\]/gm)].map((match) => match[1]);
        /* The reconstruction prompt sends one JSON object per line, keyed by
           `block_id`; the translation prompt sends `[id]` lines. The stub
           answers whichever it was asked, in the shape that prompt defines. */
        const formulaPart = prompt.split("Formulas to reconstruct:")[1] ?? "";
        const formulaIds = formulaPart
          .split(String.fromCharCode(10))
          .map((line) => line.trim())
          .filter((line) => line.startsWith("{"))
          .map((line) => {
            try {
              return JSON.parse(line).block_id;
            } catch {
              return null;
            }
          })
          .filter((id) => typeof id === "string" && id !== "");
        const isFormulaPrompt = /Formulas to reconstruct:/.test(prompt);
        const answer = isFormulaPrompt
          // The reconstruction prompt: one entry per formula, each either a
          // LaTeX answer or an honest refusal. Every third formula is refused so
          // the fallback path is exercised by the same run that exercises the
          // happy one.
          ? {
              // Keyed by `block_id`, which is what both the prompt and the
              // pipeline's parser use — the shape the criteria froze.
              formulas: formulaIds.map((block_id, index) =>
                index % 3 === 2
                  ? { block_id, status: "refusal", refusal_reason: "stub: 字形无法辨识" }
                  : {
                      block_id,
                      status: "reconstructed",
                      latex: String.fromCharCode(92) + "\mathcal{L}_{" + index + "} = " + String.fromCharCode(92) + "sum_{i=1}^{N} " + String.fromCharCode(92) + "frac{a_i}{b_i}",
                    },
              ),
            }
          : {
              headings: ids((prompt.split("Paragraphs:")[0] ?? "")).map((id) => ({
                id,
                text: `【译】${id}`,
              })),
              paragraphs: ids((prompt.split("Paragraphs:")[1] ?? "")).map((id) => ({
                id,
                text: `【译】${id}`,
              })),
            };
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          id: "chatcmpl-stub", object: "chat.completion", created: 1, model: "stub-translator",
          choices: [{
            index: 0,
            message: { role: "assistant", content: JSON.stringify(answer) },
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
  // Keep the talkative logs out of the way, but keep the *errors*: a swallowed
  // traceback is how a real defect looks like a silent timeout three steps later.
  child.stdout.on("data", () => {});
  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    if (/Traceback|Error|error:|Exception/i.test(text)) console.error("[backend]", text.slice(0, 600));
  });
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

/** Is something already answering on the port this suite needs? */
async function portIsTaken() {
  try {
    const response = await fetch(`${BACKEND_URL}/api/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function main() {
  prepare();
  const stubPort = await freePort();
  const stub = await startStubProvider(stubPort);
  console.log(`stub provider: http://127.0.0.1:${stubPort}/v1`);

  /* A backend left running from another session holds this port, and then every
     request this suite makes lands in the wrong data directory — which presents
     as `profile: undefined` three steps later and cost three confusing failures
     before it was named. Fail here instead, saying what to do. */
  if (await portIsTaken()) {
    throw new Error(
      `something is already listening on ${BACKEND_URL} — stop it before running this suite ` +
        "(a backend left over from another session is the usual cause)",
    );
  }

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

  /* Offline-first is a claim this application makes in its README. A dependency
     added for formula rendering is the first thing that could quietly break it,
     so every request the page makes is inspected: loopback and blob/data URLs
     only. */
  const offsiteRequests = [];
  page.on("request", (request) => {
    const url = request.url();
    if (url.startsWith("blob:") || url.startsWith("data:")) return;
    try {
      const { hostname, protocol } = new URL(url);
      if (protocol === "file:") return;
      if (hostname === "127.0.0.1" || hostname === "localhost") return;
      offsiteRequests.push(url);
    } catch {
      offsiteRequests.push(url);
    }
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
      const translation = document.querySelector('[data-testid="reflow-translation"]');
      const column = source?.closest("div[class*='max-w-']");
      const style = source ? getComputedStyle(source) : null;
      const translationStyle = translation ? getComputedStyle(translation) : null;
      return {
        font: source ? Number.parseFloat(style.fontSize) : 0,
        lineHeight: source ? Number.parseFloat(style.lineHeight) : 0,
        measure: column ? Math.round(column.getBoundingClientRect().width) : 0,
        sourceFamily: style?.fontFamily ?? "",
        translationFamily: translationStyle?.fontFamily ?? "",
        translationFont: translation ? Number.parseFloat(translationStyle.fontSize) : 0,
      };
    });
    check("the prose is set at a readable size and measure",
      type.font >= 15.5 && type.lineHeight >= 26 && type.measure <= 680,
      `font ${type.font}px, line-height ${type.lineHeight}px, measure ${type.measure}px`);
    const SERIF_FACES = /Charter|Source Serif|Iowan|Georgia|Cambria|Times New Roman/;
    check("the source is set in a serif face and the translation is not",
      SERIF_FACES.test(type.sourceFamily) &&
        !SERIF_FACES.test(type.translationFamily) &&
        /YaHei|PingFang|WenQuanYi Micro Hei/.test(type.translationFamily),
      `source "${type.sourceFamily.split(",")[0]}" / translation "${type.translationFamily.split(",").slice(-4).join(",")}"`);

    // --- 3b1. the formula is drawn larger, and centred with its number --------
    // Wait for the crop to be painted: a raster may have to be re-rendered after
    // the cache handed one back, and measuring mid-render measures the wait.
    await page.waitForFunction(
      () => {
        const crop = document.querySelector(
          '[data-testid="reflow-crop"][data-layout-class="isolate_formula"] canvas',
        );
        return crop !== null && crop.width > 1;
      },
      null,
      { timeout: 30000 },
    );
    const formula = await page.evaluate(() => {
      const crop = document.querySelector('[data-testid="reflow-crop"][data-layout-class="isolate_formula"]');
      if (crop === null) return null;
      const column = document.querySelector('[data-testid="reflow-source"]')?.closest("div[class*='max-w-']");
      const canvas = crop.querySelector("canvas");
      const number = crop.querySelector('[data-testid="reflow-caption"]');
      if (canvas === null || column === null) return null;
      const box = canvas.getBoundingClientRect();
      const columnBox = column.getBoundingClientRect();
      const styleWidth = Number.parseFloat(getComputedStyle(canvas).width);
      return {
        recorded: Number(crop.dataset.displayWidth ?? 0),
        styleWidth: Math.round(styleWidth),
        drawn: Math.round(box.width),
        columnWidth: Math.round(columnBox.width),
        offsetFromCentre: Math.round(
          Math.abs((box.left + box.width / 2) - (columnBox.left + columnBox.width / 2)),
        ),
        numberRightGap: number
          ? Math.round(Math.abs(columnBox.right - number.getBoundingClientRect().right))
          : null,
      };
    });
    // The formula is drawn at the width the view computed — the canvas is the
    // size it was told to be, not stretched to something else.
    check("a formula is drawn at the magnified width the view computed, not stretched",
      formula !== null &&
        formula.recorded > 0 &&
        formula.drawn === formula.recorded &&
        formula.styleWidth === formula.recorded,
      JSON.stringify(formula));
    check("a formula is centred in the column, its number at the right margin",
      formula !== null && formula.offsetFromCentre <= 4 &&
        (formula.numberRightGap === null || formula.numberRightGap <= 12),
      JSON.stringify(formula));

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

    // --- 3b3. the whole paper and back: the raster cache must hand memory back
    const height = await page.evaluate(
      () => document.querySelector('[data-testid="reflow-scroll"]').scrollHeight,
    );
    await page.evaluate((to) => {
      document.querySelector('[data-testid="reflow-scroll"]').scrollTo({ top: to });
    }, height);
    await sleep(2500);
    await page.evaluate(() => {
      document.querySelector('[data-testid="reflow-scroll"]').scrollTo({ top: 0 });
    });
    await sleep(2500);
    const afterRoundTrip = await page.evaluate(() => {
      const crops = Array.from(document.querySelectorAll('[data-testid="reflow-crop"] canvas'));
      return {
        crops: crops.length,
        painted: crops.filter((canvas) => canvas.width > 0 && canvas.height > 0).length,
      };
    });
    check("scrolling the whole paper and back still paints every crop",
      afterRoundTrip.crops > 0 && afterRoundTrip.painted === afterRoundTrip.crops,
      `${afterRoundTrip.painted}/${afterRoundTrip.crops} painted`);

    // --- 3b4. formulas: offered, generated, typeset, and checkable ----------
    const banner = await page
      .locator('[data-testid="reflow-formulas-upgrade"]')
      .count()
      .catch(() => 0);
    let formulaChecked = false;
    if (banner > 0) {
      const offer = await page.locator('[data-testid="reflow-formulas-upgrade"]').innerText();
      check("a paper whose formulas were never reconstructed says so, and what it costs",
        /\d+ 处公式/.test(offer) && /\d+ 次请求/.test(offer), offer.replace(/\s+/g, " ").slice(0, 70));

      const beforeFormulas = await ledger();
      await page.click('[data-testid="reflow-formulas-generate"]');
      await page.waitForSelector('[data-testid="reflow-formula-item"]', { timeout: 180000 });
      try {
        await page.waitForFunction(
          () => {
            const item = document.querySelector('[data-testid="reflow-formula-item"]');
            return item !== null && item.dataset.renderMode === "latex";
          },
          null,
          { timeout: 60000 },
        );
      } catch (error) {
        // Say which path it took: a fallback is silent by design, and "it never
        // typeset" is not a diagnosis.
        const postAgain = await page
          .evaluate(async () => {
            const docs = await (await fetch("http://127.0.0.1:8000/api/documents")).json();
            const id = docs[0]?.document_id;
            const profiles = await (await fetch("http://127.0.0.1:8000/api/profiles")).json();
            const response = await fetch(
              `http://127.0.0.1:8000/api/documents/${id}/formulas`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ profile_id: profiles[0]?.id ?? "", force: true }),
              },
            );
            const artifact = await response.json();
            return {
              httpStatus: response.status,
              status: artifact.status,
              total: artifact.total_formulas,
              ok: artifact.reconstructed_count,
              refused: artifact.refused_count,
              failed: artifact.failed_count,
              reasons: (artifact.formulas ?? [])
                .map((f) => `${f.status}:${f.error_reason ?? f.refusal_reason ?? "-"}`)
                .slice(0, 2),
              latex: (artifact.formulas ?? [])[0]?.latex?.slice(0, 40) ?? null,
            };
          })
          .catch((error) => ({ error: String(error) }));
        console.error("  the POST itself returns:", JSON.stringify(postAgain));
        const fromBackend = await page
          .evaluate(async () => {
            const docs = await (await fetch("http://127.0.0.1:8000/api/documents")).json();
            const listed = docs.map((doc) => `${doc.document_id}:${doc.name}`);
            const id = docs[0]?.document_id;
            const response = await fetch(`http://127.0.0.1:8000/api/documents/${id}/formulas`);
            if (!response.ok) {
              // Which papers the backend knows, and each one's artifact status:
              // a 404 here is ambiguous between "never written" and "asked about
              // the wrong document".
              const perDocument = [];
              for (const doc of docs) {
                const probe = await fetch(
                  `http://127.0.0.1:8000/api/documents/${doc.document_id}/formulas`,
                );
                perDocument.push(`${doc.name}: ${probe.status}`);
              }
              return { status: response.status, listed, perDocument };
            }
            const artifact = await response.json();
            return {
              listed,
              status: artifact.status,
              total: artifact.total_formulas,
              ok: artifact.reconstructed_count,
              refused: artifact.refused_count,
              failed: artifact.failed_count,
              first: artifact.formulas?.[0]?.block_id ?? null,
              firstStatus: artifact.formulas?.[0]?.status ?? null,
              reason:
                artifact.formulas?.[0]?.error_reason ?? artifact.formulas?.[0]?.refusal_reason ?? null,
            };
          })
          .catch((error) => ({ error: String(error) }));
        console.error("  backend holds:", JSON.stringify(fromBackend));
        const why = await page.evaluate(() => {
          const item = document.querySelector('[data-testid="reflow-formula-item"]');
          return {
            mode: item?.dataset.renderMode ?? "(none)",
            badge: item?.querySelector('[data-testid="reflow-formula-badge"]')?.textContent ?? "",
            text: (item?.textContent ?? "").replace(/\s+/g, " ").slice(0, 160),
            katexRequests: performance
              .getEntriesByType("resource")
              .map((entry) => entry.name)
              .filter((name) => /katex/i.test(name)),
            failures: window.__formulaDiag ?? null,
          };
        });
        console.error("  formula diagnosis:", JSON.stringify(why));
        console.error("  console:", consoleErrors.slice(0, 4).join(" | ") || "(none)");
        throw error;
      }

      const afterFormulas = await ledger();
      const reconstruction = afterFormulas.by_operation?.formula_latex ?? 0;
      check("the reconstruction costs the disclosed number of calls, and no more",
        reconstruction >= 1 && reconstruction <= 2,
        `${reconstruction} call(s) for the paper's formulas (was ${beforeFormulas.calls} before)`);

      const typeset = await page.evaluate(() => {
        const item = document.querySelector('[data-testid="reflow-formula-item"]');
        const math = item?.querySelector('[data-testid="reflow-formula-math"]');
        const number = item?.querySelector('[data-testid="reflow-formula-number"]');
        return {
          katex: math ? math.querySelectorAll(".katex").length : 0,
          badge: item?.querySelector('[data-testid="reflow-formula-badge"]')?.textContent ?? "",
          number: number?.textContent ?? "",
          // The container this application sizes — not a descendant KaTeX
          // sizes itself, whose own rule is 1.21em of whatever it is given.
          font: math
            ? Number.parseFloat(
                getComputedStyle(
                  math.querySelector('[data-testid="reflow-formula-container"]') ?? math,
                ).fontSize,
              )
            : 0,
        };
      });
      check("the formula is typeset, not a picture of one",
        typeset.katex > 0 && /AI 重建/.test(typeset.badge), JSON.stringify(typeset));
      check("a typeset formula is set at the size the prose is set beside",
        typeset.font >= 16 && typeset.font <= 20, `${typeset.font}px`);

      // The reader can check it against the paper, which is the only real
      // verification this feature has.
      await page.click('[data-testid="reflow-formula-math"]');
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="reflow-formula-item"]')?.dataset.renderMode ===
          "crop",
        null,
        { timeout: 30000 },
      );
      const flipped = await page.evaluate(() => ({
        badge:
          document
            .querySelector('[data-testid="reflow-formula-item"] [data-testid="reflow-formula-badge"]')
            ?.textContent ?? "",
        crop: document.querySelectorAll('[data-testid="reflow-formula-item"] canvas').length,
      }));
      check("one click shows the paper's own formula, and says which is which",
        /原版/.test(flipped.badge) && flipped.crop > 0, JSON.stringify(flipped));
      await page.click('[data-testid="reflow-formula-crop-toggle"]');
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="reflow-formula-item"]')?.dataset.renderMode ===
          "latex",
        null,
        { timeout: 30000 },
      );
      formulaChecked = true;
    }
    check("a formula run left the reading intact", formulaChecked || banner === 0,
      formulaChecked ? "reconstruction exercised" : "no formulas on this paper");

    // --- 3b5. a refused formula shows the paper, and says why ---------------
    const refusals = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="reflow-formula-item"]'))
        .filter((item) => item.dataset.renderMode === "crop")
        .map((item) => item.textContent ?? ""));
    check("a formula the model would not answer for is shown as the paper's own",
      refusals.every((text) => /原版|未重建|无法解析|过长/.test(text)),
      `${refusals.length} fallback(s)`);

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
      /status of 404/.test(text) && /\/(overview|analysis|bilingual-text|formulas)(\?|\s|$)/.test(text);
    // --- 5b. the column never scrolls sideways (AC-P0-10) ------------------
    for (const width of [768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await sleep(900);
      const fit = await page.evaluate(() => {
        const scroll = document.querySelector('[data-testid="reflow-scroll"]');
        // Name the widest thing inside, so an overflow says what caused it.
        const nodes = Array.from(scroll.querySelectorAll("*"))
          .map((node) => ({
            testid: node.dataset.testid ?? node.tagName.toLowerCase(),
            width: Math.round(node.getBoundingClientRect().width),
            chain: [node.parentElement, node.parentElement?.parentElement]
              .map((parent) =>
                parent === null || parent === undefined
                  ? ""
                  : `${parent.dataset.testid ?? parent.tagName.toLowerCase()}(${Math.round(parent.getBoundingClientRect().width)}${/overflow-x-auto/.test(parent.className) ? ",scrolls" : ""})`,
              )
              .join(" < "),
          }))
          .sort((a, b) => b.width - a.width);
        const widest = nodes[0] ?? { testid: "(none)", width: 0, chain: "" };
        const runners = nodes.slice(0, 3);
        return {
          scrollWidth: scroll.scrollWidth,
          clientWidth: scroll.clientWidth,
          columnWidth: Number(scroll.dataset.columnWidth ?? 0),
          widest,
          runners,
        };
      });
      check(`the reading column does not scroll sideways at ${width}px`,
        fit.scrollWidth <= fit.clientWidth + 1, JSON.stringify(fit));
    }

    check("nothing was fetched from outside this machine (offline-first, AC-P0-07)",
      offsiteRequests.length === 0, offsiteRequests.slice(0, 3).join(" | ") || "loopback only");

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
