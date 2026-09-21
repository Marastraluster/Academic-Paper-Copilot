/**
 * Document and artifact endpoints (docs/API_CONTRACT.md §2).
 *
 * The browser's only way to register a document is the multipart upload: a
 * `File` from a picker or a drop has no usable filesystem path, so the JSON
 * `{path}` form the backend also accepts is unusable here. That form exists for
 * local headless callers and is deliberately not exposed.
 *
 * Artifacts are fetched as blobs rather than used as `<a href>` targets or PDF.js
 * URLs pointed straight at the API. Two reasons: the object URL is then owned by
 * exactly one module that can revoke it (AC-P0-15), and the request can carry
 * `no-store`, without which a retranslation renders the previous result.
 */
import { apiBlob, apiJson } from "@/api/client";

export interface DocumentSummary {
  document_id: string;
  name: string;
  page_count: number;
  source: "upload" | "path";
  has_translation: boolean;
  created_at: string;
}

export interface UploadOptions {
  signal?: AbortSignal;
}

export async function uploadDocument(
  file: File,
  { signal }: UploadOptions = {},
): Promise<DocumentSummary> {
  const form = new FormData();
  // Field name is fixed by the backend's `UploadFile` parameter.
  form.append("file", file, file.name);

  // Content-Type is deliberately not set: the browser must generate the
  // multipart boundary itself, and setting the header by hand strips it.
  return apiJson<DocumentSummary>("/api/documents", {
    method: "POST",
    body: form,
    signal,
  });
}

export async function getDocument(
  documentId: string,
  { signal }: UploadOptions = {},
): Promise<DocumentSummary> {
  return apiJson<DocumentSummary>(
    `/api/documents/${encodeURIComponent(documentId)}`,
    { signal },
  );
}

/**
 * The original PDF, as the backend kept it.
 *
 * The browser has the `File` it was given, except after a reload — where the
 * only copy left is this one. Fetched as a blob for the same two reasons as the
 * translated artifact: one owner, one revocation, and a request that can carry
 * `no-store`.
 */
export async function fetchOriginalPdf(
  documentId: string,
  { signal }: UploadOptions = {},
): Promise<Blob> {
  return apiBlob(`/api/documents/${encodeURIComponent(documentId)}/file`, {
    signal,
  });
}

/** The translated (mono) artifact — N pages, one per source page. */
export async function fetchTranslatedPdf(
  documentId: string,
  { signal }: UploadOptions = {},
): Promise<Blob> {
  return apiBlob(`/api/documents/${encodeURIComponent(documentId)}/translated`, {
    signal,
  });
}

/** One entry of `GET /api/documents/{id}/sections`. */
export interface SectionSummary {
  id: string;
  title: string;
  /** `null` when the heading carries no numbering and no reliable signal. */
  level: number | null;
  /** The section this one nests under, or `null` for a root. */
  parent_id: string | null;
  /** 1-based page the section starts on. */
  page_number: number;
  /** `[first, last]` pages the section touches. */
  page_range: [number, number];
  /**
   * The heading's box in PDF points, or `null` when the navigation ladder had to
   * fall back to the first paragraph or to the page alone.
   */
  bbox: [number, number, number, number] | null;
  /**
   * Which rung of the ladder produced `page_number` / `bbox`:
   * `"heading"` | `"paragraph"` | `"page"`. A caller that draws a box can check
   * this rather than inferring it from a null.
   */
  anchor: "heading" | "paragraph" | "page";
  is_references: boolean;
}

/**
 * The document outline, for Section-scoped questions.
 *
 * Resolving the current section from this rather than by re-parsing headings in
 * the browser is the point: the outline already exists in the `DocumentIR`, and a
 * second detector in the frontend would be a second answer to a settled question.
 */
export async function listSections(
  documentId: string,
  { signal }: UploadOptions = {},
): Promise<SectionSummary[]> {
  return apiJson<SectionSummary[]>(
    `/api/documents/${encodeURIComponent(documentId)}/sections`,
    { signal },
  );
}

// The dual (interleaved, 2N-page) artifact is deliberately absent here. It is an
// export-only download, so ExportMenu links straight to it rather than streaming
// it through a blob that would then need an owner and a revoke.
