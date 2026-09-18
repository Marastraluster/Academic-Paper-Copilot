import { AssistantSidebar } from "@/assistant/AssistantSidebar";
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
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background">
      <TopBar />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <AssistantSidebar />
        <ReaderWorkspace />
      </div>

      <StatusBar />
    </div>
  );
}
