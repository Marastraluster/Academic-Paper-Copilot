/**
 * Figures, tables and display formulas: the paper's own pixels, cropped.
 *
 * Everything else in the reflowed reading is re-typeset prose, and that is the
 * point of the view. These three classes are the exception, because their pixels
 * *are* the content: a formula's extracted text is scrambled (`LInfoNCE = −1
 * \n2B\nB\nX\ni=1`), and a figure is a drawing.
 *
 * So a page is rendered once through PDF.js at the live scale and
 * `devicePixelRatio`, and each crop is a copy of one rectangle out of it. A
 * zoom re-renders — a crop is never an upscaled bitmap, which is what "zoomable
 * without squinting" has to mean.
 *
 * Two things here are load-bearing, and both were defects in the view this one
 * replaces, found only by running it in a real browser:
 *
 * 1. **A released bitmap must not be reachable.** The raster is published as
 *    *state*, never read from a ref during a render: a ref can hand a child a
 *    canvas the cleanup has already emptied, and `drawImage` **throws** on a
 *    canvas with no pixels — from inside a React effect, where the error
 *    boundary takes the whole view down.
 * 2. **A measurement of zero is not a size.** Nothing is drawn from a raster
 *    with no width or height; it is a page that has not been rendered yet.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";

import type { Box } from "@/bilingual/reflow/stream";
import type { PdfjsModule } from "@/pdf/pdfjs";

export type Raster = HTMLCanvasElement | null;

interface Registry {
  rasters: Map<number, HTMLCanvasElement>;
  pending: Set<number>;
}

/**
 * One render per page, shared by every crop on it.
 *
 * `version` exists because the map is a ref: a crop cannot re-render when a
 * render finishes unless something tells it to, and publishing the rasters
 * themselves as state would copy a page-sized bitmap into the store on every
 * page. The version is the cheap signal; the map is the data.
 */
export function usePageRasters(
  pdf: PDFDocumentProxy,
  pdfjs: PdfjsModule,
  scale: number,
): { rasterFor: (page: number) => Raster; request: (page: number) => void; version: number } {
  const registry = useRef<Registry>({ rasters: new Map(), pending: new Set() });
  const tasks = useRef<Map<number, RenderTask>>(new Map());
  const [version, setVersion] = useState(0);

  const release = useCallback(() => {
    for (const task of tasks.current.values()) task.cancel();
    tasks.current.clear();
    for (const canvas of registry.current.rasters.values()) {
      // Hand the memory back rather than waiting for a garbage collection that
      // may not come while the reader keeps scrolling.
      canvas.width = 0;
      canvas.height = 0;
    }
    registry.current.rasters.clear();
    registry.current.pending.clear();
    setVersion((value) => value + 1);
  }, []);

  // A new scale means every raster is the wrong resolution.
  useEffect(() => {
    release();
  }, [release, scale, pdf]);

  useEffect(() => release, [release]);

  const request = useCallback(
    (pageNumber: number) => {
      const state = registry.current;
      if (state.rasters.has(pageNumber) || state.pending.has(pageNumber)) return;
      state.pending.add(pageNumber);

      void (async () => {
        let task: RenderTask | null = null;
        try {
          const page = await pdf.getPage(pageNumber);
          const viewport = page.getViewport({ scale });
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
          if (state.pending.has(pageNumber)) {
            state.rasters.set(pageNumber, canvas);
            state.pending.delete(pageNumber);
            setVersion((value) => value + 1);
          }
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
    [pdf, scale],
  );

  const rasterFor = useCallback((pageNumber: number): Raster => {
    return registry.current.rasters.get(pageNumber) ?? null;
  }, []);

  // `pdfjs` is part of the contract so a caller cannot pass a module the page
  // was not rendered with; it is unused here otherwise.
  void pdfjs;

  return { rasterFor, request, version };
}

/** One crop, copied out of the page's own render at the live scale. */
export function CropCanvas({
  raster,
  box,
  scale,
}: {
  raster: Raster;
  box: Box;
  scale: number;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    // No pixels to copy from: `drawImage` throws on a canvas with no width or
    // height rather than drawing nothing, and an exception here is the whole
    // reading gone.
    if (canvas === null || raster === null || raster.width === 0 || raster.height === 0) return;

    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round((box[2] - box[0]) * scale * ratio));
    const height = Math.max(1, Math.round((box[3] - box[1]) * scale * ratio));
    canvas.width = width;
    canvas.height = height;
    canvas.style.width = `${(box[2] - box[0]) * scale}px`;
    canvas.style.height = `${(box[3] - box[1]) * scale}px`;

    const context = canvas.getContext("2d");
    if (context === null) return;
    context.drawImage(
      raster,
      Math.round(box[0] * scale * ratio),
      Math.round(box[1] * scale * ratio),
      width,
      height,
      0,
      0,
      width,
      height,
    );
  }, [raster, box, scale]);

  return <canvas ref={ref} className="block h-auto max-w-full" aria-hidden="true" />;
}
