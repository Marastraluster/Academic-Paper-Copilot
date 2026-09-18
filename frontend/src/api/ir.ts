/**
 * The canonical Document IR, as the browser needs it.
 *
 * Fetched once per document, when registration completes, alongside the outline
 * and the provider list. Selection mapping intersects live geometry against these
 * boxes on every mouse-up, so a round trip per selection would make the reader
 * feel broken — and the IR is a published artifact of the document, not a new
 * contract invented for this feature.
 *
 * Only the fields the mapping needs are typed. The IR carries more (metadata,
 * reading order, page mapping); adding fields to a type the UI does not read is
 * how a schema drifts from its use.
 */
import { apiJson } from "@/api/client";

/** `[x0, y0, x1, y1]` in PDF points, top-left origin — PyMuPDF's convention. */
export type Bbox = [number, number, number, number];

export interface IrParagraph {
  id: string;
  section_id: string | null;
  text: string;
  /** 1-based. */
  page_number: number;
  page_range: [number, number];
  block_ids: string[];
  bboxes: Bbox[];
}

export interface IrBlock {
  id: string;
  page_number: number;
  layout_class: string;
  bbox: Bbox;
  text: string;
}

export interface IrPage {
  page_number: number;
  width_pt: number;
  height_pt: number;
  rotation: number;
  blocks: IrBlock[];
}

export interface DocumentIr {
  document_id: string;
  content_hash: string;
  page_count: number;
  paragraphs: IrParagraph[];
  pages: IrPage[];
}

export async function fetchIr(
  documentId: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<DocumentIr> {
  return apiJson<DocumentIr>(`/api/documents/${encodeURIComponent(documentId)}/ir`, {
    signal,
  });
}
