/**
 * What a page becomes when the paper is unrolled into one reading column.
 *
 * The paper is a *laid-out* object: two columns of text set side by side, a
 * running head, a folio, floats that span both columns. The reader asked for the
 * effect the extension 沉浸式翻译 produces — the source stays where it is and its
 * translation follows it — and the only way a PDF can give that without
 * re-typesetting a word is to cut the page into regions and unroll them: the
 * left column's blocks in order, each followed by its translation, then the
 * right column's, with anything that spanned both columns carried whole.
 *
 * This module is that arithmetic and nothing else. No DOM, no canvas, no store:
 * rectangles and paragraph spans in, the regions to draw out, in reading order.
 * Every claim about the result — no block dropped, none drawn twice, no region
 * of negative height — is therefore arithmetic a test can check in a millisecond
 * without a browser.
 *
 * ## The rule that keeps it honest
 *
 * A lane is **tiled**, not sampled: its strips run from one cut to the next with
 * no gaps and no overlaps, so what the reader sees between two cuts is the
 * paper's own pixels at the paper's own spacing. One strip per block would leave
 * the paper's leading to be re-invented as CSS margins — the moment this stops
 * being the original layout (AC_CHANGE_REQUEST 3).
 */

/** A rectangle in PDF points, top-left origin — the IR's own space. */
export type Box = [number, number, number, number];

/** The extractor's own "this is not content" class: running heads, folios, stamps. */
export const FURNITURE_CLASS = "abandon";

/** Below this the two x-clusters are not two columns. */
export const MIN_GUTTER_PT = 6;

export interface PageGeometry {
  pageNumber: number;
  widthPt: number;
  heightPt: number;
}

export interface BlockRect {
  id: string;
  layoutClass: string;
  box: Box;
  fontSize: number | null;
}

export type ParagraphStatus = "translated" | "skipped" | "untranslated";

/** One paragraph of the paper, as the artifact carries it. */
export interface ParagraphSpan {
  id: string;
  boxes: Box[];
  status: ParagraphStatus;
  text: string | null;
  note: string | null;
}

export type LaneKind = "left" | "right" | "full";

export interface Strip {
  id: string;
  pageNumber: number;
  lane: LaneKind;
  /** The source rectangle, in PDF points. */
  box: Box;
  /** Every block this strip draws — one or more, since a lane is tiled. */
  blockIds: string[];
}

export interface Insertion {
  id: string;
  paragraphId: string;
  pageNumber: number;
  lane: LaneKind;
  /** The paragraph's own last rectangle, for the jump back to the PDF. */
  box: Box;
  status: ParagraphStatus;
  text: string | null;
  note: string | null;
}

/**
 * `seam` marks where the paper's arrangement changes — the left column ending
 * and the right beginning — so the reader can see the page has been unrolled
 * rather than wonder why the text jumps.
 */
export type FlowItem =
  | { kind: "strip"; strip: Strip }
  | { kind: "insertion"; insertion: Insertion }
  | { kind: "seam"; id: string; pageNumber: number; from: LaneKind; to: LaneKind };

export interface PageFlow {
  pageNumber: number;
  widthPt: number;
  heightPt: number;
  items: FlowItem[];
  strips: Strip[];
  /** Paragraphs on this page the artifact holds but never translated (the bibliography). */
  skipped: string[];
  /**
   * In-band blocks that no strip lists. Empty by construction; carried so a test
   * asserts the coverage claim instead of trusting it.
   */
  uncovered: string[];
  /**
   * Blocks the view deliberately does not draw: everything outside the content
   * band, i.e. the paper's margins. Measured on the reader's own paper that is
   * the arXiv margin stamp — 23 pt wide, 344 pt tall — which the criteria's
   * "furniture above the body is a header" rule would otherwise pin into page
   * 1's footer as a sliver (AC_CHANGE_REQUEST 2).
   */
  cropped: string[];
}

