import { useCallback, useMemo } from "react";

import { selectActiveTranslation, useWorkspaceStore } from "@/stores/workspace";
import {
  cancelActiveTranslation,
  retranslate as retranslateSession,
  startTranslation,
  type TranslateOptions,
} from "@/translation/session";

export interface TranslationSession {
  /** Begin a translation of the open document. */
  start: (options: TranslateOptions) => Promise<void>;
  /** Re-run with the settings used most recently. */
  retranslate: () => Promise<void>;
  /** Ask the backend to stop at the next page boundary. */
  cancel: () => Promise<void>;
  /** True while a task is being submitted or is running. */
  busy: boolean;
  /** True once a readable translated artifact exists for the open document. */
  ready: boolean;
}

/**
 * The actions the UI can take on a translation, and the two flags it needs to
 * enable or disable its controls.
 *
 * A thin hook over the session module on purpose: the async work, the guards and
 * the object-URL lifetime all live there, where they can be torn down without a
 * component being mounted. Components only ask for things to happen.
 */
export function useTranslationSession(): TranslationSession {
  const translation = useWorkspaceStore(selectActiveTranslation);
  const registration = useWorkspaceStore((s) => s.document?.registration ?? null);

  const start = useCallback(
    async (options: TranslateOptions) => {
      await startTranslation(options);
    },
    [],
  );

  const retranslate = useCallback(async () => {
    await retranslateSession();
  }, []);

  const cancel = useCallback(async () => {
    await cancelActiveTranslation();
  }, []);

  return useMemo(
    () => ({
      start,
      retranslate,
      cancel,
      // Registration counts as busy: translating a document whose backend
      // identity does not exist yet is not a thing that can succeed.
      busy:
        registration === "pending" ||
        translation?.status === "submitting" ||
        translation?.status === "translating",
      ready: translation?.status === "success" && translation.monoUrl !== null,
    }),
    [start, retranslate, cancel, registration, translation],
  );
}
