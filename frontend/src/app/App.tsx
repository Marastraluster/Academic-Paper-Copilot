import { ErrorBoundary } from "@/app/ErrorBoundary";
import { AppShell } from "@/app/AppShell";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * Application root.
 *
 * No network request is issued on mount. The backend does not exist until
 * Phase 3, and AC-09 requires the shell to render fully — with zero console
 * errors — while it is absent.
 */
export function App() {
  return (
    <ErrorBoundary>
      <TooltipProvider delayDuration={400}>
        <AppShell />
      </TooltipProvider>
    </ErrorBoundary>
  );
}
