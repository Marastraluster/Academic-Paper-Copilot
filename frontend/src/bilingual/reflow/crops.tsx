/**
 * Figures, tables and display formulas: the paper's own pixels, cropped.
 *
 * Everything else in the reflowed reading is re-typeset prose, and that is the
 * point of the view. These three classes are the exception, because their pixels
 * *are* the content: a formula's extracted text is scrambled (`LInfoNCE = −1
 * \n2B\nB\nX\ni=1`), and a figure is a drawing.
 *
 * So a page is rendered once through PDF.js and each crop is a copy of one
 * rectangle out of it. A zoom re-renders — a crop is never an upscaled bitmap,
 * which is what "zoomable without squinting" has to mean.
 *
 * ## The two things that make this module delicate
 *
 * 1. **A released bitmap must not be reachable.** The raster is published as
 *    *state*, never read from a ref during a render: a ref can hand a child a
 *    canvas the cleanup has already emptied, and `drawImage` **throws** on a
 *    canvas with no pixels — from inside a React effect, where the error
 *    boundary takes the whole view down. Both halves of that were defects in the
 *    view this one replaces, found only by running it in a real browser.
 * 2. **A raster is tens of megabytes.** Measured: a letter page at scale 1.25,
 *    `devicePixelRatio` 2 and the formula magnification below is 612 × 792 pt
 *    × 1.25 × 2 × 1.71 → ~29.6 MB of backing store. The first version of this
 *    cache never evicted, so scrolling a 14-page paper held ≈ 414 MB. It is
 *    bounded here, and the browser harness scrolls the whole paper and back to
 *    prove the crops still paint after an eviction.
 *
 * ## Why the crops are drawn larger than the paper set them
 *
 * The reader's verdict on the first reflow was *"字体和公式排版不够好看"*, and the
 * measured cause for the formula half of it is size: display formulas in these
 * papers are set at **6.5–10 pt** while the prose beside them is 16 px, so a
 * formula read as fine print. The crop is vector content, so drawing it larger
 * is *sharp* — this is a re-render, not a scale-up of a bitmap.
 *
 * The magnification is one number per document, `inkOf`'s job: the prose size
 * over the size the paper set its formulas in. A fixed factor would fit exactly
 * one paper — measured, the same 1.71 draws a 6.5 pt formula at 11 px and a
 * 10 pt one at 17 px (AC_CHANGE_REQUEST 1 in `docs/acceptance/DS-DOC-009.md`).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";

import type { Box } from "@/bilingual/reflow/stream";
import type { PdfjsModule } from "@/pdf/pdfjs";

export type Raster = HTMLCanvasElement | null;

/** The prose size these crops are drawn to match, in CSS pixels. */
export const PROSE_PX = 16;

/** Below this, a formula is a footnote; above it, a headline. */
export const MIN_MAGNIFICATION = 1.0;
export const MAX_MAGNIFICATION = 2.5;

/** How many page rasters may be held at once — see the memory note above. */
export const RASTER_CACHE_LIMIT = 3;

/**
 * Which pages fall out of the cache when it is over its limit.
 *
 * A pure function so the policy is testable without a browser: `order` is
 * least-recently-used first.
 */
export function pagesToEvict(order: readonly number[], limit = RASTER_CACHE_LIMIT): number[] {
  const over = order.length - limit;
  return over <= 0 ? [] : order.slice(0, over);
}

/**
 * How much larger to draw the paper's formula-level content.
 *
 * `medianInkPt` is the size the paper set its display formulas in, measured from
 * the IR (`TextBlockIR.font_size`); when the extractor did not state one, the
 * fallback is the factor that fits the papers measured here.
 */
export function magnificationFor(medianInkPt: number | null, prosePx = PROSE_PX): number {
  if (medianInkPt === null || medianInkPt <= 0) return 1.71;
  return Math.min(Math.max(prosePx / medianInkPt, MIN_MAGNIFICATION), MAX_MAGNIFICATION);
}

interface Registry {
  rasters: Map<number, HTMLCanvasElement>;
  /** Least-recently-used first, so the oldest can be handed back. */
  order: number[];
  pending: Set<number>;
}

/**
 * One render per page, shared by every crop on it — and bounded.
 *
 * `version` exists because the registry is a ref: a crop cannot re-render when a
 * render finishes unless something tells it to, and publishing the rasters
 * themselves as state would copy a page-sized bitmap into the store per page.
 * The version is the cheap signal; the map is the data.
 */
