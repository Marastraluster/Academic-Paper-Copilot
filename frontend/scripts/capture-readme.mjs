/**
 * The screenshots the README shows, captured from the running application.
 *
 * This is not DS-FE-001's evidence script. `capture.mjs` measures the shell and
 * exits non-zero on a layout regression; it drives a fixture PDF and a mode
 * (`reader-mode-bilingual`) that no longer exists. This script's only job is to
 * produce honest pictures of the current build for `docs/screenshots/`, so it
 * takes no position on layout and fails soft: a shot that could not be taken is
 * reported and skipped rather than passed off as evidence.
 *
 * Requirements, all of them:
 *   - the backend on :8000 with a working model service (the Copilot shot asks a
 *     real question, and the reading shot runs a real translation job)
 *   - `npm run dev` on :5173
 *
 * Private-paper policy: the capture never touches the reader's own library. It
 * downloads a copy of a *public* paper already in the library (resnet.pdf), loads
 * that copy, and deletes it again on the way out — including the partial
 * translation, which lives under the copy's own document directory.
 *
 *   node scripts/capture-readme.mjs            # capture, then clean up
 *   KEEP_SCRATCH=1 node scripts/capture-readme.mjs   # leave the copy in place
 */
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(here, "../../docs/screenshots");
const BASE_URL = process.env.PREVIEW_URL ?? "http://127.0.0.1:5173";
const API_URL = process.env.API_URL ?? "http://127.0.0.1:8000";
const SOURCE_NAME = process.env.CAPTURE_SOURCE ?? "resnet.pdf";
const KEEP = process.env.KEEP_SCRATCH === "1";

/** 1440x900 is the size the reading layout is designed for; 1.5x keeps the
 *  smallest label legible after GitHub scales the column down. */
const VIEWPORT = { width: 1440, height: 900 };
const DEVICE_SCALE_FACTOR = 1.5;

const QUESTION = "这段话在说什么？";

mkdirSync(OUT_DIR, { recursive: true });

const taken = [];
const skipped = [];
const consoleErrors = [];

