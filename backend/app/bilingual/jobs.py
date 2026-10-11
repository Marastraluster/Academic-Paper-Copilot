"""Paragraph translation as a background job the reader can read along with.

The synchronous ``POST /bilingual-text`` translates a whole paper inside one
request: minutes with no progress, and a closed tab threw the paid-for work
away. A job instead:

* **keeps every batch as it lands** (`write_partial`), so the column fills in
  from the first batch and nothing already paid for is lost;
* **resumes** — started again after a stop, it sends only batches with a
  paragraph still missing;
* **reports progress in batches**, the unit the work is actually done in, so a
  progress bar measures something real;
* **runs a few batches at once** (bounded), because batches are independent and
  a paper is otherwise as slow as its slowest call times the batch count.

A provider failure that would fail every batch (a refused key, an unreachable
endpoint) stops the job and names the failure; what was translated before it
stays. A batch the model answered badly twice is a gap, not a stop — the same
rule as the synchronous path.
"""

from __future__ import annotations

import asyncio
import threading
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.bilingual.cache import (
    delete_partial,
    read_partial,
    write_bilingual,
    write_partial,
)
from app.bilingual import glossary as paper_glossary
from app.bilingual.models import BilingualArtifact
from app.bilingual.pipeline import Batch, Plan, assemble, heading_views_for, plan, translate_batch
from app.document.models import DocumentIR
from app.llm.base import LLMProvider
from app.llm.errors import LLMError, sanitize_message
from app.logging import get_logger

logger = get_logger(__name__)

DEFAULT_CONCURRENCY = 2
MAX_CONCURRENCY = 4

ACTIVE = frozenset({"running"})


def _now() -> str:
    return datetime.now(tz=timezone.utc).replace(microsecond=0).isoformat()


@dataclass
class TranslationJob:
    document_id: str
    content_hash: str
    target_language: str
    status: str = "running"
    total_batches: int = 0
    done_batches: int = 0
    failed_batches: int = 0
    total_paragraphs: int = 0
    translated_paragraphs: int = 0
    started_at: str = field(default_factory=_now)
    finished_at: str | None = None
    code: str | None = None
    message: str | None = None
    #: Batches already done by an earlier run of this paper; not paid for again.
    resumed_batches: int = 0
    #: ``glossary`` while the paper's terms are being read (one call, before the
    #: first batch), then ``translating``.
    phase: str = "translating"
    glossary_terms: int = 0

    def payload(self) -> dict[str, Any]:
        return asdict(self)


Key = tuple[str, str]
_jobs: dict[Key, TranslationJob] = {}
_tasks: dict[Key, asyncio.Task[None]] = {}


def key_for(content_hash: str, target_language: str) -> Key:
    return (content_hash, target_language)


def get(content_hash: str, target_language: str) -> TranslationJob | None:
    return _jobs.get(key_for(content_hash, target_language))


def is_running(content_hash: str, target_language: str) -> bool:
    job = get(content_hash, target_language)
    return job is not None and job.status in ACTIVE


def pending_ids(work: Plan, translated: dict[str, str]) -> set[str]:
    return {
        paragraph.id
        for batch in work.batches
        for paragraph in batch.paragraphs
        if paragraph.id not in translated
    }


def snapshot(
    ir: DocumentIR,
    documents_dir: Path,
    target_language: str,
) -> BilingualArtifact | None:
    """What a running (or stopped) job has produced so far, or ``None``."""
    partial = read_partial(
        documents_dir,
        content_hash=ir.content_hash,
        ir_pipeline_version=ir.pipeline_version,
        target_language=target_language,
    )
    running = is_running(ir.content_hash, target_language)
    if partial is None:
        if not running:
            return None
        # A job whose first batch has not landed yet: every paragraph is on its
        # way. Answering "nothing here" sent the column back to the button that
        # had just been pressed, with the job running unseen behind it.
        partial = {"translated": {}, "headings": {}}
    work = plan(ir)
    translated = dict(partial["translated"])
    return assemble(
        ir, work, heading_views_for(work), translated, dict(partial["headings"]),
        target_language=target_language,
        provider_model=str(partial.get("provider_model") or ""),
        # Still on its way only while a job is working; after a stop, a missing
        # paragraph is simply missing until the reader resumes.
        pending=pending_ids(work, translated) if running else None,
    )


