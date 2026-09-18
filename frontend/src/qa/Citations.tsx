/**
 * Citation chips and the reference list.
 *
 * A citation is the one thing in this feature that can be *wrong in a way that
 * looks right*, so everything here comes from the backend's resolved metadata:
 * the page, the section and the excerpt are all from the `DocumentIR`, and none
 * of them is parsed out of the answer text. The number a reader sees is a
 * presentation index; the internal `citation_id` never reaches the screen.
 *
 * The two presentations answer different questions. A chip sits inside the
 * sentence it supports and says *which* evidence; a reference card says *what*
 * that evidence is. Detaching the chips into one list at the end would break the
 * claim-to-source association the whole feature rests on, which is why both
 * exist rather than only the tidier one.
 */
import { Quote } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Citation } from "@/qa/parse";

/** Long enough to recognise the passage, short enough not to become a panel. */
const PREVIEW_CHARS = 220;

function bound(text: string, limit = PREVIEW_CHARS): string {
  if (text.length <= limit) return text;
  const window = text.slice(0, limit);
  const cut = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("。"),
    window.lastIndexOf(" "),
  );
  return `${cut > limit / 2 ? window.slice(0, cut + 1) : window}…`;
}

/** What a screen reader hears instead of "button 3". */
export function citationLabel(citation: Citation): string {
  const page = citation.pageNumber === null ? "页码未知" : `第 ${citation.pageNumber} 页`;
  const section = citation.sectionTitle ? `，${citation.sectionTitle}` : "";
  return `引用 ${citation.index}，${page}${section}`;
}

export function CitationChip({
  citation,
  onJump,
}: {
  citation: Citation;
  onJump: (citation: Citation) => void;
}) {
  const chip = (
    <button
      type="button"
      data-testid={`citation-chip-${citation.index}`}
      aria-label={citationLabel(citation)}
      disabled={!citation.jumpable}
      onClick={() => onJump(citation)}
      className={cn(
        "mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-sm px-1 align-baseline text-2xs font-medium tabular-nums transition-colors",
        citation.jumpable
          ? "bg-primary/10 text-primary hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          : "cursor-default bg-muted text-muted-foreground",
      )}
    >
      {citation.index}
    </button>
  );

  if (!citation.jumpable) return chip;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent
        side="top"
        data-testid={`citation-tooltip-${citation.index}`}
        className="max-w-xs space-y-1"
      >
        <p className="text-2xs font-medium">
          第 {citation.pageNumber} 页
          <span className="font-normal text-muted-foreground">
            {citation.sectionTitle ? ` · ${citation.sectionTitle}` : ""}
          </span>
        </p>
        {citation.snippet && (
          <p className="text-2xs leading-relaxed text-muted-foreground">
            {bound(citation.snippet)}
          </p>
        )}
        <p className="text-2xs text-muted-foreground/80">点击跳转至原文对应页面</p>
      </TooltipContent>
    </Tooltip>
  );
}

export function ReferenceCard({
  citation,
  onJump,
}: {
  citation: Citation;
  onJump: (citation: Citation) => void;
}) {
  return (
    <li
      data-testid={`reference-card-${citation.index}`}
      className="rounded border bg-background px-2 py-1.5 text-2xs leading-relaxed"
    >
      <button
        type="button"
        onClick={() => onJump(citation)}
        disabled={!citation.jumpable}
        aria-label={citationLabel(citation)}
        className="w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
      >
        <span className="mr-1 font-medium text-primary tabular-nums">
          [{citation.index}]
        </span>
        <span className="text-muted-foreground">
          第 {citation.pageNumber ?? "?"} 页
          {citation.sectionTitle ? ` · ${citation.sectionTitle}` : ""}
          {citation.isCaption ? " · 图表" : ""}
        </span>
        {citation.snippet && (
          <span className="mt-0.5 flex gap-1 text-foreground/80">
            <Quote className="mt-0.5 h-2.5 w-2.5 shrink-0 text-muted-foreground/60" aria-hidden="true" />
            <span>{bound(citation.snippet, 260)}</span>
          </span>
        )}
      </button>
    </li>
  );
}

/**
 * The reference list under an answer.
 *
 * Ordered as the answer cited them, not by page: a reader checking a specific
 * sentence wants the same order they met the chips in.
 */
export function ReferenceList({
  citations,
  onJump,
}: {
  citations: Citation[];
  onJump: (citation: Citation) => void;
}) {
  if (citations.length === 0) return null;

  return (
    <section data-testid="reference-list" aria-label="参考来源" className="mt-2">
      <h4 className="mb-1 text-2xs font-medium text-muted-foreground">
        参考来源（{citations.length}）
      </h4>
      <ul className="space-y-1">
        {citations.map((citation) => (
          <ReferenceCard key={citation.id} citation={citation} onJump={onJump} />
        ))}
      </ul>
    </section>
  );
}
