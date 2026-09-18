/**
 * Provider and transport failures, in Paper QA's words.
 *
 * `describeApiError` already maps every `LLM_*` code, but its copy is the
 * translation surface's — "翻译服务认证失败" is the wrong sentence to show
 * someone asking a question about a paper. The codes are the backend's; only the
 * prose differs, so the mapping lives here and everything unrecognised falls
 * through to the shared describer rather than being re-invented.
 */
import { isApiError } from "@/api/client";
import { describeApiError, type UserFacingError } from "@/translation/errors";

const QA_REMEDIES: Record<string, Omit<UserFacingError, "code">> = {
  LLM_AUTHENTICATION_ERROR: {
    title: "模型服务认证失败",
    detail: "请检查所选 Provider 配置中的 API Key 是否正确、是否已过期。",
    retryable: false,
  },
  LLM_PERMISSION_DENIED: {
    title: "模型服务拒绝访问",
    detail: "该 API Key 无权使用所选模型，请在 Provider 侧核对权限。",
    retryable: false,
  },
  LLM_RATE_LIMIT: {
    title: "模型调用频率受限",
    detail: "请稍后重试，或在 Provider 侧提升配额。",
    retryable: true,
  },
  LLM_TIMEOUT: {
    title: "模型响应超时",
    detail: "模型在限定时间内没有返回。可稍后重试，或改用响应更快的模型。",
    retryable: true,
  },
  LLM_CONNECTION_ERROR: {
    title: "无法连接模型服务",
    detail: "请检查 Provider 的 Base URL，以及本地模型服务是否已启动。",
    retryable: true,
  },
  LLM_SERVER_ERROR: {
    title: "模型服务返回错误",
    detail: "Provider 侧出现异常，可稍后重试。",
    retryable: true,
  },
  LLM_OUTPUT_TRUNCATED: {
    title: "模型输出被截断",
    detail: "模型在写完回答前用尽了输出预算。可稍后重试；若反复出现，请换用输出更短的模型。",
    retryable: true,
  },
  LLM_NOT_FOUND: {
    title: "模型不存在",
    detail: "Provider 不认识该模型名，请在配置中核对。",
    retryable: false,
  },
  VALIDATION_ERROR: {
    title: "请求参数校验失败",
    detail: "提问范围与论文结构不匹配。请更换范围后重试。",
    retryable: false,
  },
  NOT_FOUND: {
    title: "未找到指定的论文或模型配置",
    detail: "文档或 Provider 配置可能已被删除。请重新打开论文，或在设置中确认配置。",
    retryable: false,
  },
};

export function describeQaError(cause: unknown): UserFacingError {
  if (isApiError(cause)) {
    const remedy = QA_REMEDIES[cause.code];
    if (remedy) return { ...remedy, code: cause.code };
  }
  return describeApiError(cause);
}
