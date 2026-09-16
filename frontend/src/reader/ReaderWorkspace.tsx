import { ViewerPanel } from "@/reader/ViewerPanel";
import { useWorkspaceStore } from "@/stores/workspace";

/**
 * AC-04 — the workspace reconfigures between one and two panels as the reader
 * mode changes. This is real DOM restructuring, not a relabelling (failure F-04).
 *
 * The workspace is the visual protagonist: it is `flex-1` and `min-w-0`, so it
 * absorbs all width the sidebar releases when collapsed (AC-05).
 */
export function ReaderWorkspace() {
  const readerMode = useWorkspaceStore((s) => s.readerMode);

  const showOriginal = readerMode === "original" || readerMode === "bilingual";
  const showTranslated =
    readerMode === "translation" || readerMode === "bilingual";

  return (
    <main
      data-testid="reader-workspace"
      data-reader-mode={readerMode}
      className="flex min-w-0 flex-1 gap-2 overflow-hidden bg-workspace p-2"
    >
      {showOriginal && (
        <ViewerPanel
          title="Original PDF"
          figureLabel="Figure 1"
          testId="viewer-original"
        />
      )}
      {showTranslated && (
        <ViewerPanel
          title="Translated PDF"
          figureLabel="图 1"
          testId="viewer-translated"
        />
      )}
    </main>
  );
}
