import { cn } from "@/lib/utils";
import { useWorkspaceStore, type ReaderMode } from "@/stores/workspace";

/** AC-03: exactly these three labels, in this order. */
const MODES: ReadonlyArray<{ value: ReaderMode; label: string; title: string }> =
  [
    { value: "original", label: "原文", title: "只显示原文" },
    { value: "bilingual", label: "双语", title: "原文与译文左右对照" },
    { value: "translation", label: "译文", title: "只显示译文" },
  ];

/**
 * AC-04 — the segmented control that drives the workspace layout.
 * This changes real state; it is not a label-only switch (explicit failure F-04).
 */
export function ReaderModeSwitch() {
  const readerMode = useWorkspaceStore((s) => s.readerMode);
  const setReaderMode = useWorkspaceStore((s) => s.setReaderMode);

  return (
    <div
      role="tablist"
      aria-label="阅读模式"
      className="inline-flex shrink-0 items-center gap-0.5 rounded-md border bg-muted/60 p-0.5"
    >
      {MODES.map(({ value, label, title }) => {
        const active = readerMode === value;
        return (
          <button
            key={value}
            type="button"
            role="tab"
            title={title}
            aria-selected={active}
            data-testid={`reader-mode-${value}`}
            onClick={() => setReaderMode(value)}
            className={cn(
              "rounded px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
