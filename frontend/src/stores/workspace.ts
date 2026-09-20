import { create } from "zustand";

import type { Bbox, DocumentIr } from "@/api/ir";
import type { ProviderProfile } from "@/api/profiles";
import type { AnnotationView } from "@/api/annotations";
import type { AnswerDiagnostics } from "@/api/qa";
import type { AnalysisView } from "@/api/analysis";
import type { Citation } from "@/qa/parse";
import type { MappingStatus, SelectionMapping } from "@/qa/selection";
import type { UserFacingError } from "@/translation/errors";

/** AC-04: the three reader modes. */
export type ReaderMode = "original" | "bilingual" | "translation";

/** The tabs the reader-side panel can show. */
export type SidebarPanel = "overview" | "outline" | "qa" | "notes";

/* ------------------------------------------------------------------ *
 * Paper QA (DS-QA-003)
 * ------------------------------------------------------------------ */

/**
 * The scopes the backend accepts, in its own vocabulary.
 *
 * The UI used to say `"document"` where the API says `"whole_paper"`, and the
 * two must not be mixed: `Scope` is `extra="forbid"`, so the wrong word is a 422
 * rather than a silently different search.
 */
export type QaScopeType = "whole_paper" | "page" | "section" | "selection";

/** A section as `GET /api/documents/{id}/sections` returns it. */
export interface QaSection {
  id: string;
  title: string;
  level: number | null;
  /** The section this one nests under, or `null` for a root. */
  parentId: string | null;
  /** 1-based page the section starts on. */
  pageNumber: number;
  /** `[first, last]` pages the section touches. */
  pageRange: [number, number];
  /** Heading box in PDF points, or `null` when the ladder fell back. */
  bbox: [number, number, number, number] | null;
  /** Which rung produced the location: `heading` | `paragraph` | `page`. */
  anchor: "heading" | "paragraph" | "page";
  isReferences: boolean;
}

/**
 * The two axes, kept apart.
 *
 * `grounded` is the backend's semantic answer and is always a success — including
 * `insufficient_evidence`, which is the system correctly declining to answer.
 * `error` is a transport or provider failure, which is a different thing that
 * happens to also produce no answer. Collapsing them would tell a user the paper
 * does not answer their question when the provider was simply unreachable.
 */
export type QaResult =
  | { state: "pending" }
  | {
      state: "grounded";
      status: "answered" | "partial" | "insufficient_evidence";
      answer: string;
      citations: Citation[];
      unansweredAspects: string[];
      rationale: string | null;
      diagnostics: AnswerDiagnostics | null;
    }
  /** A status this build does not recognise. Never rendered as an answer. */
  | { state: "unknown_status"; status: string; answer: string; citations: Citation[] }
  /** The body was not an answer at all. */
  | { state: "malformed" }
  | { state: "error"; error: UserFacingError };

/**
 * One asked question and whatever came back.
 *
 * Every turn carries the document it belongs to. History is a *presentation*
 * convenience — each request is a separate single-turn call and none of this is
 * ever sent back as context — but a turn still has to know which paper it is
 * about, or switching documents would show paper A's answer under paper B.
 */
export interface QaTurn {
  id: string;
  question: string;
  scopeType: QaScopeType;
  /** What the scope was when the question was asked, for display. Frozen. */
  scopeLabel: string;
  profileId: string;
  documentId: string;
  sessionToken: string;
  result: QaResult;
}

/**
 * Where a drag covered source geometry, before any domain has interpreted it.
 *
 * `rects` is per page in source-PDF points; `text` is what the browser reported.
 * Neither says what the selection *means* — that is what the two mappers decide.
 */
export interface SelectionGeometry {
  documentId: string;
  sessionToken: string;
  pages: number[];
  text: string;
  rects: Record<number, Bbox[]>;
}

/**
 * A resolved text selection, and where it came from.
 *
 * Carries its document identity for the same reason a translation does: a
 * selection belongs to one paper, and paper A's paragraph ids must be
 * unreachable — not merely ignored — while paper B is open.
 */
export interface SelectionState {
  documentId: string;
  sessionToken: string;
  mapping: SelectionMapping;
}

