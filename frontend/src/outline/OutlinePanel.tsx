import { useEffect, useMemo, useRef } from "react";
import { ChevronDown, ChevronRight, FileText, MessageSquarePlus } from "lucide-react";

import { useWorkspaceStore, type QaSection } from "@/stores/workspace";
import { buildOutlineTree } from "@/outline/tree";
import { askThisSection, jumpToSection } from "@/outline/navigate";
import { cn } from "@/lib/utils";

/**
 * The paper's structure, as a table of contents.
 *
 * ARIA tree semantics with the keyboard behaviour they require: arrow keys move
 * between visible nodes, left and right collapse and expand, Enter and Space
 * navigate. The brief is explicit that tree roles may not be declared without
 * that behaviour (Phase 40), so both live here together.
 *
 * Three visual states, and they are three different things:
 *
 * * **active** — where the reader is, tracked from the reading position;
 * * **selected** — the section the user handed to Paper QA, which is sticky;
 * * **current** — the keyboard focus, which follows arrow keys.
 *
 * None is conveyed by colour alone: each carries an `aria-current`, an
 * `aria-selected`, or a focus ring, and the active row is also bolder.
 */
export function OutlinePanel() {
  const sections = useWorkspaceStore((s) => s.sections);
  const activeSectionId = useWorkspaceStore((s) => s.activeSectionId);
  const selectedSectionId = useWorkspaceStore((s) => s.selectedSectionId);
  const expandedIds = useWorkspaceStore((s) => s.expandedSectionIds);
  const toggleExpanded = useWorkspaceStore((s) => s.toggleSectionExpanded);
  const document_ = useWorkspaceStore((s) => s.document);

  const tree = useMemo(
    () => (sections && sections.length > 0 ? buildOutlineTree(sections) : null),
    [sections],
  );

  const expanded = useMemo(() => new Set(expandedIds), [expandedIds]);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Keep the active row in view as the reader moves, without fighting a user who
  // is scrolling the outline themselves: only scroll when the row is actually
  // out of sight, and never take focus.
  useEffect(() => {
    if (activeSectionId === null) return;
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(
      `[data-section-id="${CSS.escape(activeSectionId)}"]`,
    );
    if (!list || !row) return;
    const rowBox = row.getBoundingClientRect();
    const listBox = list.getBoundingClientRect();
    if (rowBox.top < listBox.top || rowBox.bottom > listBox.bottom) {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [activeSectionId, expandedIds]);

  if (!document_ || document_.registration !== "ready") {
    return (
      <p
        data-testid="outline-empty-state"
        className="px-3 py-6 text-xs text-muted-foreground"
      >
        请先打开一篇论文。
      </p>
    );
  }

  if (tree === null) {
    return (
      <p
        data-testid="outline-no-structure"
        className="px-3 py-6 text-xs text-muted-foreground"
      >
        本文未检测到明确的章节结构。阅读与问答仍可使用。
      </p>
    );
  }

  const flat: { section: QaSection; depth: number; hasChildren: boolean }[] = [];
  const walk = (nodes: QaSection[], depth: number) => {
    for (const section of nodes) {
      const children = tree.childrenOf.get(section.id) ?? [];
      flat.push({ section, depth, hasChildren: children.length > 0 });
      if (children.length > 0 && expanded.has(section.id)) walk(children, depth + 1);
    }
  };
  walk(tree.roots, 0);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const index = flat.findIndex(
      (entry) => entry.section.id === (event.target as HTMLElement).dataset.sectionId,
    );
    if (index < 0) return;
    const { section, hasChildren } = flat[index];
    const focusAt = (next: number) => {
      const target = flat[next];
      if (!target) return;
      listRef.current
        ?.querySelector<HTMLElement>(
          `[data-section-id="${CSS.escape(target.section.id)}"]`,
        )
        ?.focus();
    };

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusAt(Math.min(index + 1, flat.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        focusAt(Math.max(index - 1, 0));
        break;
      case "ArrowRight":
        if (hasChildren && !expanded.has(section.id)) {
          event.preventDefault();
          toggleExpanded(section.id);
        }
        break;
      case "ArrowLeft":
        if (hasChildren && expanded.has(section.id)) {
          event.preventDefault();
          toggleExpanded(section.id);
        }
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        jumpToSection(section);
        break;
      default:
        break;
    }
  };

  return (
    <div
      data-testid="outline-panel"
      ref={listRef}
      role="tree"
      aria-label="论文目录"
      onKeyDown={onKeyDown}
      className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1 py-1"
    >
      {flat.map(({ section, depth, hasChildren }) => {
        const isActive = section.id === activeSectionId;
        const isSelected = section.id === selectedSectionId;
        const isOpen = expanded.has(section.id);
        return (
          <div
            key={section.id}
            role="treeitem"
            tabIndex={0}
            data-section-id={section.id}
            data-testid={`outline-node-${section.id}`}
            data-active={isActive}
            aria-level={depth + 1}
            aria-selected={isSelected}
            aria-current={isActive ? "location" : undefined}
            aria-expanded={hasChildren ? isOpen : undefined}
            style={{ paddingLeft: `${depth * 12 + 4}px` }}
            className={cn(
              "group flex items-center gap-1 rounded-sm py-1 pr-1 text-xs",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
              isActive && "bg-primary/10 font-semibold",
              !isActive && "hover:bg-accent/60",
            )}
          >
            {hasChildren ? (
              <button
                type="button"
                tabIndex={-1}
                aria-label={isOpen ? `折叠 ${section.title}` : `展开 ${section.title}`}
                data-testid={`outline-toggle-${section.id}`}
                onClick={() => toggleExpanded(section.id)}
                className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
              >
                {isOpen ? (
                  <ChevronDown className="h-3 w-3" aria-hidden="true" />
                ) : (
                  <ChevronRight className="h-3 w-3" aria-hidden="true" />
                )}
              </button>
            ) : (
              <span className="w-4 shrink-0" aria-hidden="true" />
            )}

            <button
              type="button"
              tabIndex={-1}
              onClick={() => jumpToSection(section)}
              title={section.title}
              data-testid={`outline-jump-${section.id}`}
              className="min-w-0 flex-1 truncate text-left"
            >
              {section.title}
            </button>

            <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
              {section.pageNumber}
            </span>

            <button
              type="button"
              tabIndex={-1}
              aria-label={`就「${section.title}」提问`}
              title="问此章节"
              data-testid={`outline-ask-${section.id}`}
              onClick={() => askThisSection(section)}
              className="shrink-0 rounded-sm p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
            >
              <MessageSquarePlus className="h-3 w-3" aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** The panel's own header line, so the sidebar shows which paper it describes. */
export function OutlineHeader() {
  const title = useWorkspaceStore((s) => s.document?.name ?? null);
  const sections = useWorkspaceStore((s) => s.sections);
  if (title === null) return null;
  return (
    <div className="flex items-center gap-1.5 border-b px-3 py-2">
      <FileText className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 truncate text-xs font-medium" title={title}>
        {title}
      </span>
      {sections && sections.length > 0 && (
        <span className="ml-auto shrink-0 text-2xs text-muted-foreground">
          {sections.length} 节
        </span>
      )}
    </div>
  );
}
