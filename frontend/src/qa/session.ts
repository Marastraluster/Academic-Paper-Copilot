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
import { teardownNotes } from "@/notes/session";
import { listSections } from "@/api/documents";
import { fetchIr } from "@/api/ir";
import { listProfiles } from "@/api/profiles";
import { askQuestion, type QaScope } from "@/api/qa";
import { describeApiError } from "@/translation/errors";
import { parseAnswer, type Citation } from "@/qa/parse";
import {
  matchParagraphs,
  readDomSelection,
  toPdfRects,
  type SelectionMapping,
} from "@/qa/selection";
import {
  nextTurnId,
  selectActiveSelection,
  selectActiveTurns,
  selectEffectiveMode,
  activeSectionFor,
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
  selection: SelectionMapping | null = null,
  section: QaSection | null = null,
): QaScope | null {
  switch (scopeType) {
    case "whole_paper":
      return { type: "whole_paper" };
    case "page":
      return Number.isInteger(activePage) && activePage >= 1
        ? { type: "page", page: activePage }
        : null;
    case "section":
      // AC_CHANGE_REQUEST 4: the section the user explicitly chose wins, and
      // is sticky; otherwise the section the reading position resolves to. This
      // is the *only* place a Section scope is built, so the canonical id that
      // reaches the backend cannot come from a title.
      return section ? { type: "section", section_id: section.id } : null;
    case "selection": {
      // DS-QA-005: the canonical ids the browser mapped the drag onto. Empty
      // means there is no honest selection to send — and the one thing this must
      // never do is answer the whole paper under a Selection label.
      const ids = selection?.paragraphIds ?? [];
      return ids.length > 0 ? { type: "selection", paragraph_ids: ids } : null;
    }
  }
}

/** What the scope was, in words, frozen onto the turn when it was asked. */
export function describeScope(
  scopeType: QaScopeType,
  activePage: number,
  section: QaSection | null,
): string {
  switch (scopeType) {
    case "whole_paper":
      return "整篇论文";
    case "page":
      return `第 ${activePage} 页`;
    case "section":
      return section ? `章节 · ${section.title}` : "章节";
    case "selection":
      return "选中内容";
  }
}

