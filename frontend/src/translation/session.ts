/**
 * Drives one document's translation from the UI's point of view.
 *
 * The store holds plain data; this module owns the things that are not data —
 * an in-flight upload, the task subscription, the artifact fetch, and the object
 * URL's lifetime. Keeping them here means teardown is one call rather than a
 * scavenger hunt through components.
 *
 * ## The one rule
 *
 * Every asynchronous continuation re-checks `isCurrent(documentId, sessionToken)`
 * before writing to the store, and **the check happens after the await, not
 * before it**. A guard that runs when the work starts proves only that it made
 * sense to start; by the time the work finishes the user may be reading a
 * different paper. This is the defect AC-P0-11 exists to prevent.
 */
import { isAbortError } from "@/api/client";
import { fetchTranslatedPdf, uploadDocument } from "@/api/documents";
import {
  STATUS_SUCCESS,
  cancelTask,
  startTranslation as startTranslationRequest,
  subscribeToTask,
  type TaskOutcome,
} from "@/api/translation";
import { loadIr, loadProfiles, loadSections, teardownQa } from "@/qa/session";
import { loadAnalysis, teardownOverview } from "@/overview/session";
import { loadAnnotations } from "@/notes/session";
import {
  nextSessionToken,
  useWorkspaceStore,
  type TranslationState,
} from "@/stores/workspace";
import { describeApiError, describeTaskError } from "@/translation/errors";

/**
 * How the translation is produced.
 *
 * `academic` sends the academic translation instructions — preserve notation,
 * citations, identifiers; do not summarise or explain — with no document
 * payload. `contextual` additionally sends the document summary, section
 * summary and neighbouring paragraphs, which costs roughly six times the
 * prompt and requires the paper to be analysed first. `basic` sends upstream's
 * minimal envelope.
 */
export type ContextMode = "basic" | "academic" | "contextual";

/** What the API calls each mode. Kept separate from the UI's vocabulary. */
const API_MODE: Record<ContextMode, string> = {
  basic: "off",
  academic: "academic",
  contextual: "standard",
};

export interface TranslateOptions {
  profileId: string;
  langIn: string;
  langOut: string;
  engine?: string;
  contextMode?: ContextMode;
}

/** Only one of each can be in flight; a new one supersedes the old. */
let activeUpload: AbortController | null = null;
let activeArtifact: AbortController | null = null;
let activeWatch: (() => void) | null = null;

/**
 * Settings used for the most recent run, so a retry re-runs the *same*
 * translation rather than silently reverting to the dialog's defaults.
 */
let lastOptions: TranslateOptions | null = null;

// --- guards -----------------------------------------------------------------

/** Is the given identity still the document the user is looking at? */
function isCurrent(documentId: string, sessionToken: string): boolean {
  const { document } = useWorkspaceStore.getState();
  return (
    document !== null &&
    document.documentId === documentId &&
    document.sessionToken === sessionToken
  );
}

/** Is this opening token still the current one? Used before a `documentId` exists. */
function isCurrentSession(sessionToken: string): boolean {
  return useWorkspaceStore.getState().document?.sessionToken === sessionToken;
}

// --- teardown ---------------------------------------------------------------

/**
 * Revoke the displayed object URL and clear it.
 *
 * The URL is read back out of the store rather than tracked separately here.
 * Two records of "the current object URL" is one more than can be kept in step,
 * and the failure mode of them drifting apart is a leaked blob URL that nothing
 * holds a reference to revoke.
 */
function releaseMonoUrl(): void {
  const { translation } = useWorkspaceStore.getState();
  if (translation === null || translation.monoUrl === null) return;

  URL.revokeObjectURL(translation.monoUrl);
  useWorkspaceStore.setState({ translation: { ...translation, monoUrl: null } });
}

/**
 * Stop watching, drop the artifact fetch, release the object URL.
 *
 * Called on document switch, on retranslation, and on unmount — the three
 * moments AC-P0-15 names. It is idempotent, so calling it defensively is safe.
 */
export function teardownTranslation(): void {
  activeWatch?.();
  activeWatch = null;

  activeArtifact?.abort();
  activeArtifact = null;

  releaseMonoUrl();
}

// --- opening a document -----------------------------------------------------

/**
 * Open a local PDF.
 *
 * Two things happen at once and neither waits for the other: PDF.js parses the
 * file in the browser, and the file is registered with the backend so it can be
 * translated. Reading must never depend on the backend being up.
 */
