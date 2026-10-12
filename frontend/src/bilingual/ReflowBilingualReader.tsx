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
import { CornerUpLeft, Loader2, RotateCcw, Sparkles, Square, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  bilingualIsCurrent,
  generateBilingual,
  loadBilingual,
  retranslate,
  stopBilingual,
} from "@/bilingual/session";
import { GlossaryPanel } from "@/bilingual/GlossaryPanel";
import {
  buildReferenceIndex,
  CitationContext,
  referenceSectionIds,
  type CitationLinks,
  type ReferenceEntry,
} from "@/bilingual/reflow/citations";
import { MathText } from "@/bilingual/reflow/MathText";
import { RecoveredFormula, RecoveredVisual } from "@/bilingual/reflow/Recovered";
import { MinerUBanner } from "@/bilingual/reflow/MinerUBanner";
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
import { profileIdFor } from "@/settings/taskModels";
import { useWorkspaceStore } from "@/stores/workspace";

/** How the column shows the paper. */
type ViewMode = "both" | "target" | "source";

const VIEW_LABELS: ReadonlyArray<{ value: ViewMode; label: string }> = [
  { value: "both", label: "对照" },
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
  1: "text-[0.9375rem]",
  2: "text-[0.875rem]",
  3: "text-[0.8125rem]",
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
  const profileId = useWorkspaceStore((state) => profileIdFor("translate", state));
  const profiles = useWorkspaceStore((state) => state.profiles);
  const documentId = useWorkspaceStore((state) => state.document?.documentId ?? null);
  const formulas = useWorkspaceStore((state) => state.formulas);
  const formulasPlan = useWorkspaceStore((state) => state.formulasPlan);
  const formulasStatus = useWorkspaceStore((state) => state.formulasStatus);

  const [refusal, setRefusal] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>("both");
  const [columnWidth, setColumnWidth] = useState(680);
  /* Reading down hides the controls; any scroll back up brings them back. */
  const [chromeHidden, setChromeHidden] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lastScrollTop = useRef(0);
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
      // The sheet's own 40 px margins come out of it too.
      setColumnWidth(Math.min(680, Math.max(240, container.clientWidth - 32 - 80)));
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(container);
    return () => observer.disconnect();
  }, [onContainerWidthChange, usable]);

  // Tell the page dock (in the PDF workspace) whether to step aside as well.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("reflow-chrome", { detail: { hidden: chromeHidden } }));
  }, [chromeHidden]);
  useEffect(
    () => () => {
      window.dispatchEvent(new CustomEvent("reflow-chrome", { detail: { hidden: false } }));
    },
    [],
  );
  const onScroll = useCallback(() => {
    const container = containerRef.current;
    if (container === null) return;
    const top = container.scrollTop;
    const delta = top - lastScrollTop.current;
    if (Math.abs(delta) < 6) return;
    lastScrollTop.current = top;
    setChromeHidden(delta > 0 && top > 80);
  }, []);

  const attach = useCallback((id: string, element: HTMLElement | null) => {
    if (element === null) itemRefs.current.delete(id);
    else itemRefs.current.set(id, element);
  }, []);

  // The count is of what was meant to be translated. References and the title
  // block are kept in the paper's words on purpose; counting them made a
  // finished reading look two-fifths undone ("86 / 141").
  const notTranslated = useMemo(
    () => (view?.paragraphs ?? []).filter((paragraph) => paragraph.status === "skipped").length,
    [view],
  );
  const toTranslate = Math.max(0, (view?.total_paragraphs ?? 0) - notTranslated);

  // --- citations: `[24]` → its bibliography entry, and the way back -------------
  const referenceIndex = useMemo(() => buildReferenceIndex(usable ? ir : null), [usable, ir]);
  const referenceSections = useMemo(() => referenceSectionIds(ir), [ir]);
  /** Where the reader was before following a citation; `null` when there is nowhere to return to. */
  const [returnTo, setReturnTo] = useState<number | null>(null);
  const jumpToReference = useCallback((entry: ReferenceEntry) => {
    const container = containerRef.current;
    if (container === null) return;
    const target = container.querySelector<HTMLElement>(
      `[data-paragraph-id="${CSS.escape(entry.paragraphId)}"]`,
    );
    if (target === null) return;
    setReturnTo((previous) => previous ?? container.scrollTop);
    target.scrollIntoView({ block: "center" });
    target.classList.remove("reflow-cited");
    // Restart the highlight when the same entry is followed twice in a row.
    void target.offsetWidth;
    target.classList.add("reflow-cited");
  }, []);
  const citationLinks = useMemo<CitationLinks | null>(
    () => (referenceIndex.size > 0 ? { index: referenceIndex, jump: jumpToReference } : null),
    [referenceIndex, jumpToReference],
  );
  const goBack = useCallback(() => {
    const container = containerRef.current;
    if (container !== null && returnTo !== null) container.scrollTop = returnTo;
    setReturnTo(null);
  }, [returnTo]);

  // --- nothing yet --------------------------------------------------------------
  if (!usable) {
    const waiting = status === "loading" && view === null;
    return (
      <div
        className="glass glass-solid m-auto flex max-h-full w-full max-w-[560px] animate-pop flex-col overflow-y-auto rounded-[26px] p-6"
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
            <div className="mt-2">
              <MinerUBanner />
            </div>
            {plan !== null && (
              <p data-testid="bilingual-plan" className="mt-1 text-2xs text-muted-foreground">
                共 {plan.paragraphs} 个段落 · 预计 {plan.batches + (plan.glossary_calls ?? 0)} 次模型请求
                {(plan.glossary_calls ?? 0) > 0 ? "（含 1 次整理术语表）" : ""} · 原文约{" "}
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
                className="mt-1 flex items-start gap-1 text-2xs text-warning dark:text-amber-500"
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
                  ? `将调用 ${plan.batches + (plan.glossary_calls ?? 0)} 次模型请求。译文逐段出现，开头几段几秒内可读，全文可能需要数分钟。`
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
      className="flex min-h-0 flex-1 animate-pane-in flex-col overflow-hidden"
      data-testid="reflow-reader"
    >
      <div
        data-testid="reflow-toolbar"
        data-hidden={chromeHidden ? "true" : undefined}
        className={cn(
          "glass relative z-10 mx-auto mt-1 flex w-full max-w-[760px] shrink-0 select-none flex-wrap items-center gap-2 rounded-full px-4 py-1.5 transition-[transform,opacity,margin] duration-500 ease-glass",
          chromeHidden && "pointer-events-none -mb-11 -translate-y-[130%] opacity-0",
        )}
      >
        <span className="text-xs font-medium">逐段对照</span>
        <span data-testid="bilingual-counts" className="text-2xs text-muted-foreground">
          {view.translated_paragraphs} / {toTranslate} 段已译
          {notTranslated > 0 && (
            <span data-testid="bilingual-kept" title="参考文献与题头信息保持原文，不送去翻译">
              {" "}· {notTranslated} 段保持原文
            </span>
          )}
        </span>
        {view.job?.status === "running" && (
          <span
            data-testid="bilingual-job-progress"
            className="flex items-center gap-1.5 text-2xs text-muted-foreground"
          >
            <span className="glass-track relative h-1.5 w-24 overflow-hidden rounded-full" aria-hidden="true">
              <span
                className="absolute inset-y-0 left-0 rounded-full bg-primary transition-[width] duration-700 ease-out"
                style={{
                  width: `${Math.round((100 * view.job.done_batches) / Math.max(1, view.job.total_batches))}%`,
                }}
              />
            </span>
            {view.job.phase === "terms"
              ? `正在按术语表统一用词（${view.job.restated_paragraphs ?? 0} 段）…`
              : `翻译中 ${view.job.done_batches}/${view.job.total_batches} 批`}
            <button
              type="button"
              data-testid="bilingual-stop"
              onClick={() => void stopBilingual()}
              className="flex items-center gap-0.5 rounded px-1 hover:bg-muted"
            >
              <Square className="h-2.5 w-2.5" aria-hidden="true" />
              停止
            </button>
          </span>
        )}
        {view.job?.status !== "running" && view.resumable === true && (
          <button
            type="button"
            data-testid="bilingual-resume"
            disabled={status === "generating"}
            onClick={() => void generateBilingual()}
            className="rounded-sm bg-primary/10 px-1.5 text-2xs font-medium text-primary hover:bg-primary/15"
          >
            继续翻译剩余段落
          </button>
        )}
        {view.status === "PARTIAL" && view.job?.status !== "running" && (
          <span
            data-testid="bilingual-partial"
            className="rounded-sm bg-amber-100 px-1 text-2xs text-warning dark:bg-amber-900/30 dark:text-amber-300"
          >
            部分段落未翻译
          </span>
        )}
        {documentId !== null && (
          <GlossaryPanel
            documentId={documentId}
            disabled={view.job?.status === "running" || status === "generating"}
            refreshKey={`${view.job?.status ?? "none"}:${view.translated_paragraphs}`}
          />
        )}
        <div className="glass-track ml-auto flex items-center gap-0.5 rounded-full p-[3px]">
          {VIEW_LABELS.map((entry) => (
            <button
              key={entry.value}
              type="button"
              data-testid={`bilingual-view-${entry.value}`}
              aria-pressed={mode === entry.value}
              onClick={() => setMode(entry.value)}
              className={cn(
                "rounded-full px-2.5 py-1 text-2xs transition-[color,background-color,transform] duration-300 ease-spring active:scale-[.92]",
                mode === entry.value
                  ? "bg-[var(--glass-strong)] font-semibold text-foreground shadow-[var(--glass-highlight),0_2px_8px_rgba(20,30,60,.12)]"
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
        onScroll={onScroll}
        className={cn(
          SANS_CLASS,
          "min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 pb-32 pt-4",
        )}
      >
        {/* One sheet of paper, as a reflowed article: the paragraphs are
            separated by space alone, never boxed, so it reads as one text. */}
        <CitationContext.Provider value={citationLinks}>
        <article
          data-testid="reflow-sheet"
          className="mx-auto w-full max-w-[760px] animate-pane-in rounded-md bg-page-surface px-10 pb-16 pt-12 shadow-[0_24px_60px_rgba(18,28,50,.14),0_2px_6px_rgba(18,28,50,.06)]"
        >
        {/* 24 px between pairs, 6 px inside one: the ratio is what makes a
            paragraph and its translation read as one thing rather than two. */}
        <div className={cn(COLUMN_CLASS, "space-y-6")}>
          <MinerUBanner />
          {formulasPlan !== null && !(ir.pipeline_version ?? "").startsWith("mineru") && (
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
                  className={cn(
                    "scroll-mt-4 select-none text-balance tracking-[-0.01em] [font-family:Charter,'Source_Serif_Pro','Iowan_Old_Style',Georgia,serif]",
                    HEADING_CLASS[level],
                  )}
                >
                  {item.title}
                  {item.titleTranslated !== null && item.titleTranslated !== "" && (
                    <span
                      data-testid="reflow-heading-translated"
                      className={cn(
                        SANS_CLASS,
                        "ml-2.5 inline-block align-baseline font-normal tracking-normal text-muted-foreground",
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
              // What MinerU recovered is drawn as itself — LaTeX, cells, the
              // figure's own image — with the page crop one click away.
              const plainCrop = (
                <CropItem
                  crop={{ ...item, caption: null, captionSide: null, footnote: null }}
                  rasterFor={rasterFor}
                  request={request}
                  scale={scale}
                  magnification={magnification}
                  columnWidth={columnWidth}
                  attach={() => undefined}
                />
              );
              if (item.layoutClass === "isolate_formula" && item.latex) {
                return (
                  <div
                    key={item.id}
                    ref={(element) => attach(item.id, element)}
                    data-item-page={item.pageNumber}
                    data-item-y0={item.box[1]}
                  >
                    <RecoveredFormula
                      latex={item.latex}
                      number={item.number ?? item.caption?.text ?? null}
                      crop={plainCrop}
                    />
                  </div>
                );
              }
              if (documentId !== null && (item.html || item.imagePath || item.code !== null)) {
                return (
                  <div
                    key={item.id}
                    ref={(element) => attach(item.id, element)}
                    data-item-page={item.pageNumber}
                    data-item-y0={item.box[1]}
                  >
                    <RecoveredVisual
                      documentId={documentId}
                      layoutClass={item.layoutClass}
                      html={item.html}
                      imagePath={item.imagePath}
                      code={item.code}
                      caption={item.caption?.text ?? null}
                      captionTranslated={item.caption?.translated ?? null}
                      footnote={item.footnote}
                      crop={plainCrop}
                    />
                  </div>
                );
              }

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
                cite={item.sectionId === null || !referenceSections.has(item.sectionId)}
                attach={attach}
                onRetry={() => void generateBilingual()}
              />
            );
          })}
        </div>
        <p
          data-testid="bilingual-disclaimer"
          className="mx-auto mt-14 max-w-[680px] select-none border-t pt-3 text-center text-2xs text-muted-foreground/70"
        >
          逐段对照为针对段落语义的沉浸式翻译，与版面翻译 PDF 的文字排版与用词可能存在细微差异。
        </p>
        </article>
        </CitationContext.Provider>
        {returnTo !== null && (
          <div className="pointer-events-none sticky bottom-4 z-10 mt-4 flex justify-center">
            <button
              type="button"
              data-testid="citation-return"
              onClick={goBack}
              className="glass glass-solid pointer-events-auto flex animate-pop select-none items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium text-foreground"
            >
              <CornerUpLeft className="h-3.5 w-3.5" aria-hidden="true" />
              返回刚才阅读的位置
            </button>
          </div>
        )}
      </div>

    </div>
  );
}

// --- one paragraph and its translation ------------------------------------------

function PairItem({
  pair,
  mode,
  cite,
  attach,
  onRetry,
}: {
  pair: ReflowPair;
  mode: ViewMode;
  /** False in the bibliography, where `[24]` is the entry rather than a pointer to it. */
  cite: boolean;
  attach: (id: string, element: HTMLElement | null) => void;
  onRetry: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const fix = () => {
    setBusy(true);
    setProblem(null);
    void retranslate(pair.paragraphId).then((outcome) => {
      setBusy(false);
      if (!outcome.ok) setProblem(outcome.reason);
    });
  };

  return (
    <div
      ref={(element) => attach(pair.id, element)}
      data-item-page={pair.pageNumber}
      data-item-y0={pair.y0}
      data-testid="reflow-pair"
      data-paragraph-id={pair.paragraphId}
      data-hovered={hovered ? "true" : undefined}
      className={cn(
        "reflow-pair -mx-3 rounded-lg px-3 py-1 transition-colors duration-300",
        hovered && "bg-primary/[.035]",
      )}
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
        <MathText text={pair.sourceText} cite={cite} runs={pair.sourceRuns} />
      </p>

      {pair.status === "translated" && pair.translatedText !== null && (
        <p
          data-testid="reflow-translation"
          className={cn(
            SANS_CLASS,
            "reflow-pair-translation mt-1.5 text-sm leading-[1.8] text-foreground/80",
            mode === "source" && "hidden",
          )}
        >
          <MathText text={pair.translatedText} cite={cite} />
          {/* Always in the tree, so the keyboard reaches it: shown on hover, on
              focus, and while it works. It used to exist only under a mouse. */}
          <button
            type="button"
            data-testid="bilingual-retranslate"
            disabled={busy}
            onClick={fix}
            className={cn(
              "ml-2 inline-flex translate-y-[1px] select-none items-center gap-0.5 rounded px-1 align-baseline text-2xs text-muted-foreground transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              hovered || busy ? "opacity-100" : "opacity-0",
            )}
          >
            {busy ? (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            ) : (
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
            )}
            重译此段
          </button>
          {problem !== null && (
            <span role="alert" data-testid="bilingual-retranslate-error" className="ml-2 select-none text-2xs text-warning">
              {problem}
            </span>
          )}
        </p>
      )}

      {pair.status === "pending" && mode !== "source" && (
        <div data-testid="bilingual-pending" aria-label="正在翻译" className="mt-3 space-y-2">
          <div className="reflow-skeleton h-2.5 w-[94%] rounded" />
          <div className="reflow-skeleton h-2.5 w-[82%] rounded" />
          <div className="reflow-skeleton h-2.5 w-[48%] rounded" />
        </div>
      )}

      {pair.status === "untranslated" && (
        <p className="mt-2 flex select-none items-start gap-1 text-xs text-warning">
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span data-testid="bilingual-gap-badge">
            此段未翻译{pair.note !== "" ? `（${pair.note}）` : ""}
          </span>
          <button type="button" className="underline" disabled={busy} onClick={fix}>
            重译此段
          </button>
          <button type="button" className="underline" onClick={onRetry}>
            重新生成逐段对照
          </button>
          {problem !== null && <span className="text-destructive">{problem}</span>}
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
