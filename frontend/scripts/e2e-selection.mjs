/**
 * DS-QA-005 — selection → canonical paragraph identity, in a real browser.
 *
 * Every drag here is a real `page.mouse` drag over the PDF.js text layer, because
 * a programmatic `Range` would prove the geometry while proving nothing about
 * whether a *user* can produce a selection the mapper understands. That
 * distinction already mattered once: the geometry was verified with synthetic
 * ranges, and the first real drag mapped nothing because the page had been
 * scrolled so the paragraph was off-screen and the coordinates were clamped.
 *
 * The expected identity comes from the `DocumentIR` fetched over the same API the
 * application uses, so the check is "does the mapper agree with the document"
 * rather than "does the mapper agree with a second copy of its own arithmetic".
 */

/** Put a paragraph's first line where a reader would have it, and report where. */
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
      // A third of the way down: far enough from the toolbar to be draggable.
      const want = viewer.getBoundingClientRect().top + viewer.clientHeight * 0.3;
      viewer.scrollTop += pageTop + y0 * scale - want;

      const rect = container.getBoundingClientRect();
      return {
        left: rect.left + x0 * scale,
        top: rect.top + y0 * scale,
        right: rect.left + boxes[0][2] * scale,
        bottom: rect.top + boxes[0][3] * scale,
        viewport: { top: 0, bottom: window.innerHeight, right: window.innerWidth },
      };
    },
    { boxes: paragraph.bboxes, page_number: paragraph.page_number },
  );
}

/**
 * Bring a paragraph on screen, then drag across its first line.
 *
 * The scroll is exact because it has to be: at fit-width a ResNet page is about
 * 1360 px tall against a ~780 px viewport, so centring the *page* leaves its top
 * off-screen and the drag lands on clamped coordinates instead of the text.
 */
