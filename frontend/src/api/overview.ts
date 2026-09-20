/**
 * The reader overview, over the backend's API.
 *
 * Replaces the DS-QA-014 path, which read `DocumentAnalysis` — the artifact the
 * *translation* pipeline produces for a system choosing the right sense of a
 * term. Measured, that artifact summarised the bibliography, produced a card for
 * "Unsectioned Content (Pages 1-1)", and said things like *"It is useful for
 * preserving author names and affiliation spelling during translation"* to a
 * person trying to decide whether to read a paper. It was never a reader
 * overview, and reading it as one is the defect this module removes.
 *
 * Two calls, and the split is the product rule:
 *
 *     fetchOverview    reads the cache and can never reach a provider
 *     requestOverview  generates, validates and caches — and costs money
 *
 * The only thing that may call the second is a button.
 */
import { apiFetch, apiJson } from "@/api/client";

export type OverviewStatus = "READY" | "PARTIAL" | "FAILED";

/** The categories the panel renders, in the order it renders them. */
export type OverviewCategory =
  | "research_question"
  | "core_idea"
  | "contributions"
  | "method"
  | "experiments"
  | "findings"
  | "limitations";

export interface OverviewEvidence {
  /** 1-based, and the only provenance the client is given.
   *
   * No rectangle and no paragraph id: the page belongs to the immutable PDF and
   * is enough to jump to, and the geometry is resolved from the document the
   * reader is already looking at rather than from a generated artifact. A model
   * that could name a rectangle could name a wrong one. */
  page_number: number;
}

export interface OverviewItemView {
  category: OverviewCategory;
  text: string;
  /** Organised by the model rather than stated by the authors as a claim. */
  inferred: boolean;
  /** The evidence supports part of this rather than all of it. */
  partial: boolean;
  evidence: OverviewEvidence[];
}

export interface OverviewTermView {
  term: string;
  definition: string;
  evidence: OverviewEvidence[];
}

export interface OverviewView {
  status: OverviewStatus;
  /** True when the backend answered from its cache rather than generating. */
  cached: boolean;
  content_hash: string;
  target_language: string;
  /** Whose reading this is, so an older model's artifact is not passed off as
   *  the current one's. */
  provider_model: string;
  created_at: string;
  source_sections: string[];
  /** Why a PARTIAL or FAILED run is not complete. Never empty for those. */
  notes: string[];
  items: OverviewItemView[];
  key_terms: OverviewTermView[];
}

/** Read the stored overview. **Never generates one.** */
export async function fetchOverview(
  documentId: string,
  targetLanguage: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<OverviewView | null> {
  const response = await apiFetch(
    `/api/documents/${encodeURIComponent(documentId)}/overview` +
      `?target_language=${encodeURIComponent(targetLanguage)}`,
    { signal },
  );
  // The route answers 404 when no artifact exists, which is an answer rather
  // than a failure: the reader is shown the deterministic entry and a button.
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`overview read failed: ${response.status}`);
  return (await response.json()) as OverviewView;
}

/**
 * Generate one. **The only call in the application that spends on the reader's
 * behalf**, and the only one that must never be reached without a button press.
 */
export async function requestOverview(
  documentId: string,
  profileId: string,
  targetLanguage: string,
  { signal, force = false }: { signal?: AbortSignal; force?: boolean } = {},
): Promise<OverviewView> {
  return apiJson<OverviewView>(
    `/api/documents/${encodeURIComponent(documentId)}/overview`,
    {
      method: "POST",
      // `apiFetch` sets no content type and FastAPI answers 422 without it.
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile_id: profileId,
        target_language: targetLanguage,
        force,
      }),
      signal,
    },
  );
}
