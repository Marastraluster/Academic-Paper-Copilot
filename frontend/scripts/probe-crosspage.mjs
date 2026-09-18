/**
 * DS-QA-011 — what a real cross-page selection actually does.
 *
 * The task's primary unknown is not persistence; it is whether a browser Range
 * can span two PDF.js text layers at all, and what the geometry looks like when
 * it does. Everything downstream is decided by this file's output, so it
 * measures and does not conclude.
 *
 * It also measures the thing the design most depends on: **how many pages are
 * mounted at once**. `PdfViewer` gives a page a canvas and a text layer only
 * while it intersects a buffered viewport, so if the answer is "one", a
 * cross-page drag has no DOM to span — no amount of mapping code changes that.
 *
 * Usage:  node scripts/probe-crosspage.mjs
 *         (needs `npm run build` and a fixture from make-crosspage-pdf.mjs)
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const backendDir = join(repoRoot, "backend");
const python = join(backendDir, ".venv", "Scripts", "python.exe");
const workDir = join(repoRoot, ".agent", "results", "crosspage");
const FIXTURE = join(workDir, "fixture.pdf");
const BACKEND_PORT = 8000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const child = spawn(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "preview", "--", "--port", String(port), "--strictPort"],
    { cwd: join(repoRoot, "frontend"), stdio: ["ignore", "pipe", "pipe"], shell: true },
  );
  let url = `http://127.0.0.1:${port}`;
  await new Promise((done) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += String(chunk).replace(/\x1b\[[0-9;]*m/g, "");
      const match = buffer.match(/http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)/);
      if (match) {
        url = `http://127.0.0.1:${match[1]}`;
        done();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    setTimeout(done, 20000);
  });
  return { child, url };
}

async function waitFor(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      /* not up */
    }
    await sleep(300);
  }
  return false;
}

/**
 * Group a live Range's client rects by the page container that owns them, using
 * the same DOM-ownership walk the application's mapper uses. Reproduced here
 * rather than imported so the probe reports what the *browser* did, independent
 * of whether the application's own code is correct.
 */
const READ_RANGE = () => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);

  const pageOf = (node) => {
    let element = node instanceof Element ? node : (node?.parentElement ?? null);
    while (element) {
      if (element instanceof HTMLElement && element.dataset.pageNumber) return element;
      element = element.parentElement;
    }
    return null;
  };

  const byPage = {};
  const rects = [];
  for (const rect of Array.from(range.getClientRects())) {
    if (rect.width <= 0 || rect.height <= 0) continue;
    const probe =
      typeof document.elementFromPoint === "function"
        ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        : null;
    const container = pageOf(probe) ?? pageOf(range.startContainer) ?? pageOf(range.endContainer);
    const page = container ? Number(container.dataset.pageNumber) : 0;
    rects.push({ page, left: Math.round(rect.left), top: Math.round(rect.top),
                 width: Math.round(rect.width), height: Math.round(rect.height) });
    if (page) byPage[page] = (byPage[page] ?? 0) + 1;
  }

  return {
    text: selection.toString().slice(0, 120),
    textLength: selection.toString().length,
    collapsed: selection.isCollapsed,
    rangeCount: selection.rangeCount,
    startContainer: range.startContainer.parentElement?.className ?? String(range.startContainer.nodeName),
    endContainer: range.endContainer.parentElement?.className ?? String(range.endContainer.nodeName),
    rectCount: rects.length,
    byPage,
    rects: rects.slice(0, 8),
  };
};

/**
 * Three ways of deciding which page a fragment belongs to, on one live Range.
 *
 * Strategy A is what the application does today: read the whole Range's rects
 * and hit-test each one's centre. Strategy B clamps the Range to each page
 * container. Strategy C clamps to each *text node*, so an element's border box
 * can never be mistaken for a line of selected text.
 *
 * They are measured side by side on the same selection because the difference
 * is exactly what this task has to get right, and reading the code cannot say
 * which one the browser actually agrees with.
 */
