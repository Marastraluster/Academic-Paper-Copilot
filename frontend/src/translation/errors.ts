/**
 * Turning backend failures into something a user can act on.
 *
 * The message the backend sends is already sanitised — `app/llm/errors.py`
 * strips the API key literal before it ever leaves the process — so nothing here
 * needs to redact anything. What this module adds is a *next step*: "authentication
 * failed" is useful, "check the selected provider profile" is actionable.
 *
 * ## Why task errors are matched on the message
 *
 * A failed translation task carries `error.code = "TRANSLATION_SERVICE_ERROR"`
 * and nothing more specific. The provider-level codes (`PROVIDER_AUTH_FAILED` and
 * friends) are emitted only by the *profile probe* endpoint, so they cannot
 * appear here. The provider's own identity survives inside the message, which
 * the kernel builds as:
 *
 *     "Translation aborted after a provider failure — LLM_AUTHENTICATION_ERROR: …"
 *
 * So a task failure is classified by recognising that `LLM_*` token. The check is
 * additive: an unrecognised message is still shown verbatim, which is always
 * correct and never worse than a generic string. See AC_CHANGE_REQUEST 1 in
 * `docs/acceptance/DS-FE-003.md`.
 */
import { API_BASE_URL } from "@/api/config";
import { isApiError } from "@/api/client";
import type { TaskError } from "@/api/translation";

export interface UserFacingError {
  /** Short headline. */
  title: string;
  /** What to do about it. */
  detail: string;
  /** The backend's code, for diagnostics. Never carries a secret. */
  code: string;
  /** True when re-running is plausibly worthwhile. */
  retryable: boolean;
}

interface Remedy {
  title: string;
  detail: string;
  retryable: boolean;
}

/** Codes the profile-probe surface emits. Kept for that surface and for defence. */
const PROVIDER_CODES: Record<string, Remedy> = {
  PROVIDER_AUTH_FAILED: {
    title: "翻译服务认证失败",
    detail: "请检查所选 Provider 配置中的 API Key 是否正确、是否已过期。",
    retryable: false,
  },
  PROVIDER_RATE_LIMITED: {
    title: "翻译服务触发限流",
    detail: "请稍后重试，或在 Provider 侧提升配额。",
    retryable: true,
  },
  PROVIDER_TIMEOUT: {
    title: "翻译服务超时",
    detail: "模型响应时间过长。可稍后重试，或改用响应更快的模型。",
    retryable: true,
  },
  PROVIDER_UNREACHABLE: {
    title: "无法连接翻译服务",
    detail: "请检查 Provider 的 Base URL，以及本地模型服务是否已启动。",
    retryable: true,
  },
  PROVIDER_MODEL_NOT_FOUND: {
    title: "翻译模型不存在",
    detail: "Provider 不认识该模型名，请在配置中核对。",
    retryable: false,
  },
  PROVIDER_ERROR: {
    title: "翻译服务返回错误",
    detail: "Provider 侧出现异常，可稍后重试。",
    retryable: true,
  },
};

/**
 * Provider failures as they actually reach a task failure: embedded in the
 * kernel's sanitised message. Ordered longest-first is unnecessary — the tokens
 * are mutually exclusive — but the list must stay in sync with `app/llm/errors.py`.
 */
const PROVIDER_TOKENS: ReadonlyArray<[string, string]> = [
  ["LLM_AUTHENTICATION_ERROR", "PROVIDER_AUTH_FAILED"],
  ["LLM_PERMISSION_DENIED", "PROVIDER_AUTH_FAILED"],
  ["LLM_RATE_LIMIT", "PROVIDER_RATE_LIMITED"],
  ["LLM_TIMEOUT", "PROVIDER_TIMEOUT"],
  ["LLM_CONNECTION_ERROR", "PROVIDER_UNREACHABLE"],
  ["LLM_SERVER_ERROR", "PROVIDER_ERROR"],
  ["LLM_NOT_FOUND", "PROVIDER_MODEL_NOT_FOUND"],
];

/** Kernel codes that are not provider faults but are worth naming plainly. */
const KERNEL_CODES: Record<string, Remedy> = {
  LAYOUT_MODEL_UNAVAILABLE: {
    title: "版面分析模型未就绪",
    detail: "首次运行需要联网下载约 72 MiB 的版面检测模型，下载完成后即可翻译。",
    retryable: true,
  },
  SOURCE_NOT_FOUND: {
    title: "源文件不可用",
    detail: "原始 PDF 已不在原位置，请重新打开该文档。",
    retryable: false,
  },
  PROCESS_INTERRUPTED: {
    title: "翻译被中断",
    detail: "后端在翻译过程中重启，本次翻译已终止。可重新发起。",
    retryable: true,
  },
};

function remedyForCode(code: string): Remedy | null {
  return PROVIDER_CODES[code] ?? KERNEL_CODES[code] ?? null;
}

function remedyForMessage(message: string): Remedy | null {
  for (const [token, code] of PROVIDER_TOKENS) {
    if (message.includes(token)) return PROVIDER_CODES[code] ?? null;
  }
  return null;
}

/**
 * Describe a failed translation task.
 *
 * Falls back to the backend's own message, which is human-readable and already
 * sanitised — never to a generic "something went wrong" that hides real detail.
 */
export function describeTaskError(error: TaskError | null): UserFacingError {
  if (!error) {
    return {
      title: "翻译失败",
      detail: "后端未能完成本次翻译，可重新发起。",
      code: "UNKNOWN",
      retryable: true,
    };
  }

  const remedy = remedyForCode(error.code) ?? remedyForMessage(error.message);
  if (remedy) {
    return { ...remedy, code: error.code };
  }

  return {
    title: "翻译失败",
    detail: error.message || "后端未能完成本次翻译，可重新发起。",
    code: error.code,
    retryable: true,
  };
}

/**
 * Describe a failure from a non-task API call — upload, profile list, artifact
 * fetch. An unreachable backend is the common case and gets the address, so the
 * user knows exactly what to start.
 */
export function describeApiError(cause: unknown): UserFacingError {
  if (isApiError(cause)) {
    if (cause.unreachable) {
      return {
        title: "无法连接到本地后端服务",
        detail: `请确认后端已在 ${API_BASE_URL} 运行后重试。`,
        code: cause.code,
        retryable: true,
      };
    }

    const remedy = remedyForCode(cause.code);
    if (remedy) return { ...remedy, code: cause.code };

    return {
      title: "请求失败",
      detail: cause.message,
      code: cause.code,
      retryable: true,
    };
  }

  return {
    title: "请求失败",
    detail: cause instanceof Error ? cause.message : "未知错误。",
    code: "UNKNOWN",
    retryable: true,
  };
}
