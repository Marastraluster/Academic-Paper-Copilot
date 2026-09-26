/**
 * What the paper becomes when it is reflowed into a single column.
 *
 * DS-DOC-007 unrolled the page but kept its pixels, and the reader could not
 * read it: two columns of 9.4 pt print on a screen. This is the other trade —
 * the paper's *prose* is set as prose, in this application's typography, and
 * everything that is not prose (a figure, a table, a display formula) is carried
 * as a crop of the page's own render, because those are the things whose pixels
 * are the content.
 *
 * This module is the assembly and nothing else: no DOM, no canvas, no store.
 * It takes the document IR, the sections the extractor derived, and the
 * translation artifact, and returns the list of items a reader will scroll past.
 * Every claim about the result is therefore arithmetic a test can check.
 *
 * ## The two traps it exists to avoid
 *
 * Both were measured on the papers in this library, and both would have looked
 * like content rather than like bugs:
 *
 * 1. **Captions are not in reading order.** Across four papers a caption sits
 *    *before* its figure or table in the IR's block order 36 times and after it
 *    58 — so walking the order puts roughly half of them above the wrong thing.
 *    They are paired here by `caption_of`, and placed by convention: a figure's
 *    caption belongs below it, a table's above it.
 * 2. **`title` blocks are not headings.** The reader's own paper has 23 of them
 *    and 16 sections; the extras are body-font table sub-labels and, in one
 *    case, a sentence fragment ("greatly benefited from very deep models.").
 *    Headings come from `sections`, placed by each section's `heading_block_id`.
 */
import type { DocumentIr, IrBlock, IrPage, IrParagraph, IrSection } from "@/api/ir";
import type { BilingualParagraphView, BilingualSectionView, BilingualView } from "@/api/bilingual";

/** A rectangle in PDF points, top-left origin — the IR's own space. */
export type Box = [number, number, number, number];

export interface ReflowHeading {
  kind: "heading";
  id: string;
  sectionId: string;
  title: string;
  titleTranslated: string | null;
  level: number | null;
  pageNumber: number;
  /** Where the paper put this heading, so a jump can find it. */
  y0: number;
}

export interface ReflowPair {
  kind: "pair";
  id: string;
  paragraphId: string;
  sectionId: string | null;
  pageNumber: number;
  /** The paragraph's own first rectangle's top edge, in PDF points. */
  y0: number;
  sourceText: string;
  translatedText: string | null;
  status: "translated" | "untranslated" | "skipped";
  note: string;
}

export interface ReflowCrop {
  kind: "crop";
  id: string;
  blockId: string;
  pageNumber: number;
  box: Box;
  layoutClass: string;
  /** The crop's own caption, where it belongs relative to the pixels. */
  caption: { text: string; translated: string | null } | null;
  captionSide: "above" | "below" | "beside" | null;
  /** A table's footnotes, which belong directly under its crop. */
  footnote: string | null;
  /**
   * The number an equation is known by — `(1)` — when the paper printed one.
   *
   * Two ways to know it, and the second exists because the first is often
   * absent: the extractor links a caption to its formula with `caption_of`, and
   * **measured on the reader's own paper that link is null for all 6 equation
   * numbers**. What survives is geometry — the number is set beside the formula
   * it belongs to — so an unlinked number is claimed by the formula whose
   * vertical middle it shares.
   */
  number: string | null;
}

/** Said once, where the references begin: they are not translated, on purpose. */
export interface ReflowNotice {
  kind: "notice";
  id: string;
  text: string;
}

export type ReflowItem = ReflowHeading | ReflowPair | ReflowCrop | ReflowNotice;

/** How close a number must sit to a formula to belong to it, in PDF points. */
export const NUMBER_PAIRING_PT = 20;

const FURNITURE = "abandon";
const CROP_CLASSES = new Set(["figure", "table", "isolate_formula"]);
const CAPTION_SIDE: Record<string, "above" | "below" | "beside"> = {
  figure_caption: "below",
  table_caption: "above",
  formula_caption: "beside",
};

