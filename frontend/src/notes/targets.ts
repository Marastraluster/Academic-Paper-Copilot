/**
 * A browser selection → the source targets an annotation persists.
 *
 * Two rules, and both exist to stop this module inventing things.

 * **The anchor comes from the IR, never from here.** `source_anchor_id` is
 * computed by the backend at extraction time and returned on every paragraph.
 * Recomputing it in the browser would mean two implementations of a hash whose
 * whole purpose is to be identical everywhere — and the failure mode is a note
 * that silently never resolves, on a paper nobody changed.
 *
 * **Nothing is fabricated.** Per-target rectangles are the selection's own boxes
 * intersected with the paragraph's own boxes — geometry the browser measured and
 * the extractor measured, combined. A multi-paragraph selection gets one set per
 * paragraph rather than every paragraph claiming the whole page's selection.
 * Quote fragments are the paragraph's *canonical source text*, not a slice at a
 * character offset this code would have to guess.
 */
import type { Bbox, IrBlock, IrParagraph } from "@/api/ir";
import type { DocumentIr } from "@/api/ir";
import type { Bbox as SelectionBbox } from "@/api/ir";
import type { PdfRect } from "@/qa/selection";
import {
  MIN_HORIZONTAL_OVERLAP_PT,
  MIN_INTERSECTION_FRACTION,
  MIN_INTERSECTION_PT2,
  MIN_VERTICAL_COVERAGE,
  matchParagraphs,
  textSupports,
  type SelectionMapping,
} from "@/qa/selection";

/** How much source either side of a target is kept, for disambiguation. */
export const CONTEXT_CHARS = 64;

export interface TargetSource {
  /** What kind of source unit this names — `paragraph`, or a caption class. */
  sourceClass: string;
  sourceAnchorId: string;
  anchorVersion: string;
  pageNumber: number;
  /** The paragraph's own envelope, in source-PDF points. */
  bbox: Bbox;
  /** The part of the selection that falls inside this paragraph. */
  rects: Bbox[];
  /** The paragraph's canonical text — what a reattachment matches against. */
  quote: string;
  prefix: string;
  suffix: string;
}

/** Overlap of two boxes, or zero when they do not meet. */
function overlap(a: SelectionBbox, b: Bbox): { w: number; h: number } {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return { w: Math.max(0, w), h: Math.max(0, h) };
}

/** The selection rectangles that actually touch this paragraph. */
function rectsForParagraph(paragraph: IrParagraph, boxes: SelectionBbox[]): Bbox[] {
  const found: Bbox[] = [];
  for (const rect of boxes) {
    for (const box of paragraph.bboxes) {
      const { w, h } = overlap(rect, box);
      // A sliver of overlap is a rectangle grazing an adjacent column, not a
      // highlight of it. The same guard the matcher uses, for the same reason.
      if (w < 1 || h < 1) continue;
      found.push([
        Math.max(rect[0], box[0]),
        Math.max(rect[1], box[1]),
        Math.min(rect[2], box[2]),
        Math.min(rect[3], box[3]),
      ]);
    }
  }
  return found;
}

/**
 * What a selection covered, as the two domains need it.
 *
 * Deliberately *not* a `SelectionMapping`: that type is the QA scope's answer to
 * "what may a question be scoped to", and it is paragraph-only by design. This
 * is the raw geometry both domains read, which is why one drag can be a valid
 * note and an invalid question at the same time.
 */
export interface AnnotationSelection {
  rects: Record<number, Bbox[]>;
  text: string;
}

