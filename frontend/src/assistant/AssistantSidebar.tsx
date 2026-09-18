import { Composer } from "@/assistant/Composer";
import { ConversationArea } from "@/assistant/ConversationArea";
import { QuickActions } from "@/assistant/QuickActions";
import { ScopeSelector } from "@/assistant/ScopeSelector";
import { SIDEBAR_WIDTH_PX } from "@/lib/layout";
import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/stores/workspace";

/**
 * AC-05 — collapsible Paper QA sidebar.
 *
 * The <aside> element stays mounted in both states so its width is measurable
 * (AC-05 verification asks for computed width in each state), but when
 * collapsed it is zero-width and its contents are unmounted entirely — that
 * way nothing inside it can be tabbed into while invisible.
 *
 * The expand trigger lives in the top bar, satisfying AC-05's requirement that
 * an expand affordance stay reachable when collapsed.
 *
 * This is the **only** assistant surface. Questions asked here go through the
 * grounded backend; there is no path that reaches a model directly, which is why
 * there is no "ask AI" escape hatch anywhere in this panel.
 */
export function AssistantSidebar() {
  const sidebarOpen = useWorkspaceStore((s) => s.sidebarOpen);

  return (
    <aside
      data-testid="assistant-sidebar"
      data-state={sidebarOpen ? "expanded" : "collapsed"}
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
          <ScopeSelector />
          <QuickActions />
          <ConversationArea />
          <Composer />
        </div>
      )}
    </aside>
  );
}