export function openDocument(file: File): void {
  // A new document invalidates everything the previous one was doing.
  teardownTranslation();
  teardownQa();
  // The overview belongs to the document that produced it, and so does an
  // in-flight generation for it. Clearing here means a late answer has nothing
  // to attach to even before the request guard sees it.
  teardownOverview();
  activeUpload?.abort();

  const sessionToken = nextSessionToken();
  useWorkspaceStore.setState({
    document: {
      sessionToken,
      name: file.name,
      file,
      documentId: null,
      registration: "pending",
      registrationError: null,
      backendPageCount: null,
    },
    translation: null,
    // The previous document's translation is gone, so a mode that displays one
    // is no longer selectable. Resetting avoids a frame of stale chrome.
    readerMode: "original",
    engine: { state: "connecting", label: "连接中…" },
  });

  const controller = new AbortController();
  activeUpload = controller;

  void (async () => {
    try {
      const summary = await uploadDocument(file, { signal: controller.signal });
      // Re-checked *after* the await: another file may have been opened, and a
      // document id belonging to a discarded file must never be adopted.
      if (!isCurrentSession(sessionToken)) return;

      const current = useWorkspaceStore.getState().document;
      if (!current) return;
      useWorkspaceStore.setState({
        document: {
          ...current,
          documentId: summary.document_id,
          name: summary.name,
          registration: "ready",
          backendPageCount: summary.page_count,
        },
        engine: { state: "ready", label: "本地服务" },
      });

      // The document now has a backend identity — which is what Section scope
      // and a question both need. Fetched here rather than when the sidebar
      // opens, so opening a paper prepares everything a question needs without a
      // round trip at the moment the user asks. Neither failure is fatal: one
      // disables a single scope, the other disables asking and says so.
      void loadSections();
      void loadProfiles();
      // Notes, for the same reason and at the same moment as the sections above:
      // they belong to the document that has just acquired an identity, and
      // loading them here means the panel has them whenever the reader opens it
      // rather than depending on when the panel happened to mount.
      void loadAnnotations();
      // A **read**, not a generation: the same reason the notes list is fetched
      // here. A reader who has already analysed this paper should see the
      // overview the moment the panel appears, and one who has not should see
      // the instant entry — neither should wait for the panel to mount to find
      // out which they are. This route never reaches a provider.
      void loadAnalysis();
      // The canonical IR, for selection mapping. Fetched here so a selection made
      // moments after a paper opens can be resolved without a round trip.
      void loadIr();
    } catch (cause) {
      if (isAbortError(cause)) return;
      if (!isCurrentSession(sessionToken)) return;

      const current = useWorkspaceStore.getState().document;
      if (!current) return;
      useWorkspaceStore.setState({
        document: {
          ...current,
          registration: "failed",
          registrationError: describeApiError(cause),
        },
        engine: { state: "error", label: "后端不可用" },
      });
    } finally {
      if (activeUpload === controller) activeUpload = null;
    }
  })();
}

/** Close the open document. */
export function closeDocument(): void {
  teardownTranslation();
  teardownQa();
  // The overview belongs to the document that produced it, and so does an
  // in-flight generation for it. Clearing here means a late answer has nothing
  // to attach to even before the request guard sees it.
  teardownOverview();
  activeUpload?.abort();
  activeUpload = null;
  useWorkspaceStore.setState({
    document: null,
    translation: null,
    readerMode: "original",
    engine: { state: "offline", label: "未连接" },
  });
}

// --- translating ------------------------------------------------------------

function patchTranslation(patch: Partial<TranslationState>): void {
  const { translation } = useWorkspaceStore.getState();
  if (translation === null) return;
  useWorkspaceStore.setState({ translation: { ...translation, ...patch } });
}

/**
 * Start a translation for the document currently open.
 *
 * Returns once the task has been *accepted*; the work continues in the store.
 */
