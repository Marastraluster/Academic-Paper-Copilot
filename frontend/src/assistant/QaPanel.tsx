import { Composer } from "@/assistant/Composer";
import { ConversationArea } from "@/assistant/ConversationArea";
import { QuickActions } from "@/assistant/QuickActions";
import { ScopeSelector } from "@/assistant/ScopeSelector";

/**
 * Paper QA's panel, as one lazily-loaded unit.
 *
 * It exists so the sidebar has a single dynamic import to wait on rather than
 * four, and so the chunk boundary matches the thing a reader opens: asking a
 * question is a mode they enter, and its parsing, answer rendering and
 * conversation state do not need to be in the download that shows them a paper.
 */
export function QaPanel() {
  return (
    <>
      <ScopeSelector />
      <QuickActions />
      <ConversationArea />
      <Composer />
    </>
  );
}
