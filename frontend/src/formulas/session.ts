/**
 * Drives one document's formula reconstruction from the UI's point of view.
 *
 * The same shape as `bilingual/session.ts`, and deliberately so: a read that
 * cannot reach a provider, a generation that only a button may start, guards
 * that re-check the document *after* every await, and a teardown that runs when
 * the reader moves to another paper.
 *
 * ## What is different, and why it matters
 *
 * A reconstruction can be **wrong in a way that looks right** — a summation
 * bound, a subscript, a Greek letter. Nothing in this file can tell a correct
 * reconstruction from a plausible one; only the reader can, by comparing it with
 * the paper. So the session's job is not to hide that: it keeps the refusal
 * reasons the model gave, keeps the count of what was and was not reconstructed,
 * and hands the view everything it needs to say so and to show the original.
 */
import { isAbortError } from "@/api/client";
import {
  fetchFormulas,
  requestFormulas,
  type FormulaPlan,
  type FormulaView,
} from "@/api/formulas";
import { useWorkspaceStore } from "@/stores/workspace";

export type GenerateOutcome = { ok: true } | { ok: false; reason: string };

let activeRead: AbortController | null = null;
let activeReadDocument: string | null = null;
let activeGeneration: AbortController | null = null;

/**
 * Stop watching the document and drop what belongs to it.
 *
 * Private on purpose: the subscription below is installed from this module, and
 * a view that could call this directly is a view that can tear the column down
 * while another part of the screen still holds a reference to it.
 */
function teardownFormulas(): void {
  activeGeneration?.abort();
  activeGeneration = null;
  activeRead?.abort();
  activeRead = null;
  activeReadDocument = null;
  useWorkspaceStore.setState({
    formulas: null,
    formulasPlan: null,
    formulasFor: null,
    formulasStatus: "idle",
    formulasError: null,
    formulasStartedAt: null,
  });
}

/**
 * Drop the reconstruction when the reader opens a different paper.
 *
 * The same one-time subscription the bilingual session installs, and for the
 * same reason: the eager half of the application does not import this module, so
 * nothing here may be wired through the document lifecycle.
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
    teardownFormulas();
  });
}

/** Read the stored artifact. Never reaches a provider. */
export async function loadFormulas(): Promise<void> {
  watchTheDocument();
  const state = useWorkspaceStore.getState();
  const document = state.document;
  if (document === null || document.documentId === null) return;

  const { documentId } = document;
  if (activeRead !== null && activeReadDocument === documentId) return;

  activeRead?.abort();
  const controller = new AbortController();
  activeRead = controller;
  activeReadDocument = documentId;

  useWorkspaceStore.setState({ formulasStatus: "loading", formulasError: null });
  try {
    const read = await fetchFormulas(documentId, { signal: controller.signal });
    if (useWorkspaceStore.getState().document?.documentId !== documentId) return;
    useWorkspaceStore.setState({
      formulas: read.state === "found" ? read.view : null,
      formulasPlan: read.state === "none" ? read.plan : null,
      formulasFor: documentId,
      formulasStatus: "ready",
    });
  } catch (error) {
    if (isAbortError(error)) return;
    if (useWorkspaceStore.getState().document?.documentId !== documentId) return;
    // Not fatal to the reading: formulas simply stay as the paper's own pixels.
    useWorkspaceStore.setState({
      formulas: null,
      formulasFor: documentId,
      formulasStatus: "ready",
      formulasError: "未能读取已有的公式重建。",
    });
  } finally {
    if (activeRead === controller) {
      activeRead = null;
      activeReadDocument = null;
    }
  }
}

/** Reconstruct the paper's formulas. **Only a reader action may call this.** */
export async function generateFormulas(options: { force?: boolean } = {}): Promise<GenerateOutcome> {
  watchTheDocument();
  const state = useWorkspaceStore.getState();
  const document = state.document;
  if (document === null || document.documentId === null) {
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
    formulasStatus: "generating",
    formulasError: null,
    formulasStartedAt: Date.now(),
  });

  try {
    const view = await requestFormulas(documentId, state.profileId, {
      signal: controller.signal,
      force: options.force ?? false,
    });
    const current = useWorkspaceStore.getState();
    if (
      current.document?.documentId !== documentId ||
      current.document?.sessionToken !== sessionToken
    ) {
      // The reader moved on. The answer is not theirs to see and is not written
      // into the store; the backend has already cached it under the paper's own
      // content hash, so nothing was wasted.
      return { ok: false, reason: "已切换到其他文档，本次公式重建未显示。" };
    }
    useWorkspaceStore.setState({
      formulas: view,
      formulasPlan: null,
      formulasFor: documentId,
      formulasStatus: "ready",
      formulasStartedAt: null,
    });
    return { ok: true };
  } catch (error) {
    if (isAbortError(error)) {
      useWorkspaceStore.setState({ formulasStatus: "idle", formulasStartedAt: null });
      return { ok: false, reason: "已取消。" };
    }
    const current = useWorkspaceStore.getState();
    if (current.document?.documentId !== documentId) {
      return { ok: false, reason: "已切换到其他文档。" };
    }
    const message = describeFailure(error);
    useWorkspaceStore.setState({
      formulasStatus: "failed",
      formulasError: message,
      formulasStartedAt: null,
    });
    return { ok: false, reason: message };
  } finally {
    if (activeGeneration === controller) activeGeneration = null;
  }
}

/**
 * What to tell the reader about a failure.
 *
 * The same distinctions the translation draws, because they mean the same
 * things: a provider they have not configured, a provider that is unreachable,
 * a run already going, or a failure on this side.
 */
function describeFailure(cause: unknown): string {
  const status = (cause as { status?: number })?.status;
  if (status === 401 || status === 403) return "模型服务拒绝了这次请求，请检查设置中的密钥。";
  if (status === 429) return "模型服务限流了，请稍后再试。";
  if (status === 409) return "这篇论文的公式重建正在生成中，请稍候。";
  if (status !== undefined && status >= 500) return "模型服务暂时不可用，请稍后再试。";
  if (status === 400 || status === 422) return "请求被拒绝，请检查设置中的模型配置。";
  if (typeof status === "number") return `公式重建失败（HTTP ${status}）。`;
  return "公式重建失败，请稍后重试。";
}

/** The artifact for the document on screen, when it is this one's. */
export function formulasForCurrentDocument(): FormulaView | null {
  const state = useWorkspaceStore.getState();
  const documentId = state.document?.documentId ?? null;
  if (state.formulas === null || documentId === null) return null;
  if (state.formulasFor !== documentId) return null;
  return state.formulas;
}

/** The plan for a paper that has none, if the read found one. */
export function planForCurrentDocument(): FormulaPlan | null {
  const state = useWorkspaceStore.getState();
  if (state.formulas !== null) return null;
  return state.formulasPlan;
}

export function disposeFormulaSession(): void {
  teardownFormulas();
}
