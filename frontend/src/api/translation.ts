/**
 * Translation task endpoints (docs/API_CONTRACT.md §5).
 *
 * Two things in here are easy to get wrong and are handled deliberately.
 *
 * **`EventSource` fires `error` for two unrelated reasons.** A named server
 * event (`event: error`) arrives as a `MessageEvent` carrying JSON; a *broken
 * connection* arrives as a bare `Event` with no `data`. A listener that treats
 * them alike will either mistake a dropped connection for a failed translation
 * or silently swallow the real failure. They are distinguished by type below.
 *
 * **A dead stream must not look like a running translation.** If the stream
 * fails before a terminal event and nothing else reads the task, the UI reports
 * progress forever — which is precisely the dishonesty this milestone exists to
 * remove. So a connection failure falls back to polling `/api/tasks/{id}`. That
 * is a status-read fallback, not a retry of the translation, and it stops at the
 * first terminal state.
 */
import { apiJson } from "@/api/client";
import { apiUrl } from "@/api/config";

export const STATUS_PENDING = "PENDING";
export const STATUS_TRANSLATING = "TRANSLATING";
export const STATUS_SUCCESS = "SUCCESS";
export const STATUS_FAILED = "FAILED";
export const STATUS_CANCELLED = "CANCELLED";

export type TaskStatus =
  | typeof STATUS_PENDING
  | typeof STATUS_TRANSLATING
  | typeof STATUS_SUCCESS
  | typeof STATUS_FAILED
  | typeof STATUS_CANCELLED;

/** Exactly the states the backend emits. `ANALYZING`/`RENDERING` do not exist. */
const TERMINAL: readonly string[] = [STATUS_SUCCESS, STATUS_FAILED, STATUS_CANCELLED];

export function isTerminal(status: string): boolean {
  return TERMINAL.includes(status);
}

export interface TaskProgress {
  page: number;
  page_count: number;
}

export interface TaskError {
  code: string;
  message: string;
}

export interface TaskSnapshot {
  task_id: string;
  document_id: string;
  status: TaskStatus;
  lang_in: string;
  lang_out: string;
  engine: string;
  /** `null` until the kernel reports its first page. Never fabricated. */
  progress: TaskProgress | null;
  error: TaskError | null;
  created_at: string;
  updated_at: string;
}

export interface StartTranslationRequest {
  profile_id: string;
  lang_in: string;
  lang_out: string;
  engine: string;
}

export interface StartedTask {
  task_id: string;
  document_id: string;
  status: TaskStatus;
}

/**
 * Start a translation. Answers in well under a second — the 202 carries a task
 * id, and the work continues in the background.
 *
 * The body carries a `profile_id` and nothing resembling a credential. The
 * backend's model forbids unknown fields, so this object is the entire contract:
 * adding `pages` or `context_mode` would earn a 422, not a silent ignore.
 */
