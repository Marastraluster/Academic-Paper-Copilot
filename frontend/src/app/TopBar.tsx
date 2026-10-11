import { useState } from "react";
import { BookOpen, Library, MessageSquare, PanelLeft, Search, Settings, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ReaderModeSwitch } from "@/reader/ReaderModeSwitch";
import { useWorkspaceStore } from "@/stores/workspace";
import { ExportMenu } from "@/translation/ExportMenu";
import { Suspense, lazy } from "react";

/**
 * The translation dialog loads when it is opened.
 *
 * It is roughly 13 kB of source — a form, its validation and its options — and
 * it is rendered closed on every page. A reader who never translates should not
 * download it, which is also true of everyone looking at the overview the
 * application now opens on. It renders nothing until `open`, so deferring it
 * changes no visible behaviour and no test's timing.
 */
const TranslateDialog = lazy(() =>
  import("@/translation/TranslateDialog").then((module) => ({
    default: module.TranslateDialog,
  })),
);

/**
 * The settings dialog loads when it is opened, for a harder reason than taste.
 *
 * The initial chunk sits inside 1.11 kB of a frozen ceiling, so anything a
 * reader has not asked for cannot be in it — and a settings screen nobody has
 * opened is exactly that. The eager half is the button's handler and this
 * import: the screen itself, its forms and its API client all arrive with the
 * first click.
 */
const SettingsDialog = lazy(() => import("@/settings/SettingsDialog"));

/**
 * The library loads when it is opened, for the same reason and one more.
 *
 * 40 bytes of headroom is the first reason. The second is that the reader asked
 * for it: *"还有一个翻译记录和换论文的方法?"* — a way to switch papers — and a
 * list they have not opened yet does not belong in the download.
 */
const LibraryDialog = lazy(() => import("@/library/LibraryDialog"));
import { useTranslationSession } from "@/translation/useTranslationSession";
import type { TranslateOptions } from "@/translation/session";

/**
 * AC-03 — top navigation bar.
 * Holds: product mark, document name, reader-mode switch, AI-translate action,
 * search, settings, and the sidebar collapse toggle (AC-05).
 *
 * `min-w-0` + truncation on the document name keeps the controls from being
 * pushed off-screen at 1024px (AC-11, AC-15).
 */