const STRATEGIES = () => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const doc = range.startContainer.ownerDocument;

  const pageOf = (node) => {
    let element = node instanceof Element ? node : (node?.parentElement ?? null);
    while (element) {
      if (element instanceof HTMLElement && element.dataset.pageNumber) return element;
      element = element.parentElement;
    }
    return null;
  };

  const pages = [...document.querySelectorAll('[data-testid="pdf-page-container"]')];
  const round = (r) => ({
    left: Math.round(r.left), top: Math.round(r.top),
    width: Math.round(r.width), height: Math.round(r.height),
  });

  // --- B: clamp the range to each page container ---------------------------
  const clampTo = (element) => {
    const bounds = doc.createRange();
    bounds.selectNodeContents(element);
    const sub = doc.createRange();
    const startAfter = range.compareBoundaryPoints(Range.START_TO_START, bounds) > 0;
    sub.setStart(startAfter ? range.startContainer : bounds.startContainer,
                 startAfter ? range.startOffset : bounds.startOffset);
    const endBefore = range.compareBoundaryPoints(Range.END_TO_END, bounds) < 0;
    sub.setEnd(endBefore ? range.endContainer : bounds.endContainer,
               endBefore ? range.endOffset : bounds.endOffset);
    return sub;
  };

  const b = {};
  for (const element of pages) {
    if (!range.intersectsNode(element)) continue;
    const sub = clampTo(element);
    b[element.dataset.pageNumber] = {
      text: sub.toString().slice(0, 40),
      rects: [...sub.getClientRects()].filter((r) => r.width > 0 && r.height > 0).map(round),
    };
  }

  // --- C: clamp to each intersecting text node -----------------------------
  const c = {};
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (node.nodeValue && node.nodeValue.trim() && range.intersectsNode(node)) {
      const element = pageOf(node);
      const page = element ? element.dataset.pageNumber : null;
      if (page) {
        const sub = doc.createRange();
        const startsBefore = range.compareBoundaryPoints(
          Range.START_TO_START, (() => { const r = doc.createRange(); r.selectNodeContents(node); return r; })(),
        ) < 0;
        sub.setStart(startsBefore ? node : range.startContainer,
                     startsBefore ? 0 : range.startOffset);
        const endsAfter = range.compareBoundaryPoints(
          Range.END_TO_END, (() => { const r = doc.createRange(); r.selectNodeContents(node); return r; })(),
        ) > 0;
        sub.setEnd(endsAfter ? node : range.endContainer,
                   endsAfter ? node.nodeValue.length : range.endOffset);
        const rects = [...sub.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
        if (rects.length === 0) { node = walker.nextNode(); continue; }
        const entry = c[page] ?? { text: "", rects: [], nodes: 0 };
        entry.nodes += 1;
        entry.text += sub.toString();
        entry.rects.push(...rects.map(round));
        c[page] = entry;
      }
    }
    node = walker.nextNode();
  }
  for (const key of Object.keys(c)) c[key].text = c[key].text.slice(0, 40);

  return { b, c, pageBoxes: pages.map((el) => ({
    page: el.dataset.pageNumber, ...round(el.getBoundingClientRect()),
  })) };
};

/** Which page containers currently hold a canvas + text layer. */
const MOUNTED = () => {
  const containers = [...document.querySelectorAll('[data-testid="pdf-page-container"]')];
  return containers.map((el) => ({
    page: Number(el.dataset.pageNumber),
    scale: Number(el.dataset.pageScale ?? "0"),
    top: Math.round(el.getBoundingClientRect().top),
    height: Math.round(el.getBoundingClientRect().height),
    hasCanvas: el.querySelector("canvas") !== null,
    hasTextLayer: el.querySelector('[data-testid="pdf-text-layer"]') !== null,
    spanCount: el.querySelectorAll('.textLayer span').length,
  }));
};

