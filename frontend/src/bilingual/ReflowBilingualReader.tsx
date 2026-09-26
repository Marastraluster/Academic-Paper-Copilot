/**
 * 逐段 — the paper reflowed into one readable column, with its translation in it.
 *
 * Two views came before this one. The first (§DS-DOC-006) re-typeset the
 * paragraphs and lost the paper: no figures, no formulas, no captions, no
 * hierarchy. The second (DS-DOC-007) kept every pixel of the page and was
 * unreadable: two columns of 9.4 pt print, zoom to read. The reader rejected
 * both, in those words, and then showed a competitor doing the third thing —
 * reflowing the prose into one column while keeping the paper's figures,
 * formulas and captions as the paper drew them.
 *
 * That is this view. Prose is prose: set here, selectable, at a readable
 * measure, with each paragraph's translation directly beneath it. Anything whose
 * pixels *are* the content — a figure, a table, a display formula — is a crop of
 * the page's own render, at the live scale, re-rendered rather than stretched
 * when the reader zooms.
 *
 * ## What it refuses to do
 *
 * A paragraph with no translation says so, in place, with the reason: a reading
 * with a visible gap is worth more than one that hides it. The bibliography is
 * kept in the paper's own words and says why. And a heading is a heading only
 * because the extractor derived a section for it — never because a layout class
 * said `title`, which it says about table sub-labels and, once, about a
 * sentence fragment.
 *
 * DS-DOC-009 answered the reader's verdict on *how it looked*: the source is set
 * in an academic serif because it is the paper, the translation in a CJK sans a
 * size down because it is the aid, the stripe that ran down every translation is
 * gone — 97 of them is noise, not emphasis — and a display formula, which the
 * paper set at 6.5–10 pt beside a 16 px sentence, is drawn larger from the
 * page's own vector content.
 *
 * The whole module is behind a dynamic import: a reader who never opens this
 * view never downloads it, and the initial chunk has two kilobytes of headroom
 * under its ceiling.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Sparkles, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { bilingualIsCurrent, generateBilingual, loadBilingual } from "@/bilingual/session";
import { CropCanvas, magnificationFor, usePageRasters } from "@/bilingual/reflow/crops";
import { FormulaItem } from "@/formulas/FormulaItem";
import { generateFormulas, loadFormulas } from "@/formulas/session";
import {
  itemPage,
  itemY0,
  reflowStream,
  type ReflowCrop,
  type ReflowItem,
  type ReflowPair,
} from "@/bilingual/reflow/stream";
import type { PageSurfaceProps } from "@/pdf/pageSurface";
import { useWorkspaceStore } from "@/stores/workspace";

/** How the column shows the paper. */
type ViewMode = "both" | "target" | "source";

const VIEW_LABELS: ReadonlyArray<{ value: ViewMode; label: string }> = [
  { value: "both", label: "双语" },
  { value: "target", label: "仅译文" },
  { value: "source", label: "仅原文" },
];

/** The reading measure: a longer line is harder to read, whatever the window. */
const COLUMN_CLASS = "mx-auto w-full max-w-[680px]";

/**
 * The two voices.
 *
 * The source is the paper, so it is set as a paper is — an academic serif at
 * body size. The translation is the aid, so it is set in the system's own
 * reading face, one size down and a shade lighter. Neither is a webfont: this
 * application works offline and ships no font files, so both are the stacks the
 * reader's own operating system already has.
 */
const SERIF_CLASS =
  "[font-family:Charter,'Source_Serif_Pro','Iowan_Old_Style',Georgia,Cambria,'Times_New_Roman',serif] [font-feature-settings:'kern'_1,'liga'_1,'calt'_1]";
const SANS_CLASS =
  "[font-family:-apple-system,BlinkMacSystemFont,'PingFang_SC','Hiragino_Sans_GB','Microsoft_YaHei','WenQuanYi_Micro_Hei',ui-sans-serif,system-ui,sans-serif]";

