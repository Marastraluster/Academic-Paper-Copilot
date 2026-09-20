/**
 * DS-QA-011 real-browser verification — a selection that crosses a page boundary.
 *
 * Everything here is a *drag*, driven through Edge with real mouse events. The
 * mapping is a function of what the browser actually produces, and the one thing
 * no component test can reproduce is that: jsdom has no layout, no
 * virtualisation, and — measured — a `Range.toString()` that behaves differently
 * from the browser's once a page has been removed underneath it.
 *
 * The fixture's every line is prefixed `L<page>-<nn>`, so the harness names the
 * exact source lines a drag started and ended on instead of asserting against
 * "some paragraph". Ordering is then checkable rather than plausible: a backward
 * drag that leaves targets ordered 1,2 has been *shown* to be canonical.
 *
 * Usage:  node scripts/e2e-crosspage.mjs      (requires `npm run build` first)
 *         E2E_PAPER=<path> E2E_LABEL=<name> node scripts/e2e-crosspage.mjs
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const backendDir = join(repoRoot, "backend");
const python = join(backendDir, ".venv", "Scripts", "python.exe");
const workDir = join(repoRoot, ".agent", "results", "e2e-crosspage");
const SYNTHETIC = join(repoRoot, ".agent", "results", "crosspage", "fixture.pdf");

// The built bundle talks to 127.0.0.1:8000 by configuration, so a harness on any
// other port gets a page that renders the PDF locally and never registers it —
// which looks exactly like a broken feature.
const BACKEND_PORT = 8000;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;

const PAPER_PATH = process.env.E2E_PAPER ?? SYNTHETIC;
const PAPER_LABEL = process.env.E2E_LABEL ?? "synthetic-two-page";
/** Which page boundary to drag across. */
const BOUNDARY = Number(process.env.E2E_BOUNDARY ?? "1");

let PREVIEW_URL = "";
const results = [];
const providerCalls = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
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

function prepareWorkdir() {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(join(workDir, "documents"), { recursive: true });
  return {
    paper: PAPER_PATH,
    database: join(workDir, "db.sqlite3"),
    documentsDir: join(workDir, "documents"),
  };
}

function startBackend(corsPort, { database, documentsDir }) {
  const child = spawn(python, ["-m", "uvicorn", "app.main:app", "--port", String(BACKEND_PORT)], {
    cwd: backendDir,
    env: {
      ...process.env, PYTHONIOENCODING: "utf-8", PYTHONPATH: backendDir,
      DATABASE_PATH: database, DOCUMENTS_DIR: documentsDir,
      CORS_ORIGINS: `http://127.0.0.1:${corsPort},http://localhost:${corsPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", () => {});
  return child;
}

async function waitFor(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return true; } catch { /* not up */ }
    await sleep(300);
  }
  return false;
}

async function startPreview(port) {
  const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "preview", "--", "--port", String(port), "--strictPort"],
    { cwd: join(repoRoot, "frontend"), stdio: ["ignore", "pipe", "pipe"], shell: true });
  await new Promise((done) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += String(chunk).replace(/\x1b\[[0-9;]*m/g, "");
      const match = buffer.match(/http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)/);
      if (match && !PREVIEW_URL) { PREVIEW_URL = `http://127.0.0.1:${match[1]}`; done(); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    setTimeout(done, 20000);
  });
  return child;
}

function uploadedDocumentId() {
  const entries = readdirSync(join(workDir, "documents")).filter((n) => n.startsWith("doc_"));
  return entries.sort().reverse()[0];
}

/**
 * Open the notes tab, and say which state the panel is actually in when it does
 * not come up. "The panel is missing" and "the document never registered" look
 * identical at a selector timeout, and they have nothing in common.
 */
async function openNotes(page) {
  await page.waitForSelector(
    '[data-testid="notes-panel"], [data-testid="notes-empty-state"]',
    { timeout: 30000 },
  );
  const empty = await page.locator('[data-testid="notes-empty-state"]').count();
  if (empty > 0) {
    const state = await page.evaluate(() => ({
      body: (document.body.textContent ?? "").replace(/\s+/g, " ").slice(0, 240),
      errorState: document.querySelectorAll('[data-testid="pdf-error-state"]').length,
    }));
    throw new Error(`the document is not ready: ${JSON.stringify(state)}`);
  }
  await page.waitForSelector('[data-testid="notes-panel"]', { timeout: 30000 });
}

/**
 * Wait until the mounted pages' text layers stop changing.
 *
 * A drag whose anchor node is replaced while the button is down produces no
 * selection at all — measured, and the reason this exists. The reader re-renders
 * a page's text layer whenever the page enters or leaves its render window, so a
 * gesture started immediately after a scroll can land on spans that are about to
 * be thrown away. Sampling until the layer is unchanged for a beat is the
 * difference between measuring the product and measuring the harness's timing.
 */
async function waitForStableLayers(page, pages, settleMs = 700) {
  const sample = () => page.evaluate((numbers) => numbers.map((n) => {
    const layer = document.querySelector(`[data-page-number="${n}"] [data-testid="pdf-text-layer"]`);
    if (!layer) return `${n}:none`;
    const spans = layer.querySelectorAll("span");
    const box = spans.length ? spans[0].getBoundingClientRect() : null;
    return `${n}:${spans.length}:${box ? Math.round(box.top) : 0}`;
  }).join("|"), pages);

  let previous = await sample();
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    await sleep(settleMs);
    const current = await sample();
    if (current === previous && !current.includes(":none")) return current;
    previous = current;
  }
  return previous;
}

