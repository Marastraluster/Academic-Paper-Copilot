/**
 * Keeps the reading session: restores it on mount, stores it as it changes.
 *
 * Mounted once, at the root, for the same reason `useSelectionCapture` is: a
 * reader who reloads has not asked for anything, so nothing else would remember
 * to do this, and a paper they were in the middle of should not depend on which
 * panel happened to mount first.
 *
 * ## What is written, and when
 *
 * The document is written the moment it becomes usable — `registration: "ready"`
 * is the first state in which the reader is actually reading, and it is also the
 * last moment at which the write is certain to have happened before they
 * reload. Page, mode and tab are written when they change; the page is debounced
 * because it changes on every pixel of a scroll and each write is a synchronous
 * disk write on the main thread.
 */
import { useEffect } from "react";

import { restoreReadingSession } from "@/session/restore";
import {
  clearStoredSession,
  patchStoredSession,
  readStoredSession,
  writeStoredSession,
} from "@/session/types";
import { useWorkspaceStore, type OpenDocument } from "@/stores/workspace";

/** A scroll produces a page change per pixel; only the last one is the reader's. */
const PAGE_WRITE_DEBOUNCE_MS = 200;

function storeNow(document: OpenDocument): void {
  if (document.documentId === null) return;
  const state = useWorkspaceStore.getState();
  writeStoredSession({
    schemaVersion: 1,
    documentId: document.documentId,
    name: document.name,
    activePage: state.activePage,
    readerMode: state.readerMode,
    outlinePanel: state.outlinePanel,
    lastActiveAt: new Date().toISOString(),
  });
}

/** What `window.__COPILOT_SESSION__` offers a developer, in development only. */
export interface SessionDebugHandle {
  /** The stored record, parsed, or null. */
  getActiveSession: () => unknown;
  /** Forget it. The next reload opens on the empty workspace. */
  clearSession: () => void;
  /** Run the restore again, ignoring whether one already ran. */
  forceRestore: () => Promise<string>;
}

export function useReadingSession(): void {
  useEffect(() => {
    if (import.meta.env.DEV) {
      // Support has one question: "why did it not come back?" — and one answer
      // to offer, which is to forget the session and start clean. Stripped from
      // production builds, so the reader pays nothing for it.
      const handle: SessionDebugHandle = {
        getActiveSession: () => readStoredSession(),
        clearSession: () => clearStoredSession(),
        forceRestore: () => restoreReadingSession(),
      };
      (window as unknown as { __COPILOT_SESSION__?: SessionDebugHandle }).__COPILOT_SESSION__ = handle;
    }

    void restoreReadingSession();

    let pending: number | null = null;

    const unsubscribe = useWorkspaceStore.subscribe((state, previous) => {
      const document = state.document;
      const becameReady =
        document !== null &&
        document.documentId !== null &&
        document.registration === "ready" &&
        previous.document?.registration !== "ready";
      if (becameReady) storeNow(document);

      if (
        state.readerMode !== previous.readerMode ||
        state.outlinePanel !== previous.outlinePanel
      ) {
        patchStoredSession({
          readerMode: state.readerMode,
          outlinePanel: state.outlinePanel,
        });
      }

      if (state.activePage !== previous.activePage) {
        if (pending !== null) window.clearTimeout(pending);
        pending = window.setTimeout(() => {
          pending = null;
          // Read at flush time: ten page changes in a scroll are one write, and
          // it is the page the reader stopped on.
          patchStoredSession({ activePage: useWorkspaceStore.getState().activePage });
        }, PAGE_WRITE_DEBOUNCE_MS);
      }
    });

    return () => {
      unsubscribe();
      if (pending !== null) window.clearTimeout(pending);
    };
  }, []);
}
