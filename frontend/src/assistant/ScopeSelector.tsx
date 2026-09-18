import { useQaSession } from "@/qa/useQaSession";
import type { MappingStatus } from "@/qa/selection";
import {
  useWorkspaceStore,
  type QaScopeType,
  type QaSection,
  type ReaderMode,
} from "@/stores/workspace";

/**
 * What Selection should say, when it cannot be used.
 *
 * Every refusal has a different fix, so every refusal gets its own sentence. A
 * single "unavailable" would leave the reader to guess which of five quite
 * different things they did.
 */
const REFUSALS: Record<MappingStatus, string> = {
  valid: "",
  partial: "",
  collapsed: "在原文中选中一段文字，即可按选区提问。",
  cross_page: "暂不支持跨页选区问答，请限制在单页内选择。",
  non_prose: "所选内容为标题或图表说明，无法作为选区问答范围。",
  unavailable: "选区映射暂不可用（原文结构尚未就绪）。",
};

function sectionLabel(sections: QaSection[] | null, available: boolean): string {
  if (available) return "当前章节";
  if (sections === null) return "当前章节（不可用）";
  if (sections.length === 0) return "当前章节（无目录结构）";
  return "当前章节（本页无章节）";
}

function selectionLabel(available: boolean, mode: ReaderMode, refused: boolean): string {
  if (available) return "选中内容";
  if (mode === "translation") return "选中内容（译文模式不可用）";
  return refused ? "选中内容（无法映射）" : "选中内容（未选择）";
}

/**
 * AC-P0-04 — the four scopes, in the backend's own vocabulary.
 *
 * A scope with no identity is **disabled with the reason**, never offered and
 * then sent anyway. Selection joined them in DS-QA-005: it is enabled only when
 * a drag actually resolved to canonical paragraphs, because answering the whole
 * paper under a Selection label is the one thing the scope model exists to
 * prevent.
 *
 * Note what it does **not** do: it never changes the selected scope by itself. A
 * reader highlighting a sentence to copy it must not have their scope silently
 * replaced — the mapping makes Selection *available*, and choosing it stays a
 * user action.
 */
export function ScopeSelector() {
  const { scope, setScope, availability, documentState, selection, selectionStatus } =
    useQaSession();
  const sections = useWorkspaceStore((s) => s.sections);
  const activePage = useWorkspaceStore((s) => s.activePage);
  const readerMode = useWorkspaceStore((s) => s.readerMode);
  const setReaderMode = useWorkspaceStore((s) => s.setReaderMode);

  const ready = documentState === "ready";
  const refused = selectionStatus !== null && selectionStatus !== "valid" && selectionStatus !== "partial";
  // In translation mode the only pane on screen is a re-laid-out document, so
  // there is no source geometry to map — and the honest offer is the one
  // citation clicking already makes.
  const selectionUsable = availability.selection && readerMode !== "translation";

  const options: ReadonlyArray<{ value: QaScopeType; label: string; enabled: boolean }> = [
    { value: "whole_paper", label: "当前论文", enabled: ready },
    {
      value: "page",
      label: ready ? `当前页（第 ${activePage} 页）` : "当前页",
      enabled: ready && availability.page,
    },
    {
      value: "section",
      label: sectionLabel(sections, availability.section),
      enabled: ready && availability.section,
    },
    {
      value: "selection",
      // `selectionUsable`, not `availability.selection`: in translation mode a
      // valid mapping exists but cannot be used, and a label that says "选中内容"
      // next to a disabled control would promise something the pane cannot do.
      label: selectionLabel(selectionUsable, readerMode, refused),
      enabled: ready && selectionUsable,
    },
  ];

  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-2">
        <label className="shrink-0 text-2xs text-muted-foreground" htmlFor="qa-scope">
          范围
        </label>
        <select
          id="qa-scope"
          aria-label="提问范围"
          data-testid="scope-selector"
          value={scope}
          disabled={!ready}
          onChange={(event) => setScope(event.target.value as QaScopeType)}
          className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-60"
        >
          {options.map(({ value, label, enabled }) => (
            <option key={value} value={value} disabled={!enabled}>
              {label}
            </option>
          ))}
        </select>
      </div>

      {readerMode === "translation" && (
        <button
          type="button"
          data-testid="selection-translation-hint"
          onClick={() => setReaderMode("original")}
          className="mt-1.5 w-full rounded border border-primary/30 bg-primary/5 px-2 py-1 text-left text-2xs text-foreground transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        >
          切换至原文模式以使用选区问答
        </button>
      )}

      {readerMode !== "translation" && selection && (
        <p
          data-testid="selection-preview"
          className="mt-1.5 rounded border bg-muted/40 px-2 py-1 text-2xs leading-relaxed text-muted-foreground"
        >
          已选 {selection.paragraphIds.length} 个段落：
          <span className="text-foreground">
            “{selection.text.replace(/\s+/g, " ").slice(0, 60)}
            {selection.text.replace(/\s+/g, " ").length > 60 ? "…" : ""}”
          </span>
          {selection.status === "partial" && (
            <span className="mt-0.5 block">部分选区内容无法映射到原文段落，已按可映射部分提问。</span>
          )}
        </p>
      )}

      {readerMode !== "translation" && !selection && selectionStatus && (
        <p data-testid="selection-refusal" className="mt-1.5 px-1 text-2xs text-muted-foreground">
          {REFUSALS[selectionStatus]}
        </p>
      )}
    </div>
  );
}
