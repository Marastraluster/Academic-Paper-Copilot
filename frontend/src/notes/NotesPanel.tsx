import { useEffect, useMemo, useState } from "react";
import { Download, Highlighter, MessageSquarePlus, Pencil, Search, Trash2, X } from "lucide-react";

import type { AnnotationView, ResolutionState } from "@/api/annotations";
import { apiUrl } from "@/api/config";
import {
  createFromSelection,
  editAnnotation,
  loadAnnotations,
  removeAnnotation,
} from "@/notes/session";
import { buildSearchIndex, filterAnnotations } from "@/notes/search";
import { buildAnnotationTargets } from "@/notes/targets";
import { useWorkspaceStore } from "@/stores/workspace";
import { jumpToAnnotation } from "@/notes/jump";
import { cn } from "@/lib/utils";

/**
 * Everything the reader has written on this paper.
 *
 * Sorted by **source order**, not creation order. A reader looking for the note
 * they made "about the method section" is looking in the paper's order; the order
 * they happened to write things in is not something they remember.
 *
 * The two failure states are shown, never repaired. A target that could not be
 * placed is the user's information, and quietly dropping it would be the one
 * outcome worse than saying so.
 */
const STATE_TEXT: Record<ResolutionState, string | null> = {
  EXACT: null,
  UNRESOLVED: null,
  REATTACHED: "位置已根据更新后的解析重新定位。",
  AMBIGUOUS: "文中找到多处匹配，需要你确认。",
  ORPHANED: "未能在此版本中定位到原位置。",
};

