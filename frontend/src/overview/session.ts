/**
 * Loading and generating the paper's overview.
 *
 * Mirrors `notes/session.ts` and `translation/session.ts`, including their one
 * rule: **every asynchronous continuation re-checks the document after the
 * await, not before it.** A guard that runs when the work starts proves only
 * that it made sense to start. Here the stakes are higher than elsewhere in the
 * application, because this is the only path that spends the reader's money —
 * and the failure it guards against is the worst one available: an analysis of
 * paper A arriving while paper B is open, rendered as though it were B's.
 *
 * ## Two operations, and only one of them can cost anything
 *
 * `loadAnalysis` reads. It runs when a paper is opened and when the panel is
 * shown, it answers 404 when nothing has been generated, and it can never reach
 * a provider. `generateOverview` spends, and **nothing calls it except a button
 * the reader pressed**.
 */
import {
  fetchAnalysis,
  requestAnalysis,
  type AnalysisView,
} from "@/api/analysis";
import { isAbortError } from "@/api/client";
import { useWorkspaceStore } from "@/stores/workspace";

let activeRead: AbortController | null = null;
let activeReadDocument: string | null = null;
let activeGeneration: AbortController | null = null;

/**
 * Is this analysis still about the document in front of the reader?
 *
 * Checked on the fields that decide whether the *content* describes this paper.
 * `content_hash` is the file, and `ir_pipeline_version` is the extraction whose
 * paragraph ids the section and term references point into — DS-DOC-002 measured
 * a single layout constant renumbering 145 of 160 paragraphs, so an analysis
 * from a previous extraction describes text that has moved.
 *
 * The provider fields in the provenance are deliberately **not** checked here.
 * Whether a *different model* would be worth asking is a question about
 * generating, and the backend's own `is_cache_valid` already answers it on the
 * POST path; it has no bearing on whether the summaries on screen describe the
 * paper on screen.
 */
export function analysisIsCurrent(
  analysis: AnalysisView | null,
  contentHash: string,
  irPipelineVersion: string,
): boolean {
  if (!analysis) return false;
  if (analysis.status !== "READY" && analysis.status !== "PARTIAL") return false;
  return (
    analysis.provenance.content_hash === contentHash &&
    analysis.provenance.ir_pipeline_version === irPipelineVersion
  );
}

/** Read the stored analysis, if there is one. Never generates. */
export async function loadAnalysis(): Promise<void> {
  const state = useWorkspaceStore.getState();
  const document = state.document;
  if (!document || document.documentId === null) return;

  const { documentId } = document;
  // A read for the document already being read is the one that matters; a second
  // one would be the same answer at twice the cost.
  if (activeRead !== null && activeReadDocument === documentId) return;

  activeRead?.abort();
  const controller = new AbortController();
  activeRead = controller;
  activeReadDocument = documentId;

  // What the store held when this read started. A read that began before a
  // generation and lands after it must not replace the generated analysis with
  // the `null` it was always going to find — the reader would watch their
  // overview disappear at the moment it arrived.
  const before = useWorkspaceStore.getState().analysis;

  useWorkspaceStore.setState({ analysisStatus: "loading", analysisError: null });
  try {
    const analysis = await fetchAnalysis(documentId, { signal: controller.signal });
    // Guarded on the **document**, not on the session token: an analysis belongs
    // to the paper's content, and reopening the same file mints a new token.
    if (useWorkspaceStore.getState().document?.documentId !== documentId) return;
    if (useWorkspaceStore.getState().analysis !== before) return;
    useWorkspaceStore.setState({
      analysis,
      analysisFor: documentId,
      analysisStatus: "ready",
    });
  } catch (error) {
    if (isAbortError(error)) return;
    if (useWorkspaceStore.getState().document?.documentId !== documentId) return;
    if (useWorkspaceStore.getState().analysis !== before) return;
    useWorkspaceStore.setState({
      analysis: null,
      analysisFor: documentId,
      analysisStatus: "ready",
      analysisError: "未能读取已有分析。",
    });
  } finally {
    if (activeRead === controller) {
      activeRead = null;
      activeReadDocument = null;
    }
  }
}

export type GenerateOutcome =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Generate the analysis. **Only a reader action may call this.**
 *
 * Returns a reason rather than throwing, because the three ways this fails mean
 * three different things to the reader — the provider was unreachable, the paper
 * could not be structured, or they left before it finished — and one message for
 * all three teaches them nothing about what to do.
 */
export async function generateOverview(): Promise<GenerateOutcome> {
  const state = useWorkspaceStore.getState();
  const document = state.document;
  if (!document || document.documentId === null) {
    return { ok: false, reason: "请先打开一篇论文。" };
  }
  const profileId = state.profileId;
  if (!profileId) {
    return { ok: false, reason: "请先配置可用的模型服务。" };
  }

  const { documentId, sessionToken } = document;
  activeGeneration?.abort();
  const controller = new AbortController();
  activeGeneration = controller;
  useWorkspaceStore.setState({
    analysisStatus: "generating",
    analysisError: null,
    analysisStartedAt: Date.now(),
  });

  try {
    const analysis = await requestAnalysis(documentId, profileId, {
      signal: controller.signal,
    });
    if (
      useWorkspaceStore.getState().document?.documentId !== documentId ||
      useWorkspaceStore.getState().document?.sessionToken !== sessionToken
    ) {
      // The reader moved on. The answer is not theirs to see and, importantly,
      // is **not written into the store** — a late analysis attached to a new
      // document is the one failure this whole module exists to prevent.
      return { ok: false, reason: "已切换到其他文档，本次分析结果未采用。" };
    }
    useWorkspaceStore.setState({
      analysis,
      analysisFor: documentId,
      analysisStatus: "ready",
      analysisStartedAt: null,
    });
    return { ok: true };
  } catch (error) {
    if (isAbortError(error)) {
      useWorkspaceStore.setState({ analysisStatus: "ready", analysisStartedAt: null });
      return { ok: false, reason: "分析已取消。" };
    }
    if (useWorkspaceStore.getState().document?.documentId !== documentId) {
      return { ok: false, reason: "已切换到其他文档，本次分析结果未采用。" };
    }
    useWorkspaceStore.setState({
      analysisStatus: "failed",
      analysisStartedAt: null,
      analysisError: describeGenerationFailure(error),
    });
    return { ok: false, reason: describeGenerationFailure(error) };
  } finally {
    if (activeGeneration === controller) activeGeneration = null;
  }
}

/**
 * The provider's failure, in the reader's terms.
 *
 * The three kinds are kept distinct because the reader's next action differs for
 * each: fix a key or wait out a network, try a different paper, or do nothing
 * because they already left.
 */
function describeGenerationFailure(error: unknown): string {
  const status = (error as { status?: number })?.status;
  if (status === 502 || status === 503 || status === 504) {
    return "AI 服务暂时不可用，请检查网络或模型配置后重试。";
  }
  if (status === 422 || status === 400) {
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
    analysis: null,
    analysisFor: null,
    analysisStatus: "idle",
    analysisError: null,
    analysisStartedAt: null,
  });
}