/** A request for the original viewer to move, and to mark the cited region. */
export interface JumpRequest {
  /** 1-based, exactly as `ResolvedCitation.page_number` gives it. */
  pageNumber: number;
  /** Source-PDF boxes in points. Never applied to the translated pane. */
  bboxes: number[][];
  /**
   * Optional distance into the page in PDF points, so a section heading can be
   * brought to the top of the viewport rather than its page. `null` for a
   * citation jump, which names a page and a box and has no heading to land on.
   */
  offsetPt: number | null;
  /** Bumped per request so an identical jump repeated still fires. */
  nonce: number;
}

export type EngineState = "offline" | "connecting" | "ready" | "error";

/** Where backend registration of the open file has got to. */
export type RegistrationState = "pending" | "ready" | "failed";

export interface OpenDocument {
  /**
   * Client-side identity for *this opening* of a file.
   *
   * A new token is minted every time a file is opened, so a late response from a
   * previous opening can be recognised and dropped even when it concerns the
   * same file — and, before a `documentId` exists at all.
   */
  sessionToken: string;
  name: string;
  /** Held so the reader can parse it locally without waiting for the backend. */
  file: File;
  /** Backend identity. `null` until registration succeeds. */
  documentId: string | null;
  registration: RegistrationState;
  registrationError: UserFacingError | null;
  /**
   * Page count as the backend counted it.
   *
   * Kept because the bilingual view aligns page *i* to page *i*: if the
   * translated artifact has a different page count, the user needs to be told
   * rather than left to discover it by scrolling into a gap.
   */
  backendPageCount: number | null;
}

export type TranslationStatus =
  | "idle"
  | "submitting"
  | "translating"
  | "success"
  | "failed";

export interface TranslationProgress {
  page: number;
  pageCount: number;
}

export interface TranslationState {
  /**
   * The document this result belongs to.
   *
   * This field is the reason a translation can never be shown against the wrong
   * document: nothing reads the translation without also checking this, so a
   * stray event for a document the user has moved on from updates a record that
   * is no longer displayed — rather than corrupting the one that is.
   */
  documentId: string;
  sessionToken: string;
  taskId: string | null;
  status: TranslationStatus;
  /** Real page progress, or `null` when the backend has not reported any yet. */
  progress: TranslationProgress | null;
  error: UserFacingError | null;
  /** Object URL of the fetched mono artifact. Owned here so it can be revoked. */
  monoUrl: string | null;
  monoPageCount: number | null;
  /** The live stream dropped; progress now comes from polling. */
  degraded: boolean;
}

interface WorkspaceState {
  // ---- Document ----
  document: OpenDocument | null;

  // ---- Translation ----
  translation: TranslationState | null;

  // ---- Reader ----
  readerMode: ReaderMode;
  setReaderMode: (mode: ReaderMode) => void;

  /**
   * The page the *original* viewer is showing, 1-based.
   *
   * Reported by the original pane and used for Page scope and its label. It is
   * never estimated from scroll position here: the viewer already knows which
   * page it is on, and a second estimate would be a second source of truth.
   */
  activePage: number;
  setActivePage: (page: number) => void;

  /**
   * Where the reader is, for current-section tracking: the page, and how far
   * down it in PDF points. Reported by the original pane.
   *
   * Deliberately richer than `activePage`: a page can carry four sections, so
   * the page number alone cannot say which one the reader is in.
   */
  readingPosition: { pageNumber: number; offsetPt: number };
  setReadingPosition: (position: { pageNumber: number; offsetPt: number }) => void;

  /** The section the reading position resolves to. Follows the reader. */
  activeSectionId: string | null;
  setActiveSectionId: (sectionId: string | null) => void;

  /** The section the user explicitly chose. Sticky, and wins over `active`. */
  selectedSectionId: string | null;
  setSelectedSectionId: (sectionId: string | null) => void;

  /** Which panel the sidebar is showing. */
  outlinePanel: SidebarPanel;
  setOutlinePanel: (panel: SidebarPanel) => void;

