/**
 * 逐段 — the paper, unrolled into one column with its translation in it.
 *
 * This is the reader's own description of what they wanted, twice over:
 *
 *   *"我原本是想要先英文一段，接下来是中文一段"*
 *   *"我想要的是能够保留原文排版的，而不是提取出来的"*
 *
 * The first attempt at this view re-typeset the paper's paragraphs and lost the
 * layout — formulas, tables, figures and the paper's own type gone, replaced by
 * this application's font. This one draws the page's **own pixels**: the page is
 * rendered once through PDF.js exactly as the 原文 mode renders it, cut into the
 * regions `geometry.ts` derives, and those regions are placed in reading order
 * with the translation of each paragraph inserted directly beneath it.
 *
 * Nothing about the source is re-typeset. The translation is real HTML text, so
 * it can be selected, copied and searched — which is the point of inserting text
 * rather than painting it into a canvas.
 *
 * ## What it costs to draw
 *
 * A page is rendered once into an offscreen canvas and then copied into one
 * canvas per region; the strips tile the page, so the live bitmap area is a
 * page, not two, and the offscreen is released as soon as the copy is done.
 * Pages are windowed by `IntersectionObserver`, exactly as the plain viewer
 * windows them. Everything is behind `React.lazy()`: a reader who never opens
 * this mode never downloads it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { Loader2, Sparkles, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  bilingualIsCurrent,
  generateBilingual,
  loadBilingual,
} from "@/bilingual/session";
import {
  pageFlow,
  type Box,
  type Insertion,
  type PageFlow,
} from "@/bilingual/inpage/geometry";
import {
  SEAM_PX,
  estimateFlowHeight,
  insertionFontPx,
} from "@/bilingual/inpage/heights";
import type { BilingualView } from "@/api/bilingual";
import type { IrBlock } from "@/api/ir";
import { cn } from "@/lib/utils";
import type { PageSurfaceProps } from "@/pdf/pageSurface";
import { useWorkspaceStore } from "@/stores/workspace";

/** How the column shows the paper. */
type ViewMode = "both" | "target" | "source";

const VIEW_LABELS: ReadonlyArray<{ value: ViewMode; label: string }> = [
  { value: "both", label: "双语" },
  { value: "target", label: "仅译文" },
  { value: "source", label: "仅原文" },
];

/** A page's flow plus the font sizes its translations should be set at. */
interface PageReading {
  flow: PageFlow;
  fontOf: (insertion: Insertion) => number | null;
}

const RENDER_BUFFER_MARGIN_PX = 600;

