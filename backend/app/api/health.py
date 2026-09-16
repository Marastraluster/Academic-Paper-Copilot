"""Health endpoint (AC-04).

Deliberately dependency-free: it reports that the process is alive and which
version is running. It does **not** probe the database or any downstream
service, so it stays fast (AC-33) and cannot itself become a source of failure.

A richer readiness probe (layout model present, OCR data present) belongs to the
PDF phase — see docs/API_CONTRACT.md §1.
"""

from __future__ import annotations

from fastapi import APIRouter

from app import __version__

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "version": __version__}
