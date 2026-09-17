"""Persistence for documents and translation tasks.

Two rules shape this module:

* **A user's file is never deleted.** A path-imported document points at a file
  the user owns and put somewhere; deleting the record must leave it exactly
  where it was. Only uploads — files this application copied in — are removable.
* **A document's files live under a directory named by its opaque id**, so no
  caller-supplied filename ever becomes a path.
"""

from __future__ import annotations

import shutil
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

DOCUMENT_ID_PREFIX = "doc_"
TASK_ID_PREFIX = "task_"

#: The states the kernel can actually distinguish. `ANALYZING` and `RENDERING`
#: appear in the API contract but the fast kernel runs one unified pipeline and
#: exposes only per-page progress — reporting those would be invention.
STATUS_PENDING = "PENDING"
STATUS_TRANSLATING = "TRANSLATING"
STATUS_SUCCEEDED = "SUCCESS"
STATUS_FAILED = "FAILED"
STATUS_CANCELLED = "CANCELLED"

ACTIVE_STATUSES = (STATUS_PENDING, STATUS_TRANSLATING)
TERMINAL_STATUSES = (STATUS_SUCCEEDED, STATUS_FAILED, STATUS_CANCELLED)

#: Error code used when a task was mid-flight as the process exited.
PROCESS_INTERRUPTED = "PROCESS_INTERRUPTED"


class DocumentStoreError(Exception):
    """Base class for document and task store failures."""


class DocumentNotFoundError(DocumentStoreError):
    pass


class TaskNotFoundError(DocumentStoreError):
    pass


class DocumentBusyError(DocumentStoreError):
    """A translation is already active for this document."""


class TaskAlreadyTerminalError(DocumentStoreError):
    """The task has finished; there is nothing left to cancel."""


def _now() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def _new_id(prefix: str) -> str:
    return f"{prefix}{uuid.uuid4().hex}"


@dataclass(frozen=True)
class DocumentRecord:
    id: str
    name: str
    page_count: int
    is_upload: bool
    source_path: Path | None
    created_at: str
    updated_at: str


@dataclass(frozen=True)
class TaskRecord:
    id: str
    document_id: str
    profile_id: str
    status: str
    lang_in: str
    lang_out: str
    engine: str
    progress_page: int | None
    progress_page_count: int | None
    error_code: str | None
    error_message: str | None
    created_at: str
    updated_at: str


