import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";

import { PdfPage } from "@/pdf/PdfPage";
import { type PdfjsModule, RENDER_BUFFER_MARGIN_PX } from "@/pdf/pdfjs";

export interface PageSize {
  width: number;
  height: number;
}

interface PdfViewerProps {
  pdfjs: PdfjsModule;
  document: PDFDocumentProxy;
  pageCount: number;
  /** Effective scale, already resolved by the workspace (including fit-width). */
  scale: number;
  /** Page geometry at scale 1. */
  baseSize: PageSize;
  onCurrentPageChange: (page: number) => void;
  /**
   * The reading position, finer than the page: which page, and how far down it
   * in **PDF points**. A page can carry several sections, so the page number
   * alone cannot say where the reader is.
   */
  onReadingPositionChange?: (position: { pageNumber: number; offsetPt: number }) => void;
  onContainerWidthChange: (width: number) => void;
  viewerRef: React.MutableRefObject<PdfViewerHandle | null>;
  /** The page a citation is marking, or `null` for none. */
  highlightPage?: number | null;
  /** Source-PDF boxes in points, drawn on `highlightPage` only. */
  highlightBoxes?: number[][];
}

export interface PdfViewerHandle {
  /**
   * Move the stack so `page` is at the top of the viewport.
   *
   * `offsetPt` is an optional distance **into** the page, in PDF points —
   * converted with the live scale, exactly as the highlight boxes are. It exists
   * because a section heading is often not at the top of its page, and scrolling
   * to the page would leave the heading the reader clicked below the fold. Omit
   * it and the behaviour is unchanged from before this parameter existed.
   */
  scrollToPage: (page: number, offsetPt?: number) => void;
}

/**
 * The scrollable page stack.
 *
 * Rendering is windowed: every page reserves its geometry, but only pages within
 * a buffered viewport instantiate a canvas. That keeps scroll height stable
 * (no jumping as pages appear) without a virtualisation dependency.
 */
export function PdfViewer({
  pdfjs,
  document,
  pageCount,
  scale,
  baseSize,
  onCurrentPageChange,
  onReadingPositionChange,
  onContainerWidthChange,
  viewerRef,
  highlightPage = null,
  highlightBoxes = [],
}: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [visiblePages, setVisiblePages] = useState<Set<number>>(new Set());

  const width = baseSize.width * scale;
  const height = baseSize.height * scale;

  // --- windowing: which pages hold a canvas ---------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new IntersectionObserver(
      (entries) => {
        setVisiblePages((previous) => {
          const next = new Set(previous);
          for (const entry of entries) {
            const page = Number(
              (entry.target as HTMLElement).dataset.pageNumber ?? "0",
            );
            if (entry.isIntersecting) next.add(page);
            else next.delete(page);
          }
          return next;
        });
      },
      // A generous margin means a page is usually rendered before it is seen.
      { root: container, rootMargin: `${RENDER_BUFFER_MARGIN_PX}px 0px` },
    );

    for (const element of pageRefs.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [pageCount, document]);

  // --- current page: most visible area, topmost wins ties --------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let frame = 0;
    const measure = () => {
      frame = 0;
      const containerRect = container.getBoundingClientRect();
      let bestPage = 1;
      let bestVisible = -1;

      for (const [page, element] of pageRefs.current) {
        const rect = element.getBoundingClientRect();
        const visible =
          Math.min(rect.bottom, containerRect.bottom) -
          Math.max(rect.top, containerRect.top);
        // Strictly greater, so an equal-height tie keeps the earlier (topmost)
        // page — Map iteration is insertion-ordered, i.e. ascending page number.
        if (visible > bestVisible) {
          bestVisible = visible;
          bestPage = page;
        }
      }
      if (bestVisible > 0) {
        onCurrentPageChange(bestPage);

        // How far into the page the viewport top has scrolled, in PDF points.
        // The same measure loop already has both rectangles, so this costs no
        // extra observer and cannot disagree with the page it is reported with.
        const element = pageRefs.current.get(bestPage);
        if (element && onReadingPositionChange) {
          const rect = element.getBoundingClientRect();
          const intoPage = (containerRect.top - rect.top) / scale;
          onReadingPositionChange({
            pageNumber: bestPage,
            offsetPt: Math.min(Math.max(intoPage, 0), rect.height / scale),
          });
        }
      }
    };

    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(measure);
    };

    measure();
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [onCurrentPageChange, onReadingPositionChange, pageCount, scale]);

  // --- keep the reading position across zoom changes (AC-019) ----------------
  const previousScaleRef = useRef(scale);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const previous = previousScaleRef.current;
    previousScaleRef.current = scale;

    // Every page scales uniformly, so the content under the viewport top can be
    // kept in place by scaling scrollTop by the same ratio. Without this, zooming
    // while reading page 5 throws the reader back toward page 1.
    if (previous > 0 && previous !== scale) {
      container.scrollTop = container.scrollTop * (scale / previous);
    }
  }, [scale]);

  // --- report container width so fit-width can be computed -------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const report = () => onContainerWidthChange(container.clientWidth);
    report();

    // Resizing the window, or collapsing the sidebar, changes the width — and
    // under fit-width the pages must follow.
    const observer = new ResizeObserver(report);
    observer.observe(container);
    return () => observer.disconnect();
  }, [onContainerWidthChange]);

  const scrollToPage = useCallback(
    (page: number, offsetPt?: number) => {
      const element = pageRefs.current.get(page);
      const container = containerRef.current;
      if (!element || !container) return;
      // `offsetPt` is in PDF points, so it scales exactly as the page does —
      // the same conversion the highlight boxes use, in the other direction.
      const into = (offsetPt ?? 0) * scale;
      container.scrollTo({ top: element.offsetTop - 8 + into, behavior: "auto" });
    },
    [scale],
  );

  viewerRef.current = useMemo(() => ({ scrollToPage }), [scrollToPage]);

  const pages = useMemo(
    () => Array.from({ length: pageCount }, (_, index) => index + 1),
    [pageCount],
  );

  return (
    <div
      ref={containerRef}
      data-testid="pdf-viewer"
      className="min-h-0 flex-1 overflow-auto bg-workspace p-4"
    >
      <div className="flex flex-col items-center gap-4">
        {pages.map((page) => (
          <PdfPage
            key={page}
            pdfjs={pdfjs}
            document={document}
            pageNumber={page}
            scale={scale}
            width={width}
            height={height}
            shouldRender={visiblePages.has(page)}
            highlightBoxes={page === highlightPage ? highlightBoxes : []}
            containerRef={(element) => {
              if (element) pageRefs.current.set(page, element);
              else pageRefs.current.delete(page);
            }}
          />
        ))}
      </div>
    </div>
  );
}
