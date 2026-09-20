import { Suspense, lazy } from "react";

import { OutlineHeader } from "@/outline/OutlineHeader";
import { OverviewPanel } from "@/overview/OverviewPanel";
import { SIDEBAR_WIDTH_PX } from "@/lib/layout";
import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/stores/workspace";

/**
 * The three panels behind a paper's overview, loaded when they are opened.
 *
 * Measured: every panel was in the initial chunk, which had **0.86 kB** of legal
 * headroom under the 350 kB ceiling before the reader overview was added at all.
 * Splitting them is what recovers room to keep building.
 *
 * The one panel that must **not** be split is the overview: its reading entry
 * renders synchronously from data the application already holds, and a lazy
 * boundary would put a suspension in front of the first paint of the tab a paper
 * opens on. React's `lazy` and dynamic `import()` are already present, so this
 * costs no dependency.
 */
const OutlinePanel = lazy(() =>
  import("@/outline/OutlinePanel").then((module) => ({ default: module.OutlinePanel })),
);
const NotesPanel = lazy(() =>
  import("@/notes/NotesPanel").then((module) => ({ default: module.NotesPanel })),
);
const QaPanel = lazy(() =>
  import("@/assistant/QaPanel").then((module) => ({ default: module.QaPanel })),
);

/**
 * What is on screen while a panel's code arrives.
 *
 * A real element with a test id rather than `null`, and that is not a testing
 * convenience: a blank frame is what a slow connection looks like, and a reader
 * cannot tell it from a panel that failed to open. The id is also how the suites
 * that render the whole shell know the panel they are about to query exists.
 */
function PanelLoading() {
  return (
    <p data-testid="assistant-panel-loading" className="px-3 py-6 text-xs text-muted-foreground">
      正在载入…
    </p>
  );
}

/**
 * AC-05 — collapsible Paper QA sidebar, and since DS-QA-008 the document
 * outline as well.
 *
 * The <aside> element stays mounted in both states so its width is measurable
 * (AC-05 verification asks for computed width in each state), but when
 * collapsed it is zero-width and its contents are unmounted entirely — that
 * way nothing inside it can be tabbed into while invisible.
 *
 * **One panel, two tabs — not two sidebars.** Decision J, and the arithmetic
 * behind it: `SIDEBAR_WIDTH_PX` is 340 and the brief fixes a 1024 px floor, so a
 * second 340 px column would leave 344 px for the paper. Tabs keep the reader
 * the centre of the screen at every width the criteria test.
 *
 * Switching tabs unmounts one subtree and mounts the other, which is safe for
 * both: outline expansion, QA turns and any in-flight request all live in the
 * store, so nothing is lost and an answer already on its way still arrives. No
 * cancellation is invented here — a request the user started keeps running.
 */
export function AssistantSidebar() {
  const sidebarOpen = useWorkspaceStore((s) => s.sidebarOpen);
  const panel = useWorkspaceStore((s) => s.outlinePanel);
  const setPanel = useWorkspaceStore((s) => s.setOutlinePanel);

  /* 概览 first, and it is where a paper opens. The order is the reading
     order: what this paper is, where its parts are, what it says when asked,
     what I thought of it. */
  const tabs = [
    { id: "overview" as const, label: "概览" },
    { id: "outline" as const, label: "目录" },
    { id: "qa" as const, label: "问答" },
    { id: "notes" as const, label: "笔记" },
  ];

  return (
    <aside
      data-testid="assistant-sidebar"
      data-state={sidebarOpen ? "expanded" : "collapsed"}
      data-panel={panel}
      aria-label="AI 论文助手"
      aria-hidden={!sidebarOpen}
      style={{ width: sidebarOpen ? SIDEBAR_WIDTH_PX : 0 }}
      className={cn(
        "shrink-0 overflow-hidden border-r bg-card transition-[width] duration-200 ease-out",
        !sidebarOpen && "border-r-0",
      )}
    >
      {sidebarOpen && (
        // Fixed-width inner column so contents don't reflow mid-animation.
        <div
          className="flex h-full flex-col"
          style={{ width: SIDEBAR_WIDTH_PX }}
        >
          <div
            role="tablist"
            aria-label="侧边栏面板"
            data-testid="assistant-tabs"
            className="flex shrink-0 gap-1 border-b px-2 py-1.5"
          >
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`assistant-tab-${tab.id}`}
                aria-selected={panel === tab.id}
                aria-controls={`assistant-tabpanel-${tab.id}`}
                data-testid={`assistant-tab-${tab.id}`}
                onClick={() => setPanel(tab.id)}
                className={cn(
                  "rounded-sm px-2.5 py-1 text-xs",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                  panel === tab.id
                    ? "bg-primary/10 font-medium text-foreground"
                    : "text-muted-foreground hover:bg-accent/60",
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {panel === "overview" ? (
            <div
              id="assistant-tabpanel-overview"
              role="tabpanel"
              aria-labelledby="assistant-tab-overview"
              data-testid="assistant-tabpanel-overview"
              className="flex min-h-0 flex-1 flex-col"
            >
              <OverviewPanel />
            </div>
          ) : panel === "notes" ? (
            <div
              id="assistant-tabpanel-notes"
              role="tabpanel"
              aria-labelledby="assistant-tab-notes"
              data-testid="assistant-tabpanel-notes"
              className="flex min-h-0 flex-1 flex-col"
            >
              <Suspense fallback={<PanelLoading />}>
                <NotesPanel />
              </Suspense>
            </div>
          ) : panel === "outline" ? (
            <div
              id="assistant-tabpanel-outline"
              role="tabpanel"
              aria-labelledby="assistant-tab-outline"
              data-testid="assistant-tabpanel-outline"
              className="flex min-h-0 flex-1 flex-col"
            >
              <OutlineHeader />
              <Suspense fallback={<PanelLoading />}>
                <OutlinePanel />
              </Suspense>
            </div>
          ) : (
            <div
              id="assistant-tabpanel-qa"
              role="tabpanel"
              aria-labelledby="assistant-tab-qa"
              data-testid="assistant-tabpanel-qa"
              className="flex min-h-0 flex-1 flex-col"
            >
              <Suspense fallback={<PanelLoading />}>
                <QaPanel />
              </Suspense>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