// --- small geometry helpers --------------------------------------------------

function overlapsY(box: Box, y0: number, y1: number): boolean {
  return box[1] < y1 && box[3] > y0;
}

function boxWidth(box: Box): number {
  return box[2] - box[0];
}

function boxHeight(box: Box): number {
  return box[3] - box[1];
}

function isEmpty(box: Box): boolean {
  return boxWidth(box) <= 0 || boxHeight(box) <= 0;
}

/**
 * The page's content band and its gutter, derived — never assumed.
 *
 * The gutter exists only between two *columns*, and the corpus holds pages that
 * have one and pages that do not: the reader's own paper is single-column on one
 * of its fourteen body pages, and another paper in the library is single-column
 * on eighteen of thirty-one. A constant would pour both columns of a two-column
 * page into one lane, or cut a single-column page in half.
 */
export function pageBands(
  bodyBlocks: BlockRect[],
  widthPt: number,
): { band: [number, number]; gutter: number | null } {
  const band: [number, number] = [
    Math.min(...bodyBlocks.map((block) => block.box[0])),
    Math.max(...bodyBlocks.map((block) => block.box[2])),
  ];

  const middle = widthPt / 2;
  const leftEdges = bodyBlocks.filter((block) => block.box[2] <= middle).map((block) => block.box[2]);
  const rightEdges = bodyBlocks.filter((block) => block.box[0] >= middle).map((block) => block.box[0]);
  const leftEdge = leftEdges.length > 0 ? Math.max(...leftEdges) : Number.NEGATIVE_INFINITY;
  const rightEdge = rightEdges.length > 0 ? Math.min(...rightEdges) : Number.POSITIVE_INFINITY;

  const twoColumns = rightEdge - leftEdge >= MIN_GUTTER_PT;

  return { band, gutter: twoColumns ? (leftEdge + rightEdge) / 2 : null };
}

/** A box's lane, by its **extent** — a box that crosses the gutter has no lane. */
export function laneOf(box: Box, gutter: number | null): LaneKind {
  if (gutter === null) return "full";
  if (box[2] <= gutter) return "left";
  if (box[0] >= gutter) return "right";
  return "full";
}

function crossesGutter(box: Box, gutter: number | null): boolean {
  return gutter !== null && box[0] < gutter && box[2] > gutter;
}

/** The lane's own x-range, which is what a strip is cut to. */
export function laneRange(
  lane: LaneKind,
  band: [number, number],
  gutter: number | null,
): [number, number] {
  if (gutter === null || lane === "full") return band;
  return lane === "left" ? [band[0], gutter] : [gutter, band[1]];
}

/**
 * The strip a paragraph's translation belongs under.
 *
 * Preferred: the strip whose cut is the paragraph's own last bottom edge, which
 * is what the cuts were taken for. Failing that — a paragraph ending one point
 * above another's end, or a lane boundary moved by a wide block — the strip that
 * *contains* that edge, so no paragraph can silently lose its translation.
 */
function stripFor(candidates: Strip[], last: Box): Strip | null {
  const exact = candidates.find((strip) => Math.abs(strip.box[3] - last[3]) <= 0.75);
  if (exact !== undefined) return exact;
  const containing = candidates.find(
    (strip) => strip.box[1] <= last[3] + 0.5 && strip.box[3] >= last[3] - 0.75,
  );
  if (containing !== undefined) return containing;
  const before = candidates
    .filter((strip) => strip.box[1] < last[3])
    .sort((a, b) => a.box[1] - b.box[1]);
  return before.length > 0 ? before[before.length - 1]! : null;
}

// --- the flow ----------------------------------------------------------------

