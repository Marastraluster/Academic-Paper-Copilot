import type { AnnotationView } from "@/api/annotations";
import { selectEffectiveMode, useWorkspaceStore } from "@/stores/workspace";

/**
 * Send the reader to where an annotation was made.
 *
 * Reuses the reader's existing jump rather than adding a second way to move the
 * page stack, and the mode handling mirrors `jumpToSection`: source geometry only
 * means something in the original pane, so a jump from translation mode returns
 * there first and says why.
 *
 * A target whose *resolution* failed can still be jumped to. The page and the
 * rectangles belong to the immutable PDF and do not stop being true because the
 * extraction re-segmented a paragraph — which is the distinction the backend
 * reports as `showable` and `amenable_to_jump`.
 */
export function jumpToAnnotation(annotation: AnnotationView): void {
  const state = useWorkspaceStore.getState();
  const target =
    annotation.targets.find((t) => t.resolved_paragraph_id !== null) ??
    annotation.targets.find((t) => t.amenable_to_jump);
  if (!target) return;

  const mode = selectEffectiveMode(state);
  if (mode === "translation") {
    state.setReaderMode("original");
    state.setNotice(
      `已切换至原文第 ${target.page_number} 页查看标注，可随时在顶部切回译文。`,
    );
  } else {
    state.setNotice(null);
  }

  state.requestJump(target.page_number, target.rects, target.rects[0]?.[1]);
}
