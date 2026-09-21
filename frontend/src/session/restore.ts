/**
 * Putting a paper in front of the reader without them handing over a file.
 *
 * ## What this is not
 *
 * Not a new way to open a document. Opening a paper the reader *chose* is still
 * `translation/session.ts::openDocument`, which registers a file. This is what
 * happens when there is no file to register: the bytes come from the backend's
 * own copy, the **existing** row is adopted rather than a new one minted, and
 * the same five loads the registration path fires are fired again.
 *
 * Adopting the row is the whole trick. A fresh upload mints a new document id,
 * the id is what the translated artifact is stored under, and a reader who
 * reloaded would be told their paper has never been translated — the very defect
 * this exists to remove. The extraction cache is keyed to the row's directory
 * too, so re-uploading would also re-run a vision pass over every page.
 *
 * ## Two callers, one path
 *
 * A **reload**, which remembers where the reader was in `localStorage`, and the
 * **library**, where they pick a paper from a list. Both go through
 * `adoptRegisteredDocument`; a second loader written beside this one would drift,
 * and the drift would show as the library opening papers differently from a
 * reload.
 *
 * ## The two rules
 *
 * **A gesture wins.** If the reader picks a file while this is still in flight,
 * the adoption is aborted and every continuation re-checks the store before
 * writing: an await is a window in which the reader may have moved on, and a
 * paper adopted over the one they just chose is the worst outcome available. The
 * check is on the **session token**, which is minted per adoption — the question
 * is never "is something open" (the library replaces what is open, on purpose)
 * but "is this still my adoption".
 *
 * **Nothing here may cost anything.** Every request below reads what is already
 * on disk — the row, the source bytes, the translated artifact, and the cached
 * extraction, notes and overview. An adoption that reached a provider would mean
 * a reload spends the reader's money, and it is measured against the ledger.
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
import {
  nextSessionToken,
  useWorkspaceStore,
  type ReaderMode,
  type SidebarPanel,
} from "@/stores/workspace";

export type RestoreOutcome =
  | "restored"
  /** Nothing was stored: a reader who has never opened a paper. */
  | "none"
  /** Something got there first — a gesture, or a second adoption. */
  | "superseded"
  /** The row or its bytes are gone. */
  | "missing"
  /** The backend did not answer. */
  | "offline";

/** Where the reader should land, and what to say when they cannot. */
export interface Adoption {
  /** 1-based; clamped to the document's page count. */
  activePage: number;
  outlinePanel: SidebarPanel;
  readerMode: ReaderMode;
  missingNotice: string;
  offlineNotice: string;
}

let activeRestore: AbortController | null = null;

/** Stop an adoption that is still in flight. Called when the reader opens a file. */
export function abortRestore(): void {
  activeRestore?.abort();
  activeRestore = null;
}

function beginAdoption(): AbortController {
  activeRestore?.abort();
  const controller = new AbortController();
  activeRestore = controller;
  return controller;
}

function endAdoption(controller: AbortController): void {
  if (activeRestore === controller) activeRestore = null;
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

/** The session token of the document in the store right now, or null. */
function openSessionToken(): string | null {
  return useWorkspaceStore.getState().document?.sessionToken ?? null;
}

/**
 * Put a paper the backend already has in front of the reader.
 *
 * `replaceOpen` is the difference between the two callers: a reload must not
 * overwrite whatever the reader has since opened, while the library is opening
 * the paper *because* they asked for it.
 */
export async function adoptRegisteredDocument(
  documentId: string,
  adoption: Adoption,
  signal: AbortSignal,
  { replaceOpen = false }: { replaceOpen?: boolean } = {},
): Promise<RestoreOutcome> {
  try {
    const summary: DocumentSummary = await getDocument(documentId, { signal });
    const bytes = await fetchOriginalPdf(documentId, { signal });
    // The reader may have chosen something of their own while this was in the
    // air. A guard that ran at the start would prove only that it made sense to
    // start.
    if (signal.aborted) return "superseded";
    if (!replaceOpen && openSessionToken() !== null) return "superseded";

    const sessionToken = nextSessionToken();
    const page = clampPage(adoption.activePage, summary.page_count);

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
      outlinePanel: adoption.outlinePanel,
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

    const mine = () => !signal.aborted && openSessionToken() === sessionToken;

    if (summary.has_translation &&
        !(await restoreTranslation(summary, sessionToken, adoption, signal))) {
      return "superseded";
    }
    if (!mine()) return "superseded";

    // Ask for the page through the one channel that moves the reader. The pane
    // applies it when its viewer is up — it cannot be applied before that, and
    // polling for a viewer would be this module guessing at another's timing.
    useWorkspaceStore.getState().requestJump(page, [], undefined);
    return "restored";
  } catch (error) {
    if (isAbortError(error)) return "superseded";

    if (isApiError(error) && error.status === 404) {
      useWorkspaceStore.getState().setNotice(adoption.missingNotice);
      return "missing";
    }

    useWorkspaceStore.setState({ engine: { state: "offline", label: "未连接" } });
    useWorkspaceStore.getState().setNotice(adoption.offlineNotice);
    return "offline";
  }
}

/** Put the reader back where they were, after a reload. */
export async function restoreReadingSession(): Promise<RestoreOutcome> {
  const stored = readStoredSession();
  if (stored === null) return "none";
  if (openSessionToken() !== null) return "superseded";

  const controller = beginAdoption();
  try {
    const outcome = await adoptRegisteredDocument(
      stored.documentId,
      {
        activePage: stored.activePage,
        readerMode: stored.readerMode,
        outlinePanel: stored.outlinePanel,
        missingNotice: "上次阅读的文档源文件已不可用，已重置工作区。",
        offlineNotice: "本地服务未连接，上次阅读的文档暂未恢复。",
      },
      controller.signal,
    );
    if (outcome === "missing") {
      // The row or the bytes it points at are gone. Keeping the session would
      // mean failing the same way on every reload.
      clearStoredSession();
    }
    return outcome;
  } finally {
    endAdoption(controller);
  }
}

/** Open a paper the reader picked from the library. */
export async function openFromLibrary(
  documentId: string,
  name: string,
): Promise<RestoreOutcome> {
  const controller = beginAdoption();
  try {
    return await adoptRegisteredDocument(
      documentId,
      {
        activePage: 1,
        readerMode: "original",
        outlinePanel: "overview",
        missingNotice: `「${name}」的源文件已不可用，无法打开。`,
        offlineNotice: "本地服务未连接，暂时无法打开这篇论文。",
      },
      controller.signal,
      { replaceOpen: true },
    );
  } finally {
    endAdoption(controller);
  }
}

/**
 * The translated artifact, as it was left. Returns false when the adoption was
 * superseded — the caller must stop rather than keep writing state.
 *
 * Failing to get it is not a failure of the adoption: the reader is reading the
 * original, which is the thing that must never break. What would be a failure is
 * reaching a provider, so this never asks for a translation, only for the one on
 * disk.
 */
async function restoreTranslation(
  summary: DocumentSummary,
  sessionToken: string,
  adoption: Adoption,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const mono = await fetchTranslatedPdf(summary.document_id, { signal });
    if (!(await looksLikePdf(mono))) throw new Error("the stored translation is not a PDF");
    if (signal.aborted || openSessionToken() !== sessionToken) return false;

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
      readerMode: adoption.readerMode === "bilingual" || adoption.readerMode === "translation"
        ? adoption.readerMode
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
