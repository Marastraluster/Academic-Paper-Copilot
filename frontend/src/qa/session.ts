/**
 * Drives Paper QA from the UI's point of view.
 *
 * The store holds plain data; this module owns what is not data — the in-flight
 * request, its abort controller, and the section fetch. It mirrors
 * `translation/session.ts` deliberately, including its one rule:
 *
 * **Every asynchronous continuation re-checks `isCurrent(documentId,
 * sessionToken)` after the await, not before it.** A guard that runs when the
 * work starts proves only that it made sense to start; by the time the answer
 * arrives the user may be reading a different paper, and paper A's answer must
 * never appear under paper B.
 *
 * Each question is a separate, independent single-turn request. Nothing here
 * sends a previous question, answer or citation back to the backend — the
 * visible history is presentation state and nothing more.
 */
import { isAbortError } from "@/api/client";
import { listSections } from "@/api/documents";
import { listProfiles } from "@/api/profiles";
import { askQuestion, type QaScope } from "@/api/qa";
import { describeApiError } from "@/translation/errors";
import { parseAnswer, type Citation } from "@/qa/parse";
import {
  nextTurnId,
  selectActiveTurns,
  selectEffectiveMode,
  selectSectionForPage,
  useWorkspaceStore,
  type QaResult,
  type QaScopeType,
  type QaSection,
  type QaTurn,
} from "@/stores/workspace";
import { describeQaError } from "@/qa/errors";

/** At most one question is in flight. A new one supersedes the old. */
let activeRequest: AbortController | null = null;
let activeSections: AbortController | null = null;

// --- guards -----------------------------------------------------------------

/** Is the given identity still the document the user is looking at? */
export function isCurrent(documentId: string, sessionToken: string): boolean {
  const { document } = useWorkspaceStore.getState();
  return (
    document !== null &&
    document.documentId === documentId &&
    document.sessionToken === sessionToken
  );
}

// --- scope ------------------------------------------------------------------

/**
 * Turn the selector's choice into a request scope, or `null` if it has no
 * identity to stand on.
 *
 * `null` means the question must not be asked. Sending `{"type": "page"}` with
 * no page, or a section scope naming a section that could not be resolved, earns
 * a 422 and tells the user nothing; refusing locally and saying which identity is
 * missing is the honest version.
 */
export function buildScope(
  scopeType: QaScopeType,
  activePage: number,
  sections: QaSection[] | null,
): QaScope | null {
  switch (scopeType) {
    case "whole_paper":
      return { type: "whole_paper" };
    case "page":
      return Number.isInteger(activePage) && activePage >= 1
        ? { type: "page", page: activePage }
        : null;
    case "section": {
      const section = selectSectionForPage(sections, activePage);
      return section ? { type: "section", section_id: section.id } : null;
    }
    case "selection":
      // DS-QA-003 Decision D: there is no selection → paragraph mapping yet, so
      // there is no honest paragraph_ids list to send. Answering the whole paper
      // and labelling it "selection" is the one thing this must not do.
      return null;
  }
}

/** What the scope was, in words, frozen onto the turn when it was asked. */
export function describeScope(
  scopeType: QaScopeType,
  activePage: number,
  sections: QaSection[] | null,
): string {
  switch (scopeType) {
    case "whole_paper":
      return "整篇论文";
    case "page":
      return `第 ${activePage} 页`;
    case "section": {
      const section = selectSectionForPage(sections, activePage);
      return section ? `章节 · ${section.title}` : "章节";
    }
    case "selection":
      return "选中内容";
  }
}

/** Whether the scope can be used right now, for the selector and its labels. */
export function scopeAvailability(
  sections: QaSection[] | null,
  activePage: number,
): Record<QaScopeType, boolean> {
  return {
    whole_paper: true,
    page: Number.isInteger(activePage) && activePage >= 1,
    section: selectSectionForPage(sections, activePage) !== null,
    // Deferred, never "unavailable for now but let's guess anyway".
    selection: false,
  };
}

// --- asking -----------------------------------------------------------------

