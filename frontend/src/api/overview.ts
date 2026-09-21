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
import { apiFetch, apiJson, isApiError } from "@/api/client";

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
  /** 1-based, and the half of the provenance that belongs to the immutable PDF. */
  page_number: number;
  /** The paragraph this evidence is, looked up in the IR the client already has.
   *
   * The rectangle is resolved from that IR rather than taken from the artifact.
   * The difference matters: the model was shown excerpts and never a coordinate,
   * so geometry travelling in an overview would be geometry nobody measured. The
   * id is backend-validated against the packet, so it names a paragraph that
   * exists — and when it does not resolve the jump still goes to the page. */
  paragraph_id: string;
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
  /** Provider-reported, or `null` when the endpoint did not report them. The
   *  panel says so rather than showing a number nobody measured. */
  input_tokens: number | null;
  output_tokens: number | null;
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
  try {
    const response = await apiFetch(
      `/api/documents/${encodeURIComponent(documentId)}/overview` +
        `?target_language=${encodeURIComponent(targetLanguage)}`,
      { signal },
    );
    return (await response.json()) as OverviewView;
  } catch (error) {
    /* The route answers 404 when no artifact exists, which is an answer rather
       than a failure: the reader is shown the deterministic entry and a button.

       It has to be recognised here rather than from a response, because
       `apiFetch` raises on every non-ok status — a check on the response below
       it would never run, and "nothing has been generated yet" would reach the
       panel as the read *failing*. It did, for every paper that had no overview:
       the panel said there was none and, one line above the button, that reading
       the existing one had not worked. */
    if (isApiError(error) && error.status === 404) return null;
    throw error;
  }
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
