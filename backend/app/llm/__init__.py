"""Vendor-neutral LLM layer.

Callers use :class:`LLMProvider` and the models below. They never import the
OpenAI SDK, inspect ``response.choices``, interpret an HTTP status, or handle an
authorization header.

Importing this package has no side effects: no client is constructed, no socket
is opened, and nothing is logged.

Later tasks add a Responses adapter (DS-BE-003), protocol auto-detection, and
provider persistence behind this same interface.
"""

from app.llm.base import LLMProvider
from app.llm.chat_completions import (
    KEYLESS_API_KEY_PLACEHOLDER,
    OpenAIChatCompletionsProvider,
    build_client,
)
from app.llm.client import PROBE_MAX_TOKENS, PROBE_PROMPT
from app.llm.detection import (
    cache_key,
    clear_detection_cache,
    get_detection_cache_stats,
    invalidate_detection_cache,
    resolve_provider,
    test_endpoint_connection,
)
from app.llm.responses import OpenAIResponsesProvider, build_responses_client
from app.llm.errors import (
    LLMAPIError,
    LLMAuthenticationError,
    LLMBadRequestError,
    LLMConnectionError,
    LLMError,
    LLMInvalidResponseError,
    LLMNotFoundError,
    LLMPermissionDeniedError,
    LLMRateLimitError,
    LLMServerError,
    LLMTimeoutError,
    normalize_exception,
)
from app.llm.models import (
    ChatMessage,
    ConnectionReport,
    LLMRequest,
    LLMResult,
    LLMUsage,
    ProviderConfig,
    Role,
)

__all__ = [
    # Interface
    "LLMProvider",
    # Models
    "ChatMessage",
    "ConnectionReport",
    "LLMRequest",
    "LLMResult",
    "LLMUsage",
    "ProviderConfig",
    "Role",
    # Implementations
    "OpenAIChatCompletionsProvider",
    "OpenAIResponsesProvider",
    "build_client",
    "build_responses_client",
    "KEYLESS_API_KEY_PLACEHOLDER",
    "PROBE_PROMPT",
    "PROBE_MAX_TOKENS",
    # Detection
    "resolve_provider",
    "test_endpoint_connection",
    "cache_key",
    "clear_detection_cache",
    "invalidate_detection_cache",
    "get_detection_cache_stats",
    # Errors
    "LLMError",
    "LLMAPIError",
    "LLMAuthenticationError",
    "LLMBadRequestError",
    "LLMConnectionError",
    "LLMInvalidResponseError",
    "LLMNotFoundError",
    "LLMPermissionDeniedError",
    "LLMRateLimitError",
    "LLMServerError",
    "LLMTimeoutError",
    "normalize_exception",
]
