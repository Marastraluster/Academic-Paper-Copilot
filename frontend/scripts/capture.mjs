/**
 * DS-FE-001 visual evidence + layout verification.
 *
 * Runs against `npm run preview` and produces:
 *   .agent/screenshots/DS-FE-001.png            (1440x900, required by AC-36)
 *   .agent/screenshots/DS-FE-001-1024.png
 *   .agent/screenshots/DS-FE-001-1920.png
 *   .agent/screenshots/DS-FE-001-original.png
 *   .agent/screenshots/DS-FE-001-collapsed.png
 *
 * It also asserts the things that would otherwise be manual eyeballing:
 *   - no window-level scrollbars at any required width  (AC-11/12/13, failure F-06)
 *   - no console errors                                 (AC-09)
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../../.agent/screenshots");
mkdirSync(outDir, { recursive: true });

const BASE_URL = process.env.PREVIEW_URL ?? "http://127.0.0.1:4173";

/**
 * A real PDF to open in the viewer, produced by scripts/make-fixture-pdf.mjs.
 *
 * Without it the workspace is empty and the content-dependent checks — pane
 * alignment, viewer scrolling — have nothing to measure. They are skipped with a
 * stated reason rather than silently passing.
 */
const PDF_FIXTURE = process.env.CAPTURE_PDF ?? null;

async function loadFixtureIntoViewers(page) {
  if (!PDF_FIXTURE) return false;
  const inputs = page.locator('[data-testid="pdf-file-input"]');
  const count = await inputs.count();
  for (let index = 0; index < count; index += 1) {
    await inputs.nth(index).setInputFiles(PDF_FIXTURE);
  }
  await page.waitForSelector('[data-testid="pdf-page-container"]', { timeout: 15000 });
  await page.waitForTimeout(600); // let the first canvases paint
  return true;
}

/** Widths required by AC-11 / AC-12 / AC-13. */
const VIEWPORTS = [
  { w: 1024, h: 768, file: "DS-FE-001-1024.png" },
  { w: 1440, h: 900, file: "DS-FE-001.png" },
  { w: 1920, h: 1080, file: "DS-FE-001-1920.png" },
];

const browser = await chromium.launch({ channel: "msedge" });
const results = [];
const failures = [];

async function checkNoWindowScroll(page, label) {
  const overflow = await page.evaluate(() => {
    const el = document.documentElement;
    return {
      scrollW: el.scrollWidth,
      clientW: el.clientWidth,
      scrollH: el.scrollHeight,
      clientH: el.clientHeight,
      bodyScrollW: document.body.scrollWidth,
      bodyClientW: document.body.clientWidth,
    };
  });

  const hOverflow = overflow.scrollW - overflow.clientW;
  const vOverflow = overflow.scrollH - overflow.clientH;

  if (hOverflow > 0 || vOverflow > 0) {
    failures.push(
      `${label}: window scroll leak — horizontal +${hOverflow}px, vertical +${vOverflow}px (F-06)`,
    );
  }
  results.push({
    label,
    hOverflow,
    vOverflow,
    pass: hOverflow <= 0 && vOverflow <= 0,
  });
}

// --- Responsive captures -----------------------------------------------------
for (const { w, h, file } of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });

  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  // Report the offending URL, not just "404".
  page.on("response", (r) => {
    if (r.status() >= 400) {
      consoleErrors.push(`HTTP ${r.status()} ${r.url()}`);
    }
  });

  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="reader-workspace"]');
  // Let the sidebar width transition settle before measuring.
  await page.waitForTimeout(400);

  await loadFixtureIntoViewers(page);

  await checkNoWindowScroll(page, `${w}x${h}`);
  await page.screenshot({ path: resolve(outDir, file) });

  if (consoleErrors.length) {
    failures.push(`${w}x${h}: console errors — ${consoleErrors.join(" | ")}`);
  }
  results.push({ label: `${w}x${h} console`, pass: consoleErrors.length === 0 });

  await page.close();
}

// --- Interaction states at 1440x900 -----------------------------------------
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(BASE_URL, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="reader-workspace"]');
await page.waitForTimeout(300);

