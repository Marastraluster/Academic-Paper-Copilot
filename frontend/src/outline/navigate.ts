import {
  selectEffectiveMode,
  useWorkspaceStore,
  type QaSection,
} from "@/stores/workspace";

/**
 * Go to the source a section names (Decisions F, G, H).
 *
 * Mirrors `jumpToCitation` deliberately — the same mode switch and the same
 * notice, because from the reader's point of view the same thing has happened:
 * they asked to see somewhere in the paper and were moved. Two navigation
 * affordances that behaved differently here would be a bug in one of them.
 *
 * The differences from a citation jump are the two things a section has that a
 * citation does not:
 *
 * * an **offset** — a heading is rarely at the top of its page, and landing at
 *   the page top would leave the heading the reader clicked below the fold;
 * * a **translated pane** to move in bilingual mode, with no boxes ever applied
 *   to it, since source geometry does not describe the translated artifact.
 */
export function jumpToSection(section: QaSection): void {
  const state = useWorkspaceStore.getState();
  const mode = selectEffectiveMode(state);

  if (mode === "translation") {
    state.setReaderMode("original");
    state.setNotice(
      `已切换至原文第 ${section.pageNumber} 页查看章节「${section.title}」，可随时在顶部切回译文。`,
    );
  } else {
    state.setNotice(null);
  }

  // A heading box is drawn only when the ladder resolved one. `anchor` says
  // which rung it came from, so a paragraph-level box is still a real box; a
  // page-level fallback has none and the jump degrades to the page.
  const boxes = section.bbox ? [section.bbox as number[]] : [];
  state.requestJump(section.pageNumber, boxes, section.bbox ? section.bbox[1] : undefined);

  if (mode === "bilingual") {
    state.requestTranslatedJump(section.pageNumber);
  }
}

/**
 * Hand this section to Paper QA (AC-P0-12).
 *
 * The canonical `section_id` is carried in state, never reconstructed from the
 * title — two sections may share a title, and a title is not an identity.
 *
 * Nothing is asked here. The scope is set and the composer is focused; a
 * provider call happens only when the user submits a question. There is no
 * "summarise this section" shortcut, because that would spend a model call the
 * user did not ask for.
 */
export function askThisSection(section: QaSection): void {
  const state = useWorkspaceStore.getState();
  state.setSelectedSectionId(section.id);
  state.setScope("section");
  state.setOutlinePanel("qa");
  // Focus rather than click: the composer owns its own focus behaviour.
  window.requestAnimationFrame(() => {
    document.querySelector<HTMLTextAreaElement>('[data-testid="qa-composer-input"]')?.focus();
  });
}