/** The classes that give a crop its caption — the paper's own naming. */
export function captionSideOf(layoutClass: string): "above" | "below" | "beside" | null {
  if (layoutClass === "figure") return "below";
  if (layoutClass === "table") return "above";
  if (layoutClass === "isolate_formula") return "beside";
  return null;
}

function boxOf(block: IrBlock): Box {
  return [block.bbox[0], block.bbox[1], block.bbox[2], block.bbox[3]];
}

/**
 * The reading column.
 *
 * Items are emitted in the extractor's reading order — which is column-major on
 * every page measured — with one exception the criteria froze: a heading is
 * emitted when the flow reaches the block it came from, and a crop absorbs its
 * own caption, which is then *not* emitted again where the caption block sits.
 */
export function reflowStream(
  ir: DocumentIr,
  view: BilingualView | null,
): ReflowItem[] {
  const paragraphsById = new Map<string, IrParagraph>();
  const paragraphByBlock = new Map<string, IrParagraph>();
  for (const paragraph of ir.paragraphs) {
    paragraphsById.set(paragraph.id, paragraph);
    for (const blockId of paragraph.block_ids) paragraphByBlock.set(blockId, paragraph);
  }

  const translated = new Map<string, BilingualParagraphView>();
  for (const paragraph of view?.paragraphs ?? []) translated.set(paragraph.paragraph_id, paragraph);

  const sectionsById = new Map<string, IrSection>();
  const headingByBlock = new Map<string, IrSection>();
  for (const section of ir.sections ?? []) {
    sectionsById.set(section.id, section);
    if (section.heading_block_id !== null && section.heading_block_id !== undefined) {
      headingByBlock.set(section.heading_block_id, section);
    }
  }
  const translatedSection = new Map<string, BilingualSectionView>();
  for (const section of view?.sections ?? []) translatedSection.set(section.section_id, section);

  // Captions and footnotes, indexed by the block they belong to, so the walk
  // never has to care where in the order the extractor happened to put them.
  const captions = new Map<string, IrBlock[]>();
  const footnotes = new Map<string, string[]>();
  const absorbed = new Set<string>();

  /** Numbers already attached to a formula, so two cannot claim the same one. */
  const claimed = new Set<string>();
  const items: ReflowItem[] = [];
  const emitted = new Set<string>();
  const noticeSections = new Set<string>();

  const emitHeading = (section: IrSection, block: IrBlock): void => {
    items.push({
      kind: "heading",
      id: `h_${section.id}`,
      sectionId: section.id,
      title: section.title,
      titleTranslated: translatedSection.get(section.id)?.title_translated ?? null,
      level: section.level,
      pageNumber: block.page_number,
      y0: block.bbox[1],
    });
  };

  const emitPair = (paragraph: IrParagraph): void => {
    const entry = translated.get(paragraph.id);
    items.push({
      kind: "pair",
      id: `p_${paragraph.id}`,
      paragraphId: paragraph.id,
      sectionId: paragraph.section_id ?? null,
      pageNumber: paragraph.page_number,
      y0: paragraph.bboxes.length > 0 ? Math.min(...paragraph.bboxes.map((box) => box[1])) : 0,
      sourceText: paragraph.text,
      translatedText: entry?.translated_text ?? null,
      status: entry?.status ?? "untranslated",
      note: entry?.note ?? "",
    });
  };

  const emitCrop = (block: IrBlock, page: IrPage): void => {
    const own = captions.get(block.id) ?? [];
    const first = own[0];
    const side = captionSideOf(block.layout_class);
    const notes = footnotes.get(block.id) ?? [];
    items.push({
      kind: "crop",
      id: `c_${block.id}`,
      blockId: block.id,
      pageNumber: block.page_number,
      box: boxOf(block),
      layoutClass: block.layout_class,
      caption: first === undefined ? null : { text: first.text, translated: null },
      captionSide: side,
      footnote: notes.length > 0 ? notes.join(" ") : null,
      number: numberFor(block, page),
    });
    for (const caption of own) absorbed.add(caption.id);
  };

  // --- index captions and footnotes against their targets ---------------------
  for (const page of ir.pages) {
    for (const block of page.blocks) {
      const target = block.caption_of;
      if (target === null || target === undefined || target === "") continue;
      const list = captions.get(target);
      if (list === undefined) captions.set(target, [block]);
      else list.push(block);
    }
  }

  /** A page's equation numbers that no `caption_of` link claims. */
  const unlinkedNumbers = (page: IrPage): IrBlock[] =>
    page.blocks.filter(
      (block) =>
        (block.caption_of === null || block.caption_of === undefined) &&
        (block.layout_class === "formula_caption" ||
          /^\(\s*\d+\s*\)$/.test((block.text ?? "").trim())),
    );

  const midY = (box: Box): number => (box[1] + box[3]) / 2;

  /** The number to print beside a formula, or null when the paper printed none. */
  const numberFor = (block: IrBlock, page: IrPage): string | null => {
    const linked = captions.get(block.id) ?? [];
    if (linked.length > 0) return (linked[0]!.text ?? "").trim();
    if (block.layout_class !== "isolate_formula") return null;
    let best: IrBlock | null = null;
    let bestDistance = NUMBER_PAIRING_PT;
    for (const candidate of unlinkedNumbers(page)) {
      if (claimed.has(candidate.id)) continue;
      const distance = Math.abs(midY(candidate.bbox) - midY(block.bbox));
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    if (best === null) return null;
    claimed.add(best.id);
    return (best.text ?? "").trim();
  };

  // --- the walk ---------------------------------------------------------------
  for (const page of ir.pages) {
    for (const block of page.blocks) {
      if (block.layout_class === FURNITURE) continue;
      if (absorbed.has(block.id)) continue;

      const section = headingByBlock.get(block.id);
      if (section !== undefined && !emitted.has(section.id)) {
        emitted.add(section.id);
        emitHeading(section, block);
        continue;
      }

      if (CROP_CLASSES.has(block.layout_class)) {
        emitCrop(block, page);
        continue;
      }

      if (block.layout_class === "table_footnote") {
        // Its table is elsewhere in the order; attach by name when the IR says
        // so, and otherwise leave it where it lies rather than guess.
        const target = block.caption_of;
        if (target !== null && target !== undefined) {
          const list = footnotes.get(target);
          if (list === undefined) footnotes.set(target, [block.text]);
          else list.push(block.text);
          absorbed.add(block.id);
          continue;
        }
        continue;
      }

      if (Object.keys(CAPTION_SIDE).includes(block.layout_class)) continue;
      // An unlinked `(1)` is not prose either; it belongs to its formula.
      if (/^\(\s*\d+\s*\)$/.test((block.text ?? "").trim())) continue;

      const paragraph = paragraphByBlock.get(block.id);
      if (paragraph === undefined) continue;
      if (emitted.has(paragraph.id)) continue;

      const owner = paragraph.section_id === null ? undefined : sectionsById.get(paragraph.section_id ?? "");
      if (owner?.is_references === true) {
        if (!noticeSections.has(owner.id)) {
          noticeSections.add(owner.id);
          items.push({
            kind: "notice",
            id: `n_${owner.id}`,
            text: "本文的参考文献保留原文，不予翻译。",
          });
        }
      }

      emitted.add(paragraph.id);
      emitPair(paragraph);
    }
  }

  return items;
}

/** The page a flow item came from, for the reading position reporting. */
export function pageOf(item: ReflowItem): number {
  if (item.kind === "notice") return 0;
  return item.pageNumber;
}

/** The page of the paper an item sits on; 0 for a notice, which is not placed. */
export function itemPage(item: ReflowItem): number {
  return item.kind === "notice" ? 0 : item.pageNumber;
}

/** Where on that page the item begins, in PDF points — for an outline jump. */
export function itemY0(item: ReflowItem): number {
  if (item.kind === "notice") return 0;
  return item.kind === "crop" ? item.box[1] : item.y0;
}

/** Where a section's heading sits in the stream, for an outline jump. */
export function headingIndex(items: ReflowItem[], sectionId: string): number {
  return items.findIndex((item) => item.kind === "heading" && item.sectionId === sectionId);
}

export type { DocumentIr, IrPage };
