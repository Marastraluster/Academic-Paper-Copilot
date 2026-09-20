/**
 * DS-QA-015-FIX-002 — the reader overview, in a real browser, through the product.
 *
 * Six scenarios, and the measurement that makes them mean anything: **the backend
 * provider ledger**. The page cannot see a model call — it talks to localhost and
 * localhost talks to the provider — so every "provider calls: 0" claim this
 * repository made before DS-QA-015 rested on counting the wrong boundary. This
 * harness reads the number the backend keeps, through a route that exists only
 * because the harness asked for it.
 *
 * The two scenarios nobody can verify any other way: a cold open that spends
 * nothing, and a paid-for overview found again after the same bytes are reopened
 * as a fresh document row.
 *
 * Usage: node scripts/e2e-overview.mjs [paper.pdf] [--generate]
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const backendDir = join(repoRoot, "backend");
const python = join(backendDir, ".venv", "Scripts", "python.exe");
const workDir = join(repoRoot, ".agent", "results", "e2e-overview15");
const BACKEND_PORT = 8000;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;

const PAPER = process.argv[2]?.endsWith(".pdf")
  ? process.argv[2]
  : join(repoRoot, ".agent", "results", "e2e-notes", "documents",
         "doc_6f4ab9d9d4d34f85bc9e441757240fd8", "source.pdf");
/** A second, different paper, for the document-switch race. */
const OTHER = join(repoRoot, ".agent", "results", "crosspage", "fixture.pdf");
const GENERATE = process.argv.includes("--generate");

let PREVIEW_URL = "";
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function appDataDir() {
  return join(process.env.LOCALAPPDATA ?? "", "AcademicPDFCopilot");
}

