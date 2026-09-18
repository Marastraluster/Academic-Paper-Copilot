/**
 * Browser text selection → canonical `ParagraphIR` identity.
 *
 * The browser's DOM is a *rendering* of the document, not the document. Nothing
 * here derives an identity from it: the DOM supplies geometry and the text the
 * user dragged across, and every id that comes out the other side is read from
 * the `DocumentIR`. Span classes, node indices and character offsets are never
 * identity — the first two change with zoom and rerender, and the third cannot be
 * computed at all, because the text layer's segmentation is not the IR's.
 *
 * ## Two measurements that shape the rules
 *
 * **One box is not enough.** A selection's `getBoundingClientRect()` spans the
 * gutter on a two-column page, so a left-column selection would intersect every
 * right-column paragraph at the same height. ResNet's left column is x=49→287 of a
 * 612 pt page. Only the per-line fragments from `getClientRects()` are used.
 *
 * **DOM order is not reading order.** A range across four adjacent spans in the
 * real reader picked up a figure's axis labels, because the text layer's DOM order
 * follows the content stream rather than the page. Geometry decides; the IR's
 * paragraph order decides the rest.
 *
 * The thresholds below are the frozen criteria's specified values. They are
 * reported by the evidence as what they admit and reject, not as calibrated
 * numbers — no sweep produced them.
 */
import type { Bbox, IrParagraph } from "@/api/ir";

/** A rectangle in canonical PDF points, top-left origin. */
export interface PdfRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A rectangle as the browser reports it, before any transform. */
export interface ClientRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const MIN_HORIZONTAL_OVERLAP_PT = 4.0;
export const MIN_VERTICAL_COVERAGE = 0.5;
export const MIN_INTERSECTION_PT2 = 80.0;
export const MIN_INTERSECTION_FRACTION = 0.4;
export const MAX_SELECTED_PARAGRAPHS = 20;
export const MIN_FRAGMENT_PT = 2.0;

/** Why a mapping could not be used. Never guessed at — each is a real condition. */
export type MappingStatus =
  | "valid"
  /** Some candidates validated and some did not. */
  | "partial"
  | "collapsed"
  /**
   * A cross-page gesture that could not be honoured *as a whole*.
   *
   * Replaces DS-QA-005's `cross_page`, which meant "spanning two pages is not
   * supported". It is supported now, so the status has to say which of the
   * several ways a cross-page gesture can fail actually happened — the reader
   * gets a sentence about their own situation instead of a sentence about a
   * feature that exists.
   */
  | "cross_page_refused"
  /**
   * The browser reports selected text the page could not measure.
   *
   * Its own status because it is a different thing from a refusal: the user's
   * gesture *succeeded*, and the part of it that cannot be placed is text whose
   * geometry is gone. Saving the rest would be a silent truncation of what they
   * visibly selected.
   */
  | "unmeasurable"
  | "non_prose"
  | "unavailable";

export interface SelectionMapping {

  status: MappingStatus;
  /** Canonical ids, reading order, deduplicated. */
  paragraphIds: string[];
  /** 1-based pages the selection touched. */
  pages: number[];
  /** What the user selected, for the preview. Not identity. */
  text: string;
  truncated: boolean;
  /**
   * Why this mapping was refused, in the reader's own terms.
   *
   * The status alone cannot say it: `cross_page_refused` covers a span of three
   * pages, a rotated page, a page with no prose, and a page whose geometry is
   * gone, and each has a different fix. The refusal's own sentence is carried
   * here so the sidebar shows the reader's situation rather than a category.
   * Empty on every mapping that was not refused.
   */
  reason: string;
  /**
   * The source-PDF boxes the selection actually covered, by page.
   *
   * Computed for matching and, until DS-QA-010, thrown away. A persistent
   * highlight needs them: a multi-line selection is several boxes, and drawing
   * its envelope instead would paint the margins beside a short last line. They
   * are in the same source-PDF point space as `IrParagraph.bboxes`, so they
   * survive zoom, fit-width and a page remount without being re-derived.
   */
  rects: Record<number, Bbox[]>;
}

const EMPTY: SelectionMapping = {
  status: "unavailable",
  paragraphIds: [],
  pages: [],
  text: "",
  truncated: false,
  rects: {},
  reason: "",
};

