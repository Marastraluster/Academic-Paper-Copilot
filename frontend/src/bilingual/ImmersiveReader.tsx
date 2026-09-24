/**
 * The paragraph-aligned reading column (逐段对照).
 *
 * The source paragraph stays where the paper put it and its translation follows
 * it, so a reader reads one column instead of two panes. The effect is the one
 * the browser extension 沉浸式翻译 produces on a web page, and the difference is
 * worth stating: there the page's own text is already in the DOM and inserting a
 * translation under it needs no alignment. Here the paper is a PDF and the pairs
 * had to be *made* — translated paragraph by paragraph, one output per input id,
 * cached by content hash — because text extracted from the translated PDF is
 * reflowed fragments and a pair built from those is wrong in a way that reads as
 * checked.
 *
 * ## What the column refuses to do
 *
 * A paragraph that has no translation says so, in place, with the reason. It is
 * never filled with a guess, and it is never quietly dropped: a reading with a
 * gap the reader can see is worth more than one that hides it.
 *
 * The whole module is behind a dynamic import — a reader who never opens this
 * view never downloads it, and the initial chunk has less than a kilobyte of
 * headroom under its ceiling.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Sparkles, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  BilingualBlockView,
  BilingualParagraphView,
  BilingualSectionView,
  BilingualView,
} from "@/api/bilingual";
import { bilingualIsCurrent, generateBilingual, loadBilingual } from "@/bilingual/session";
import { useWorkspaceStore } from "@/stores/workspace";

/** How the column shows the paper. Both languages, or one of them. */
type ViewMode = "both" | "target" | "source";

const VIEW_LABELS: ReadonlyArray<{ value: ViewMode; label: string }> = [
  { value: "both", label: "双语" },
  { value: "target", label: "仅译文" },
  { value: "source", label: "仅原文" },
];

/** What each non-prose unit is called, when it is shown in the flow. */
const BLOCK_LABEL: Record<string, string> = {
  isolate_formula: "公式",
  figure_caption: "图说明",
  table_caption: "表说明",
  formula_caption: "公式说明",
};

type Unit =
  | { kind: "section"; section: BilingualSectionView }
  | { kind: "paragraph"; paragraph: BilingualParagraphView }
  | { kind: "block"; block: BilingualBlockView };

/**
 * The reading order of the column: headings, paragraphs and the non-prose units
 * between them.
 *
 * Built by walking the artifact's paragraphs — which the backend emits in the
 * extraction's own reading order — and slipping in whatever non-prose unit sits
 * before each one. The position of a unit is its first block's place on its page,
 * which the IR already established; nothing here re-derives reading order, and a
 * page whose blocks are unknown simply puts the unit after the prose.
 */
function buildUnits(
  view: BilingualView,
  blockOrder: Map<string, number>,
): Unit[] {
  const blocks = [...view.blocks].sort((left, right) => {
    const leftKey = left.page_number * 10_000 + (blockOrder.get(left.block_id) ?? 9_999);
    const rightKey = right.page_number * 10_000 + (blockOrder.get(right.block_id) ?? 9_999);
    return leftKey - rightKey;
  });

  const units: Unit[] = [];
  let nextBlock = 0;
  let currentSection: string | null | undefined;

  const flushBlocksUpTo = (page: number, position: number) => {
    while (nextBlock < blocks.length) {
      const block = blocks[nextBlock]!;
      const at = block.page_number * 10_000 + (blockOrder.get(block.block_id) ?? 9_999);
      if (at > page * 10_000 + position) return;
      units.push({ kind: "block", block });
      nextBlock += 1;
    }
  };

  for (const paragraph of view.paragraphs) {
    const first = paragraph.bboxes.length > 0 ? 0 : 9_999;
    flushBlocksUpTo(paragraph.page_number, first);
    if (paragraph.section_id !== currentSection) {
      currentSection = paragraph.section_id;
      const section = view.sections.find((item) => item.section_id === currentSection);
      if (section) units.push({ kind: "section", section });
    }
    units.push({ kind: "paragraph", paragraph });
  }
  while (nextBlock < blocks.length) {
    units.push({ kind: "block", block: blocks[nextBlock]! });
    nextBlock += 1;
  }
  return units;
}

function pageLabel(pageNumber: number): string {
  return `P. ${pageNumber}`;
}

