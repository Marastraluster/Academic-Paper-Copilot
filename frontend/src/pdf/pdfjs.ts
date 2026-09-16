/**
 * PDF.js configuration.
 *
 * The worker is imported with Vite's `?url` suffix so it is emitted as a real
 * asset and referenced by URL. The alternative — inlining it or pointing at a
 * CDN — either breaks the production build or violates the local-first
 * guarantee by fetching code from a third party.
 *
 * Resolving this wrongly is a classic trap: it works under `npm run dev` (where
 * Vite serves modules on demand) and fails in the built bundle. `npm run build`
 * plus the preview-based runtime check exist to catch exactly that.
 */
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

export type PdfjsModule = typeof import("pdfjs-dist");

let modulePromise: Promise<PdfjsModule> | null = null;

/**
 * Load PDF.js on demand.
 *
 * PDF.js is roughly half a megabyte, and the reader shell is useful before any
 * document is open — an empty workspace, a settings screen, the assistant. So it
 * is fetched when a PDF is actually opened, keeping it in its own asynchronous
 * chunk rather than in the initial bundle.
 *
 * The import is cached: two viewer instances opening a document concurrently
 * share one module instance, which matters because `GlobalWorkerOptions` is
 * module-global state.
 */
export function loadPdfjs(): Promise<PdfjsModule> {
  if (!modulePromise) {
    modulePromise = import("pdfjs-dist").then((module) => {
      module.GlobalWorkerOptions.workerSrc = workerUrl;
      return module;
    });
  }
  return modulePromise;
}

/** Discrete zoom steps offered by the toolbar (AC-017). */
export const ZOOM_STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0] as const;

export const MIN_ZOOM = ZOOM_STEPS[0];
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

/** Horizontal padding subtracted when computing a fit-width scale (AC-018). */
export const FIT_WIDTH_PADDING_PX = 32;

/** How far outside the viewport pages are still rendered (AC-015). */
export const RENDER_BUFFER_MARGIN_PX = 300;

export function clampZoom(scale: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}

/** The next discrete step above `scale`, or the maximum. */
export function zoomIn(scale: number): number {
  const next = ZOOM_STEPS.find((step) => step > scale + 1e-6);
  return next ?? MAX_ZOOM;
}

/** The next discrete step below `scale`, or the minimum. */
export function zoomOut(scale: number): number {
  const lower = [...ZOOM_STEPS].reverse().find((step) => step < scale - 1e-6);
  return lower ?? MIN_ZOOM;
}