export function buildAnnotationTargets(
  ir: DocumentIr,
  selection: AnnotationSelection | SelectionMapping,
): TargetSource[] {
  const rectsByPage = selection.rects ?? {};
  const selectedText = selection.text ?? "";

  const asPdfRects = () => {
    const converted = new Map<number, PdfRect[]>();
    for (const [page, boxes] of Object.entries(rectsByPage)) {
      converted.set(
        Number(page),
        boxes.map((box) => ({ x0: box[0], y0: box[1], x1: box[2], y1: box[3] })),
      );
    }
    return converted;
  };

  /* The paragraph ids are matched here when the caller did not supply them.
   *
   * The annotation path is handed **geometry** and nothing else, because the QA
   * mapping is paragraph-only by design and a caption selection has none. That
   * means this function has to answer "which paragraphs did the drag cover?"
   * itself — and it does, with the same matcher the QA path uses on the same
   * rects, so the two agree by construction rather than by coincidence. */
  const paragraphIds =
    "paragraphIds" in selection
      ? (selection as SelectionMapping).paragraphIds
      : matchParagraphs(asPdfRects(), ir.paragraphs, selectedText).paragraphIds;

  const byId = new Map(ir.paragraphs.map((paragraph) => [paragraph.id, paragraph]));
  const order = new Map(ir.paragraphs.map((paragraph, index) => [paragraph.id, index]));
  const ordered = [...paragraphIds].sort(
    (left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0),
  );

  const sources: TargetSource[] = [];
  for (const id of ordered) {
    const paragraph = byId.get(id);
    if (!paragraph || !paragraph.bboxes.length) continue;
    if (!paragraph.source_anchor_id) continue;

    const boxes = (rectsByPage[paragraph.page_number] ?? []) as SelectionBbox[];
    const rects = rectsForParagraph(paragraph, boxes);
    const envelope = envelopeOfParagraph(paragraph);

    const index = order.get(id) ?? 0;
    const before = ir.paragraphs[index - 1];
    const after = ir.paragraphs[index + 1];

    sources.push({
      sourceClass: "paragraph",
      sourceAnchorId: paragraph.source_anchor_id,
      anchorVersion: "1",
      pageNumber: paragraph.page_number,
      bbox: envelope,
      // A paragraph whose text the selection only partly covers still gets its own
      // envelope when no line box could be attributed — better a box that is too
      // generous around the right paragraph than a missing highlight.
      rects: rects.length > 0 ? rects : [envelope],
      quote: paragraph.text,
      prefix: before ? before.text.slice(-CONTEXT_CHARS) : "",
      suffix: after ? after.text.slice(0, CONTEXT_CHARS) : "",
    });
  }

  sources.push(...buildBlockTargets(ir, rectsByPage, selectedText));

  /* One order across both domains. Page then top coordinate is the key they
     share, and it is the page's own order — a note spanning a paragraph, the
     figure under it and the caption below that must read the way the paper
     does. Sorting by kind instead would put every caption after every
     paragraph, which is a reading order no page has. */
  sources.sort((left, right) => {
    const leftKey = sourceOrderKey(left.pageNumber, left.bbox[1]);
    const rightKey = sourceOrderKey(right.pageNumber, right.bbox[1]);
    return leftKey - rightKey;
  });
  return sources;
}

/** One target per non-prose block the selection's own geometry covered. */
function buildBlockTargets(
  ir: DocumentIr,
  rectsByPage: Record<number, Bbox[]>,
  selectedText: string,
): TargetSource[] {
  const blocks = anchorableBlocks(ir);
  if (blocks.length === 0) return [];

  const asPdfRects = new Map<number, PdfRect[]>();
  for (const [page, boxes] of Object.entries(rectsByPage)) {
    asPdfRects.set(
      Number(page),
      boxes.map((box) => ({ x0: box[0], y0: box[1], x1: box[2], y1: box[3] })),
    );
  }

  const matched = new Set(matchBlocks(asPdfRects, blocks, selectedText));
  const sources: TargetSource[] = [];
  for (const block of blocks) {
    if (!matched.has(block.id)) continue;
    const boxes = rectsByPage[block.page_number] ?? [];
    const rects = rectsForBlock(block, boxes);
    const all = anchorableBlocks(ir);
    const index = all.findIndex((candidate) => candidate.id === block.id);
    const before = all[index - 1];
    const after = all[index + 1];

    sources.push({
      sourceClass: block.layout_class,
      sourceAnchorId: block.source_anchor_id,
      anchorVersion: "1",
      pageNumber: block.page_number,
      bbox: block.bbox,
      rects: rects.length > 0 ? rects : [block.bbox],
      // The block's canonical text, not the drag's: it is what a reattachment
      // matches against, and a caption's own words are the identity — the part
      // of it the reader happened to drag across is not.
      quote: block.text,
      prefix: before ? before.text.slice(-CONTEXT_CHARS) : "",
      suffix: after ? after.text.slice(0, CONTEXT_CHARS) : "",
    });
  }
  return sources;
}

// --- non-prose source units (DS-QA-013) ---------------------------------------

/**
 * The layout classes a reader may persistently annotate.
 *
 * Mirrors `ANCHORABLE_CLASSES` on the backend, and it is a *closed* set on both
 * sides: the API rejects anything else, so a class added here without being
 * added there would fail visibly rather than store a target nothing can resolve.
 *
 * Why these four and not more, measured on five real papers:
 *
 *   - `figure` and `table` hold run-together fragments — a probe of a real
 *     figure block's text layer read `"identityweight layerweight layerrelu…"`.
 *     Persisting that as a quote would store a sentence nobody wrote.
 *   - `abandon` is page furniture: the arXiv stamp, running footnotes, page
 *     numbers. Not the paper's content.
 *   - `title` covers 163 blocks against 100 captions, and the layout model
 *     mislabels prose fragments as headings — `"greatly benefited from very deep
 *     models."` is tagged `title` in two of the audited papers.
 */
