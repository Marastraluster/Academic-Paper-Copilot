/**
 * DS-QA-005 AC-02 — does the rotation inverse actually round-trip?
 *
 * The criterion requires it verified against a real rotated fixture, because the
 * four affine formulas are plausible and untested, and a wrong one maps a
 * horizontal span onto a vertical coordinate — a confidently wrong paragraph,
 * which is worse than the unavailable state it replaces.
 *
 * The check is anchored on the **text layer**, not on the mapper's own transform.
 * Dragging to a coordinate computed by inverting the mapper would round-trip
 * perfectly even if both halves were wrong in the same way. Instead a span is
 * picked by its *text*, the drag covers its box, and the question is whether the
 * mapper returns the paragraph that text belongs to.
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
const workDir = join(repoRoot, ".agent", "results", "probe-rotation");
const BACKEND_PORT = 8000;

function prepare() {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(join(workDir, "documents"), { recursive: true });
  const real = join(process.env.LOCALAPPDATA, "AcademicPDFCopilot");
  for (const suffix of ["", "-wal", "-shm"]) {
    const from = join(real, `db.sqlite3${suffix}`);
    if (existsSync(from)) copyFileSync(from, join(workDir, `db.sqlite3${suffix}`));
  }
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

prepare();
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
const results = [];

for (const angle of [90, 180, 270]) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://127.0.0.1:${previewPort}`, { waitUntil: "domcontentloaded" });
  await page.setInputFiles(
    '[data-testid="pdf-file-input"]',
    join(repoRoot, ".agent", "results", "rotated", `rot${angle}.pdf`),
  );
  await page.waitForSelector('[data-testid="pdf-page-container"]', { timeout: 60000 });
  await page.waitForSelector('[data-testid="qa-composer"]:not([disabled])', { timeout: 60000 });
  await page.waitForTimeout(2000);

  const ir = await page.evaluate(async (base) => {
    const documents = await (await fetch(`${base}/api/documents`)).json();
    return (await fetch(`${base}/api/documents/${documents[0].document_id}/ir`)).json();
  }, `http://127.0.0.1:${BACKEND_PORT}`);

  const rotation = ir.pages[0]?.rotation ?? 0;

  // Pick a span by its TEXT, then drag across that span's own client rect. The
  // anchor is the DOM, not the mapper: the span says what it contains, and the
  // IR says which paragraph contains that.
  const anchor = await page.evaluate(() => {
    const spans = [...document.querySelectorAll('[data-testid="pdf-text-layer"] span')].filter(
      (span) => (span.textContent ?? "").trim().length > 25,
    );
    const span = spans[Math.floor(spans.length / 2)];
    if (!span) return null;
    const rect = span.getBoundingClientRect();
    return {
      text: (span.textContent ?? "").trim(),
      x: rect.x, y: rect.y, width: rect.width, height: rect.height,
    };
  });

  if (!anchor) {
    results.push({ angle, rotation, ok: false, why: "no span to anchor on" });
    await page.close();
    continue;
  }

  const expected = ir.paragraphs.filter((paragraph) =>
    paragraph.text.includes(anchor.text.slice(0, 24)),
  );
  const y = anchor.y + anchor.height / 2;
  await page.mouse.move(anchor.x + 2, y);
  await page.mouse.down();
  await page.mouse.move(anchor.x + anchor.width / 2, y, { steps: 6 });
  await page.mouse.move(anchor.x + Math.max(anchor.width - 2, 20), y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  const mapped = await page.evaluate(() => {
    const preview = document.querySelector('[data-testid="selection-preview"]');
    const option = [...document.querySelectorAll('[data-testid="scope-selector"] option')].find(
      (candidate) => candidate.textContent?.startsWith("选中内容"),
    );
    return {
      disabled: option?.disabled ?? true,
      preview: preview?.textContent ?? null,
      selected: window.getSelection()?.toString() ?? "",
    };
  });

  // The ids are recovered by asking, so the check reads what the *request* would
  // carry rather than what the UI displays.
  const captured = [];
  const listener = (request) => {
    if (request.url().endsWith("/answer")) captured.push(request.postData() ?? "");
  };
  page.on("request", listener);
  // A disabled Selection is itself the finding: it means the mapper refused,
  // which is the fail-safe outcome the criterion accepts over a wrong answer.
  let ids = [];
  if (!mapped.disabled) {
    await page.selectOption('[data-testid="scope-selector"]', "selection");
    await page.fill('[data-testid="qa-composer"]', "What does this say?");
    await page.click('[data-testid="composer-send"]');
    await page.waitForTimeout(1500);
    ids = captured.length ? (JSON.parse(captured.at(-1)).scope?.paragraph_ids ?? []) : [];
  }
  page.off("request", listener);

  results.push({
    angle,
    rotation,
    expected: expected.map((paragraph) => paragraph.id.slice(-4)),
    mapped: ids.map((id) => id.slice(-4)),
    overlap: ids.filter((id) => expected.some((paragraph) => paragraph.id === id)).length,
    selected: mapped.selected.slice(0, 60),
    preview: mapped.preview,
    disabled: mapped.disabled,
    boxes: ir.paragraphs.slice(0, 3).map((p) => p.bboxes[0].map(Math.round)),
  });
  await page.close();
}

writeFileSync(join(workDir, "rotation.json"), JSON.stringify(results, null, 1));
for (const result of results) {
  console.log(
    `rot${result.angle}: PageIR.rotation=${result.rotation} ` +
      `expected=[${result.expected}] mapped=[${result.mapped}] overlap=${result.overlap}`,
  );
}

await browser.close();
preview.kill();
backend.kill();
process.exit(0);
