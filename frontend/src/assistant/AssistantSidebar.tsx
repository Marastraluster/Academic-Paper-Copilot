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
/** The papers around this one — reaches an outside index, so never eager. */
const RelatedPanel = lazy(() => import("@/related/RelatedPanel"));

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
  /* 问答 moved to the Copilot column on the right. A stored "qa" (an older
     session, or a caller that still names it) shows the overview here. */
  const stored = useWorkspaceStore((s) => s.outlinePanel);
  const panel = stored === "qa" ? "overview" : stored;
  const setPanel = useWorkspaceStore((s) => s.setOutlinePanel);

  /* 概览 first, and it is where a paper opens: what this paper is, where its
     parts are, what surrounds it, what I thought of it. Asking about it is the
     Copilot column's job. */
  const tabs = [
    { id: "overview" as const, label: "概览" },
    { id: "outline" as const, label: "目录" },
    { id: "related" as const, label: "文献" },
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
        "glass shrink-0 overflow-hidden rounded-[26px] transition-[width,margin,opacity,filter] duration-500 ease-glass",
        sidebarOpen ? "mr-2" : "mr-0 border-0 opacity-0 blur-sm",
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
            className="glass-track relative mx-2.5 mb-1.5 mt-2.5 grid shrink-0 grid-cols-4 rounded-[15px] p-[3px]"
          >
            <span
              aria-hidden="true"
              className="glass-thumb absolute bottom-[3px] left-[3px] top-[3px] rounded-xl"
              style={{
                width: "calc((100% - 6px) / 4)",
                transform: `translateX(${Math.max(0, tabs.findIndex((tab) => tab.id === panel)) * 100}%)`,
              }}
            />
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
                  "relative z-[1] h-8 rounded-xl text-xs transition-[color,transform] duration-300 ease-spring active:scale-[.94]",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                  panel === tab.id
                    ? "font-semibold text-foreground"
                    : "text-muted-foreground hover:text-foreground",
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
              className="flex min-h-0 flex-1 animate-pane-in flex-col"
            >
              <OverviewPanel />
            </div>
          ) : panel === "notes" ? (
            <div
              id="assistant-tabpanel-notes"
              role="tabpanel"
              aria-labelledby="assistant-tab-notes"
              data-testid="assistant-tabpanel-notes"
              className="flex min-h-0 flex-1 animate-pane-in flex-col"
            >
              <Suspense fallback={<PanelLoading />}>
                <NotesPanel />
              </Suspense>
            </div>
          ) : panel === "related" ? (
            <div
              id="assistant-tabpanel-related"
              role="tabpanel"
              aria-labelledby="assistant-tab-related"
              data-testid="assistant-tabpanel-related"
              className="flex min-h-0 flex-1 animate-pane-in flex-col"
            >
              <Suspense fallback={<PanelLoading />}>
                <RelatedPanel />
              </Suspense>
            </div>
          ) : panel === "outline" ? (
            <div
              id="assistant-tabpanel-outline"
              role="tabpanel"
              aria-labelledby="assistant-tab-outline"
              data-testid="assistant-tabpanel-outline"
              className="flex min-h-0 flex-1 animate-pane-in flex-col"
            >
              <OutlineHeader />
              <Suspense fallback={<PanelLoading />}>
                <OutlinePanel />
              </Suspense>
            </div>
          ) : null}
        </div>
      )}
    </aside>
  );
}
