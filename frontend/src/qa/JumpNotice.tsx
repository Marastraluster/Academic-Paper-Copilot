/**
 * Says what a citation click did to the reader.
 *
 * Only two things ever put a message here, and both are about the reader having
 * been moved without the user asking: a citation clicked in translation mode
 * switches to the original, and a reader who is not told why has lost their
 * place with no explanation. Dismissible, and it says how to get back.
 *
 * The wrapper is what stays eager: it reads one field and decides whether there
 * is anything to say. The banner itself — its markup, its close button, its icon
 * — only exists once there is a message, which is never on the first paint. That
 * is two and a half kilobytes the reader does not download to open a paper.
 */
import { Suspense, lazy } from "react";

import { useWorkspaceStore } from "@/stores/workspace";

const JumpNoticeBody = lazy(() => import("@/qa/JumpNoticeBody"));

export function JumpNotice() {
  const notice = useWorkspaceStore((s) => s.notice);
  if (!notice) return null;
  return (
    <Suspense fallback={null}>
      <JumpNoticeBody notice={notice} />
    </Suspense>
  );
}
