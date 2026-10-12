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
import { apiUrl } from "@/api/config";

export type BilingualStatus = "READY" | "PARTIAL" | "FAILED";
/** `pending` only while a background job is still on its way to this paragraph. */
export type ParagraphStatus = "translated" | "skipped" | "untranslated" | "pending";

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
  /** What a structural parser (MinerU) recovered; absent under the in-house one. */
  latex?: string | null;
  html?: string | null;
  image_path?: string | null;
  caption_of?: string | null;
}

/** A background translation's progress, in batches — the unit the work is done in. */
export interface BilingualJob {
  status: "running" | "completed" | "failed" | "cancelled";
  total_batches: number;
  done_batches: number;
  failed_batches: number;
  total_paragraphs: number;
  translated_paragraphs: number;
  resumed_batches: number;
  code: string | null;
  message: string | null;
  /** `terms` while early paragraphs are brought into line with the glossary. */
  phase?: "translating" | "terms";
  glossary_terms?: number;
  restated_paragraphs?: number;
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
  /** Present while (or after) a background job produced this reading. */
  job?: BilingualJob | null;
  /** A job stopped short: starting again resumes it. */
  resumable?: boolean;
}

/** What a generation would cost, computed from the IR rather than estimated. */
export interface BilingualPlan {
  paragraphs: number;
  batches: number;
  /** 1 when the paper has no glossary yet: it is read once for its terms. */
  glossary_calls?: number;
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

/** What starting a job answered. */
export type JobStart =
  | { kind: "job"; job: BilingualJob }
  | { kind: "cached" }
  | { kind: "reading"; view: BilingualView }
  | { kind: "unsupported" };

/**
 * Start (or resume) translating in the background. **Spends money.**
 *
 * An older backend has no job route; that answers `unsupported` and the caller
 * falls back to the one-request generation.
 */
export async function startBilingualJob(
  documentId: string,
  profileId: string,
  targetLanguage: string,
  { signal, force = false }: { signal?: AbortSignal; force?: boolean } = {},
): Promise<JobStart> {
  let body: unknown;
  try {
    body = await apiJson<unknown>(
      `/api/documents/${encodeURIComponent(documentId)}/bilingual-text/jobs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile_id: profileId, target_language: targetLanguage, force }),
        signal,
      },
    );
  } catch (error) {
    const status = (error as { status?: number })?.status;
    if (status === 404 || status === 405) return { kind: "unsupported" };
    throw error;
  }
  const record = body as Record<string, unknown>;
  if (Array.isArray(record.paragraphs)) return { kind: "reading", view: body as BilingualView };
  if (record.cached === true) return { kind: "cached" };
  return { kind: "job", job: body as BilingualJob };
}

/** Stop a running job. What it translated stays, and starting again resumes. */
export async function stopBilingualJob(documentId: string, targetLanguage: string): Promise<void> {
  await apiFetch(
    `/api/documents/${encodeURIComponent(documentId)}/bilingual-text/jobs` +
      `?target_language=${encodeURIComponent(targetLanguage)}`,
    { method: "DELETE" },
  );
}

export interface RetranslatedParagraph {
  paragraph_id: string;
  translated_text: string;
  status: ParagraphStatus;
}

/** Translate one paragraph again — one model call. */
export async function retranslateParagraph(
  documentId: string,
  paragraphId: string,
  profileId: string,
  targetLanguage: string,
): Promise<RetranslatedParagraph> {
  return apiJson<RetranslatedParagraph>(
    `/api/documents/${encodeURIComponent(documentId)}/bilingual-text/paragraphs/` +
      `${encodeURIComponent(paragraphId)}/retranslate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile_id: profileId, target_language: targetLanguage }),
    },
  );
}

/** Where an image MinerU cut out of the paper is served. */
export function assetUrl(documentId: string, imagePath: string): string {
  const safe = imagePath.split("/").map(encodeURIComponent).join("/");
  return apiUrl(`/api/documents/${encodeURIComponent(documentId)}/assets/${safe}`);
}

/** One entry of a paper's glossary: a term, and the translation to keep. */
export interface GlossaryTerm {
  source: string;
  target: string;
}

export interface GlossaryView {
  /** False until a translation (or the reader) has made one. */
  exists: boolean;
  terms: GlossaryTerm[];
}

const glossaryUrl = (documentId: string, targetLanguage: string) =>
  `/api/documents/${encodeURIComponent(documentId)}/bilingual-text/glossary` +
  `?target_language=${encodeURIComponent(targetLanguage)}`;

/** The terms this paper is translated with. Reads only. */
export async function fetchGlossary(
  documentId: string,
  targetLanguage: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<GlossaryView> {
  return apiJson<GlossaryView>(glossaryUrl(documentId, targetLanguage), { signal });
}

/**
 * Save the reader's glossary. Spends nothing: the answer says how many
 * paragraphs contain a changed term and so lost their translation — starting
 * the job again translates those, and only those.
 */
export async function saveGlossary(
  documentId: string,
  targetLanguage: string,
  terms: GlossaryTerm[],
): Promise<GlossaryView & { affected_paragraphs: number }> {
  return apiJson<GlossaryView & { affected_paragraphs: number }>(glossaryUrl(documentId, targetLanguage), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ terms, target_language: targetLanguage }),
  });
}

/**
 * Read the paper's terms again. **Spends one model call**, stores nothing: the
 * answer is a proposal for the reader to look over and save.
 */
export async function extractGlossary(
  documentId: string,
  targetLanguage: string,
  profileId: string,
): Promise<GlossaryTerm[]> {
  const body = await apiJson<{ terms: GlossaryTerm[] }>(
    `/api/documents/${encodeURIComponent(documentId)}/bilingual-text/glossary/extract`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile_id: profileId, target_language: targetLanguage }),
    },
  );
  return Array.isArray(body?.terms) ? body.terms : [];
}
