import { cn } from "@/lib/utils";
import {
  selectEffectiveMode,
  selectHasTranslation,
  useWorkspaceStore,
  type ReaderMode,
} from "@/stores/workspace";

/** AC-03's three labels, plus the paragraph-aligned column (DS-DOC-006). */
const MODES: ReadonlyArray<{ value: ReaderMode; label: string; title: string }> =
  [
    { value: "original", label: "原文", title: "只显示原文" },
    { value: "bilingual", label: "双语", title: "原文与译文左右对照" },
    { value: "translation", label: "译文", title: "只显示译文" },
    { value: "immersive", label: "逐段", title: "原文一段、译文一段，逐段对照" },
  ];

/** The modes that need a translated PDF. `immersive` needs none: it is its own
 *  reading, generated from the paper's paragraphs. */
const NEEDS_A_PDF_TRANSLATION = new Set<ReaderMode>(["bilingual", "translation"]);

const NEEDS_TRANSLATION = "需要先完成一次翻译";

/**
 * AC-04 — the segmented control that drives the workspace layout.
 * This changes real state; it is not a label-only switch (explicit failure F-04).
 *
 * The two translated modes are disabled until a translation exists. In DS-FE-001
 * they were always selectable, because both panes were placeholders and there
 * was nothing to promise. Now that the panes are real, an enabled 译文 that shows
 * an empty box would be a promise the app cannot keep — so the control tells the
 * truth about what is currently possible.
 */
export function ReaderModeSwitch() {
  const setReaderMode = useWorkspaceStore((s) => s.setReaderMode);
  const hasTranslation = useWorkspaceStore(selectHasTranslation);
  const effectiveMode = useWorkspaceStore(selectEffectiveMode);

  return (
    <div
      role="tablist"
      aria-label="阅读模式"
      className="inline-flex shrink-0 items-center gap-0.5 rounded-md border bg-muted/60 p-0.5"
    >
      {MODES.map(({ value, label, title }) => {
        const locked = NEEDS_A_PDF_TRANSLATION.has(value) && !hasTranslation;
        const active = effectiveMode === value;
        return (
          <button
            key={value}
            type="button"
            role="tab"
            title={locked ? NEEDS_TRANSLATION : title}
            aria-selected={active}
            // Disabled rather than merely dimmed: a control that looks inert but
            // still responds is worse than one that plainly cannot be used.
            disabled={locked}
            data-testid={`reader-mode-${value}`}
            data-locked={locked ? "true" : undefined}
            onClick={() => setReaderMode(value)}
            className={cn(
              "rounded px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
              locked && "cursor-not-allowed opacity-40 hover:text-muted-foreground",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
