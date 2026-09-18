import type { DocumentIr, IrParagraph, IrPage } from "@/api/ir";

/**
 * Which section is the reader in?
 *
 * The rule the criteria froze (AC-P0-07), and the reason the obvious answer is
 * wrong:
 *
 *   **A rule based on vertical position alone is broken on a two-column page.**
 *   Measured on ResNet page 3, the block order is left column (x≈49, y 73→647)
 *   *then* right column (x≈308, y 73→…). A right-column block at y=73 follows a
 *   left-column block at y=647 in reading order, so "the heading nearest the top
 *   of the viewport" reports the wrong column for most of the page.
 *
 *   **A rule based on the page alone is broken on a multi-section page.** The
 *   same page carries paragraphs from four sections — `2. Related Work`, `3.1`,
 *   `3.2`, `3.3` — and the page-based lookup this replaces
 *   (`selectSectionForPage`) returned `3.3` for all of them, including the
 *   reader at the top of the page in `2. Related Work`.
 *
 * So the position is expressed in **canonical reading order**: how far through
 * the page's content the reader is, not how far down the screen they are. The
 * page's blocks are already in reading order, so walking them accumulates
 * content the way a reader consumes it, and the two-column inversion cannot
 * arise — the left column is simply earlier in the sequence.
 *
 * The trade this makes, stated rather than hidden: a page whose *rendered*
 * proportions differ wildly from its content proportions (one very tall table
 * beside many short lines) maps the scroll position onto the sequence
 * approximately. It is stable, deterministic, and never claims a section the
 * reader has not reached; it is not a pixel-exact read-head.
 */

/** Where the reader is: a page, and how far down it, in PDF points. */
export interface ReadingPosition {
  pageNumber: number;
  offsetPt: number;
}

export function pageOf(ir: DocumentIr, pageNumber: number): IrPage | undefined {
  return ir.pages.find((page) => page.page_number === pageNumber);
}

/**
 * `block_id` -> `section_id`, from the paragraphs that own those blocks.
 *
 * Headings and formulas belong to no paragraph, so they are absent here and are
 * skipped when the anchor lands on one — the reader is then in the section the
 * next prose block belongs to, which is the section that heading opened.
 */
export function blockSections(paragraphs: IrParagraph[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  // Tolerant of a partial IR on purpose: this runs on every mount of the shell,
  // and a document whose IR predates a field must not take the reader down.
  for (const paragraph of paragraphs ?? []) {
    if (!paragraph.section_id) continue;
    for (const blockId of paragraph.block_ids) {
      if (!map.has(blockId)) map.set(blockId, paragraph.section_id);
    }
  }
  return map;
}

/**
 * The section governing `position`, or `null` when the page cannot say.
 *
 * `null` is a real answer: a page with no mapped prose — a plate of figures, the
 * references — has no section to report, and inventing one from the previous
 * page would make the outline claim the reader is somewhere they are not.
 */
export function sectionAtReadingPosition(
  page: IrPage,
  offsetPt: number,
  sections: Map<string, string>,
): string | null {
  const total = (page.blocks ?? []).reduce(
    (sum, block) => sum + Math.max(0, block.bbox[3] - block.bbox[1]),
    0,
  );
  if (total <= 0 || page.height_pt <= 0) return null;

  const progress = Math.min(Math.max(offsetPt / page.height_pt, 0), 1);
  const target = progress * total;

  let consumed = 0;
  for (const block of page.blocks) {
    consumed += Math.max(0, block.bbox[3] - block.bbox[1]);
    if (consumed < target) continue;
    const section = sections.get(block.id);
    if (section) return section;
    // A heading or formula block: keep walking forward rather than reporting the
    // previous block's section, which would leave the reader one section behind
    // for the whole of the section they just entered.
  }

  // Past the end of the mapped content: the last section on the page governs.
  for (let at = page.blocks.length - 1; at >= 0; at -= 1) {
    const section = sections.get(page.blocks[at].id);
    if (section) return section;
  }
  return null;
}

/**
 * The section for a whole-document position, falling back to the nearest earlier
 * page that can answer.
 *
 * The fallback exists because whole pages of figures and reference lists map to
 * no section, and blanking the outline highlight there reads as "the outline
 * broke" rather than "this page belongs to nothing". It walks **backwards only**:
 * looking forwards would name a section the reader has not reached yet.
 */
export function activeSection(
  ir: DocumentIr,
  position: ReadingPosition,
  sections: Map<string, string>,
): string | null {
  for (let page = position.pageNumber; page >= 1; page -= 1) {
    const model = pageOf(ir, page);
    if (!model) continue;
    const offset = page === position.pageNumber ? position.offsetPt : Number.MAX_VALUE;
    const found = sectionAtReadingPosition(model, offset, sections);
    if (found) return found;
  }
  return null;
}
