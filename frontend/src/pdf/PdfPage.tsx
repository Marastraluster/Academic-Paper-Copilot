import { useEffect, useRef } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";

import { type PdfjsModule, RENDER_BUFFER_MARGIN_PX } from "@/pdf/pdfjs";

interface PdfPageProps {
  /** The loaded PDF.js module — passed down so this file never imports it eagerly. */
  pdfjs: PdfjsModule;
  document: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  /** Rendered size at this scale, so the container reserves space before paint. */
  width: number;
  height: number;
  /** False when the page is far from the viewport; the canvas is released. */
  shouldRender: boolean;
  /**
   * Source-PDF boxes to mark on this page, in points, top-left origin.
   *
   * Scaled by the same `scale` the page was rendered at, which is the whole
   * transform: the `DocumentIR` measures from the top-left in points, and so does
   * a PDF.js viewport at rotation 0. Rotated pages are filtered out before they
   * reach here rather than being transformed approximately.
   */
  highlightBoxes?: number[][];
  /**
   * The page's own element, handed up so the viewer can observe it directly.
   * A wrapper element would leave the observer watching a node with no page
   * number on it — which silently rendered nothing at all.
   */
  containerRef?: (element: HTMLDivElement | null) => void;
}

/**
 * One page: a reserved-size container holding a canvas and a text layer.
 *
 * The container always occupies its final geometry — reserved by the parent from
 * page 1's aspect ratio — so scrolling never jumps as pages render. The canvas
 * itself exists only while the page is near the viewport, and its render task is
 * cancelled the moment it leaves, which is what keeps a 200-page document
 * usable.
 */
export function PdfPage({
  pdfjs,
  document,
  pageNumber,
  scale,
  width,
  height,
  shouldRender,
  highlightBoxes = [],
  containerRef,
}: PdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!shouldRender) return;

    let cancelled = false;
    let renderTask: RenderTask | null = null;
    let textLayer: { cancel: () => void } | null = null;

    const run = async () => {
      const page = await document.getPage(pageNumber);
      if (cancelled) return;

      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      if (!canvas) return;

      // HiDPI: back the canvas with more pixels than its CSS size, or text is
      // soft on every modern display.
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      const context = canvas.getContext("2d");
      if (!context) return;

      renderTask = page.render({
        canvas,
        canvasContext: context,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });

      try {
        await renderTask.promise;
      } catch {
        // Cancellation is routine when the user scrolls quickly; the page will
        // be re-rendered when it comes back into view.
        return;
      }
      if (cancelled) return;

      // --- text layer -------------------------------------------------------
      const container = textLayerRef.current;
      if (!container) return;

      container.replaceChildren();
      pdfjs.setLayerDimensions(container, viewport);
      container.style.setProperty("--scale-factor", String(scale));

      const layer = new pdfjs.TextLayer({
        textContentSource: page.streamTextContent(),
        container,
        viewport,
      });
      textLayer = layer;

      try {
        await layer.render();
      } catch {
        // A cancelled text layer is as routine as a cancelled canvas render.
      }
    };

    void run();

    return () => {
      cancelled = true;
      // Cancelling matters: without it a fast scroll queues dozens of renders
      // that each hold a canvas alive.
      renderTask?.cancel();
      textLayer?.cancel();
      const canvas = canvasRef.current;
      if (canvas) {
        // Release the backing store rather than leaving megabytes of bitmap
        // attached to a detached node.
        canvas.width = 0;
        canvas.height = 0;
      }
    };
  }, [pdfjs, document, pageNumber, scale, shouldRender]);

  return (
    <div
      ref={containerRef}
      data-testid="pdf-page-container"
      data-page-number={pageNumber}
      className="pdf-page relative mx-auto shrink-0 bg-page-surface shadow-sm"
      style={{ width, height }}
    >
      {shouldRender && (
        <>
          <canvas
            ref={canvasRef}
            data-testid="pdf-page-canvas"
            className="block"
            aria-label={`Page ${pageNumber}`}
          />
          <div ref={textLayerRef} className="textLayer" data-testid="pdf-text-layer" />
          {highlightBoxes.length > 0 && (
            <div
              data-testid="pdf-highlight-layer"
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
            >
              {highlightBoxes.map((box, index) => (
                <span
                  key={index}
                  data-testid="pdf-highlight-box"
                  className="absolute rounded-sm border border-primary/40 bg-primary/15 transition-opacity duration-500"
                  style={{
                    left: box[0]! * scale,
                    top: box[1]! * scale,
                    width: Math.max((box[2]! - box[0]!) * scale, 1),
                    height: Math.max((box[3]! - box[1]!) * scale, 1),
                  }}
                />
              ))}
            </div>
          )}
        </>
      )}
      {!shouldRender && (
        <span className="absolute inset-0 flex items-center justify-center text-2xs text-muted-foreground/50">
          {pageNumber}
        </span>
      )}
    </div>
  );
}

export { RENDER_BUFFER_MARGIN_PX };
