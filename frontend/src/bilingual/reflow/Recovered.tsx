/**
 * Figures, tables, formulas and code as a structural parser (MinerU) recovered
 * them — drawn as themselves rather than as crops of the page.
 *
 * Every one of these keeps the page crop one click away, because a parser can be
 * wrong and the paper cannot: a table whose cells were misread, a formula whose
 * subscript was lost. The reader can always see what was printed.
 *
 * Table HTML comes from outside this application, so it is **rebuilt from a
 * whitelist**, never inserted as received: only table structure, a few inline
 * formatting tags and `colspan`/`rowspan` survive. Anything else — scripts,
 * event handlers, links, images, styles — is dropped.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { assetUrl } from "@/api/bilingual";
import { MathText, loadKatex } from "@/bilingual/reflow/MathText";
import { cn } from "@/lib/utils";

const TABLE_TAGS = new Set([
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col",
  "br", "sub", "sup", "b", "i", "em", "strong", "span", "p",
]);
const SPAN_ATTRS = new Set(["colspan", "rowspan"]);

/** The table's structure and text, and nothing that could execute or load. */
export function sanitizeTableHtml(html: string): string {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const out = document.implementation.createHTMLDocument("");

  const copy = (node: Node, into: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        // Private-use code points are a PDF font's own glyph slots (the tall
        // brackets of a stacked cell, typically). Outside that font they are
        // empty boxes, and they say nothing a reader can use.
        into.appendChild(out.createTextNode((child.textContent ?? "").replace(PRIVATE_USE, "")));
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const element = child as Element;
      const tag = element.tagName.toLowerCase();
      if (!TABLE_TAGS.has(tag)) {
        // Unknown wrapper: keep its text, drop the element. `script`/`style`
        // content is not text a reader should see either.
        if (tag !== "script" && tag !== "style") copy(element, into);
        continue;
      }
      const clean = out.createElement(tag);
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name.toLowerCase();
        if (SPAN_ATTRS.has(name) && /^\d{1,3}$/.test(attribute.value)) {
          clean.setAttribute(name, attribute.value);
        }
      }
      copy(element, clean);
      into.appendChild(clean);
    }
  };

  const holder = out.createElement("div");
  copy(parsed.body, holder);
  markNumericColumns(holder);
  return holder.innerHTML;
}

const PRIVATE_USE = /[\uE000-\uF8FF]/g;
const NUMERIC = /^[-+−–]?\s?[\d.,]+\s?(?:%|×\d*|[kKmMbB])?(?:\s?[±/]\s?[\d.,]+%?)?$/;

/**
 * Right-align the columns that hold only numbers, so the digits line up.
 *
 * Decided per column, never per cell — a column that mixes a number with a word
 * stays as it was. A table with merged cells is left alone: its columns cannot
 * be counted by position without reproducing the browser's own span layout.
 */
function markNumericColumns(holder: Element): void {
  for (const table of Array.from(holder.querySelectorAll("table"))) {
    const rows = Array.from(table.querySelectorAll("tr")).map((row) => Array.from(row.children));
    if (rows.length < 3) continue;
    if (rows.some((cells) => cells.some((cell) => cell.hasAttribute("colspan") || cell.hasAttribute("rowspan")))) {
      continue;
    }
    const width = Math.max(...rows.map((cells) => cells.length));
    // The first row is the header, and the first column names the rows.
    for (let column = 1; column < width; column += 1) {
      const body = rows.slice(1).map((cells) => cells[column]).filter((cell) => cell !== undefined);
      const filled = body.filter((cell) => (cell.textContent ?? "").trim() !== "");
      if (filled.length < 2) continue;
      if (!filled.every((cell) => NUMERIC.test((cell.textContent ?? "").trim()))) continue;
      for (const cells of rows) cells[column]?.setAttribute("data-num", "");
    }
  }
}