class DocumentStore:
    """Documents and tasks, backed by a bootstrapped SQLite connection."""

    def __init__(self, connection: sqlite3.Connection, documents_dir: Path) -> None:
        self._connection = connection
        self._documents_dir = Path(documents_dir)

    # -- layout -------------------------------------------------------------

    def document_dir(self, document_id: str) -> Path:
        """The managed directory for a document.

        Named by the opaque id alone, so nothing a caller supplies can escape it.
        """
        return self._documents_dir / document_id

    def source_file(self, document_id: str) -> Path:
        return self.document_dir(document_id) / "source.pdf"

    def mono_file(self, document_id: str) -> Path:
        return self.document_dir(document_id) / "mono.pdf"

    def dual_file(self, document_id: str) -> Path:
        return self.document_dir(document_id) / "dual.pdf"

    # -- documents ----------------------------------------------------------

    def create_document(
        self,
        *,
        name: str,
        page_count: int,
        is_upload: bool,
        source_path: Path | None = None,
    ) -> DocumentRecord:
        document_id = _new_id(DOCUMENT_ID_PREFIX)
        self.document_dir(document_id).mkdir(parents=True, exist_ok=True)
        now = _now()
        self._connection.execute(
            """
            INSERT INTO documents
                (id, name, page_count, is_upload, source_path, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                document_id, name, page_count, 1 if is_upload else 0,
                str(source_path) if source_path is not None else None, now, now,
            ),
        )
        self._connection.commit()
        return self.get_document(document_id)

    def get_document(self, document_id: str) -> DocumentRecord:
        row = self._connection.execute(
            "SELECT * FROM documents WHERE id = ?", (document_id,)
        ).fetchone()
        if row is None:
            raise DocumentNotFoundError(f"No document with id {document_id!r}.")
        return _document_from_row(row)

    def list_documents(self) -> list[DocumentRecord]:
        rows = self._connection.execute(
            "SELECT * FROM documents ORDER BY created_at DESC"
        ).fetchall()
        return [_document_from_row(row) for row in rows]

    def delete_document(self, document_id: str) -> None:
        """Remove a document record and its *derived* artifacts.

        The user's original is left alone in every case. For an upload, the
        managed copy is ours to remove; for a path import there is nothing of
        ours to remove beyond the derived outputs.
        """
        record = self.get_document(document_id)  # raises if unknown
        self._connection.execute("DELETE FROM documents WHERE id = ?", (document_id,))
        self._connection.commit()

        # `source_path` is deliberately never consulted here. Even for a path
        # import, the only thing deleted is our own directory.
        shutil.rmtree(self.document_dir(record.id), ignore_errors=True)

    # -- tasks --------------------------------------------------------------

    def create_task(
        self,
        *,
        document_id: str,
        profile_id: str,
        lang_in: str,
        lang_out: str,
        engine: str,
    ) -> TaskRecord:
        if self.active_task_for_document(document_id) is not None:
            raise DocumentBusyError(
                "A translation is already running for this document."
            )

        task_id = _new_id(TASK_ID_PREFIX)
        now = _now()
        self._connection.execute(
            """
            INSERT INTO translation_tasks
                (id, document_id, profile_id, status, lang_in, lang_out, engine,
                 created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                task_id, document_id, profile_id, STATUS_PENDING,
                lang_in, lang_out, engine, now, now,
            ),
        )
        self._connection.commit()
        return self.get_task(task_id)

    def get_task(self, task_id: str) -> TaskRecord:
        row = self._connection.execute(
            "SELECT * FROM translation_tasks WHERE id = ?", (task_id,)
        ).fetchone()
        if row is None:
            raise TaskNotFoundError(f"No task with id {task_id!r}.")
        return _task_from_row(row)

    def active_task_for_document(self, document_id: str) -> TaskRecord | None:
        placeholders = ", ".join("?" for _ in ACTIVE_STATUSES)
        row = self._connection.execute(
            f"SELECT * FROM translation_tasks WHERE document_id = ? "
            f"AND status IN ({placeholders}) ORDER BY created_at DESC LIMIT 1",
            (document_id, *ACTIVE_STATUSES),
        ).fetchone()
        return _task_from_row(row) if row else None

    def update_task(
        self,
        task_id: str,
        *,
        status: str | None = None,
        progress_page: int | None = None,
        progress_page_count: int | None = None,
        error_code: str | None = None,
        error_message: str | None = None,
    ) -> TaskRecord:
        assignments: dict[str, object] = {"updated_at": _now()}
        if status is not None:
            assignments["status"] = status
        if progress_page is not None:
            assignments["progress_page"] = progress_page
        if progress_page_count is not None:
            assignments["progress_page_count"] = progress_page_count
        if error_code is not None:
            assignments["error_code"] = error_code
        if error_message is not None:
            assignments["error_message"] = error_message

        columns = ", ".join(f"{name} = ?" for name in assignments)
        self._connection.execute(
            f"UPDATE translation_tasks SET {columns} WHERE id = ?",  # noqa: S608 - closed set of columns
            (*assignments.values(), task_id),
        )
        self._connection.commit()
        return self.get_task(task_id)

    def reconcile_interrupted_tasks(self) -> int:
        """Fail tasks that were mid-flight when the process last exited.

        A task lives in memory while it runs, so a restart orphans it. Leaving it
        as `TRANSLATING` forever would make it look like work still in progress;
        saying plainly that it was interrupted is the honest option.
        """
        placeholders = ", ".join("?" for _ in ACTIVE_STATUSES)
        cursor = self._connection.execute(
            f"UPDATE translation_tasks SET status = ?, error_code = ?, "
            f"error_message = ?, updated_at = ? WHERE status IN ({placeholders})",
            (
                STATUS_FAILED,
                PROCESS_INTERRUPTED,
                "Translation was interrupted by a backend restart.",
                _now(),
                *ACTIVE_STATUSES,
            ),
        )
        self._connection.commit()
        return cursor.rowcount or 0


def _document_from_row(row: sqlite3.Row) -> DocumentRecord:
    raw_path = row["source_path"]
    return DocumentRecord(
        id=row["id"],
        name=row["name"],
        page_count=row["page_count"],
        is_upload=bool(row["is_upload"]),
        source_path=Path(raw_path) if raw_path else None,
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _task_from_row(row: sqlite3.Row) -> TaskRecord:
    return TaskRecord(
        id=row["id"],
        document_id=row["document_id"],
        profile_id=row["profile_id"],
        status=row["status"],
        lang_in=row["lang_in"],
        lang_out=row["lang_out"],
        engine=row["engine"],
        progress_page=row["progress_page"],
        progress_page_count=row["progress_page_count"],
        error_code=row["error_code"],
        error_message=row["error_message"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )
