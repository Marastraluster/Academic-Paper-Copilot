/**
 * One display formula: typeset from a reconstruction, or the paper's own pixels.
 *
 * ## What this file is actually for
 *
 * A reconstruction can be **wrong in a way that looks right** — a summation bound
 * that should read `N`, a subscript that should be `i`, a `\sigma` where the paper
 * set `\tau`. Nothing here can tell a correct reconstruction from a plausible
 * one. So this component does three things instead of guessing:
 *
 * 1. **It never shows LaTeX that does not parse.** `katex.renderToString` with
 *    `throwOnError` runs before anything reaches the DOM; a string that throws is
 *    not displayed as text, it is *not displayed at all* — the paper's own crop
 *    takes its place.
 * 2. **It says where the formula came from**, in a badge the reader can see
 *    without hunting: `AI 重建`.
 * 3. **It gives the reader the original in one click**, and the same click back.
 *    That comparison is the only real verification this feature has, which makes
 *    the toggle the most important control in the file rather than a nicety.
 *
 * ## Why KaTeX is imported dynamically *here*
 *
 * The renderer is ~270 kB of JavaScript and ~350 kB of fonts (measured). A reader
 * who opens the reading on a paper with no formulas should not pay for either, so
 * both the module and its stylesheet are fetched in the same `Promise.all` the
 * first time a formula is actually typeset — and the stylesheet is fetched
 * *with* the code, so the formula is never painted unstyled for a frame.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";

import { cn } from "@/lib/utils";

/** The optical size the criteria freeze: 18 px against 16 px prose. */
export const FORMULA_FONT_REM = 1.125;
/** How much a formula may be shrunk before the paper's own crop is used instead. */
export const MIN_FORMULA_SCALE = 0.8;

interface FormulaItemProps {
  /** The sentence the model wrote, or null when it refused. */
  latex: string | null;
  /** Why there is no reconstruction, when there is none. */
  refusalReason?: string | null;
  /** Why a reconstruction could not be shown, when it could not. */
  failureReason?: string | null;
  /** `(1)`, from the paper. */
  number: string | null;
  /** Which page of the paper this formula is on — for the badge and the jump. */
  pageNumber: number;
  /** The paper's own pixels, rendered by the caller. */
  crop: React.ReactNode;
  /** The slot the formula has to fit in, in CSS pixels. */
  availableWidthPx: number;
  /** The identifier the backend knows this formula by, for the retry path. */
  blockId: string;
}

type Rendering =
  | { kind: "pending" }
  | { kind: "latex"; html: string }
  | { kind: "unavailable"; why: "no-reconstruction" | "unparsable" | "too-wide" | "load-failed" };

