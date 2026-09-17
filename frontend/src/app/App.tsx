import { useEffect } from "react";

import { ErrorBoundary } from "@/app/ErrorBoundary";
import { AppShell } from "@/app/AppShell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { disposeTranslationSession } from "@/translation/session";

/**
 * Application root.
 *
 * Still issues no network request on mount. The backend exists now, but nothing
 * is fetched until the user opens a document — an idle window must not call out,
 * and AC-09 requires the shell to render fully with the backend absent.
 *
 * Unmounting releases whatever the session is holding: a task subscription, an
 * in-flight upload, and the translated document's object URL. Those live outside
 * React precisely so that they survive re-renders, which means nothing else
 * would ever free them.
 */
export function App() {
  useEffect(() => disposeTranslationSession, []);

  return (
    <ErrorBoundary>
      <TooltipProvider delayDuration={400}>
        <AppShell />
      </TooltipProvider>
    </ErrorBoundary>
  );
}
