/**
 * DS-QA-005 — what a real PDF.js text selection actually looks like.
 *
 * The mapping this task needs is "DOM Range → canonical source geometry", and
 * the only way to build it honestly is to look at the geometry the browser
 * really produces: how the text layer positions its spans, what
 * `Range.getClientRects()` returns, and how those relate to the page element and
 * the PDF viewport. Guessing the convention is how a mapping ends up confidently
 * wrong.
 *
 * Usage: node scripts/probe-selection.mjs   (needs `npm run build` and the app DB)
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const backendDir = join(repoRoot, "backend");
const python = join(backendDir, ".venv", "Scripts", "python.exe");
const workDir = join(repoRoot, ".agent", "results", "probe-selection");
const BACKEND_PORT = 8000;
const BASELINE_DOCUMENT = "doc_6f4ab9d9d4d34f85bc9e441757240fd8";

function appDataDir() {
  return join(process.env.LOCALAPPDATA, "AcademicPDFCopilot");
}

function prepare() {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(join(workDir, "documents"), { recursive: true });
  const real = appDataDir();
  for (const suffix of ["", "-wal", "-shm"]) {
    const from = join(real, `db.sqlite3${suffix}`);
    if (existsSync(from)) copyFileSync(from, join(workDir, `db.sqlite3${suffix}`));
  }
  const paper = join(real, "documents", BASELINE_DOCUMENT, "source.pdf");
  const target = join(workDir, "resnet.pdf");
  copyFileSync(paper, target);
  return target;
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

async function main() {
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

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${previewPort}`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  const browser = await chromium.launch({ channel: "msedge" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const report = {};

  try {
    await page.goto(`http://127.0.0.1:${previewPort}`, { waitUntil: "domcontentloaded" });
    await page.setInputFiles('[data-testid="pdf-file-input"]', paper);
    await page.waitForSelector('[data-testid="pdf-text-layer"]', { timeout: 60000 });
    await page.waitForTimeout(2500);

    // --- 1. what the text layer actually contains --------------------------
    report.textLayer = await page.evaluate(() => {
      const layer = document.querySelector('[data-testid="pdf-text-layer"]');
      if (!layer) return null;
      const style = getComputedStyle(layer);
      const spans = [...layer.querySelectorAll("span")];
      return {
        layerClass: layer.className,
        layerTransform: style.transform,
        layerFontSize: style.fontSize,
        scaleFactorVar: style.getPropertyValue("--scale-factor"),
        layerRect: layer.getBoundingClientRect().toJSON(),
        spanCount: spans.length,
        firstSpans: spans.slice(0, 4).map((span) => ({
          text: span.textContent.slice(0, 40),
          transform: getComputedStyle(span).transform,
          left: getComputedStyle(span).left,
          top: getComputedStyle(span).top,
          fontSize: getComputedStyle(span).fontSize,
          rect: span.getBoundingClientRect().toJSON(),
        })),
      };
    });

    // --- 2. the page container and its scale -------------------------------
    report.page = await page.evaluate(() => {
      const container = document.querySelector('[data-testid="pdf-page-container"]');
      const canvas = container.querySelector("canvas");
      const rect = container.getBoundingClientRect();
      return {
        pageNumber: container.dataset.pageNumber,
        rect: rect.toJSON(),
        // The rendered CSS size of the page: PDF points × scale.
        canvasCssWidth: canvas ? parseFloat(canvas.style.width) : null,
        canvasCssHeight: canvas ? parseFloat(canvas.style.height) : null,
      };
    });

    // --- 2b. a real mouse drag over the text layer -------------------------
    // Programmatic ranges proved the geometry; this proves a *user drag* produces
    // a selection at all, which is the part the mapping depends on.
    const dragReport = await page.evaluate(() => {
      const container = document.querySelector('[data-testid="pdf-page-container"][data-page-number="3"]');
      if (!container) return null;
      container.scrollIntoView({ block: "center" });
      const rect = container.getBoundingClientRect();
      const scale = Number(container.dataset.pageScale ?? "0");
      // The first paragraph on page 3, from the IR.
      return { left: rect.left, top: rect.top, scale, width: rect.width, height: rect.height };
    });
    if (dragReport) {
      await page.waitForTimeout(700);
      const box = await page.evaluate(() => {
        const container = document.querySelector('[data-testid="pdf-page-container"][data-page-number="3"]');
        const rect = container.getBoundingClientRect();
        const scale = Number(container.dataset.pageScale ?? "0");
        const spans = [...container.querySelectorAll('.textLayer span')]
          .map((s) => ({ r: s.getBoundingClientRect(), text: s.textContent }))
          .filter((s) => s.r.width > 20 && s.r.top > rect.top + 40 && s.r.top < rect.top + 300);
        return { rect: rect.toJSON(), scale,
                 sample: spans.slice(0, 5).map((s) => ({ text: s.text.slice(0, 30), r: s.r.toJSON() })) };
      });
      report.dragTargets = box;
      if (box.sample.length >= 2) {
        const first = box.sample[0].r;
        const second = box.sample[1].r;
        await page.mouse.move(first.left + 4, first.top + first.height / 2);
        await page.mouse.down();
        await page.mouse.move(second.right - 4, second.top + second.height / 2, { steps: 10 });
        await page.mouse.up();
        await page.waitForTimeout(300);
        report.afterDrag = await page.evaluate(() => ({
          text: window.getSelection()?.toString().slice(0, 80) ?? "",
          collapsed: window.getSelection()?.isCollapsed ?? true,
          rangeCount: window.getSelection()?.rangeCount ?? 0,
        }));
      }
    }

    // --- 3. select a phrase inside one paragraph ---------------------------
    report.selection = await page.evaluate(() => {
      const layer = document.querySelector('[data-testid="pdf-text-layer"]');
      const spans = [...layer.querySelectorAll("span")].filter((s) => s.textContent.trim().length > 3);
      // Take a span from the middle of the page, not the header.
      const span = spans[Math.floor(spans.length / 2)];
      const node = span.firstChild;
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, Math.min(20, node.length));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);

      const rects = [...range.getClientRects()].map((r) => ({
        x: r.x, y: r.y, width: r.width, height: r.height,
      }));
      return {
        text: selection.toString(),
        anchorNode: selection.anchorNode?.nodeName,
        focusNode: selection.focusNode?.nodeName,
        isCollapsed: selection.isCollapsed,
        rangeCount: selection.rangeCount,
        rectCount: rects.length,
        rects: rects.slice(0, 6),
        spanRect: span.getBoundingClientRect().toJSON(),
        // How many spans does the range intersect at all?
        spansInLayer: spans.length,
      };
    });

    // --- 4. across several spans -------------------------------------------
    report.multiSpan = await page.evaluate(() => {
      const layer = document.querySelector('[data-testid="pdf-text-layer"]');
      const spans = [...layer.querySelectorAll("span")].filter((s) => s.textContent.trim().length > 2);
      const start = spans[Math.floor(spans.length / 2)];
      const end = spans[Math.min(spans.length - 1, Math.floor(spans.length / 2) + 3)];
      const range = document.createRange();
      range.setStart(start.firstChild, 0);
      range.setEnd(end.firstChild, end.firstChild.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return {
        text: selection.toString().slice(0, 120),
        rectCount: [...range.getClientRects()].length,
        spansTouched: spans.filter((s) => range.intersectsNode(s)).length,
      };
    });

    // --- 5. zoom: what changes, and what does not ---------------------------
    // One zoom-in step through the toolbar, then re-measure the same layer.
    await page.click('[aria-label="放大"]').catch(() => {});
    await page.waitForTimeout(1200);
    report.zoom = await page.evaluate(() => {
      const layer = document.querySelector('[data-testid="pdf-text-layer"]');
      const spans = [...layer.querySelectorAll("span")];
      const span = spans[Math.floor(spans.length / 2)];
      return {
        spanCount: spans.length,
        scaleFactorVar: getComputedStyle(layer).getPropertyValue("--scale-factor"),
        layerTransform: getComputedStyle(layer).transform,
        sampleSpanTransform: span ? getComputedStyle(span).transform : null,
        sampleSpanFontSize: span ? getComputedStyle(span).fontSize : null,
      };
    });

    writeFileSync(join(workDir, "probe.json"), JSON.stringify(report, null, 1));
    console.log(JSON.stringify(report, null, 1));
  } finally {
    await browser.close();
    preview.kill();
    backend.kill();
  }
}

await main();
