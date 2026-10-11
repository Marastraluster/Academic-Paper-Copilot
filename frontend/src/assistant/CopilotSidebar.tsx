import { Suspense, lazy } from "react";
import { Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/stores/workspace";

/** Paper QA — its parsing, answer rendering and conversation state — arrives
 *  in its own chunk, so the initial download stays what it was. */
const QaPanel = lazy(() =>
  import("@/assistant/QaPanel").then((module) => ({ default: module.QaPanel })),
);

/**
 * The Copilot column, on the right.
 *
 * Reading aids — overview, outline, related papers, notes — sit on the left;
 * the conversation about the paper sits here, so a reader can keep the outline
 * open while asking about a section. Width tracks the viewport between 300 and
 * 380 px so the paper keeps a readable column on a 1280 px screen.
 */
export function CopilotSidebar() {
  const open = useWorkspaceStore((s) => s.copilotOpen);
  const setOpen = useWorkspaceStore((s) => s.setCopilotOpen);

  return (
    <aside
      data-testid="copilot-sidebar"
      data-state={open ? "expanded" : "collapsed"}
      aria-label="Copilot 论文问答"
      aria-hidden={!open}
      className={cn(
        "glass shrink-0 overflow-hidden rounded-[26px] transition-[width,margin,opacity,filter] duration-500 ease-glass",
        open ? "ml-2 w-[clamp(300px,26vw,380px)]" : "ml-0 w-0 border-0 opacity-0 blur-sm",
      )}
    >
      {open && (
        <div className="flex h-full w-[clamp(300px,26vw,380px)] animate-pane-in flex-col">
          <div className="flex shrink-0 items-center gap-2 px-4 pb-1 pt-3">
            <span
              aria-hidden="true"
              className="grid h-7 w-7 place-items-center rounded-[9px] bg-primary/[.12] text-primary"
            >
              <Sparkles className="h-4 w-4" />
            </span>
            <h2 className="text-[13px] font-semibold">Copilot</h2>
            <span className="text-2xs text-muted-foreground">就这篇论文提问</span>
            <Button
              variant="ghost"
              size="icon-sm"
              className="ml-auto"
              aria-label="收起 Copilot"
              data-testid="copilot-close"
              onClick={() => setOpen(false)}
            >
              <X />
            </Button>
          </div>
          <div
            id="assistant-tabpanel-qa"
            data-testid="assistant-tabpanel-qa"
            className="flex min-h-0 flex-1 flex-col"
          >
            <Suspense
              fallback={
                <p data-testid="assistant-panel-loading" className="px-4 py-6 text-xs text-muted-foreground">
                  正在载入…
                </p>
              }
            >
              <QaPanel />
            </Suspense>
          </div>
        </div>
      )}
    </aside>
  );
}