/**
 * Client rectangles → canonical PDF points.
 *
 * The inverse of the transform that draws a citation highlight. `pageRect` is the
 * page container's client rect; `scale` is published by the page itself rather
 * than parsed out of PDF.js's CSS variable, so this depends on the application's
 * contract rather than a library's internals.
 *
 * ## Rotated pages return nothing, deliberately
 *
 * DS-QA-005's AC-02 asked for the affine inverse for `rotation ∈ {90, 180, 270}`,
 * with four formulas. They were implemented, and then **removed**, because the
 * measurement could not confirm them: a real drag on a page built with `/Rotate
 * 90` mapped to nothing, and the two conventions involved turn out not to be
 * reconcilable by inspection — PyMuPDF reports a rotated page's `rect` as
 * 792×612 while reporting its text blocks in unrotated coordinates, and PDF.js's
 * viewport transform already carries the rotation.
 *
 * A wrong inverse does not degrade gracefully. It maps a horizontal span onto a
 * vertical coordinate and returns **a confidently wrong paragraph**, which is
 * worse than the unavailable state it would replace — and the same judgement
 * DS-QA-003 made when it declined to draw highlights on rotated pages. The
 * criterion's own fallback permits this, and the honest version of "we are not
 * sure" is to return nothing and say so.
 */
export function toPdfRects(
  rects: readonly ClientRect[],
  pageRect: { left: number; top: number },
  scale: number,
  page: { width_pt: number; height_pt: number; rotation: number },
): PdfRect[] {
  if (!(scale > 0)) return [];
  if ((((page.rotation % 360) + 360) % 360) !== 0) return [];

  const boxes: PdfRect[] = [];
  for (const rect of rects) {
    const x = (rect.left - pageRect.left) / scale;
    const y = (rect.top - pageRect.top) / scale;
    const w = rect.width / scale;
    const h = rect.height / scale;
    if (w < MIN_FRAGMENT_PT || h < MIN_FRAGMENT_PT) continue;
    boxes.push({ x0: x, y0: y, x1: x + w, y1: y + h });
  }
  return boxes;
}

/** Normalization used only to *confirm* a geometric candidate, never to find one. */
export function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[­​]/g, "")
    // A word broken across a line by a hyphen is one word in the IR.
    .replace(/(\w)-\s*\n\s*(\w)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function tokensOf(text: string): string[] {
  return text.split(/[^\p{L}\p{N}.\-]+/u).filter(Boolean);
}

function trigrams(text: string): Set<string> {
  const padded = ` ${text} `;
  const grams = new Set<string>();
  for (let index = 0; index + 3 <= padded.length; index += 1) {
    grams.add(padded.slice(index, index + 3));
  }
  return grams;
}

/**
 * Does the paragraph's own text support the selection?
 *
 * A geometric hit on a figure's caption box or an axis label is a real overlap and
 * a false identity, so geometry proposes and this disposes. Deliberately lenient
 * in the direction that matters: a paragraph the user genuinely selected across
 * must not be rejected for a line-break artefact.
 */
export function textSupports(selected: string, paragraphText: string): boolean {
  const needle = normalizeText(selected);
  const haystack = normalizeText(paragraphText);
  if (!needle) return false;
  if (haystack.includes(needle)) return true;

  const needleTokens = tokensOf(needle);
  if (needleTokens.length <= 5) return false;

  const haystackTokens = new Set(tokensOf(haystack));
  const contained = needleTokens.filter((token) => haystackTokens.has(token)).length;
  if (contained / needleTokens.length >= 0.35) return true;

  const left = trigrams(needle);
  const right = trigrams(haystack);
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return left.size > 0 && shared / left.size >= 0.25;
}

function intersect(a: PdfRect, b: Bbox): { dx: number; dy: number } {
  return {
    dx: Math.max(0, Math.min(a.x1, b[2]) - Math.max(a.x0, b[0])),
    dy: Math.max(0, Math.min(a.y1, b[3]) - Math.max(a.y0, b[1])),
  };
}

/**
 * Map canonical selection geometry onto paragraphs.
 *
 * Pure, so the rules can be tested without a browser, and so the transform above
 * can be tested separately from the matching below — they fail in different ways
 * and a combined test would not say which.
 */
export function matchParagraphs(
  rectsByPage: Map<number, PdfRect[]>,
  paragraphs: readonly IrParagraph[],
  selectedText: string,
): SelectionMapping {
  const totalArea = [...rectsByPage.values()]
    .flat()
    .reduce((sum, rect) => sum + (rect.x1 - rect.x0) * (rect.y1 - rect.y0), 0);
  const areaThreshold = Math.min(
    MIN_INTERSECTION_PT2,
    MIN_INTERSECTION_FRACTION * totalArea,
  );

  const accepted: string[] = [];
  let rejected = 0;

  for (const paragraph of paragraphs) {
    const rects = rectsByPage.get(paragraph.page_number);
    if (!rects || rects.length === 0) continue;

    let area = 0;
    for (const rect of rects) {
      for (const box of paragraph.bboxes) {
        const { dx, dy } = intersect(rect, box);
        if (dx < MIN_HORIZONTAL_OVERLAP_PT) continue;
        const lineHeight = Math.min(rect.y1 - rect.y0, box[3] - box[1]);
        if (lineHeight <= 0 || dy / lineHeight < MIN_VERTICAL_COVERAGE) continue;
        area += dx * dy;
      }
    }
    if (area < areaThreshold) continue;

    if (textSupports(selectedText, paragraph.text)) accepted.push(paragraph.id);
    else rejected += 1;
  }

  if (accepted.length === 0) {
    return {
      ...EMPTY,
      text: selectedText,
      status: "non_prose",
      pages: [...rectsByPage.keys()],
      rects: toBboxRecord(rectsByPage),
    };
  }

  // Reading order is the IR's, not the DOM's and not the drag's.
  const order = new Map(paragraphs.map((paragraph, index) => [paragraph.id, index]));
  accepted.sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));

  const unique = [...new Set(accepted)];
  const truncated = unique.length > MAX_SELECTED_PARAGRAPHS;
  return {
    status: rejected > 0 || truncated ? "partial" : "valid",
    paragraphIds: unique.slice(0, MAX_SELECTED_PARAGRAPHS),
    pages: [...rectsByPage.keys()].sort((left, right) => left - right),
    text: selectedText,
    truncated,
    rects: toBboxRecord(rectsByPage),
    reason: "",
  };
}

