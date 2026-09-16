import { useCallback, useEffect, useRef, useState } from "react";
import { FileUp, Loader2, ShieldAlert, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  FIT_WIDTH_PADDING_PX,
  type PdfjsModule,
  clampZoom,
  loadPdfjs,
  zoomIn as nextZoomIn,
  zoomOut as nextZoomOut,
} from "@/pdf/pdfjs";
import { PdfToolbar } from "@/pdf/PdfToolbar";
import { PdfViewer, type PageSize, type PdfViewerHandle } from "@/pdf/PdfViewer";
import type { ViewerError, ViewerStatus, ZoomMode } from "@/pdf/types";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import { cn } from "@/lib/utils";

interface PdfWorkspaceProps {
  /** Passed through to the panel element so the reader modes keep their hooks. */
  testId?: string;
  label?: string;
}

const DEFAULT_PAGE_SIZE: PageSize = { width: 595, height: 842 };

/**
 * A complete PDF reading surface: ingestion, states, toolbar and viewer.
 *
 * Everything is local. The file is read into an ArrayBuffer in the browser and
 * handed straight to PDF.js — nothing is uploaded, and no object URL is created
 * that would need revoking.
 *
 * Self-contained by design: two of these can be mounted side by side, each with
 * its own document, zoom and page, which is what the bilingual mode will need.
 */
export function PdfWorkspace({ testId = "pdf-viewer-panel", label }: PdfWorkspaceProps) {
  const [status, setStatus] = useState<ViewerStatus>("empty");
  const [error, setError] = useState<ViewerError | null>(null);
  const [documentName, setDocumentName] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [zoom, setZoom] = useState<ZoomMode>({ kind: "fit-width" });
  const [baseSize, setBaseSize] = useState<PageSize>(DEFAULT_PAGE_SIZE);
  const [containerWidth, setContainerWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  // Populated on first open; PDF.js lives in its own async chunk.
  const [pdfjs, setPdfjs] = useState<PdfjsModule | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const viewerRef = useRef<PdfViewerHandle | null>(null);
  const proxyRef = useRef<PDFDocumentProxy | null>(null);
  // Teardown belongs to the loading task, not the document proxy: in PDF.js 6
  // `loadingTask.destroy()` aborts the worker and frees the file, which is what
  // keeps a second document from inheriting the first one's memory.
  const taskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const loadTokenRef = useRef(0);

  // --- lifecycle: release the previous document -----------------------------
  const releaseDocument = useCallback(() => {
    const task = taskRef.current;
    taskRef.current = null;
    proxyRef.current = null;
    void task?.destroy().catch(() => undefined);
  }, []);

  useEffect(() => releaseDocument, [releaseDocument]);

  const openFile = useCallback(
    async (file: File) => {
      const token = ++loadTokenRef.current;

      if (!file.name.toLowerCase().endsWith(".pdf")) {
        releaseDocument();
        setStatus("error");
        setError({ kind: "unsupported", message: `“${file.name}” is not a PDF file.` });
        return;
      }

      releaseDocument();
      setStatus("loading");
      setError(null);
      setDocumentName(file.name);
      setCurrentPage(1);

      try {
        const module = await loadPdfjs();
        const data = new Uint8Array(await file.arrayBuffer());
        const task = module.getDocument({ data });
        const proxy = await task.promise;

        // A newer load started while this one was in flight.
        if (token !== loadTokenRef.current) {
          void task.destroy();
          return;
        }

        setPdfjs(module);
        taskRef.current = task;
        proxyRef.current = proxy;
        const firstPage = await proxy.getPage(1);
        const viewport = firstPage.getViewport({ scale: 1 });

        setBaseSize({ width: viewport.width, height: viewport.height });
        setPageCount(proxy.numPages);
        // A different paper has different dimensions; carrying a zoom ratio
        // across documents produces broken layouts.
        setZoom({ kind: "fit-width" });
        setStatus("ready");
      } catch (caught) {
        if (token !== loadTokenRef.current) return;
        setStatus("error");
        setPageCount(0);
        setError(describeFailure(caught, file.name));
      }
    },
    [releaseDocument],
  );

  // --- keyboard: Mod+O ------------------------------------------------------
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") {
        event.preventDefault();
        inputRef.current?.click();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // --- zoom -----------------------------------------------------------------
  const fitWidthScale =
    containerWidth > 0
      ? (containerWidth - FIT_WIDTH_PADDING_PX) / baseSize.width
      : 1;
  const effectiveScale =
    zoom.kind === "fit-width" ? fitWidthScale : clampZoom(zoom.value);

  const applyScale = (scale: number) => setZoom({ kind: "scale", value: clampZoom(scale) });

  const handleJump = (page: number) => {
    setCurrentPage(page);
    viewerRef.current?.scrollToPage(page);
  };

  const openPicker = () => inputRef.current?.click();

  return (
    <section
      aria-label={label}
      data-testid={testId}
      className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-md border bg-workspace"
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const file = event.dataTransfer.files?.[0];
        if (file) void openFile(file);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        data-testid="pdf-file-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void openFile(file);
          // Reset so choosing the same file twice still fires a change event.
          event.target.value = "";
        }}
      />

      {status === "ready" && (
        <PdfToolbar
          currentPage={currentPage}
          pageCount={pageCount}
          scale={effectiveScale}
          fitWidth={zoom.kind === "fit-width"}
          onJumpToPage={handleJump}
          onZoomIn={() => applyScale(nextZoomIn(effectiveScale))}
          onZoomOut={() => applyScale(nextZoomOut(effectiveScale))}
          onToggleFitWidth={() =>
            setZoom((mode) =>
              mode.kind === "fit-width" ? { kind: "scale", value: effectiveScale } : { kind: "fit-width" },
            )
          }
        />
      )}

      {status === "empty" && (
        <EmptyState onOpen={openPicker} dragging={dragging} />
      )}

      {status === "loading" && (
        <div
          data-testid="pdf-loading-spinner"
          role="status"
          aria-live="polite"
          className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground"
        >
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
          <p className="text-xs">正在打开 {documentName ?? "PDF"}…</p>
        </div>
      )}

      {status === "error" && error && (
        <ErrorState error={error} onRetry={openPicker} />
      )}

      {status === "ready" && proxyRef.current && pdfjs && (
        <PdfViewer
          pdfjs={pdfjs}
          document={proxyRef.current}
          pageCount={pageCount}
          scale={effectiveScale}
          baseSize={baseSize}
          viewerRef={viewerRef}
          onCurrentPageChange={setCurrentPage}
          onContainerWidthChange={setContainerWidth}
        />
      )}

      {dragging && status === "ready" && (
        <div className="pointer-events-none absolute inset-0 rounded-md ring-2 ring-primary ring-inset" />
      )}
    </section>
  );
}