function toResult(parsed: ReturnType<typeof parseAnswer>): QaResult {
  switch (parsed.kind) {
    case "malformed":
      return { state: "malformed" };
    case "unknown_status":
      return {
        state: "unknown_status",
        status: parsed.status,
        answer: parsed.answer,
        citations: parsed.citations,
      };
    case "grounded":
      return {
        state: "grounded",
        status: parsed.status,
        answer: parsed.answer,
        citations: parsed.citations,
        unansweredAspects: parsed.unansweredAspects,
        rationale: parsed.rationale,
        diagnostics: parsed.diagnostics,
      };
  }
}

function patchTurn(turnId: string, result: QaResult): void {
  useWorkspaceStore.setState((state) => ({
    turns: state.turns.map((turn) =>
      turn.id === turnId ? { ...turn, result } : turn,
    ),
  }));
}

export interface AskOptions {
  question: string;
  profileId: string;
  /** Ask in this scope instead of the selector's. Used by quick actions. */
  scopeOverride?: QaScopeType;
  /** Clear the composer only when the question came from it. */
  fromComposer?: boolean;
}

/**
 * Ask one question about the open document.
 *
 * Returns when the answer has been recorded or the request has failed; there is
 * nothing for the caller to await beyond that.
 */
export async function askQa({
  question,
  profileId,
  scopeOverride,
  fromComposer = true,
}: AskOptions): Promise<void> {
  const state = useWorkspaceStore.getState();
  const document = state.document;
  if (!document || document.documentId === null || document.registration !== "ready") {
    return;
  }

  const text = question.trim();
  if (!text) return; // AC-P0-07
  if (state.submitting) return; // one at a time; no duplicate in-flight

  const scopeType = scopeOverride ?? state.scope;
  const scope = buildScope(scopeType, state.activePage, state.sections);
  if (scope === null) return; // AC-P0-05 — no identity, no request

  const { documentId, sessionToken } = document;
  const turnId = nextTurnId();

  const turn: QaTurn = {
    id: turnId,
    question: text,
    scopeType,
    scopeLabel: describeScope(scopeType, state.activePage, state.sections),
    profileId,
    documentId,
    sessionToken,
    result: { state: "pending" },
  };

  useWorkspaceStore.setState((current) => ({
    turns: [...current.turns, turn],
    submitting: true,
    ...(fromComposer ? { question: "" } : {}),
  }));

  // A previous request cannot still be in flight — `submitting` is checked above
  // — but aborting is cheap and makes the invariant hold even if that changes.
  activeRequest?.abort();
  const controller = new AbortController();
  activeRequest = controller;

  try {
    const raw = await askQuestion(documentId, {
      question: text,
      scope,
      profileId,
      signal: controller.signal,
    });
    if (!isCurrent(documentId, sessionToken)) return;
    patchTurn(turnId, toResult(parseAnswer(raw)));
  } catch (cause) {
    if (isAbortError(cause)) return;
    if (!isCurrent(documentId, sessionToken)) return;
    patchTurn(turnId, { state: "error", error: describeQaError(cause) });
  } finally {
    // Only the request that is still current may clear the flag: a later
    // question started after this one was superseded must not be marked idle by
    // its predecessor finishing.
    if (activeRequest === controller) {
      activeRequest = null;
      useWorkspaceStore.setState({ submitting: false });
    }
  }
}

/** Ask again, using the same question, scope and profile as the given turn. */
export async function retryTurn(turnId: string): Promise<void> {
  const turn = useWorkspaceStore.getState().turns.find((item) => item.id === turnId);
  if (!turn) return;
  await askQa({
    question: turn.question,
    profileId: turn.profileId,
    scopeOverride: turn.scopeType,
    fromComposer: false,
  });
}

// --- providers ---------------------------------------------------------------

let activeProfiles: AbortController | null = null;

/**
 * Load the provider profiles, once, for the document that is open.
 *
 * A question cannot be asked without one, and the difference between "no
 * provider is configured" and "the provider list could not be read" is the
 * difference between a setup step and a failure — so the two are stored
 * separately rather than both arriving as an empty list.
 */
