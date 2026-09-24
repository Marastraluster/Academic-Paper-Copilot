/**
 * DS-DOC-006 — the paragraph-aligned column, in a real browser.
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
const workDir = join(repoRoot, ".agent", "results", "e2e-bilingual-reading");
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
    await page.click('[data-testid="bilingual-generate-btn"]');
    await page.waitForSelector('[data-testid="bilingual-pair"]', { timeout: 300000 });
    const pairs = await page.locator('[data-testid="bilingual-pair"]').count();
    check("a generation produces a pair for every paragraph", pairs > 50, `${pairs} pairs`);

    const afterGenerate = await ledger();
    const synthesis = afterGenerate.by_operation?.bilingual_text ?? 0;
    const probes = afterGenerate.by_operation?.unlabelled ?? 0;
    check("and it cost one call per batch, within the frozen bound",
      synthesis >= 5 && synthesis <= 10,
      `${synthesis} synthesis call(s) + ${probes} protocol probe(s) = ${afterGenerate.calls} request(s)`);

    const section = await page.locator('[data-testid^="bilingual-section-"]').first().innerText();
    check("headings are shown in both languages", /[A-Za-z]/.test(section) && /【译】|[一-鿿]/.test(section),
      section.replace(/\s+/g, " ").slice(0, 60));

    const formula = await page.locator('[data-testid="bilingual-block-isolate_formula"]').count();
    check("formulas are carried in the source and never translated", formula >= 1, `${formula} formula(s)`);

    // --- 3. the clipboard, with a real drag ---------------------------------
    const pair = page.locator('[data-testid="bilingual-pair"]').nth(2);
    const source = pair.locator('[data-testid="bilingual-source-p"]');
    const box = await source.boundingBox();
    if (box) {
      await page.mouse.move(box.x + 4, box.y + 4);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 4, box.y + box.height - 4, { steps: 12 });
      await page.mouse.up();
    }
    const copied = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    const sourceText = (await source.innerText()).trim();
    check("a drag across a paragraph selects its prose", copied.trim().length > 20, copied.trim().slice(0, 40));
    check("and the selection carries no badge, button or paragraph id",
      !copied.includes("P. ") && !/未翻译/.test(copied) && !/p_doc_/.test(copied), copied.slice(-40));
    check("the copied text is the paragraph's own words",
      sourceText.startsWith(copied.trim().slice(0, 30)), sourceText.slice(0, 30));

    // --- 4. back to the paper ----------------------------------------------
    await pair.locator('[data-testid="bilingual-jump-pdf"]').first().click();
    await page.waitForSelector('[data-testid="pdf-page-container"]', { timeout: 60000 });
    const mode = await page.getAttribute('[data-testid="reader-workspace"]', "data-reader-mode");
    check("a page badge puts the reader back in the PDF", mode === "original", `mode ${mode}`);

    // --- 5. reopening is free ----------------------------------------------
    const documentIds = () =>
      page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="document-name"]'))
        .map((node) => node.textContent));
    await documentIds();
    // From here the question is what *reopening* costs, so the ledger starts
    // empty. Without this the check would report every call the session has made.
    await fetch(`${BACKEND_URL}/api/_debug/provider-ledger/reset`, { method: "POST" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="pdf-page-container"]', { timeout: 120000 });
    const hash = createHash("sha256").update(readFileSync(PAPER)).digest("hex").slice(0, 12);
    const cached = readdirSync(join(workDir, "documents", "_cache", "bilingual"))
      .some((name) => name.startsWith(hash));
    check("the reading is cached under the paper's content hash", cached, hash);

    await page.click('[data-testid="reader-mode-immersive"]');
    await page.waitForSelector('[data-testid="bilingual-pair"]', { timeout: 60000 });
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