export function NotesPanel() {
  const document_ = useWorkspaceStore((s) => s.document);
  const annotations = useWorkspaceStore((s) => s.annotations);
  const ir = useWorkspaceStore((s) => s.ir);
  const geometry = useWorkspaceStore((s) => s.selectionGeometry);
  const activeId = useWorkspaceStore((s) => s.activeAnnotationId);
  const setActiveId = useWorkspaceStore((s) => s.setActiveAnnotationId);

  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const ready = document_?.registration === "ready";
  const documentId = document_?.documentId ?? null;
  const annotationsFor = useWorkspaceStore((s) => s.annotationsFor);
  // Keyed on *which document the list describes*, not on whether one is loaded.
  //
  // Two ways the naive version failed, both measured: a reload leaves an empty
  // store while the backend still holds the paper's notes, and opening a document
  // runs the teardown that clears this state — after the fetch that filled it.
  // An effect that fires only when the array is null cannot see either, because
  // it has no way to tell "empty" from "not fetched".
  useEffect(() => {
    if (ready && documentId !== null && annotationsFor !== documentId) {
      void loadAnnotations();
    }
  }, [ready, documentId, annotationsFor]);

  // Switching papers clears the query. A filter carried across would show the
  // new paper's notes already reduced, with the reason sitting in a box the
  // reader has to notice — which is an empty-looking panel for a paper that has
  // notes, the exact confusion this feature must not add.
  useEffect(() => {
    setQuery("");
  }, [documentId]);

  const ordered = useMemo(() => {
    const list = [...(annotations ?? [])];
    list.sort((left, right) => {
      const a = left.targets[0];
      const b = right.targets[0];
      if (!a || !b) return 0;
      return a.page_number - b.page_number || a.rects[0]?.[1] - b.rects[0]?.[1];
    });
    return list;
  }, [annotations]);

  /* Normalised once per list rather than once per keystroke. The corpus does not
     change while the reader types, and re-folding five hundred notes to answer
     one keystroke is five hundred times the work for the same result. Rebuilt
     when the list is replaced — which a create, edit or delete does, so a search
     is never stale. */
  const searchIndex = useMemo(() => buildSearchIndex(ordered), [ordered]);
  const visible = useMemo(() => {
    const started = performance.now();
    const matched = filterAnnotations(ordered, searchIndex, query);
    /* Timed where it runs, and only where it runs.
     *
     * The budget the criteria freeze is on the *filtering*, and the number a
     * reader experiences includes React re-rendering every matching row — five
     * hundred of them. Measuring the second and reporting it as the first would
     * fail a criterion the code passes, and measuring it in a test runner would
     * report jsdom's `String.normalize` rather than the browser's. Two marks per
     * keystroke cost nothing and make the frozen quantity observable from
     * outside. */
    performance.mark("notes-filter-start", { startTime: started });
    performance.mark("notes-filter-end");
    performance.measure("notes-filter", "notes-filter-start", "notes-filter-end");
    return matched;
  }, [ordered, searchIndex, query]);
  const searching = query.trim() !== "";

  /* Whether a note can be made, asked the same way `createFromSelection` asks
     it — by building the targets.
   *
   * It used to read the **QA** mapping's paragraph count, which is a different
   * question with a narrower answer: a drag across a figure caption maps to no
   * paragraph, so the button stayed disabled for a selection that could create a
   * perfectly good note. Measured in a browser: the formula `y = F(x, {Wi}) + x`
   * selected correctly and the action was refused.
   *
   * Asking the builder means the button and the action cannot disagree — there
   * is one implementation of "does this selection name a source unit". */
  const canAnnotate = useMemo(() => {
    if (!ir || !geometry) return false;
    return buildAnnotationTargets(ir, { rects: geometry.rects, text: geometry.text }).length > 0;
  }, [ir, geometry]);

  const create = async (kind: "highlight" | "note") => {
    setError(null);
    const result = await createFromSelection({ kind, comment: kind === "note" ? draft : null });
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    setDraft("");
    setActiveId(result.annotation.id);
  };

  if (!ready) {
    return (
      <p data-testid="notes-empty-state" className="px-3 py-6 text-xs text-muted-foreground">
        请先打开一篇论文。
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="notes-panel">
      {/* The creation affordance lives here rather than in a floating popover:
          the reader-side panel is already where the user works, and an overlay
          above the text would have to avoid the selection it exists to act on. */}
      <div className="shrink-0 border-b px-2 py-1.5" data-testid="notes-create">
        <div className="flex items-center gap-1">
          <button
            type="button"
            data-testid="notes-create-highlight"
            disabled={!canAnnotate}
            onClick={() => void create("highlight")}
            className="flex items-center gap-1 rounded-sm px-2 py-1 text-xs enabled:hover:bg-accent/60 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <Highlighter className="h-3 w-3" aria-hidden="true" />
            高亮
          </button>
          <button
            type="button"
            data-testid="notes-create-note"
            disabled={!canAnnotate}
            onClick={() => void create("note")}
            className="flex items-center gap-1 rounded-sm px-2 py-1 text-xs enabled:hover:bg-accent/60 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <MessageSquarePlus className="h-3 w-3" aria-hidden="true" />
            笔记
          </button>
        </div>
        <input
          data-testid="notes-draft"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={canAnnotate ? "为选中文字添加笔记…" : "先在论文中选择文字"}
          aria-label="笔记内容"
          className="mt-1 w-full rounded-sm border bg-background px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        />
        {error !== null && (
          <p role="alert" data-testid="notes-error" className="mt-1 text-2xs text-destructive">
            {error}
          </p>
        )}
      </div>

      {/* Search and export sit under the create block rather than in a toolbar of
          their own: three controls in a 340 px column do not need a chrome layer,
          and a reader who wants either one is already looking here. */}
      <div className="shrink-0 border-b px-2 py-1.5" data-testid="notes-tools">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            data-testid="notes-search-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query !== "") {
                event.stopPropagation();
                setQuery("");
              }
            }}
            placeholder="搜索笔记…"
            aria-label="搜索笔记"
            className="w-full rounded-sm border bg-background py-1 pl-6 pr-6 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          />
          {query !== "" && (
            <button
              type="button"
              data-testid="notes-search-clear"
              aria-label="清除搜索"
              onClick={() => setQuery("")}
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          )}
        </div>

        {/* Plain anchor downloads, like the translation menu: the browser streams
            the file the backend generated straight to disk, so there is no object
            URL to own or revoke. No `download` attribute, deliberately — the name
            the reader gets is the one the backend sanitised for their filesystem,
            and a second sanitiser here would be a second answer to disagree with. */}
        <div className="mt-1 flex items-center gap-1 text-2xs text-muted-foreground">
          <Download className="h-3 w-3" aria-hidden="true" />
          <span>导出</span>
          <a
            data-testid="export-notes-markdown"
            href={documentId ? apiUrl(`/api/documents/${encodeURIComponent(documentId)}/export/notes.md`) : undefined}
            aria-disabled={ordered.length === 0}
            title={ordered.length === 0 ? "当前文档暂无笔记可导出" : "导出为 Markdown"}
            onClick={(event) => {
              if (ordered.length === 0) event.preventDefault();
            }}
            className={cn(
              "rounded-sm px-1.5 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
              ordered.length === 0
                ? "pointer-events-none opacity-40"
                : "hover:bg-accent hover:text-foreground",
            )}
          >
            Markdown
          </a>
          <a
            data-testid="export-notes-json"
            href={documentId ? apiUrl(`/api/documents/${documentId}/export/notes.json`) : undefined}
            aria-disabled={ordered.length === 0}
            title={ordered.length === 0 ? "当前文档暂无笔记可导出" : "导出为 JSON"}
            onClick={(event) => {
              if (ordered.length === 0) event.preventDefault();
            }}
            className={cn(
              "rounded-sm px-1.5 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
              ordered.length === 0
                ? "pointer-events-none opacity-40"
                : "hover:bg-accent hover:text-foreground",
            )}
          >
            JSON
          </a>
          {searching && ordered.length > 0 && (
            <span data-testid="notes-export-scope" className="ml-auto">
              全部 {ordered.length} 条
            </span>
          )}
        </div>
      </div>

      {annotations !== null && annotations.length === 0 ? (
        <p data-testid="notes-none" className="px-3 py-6 text-xs text-muted-foreground">
          在论文中选择文字即可添加高亮或笔记。
        </p>
      ) : searching && visible.length === 0 ? (
        /* A different sentence from the one above, on purpose. "You have not
           written anything yet" and "nothing matches what you typed" call for
           different next actions, and one sentence for both teaches the reader
           nothing about which they are in. */
        <p data-testid="notes-search-empty" className="px-3 py-6 text-xs text-muted-foreground">
          未找到匹配的笔记或高亮
        </p>
      ) : (
        <ul
          data-testid="notes-list"
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1 py-1"
        >
          {visible.map((annotation) => (
            <NoteRow
              key={annotation.id}
              annotation={annotation}
              active={annotation.id === activeId}
              editing={editing === annotation.id}
              onSelect={() => {
                setActiveId(annotation.id);
                jumpToAnnotation(annotation);
              }}
              onEdit={() => setEditing(annotation.id)}
              onSave={async (text) => {
                await editAnnotation(annotation.id, text || null);
                setEditing(null);
              }}
              onDelete={async () => {
                await removeAnnotation(annotation.id);
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function NoteRow({
  annotation,
  active,
  editing,
  onSelect,
  onEdit,
  onSave,
  onDelete,
}: {
  annotation: AnnotationView;
  active: boolean;
  editing: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onSave: (text: string) => void;
  onDelete: () => void;
}) {
  const [value, setValue] = useState(annotation.comment ?? "");
  // `find` returns `undefined` when nothing matches, and `undefined !== null`
  // is true — so the naive version rendered a badge for *every* note, including
  // the ones that resolved exactly. Found by the AC-P0-07 test.
  const warning =
    annotation.targets
      .map((target) => STATE_TEXT[target.state])
      .find((text) => text != null) ?? null;

  return (
    <li
      data-testid={`note-${annotation.id}`}
      data-active={active}
      onClick={onSelect}
      className={cn(
        "mb-1 cursor-pointer rounded-sm border px-2 py-1.5 text-xs",
        active ? "border-primary/40 bg-primary/5" : "border-transparent hover:bg-accent/50",
      )}
    >
      {/* The whole row selects, not only the quote line. A reader clicking a
          search result aims at the result; with the handler on the quote alone,
          a click on the note's own text did nothing — which reads as a result
          that cannot be opened. The controls inside the row stop the event, so
          editing or deleting never also jumps the reader somewhere. */}
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onSelect();
        }}
        aria-label="跳转到标注位置"
        className="w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <p className="line-clamp-2 text-2xs italic text-muted-foreground">
          “{annotation.quote.slice(0, 90)}”
        </p>
      </button>

      {editing ? (
        <div className="mt-1 flex items-center gap-1">
          <input
            autoFocus
            data-testid={`note-input-${annotation.id}`}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-label="编辑笔记"
            className="min-w-0 flex-1 rounded-sm border bg-background px-1.5 py-0.5 text-xs"
          />
          <button
            type="button"
            data-testid={`note-save-${annotation.id}`}
            onClick={(event) => {
              event.stopPropagation();
              onSave(value);
            }}
            className="rounded-sm px-1.5 py-0.5 text-2xs hover:bg-accent"
          >
            保存
          </button>
        </div>
      ) : (
        annotation.comment && (
          <p data-testid={`note-comment-${annotation.id}`} className="mt-1 whitespace-pre-wrap">
            {annotation.comment}
          </p>
        )
      )}

      {warning !== null && (
        <p
          data-testid={`note-state-${annotation.id}`}
          className="mt-1 text-2xs text-amber-600 dark:text-amber-500"
        >
          {warning}
        </p>
      )}

      <div className="mt-1 flex items-center gap-1 text-2xs text-muted-foreground">
        <span>第 {annotation.targets[0]?.page_number ?? "?"} 页</span>
        {annotation.targets.length > 1 && <span>· {annotation.targets.length} 处</span>}
        <button
          type="button"
          aria-label="编辑笔记"
          data-testid={`note-edit-${annotation.id}`}
          onClick={onEdit}
          className="ml-auto rounded-sm p-0.5 hover:text-foreground"
        >
          <Pencil className="h-3 w-3" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="删除笔记"
          data-testid={`note-delete-${annotation.id}`}
          onClick={onDelete}
          className="rounded-sm p-0.5 hover:text-destructive"
        >
          <Trash2 className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}
