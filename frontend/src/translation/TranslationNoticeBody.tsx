import { Info, Loader2, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { selectActiveTranslation, useWorkspaceStore } from "@/stores/workspace";
import { useTranslationSession } from "@/translation/useTranslationSession";

/**
 * The translation's own status line, above the reader panes.
 *
 * Deliberately a banner rather than a modal or an overlay: the product's premise
 * is that reading continues while a translation runs, so nothing here may cover
 * the document or take focus. It renders only when there is something to say —
 * success in particular is silent, because the mode switch unlocking is a better
 * signal than a banner that never goes away.
 *
 * Split from `TranslationNotice` so its markup, its buttons and its icons are not
 * in the download for every reader who never translates. The wrapper decides
 * whether there is anything to say; this module is what says it.
 */
export function TranslationNoticeBody() {
  const translation = useWorkspaceStore(selectActiveTranslation);
  const document = useWorkspaceStore((s) => s.document);
  const { retranslate, cancel, busy } = useTranslationSession();

  if (!translation || translation.status === "idle") return null;

  if (translation.status === "failed") {
    const error = translation.error;
    return (
      <div
        data-testid="translation-error"
        role="alert"
        className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs"
      >
        <TriangleAlert
          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-destructive">{error?.title ?? "翻译失败"}</p>
          <p className="mt-0.5 text-muted-foreground">
            {error?.detail ?? "可重新发起翻译。"}
            {error?.code ? (
              <span className="ml-1 text-muted-foreground/70">（{error.code}）</span>
            ) : null}
          </p>
        </div>
        {/* Offered only when re-running could plausibly help. A retry button
            against a rejected API key produces the same failure twice. */}
        {error?.retryable !== false && (
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            data-testid="translation-retry"
            disabled={busy || !document?.documentId}
            onClick={() => void retranslate()}
          >
            重试
          </Button>
        )}
      </div>
    );
  }

  if (translation.status === "success") {
    const expected = document?.backendPageCount ?? null;
    const actual = translation.monoPageCount;

    // Silent when everything lines up. The bilingual view maps page i to page i,
    // so a differing count is a real reading hazard and worth interrupting for;
    // agreement is not news.
    if (expected === null || actual === null || expected === actual) return null;

    return (
      <div
        data-testid="translation-page-mismatch"
        role="status"
        className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground"
      >
        <Info className="h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden="true" />
        <span>
          译文页数（{actual}）与原文页数（{expected}）不一致，双语对照的页码可能无法逐页对应。
        </span>
      </div>
    );
  }

  // --- running: honest, including about not knowing --------------------------
  const progress = translation.progress;
  return (
    <div
      data-testid="translation-running"
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-xs text-muted-foreground"
    >
      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
      <span data-testid="translation-progress-label">
        {progress
          ? `正在翻译：第 ${progress.page} / ${progress.pageCount} 页`
          : "正在提交翻译任务…"}
      </span>

      {translation.degraded && (
        <span data-testid="translation-degraded" className="text-amber-600">
          · 实时进度连接已断开，改用轮询
        </span>
      )}

      <Button
        size="sm"
        variant="ghost"
        className="ml-auto shrink-0"
        data-testid="translation-cancel"
        onClick={() => void cancel()}
      >
        取消
      </Button>
    </div>
  );
}

export default TranslationNoticeBody;
