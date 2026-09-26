/**
 * What a page surface needs from the workspace that loaded the document.
 *
 * The PDF document is loaded once, by `PdfWorkspace`, along with the toolbar,
 * the zoom and the page jumps. A reader mode that wants to draw the pages
 * differently — DS-DOC-007's unrolled bilingual reading does — should get the
 * loaded document from there rather than load the same file a second time, and
 * should keep the toolbar's zoom working.
 *
 * This is the shape of that handover. It is a type, so importing it from the
 * eager side costs the initial chunk nothing.
 */
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { MutableRefObject } from "react";

import type { PageSize, PdfViewerHandle } from "@/pdf/PdfViewer";
import type { PdfjsModule } from "@/pdf/pdfjs";

export interface PageSurfaceProps {
  /** The loaded PDF.js module — passed down so no surface imports it eagerly. */
  pdfjs: PdfjsModule;
  document: PDFDocumentProxy;
  scale: number;
  pageCount: number;
  baseSize: PageSize;
  /** So an outline click can move this surface the way it moves the plain one. */
  viewerRef: MutableRefObject<PdfViewerHandle | null>;
  onCurrentPageChange: (page: number) => void;
  /**
   * The surface's own width, so fit-width fits *it*.
   *
   * The plain viewer reports the width of its scroll box; a surface that does
   * not report one leaves fit-width solving for a container it is not in.
   */
  onContainerWidthChange: (width: number) => void;
}
