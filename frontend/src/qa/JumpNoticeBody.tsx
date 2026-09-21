/**
 * The notice banner itself, loaded when there is something to say.
 *
 * Split from `JumpNotice` so the application does not carry the markup for a
 * message nobody has triggered. The text is passed in rather than read again
 * from the store: one reader of the state, one place where it can change.
 */
import { X } from "lucide-react";

import { useWorkspaceStore } from "@/stores/workspace";

export function JumpNoticeBody({ notice }: { notice: string }) {
  const setNotice = useWorkspaceStore((s) => s.setNotice);

  return (
    <div
      data-testid="qa-jump-notice"
      role="status"
      className="flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 px-2 py-1.5 text-2xs text-foreground"
    >
      <p className="min-w-0 flex-1">{notice}</p>
      <button
        type="button"
        aria-label="关闭提示"
        data-testid="qa-jump-notice-close"
        onClick={() => setNotice(null)}
        className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
      >
        <X className="h-3 w-3" aria-hidden="true" />
      </button>
    </div>
  );
}

export default JumpNoticeBody;
