import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/stores/workspace";

/**
 * AC-06(3) — scrollable conversation history.
 * AC-29 / AC-37: this is one of the few regions allowed to scroll.
 */
export function ConversationArea() {
  const messages = useWorkspaceStore((s) => s.messages);

  return (
    <div
      data-testid="conversation-area"
      aria-label="对话记录"
      className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2"
    >
      {messages.map((m) => (
        <div
          key={m.id}
          className={cn(
            "rounded-md px-2.5 py-1.5 text-xs leading-relaxed",
            m.role === "user"
              ? "ml-6 bg-primary text-primary-foreground"
              : "mr-2 border bg-card text-card-foreground",
          )}
        >
          {m.content}
        </div>
      ))}
    </div>
  );
}