export async function startTranslation(options: TranslateOptions): Promise<void> {
  const { document } = useWorkspaceStore.getState();
  if (!document?.documentId || document.registration !== "ready") return;

  const { documentId, sessionToken } = document;
  lastOptions = options;

  // A new run replaces the previous result rather than stacking on it.
  teardownTranslation();

  useWorkspaceStore.setState({
    translation: {
      documentId,
      sessionToken,
      taskId: null,
      status: "submitting",
      progress: null,
      error: null,
      monoUrl: null,
      monoPageCount: null,
      degraded: false,
    },
  });

  try {
    const started = await startTranslationRequest(documentId, {
      profile_id: options.profileId,
      lang_in: options.langIn,
      lang_out: options.langOut,
      engine: options.engine ?? "fast",
      context_mode: API_MODE[options.contextMode ?? "academic"],
    });

    if (!isCurrent(documentId, sessionToken)) return;

    patchTranslation({ taskId: started.task_id, status: "translating" });

    activeWatch = subscribeToTask(started.task_id, {
      onProgress: (progress, status) => {
        if (!isCurrent(documentId, sessionToken)) return;
        patchTranslation({
          progress: progress
            ? { page: progress.page, pageCount: progress.page_count }
            : null,
          // A terminal status may arrive through a snapshot before the event
          // that would announce it; keeping the status in step avoids a render
          // where progress has stopped but the UI still says "translating".
          status: status === "PENDING" ? "submitting" : "translating",
        });
      },
      onStreamDegraded: () => {
        if (!isCurrent(documentId, sessionToken)) return;
        patchTranslation({ degraded: true });
      },
      onTerminal: (outcome) => {
        void conclude(documentId, sessionToken, outcome);
      },
    });
  } catch (cause) {
    if (!isCurrent(documentId, sessionToken)) return;
    patchTranslation({ status: "failed", error: describeApiError(cause) });
  }
}

async function conclude(
  documentId: string,
  sessionToken: string,
  outcome: TaskOutcome,
): Promise<void> {
  // The single most important line in this file. A result for a document the
  // user has moved on from stops here.
  if (!isCurrent(documentId, sessionToken)) return;

  activeWatch = null;

  // `outcome.status` is the backend's vocabulary, which is upper-case. The
  // store's own status is lower-case; the two must not be confused.
  if (outcome.status !== STATUS_SUCCESS) {
    patchTranslation({
      status: "failed",
      error: describeTaskError(outcome.error),
    });
    return;
  }

  activeArtifact?.abort();
  const controller = new AbortController();
  activeArtifact = controller;

  try {
    const blob = await fetchTranslatedPdf(documentId, { signal: controller.signal });
    if (!isCurrent(documentId, sessionToken)) return;

    const url = URL.createObjectURL(blob);
    // Checked again, because creating the URL is the point of no return: if the
    // document changed in the meantime the URL would leak with nothing holding
    // a reference to revoke it.
    if (!isCurrent(documentId, sessionToken)) {
      URL.revokeObjectURL(url);
      return;
    }

    releaseMonoUrl();
    patchTranslation({ status: "success", monoUrl: url, error: null });
  } catch (cause) {
    if (isAbortError(cause)) return;
    if (!isCurrent(documentId, sessionToken)) return;

    // The task succeeded but its artifact cannot be read. Saying so is more
    // useful than a generic failure, and it points at the right thing.
    patchTranslation({
      status: "failed",
      error: {
        title: "无法获取译文文件",
        detail: "后端报告翻译成功，但译文 PDF 无法下载。可重新发起翻译。",
        code: "TRANSLATED_FILE_UNAVAILABLE",
        retryable: true,
      },
    });
  } finally {
    if (activeArtifact === controller) activeArtifact = null;
  }
}

/**
 * Ask the backend to stop at the next page boundary.
 *
 * Deliberately does not set `CANCELLED` locally: the kernel stops at a page
 * boundary, so the honest state between the request and the stop is "still
 * running". The status changes when the backend says it did.
 */
export async function cancelActiveTranslation(): Promise<void> {
  const { translation } = useWorkspaceStore.getState();
  if (!translation?.taskId) return;

  const { documentId, sessionToken } = translation;
  try {
    await cancelTask(translation.taskId);
    if (!isCurrent(documentId, sessionToken)) return;
    patchTranslation({ status: "translating" });
  } catch (cause) {
    if (!isCurrent(documentId, sessionToken)) return;
    patchTranslation({ error: describeApiError(cause) });
  }
}

/** Record the page count of the rendered translated artifact (AC §12). */
export function noteTranslatedPageCount(pageCount: number): void {
  if (useWorkspaceStore.getState().translation === null) return;
  patchTranslation({ monoPageCount: pageCount });
}

/** Re-run the most recent translation with the same settings. */
export async function retranslate(): Promise<void> {
  if (lastOptions === null) return;
  await startTranslation(lastOptions);
}

/** Release everything this module holds. Called when the app unmounts. */
export function disposeTranslationSession(): void {
  teardownTranslation();
  activeUpload?.abort();
  activeUpload = null;
  lastOptions = null;
}
