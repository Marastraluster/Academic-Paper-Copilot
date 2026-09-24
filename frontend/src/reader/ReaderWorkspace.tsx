import { Suspense, lazy, useMemo } from "react";
import { Languages } from "lucide-react";

import { PdfWorkspace, type PdfSource } from "@/pdf/PdfWorkspace";
import { JumpNotice } from "@/qa/JumpNotice";
import {
  selectEffectiveMode,
  selectActiveTranslation,
  useWorkspaceStore,
} from "@/stores/workspace";
import { openDocument, noteTranslatedPageCount } from "@/translation/session";
import { useActiveSection } from "@/outline/useActiveSection";
import { TranslationNotice } from "@/translation/TranslationNotice";

/**
 * The paragraph-aligned column loads when the reader asks for it.
 *
 * It is the whole paper in two languages — a hundred-odd paragraphs of pairs —
 * and it is one of four modes, so a reader who never opens it should not carry
 * it. The initial chunk has less than a kilobyte of headroom under its ceiling,
 * which is the other half of the reason.
 */
const ImmersiveReader = lazy(() => import("@/bilingual/ImmersiveReader"));

/**
 * AC-04 — the workspace reconfigures between one and two panels as the reader
 * mode changes. This is real DOM restructuring, not a relabelling (failure F-04).
 *
 * Each panel is a self-contained `PdfWorkspace` with its own document, zoom and
 * page. Bilingual mode is two *independent* readers side by side: there is no
 * shared PDF.js instance and no scroll lockstep, which is what AC-P1-01 asks for
 * — it requires page 1 in both panes and independent navigation, not synchronised
 * scrolling. Lockstep is a later enhancement.
 *
 * The original pane is driven by the open document rather than by its own picker,
 * so the app can register that file for translation. The picker still lives in
 * the pane; picking a file routes back through `openDocument`.
 */
export function ReaderWorkspace() {
  const document = useWorkspaceStore((s) => s.document);
  const mode = useWorkspaceStore(selectEffectiveMode);
  const translation = useWorkspaceStore(selectActiveTranslation);
  const setActivePage = useWorkspaceStore((s) => s.setActivePage);
  const setReadingPosition = useWorkspaceStore((s) => s.setReadingPosition);
  const jumpRequest = useWorkspaceStore((s) => s.jumpRequest);
  const annotations = useWorkspaceStore((s) => s.annotations);
  const translatedJump = useWorkspaceStore((s) => s.translatedJump);

  // Tracks the reader's position against the canonical structure, so the outline
  // can say which section they are in. Lives here because the position it needs
  // comes from the original pane.
  useActiveSection();

  /**
   * The reader's own marks, by page, in source-PDF points.
   *
   * Derived from the annotations on every render rather than cached: a target's
   * rectangles belong to the immutable PDF, so they are still the right boxes
   * even when resolution has changed what paragraph they correspond to. Drawn on
   * the original pane only — translated geometry is a different space entirely.
   */
  const annotationBoxes = useMemo(() => {
    const byPage: Record<number, number[][]> = {};
    for (const annotation of annotations ?? []) {
      for (const target of annotation.targets) {
        if (!target.showable || target.rects.length === 0) continue;
        (byPage[target.page_number] ??= []).push(...target.rects.map((r) => [...r]));
      }
    }
    return byPage;
  }, [annotations]);

  // The translated pane follows an *outline* jump only, and never carries source
  // boxes — the source geometry does not describe the translated artifact.
  const translatedJumpRequest = useMemo(
    () =>
      translatedJump
        ? { pageNumber: translatedJump.pageNumber, bboxes: [], offsetPt: null,
            nonce: translatedJump.nonce }
        : null,
    [translatedJump],
  );

  const showOriginal = mode === "original" || mode === "bilingual";
  const showTranslated = mode === "translation" || mode === "bilingual";

  // Memoised on the store objects so the panes see a stable source identity and
  // do not reload the document on every unrelated re-render.
  const originalSource = useMemo<PdfSource | null>(
    () =>
      document ? { kind: "local", file: document.file, name: document.name } : null,
    [document],
  );

  const monoUrl = translation?.monoUrl ?? null;
  const translatedSource = useMemo<PdfSource | null>(
    () =>
      monoUrl ? { kind: "asset", url: monoUrl, name: `${document?.name ?? "文档"}（译文）` } : null,
    [monoUrl, document?.name],
  );

  return (
    <main
      data-testid="reader-workspace"
      data-reader-mode={mode}
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-hidden bg-workspace p-2"
    >
      <TranslationNotice />
      <JumpNotice />

      {mode === "immersive" ? (
        <Suspense
          fallback={
            <p data-testid="assistant-panel-loading" className="p-3 text-xs text-muted-foreground">
              正在载入…
            </p>
          }
        >
          <ImmersiveReader />
        </Suspense>
      ) : (
      <div className="flex min-h-0 min-w-0 flex-1 gap-2">
        {showOriginal && (
          <PdfWorkspace
            testId="viewer-original"
            label="原文 PDF"
            source={originalSource}
            onFileChosen={openDocument}
            onCurrentPageChange={setActivePage}
            onReadingPositionChange={setReadingPosition}
            // The citation's page and boxes describe the *source* document, so
            // they are applied here and nowhere else. In bilingual mode the
            // translated pane is left exactly where the reader left it.
            jump={jumpRequest}
            annotationBoxes={annotationBoxes}
            allowHighlight
          />
        )}
        {showTranslated && (
          <PdfWorkspace
            testId="viewer-translated"
            label="译文 PDF"
            source={translatedSource}
            onDocumentLoaded={({ pageCount }) => noteTranslatedPageCount(pageCount)}
            jump={translatedJumpRequest}
            emptyState={<TranslatedEmpty />}
          />
        )}
      </div>
      )}
    </main>
  );
}

/**
 * Shown in the translated pane when there is no artifact to display.
 *
 * It carries no file picker: a translated document is produced by translating
 * the original, and offering a drop target here would imply the two panes are
 * independent inputs when in fact one is derived from the other.
 */
function TranslatedEmpty() {
  return (
    <div
      data-testid="translated-empty-state"
      className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground"
    >
      <Languages className="h-6 w-6 text-muted-foreground/60" aria-hidden="true" />
      <p className="text-sm font-medium">尚无译文</p>
      <p className="max-w-xs text-xs">点击顶部的「AI翻译」生成译文后，可在此与原文对照阅读。</p>
    </div>
  );
}
