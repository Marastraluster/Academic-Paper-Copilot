/**
 * Reconstructed formulas, over the backend's API.
 *
 * Two calls, and the split is the same product rule the translation follows:
 *
 *     fetchFormulas    reads the cache, can never reach a provider, and when
 *                      there is nothing it answers with what making one costs
 *     requestFormulas  reconstructs, validates and caches — and costs money
 *
 * The route is `/formulas` and the artifact is its own file: a formula
 * reconstruction is not part of the paragraph translation, it has its own
 * versions, and adding it must not invalidate a translation the reader has
 * already paid for.
 *
 * Imported only by the lazily-loaded reading: the initial chunk's ceiling is
 * 310.0 kB and this has no business in it.
 */
import { apiFetch, apiJson } from "@/api/client";

export type FormulaStatus = "READY" | "PARTIAL" | "FAILED";
export type ItemStatus = "reconstructed" | "refusal" | "failed" | "unprocessed";

export interface FormulaItemView {
  block_id: string;
  /** Persistent identity — the same formula in a re-imported copy of the paper. */
  source_anchor_id: string;
  page_number: number;
  bbox: [number, number, number, number];
  /** What the extractor read: the glyph soup the reconstruction is made from. */
  raw_soup: string;
  font_size: number | null;
  status: ItemStatus;
  latex: string;
  /** `(1)`, when the paper printed one beside this formula. */
  equation_number: string | null;
  /** Why the model would not answer: the reader is told, not left guessing. */
  refusal_reason: string | null;
  error_reason: string | null;
}

export interface FormulaView {
  content_hash: string;
  status: FormulaStatus;
  total_formulas: number;
  reconstructed_count: number;
  refused_count: number;
  failed_count: number;
  formulas: FormulaItemView[];
  provider_model: string;
  created_at: string;
  input_tokens: number | null;
  output_tokens: number | null;
  notes: string[];
}

/** What making one would cost, read from the 404 that says there is none. */
export interface FormulaPlan {
  total_formulas: number;
  batch_count: number;
  character_volume: number;
}

export type FormulaRead =
  | { state: "found"; view: FormulaView }
  | { state: "none"; plan: FormulaPlan | null };

/** Read the stored artifact. Never reaches a provider. */
export async function fetchFormulas(
  documentId: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<FormulaRead> {
  try {
    const view = await apiJson<FormulaView>(
      `/api/documents/${encodeURIComponent(documentId)}/formulas`,
      { signal },
    );
    return { state: "found", view };
  } catch (error) {
    // `ApiError` carries the envelope's `detail` — the same place the bilingual
    // read finds its plan, which is the precedent this follows.
    const detail = (error as { detail?: { plan?: FormulaPlan } })?.detail;
    if ((error as { status?: number })?.status === 404) {
      return { state: "none", plan: detail?.plan ?? null };
    }
    throw error;
  }
}

/** Reconstruct. **Only a reader action may call this.** */
export async function requestFormulas(
  documentId: string,
  profileId: string,
  { signal, force = false }: { signal?: AbortSignal; force?: boolean } = {},
): Promise<FormulaView> {
  const response = await apiFetch(
    `/api/documents/${encodeURIComponent(documentId)}/formulas`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile_id: profileId, force }),
      signal,
    },
  );
  return (await response.json()) as FormulaView;
}
