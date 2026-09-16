import { useWorkspaceStore, type AssistantScope } from "@/stores/workspace";

/** AC-06(1) + brief §29: the four context scopes. */
const SCOPES: ReadonlyArray<{ value: AssistantScope; label: string }> = [
  { value: "document", label: "当前论文" },
  { value: "page", label: "当前页" },
  { value: "section", label: "当前章节" },
  { value: "selection", label: "选中内容" },
];

export function ScopeSelector() {
  const scope = useWorkspaceStore((s) => s.scope);
  const setScope = useWorkspaceStore((s) => s.setScope);

  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <span className="shrink-0 text-2xs text-muted-foreground">范围</span>
      <select
        aria-label="助手上下文范围"
        data-testid="scope-selector"
        value={scope}
        onChange={(e) => setScope(e.target.value as AssistantScope)}
        className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      >
        {SCOPES.map(({ value, label }) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </div>
  );
}
