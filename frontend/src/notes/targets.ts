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
import type { Bbox, IrParagraph } from "@/api/ir";
import type { DocumentIr } from "@/api/ir";
import type { Bbox as SelectionBbox } from "@/api/ir";
import type { SelectionMapping } from "@/qa/selection";

/** How much source either side of a target is kept, for disambiguation. */
export const CONTEXT_CHARS = 64;

export interface TargetSource {
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
function rectsFor(paragraph: IrParagraph, boxes: SelectionBbox[]): Bbox[] {
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

export function buildAnnotationTargets(
  ir: DocumentIr,
  mapping: SelectionMapping,
): TargetSource[] {
  if (mapping.paragraphIds.length === 0) return [];

  const byId = new Map(ir.paragraphs.map((paragraph) => [paragraph.id, paragraph]));
  const order = new Map(ir.paragraphs.map((paragraph, index) => [paragraph.id, index]));
  const ordered = [...mapping.paragraphIds].sort(
    (left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0),
  );

  const sources: TargetSource[] = [];
  for (const id of ordered) {
    const paragraph = byId.get(id);
    if (!paragraph || !paragraph.bboxes.length) continue;
    if (!paragraph.source_anchor_id) continue;

    const boxes = (mapping.rects[paragraph.page_number] ?? []) as SelectionBbox[];
    const rects = rectsFor(paragraph, boxes);
    const envelope: Bbox = [
      Math.min(...paragraph.bboxes.map((b) => b[0])),
      Math.min(...paragraph.bboxes.map((b) => b[1])),
      Math.max(...paragraph.bboxes.map((b) => b[2])),
      Math.max(...paragraph.bboxes.map((b) => b[3])),
    ];

    const index = order.get(id) ?? 0;
    const before = ir.paragraphs[index - 1];
    const after = ir.paragraphs[index + 1];

    sources.push({
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
  return sources;
}
