import { useQaSession } from "@/qa/useQaSession";
import { QUICK_ACTIONS } from "@/stores/workspace";

/**
 * AC-P1-04 — the academic shortcuts, wired to real questions.
 *
 * Each one asks a question through the same grounded path as the composer; there
 * is no second way into the model. The scope it uses is printed on the resulting
 * card, so a reader can always see what was searched rather than inferring it
 * from the button they pressed.
 */
export function QuickActions() {
  const { askQuickAction, canRunAction, documentState, availability } = useQaSession();
  const disabled = documentState !== "ready";

  return (
    <div
      role="group"
      aria-label="快捷操作"
      className="flex flex-wrap gap-1 px-3 pb-2"
    >
      {QUICK_ACTIONS.map((action) => {
        // An action tied to a scope needs that scope to exist right now: there
        // is nothing to explain until something is selected.
        const scopeMissing = action.scope !== null && !availability[action.scope];
        const unavailable = disabled || !action.enabled || !canRunAction || scopeMissing;
        return (
          <button
            key={action.label}
            type="button"
            data-testid={`quick-action-${action.label}`}
            disabled={unavailable}
            title={
              !action.enabled
                ? "该能力尚未实现"
                : scopeMissing && action.scope === "selection"
                  ? "先在论文中选中一段文字"
                  : undefined
            }
            onClick={() => void askQuickAction(action)}
            className="rounded border bg-background px-2 py-1 text-2xs text-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-background"
          >
            {action.label}
          </button>
        );
      })}
    </div>
  );
}
