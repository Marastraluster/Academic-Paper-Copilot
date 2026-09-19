/**
 * DS-QA-013 Phase 2 — which non-prose source units can a browser actually select?
 *
 * The task's trigger was a count of caption and formula blocks outside
 * ParagraphIR. A count is not an eligibility argument: a block the extraction
 * sees may be a vector drawing, an image, or glyphs the PDF's text layer exposes
 * under different codepoints than the extractor read. What matters for
 * annotation is narrower and only the browser can answer it:
 *
 *   is there selectable text on the page, under this exact rectangle,
 *   whose characters are the block's characters?
 *
 * So this walks the real IR, finds every non-prose block, and asks the real
 * text layer. Nothing here is inferred from the block's `text` field.
 *
 * Usage: node scripts/probe-nonprose.mjs [paper.pdf]
 *        (requires `npm run build`)
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const backendDir = join(repoRoot, "backend");
const python = join(backendDir, ".venv", "Scripts", "python.exe");
const workDir = join(repoRoot, ".agent", "results", "nonprose", "browser");
const BACKEND_PORT = 8000;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;

const PAPER = process.argv[2]
  ?? join(repoRoot, ".agent", "results", "e2e-notes", "documents",
          "doc_5e6aaca5ea5d4109b4f3a33a75df043d", "source.pdf");

/** Classes deliberately outside ParagraphIR that a reader can see. */
const CANDIDATES = [
  "figure_caption", "table_caption", "formula_caption", "isolate_formula",
  "figure", "table", "table_footnote", "title", "plain text",
];

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

async function waitFor(url, timeoutMs = 240000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return true; } catch { /* not up */ }
    await sleep(400);
  }
  return false;
}

const previewPort = await freePort();
rmSync(workDir, { recursive: true, force: true });
mkdirSync(join(workDir, "documents"), { recursive: true });