export default function InPageBilingualReader({
  pdfjs,
  document: pdf,
  scale,
  baseSize,
  viewerRef,
  onCurrentPageChange,
  onContainerWidthChange,
}: PageSurfaceProps) {
  const view = useWorkspaceStore((state) => state.bilingual);
  const ir = useWorkspaceStore((state) => state.ir);
  const status = useWorkspaceStore((state) => state.bilingualStatus);
  const error = useWorkspaceStore((state) => state.bilingualError);
  const plan = useWorkspaceStore((state) => state.bilingualPlan);
  const profileId = useWorkspaceStore((state) => state.profileId);
  const profiles = useWorkspaceStore((state) => state.profiles);
  const documentId = useWorkspaceStore((state) => state.document?.documentId ?? null);

  const [refusal, setRefusal] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>("both");

  const containerRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [visiblePages, setVisiblePages] = useState<Set<number>>(new Set());
  const measured = useRef<Map<number, number>>(new Map());

  // The stored reading. A **read**: it cannot reach a provider, and it is the
  // only request this view makes on its own.
  useEffect(() => {
    if (documentId !== null) void loadBilingual();
  }, [documentId]);

  const usable =
    view !== null && ir !== null && documentId !== null && bilingualIsCurrent(view, ir.content_hash);

  const readings = useMemo<PageReading[]>(() => {
    if (!usable || ir === null || view === null) return [];
    const byPage = new Map<number, BilingualView["paragraphs"]>();
    for (const paragraph of view.paragraphs) {
      const list = byPage.get(paragraph.page_number);
      if (list === undefined) byPage.set(paragraph.page_number, [paragraph]);
      else list.push(paragraph);
    }

    return ir.pages.map((page) => {
      const blocks = page.blocks.map((block: IrBlock) => ({
        id: block.id,
        layoutClass: block.layout_class,
        box: block.bbox,
        fontSize: block.font_size ?? null,
      }));
      const paragraphs = (byPage.get(page.page_number) ?? []).map((paragraph) => ({
        id: paragraph.paragraph_id,
        boxes: paragraph.bboxes as Box[],
        status: paragraph.status,
        text: paragraph.translated_text,
        note: paragraph.note,
      }));
      const flow = pageFlow(
        { pageNumber: page.page_number, widthPt: page.width_pt, heightPt: page.height_pt },
        blocks,
        paragraphs satisfies ParagraphSpanLike[],
      );

      // A translation is set at the size of the block the paragraph ends in:
      // headline paragraphs stay headline-sized, and the unrolled page keeps the
      // paper's own hierarchy instead of one size throughout.
      const fontOf = (insertion: Insertion): number | null => {
        const match = page.blocks.find(
          (block) =>
            Math.abs(block.bbox[0] - insertion.box[0]) < 0.6 &&
            Math.abs(block.bbox[1] - insertion.box[1]) < 0.6 &&
            Math.abs(block.bbox[2] - insertion.box[2]) < 0.6 &&
            Math.abs(block.bbox[3] - insertion.box[3]) < 0.6,
        );
        return match?.font_size ?? null;
      };

      return { flow, fontOf };
    });
  }, [usable, ir, view]);

  const estimates = useMemo(() => {
    const map = new Map<number, number>();
    for (const reading of readings) {
      map.set(reading.flow.pageNumber, estimateFlowHeight(reading.flow, scale, reading.fontOf));
    }
    return map;
  }, [readings, scale]);

  // --- windowing ---------------------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        setVisiblePages((previous) => {
          const next = new Set(previous);
          for (const entry of entries) {
            const page = Number((entry.target as HTMLElement).dataset.pageNumber ?? "0");
            if (entry.isIntersecting) next.add(page);
            else next.delete(page);
          }
          return next;
        });
      },
      { root: container, rootMargin: `${RENDER_BUFFER_MARGIN_PX}px 0px` },
    );
    for (const element of pageRefs.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [readings.length]);

  // --- fit-width needs the width of *this* box, not the plain viewer's --------
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const report = () => onContainerWidthChange(container.clientWidth);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(container);
    return () => observer.disconnect();
  }, [onContainerWidthChange]);

  // --- the page the reader is on ------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const containerRect = container.getBoundingClientRect();
      let best = 1;
      let bestVisible = -1;
      for (const [page, element] of pageRefs.current) {
        const rect = element.getBoundingClientRect();
        const visible =
          Math.min(rect.bottom, containerRect.bottom) - Math.max(rect.top, containerRect.top);
        if (visible > bestVisible) {
          bestVisible = visible;
          best = page;
        }
      }
      if (bestVisible > 0) onCurrentPageChange(best);
    };
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(measure);
    };
    measure();
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [onCurrentPageChange, readings.length]);

  /**
   * A page's real height, once it has one.
   *
   * The estimate reserved the space; this replaces it, and pays back the
   * difference to pages the reader has already scrolled past — otherwise a page
   * above the viewport growing by 400 px silently moves what they are reading.
   */
  const onPageMeasured = useCallback((page: number, naturalHeight: number) => {
    // A measurement of zero is not a short page: it is a page that has not been
    // laid out. Trusting it would collapse the container to nothing and let the
    // scroll position underneath it collapse too.
    if (naturalHeight <= 0) return;
    const previous = measured.current.get(page);
    measured.current.set(page, naturalHeight);
    if (previous === undefined) return;
    const delta = naturalHeight - previous;
    if (Math.abs(delta) < 1) return;

    const container = containerRef.current;
    const element = pageRefs.current.get(page);
    if (container === null || element === undefined) return;
    if (element.getBoundingClientRect().bottom <= container.getBoundingClientRect().top) {
      container.scrollTop += delta;
    }
  }, []);

  // --- jumps from the outline and from a paragraph's own badge ------------------
  useEffect(() => {
    viewerRef.current = {
      scrollToPage: (page: number, offsetPt?: number) => {
        const container = containerRef.current;
        const element = pageRefs.current.get(page);
        if (container === null || element === undefined) return;
        const pageRect = element.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();

        // The unrolled page is taller than the paper's, so a position in the PDF
        // is found by the region that contains it rather than by multiplying.
        let into = 0;
        const regions = element.querySelectorAll<HTMLElement>("[data-region-y0]");
        for (const region of regions) {
          const y0 = Number(region.dataset.regionY0 ?? "0");
          const y1 = Number(region.dataset.regionY1 ?? "0");
          const strip = region.dataset.regionKind === "strip";
          if (offsetPt !== undefined && offsetPt >= y0 - 2 && offsetPt <= y1 + 2) {
            into = region.getBoundingClientRect().top - pageRect.top;
            if (strip) into += (offsetPt - y0) * scale;
            break;
          }
        }
        container.scrollTop += into + (pageRect.top - containerRect.top) - 8;
      },
    };
  }, [scale, viewerRef]);

  // --- nothing yet ---------------------------------------------------------------
  if (!usable) {
    const waiting = status === "loading" && view === null;
    return (
      <div
        className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-md border bg-background p-3"
        data-testid="bilingual-inpage"
      >
        <h2 className="flex select-none items-center gap-1.5 text-sm font-medium">
          <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />
          逐段对照
        </h2>
        {waiting ? (
          <p data-testid="bilingual-loading" className="mt-2 text-xs text-muted-foreground">
            正在载入逐段对照…
          </p>
        ) : (
          <>
            <p data-testid="bilingual-not-generated" className="mt-2 text-xs text-muted-foreground">
              这篇论文还没有逐段对照。生成后，原文页面保持不变，每个段落下方直接给出它的译文。
            </p>
            {plan !== null && (
              <p data-testid="bilingual-plan" className="mt-1 text-2xs text-muted-foreground">
                共 {plan.paragraphs} 个段落 · 预计 {plan.batches} 次模型请求 · 原文约{" "}
                {plan.characters.toLocaleString()} 字符
              </p>
            )}
            {profileId !== "" && profiles !== null && (
              <p className="mt-1 select-none text-2xs text-muted-foreground">
                模型服务：{profiles.find((profile) => profile.id === profileId)?.name ?? profileId}
              </p>
            )}
            {(error !== null || refusal !== null || status === "failed") && (
              <p
                role="alert"
                data-testid="bilingual-error"
                className="mt-1 flex items-start gap-1 text-2xs text-amber-600 dark:text-amber-500"
              >
                <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                <span>{refusal ?? error ?? "逐段对照生成失败，请稍后重试。"}</span>
              </p>
            )}
            <Button
              size="sm"
              variant="outline"
              className="mt-2 w-fit select-none"
              data-testid="bilingual-generate-btn"
              disabled={status === "generating"}
              onClick={() => {
                setRefusal(null);
                void generateBilingual().then((outcome) => {
                  if (!outcome.ok) setRefusal(outcome.reason);
                });
              }}
            >
              {status === "generating" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : null}
              生成逐段对照
            </Button>
            <p className="mt-1 select-none text-2xs text-muted-foreground/80">
              {status === "generating"
                ? "正在翻译…"
                : plan !== null
                  ? `将调用 ${plan.batches} 次模型请求，可能耗时数分钟。`
                  : "将调用若干次模型请求，可能耗时数分钟。"}
            </p>
            {profileId === "" && (
              <p className="mt-1 select-none text-2xs text-muted-foreground/80">
                请先在设置中配置模型服务。
              </p>
            )}
            <p data-testid="bilingual-disclaimer" className="mt-3 text-2xs text-muted-foreground/70">
              逐段对照为针对段落语义的沉浸式翻译，与版面翻译 PDF 的文字排版与用词可能存在细微差异。
            </p>
          </>
        )}
      </div>
    );
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border bg-background"
      data-testid="bilingual-inpage"
    >
      <div className="flex shrink-0 select-none flex-wrap items-center gap-1.5 border-b px-3 py-1.5">
        <span className="text-xs font-medium">逐段对照</span>
        <span data-testid="bilingual-counts" className="text-2xs text-muted-foreground">
          {view.translated_paragraphs} / {view.total_paragraphs} 段已译
        </span>
        {view.status === "PARTIAL" && (
          <span
            data-testid="bilingual-partial"
            className="rounded-sm bg-amber-100 px-1 text-2xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
          >
            部分段落未翻译
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5 rounded-md border bg-muted/60 p-0.5">
          {VIEW_LABELS.map((entry) => (
            <button
              key={entry.value}
              type="button"
              data-testid={`bilingual-view-${entry.value}`}
              aria-pressed={mode === entry.value}
              onClick={() => setMode(entry.value)}
              className={cn(
                "rounded-sm px-1.5 py-0.5 text-2xs transition-colors",
                mode === entry.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      <div
        ref={containerRef}
        data-testid="bilingual-inpage-scroll"
        className="min-h-0 flex-1 overflow-auto bg-workspace p-4"
      >
        <div className="mx-auto flex w-fit flex-col items-center gap-6">
          {readings.map((reading) => (
            <PageReadingView
              key={reading.flow.pageNumber}
              reading={reading}
              pdfjs={pdfjs}
              pdf={pdf}
              scale={scale}
              mode={mode}
              hovered={hovered}
              setHovered={setHovered}
              shouldRender={visiblePages.has(reading.flow.pageNumber)}
              estimate={estimates.get(reading.flow.pageNumber) ?? baseSize.height * scale}
              measuredHeight={measured.current.get(reading.flow.pageNumber)}
              onMeasured={onPageMeasured}
              containerRef={(element) => {
                if (element === null) pageRefs.current.delete(reading.flow.pageNumber);
                else pageRefs.current.set(reading.flow.pageNumber, element);
              }}
            />
          ))}
        </div>
      </div>
      <p
        data-testid="bilingual-disclaimer"
        className="shrink-0 select-none border-t px-3 py-1 text-2xs text-muted-foreground/70"
      >
        逐段对照为针对段落语义的沉浸式翻译，与版面翻译 PDF 的文字排版与用词可能存在细微差异。
      </p>
    </div>
  );
}

type ParagraphSpanLike = Parameters<typeof pageFlow>[2][number];

// --- one page ------------------------------------------------------------------

interface PageReadingViewProps {
  reading: PageReading;
  pdfjs: PageSurfaceProps["pdfjs"];
  pdf: PDFDocumentProxy;
  scale: number;
  mode: ViewMode;
  hovered: string | null;
  setHovered: (id: string | null) => void;
  shouldRender: boolean;
  estimate: number;
  measuredHeight: number | undefined;
  onMeasured: (page: number, height: number) => void;
  containerRef: (element: HTMLDivElement | null) => void;
}

function PageReadingView({
  reading,
  pdfjs,
  pdf,
  scale,
  mode,
  hovered,
  setHovered,
  shouldRender,
  estimate,
  measuredHeight,
  onMeasured,
  containerRef,
}: PageReadingViewProps) {
  const { flow, fontOf } = reading;
  const pageNumber = flow.pageNumber;
  /**
   * The page's own render, and the state that publishes it.
   *
   * State rather than a ref, and this is not a style choice: a ref read during a
   * render hands the children a canvas that the effect's cleanup may have
   * already emptied, and drawing from an emptied canvas **throws** — measured in
   * Chromium the first time the reader zoomed, where the exception took the whole
   * reading down to an error boundary. With state, the children are handed a
   * canvas that is alive and are told the moment it is not.
   */
  const [raster, setRaster] = useState<HTMLCanvasElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  // One render of the page, at this scale, into a canvas nobody sees. Every
  // region is copied out of it; the moment it is replaced, the children stop
  // referring to it and the bitmap becomes garbage — which is why the cleanup
  // drops the reference instead of zeroing the canvas underneath them.
  useEffect(() => {
    if (!shouldRender) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    const offscreen = window.document.createElement("canvas");

    void (async () => {
      const page = await pdf.getPage(pageNumber);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const ratio = window.devicePixelRatio || 1;
      offscreen.width = Math.floor(viewport.width * ratio);
      offscreen.height = Math.floor(viewport.height * ratio);
      const context = offscreen.getContext("2d");
      if (context === null) return;
      task = page.render({
        canvas: offscreen,
        canvasContext: context,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      try {
        await task.promise;
      } catch {
        return;
      }
      if (cancelled) return;
      setRaster(offscreen);
    })();

    return () => {
      cancelled = true;
      task?.cancel();
      setRaster(null);
    };
  }, [pageNumber, pdf, scale, shouldRender, pdfjs]);

  // The real height, reported up so the scroll position can be corrected.
  useEffect(() => {
    const element = contentRef.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => onMeasured(pageNumber, element.offsetHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, [onMeasured, pageNumber]);

  // Which strips are source prose: one with a translation after it. Used by the
  // 仅译文 view, which keeps the figures and drops the prose the translation
  // already carries.
  const proseStrips = useMemo(() => {
    const set = new Set<string>();
    let last: string | null = null;
    for (const item of flow.items) {
      if (item.kind === "strip") last = item.strip.id;
      else if (item.kind === "insertion" && last !== null) set.add(last);
    }
    return set;
  }, [flow]);

  const [minHeight, setMinHeight] = useState(estimate);
  useEffect(() => {
    setMinHeight(measuredHeight ?? estimate);
  }, [estimate, measuredHeight]);

  return (
    <div
      ref={containerRef}
      data-testid="bilingual-inpage-page"
      data-page-number={pageNumber}
      data-page-scale={scale}
      className="relative w-fit bg-page-surface shadow-sm"
      style={{ minHeight }}
    >
      <div ref={contentRef} className="flex w-fit flex-col">
        {flow.skipped.length > 0 && (
          <p
            data-testid="bilingual-inpage-kept-original"
            className="select-none border-b border-dashed px-2 py-1 text-2xs text-muted-foreground/80"
          >
            本页参考文献保留原文，不予翻译。
          </p>
        )}
        {flow.items.map((item, index) => {
          if (item.kind === "strip") {
            const { strip } = item;
            const width = (strip.box[2] - strip.box[0]) * scale;
            const height = (strip.box[3] - strip.box[1]) * scale;
            const hidden = mode === "target" && proseStrips.has(strip.id);
            return (
              <div
                key={`${strip.id}_${index}`}
                data-testid="bilingual-inpage-strip"
                data-strip-id={strip.id}
                data-strip-lane={strip.lane}
                data-region-kind="strip"
                data-region-y0={strip.box[1]}
                data-region-y1={strip.box[3]}
                data-hovered={hovered === strip.id ? "true" : undefined}
                className={cn(
                  "group relative shrink-0",
                  hidden && "hidden",
                  hovered === strip.id && "ring-1 ring-primary/30",
                )}
                style={{ width, height }}
              >
                {shouldRender && (
                  <StripCanvas raster={raster} box={strip.box} scale={scale} />
                )}
                <button
                  type="button"
                  data-testid="bilingual-jump-pdf"
                  title={`在原文 PDF 中查看（第 ${pageNumber} 页）`}
                  onClick={() => {
                    const state = useWorkspaceStore.getState();
                    state.setReaderMode("original");
                    state.requestJump(pageNumber, [strip.box], strip.box[1]);
                  }}
                  className="absolute right-0.5 top-0.5 select-none rounded-sm bg-background/80 px-1 text-2xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                >
                  P. {pageNumber}
                </button>
              </div>
            );
          }

          if (item.kind === "seam") {
            return (
              <div
                key={item.id}
                data-testid="bilingual-inpage-seam"
                className="flex shrink-0 select-none items-center justify-center border-y border-dashed text-2xs text-muted-foreground/60"
                style={{ height: SEAM_PX }}
              >
                分栏
              </div>
            );
          }

          const { insertion } = item;
          const width = lastWidth(flow, index, scale);
          const fontPx = insertionFontPx(fontOf(insertion), scale);
          const done = insertion.status === "translated";
          return (
            <div
              key={`${insertion.id}_${index}`}
              data-testid="bilingual-inpage-target"
              data-paragraph-id={insertion.paragraphId}
              data-region-kind="insertion"
              data-region-y0={insertion.box[1]}
              data-region-y1={insertion.box[3]}
              data-hovered={hovered === lastStripId(flow, index) ? "true" : undefined}
              onMouseEnter={() => setHovered(lastStripId(flow, index))}
              onMouseLeave={() => setHovered(null)}
              className={cn(
                "shrink-0 rounded-sm px-2 py-1.5",
                mode === "source" && "hidden",
                hovered === lastStripId(flow, index) && "bg-primary/[0.04]",
              )}
              style={{ width, fontSize: fontPx, lineHeight: 1.7 }}
            >
              {done ? (
                <p data-testid="bilingual-inpage-text" className="text-foreground">
                  {insertion.text}
                </p>
              ) : (
                <p className="flex select-none items-start gap-1 text-2xs text-amber-600 dark:text-amber-500">
                  <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                  <span data-testid="bilingual-inpage-gap">
                    此段未翻译{insertion.note !== null && insertion.note !== "" ? `（${insertion.note}）` : ""}
                  </span>
                  <button
                    type="button"
                    data-testid="bilingual-inpage-retry"
                    className="underline"
                    disabled={status_isGenerating()}
                    onClick={() => void generateBilingual()}
                  >
                    重新生成逐段对照
                  </button>
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The width of the strip an insertion follows — the paper's own column width. */
function lastWidth(flow: PageFlow, index: number, scale: number): number {
  for (let at = index - 1; at >= 0; at -= 1) {
    const item = flow.items[at];
    if (item !== undefined && item.kind === "strip") {
      return (item.strip.box[2] - item.strip.box[0]) * scale;
    }
  }
  return flow.widthPt * scale;
}

/** The strip an insertion follows, so hovering either half couples them. */
function lastStripId(flow: PageFlow, index: number): string | null {
  for (let at = index - 1; at >= 0; at -= 1) {
    const item = flow.items[at];
    if (item !== undefined && item.kind === "strip") return item.strip.id;
  }
  return null;
}

function status_isGenerating(): boolean {
  return useWorkspaceStore.getState().bilingualStatus === "generating";
}

/** One region of the page: copied out of the page's own render, at this scale. */
function StripCanvas({
  raster,
  box,
  scale,
}: {
  raster: HTMLCanvasElement | null;
  box: Box;
  scale: number;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    // A canvas with no pixels is not a canvas to copy from: `drawImage` throws
    // rather than drawing nothing, and an exception here takes the page down.
    if (canvas === null || raster === null || raster.width === 0 || raster.height === 0) return;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round((box[2] - box[0]) * scale * ratio));
    const height = Math.max(1, Math.round((box[3] - box[1]) * scale * ratio));
    canvas.width = width;
    canvas.height = height;
    canvas.style.width = `${(box[2] - box[0]) * scale}px`;
    canvas.style.height = `${(box[3] - box[1]) * scale}px`;
    const context = canvas.getContext("2d");
    if (context === null) return;
    context.drawImage(
      raster,
      Math.round(box[0] * scale * ratio),
      Math.round(box[1] * scale * ratio),
      width,
      height,
      0,
      0,
      width,
      height,
    );
  }, [raster, box, scale]);

  return <canvas ref={ref} aria-hidden="true" className="block" />;
}

export type { PageReading };