// Original-only mode
await page.click('[data-testid="reader-mode-original"]');
await page.waitForTimeout(250);
await page.screenshot({ path: resolve(outDir, "DS-FE-001-original.png") });
const originalOnly =
  (await page.locator('[data-testid="viewer-original"]').count()) === 1 &&
  (await page.locator('[data-testid="viewer-translated"]').count()) === 0;

// Back to bilingual + collapse the sidebar
await page.click('[data-testid="reader-mode-bilingual"]');
await page.waitForTimeout(200);
await page.click('[data-testid="sidebar-toggle"]');
await page.waitForTimeout(400);
await page.screenshot({ path: resolve(outDir, "DS-FE-001-collapsed.png") });

const sidebarWidth = await page.evaluate(() => {
  const el = document.querySelector('[data-testid="assistant-sidebar"]');
  return el ? el.getBoundingClientRect().width : -1;
});
const workspaceWidth = await page.evaluate(() => {
  const el = document.querySelector('[data-testid="reader-workspace"]');
  return el ? el.getBoundingClientRect().width : -1;
});

if (!originalOnly) failures.push("original mode: viewer panel counts wrong (F-04)");
if (sidebarWidth > 1) failures.push(`collapsed sidebar width ${sidebarWidth}px, expected ~0`);

// Both panes must be loaded before comparing them: switching reader modes
// unmounts a panel, and a remounted viewer starts empty.
await loadFixtureIntoViewers(page);

// The two panes are compared side by side, so their page surfaces must line up.
// A visible vertical offset here reads as a rendering bug.
const alignment = await page.evaluate(() => {
  const top = (id) => {
    const panel = document.querySelector(`[data-testid="${id}"]`);
    const surface = panel?.querySelector('[data-testid="pdf-page-container"]');
    return surface ? Math.round(surface.getBoundingClientRect().top) : -1;
  };
  return { original: top("viewer-original"), translated: top("viewer-translated") };
});
const aligned =
  alignment.original >= 0 &&
  Math.abs(alignment.original - alignment.translated) <= 1;

if (!aligned) {
  failures.push(
    `bilingual panes misaligned: original top=${alignment.original}px, translated top=${alignment.translated}px`,
  );
}

results.push({
  label: "bilingual panes aligned",
  pass: aligned,
  detail: `orig=${alignment.original}px trans=${alignment.translated}px`,
});
results.push({ label: "original mode panel swap", pass: originalOnly });
results.push({ label: "collapsed sidebar width ~0", pass: sidebarWidth <= 1 });
results.push({
  label: "workspace reclaims width",
  pass: workspaceWidth > 1000,
  detail: `workspace=${workspaceWidth}px`,
});

await page.close();

// --- AC-26: initial render performance --------------------------------------
const perfPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await perfPage.goto(BASE_URL, { waitUntil: "load" });
await perfPage.waitForSelector('[data-testid="reader-workspace"]');

const perf = await perfPage.evaluate(async () => {
  const nav = performance.getEntriesByType("navigation")[0];

  // `getEntriesByType("paint")` occasionally comes back empty even after the
  // page has painted — the buffered observer is the reliable read, so fall back
  // to it rather than reporting a spurious -1.
  let fcp = performance
    .getEntriesByType("paint")
    .find((p) => p.name === "first-contentful-paint")?.startTime;

  if (fcp === undefined) {
    fcp = await new Promise((resolve) => {
      const observer = new PerformanceObserver((list) => {
        const entry = list.getEntries().find((e) => e.name === "first-contentful-paint");
        if (entry) {
          observer.disconnect();
          resolve(entry.startTime);
        }
      });
      observer.observe({ type: "paint", buffered: true });
      setTimeout(() => {
        observer.disconnect();
        resolve(-1);
      }, 2000);
    });
  }

  return {
    fcp: Math.round(fcp),
    domInteractive: nav ? Math.round(nav.domInteractive) : -1,
    domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : -1,
  };
});

