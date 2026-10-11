import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Maximize2, Minus, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface PdfToolbarProps {
  currentPage: number;
  pageCount: number;
  scale: number;
  fitWidth: boolean;
  onJumpToPage: (page: number) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onToggleFitWidth: () => void;
}

/**
 * Compact reading controls. Deliberately small: the PDF is the protagonist, and
 * a tall header would take reading space from it.
 */
export function PdfToolbar({
  currentPage,
  pageCount,
  scale,
  fitWidth,
  onJumpToPage,
  onZoomIn,
  onZoomOut,
  onToggleFitWidth,
}: PdfToolbarProps) {
  const [draft, setDraft] = useState(String(currentPage));

  // Follow the viewer unless the user is mid-edit.
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(String(currentPage));
  }, [currentPage, editing]);

  // The reflowed reading hides its controls while the reader scrolls down;
  // the dock follows it, so the paper gets the whole height.
  const [tucked, setTucked] = useState(false);
  useEffect(() => {
    const listen = (event: Event) =>
      setTucked(Boolean((event as CustomEvent<{ hidden: boolean }>).detail?.hidden));
    window.addEventListener("reflow-chrome", listen);
    return () => window.removeEventListener("reflow-chrome", listen);
  }, []);

  const commit = () => {
    setEditing(false);
    const parsed = Number.parseInt(draft, 10);
    if (Number.isFinite(parsed)) {
      onJumpToPage(Math.min(Math.max(parsed, 1), pageCount));
    } else {
      setDraft(String(currentPage));
    }
  };

  return (
    // A floating glass dock at the bottom of the page, out of the reading
    // column's way: the PDF is the protagonist and gets the full height.
    <div
      role="toolbar"
      aria-label="页面控制"
      data-testid="pdf-dock"
      data-hidden={tucked ? "true" : undefined}
      className={cn(
        "glass absolute bottom-5 left-1/2 z-20 flex h-[52px] -translate-x-1/2 items-center gap-0.5 rounded-full px-2 transition-[transform,opacity] duration-500 ease-spring hover:scale-[1.03]",
        tucked && "pointer-events-none translate-y-[140%] opacity-0",
      )}
    >
      <Button
        variant="ghost"
        size="icon"
        aria-label="上一页"
        disabled={currentPage <= 1}
        onClick={() => onJumpToPage(currentPage - 1)}
      >
        <ChevronLeft />
      </Button>

      <input
        data-testid="page-number-input"
        aria-label="页码"
        data-plain
        className="glass-track h-[30px] w-10 rounded-[10px] border-0 px-1 text-center text-[13px] tabular-nums focus-visible:bg-[var(--glass-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        value={draft}
        onChange={(event) => {
          setEditing(true);
          setDraft(event.target.value);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
      />
      <span className="whitespace-nowrap px-1.5 text-[13px] tabular-nums text-muted-foreground">
        / {pageCount}
      </span>

      <Button
        variant="ghost"
        size="icon"
        aria-label="下一页"
        disabled={currentPage >= pageCount}
        onClick={() => onJumpToPage(currentPage + 1)}
      >
        <ChevronRight />
      </Button>

      <span aria-hidden="true" className="mx-1.5 h-[22px] w-px bg-[var(--glass-line)]" />

      <Button
        variant="ghost"
        size="icon"
        aria-label="缩小"
        onClick={onZoomOut}
      >
        <Minus />
      </Button>
      <span className="w-[52px] text-center text-[13px] tabular-nums">
        {Math.round(scale * 100)}%
      </span>
      <Button variant="ghost" size="icon" aria-label="放大" onClick={onZoomIn}>
        <Plus />
      </Button>

      <Button
        data-testid="fit-width-btn"
        variant="ghost"
        size="icon"
        aria-label="适应宽度"
        aria-pressed={fitWidth}
        className={cn(fitWidth && "bg-[var(--glass-strong)] text-primary shadow-[var(--glass-highlight)]")}
        onClick={onToggleFitWidth}
      >
        <Maximize2 />
      </Button>
    </div>
  );
}
