/**
 * The translation's status line — the wrapper that decides whether to show one.
 *
 * What stays eager is this: read the current translation, and render nothing
 * when there is nothing to say. What is deferred is the banner itself, which
 * only exists once a translation has a state worth reporting. A reader who never
 * translates never downloads it, and one who does pays a local chunk fetch at
 * the same moment the notice appears.
 */
import { Suspense, lazy } from "react";

import { selectActiveTranslation, useWorkspaceStore } from "@/stores/workspace";

const TranslationNoticeBody = lazy(() => import("@/translation/TranslationNoticeBody"));

export function TranslationNotice() {
  const translation = useWorkspaceStore(selectActiveTranslation);
  if (!translation || translation.status === "idle") return null;
  return (
    <Suspense fallback={null}>
      <TranslationNoticeBody />
    </Suspense>
  );
}
