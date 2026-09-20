"""A read-out of the provider ledger, for measuring the product from outside it.

## Why this exists

The browser cannot see a model call. The page talks to localhost, and localhost
talks to the provider — so every "provider calls: 0" claim this repository made
before DS-QA-015 rested on counting the wrong thing. A browser acceptance that
has to *prove* a cold open costs nothing needs the number the backend keeps, and
there is no way to read an in-process ledger from another process.

## Why it is gated

The route is registered **only when `ENABLE_PROVIDER_LEDGER=1`**. A default run
does not have it: this is instrumentation for a harness, not a product surface,
and an endpoint that reports what the application has been spending is not
something a reader asked for. The harness sets the variable when it starts the
backend; nothing else does.

It reports counts and token totals — the same fields `CountingProvider` records —
and never a prompt, a completion, a credential or a line of anybody's paper.
"""

from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter

from app.llm import accounting

router = APIRouter(tags=["instrumentation"])


def enabled() -> bool:
    return os.environ.get("ENABLE_PROVIDER_LEDGER", "") == "1"


@router.get("/_debug/provider-ledger")
async def provider_ledger() -> Any:
    """How many calls have left this process, and what they cost."""
    summary = accounting.summary()
    return {
        "calls": summary["calls"],
        "failed": summary["failed"],
        "by_operation": summary["by_operation"],
        "input_tokens": summary["input_tokens"],
        "output_tokens": summary["output_tokens"],
        "usage_reported": summary["usage_reported"],
    }


@router.post("/_debug/provider-ledger/reset")
async def reset_provider_ledger() -> Any:
    """Zero the ledger, so a scenario measures only its own action."""
    accounting.reset()
    return {"calls": 0}
