/**
 * The document analysis, over the backend's API.
 *
 * **This is the first module in the application that can spend the reader's
 * money.** DocumentAnalysis is several sequential provider calls over a whole
 * paper — measured earlier at minutes, not seconds — and until now nothing in
 * `frontend/src` reached for it, so the "opening a paper costs nothing" promise
 * held structurally rather than by discipline. Now it is a rule with a module
 * behind it: `fetchAnalysis` reads and `requestAnalysis` spends, and only an
 * explicit reader action may call the second.
 *
 * The shapes mirror `app.context.models`. Only the fields the Overview renders
 * are typed: adding fields a UI does not read is how a schema drifts from its
 * use, and the analysis carries more (entities, errors, per-unit records) that
 * an entry point has no business showing.
 */
import { apiFetch, apiJson } from "@/api/client";

/** One section's summary, and where in the paper it came from. */
export interface SectionAnalysis {
  section_id: string;
  title: string;
  summary: string;
  /** 1-based, `[first, last]`. The anchor a summary can actually be checked against. */
  page_range: [number, number];
  /**
   * True when this covers paragraphs the extraction could not place in a
   * section — an automatic partition rather than one the authors wrote. The
   * panel says so, because a title the reader takes for the author's own is a
   * claim nobody made.
   */
  synthetic: boolean;
}

export interface GlossaryTerm {
  /** The canonical spelling as it appears in the source. Never case-folded. */
  source_term: string;
  suggested_translation: string | null;
  /** What the term means *in this paper*. Not a dictionary definition. */
  definition: string | null;
  is_translatable: boolean;
  /** Where the term occurs, as runtime paragraph ids. */
  paragraph_ids: string[];
}

export interface AcronymEntry {
  acronym: string;
  expansion: string | null;
}

/**
 * What a model concluded about the paper, and what it was told to conclude it.
 *
 * `provenance` is not decoration — it is the only way to tell whether this
 * describes the document in front of the reader. See `analysisIsCurrent`.
 */
export interface AnalysisView {
  document_id: string;
  status: "READY" | "PARTIAL" | "FAILED" | "CANCELLED";
  summary: string | null;
  sections: SectionAnalysis[];
  glossary: GlossaryTerm[];
  acronyms: AcronymEntry[];
  provenance: {
    content_hash: string;
    pipeline_version: string;
    prompt_version: string;
    /** Which *extraction* produced the paragraphs this points at. */
    ir_pipeline_version: string;
    provider_model: string;
    target_language: string;
    created_at: string;
  };
}

/** No analysis has been generated for this document. Not an error. */
export const ANALYSIS_ABSENT = "ANALYSIS_NOT_FOUND";

/** Read the stored analysis. **Never generates one.** */
export async function fetchAnalysis(
  documentId: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<AnalysisView | null> {
  const response = await apiFetch(
    `/api/documents/${encodeURIComponent(documentId)}/analysis`,
    { signal },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`analysis read failed: ${response.status}`);
  }
  return (await response.json()) as AnalysisView;
}

/**
 * Ask the backend to analyse the paper, or to return what it already has.
 *
 * Expensive and blocking: the backend runs several provider calls and answers
 * when it is finished. Only a reader action may reach this.
 */
export async function requestAnalysis(
  documentId: string,
  profileId: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<AnalysisView> {
  return apiJson<AnalysisView>(
    `/api/documents/${encodeURIComponent(documentId)}/analysis`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile_id: profileId }),
      signal,
    },
  );
}