export const ANCHORABLE_BLOCK_CLASSES = [
  "figure_caption",
  "table_caption",
  "formula_caption",
  "isolate_formula",
] as const;

export type AnchorableBlockClass = (typeof ANCHORABLE_BLOCK_CLASSES)[number];

/**
 * Every block a query may match, in the document's own reading order.
 *
 * Reading order is the IR's: `PageIR.blocks` is already ordered by the
 * reading-order pass, so this re-sorts nothing and cannot disagree with it.
 */
export function anchorableBlocks(ir: DocumentIr): IrBlock[] {
  const wanted = new Set<string>(ANCHORABLE_BLOCK_CLASSES);
  return ir.pages
    .slice()
    .sort((left, right) => left.page_number - right.page_number)
    .flatMap((page) => page.blocks)
    .filter(
      (block) =>
        wanted.has(block.layout_class) && block.text.trim() !== "" && block.source_anchor_id,
    );
}

/**
 * A canonical position for ordering targets across **both** source domains.
 *
 * Paragraphs and blocks are ordered by different structures — `ir.paragraphs`
 * is a reading-order list, `PageIR.blocks` is a per-page one — so an annotation
 * holding both needs a key they share. Page then top coordinate is that key, and
 * it reflects where the content actually sits.
 *
 * Deliberately not "all paragraphs, then all captions": a note spanning a
 * paragraph, the figure under it and the caption below that must read in the
 * order the page does. Measured on the ResNet extraction, a figure caption at
 * y=304 sits *below* the paragraph above it and above the one after.
 */
function envelopeOfParagraph(paragraph: IrParagraph): Bbox {
  return [
    Math.min(...paragraph.bboxes.map((b) => b[0])),
    Math.min(...paragraph.bboxes.map((b) => b[1])),
    Math.max(...paragraph.bboxes.map((b) => b[2])),
    Math.max(...paragraph.bboxes.map((b) => b[3])),
  ];
}

/** The line rectangles of a block the selection actually covered. */
function rectsForBlock(block: IrBlock, boxes: SelectionBbox[]): Bbox[] {
  const found: Bbox[] = [];
  for (const rect of boxes) {
    const { w, h } = overlap(rect, block.bbox);
    // A sliver is the selection grazing the block beside the one the reader
    // meant. The same guard the paragraph path uses, for the same reason.
    if (w < 1 || h < 1) continue;
    found.push([
      Math.max(rect[0], block.bbox[0]),
      Math.max(rect[1], block.bbox[1]),
      Math.min(rect[2], block.bbox[2]),
      Math.min(rect[3], block.bbox[3]),
    ]);
  }
  return found;
}

export function sourceOrderKey(pageNumber: number, top: number): number {
  return pageNumber * 1_000_000 + top;
}

/** The blocks whose own boxes the selection actually covered. */
export function matchBlocks(
  rectsByPage: Map<number, { x0: number; y0: number; x1: number; y1: number }[]>,
  blocks: readonly IrBlock[],
  selectedText: string,
): string[] {
  const totalArea = [...rectsByPage.values()]
    .flat()
    .reduce((sum, rect) => sum + (rect.x1 - rect.x0) * (rect.y1 - rect.y0), 0);
  const areaThreshold = Math.min(
    MIN_INTERSECTION_PT2,
    MIN_INTERSECTION_FRACTION * totalArea,
  );

  const accepted: string[] = [];
  for (const block of blocks) {
    const rects = rectsByPage.get(block.page_number);
    if (!rects || rects.length === 0) continue;

    let area = 0;
    for (const rect of rects) {
      const dx = Math.max(0, Math.min(rect.x1, block.bbox[2]) - Math.max(rect.x0, block.bbox[0]));
      const dy = Math.max(0, Math.min(rect.y1, block.bbox[3]) - Math.max(rect.y0, block.bbox[1]));
      if (dx < MIN_HORIZONTAL_OVERLAP_PT) continue;
      const lineHeight = Math.min(rect.y1 - rect.y0, block.bbox[3] - block.bbox[1]);
      if (lineHeight <= 0 || dy / lineHeight < MIN_VERTICAL_COVERAGE) continue;
      area += dx * dy;
    }
    if (area < areaThreshold) continue;

    // Geometry proposes, text disposes — the same rule the paragraph matcher
    // uses, and for the same reason: a caption's rectangle is a real overlap and
    // a false identity when the reader selected the table beside it.
    if (textSupports(selectedText, block.text)) accepted.push(block.id);
  }
  return accepted;
}
