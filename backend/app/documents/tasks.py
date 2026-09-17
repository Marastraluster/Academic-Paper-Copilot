"""Running translations in the background.

The kernel is synchronous and takes minutes, so it cannot run on the event loop
and the request that starts it must not be the one that waits for it. This module
owns that boundary: it schedules the work, bridges progress back to the loop
safely, and records an honest terminal state.

Only states the kernel can actually distinguish are used. The API contract
mentions `ANALYZING` and `RENDERING`, but the fast kernel runs one unified
pipeline and reports per-page progress — so those states are never emitted.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import shutil
from pathlib import Path
from typing import Any

from app.documents.store import (
    ACTIVE_STATUSES,
    STATUS_CANCELLED,
    STATUS_FAILED,
    STATUS_SUCCEEDED,
    STATUS_TRANSLATING,
    DocumentBusyError,
    DocumentStore,
    TaskAlreadyTerminalError,
    TaskRecord,
)
from app.llm.errors import sanitize_message
from app.logging import get_logger
from app.pdfkernel import PDFKernelError, translate_pdf

logger = get_logger(__name__)

#: How many events a slow subscriber may fall behind before older ones are
#: dropped. Progress is a snapshot, not a ledger — the newest value is the
#: useful one, so a lagging consumer should not be able to stall a translation.
_SUBSCRIBER_QUEUE_SIZE = 64


class TaskRunner:
    """Schedules translations and publishes their progress."""

    def __init__(self, store: DocumentStore, profiles: Any) -> None:
        self._store = store
        self._profiles = profiles
        self._subscribers: dict[str, set[asyncio.Queue]] = {}
        self._cancel_events: dict[str, asyncio.Event] = {}
        self._runners: dict[str, asyncio.Task] = {}

    # -- lifecycle ----------------------------------------------------------

    def start(
        self,
        *,
        document_id: str,
        profile_id: str,
        lang_in: str,
        lang_out: str,
        engine: str,
    ) -> TaskRecord:
        """Create a task record and schedule it. Returns immediately."""
        task = self._store.create_task(
            document_id=document_id,
            profile_id=profile_id,
            lang_in=lang_in,
            lang_out=lang_out,
            engine=engine,
        )
        self._runners[task.id] = asyncio.create_task(self._run(task))
        return task

    def cancel(self, task_id: str) -> TaskRecord:
        """Request cancellation at the next page boundary."""
        task = self._store.get_task(task_id)

        if task.status not in ACTIVE_STATUSES:
            raise TaskAlreadyTerminalError(
                f"Task {task_id!r} is already {task.status}; nothing to cancel."
            )

        event = self._cancel_events.get(task_id)
        if event is not None:
            event.set()

        # The stored status only changes to CANCELLED when the kernel actually
        # stops. Reporting it as cancelled now would claim something untrue.
        return task

    async def shutdown(self) -> None:
        """Ask every in-flight translation to stop, and wait briefly."""
        for event in self._cancel_events.values():
            event.set()
        runners = list(self._runners.values())
        for runner in runners:
            runner.cancel()
        for runner in runners:
            with contextlib.suppress(BaseException):
                await runner

    # -- progress subscription ---------------------------------------------

    def subscribe(self, task_id: str) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=_SUBSCRIBER_QUEUE_SIZE)
        self._subscribers.setdefault(task_id, set()).add(queue)
        return queue

    def unsubscribe(self, task_id: str, queue: asyncio.Queue) -> None:
        subscribers = self._subscribers.get(task_id)
        if subscribers is not None:
            subscribers.discard(queue)
            if not subscribers:
                self._subscribers.pop(task_id, None)

    def _publish(self, task_id: str, event: dict) -> None:
        """Fan out an event, dropping the oldest for a lagging subscriber."""
        for queue in list(self._subscribers.get(task_id, ())):
            if queue.full():
                with contextlib.suppress(asyncio.QueueEmpty):
                    queue.get_nowait()
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(event)

    # -- the work -----------------------------------------------------------

    async def _run(self, task: TaskRecord) -> None:
        loop = asyncio.get_running_loop()
        cancel_event = asyncio.Event()
        self._cancel_events[task.id] = cancel_event

        def on_progress(page: int, total: int) -> None:
            # Called from the worker thread; everything it touches must hop back
            # to the loop before mutating shared state.
            loop.call_soon_threadsafe(self._record_progress, task.id, page, total)

        try:
            record = self._store.get_document(task.document_id)
            source = (
                self._store.source_file(record.id)
                if record.is_upload
                else record.source_path
            )
            if source is None or not Path(source).is_file():
                self._fail(task.id, "SOURCE_NOT_FOUND", "The source file is no longer available.")
                return

            config = self._profiles.to_provider_config(task.profile_id)
            document_dir = self._store.document_dir(task.document_id)
            # The kernel names its outputs after the source stem; a work
            # directory lets us place them under the canonical names afterwards,
            # and keeps a failed run's partial files away from the real ones.
            work_dir = document_dir / ".translation-work"
            shutil.rmtree(work_dir, ignore_errors=True)
            work_dir.mkdir(parents=True, exist_ok=True)

            self._store.update_task(task.id, status=STATUS_TRANSLATING)
            self._publish(task.id, {"event": "progress", "status": STATUS_TRANSLATING,
                                    "progress": {"page": 0, "page_count": record.page_count}})

            try:
                result = await translate_pdf(
                    source,
                    work_dir,
                    task.lang_out,
                    config,
                    source_lang=task.lang_in,
                    engine=task.engine,
                    overwrite=True,
                    # The upstream cache is keyed without the endpoint, so a hit
                    # could return a translation produced by a *different*
                    # provider. Re-running is the safe default until the cache
                    # phase fixes the key.
                    ignore_cache=True,
                    on_progress=on_progress,
                    cancellation_event=cancel_event,
                )
                # Moved out of the work directory *before* it is cleaned up —
                # otherwise the finally below would delete the results.
                if not cancel_event.is_set():
                    self._place_artifacts(
                        task.document_id, result.mono_path, result.dual_path
                    )
            except PDFKernelError as exc:
                if cancel_event.is_set():
                    self._mark_cancelled(task.id)
                else:
                    self._fail(task.id, exc.code, exc.message)
                return
            except asyncio.CancelledError:
                self._mark_cancelled(task.id)
                raise
            finally:
                shutil.rmtree(work_dir, ignore_errors=True)

            if cancel_event.is_set():
                self._mark_cancelled(task.id)
                return

            self._store.update_task(
                task.id,
                status=STATUS_SUCCEEDED,
                progress_page=result.source_page_count,
                progress_page_count=result.source_page_count,
            )
            self._publish(task.id, {
                "event": "done",
                "status": STATUS_SUCCEEDED,
                "page_count": result.source_page_count,
                "translated_page_count": result.mono_page_count,
            })
        except Exception:  # noqa: BLE001 - a background task must never die silently
            logger.exception("Translation task failed unexpectedly", extra={"task_id": task.id})
            self._fail(task.id, "INTERNAL_ERROR", "Translation failed.")
        finally:
            self._cancel_events.pop(task.id, None)
            self._runners.pop(task.id, None)

    def _record_progress(self, task_id: str, page: int, total: int) -> None:
        try:
            self._store.update_task(task_id, progress_page=page, progress_page_count=total)
        except Exception:  # noqa: BLE001 - progress is best-effort
            return
        self._publish(task_id, {"event": "progress", "status": STATUS_TRANSLATING,
                                "progress": {"page": page, "page_count": total}})

    def _mark_cancelled(self, task_id: str) -> None:
        self._store.update_task(task_id, status=STATUS_CANCELLED)
        self._publish(task_id, {"event": "cancelled", "status": STATUS_CANCELLED})

    def _fail(self, task_id: str, code: str, message: str) -> None:
        # Kernel messages are already sanitised, but the key literal is stripped
        # again here so a future path that forgets cannot leak one.
        safe = sanitize_message(message or "Translation failed.")
        self._store.update_task(
            task_id, status=STATUS_FAILED, error_code=code, error_message=safe
        )
        self._publish(task_id, {"event": "error", "status": STATUS_FAILED,
                                "code": code, "message": safe})

    def _place_artifacts(self, document_id: str, mono: Path, dual: Path) -> None:
        """Move the kernel's outputs to their canonical names."""
        target_dir = self._store.document_dir(document_id)
        target_dir.mkdir(parents=True, exist_ok=True)
        for produced, target in (
            (mono, self._store.mono_file(document_id)),
            (dual, self._store.dual_file(document_id)),
        ):
            if Path(produced).is_file():
                os.replace(produced, target)


__all__ = ["TaskRunner", "DocumentBusyError"]
