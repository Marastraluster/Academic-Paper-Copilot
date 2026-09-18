"""The per-document FTS5 index.

**One SQLite file per document**, at `<documents_dir>/<document_id>/search.db`,
beside `ir.json`, `analysis.json`, `mono.pdf` and `dual.pdf`.

Three reasons, in order of weight:

1. **BM25's IDF is computed over the whole table.** In a shared database holding
   every paper the user has ever opened, a robotics paper's term weights would be
   skewed by all the computer-vision and chemistry papers ingested before it.
   Per-document files keep the statistics local to the paper being searched.
2. **Isolation stops being a `WHERE` clause.** A query against document A cannot
   reach document B's paragraphs, because it never opens B's file. That is a
   structural guarantee rather than a discipline every future query must keep.
3. **The application database is untouched.** No migration, no schema version
   bump, and the guards that pin its table set pass unmodified. Derived artifacts
   already live in the document directory; this is one more.

The index records the `content_hash` it was built from. A mismatch marks it stale
and it is rebuilt — a stale index must never quietly answer for a document whose
source has changed.
"""

from __future__ import annotations

import sqlite3
import threading
from dataclasses import dataclass
from pathlib import Path

from app.document.models import LAYOUT_ABANDON, DocumentIR
from app.logging import get_logger

logger = get_logger(__name__)

INDEX_FILENAME = "search.db"

#: Bumped when the schema below changes, so an old file is rebuilt rather than
#: read with assumptions that no longer hold.
SCHEMA_SIGNATURE = "1"

#: Column weights for `bm25()`. The section title is matched and weighted above
#: the body, so a query naming a section topic can reach the prose that discusses
#: it — while a three-word heading is never itself returned as an answer, because
#: headings are not index rows.
#:
#: **The weight is not tuned, and this benchmark cannot tune it.** Re-running the
#: real ResNet set at 0.0 / 1.0 / 3.0 / 5.0 / 10.0 gives identical Hit@1/3/5/10 —
#: 60/70/70/80 — and 0.0 means removing the title column from ranking entirely.
#: 5.0 is kept as a conventional middle value that leaves the signal available.
#: Nothing measured depends on it, and saying otherwise would be inventing a
#: justification for a number that was chosen rather than derived.
TITLE_WEIGHT = 5.0
BODY_WEIGHT = 1.0

#: `abandon` is running headers, footers and page stamps. Excluded from the index
#: entirely rather than down-ranked: a paper's title repeats on every page, and
#: BM25 would score those fragments highly for exactly the queries a reader asks.
_EXCLUDED_CLASSES = {LAYOUT_ABANDON}

_SCHEMA = f"""
CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
    chunk_id      UNINDEXED,
    kind          UNINDEXED,
    section_id    UNINDEXED,
    page_number   UNINDEXED,
    page_range    UNINDEXED,
    block_ids     UNINDEXED,
    section_title,
    text,
    tokenize = 'unicode61'
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
"""

#: The ranking expression, in the table's own column order. Exported rather than
#: repeated at the call site: `bm25()` takes one weight per column positionally,
#: so a second copy of this literal would keep working while silently ignoring any
#: change to the weights above.
BM25_EXPRESSION = f"bm25(chunks, 0, 0, 0, 0, 0, 0, {TITLE_WEIGHT}, {BODY_WEIGHT})"

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _lock_for(path: Path) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(str(path), threading.Lock())


def index_path(document_dir: Path) -> Path:
    return Path(document_dir) / INDEX_FILENAME


@dataclass(frozen=True)
class IndexStats:
    chunks: int
    rebuilt: bool