async def run(
    job: TranslationJob,
    *,
    ir: DocumentIR,
    provider: LLMProvider,
    documents_dir: Path,
    provider_base_url: str = "",
    glossary: list[str] | None = None,
    concurrency: int = DEFAULT_CONCURRENCY,
    make_glossary: bool = False,
) -> TranslationJob:
    """Translate what is still missing, batch by batch.

    ``make_glossary`` reads the paper's terms first when it has no glossary yet
    — one more call, once per paper. A glossary that exists (the reader may have
    corrected it) is used as it is and never regenerated here.
    """
    work = plan(ir)
    heading_views = heading_views_for(work)
    partial = read_partial(
        documents_dir,
        content_hash=ir.content_hash,
        ir_pipeline_version=ir.pipeline_version,
        target_language=job.target_language,
    ) or {}
    translated: dict[str, str] = dict(partial.get("translated") or {})
    headings: dict[str, str] = dict(partial.get("headings") or {})
    model = str(partial.get("provider_model") or "")

    # Only what is missing is sent. After a stop that is whole batches; after
    # the reader corrects a term it is the few paragraphs that term occurs in,
    # and resending their neighbours would pay again for text that did not change.
    todo = [
        Batch(paragraphs=missing)
        for batch in work.batches
        if (missing := [paragraph for paragraph in batch.paragraphs if paragraph.id not in translated])
    ]
    job.total_batches = len(work.batches)
    job.resumed_batches = job.done_batches = len(work.batches) - len(todo)
    job.total_paragraphs = work.paragraph_count
    job.translated_paragraphs = sum(1 for key in translated if key in pending_ids(work, {}))

    # One write at a time. A batch's shielded write may still be in its thread
    # when a sibling's failure makes the job write again; on Windows two
    # replaces of one file collide (PermissionError) and the job died of it.
    writing = threading.Lock()

    def persist() -> None:
        with writing:
            write_partial(
                documents_dir,
                content_hash=ir.content_hash,
                ir_pipeline_version=ir.pipeline_version,
                target_language=job.target_language,
                translated=dict(translated),
                headings=dict(headings),
                provider_model=model,
            )

    terms = paper_glossary.read_terms(documents_dir, ir.content_hash, job.target_language)
    if terms is None and make_glossary and todo:
        job.phase = "glossary"
        try:
            terms = await paper_glossary.extract(work, provider, target_language=job.target_language)
        except asyncio.CancelledError:
            job.status, job.code, job.message = "cancelled", "CANCELLED", "翻译已停止，已完成的段落会保留。"
            job.finished_at = _now()
            raise
        except LLMError as failure:
            # A refused key or an unreachable endpoint would fail every batch too.
            job.status, job.finished_at = "failed", _now()
            job.code, job.message = failure.code, sanitize_message(failure.message)
            return job
        await asyncio.to_thread(
            paper_glossary.write_terms, documents_dir, ir.content_hash, job.target_language, terms
        )
    job.phase = "translating"
    job.glossary_terms = len(terms or [])

    lock = asyncio.Lock()
    gate = asyncio.Semaphore(max(1, min(MAX_CONCURRENCY, concurrency)))

    async def one(batch) -> None:
        nonlocal model
        async with gate:
            result = await translate_batch(
                batch, heading_views, provider,
                target_language=job.target_language, glossary=glossary, terms=terms,
            )
        async with lock:
            job.done_batches += 1
            model = result.model or model
            if result.failed:
                job.failed_batches += 1
                return
            translated.update(result.translations)
            for identifier, text in result.headings.items():
                headings.setdefault(identifier, text)
            job.translated_paragraphs = sum(
                1 for b in work.batches for p in b.paragraphs if p.id in translated
            )
            # Shielded: a sibling batch failing cancels this task, and a batch
            # that has already been paid for must still reach the disk.
            await asyncio.shield(asyncio.to_thread(persist))

    failure: BaseException | None = None
    try:
        async with asyncio.TaskGroup() as group:
            for batch in todo:
                group.create_task(one(batch))
    except asyncio.CancelledError:
        job.status, job.code, job.message = "cancelled", "CANCELLED", "翻译已停止，已完成的段落会保留。"
        job.finished_at = _now()
        if translated:
            persist()
        raise
    except BaseExceptionGroup as failures:  # noqa: B036 - inspected, then reported
        failure = next(
            (e for e in failures.exceptions if not isinstance(e, asyncio.CancelledError)),
            failures.exceptions[0],
        )

    if failure is not None:
        # Whatever landed before the failure is the reader's; keep it.
        if translated:
            await asyncio.to_thread(persist)
        job.finished_at = _now()
        job.status = "failed"
        if isinstance(failure, LLMError):
            job.code = failure.code
            job.message = sanitize_message(failure.message)
        else:
            logger.error(
                "bilingual job failed",
                extra={"document_id": job.document_id, "reason": type(failure).__name__},
            )
            job.code = "INTERNAL_ERROR"
            job.message = f"翻译中断：{type(failure).__name__}"
        return job

    artifact = assemble(
        ir, work, heading_views, translated, headings,
        target_language=job.target_language,
        failed_batches=job.failed_batches,
        provider_model=model,
        provider_base_url=provider_base_url,
        created_at=_now(),
    )
    if artifact.is_usable():
        await asyncio.to_thread(write_bilingual, documents_dir, artifact)
    if artifact.status == "READY":
        # Complete: the artifact is the record now. A PARTIAL keeps its partial,
        # so "resume" can fill the gaps without repeating what succeeded.
        await asyncio.to_thread(delete_partial, documents_dir, ir.content_hash, job.target_language)
    job.status = "completed"
    job.finished_at = _now()
    return job


def start(
    *,
    document_id: str,
    ir: DocumentIR,
    provider: LLMProvider,
    documents_dir: Path,
    target_language: str,
    provider_base_url: str = "",
    glossary: list[str] | None = None,
    concurrency: int = DEFAULT_CONCURRENCY,
    make_glossary: bool = False,
) -> TranslationJob:
    """Start a job, or return the one already running for this paper and language."""
    key = key_for(ir.content_hash, target_language)
    current = _jobs.get(key)
    if current is not None and current.status in ACTIVE:
        return current
    job = TranslationJob(
        document_id=document_id, content_hash=ir.content_hash, target_language=target_language,
    )
    _jobs[key] = job
    task = asyncio.create_task(
        run(
            job, ir=ir, provider=provider, documents_dir=documents_dir,
            provider_base_url=provider_base_url, glossary=glossary, concurrency=concurrency,
            make_glossary=make_glossary,
        )
    )
    _tasks[key] = task
    task.add_done_callback(lambda _t: _tasks.pop(key, None))
    return job


async def stop(content_hash: str, target_language: str) -> TranslationJob | None:
    key = key_for(content_hash, target_language)
    task = _tasks.get(key)
    if task is not None:
        task.cancel()
        try:
            await task
        except BaseException:  # noqa: BLE001
            pass
    return _jobs.get(key)


async def cancel_all() -> None:
    for task in list(_tasks.values()):
        task.cancel()
    for task in list(_tasks.values()):
        try:
            await task
        except BaseException:  # noqa: BLE001
            pass