/** The table as text a spreadsheet will take: one row per line, cells tab-separated. */
export function tableToText(html: string): string {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  return Array.from(parsed.querySelectorAll("tr"))
    .map((row) =>
      Array.from(row.children)
        .map((cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim())
        .join("\t"),
    )
    .join("\n");
}

/** Below this a table's text is no longer text a reader should be asked to read. */
const MIN_TABLE_TEXT_PX = 11;
const MIN_TABLE_FIT = 0.7;

/**
 * A table sized to the column when that is honest, and scrolled when it is not.
 *
 * Measured in the browser, not estimated: the table is laid out at full size,
 * and if it is wider than the column it is set smaller — but only down to 70 %
 * and never below 11 px text. A table that would need more than that (a
 * 25-column one, say) keeps its natural size inside its own scroller; shrinking
 * it to fit would produce a table nobody can read. The reading column itself
 * never scrolls sideways either way.
 */
function FittedTable({ html }: { html: string }) {
  const wrapper = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState<{ mode: "fits" | "wrapped" | "scaled" | "scroll"; scale: number }>({
    mode: "fits",
    scale: 1,
  });

  useLayoutEffect(() => {
    const element = wrapper.current;
    if (element === null) return;
    const measure = () => {
      element.style.setProperty("--table-scale", "1");
      element.removeAttribute("data-wrap");
      const available = element.clientWidth;
      if (element.scrollWidth === 0 || available === 0 || element.scrollWidth <= available + 1) {
        setFit({ mode: "fits", scale: 1 });
        return;
      }
      // Too wide on one line per cell. A table of sentences (a comparison of
      // methods, say) only needs its cells to wrap; a table of numbers does not
      // get narrower that way, and goes on to be scaled or scrolled.
      element.setAttribute("data-wrap", "");
      if (element.scrollWidth <= available + 1) {
        setFit({ mode: "wrapped", scale: 1 });
        return;
      }
      const natural = element.scrollWidth;
      const scale = available / natural;
      const base = Number.parseFloat(getComputedStyle(element.querySelector("table") ?? element).fontSize) || 13;
      if (scale >= MIN_TABLE_FIT && base * scale >= MIN_TABLE_TEXT_PX) {
        // A hair under, so rounding never leaves a one-pixel scrollbar.
        setFit({ mode: "scaled", scale: Math.floor(scale * 1000 - 2) / 1000 });
      } else {
        setFit({ mode: "scroll", scale: 1 });
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      measure();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [html]);

  return (
    <>
      <div
        ref={wrapper}
        data-testid="recovered-table-scroller"
        data-fit={fit.mode}
        data-wrap={fit.mode === "fits" ? undefined : ""}
        className="overflow-x-auto"
        style={{ ["--table-scale" as string]: String(fit.scale) }}
        // A scroller that cannot be focused cannot be scrolled from the keyboard.
        tabIndex={fit.mode === "scroll" ? 0 : undefined}
        role={fit.mode === "scroll" ? "region" : undefined}
        aria-label={fit.mode === "scroll" ? "宽表格，可横向滚动" : undefined}
      >
        <div data-testid="recovered-table" className="reflow-table" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
      {fit.mode === "scroll" && (
        <p data-testid="recovered-table-wide" className="select-none text-center text-2xs text-muted-foreground">
          表格较宽，按原尺寸显示，可横向滚动
        </p>
      )}
    </>
  );
}

function ShowOriginal({
  showing,
  onToggle,
  label,
}: {
  showing: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      data-testid="recovered-toggle"
      aria-pressed={showing}
      onClick={onToggle}
      className="select-none rounded-full bg-primary/10 px-2 py-0.5 text-2xs font-medium text-primary transition-colors hover:bg-primary/15"
    >
      {showing ? "论文原图 · 点击切回" : `${label} · 点击看原图`}
    </button>
  );
}

/** A display formula from its LaTeX, numbered as the paper numbered it. */
export function RecoveredFormula({
  latex,
  number,
  crop,
}: {
  latex: string;
  number: string | null;
  crop: ReactNode;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [original, setOriginal] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadKatex()
      .then((katex) => {
        if (cancelled) return;
        setHtml(katex.renderToString(latex, { throwOnError: true, displayMode: true }));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [latex]);

  if (failed) return <>{crop}</>;
  return (
    <figure data-testid="recovered-formula" className="group my-5">
      <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center gap-2">
        <div aria-hidden="true" />
        <div className="min-w-0 overflow-x-auto">
          {original || html === null ? (
            crop
          ) : (
            <div
              className="reflow-display-math"
              role="math"
              aria-label={latex}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}
        </div>
        <span className="flex select-none justify-end pr-1 text-xs text-muted-foreground">
          {number ?? ""}
        </span>
      </div>
      <div className="mt-1 flex justify-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <ShowOriginal showing={original} onToggle={() => setOriginal((v) => !v)} label="MinerU 识别" />
      </div>
    </figure>
  );
}

/** A figure or table drawn from what the parser recovered, captions bilingual. */
export function RecoveredVisual({
  documentId,
  layoutClass,
  html,
  imagePath,
  code,
  caption,
  captionTranslated,
  footnote,
  crop,
}: {
  documentId: string;
  layoutClass: string;
  html: string | null;
  imagePath: string | null;
  code: string | null;
  caption: string | null;
  captionTranslated: string | null;
  footnote: string | null;
  crop: ReactNode;
}) {
  const [original, setOriginal] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [copied, setCopied] = useState(false);
  const isTable = layoutClass === "table";
  const cleanTable = isTable && html ? sanitizeTableHtml(html) : null;
  const captionAbove = isTable;

  const captionNode =
    caption !== null ? (
      <figcaption data-testid="reflow-caption" className="text-[0.8125rem] leading-[1.55] text-muted-foreground">
        <MathText text={caption} />
        {captionTranslated ? (
          <span className="mt-0.5 block text-foreground/70">
            <MathText text={captionTranslated} />
          </span>
        ) : null}
      </figcaption>
    ) : null;

  let body: ReactNode;
  if (original) {
    body = crop;
  } else if (code !== null) {
    body = (
      <pre className="overflow-x-auto rounded-lg bg-muted/60 p-3 text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
    );
  } else if (cleanTable) {
    body = <FittedTable html={cleanTable} />;
  } else if (imagePath) {
    body = (
      <button
        type="button"
        onClick={() => setZoomed((v) => !v)}
        aria-label={zoomed ? "缩小图片" : "放大图片"}
        className={cn(
          "block w-full cursor-zoom-in overflow-hidden rounded-lg bg-white transition-transform duration-500",
          zoomed && "cursor-zoom-out",
        )}
      >
        <img
          data-testid="recovered-image"
          src={assetUrl(documentId, imagePath)}
          alt={caption ?? "论文中的图"}
          loading="lazy"
          className={cn("mx-auto max-h-[70vh] w-auto max-w-full transition-transform duration-500", zoomed && "max-h-none")}
        />
      </button>
    );
  } else {
    body = crop;
  }

  return (
    <figure data-testid="recovered-visual" data-layout-class={layoutClass} className="group my-6 flex flex-col gap-2">
      {captionAbove && captionNode}
      {body}
      {!captionAbove && captionNode}
      {footnote !== null && (
        <p data-testid="reflow-footnote" className="text-xs leading-[1.4] text-muted-foreground">
          <MathText text={footnote} />
        </p>
      )}
      {(cleanTable || imagePath || code !== null) && (
        <div className="flex justify-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <ShowOriginal showing={original} onToggle={() => setOriginal((v) => !v)} label="MinerU 识别" />
          {cleanTable && !original && (
            <button
              type="button"
              data-testid="recovered-table-copy"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(tableToText(cleanTable))
                  .then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1600);
                  })
                  .catch(() => undefined);
              }}
              className="select-none rounded-full bg-muted px-2 py-0.5 text-2xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {copied ? "已复制" : "复制表格"}
            </button>
          )}
        </div>
      )}
    </figure>
  );
}
