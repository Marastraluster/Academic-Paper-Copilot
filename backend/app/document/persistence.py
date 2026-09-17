"""Reading and writing ``ir.json``.

The IR lives beside ``source.pdf``, ``mono.pdf`` and ``dual.pdf`` in the
document's own directory. That choice is not incidental:

* it is deleted with the document, with no cleanup path to forget;
* it needs no SQLite migration, and `tests/test_db.py` pins the table set
  precisely because speculative tables were a real hazard;
* it does not contend with the database's single writer while a translation is
  running.

Writes are atomic. An extraction that fails halfway must not leave a truncated
JSON file that the next read would parse as a complete — and wrong — document.
The temporary file is a sibling so the final rename stays within one filesystem.
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path

from app.document.models import DocumentIR

IR_FILENAME = "ir.json"

#: Prefix for the temporary file an atomic write goes through. Also what a
#: leak check looks for: a stray one means a write died mid-flight.
TEMP_PREFIX = ".ir-"


def ir_path(document_dir: Path) -> Path:
    return Path(document_dir) / IR_FILENAME


def write_ir(document_dir: Path, ir: DocumentIR) -> Path:
    """Serialise ``ir`` into ``document_dir`` atomically."""
    directory = Path(document_dir)
    directory.mkdir(parents=True, exist_ok=True)
    target = ir_path(directory)
    temporary = directory / f"{TEMP_PREFIX}{uuid.uuid4().hex}.json"

    try:
        temporary.write_text(ir.model_dump_json(indent=2), encoding="utf-8")
        os.replace(temporary, target)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise

    return target


def read_ir(document_dir: Path) -> DocumentIR | None:
    """Load the stored IR, or ``None`` if there is not a usable one.

    A file that exists but does not parse is treated as absent rather than fatal:
    the caller can re-extract, which is strictly better than failing forever on a
    corrupt cache.
    """
    path = ir_path(document_dir)
    if not path.is_file():
        return None
    try:
        return DocumentIR.model_validate_json(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None


def delete_ir(document_dir: Path) -> None:
    """Remove the stored IR and any temporary file left by a failed write."""
    directory = Path(document_dir)
    ir_path(directory).unlink(missing_ok=True)
    for leftover in directory.glob(f"{TEMP_PREFIX}*.json"):
        leftover.unlink(missing_ok=True)