/**
 * The matcher works in `PdfRect` objects; everything downstream — the IR, the
 * annotation payload, the highlight renderer — uses `[x0, y0, x1, y1]` tuples.
 * Converting once, here, is what keeps a single coordinate representation in the
 * system rather than two that agree until someone edits one.
 */
function toBboxRecord(rectsByPage: Map<number, PdfRect[]>): Record<number, Bbox[]> {
  const out: Record<number, Bbox[]> = {};
  for (const [page, rects] of rectsByPage) {
    out[page] = rects.map((r) => [r.x0, r.y0, r.x1, r.y1] as Bbox);
  }
  return out;
}

/** The page a DOM node belongs to, by walking up to the page container. */
export function pageElementOf(node: Node | null): HTMLElement | null {
  let element = node instanceof Element ? node : (node?.parentElement ?? null);
  while (element) {
    if (element instanceof HTMLElement && element.dataset.pageNumber) return element;
    element = element.parentElement;
  }
  return null;
}

export interface PageSelectionFragment {
  page: number;
  element: HTMLElement;
  /** Line fragments the browser measured for this page, and nothing else. */
  rects: ClientRect[];
  /** The selected text this page's own nodes contributed. */
  text: string;
}

export interface DomSelection {
  text: string;
  isCollapsed: boolean;
  /** One entry per page the selection touched, in page order. */
  byPage: PageSelectionFragment[];
  crossPage: boolean;
  /** True when the selection lives in a pane that is not source evidence. */
  translatedPane: boolean;
  /**
   * Non-whitespace characters of the selection the DOM could measure, and the
   * count the browser reports as selected.
   *
   * These are equal for every honest selection. They differ by exactly the text
   * whose geometry no longer exists — see `readDomSelection`.
   */
  measuredChars: number;
  reportedChars: number;
}

const EMPTY_DOM_SELECTION: DomSelection = {
  text: "",
  isCollapsed: true,
  byPage: [],
  crossPage: false,
  translatedPane: false,
  measuredChars: 0,
  reportedChars: 0,
};

/** Non-whitespace characters. The unit both completeness counts are in. */
export function measurableChars(text: string): number {
  return text.replace(/\s+/g, "").length;
}

