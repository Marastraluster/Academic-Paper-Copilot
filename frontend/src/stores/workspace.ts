import { create } from "zustand";

/** AC-04: the three reader modes. */
export type ReaderMode = "original" | "bilingual" | "translation";

/** AC-06: assistant context scope. */
export type AssistantScope = "selection" | "page" | "section" | "document";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export interface TranslationProgress {
  /** Human-readable stage label shown in the status bar. */
  label: string;
  currentPage: number;
  pageCount: number;
  /** 0-100. */
  percent: number;
}

export type EngineState = "offline" | "ready" | "preparing" | "error";

interface WorkspaceState {
  // ---- Document ----
  documentName: string;

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
  progress: TranslationProgress;
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
 * DS-FE-001 is a shell task: the backend does not exist yet (Phase 3).
 * Replies must therefore say so plainly rather than imitate an answer.
 */
const NO_BACKEND_NOTICE =
  "助手后端尚未接入（Phase 3）。当前仅演示工作区结构，此回复不是论文内容。";

let messageSeq = 0;
const nextMessageId = (): string => {
  messageSeq += 1;
  return `msg-${messageSeq}`;
};

const INITIAL_MESSAGES: ChatMessage[] = [
  {
    id: nextMessageId(),
    role: "assistant",
    content: "已就绪。可以询问这篇论文，或使用上方的快捷操作。",
  },
];

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => ({
  documentName: "paper.pdf",

  // AC-04: bilingual is the default mode.
  readerMode: "bilingual",
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

  // Placeholder state. No translation has run; these values are illustrative
  // only and are labelled as such in the status bar.
  progress: {
    label: "Translating...",
    currentPage: 5,
    pageCount: 18,
    percent: 72,
  },

  // AC-08 / AC-09: no backend is running, so the honest engine state is offline.
  engine: { state: "offline", label: "Offline" },
}));