const backend = spawn(
  python, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(BACKEND_PORT)],
  {
    cwd: backendDir,
    env: {
      ...process.env, PYTHONIOENCODING: "utf-8", PYTHONPATH: backendDir,
      DATABASE_PATH: join(workDir, "db.sqlite3"),
      DOCUMENTS_DIR: join(workDir, "documents"),
      CORS_ORIGINS: `http://127.0.0.1:${previewPort}`,
      LOG_LEVEL: "WARNING",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
backend.stderr.on("data", () => {});

const preview = spawn(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["run", "preview", "--", "--port", String(previewPort), "--strictPort"],
  { cwd: join(repoRoot, "frontend"), stdio: ["ignore", "pipe", "pipe"], shell: true },
);
let url = "";
{
  let buffer = "";
  preview.stdout.on("data", (chunk) => {
    buffer += String(chunk).replace(/\x1b\[[0-9;]*m/g, "");
    const match = buffer.match(/http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)/);
    if (match && !url) url = `http://127.0.0.1:${match[1]}`;
  });
}
await sleep(8000);

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const report = { paper: PAPER, classes: {}, samples: [] };

try {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.setInputFiles('[data-testid="pdf-file-input"]', PAPER);
  await page.waitForSelector('[data-testid="pdf-text-layer"]', { timeout: 120000 });
  await sleep(3000);

  // The IR the application itself would read.
  const documentId = await page.evaluate(() =>
    [...document.querySelectorAll("body *")].length && null);
  void documentId;
  const listing = await (await fetch(`${BACKEND_URL}/api/documents`)).json();
  const record = (listing.documents ?? listing)[0];
  const ir = await (await fetch(
    `${BACKEND_URL}/api/documents/${record.document_id}/ir`,
  )).json();

  const blocks = ir.pages.flatMap((p) => p.blocks);
  for (const layout of CANDIDATES) {
    const count = blocks.filter((b) => b.layout_class === layout).length;
    if (count) report.classes[layout] = { blocks: count, selectable: 0, exactText: 0 };
  }

  /* Every non-prose block with text, on its page. The probe scrolls to each
     page once and measures all of that page's candidates together — a page is
     where the cost is, not a block. */
  const byPage = new Map();
  for (const block of blocks) {
    if (!CANDIDATES.includes(block.layout_class)) continue;
    if (!(block.text ?? "").trim()) continue;
    if (!byPage.has(block.page_number)) byPage.set(block.page_number, []);
    byPage.get(block.page_number).push(block);
  }

  for (const [pageNumber, pageBlocks] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    await page.evaluate((n) => {
      const viewer = document.querySelector('[data-testid="pdf-viewer"]');
      const container = document.querySelector(`[data-page-number="${n}"]`);
      if (viewer && container) viewer.scrollTop = container.offsetTop - 40;
    }, pageNumber);
    await sleep(1200);

    const measured = await page.evaluate((wanted) => {
      const container = document.querySelector(`[data-page-number="${wanted.pageNumber}"]`);
      if (!container) return null;
      const layer = container.querySelector('[data-testid="pdf-text-layer"]');
      const scale = Number(container.dataset.pageScale ?? "0");
      const box = container.getBoundingClientRect();
      if (!layer || !(scale > 0)) return null;

      const spans = [...layer.querySelectorAll("span")].map((span) => ({
        text: span.textContent ?? "",
        rect: span.getBoundingClientRect().toJSON(),
      }));

      const results = [];
      for (const block of wanted.blocks) {
        // The block's rectangle, in client coordinates, using the application's
        // own published scale — the same conversion the mapper uses.
        const [x0, y0, x1, y1] = block.bbox;
        const left = box.left + x0 * scale;
        const top = box.top + y0 * scale;
        const right = box.left + x1 * scale;
        const bottom = box.top + y1 * scale;

        const hitting = spans.filter((span) =>
          Math.min(span.rect.right, right) - Math.max(span.rect.left, left) > 1
          && Math.min(span.rect.bottom, bottom) - Math.max(span.rect.top, top) > 1);

        const joined = hitting.map((span) => span.text).join("").replace(/\s+/g, " ").trim();
        const canonical = (block.text ?? "").replace(/\s+/g, " ").trim();
        // Character overlap rather than equality: the text layer splits lines
        // differently and the extractor re-joins them, so "the same words" is the
        // question, not "the same string".
        const wantedChars = new Set(canonical.replace(/\s/g, "").split(""));
        const gotChars = new Set(joined.replace(/\s/g, "").split(""));
        let shared = 0;
        for (const ch of wantedChars) if (gotChars.has(ch)) shared += 1;
        const coverage = wantedChars.size ? shared / wantedChars.size : 0;

        results.push({
          id: block.id,
          layout: block.layout_class,
          page: block.page_number,
          canonical: canonical.slice(0, 70),
          textLayer: joined.slice(0, 70),
          spans: hitting.length,
          coverage: Math.round(coverage * 100) / 100,
          bbox: block.bbox.map((v) => Math.round(v * 10) / 10),
        });
      }
      return results;
    }, { pageNumber, blocks: pageBlocks });

    if (!measured) continue;
    for (const item of measured) {
      report.samples.push(item);
      if (item.spans > 0) {
        report.classes[item.layout].selectable += 1;
        if (item.coverage >= 0.9) report.classes[item.layout].exactText += 1;
      }
    }
  }
} finally {
  await browser.close();
  preview.kill();
  backend.kill();
}

writeFileSync(
  join(workDir, "probe.json"),
  JSON.stringify(report, null, 1),
  "utf8",
);
console.log(JSON.stringify({ classes: report.classes }, null, 1));
console.log("\n--- samples ---");
for (const sample of report.samples) {
  console.log(
    `  ${sample.layout.padEnd(17)} p${String(sample.page).padStart(2)} ` +
    `spans=${String(sample.spans).padStart(3)} cover=${sample.coverage}  ` +
    `${JSON.stringify(sample.textLayer.slice(0, 44))}`,
  );
}
process.exit(0);
