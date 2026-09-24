/**
 * The paragraph-aligned reading, over the backend's API.
 *
 * Three calls, and the split is the product rule:
 *
 *     fetchBilingual   reads the cache and can never reach a provider; when
 *                      there is nothing it answers with what making one costs
 *     requestBilingual generates, validates and caches — and costs money
 *
 * The route is `/bilingual-text` and not `/bilingual`: the latter already answers
 * with the 2N-page dual **PDF** the export menu downloads. They are different
 * artifacts of the same paper, and one URL may not mean two things.
 *
 * Imported only by the lazily-loaded reading column: the initial chunk has less
 * than a kilobyte of headroom under its ceiling, and a reader who never opens
 * this view should not download it.
 */
import { apiFetch, apiJson } from "@/api/client";

export type BilingualStatus = "READY" | "PARTIAL" | "FAILED";
export type ParagraphStatus = "translated" | "skipped" | "untranslated";

export interface BilingualSectionView {
  section_id: string;
  title: string;
  title_translated: string;
  level: number | null;
  page_number: number;
  is_references: boolean;
}

export interface BilingualParagraphView {
  paragraph_id: string;
  page_number: number;
  section_id: string | null;
  /** Verbatim from the paper. The column shows the source, not a re-extraction. */
  source_text: string;
  translated_text: string;
  status: ParagraphStatus;
  /** Why this paragraph has no translation, when it has none. */
  note: string;
  /** Source-PDF points, so a click can put the reader on the paragraph. */
  bboxes: number[][];
}

export interface BilingualBlockView {
  block_id: string;
  page_number: number;
  layout_class: string;
  text: string;
  bbox: number[] | null;
}

export interface BilingualView {
  status: BilingualStatus;
  cached: boolean;
  content_hash: string;
  target_language: string;
  provider_model: string;
  created_at: string;
  input_tokens: number | null;
  output_tokens: number | null;
  notes: string[];
  total_paragraphs: number;
  translated_paragraphs: number;
  sections: BilingualSectionView[];
  paragraphs: BilingualParagraphView[];
  blocks: BilingualBlockView[];
}

/** What a generation would cost, computed from the IR rather than estimated. */
export interface BilingualPlan {
  paragraphs: number;
  batches: number;
  characters: number;
  sections: number;
  skipped: number;
}

/** What one read found: a reading, or the cost of making one. */
export type BilingualRead =
  | { state: "found"; view: BilingualView }
  | { state: "none"; plan: BilingualPlan | null };

/**
 * Read the stored reading. **Never generates one.**
 *
 * A 404 is an answer rather than a failure, and it carries the plan: the column
 * can then say what a generation would cost from the read it already made, with
 * no second request and no guess.
 */
export async function fetchBilingual(
  documentId: string,
  targetLanguage: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<BilingualRead> {
  try {
    const response = await apiFetch(
      `/api/documents/${encodeURIComponent(documentId)}/bilingual-text` +
        `?target_language=${encodeURIComponent(targetLanguage)}`,
      { signal },
    );
    return { state: "found", view: (await response.json()) as BilingualView };
  } catch (error) {
    const detail = (error as { detail?: { plan?: BilingualPlan } })?.detail;
    if ((error as { status?: number })?.status === 404) {
      return { state: "none", plan: detail?.plan ?? null };
    }
    throw error;
  }
}

/** Generate one. **Spends money**, so only a button press may reach it. */
export async function requestBilingual(
  documentId: string,
  profileId: string,
  targetLanguage: string,
  { signal, force = false }: { signal?: AbortSignal; force?: boolean } = {},
): Promise<BilingualView> {
  return apiJson<BilingualView>(
    `/api/documents/${encodeURIComponent(documentId)}/bilingual-text`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile_id: profileId, target_language: targetLanguage, force }),
      signal,
    },
  );
}
