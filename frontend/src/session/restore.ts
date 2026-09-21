/**
 * Putting the reader back where they were, after a reload.
 *
 * ## What this is not
 *
 * Not a new way to open a document. Opening a paper is still
 * `translation/session.ts::openDocument`, which registers a file the reader
 * chose. This is what happens when they chose nothing because they chose it in a
 * previous life of the tab: the same bytes are fetched from the backend's copy,
 * the **existing** row is adopted rather than a new one minted, and the same
 * five loads the registration path fires are fired again.
 *
 * Adopting the row is the whole trick. A fresh upload mints a new document id,
 * the id is what the translated artifact is stored under, and the reader who
 * reloaded would be told their paper has never been translated — the very defect
 * this exists to remove. The extraction cache is keyed to the row's directory
 * too, so re-uploading would also re-run a vision pass over every page.
 *
 * ## The two rules
 *
 * **A gesture wins.** If the reader picks a file while this is still in flight,
 * the restore is aborted and every continuation re-checks the store before
 * writing: an await is a window in which the reader may have moved on, and a
 * paper restored over the one they just chose is the worst outcome available.
 *
 * **Nothing here may cost anything.** Every request below reads what is already
 * on disk — the row, the source bytes, the translated artifact, and the cached
 * extraction, notes and overview. A restore that reached a provider would mean a
 * reload spends the reader's money, and it is measured against the ledger.
 */
import { isAbortError, isApiError } from "@/api/client";
import {
  fetchOriginalPdf,
  fetchTranslatedPdf,
  getDocument,
  type DocumentSummary,
} from "@/api/documents";
import { loadAnnotations } from "@/notes/session";
import { loadOverview } from "@/overview/session";
import { loadIr, loadProfiles, loadSections } from "@/qa/session";
import { clearStoredSession, readStoredSession } from "@/session/types";
import { nextSessionToken, useWorkspaceStore } from "@/stores/workspace";

export type RestoreOutcome =
  | "restored"
  /** Nothing was stored: a reader who has never opened a paper. */
  | "none"
  /** Something got there first — a gesture, or a second restore. */
  | "superseded"
  /** The row or its bytes are gone. The stored session has been cleared. */
  | "missing"
  /** The backend did not answer. The stored session is kept. */
  | "offline";

let activeRestore: AbortController | null = null;

/** Stop a restore that is still in flight. Called when the reader opens a file. */
export function abortRestore(): void {
  activeRestore?.abort();
  activeRestore = null;
}

/** The page stack, which exists only once PDF.js has parsed the document. */
const READY_SELECTOR = '[data-testid="pdf-page-container"]';

/**
 * Ask the viewer for the stored page, once there is a viewer to ask.
 *
 * A jump issued at restore time is swallowed: the pane renders its document
 * asynchronously, so the viewer's ref is null when the request is made and the
 * effect that consumes it does not run again. Waiting for the page stack is the
 * honest signal that the document is up — and the wait is bounded and abortable,
 * so a document that never opens costs a few hundred milliseconds of polling,
 * not a hung restore.
 */
async function jumpOnceOpen(page: number, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!signal.aborted && Date.now() < deadline) {
    if (window.document.querySelector(READY_SELECTOR) !== null) {
      useWorkspaceStore.getState().requestJump(page, [], undefined);
      return;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 60));
  }
}

/** The first bytes of a PDF, which is what "this is a PDF" actually means. */
async function looksLikePdf(blob: Blob): Promise<boolean> {
  if (blob.size < 5) return false;
  const head = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
  return String.fromCharCode(...head) === "%PDF-";
}

function clampPage(page: number, pageCount: number): number {
  if (!Number.isFinite(page)) return 1;
  return Math.min(Math.max(Math.trunc(page), 1), Math.max(pageCount, 1));
}

/** The id of the document in the store right now, or null. */
function openDocumentId(): string | null {
  return useWorkspaceStore.getState().document?.documentId ?? null;
}