  // ---- Notes (DS-QA-010) ----
  /**
   * The open document's annotations, as the backend resolved them.
   *
   * `null` means "not loaded yet", which the panel shows differently from "none".
   * They are *resolved* views, not stored records: re-reading the paper after an
   * extraction change is what moves a target from EXACT to REATTACHED, and this
   * is where the result lands.
   */
  annotations: AnnotationView[] | null;
  setAnnotations: (annotations: AnnotationView[] | null) => void;
  /**
   * Which document `annotations` describes, or `null` when nothing is loaded.
   *
   * Separate from `annotations` because "the list is empty" and "the list has not
   * been fetched" are different states, and an effect cannot tell them apart from
   * the array alone — a distinction that cost a browser run to learn.
   */
  annotationsFor: string | null;
  setAnnotationsFor: (documentId: string | null) => void;

  /** The annotation the reader is looking at, for list highlighting. */
  activeAnnotationId: string | null;
  setActiveAnnotationId: (annotationId: string | null) => void;

  /** `section_id`s the user has expanded. Ids, never titles or indices. */
  expandedSectionIds: string[];
  toggleSectionExpanded: (sectionId: string) => void;
  expandSections: (sectionIds: string[]) => void;

  /** A pending request for the original viewer to move and highlight. */
  jumpRequest: JumpRequest | null;
  requestJump: (pageNumber: number, bboxes: number[][], offsetPt?: number) => void;

  /**
   * A pending request for the **translated** pane to move, in bilingual mode.
   *
   * Deliberately separate from `jumpRequest`, and set only by outline
   * navigation. Citations leave the translated pane where the reader left it
   * (AC-P1-01: the two panes navigate independently), and routing them through
   * this channel would quietly make that lockstep. An outline click is a
   * different act: the reader asked for a *section*, and in a side-by-side view
   * leaving the facing pane on an unrelated page makes the two disagree.
   *
   * Carries no boxes — source geometry is never applied to the translated pane.
   */
  translatedJump: { pageNumber: number; nonce: number } | null;
  requestTranslatedJump: (pageNumber: number) => void;

  /**
   * A transient message about what just happened — currently only the "switched
   * to the original to show this citation" notice. Dismissed by the reader.
   */
  notice: string | null;
  setNotice: (notice: string | null) => void;

  /** The page the last jump landed on, so its highlight can fade on a page move. */
  clearJump: () => void;

  // ---- Paper QA ----
  scope: QaScopeType;
  setScope: (scope: QaScopeType) => void;
  question: string;
  setQuestion: (value: string) => void;
  /** True while a question is in flight. One at a time. */
  submitting: boolean;
  turns: QaTurn[];

  /**
   * Sections for the open document.
   *
   * `null` means "not resolved yet" — distinct from `[]`, which means the
   * backend has no section structure for this paper. Section scope is offered
   * only in the second case being false.
   */
  sections: QaSection[] | null;
  setSections: (sections: QaSection[] | null) => void;

  /**
   * Provider profiles, loaded once per document rather than once per component.
   *
   * Four sidebar components need to know whether a provider exists; four copies
   * of that state would mean four requests and four chances to disagree.
   */
  profiles: ProviderProfile[] | null;
  profilesError: string | null;
  profileId: string;
  setProfiles: (profiles: ProviderProfile[] | null, error?: string | null) => void;
  setProfileId: (id: string) => void;

  /**
   * The canonical IR, fetched once per document.
   *
   * Selection mapping intersects live geometry against these boxes on every
   * mouse-up, so it has to be local. Released on document switch — the ids in it
   * belong to one paper and must never be sendable against another.
   */
  ir: DocumentIr | null;
  setIr: (ir: DocumentIr | null) => void;

