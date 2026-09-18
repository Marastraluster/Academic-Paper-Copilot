/**
 * One answer, rendered as the academic prose it is.
 *
 * No chat bubble, no avatar, no "assistant" voice: the answer is a short piece of
 * academic text with numbered references, and it is typeset that way. That is a
 * product decision as much as a visual one — the feature is a reading assistant,
 * and dressing it as a conversation would promise a memory it does not have.
 */
import { parseAnswerBlocks, type Inline } from "@/qa/answerBlocks";
import { CitationChip } from "@/qa/Citations";
import type { Citation } from "@/qa/parse";

export function AnswerBody({
  answer,
  citations,
  onJump,
}: {
  answer: string;
  citations: Citation[];
  onJump: (citation: Citation) => void;
}) {
  const citationsById = new Map(citations.map((citation) => [citation.id, citation]));
  const blocks = parseAnswerBlocks(answer, citations);

  const renderInlines = (inlines: Inline[]) =>
    inlines.map((inline, index) => {
      switch (inline.kind) {
        case "strong":
          return (
            <strong key={index} className="font-semibold text-foreground">
              {inline.text}
            </strong>
          );
        case "code":
          return (
            <code key={index} className="rounded bg-muted px-1 py-px font-mono text-2xs">
              {inline.text}
            </code>
          );
        case "citation": {
          const citation = citationsById.get(inline.id);
          if (!citation) return null;
          return <CitationChip key={index} citation={citation} onJump={onJump} />;
        }
        case "text":
          return <span key={index}>{inline.text}</span>;
      }
    });

  return (
    <div data-testid="qa-answer-body" className="space-y-1.5 text-xs leading-relaxed">
      {blocks.map((block, index) => {
        if (block.kind === "code") {
          return (
            <pre
              key={index}
              className="overflow-x-auto rounded border bg-muted px-2 py-1.5 font-mono text-2xs"
            >
              {block.text}
            </pre>
          );
        }
        if (block.kind === "list") {
          const List = block.ordered ? "ol" : "ul";
          return (
            <List
              key={index}
              className={
                block.ordered ? "list-decimal space-y-0.5 pl-4" : "list-disc space-y-0.5 pl-4"
              }
            >
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInlines(item)}</li>
              ))}
            </List>
          );
        }
        return <p key={index}>{renderInlines(block.inlines)}</p>;
      })}
    </div>
  );
}
