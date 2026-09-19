/**
 * Notes and highlights, over the backend's API.
 *
 * The shapes here mirror `app/annotations/service.py::summary`, and deliberately
 * carry **no anchor hash**: a digest identifies a source region to the backend,
 * and a reader has no use for one. What the client gets is what it draws with.
 */
import { apiFetch, apiJson } from "@/api/client";
import type { Bbox } from "@/api/ir";

/** What became of a target when it was looked for in the current extraction. */
export type ResolutionState =
  | "EXACT"
  | "REATTACHED"
  | "AMBIGUOUS"
  | "ORPHANED"
  /**
   * The document has not been read yet, so where this target sits *now* is not
   * known. The annotation itself is fully known — page, rectangles and quote come
   * from the immutable PDF — and it is listed; only the current paragraph
   * association is outstanding.
   */
  | "UNRESOLVED";

export interface ResolvedTarget {
  order: number;
  /** `paragraph`, or the layout class of the block this target names. */
  source_class?: string;
  /** 1-based, as the source PDF numbers it. */
  page_number: number;
  /** Line rectangles in source-PDF points. */
  rects: Bbox[];
  quote: string;
  state: ResolutionState;
  /** The paragraph this resolved to, when it resolved. A runtime id. */
  resolved_paragraph_id: string | null;
  detail: string;
  /**
   * Whether the source can still be *shown*, which is a different question from
   * whether it can be *resolved*. The geometry belongs to the immutable PDF, so
   * it survives an orphan.
   */
  showable: boolean;
  amenable_to_jump: boolean;
}

export interface AnnotationView {
  id: string;
  kind: "highlight" | "note";
  color: string;
  quote: string;
  comment: string | null;
  created_at: string;
  updated_at: string;
  targets: ResolvedTarget[];
}

export interface AnnotationList {
  document_id: string;
  content_hash: string;
  annotations: AnnotationView[];
}

export interface NewTarget {
  /** What kind of source unit this names. Defaults to a paragraph server-side. */
  source_class?: string;
  source_anchor_id: string;
  anchor_version?: string;
  page_number: number;
  original_bbox: Bbox;
  rects: Bbox[];
  exact_quote: string;
  prefix?: string;
  suffix?: string;
}

export async function listAnnotations(
  documentId: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<AnnotationList> {
  return apiJson<AnnotationList>(
    `/api/documents/${encodeURIComponent(documentId)}/annotations`,
    { signal },
  );
}

export async function createAnnotation(
  documentId: string,
  body: {
    kind: "highlight" | "note";
    quote: string;
    comment?: string | null;
    targets: NewTarget[];
  },
): Promise<AnnotationView> {
  return apiJson<AnnotationView>(
    `/api/documents/${encodeURIComponent(documentId)}/annotations`,
    {
      method: "POST",
      // `apiFetch` does not set this, and FastAPI answers 422 without it — the
      // body arrives as text and no model can be built from it.
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

export async function updateAnnotation(
  annotationId: string,
  comment: string | null,
): Promise<AnnotationView> {
  return apiJson<AnnotationView>(
    `/api/annotations/${encodeURIComponent(annotationId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comment }),
    },
  );
}

export async function deleteAnnotation(annotationId: string): Promise<void> {
  // `apiFetch`, not `apiJson`: the route answers 204 with no body, and parsing an
  // empty response as JSON is a failure the delete did not actually have.
  await apiFetch(`/api/annotations/${encodeURIComponent(annotationId)}`, {
    method: "DELETE",
  });
}