export function usePageRasters(
  pdf: PDFDocumentProxy,
  pdfjs: PdfjsModule,
  scale: number,
  magnification: number,
): { rasterFor: (page: number) => Raster; request: (page: number) => void; version: number } {
  const registry = useRef<Registry>({ rasters: new Map(), order: [], pending: new Set() });
  const tasks = useRef<Map<number, RenderTask>>(new Map());
  const [version, setVersion] = useState(0);

  const drawScale = scale * magnification;

  const release = useCallback((pageNumber: number) => {
    const canvas = registry.current.rasters.get(pageNumber);
    if (canvas === undefined) return;
    // Hand the memory back rather than waiting for a collection that may not
    // come while the reader keeps scrolling.
    canvas.width = 0;
    canvas.height = 0;
    registry.current.rasters.delete(pageNumber);
    registry.current.order = registry.current.order.filter((page) => page !== pageNumber);
  }, []);

  const releaseAll = useCallback(() => {
    for (const task of tasks.current.values()) task.cancel();
    tasks.current.clear();
    for (const pageNumber of [...registry.current.rasters.keys()]) release(pageNumber);
    registry.current.pending.clear();
    setVersion((value) => value + 1);
  }, [release]);

  // A new scale — or a new magnification — means every raster is wrong.
  useEffect(() => {
    releaseAll();
  }, [releaseAll, drawScale, pdf]);

  useEffect(() => releaseAll, [releaseAll]);

  const rasterFor = useCallback((pageNumber: number): Raster => {
    const canvas = registry.current.rasters.get(pageNumber);
    return canvas ?? null;
  }, []);

  const request = useCallback(
    (pageNumber: number) => {
      const state = registry.current;
      if (state.rasters.has(pageNumber)) {
        // Touching a cached page keeps it; the reader is looking at it.
        state.order = [...state.order.filter((page) => page !== pageNumber), pageNumber];
        return;
      }
      if (state.pending.has(pageNumber)) return;
      state.pending.add(pageNumber);

      void (async () => {
        let task: RenderTask | null = null;
        try {
          const page = await pdf.getPage(pageNumber);
          const viewport = page.getViewport({ scale: drawScale });
          const ratio = window.devicePixelRatio || 1;
          const canvas = window.document.createElement("canvas");
          canvas.width = Math.floor(viewport.width * ratio);
          canvas.height = Math.floor(viewport.height * ratio);
          const context = canvas.getContext("2d");
          if (context === null) {
            state.pending.delete(pageNumber);
            return;
          }
          task = page.render({
            canvas,
            canvasContext: context,
            viewport,
            transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
          });
          tasks.current.set(pageNumber, task);
          await task.promise;
          if (!state.pending.has(pageNumber)) return;

          state.pending.delete(pageNumber);
          state.rasters.set(pageNumber, canvas);
          state.order.push(pageNumber);
          for (const evicted of pagesToEvict(state.order)) release(evicted);
          setVersion((value) => value + 1);
        } catch {
          // Cancellation is routine: a scale change, a page scrolled away, the
          // view unmounted. The next request re-renders it.
          state.pending.delete(pageNumber);
        } finally {
          if (task !== null && tasks.current.get(pageNumber) === task) {
            tasks.current.delete(pageNumber);
          }
        }
      })();
    },
    [pdf, drawScale, release],
  );

  // `pdfjs` is part of the contract so a caller cannot pass a module the page
  // was not rendered with; it is unused here otherwise.
  void pdfjs;

  return { rasterFor, request, version };
}

/**
 * One crop, copied out of the page's own render.
 *
 * `displayWidthPx` is the width it will occupy on screen — already magnified,
 * already clamped to its slot by the caller, because only the caller knows how
 * much room the column has. The copy is made at exactly that width, so what is
 * drawn is what the display needs and no more.
 */
export function CropCanvas({
  raster,
  box,
  drawScale,
  displayWidthPx,
}: {
  raster: Raster;
  /** The source rectangle, in PDF points. */
  box: Box;
  /** The scale the raster was drawn at — `viewScale × magnification`. */
  drawScale: number;
  /** The width this crop occupies on screen, after magnification and clamping. */
  displayWidthPx: number;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (canvas === null) return;

    const ratio = window.devicePixelRatio || 1;
    const boxWidth = Math.max(box[2] - box[0], 0.01);
    const boxHeight = Math.max(box[3] - box[1], 0.01);
    const cssHeight = (displayWidthPx * boxHeight) / boxWidth;

    // The element is sized before the pixels are asked for, so a crop whose page
    // has not been rendered yet — or whose raster has just been handed back to
    // hold the memory down — reserves its place instead of showing the 300 × 150
    // a canvas defaults to and shoving the column around when it fills in.
    canvas.style.width = `${displayWidthPx}px`;
    canvas.style.height = `${cssHeight}px`;
    canvas.width = Math.max(1, Math.round(displayWidthPx * ratio));
    canvas.height = Math.max(1, Math.round(cssHeight * ratio));

    // No pixels to copy from: `drawImage` throws on a canvas with no width or
    // height rather than drawing nothing, and an exception here is the whole
    // reading gone.
    if (raster === null || raster.width === 0 || raster.height === 0) return;

    const context = canvas.getContext("2d");
    if (context === null) return;
    context.drawImage(
      raster,
      Math.round(box[0] * drawScale * ratio),
      Math.round(box[1] * drawScale * ratio),
      Math.round(boxWidth * drawScale * ratio),
      Math.round(boxHeight * drawScale * ratio),
      0,
      0,
      canvas.width,
      canvas.height,
    );
  }, [raster, box, drawScale, displayWidthPx]);

  return <canvas ref={ref} className="block" aria-hidden="true" />;
}
