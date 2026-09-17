/**
 * The one place the frontend talks to the backend.
 *
 * Every call goes through here so that three rules hold everywhere at once:
 *
 * 1. **No component hardcodes a URL.** Paths are relative and resolved through
 *    `apiUrl`, which owns the single base-URL constant (DS-FE-001 AC-10).
 * 2. **Every failure is the same shape.** The backend answers with
 *    `{"error": {"code", "message", "detail"}}`; `ApiError` is that envelope as
 *    an exception, so callers switch on a stable `code` rather than parsing text.
 * 3. **Nothing here logs a request or a response body.** A translation request
 *    carries a `profile_id`, not a key — but a rule that depends on remembering
 *    that is a rule that eventually fails, so the logging simply does not exist.
 *    There is deliberately no `console.*` call in this module.
 */
import { apiUrl } from "@/api/config";

/** Sent when the backend could not be reached at all — no HTTP status exists. */
export const BACKEND_UNREACHABLE = "BACKEND_UNREACHABLE";

/** Status used when the request never produced a response. */
const NO_RESPONSE = 0;

export class ApiError extends Error {
  /** HTTP status, or 0 when the request never reached the server. */
  readonly status: number;
  /** Stable machine-readable code from the error envelope. */
  readonly code: string;
  readonly detail: unknown;

  constructor(status: number, code: string, message: string, detail: unknown = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }

  /** True when the backend is not running, or the network refused the call. */
  get unreachable(): boolean {
    return this.status === NO_RESPONSE;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

export function isAbortError(value: unknown): boolean {
  return (value as { name?: string } | null)?.name === "AbortError";
}

/** Parse the error envelope, tolerating a response that is not JSON at all. */
async function readError(response: Response): Promise<ApiError> {
  let code = "HTTP_ERROR";
  let message = `请求失败（HTTP ${response.status}）。`;
  let detail: unknown = {};

  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; detail?: unknown };
    };
    if (body?.error) {
      // Trust the envelope only as far as it goes: a malformed one still has to
      // produce a usable error rather than an undefined message.
      code = body.error.code || code;
      message = body.error.message || message;
      detail = body.error.detail ?? {};
    }
  } catch {
    // A 502 from a proxy, an HTML error page, a truncated body — all land here.
    // The status line is still true, so the generic message stands.
  }

  return new ApiError(response.status, code, message, detail);
}

/**
 * Fetch a backend path, raising `ApiError` for anything that is not 2xx.
 *
 * An aborted request is re-thrown as the original `AbortError` rather than
 * wrapped: cancellation is a deliberate local decision, not a backend failure,
 * and callers must be able to tell them apart.
 */
export async function apiFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), init);
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
    throw new ApiError(
      NO_RESPONSE,
      BACKEND_UNREACHABLE,
      "无法连接到本地后端服务。",
      { path },
    );
  }

  if (!response.ok) throw await readError(response);
  return response;
}

export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await apiFetch(path, init);
  return (await response.json()) as T;
}

/**
 * Fetch a binary artifact.
 *
 * `no-store` is not an optimisation — it is correctness. Translation artifacts
 * are served from a stable path (`/documents/{id}/translated`) whose *contents*
 * change when the document is retranslated. Without this, a re-run would render
 * the previous translation straight out of the browser cache.
 */
export async function apiBlob(path: string, init: RequestInit = {}): Promise<Blob> {
  const response = await apiFetch(path, { ...init, cache: "no-store" });
  return await response.blob();
}
