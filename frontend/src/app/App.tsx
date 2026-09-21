import { useEffect } from "react";

import { ErrorBoundary } from "@/app/ErrorBoundary";
import { AppShell } from "@/app/AppShell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useReadingSession } from "@/session/useReadingSession";
import { disposeTranslationSession } from "@/translation/session";

/**
 * Application root.
 *
 * A cold window — one with no stored reading session — still issues no network
 * request on mount, and the shell renders fully with the backend absent (AC-09).
 * The one thing that may be fetched here is the paper the reader was already
 * reading: `useReadingSession` reads a `localStorage` record, and only when one
 * exists does it ask the backend for bytes the reader is demonstrably waiting
 * for. A first visit has no record and makes no request.
 *
 * Unmounting releases whatever the session is holding: a task subscription, an
 * in-flight upload, and the translated document's object URL. Those live outside
 * React precisely so that they survive re-renders, which means nothing else
 * would ever free them.
 */
export function App() {
  useReadingSession();
  useEffect(() => disposeTranslationSession, []);

  return (
    <ErrorBoundary>
      <TooltipProvider delayDuration={400}>
        <AppShell />
      </TooltipProvider>
    </ErrorBoundary>
  );
}
