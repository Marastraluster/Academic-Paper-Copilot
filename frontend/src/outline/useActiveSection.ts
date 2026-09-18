import { useEffect, useMemo } from "react";

import { useWorkspaceStore } from "@/stores/workspace";
import { activeSection, blockSections } from "@/outline/currentSection";
import { buildOutlineTree, ancestorsOf } from "@/outline/tree";

/**
 * Keeps the active section in step with where the reader is.
 *
 * Three properties worth stating, because each is a way this could be wrong:
 *
 * * **It never runs on scroll alone.** The reading position only changes when the
 *   viewer's own measure loop says so, and the viewer already has that loop.
 * * **It uses canonical order, not screen position.** `activeSection` walks the
 *   page's blocks in reading order, so a two-column page cannot invert it.
 * * **It does not fight the user.** The active node's ancestors are revealed, but
 *   a node the user collapsed elsewhere stays collapsed — revealing is additive
 *   (`expandSections`), never a reset.
 */
export function useActiveSection(): void {
  const document = useWorkspaceStore((s) => s.document);
  const ir = useWorkspaceStore((s) => s.ir);
  const sections = useWorkspaceStore((s) => s.sections);
  const readingPosition = useWorkspaceStore((s) => s.readingPosition);
  const setActiveSectionId = useWorkspaceStore((s) => s.setActiveSectionId);

  const documentId = document?.documentId ?? null;

  // The IR is loaded once, by the registration path in `translation/session.ts`,
  // which already fetches it "so a selection made moments after a paper opens can
  // be resolved without a round trip". This hook therefore fetches nothing: a
  // document that has not resolved its IR has no block geometry to resolve a
  // reading position against, and asking for it here would put a second fetch on
  // the open path for a panel the user may never open.

  const blockToSection = useMemo(
    () => blockSections(ir?.paragraphs),
    [ir],
  );

  const tree = useMemo(
    () => (sections ? buildOutlineTree(sections) : null),
    [sections],
  );

  const resolved = useMemo(() => {
    if (!ir || !Array.isArray(ir.pages) || !sections || sections.length === 0) {
      return null;
    }
    if (ir.document_id !== documentId) return null;
    return activeSection(ir, readingPosition, blockToSection);
  }, [ir, sections, documentId, readingPosition, blockToSection]);

  useEffect(() => {
    setActiveSectionId(resolved);
    if (resolved === null || tree === null) return;
    const chain = ancestorsOf(tree, resolved);
    if (chain.length > 0) useWorkspaceStore.getState().expandSections(chain);
  }, [resolved, tree, setActiveSectionId]);
}
