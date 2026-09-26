/**
 * How tall a page becomes once its translations are in it.
 *
 * The existing viewer can reserve a page's space exactly, because a page's
 * height is `baseSize.height × scale` — the same for every page, known before
 * anything is rendered. Here it is not: a page's height is the paper's height
 * plus the heights of the paragraphs under it, and those depend on how much
 * Chinese each translation runs to. Nothing can know that before the text is
 * laid out.
 *
 * So the height is estimated, the estimate reserves the space, and the real
 * height replaces it as soon as the page has been laid out. A poor estimate is
 * therefore not a wrong number on screen — it is a scroll position that has to
 * be corrected, which is what `InPageBilingualReader` does when it measures.
 *
 * The estimate is deterministic: the same paper gives the same number on every
 * machine and every run, which is what makes it testable.
 */
import type { Insertion, PageFlow } from "@/bilingual/inpage/geometry";

/** The typography of an inserted translation. */
export const INSERTION_LINE_HEIGHT = 1.7;
export const INSERTION_PADDING_PX = 10;
/** Below this a Chinese paragraph stops being readable at 100 % zoom. */
export const INSERTION_MIN_FONT_PT = 10;
/** The visible break where the paper's arrangement changes. */
export const SEAM_PX = 18;

/**
 * The size a translation is set at: the size the paper set its paragraph in.
 *
 * A paper's headings and its body text are different sizes and the translation
 * should follow, or the unrolled page reads as one flat wall. The floor is there
 * because papers set body text around 9–10 pt, which is legible on a page
 * viewed whole and not in a column read on a screen.
 */
export function insertionFontPx(sourceFontPt: number | null, scale: number): number {
  const base = Math.max(sourceFontPt ?? INSERTION_MIN_FONT_PT, INSERTION_MIN_FONT_PT);
  return base * scale;
}

/**
 * One insertion's height, in CSS pixels.
 *
 * Chinese in a column of known width is close to one em per character, which is
 * why this can be arithmetic rather than measurement — and why it is only used
 * for reserving space, never for deciding where anything goes.
 */
export function estimateInsertionHeight(
  text: string | null,
  laneWidthPx: number,
  fontPx: number,
): number {
  const line = fontPx * INSERTION_LINE_HEIGHT;
  if (text === null || text.trim() === "") return line + INSERTION_PADDING_PX;
  const perLine = Math.max(1, Math.floor(laneWidthPx / fontPx));
  return Math.ceil(text.length / perLine) * line + INSERTION_PADDING_PX;
}

/** A page's estimated height, in CSS pixels, at this scale. */
export function estimateFlowHeight(
  flow: PageFlow,
  scale: number,
  sourceFontPt: (insertion: Insertion) => number | null,
): number {
  let total = 0;
  // An insertion is set to the width of the strip it follows, so the width has
  // to be carried through the walk rather than recomputed per insertion.
  let laneWidthPx = flow.widthPt * scale;

  for (const item of flow.items) {
    if (item.kind === "strip") {
      total += (item.strip.box[3] - item.strip.box[1]) * scale;
      laneWidthPx = (item.strip.box[2] - item.strip.box[0]) * scale;
      continue;
    }
    if (item.kind === "seam") {
      total += SEAM_PX;
      continue;
    }
    const fontPx = insertionFontPx(sourceFontPt(item.insertion), scale);
    total += estimateInsertionHeight(
      item.insertion.status === "translated" ? item.insertion.text : "此段未翻译",
      laneWidthPx,
      fontPx,
    );
  }

  return Math.ceil(total);
}
