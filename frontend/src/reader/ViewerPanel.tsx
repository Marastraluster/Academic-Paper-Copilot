import { cn } from "@/lib/utils";

/**
 * A placeholder "page" that reads as an academic paper:
 * title block, abstract, two-column body, an inline formula, and a figure.
 *
 * Both viewers render the identical structure so the two panes line up
 * row-for-row in bilingual mode — the panes are compared side by side, so any
 * structural drift between them looks like a rendering bug.
 *
 * Text is represented by bars, never by invented words: this is a placeholder,
 * and fabricating body text would misrepresent it as real content.
 */

/** Fixed widths (percent) so both panes are byte-identical in layout. */
const ABSTRACT_WIDTHS = [100, 96, 99, 62];
const COL_A_WIDTHS = [100, 94, 99, 71, 100, 88, 96, 64, 100, 92];
const COL_B_WIDTHS = [98, 100, 89, 95, 68, 100, 91, 97, 73, 100];
/** Reference entries sit in a single column and are indented-ish. */
const REFERENCE_WIDTHS = [88, 76, 91, 68, 84, 72, 90];

function TextLine({ width, tone = "body" }: { width: number; tone?: "body" | "head" }) {
  return (
    <div
      className={cn(
        "rounded-sm",
        // Tuned so the bars survive being viewed on a white page: /12 (the
        // first attempt) was effectively invisible.
        tone === "head" ? "bg-muted-foreground/45" : "bg-muted-foreground/25",
      )}
      style={{ height: tone === "head" ? 7 : 5, width: `${width}%` }}
    />
  );
}

function PageSurface({ label }: { label: string }) {
  return (
    <div
      aria-hidden="true"
      data-testid="page-surface"
      className="mx-auto flex w-full max-w-[42rem] flex-col gap-3 rounded-sm border bg-page-surface px-7 py-6 shadow-sm"
    >
      {/* Title block */}
      <div className="flex flex-col items-center gap-2 pb-1">
        <TextLine width={62} tone="head" />
        <TextLine width={40} tone="head" />
        <TextLine width={28} />
      </div>

      <div className="h-px w-full bg-border" />

      {/* Abstract */}
      <div className="flex flex-col gap-1.5 px-4">
        {ABSTRACT_WIDTHS.map((w, i) => (
          <TextLine key={i} width={w} />
        ))}
      </div>

      {/* Two-column body */}
      <div className="grid grid-cols-2 gap-5 pt-1">
        <div className="flex flex-col gap-1.5">
          {COL_A_WIDTHS.map((w, i) => (
            <TextLine key={i} width={w} />
          ))}
        </div>
        <div className="flex flex-col gap-1.5">
          {COL_B_WIDTHS.map((w, i) => (
            <TextLine key={i} width={w} />
          ))}
        </div>
      </div>

      {/* Inline formula */}
      <div className="mx-10 flex justify-center rounded-sm border border-dashed py-3">
        <span className="font-mono text-2xs text-muted-foreground/70">
          ƒ(x) = Σᵢ θᵢ φᵢ(x)
        </span>
      </div>

      {/* Figure */}
      <div className="flex flex-col gap-1.5">
        <div className="flex h-28 items-center justify-center rounded-sm border border-dashed bg-muted/50">
          <span className="text-2xs text-muted-foreground/60">{label}</span>
        </div>
        <TextLine width={54} />
      </div>

      {/* Continuing body, so the viewer genuinely scrolls (AC-29) */}
      <div className="grid grid-cols-2 gap-5 pt-2">
        <div className="flex flex-col gap-1.5">
          {COL_B_WIDTHS.map((w, i) => (
            <TextLine key={i} width={w} />
          ))}
        </div>
        <div className="flex flex-col gap-1.5">
          {COL_A_WIDTHS.map((w, i) => (
            <TextLine key={i} width={w} />
          ))}
        </div>
      </div>

      {/* Section heading + body */}
      <div className="flex flex-col gap-1.5 pt-2">
        <TextLine width={34} tone="head" />
        <div className="grid grid-cols-2 gap-5 pt-1">
          <div className="flex flex-col gap-1.5">
            {COL_A_WIDTHS.slice(0, 6).map((w, i) => (
              <TextLine key={i} width={w} />
            ))}
          </div>
          <div className="flex flex-col gap-1.5">
            {COL_B_WIDTHS.slice(0, 6).map((w, i) => (
              <TextLine key={i} width={w} />
            ))}
          </div>
        </div>
      </div>

      {/* References */}
      <div className="flex flex-col gap-1.5 pt-2">
        <TextLine width={20} tone="head" />
        {REFERENCE_WIDTHS.map((w, i) => (
          <TextLine key={i} width={w} />
        ))}
      </div>
    </div>
  );
}

interface ViewerPanelProps {
  title: string;
  /** Caption shown inside the figure placeholder, e.g. "Figure 1". */
  figureLabel: string;
  testId: string;
}

/**
 * AC-07 — a placeholder viewer surface.
 * Deliberately does not load PDF.js or touch PDF bytes; that is Phase 9.
 * Scrolling is internal to this element (AC-29).
 */
export function ViewerPanel({ title, figureLabel, testId }: ViewerPanelProps) {
  return (
    <section
      aria-label={title}
      data-testid={testId}
      className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-md border bg-workspace"
    >
      <div className="flex h-8 shrink-0 items-center gap-2 border-b bg-card px-2.5">
        <span className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
          {title}
        </span>
        <span className="ml-auto text-2xs text-muted-foreground/70">
          占位视图
        </span>
      </div>

      {/* Scroll container: internal only (AC-29) */}
      <div
        data-testid="viewer-scroll"
        className="min-h-0 flex-1 overflow-y-auto p-3"
      >
        <PageSurface label={figureLabel} />
      </div>
    </section>
  );
}