export async function loadProfiles(): Promise<void> {
  const document = useWorkspaceStore.getState().document;
  if (!document || document.registration !== "ready" || document.documentId === null) {
    return;
  }
  const sessionToken = document.sessionToken;

  activeProfiles?.abort();
  const controller = new AbortController();
  activeProfiles = controller;

  try {
    const profiles = await listProfiles(controller.signal);
    if (useWorkspaceStore.getState().document?.sessionToken !== sessionToken) return;
    useWorkspaceStore.getState().setProfiles(profiles, null);
  } catch (cause) {
    if (isAbortError(cause)) return;
    if (useWorkspaceStore.getState().document?.sessionToken !== sessionToken) return;
    useWorkspaceStore.getState().setProfiles([], describeApiError(cause).detail);
  } finally {
    if (activeProfiles === controller) activeProfiles = null;
  }
}

// --- sections ---------------------------------------------------------------

/**
 * Resolve the document outline, so Section scope has a real identity.
 *
 * Failure is not fatal and is not reported as an error: Section scope simply
 * stays unavailable and Whole Paper still works. A section list is an
 * enhancement to one scope, not a prerequisite for asking anything.
 */
export async function loadSections(): Promise<void> {
  const document = useWorkspaceStore.getState().document;
  if (!document || document.documentId === null || document.registration !== "ready") {
    return;
  }
  const { documentId, sessionToken } = document;

  activeSections?.abort();
  const controller = new AbortController();
  activeSections = controller;

  try {
    const sections = await listSections(documentId, { signal: controller.signal });
    if (!isCurrent(documentId, sessionToken)) return;
    useWorkspaceStore.setState({
      sections: sections.map((section) => ({
        id: section.id,
        title: section.title,
        level: section.level,
        pageNumber: section.page_number,
        isReferences: section.is_references,
      })),
    });
  } catch {
    // Leave `sections` as it is. `null` reads as "not resolved", which disables
    // Section scope without claiming the paper has no sections.
  } finally {
    if (activeSections === controller) activeSections = null;
  }
}

// --- citations --------------------------------------------------------------

/**
 * Go to the source a citation names (Decisions A and B).
 *
 * The page number is the backend's, from the `DocumentIR`. It is never derived
 * from the answer text, and it is never adjusted — both the API and the viewer
 * count pages from 1.
 *
 * In **translation** mode the reader is switched to the original first: the
 * translated PDF is re-laid-out, so a source page number is not a page in it, and
 * a source bounding box would land on unrelated text. In **bilingual** mode only
 * the original pane is asked to move — the two panes are independent viewers, and
 * the translated one stays where the reader left it.
 */
export function jumpToCitation(citation: Citation): void {
  if (!citation.jumpable || citation.pageNumber === null) return;

  const state = useWorkspaceStore.getState();
  if (selectEffectiveMode(state) === "translation") {
    state.setReaderMode("original");
    state.setNotice(
      `已切换至原文第 ${citation.pageNumber} 页查看引用，可随时在顶部切回译文。`,
    );
  } else {
    state.setNotice(null);
  }
  state.requestJump(citation.pageNumber, citation.bboxes);
}

// --- teardown ---------------------------------------------------------------

/**
 * Drop everything Paper QA is doing for the document being left.
 *
 * Called on document switch and on close, alongside `teardownTranslation`. The
 * turns themselves are cleared rather than kept: history belongs to a document,
 * and carrying paper A's questions into paper B would be exactly the leak
 * AC-P0-19 exists to prevent.
 */
export function teardownQa(): void {
  activeRequest?.abort();
  activeRequest = null;
  activeSections?.abort();
  activeSections = null;
  activeProfiles?.abort();
  activeProfiles = null;

  useWorkspaceStore.setState({
    turns: [],
    submitting: false,
    question: "",
    sections: null,
    activePage: 1,
    jumpRequest: null,
    notice: null,
    scope: "whole_paper",
    profiles: null,
    profilesError: null,
    profileId: "",
  });
}

/** The turns to render: those belonging to the open document. */
export function currentTurns(): QaTurn[] {
  return selectActiveTurns(useWorkspaceStore.getState());
}
