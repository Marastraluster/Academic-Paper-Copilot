/**
 * Parsing the answer's Markdown subset, and its `[E1]` markers, into blocks.
 *
 * Written rather than installed, and the reason is the bundle. The initial chunk
 * is 275 kB against a 350 kB ceiling; `react-markdown` with its `remark`/`rehype`
 * tree is 40 kB+ of parser for a grammar this feature never sees, and it would
 * also accept raw HTML — which an answer derived from an untrusted PDF has no
 * business being able to inject. The subset below is what DS-QA-002 actually
 * emits: paragraphs, bullet and numbered lists, bold, inline code, fenced code.
 *
 * `[E1]` becomes a citation reference; the marker itself never reaches the
 * reader, because a raw evidence id is a debug detail, not a citation. A marker
 * naming a citation the response did not include is left as literal text — it
 * should be impossible (the backend derives the list from the markers) and if it
 * ever happens, showing it is better than silently deleting a sentence's source.
 */
import type { Citation } from "@/qa/parse";

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "code"; text: string }
  | { kind: "citation"; id: string; index: number };

export type Block =
  | { kind: "paragraph"; inlines: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "code"; text: string };

/** `**bold**` · `` `code` `` · `[E1]`, in one pass. */
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[E\d+\])/g;
const MARKER = /^\[(E\d+)\]$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const FENCE = /^\s*```/;

function parseInline(text: string, byId: Map<string, Citation>): Inline[] {
  const inlines: Inline[] = [];

  for (const piece of text.split(INLINE)) {
    if (!piece) continue;

    const marker = MARKER.exec(piece);
    if (marker) {
      const citation = byId.get(marker[1]!);
      inlines.push(
        citation
          ? { kind: "citation", id: citation.id, index: citation.index }
          : { kind: "text", text: piece },
      );
      continue;
    }
    if (piece.startsWith("**") && piece.endsWith("**") && piece.length > 4) {
      inlines.push({ kind: "strong", text: piece.slice(2, -2) });
      continue;
    }
    if (piece.startsWith("`") && piece.endsWith("`") && piece.length > 2) {
      inlines.push({ kind: "code", text: piece.slice(1, -1) });
      continue;
    }
    inlines.push({ kind: "text", text: piece });
  }

  return inlines;
}

/**
 * Split an answer into renderable blocks.
 *
 * Deliberately forgiving: an unterminated code fence is closed at the end rather
 * than swallowing the rest of the answer, and a line that is neither a list item
 * nor a paragraph break simply continues the current paragraph — which is what
 * Markdown does with a wrapped line anyway.
 */
export function parseAnswerBlocks(answer: string, citations: Citation[]): Block[] {
  const byId = new Map(citations.map((citation) => [citation.id, citation]));
  const blocks: Block[] = [];
  const lines = answer.replace(/\r\n/g, "\n").split("\n");

  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let fence: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ kind: "paragraph", inlines: parseInline(paragraph.join(" "), byId) });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({
        kind: "list",
        ordered: list.ordered,
        items: list.items.map((item) => parseInline(item, byId)),
      });
      list = null;
    }
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
  };

  for (const line of lines) {
    if (fence !== null) {
      if (FENCE.test(line)) {
        blocks.push({ kind: "code", text: fence.join("\n") });
        fence = null;
      } else {
        fence.push(line);
      }
      continue;
    }

    if (FENCE.test(line)) {
      flushAll();
      fence = [];
      continue;
    }

    if (line.trim() === "") {
      flushAll();
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);

    if (bullet || numbered) {
      flushParagraph();
      const ordered = numbered !== null;
      const item = (bullet ?? numbered)![1]!;
      // A change of marker kind starts a new list rather than continuing one.
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push(item);
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  if (fence !== null) blocks.push({ kind: "code", text: fence.join("\n") });
  flushAll();

  return blocks;
}