  /** The current selection's canonical mapping, bound to the document it came from. */
  selection: SelectionState | null;
  setSelection: (selection: SelectionState | null) => void;
  /**
   * Why the last selection attempt was refused, if it was.
   *
   * Kept so the scope selector can say *which* reason — a heading, a figure, a
   * cross-page drag — rather than a generic "unavailable" that teaches the reader
   * nothing about what to do differently.
   */
  selectionStatus: MappingStatus | null;
  setSelectionStatus: (status: MappingStatus | null) => void;
  /**
   * The refusal in the reader's own terms, when the mapping carried one.
   *
   * A status is a category; `cross_page_refused` covers four different
   * situations with four different fixes. The sentence the mapper produced is
   * stored beside the status so the sidebar can show the reader their own
   * problem. Empty whenever the status is not a refusal.
   */
  selectionReason: string;
  setSelectionReason: (reason: string) => void;
  /**
   * The source geometry of the last selection, whatever it mapped to.
   *
   * Kept separate from `selection` because the two answer different questions.
   * `selection` is *"what may a question be scoped to"* and is deliberately
   * paragraph-only. This is *"where on the page did the reader drag"* — the
   * measured rectangles and the text — which the annotation path also needs for
   * the non-prose classes a question may never use.
   *
   * One DOM read, one coordinate conversion, two domain filters. The alternative
   * — reading the browser selection twice and converting twice — is two answers
   * that agree until one of them is edited.
   */
  selectionGeometry: SelectionGeometry | null;
  setSelectionGeometry: (geometry: SelectionGeometry | null) => void;

  // ---- Paper overview (DS-QA-014) ----
  /**
   * The stored analysis, or `null`.
   *
   * Null means *nothing has been loaded or generated*, which the panel reports
   * as "not generated yet" — never as "this paper has no summary", which would
   * be a claim about the paper rather than about what we have done.
   */
  analysis: AnalysisView | null;
  /** Which document `analysis` describes, so a stale one is never rendered. */
  analysisFor: string | null;
  analysisStatus: "idle" | "loading" | "generating" | "ready" | "failed";
  analysisError: string | null;
  /** When generation started, so elapsed time is real rather than simulated. */
  analysisStartedAt: number | null;

  // ---- Sidebar (AC-05) ----
  sidebarOpen: boolean;
  toggleSidebar: () => void;

  // ---- Status bar (AC-08) ----
  engine: { state: EngineState; label: string };
}

/** AC-P1-04: the academic quick actions, wired to real questions and scopes. */
export const QUICK_ACTIONS: ReadonlyArray<{
  label: string;
  /** `null` means "whatever scope is currently selected". */
  scope: QaScopeType | null;
  question: string;
  /** False for actions whose capability does not exist yet. */
  enabled: boolean;
}> = [
  {
    label: "总结本页",
    scope: "page",
    question: "请总结本页的核心内容与关键结论。",
    enabled: true,
  },
  {
    // DS-QA-003 §Decision D: there is no selection → paragraph mapping, so this
    // is disabled rather than answering about something the user did not select.
    label: "解释选中内容",
    scope: "selection",
    question: "请解释选中内容的含义。",
    enabled: false,
  },
  {
    label: "解释公式",
    scope: null,
    question: "请解释此处的数学公式及各变量的物理含义。",
    enabled: true,
  },
  {
    label: "总结方法",
    scope: "whole_paper",
    question: "请详细总结本文提出的方法、模型架构与核心算法。",
    enabled: true,
  },
  {
    label: "提取创新点",
    scope: "whole_paper",
    question: "本文的主要创新点与核心贡献是什么？",
    enabled: true,
  },
  {
    label: "总结实验结果",
    scope: "whole_paper",
    question: "请总结本文的实验设置、基线对比及主要实验结果。",
    enabled: true,
  },
];

let turnSeq = 0;
export const nextTurnId = (): string => {
  turnSeq += 1;
  return `qa-${turnSeq}`;
};

let sessionSeq = 0;
/** Mint a fresh client-side identity for one opening of a file. */
export function nextSessionToken(): string {
  sessionSeq += 1;
  return `open-${sessionSeq}`;
}

let jumpSeq = 0;

