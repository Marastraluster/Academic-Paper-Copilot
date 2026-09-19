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
  /** Runtime identity for this extraction — `p_<doc>_<ordinal>`. */
  id: string;
  /**
   * **Persistent** identity: the digest of the immutable source region this
   * paragraph came from, computed by the backend at extraction time.
   *
   * A note or highlight must anchor to this and never to `id`. DS-DOC-002
   * measured why: lowering one gutter constant renumbered 145 of 160 paragraphs
   * of Diffusion Policy while the file itself did not change by a byte.
   *
   * It is read from here rather than recomputed in the browser on purpose. Two
   * implementations of a hash whose entire purpose is to be identical everywhere
   * is a divergence waiting to happen, and the symptom would be a note that
   * silently never resolves on a paper nobody changed.
   */
  source_anchor_id: string;
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
  /**
   * **Persistent** identity, for the classes a reader may annotate.
   *
   * Empty on every other class, and that is the honest value: being present in
   * the IR and being annotatable are different things. Computed by the backend
   * at extraction time for the same reason the paragraph anchor is — a hash
   * whose whole purpose is to be identical everywhere must have one
   * implementation, and a second one in the browser is a divergence waiting to
   * happen whose symptom would be a caption note that silently never resolves.
   */
  source_anchor_id: string;
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
