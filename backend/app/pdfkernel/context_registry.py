"""Handing each translation run its own context, without a global.

Upstream constructs the translator itself, from a service name, on a worker
thread — so the only way to give it per-run state is to substitute the class
(which the adapter already does) and let it *look up* that state.

The lookup key travels in `envs`, which upstream already threads through to the
constructor, and it is a single opaque id rather than the context itself. The
registry behind it is guarded by a lock and keyed by a UUID minted per run, so
two documents translating at once cannot see each other's context — and an entry
is removed in a `finally`, so a failed run does not leak the analysis of a paper
the user has moved on from.

A weak `ContextVar` would be tidier, but upstream's inner `ThreadPoolExecutor`
does not propagate context variables to its workers, so the unit threads would
not see it. An explicit registry does not depend on that.
"""

from __future__ import annotations

import threading
import uuid
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover - import for typing only
    from app.context.translation_context import UnitContextProvider

#: The `envs` key upstream passes to the translator constructor.
RUN_ID_ENV = "PDFCOPILOT_CONTEXT_RUN_ID"

_REGISTRY: dict[str, "UnitContextProvider"] = {}
_LOCK = threading.Lock()


def register(provider: "UnitContextProvider") -> str:
    """Make ``provider`` reachable from the translator about to be constructed."""
    run_id = uuid.uuid4().hex
    with _LOCK:
        _REGISTRY[run_id] = provider
    return run_id


def lookup(run_id: str | None) -> "UnitContextProvider | None":
    """The provider for a run, or ``None`` — never an exception.

    A missing entry is a legitimate state: a translation started with no context
    at all, or one whose provider was released because the run was abandoned.
    """
    if not run_id:
        return None
    with _LOCK:
        return _REGISTRY.get(run_id)


def release(run_id: str | None) -> None:
    """Drop a run's provider. Called in a `finally`, so it always happens."""
    if not run_id:
        return
    with _LOCK:
        _REGISTRY.pop(run_id, None)


def active_runs() -> int:
    """How many providers are currently registered. Used by tests to prove cleanup."""
    with _LOCK:
        return len(_REGISTRY)
