/**
 * One question and its outcome.
 *
 * Each turn is a self-contained card rather than a chat bubble, and the header
 * carries the scope it was asked in — because that scope is frozen at the moment
 * of asking. If the user changes the selector afterwards, this card must still
 * say what was actually searched: relabelling an old answer with the new scope
 * would make the result look like something it is not.
 *
 * The four outcomes are visually distinct on purpose:
 *
 * * `answered` / `partial` — grounded results, neutral styling, real citations.
 * * `insufficient_evidence` — also a success. The evidence does not answer the
 *   question, which is a fact about the paper, not a failure of the request.
 * * `error` — the request or the provider failed. Nothing was learned about the
 *   paper at all.
 * * `unknown_status` / `malformed` — the backend said something this build does
 *   not understand. Shown as unrecognised, never as an answer.
 */
import { CircleAlert, CircleHelp, Loader2, TriangleAlert } from "lucide-react";

import { AnswerBody } from "@/qa/AnswerBody";
import { ReferenceList } from "@/qa/Citations";
import type { Citation } from "@/qa/parse";
import { cn } from "@/lib/utils";
import type { QaTurn } from "@/stores/workspace";

interface QaTurnCardProps {
  turn: QaTurn;
  onJump: (citation: Citation) => void;
  onRetry: (turnId: string) => void;
  /** Re-ask the same question across the whole paper. Only offered when useful. */
  onWiden: (turnId: string) => void;
}

const BADGE =
  "shrink-0 rounded-sm bg-muted px-1 py-px text-2xs font-normal text-muted-foreground";

export function QaTurnCard({ turn, onJump, onRetry, onWiden }: QaTurnCardProps) {
  return (
    <article
      data-testid={`qa-turn-${turn.id}`}
      data-state={turn.result.state}
      className="rounded-md border bg-card px-2.5 py-2"
    >
      <header className="mb-1.5 flex items-start gap-2">
        <h3 className="min-w-0 flex-1 text-xs font-medium leading-snug text-foreground">
          {turn.question}
        </h3>
        <span className={BADGE}>{turn.scopeLabel}</span>
      </header>

      <Body turn={turn} onJump={onJump} onRetry={onRetry} onWiden={onWiden} />
    </article>
  );
}

function Body({ turn, onJump, onRetry, onWiden }: QaTurnCardProps) {
  const { result } = turn;

  switch (result.state) {
    case "pending":
      return (
        <p
          data-testid="qa-pending"
          role="status"
          aria-live="polite"
          className="flex items-center gap-1.5 text-2xs text-muted-foreground"
        >
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          正在检索文献并生成回答…
        </p>
      );

    case "grounded":
      return (
        <Grounded
          turn={turn}
          onJump={onJump}
          onWiden={onWiden}
          result={result}
        />
      );

    case "unknown_status":
      return (
        <div data-testid="qa-unknown-status" className="space-y-1.5">
          <p className="flex items-center gap-1.5 text-2xs text-amber-700">
            <CircleHelp className="h-3 w-3 shrink-0" aria-hidden="true" />
            应答状态异常：{result.status}
            <span className="text-muted-foreground">（本版本无法识别，以下内容未经确认）</span>
          </p>
          {result.answer && (
            <AnswerBody answer={result.answer} citations={result.citations} onJump={onJump} />
          )}
          <ReferenceList citations={result.citations} onJump={onJump} />
        </div>
      );

    case "malformed":
      return (
        <p
          data-testid="qa-malformed"
          className="flex items-center gap-1.5 text-2xs text-muted-foreground"
        >
          <TriangleAlert className="h-3 w-3 shrink-0" aria-hidden="true" />
          后端返回的内容无法解析为回答。
        </p>
      );

    case "error":
      return (
        <div data-testid="qa-error" className="space-y-1.5">
          <p className="flex items-start gap-1.5 text-2xs text-destructive">
            <CircleAlert className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
            <span>
              <span className="font-medium">{result.error.title}</span>
              {result.error.detail && (
                <span className="block text-muted-foreground">{result.error.detail}</span>
              )}
            </span>
          </p>
          <button
            type="button"
            data-testid={`qa-retry-${turn.id}`}
            onClick={() => onRetry(turn.id)}
            className="rounded border bg-background px-1.5 py-0.5 text-2xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          >
            重试
          </button>
        </div>
      );
  }
}

function Grounded({
  turn,
  result,
  onJump,
  onWiden,
}: Pick<QaTurnCardProps, "turn" | "onJump" | "onWiden"> & {
  result: Extract<QaTurn["result"], { state: "grounded" }>;
}) {
  if (result.status === "insufficient_evidence") {
    return (
      <div data-testid="qa-insufficient" className="space-y-1.5">
        <p className="text-xs text-foreground">未找到充分证据</p>
        <p className="text-2xs text-muted-foreground">
          {result.rationale ?? "论文在指定范围内未包含回答此问题的依据。"}
        </p>
        {/* Offered only when the backend said a wider scope would have found
            something. The scope stays a constraint until the user lifts it. */}
        {result.diagnostics?.suggest_scope_expansion && turn.scopeType !== "whole_paper" && (
          <button
            type="button"
            data-testid={`qa-widen-${turn.id}`}
            onClick={() => onWiden(turn.id)}
            className="rounded border bg-background px-1.5 py-0.5 text-2xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          >
            在「整篇论文」范围内重新检索
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <AnswerBody answer={result.answer} citations={result.citations} onJump={onJump} />

      {result.status === "partial" && (
        <div
          data-testid="qa-partial-notice"
          className="rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1.5"
        >
          <p className="text-2xs font-medium text-amber-700">部分回答（以下方面文献缺乏依据）</p>
          <ul className={cn("mt-0.5 list-disc space-y-0.5 pl-4 text-2xs text-muted-foreground")}>
            {result.unansweredAspects.map((aspect, index) => (
              <li key={index}>{aspect}</li>
            ))}
          </ul>
        </div>
      )}

      <ReferenceList citations={result.citations} onJump={onJump} />
    </div>
  );
}