export async function restoreReadingSession(): Promise<RestoreOutcome> {
  const stored = readStoredSession();
  if (stored === null) return "none";
  if (useWorkspaceStore.getState().document !== null) return "superseded";

  activeRestore?.abort();
  const controller = new AbortController();
  activeRestore = controller;
  const { signal } = controller;

  try {
    const summary: DocumentSummary = await getDocument(stored.documentId, { signal });
    const bytes = await fetchOriginalPdf(stored.documentId, { signal });
    // The reader may have chosen something of their own while this was in the
    // air. A guard that ran at the start would prove only that it made sense to
    // start.
    if (signal.aborted || openDocumentId() !== null) return "superseded";

    const sessionToken = nextSessionToken();
    const page = clampPage(stored.activePage, summary.page_count);

    useWorkspaceStore.setState({
      document: {
        sessionToken,
        name: summary.name,
        file: new File([bytes], summary.name, { type: "application/pdf" }),
        documentId: summary.document_id,
        registration: "ready",
        registrationError: null,
        backendPageCount: summary.page_count,
      },
      engine: { state: "ready", label: "本地服务" },
      translation: null,
      readerMode: "original",
      outlinePanel: stored.outlinePanel,
      activePage: page,
    });

    // The same five the registration path fires, for the same reasons: the
    // document now has an identity, and everything keyed to it — sections,
    // profiles, notes, the cached overview, the canonical IR — is a read.
    void loadSections();
    void loadProfiles();
    void loadAnnotations();
    void loadOverview();
    void loadIr();

    if (summary.has_translation && !(await restoreTranslation(summary, sessionToken, stored, signal))) {
      return "superseded";
    }
    if (signal.aborted || openDocumentId() !== summary.document_id) return "superseded";

    void jumpOnceOpen(page, signal);
    return "restored";
  } catch (error) {
    if (isAbortError(error)) return "superseded";

    if (isApiError(error) && error.status === 404) {
      // The row or the bytes it points at are gone. Keeping the session would
      // mean failing the same way on every reload.
      clearStoredSession();
      useWorkspaceStore.getState().setNotice("上次阅读的文档源文件已不可用，已重置工作区。");
      return "missing";
    }

    // The backend did not answer. The session is the one thing worth keeping:
    // when the local service is up again, the next reload restores the paper.
    useWorkspaceStore.setState({ engine: { state: "offline", label: "未连接" } });
    useWorkspaceStore.getState().setNotice("本地服务未连接，上次阅读的文档暂未恢复。");
    return "offline";
  } finally {
    if (activeRestore === controller) activeRestore = null;
  }
}

/**
 * The translated artifact, as it was left. Returns false when the restore was
 * superseded — the caller must stop rather than keep writing state.
 *
 * Failing to get it is not a failure of the restore: the reader is reading the
 * original, which is the thing that must never break. What would be a failure is
 * reaching a provider, so this never asks for a translation, only for the one on
 * disk.
 */
async function restoreTranslation(
  summary: DocumentSummary,
  sessionToken: string,
  stored: { documentId: string; readerMode: string; activePage: number },
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const mono = await fetchTranslatedPdf(summary.document_id, { signal });
    if (!(await looksLikePdf(mono))) throw new Error("the stored translation is not a PDF");
    if (signal.aborted || openDocumentId() !== summary.document_id) return false;

    useWorkspaceStore.setState({
      translation: {
        documentId: summary.document_id,
        sessionToken,
        // There is no task behind a restoration, and every task-shaped
        // affordance (cancel, retry, subscribe) is guarded on this being null.
        taskId: null,
        status: "success",
        progress: null,
        error: null,
        // Created here and revoked by `teardownTranslation`, which owns the
        // lifetime of every translated artifact's object URL.
        monoUrl: URL.createObjectURL(mono),
        monoPageCount: summary.page_count,
        degraded: false,
      },
      readerMode: stored.readerMode === "bilingual" || stored.readerMode === "translation"
        ? stored.readerMode
        : "original",
    });
    return true;
  } catch (error) {
    if (isAbortError(error)) return false;
    useWorkspaceStore.setState({ readerMode: "original" });
    useWorkspaceStore.getState().setNotice("译文无法加载，已回到原文阅读。");
    return true;
  }
}
