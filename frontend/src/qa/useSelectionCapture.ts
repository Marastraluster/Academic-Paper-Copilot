/**
 * Watches the browser's text selection and resolves it to canonical paragraphs.
 *
 * Mounted once, at the shell, because a reader can highlight a sentence before
 * opening the sidebar and the mapping should be there when they do.
 *
 * Three rules shape the listeners, and each is about not getting in the way.
 *
 * **Passive, and never `preventDefault`.** Copying text is the most common reason
 * to select it, and a listener that swallowed the event would break `Ctrl+C` to
 * add a feature the user did not ask for. Nothing here cancels anything.
 *
 * **Debounced, because `selectionchange` fires on every pixel of a drag.** The
 * mapping is cheap, but re-running it sixty times a second on a selection that is
 * still changing is work with no reader on the other end of it. `mouseup` is the
 * honest signal that a drag finished; the debounce covers keyboard selection,
 * which has no mouseup at all.
 *
 * **A click in the sidebar does not clear the selection; a click in the paper
 * does.** Clicking *Ask* takes focus out of the page and collapses the browser's
 * selection — so treating a collapse as "the reader cleared it" destroys the
 * highlighted text at the exact moment they ask about it. The measurement caught
 * this as a request that was never sent: the mapping existed, the button was
 * enabled, and the scope resolved to nothing 150 ms after the click. Where the
 * click landed is the difference between "I am done selecting" and "I am asking
 * about what I selected".
 */
import { useEffect } from "react";

import { clearSelection, refreshSelection } from "@/qa/session";
import { useWorkspaceStore } from "@/stores/workspace";

/** Keyboard selection produces no mouseup, so a short settle time covers it. */
const SETTLE_MS = 150;

/** The reader's own surface. A click here is a click on the document. */
const READER = '[data-testid="reader-workspace"], [data-testid="pdf-viewer"]';

export function useSelectionCapture(): void {
  // Re-subscribed when the reader mode changes: switching panes replaces the DOM
  // the selection lived in, and a mapping from a pane that no longer exists is
  // stale by definition.
  const readerMode = useWorkspaceStore((s) => s.readerMode);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const settle = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        refreshSelection();
      }, SETTLE_MS);
    };

    const onMouseUp = (event: MouseEvent) => {
      const target = event.target;
      const inReader =
        target instanceof Element && target.closest(READER) !== null;
      // A click in the paper collapses the selection deliberately, so it clears;
      // a click in the sidebar is a click on the feature, so it keeps.
      if (inReader) clearSelection();
      settle();
    };

    document.addEventListener("selectionchange", settle);
    document.addEventListener("mouseup", onMouseUp);

    return () => {
      document.removeEventListener("selectionchange", settle);
      document.removeEventListener("mouseup", onMouseUp);
      if (timer !== null) clearTimeout(timer);
    };
  }, [readerMode]);
}