export const useWorkspaceStore = create<WorkspaceState>()((set) => ({
  document: null,
  translation: null,

  // AC-04 / DS-FE-003 §14: nothing is translated yet, so the only mode that can
  // honestly be shown is the original.
  readerMode: "original",
  setReaderMode: (mode) => set({ readerMode: mode }),

  activePage: 1,
  // One page, two readers. `activePage` labels Page scope; `readingPosition`
  // locates the reader inside the page. Updating the page without the position
  // would leave them disagreeing, so the setter moves both — a second way to
  // change one of them would be a second source of truth for the same fact.
  setActivePage: (page) =>
    set((state) => ({
      activePage: page,
      readingPosition: { ...state.readingPosition, pageNumber: page },
    })),

  readingPosition: { pageNumber: 1, offsetPt: 0 },
  setReadingPosition: (position) => set({ readingPosition: position }),

  activeSectionId: null,
  setActiveSectionId: (sectionId) => set({ activeSectionId: sectionId }),

  selectedSectionId: null,
  setSelectedSectionId: (sectionId) => set({ selectedSectionId: sectionId }),

  // DS-QA-008: the shipped panel is Paper QA, and the outline is one click away
  // in the tab strip. The criteria freeze the tab *structure* (Decision J) but not
  // which tab opens first, and defaulting to the outline would silently move every
  // existing QA affordance behind a click — a product change dressed as a layout
  // change. Revisit if product testing says otherwise.
  // Opening a paper lands on the overview: it is the answer to "what is this",
  // and it renders from data already held, so the first paint is never a spinner.
  outlinePanel: "overview",
  setOutlinePanel: (panel) => set({ outlinePanel: panel }),

  annotations: null,
  setAnnotations: (annotations) => set({ annotations }),

  annotationsFor: null,
  setAnnotationsFor: (documentId) => set({ annotationsFor: documentId }),

  activeAnnotationId: null,
  setActiveAnnotationId: (annotationId) => set({ activeAnnotationId: annotationId }),

  expandedSectionIds: [],
  toggleSectionExpanded: (sectionId) =>
    set((state) => ({
      expandedSectionIds: state.expandedSectionIds.includes(sectionId)
        ? state.expandedSectionIds.filter((id) => id !== sectionId)
        : [...state.expandedSectionIds, sectionId],
    })),
  expandSections: (sectionIds) =>
    set((state) => ({
      expandedSectionIds: [...new Set([...state.expandedSectionIds, ...sectionIds])],
    })),

  jumpRequest: null,
  requestJump: (pageNumber, bboxes, offsetPt) =>
    set({
      jumpRequest: {
        pageNumber,
        bboxes,
        offsetPt: offsetPt ?? null,
        nonce: (jumpSeq += 1),
      },
    }),

  translatedJump: null,
  requestTranslatedJump: (pageNumber) =>
    set({ translatedJump: { pageNumber, nonce: (jumpSeq += 1) } }),

  notice: null,
  setNotice: (notice) => set({ notice }),
  clearJump: () => set({ jumpRequest: null, translatedJump: null }),

  scope: "whole_paper",
  setScope: (scope) => set({ scope }),
  question: "",
  setQuestion: (value) => set({ question: value }),
  submitting: false,
  turns: [],
  sections: null,
  setSections: (sections) => set({ sections }),

  profiles: null,
  profilesError: null,
  profileId: "",
  setProfiles: (profiles, error = null) =>
    set((state) => ({
      profiles,
      profilesError: error,
      // Keep a chosen profile if it is still present; otherwise take the first,
      // so a deleted profile cannot leave the composer pointing at nothing.
      profileId:
        profiles && profiles.some((profile) => profile.id === state.profileId)
          ? state.profileId
          : (profiles?.[0]?.id ?? ""),
    })),
  setProfileId: (profileId) => set({ profileId }),

  ir: null,
  setIr: (ir) => set({ ir }),

  selection: null,
  setSelection: (selection) => set({ selection }),
  selectionStatus: null,
  selectionReason: "",
  setSelectionStatus: (selectionStatus) => set({ selectionStatus }),
  setSelectionReason: (selectionReason) => set({ selectionReason }),
  selectionGeometry: null,
  setSelectionGeometry: (selectionGeometry) => set({ selectionGeometry }),

  analysis: null,
  analysisFor: null,
  analysisStatus: "idle",
  analysisError: null,
  analysisStartedAt: null,

  // AC-05: expanded by default.
  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),

  // No backend contact has happened yet. Saying "connecting" would imply a
  // request is in flight; saying "ready" would claim a fact we have not checked.
  engine: { state: "offline", label: "未连接" },
}));

