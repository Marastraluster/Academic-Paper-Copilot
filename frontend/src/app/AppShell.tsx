import { AssistantSidebar } from "@/assistant/AssistantSidebar";
import { CopilotSidebar } from "@/assistant/CopilotSidebar";
import { useSelectionCapture } from "@/qa/useSelectionCapture";
import { ReaderWorkspace } from "@/reader/ReaderWorkspace";
import { StatusBar } from "@/app/StatusBar";
import { TopBar } from "@/app/TopBar";

/**
 * AC-02 — the four-region shell.
 *
 *   <header>  TopBar
 *   <aside>   AssistantSidebar
 *   <main>    ReaderWorkspace
 *   <footer>  StatusBar
 *
 * `h-screen w-screen overflow-hidden` guarantees the viewport itself never
 * scrolls (AC-29); `min-h-0` on the middle row is what allows the sidebar and
 * the viewers to scroll internally instead of stretching the page.
 */
export function AppShell() {
  // Watches the browser selection for the whole shell, not just the sidebar: a
  // reader can highlight a sentence before the sidebar is open.
  useSelectionCapture();

  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden">
      {/* The light field the glass panels float on. Decorative only. */}
      <div className="light-field" aria-hidden="true">
        <i style={{ width: 620, height: 620, left: -140, top: -180, background: "var(--orb-1)" }} />
        <i
          style={{
            width: 560, height: 560, right: -120, top: 180, background: "var(--orb-2)",
            animationDuration: "34s", animationDelay: "-8s",
          }}
        />
        <i
          style={{
            width: 520, height: 520, left: "34%", bottom: -260, background: "var(--orb-3)",
            animationDuration: "40s", animationDelay: "-16s",
          }}
        />
      </div>

      <div className="relative z-10 flex min-h-0 flex-1 flex-col gap-2 p-3">
        <TopBar />

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <AssistantSidebar />
          {/* The status pill floats in the reading column's bottom-right corner,
              beside the page dock, clear of both sidebars. */}
          <div className="relative flex min-w-0 flex-1">
            <ReaderWorkspace />
            <StatusBar />
          </div>
          <CopilotSidebar />
        </div>
      </div>
    </div>
  );
}