/** Each level at the size the criteria froze, with the rhythm around it. */
const HEADING_CLASS: Record<number, string> = {
  1: "mt-10 mb-3 text-[1.375rem] font-bold leading-[1.35]",
  2: "mt-8 mb-2 text-[1.1875rem] font-semibold leading-[1.4]",
  3: "mt-6 mb-2 text-[1.0625rem] font-semibold leading-[1.45]",
};
const HEADING_TRANSLATION_CLASS: Record<number, string> = {
  1: "mt-1 text-[0.9375rem]",
  2: "mt-1 text-[0.875rem]",
  3: "mt-0.5 text-[0.8125rem]",
};

/** The number's own column, so a formula can be centred without it. */
const NUMBER_SLOT_PX = 64;

export default function ReflowBilingualReader({
  pdfjs,
  document: pdf,
  scale,
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
  const formulas = useWorkspaceStore((state) => state.formulas);
  const formulasPlan = useWorkspaceStore((state) => state.formulasPlan);
  const formulasStatus = useWorkspaceStore((state) => state.formulasStatus);

  const [refusal, setRefusal] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>("both");
  const [columnWidth, setColumnWidth] = useState(680);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Map<string, HTMLElement>>(new Map());

  // The stored reading and the stored formulas. Both are **reads**: neither can
  // reach a provider, and they are the only requests this view makes on its own.
  useEffect(() => {
    if (documentId !== null) void loadBilingual();
  }, [documentId]);
  useEffect(() => {
    if (documentId !== null) void loadFormulas();
  }, [documentId]);

  const usable =
    view !== null && ir !== null && documentId !== null && bilingualIsCurrent(view, ir.content_hash);

  const items = useMemo<ReflowItem[]>(
    () => (usable && ir !== null ? reflowStream(ir, view) : []),
    [usable, ir, view],
  );

  // `version` is what makes the column re-render when a page's render lands.
  /**
   * How much larger the paper's formulas are drawn.
   *
   * One number for the document, from the size the paper set its own display
   * formulas in — because that size varies: 6.5 pt and 9.3 pt in one of the
   * papers here, 10 pt in another. A fixed factor suits exactly one of them
   * (AC_CHANGE_REQUEST 1 in `docs/acceptance/DS-DOC-009.md`).
   */
  const magnification = useMemo(() => {
    if (ir === null) return 1;
    const inks = ir.pages
      .flatMap((page) => page.blocks)
      .filter((block) => block.layout_class === "isolate_formula")
      .map((block) => block.font_size)
      .filter((size): size is number => typeof size === "number" && size > 0)
      .sort((a, b) => a - b);
    if (inks.length === 0) return 1;
    return magnificationFor(inks[Math.floor(inks.length / 2)] ?? null);
  }, [ir]);

  const { rasterFor, request, version } = usePageRasters(pdf, pdfjs, scale, magnification);
  void version;

  // --- the reader's place, and the outline ------------------------------------
  useEffect(() => {
    viewerRef.current = {
      scrollToPage: (page: number, offsetPt?: number) => {
        const container = containerRef.current;
        if (container === null) return;
        const candidates = items
          .map((item) => ({
            element: itemRefs.current.get(item.id) ?? null,
            page: itemPage(item),
            y0: itemY0(item),
          }))
          .filter((entry): entry is { element: HTMLElement; page: number; y0: number } =>
            entry.element !== null && entry.page > 0,
          );

        // A position in the paper, resolved to the item that contains it — the
        // reflowed column is not paged, so there is no page offset to multiply.
        const onPage = candidates.filter((entry) => entry.page === page);
        const target =
          (offsetPt === undefined
            ? onPage[0]
            : (onPage.find((entry) => entry.y0 >= offsetPt - 4) ?? onPage[onPage.length - 1])) ??
          candidates.find((entry) => entry.page > page);
        if (target === undefined) return;
        target.element.scrollIntoView({ block: "start", behavior: "auto" });
      },
    };
  }, [items, viewerRef]);

  // --- the page the reader is in ----------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const containerTop = container.getBoundingClientRect().top;
      let best = 1;
      let bestDistance = Number.POSITIVE_INFINITY;
      // A reflow has no pages, but the reader still wants to know which page of
      // the paper they are in — the first item below the top of the viewport is
      // the honest answer.
      for (const item of items) {
        if (item.kind === "notice") continue;
        const element = itemRefs.current.get(item.id);
        if (element === undefined) continue;
        const distance = element.getBoundingClientRect().top - containerTop;
        if (distance >= -8 && distance < bestDistance) {
          bestDistance = distance;
          best = item.pageNumber;
        }
      }
      onCurrentPageChange(best);
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
  }, [items, onCurrentPageChange]);

  /**
   * The width of this box — for fit-width, and for clamping a crop.
   *
   * `usable` is in the dependency list for a reason that cost a real bug: on the
   * first render there is no reading yet, so the component returns its empty
   * state and the container this measures **does not exist**. The effect then
   * returned early and never ran again, leaving the column width at its initial
   * 680 on every narrower viewport — invisible at 1440 px, and a crop hanging
   * out of its column at 768 px.
   */
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const report = () => {
      onContainerWidthChange(container.clientWidth);
      // The column is what a crop is clamped against: narrower than the box on a
      // wide screen, the box itself on a narrow one.
      setColumnWidth(Math.min(680, Math.max(240, container.clientWidth - 32)));
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(container);
    return () => observer.disconnect();
  }, [onContainerWidthChange, usable]);

  const attach = useCallback((id: string, element: HTMLElement | null) => {
    if (element === null) itemRefs.current.delete(id);
    else itemRefs.current.set(id, element);
  }, []);

  // --- nothing yet --------------------------------------------------------------
  if (!usable) {
    const waiting = status === "loading" && view === null;
    return (
      <div
        className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-md border bg-background p-3"
        data-testid="reflow-reader"
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
              这篇论文还没有逐段对照。生成后，论文重排成单栏，每个段落下方直接给出它的译文，图表和公式保持原样。
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
            <p
              data-testid="bilingual-disclaimer"
              className="mt-3 text-2xs text-muted-foreground/70"
            >
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
      data-testid="reflow-reader"
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
        data-testid="reflow-scroll"
        data-column-width={columnWidth}
        className={cn(
          SANS_CLASS,
          "min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-workspace px-4 py-8",
        )}
      >
        {/* 28 px between pairs, 8 px inside one: the ratio is what makes a
            paragraph and its translation read as one thing rather than two. */}
        <div className={cn(COLUMN_CLASS, "space-y-7")}>
          {formulasPlan !== null && (
            <div
              data-testid="reflow-formulas-upgrade"
              className="flex flex-wrap items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground"
            >
              <span>
                检测到 {formulasPlan.total_formulas} 处公式，可生成 LaTeX 排版（将消耗{" "}
                {formulasPlan.batch_count} 次请求）
              </span>
              <Button
                size="sm"
                variant="outline"
                className="w-fit select-none"
                data-testid="reflow-formulas-generate"
                disabled={formulasStatus === "generating"}
                onClick={() => void generateFormulas()}
              >
                {formulasStatus === "generating" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : null}
                生成 LaTeX
              </Button>
            </div>
          )}
          {items.map((item) => {
            if (item.kind === "heading") {
              const level = item.level === 1 ? 1 : item.level === 2 ? 2 : 3;
              const Tag = (level === 1 ? "h1" : level === 2 ? "h2" : "h3") as "h1" | "h2" | "h3";
              return (
                <Tag
                  key={item.id}
                  ref={(element: HTMLHeadingElement | null) => attach(item.id, element)}
                  data-item-page={item.pageNumber}
                  data-item-y0={item.y0}
                  data-testid="reflow-heading"
                  data-section-id={item.sectionId}
                  data-heading-level={level}
                  className={cn("scroll-mt-4 select-none text-balance", HEADING_CLASS[level])}
                >
                  {item.title}
                  {item.titleTranslated !== null && item.titleTranslated !== "" && (
                    <span
                      data-testid="reflow-heading-translated"
                      className={cn(
                        "block font-normal text-muted-foreground",
                        HEADING_TRANSLATION_CLASS[level],
                      )}
                    >
                      {item.titleTranslated}
                    </span>
                  )}
                </Tag>
              );
            }

            if (item.kind === "notice") {
              return (
                <p
                  key={item.id}
                  data-testid="reflow-references-notice"
                  className="select-none rounded-sm border border-dashed px-3 py-2 text-xs text-muted-foreground"
                >
                  {item.text}
                </p>
              );
            }

            if (item.kind === "crop") {
              // A formula is the reconstruction component's to place — but only
              // when the paper *has* reconstructions. Without them the crop is
              // what the reader gets, equation number and all: diverting a
              // formula that has no reconstruction would silently drop the
              // number the paper printed beside it.
              // Only an artifact that describes *this* extraction may typeset a
              // formula; the same guard the reading makes for its own cache.
              if (
                item.layoutClass === "isolate_formula" &&
                formulas !== null &&
                formulas.content_hash === ir.content_hash
              ) {
                const reconstruction =
                  formulas.formulas.find((entry) => entry.block_id === item.blockId) ?? null;
                const usable =
                  reconstruction !== null &&
                  reconstruction.status === "reconstructed" &&
                  reconstruction.latex.trim() !== "";
                return (
                  <FormulaItem
                    key={item.id}
                    latex={usable ? reconstruction.latex : null}
                    refusalReason={reconstruction?.refusal_reason ?? null}
                    failureReason={reconstruction?.error_reason ?? null}
                    number={item.number ?? item.caption?.text ?? null}
                    pageNumber={item.pageNumber}
                    blockId={item.blockId}
                    availableWidthPx={Math.max(240, columnWidth - 128)}
                    // The number moves to the component's own right-hand slot,
                    // so the crop underneath it must not print it twice.
                    crop={
                      <CropItem
                        crop={{ ...item, caption: null, captionSide: null, footnote: null }}
                        rasterFor={rasterFor}
                        request={request}
                        scale={scale}
                        magnification={magnification}
                        columnWidth={columnWidth}
                        attach={attach}
                      />
                    }
                  />
                );
              }

              return (
                <CropItem
                  key={item.id}
                  crop={item}
                  rasterFor={rasterFor}
                  request={request}
                  scale={scale}
                  magnification={magnification}
                  columnWidth={columnWidth}
                  attach={attach}
                />
              );
            }

            return (
              <PairItem
                key={item.id}
                pair={item}
                mode={mode}
                attach={attach}
                onRetry={() => void generateBilingual()}
              />
            );
          })}
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

// --- one paragraph and its translation ------------------------------------------

function PairItem({
  pair,
  mode,
  attach,
  onRetry,
}: {
  pair: ReflowPair;
  mode: ViewMode;
  attach: (id: string, element: HTMLElement | null) => void;
  onRetry: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      ref={(element) => attach(pair.id, element)}
      data-item-page={pair.pageNumber}
      data-item-y0={pair.y0}
      data-testid="reflow-pair"
      data-paragraph-id={pair.paragraphId}
      data-hovered={hovered ? "true" : undefined}
      className={cn("reflow-pair rounded-md transition-colors", hovered && "bg-muted/40")}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <p
        data-testid="reflow-source"
        className={cn(
          SERIF_CLASS,
          "reflow-pair-source text-base leading-[1.7] text-foreground",
          mode === "target" && "hidden",
        )}
      >
        {pair.sourceText}
      </p>

      {pair.status === "translated" && pair.translatedText !== null && (
        <p
          data-testid="reflow-translation"
          className={cn(
            SANS_CLASS,
            "reflow-pair-translation mt-2 text-sm leading-[1.65] text-foreground/80",
            mode === "source" && "hidden",
          )}
        >
          {pair.translatedText}
        </p>
      )}

      {pair.status === "untranslated" && (
        <p className="mt-2 flex select-none items-start gap-1 text-xs text-amber-600">
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span data-testid="bilingual-gap-badge">
            此段未翻译{pair.note !== "" ? `（${pair.note}）` : ""}
          </span>
          <button type="button" className="underline" onClick={onRetry}>
            重新生成逐段对照
          </button>
        </p>
      )}
    </div>
  );
}

// --- one figure, table or display formula ---------------------------------------

function CropItem({
  crop,
  rasterFor,
  request,
  scale,
  magnification,
  columnWidth,
  attach,
}: {
  crop: ReflowCrop;
  rasterFor: (page: number) => HTMLCanvasElement | null;
  request: (page: number) => void;
  scale: number;
  magnification: number;
  columnWidth: number;
  attach: (id: string, element: HTMLElement | null) => void;
}) {
  const [near, setNear] = useState(false);
  const host = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) setNear(true);
      },
      { rootMargin: "900px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (near) request(crop.pageNumber);
  }, [near, crop.pageNumber, request, scale]);

  const raster = rasterFor(crop.pageNumber);
  const caption = crop.caption;
  const isFormula = crop.layoutClass === "isolate_formula";
  const boxWidth = Math.max(crop.box[2] - crop.box[0], 0.01);

  // Measured against the size the paper set the formula in, then drawn larger so
  // a 6.5–10 pt formula is not fine print beside a 16 px sentence — but never
  // past the column, and never past the slot its equation number needs.
  const naturalPx = boxWidth * scale;
  const slot = isFormula && caption !== null ? columnWidth - NUMBER_SLOT_PX : columnWidth;
  // A crop wider than the column *at its natural size* is not shrunk: the reader
  // asked for that zoom. It gets a scroller of its own, so the column itself
  // never scrolls sideways.
  const overflows = naturalPx > columnWidth;
  const displayWidthPx = overflows ? naturalPx : Math.min(naturalPx * magnification, slot);

  return (
    <figure
      ref={(element) => {
        host.current = element;
        attach(crop.id, element);
      }}
      data-item-page={crop.pageNumber}
      data-item-y0={crop.box[1]}
      data-testid="reflow-crop"
      data-layout-class={crop.layoutClass}
      data-class-caption={caption === null ? undefined : (crop.captionSide ?? undefined)}
      data-display-width={Math.round(displayWidthPx)}
      className="my-6"
      aria-label={`${crop.layoutClass}（第 ${crop.pageNumber} 页原图）`}
    >
      {caption !== null && crop.captionSide === "above" && (
        <figcaption
          data-testid="reflow-caption"
          className="mb-2 text-[0.8125rem] leading-[1.5] text-muted-foreground"
        >
          {caption.text}
        </figcaption>
      )}

      {/* Three slots — an equal spacer, the formula, the number — so the
          formula's centre is the column's centre whatever the number's width. */}
      <div
        className={cn(
          isFormula &&
            caption !== null &&
            "grid w-full grid-cols-[1fr_auto_1fr] items-center gap-2",
        )}
      >
        {isFormula && caption !== null && <div aria-hidden="true" />}
        <div
          data-testid={overflows ? "reflow-crop-scroller" : undefined}
          className={cn("flex min-w-0 justify-center", overflows && "touch-pan-x overflow-x-auto")}
        >
          <CropCanvas
            raster={raster}
            box={crop.box}
            drawScale={scale * magnification}
            displayWidthPx={displayWidthPx}
          />
        </div>
        {isFormula && caption !== null && (
          <figcaption
            data-testid="reflow-caption"
            className="flex select-none justify-end pr-1 text-xs text-muted-foreground"
          >
            {caption.text}
          </figcaption>
        )}
      </div>

      {caption !== null && crop.captionSide === "below" && (
        <figcaption
          data-testid="reflow-caption"
          className="mt-2 text-[0.8125rem] leading-[1.5] text-muted-foreground"
        >
          {caption.text}
        </figcaption>
      )}

      {crop.footnote !== null && (
        <p
          data-testid="reflow-footnote"
          className="mt-1.5 text-xs leading-[1.4] text-muted-foreground"
        >
          {crop.footnote}
        </p>
      )}
    </figure>
  );
}
