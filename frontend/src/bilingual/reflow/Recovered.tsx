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
import { useEffect, useState, type ReactNode } from "react";

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
        into.appendChild(out.createTextNode(child.textContent ?? ""));
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
  return holder.innerHTML;
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
    body = (
      <div className="overflow-x-auto">
        <div
          data-testid="recovered-table"
          className="reflow-table"
          dangerouslySetInnerHTML={{ __html: cleanTable }}
        />
      </div>
    );
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
        <div className="flex justify-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <ShowOriginal showing={original} onToggle={() => setOriginal((v) => !v)} label="MinerU 识别" />
        </div>
      )}
    </figure>
  );
}
