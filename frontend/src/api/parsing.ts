/**
 * Structural parsing with MinerU, over the backend's API.
 *
 * Parsing runs in the background on the backend; this module starts it and
 * reads where it is. When it completes the backend has replaced the paper's IR,
 * so the caller re-reads the IR and everything derived from it.
 */
import { apiJson } from "@/api/client";

export interface ParseState {
  document_id: string;
  /** `idle` and `parser` come from a status read with no run in memory. */
  status: "pending" | "uploading" | "queued" | "running" | "converting" | "completed" | "failed" | "idle";
  parser?: "mineru" | "builtin" | "none";
  tier?: string | null;
  code?: string | null;
  message?: string | null;
  paragraphs?: number | null;
  sections?: number | null;
  partial?: boolean;
}

export const PARSE_ACTIVE = new Set(["pending", "uploading", "queued", "running", "converting"]);

export async function startParse(documentId: string, profileId: string): Promise<ParseState> {
  return apiJson<ParseState>(`/api/documents/${encodeURIComponent(documentId)}/parse`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile_id: profileId }),
  });
}

export async function fetchParseState(
  documentId: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<ParseState> {
  return apiJson<ParseState>(`/api/documents/${encodeURIComponent(documentId)}/parse`, { signal });
}