/**
 * Read the live DOM selection, without interpreting it.
 *
 * ## Why the range is clamped to each text node rather than to each page
 *
 * The obvious implementation reads `range.getClientRects()` once and works out
 * which page each rectangle belongs to afterwards. **It is wrong, and the
 * measurement says so.** `Range.getClientRects()` includes the border boxes of
 * partially-contained elements, so a selection ending inside page 2's absolutely
 * positioned text layer emits page 2's *entire* box — 1050×1486 at fit-width.
 * Deciding its owner by hit-testing the centre fails too: a rectangle below the
 * fold has no element under its centre, `elementFromPoint` returns null, and the
 * fallback attributes a page-2 rectangle to page 1. The result is a rectangle
 * covering every paragraph on page 1, which is a highlight over the whole page.
 *
 * Clamping the range to each text node and measuring *that* removes both
 * problems structurally rather than by threshold. Measured on the same live
 * cross-page selection:
 *
 *     clamp to page container → page 1: 7 rects, page 2: 8 rects,
 *                               including the 1050×1486 artifact
 *     clamp to text node      → page 1: 4 rects, page 2: 4 rects, no artifact
 *
 * A text node is inside exactly one page container, so ownership is known
 * directly — which is also what the brief asks for: do not assign a fragment to
 * a page by proximity when the DOM can answer it. And `getClientRects()` on a
 * range that contains only text returns only line boxes.
 *
 * ## The completeness counts
 *
 * `Range.toString()` is computed from live node references, so it keeps
 * reporting text whose nodes have been **removed from the document**: a drag
 * that auto-scrolls has its starting page virtualised away mid-gesture, and the
 * page's text is still in `toString()` while `getClientRects()` on it measures
 * nothing. Measured: 6388 reported characters against a selection whose first
 * page could no longer be measured at all.
 *
 * So the two counts are reported rather than reconciled. When they disagree, the
 * mapping says so and refuses — saving the measurable part would silently
 * truncate a span the user can still see highlighted on screen.
 */
export function readDomSelection(selection: Selection | null): DomSelection {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return EMPTY_DOM_SELECTION;
  }

  const range = selection.getRangeAt(0);
  const doc = range.startContainer.ownerDocument;
  if (!doc) return EMPTY_DOM_SELECTION;

  const byPage = new Map<number, PageSelectionFragment>();
  let measuredChars = 0;
  let translatedPane = false;

  // Only pages whose content the range actually touches are walked. This is the
  // pre-filter that keeps the walk proportional to the selection rather than to
  // the document — a page is visited only if some of it is selected.
  const containers = doc.querySelectorAll<HTMLElement>("[data-page-number]");
  for (const container of Array.from(containers)) {
    const page = Number(container.dataset.pageNumber ?? "0");
    if (!page || !range.intersectsNode(container)) continue;

    const inTranslation = container.closest('[data-testid="viewer-translated"]') !== null;
    if (inTranslation) translatedPane = true;

    const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode() as Text | null;
    while (node) {
      const text = node.nodeValue;
      if (text && text.trim() && range.intersectsNode(node)) {
        const sub = clampRangeToNode(doc, range, node);
        const rects: ClientRect[] = [];
        for (const rect of Array.from(sub.getClientRects())) {
          if (rect.width <= 0 || rect.height <= 0) continue;
          rects.push({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
        }
        const contributed = sub.toString();
        measuredChars += measurableChars(contributed);
        if (rects.length > 0) {
          const entry = byPage.get(page) ?? { page, element: container, rects: [], text: "" };
          entry.rects.push(...rects);
          entry.text += contributed;
          byPage.set(page, entry);
        }
      }
      node = walker.nextNode() as Text | null;
    }
  }

  const text = selection.toString();
  return {
    text,
    isCollapsed: false,
    byPage: [...byPage.values()].sort((left, right) => left.page - right.page),
    crossPage: byPage.size > 1,
    translatedPane,
    measuredChars,
    reportedChars: measurableChars(text),
  };
}

/**
 * The part of `range` that falls inside one text node.
 *
 * A text node is either entirely inside the range, entirely outside it, or
 * carries one of its boundaries — there is no fourth case, which is why this
 * needs no intersection arithmetic beyond two comparisons.
 */
function clampRangeToNode(doc: Document, range: Range, node: Text): Range {
  const bounds = doc.createRange();
  bounds.selectNodeContents(node);

  const sub = doc.createRange();
  const startsAfter = range.compareBoundaryPoints(Range.START_TO_START, bounds) > 0;
  sub.setStart(
    startsAfter ? range.startContainer : node,
    startsAfter ? range.startOffset : 0,
  );
  const endsBefore = range.compareBoundaryPoints(Range.END_TO_END, bounds) < 0;
  sub.setEnd(
    endsBefore ? range.endContainer : node,
    endsBefore ? range.endOffset : (node.nodeValue?.length ?? 0),
  );
  return sub;
}
