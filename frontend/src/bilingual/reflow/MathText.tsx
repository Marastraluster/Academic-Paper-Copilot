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
import { useEffect, useState } from "react";

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

export function MathText({ text }: { text: string }) {
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

  if (!hasMath) return <>{text}</>;

  return (
    <>
      {splitMath(text).map((piece, index) => {
        if (piece.kind === "text") return <span key={index}>{piece.text}</span>;
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
