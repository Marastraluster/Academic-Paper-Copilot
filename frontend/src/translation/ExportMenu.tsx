import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";

import { apiUrl } from "@/api/config";
import { Button } from "@/components/ui/button";
import { selectHasTranslation, useWorkspaceStore } from "@/stores/workspace";

/**
 * Download the translation artifacts.
 *
 * This is where the dual (interleaved) PDF belongs. It is 2N pages — page 1
 * original, page 1 translated, page 2 original, … — which makes it useless as a
 * side-by-side reading surface but exactly right for printing or offline study.
 * The reader never loads it; only this menu offers it.
 *
 * Plain anchor downloads rather than a fetched blob: the browser then streams
 * the file straight to disk, so there is no object URL to own or revoke.
 */
export function ExportMenu() {
  const hasTranslation = useWorkspaceStore(selectHasTranslation);
  const documentId = useWorkspaceStore((s) => s.document?.documentId ?? null);
  const name = useWorkspaceStore((s) => s.document?.name ?? "document.pdf");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Close on an outside click or Escape, the two ways a menu is expected to go.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // A translation is what these download, so without one there is nothing to
  // offer — and a disabled control that explains itself beats a hidden one.
  if (!hasTranslation || !documentId) {
    return (
      <Button
        size="sm"
        variant="ghost"
        className="shrink-0 gap-1.5"
        data-testid="export-menu-trigger"
        aria-label="导出"
        disabled
      >
        <Download className="h-3.5 w-3.5" />
        导出
      </Button>
    );
  }

  const stem = name.replace(/\.pdf$/i, "");

  return (
    <div ref={containerRef} className="relative shrink-0">
      <Button
        size="sm"
        variant="ghost"
        className="gap-1.5"
        data-testid="export-menu-trigger"
        aria-label="导出"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
      >
        <Download className="h-3.5 w-3.5" />
        导出
      </Button>

      {open && (
        <div
          role="menu"
          data-testid="export-menu"
          className="absolute right-0 z-40 mt-1 w-52 rounded-md border bg-card p-1 shadow-md"
        >
          <a
            role="menuitem"
            data-testid="export-translated"
            href={apiUrl(`/api/documents/${encodeURIComponent(documentId)}/translated`)}
            download={`${stem}-译文.pdf`}
            className="block rounded px-2 py-1.5 text-xs hover:bg-accent"
            onClick={() => setOpen(false)}
          >
            下载译文 PDF
          </a>
          <a
            role="menuitem"
            data-testid="export-bilingual"
            href={apiUrl(`/api/documents/${encodeURIComponent(documentId)}/bilingual`)}
            download={`${stem}-双语对照.pdf`}
            className="block rounded px-2 py-1.5 text-xs hover:bg-accent"
            onClick={() => setOpen(false)}
          >
            下载双语对照 PDF（逐页交替）
          </a>
        </div>
      )}
    </div>
  );
}