export function ImmersiveReader() {
  const document_ = useWorkspaceStore((s) => s.document);
  const ir = useWorkspaceStore((s) => s.ir);
  const view = useWorkspaceStore((s) => s.bilingual);
  const plan = useWorkspaceStore((s) => s.bilingualPlan);
  const status = useWorkspaceStore((s) => s.bilingualStatus);
  const error = useWorkspaceStore((s) => s.bilingualError);
  const startedAt = useWorkspaceStore((s) => s.bilingualStartedAt);
  const profileId = useWorkspaceStore((s) => s.profileId);
  const documentId = document_?.documentId ?? null;

  const [mode, setMode] = useState<ViewMode>("both");
  const [hovered, setHovered] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const ready = document_?.registration === "ready";

  // Read the stored reading when the column opens. A read: it cannot reach a
  // provider, and it is the only request this view makes on its own.
  useEffect(() => {
    if (ready && documentId !== null) void loadBilingual();
  }, [ready, documentId]);

  const usable =
    view !== null && view !== undefined && documentId !== null && ir !== null &&
    bilingualIsCurrent(view, ir.content_hash);

  const blockOrder = useMemo(() => {
    const order = new Map<string, number>();
    for (const page of ir?.pages ?? []) {
      (page.blocks ?? []).forEach((block, index) => order.set(block.id, index));
    }
    return order;
  }, [ir]);

  const units = useMemo(
    () => (usable && view ? buildUnits(view, blockOrder) : []),
    [usable, view, blockOrder],
  );

  const jump = useCallback((pageNumber: number, bboxes: number[][]) => {
    // The same jump the citation and section paths use, and it moves the reader
    // to the PDF: the column is a reading of the paper, not a replacement for it.
    useWorkspaceStore.getState().setReaderMode("original");
    useWorkspaceStore.getState().requestJump(pageNumber, bboxes, bboxes[0]?.[1]);
  }, []);

  if (!ready) {
    return (
      <p data-testid="bilingual-empty-state" className="p-3 text-xs text-muted-foreground">
        请先打开一篇论文。
      </p>
    );
  }

  if (status === "loading" && view === null) {
    return (
      <p data-testid="bilingual-loading" className="p-3 text-xs text-muted-foreground">
        正在载入逐段对照…
      </p>
    );
  }

  if (!usable) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3" data-testid="bilingual-panel">
        <h2 className="flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />
          逐段对照
        </h2>
        <p data-testid="bilingual-not-generated" className="mt-2 text-xs text-muted-foreground">
          这篇论文还没有逐段对照。生成后，每个段落下方会直接给出它的译文。
        </p>
        {plan !== null && (
          <p data-testid="bilingual-plan" className="mt-1 text-2xs text-muted-foreground">
            共 {plan.paragraphs} 个段落 · 预计 {plan.batches} 次模型请求 · 原文约{" "}
            {plan.characters.toLocaleString()} 字符
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
          className="mt-2 w-fit"
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
        {/* Stated before the reader presses it, not after. This is the only
            control here that spends their money, and the call count is computed
            from the paper rather than guessed. */}
        <p className="mt-1 text-2xs text-muted-foreground/80">
          {status === "generating"
            ? `正在翻译（已用时 ${Math.floor(((startedAt ? Date.now() - startedAt : 0)) / 1000)} 秒）…`
            : plan !== null
              ? `将调用 ${plan.batches} 次模型请求，可能耗时数分钟。`
              : "将调用若干次模型请求，可能耗时数分钟。"}
        </p>
        {profileId === "" && (
          <p className="mt-1 text-2xs text-muted-foreground/80">请先在设置中配置模型服务。</p>
        )}
      </div>
    );
  }

  const shown = view!;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border bg-background"
      data-testid="bilingual-panel"
    >
      {/* ---- header: what this is, and whose reading it is ---- */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-3 py-1.5">
        <span className="text-xs font-medium">逐段对照</span>
        <span data-testid="bilingual-counts" className="text-2xs text-muted-foreground">
          {shown.translated_paragraphs} / {shown.total_paragraphs} 段已译
        </span>
        {shown.status === "PARTIAL" && (
          <span
            data-testid="bilingual-partial"
            className="rounded-sm bg-amber-100 px-1 text-2xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
          >
            部分段落未翻译
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5 rounded-md border bg-muted/60 p-0.5">
          {VIEW_LABELS.map((option) => (
            <button
              key={option.value}
              type="button"
              data-testid={`bilingual-view-${option.value}`}
              aria-pressed={mode === option.value}
              onClick={() => setMode(option.value)}
              className={cn(
                "rounded px-2 py-0.5 text-2xs",
                mode === option.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {/* ---- the column ---- */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {units.map((unit, index) => {
          if (unit.kind === "section") {
            const section = unit.section;
            return (
              <div
                key={`s-${section.section_id}-${index}`}
                data-testid={`bilingual-section-${section.section_id}`}
                data-level={section.level ?? 1}
                className={cn(
                  "mt-3 border-b pb-0.5 first:mt-0",
                  (section.level ?? 1) <= 1 ? "text-sm font-semibold" : "text-xs font-medium",
                )}
              >
                {/* select-none: chrome must not end up in a copied paragraph. */}
                <span className="select-none">
                  <button
                    type="button"
                    data-testid="bilingual-jump-pdf"
                    onClick={() => jump(section.page_number, [])}
                    className="mr-1 text-2xs text-primary hover:underline"
                  >
                    {pageLabel(section.page_number)}
                  </button>
                </span>
                <span>{section.title}</span>
                {section.title_translated && (
                  <span className="ml-1 text-muted-foreground">{section.title_translated}</span>
                )}
                {section.is_references && (
                  <span className="ml-1 text-2xs text-muted-foreground">（参考文献不予翻译）</span>
                )}
              </div>
            );
          }

          if (unit.kind === "block") {
            const block = unit.block;
            return (
              <div
                key={`b-${block.block_id}`}
                data-testid={`bilingual-block-${block.layout_class}`}
                className="my-1.5 rounded-sm bg-muted/40 px-2 py-1 text-2xs text-muted-foreground"
              >
                <span className="select-none">[{BLOCK_LABEL[block.layout_class] ?? "原文"}] </span>
                <span className="whitespace-pre-wrap italic">{block.text}</span>
              </div>
            );
          }

          const paragraph = unit.paragraph;
          const isHovered = hovered === paragraph.paragraph_id;
          return (
            <div
              key={paragraph.paragraph_id}
              data-testid="bilingual-pair"
              data-hovered={isHovered ? "true" : undefined}
              className={cn(
                "my-1.5 rounded-sm border-l-2 py-1 pl-2 transition-colors",
                isHovered ? "border-primary bg-primary/5" : "border-transparent",
              )}
              onMouseEnter={() => setHovered(paragraph.paragraph_id)}
              onMouseLeave={() => setHovered((current) =>
                current === paragraph.paragraph_id ? null : current,
              )}
            >
              {mode !== "target" && (
                <p
                  data-testid="bilingual-source-p"
                  className="whitespace-pre-wrap text-xs leading-relaxed text-foreground"
                >
                  {paragraph.source_text}
                </p>
              )}
              {mode !== "source" && paragraph.status === "translated" && (
                <p
                  data-testid="bilingual-target-p"
                  className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-foreground/80"
                >
                  {paragraph.translated_text}
                </p>
              )}
              {mode !== "source" && paragraph.status !== "translated" && (
                <p className="mt-1 text-2xs text-muted-foreground" data-testid="bilingual-missing">
                  {paragraph.status === "skipped" ? "未翻译" : "此段未翻译"}
                  {paragraph.note ? ` · ${paragraph.note}` : ""}
                </p>
              )}
              {/* Chrome, and marked as such: a selection dragged across a pair
                  copies the prose and nothing else. */}
              <span className="mt-0.5 flex select-none items-center gap-1 text-2xs text-muted-foreground/70">
                <button
                  type="button"
                  data-testid="bilingual-jump-pdf"
                  onClick={() => jump(paragraph.page_number, paragraph.bboxes)}
                  className="text-primary hover:underline"
                >
                  {pageLabel(paragraph.page_number)}
                </button>
                {paragraph.status !== "translated" && <span>· 未翻译</span>}
              </span>
            </div>
          );
        })}

        <p
          data-testid="bilingual-disclaimer"
          className="mt-4 border-t pt-2 text-2xs text-muted-foreground/80"
        >
          逐段对照为针对段落语义的沉浸式翻译，与版面翻译 PDF 的文字排版与用词可能存在细微差异。
          {shown.provider_model ? `（由 ${shown.provider_model} 生成` : "（"}
          {shown.cached ? "，已缓存）" : "）"}
        </p>
      </div>
    </div>
  );
}

export default ImmersiveReader;
