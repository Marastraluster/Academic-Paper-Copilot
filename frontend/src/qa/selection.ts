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
  | "cross_page"
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
}

const EMPTY: SelectionMapping = {
  status: "unavailable",
  paragraphIds: [],
  pages: [],
  text: "",
  truncated: false,
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
    return { ...EMPTY, text: selectedText, status: "non_prose", pages: [...rectsByPage.keys()] };
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
  };
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

export interface DomSelection {
  text: string;
  isCollapsed: boolean;
  /** One entry per page the selection touched, in page order. */
  byPage: { page: number; element: HTMLElement; rects: ClientRect[] }[];
  crossPage: boolean;
  /** True when the selection lives in a pane that is not source evidence. */
  translatedPane: boolean;
}

/**
 * Read the live DOM selection, without interpreting it.
 *
 * `getClientRects()` is per line fragment and is the only thing used for
 * geometry. `pageElementOf` walks each fragment's own container, so a range that
 * crosses a page boundary is *detected* here and refused by the caller rather than
 * being mapped onto whichever page happened to come first.
 */
export function readDomSelection(selection: Selection | null): DomSelection {
  const empty: DomSelection = {
    text: "",
    isCollapsed: true,
    byPage: [],
    crossPage: false,
    translatedPane: false,
  };
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return empty;

  const range = selection.getRangeAt(0);
  const byPage = new Map<number, { page: number; element: HTMLElement; rects: ClientRect[] }>();
  let translatedPane = false;

  for (const rect of Array.from(range.getClientRects())) {
    if (rect.width <= 0 || rect.height <= 0) continue;
    // The fragment's own position identifies its page; a range spanning pages
    // produces fragments on both, which is how cross-page is detected. When the
    // environment has no hit-testing, the range's own containers are the honest
    // fallback — and jsdom, which has neither, is a real example of one that
    // does not.
    const element = pageElementOf(range.startContainer) ?? pageElementOf(range.endContainer);
    const probe =
      typeof document.elementFromPoint === "function"
        ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        : null;
    const container = pageElementOf(probe) ?? element;
    if (!container) continue;
    if (container.closest('[data-testid="viewer-translated"]')) translatedPane = true;

    const page = Number(container.dataset.pageNumber ?? "0");
    if (!page) continue;
    const entry = byPage.get(page) ?? { page, element: container, rects: [] };
    entry.rects.push({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    byPage.set(page, entry);
  }

  return {
    text: selection.toString(),
    isCollapsed: false,
    byPage: [...byPage.values()].sort((left, right) => left.page - right.page),
    crossPage: byPage.size > 1,
    translatedPane,
  };
}
