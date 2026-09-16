import { PdfWorkspace } from "@/pdf/PdfWorkspace";
import { useWorkspaceStore } from "@/stores/workspace";

/**
 * AC-04 — the workspace reconfigures between one and two panels as the reader
 * mode changes. This is real DOM restructuring, not a relabelling (failure F-04).
 *
 * Each panel is a self-contained `PdfWorkspace` with its own document, zoom and
 * page — which is what bilingual mode needs: two independent readers side by
 * side, not one shared viewer.
 *
 * The `viewer-original` / `viewer-translated` hooks are kept from DS-FE-001 so
 * the existing mode-switch tests and the browser capture harness keep verifying
 * real behaviour rather than being deleted along with the old mock.
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
      {showOriginal && <PdfWorkspace testId="viewer-original" label="Original PDF" />}
      {showTranslated && (
        <PdfWorkspace testId="viewer-translated" label="Translated PDF" />
      )}
    </main>
  );
}
