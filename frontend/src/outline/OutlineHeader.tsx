import { FileText } from "lucide-react";

import { useWorkspaceStore } from "@/stores/workspace";

/** The outline tab's heading and controls.
 *
 * In its own module so the panel it labels can be lazily loaded while the
 * header, which is one line of chrome, stays in the initial chunk. They
 * shared a file and that is what kept the whole outline in the first
 * download.
 */
export function OutlineHeader() {
  const title = useWorkspaceStore((s) => s.document?.name ?? null);
  const sections = useWorkspaceStore((s) => s.sections);
  if (title === null) return null;
  return (
    <div className="flex items-center gap-1.5 border-b px-3 py-2">
      <FileText className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 truncate text-xs font-medium" title={title}>
        {title}
      </span>
      {sections && sections.length > 0 && (
        <span className="ml-auto shrink-0 text-2xs text-muted-foreground">
          {sections.length} 节
        </span>
      )}
    </div>
  );
}
