/**
 * Turning a backend response into something the UI can render without trusting it.
 *
 * The backend is ours and its shape is frozen, so this is not defensive
 * programming for its own sake. It exists for one specific failure: a status the
 * frontend does not recognise. That happens the day the backend adds a fourth
 * answerability state, and the wrong responses to it are the two obvious ones —
 * crash, or treat it as `answered`. An answer whose status we do not understand
 * is an answer whose grounding we cannot vouch for, so it is shown as
 * **unrecognised** rather than as an answer, and the reader can still see it.
 *
 * A citation missing its page is kept, not dropped: the snippet is still real
 * evidence. It is marked `jumpable: false`, and the UI disables the jump for it
 * rather than sending the reader to a page number we do not have.
 */
import type { AnswerDiagnostics } from "@/api/qa";

/** The statuses this build understands. */
export type GroundedStatus = "answered" | "partial" | "insufficient_evidence";

const GROUNDED_STATUSES: readonly GroundedStatus[] = [
  "answered",
  "partial",
  "insufficient_evidence",
];

export function isGroundedStatus(value: string): value is GroundedStatus {
  return (GROUNDED_STATUSES as readonly string[]).includes(value);
}

/**
 * A citation as the UI uses it.
 *
 * `pageNumber` is `null` when the backend did not supply a usable one. It is
 * never guessed from the answer text — page identity belongs to the application,
 * and a page number parsed out of prose would be the model's, not the document's.
 */
export interface Citation {
  /** `citation_id` — internal. Never displayed. */
  id: string;
  /** The number a reader sees: 1, 2, 3… in first-appearance order. */
  index: number;
  pageNumber: number | null;
  sectionTitle: string | null;
  snippet: string;
  bboxes: number[][];
  isCaption: boolean;
  /** False when there is no page to go to; the chip renders but does not jump. */
  jumpable: boolean;
}

export type ParsedAnswer =
  | {
      kind: "grounded";
      status: GroundedStatus;
      answer: string;
      citations: Citation[];
      unansweredAspects: string[];
      rationale: string | null;
      diagnostics: AnswerDiagnostics | null;
    }
  | {
      kind: "unknown_status";
      status: string;
      answer: string;
      citations: Citation[];
    }
  | { kind: "malformed" };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

/** `[x0, y0, x1, y1]` boxes, dropping anything that is not four finite numbers. */
function asBoxes(value: unknown): number[][] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (box): box is number[] =>
      Array.isArray(box) && box.length === 4 && box.every((n) => typeof n === "number"),
  );
}

function asPositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

function toCitation(raw: unknown, index: number): Citation | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = asString(record.citation_id);
  if (!id) return null;

  const pageNumber = asPositiveInt(record.page_number);
  return {
    id,
    index,
    pageNumber,
    sectionTitle: typeof record.section_title === "string" ? record.section_title : null,
    snippet: asString(record.snippet),
    bboxes: asBoxes(record.bboxes),
    isCaption: record.is_caption === true,
    jumpable: pageNumber !== null,
  };
}

function toCitations(value: unknown): Citation[] {
  if (!Array.isArray(value)) return [];
  const citations: Citation[] = [];
  for (const raw of value) {
    const citation = toCitation(raw, citations.length + 1);
    if (citation) citations.push(citation);
  }
  return citations;
}

/**
 * Classify a response body.
 *
 * `malformed` means the envelope itself is not an answer — no `status`, or an
 * `answer` that is not a string. Anything with a recognised status becomes
 * `grounded`; anything with an unrecognised one becomes `unknown_status` and is
 * never allowed to masquerade as an answer.
 */
export function parseAnswer(raw: unknown): ParsedAnswer {
  const record = asRecord(raw);
  if (!record) return { kind: "malformed" };

  const status = record.status;
  if (typeof status !== "string" || status === "") return { kind: "malformed" };

  const answerValue = record.answer;
  if (answerValue !== undefined && typeof answerValue !== "string") {
    return { kind: "malformed" };
  }
  const answer = asString(answerValue);

  if (!isGroundedStatus(status)) {
    return { kind: "unknown_status", status, answer, citations: toCitations(record.citations) };
  }

  return {
    kind: "grounded",
    status,
    answer,
    citations: toCitations(record.citations),
    unansweredAspects: asStringArray(record.unanswered_aspects),
    rationale:
      typeof record.missing_evidence_rationale === "string" &&
      record.missing_evidence_rationale.trim() !== ""
        ? record.missing_evidence_rationale
        : null,
    diagnostics:
      asRecord(record.diagnostics) !== null
        ? (record.diagnostics as AnswerDiagnostics)
        : null,
  };
}

