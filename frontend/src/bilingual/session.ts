/**
 * Reading and generating the paragraph-aligned column (逐段对照).
 *
 * Mirrors `overview/session.ts`, including its one rule: **every asynchronous
 * continuation re-checks the document after the await, not before it.** The
 * failure that guards against is the worst one available — paper A's paragraphs
 * rendered under paper B's title.
 *
 * ## Two operations, and only one of them can cost anything
 *
 * `loadBilingual` reads. It cannot reach a provider, and it runs when the column
 * is opened rather than when a paper is, because the artifact is the whole paper
 * in two languages — a hundred-odd paragraphs — and a reader who never opens this
 * view should not pay for it in bytes or in memory.
 *
 * `generateBilingual` spends, and **nothing calls it except a button the reader
 * pressed**. The number of provider calls it will make is computed from the IR by
 * the backend's own plan, so the disclosure and the work cannot disagree.
 */
import {
  fetchBilingual,
  requestBilingual,
  type BilingualView,
} from "@/api/bilingual";
import { isAbortError } from "@/api/client";
import { useWorkspaceStore } from "@/stores/workspace";

// The column's own work is torn down by the column's own module — see below.

let activeRead: AbortController | null = null;
let activeReadDocument: string | null = null;
let activeGeneration: AbortController | null = null;

/** The language the column is asked for. The interface is Chinese. */
export const BILINGUAL_LANGUAGE = "zh-CN";

/**
 * Is this reading still about the document in front of the reader?
 *
 * The backend refuses an artifact from a previous extraction when it answers;
 * this is the belt to that pair of braces, because the artifact and the document
 * arrive from two different requests.
 */
export function bilingualIsCurrent(
  view: BilingualView | null,
  contentHash: string,
): boolean {
  if (!view) return false;
  if (view.status !== "READY" && view.status !== "PARTIAL") return false;
  return view.content_hash === contentHash;
}

/** Read the stored reading. Never generates one. */
export async function loadBilingual(): Promise<void> {
  watchTheDocument();
  const state = useWorkspaceStore.getState();
  const document = state.document;
  if (!document || document.documentId === null) return;

  const { documentId } = document;
  if (activeRead !== null && activeReadDocument === documentId) return;

  activeRead?.abort();
  const controller = new AbortController();
  activeRead = controller;
  activeReadDocument = documentId;

  const before = useWorkspaceStore.getState().bilingual;
  useWorkspaceStore.setState({ bilingualStatus: "loading", bilingualError: null });
  try {
    const read = await fetchBilingual(documentId, BILINGUAL_LANGUAGE, {
      signal: controller.signal,
    });
    if (useWorkspaceStore.getState().document?.documentId !== documentId) return;
    if (useWorkspaceStore.getState().bilingual !== before) return;
    useWorkspaceStore.setState({
      bilingual: read.state === "found" ? read.view : null,
      bilingualPlan: read.state === "none" ? read.plan : null,
      bilingualFor: documentId,
      bilingualStatus: "ready",
    });
  } catch (error) {
    if (isAbortError(error)) return;
    if (useWorkspaceStore.getState().document?.documentId !== documentId) return;
    if (useWorkspaceStore.getState().bilingual !== before) return;
    useWorkspaceStore.setState({
      bilingual: null,
      bilingualFor: documentId,
      bilingualStatus: "ready",
      bilingualError: "未能读取已有的逐段对照。",
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
 * Generate the column. **Only a reader action may call this.**
 *
 * Returns a reason rather than throwing: the failures mean different things to
 * the reader — the provider was unreachable, another run is already going, or
 * they left before it finished — and one message for all three teaches them
 * nothing about what to do.
 */
export async function generateBilingual(): Promise<GenerateOutcome> {
  watchTheDocument();
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
    bilingualStatus: "generating",
    bilingualError: null,
    bilingualStartedAt: Date.now(),
  });

  try {
    const view = await requestBilingual(
      documentId, state.profileId, BILINGUAL_LANGUAGE,
      { signal: controller.signal, force: true },
    );
    if (
      useWorkspaceStore.getState().document?.documentId !== documentId ||
      useWorkspaceStore.getState().document?.sessionToken !== sessionToken
    ) {
      // The reader moved on. The answer is not theirs to see and is **not written
      // into the store**; the backend has already cached it under the paper's own
      // content hash, so nothing was wasted.
      return { ok: false, reason: "已切换到其他文档，本次逐段对照未显示。" };
    }
    useWorkspaceStore.setState({
      bilingual: view,
      bilingualFor: documentId,
      bilingualStatus: "ready",
      bilingualStartedAt: null,
    });
    return { ok: true };
  } catch (error) {
    if (isAbortError(error)) {
      useWorkspaceStore.setState({ bilingualStatus: "ready", bilingualStartedAt: null });
      return { ok: false, reason: "已取消。" };
    }
    if (useWorkspaceStore.getState().document?.documentId !== documentId) {
      return { ok: false, reason: "已切换到其他文档，本次逐段对照未显示。" };
    }
    const reason = describeFailure(error);
    useWorkspaceStore.setState({
      bilingualStatus: "failed",
      bilingualStartedAt: null,
      bilingualError: reason,
    });
    return { ok: false, reason };
  } finally {
    if (activeGeneration === controller) activeGeneration = null;
  }
}

/**
 * The provider's failure, in the reader's terms.
 *
 * The kinds stay distinct because the next action differs: fix a key, wait, try
 * another paper — or, for a run already going, do nothing at all.
 */
function describeFailure(error: unknown): string {
  const status = (error as { status?: number })?.status;
  if (status === 401 || status === 403) return "模型服务拒绝了这次请求，请检查 API 密钥配置。";
  if (status === 429) return "模型服务请求过于频繁，请稍后重试。";
  if (status === 409) return "这篇论文的逐段对照正在生成中，请稍候。";
  if (status === 502 || status === 503 || status === 504) {
    return "AI 服务暂时不可用，请检查网络或模型配置后重试。";
  }
  if (status === 400 || status === 422) return "这篇论文的结构无法解析，暂时无法生成逐段对照。";
  return "逐段对照生成失败，请稍后重试。";
}

/**
 * Watch for the document changing, and stop when it does.
 *
 * The alternative was for the document lifecycle to call in here, which meant
 * importing this module — and with it the API client, three kilobytes of guards
 * and messages — into the *initial* bundle, for a column most readers never open.
 * A subscription costs nothing until this module is loaded, and this module is
 * only loaded when there is a column that could be doing work: a generation
 * started from the column, or a read the column asked for.
 *
 * Installed once, on the first load.
 */
let watching = false;
function watchTheDocument(): void {
  if (watching) return;
  watching = true;
  let token = useWorkspaceStore.getState().document?.sessionToken ?? null;
  useWorkspaceStore.subscribe((state) => {
    const current = state.document?.sessionToken ?? null;
    if (current === token) return;
    token = current;
    teardownBilingual();
  });
}

/** Cancel whatever is running, for a document that is closing or changing. */
function teardownBilingual(): void {
  activeRead?.abort();
  activeRead = null;
  activeReadDocument = null;
  activeGeneration?.abort();
  activeGeneration = null;
  useWorkspaceStore.setState({
    bilingual: null,
    bilingualPlan: null,
    bilingualFor: null,
    bilingualStatus: "idle",
    bilingualError: null,
    bilingualStartedAt: null,
  });
}