async function openPaper(page, paper) {
  await page.setInputFiles('[data-testid="pdf-file-input"]', paper);
  await page.waitForSelector('[data-testid="pdf-page-container"]', { timeout: 120000 });
  await page.waitForSelector('[data-testid="assistant-tab-notes"]', { timeout: 60000 });
  // Registration uploads the file and then fetches the canonical IR, and the
  // mapping is *unavailable* until that arrives. Dragging before it lands makes
  // the harness measure its own impatience: measured, it produced a refusal with
  // no explanation, because a selection with no IR is not a failed selection.
  const deadline = Date.now() + 180000;
  let documentId = null;
  while (Date.now() < deadline && documentId === null) {
    try { documentId = uploadedDocumentId(); } catch { /* not written yet */ }
    if (documentId === undefined) documentId = null;
    if (documentId === null) await sleep(500);
  }
  if (documentId === null) throw new Error("the document never registered");
  await waitFor(`${BACKEND_URL}/api/documents/${documentId}/ir`, 180000);
  await sleep(1200);
}

/**
 * What the sidebar says went wrong, read where it is actually rendered.
 *
 * The refusal sentence lives in the QA panel's scope selector, so asking for it
 * while the notes tab is open always returns nothing — which is exactly how a
 * harness concludes "no reason was given" when a reason was there all along.
 */
async function readRefusal(page) {
  await page.click('[data-testid="assistant-tab-qa"]');
  await sleep(400);
  const text = await page.locator('[data-testid="selection-refusal"]').count() > 0
    ? await page.locator('[data-testid="selection-refusal"]').innerText() : "";
  await page.click('[data-testid="assistant-tab-notes"]');
  await sleep(300);
  return text;
}

/**
 * Scroll so page `n`'s last lines and page `n+1`'s first lines are both on
 * screen. This is the only window in which a cross-page drag is possible at all
 * — the viewer keeps a page mounted only while it is near the viewport, and the
 * measurement found exactly two pages mounted at a boundary, never three.
 */
async function scrollToBoundary(page, n) {
  return page.evaluate((pageNumber) => {
    const viewer = document.querySelector('[data-testid="pdf-viewer"]');
    const next = document.querySelector(`[data-page-number="${pageNumber + 1}"]`);
    if (!viewer || !next) return null;
    viewer.scrollTop = next.offsetTop - viewer.clientHeight * 0.55;
    return viewer.scrollTop;
  }, n);
}

