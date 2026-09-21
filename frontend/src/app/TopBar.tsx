import { useState } from "react";
import { BookOpen, PanelLeft, Search, Settings, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
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
  const { start, busy } = useTranslationSession();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

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
    <header className="flex h-11 shrink-0 items-center gap-2 border-b bg-card px-2.5">
      {/* Sidebar toggle (AC-05: the expand trigger stays reachable when collapsed) */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
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

      {/* Product mark */}
      <div className="flex shrink-0 items-center gap-1.5 pl-0.5 pr-1">
        <BookOpen className="h-4 w-4 text-primary" aria-hidden="true" />
        <span className="text-xs font-semibold tracking-tight">
          Academic PDF Copilot
        </span>
      </div>

      <Separator orientation="vertical" className="h-5" />

      {/* Document name — truncates rather than pushing controls off-screen */}
      <span
        className="min-w-0 max-w-[22ch] flex-1 truncate text-xs text-muted-foreground"
        title={document?.name ?? "未打开文档"}
        data-testid="document-name"
      >
        {document?.name ?? "未打开文档"}
      </span>

      <ReaderModeSwitch />

      <Separator orientation="vertical" className="h-5" />

      {/* Search */}
      <div className="relative hidden items-center md:flex">
        <Search
          className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-muted-foreground"
          aria-hidden="true"
        />
        <input
          type="search"
          placeholder="搜索论文…"
          aria-label="搜索论文"
          className="h-7 w-40 rounded-md border bg-background pl-7 pr-2 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background lg:w-52"
        />
      </div>

      {/* AI translate */}
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="shrink-0">
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
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

      {/* Settings */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
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
    </header>
  );
}
