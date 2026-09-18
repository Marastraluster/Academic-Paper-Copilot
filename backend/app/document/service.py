"""When to extract, when to reuse, and how not to do it twice.

Extraction is expensive — every page is rendered and pushed through a vision
model — so it happens once per document and is cached on disk. Two rules follow
from that, and both are enforced here rather than hoped for:

* **A read never re-does the work.** If an ``ir.json`` exists, it is returned.
  No PyMuPDF open, no ONNX session, which is what lets a cached read answer in
  milliseconds while an extraction takes seconds.
* **Concurrent readers do not race.** Two simultaneous requests for the same
  un-extracted document would otherwise both run the full pipeline, doubling the
  work and racing to write the same file. A per-document lock makes the second
  wait for the first and then reuse its result.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from pathlib import Path

from app.document.extract import (
    IR_PIPELINE_VERSION,
    DocumentExtractionError,
    extract_document_ir,
)
from app.document.models import DocumentIR
from app.document.persistence import read_ir, write_ir
from app.logging import get_logger

logger = get_logger(__name__)

#: One lock per document id, created on demand. Bounded by the number of
#: documents actually being read, which is small for a single-user desktop app.
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _lock_for(document_id: str) -> threading.Lock:
    with _locks_guard:
        lock = _locks.get(document_id)
        if lock is None:
            lock = threading.Lock()
            _locks[document_id] = lock
        return lock


@dataclass(frozen=True)
class ExtractionSummary:
    page_count: int
    paragraph_count: int
    section_count: int
    duration_seconds: float
    reused: bool


def load_ir(document_dir: Path) -> DocumentIR | None:
    """The cached IR, if one exists and parses. Never runs extraction."""
    return read_ir(document_dir)


def is_reusable(cached: DocumentIR | None, document_id: str) -> bool:
    """Whether a stored IR may answer for this document.

    Three conditions, and the third is the one that was missing. A stored IR is
    reused only when it is present, describes *this* document, and was produced by
    the **current** pipeline.

    Without the version check an improvement to extraction reached every new
    document and no existing one: the reading-order section correction
    (`ff744ab`) left a stored IR whose sections were assigned by page, with eight
    of sixteen owning no paragraphs, and nothing could tell. The same shape as
    `index.py`'s `SCHEMA_SIGNATURE` guard on the FTS index, applied to the IR.
    """
    return (
        cached is not None
        and cached.document_id == document_id
        and cached.pipeline_version == IR_PIPELINE_VERSION
    )


def extract_and_store(
    document_dir: Path,
    source_path: Path,
    document_id: str,
    *,
    force: bool = False,
) -> tuple[DocumentIR, ExtractionSummary]:
    """Return the IR for a document, extracting only if there is not one already.

    Blocking and CPU-bound: callers on the event loop must run this in a thread.
    """
    directory = Path(document_dir)

    if not force:
        cached = read_ir(directory)
        if is_reusable(cached, document_id):
            return cached, ExtractionSummary(
                page_count=cached.page_count,
                paragraph_count=len(cached.paragraphs),
                section_count=len(cached.sections),
                duration_seconds=0.0,
                reused=True,
            )

    # Serialised per document: the second caller waits, then reads the first
    # caller's result instead of repeating several seconds of inference.
    with _lock_for(document_id):
        if not force:
            cached = read_ir(directory)
            if is_reusable(cached, document_id):
                return cached, ExtractionSummary(
                    page_count=cached.page_count,
                    paragraph_count=len(cached.paragraphs),
                    section_count=len(cached.sections),
                    duration_seconds=0.0,
                    reused=True,
                )

        started = time.perf_counter()
        ir = extract_document_ir(source_path, document_id)
        write_ir(directory, ir)
        duration = time.perf_counter() - started

    logger.info(
        "document ir extracted",
        extra={
            "document_id": document_id,
            "pages": ir.page_count,
            "paragraphs": len(ir.paragraphs),
            "sections": len(ir.sections),
            "duration_s": round(duration, 3),
        },
    )

    return ir, ExtractionSummary(
        page_count=ir.page_count,
        paragraph_count=len(ir.paragraphs),
        section_count=len(ir.sections),
        duration_seconds=duration,
        reused=False,
    )


__all__ = [
    "DocumentExtractionError",
    "ExtractionSummary",
    "IR_PIPELINE_VERSION",
    "extract_and_store",
    "is_reusable",
    "load_ir",
]
