import { SendHorizontal } from "lucide-react";
import type { KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { useWorkspaceStore } from "@/stores/workspace";

/**
 * AC-06(4) — composer pinned to the bottom of the sidebar.
 * AC-18: blank or whitespace-only submissions are refused.
 */
export function Composer() {
  const composerValue = useWorkspaceStore((s) => s.composerValue);
  const setComposerValue = useWorkspaceStore((s) => s.setComposerValue);
  const submitComposer = useWorkspaceStore((s) => s.submitComposer);

  const canSubmit = composerValue.trim().length > 0;

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitComposer();
    }
  };

  return (
    <div className="shrink-0 border-t bg-card p-2">
      <div className="flex items-end gap-1.5">
        <textarea
          rows={1}
          value={composerValue}
          onChange={(e) => setComposerValue(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="向论文提问"
          placeholder="Ask paper..."
          className="max-h-28 min-h-8 flex-1 resize-none rounded-md border bg-background px-2 py-1.5 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        />
        <Button
          size="icon-sm"
          aria-label="发送"
          data-testid="composer-send"
          disabled={!canSubmit}
          onClick={submitComposer}
        >
          <SendHorizontal className="h-3.5 w-3.5" />
        </Button>
      </div>
      <p className="mt-1 px-0.5 text-2xs text-muted-foreground/70">
        Enter 发送 · Shift+Enter 换行
      </p>
    </div>
  );
}
