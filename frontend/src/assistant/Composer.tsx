import { Loader2, SendHorizontal } from "lucide-react";
import { useRef, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { useQaSession } from "@/qa/useQaSession";
import { useWorkspaceStore } from "@/stores/workspace";

/**
 * The question box.
 *
 * **Enter submits, and Enter during an IME composition does not.** This is the
 * detail that makes the input usable in Chinese, Japanese and Korean: while a
 * Pinyin composition is open, Enter *confirms the candidate*, and a handler that
 * only checks `event.key === "Enter"` sends a half-typed question and steals the
 * keystroke the user needed. Both signals are checked, because browsers disagree
 * about which one is set and React's synthetic event does not always carry
 * `isComposing` through.
 */
export function Composer() {
  const question = useWorkspaceStore((s) => s.question);
  const setQuestion = useWorkspaceStore((s) => s.setQuestion);
  const { ask, canAsk, submitting, documentState } = useQaSession();

  // Belt and braces for the IME guard: `isComposing` on the event is the primary
  // signal, and this catches a browser that reports it only on keydown.
  const composing = useRef(false);

  const disabled = documentState !== "ready";

  const submit = () => {
    if (!canAsk || composing.current) return;
    void ask();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // `nativeEvent.isComposing` is the authoritative flag; `event.keyCode === 229`
    // is what some IMEs report instead, and checking both is cheaper than
    // discovering which one a user's browser sets.
    const native = event.nativeEvent as KeyboardEvent["nativeEvent"] & {
      isComposing?: boolean;
      keyCode?: number;
    };
    if (composing.current || native.isComposing === true || native.keyCode === 229) {
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="shrink-0 border-t bg-card p-2">
      <div className="flex items-end gap-1.5">
        <textarea
          rows={1}
          value={question}
          disabled={disabled}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={onKeyDown}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          aria-label="向论文提问"
          data-testid="qa-composer"
          placeholder={
            disabled
              ? documentState === "none"
                ? "请先打开 PDF 论文…"
                : "正在把文档注册到后端…"
              : "Ask about paper…"
          }
          className="max-h-28 min-h-8 flex-1 resize-none rounded-md border bg-background px-2 py-1.5 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-60"
        />
        <Button
          size="icon-sm"
          aria-label="提问"
          data-testid="composer-send"
          disabled={!canAsk}
          onClick={submit}
        >
          {submitting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <SendHorizontal className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
      <p className="mt-1 px-0.5 text-2xs text-muted-foreground/70">
        Enter 提问 · Shift+Enter 换行 · 每次提问基于选定范围独立检索（单轮精准问答）
      </p>
    </div>
  );
}
