/**
 * Why did a one-line drag map to two paragraphs?
 *
 * The browser end-to-end run reported that dragging across the first line of
 * paragraph 0020 resolved to both 0020 and 0021. Either the matcher is admitting
 * a neighbour it should reject, or the drag selected more than one line — and the
 * two have nothing in common but the symptom. This dumps the actual numbers: the
 * selection's line fragments in PDF points, and every paragraph's boxes with the
 * overlap they computed.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const backendDir = join(repoRoot, "backend");
const python = join(backendDir, ".venv", "Scripts", "python.exe");
const workDir = join(repoRoot, ".agent", "results", "probe-overlap");
const BACKEND_PORT = 8000;
const BASELINE_DOCUMENT = "doc_6f4ab9d9d4d34f85bc9e441757240fd8";

function prepare() {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(join(workDir, "documents"), { recursive: true });
  const real = join(process.env.LOCALAPPDATA, "AcademicPDFCopilot");
  for (const suffix of ["", "-wal", "-shm"]) {
    const from = join(real, `db.sqlite3${suffix}`);
    if (existsSync(from)) copyFileSync(from, join(workDir, `db.sqlite3${suffix}`));
  }
  const paper = join(real, "documents", BASELINE_DOCUMENT, "source.pdf");
  copyFileSync(paper, join(workDir, "resnet.pdf"));
  return join(workDir, "resnet.pdf");
}

function freePort() {
  return new Promise((done) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

const paper = prepare();
const previewPort = await freePort();
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
      CORS_ORIGINS: `http://127.0.0.1:${previewPort},http://localhost:${previewPort}`,
      PYTHONIOENCODING: "utf-8",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
backend.stderr.on("data", () => {});
const preview = spawn(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["run", "preview", "--", "--port", String(previewPort), "--strictPort"],
  { cwd: resolve(here, ".."), stdio: ["ignore", "pipe", "pipe"], shell: true },
);
preview.stdout.on("data", () => {});

for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    if ((await fetch(`http://127.0.0.1:${previewPort}`)).ok) break;
  } catch {
    /* not up */
  }
  await new Promise((r) => setTimeout(r, 300));
}

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`http://127.0.0.1:${previewPort}`, { waitUntil: "domcontentloaded" });
await page.setInputFiles('[data-testid="pdf-file-input"]', paper);
await page.waitForSelector('[data-testid="pdf-page-container"]', { timeout: 60000 });
// Wait for backend registration, not just for the local parse: the IR lives on
// the backend, and asking before the upload finished returns an empty list.
await page.waitForSelector('[data-testid="qa-composer"]:not([disabled])', { timeout: 60000 });
await page.waitForTimeout(1500);

const ir = await page.evaluate(async (base) => {
  const documents = await (await fetch(`${base}/api/documents`)).json();
  if (!documents.length) return { error: "no documents" };
  const response = await fetch(`${base}/api/documents/${documents[0].document_id}/ir`);
  return response.json();
}, `http://127.0.0.1:${BACKEND_PORT}`);
if (!ir.paragraphs) {
  console.log("IR unavailable:", JSON.stringify(ir).slice(0, 200));
  process.exit(2);
}

const left = ir.paragraphs.find(
  (item) => item.page_number === 3 && item.bboxes[0][0] < 300 && item.bboxes[0][2] < 300,
);
const neighbour = ir.paragraphs.find(
  (item) => item.page_number === 3 && item.id !== left.id && item.bboxes[0][0] < 300,
);

const spot = await page.evaluate(
  ({ boxes, page_number }) => {
    const viewer = document.querySelector('[data-testid="pdf-viewer"]');
    const container = document.querySelector(
      `[data-testid="pdf-page-container"][data-page-number="${page_number}"]`,
    );
    const scale = Number(container.dataset.pageScale ?? "0");
    const [x0, y0] = boxes[0];
    const want = viewer.getBoundingClientRect().top + viewer.clientHeight * 0.3;
    viewer.scrollTop += container.getBoundingClientRect().top + y0 * scale - want;
    const rect = container.getBoundingClientRect();
    return {
      left: rect.left + x0 * scale,
      top: rect.top + y0 * scale,
      right: rect.left + boxes[0][2] * scale,
    };
  },
  { boxes: left.bboxes, page_number: left.page_number },
);

await page.waitForTimeout(400);
const y = spot.top + 6;
await page.mouse.move(spot.left + 4, y);
await page.mouse.down();
await page.mouse.move((spot.left + spot.right) / 2, y, { steps: 8 });
await page.mouse.move(spot.right - 4, y, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(400);

const report = await page.evaluate(
  ({ boxesById, pageNumber }) => {
    const container = document.querySelector(
      `[data-testid="pdf-page-container"][data-page-number="${pageNumber}"]`,
    );
    const rect = container.getBoundingClientRect();
    const scale = Number(container.dataset.pageScale ?? "0");
    const selection = window.getSelection();
    const range = selection.rangeCount ? selection.getRangeAt(0) : null;
    const rects = range
      ? [...range.getClientRects()].map((r) => ({
          x0: (r.left - rect.left) / scale,
          y0: (r.top - rect.top) / scale,
          x1: (r.right - rect.left) / scale,
          y1: (r.bottom - rect.top) / scale,
        }))
      : [];
    const overlaps = Object.entries(boxesById).map(([id, boxes]) => {
      let area = 0;
      let best = { dx: 0, dy: 0 };
      for (const r of rects) {
        for (const b of boxes) {
          const dx = Math.max(0, Math.min(r.x1, b[2]) - Math.max(r.x0, b[0]));
          const dy = Math.max(0, Math.min(r.y1, b[3]) - Math.max(r.y0, b[1]));
          if (dx >= 4 && dy / Math.min(r.y1 - r.y0, b[3] - b[1]) >= 0.5) {
            area += dx * dy;
            best = { dx: Math.round(dx), dy: Math.round(dy) };
          }
        }
      }
      return { id: id.slice(-4), boxes, area: Math.round(area), best };
    });
    return {
      text: selection.toString(),
      scale,
      rects: rects.map((r) => ({
        x0: Math.round(r.x0), y0: Math.round(r.y0), x1: Math.round(r.x1), y1: Math.round(r.y1),
      })),
      overlaps,
    };
  },
  {
    boxesById: Object.fromEntries(
      ir.paragraphs.filter((p) => p.page_number === 3).map((p) => [p.id, p.bboxes]),
    ),
    pageNumber: 3,
  },
);

writeFileSync(join(workDir, "overlap.json"), JSON.stringify(report, null, 1));
console.log("selected:", JSON.stringify(report.text));
console.log("scale:", report.scale, "| target box:", left.bboxes[0].map(Math.round));
console.log("selection rects (pt):", JSON.stringify(report.rects));
console.log("neighbour box:", neighbour.bboxes[0].map(Math.round));
console.log("overlaps:", JSON.stringify(report.overlaps.slice(0, 6)));

await browser.close();
preview.kill();
backend.kill();
process.exit(0);