export function FormulaItem({
  latex,
  refusalReason = null,
  failureReason = null,
  number,
  pageNumber,
  crop,
  availableWidthPx,
  blockId,
}: FormulaItemProps) {
  const [rendering, setRendering] = useState<Rendering>({ kind: "pending" });
  const [showOriginal, setShowOriginal] = useState(false);
  const [scale, setScale] = useState(1);
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  // --- typeset, or find out that we cannot ------------------------------------
  useEffect(() => {
    let cancelled = false;
    if (latex === null || latex.trim() === "") {
      setRendering({ kind: "unavailable", why: "no-reconstruction" });
      return;
    }

    void (async () => {
      try {
        // One fetch for the renderer and one for its stylesheet: a formula that
        // appeared before its fonts did would be painted in the wrong metrics.
        const [katex] = await Promise.all([
          import("katex"),
          import("katex/dist/katex.min.css"),
        ]);
        if (cancelled) return;
        const html = katex.default.renderToString(latex, {
          throwOnError: true,
          displayMode: true,
          // No `trust`: a model's `\href` is not a link this application will
          // follow, and KaTeX drops it by default.
        });
        if (cancelled) return;
        setRendering({ kind: "latex", html });
      } catch {
        // Either the renderer could not be fetched or the LaTeX does not parse.
        // Both mean the same thing to the reader: show the paper.
        if (!cancelled) setRendering({ kind: "unavailable", why: "unparsable" });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [latex]);

  // --- fit it to the slot, without ever scrolling sideways ---------------------
  useLayoutEffect(() => {
    if (rendering.kind !== "latex") return;
    const surface = surfaceRef.current;
    if (surface === null) return;
    const natural = surface.scrollWidth;
    if (natural <= availableWidthPx + 1) {
      setScale(1);
      return;
    }
    const fitted = Math.max(MIN_FORMULA_SCALE, availableWidthPx / natural);
    // Past the floor the narrowest legible setting is still too wide: a formula
    // scaled below this is unreadable, and shrinking the *column* is not ours to
    // do — so the paper's own crop, which is already clamped, takes over.
    if (fitted <= MIN_FORMULA_SCALE && natural * MIN_FORMULA_SCALE > availableWidthPx + 1) {
      setRendering({ kind: "unavailable", why: "too-wide" });
      return;
    }
    setScale(fitted);
  }, [rendering, availableWidthPx]);

  const copyLatex = useCallback(() => {
    if (latex === null) return;
    void navigator.clipboard?.writeText(latex);
  }, [latex]);

  const typeset = rendering.kind === "latex" && !showOriginal;

  return (
    <div
      className="reflow-formula-container my-7 grid w-full grid-cols-[64px_1fr_64px] items-center gap-2"
      data-testid="reflow-formula-item"
      data-formula-id={blockId}
      data-render-mode={typeset ? "latex" : "crop"}
      data-formula-page={pageNumber}
    >
      {/* Slot 1 balances slot 3, so the formula's centre is the column's centre
          whatever the equation number's width. */}
      <div aria-hidden="true" />

      <div className="flex min-w-0 flex-col items-center justify-center">
        {typeset ? (
          <div
            ref={surfaceRef}
            tabIndex={0}
            role="button"
            aria-label="公式由模型重建：点击查看原版剪裁"
            data-testid="reflow-formula-math"
            onClick={() => setShowOriginal(true)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setShowOriginal(true);
              }
            }}
            style={{ transform: scale === 1 ? undefined : `scale(${scale})` }}
            className={cn(
              "group relative flex max-w-full cursor-pointer justify-center rounded px-2 py-1",
              "transition-colors hover:bg-muted/30 focus:outline-none focus:ring-1 focus:ring-primary",
            )}
          >
            <span
              data-testid="reflow-formula-container"
              className="select-all text-[1.125rem]"
              // KaTeX's own output, generated above with `trust` off; the only
              // HTML this application injects unattended.
              dangerouslySetInnerHTML={{ __html: rendering.html }}
            />
            <span
              data-testid="reflow-formula-badge"
              title="此公式由模型根据 PDF 字形还原，可能存在符号或下标偏差。点击可查看原版清晰剪裁。"
              className="absolute -top-3 right-1 select-none rounded bg-muted/80 px-1.5 py-0.5 text-2xs text-muted-foreground"
            >
              AI 重建 · 点击对比原图
            </span>
            <button
              type="button"
              data-testid="reflow-formula-copy"
              onClick={(event) => {
                event.stopPropagation();
                copyLatex();
              }}
              className="absolute -top-3 left-1 select-none rounded bg-muted/80 px-1.5 py-0.5 text-2xs text-muted-foreground opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100"
            >
              复制 LaTeX
            </button>
          </div>
        ) : (
          <div
            tabIndex={0}
            role="button"
            aria-label="原版剪裁：点击切回 LaTeX 排版"
            data-testid="reflow-formula-crop-toggle"
            onClick={() => {
              // Only a formula that *has* a typeset form toggles back to it.
              if (rendering.kind === "latex") setShowOriginal(false);
            }}
            onKeyDown={(event) => {
              if ((event.key === "Enter" || event.key === " ") && rendering.kind === "latex") {
                event.preventDefault();
                setShowOriginal(false);
              }
            }}
            className={cn(
              "flex max-w-full flex-col items-center rounded border border-amber-500/30 bg-amber-500/5 p-1",
              rendering.kind === "latex" && "cursor-pointer",
            )}
          >
            {crop}
            <span
              data-testid="reflow-formula-badge"
              className="mt-1 select-none rounded bg-amber-500/10 px-1.5 py-0.5 text-2xs text-amber-600"
            >
              {rendering.kind === "latex"
                ? "原版 PDF 剪裁 · 点击切回 LaTeX"
                : rendering.kind === "unavailable"
                  ? PROVENANCE[rendering.why]
                  : "正在载入排版引擎…"}
            </span>
            {rendering.kind !== "latex" && (refusalReason ?? failureReason ?? null) !== null && (
              <span className="mt-0.5 flex select-none items-start gap-1 text-2xs text-muted-foreground">
                <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                <span>{refusalReason ?? failureReason}</span>
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex w-16 select-none justify-end pr-1 text-xs text-muted-foreground">
        {number !== null && <span data-testid="reflow-formula-number">{number}</span>}
      </div>
    </div>
  );
}

/** Why the reader is looking at the paper instead of a reconstruction. */
const PROVENANCE: Record<string, string> = {
  "no-reconstruction": "未重建 · 原版 PDF 剪裁",
  unparsable: "重建结果无法解析 · 原版 PDF 剪裁",
  "too-wide": "公式过长 · 原版 PDF 剪裁",
  "load-failed": "排版引擎未能载入 · 原版 PDF 剪裁",
};