export async function startTranslation(
  documentId: string,
  payload: StartTranslationRequest,
  signal?: AbortSignal,
): Promise<StartedTask> {
  return apiJson<StartedTask>(
    `/api/documents/${encodeURIComponent(documentId)}/translate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    },
  );
}

export async function getTask(
  taskId: string,
  signal?: AbortSignal,
): Promise<TaskSnapshot> {
  return apiJson<TaskSnapshot>(`/api/tasks/${encodeURIComponent(taskId)}`, { signal });
}

/**
 * Ask for cancellation at the next page boundary.
 *
 * Honest about the limit: the current page finishes first, because the kernel
 * polls once per page. The stored status becomes `CANCELLED` only when the
 * kernel actually stops, so this response saying `CANCELLING` is not a
 * contradiction — it is the truth.
 */
export async function cancelTask(
  taskId: string,
): Promise<{ task_id: string; status: string; message: string }> {
  return apiJson<{ task_id: string; status: string; message: string }>(
    `/api/tasks/${encodeURIComponent(taskId)}/cancel`,
    { method: "POST" },
  );
}

export interface TaskOutcome {
  status: TaskStatus;
  error: TaskError | null;
  /** The authoritative final snapshot, or `null` if even that read failed. */
  task: TaskSnapshot | null;
}

export interface TaskHandlers {
  /** Called with each real progress reading. `null` means "not yet known". */
  onProgress: (progress: TaskProgress | null, status: TaskStatus) => void;
  onTerminal: (outcome: TaskOutcome) => void;
  /** The live stream dropped; progress is now coming from polling. */
  onStreamDegraded?: () => void;
}

/** How often to re-read the task once the stream is gone. */
const POLL_INTERVAL_MS = 1500;

/**
 * Watch a task until it reaches a terminal state. Returns an unsubscribe that
 * closes the stream and cancels any pending poll.
 */
export function subscribeToTask(taskId: string, handlers: TaskHandlers): () => void {
  let closed = false;
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stop = () => {
    closed = true;
    source?.close();
    source = null;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const parse = (event: Event): Record<string, unknown> | null => {
    const data = (event as MessageEvent).data;
    if (typeof data !== "string") return null;
    try {
      return JSON.parse(data) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  /**
   * Read the task once more before declaring the outcome.
   *
   * The `done` event carries `page_count`/`translated_page_count` but is *not* a
   * full snapshot — it has no `task_id`, and `error` is absent from it. Treating
   * it as one would leave the store holding a malformed record, so the terminal
   * event is a signal to fetch the authoritative state rather than a payload.
   */
  const conclude = async (fallbackStatus: TaskStatus, fallbackError: TaskError | null) => {
    let task: TaskSnapshot | null = null;
    try {
      task = await getTask(taskId);
    } catch {
      // The task is finished either way; the stream already told us how.
    }
    if (closed) return;
    stop();
    handlers.onTerminal({
      status: (task?.status as TaskStatus) ?? fallbackStatus,
      error: task?.error ?? fallbackError,
      task,
    });
  };

  const applySnapshot = (task: TaskSnapshot) => {
    if (closed) return;
    handlers.onProgress(task.progress, task.status);
    if (isTerminal(task.status)) void conclude(task.status, task.error);
  };

  const poll = async () => {
    if (closed) return;
    try {
      applySnapshot(await getTask(taskId));
    } catch {
      // A transient read failure must not end the watch; the next tick retries.
    }
    if (!closed) timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
  };

  const startPolling = () => {
    if (closed || timer !== null) return;
    handlers.onStreamDegraded?.();
    void poll();
  };

  // jsdom has no EventSource. Falling back immediately keeps the same guarantee
  // — the task is still watched to a terminal state — instead of hanging.
  if (typeof EventSource === "undefined") {
    startPolling();
    return stop;
  }

  source = new EventSource(apiUrl(`/api/tasks/${encodeURIComponent(taskId)}/events`));

  source.addEventListener("snapshot", (event) => {
    const payload = parse(event);
    if (payload) applySnapshot(payload as unknown as TaskSnapshot);
  });

  source.addEventListener("progress", (event) => {
    const payload = parse(event);
    if (closed || !payload) return;
    const progress = payload.progress as TaskProgress | undefined;
    if (progress) handlers.onProgress(progress, payload.status as TaskStatus);
  });

  source.addEventListener("done", () => void conclude(STATUS_SUCCESS, null));
  source.addEventListener("cancelled", () => void conclude(STATUS_CANCELLED, null));

  source.addEventListener("error", (event) => {
    // A named server event is a `MessageEvent` with data; a connection failure
    // is a bare `Event`. Conflating them is the trap this check exists for.
    if (event instanceof MessageEvent && typeof event.data === "string" && event.data) {
      const payload = parse(event);
      const error = (payload?.error as TaskError | undefined) ?? {
        code: String(payload?.code ?? "TRANSLATION_FAILED"),
        message: String(payload?.message ?? "翻译失败。"),
      };
      void conclude(STATUS_FAILED, error);
      return;
    }

    // Otherwise the stream itself broke. EventSource would silently retry
    // forever, leaving the UI claiming progress it is no longer receiving, so
    // it is closed and the task is read directly instead.
    source?.close();
    source = null;
    startPolling();
  });

  return stop;
}
