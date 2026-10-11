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
    { value: "immersive", label: "逐段", title: "原文一段、译文一段，逐段对照" },
    { value: "original", label: "原文", title: "只显示原文 PDF" },
    { value: "translation", label: "译文", title: "版面翻译后的 PDF（pdf2zh，可选）" },
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

  const activeIndex = MODES.findIndex((mode) => mode.value === effectiveMode);

  return (
    <div
      role="tablist"
      aria-label="阅读模式"
      className="glass-track relative inline-flex shrink-0 items-center rounded-full p-[3px]"
    >
      {/* The glass thumb slides — with a little overshoot — to the active mode. */}
      {activeIndex >= 0 && (
        <span
          aria-hidden="true"
          data-testid="reader-mode-thumb"
          className="glass-thumb absolute left-[3px] top-[3px] h-8 w-[60px] rounded-full"
          style={{ transform: `translateX(${activeIndex * 60}px)` }}
        />
      )}
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
              "relative z-[1] h-8 w-[60px] rounded-full text-[13px] transition-[color,transform] duration-300 ease-spring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[.92]",
              active
                ? "font-semibold text-foreground"
                : "font-medium text-muted-foreground hover:text-foreground",
              locked && "cursor-not-allowed opacity-40 hover:text-muted-foreground active:scale-100",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