/**
 * The QA turns for the document currently open.
 *
 * The same guarantee `selectActiveTranslation` provides, for the same reason: a
 * turn belonging to a document the user has left is *unreachable* from the UI
 * rather than merely ignored by it. Filtering on read means no code path can
 * forget to check.
 */
export function selectActiveTurns(
  state: Pick<WorkspaceState, "document" | "turns">,
): QaTurn[] {
  const { document, turns } = state;
  if (!document || document.documentId === null) return [];
  return turns.filter(
    (turn) =>
      turn.documentId === document.documentId &&
      turn.sessionToken === document.sessionToken,
  );
}

/**
 * The selection for the document currently open, or `null`.
 *
 * The same guarantee the translation and the QA turns have, for the same reason:
 * paper A's paragraph ids are *unreachable* while paper B is open, so no code
 * path can send them by forgetting to check.
 */
export function selectActiveSelection(
  state: Pick<WorkspaceState, "document" | "selection">,
): SelectionState | null {
  const { document, selection } = state;
  if (!document || document.documentId === null || !selection) return null;
  if (selection.documentId !== document.documentId) return null;
  if (selection.sessionToken !== document.sessionToken) return null;
  return selection;
}

/**
 * The translation for the document currently open, or `null`.
 *
 * Every consumer goes through this rather than reading `translation` directly.
 * That is the whole cross-document guarantee: a result belonging to a document
 * the user has left is unreachable from the UI, not merely ignored by it.
 */
export function selectActiveTranslation(
  state: Pick<WorkspaceState, "document" | "translation">,
): TranslationState | null {
  const { document, translation } = state;
  if (!document || !translation) return null;
  if (document.documentId === null) return null;
  if (translation.documentId !== document.documentId) return null;
  if (translation.sessionToken !== document.sessionToken) return null;
  return translation;
}

/** True when a readable translated artifact exists for the open document. */
export function selectHasTranslation(
  state: Pick<WorkspaceState, "document" | "translation">,
): boolean {
  const translation = selectActiveTranslation(state);
  return translation?.status === "success" && translation.monoUrl !== null;
}

/**
 * The mode actually rendered.
 *
 * Stored separately from `readerMode` so the two cannot disagree: a failure or a
 * document switch that invalidates a translation falls back to the original
 * immediately, without a render pass in which the workspace would be showing a
 * translation that no longer belongs to the open document.
 */
export function selectEffectiveMode(
  state: Pick<WorkspaceState, "document" | "translation" | "readerMode">,
): ReaderMode {
  if (state.readerMode === "original") return "original";
  return selectHasTranslation(state) ? state.readerMode : "original";
}

/**
 * The section a Section scope should use, or `null`.
 *
 * **`selectSectionForPage` lived here and is gone.** It returned the last section
 * whose start page was at or before the current page, which is wrong on any page
 * carrying more than one section: measured on ResNet page 3, whose paragraphs
 * belong to four sections, it answered `3.3. Network Architectures` for a reader
 * at the top of the page in `2. Related Work`. The rule that replaced it lives in
 * `outline/currentSection.ts` and is expressed in canonical reading order, so a
 * two-column page cannot invert it.
 *
 * AC_CHANGE_REQUEST 4 froze the precedence: an **explicitly selected** section
 * wins and is sticky, because the user chose it deliberately; otherwise the
 * **active** section from the reading position. Asking a question clears the
 * selection, since the scope is then frozen onto that turn.
 */
export function activeSectionFor(
  state: Pick<WorkspaceState, "sections" | "activeSectionId" | "selectedSectionId">,
): QaSection | null {
  if (!state.sections || state.sections.length === 0) return null;
  const wanted = state.selectedSectionId ?? state.activeSectionId;
  if (wanted === null) return null;
  return state.sections.find((section) => section.id === wanted) ?? null;
}