// AC-27 (P1): no layout shift on load — the four regions take fixed/flex bounds.
const cls = await perfPage.evaluate(
  () =>
    new Promise((resolve) => {
      let total = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) total += entry.value;
        }
      }).observe({ type: "layout-shift", buffered: true });
      // Give the observer time to drain buffered shifts.
      setTimeout(() => resolve(total), 600);
    }),
);

results.push({
  label: "AC-27 cumulative layout shift",
  pass: cls === 0,
  detail: `CLS=${cls}`,
});
if (cls !== 0) failures.push(`AC-27: CLS ${cls} is not 0`);

await perfPage.close();

const FCP_BUDGET_MS = 300;
const fcpPass = perf.fcp >= 0 && perf.fcp < FCP_BUDGET_MS;
const ttiPass =
  perf.domInteractive >= 0 && perf.domInteractive < FCP_BUDGET_MS;

if (!fcpPass) failures.push(`AC-26: FCP ${perf.fcp}ms exceeds ${FCP_BUDGET_MS}ms`);
if (!ttiPass)
  failures.push(
    `AC-26: DOM interactive ${perf.domInteractive}ms exceeds ${FCP_BUDGET_MS}ms`,
  );

results.push({
  label: "AC-26 first contentful paint",
  pass: fcpPass,
  detail: `${perf.fcp}ms (budget ${FCP_BUDGET_MS}ms)`,
});
results.push({
  label: "AC-26 time to interactive (DOM interactive)",
  pass: ttiPass,
  detail: `${perf.domInteractive}ms (budget ${FCP_BUDGET_MS}ms)`,
});

// --- AC-37 independent scroll + AC-38 keyboard traversal ---------------------
const a11yPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await a11yPage.goto(BASE_URL, { waitUntil: "networkidle" });
await a11yPage.waitForSelector('[data-testid="reader-workspace"]');
await loadFixtureIntoViewers(a11yPage);

// AC-38 runs FIRST, on a freshly loaded page where focus starts at the document
// root — otherwise traversal only ever shows the tail of the sequence.
const tabsFromStart = [];
// Enough presses to traverse the whole shell: top bar (7), sidebar scope +
// six quick actions, conversation, composer, then both viewers.
for (let i = 0; i < 26; i += 1) {
  await a11yPage.keyboard.press("Tab");
  tabsFromStart.push(
    await a11yPage.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return "(none)";
      return (
        el.getAttribute("aria-label") ??
        el.getAttribute("data-testid") ??
        (el.textContent ?? "").trim().slice(0, 20)
      );
    }),
  );
}
console.log(`\nFull tab order from load:\n  ${tabsFromStart.join(" -> ")}`);

// AC-37 — flood the conversation: 10 quick-action clicks = 20 extra messages.
for (let i = 0; i < 10; i += 1) {
  await a11yPage.click('[data-testid="quick-action-总结本页"]');
}

const scrollState = await a11yPage.evaluate(() => {
  const conv = document.querySelector('[data-testid="conversation-area"]');
  const viewer = document.querySelector(
    '[data-testid="viewer-original"] [data-testid="pdf-viewer"]',
  );
  const win = document.documentElement;
  return {
    conversationScrolls: conv ? conv.scrollHeight > conv.clientHeight : false,
    conversationOverflowY: conv ? getComputedStyle(conv).overflowY : "missing",
    viewerScrolls: viewer ? viewer.scrollHeight > viewer.clientHeight : false,
    windowOverflow: win.scrollHeight - win.clientHeight,
  };
});

if (!scrollState.conversationScrolls) {
  failures.push("AC-37: conversation area did not become scrollable");
}
if (!scrollState.viewerScrolls) {
  failures.push("AC-37: PDF viewer content does not scroll internally");
}
if (scrollState.windowOverflow > 0) {
  failures.push(
    `AC-37: window scrolled (+${scrollState.windowOverflow}px) after flooding the conversation`,
  );
}