const api = async (path, init) => {
  const response = await fetch(`${API_URL}${path}`, init);
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} -> ${response.status}`);
  }
  return response;
};

const listDocuments = async () => (await api("/api/documents")).json();

async function stageScratchCopy() {
  const documents = await listDocuments();
  const source = documents.find((item) => item.name === SOURCE_NAME);
  if (!source) throw new Error(`no document named ${SOURCE_NAME} in the library`);

  const bytes = new Uint8Array(
    await (await api(`/api/documents/${source.document_id}/file`)).arrayBuffer(),
  );
  const dir = resolve(tmpdir(), "academic-pdf-copilot-shots");
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, SOURCE_NAME);
  writeFileSync(path, bytes);

  return { path, knownIds: new Set(documents.map((item) => item.document_id)), source };
}

/** The upload is the application's own path (a File, not a filesystem path), so
 *  the new document is found by diffing the library rather than by reading a
 *  response body out of the page. */
async function awaitUploadedDocument(knownIds, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const documents = await listDocuments();
    const fresh = documents.find((item) => !knownIds.has(item.document_id));
    if (fresh) return fresh;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("the uploaded copy never appeared in the library");
}

const shot = async (page, name, why) => {
  const path = resolve(OUT_DIR, name);
  await page.screenshot({ path });
  const { size } = statSync(path);
  taken.push({ name, size, why });
  console.log(`  ok    ${name}  ${(size / 1024).toFixed(0)} kB  — ${why}`);
};

const skip = (name, why) => {
  skipped.push({ name, why });
  console.log(`  SKIP  ${name}  — ${why}`);
};

/** A reader's selection, produced the way a reader produces it: a real drag over
 *  the text layer. A programmatic Range would show the same highlight while
 *  proving nothing about the interaction the screenshot is meant to depict. */
/** Put a paragraph's first line where a reader would have it, and report where.
 *  Taken from `e2e-selection.mjs`, where the arithmetic was paid for: at fit-width
 *  a page is taller than the viewport, so a paragraph that is merely on screen has
 *  its first line off-screen and the drag lands on clamped coordinates. */
async function positionParagraph(page, paragraph) {
  return page.evaluate(
    ({ boxes, page_number }) => {
      const viewer = document.querySelector('[data-testid="pdf-viewer"]');
      const container = document.querySelector(
        `[data-testid="pdf-page-container"][data-page-number="${page_number}"]`,
      );
      if (!viewer || !container) return null;
      const scale = Number(container.dataset.pageScale ?? "0");
      if (!(scale > 0)) return null;

      const [x0, y0] = boxes[0];
      const pageTop = container.getBoundingClientRect().top;
      const want = viewer.getBoundingClientRect().top + viewer.clientHeight * 0.3;
      viewer.scrollTop += pageTop + y0 * scale - want;

      const rect = container.getBoundingClientRect();
      return {
        left: rect.left + x0 * scale,
        top: rect.top + y0 * scale,
        right: rect.left + boxes[0][2] * scale,
        bottom: rect.top + boxes[0][3] * scale,
      };
    },
    { boxes: paragraph.bboxes, page_number: paragraph.page_number },
  );
}

async function dragSelectText(page, ir, { pageNumber = 3, index = 0 } = {}) {
  const candidates = (ir.paragraphs ?? []).filter(
    (item) =>
      item.page_number === pageNumber &&
      (item.bboxes ?? []).length > 0 &&
      (item.text ?? "").trim().length >= 120 &&
      item.bboxes[0][2] - item.bboxes[0][0] >= 120,
  );
  const paragraph = candidates[index];
  if (!paragraph) return null;

  await positionParagraph(page, paragraph);
  await page.waitForTimeout(350);
  const spot = await positionParagraph(page, paragraph);
  if (!spot) return null;

  // Stop inside the line's text rather than at the column edge: a point past the
  // last character resolves to the next line's start, and the drag then selects
  // the following paragraph too.
  const y = spot.top + 6;
  const inset = (spot.right - spot.left) * 0.12;
  const startX = spot.left + inset;
  const endX = spot.right - inset;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move((startX + endX) / 2, y, { steps: 8 });
  await page.mouse.move(endX, y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(500);

  const state = await page.evaluate(() => {
    const option = [...document.querySelectorAll('[data-testid="scope-selector"] option')].find(
      (candidate) => candidate.textContent?.startsWith("选中内容"),
    );
    return {
      preview: document.querySelector('[data-testid="selection-preview"]')?.textContent ?? null,
      disabled: option?.disabled ?? true,
    };
  });
  return {
    paragraph,
    spot,
    ...state,
    mapped: !state.disabled && /已选/.test(state.preview ?? ""),
  };
}

/** The IR is what the mapper itself uses, so the drag is aimed with the document's
 *  own geometry rather than with a second guess at it. */
async function loadIr(documentId, timeoutMs = 180000) {
  const started = Date.now();
  for (;;) {
    const response = await fetch(`${API_URL}/api/documents/${documentId}/ir`);
    if (response.ok) {
      const ir = await response.json();
      if ((ir.paragraphs ?? []).length) return ir;
    }
    if (Date.now() - started > timeoutMs) throw new Error("the IR never reported paragraphs");
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

const browser = await chromium.launch({ channel: "msedge" });
const context = await browser.newContext({
  viewport: VIEWPORT,
  deviceScaleFactor: DEVICE_SCALE_FACTOR,
  locale: "zh-CN",
});
const page = await context.newPage();
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
page.on("response", (response) => {
  if (response.status() >= 400) {
    // The method is part of the finding: a 404 on a DELETE of something already
    // gone is a cleanup artifact, while a 404 on a GET is a missing resource.
    consoleErrors.push(
      `HTTP ${response.status()} ${response.request().method()} ${response.url()}`,
    );
  }
});

let scratch = null;
let documentId = null;
let noteId = null;
let jobRunning = false;

try {
  scratch = await stageScratchCopy();
  console.log(
    `source: ${scratch.path} (a copy of the library's ${SOURCE_NAME}, ${scratch.source.page_count} pages)`,
  );

  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="reader-workspace"]', { timeout: 30000 });

  // --- load the copy ---------------------------------------------------------
  await page.setInputFiles('[data-testid="pdf-file-input"]', scratch.path);
  const uploaded = await awaitUploadedDocument(scratch.knownIds);
  documentId = uploaded.document_id;
  await page.waitForSelector('[data-testid="pdf-page-container"]', { timeout: 120000 });
  await page.waitForTimeout(1500);
  console.log(`loaded ${documentId} (${uploaded.name}, ${uploaded.page_count} pages)`);

  // The IR is what the outline, the overview and selection mapping are built
  // from, and it is computed after the first paint. Wait for it once, for all
  // the shots that need it.
  try {
    await page.waitForSelector('[data-testid="overview-no-ir"]', {
      state: "detached",
      timeout: 180000,
    });
  } catch {
    console.log("  note  the IR did not report ready within 180s; capturing anyway");
  }

  const ir = await loadIr(documentId);

  // Selection lives in 原文 mode: the 逐段 view renders the reflow sheet, which
  // has no PDF text layer to drag across.
  await page.click('[data-testid="reader-mode-original"]');
  await page.waitForSelector('[data-testid="pdf-text-layer"]', { timeout: 30000 });
  await page.waitForTimeout(800);
  console.log(`the IR offers ${ir.paragraphs.length} paragraphs to select from`);

  // --- Copilot: a selection, a question, a grounded answer -------------------
  try {
    const selection = await dragSelectText(page, ir);
    if (!selection?.mapped) {
      skip("copilot.png", "a drag over the text layer mapped to no paragraph");
    } else {
      await page.selectOption('[data-testid="scope-selector"]', "selection");
      await page.fill('[data-testid="qa-composer"]', QUESTION);
      await page.click('[data-testid="composer-send"]');
      await page.waitForSelector('[data-testid="qa-answer-body"]', { timeout: 180000 });
      await page.waitForTimeout(1200);
      if (await page.locator('[data-testid="reference-list"]').count()) {
        await shot(page, "copilot.png", `selection → "${QUESTION}" with page citations`);
      } else {
        skip("copilot.png", "the answer came back with no citation list to show");
      }
    }
  } catch (error) {
    skip("copilot.png", `the question did not answer: ${error.message}`);
  }

  // --- notes: one real note, removed again below -----------------------------
  try {
    await page.click('[data-testid="assistant-tab-notes"]');
    await page.waitForSelector('[data-testid="notes-panel"], [data-testid="notes-empty-state"]', {
      timeout: 30000,
    });
    const noteSelection = await dragSelectText(page, ir, { index: 1 });
    if (!noteSelection?.mapped) {
      skip("notes.png", "a second drag mapped to no paragraph");
    } else {
      await page.click('[data-testid="notes-create-highlight"]');
      await page.waitForTimeout(600);
      await page.click('[data-testid="notes-create-note"]');
      await page.waitForTimeout(800);
      noteId = await page.evaluate(() => {
        const button = document.querySelector('[data-testid^="note-edit-"]');
        return button ? button.getAttribute("data-testid").replace("note-edit-", "") : null;
      });
      if (!noteId) {
        skip("notes.png", "the note card never offered an edit control");
      } else {
        await page.click(`[data-testid="note-edit-${noteId}"]`);
        await page.fill(
          `[data-testid="note-input-${noteId}"]`,
          "The residual connection is the whole argument: adding the identity keeps the gradient path short.",
        );
        await page.click(`[data-testid="note-save-${noteId}"]`);
        await page.waitForTimeout(600);
        await shot(page, "notes.png", "a highlight and the note attached to it");
      }
    }
  } catch (error) {
    skip("notes.png", `the note flow failed: ${error.message}`);
  }

  // --- reader: the paragraph reading, the outline beside it -------------------
  try {
    await page.click('[data-testid="assistant-tab-outline"]');
    await page.waitForSelector('[data-testid="outline-panel"], [data-testid="outline-no-structure"]', {
      timeout: 30000,
    });
    await page.click('[data-testid="reader-mode-immersive"]');
    await page.waitForSelector('[data-testid="reflow-reader"]', { timeout: 30000 });
    await page.waitForTimeout(900);
    if (await page.locator('[data-testid="outline-panel"]').count()) {
      await shot(
        page,
        "reader.png",
        "逐段 reading, the table of contents beside it, and the Copilot column",
      );
    } else {
      skip("reader.png", "the outline reported no structure to show");
    }
  } catch (error) {
    skip("reader.png", `the reading did not settle: ${error.message}`);
  }

  // --- translation: a real job, or the cache that makes one unnecessary -------
  try {
    await page.click('[data-testid="reader-mode-immersive"]');
    await page.waitForSelector('[data-testid="reflow-reader"]', { timeout: 30000 });
    // The reading's chrome hides itself on a downward scroll, and a hidden
    // toolbar has `pointer-events: none`: put the column back at the top before
    // touching anything in it.
    await page.evaluate(() => {
      const column = document.querySelector('[data-testid="reflow-scroll"]');
      if (column) column.scrollTop = 0;
    });
    await page.waitForTimeout(600);
    // The reading settles into one of four states — still loading, nothing yet
    // (生成逐段对照), resumable (继续翻译剩余段落), or already translated — and the
    // content-addressed cache means the same paper copied under a new id can land
    // in any of them. Wait for it to settle before deciding which one it is.
    await page.waitForSelector(
      '[data-testid="bilingual-generate-btn"], [data-testid="bilingual-resume"], [data-testid="bilingual-counts"]',
      { timeout: 120000 },
    );
    const start = page.locator('[data-testid="bilingual-generate-btn"]');
    const resume = page.locator('[data-testid="bilingual-resume"]');
    let started = false;
    if (await start.count()) {
      await start.click();
      started = true;
    } else if (await resume.count()) {
      await resume.click();
      started = true;
    } else {
      console.log("  note  the reading already carries its translation");
    }
    jobRunning = started;
    // Wait for translated paragraphs rather than for the job: the point of the
    // screenshot is the reading, and the job is deliberately resumable.
    await page.waitForSelector('[data-testid="reflow-translation"]', { timeout: 300000 });
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="reflow-translation"]').length >= 6,
      undefined,
      { timeout: 300000 },
    );
    await page.waitForTimeout(800);
    await shot(
      page,
      "translation.png",
      started ? "逐段 translation, typeset, in progress" : "逐段 reading, translated",
    );

    const glossary = page.locator('[data-testid="glossary-toggle"]');
    if (await glossary.count()) {
      await glossary.click();
      await page.waitForTimeout(800);
      const rows = await page.locator('[data-testid="glossary-row"]').count();
      if (rows > 0) {
        await shot(page, "glossary.png", `the paper's glossary, ${rows} terms`);
      } else {
        skip("glossary.png", "the glossary panel was empty");
      }
      await glossary.click();
      await page.waitForTimeout(400);
    } else {
      skip("glossary.png", "no glossary control was offered");
    }

    const stop = page.locator('[data-testid="bilingual-stop"]');
    if (await stop.count()) {
      await stop.click();
      await page.waitForTimeout(800);
    }
    jobRunning = false;
  } catch (error) {
    skip("translation.png", `the translation job produced nothing to show: ${error.message}`);
  }

  // --- outline, then settings, then the library -------------------------------
  try {
    await page.click('[data-testid="reader-mode-original"]');
    await page.click('[data-testid="assistant-tab-outline"]');
    await page.waitForSelector('[data-testid="pdf-page-container"]', { timeout: 30000 });
    await page.waitForTimeout(1200);
    await shot(page, "outline.png", "the table of contents, following the reading");
  } catch (error) {
    skip("outline.png", error.message);
  }

  try {
    await page.click('[data-testid="settings-open"]');
    await page.waitForSelector('[data-testid="settings-dialog"]', { timeout: 30000 });
    await page.waitForTimeout(1000);
    await shot(page, "settings.png", "model services, a document parser, and a model per task");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
  } catch (error) {
    skip("settings.png", error.message);
  }

  try {
    await page.click('[data-testid="library-open"]');
    await page.waitForSelector('[data-testid="library-dialog"]', { timeout: 30000 });
    // Filtered on purpose: the dialog in the README shows the search, not the
    // reader's whole reading list.
    await page.fill('[data-testid="library-search-input"]', "resnet");
    await page.waitForTimeout(800);
    await shot(page, "library.png", "the library, with its search");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
  } catch (error) {
    skip("library.png", error.message);
  }
} finally {
  // --- leave nothing behind --------------------------------------------------
  try {
    if (noteId && documentId) {
      const note = page.locator(`[data-testid="note-delete-${noteId}"]`);
      if (await note.count()) {
        await note.click();
        await page.waitForTimeout(500);
      }
    }
  } catch (error) {
    console.log(`  note  the note could not be removed: ${error.message}`);
  }

  try {
    if (jobRunning && documentId) {
      const stop = page.locator('[data-testid="bilingual-stop"]');
      if (await stop.count()) await stop.click();
    }
  } catch {
    /* the document is deleted below regardless */
  }

  if (documentId && !KEEP) {
    try {
      // The browser may still hold the document open; cancel the short-lived
      // translation task and close the reader first is not required — the API
      // deletes the directory, and the running job writes into it.
      await api(`/api/documents/${documentId}`, { method: "DELETE" });
      console.log(`removed the scratch document ${documentId}`);
    } catch (error) {
      console.log(`  note  the scratch document could not be removed: ${error.message}`);
    }
  } else if (documentId) {
    console.log(`left the scratch document ${documentId} in place (KEEP_SCRATCH=1)`);
  }

  await browser.close();
}

console.log("\n=== capture ===");
for (const item of taken) console.log(`  ${item.name}  ${(item.size / 1024).toFixed(0)} kB`);
if (skipped.length) {
  console.log("\nnot taken:");
  for (const item of skipped) console.log(`  ${item.name}  — ${item.why}`);
}
if (consoleErrors.length) {
  console.log("\nconsole errors seen while capturing:");
  for (const line of [...new Set(consoleErrors)].slice(0, 20)) console.log(`  ${line}`);
}
console.log(`\nwritten to ${OUT_DIR}`);
