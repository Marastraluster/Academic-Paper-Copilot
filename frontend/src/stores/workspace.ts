import { create } from "zustand";

import type { ProviderProfile } from "@/api/profiles";
import type { AnswerDiagnostics } from "@/api/qa";
import type { Citation } from "@/qa/parse";
import type { UserFacingError } from "@/translation/errors";

/** AC-04: the three reader modes. */
export type ReaderMode = "original" | "bilingual" | "translation";

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
  /** 1-based page the section starts on. */
  pageNumber: number;
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

/** A request for the original viewer to move, and to mark the cited region. */
export interface JumpRequest {
  /** 1-based, exactly as `ResolvedCitation.page_number` gives it. */
  pageNumber: number;
  /** Source-PDF boxes in points. Never applied to the translated pane. */
  bboxes: number[][];
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

  /** A pending request for the original viewer to move and highlight. */
  jumpRequest: JumpRequest | null;
  requestJump: (pageNumber: number, bboxes: number[][]) => void;

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
  setActivePage: (page) => set({ activePage: page }),

  jumpRequest: null,
  requestJump: (pageNumber, bboxes) =>
    set({ jumpRequest: { pageNumber, bboxes, nonce: (jumpSeq += 1) } }),

  notice: null,
  setNotice: (notice) => set({ notice }),
  clearJump: () => set({ jumpRequest: null }),

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
 * The section that governs the page the reader is on, or `null`.
 *
 * The last section whose start page is at or before the current one — sections
 * arrive in reading order, so "last" is "the most recent one a reader has
 * passed". Deliberately returns `null` rather than guessing when there is no such
 * section: Section scope is only offered when it has a real identity.
 */
export function selectSectionForPage(
  sections: QaSection[] | null,
  page: number,
): QaSection | null {
  if (!sections || sections.length === 0) return null;
  let found: QaSection | null = null;
  for (const section of sections) {
    if (section.pageNumber <= page) found = section;
    else break;
  }
  return found;
}
