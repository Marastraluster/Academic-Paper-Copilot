import { useQaSession } from "@/qa/useQaSession";
import { useWorkspaceStore, type QaScopeType, type QaSection } from "@/stores/workspace";

/**
 * What Section scope should say, when it cannot be used.
 *
 * Three different reasons get three different labels. "The paper has no outline"
 * is a fact about the paper; "the outline has not arrived" is a fact about us;
 * and "this page is not inside any section" is a fact about where the reader is.
 * Collapsing them into one would state the wrong one most of the time.
 */
function sectionLabel(sections: QaSection[] | null, available: boolean): string {
  if (available) return "当前章节";
  if (sections === null) return "当前章节（不可用）";
  if (sections.length === 0) return "当前章节（无目录结构）";
  return "当前章节（本页无章节）";
}

/**
 * AC-P0-04 — the four scopes, in the backend's own vocabulary.
 *
 * A scope with no identity is **disabled with the reason**, never offered and
 * then sent anyway: `{"type": "page"}` without a page, or a section scope naming
 * nothing, earns a 422 and tells the user nothing about their paper. The label
 * says which identity is missing, which is the part they can act on.
 */
export function ScopeSelector() {
  const { scope, setScope, availability, documentState } = useQaSession();
  const sections = useWorkspaceStore((s) => s.sections);
  const activePage = useWorkspaceStore((s) => s.activePage);

  const ready = documentState === "ready";

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
      label: "选中内容（暂未支持）",
      // DS-QA-003 Decision D: there is no selection → paragraph mapping, so this
      // is deferred rather than approximated. Answering the whole paper and
      // calling it a selection would be a lie about what was searched.
      enabled: false,
    },
  ];

  return (
    <div className="flex items-center gap-2 px-3 py-2">
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
  );
}
