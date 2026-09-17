"""Writing a derived artifact without ever leaving a half-written one behind.

The IR and the analysis both live in a document's directory as JSON files, and
both must survive a process dying mid-write. The rule is the same in each case:
write to a sibling temporary file, then rename it into place. A rename within one
filesystem is atomic, so a reader sees either the previous file or the new one,
never a truncated mixture.

The temporary file is a **sibling** rather than something in the system temp
directory, because a rename across filesystems is a copy and stops being atomic.

A reader that finds a corrupt file treats it as absent and regenerates, which is
strictly better than failing permanently on a bad cache.
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path


def write_text_atomic(directory: Path, filename: str, text: str, *, temp_prefix: str) -> Path:
    """Write ``text`` to ``directory/filename`` atomically."""
    target_dir = Path(directory)
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / filename
    temporary = target_dir / f"{temp_prefix}{uuid.uuid4().hex}.tmp"

    try:
        temporary.write_text(text, encoding="utf-8")
        os.replace(temporary, target)
    except BaseException:
        # Including cancellation: a caller interrupted mid-write must not leave a
        # temporary file that a later leak check would flag.
        temporary.unlink(missing_ok=True)
        raise

    return target


def remove_temp_files(directory: Path, temp_prefix: str) -> int:
    """Delete leftover temporary files. Returns how many were removed."""
    removed = 0
    for leftover in Path(directory).glob(f"{temp_prefix}*"):
        leftover.unlink(missing_ok=True)
        removed += 1
    return removed
