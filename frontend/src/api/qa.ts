/**
 * Paper QA endpoints (DS-QA-002 `POST /api/documents/{id}/answer`).
 *
 * Three properties of this contract are load-bearing, and each is easy to lose
 * by being helpful.
 *
 * **`status` is not a union here.** The backend answers with `answered`,
 * `partial` or `insufficient_evidence` — and a future backend may add a fourth.
 * Typing the wire field as a closed union would make an unrecognised status a
 * TypeScript error at the boundary that is supposed to *survive* it, so the raw
 * type is `string` and narrowing happens once, explicitly, in `parseAnswer`.
 *
 * **A 200 with `insufficient_evidence` is a success.** It is not an error, and
 * nothing in this module turns it into one. Only a non-2xx response becomes an
 * `ApiError`, which is the transport axis — a different axis from the semantic
 * one, and keeping them separate is the whole reason the backend reports them
 * differently.
 *
 * **The request carries no evidence.** There is no field for it: evidence is
 * retrieved in-process by the backend. A bundle supplied by a caller would let it
 * choose the text the model cites while the citations still resolved to real
 * pages — a fabricated citation with perfect metadata.
 */
import { apiJson } from "@/api/client";

/** The scopes the backend accepts. `extra="forbid"` makes this list closed. */
export type QaScope =
  | { type: "whole_paper" }
  | { type: "page"; page: number }
  | { type: "section"; section_id: string }
  | { type: "selection"; paragraph_ids: string[] };

export interface ResolvedCitation {
  /** The marker the model wrote — `E1`. Not for display. */
  citation_id: string;
  paragraph_id: string;
  section_id: string | null;
  section_title: string | null;
  /** 1-based, resolved by the application from the `DocumentIR`. */
  page_number: number;
  page_range: number[];
  block_ids: string[];
  /** `[x0, y0, x1, y1]` per block, PDF points, top-left origin. */
  bboxes: number[][];
  snippet: string;
  is_caption: boolean;
}

export interface AnswerDiagnostics {
  code: string;
  execution_time_ms: number;
  requests_made: number;
  prompt_tokens: number;
  completion_tokens: number;
  repair_attempted: boolean;
  evidence_items: number;
  evidence_dropped: number;
  dropped_citations: string[];
  suggest_scope_expansion: boolean;
}

/** The wire shape. `status` is deliberately `string` — see the module docstring. */
export interface RawAnswerResult {
  document_id: string;
  question: string;
  status: string;
  answer: string;
  citations: ResolvedCitation[];
  unanswered_aspects: string[];
  missing_evidence_rationale: string | null;
  diagnostics: AnswerDiagnostics;
}

export interface AskOptions {
  question: string;
  scope: QaScope;
  profileId: string;
  topK?: number;
  /** Overrides the default, which is to answer in the question's language. */
  language?: string | null;
  signal?: AbortSignal;
}

/**
 * Ask one question. Returns the parsed JSON body unvalidated.
 *
 * Validation is `parseAnswer`'s job, and it is separated deliberately: a body
 * that parses as JSON but is not an answer must render as a controlled
 * "unrecognised response" card, not as a thrown exception from the transport
 * layer. An abort is re-thrown untouched, because cancellation is a local
 * decision rather than a backend failure.
 */
export async function askQuestion(
  documentId: string,
  { question, scope, profileId, topK = 8, language = null, signal }: AskOptions,
): Promise<unknown> {
  return apiJson<unknown>(
    `/api/documents/${encodeURIComponent(documentId)}/answer`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        scope,
        profile_id: profileId,
        top_k: topK,
        language,
      }),
      signal,
    },
  );
}