function describeFailure(caught: unknown, fileName: string): ViewerError {
  const name = (caught as { name?: string })?.name ?? "";
  if (name === "PasswordException") {
    return { kind: "password", message: "This document is password-protected." };
  }
  if (name === "InvalidPDFException") {
    return { kind: "corrupt", message: `“${fileName}” could not be read as a PDF.` };
  }
  return {
    kind: "unsupported",
    message:
      (caught as { message?: string })?.message ?? `“${fileName}” could not be opened.`,
  };
}

function EmptyState({ onOpen, dragging }: { onOpen: () => void; dragging: boolean }) {
  return (
    <div
      data-testid="pdf-empty-state"
      className={cn(
        "flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center",
        dragging && "bg-accent/40",
      )}
    >
      <FileUp className="h-6 w-6 text-muted-foreground/60" aria-hidden="true" />
      <div>
        <p className="text-sm font-medium">未打开文档</p>
        <p className="mt-1 text-xs text-muted-foreground">
          拖入 PDF，或
        </p>
      </div>
      <Button data-testid="open-pdf-button" size="sm" variant="outline" onClick={onOpen}>
        打开 PDF
      </Button>
    </div>
  );
}

function ErrorState({ error, onRetry }: { error: ViewerError; onRetry: () => void }) {
  const password = error.kind === "password";
  const testId = password ? "pdf-password-error" : "pdf-error-state";

  return (
    <div
      data-testid={testId}
      role="alert"
      className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center"
    >
      {password ? (
        <ShieldAlert className="h-6 w-6 text-muted-foreground/60" aria-hidden="true" />
      ) : (
        <TriangleAlert className="h-6 w-6 text-destructive/70" aria-hidden="true" />
      )}
      <div>
        <p className="text-sm font-medium">
          {password ? "文档已受密码保护" : "无法打开文档"}
        </p>
        <p className="mt-1 max-w-sm text-xs text-muted-foreground">
          {password
            ? "暂不支持加密 PDF，请打开未加密的文件。"
            : error.message}
        </p>
      </div>
      <Button size="sm" variant="outline" onClick={onRetry}>
        打开其他文件
      </Button>
    </div>
  );
}
