"""The provider contract every implementation satisfies.

Callers depend on this and nothing else. DS-BE-003 adds a Responses adapter that
implements the same two methods, so translation, context analysis and Paper QA
never learn which protocol is in use.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator

from app.llm.models import ConnectionReport, LLMRequest, LLMResult


class LLMProvider(ABC):
    """Vendor-neutral text generation."""

    #: Stable identifier reported in :class:`~app.llm.models.LLMResult`.
    protocol: str = "unknown"

    @abstractmethod
    async def generate(self, request: LLMRequest) -> LLMResult:
        """Run one completion.

        Raises an :class:`~app.llm.errors.LLMError` subclass on failure. The
        original cancellation signal is never swallowed: an ``asyncio``
        cancellation propagates untouched.
        """

    @abstractmethod
    async def test_connection(self) -> ConnectionReport:
        """Probe the endpoint cheaply, without consuming a meaningful prompt."""

    async def generate_stream(self, request: LLMRequest) -> AsyncIterator[str]:
        """Streaming is a later concern.

        Declared so the contract is complete and a caller written today can be
        switched to streaming without a signature change. No provider implements
        it yet; there is deliberately no streaming subsystem in this task.
        """
        raise NotImplementedError(
            f"{type(self).__name__} does not implement streaming yet"
        )
        yield ""  # unreachable; makes this an async generator per the signature
