import { QUICK_ACTIONS, useWorkspaceStore } from "@/stores/workspace";

/**
 * AC-06(2) — the six required academic quick actions.
 * Each must be clickable without a runtime error (AC-35).
 */
export function QuickActions() {
  const runQuickAction = useWorkspaceStore((s) => s.runQuickAction);

  return (
    <div
      role="group"
      aria-label="快捷操作"
      className="flex flex-wrap gap-1 px-3 pb-2"
    >
      {QUICK_ACTIONS.map((action) => (
        <button
          key={action}
          type="button"
          data-testid={`quick-action-${action}`}
          onClick={() => runQuickAction(action)}
          className="rounded border bg-background px-2 py-1 text-2xs text-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        >
          {action}
        </button>
      ))}
    </div>
  );
}
