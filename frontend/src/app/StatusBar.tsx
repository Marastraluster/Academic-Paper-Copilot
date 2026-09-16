import { cn } from "@/lib/utils";
import { useWorkspaceStore, type EngineState } from "@/stores/workspace";

const ENGINE_DOT: Record<EngineState, string> = {
  offline: "bg-muted-foreground/50",
  preparing: "bg-amber-500",
  ready: "bg-emerald-600",
  error: "bg-destructive",
};

/**
 * AC-08 — bottom status and progress bar.
 * Height is pinned to 28px (within the required 28–36px) and it spans the full
 * viewport width.
 *
 * The progress figures are placeholder state for this shell task: no
 * translation has run, because the translation backend is Phase 5. The
 * "示例" chip is deliberate — a status bar that claims 72% progress with no
 * engine behind it would be actively misleading.
 */
export function StatusBar() {
  const { label, currentPage, pageCount, percent } = useWorkspaceStore(
    (s) => s.progress,
  );
  const engine = useWorkspaceStore((s) => s.engine);

  return (
    <footer className="flex h-7 shrink-0 items-center gap-3 border-t bg-card px-2.5 text-2xs text-muted-foreground">
      <span className="shrink-0 rounded-sm bg-muted px-1 py-px font-medium">
        示例
      </span>

      <span className="shrink-0" data-testid="status-label">
        {label}
      </span>

      <span className="shrink-0 tabular-nums" data-testid="status-page">
        Page {currentPage} / {pageCount}
      </span>

      {/* Progress indicator */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="翻译进度"
          className="h-1.5 max-w-md min-w-16 flex-1 overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
        <span className="shrink-0 tabular-nums" data-testid="status-percent">
          {percent}%
        </span>
      </div>

      {/* Engine status (AC-08). Honest: no backend is running yet. */}
      <span
        className="flex shrink-0 items-center gap-1.5"
        data-testid="engine-status"
      >
        <span
          className={cn("h-1.5 w-1.5 rounded-full", ENGINE_DOT[engine.state])}
          aria-hidden="true"
        />
        Engine: {engine.label}
      </span>
    </footer>
  );
}
