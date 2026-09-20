"""Where a paid-for overview lives, addressed by what it is about.

## The defect this replaces

`app/context/persistence.py` stores an analysis at `<document_dir>/analysis.json`
and the document directory derives from a **document row** — `uuid4().hex`,
minted fresh every time a file is opened. Reopening a byte-identical PDF
therefore makes the artifact unreachable, and the reader pays the whole cost
again. Measured for DS-QA-014: 1565.8 seconds per reopen. Reproduced in
`tests/test_analysis_cache_identity.py`.

This is the DS-QA-010-FIX-001 defect — the notes list was keyed on the document
row and fixed by keying on `content_hash` — and the analysis never received that
fix because nothing used it until the reader overview did.

## Where the file goes, and why exactly there

    <documents_dir>/_cache/overview/<content_hash>_<language>.json

**Beside** the per-document directories, never inside one. A cache one level
deeper is reachable only through the row that produced it, which is the defect
restated. The segment is prefixed so it cannot collide with a `doc_…` directory
and so a reader looking at the folder can see it is not a document.

## What invalidates, and what is only recorded

The distinction is the whole design:

    source identity     content_hash, ir_pipeline_version     — the paper changed
    generation config   prompt_version, pipeline_version,
                        schema_version, target_language       — the answer changed

`provider_model` is deliberately **not** in the key. A different model produces a
different overview, but the one already made still describes a paper that has not
changed, and throwing it away would charge the reader again for a fact that is
still true. It is recorded and shown, so the reader knows whose reading they are
looking at. `target_language` *is* in the key, because Chinese prose and English
prose are different documents, not different opinions of the same one.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path

from app.logging import get_logger

from app.overview.models import (
    OVERVIEW_ARTIFACT_KIND,
    OVERVIEW_PIPELINE_VERSION,
    OVERVIEW_SCHEMA_VERSION,
    READER_OVERVIEW_PROMPT_VERSION,
    EvidenceRef,
    KeyTerm,
    OverviewItem,
    ReaderOverview,
)

#: Prefixed so it sorts away from the `doc_…` directories and reads as what it is.
CACHE_DIRNAME = "_cache"
OVERVIEW_DIRNAME = "overview"

#: The temporary files an atomic write goes through. Dotted so a reader looking
#: at the folder sees they are not artifacts, and swept on every write.
TEMP_PREFIX = ".overview-"

#: How old a temporary file must be before a sweep will remove it. A killed
#: process leaves one behind forever; an in-flight write is never this old, so
#: the sweep cannot remove a file another writer is still using.
STALE_TEMP_SECONDS = 3600.0

logger = get_logger(__name__)


def overview_dir(documents_dir: Path) -> Path:
    return Path(documents_dir) / CACHE_DIRNAME / OVERVIEW_DIRNAME


def overview_path(documents_dir: Path, content_hash: str, target_language: str) -> Path:
    """The file one paper's overview in one language lives at.

    The language is in the *name* rather than inside the file so two languages
    coexist for one paper: a reader switching the interface language must not
    destroy the overview they already paid for in the other one.
    """
    safe_language = target_language.replace("/", "_")
    return overview_dir(documents_dir) / f"{content_hash}_{safe_language}.json"


def cache_is_compatible(
    overview: ReaderOverview | None,
    *,
    content_hash: str,
    ir_pipeline_version: str,
    target_language: str,
) -> bool:
    """May this stored overview answer for this document, right now?

    Every field here answers "does the stored text describe *this* paper in
    *this* language". The provider is absent on purpose — see the module
    docstring — and so is `created_at`, which describes when rather than what.
    """
    if overview is None:
        return False
    if not overview.is_usable():
        return False
    if overview.artifact_kind != OVERVIEW_ARTIFACT_KIND:
        return False
    if overview.schema_version != OVERVIEW_SCHEMA_VERSION:
        return False
    if overview.pipeline_version != OVERVIEW_PIPELINE_VERSION:
        return False
    if overview.prompt_version != READER_OVERVIEW_PROMPT_VERSION:
        return False
    if overview.content_hash != content_hash:
        return False
    if overview.target_language != target_language:
        return False
    if overview.ir_pipeline_version != ir_pipeline_version:
        return False
    return True


def read_overview(
    documents_dir: Path,
    *,
    content_hash: str,
    ir_pipeline_version: str,
    target_language: str,
) -> ReaderOverview | None:
    """The stored overview, if it is still about this paper in this language.

    A file that exists but does not parse, or parses but no longer matches, is
    reported as absent rather than raised: the caller regenerates, which is
    strictly better than failing forever on a file nobody can read. The same
    principle `read_ir` applies to a corrupt IR cache.
    """
    path = overview_path(documents_dir, content_hash, target_language)
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        # Said out loud, because a cache that silently answers "nothing here" for
        # a file that exists is indistinguishable from one with a real defect in
        # it. The path and the reason, never the content: the file holds paper
        # prose.
        logger.warning(
            "overview cache unreadable; treating as absent",
            extra={"path": str(path), "reason": type(error).__name__},
        )
        return None

    try:
        overview = _from_payload(payload)
    except (KeyError, TypeError, ValueError) as error:
        logger.warning(
            "overview cache is not in the expected shape; treating as absent",
            extra={"path": str(path), "reason": type(error).__name__},
        )
        return None

    if not cache_is_compatible(
        overview,
        content_hash=content_hash,
        ir_pipeline_version=ir_pipeline_version,
        target_language=target_language,
    ):
        return None
    return overview


def write_overview(documents_dir: Path, overview: ReaderOverview) -> Path:
    """Persist an overview, completely or not at all.

    A killed provider request or a backend that dies mid-write must not leave a
    file that *looks* valid and is half a paper — the next open would render it,
    and the reader would see a truncated overview with no way to tell. So the
    bytes land in a temporary file in the same directory, are read back and
    parsed as a check that what was written is what will be read, and only then
    replace the target atomically. Same directory because `os.replace` is only
    atomic within a filesystem.
    """
    directory = overview_dir(documents_dir)
    directory.mkdir(parents=True, exist_ok=True)
    remove_temp_files(documents_dir)
    path = overview_path(documents_dir, overview.content_hash, overview.target_language)

    payload = _to_payload(overview)
    handle, temporary = tempfile.mkstemp(
        prefix=TEMP_PREFIX, suffix=".tmp", dir=directory
    )
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as file:
            json.dump(payload, file, ensure_ascii=False)
        # Read it back before trusting it: a disk that filled up, an encoding
        # that mangled a character, a serialiser that met something it could not
        # write — all of them produce a file that exists and is not usable.
        json.loads(Path(temporary).read_text(encoding="utf-8"))
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise
    return path


def delete_overview(documents_dir: Path, content_hash: str, target_language: str) -> None:
    overview_path(documents_dir, content_hash, target_language).unlink(missing_ok=True)


def remove_temp_files(documents_dir: Path, *, now: float | None = None) -> list[str]:
    """Delete temporary files a killed process left behind, and return their names.

    Only files older than an hour. A write that is *in flight* has a temporary
    file too, and a sweep that removed it would corrupt a write that had done
    nothing wrong — the reader would find out when the artifact they just paid
    for turned out to be half a file. An hour is longer than any write takes and
    shorter than a reader's patience for litter.

    Never raises: this is housekeeping on a directory the caller is about to
    write to, and failing the write because cleanup failed would be backwards.
    """
    moment = time.time() if now is None else now
    removed: list[str] = []
    for candidate in overview_dir(documents_dir).glob(f"{TEMP_PREFIX}*.tmp"):
        try:
            if moment - candidate.stat().st_mtime < STALE_TEMP_SECONDS:
                continue
            candidate.unlink()
            removed.append(candidate.name)
        except OSError as error:
            logger.warning(
                "a stale overview temporary file could not be removed",
                extra={"path": str(candidate), "reason": type(error).__name__},
            )
    return removed


# --- serialisation ------------------------------------------------------------
#
# Hand-written rather than `asdict`, so the file's shape is a decision rather
# than a consequence of the dataclass's field order. A stored artifact is read by
# a future version of this code, and `asdict` would let a refactor silently
# change the format.


def _to_payload(overview: ReaderOverview) -> dict:
    return {
        "artifact_kind": overview.artifact_kind,
        "schema_version": overview.schema_version,
        "pipeline_version": overview.pipeline_version,
        "prompt_version": overview.prompt_version,
        "input_tokens": overview.input_tokens,
        "output_tokens": overview.output_tokens,
        "content_hash": overview.content_hash,
        "ir_pipeline_version": overview.ir_pipeline_version,
        "target_language": overview.target_language,
        "status": overview.status,
        "provider_model": overview.provider_model,
        "provider_base_url": overview.provider_base_url,
        "created_at": overview.created_at,
        "source_sections": list(overview.source_sections),
        "notes": list(overview.notes),
        "items": [
            {
                "category": item.category,
                "text": item.text,
                "inferred": item.inferred,
                "partial": item.partial,
                "evidence": [
                    {"paragraph_id": ref.paragraph_id, "page_number": ref.page_number}
                    for ref in item.evidence
                ],
            }
            for item in overview.items
        ],
        "key_terms": [
            {
                "term": term.term,
                "definition": term.definition,
                "evidence": [
                    {"paragraph_id": ref.paragraph_id, "page_number": ref.page_number}
                    for ref in term.evidence
                ],
            }
            for term in overview.key_terms
        ],
    }


def _from_payload(payload: dict) -> ReaderOverview:
    def evidence(raw: list) -> tuple[EvidenceRef, ...]:
        return tuple(
            EvidenceRef(paragraph_id=item["paragraph_id"], page_number=int(item["page_number"]))
            for item in raw
        )

    return ReaderOverview(
        content_hash=payload["content_hash"],
        target_language=payload["target_language"],
        status=payload["status"],
        items=[
            OverviewItem(
                category=item["category"],
                text=item["text"],
                evidence=evidence(item.get("evidence", [])),
                inferred=bool(item.get("inferred", False)),
                partial=bool(item.get("partial", False)),
            )
            for item in payload.get("items", [])
        ],
        key_terms=[
            KeyTerm(
                term=term["term"],
                definition=term["definition"],
                evidence=evidence(term.get("evidence", [])),
            )
            for term in payload.get("key_terms", [])
        ],
        ir_pipeline_version=payload.get("ir_pipeline_version", ""),
        artifact_kind=payload.get("artifact_kind", ""),
        schema_version=payload.get("schema_version", ""),
        # A file written before this dimension existed was written by the only
        # pipeline version there has ever been, so it is read as the current one
        # rather than as empty. Empty would invalidate every overview already
        # paid for, and charge the reader for a rename.
        pipeline_version=payload.get("pipeline_version", OVERVIEW_PIPELINE_VERSION),
        prompt_version=payload.get("prompt_version", ""),
        # Absent is the honest answer for a run whose usage was never recorded:
        # the panel says "unavailable" rather than guessing one.
        input_tokens=payload.get("input_tokens"),
        output_tokens=payload.get("output_tokens"),
        provider_model=payload.get("provider_model", ""),
        provider_base_url=payload.get("provider_base_url", ""),
        created_at=payload.get("created_at", ""),
        source_sections=list(payload.get("source_sections", [])),
        notes=list(payload.get("notes", [])),
    )