export function TopBar() {
  const document = useWorkspaceStore((s) => s.document);
  const sidebarOpen = useWorkspaceStore((s) => s.sidebarOpen);
  const toggleSidebar = useWorkspaceStore((s) => s.toggleSidebar);
  const copilotOpen = useWorkspaceStore((s) => s.copilotOpen);
  const toggleCopilot = useWorkspaceStore((s) => s.toggleCopilot);
  const { start, busy } = useTranslationSession();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /* The library lives in the store: the reader's empty workspace has a door to
     it too, and that door is in another subtree. */
  const libraryOpen = useWorkspaceStore((s) => s.libraryOpen);
  const libraryQuery = useWorkspaceStore((s) => s.libraryQuery);
  const openLibrary = useWorkspaceStore((s) => s.openLibrary);
  const closeLibrary = useWorkspaceStore((s) => s.closeLibrary);

  // A translation needs somewhere to run: no document, or one whose backend
  // identity is still being established, cannot be translated yet.
  const canTranslate =
    document !== null && document.registration === "ready" && document.documentId !== null;
  const translating = busy && document?.registration === "ready";

  const submit = (options: TranslateOptions) => {
    setDialogOpen(false);
    void start(options);
  };

  return (
    <>
    {/* z-30: `.glass` isolates its stacking, so without a level of its own the
        panels after it in the tree paint over the menus that drop out of it. */}
    <header className="glass z-30 flex h-14 shrink-0 items-center gap-2 rounded-[28px] px-2.5">
      {/* Sidebar toggle (AC-05: the expand trigger stays reachable when collapsed) */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={sidebarOpen ? "收起侧边栏" : "展开侧边栏"}
            aria-expanded={sidebarOpen}
            data-testid="sidebar-toggle"
            onClick={toggleSidebar}
          >
            <PanelLeft />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {sidebarOpen ? "收起侧边栏" : "展开侧边栏"}
        </TooltipContent>
      </Tooltip>

      {/* Product mark, with the open paper's name beneath it. */}
      <div className="flex min-w-0 shrink items-center gap-2 pr-1">
        <span
          aria-hidden="true"
          className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[10px] bg-primary text-primary-foreground shadow-[inset_0_1px_0_rgba(255,255,255,.35),0_4px_12px_hsl(var(--primary)/.35)]"
        >
          <BookOpen className="h-4 w-4" />
        </span>
        <div className="min-w-0 leading-[1.15]">
          <div className="whitespace-nowrap text-[13px] font-bold tracking-tight">
            Academic PDF Copilot
          </div>
          {/* Document name — truncates rather than pushing controls off-screen */}
          <div
            className="max-w-[22ch] truncate text-2xs text-muted-foreground"
            title={document?.name ?? "未打开文档"}
            data-testid="document-name"
          >
            {document?.name ?? "未打开文档"}
          </div>
        </div>
      </div>

      <div className="min-w-2 flex-1" />
      <ReaderModeSwitch />
      <div className="min-w-2 flex-1" />

      {/* Search — the library's other door. It was an inert field for four
          tasks; a reader who wants a different paper will reach for the control
          that says it searches papers, so it now opens the list and carries
          whatever has been typed into it. */}
      <div className="relative hidden items-center md:flex">
        <Search
          className="pointer-events-none absolute left-3 z-[1] h-4 w-4 text-muted-foreground"
          aria-hidden="true"
        />
        <input
          type="search"
          data-testid="paper-search"
          placeholder="搜索论文…"
          aria-label="搜索论文"
          value={libraryQuery}
          onChange={(event) => openLibrary(event.target.value)}
          onClick={() => openLibrary()}
          className="glass-track h-9 w-40 rounded-full border-0 pl-9 pr-3 text-[13px] transition-[width,background-color,box-shadow] duration-500 ease-spring placeholder:text-muted-foreground focus-visible:w-56 focus-visible:bg-[var(--glass-strong)] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/30 lg:w-52 lg:focus-visible:w-60 xl:focus-visible:w-72"
        />
      </div>

      {/* AI translate */}
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="shrink-0">
            <Button
              variant="glow"
              className="sheen h-9 gap-1.5 px-4 text-[13px] font-semibold"
              data-testid="ai-translate"
              aria-label="AI翻译"
              // Disabled while a translation runs, so the same work cannot be
              // queued twice. Retranslation becomes possible again once the task
              // reaches a terminal state.
              disabled={!canTranslate || translating}
              onClick={() => setDialogOpen(true)}
            >
              <Sparkles className="h-3.5 w-3.5" />
              AI翻译
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {document === null
            ? "请先打开一个 PDF"
            : document.registration === "pending"
              ? "正在把文档注册到后端…"
              : translating
                ? "翻译进行中"
                : "翻译当前文档"}
        </TooltipContent>
      </Tooltip>

      {/* Export — the only place the 2N dual artifact is offered (§13). */}
      <ExportMenu />

      {/* The library — the papers this application already has. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="论文库"
            data-testid="library-open"
            className="shrink-0"
            onClick={() => openLibrary()}
          >
            {/* Not `BookOpen`: that is already the product mark three controls
                to the left, and two identical icons in one bar say nothing. */}
            <Library />
          </Button>
        </TooltipTrigger>
        <TooltipContent>论文库</TooltipContent>
      </Tooltip>

      {/* Copilot — the paper-QA column on the right. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={copilotOpen ? "收起 Copilot" : "打开 Copilot"}
            aria-pressed={copilotOpen}
            data-testid="copilot-toggle"
            className={copilotOpen ? "shrink-0 bg-[var(--glass-strong)] text-primary shadow-[var(--glass-highlight)]" : "shrink-0"}
            onClick={toggleCopilot}
          >
            <MessageSquare />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Copilot 论文问答</TooltipContent>
      </Tooltip>

      {/* Settings */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="设置"
            data-testid="settings-open"
            className="shrink-0"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings />
          </Button>
        </TooltipTrigger>
        <TooltipContent>设置</TooltipContent>
      </Tooltip>

    </header>

      {/* Outside the header: its backdrop-filter would otherwise become the
          containing block of these fixed overlays and clip them to the bar. */}
      {dialogOpen && (
        <Suspense fallback={null}>
          <TranslateDialog
            open={dialogOpen}
            onClose={() => setDialogOpen(false)}
            onSubmit={submit}
          />
        </Suspense>
      )}

      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        </Suspense>
      )}

      {libraryOpen && (
        <Suspense fallback={null}>
          <LibraryDialog
            open={libraryOpen}
            initialQuery={libraryQuery}
            onClose={closeLibrary}
          />
        </Suspense>
      )}
    </>
  );
}