def _connect(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(str(path))
    connection.row_factory = sqlite3.Row
    connection.executescript(_SCHEMA)
    return connection


def _stored_hash(connection: sqlite3.Connection) -> str | None:
    row = connection.execute("SELECT value FROM meta WHERE key = 'content_hash'").fetchone()
    return row["value"] if row else None


def _stored_signature(connection: sqlite3.Connection) -> str | None:
    row = connection.execute("SELECT value FROM meta WHERE key = 'signature'").fetchone()
    return row["value"] if row else None


def _stored_pipeline(connection: sqlite3.Connection) -> str | None:
    """Which extraction pipeline the rows were built from.

    `content_hash` answers "did the PDF change" and cannot answer "did the
    extraction change". DS-DOC-002 made the difference matter: correcting reading
    order re-segments paragraphs, and **paragraph ids are reading positions**, so
    a rebuilt IR renumbers the very ids this index stores as `chunk_id`.

    Without this check the index would stay "fresh" after such a change — same
    PDF, same schema — and retrieval would return rows whose `chunk_id` now names
    a different paragraph. Every citation built from one would point at text that
    does not support the claim, silently.
    """
    row = connection.execute(
        "SELECT value FROM meta WHERE key = 'pipeline_version'"
    ).fetchone()
    return row["value"] if row else None


def _chunk_rows(ir: DocumentIR):
    """The units this index holds.

    Paragraphs are the primary corpus: they already carry stable ids, page
    mapping, section mapping and reading order. Captions are added as first-class
    evidence — "what does Figure 3 show?" is a real question and the caption is
    the only thing that answers it — but they are tagged so a caller can tell
    them from prose.

    Headings are **not** rows. A heading is indexing signal, not evidence: it is
    carried as the `section_title` column of the paragraphs it governs, which
    boosts them without ever returning three words as an answer.
    """
    sections = {section.id: section for section in ir.sections}

    for paragraph in ir.paragraphs:
        section = sections.get(paragraph.section_id) if paragraph.section_id else None
        # `page_range` is delimited on both sides so a page-scoped query can test
        # membership with LIKE rather than only matching the starting page. A
        # paragraph starting at the foot of page 3 and finishing on page 4 is
        # found by a page-4 query — otherwise the reader is sent to a page where
        # the text is not visible.
        pages = ",".join(str(p) for p in paragraph.page_range)
        yield (
            paragraph.id, "paragraph", paragraph.section_id or "",
            paragraph.page_number, f",{pages},",
            ",".join(paragraph.block_ids),
            section.title if section else "",
            paragraph.text,
        )

    for page in ir.pages:
        for block in page.blocks:
            if block.layout_class not in ("figure_caption", "table_caption"):
                continue
            if not block.text.strip():
                continue
            yield (
                block.id, "caption", "",
                block.page_number, f",{block.page_number},",
                block.id, "", block.text,
            )


def ensure_index(
    document_dir: Path, ir: DocumentIR, *, force: bool = False
) -> IndexStats:
    """Build the index if it is absent or stale. Idempotent.

    The whole build happens under a per-document lock, so two searches arriving
    at once produce one index rather than a race.
    """
    directory = Path(document_dir)
    directory.mkdir(parents=True, exist_ok=True)
    path = index_path(directory)

    with _lock_for(path):
        connection = _connect(path)
        try:
            fresh = (
                not force
                and _stored_hash(connection) == ir.content_hash
                and _stored_signature(connection) == SCHEMA_SIGNATURE
                and _stored_pipeline(connection) == ir.pipeline_version
            )
            if fresh:
                count = connection.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
                return IndexStats(chunks=int(count), rebuilt=False)

            rows = list(_chunk_rows(ir))
            # Rebuilt in one transaction: a half-written index that still carried
            # the new hash would answer with half the paper.
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("DELETE FROM chunks")
            connection.executemany(
                "INSERT INTO chunks (chunk_id, kind, section_id, page_number, "
                "page_range, block_ids, section_title, text) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                rows,
            )
            connection.execute(
                "INSERT INTO meta (key, value) VALUES ('content_hash', ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (ir.content_hash,),
            )
            connection.execute(
                "INSERT INTO meta (key, value) VALUES ('signature', ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (SCHEMA_SIGNATURE,),
            )
            connection.execute(
                "INSERT INTO meta (key, value) VALUES ('pipeline_version', ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (ir.pipeline_version,),
            )
            connection.commit()
        finally:
            connection.close()

    logger.info(
        "search index built",
        extra={"chunks": len(rows), "document_id": ir.document_id},
    )
    return IndexStats(chunks=len(rows), rebuilt=True)


def is_stale(document_dir: Path, ir: DocumentIR) -> bool:
    """Whether a stored index no longer describes this document."""
    path = index_path(Path(document_dir))
    if not path.is_file():
        return True
    try:
        connection = _connect(path)
    except sqlite3.Error:
        return True
    try:
        return not (
            _stored_hash(connection) == ir.content_hash
            and _stored_signature(connection) == SCHEMA_SIGNATURE
            and _stored_pipeline(connection) == ir.pipeline_version
        )
    finally:
        connection.close()
