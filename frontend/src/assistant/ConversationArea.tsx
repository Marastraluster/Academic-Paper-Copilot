import { BookOpen } from "lucide-react";

import { QaTurnCard } from "@/qa/QaTurnCard";
import { jumpToCitation } from "@/qa/session";
import { useQaSession } from "@/qa/useQaSession";

/**
 * The questions asked of this document, oldest first.
 *
 * Each entry is an independent card. There is no conversational thread and the
 * UI does not imply one: a follow-up like "what about the second experiment?"
 * has no referent here, and a chat transcript would suggest it does. The hint
 * above the composer says the same thing in the user's words.
 *
 * The area is one of the few regions allowed to scroll — the shell pins the
 * viewport and everything else stays fixed.
 */
export function ConversationArea() {
  const { turns, documentState, profilesError, hasProfile, retry, widen } = useQaSession();

  return (
    <div
      data-testid="conversation-area"
      aria-label="问答记录"
      className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2"
    >
      {documentState === "none" && (
        <Empty
          title="未打开文档"
          detail="请打开一篇 PDF 论文以启用问答助手。"
        />
      )}

      {documentState === "pending" && (
        <Empty title="正在把文档注册到后端…" detail="注册完成后即可提问。" />
      )}

      {documentState === "failed" && (
        <Empty
          title="文档注册失败"
          detail="问答服务暂不可用。请重新打开该论文，或确认后端服务正在运行。"
        />
      )}

      {documentState === "ready" && !hasProfile && (
        <div
          data-testid="qa-no-profiles"
          role="alert"
          className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-2xs text-amber-800"
        >
          <p className="font-medium">未检测到可用的模型配置</p>
          <p className="mt-0.5">
            请在项目目录运行{" "}
            <code className="rounded bg-background/60 px-1 font-mono">
              python scripts/configure_provider.py
            </code>{" "}
            添加 Provider Profile 后重新打开论文。
          </p>
        </div>
      )}

      {documentState === "ready" && hasProfile && profilesError && (
        <p data-testid="qa-profiles-error" role="alert" className="text-2xs text-destructive">
          {profilesError}
        </p>
      )}

      {documentState === "ready" && hasProfile && turns.length === 0 && (
        <Empty
          title="可以开始提问"
          detail="回答只依据论文中检索到的原文证据，并在结论旁标注来源页码。证据不足时会明确说明，而不是凭记忆作答。"
        />
      )}

      {turns.map((turn) => (
        <QaTurnCard
          key={turn.id}
          turn={turn}
          onJump={jumpToCitation}
          onRetry={(turnId) => void retry(turnId)}
          onWiden={(turnId) => void widen(turnId)}
        />
      ))}
    </div>
  );
}

function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="space-y-1 px-1 py-3 text-center">
      <BookOpen className="mx-auto h-4 w-4 text-muted-foreground/50" aria-hidden="true" />
      <p className="text-xs font-medium text-foreground">{title}</p>
      <p className="text-2xs leading-relaxed text-muted-foreground">{detail}</p>
    </div>
  );
}
