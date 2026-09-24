"""Where a paper's paragraph translations live, addressed by what they describe.

The same store the reader overview uses, one level over:

    <documents_dir>/_cache/bilingual/<content_hash>_<language>.json

**Beside** the per-document directories, never inside one. The document row is
`uuid4().hex`, minted fresh every time a file is opened, so an artifact stored
under it is unreachable the moment the reader reopens the paper — the defect
DS-QA-015 was written to remove, and the reason notes were re-keyed to the PDF's
content hash before that (DS-QA-010-FIX-001). A translation a reader paid for
must survive the row it was made from.

## What invalidates, and what is only recorded

    source identity     content_hash, ir_pipeline_version   — the paper changed
    generation config   prompt_version, pipeline_version,
                        schema_version, target_language     — the answer changed

`provider_model` is deliberately **not** in the key. A different model produces a
different translation, and the one already made still describes a paper that has
not changed a byte; throwing it away would charge the reader twice for the same
page. It is recorded, and the column says whose reading it is.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path

from app.logging import get_logger
from app.bilingual.models import (
    BILINGUAL_ARTIFACT_KIND,
    BilingualBlock,
    BILINGUAL_PIPELINE_VERSION,
    BILINGUAL_SCHEMA_VERSION,
    BILINGUAL_PROMPT_VERSION,
    BilingualArtifact,
    BilingualParagraph,
    BilingualSection,
)

#: Prefixed so it sorts away from the `doc_…` directories and reads as what it is.
CACHE_DIRNAME = "_cache"
BILINGUAL_DIRNAME = "bilingual"

#: The temporary files an atomic write goes through, and the age after which a
#: sweep may remove one. An in-flight write is never an hour old.
TEMP_PREFIX = ".bilingual-"
STALE_TEMP_SECONDS = 3600.0

logger = get_logger(__name__)


def bilingual_dir(documents_dir: Path) -> Path:
    return Path(documents_dir) / CACHE_DIRNAME / BILINGUAL_DIRNAME


def bilingual_path(documents_dir: Path, content_hash: str, target_language: str) -> Path:
    """The file one paper's paragraph translations live at, for one language.

    The language is in the *name* rather than inside the file, so two languages
    coexist: a reader switching the interface must not destroy the reading they
    already paid for in the other one.
    """
    safe_language = target_language.replace("/", "_")
    return bilingual_dir(documents_dir) / f"{content_hash}_{safe_language}.json"


def cache_is_compatible(
    artifact: BilingualArtifact | None,
    *,
    content_hash: str,
    ir_pipeline_version: str,
    target_language: str,
) -> bool:
    """May this stored artifact answer for this document, right now?

    Every field here answers "does this text describe *this* paper, in *this*
    language, under *this* generation". The provider is absent on purpose — see
    the module docstring — and so is `created_at`, which describes when rather
    than what.
    """
    if artifact is None:
        return False
    if not artifact.is_usable():
        return False
    if artifact.artifact_kind != BILINGUAL_ARTIFACT_KIND:
        return False
    if artifact.schema_version != BILINGUAL_SCHEMA_VERSION:
        return False
    if artifact.pipeline_version != BILINGUAL_PIPELINE_VERSION:
        return False
    if artifact.prompt_version != BILINGUAL_PROMPT_VERSION:
        return False
    if artifact.content_hash != content_hash:
        return False
    if artifact.target_language != target_language:
        return False
    if artifact.ir_pipeline_version != ir_pipeline_version:
        return False
    return True


def read_bilingual(
    documents_dir: Path,
    *,
    content_hash: str,
    ir_pipeline_version: str,
    target_language: str,
) -> BilingualArtifact | None:
    """The stored artifact, if it is still about this paper in this language.

    A file that exists but does not parse, or parses but no longer matches, is
    reported as absent rather than raised: the caller regenerates, which is
    better than failing forever on a file nobody can read.
    """
    path = bilingual_path(documents_dir, content_hash, target_language)
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        logger.warning(
            "bilingual cache unreadable; treating as absent",
            extra={"path": str(path), "reason": type(error).__name__},
        )
        return None

    try:
        artifact = _from_payload(payload)
    except (KeyError, TypeError, ValueError) as error:
        logger.warning(
            "bilingual cache is not in the expected shape; treating as absent",
            extra={"path": str(path), "reason": type(error).__name__},
        )
        return None

    if not cache_is_compatible(
        artifact,
        content_hash=content_hash,
        ir_pipeline_version=ir_pipeline_version,
        target_language=target_language,
    ):
        return None
    return artifact


def write_bilingual(documents_dir: Path, artifact: BilingualArtifact) -> Path:
    """Persist an artifact, completely or not at all.

    A killed request must not leave a file that *looks* valid and is half a
    paper: the next open would render it, and the reader would read a document
    quietly missing its second half. The bytes land in a temporary file in the
    same directory, are read back as a check, and only then replace the target.
    """
    directory = bilingual_dir(documents_dir)
    directory.mkdir(parents=True, exist_ok=True)
    remove_temp_files(documents_dir)
    path = bilingual_path(documents_dir, artifact.content_hash, artifact.target_language)

    payload = _to_payload(artifact)
    handle, temporary = tempfile.mkstemp(prefix=TEMP_PREFIX, suffix=".tmp", dir=directory)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as file:
            json.dump(payload, file, ensure_ascii=False)
        json.loads(Path(temporary).read_text(encoding="utf-8"))
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise
    return path


def delete_bilingual(documents_dir: Path, content_hash: str, target_language: str) -> None:
    bilingual_path(documents_dir, content_hash, target_language).unlink(missing_ok=True)


def remove_temp_files(documents_dir: Path, *, now: float | None = None) -> list[str]:
    """Delete temporary files a killed process left behind.

    Only files older than an hour: a write that is *in flight* has one too, and
    removing it would corrupt a write that had done nothing wrong. Never raises —
    housekeeping must not be why a paid-for write fails.
    """
    moment = time.time() if now is None else now
    removed: list[str] = []
    for candidate in bilingual_dir(documents_dir).glob(f"{TEMP_PREFIX}*.tmp"):
        try:
            if moment - candidate.stat().st_mtime < STALE_TEMP_SECONDS:
                continue
            candidate.unlink()
            removed.append(candidate.name)
        except OSError as error:
            logger.warning(
                "a stale bilingual temporary file could not be removed",
                extra={"path": str(candidate), "reason": type(error).__name__},
            )
    return removed


# --- serialisation ------------------------------------------------------------
#
# Hand-written rather than `asdict`, so the file's shape is a decision rather
# than a consequence of the dataclass's field order. A stored artifact is read by
# a future version of this code, and `asdict` would let a refactor silently
# change the format.


def _to_payload(artifact: BilingualArtifact) -> dict:
    return {
        "artifact_kind": artifact.artifact_kind,
        "schema_version": artifact.schema_version,
        "pipeline_version": artifact.pipeline_version,
        "prompt_version": artifact.prompt_version,
        "content_hash": artifact.content_hash,
        "ir_pipeline_version": artifact.ir_pipeline_version,
        "target_language": artifact.target_language,
        "status": artifact.status,
        "provider_model": artifact.provider_model,
        "provider_base_url": artifact.provider_base_url,
        "created_at": artifact.created_at,
        "input_tokens": artifact.input_tokens,
        "output_tokens": artifact.output_tokens,
        "notes": list(artifact.notes),
        "sections": [
            {
                "section_id": section.section_id,
                "title": section.title,
                "title_translated": section.title_translated,
                "level": section.level,
                "page_number": section.page_number,
                "is_references": section.is_references,
            }
            for section in artifact.sections
        ],
        "blocks": [
            {
                "block_id": block.block_id,
                "page_number": block.page_number,
                "layout_class": block.layout_class,
                "text": block.text,
                "bbox": list(block.bbox) if block.bbox else None,
            }
            for block in artifact.blocks
        ],
        "paragraphs": [
            {
                "paragraph_id": paragraph.paragraph_id,
                "page_number": paragraph.page_number,
                "section_id": paragraph.section_id,
                "source_text": paragraph.source_text,
                "translated_text": paragraph.translated_text,
                "status": paragraph.status,
                "note": paragraph.note,
                "bboxes": [list(box) for box in paragraph.bboxes],
            }
            for paragraph in artifact.paragraphs
        ],
    }


def _from_payload(payload: dict) -> BilingualArtifact:
    return BilingualArtifact(
        content_hash=payload["content_hash"],
        target_language=payload["target_language"],
        status=payload["status"],
        sections=[
            BilingualSection(
                section_id=section["section_id"],
                title=section["title"],
                title_translated=section.get("title_translated", ""),
                level=section.get("level"),
                page_number=int(section.get("page_number", 1)),
                is_references=bool(section.get("is_references", False)),
            )
            for section in payload.get("sections", [])
        ],
        blocks=[
            BilingualBlock(
                block_id=block["block_id"],
                page_number=int(block["page_number"]),
                layout_class=block.get("layout_class", ""),
                text=block.get("text", ""),
                bbox=tuple(float(v) for v in block["bbox"]) if block.get("bbox") else None,
            )
            for block in payload.get("blocks", [])
        ],
        paragraphs=[
            BilingualParagraph(
                paragraph_id=paragraph["paragraph_id"],
                page_number=int(paragraph["page_number"]),
                source_text=paragraph["source_text"],
                translated_text=paragraph.get("translated_text", ""),
                status=paragraph.get("status", "untranslated"),
                section_id=paragraph.get("section_id"),
                note=paragraph.get("note", ""),
                bboxes=tuple(
                    tuple(float(value) for value in box)
                    for box in paragraph.get("bboxes", [])
                ),
            )
            for paragraph in payload.get("paragraphs", [])
        ],
        ir_pipeline_version=payload.get("ir_pipeline_version", ""),
        artifact_kind=payload.get("artifact_kind", ""),
        schema_version=payload.get("schema_version", ""),
        # A file written before this dimension existed was written by the only
        # pipeline version there has been; reading it as empty would invalidate
        # everything already paid for.
        pipeline_version=payload.get("pipeline_version", BILINGUAL_PIPELINE_VERSION),
        prompt_version=payload.get("prompt_version", ""),
        provider_model=payload.get("provider_model", ""),
        provider_base_url=payload.get("provider_base_url", ""),
        created_at=payload.get("created_at", ""),
        input_tokens=payload.get("input_tokens"),
        output_tokens=payload.get("output_tokens"),
        notes=list(payload.get("notes", [])),
    )
