"""Counting what actually leaves this machine.

## Why this exists

DS-QA-014's browser harness watched the *page* for requests to a provider host
and reported zero. That number was true and useless: the page never talks to a
provider, the backend does. Every "provider calls: 0" claim the repository has
made rests on a counter at the wrong boundary — it can prove the browser sent
nothing, and it cannot count a single model call.

So this sits at the only boundary every call crosses: the provider itself. A
provider built by `detection.build_provider` is wrapped here, and every
`generate` — including retries, repair calls and the ones a pipeline makes on its
own initiative — is recorded.

## What it records, and what it refuses to

Operation, model, protocol, outcome and usage. Never the prompt, never the
completion, never a credential: a counter that logs paper text is a worse problem
than the one it solves, and the repository's logging rules forbid it. The
category is a label the *caller* sets (see `operation`), because only the caller
knows whether it is translating a paragraph or analysing a section, and guessing
from a prompt is how a classifier becomes a liability.

## How it is read

`snapshot()` for tests and benchmarks; `reset()` before a measured run. Nothing in
the normal UI reads it — a counter that ships a UI is a feature, and this is
instrumentation.
"""

from __future__ import annotations

import threading
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Iterator

from app.llm.base import LLMProvider
from app.llm.models import LLMRequest, LLMResult

#: What the current call is *for*. Set by the caller; `unlabelled` otherwise,
#: which is honest — a guess would be worse than a gap.
_operation: ContextVar[str] = ContextVar("provider_operation", default="unlabelled")


@dataclass
class ProviderCall:
    """One request that left the process."""

    operation: str
    model: str
    protocol: str
    ok: bool
    #: Provider-reported usage, or `None` when the endpoint does not report it.
    #: Never estimated: a character-count approximation presented as provider
    #: token usage is a number nobody can act on.
    input_tokens: int | None = None
    output_tokens: int | None = None
    error: str | None = None


@dataclass
class _Ledger:
    calls: list[ProviderCall] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)


_ledger = _Ledger()


@contextmanager
def operation(name: str) -> Iterator[None]:
    """Label every provider call made in this block.

    Restores the previous label rather than clearing it, so a nested measurement
    inside a caller's own block does not erase the caller's.
    """
    token = _operation.set(name)
    try:
        yield
    finally:
        _operation.reset(token)


def record(call: ProviderCall) -> None:
    with _ledger.lock:
        _ledger.calls.append(call)


def snapshot() -> list[ProviderCall]:
    """Every call recorded since the last `reset`, in order."""
    with _ledger.lock:
        return list(_ledger.calls)


def total() -> int:
    return len(snapshot())


def reset() -> None:
    with _ledger.lock:
        _ledger.calls.clear()


def summary() -> dict[str, Any]:
    """Counts by operation and outcome, for a benchmark to print."""
    calls = snapshot()
    by_operation: dict[str, int] = {}
    for call in calls:
        by_operation[call.operation] = by_operation.get(call.operation, 0) + 1
    return {
        "calls": len(calls),
        "failed": sum(1 for call in calls if not call.ok),
        "by_operation": by_operation,
        "input_tokens": sum(c.input_tokens or 0 for c in calls),
        "output_tokens": sum(c.output_tokens or 0 for c in calls),
        "usage_reported": all(c.input_tokens is not None for c in calls) if calls else True,
    }


def _usage_of(result: LLMResult) -> tuple[int | None, int | None]:
    """Provider-reported usage, or `(None, None)`.

    The field names follow the Chat Completions convention — `prompt_tokens` and
    `completion_tokens` — because that is the one every compatible endpoint
    implements. Some do not report usage at all, and the honest answer there is
    that it is unavailable.
    """
    usage = getattr(result, "usage", None)
    if usage is None:
        return None, None
    return (
        getattr(usage, "prompt_tokens", None),
        getattr(usage, "completion_tokens", None),
    )


class CountingProvider(LLMProvider):
    """Delegates to a real provider and records what it did.

    Transparent on purpose: the wrapped provider's return value and exceptions
    pass through untouched, so a caller cannot tell it is being measured and
    cannot start depending on the measurement.
    """

    def __init__(self, inner: LLMProvider) -> None:
        self._inner = inner
        self.protocol = inner.protocol
        # The model lives on the provider's configuration, not on the request:
        # `LLMRequest` deliberately carries only what a caller chooses per call.
        config = getattr(inner, "_config", None) or getattr(inner, "config", None)
        self.model = getattr(config, "model", "") or ""

    async def generate(self, request: LLMRequest) -> LLMResult:
        label = _operation.get()
        try:
            result = await self._inner.generate(request)
        except BaseException as error:  # noqa: BLE001 - recorded, then re-raised
            record(ProviderCall(
                operation=label, model=self.model,
                protocol=self.protocol, ok=False, error=type(error).__name__,
            ))
            raise
        input_tokens, output_tokens = _usage_of(result)
        record(ProviderCall(
            operation=label,
            model=getattr(result, "model", None) or self.model,
            protocol=self.protocol, ok=True,
            input_tokens=input_tokens, output_tokens=output_tokens,
        ))
        return result

    def unwrap(self) -> LLMProvider:
        """The provider actually doing the work.

        The wrapper is transparent to *behaviour* and not to `isinstance`, and
        pretending otherwise would need machinery nobody benefits from. Detection
        tests ask which adapter was chosen; asking that of the delegate is the
        same question, and this is how they ask it.
        """
        return self._inner

    async def test_connection(self):
        # A connectivity probe is not a paper's worth of work, and counting it
        # would make "did opening this document cost anything?" answerable only
        # after subtracting a probe. It stays out of the ledger.
        return await self._inner.test_connection()

    async def generate_stream(self, request: LLMRequest) -> AsyncIterator[str]:
        async for chunk in self._inner.generate_stream(request):
            yield chunk