async function main() {
  if (!existsSync(FIXTURE)) {
    console.error(`missing fixture ${FIXTURE}; run make-crosspage-pdf.mjs first`);
    process.exit(1);
  }
  rmSync(join(workDir, "documents"), { recursive: true, force: true });
  mkdirSync(join(workDir, "documents"), { recursive: true });
  const database = join(workDir, "probe.sqlite3");
  rmSync(database, { force: true });

  const previewPort = await freePort();
  const backend = spawn(
    python,
    ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(BACKEND_PORT)],
    {
      cwd: backendDir,
      env: {
        ...process.env,
        DATABASE_PATH: database,
        DOCUMENTS_DIR: join(workDir, "documents"),
        LOG_LEVEL: "WARNING",
        CORS_ORIGINS: `http://127.0.0.1:${previewPort},http://localhost:${previewPort}`,
        PYTHONIOENCODING: "utf-8",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  backend.stderr.on("data", () => {});
  const preview = await startPreview(previewPort);

  const report = {};
  let browser = null;
  try {
    await waitFor(`http://127.0.0.1:${BACKEND_PORT}/api/config`);
    await waitFor(preview.url);

    browser = await chromium.launch({ channel: "msedge" });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(preview.url, { waitUntil: "domcontentloaded" });
    await page.setInputFiles('[data-testid="pdf-file-input"]', FIXTURE);
    await page.waitForSelector('[data-testid="pdf-page-container"]', { timeout: 60000 });
    await page.waitForTimeout(4000);

    // --- 1. geometry at rest ------------------------------------------------
    report.layout = await page.evaluate(() => {
      const viewer = document.querySelector('[data-testid="pdf-viewer"]');
      const container = document.querySelector('[data-testid="pdf-page-container"]');
      const rect = container.getBoundingClientRect();
      return {
        viewerClientHeight: viewer.clientHeight,
        viewerScrollHeight: viewer.scrollHeight,
        scrollTop: viewer.scrollTop,
        pageScale: Number(container.dataset.pageScale ?? "0"),
        pageTop: Math.round(rect.top),
        pageHeight: Math.round(rect.height),
        windowInnerHeight: window.innerHeight,
      };
    });

    // --- 2. scroll to the page 1 / page 2 boundary --------------------------
    report.scrolled = await page.evaluate(() => {
      const viewer = document.querySelector('[data-testid="pdf-viewer"]');
      const first = document.querySelector('[data-testid="pdf-page-container"][data-page-number="1"]');
      const second = document.querySelector('[data-testid="pdf-page-container"][data-page-number="2"]');
      // Put the boundary a little below the middle of the viewport, so both the
      // tail of page 1 and the head of page 2 are on screen together.
      viewer.scrollTop = second.offsetTop - viewer.clientHeight * 0.55;
      return { scrollTop: viewer.scrollTop };
    });
    await page.waitForTimeout(1200);
    report.mountedAtBoundary = await page.evaluate(MOUNTED);

    // --- 3. where are the two lines the drag will join? ---------------------
    const anchors = await page.evaluate(() => {
      const find = (prefix) => {
        const spans = [...document.querySelectorAll('.textLayer span')];
        const span = spans.find((s) => (s.textContent ?? "").trim().startsWith(prefix));
        return span ? span.getBoundingClientRect().toJSON() : null;
      };
      return { tailOfPage1: find("L1-37"), headOfPage2: find("L2-04") };
    });
    report.anchorLines = {
      tailOfPage1: anchors.tailOfPage1 && {
        left: Math.round(anchors.tailOfPage1.left),
        top: Math.round(anchors.tailOfPage1.top),
        right: Math.round(anchors.tailOfPage1.right),
        height: Math.round(anchors.tailOfPage1.height),
      },
      headOfPage2: anchors.headOfPage2 && {
        left: Math.round(anchors.headOfPage2.left),
        top: Math.round(anchors.headOfPage2.top),
        right: Math.round(anchors.headOfPage2.right),
        height: Math.round(anchors.headOfPage2.height),
      },
    };

    // --- 4. the drag --------------------------------------------------------
    if (anchors.tailOfPage1 && anchors.headOfPage2) {
      const a = anchors.tailOfPage1;
      const b = anchors.headOfPage2;
      await page.mouse.move(a.left + 3, a.top + a.height / 2);
      await page.mouse.down();
      // Several steps, because a single jump is not a drag a browser treats as
      // a selection, and the per-step positions are what a real gesture produces.
      for (let i = 1; i <= 24; i += 1) {
        await page.mouse.move(
          a.left + 3 + ((b.right - 4 - (a.left + 3)) * i) / 24,
          a.top + a.height / 2 + ((b.top + b.height / 2 - (a.top + a.height / 2)) * i) / 24,
        );
        await page.waitForTimeout(12);
      }
      await page.waitForTimeout(200);
      report.duringDrag = await page.evaluate(READ_RANGE);
      report.strategies = await page.evaluate(STRATEGIES);

      // --- 4b. does the Range survive its own page unmounting? -------------
      // A real drag that reaches the boundary is usually still scrolling. If a
      // touched page loses its text layer mid-drag, every offset into it is gone
      // and no mapping can be honest about it — so this is measured, not assumed.
      report.autoScroll = await page.evaluate(() => {
        const viewer = document.querySelector('[data-testid="pdf-viewer"]');
        return { before: viewer.scrollTop };
      });
      await page.mouse.move(a.left + 3, 880);
      await page.waitForTimeout(900);
      report.autoScroll.afterPointerAtEdge = await page.evaluate(
        () => document.querySelector('[data-testid="pdf-viewer"]').scrollTop,
      );
      await page.mouse.move(a.left + 3, b.top + b.height / 2, { steps: 8 });
      await page.waitForTimeout(300);
      report.autoScroll.restored = await page.evaluate(
        () => document.querySelector('[data-testid="pdf-viewer"]').scrollTop,
      );

      // --- 4c. the unmount, while the selection is still live --------------
      await page.evaluate(() => {
        const viewer = document.querySelector('[data-testid="pdf-viewer"]');
        viewer.scrollTop = 2600;
      });
      await page.waitForTimeout(1500);
      report.mountedFarAway = await page.evaluate(MOUNTED);
      report.afterUnmount = await page.evaluate(() => {
        const selection = window.getSelection();
        const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
        return {
          textLength: selection ? selection.toString().length : 0,
          rectCount: range ? [...range.getClientRects()].filter((r) => r.width > 0).length : 0,
          // A detached anchor is the failure mode that matters: the offsets point
          // into a node no longer in the document, so nothing can be measured.
          startConnected: range ? range.startContainer.isConnected : null,
          endConnected: range ? range.endContainer.isConnected : null,
        };
      });
      await page.evaluate(() => {
        const viewer = document.querySelector('[data-testid="pdf-viewer"]');
        viewer.scrollTop = 1135;
      });
      await page.waitForTimeout(1200);
      report.afterReturn = await page.evaluate(() => {
        const selection = window.getSelection();
        return {
          mapped: window.__lastMapping ?? null,
          textLength: selection ? selection.toString().length : 0,
          collapsed: selection ? selection.isCollapsed : null,
        };
      });

      await page.mouse.up();
      await page.waitForTimeout(1200);
      report.afterDrag = await page.evaluate(READ_RANGE);
      report.mountedAfterDrag = await page.evaluate(MOUNTED);
      report.selectionText = await page.evaluate(() =>
        window.getSelection()?.toString().slice(0, 200) ?? "",
      );

      // What the application made of it. The scope selector names the refusal
      // when the mapping was rejected, so its text is the observable.
      await page.waitForTimeout(600);
      report.appReaction = await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('[data-testid^="note-create"]')];
        return {
          createButtons: buttons.length,
          enabled: buttons.map((b) => !b.disabled),
          bodyText: (document.querySelector('[data-testid="reader-sidebar"]')?.textContent ?? "")
            .replace(/\s+/g, " ")
            .slice(0, 300),
        };
      });

      // --- 5. deliberate zoom-out: how many pages mount at once? ------------
      report.zoomOut = [];
      for (let i = 0; i < 3; i += 1) {
        await page.click('[aria-label="缩小"]').catch(() => {});
        await page.waitForTimeout(1000);
        const mounted = await page.evaluate(MOUNTED);
        report.zoomOut.push({
          scrollTop: await page.evaluate(
            () => document.querySelector('[data-testid="pdf-viewer"]').scrollTop,
          ),
          rendered: mounted.filter((m) => m.hasTextLayer).map((m) => m.page),
          scale: mounted[0]?.scale ?? null,
        });
      }
    }
  } finally {
    if (browser) await browser.close();
    preview.child?.kill();
    backend.kill();
  }

  writeFileSync(join(workDir, "probe.json"), JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report, null, 1));
  const first = readFileSync(join(workDir, "probe.json"), "utf8");
  if (first.length === 0) console.error("empty report");
}

await main();