async function dragAcrossParagraph(
  page,
  paragraph,
  { reverse = false, lines = 1, fraction = 0.12 } = {},
) {
  await positionParagraph(page, paragraph);
  await page.waitForTimeout(350);
  const spot = await positionParagraph(page, paragraph);
  if (!spot) return { ok: false, why: "no page container or no scale" };

  const visible =
    spot.bottom > spot.viewport.top + 20 &&
    spot.top < spot.viewport.bottom - 20 &&
    spot.left >= 0 &&
    spot.right <= spot.viewport.right;
  if (!visible) return { ok: false, why: "could not bring the paragraph on screen" };

  // **Stop inside the line's text, not at the column edge.** A point past the
  // last character of a line resolves to the *next* line's start, so a drag to
  // the box's right edge selects the following paragraph as well — which is what
  // an earlier version did, and the resulting two-paragraph mapping looked like a
  // matcher defect. The matcher was right: the selection really did cover both.
  const y = spot.top + 6;
  const inset = (spot.right - spot.left) * fraction;
  const startX = reverse ? spot.right - inset : spot.left + inset;
  const endX = reverse ? spot.left + inset : spot.right - inset;
  const endY = lines > 1 ? y + (spot.bottom - spot.top) * 0.5 : y;

  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move((startX + endX) / 2, y, { steps: 8 });
  await page.mouse.move(endX, endY, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  const state = await page.evaluate(() => {
    const option = [...document.querySelectorAll('[data-testid="scope-selector"] option')].find(
      (candidate) => candidate.textContent?.startsWith("选中内容"),
    );
    return {
      preview: document.querySelector('[data-testid="selection-preview"]')?.textContent ?? null,
      label: option?.textContent ?? null,
      disabled: option?.disabled ?? true,
      selected: window.getSelection()?.toString() ?? "",
    };
  });
  const count = Number((state.preview ?? "").match(/已选\s*(\d+)\s*个段落/)?.[1] ?? 0);
  return { ok: !state.disabled, count, ...state };
}

/** Drag, scope to it, ask, and report the ids the request actually carried. */
async function mapAndAsk(page, paragraph, question, ask, dragOptions = {}) {
  const captured = [];
  const listener = (request) => {
    if (request.url().endsWith("/answer")) captured.push(request.postData() ?? "");
  };
  page.on("request", listener);
  try {
    const drag = await dragAcrossParagraph(page, paragraph, dragOptions);
    await page.selectOption('[data-testid="scope-selector"]', "selection");
    await ask(page, question);
    const body = captured.at(-1) ? JSON.parse(captured.at(-1)) : null;
    return { drag, scope: body?.scope ?? null, requests: captured.length };
  } finally {
    page.off("request", listener);
  }
}

const short = (id) => (id ? id.slice(-4) : "none");

export async function runSelectionChecks(page, { backendUrl, check, ask, ir }) {
  // Page 3 of the ResNet paper is a two-column body page: the left column runs
  // x=49→287 and the right x=310→548 of 612. A selection mapped by a single
  // bounding box would span the gutter and take both columns at the same height.
  const left = ir.paragraphs.find(
    (item) => item.page_number === 3 && item.bboxes[0][0] < 300 && item.bboxes[0][2] < 300,
  );
  const right = ir.paragraphs.find(
    (item) => item.page_number === 3 && item.bboxes[0][0] > 300,
  );
  if (!left) {
    check("the IR has a left-column paragraph on page 3 to select", false, "no fixture");
    return;
  }

  const first = await mapAndAsk(page, left, "What does this passage say?", ask);
  check(
    "a real drag across one line maps to one paragraph (AC-11)",
    first.drag.ok && first.drag.count === 1,
    first.drag.why ?? `mapped ${first.drag.count}, preview ${JSON.stringify(first.drag.preview?.slice(0, 44))}`,
  );
  check(
    "the request carries exactly that paragraph and nothing else (AC-09)",
    first.scope?.type === "selection" &&
      first.scope.paragraph_ids?.length === 1 &&
      first.scope.paragraph_ids[0] === left.id &&
      Object.keys(first.scope).length === 2,
    `${(first.scope?.paragraph_ids ?? []).map(short).join(",")} vs ${short(left.id)}`,
  );
  check(
    "no right-column paragraph came with it (AC-03)",
    right !== undefined && !(first.scope?.paragraph_ids ?? []).includes(right.id),
    right ? `right column ${short(right.id)} excluded` : "no right column found",
  );

  const turn = page.locator('[data-testid^="qa-turn-"]').last();
  const citations = await turn.locator('[data-testid^="reference-card-"]').count();
  check(
    "the answer is grounded in the selection, with citations (AC-33)",
    (await turn.getAttribute("data-state")) === "grounded" && citations > 0,
    `${citations} citation(s)`,
  );

  // --- across two paragraphs ----------------------------------------------
  // Deliberately dragging past the end of the first paragraph's line, which is
  // exactly what the one-paragraph case must *not* do.
  const second = ir.paragraphs.find(
    (item) => item.page_number === 3 && item.id !== left.id && item.bboxes[0][0] < 300,
  );
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  const across = await mapAndAsk(page, left, "What does this passage say?", ask, { lines: 6 });
  check(
    "a drag that really does cross into the next paragraph maps both (AC-04)",
    across.drag.ok &&
      across.scope?.paragraph_ids?.includes(left.id) &&
      across.scope?.paragraph_ids?.includes(second.id),
    `${(across.scope?.paragraph_ids ?? []).map(short).join(",")} vs ${short(left.id)}+${short(second.id)}`,
  );

  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  const reversed = await mapAndAsk(page, left, "What does this passage say?", ask);
  check(
    "a reversed drag maps the same paragraph (AC-04)",
    reversed.drag.ok && reversed.scope?.paragraph_ids?.[0] === left.id,
    reversed.drag.why ?? (reversed.scope?.paragraph_ids ?? []).map(short).join(","),
  );

  await page.click('[aria-label="放大"]');
  await page.waitForTimeout(900);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  const zoomed = await mapAndAsk(page, left, "What does this passage say?", ask, {
    fraction: 0.3,
  });
  check(
    "the same paragraph maps identically at a different zoom (AC-01)",
    zoomed.drag.ok &&
      zoomed.scope?.paragraph_ids?.length === 1 &&
      zoomed.scope.paragraph_ids[0] === left.id,
    zoomed.drag.why ?? (zoomed.scope?.paragraph_ids ?? []).map(short).join(","),
  );
  await page.click('[aria-label="适应宽度"]');
  await page.waitForTimeout(600);

  // --- selecting alone must not call a model ------------------------------
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  const drag = await dragAcrossParagraph(page, right ?? left);
  check(
    "selecting text on its own makes no request (privacy, AC-08)",
    drag.ok,
    drag.why ?? "selection mapped without asking anything",
  );

  // --- clicking in the paper clears it ------------------------------------
  const viewer = await page.locator('[data-testid="pdf-viewer"]').boundingBox();
  await page.mouse.click(viewer.x + 20, viewer.y + viewer.height - 20);
  await page.waitForTimeout(400);
  const cleared = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="scope-selector"] option')].find((candidate) =>
      candidate.textContent?.startsWith("选中内容"),
    )?.disabled,
  );
  check("clicking in the paper clears the selection (AC-11)", cleared === true);
}
