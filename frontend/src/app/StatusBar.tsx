import { cn } from "@/lib/utils";
import {
  selectActiveTranslation,
  useWorkspaceStore,
  type EngineState,
  type TranslationStatus,
} from "@/stores/workspace";

const ENGINE_DOT: Record<EngineState, string> = {
  offline: "bg-muted-foreground/50",
  connecting: "bg-amber-500",
  ready: "bg-emerald-600",
  error: "bg-destructive",
};

/**
 * AC-08 — bottom status and progress bar.
 * Height is pinned to 28px (within the required 28–36px) and it spans the full
 * viewport width.
 *
 * Everything here is measured, not decorative. DS-FE-001 shipped this bar with
 * placeholder figures (`Page 5 / 18`, `72%`) and a `示例` chip admitting they were
 * invented. They are gone. The bar now reports what the backend actually said,
 * and when the backend has said nothing yet it says nothing rather than
 * guessing: an indeterminate bar is honest, a fabricated percentage is not.
 *
 * Concretely: percentage and page count appear only when a real per-page reading
 * exists, and the progress bar itself exists only while a translation is running.
 */
export function StatusBar() {
  const document = useWorkspaceStore((s) => s.document);
  const translation = useWorkspaceStore(selectActiveTranslation);
  const engine = useWorkspaceStore((s) => s.engine);

  const running =
    translation?.status === "submitting" || translation?.status === "translating";
  const progress = running ? translation?.progress ?? null : null;

  const percent = progress ? Math.round((progress.page / progress.pageCount) * 100) : null;

  const label = describeLabel(document !== null, translation?.status ?? null);

  return (
    <footer className="flex h-7 shrink-0 items-center gap-3 border-t bg-card px-2.5 text-2xs text-muted-foreground">
      <span className="shrink-0" data-testid="status-label">
        {label}
      </span>

      <span className="shrink-0 tabular-nums" data-testid="status-page">
        {progress ? `Page ${progress.page} / ${progress.pageCount}` : "Page — / —"}
      </span>

      {/* Progress indicator — only while there is progress to indicate. */}
      {running && (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div
            role="progressbar"
            aria-label="翻译进度"
            // An indeterminate bar carries no aria-valuenow: assistive technology
            // then reports "busy" rather than a number nobody measured.
            aria-valuenow={percent ?? undefined}
            aria-valuemin={percent === null ? undefined : 0}
            aria-valuemax={percent === null ? undefined : 100}
            className="h-1.5 max-w-md min-w-16 flex-1 overflow-hidden rounded-full bg-muted"
          >
            <div
              className={cn(
                "h-full rounded-full bg-primary transition-[width] duration-300",
                percent === null && "w-1/3 animate-pulse",
              )}
              style={percent === null ? undefined : { width: `${percent}%` }}
            />
          </div>
          <span className="shrink-0 tabular-nums" data-testid="status-percent">
            {percent === null ? "…" : `${percent}%`}
          </span>
        </div>
      )}

      {!running && <span className="min-w-0 flex-1" />}

      {/* Engine status (AC-08). Reports only what has actually been observed. */}
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

function describeLabel(hasDocument: boolean, status: TranslationStatus | null): string {
  if (!hasDocument) return "未打开文档";
  switch (status) {
    case "submitting":
      return "正在提交翻译…";
    case "translating":
      return "正在翻译…";
    case "success":
      return "翻译完成";
    case "failed":
      return "翻译失败";
    default:
      // No translation has been requested for this document.
      return "就绪";
  }
}