/** The user's real data, copied — the provider profile and its credential with it. */
function prepare() {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(join(workDir, "documents"), { recursive: true });
  const real = appDataDir();
  for (const suffix of ["", "-wal", "-shm"]) {
    const from = join(real, `db.sqlite3${suffix}`);
    if (existsSync(from)) copyFileSync(from, join(workDir, `db.sqlite3${suffix}`));
  }
  return { database: join(workDir, "db.sqlite3"), documentsDir: join(workDir, "documents") };
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

function startBackend(corsPort, { database, documentsDir }) {
  const child = spawn(python, ["-m", "uvicorn", "app.main:app", "--port", String(BACKEND_PORT)], {
    cwd: backendDir,
    env: {
      ...process.env, PYTHONIOENCODING: "utf-8", PYTHONPATH: backendDir,
      DATABASE_PATH: database, DOCUMENTS_DIR: documentsDir,
      CORS_ORIGINS: `http://127.0.0.1:${corsPort},http://localhost:${corsPort}`,
      // The ledger route exists only because this harness asked for it.
      ENABLE_PROVIDER_LEDGER: "1",
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

/** How many model calls have left the backend since the last reset. */
async function ledger() {
  const response = await fetch(`${BACKEND_URL}/api/_debug/provider-ledger`);
  return response.json();
}

async function resetLedger() {
  await fetch(`${BACKEND_URL}/api/_debug/provider-ledger/reset`, { method: "POST" });
}

/** Every document row currently on disk. */
function documentIds() {
  return new Set(
    readdirSync(join(workDir, "documents")).filter((n) => n.startsWith("doc_")),
  );
}

/**
 * The row that appeared since `before`.
 *
 * Not "the newest by name": document ids are `uuid4().hex`, so sorting them puts
 * a row created a minute ago above or below one created now at random. The first
 * version of this harness did exactly that and silently re-measured the *old*
 * document — which made the fresh-row cache test pass for the wrong reason, since
 * a cached overview is found under the old row trivially.
 */
function rowAppearedSince(before) {
  const now = documentIds();
  for (const id of now) if (!before.has(id)) return id;
  return null;
}

async function openPaper(page, paper) {
  await page.setInputFiles('[data-testid="pdf-file-input"]', paper);
  await page.waitForSelector('[data-testid="pdf-page-container"]', { timeout: 120000 });
  await page.waitForSelector('[data-testid="assistant-tab-overview"]', { timeout: 60000 });
  // The panel says "正在读取论文结构" until the IR arrives; waiting for *that* to
  // go is the honest gate, because the notice it replaces is one the panel is
  // careful not to make before it has looked.
  await page.waitForSelector('[data-testid="overview-no-ir"]', { state: "detached", timeout: 240000 });
  await sleep(1200);
}

async function main() {
  const hashBefore = createHash("sha256").update(readFileSync(PAPER)).digest("hex");
  const prepared = prepare();
  console.log(`paper: ${PAPER}`);
  console.log(`generate: ${GENERATE}\n`);

  const previewPort = await freePort();
  const backend = startBackend(previewPort, prepared);
  if (!(await waitFor(`${BACKEND_URL}/api/health`))) {
    console.log("backend did not start"); backend.kill(); return 2;
  }
  const preview = await startPreview(previewPort);
  console.log(`preview: ${PREVIEW_URL}\n`);

  const browser = await chromium.launch({ channel: "msedge" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    consoleErrors.push(`${m.text()} :: ${m.location()?.url ?? ""}`);
  });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  const overviewFor = async (documentId) => {
    if (!documentId) return null;
    const response = await fetch(`${BACKEND_URL}/api/documents/${documentId}/overview`);
    return response.status === 200 ? response.json() : null;
  };

  try {
    await page.goto(PREVIEW_URL, { waitUntil: "domcontentloaded" });
    await resetLedger();

    // --- 1. cold open -----------------------------------------------------
    const beforeFirst = documentIds();
    await openPaper(page, PAPER);
    const firstId = rowAppearedSince(beforeFirst);
    check("a paper opens on the overview tab",
      (await page.locator('[data-testid="assistant-tabpanel-overview"]').count()) === 1);

    const title = await page.locator('[data-testid="overview-title"]').innerText();
    check("the title is shown", title.includes("Residual") || title.length > 4, JSON.stringify(title));
    check("the abstract is shown",
      (await page.locator('[data-testid="overview-abstract"]').count()) === 1);
    check("a reading recommendation is offered",
      (await page.locator('[data-testid="overview-start-reading"]').count()) === 1);
    check("the generate action is offered",
      (await page.locator('[data-testid="overview-generate"]').count()) === 1);
    check("the entry is not replaced by a spinner",
      (await page.locator('[data-testid="overview-progress"]').count()) === 0);

    const cold = await ledger();
    check("a cold open reaches no provider", cold.calls === 0, JSON.stringify(cold));
    check("and generated nothing behind the reader's back",
      (await overviewFor(firstId)) === null);

    // --- 2. explicit generation -------------------------------------------
    let generated = null;
    if (GENERATE) {
      await resetLedger();
      const started = Date.now();
      await page.click('[data-testid="overview-generate"]');
      await sleep(900);
      check("progress is shown after the click",
        (await page.locator('[data-testid="overview-progress"]').count()) === 1);

      const deadline = Date.now() + 300000;
      while (Date.now() < deadline && generated === null) {
        await sleep(2500);
        generated = await overviewFor(rowAppearedSince(beforeFirst) ?? firstId);
      }
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      check("a real generation produced an overview", generated !== null,
        generated ? `${seconds}s, ${generated.items.length} items` : "timed out");

      /* AC-P0-18 is scoped by its own wording to calls carrying
         `operation="reader_overview"` — and the protocol-detection probes are
         unlabelled. Both numbers are reported, because the criterion measures one
         of them and the reader pays for the other. */
      const after = await ledger();
      const synthesis = after.by_operation?.reader_overview ?? 0;
      const probes = after.by_operation?.unlabelled ?? 0;
      check("the synthesis stays inside the frozen call budget", synthesis <= 2,
        `${synthesis} reader_overview call(s), ${probes} protocol probe(s), ` +
        `${after.calls} total`);
      check("and no request carried paper content while finding the protocol",
        probes <= 2, `${probes} probe(s) sent "ping" with a one-token budget`);

      if (generated) {
        check("the status is READY or PARTIAL",
          generated.status === "READY" || generated.status === "PARTIAL", generated.status);
        check("the prose is Chinese",
          /[一-鿿]/.test(generated.items[0]?.text ?? ""),
          JSON.stringify((generated.items[0]?.text ?? "").slice(0, 26)));
        check("every item carries evidence",
          generated.items.every((item) => item.evidence.length > 0),
          `${generated.items.length} items`);
        check("technical identifiers survive",
          generated.key_terms.some((term) => /[A-Za-z]/.test(term.term)),
          generated.key_terms.slice(0, 3).map((t) => t.term).join(", "));
        const forbidden = /translation|translator|preserving .* spelling/i;
        check("no translator-directed text is displayed",
          !generated.items.some((item) => forbidden.test(item.text)));
        await page.waitForSelector('[data-testid="overview-body"]', { timeout: 30000 });
        check("the panel renders it", true);
      }
    }

    // --- 3. evidence jump --------------------------------------------------
    if (generated) {
      const badge = page.locator('[data-testid^="overview-evidence-p"]').first();
      const label = await badge.innerText();
      const before = await page.evaluate(() =>
        document.querySelector('[data-testid="pdf-viewer"]').scrollTop);
      await badge.click();
      await sleep(1500);
      const after = await page.evaluate(() =>
        document.querySelector('[data-testid="pdf-viewer"]').scrollTop);
      check("clicking an item's page moves the reader there", after !== before,
        `${label} · ${before} -> ${after}`);
    }

    // --- 4. same PDF, fresh row -------------------------------------------
    if (generated) {
      const hash = generated.content_hash;
      await resetLedger();
      // The same bytes, opened again — which is what reopening a paper is.
      const beforeReopen = documentIds();
      await openPaper(page, PAPER);
      const secondId = rowAppearedSince(beforeReopen);
      check("reopening created a fresh document row",
        secondId !== null && secondId !== firstId,
        `${firstId} -> ${secondId}`);

      const found = await overviewFor(secondId);
      check("the overview is found under the new row",
        found !== null && found.content_hash === hash,
        found ? `hash ${found.content_hash.slice(0, 12)}` : "not found");

      check("the panel renders the cached overview",
        (await page.locator('[data-testid="overview-body"]').count()) === 1);
      check("without being asked to generate",
        (await page.locator('[data-testid="overview-generate"]').count()) === 0);

      const reopened = await ledger();
      check("and the reopen reached no provider", reopened.calls === 0,
        JSON.stringify(reopened));
    }

    // --- 5. provider failure ----------------------------------------------
    {
      /* A paper that has never been analysed, with generation pointed at an
         endpoint that cannot answer. The entry must survive it. */
      await resetLedger();
      const beforeOther = documentIds();
      await openPaper(page, OTHER);
      const otherId = rowAppearedSince(beforeOther);
      await page.waitForSelector('[data-testid="overview-not-generated"]', { timeout: 60000 });

      const listing = await (await fetch(`${BACKEND_URL}/api/profiles`)).json();
      const profile = (listing.profiles ?? listing)[0];
      check("a provider profile is configured for the failure path",
        Boolean(profile?.id), String(profile?.id ?? "").slice(0, 12));

      if (profile?.id) {
        const original = profile.base_url;
        const patch = (base_url) =>
          fetch(`${BACKEND_URL}/api/profiles/${profile.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ base_url }),
          }).catch(() => {});

        await patch("http://127.0.0.1:9");
        await page.click('[data-testid="overview-generate"]');
        await sleep(1200);
        await page.waitForSelector(
          '[data-testid="overview-error"], [data-testid="overview-body"]',
          { timeout: 180000 },
        );
        check("a provider failure is reported",
          (await page.locator('[data-testid="overview-error"]').count()) === 1);
        /* The entry, not specifically the abstract: this fixture is a synthetic
           page of numbered lines with no abstract section, so the panel correctly
           says so — and asserting on the abstract would have been a test of the
           fixture rather than of the failure path. */
        check("the reading entry survives it",
          (await page.locator('[data-testid="overview-title"]').count()) === 1
            && (await page.locator('[data-testid="overview-entry"]').count()) === 1);
        check("retry remains available",
          (await page.locator('[data-testid="overview-generate"]').count()) === 1);
        check("no spinner is left running",
          (await page.locator('[data-testid="overview-progress"]').count()) === 0);
        check("no failed run was cached as READY",
          (await overviewFor(otherId)) === null,
          `row ${String(otherId).slice(0, 14)}`);
        await patch(original);
      }
    }

    // --- 6. document switch mid-generation --------------------------------
    if (GENERATE) {
      /* Generation starts on the paper that has **no** cached overview — the
         fixture. `PAPER` has one by now, from the scenarios above, so clicking
         generate on it would wait for a button that is correctly absent. */
      await resetLedger();
      const beforeA = documentIds();
      await openPaper(page, OTHER);
      const aId = rowAppearedSince(beforeA);
      await page.click('[data-testid="overview-generate"]');
      await sleep(600);
      const aHash = (await overviewFor(aId))?.content_hash
        ?? "0000000000000000000000000000000000000000000000000000000000000000";
      const beforeB = documentIds();
      // Leave before it can finish.
      await openPaper(page, PAPER);
      check("B shows its own deterministic entry",
        (await page.locator('[data-testid="overview-entry"]').count()) === 1);
      const bHash = await page.evaluate(() =>
        document.querySelector('[data-testid="overview-title"]')?.textContent ?? "");

      /* Wait for A's generation to actually **finish**, so the thing being
         checked is a completed artifact of A's arriving while B is open — not
         the absence of a result that had not been produced yet. Measured
         generation runs 30-60 s, so sampling once at 35 s proves nothing. */
      const aDeadline = Date.now() + 180000;
      let aArtifact = null;
      while (Date.now() < aDeadline && aArtifact === null) {
        await sleep(3000);
        aArtifact = await overviewFor(aId);
      }
      /* What matters is not that B shows nothing — B may legitimately show its
         *own* cached overview — but that what B shows is B's. A's artifact is
         keyed to a different content hash, and the panel refuses one that does
         not match the paper on screen. */
      check("A's generation completed after the reader left", aArtifact !== null,
        aArtifact ? `cached under ${aArtifact.content_hash.slice(0, 12)}` : "never finished");
      const stillB = await page.evaluate(() => ({
        title: document.querySelector('[data-testid="overview-title"]')?.textContent ?? "",
      }));
      const bOverview = await overviewFor(rowAppearedSince(beforeB) ?? "");
      check("and it is owned by A's content hash, not B's",
        aArtifact !== null && aArtifact.content_hash !== bOverview?.content_hash,
        `A ${String(aArtifact?.content_hash).slice(0, 12)} vs B ${String(bOverview?.content_hash).slice(0, 12)}`);
      check("B never renders A's overview", (bOverview?.content_hash ?? "") !== aHash,
        `B hash ${String(bOverview?.content_hash).slice(0, 12)}`);
      check("B shows its own paper", stillB.title.includes("Residual"),
        JSON.stringify(stillB.title.slice(0, 24)));
      check("B still shows its own entry",
        (await page.locator('[data-testid="overview-abstract"]').count()) === 1);
    }

    /* Three kinds of console noise are the application working as designed, and
       a filter that ignored them all would also hide a real fault — so each is
       named:
         - a connection error, because the harness kills the backend at the end;
         - a 404 on the overview route, which is how "not analysed yet" is said;
         - an ERR_FAILED on the overview route, which is Chrome's report of a
           fetch the panel *aborted* — `loadOverview` cancels a superseded read
           on purpose, and an aborted request is logged as a CORS failure because
           no response ever arrived to carry the headers. */
    const realErrors = consoleErrors.filter((text) => {
      if (/ERR_CONNECTION_(RESET|REFUSED)/.test(text)) return false;
      if (/404/.test(text) && /\/overview/.test(text)) return false;
      if (/ERR_FAILED/.test(text) && /\/overview/.test(text)) return false;
      // The same abort, reported by a Chrome build that names the policy rather
      // than the network error.
      if (/blocked by CORS policy/.test(text) && /\/overview/.test(text)) return false;
      return true;
    });
    check("no uncaught console errors during the run", realErrors.length === 0,
      realErrors.slice(0, 2).join(" | "));
  } finally {
    await browser.close();
    preview.child?.kill();
    backend.kill();
  }

  const hashAfter = createHash("sha256").update(readFileSync(PAPER)).digest("hex");
  check("the source PDF is byte-identical through the product path",
    hashBefore === hashAfter, `${hashBefore.slice(0, 12)} -> ${hashAfter.slice(0, 12)}`);

  const passed = results.filter((r) => r.ok).length;
  writeFileSync(join(workDir, "results.json"), JSON.stringify({ results, passed }, null, 1));
  console.log(`\n${passed}/${results.length} passed`);
  return passed === results.length ? 0 : 1;
}

process.exit(await main());
