import { X } from "lucide-react";

import { useWorkspaceStore } from "@/stores/workspace";

/**
 * Says what a citation click did to the reader.
 *
 * Only two things ever put a message here, and both are about the reader having
 * been moved without the user asking: a citation clicked in translation mode
 * switches to the original, and a reader who is not told why has lost their
 * place with no explanation. Dismissible, and it says how to get back.
 */
export function JumpNotice() {
  const notice = useWorkspaceStore((s) => s.notice);
  const setNotice = useWorkspaceStore((s) => s.setNotice);

  if (!notice) return null;

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
