/**
 * Prose with inline formulas, as MinerU delivers it: `… fit $F(x) = H(x) - x$ and …`.
 *
 * Text without a `$` is returned as the plain string it is — no renderer is
 * loaded, nothing changes for a paper the in-house extractor read. Otherwise
 * KaTeX is fetched once, lazily (it is ~260 kB and most readers never need it),
 * and each formula is typeset inline. A formula that does not parse is shown as
 * its source, in a monospace span, rather than as a red error or nothing: the
 * reader keeps every character the paper had.
 */
import { useEffect, useState, type ReactNode } from "react";

import type { InlineRun } from "@/api/ir";

import { CitedText } from "@/bilingual/reflow/citations";

type Katex = typeof import("katex");

let katexPromise: Promise<Katex> | null = null;
function loadKatex(): Promise<Katex> {
  katexPromise ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(
    ([module]) => (module as unknown as { default: Katex }).default ?? (module as unknown as Katex),
  );
  return katexPromise;
}

/** `$…$` that is not `\$`, and not `$$`. Mirrors the backend's `mathguard`. */
const INLINE_MATH = /(?<![\\$])\$(?!\$)((?:\\.|[^$\\])+?)\$(?!\$)/g;

export type Piece = { kind: "text"; text: string } | { kind: "math"; latex: string };

export function splitMath(text: string): Piece[] {
  const pieces: Piece[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_MATH)) {
    const start = match.index ?? 0;
    if (start > last) pieces.push({ kind: "text", text: text.slice(last, start) });
    pieces.push({ kind: "math", latex: match[1] ?? "" });
    last = start + match[0].length;
  }
  if (last < text.length) pieces.push({ kind: "text", text: text.slice(last) });
  return pieces;
}

/** `text` cut at the edges of its styled runs, in order, nothing lost. */
export function styledSegments(text: string, runs: InlineRun[]): Array<{ text: string; styles: string[] }> {
  const ordered = runs
    .filter((run) => run.start >= 0 && run.end <= text.length && run.start < run.end)
    .sort((a, b) => a.start - b.start);
  const out: Array<{ text: string; styles: string[] }> = [];
  let cursor = 0;
  for (const run of ordered) {
    if (run.start < cursor) continue; // overlapping runs: the first one stands
    if (run.start > cursor) out.push({ text: text.slice(cursor, run.start), styles: [] });
    out.push({ text: text.slice(run.start, run.end), styles: run.styles });
    cursor = run.end;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), styles: [] });
  return out;
}

function styled(node: ReactNode, styles: string[]): ReactNode {
  let out = node;
  if (styles.includes("code")) out = <code className="rounded bg-muted px-0.5 text-[0.9em]">{out}</code>;
  if (styles.includes("superscript")) out = <sup>{out}</sup>;
  if (styles.includes("subscript")) out = <sub>{out}</sub>;
  if (styles.includes("underline")) out = <u>{out}</u>;
  if (styles.includes("italic")) out = <em>{out}</em>;
  if (styles.includes("bold")) out = <strong className="font-semibold">{out}</strong>;
  return out;
}

/**
 * `cite` turns the paper's `[24]` markers into links to their bibliography
 * entries (see `citations`); it is off for captions, footnotes and the
 * bibliography itself, where a marker is not a pointer to follow.
 *
 * `runs` are the paper's own bold, italic and superscript, as ranges of `text`:
 * a run-in heading set in bold is what tells a reader where a new topic starts.
 */
export function MathText({
  text,
  cite = false,
  runs,
}: {
  text: string;
  cite?: boolean;
  runs?: InlineRun[];
}) {
  if (runs !== undefined && runs.length > 0) {
    return (
      <>
        {styledSegments(text, runs).map((segment, index) => (
          <span key={index} data-run={segment.styles.length > 0 ? segment.styles.join(" ") : undefined}>
            {styled(<MathText text={segment.text} cite={cite} />, segment.styles)}
          </span>
        ))}
      </>
    );
  }
  return <PlainMathText text={text} cite={cite} />;
}

function PlainMathText({ text, cite }: { text: string; cite: boolean }) {
  const hasMath = text.includes("$") && splitMath(text).some((piece) => piece.kind === "math");
  const [katex, setKatex] = useState<Katex | null>(null);

  useEffect(() => {
    if (!hasMath) return;
    let cancelled = false;
    void loadKatex()
      .then((module) => {
        if (!cancelled) setKatex(module);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [hasMath]);

  if (!hasMath) return cite ? <CitedText text={text} /> : <>{text}</>;

  return (
    <>
      {splitMath(text).map((piece, index) => {
        if (piece.kind === "text") {
          return <span key={index}>{cite ? <CitedText text={piece.text} /> : piece.text}</span>;
        }
        if (katex !== null) {
          try {
            const html = katex.renderToString(piece.latex, { throwOnError: true, displayMode: false });
            return (
              <span
                key={index}
                data-testid="inline-math"
                className="reflow-inline-math"
                // KaTeX output from a string it parsed; `trust` is off, so no
                // `\href` or `\includegraphics` from the paper becomes markup.
                dangerouslySetInnerHTML={{ __html: html }}
              />
            );
          } catch {
            // Falls through to the source.
          }
        }
        return (
          <code key={index} className="rounded bg-muted px-0.5 text-[0.85em]">
            {piece.latex}
          </code>
        );
      })}
    </>
  );
}

export { loadKatex };
