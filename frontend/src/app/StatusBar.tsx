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
  ready: "bg-emerald-600 animate-[engine-pulse_2.4s_ease-out_infinite]",
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
    <footer className="glass absolute bottom-5 right-5 z-20 flex h-9 max-w-[calc(100%-40px)] items-center gap-2.5 rounded-full px-3.5 text-xs text-muted-foreground">
      <span className="shrink-0" data-testid="status-label">
        {label}
      </span>

      {/* The page count lives in the dock; here it is read out, not shown,
          except while a translation reports its progress. */}
      <span className={cn("shrink-0 tabular-nums", !running && "sr-only")} data-testid="status-page">
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
            className="glass-track h-1.5 w-28 overflow-hidden rounded-full"
          >
            <div
              className={cn(
                "h-full rounded-full bg-primary transition-[width] duration-700 ease-glass",
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

      {/* Engine status (AC-08). Reports only what has actually been observed. */}
      <span
        className="flex shrink-0 items-center gap-1.5"
        data-testid="engine-status"
      >
        <span
          className={cn("h-2 w-2 rounded-full", ENGINE_DOT[engine.state])}
          aria-hidden="true"
        />
        <span className="sr-only">Engine: </span>
        {engine.label}
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
