/**
 * Related papers, over the backend's API.
 *
 * Every call here may reach an outside index (OpenAlex or Semantic Scholar), so
 * the backend refuses all of them until a literature-search profile exists —
 * `SEARCH_NOT_CONFIGURED` — and this module reports that as its own state.
 */
import { apiJson } from "@/api/client";
import type { DocumentSummary } from "@/api/documents";

export type RelatedKind = "reference" | "citing" | "similar" | "search";

export interface RelatedPaper {
  key: string;
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  doi: string | null;
  url: string | null;
  abstract: string | null;
  cited_by: number | null;
  oa_pdf_url: string | null;
  kind: RelatedKind;
  /** The paper's own bibliography entry for this reference, when found. */
  entry_paragraph_id?: string | null;
  /** The first body paragraph that cites it — where "本文引用处" jumps. */
  cited_in_paragraph_id?: string | null;
  marker?: number | null;
  /**
   * Indexes leave this null. From a web-searching model: true only when its
   * link was among the pages the search returned; false means "check it".
   */
  verified?: boolean | null;
  /** One sentence on how it relates to this paper, when explained. */
  relation?: string | null;
}

export interface RelatedResult {
  source: string;
  identified: RelatedPaper | null;
  query: { doi: string | null; title: string | null };
  papers: RelatedPaper[];
  cached: boolean;
}

export type RelatedRead =
  | { state: "ok"; result: RelatedResult }
  | { state: "not-configured" };

/**
 * Fired on `window` when settings turn the search on, off or to another source,
 * so an open 文献 panel asks again instead of showing what was true before.
 */
export const SEARCH_PROFILE_CHANGED = "related:search-profile-changed";

const base = (documentId: string) => `/api/documents/${encodeURIComponent(documentId)}/related`;

function notConfigured(error: unknown): boolean {
  const e = error as { status?: number; code?: string };
  return e?.status === 409 && e.code === "SEARCH_NOT_CONFIGURED";
}

export async function fetchRelated(
  documentId: string,
  { refresh = false, signal }: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<RelatedRead> {
  try {
    const result = await apiJson<RelatedResult>(`${base(documentId)}${refresh ? "?refresh=1" : ""}`, { signal });
    return { state: "ok", result };
  } catch (error) {
    if (notConfigured(error)) return { state: "not-configured" };
    throw error;
  }
}

export async function searchRelated(
  documentId: string,
  query: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<RelatedPaper[]> {
  const body = await apiJson<{ papers: RelatedPaper[] }>(
    `${base(documentId)}/search?q=${encodeURIComponent(query)}`,
    { signal },
  );
  return body.papers;
}

/** One model call per eight papers; already-explained ones cost nothing. */
export async function explainRelated(
  documentId: string,
  profileId: string,
  keys: string[],
): Promise<Record<string, string>> {
  const body = await apiJson<{ relations: Record<string, string> }>(`${base(documentId)}/explain`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile_id: profileId, keys }),
  });
  return body.relations;
}

/** Fetch a related paper's open-access PDF into the library. */
export async function importRelated(documentId: string, key: string): Promise<DocumentSummary> {
  return apiJson<DocumentSummary>(`${base(documentId)}/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
}

export interface WebModel {
  profile_id: string;
  name: string;
  model: string;
  base_url: string;
  /** Whether the service runs a web search itself (DeepSeek, Qwen, GLM, …). */
  supported: boolean;
  via: string | null;
}

/** Chat profiles that could do related-paper search; nothing is sent to find out. */
export async function fetchWebModels(): Promise<WebModel[]> {
  return (await apiJson<{ models: WebModel[] }>("/api/related/web-models")).models;
}
