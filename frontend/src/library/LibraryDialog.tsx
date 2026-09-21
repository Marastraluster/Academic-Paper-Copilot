/**
 * The papers this application has registered, and what is known about each.
 *
 * ## Why a screen was needed at all
 *
 * Opening a paper used to mean handing over a file again. Everything downstream
 * was already content-addressed — the notes, the overview cache, the translated
 * artifact — but nothing in the application showed the reader that those papers
 * still existed, so "I had this open yesterday" meant finding the PDF on disk.
 *
 * ## What a row is honest about
 *
 * Two facts, kept apart because they can differ: **the artifact** (is there a
 * translated PDF on disk) and **the record** (the last translation run that
 * succeeded — language pair, engine, when). Nothing here reports which model
 * produced an artifact: a profile can be edited afterwards, and a row claiming
 * its current model would be describing a run that may not have used it. Nothing
 * reports tokens or latency either, because nothing recorded them (DS-DOC-005
 * §2.5).
 *
 * ## Deleting
 *
 * Removes the row and the artifacts derived from it. It does **not** remove the
 * reader's notes or the cached overview — those are keyed to the bytes, not to
 * the row — so the confirmation says so rather than letting them find out by
 * re-importing the file and discovering their notes never left.
 *
 * The whole module is behind a dynamic import: there are 40 bytes of bundle
 * headroom, and a list nobody has opened should not be in the first download.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileText, FolderOpen, Loader2, Search, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { deleteDocument, listDocuments, type DocumentSummary } from "@/api/documents";
import type { RestoreOutcome } from "@/session/restore";
import { useWorkspaceStore } from "@/stores/workspace";
import { describeApiError } from "@/translation/errors";

/** `YYYY-MM-DD HH:mm` in the reader's own timezone, and never a locale guess. */
function when(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}`
  );
}

export interface LibraryDialogProps {
  open: boolean;
  onClose: () => void;
  /** Text already typed into the top bar's search field, if any. */
  initialQuery?: string;
}

export function LibraryDialog({ open, onClose, initialQuery = "" }: LibraryDialogProps) {
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);
  const [query, setQuery] = useState(initialQuery);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const currentId = useWorkspaceStore((s) => s.document?.documentId ?? null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<Element | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const rows = await listDocuments({ signal });
      setDocuments(rows);
      setError(null);
    } catch (caught) {
      if ((caught as { name?: string })?.name === "AbortError") return;
      setDocuments([]);
      setError(describeApiError(caught).detail);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setDocuments(null);
    setConfirming(null);
    setQuery(initialQuery);
    void load(controller.signal);
    return () => controller.abort();
  }, [open, initialQuery, load]);

  // Escape closes; Tab cycles inside; focus returns to whatever opened this.
  // The same contract every dialog in this shell keeps.
  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const previous = restoreFocusRef.current;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [open, onClose]);

  const visible = useMemo(() => {
    if (documents === null) return null;
    const needle = query.trim().toLowerCase();
    if (needle === "") return documents;
    return documents.filter((row) => row.name.toLowerCase().includes(needle));
  }, [documents, query]);

  const openPaper = useCallback(async (row: DocumentSummary) => {
    setBusyId(row.document_id);
    setError(null);
    try {
      // Through the module that owns "open a document", not the adoption path
      // directly: switching papers has to tear the previous one down, including
      // revoking its translation's object URL.
      const { openRegisteredDocument } = await import("@/translation/session");
      const outcome: RestoreOutcome = await openRegisteredDocument(row.document_id, row.name);
      if (outcome === "restored") {
        onClose();
        return;
      }
      // Everything else has already said what happened, in the workspace.
      if (outcome === "superseded") onClose();
    } catch (caught) {
      setError(describeApiError(caught).detail);
    } finally {
      setBusyId(null);
    }
  }, [onClose]);

  const remove = useCallback(async (row: DocumentSummary) => {
    setBusyId(row.document_id);
    setError(null);
    try {
      await deleteDocument(row.document_id);
      setConfirming(null);
      if (currentId === row.document_id) {
        // The paper on screen no longer exists. The workspace goes back to its
        // empty state through the same path closing a document always takes.
        const { closeDocument } = await import("@/translation/session");
        closeDocument();
      }
      await load();
    } catch (caught) {
      setError(describeApiError(caught).detail);
    } finally {
      setBusyId(null);
    }
  }, [currentId, load]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="library-dialog-title"
        data-testid="library-dialog"
        className="flex max-h-[85vh] w-full max-w-lg flex-col gap-2 rounded-lg border bg-card p-4 shadow-lg"
      >
        <div className="flex items-center justify-between">
          <h2 id="library-dialog-title" className="flex items-center gap-1.5 text-sm font-semibold">
            <FolderOpen className="h-4 w-4 text-primary" aria-hidden="true" />
            论文库
          </h2>
          <Button size="icon-sm" variant="ghost" aria-label="关闭" onClick={onClose}>
            <X />
          </Button>
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input
            type="search"
            data-testid="library-search-input"
            placeholder="搜索论文…"
            aria-label="搜索论文"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-7 w-full rounded-md border bg-background pl-7 pr-2 text-xs"
          />
        </div>

        {visible === null ? (
          <p data-testid="library-loading" className="px-1 py-4 text-2xs text-muted-foreground">
            正在载入…
          </p>
        ) : documents !== null && documents.length === 0 ? (
          <p data-testid="library-empty" className="px-1 py-4 text-2xs text-muted-foreground">
            还没有打开过任何论文。拖入一个 PDF 就会出现在这里。
          </p>
        ) : visible.length === 0 ? (
          <p data-testid="library-no-match" className="px-1 py-4 text-2xs text-muted-foreground">
            没有匹配「{query}」的论文。
          </p>
        ) : (
          <ul data-testid="library-list" className="min-h-0 flex-1 space-y-1 overflow-y-auto">
            {visible.map((row) => {
              const record = row.translation_record ?? null;
              const isCurrent = row.document_id === currentId;
              return (
                <li
                  key={row.document_id}
                  data-testid={`library-row-${row.document_id}`}
                  data-current={isCurrent}
                  className={cn(
                    "rounded-sm border px-2 py-1.5",
                    isCurrent ? "border-primary/40 bg-primary/5" : "border-transparent bg-accent/30",
                  )}
                >
                  <div className="flex items-start gap-2">
                    <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium" title={row.name}>{row.name}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-1 text-2xs text-muted-foreground">
                        <span>{row.page_count} 页</span>
                        {row.source === "path" ? (
                          <span
                            data-testid="library-source-path"
                            title="本地路径关联文件，删除记录不会删除本地源文件"
                          >
                            · 本地路径
                          </span>
                        ) : (
                          <span data-testid="library-source-upload">· 上传</span>
                        )}
                        <span>· {when(row.created_at)}</span>
                      </p>
                      <p className="mt-1 flex flex-wrap items-center gap-1 text-2xs">
                        {row.has_translation ? (
                          <span
                            data-testid="library-translated"
                            className="rounded-sm bg-emerald-100 px-1 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
                          >
                            已翻译
                          </span>
                        ) : (
                          <span data-testid="library-untranslated" className="text-muted-foreground">
                            未翻译
                          </span>
                        )}
                        {record !== null && (
                          <span data-testid="library-record" className="text-muted-foreground">
                            {record.lang_in} → {record.lang_out} · {record.engine} · {when(record.translated_at)}
                          </span>
                        )}
                        {isCurrent && (
                          <span data-testid="library-current" className="rounded-sm bg-primary/15 px-1 text-primary">
                            正在阅读
                          </span>
                        )}
                      </p>
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        size="sm"
                        variant={isCurrent ? "ghost" : "outline"}
                        data-testid={`library-open-${row.document_id}`}
                        disabled={isCurrent || busyId === row.document_id}
                        onClick={() => void openPaper(row)}
                      >
                        {busyId === row.document_id && (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                        )}
                        打开
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="删除"
                        data-testid={`library-delete-${row.document_id}`}
                        disabled={busyId === row.document_id}
                        onClick={() => setConfirming(row.document_id)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </div>

                  {confirming === row.document_id && (
                    <div
                      data-testid={`library-confirm-${row.document_id}`}
                      className="mt-1.5 rounded-sm border border-destructive/40 bg-destructive/5 p-2"
                    >
                      <p className="text-2xs">
                        将删除文档记录与翻译文件；这篇论文的笔记与概览缓存会保留
                        （重新导入相同文件时可自动恢复）。
                      </p>
                      <div className="mt-1.5 flex gap-1.5">
                        <Button size="sm" variant="destructive"
                          data-testid={`library-delete-confirm-${row.document_id}`}
                          onClick={() => void remove(row)}>
                          删除
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setConfirming(null)}>
                          取消
                        </Button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {error !== null && (
          <p role="alert" data-testid="library-error" className="text-2xs text-amber-600">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

export default LibraryDialog;
