/**
 * `[24]` in the prose, resolved to the reference it names.
 *
 * The paper prints a number; the reader wants the paper behind it. The index is
 * built from the paper's own bibliography — the IR's paragraphs under a section
 * marked as references (the reading itself leaves that section out: it is never
 * sent to a model) — by their leading `[n]` markers, so nothing is guessed: a number with
 * no entry stays plain text. A bibliography the extractor ran together into one
 * paragraph is cut at its markers where they count upwards, the same rule the
 * backend uses to tie a related paper to its entry.
 *
 * Nothing here reaches the network or a model. A click scrolls the column to
 * the entry, and the reader is offered the way back.
 */
import { createContext, useContext, type ReactNode } from "react";

import type { DocumentIr } from "@/api/ir";

export interface ReferenceEntry {
  number: number;
  /** The paragraph the entry was read from — what a click scrolls to. */
  paragraphId: string;
  /** The entry's own text, shown on hover. */
  text: string;
}

export type ReferenceIndex = ReadonlyMap<number, ReferenceEntry>;

const ENTRY_MARKER = /(?:^|\s)\[(\d{1,4})\]\s/g;

/** Every numbered entry of the paper's bibliography, by its number. */
export function buildReferenceIndex(
  ir: Pick<DocumentIr, "sections" | "paragraphs"> | null,
): ReferenceIndex {
  const index = new Map<number, ReferenceEntry>();
  if (ir === null) return index;
  const references = referenceSectionIds(ir);
  if (references.size === 0) return index;

  for (const paragraph of ir.paragraphs) {
    if (!paragraph.section_id || !references.has(paragraph.section_id)) continue;
    const text = paragraph.text;
    const starts: Array<{ number: number; at: number }> = [];
    let last = 0;
    for (const match of text.matchAll(ENTRY_MARKER)) {
      const number = Number(match[1]);
      const at = (match.index ?? 0) + match[0].indexOf("[");
      // Prose before the first marker, or a citation inside an entry.
      if ((starts.length === 0 && text.slice(0, at).trim() !== "") || number <= last) continue;
      starts.push({ number, at });
      last = number;
    }
    starts.forEach((start, i) => {
      if (index.has(start.number)) return; // the first entry with a number is the entry
      const end = i + 1 < starts.length ? starts[i + 1]!.at : text.length;
      index.set(start.number, {
        number: start.number,
        paragraphId: paragraph.id,
        text: text.slice(start.at, end).trim(),
      });
    });
  }
  return index;
}

/** The ids of the sections that are the paper's bibliography. */
export function referenceSectionIds(ir: Pick<DocumentIr, "sections"> | null): ReadonlySet<string> {
  return new Set((ir?.sections ?? []).filter((section) => section.is_references).map((section) => section.id));
}

/** `[7]`, `[2, 34, 49]`, `[7–9]` — numbers only, so `[x]` and `[Fig. 2]` are left alone. */
const CITATION = /\[(\d{1,4}(?:\s*[,;–—-]\s*\d{1,4})*)\]/g;

export type CitationPiece =
  | { kind: "text"; text: string }
  | { kind: "number"; text: string; number: number };

/** Text cut so that each cited number is its own piece; everything else is kept verbatim. */
export function splitCitations(text: string, index: ReferenceIndex): CitationPiece[] {
  if (index.size === 0 || !text.includes("[")) return [{ kind: "text", text }];
  const pieces: CitationPiece[] = [];
  let last = 0;
  const push = (value: string) => {
    if (value === "") return;
    const previous = pieces[pieces.length - 1];
    if (previous?.kind === "text") previous.text += value;
    else pieces.push({ kind: "text", text: value });
  };

  for (const match of text.matchAll(CITATION)) {
    const start = match.index ?? 0;
    // The marker that opens a bibliography entry is the entry, not a citation of it.
    if (start === 0) continue;
    const inner = match[1] ?? "";
    const numbers = [...inner.matchAll(/\d{1,4}/g)];
    if (!numbers.some((n) => index.has(Number(n[0])))) continue;

    push(text.slice(last, start) + "[");
    let cursor = 0;
    for (const n of numbers) {
      const at = n.index ?? 0;
      push(inner.slice(cursor, at));
      const number = Number(n[0]);
      if (index.has(number)) pieces.push({ kind: "number", text: n[0], number });
      else push(n[0]);
      cursor = at + n[0].length;
    }
    push(inner.slice(cursor) + "]");
    last = start + match[0].length;
  }
  push(text.slice(last));
  return pieces;
}

export interface CitationLinks {
  index: ReferenceIndex;
  jump: (entry: ReferenceEntry) => void;
}

/** Absent outside a reading that has a bibliography: prose then renders as plain text. */
export const CitationContext = createContext<CitationLinks | null>(null);

/** A run of prose with its citations made into links, when there is something to link to. */
export function CitedText({ text }: { text: string }): ReactNode {
  const links = useContext(CitationContext);
  if (links === null) return text;
  const pieces = splitCitations(text, links.index);
  if (pieces.length === 1 && pieces[0]!.kind === "text") return text;
  return (
    <>
      {pieces.map((piece, i) => {
        if (piece.kind === "text") return <span key={i}>{piece.text}</span>;
        const entry = links.index.get(piece.number)!;
        return (
          <button
            key={i}
            type="button"
            data-testid="citation-link"
            data-citation={piece.number}
            title={entry.text.length > 320 ? `${entry.text.slice(0, 320)}…` : entry.text}
            aria-label={`参考文献 ${piece.number}`}
            onClick={() => links.jump(entry)}
            className="rounded-[3px] text-primary underline decoration-primary/30 underline-offset-2 hover:bg-primary/10 hover:decoration-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {piece.text}
          </button>
        );
      })}
    </>
  );
}
