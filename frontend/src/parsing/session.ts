/**
 * Re-parsing the open paper with MinerU, and swapping in the better IR.
 *
 * The same rule as every session module here: each continuation re-checks the
 * document after the await, so a parse of paper A never lands on paper B.
 */
import { fetchIr } from "@/api/ir";
import { fetchParseState, PARSE_ACTIVE, startParse, type ParseState } from "@/api/parsing";
import { describeApiError } from "@/translation/errors";
import { loadBilingual } from "@/bilingual/session";
import { useWorkspaceStore } from "@/stores/workspace";

const POLL_MS = 2000;

export type ParseOutcome = { ok: true; state: ParseState } | { ok: false; reason: string };

const LABELS: Record<string, string> = {
  pending: "准备中",
  uploading: "正在上传",
  queued: "排队中",
  running: "MinerU 正在解析",
  converting: "正在整理结构",
};

export function describeParse(state: ParseState | null): string {
  if (state === null) return "";
  return LABELS[state.status] ?? "";
}

/**
 * Parse with the given MinerU profile. Calls `onProgress` with each state, and
 * when it completes re-reads the IR so the reading and the sidebar use it.
 */
export async function parseWithMinerU(
  profileId: string,
  onProgress: (state: ParseState) => void,
): Promise<ParseOutcome> {
  const document = useWorkspaceStore.getState().document;
  if (!document || document.documentId === null) return { ok: false, reason: "请先打开一篇论文。" };
  const { documentId, sessionToken } = document;
  const stillHere = () => useWorkspaceStore.getState().document?.sessionToken === sessionToken;

  try {
    let state = await startParse(documentId, profileId);
    onProgress(state);
    while (PARSE_ACTIVE.has(state.status)) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      if (!stillHere()) return { ok: false, reason: "已切换到其他文档。" };
      state = await fetchParseState(documentId);
      onProgress(state);
    }
    if (state.status !== "completed") {
      return { ok: false, reason: state.message ? `解析失败：${state.message}` : "解析失败，请检查 MinerU 服务。" };
    }
    const ir = await fetchIr(documentId);
    if (!stillHere()) return { ok: false, reason: "已切换到其他文档。" };
    // A new IR renumbers paragraphs: the old reading no longer describes it.
    useWorkspaceStore.setState({ ir, bilingual: null, bilingualFor: null, bilingualPlan: null });
    void loadBilingual();
    return { ok: true, state };
  } catch (error) {
    return { ok: false, reason: describeApiError(error).detail };
  }
}