/**
 * The two ends of a boundary drag, and they are chosen for a reason.
 *
 * **Start** is the first line in the bottom quarter of page N, not page N's last
 * line. Starting on the last line selects one line of that page, and the
 * paragraph it belongs to is then supported by roughly a quarter of its own
 * words — which the mapper is entitled to reject, and did, when this harness
 * first used the last line. The bottom quarter lands on a paragraph boundary in
 * the synthetic fixture and inside a body paragraph on a real paper, so what is
 * selected is always a substantial run of prose on both pages.
 *
 * **End** is the last line of page N+1 still comfortably inside the viewport.
 * Ending at the very edge would push the pointer into the autoscroll band
 * (measured at 2.9 px/ms) and the gesture would keep going past what the
 * harness asked for.
 */
async function boundaryAnchors(page, n) {
  return page.evaluate((pageNumber) => {
    const containerOf = (p) => document.querySelector(`[data-page-number="${p}"]`);
    const layerOf = (p) => {
      const container = containerOf(p);
      return container ? container.querySelector('[data-testid="pdf-text-layer"]') : null;
    };
    const usable = (layer) =>
      layer ? [...layer.querySelectorAll("span")]
        .filter((s) => (s.textContent ?? "").trim().length > 20) : [];

    const viewer = document.querySelector('[data-testid="pdf-viewer"]');
    const previousBox = containerOf(pageNumber)?.getBoundingClientRect();
    const nextBox = containerOf(pageNumber + 1)?.getBoundingClientRect();
    if (!viewer || !previousBox || !nextBox) return null;

    const previous = usable(layerOf(pageNumber));
    const next = usable(layerOf(pageNumber + 1));
    if (previous.length === 0 || next.length === 0) return null;

    const viewerBox = viewer.getBoundingClientRect();

    /* Both ends are kept clear of the reader's edges on purpose. A drag that
       reaches within a few pixels of the top or bottom sets off the browser's
       own autoscroll, which scrolls the pages under a stationary pointer — and
       then the coordinates this function returned describe content that is no
       longer there. Measured: the same drag selected 1,879 characters and then
       nothing at all, on the same scroll position. */
    const band = viewerBox.height * 0.12;
    const lowest = viewerBox.top + viewerBox.height - band;
    const topmost = viewerBox.top + band;

    const bottomQuarter = previousBox.bottom - previousBox.height * 0.25;
    const tail = previous.find((s) => {
      const box = s.getBoundingClientRect();
      const centre = box.top + box.height / 2;
      return centre >= bottomQuarter && centre >= topmost && centre <= lowest;
    }) ?? previous.find((s) => {
      const box = s.getBoundingClientRect();
      return box.top + box.height / 2 >= topmost && box.top + box.height / 2 <= lowest;
    }) ?? previous[previous.length - 1];
    const a = tail.getBoundingClientRect();

    const limit = viewerBox.top + viewerBox.height - band;
    const visible = next.filter(
      (s) => s.getBoundingClientRect().top + s.getBoundingClientRect().height / 2 <= limit,
    );
    const head = visible.length > 0 ? visible[visible.length - 1] : next[0];
    const b = head.getBoundingClientRect();

    return {
      mounted: [Boolean(layerOf(pageNumber)), Boolean(layerOf(pageNumber + 1))],
      tailText: (tail.textContent ?? "").trim().slice(0, 24),
      headText: (head.textContent ?? "").trim().slice(0, 24),
      start: { x: a.left, y: a.top + a.height / 2 },
      end: { x: b.right - 4, y: b.top + b.height / 2 },
    };
  }, n);
}