results.push({
  label: "AC-37 conversation scrolls internally",
  pass: scrollState.conversationScrolls,
  detail: `overflow-y:${scrollState.conversationOverflowY}`,
});
results.push({
  label: "AC-37 PDF viewer scrolls internally",
  pass: scrollState.viewerScrolls,
});
results.push({
  label: "AC-37 window stays unscrolled",
  pass: scrollState.windowOverflow <= 0,
  detail: `overflow=${scrollState.windowOverflow}px`,
});

// AC-38 — assess the traversal captured from a clean load above.
const distinctFocusTargets = new Set(
  tabsFromStart.filter((t) => t !== "(none)"),
);

// Traversal must genuinely span the shell, not loop inside one region: the top
// bar, the sidebar and the PDF viewers all have to be reachable by keyboard.
const groupOf = (label) => {
  if (label.includes("sidebar-toggle")) return "topbar";
  if (label.includes("reader-mode")) return "topbar";
  if (["设置", "搜索论文", "收起侧边栏", "展开侧边栏", "AI翻译"].some((k) => label.includes(k))) return "topbar";
  if (label.includes("quick-action")) return "sidebar";
  if (["对话记录", "向论文提问", "发送", "范围", "助手上下文范围"].some((k) => label.includes(k))) return "sidebar";
  // The scrollable page stack. Chromium makes a scroll container focusable, so
  // it appears in the tab order without an explicit tabindex.
  if (label.includes("pdf-viewer")) return "viewer";
  return "other";
};
const groups = new Set(tabsFromStart.map(groupOf));
const tabPass =
  distinctFocusTargets.size >= 8 &&
  groups.has("topbar") &&
  groups.has("sidebar") &&
  groups.has("viewer");

if (!tabPass) {
  failures.push(
    `AC-38: keyboard traversal insufficient — ${distinctFocusTargets.size} distinct stops, regions: ${[...groups].join(",")}`,
  );
}
results.push({
  label: "AC-38 keyboard traversal spans shell regions",
  pass: tabPass,
  detail: `${distinctFocusTargets.size} stops across ${[...groups].join("/")}`,
});

// AC-30 — hover and keyboard-focus must produce a visible state change.
const bgOf = (selector) =>
  a11yPage.evaluate(
    (sel) => getComputedStyle(document.querySelector(sel)).backgroundColor,
    selector,
  );

const quickSel = '[data-testid="quick-action-总结本页"]';
// Park the pointer away from any control first — the AC-37 clicking above left
// the cursor sitting on this very button, which would make "rest" read as hover.
await a11yPage.mouse.move(0, 0);
await a11yPage.waitForTimeout(200);
const restBg = await bgOf(quickSel);
await a11yPage.hover(quickSel);
await a11yPage.waitForTimeout(200);
const hoverBg = await bgOf(quickSel);
const hoverPass = restBg !== hoverBg;

if (!hoverPass) {
  failures.push(`AC-30: hover produced no visual change on quick action (${restBg})`);
}
results.push({
  label: "AC-30 hover changes visual state",
  pass: hoverPass,
  detail: `${restBg} -> ${hoverBg}`,
});

// The active reader-mode tab must be visually distinct from an inactive one.
const activeTabBg = await bgOf('[data-testid="reader-mode-bilingual"]');
const inactiveTabBg = await bgOf('[data-testid="reader-mode-original"]');
const activeTabPass = activeTabBg !== inactiveTabBg;
if (!activeTabPass) failures.push("AC-30: active reader-mode tab is not visually distinct");
results.push({
  label: "AC-30 active tab is visually distinct",
  pass: activeTabPass,
  detail: `active ${activeTabBg} vs inactive ${inactiveTabBg}`,
});

await a11yPage.close();
await browser.close();

// --- Report ------------------------------------------------------------------
console.log("\n=== Layout verification ===\n");
for (const r of results) {
  const mark = r.pass ? "PASS" : "FAIL";
  console.log(`[${mark}] ${r.label}${r.detail ? ` — ${r.detail}` : ""}`);
}

console.log(`\nScreenshots written to: ${outDir}`);
console.log(
  `  scroll-overflow measurements: ${JSON.stringify(
    results.filter((r) => r.hOverflow !== undefined),
  )}`,
);

if (failures.length) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nAll layout checks passed.");
