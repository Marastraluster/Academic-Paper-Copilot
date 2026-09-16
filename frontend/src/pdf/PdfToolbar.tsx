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
    // h-10 / 40px: the specified desktop density token. Compact, but not so
    // tight that the page controls lose their hit targets.
    <div className="flex h-10 shrink-0 items-center gap-1 border-b bg-card px-2">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="上一页"
        disabled={currentPage <= 1}
        onClick={() => onJumpToPage(currentPage - 1)}
      >
        <ChevronLeft />
      </Button>

      <input
        data-testid="page-number-input"
        aria-label="页码"
        className="h-6 w-10 rounded border bg-background px-1 text-center text-xs tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
      <span className="text-xs tabular-nums text-muted-foreground">
        / {pageCount}
      </span>

      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="下一页"
        disabled={currentPage >= pageCount}
        onClick={() => onJumpToPage(currentPage + 1)}
      >
        <ChevronRight />
      </Button>

      <div className="mx-1 h-4 w-px bg-border" />

      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="缩小"
        onClick={onZoomOut}
      >
        <Minus />
      </Button>
      <span className="w-10 text-center text-xs tabular-nums text-muted-foreground">
        {Math.round(scale * 100)}%
      </span>
      <Button variant="ghost" size="icon-sm" aria-label="放大" onClick={onZoomIn}>
        <Plus />
      </Button>

      <Button
        data-testid="fit-width-btn"
        variant={fitWidth ? "secondary" : "ghost"}
        size="icon-sm"
        aria-label="适应宽度"
        aria-pressed={fitWidth}
        className={cn(fitWidth && "text-foreground")}
        onClick={onToggleFitWidth}
      >
        <Maximize2 />
      </Button>
    </div>
  );
}