/** Whether the scope can be used right now, for the selector and its labels. */
export function scopeAvailability(
  activePage: number,
  selection: SelectionMapping | null = null,
  section: QaSection | null = null,
): Record<QaScopeType, boolean> {
  return {
    whole_paper: true,
    page: Number.isInteger(activePage) && activePage >= 1,
    section: section !== null,
    // DS-QA-005: available only when a drag actually resolved to canonical
    // paragraphs. An unmappable selection leaves it unavailable, which is the
    // honest answer and the one DS-QA-003 shipped.
    selection: (selection?.paragraphIds.length ?? 0) > 0,
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

  if (state.submitting) return; // one at a time; no duplicate in-flight

  const scopeType = scopeOverride ?? state.scope;
  const text = question.trim();
  // AC-P0-07 refuses an empty question for a searchable scope — there is nothing
  // to search for. AC-10 is the one exception: under a Selection an empty
  // question is the "explain what I highlighted" case, which the backend
  // implements by returning the selected paragraphs without running FTS.
  if (!text && scopeType !== "selection") return;
  const scope = buildScope(
    scopeType,
    state.activePage,
    selectActiveSelection(state)?.mapping ?? null,
    activeSectionFor(state),
  );
  if (scope === null) return; // AC-P0-05 — no identity, no request

  const { documentId, sessionToken } = document;
  const turnId = nextTurnId();

  const turn: QaTurn = {
    id: turnId,
    question: text,
    scopeType,
    scopeLabel: describeScope(scopeType, state.activePage, activeSectionFor(state)),
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

// --- the IR ------------------------------------------------------------------

let activeIr: AbortController | null = null;

/**
 * Fetch the canonical IR, once, for the document that is open.
 *
 * Selection mapping intersects live geometry against these boxes on every
 * mouse-up, so it has to be local — a round trip per selection would make the
 * reader feel broken. Failure leaves selection unavailable and everything else
 * working; the IR is an enhancement to one scope, not a prerequisite.
 */
export async function loadIr(): Promise<void> {
  const document = useWorkspaceStore.getState().document;
  if (!document || document.documentId === null || document.registration !== "ready") {
    return;
  }
  const { documentId, sessionToken } = document;

  activeIr?.abort();
  const controller = new AbortController();
  activeIr = controller;

  try {
    const ir = await fetchIr(documentId, { signal: controller.signal });
    if (!isCurrent(documentId, sessionToken)) return;
    useWorkspaceStore.setState({ ir });
  } catch {
    // Leave it null: Selection stays unavailable and says so.
  } finally {
    if (activeIr === controller) activeIr = null;
  }
}

// --- selection ----------------------------------------------------------------

const EMPTY_MAPPING: SelectionMapping = {
  status: "unavailable",
  paragraphIds: [],
  pages: [],
  text: "",
  truncated: false,
  rects: {},
};

/**
 * Resolve the current browser selection to canonical paragraph ids.
 *
 * Never guesses, and never falls back: a selection that maps to no paragraph
 * leaves Selection unavailable rather than labelling a whole-paper search as a
 * selection. Every refusal carries the reason, so the sidebar can say which one
 * it was instead of a generic "unavailable".
 */
export function captureSelection(): SelectionMapping | null {
  const state = useWorkspaceStore.getState();
  const document = state.document;
  if (!document || document.documentId === null) return null;

  const dom = readDomSelection(
    typeof window === "undefined" ? null : window.getSelection(),
  );
  if (dom.isCollapsed || dom.byPage.length === 0) {
    return { ...EMPTY_MAPPING, status: "collapsed" };
  }

  // A pane showing the translation is a re-laid-out document; its geometry is
  // not the source's and no validated mapping between them exists.
  if (dom.translatedPane) return { ...EMPTY_MAPPING, status: "non_prose", text: dom.text };

  // Both pages must be mounted for a browser range to span them, and the viewer
  // windows pages — so this is refused rather than mapped onto whichever page
  // came first.
  if (dom.crossPage) {
    return {
      status: "cross_page",
      paragraphIds: [],
      pages: dom.byPage.map((entry) => entry.page),
      text: dom.text,
      truncated: false,
      rects: {},
    };
  }

  if (!state.ir) return { ...EMPTY_MAPPING, status: "unavailable", text: dom.text };

  const { page: pageNumber, element, rects } = dom.byPage[0]!;
  const irPage = state.ir.pages.find((candidate) => candidate.page_number === pageNumber);
  const scale = Number(element.dataset.pageScale ?? "0");
  if (!irPage || !(scale > 0)) {
    return { ...EMPTY_MAPPING, status: "unavailable", text: dom.text };
  }

  const pdfRects = toPdfRects(rects, element.getBoundingClientRect(), scale, irPage);
  if (pdfRects.length === 0) {
    return { ...EMPTY_MAPPING, status: "unavailable", text: dom.text };
  }

  return matchParagraphs(new Map([[pageNumber, pdfRects]]), state.ir.paragraphs, dom.text);
}

/**
 * Record a new selection.
 *
 * **A collapsed selection is ignored, not treated as a cleared one.** That is not
 * a detail: clicking the Ask button takes focus out of the page and collapses the
 * browser's selection, so clearing on collapse would destroy the very thing the
 * request is about — the highlighted text — at the moment the reader asks about
 * it. The measurement caught this as a request that was never sent.
 *
 * Clearing is an explicit act: it happens when the reader clicks in the paper,
 * where collapsing the selection *is* the intent. See `clearSelection`.
 *
 * Deliberately does **not** touch the chosen scope either. Highlighting a
 * sentence to copy it must not silently replace the scope the user picked; the
 * mapping makes Selection *available*, and choosing it stays a user action.
 */
export function refreshSelection(): SelectionMapping | null {
  const mapping = captureSelection();
  const document = useWorkspaceStore.getState().document;

  if (!document || document.documentId === null || !mapping) return null;
  if (mapping.status === "collapsed") return null;

  if (mapping.status !== "valid" && mapping.status !== "partial") {
    // The refusal is recorded as a *status*, so the sidebar can say which one it
    // was. A generic "unavailable" would leave the reader guessing at the fix.
    useWorkspaceStore.setState({ selection: null, selectionStatus: mapping.status });
    return mapping;
  }

  useWorkspaceStore.setState({
    selection: {
      documentId: document.documentId,
      sessionToken: document.sessionToken,
      mapping,
    },
    selectionStatus: mapping.status,
  });
  return mapping;
}

/** Drop the mapping. Called when the reader clicks in the paper, not in the sidebar. */
export function clearSelection(): void {
  useWorkspaceStore.setState({ selection: null, selectionStatus: null });
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
        parentId: section.parent_id,
        pageNumber: section.page_number,
        pageRange: section.page_range,
        bbox: section.bbox,
        anchor: section.anchor,
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
  activeIr?.abort();
  activeIr = null;

  // Notes are the user's own data and are cleared from the *view* on close like
  // every other scope — the rows stay in the database, keyed to the paper's
  // fingerprint, and come back when the same PDF is opened again.
  teardownNotes();

  useWorkspaceStore.setState({
    turns: [],
    submitting: false,
    question: "",
    sections: null,
    activePage: 1,
    jumpRequest: null,
    translatedJump: null,
    notice: null,
    scope: "whole_paper",
    // DS-QA-008. The outline's own state names sections of the paper being
    // closed: an active section, a section handed to Paper QA, and which nodes
    // were expanded. Section ids are document-prefixed so a stale one could not
    // match paper B's list — but leaving them set means the outline briefly
    // claims a selection from a paper that is no longer open, and AC-P0-13 asks
    // for the state to be cleared rather than merely harmless.
    activeSectionId: null,
    selectedSectionId: null,
    expandedSectionIds: [],
    readingPosition: { pageNumber: 1, offsetPt: 0 },
    profiles: null,
    profilesError: null,
    profileId: "",
    // The IR holds paper A's paragraph ids and the selection names them: both are
    // released here, so neither can be reached while paper B is open.
    ir: null,
    selection: null,
    selectionStatus: null,
  });
}

/** The turns to render: those belonging to the open document. */
export function currentTurns(): QaTurn[] {
  return selectActiveTurns(useWorkspaceStore.getState());
}