/** A real drag, in steps — one jump is not a gesture a browser reads as one. */
async function dragAcross(page, from, to) {
  const before = { top: await page.evaluate(() =>
    document.querySelector('[data-testid="pdf-viewer"]').scrollTop) };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // A beat, then a two-pixel move, before the real gesture. Measured: a drag
  // dispatched as one immediate jump after the button goes down reliably selects
  // when it starts high in the page and intermittently selects nothing when it
  // starts low — the browser has not latched the anchor yet.
  await sleep(80);
  await page.mouse.move(from.x + (to.x >= from.x ? 2 : -2), from.y + (to.y >= from.y ? 2 : -2));
  await sleep(30);
  const steps = 20;
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * i) / steps,
      from.y + ((to.y - from.y) * i) / steps,
    );
    await sleep(16);
  }
  await page.mouse.up();
  await sleep(900); // the capture hook settles at 150 ms, then the IR maps

  const moved = await page.evaluate(() =>
    document.querySelector('[data-testid="pdf-viewer"]').scrollTop);
  if (Math.abs(moved - before.top) > 2) {
    console.log(`    [warn] the view scrolled during the drag: ` +
      `${before.top} -> ${moved}; later coordinates may not apply`);
  }
}

async function main() {
  if (!existsSync(PAPER_PATH)) {
    console.error(`missing paper ${PAPER_PATH}`);
    return 2;
  }
  const before = createHash("sha256").update(readFileSync(PAPER_PATH)).digest("hex");
  const { paper, database, documentsDir } = prepareWorkdir();
  console.log(`paper: ${PAPER_LABEL} — ${paper}`);
  console.log(`boundary: page ${BOUNDARY} -> ${BOUNDARY + 1}\n`);

  const previewPort = await freePort();
  const backend = startBackend(previewPort, { database, documentsDir });
  if (!(await waitFor(`${BACKEND_URL}/api/health`))) {
    console.log("backend did not start"); backend.kill(); return 2;
  }
  const preview = await startPreview(previewPort);
  if (!PREVIEW_URL) { preview.kill(); backend.kill(); return 2; }
  console.log(`preview: ${PREVIEW_URL}\n`);

  const browser = await chromium.launch({ channel: "msedge" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
/* A 404 is the *designed* answer on the two routes the Overview panel asks
   about when a paper opens: `/overview` (nothing generated yet) and the older
   `/analysis` (not analysed yet). The status is part of the match, so a 500 on
   either path is still an error; the location carries the route. */
const designed404 = (t) =>
  /status of 404/.test(t) && /\/(analysis|overview)(\?|\s|$)/.test(t);

    /* The console message for a failed request does not carry its URL, and the
     Overview panel asks for an analysis on every paper open — a 404 there is
     the route's designed answer ("not analysed yet"), not a fault. The location
     does carry the URL, so the filter can be exact. */
page.on("console", (m) => {
    if (m.type() !== "error") return;
    consoleErrors.push(`${m.text()} :: ${m.location()?.url ?? ""}`);
  });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  let createCalls = 0;
  page.on("request", (r) => {
    if (/deepseek|openai|anthropic|chat\/completions/.test(r.url())) providerCalls.push(r.url());
    if (r.method() === "POST" && r.url().includes("/annotations")) createCalls += 1;
  });
  page.on("response", async (r) => {
    if (!r.url().includes("/api/")) return;
    let body = "";
    try { body = (await r.text()).slice(0, 160); } catch { /* gone */ }
    const path = r.url().replace(BACKEND_URL, "");
    if (r.status() >= 400 || path.includes("/documents")) {
      console.log(`    [api] ${r.status()} ${r.request().method()} ${path} :: ${body}`);
    }
  });
  page.on("requestfailed", (r) => {
    if (r.url().includes("/api/")) {
      console.log(`    [reqfail] ${r.url().replace(BACKEND_URL, "")} :: ${r.failure()?.errorText}`);
    }
  });

  const annotations = async (documentId) =>
    (await fetch(`${BACKEND_URL}/api/documents/${documentId}/annotations`)).json();

  try {
    await page.goto(PREVIEW_URL, { waitUntil: "domcontentloaded" });
    await openPaper(page, paper);
    const documentId = uploadedDocumentId();
    const ir = await (await fetch(`${BACKEND_URL}/api/documents/${documentId}/ir`)).json();
    await page.click('[data-testid="assistant-tab-notes"]');
    await openNotes(page);

    // --- 1. the boundary window -------------------------------------------
    await scrollToBoundary(page, BOUNDARY);
    await waitForStableLayers(page, [BOUNDARY, BOUNDARY + 1]);
    const anchors = await boundaryAnchors(page, BOUNDARY);
    check(
      "two adjacent pages are mounted at the boundary",
      anchors !== null && anchors.mounted.every(Boolean),
      anchors
        ? `${anchors.mounted.join(", ")} | tail=${JSON.stringify(anchors.tailText)} ` +
          `head=${JSON.stringify(anchors.headText)} ` +
          `from=(${anchors.start.x.toFixed(0)},${anchors.start.y.toFixed(0)}) ` +
          `to=(${anchors.end.x.toFixed(0)},${anchors.end.y.toFixed(0)})`
        : "no text layer",
    );
    if (!anchors) throw new Error("no boundary to drag across");

    // --- 2. the harder direction first, with nothing on the page yet -------
    // A backward drag is the one that proves canonical ordering: the *drag* runs
    // page N+1 -> N, so if the persisted targets read N…N+1 they were ordered by
    // the document and not by the gesture. It runs before anything is created,
    // so a failure here cannot be the annotation overlay getting in the way.
    await dragAcross(page, anchors.end, anchors.start);
    const backward = await page.evaluate(() =>
      (window.getSelection()?.toString() ?? "").replace(/\s+/g, " ").trim());
    const tailFragment = anchors.tailText.slice(-14).replace(/\s+/g, " ");
    const headFragment = anchors.headText.slice(0, 10).replace(/\s+/g, " ");
    check(
      "a backward drag selects text from both pages",
      backward.includes(tailFragment) && backward.includes(headFragment),
      `${backward.length} chars | ${JSON.stringify(backward.slice(0, 44))} …`,
    );

    const backwardEnabled =
      await page.locator('[data-testid="notes-create-highlight"]').isEnabled();
    let backwardRefusal = "";
    if (!backwardEnabled) backwardRefusal = await readRefusal(page);
    check("the backward selection enables the create action", backwardEnabled,
      backwardRefusal ? `refusal: ${backwardRefusal}` : "");
    if (!backwardEnabled) {
      throw new Error(`the backward selection did not map: ${backwardRefusal || "no reason shown"}`);
    }

    /* The direction claim, asserted on the browser's own selection rather than
       inferred from the result: a Range is always normalised, so what makes the
       drag backward is which end is the *anchor*. */
    const direction = await page.evaluate(() => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return null;
      const range = selection.getRangeAt(0);
      const pageOf = (node) => {
        let element = node instanceof Element ? node : (node?.parentElement ?? null);
        while (element) {
          if (element instanceof HTMLElement && element.dataset.pageNumber) {
            return Number(element.dataset.pageNumber);
          }
          element = element.parentElement;
        }
        return null;
      };
      return {
        anchor: pageOf(selection.anchorNode), focus: pageOf(selection.focusNode),
        start: pageOf(range.startContainer), end: pageOf(range.endContainer),
      };
    });
    check(
      "the drag really ran backward: anchor on the later page, range still normalised",
      direction !== null && direction.anchor === BOUNDARY + 1
        && direction.focus === BOUNDARY
        && direction.start === BOUNDARY && direction.end === BOUNDARY + 1,
      JSON.stringify(direction),
    );

    await page.click('[data-testid="notes-create-highlight"]');
    await sleep(1500);

    const listed = await annotations(documentId);
    const created = listed.annotations[0];
    check("one annotation was created", listed.annotations.length === 1,
      `${listed.annotations.length} listed`);

    const targetPages = created.targets.map((t) => t.page_number);
    check(
      "every target lands on one of the two pages the drag crossed",
      targetPages.length >= 2
        && new Set(targetPages).size === 2
        && targetPages.every((p) => p === BOUNDARY || p === BOUNDARY + 1),
      `pages ${targetPages.join(",")}`,
    );
    check(
      "targets are ordered by page even though the drag ran backward",
      targetPages.join(",") === [...targetPages].sort((x, y) => x - y).join(","),
      `order ${targetPages.join(",")}`,
    );

    /* The artifact this task exists to prevent. A whole-page rectangle measured
       842 pt tall in the probe; a line of this paper is ~11 pt. Anything in the
       hundreds is a page box that got attributed to a page it does not belong
       to, and it would paint over the whole page. */
    const tallest = Math.max(...created.targets.flatMap((t) =>
      t.rects.map((r) => r[3] - r[1])));
    check("no target carries a page-sized rectangle", tallest < 60,
      `tallest rect ${tallest.toFixed(1)} pt`);

    /* The structural form of "no rectangle bridges two pages": every rectangle
       lies inside its own page's box, so a bridging rectangle is by definition
       outside one of them. Containment inside the paragraph *envelope* is
       enforced by the server at write time — this annotation was accepted, so it
       held — but the envelope is deliberately not in the response. */
    const pageBox = new Map(ir.pages.map((p) => [p.page_number, p]));
    const outOfPage = created.targets.flatMap((t) => {
      const box = pageBox.get(t.page_number);
      if (!box) return [];
      return t.rects.filter((r) =>
        r[0] < -0.5 || r[1] < -0.5
        || r[2] > box.width_pt + 0.5 || r[3] > box.height_pt + 0.5);
    });
    check("every rectangle lies inside its own page's box", outOfPage.length === 0,
      outOfPage.length ? JSON.stringify(outOfPage[0]) : `${created.targets.length} targets checked`);

    // --- 3. the highlight is on both pages --------------------------------
    const boxesByPage = await page.evaluate((pageNumber) => {
      const countIn = (p) => {
        const container = document.querySelector(`[data-page-number="${p}"]`);
        return container
          ? container.querySelectorAll('[data-testid="pdf-persistent-highlight-box"]').length
          : 0;
      };
      return { first: countIn(pageNumber), second: countIn(pageNumber + 1) };
    }, BOUNDARY);
    check("a highlight is drawn on both pages",
      boxesByPage.first > 0 && boxesByPage.second > 0,
      `page ${BOUNDARY}: ${boxesByPage.first}, page ${BOUNDARY + 1}: ${boxesByPage.second}`);

    const rows = await page.locator("li[data-testid^='note-']").count();
    check("the notes panel lists it once", rows === 1, `${rows} rows`);

    // --- 4. the same span, dragged the other way, is the same annotation ---
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await sleep(400);
    await scrollToBoundary(page, BOUNDARY);
    await waitForStableLayers(page, [BOUNDARY, BOUNDARY + 1]);
    const anchorsAgain = await boundaryAnchors(page, BOUNDARY);
    await dragAcross(page, anchorsAgain.start, anchorsAgain.end);
    const forward = await page.evaluate(() =>
      (window.getSelection()?.toString() ?? "").replace(/\s+/g, " ").trim());
    check(
      "a forward drag over the same span also spans both pages",
      forward.includes(anchorsAgain.tailText.slice(-14).replace(/\s+/g, " "))
        && forward.includes(anchorsAgain.headText.slice(0, 10).replace(/\s+/g, " ")),
      `${forward.length} chars`,
    );
    const forwardEnabled =
      await page.locator('[data-testid="notes-create-highlight"]').isEnabled();
    check("the forward selection enables the create action", forwardEnabled,
      forwardEnabled ? "" : await readRefusal(page));
    if (forwardEnabled) {
      await page.click('[data-testid="notes-create-highlight"]');
      await sleep(1500);
      const after = await annotations(documentId);
      check(
        "re-marking the same span focuses the existing annotation",
        after.annotations.length === 1,
        `${after.annotations.length} annotation(s)`,
      );
    }

    // --- 5. virtualisation: unmount, then remount -------------------------
    const createdBefore = createCalls;
    await page.evaluate(() => {
      document.querySelector('[data-testid="pdf-viewer"]').scrollTop = 100000;
    });
    await sleep(1800);
    const unmounted = await page.evaluate((pageNumber) => {
      const container = document.querySelector(`[data-page-number="${pageNumber}"]`);
      return container
        ? container.querySelector('[data-testid="pdf-text-layer"]') === null
        : true;
    }, BOUNDARY);
    check("scrolling far away unmounts the annotated page's layer", unmounted);

    await scrollToBoundary(page, BOUNDARY);
    await waitForStableLayers(page, [BOUNDARY, BOUNDARY + 1]);
    const restored = await page.evaluate((pageNumber) => {
      const countIn = (p) => {
        const container = document.querySelector(`[data-page-number="${p}"]`);
        return container
          ? container.querySelectorAll('[data-testid="pdf-persistent-highlight-box"]').length
          : 0;
      };
      return { first: countIn(pageNumber), second: countIn(pageNumber + 1) };
    }, BOUNDARY);
    check("both pages' highlights come back on remount",
      restored.first > 0 && restored.second > 0,
      `page ${BOUNDARY}: ${restored.first}, page ${BOUNDARY + 1}: ${restored.second}`);
    check("the remount issued no extra create request",
      createCalls === createdBefore, `${createCalls - createdBefore} extra`);

    // --- 6. reload ---------------------------------------------------------
    await page.reload({ waitUntil: "domcontentloaded" });
    await openPaper(page, paper);
    await page.click('[data-testid="assistant-tab-notes"]');
    await openNotes(page);
    await sleep(1500);
    await scrollToBoundary(page, BOUNDARY);
    await waitForStableLayers(page, [BOUNDARY, BOUNDARY + 1]);
    const afterReload = await page.evaluate((pageNumber) => {
      const countIn = (p) => {
        const container = document.querySelector(`[data-page-number="${p}"]`);
        return container
          ? container.querySelectorAll('[data-testid="pdf-persistent-highlight-box"]').length
          : 0;
      };
      return { first: countIn(pageNumber), second: countIn(pageNumber + 1) };
    }, BOUNDARY);
    check("after a reload both pages draw their highlights again",
      afterReload.first > 0 && afterReload.second > 0,
      `page ${BOUNDARY}: ${afterReload.first}, page ${BOUNDARY + 1}: ${afterReload.second}`);

    const reloadedId = uploadedDocumentId();
    const reloaded = await annotations(reloadedId);
    check("the reloaded document lists one annotation spanning both pages",
      reloaded.annotations.length === 1
        && new Set(reloaded.annotations[0].targets.map((t) => t.page_number)).size === 2,
      `${reloaded.annotations.length} annotation(s), ` +
      `${reloaded.annotations[0]?.targets.length ?? 0} target(s)`);

    // --- 7. navigation -----------------------------------------------------
    if (reloaded.annotations.length > 0) {
      await page.click("li[data-testid^='note-']");
      await sleep(1500);
      const navigated = await page.evaluate((pageNumber) => {
        const viewer = document.querySelector('[data-testid="pdf-viewer"]');
        const container = document.querySelector(`[data-page-number="${pageNumber}"]`);
        if (!viewer || !container) return null;
        const rect = container.getBoundingClientRect();
        const viewerRect = viewer.getBoundingClientRect();
        // The first page of the span is on screen after the jump.
        return rect.bottom > viewerRect.top && rect.top < viewerRect.bottom;
      }, BOUNDARY);
      check("clicking the annotation lands on its first page", navigated === true);
    }

    check("no provider call was made", providerCalls.length === 0,
      providerCalls.join(", "));
    check("no uncaught console errors during the run",
      consoleErrors.filter(
        (t) => !/ERR_CONNECTION_(RESET|REFUSED)/.test(t) && !designed404(t)).length === 0,
      consoleErrors.slice(0, 2).join(" | "));
  } finally {
    await browser.close();
    preview.child?.kill();
    backend.kill();
  }

  const after = createHash("sha256").update(readFileSync(PAPER_PATH)).digest("hex");
  check("the source PDF is byte-identical", before === after, before.slice(0, 16));

  const passed = results.filter((r) => r.ok).length;
  writeFileSync(join(workDir, "results.json"), JSON.stringify({ results, passed }, null, 1));
  console.log(`\n${passed}/${results.length} passed`);
  return passed === results.length ? 0 : 1;
}

process.exit(await main());
