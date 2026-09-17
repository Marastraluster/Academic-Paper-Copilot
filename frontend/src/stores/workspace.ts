import { create } from "zustand";

import type { UserFacingError } from "@/translation/errors";

/** AC-04: the three reader modes. */
export type ReaderMode = "original" | "bilingual" | "translation";

/** AC-06: assistant context scope. */
export type AssistantScope = "selection" | "page" | "section" | "document";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
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
   * same file — and, more importantly, before a `documentId` exists at all.
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

  // ---- Sidebar (AC-05) ----
  sidebarOpen: boolean;
  toggleSidebar: () => void;

  // ---- Assistant (AC-06) ----
  scope: AssistantScope;
  setScope: (scope: AssistantScope) => void;
  messages: ChatMessage[];
  composerValue: string;
  setComposerValue: (value: string) => void;
  /** AC-18: blank / whitespace-only submissions are ignored. */
  submitComposer: () => void;
  runQuickAction: (label: string) => void;

  // ---- Status bar (AC-08) ----
  engine: { state: EngineState; label: string };
}

/** AC-06: the six required academic quick actions. */
export const QUICK_ACTIONS = [
  "总结本页",
  "解释选中内容",
  "解释公式",
  "总结方法",
  "提取创新点",
  "总结实验结果",
] as const;

export type QuickAction = (typeof QUICK_ACTIONS)[number];

/**
 * DS-FE-001 was a shell task with no backend. DS-FE-003 wires the real one, so
 * replies must still say plainly that Paper QA is not built — an assistant that
 * invents a plausible answer about a real paper would be far worse than one that
 * admits it cannot yet read.
 */
const NO_BACKEND_NOTICE =
  "论文问答（Paper QA）尚未实现（Phase 8）。此回复不是论文内容。";

let messageSeq = 0;
const nextMessageId = (): string => {
  messageSeq += 1;
  return `msg-${messageSeq}`;
};

let sessionSeq = 0;
/** Mint a fresh client-side identity for one opening of a file. */
export function nextSessionToken(): string {
  sessionSeq += 1;
  return `open-${sessionSeq}`;
}

const INITIAL_MESSAGES: ChatMessage[] = [
  {
    id: nextMessageId(),
    role: "assistant",
    content: "已就绪。可以询问这篇论文，或使用上方的快捷操作。",
  },
];

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => ({
  document: null,
  translation: null,

  // AC-04 / DS-FE-003 §14: nothing is translated yet, so the only mode that can
  // honestly be shown is the original. Bilingual is no longer the default — it
  // became a promise the app could not keep once the panels stopped being
  // placeholders.
  readerMode: "original",
  setReaderMode: (mode) => set({ readerMode: mode }),

  // AC-05: expanded by default.
  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),

  scope: "document",
  setScope: (scope) => set({ scope }),

  messages: INITIAL_MESSAGES,
  composerValue: "",
  setComposerValue: (value) => set({ composerValue: value }),

  submitComposer: () => {
    const text = get().composerValue.trim();
    if (!text) return; // AC-18
    set((s) => ({
      composerValue: "",
      messages: [
        ...s.messages,
        { id: nextMessageId(), role: "user", content: text },
        { id: nextMessageId(), role: "assistant", content: NO_BACKEND_NOTICE },
      ],
    }));
  },

  runQuickAction: (label) => {
    set((s) => ({
      messages: [
        ...s.messages,
        { id: nextMessageId(), role: "user", content: label },
        { id: nextMessageId(), role: "assistant", content: NO_BACKEND_NOTICE },
      ],
    }));
  },

  // No backend contact has happened yet. Saying "connecting" would imply a
  // request is in flight; saying "ready" would claim a fact we have not checked.
  engine: { state: "offline", label: "未连接" },
}));

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
