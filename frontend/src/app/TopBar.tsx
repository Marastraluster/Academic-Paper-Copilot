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

/**
 * AC-03 — top navigation bar.
 * Holds: product mark, document name, reader-mode switch, AI-translate action,
 * search, settings, and the sidebar collapse toggle (AC-05).
 *
 * `min-w-0` + truncation on the document name keeps the controls from being
 * pushed off-screen at 1024px (AC-11, AC-15).
 */
export function TopBar() {
  const documentName = useWorkspaceStore((s) => s.documentName);
  const sidebarOpen = useWorkspaceStore((s) => s.sidebarOpen);
  const toggleSidebar = useWorkspaceStore((s) => s.toggleSidebar);

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
        title={documentName}
        data-testid="document-name"
      >
        {documentName}
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
      <Button size="sm" variant="outline" className="shrink-0 gap-1.5">
        <Sparkles className="h-3.5 w-3.5" />
        AI翻译
      </Button>

      {/* Settings */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="设置"
            className="shrink-0"
          >
            <Settings />
          </Button>
        </TooltipTrigger>
        <TooltipContent>设置</TooltipContent>
      </Tooltip>
    </header>
  );
}