export function pageFlow(
  geometry: PageGeometry,
  blocks: BlockRect[],
  paragraphs: ParagraphSpan[],
): PageFlow {
  const drawn = blocks.filter((block) => !isEmpty(block.box));
  const body = drawn.filter((block) => block.layoutClass !== FURNITURE_CLASS);

  // A page of nothing but furniture — measured: the reader's paper's last page.
  // It cannot be unrolled, so it is drawn as what it is.
  if (body.length === 0) {
    if (drawn.length === 0) {
      return {
        pageNumber: geometry.pageNumber,
        widthPt: geometry.widthPt,
        heightPt: geometry.heightPt,
        items: [],
        strips: [],
        skipped: [],
        uncovered: [],
        cropped: [],
      };
    }
    const strip: Strip = {
      id: `s${geometry.pageNumber}_page`,
      pageNumber: geometry.pageNumber,
      lane: "full",
      box: [0, 0, geometry.widthPt, geometry.heightPt],
      blockIds: drawn.map((block) => block.id),
    };
    return {
      pageNumber: geometry.pageNumber,
      widthPt: geometry.widthPt,
      heightPt: geometry.heightPt,
      items: [{ kind: "strip", strip }],
      strips: [strip],
      skipped: [],
      uncovered: [],
      cropped: [],
    };
  }

  const { band, gutter } = pageBands(body, geometry.widthPt);
  const inBand = (block: BlockRect): boolean => block.box[0] < band[1] && block.box[2] > band[0];
  const cropped = drawn.filter((block) => !inBand(block)).map((block) => block.id);
  const kept = drawn.filter(inBand);

  const bodyTop = Math.min(...body.map((block) => block.box[1]));
  const bodyBottom = Math.max(...body.map((block) => block.box[3]));

  // Furniture is a header only when it is entirely above the body and a footer
  // only when it is entirely below it. Anything else lies inside the body's own
  // range and is drawn where it lies, by whichever lane strip covers it — the
  // measured exception in the corpus is a 10 × 10 pt box on page 23 of one paper.
  const header = kept.filter(
    (block) => block.layoutClass === FURNITURE_CLASS && block.box[3] <= bodyTop,
  );
  const footer = kept.filter(
    (block) => block.layoutClass === FURNITURE_CLASS && block.box[1] >= bodyBottom,
  );

  const laneBlocks: Record<LaneKind, BlockRect[]> = { left: [], right: [], full: [] };
  const wide: BlockRect[] = [];
  for (const block of kept) {
    if (block.layoutClass === FURNITURE_CLASS) continue;
    if (crossesGutter(block.box, gutter)) wide.push(block);
    else laneBlocks[laneOf(block.box, gutter)].push(block);
  }

  /**
   * Wide blocks that overlap each other are one region, not two.
   *
   * Measured on page 8 of the fixture: three gutter-crossing blocks whose
   * y-ranges intersect (70.3–168.9, 166.0–172.9, 170.8–193.0). Drawn as three
   * full-width strips they would paint the same band two and three times; drawn
   * as one they paint it once and still list every block that lives there.
   */
  const wideGroups: BlockRect[][] = [];
  for (const block of [...wide].sort((a, b) => a.box[1] - b.box[1])) {
    const last = wideGroups[wideGroups.length - 1];
    const lastBottom = last === undefined ? Number.NEGATIVE_INFINITY : Math.max(...last.map((b) => b.box[3]));
    if (last !== undefined && block.box[1] < lastBottom - 0.5) last.push(block);
    else wideGroups.push([block]);
  }
  const lanes = (["left", "right", "full"] as LaneKind[]).filter(
    (lane) => laneBlocks[lane].length > 0,
  );

  // --- strips -----------------------------------------------------------------
  const strips: Strip[] = [];
  const covered = new Set<string>();

  const push = (lane: LaneKind, box: Box, ids: string[]): void => {
    if (boxHeight(box) <= 0.5) return;
    const fresh = ids.filter((id) => !covered.has(id));
    for (const id of fresh) covered.add(id);
    strips.push({
      id: `s${geometry.pageNumber}_${lane}_${Math.round(box[1] * 10)}`,
      pageNumber: geometry.pageNumber,
      lane,
      box,
      blockIds: fresh,
    });
  };

  const [bandX0, bandX1] = band;
  // Only when there is something in them: an empty band is a few hundred pixels
  // of margin being rendered as a canvas for nothing.
  if (header.length > 0) push("full", [bandX0, 0, bandX1, bodyTop], header.map((block) => block.id));

  // Every lane runs the full body band, not just its own blocks' extent. The
  // difference is content that is not a body block but lives in the lane's
  // x-range — measured: running feet at y 703–714 on pages 3, 5, 6, 7 and 11 of
  // the fixture, below the left column's last paragraph and above the right
  // column's. A lane that stopped at its own last block would leave them outside
  // every strip, drawn nowhere.
  for (const lane of lanes) {
    const own = laneBlocks[lane];
    const [laneX0, laneX1] = laneRange(lane, band, gutter);

    // A lane's coverage, minus the y-ranges of the wide regions: those are drawn
    // whole and full width, and drawing them again inside a lane would put the
    // same figure on the page twice.
    let segments: Array<[number, number]> = [[bodyTop, bodyBottom]];
    for (const group of wideGroups) {
      const y0 = Math.min(...group.map((block) => block.box[1]));
      const y1 = Math.max(...group.map((block) => block.box[3]));
      if (!overlapsY([bandX0, y0, bandX1, y1], bodyTop, bodyBottom)) continue;
      const next: Array<[number, number]> = [];
      for (const [a, b] of segments) {
        if (y1 <= a || y0 >= b) {
          next.push([a, b]);
          continue;
        }
        if (y0 > a + 0.5) next.push([a, y0]);
        if (y1 < b - 0.5) next.push([y1, b]);
      }
      segments = next;
    }

    for (const [y0, y1] of segments) {
      const inSegment = own.filter((block) => block.box[1] >= y0 - 0.5 && block.box[3] <= y1 + 0.5);
      let previous = y0;
      const cuts = [...new Set(inSegment.map((block) => block.box[3]))]
        .filter((cut) => cut > y0 + 0.5 && cut < y1 - 0.5)
        .sort((a, b) => a - b);
      for (const cut of cuts) {
        push(
          lane,
          [laneX0, previous, laneX1, cut],
          inSegment.filter((block) => block.box[3] <= cut + 0.5).map((block) => block.id),
        );
        previous = cut;
      }
      push(
        lane,
        [laneX0, previous, laneX1, y1],
        inSegment.map((block) => block.id),
      );
    }
  }
  if (footer.length > 0) {
    push("full", [bandX0, bodyBottom, bandX1, geometry.heightPt], footer.map((block) => block.id));
  }

  const wideStrips: Strip[] = wideGroups.map((group) => ({
    id: `s${geometry.pageNumber}_wide_${Math.round(Math.min(...group.map((b) => b.box[1])) * 10)}`,
    pageNumber: geometry.pageNumber,
    lane: "full",
    box: [
      bandX0,
      Math.min(...group.map((b) => b.box[1])),
      bandX1,
      Math.max(...group.map((b) => b.box[3])),
    ],
    blockIds: group.map((block) => block.id),
  }));
  for (const block of wide) covered.add(block.id);

  // Anything the lanes did not list — furniture lying inside the body's own
  // range, or a block the wide exclusions left outside every segment — is drawn
  // by whichever strip covers it, so it belongs to that strip's list. Measured:
  // one such block on page 1 of the fixture, an `abandon` running foot the
  // extractor placed inside the body's y-range.
  for (const block of kept) {
    if (covered.has(block.id)) continue;
    const home = strips.find(
      (strip) =>
        block.box[0] >= strip.box[0] - 0.51 &&
        block.box[2] <= strip.box[2] + 0.51 &&
        block.box[1] >= strip.box[1] - 0.51 &&
        block.box[3] <= strip.box[3] + 0.51,
    );
    if (home === undefined) continue;
    home.blockIds.push(block.id);
    covered.add(block.id);
  }

  // --- where each translation goes --------------------------------------------
  const attachments = new Map<string, Insertion[]>();
  const skipped: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.boxes.length === 0) continue;
    if (paragraph.status === "skipped") {
      skipped.push(paragraph.id);
      continue;
    }
    const last = paragraph.boxes[paragraph.boxes.length - 1]!;
    const candidates = crossesGutter(last, gutter) ? wideStrips : strips.filter((strip) => strip.lane === laneOf(last, gutter));
    const strip = stripFor(candidates, last);
    if (strip === null) continue;
    const insertion: Insertion = {
      id: `i_${paragraph.id}`,
      paragraphId: paragraph.id,
      pageNumber: geometry.pageNumber,
      lane: strip.lane,
      box: last,
      status: paragraph.status,
      text: paragraph.text,
      note: paragraph.note,
    };
    const list = attachments.get(strip.id);
    if (list === undefined) attachments.set(strip.id, [insertion]);
    else list.push(insertion);
  }

  // --- the reading order -------------------------------------------------------
  //
  // The IR's own order, which is column-major on every page measured: the left
  // column top to bottom, then the right, with a wide item where the extractor
  // put it. Nothing is re-sorted — re-sorting would be this module inventing a
  // reading order the extractor already decided.
  const items: FlowItem[] = [];
  const headerStrips = strips.filter((strip) => strip.box[1] === 0);
  if (headerStrips.length > 0 && headerStrips[0]!.blockIds.length > 0) {
    items.push({ kind: "strip", strip: headerStrips[0]! });
  }

  const emitted = new Set<string>();
  let lastLane: LaneKind | null = headerStrips.length > 0 && headerStrips[0]!.blockIds.length > 0 ? "full" : null;

  const emitStrips = (list: Strip[], lane: LaneKind): void => {
    if (lastLane !== null && lastLane !== lane) {
      items.push({
        kind: "seam",
        id: `seam${geometry.pageNumber}_${items.length}`,
        pageNumber: geometry.pageNumber,
        from: lastLane,
        to: lane,
      });
    }
    for (const strip of [...list].sort((a, b) => a.box[1] - b.box[1])) {
      items.push({ kind: "strip", strip });
      for (const insertion of attachments.get(strip.id) ?? []) {
        items.push({ kind: "insertion", insertion });
      }
    }
    lastLane = lane;
  };

  for (const block of kept) {
    if (block.layoutClass === FURNITURE_CLASS) continue;
    if (crossesGutter(block.box, gutter)) {
      if (!emitted.has("wide")) {
        emitted.add("wide");
        emitStrips(wideStrips, "full");
      }
      continue;
    }
    const lane = laneOf(block.box, gutter);
    if (!emitted.has(lane)) {
      emitted.add(lane);
      emitStrips(
        strips.filter((strip) => strip.lane === lane && strip.box[1] > 0 && strip.box[3] < geometry.heightPt),
        lane,
      );
    }
  }

  const footerStrip = strips.find((strip) => strip.box[3] === geometry.heightPt);
  if (footerStrip !== undefined && footerStrip.blockIds.length > 0) {
    if (lastLane !== null && lastLane !== "full") {
      items.push({
        kind: "seam",
        id: `seam${geometry.pageNumber}_${items.length}`,
        pageNumber: geometry.pageNumber,
        from: lastLane,
        to: "full",
      });
    }
    items.push({ kind: "strip", strip: footerStrip });
  }

  const uncovered = kept
    .filter((block) => !covered.has(block.id))
    .map((block) => block.id);

  return {
    pageNumber: geometry.pageNumber,
    widthPt: geometry.widthPt,
    heightPt: geometry.heightPt,
    items,
    strips: [...strips, ...wideStrips],
    skipped,
    uncovered,
    cropped,
  };
}
