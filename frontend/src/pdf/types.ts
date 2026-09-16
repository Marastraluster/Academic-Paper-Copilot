import type { PDFDocumentProxy } from "pdfjs-dist";

/** Where a viewer is in its lifecycle. */
export type ViewerStatus = "empty" | "loading" | "ready" | "error";

/** Why a document could not be opened — the user-facing distinction matters. */
export type ViewerErrorKind = "corrupt" | "password" | "unsupported";

export interface ViewerError {
  kind: ViewerErrorKind;
  message: string;
}

/** A document the viewer is showing. */
export interface LoadedDocument {
  /** Local file name, for display. Never a path. */
  name: string;
  proxy: PDFDocumentProxy;
  pageCount: number;
}

/** Zoom mode: an explicit scale, or a scale derived from the container width. */
export type ZoomMode = { kind: "scale"; value: number } | { kind: "fit-width" };
