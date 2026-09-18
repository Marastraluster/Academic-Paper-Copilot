import { useEffect, useMemo, useState } from "react";
import { Highlighter, MessageSquarePlus, Pencil, Trash2 } from "lucide-react";

import type { AnnotationView, ResolutionState } from "@/api/annotations";
import {
  createFromSelection,
  editAnnotation,
  loadAnnotations,
  removeAnnotation,
} from "@/notes/session";
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
  REATTACHED: "位置已根据更新后的解析重新定位。",
  AMBIGUOUS: "文中找到多处匹配，需要你确认。",
  ORPHANED: "未能在此版本中定位到原位置。",
};

export function NotesPanel() {
  const document_ = useWorkspaceStore((s) => s.document);
  const annotations = useWorkspaceStore((s) => s.annotations);
  const selection = useWorkspaceStore((s) => s.selection);
  const activeId = useWorkspaceStore((s) => s.activeAnnotationId);
  const setActiveId = useWorkspaceStore((s) => s.setActiveAnnotationId);

  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const hasSelection = (selection?.mapping.paragraphIds.length ?? 0) > 0;

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
            disabled={!hasSelection}
            onClick={() => void create("highlight")}
            className="flex items-center gap-1 rounded-sm px-2 py-1 text-xs enabled:hover:bg-accent/60 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <Highlighter className="h-3 w-3" aria-hidden="true" />
            高亮
          </button>
          <button
            type="button"
            data-testid="notes-create-note"
            disabled={!hasSelection}
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
          placeholder={hasSelection ? "为选中文字添加笔记…" : "先在论文中选择文字"}
          aria-label="笔记内容"
          className="mt-1 w-full rounded-sm border bg-background px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        />
        {error !== null && (
          <p role="alert" data-testid="notes-error" className="mt-1 text-2xs text-destructive">
            {error}
          </p>
        )}
      </div>

      {annotations !== null && annotations.length === 0 ? (
        <p data-testid="notes-none" className="px-3 py-6 text-xs text-muted-foreground">
          在论文中选择文字即可添加高亮或笔记。
        </p>
      ) : (
        <ul
          data-testid="notes-list"
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1 py-1"
        >
          {ordered.map((annotation) => (
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
  const warning = annotation.targets
    .map((target) => STATE_TEXT[target.state])
    .find((text) => text !== null);

  return (
    <li
      data-testid={`note-${annotation.id}`}
      data-active={active}
      className={cn(
        "mb-1 rounded-sm border px-2 py-1.5 text-xs",
        active ? "border-primary/40 bg-primary/5" : "border-transparent hover:bg-accent/50",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
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
            onClick={() => onSave(value)}
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
