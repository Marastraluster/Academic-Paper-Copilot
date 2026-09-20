/**
 * Reading and generating the paper's overview.
 *
 * Mirrors `notes/session.ts` and `translation/session.ts`, including their one
 * rule: **every asynchronous continuation re-checks the document after the
 * await, not before it.** A guard that runs when the work starts proves only
 * that it made sense to start, and the failure it guards here is the worst one
 * available — an overview of paper A rendered as though it were B's.
 *
 * ## Two operations, and only one of them can cost anything
 *
 * `loadOverview` reads. It runs when a paper opens and answers 404 when nothing
 * has been generated; it cannot reach a provider. `generateOverview` spends, and
 * **nothing calls it except a button the reader pressed**.
 */
import {
  fetchOverview,
  requestOverview,
  type OverviewView,
} from "@/api/overview";
import { isAbortError } from "@/api/client";
import { useWorkspaceStore } from "@/stores/workspace";

let activeRead: AbortController | null = null;
let activeReadDocument: string | null = null;
let activeGeneration: AbortController | null = null;

/** The language the overview is asked for. The interface is Chinese. */
export const OVERVIEW_LANGUAGE = "zh-CN";

/**
 * Is this overview still about the document in front of the reader?
 *
 * The backend already refuses an overview from a previous extraction when it
 * answers, so this is the belt to that pair of braces: the check is made again
 * against the IR the reader is actually looking at, because the artifact and the
 * document are fetched by two different requests and nothing guarantees they
 * arrived together.
 */
export function overviewIsCurrent(
  overview: OverviewView | null,
  contentHash: string,
): boolean {
  if (!overview) return false;
  if (overview.status !== "READY" && overview.status !== "PARTIAL") return false;
  return overview.content_hash === contentHash;
}

/** Read the stored overview, if there is one. Never generates. */
export async function loadOverview(): Promise<void> {
  const state = useWorkspaceStore.getState();
  const document = state.document;
  if (!document || document.documentId === null) return;

  const { documentId } = document;
  if (activeRead !== null && activeReadDocument === documentId) return;

  activeRead?.abort();
  const controller = new AbortController();
  activeRead = controller;
  activeReadDocument = documentId;

  // What the store held when this read started. A read that began before a
  // generation and lands after it must not replace the generated overview with
  // the `null` it was always going to find — the reader would watch their
  // overview disappear at the moment it arrived.
  const before = useWorkspaceStore.getState().overview;

  useWorkspaceStore.setState({ overviewStatus: "loading", overviewError: null });
  try {
    const overview = await fetchOverview(documentId, OVERVIEW_LANGUAGE, {
      signal: controller.signal,
    });
    // Guarded on the **document**, not on the session token: an overview belongs
    // to the paper's content, and reopening the same file mints a new token.
    if (useWorkspaceStore.getState().document?.documentId !== documentId) return;
    if (useWorkspaceStore.getState().overview !== before) return;
    useWorkspaceStore.setState({
      overview,
      overviewFor: documentId,
      overviewStatus: "ready",
    });
  } catch (error) {
    if (isAbortError(error)) return;
    if (useWorkspaceStore.getState().document?.documentId !== documentId) return;
    if (useWorkspaceStore.getState().overview !== before) return;
    useWorkspaceStore.setState({
      overview: null,
      overviewFor: documentId,
      overviewStatus: "ready",
      overviewError: "未能读取已有概览。",
    });
  } finally {
    if (activeRead === controller) {
      activeRead = null;
      activeReadDocument = null;
    }
  }
}

export type GenerateOutcome = { ok: true } | { ok: false; reason: string };

/**
 * Generate the overview. **Only a reader action may call this.**
 *
 * Returns a reason rather than throwing: the three ways this fails mean three
 * different things to the reader — the provider was unreachable, the paper could
 * not be structured, or they left before it finished — and one message for all
 * three teaches them nothing about what to do.
 */
export async function generateOverview(): Promise<GenerateOutcome> {
  const state = useWorkspaceStore.getState();
  const document = state.document;
  if (!document || document.documentId === null) {
    return { ok: false, reason: "请先打开一篇论文。" };
  }
  if (!state.profileId) {
    return { ok: false, reason: "请先配置可用的模型服务。" };
  }

  const { documentId, sessionToken } = document;
  activeGeneration?.abort();
  const controller = new AbortController();
  activeGeneration = controller;
  useWorkspaceStore.setState({
    overviewStatus: "generating",
    overviewError: null,
    overviewStartedAt: Date.now(),
  });

  try {
    const overview = await requestOverview(
      documentId, state.profileId, OVERVIEW_LANGUAGE,
      { signal: controller.signal, force: true },
    );
    if (
      useWorkspaceStore.getState().document?.documentId !== documentId ||
      useWorkspaceStore.getState().document?.sessionToken !== sessionToken
    ) {
      // The reader moved on. The answer is not theirs to see and is **not written
      // into the store** — a late overview attached to a new document is the one
      // failure this module exists to prevent. The backend has already cached it
      // under the paper's own content hash, so nothing was wasted: it will be
      // found the next time that paper is opened.
      return { ok: false, reason: "已切换到其他文档，本次概览结果未显示。" };
    }
    useWorkspaceStore.setState({
      overview,
      overviewFor: documentId,
      overviewStatus: "ready",
      overviewStartedAt: null,
    });
    return { ok: true };
  } catch (error) {
    if (isAbortError(error)) {
      useWorkspaceStore.setState({ overviewStatus: "ready", overviewStartedAt: null });
      return { ok: false, reason: "已取消。" };
    }
    if (useWorkspaceStore.getState().document?.documentId !== documentId) {
      return { ok: false, reason: "已切换到其他文档，本次概览结果未显示。" };
    }
    const reason = describeGenerationFailure(error);
    useWorkspaceStore.setState({
      overviewStatus: "failed",
      overviewStartedAt: null,
      overviewError: reason,
    });
    return { ok: false, reason };
  } finally {
    if (activeGeneration === controller) activeGeneration = null;
  }
}

/**
 * The provider's failure, in the reader's terms.
 *
 * The kinds are kept distinct because the reader's next action differs for each:
 * fix a key or wait out a network, try a different paper, or do nothing because
 * they already left.
 */
function describeGenerationFailure(error: unknown): string {
  const status = (error as { status?: number })?.status;
  if (status === 401 || status === 403) {
    return "模型服务拒绝了这次请求，请检查 API 密钥配置。";
  }
  if (status === 429) {
    return "模型服务请求过于频繁，请稍后重试。";
  }
  if (status === 502 || status === 503 || status === 504) {
    return "AI 服务暂时不可用，请检查网络或模型配置后重试。";
  }
  if (status === 400 || status === 422) {
    return "这篇论文的结构无法解析，暂时无法生成概览。";
  }
  return "概览生成失败，请稍后重试。";
}

/** Cancel whatever is running, for a document that is closing or changing. */
export function teardownOverview(): void {
  activeRead?.abort();
  activeRead = null;
  activeReadDocument = null;
  activeGeneration?.abort();
  activeGeneration = null;
  useWorkspaceStore.setState({
    overview: null,
    overviewFor: null,
    overviewStatus: "idle",
    overviewError: null,
    overviewStartedAt: null,
  });
}
