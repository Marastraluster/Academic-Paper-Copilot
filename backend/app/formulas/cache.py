"""Where a paper's formula reconstructions live, addressed by what they describe.

The same store the bilingual reading uses, one directory over:

    <documents_dir>/_cache/formulas/<content_hash>.json

**Beside** the per-document directories, never inside one. The document row is
`uuid4().hex`, minted fresh every time a file is opened, so an artifact stored
under it is unreachable the moment the reader reopens the paper — the same
defect DS-QA-015 was written to remove for the overview, and the same reason the
bilingual reading was re-keyed to the content hash. A reconstruction the reader
paid for must survive the row it was made from.

The directory is the formulas' **own**, and nothing here touches
`_cache/bilingual/`: the translation a reader paid for is a different artifact,
with a different key, and this module neither reads nor writes its directory.

## What invalidates, and what is only recorded

    source identity     content_hash, ir_pipeline_version   — the paper changed
    generation config   prompt_version, pipeline_version,
                        schema_version                      — the answer changed

`provider_model` is deliberately **not** in the key, for the same reason the
bilingual cache keeps it out: a different model produces a different
reconstruction, and the one already made still describes a paper that has not
changed a byte; throwing it away would charge the reader twice for the same
page. It is recorded, and the column says whose reconstruction it is.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path

from app.formulas.models import (
    FORMULA_ARTIFACT_KIND,
    FORMULA_PIPELINE_VERSION,
    FORMULA_PROMPT_VERSION,
    FORMULA_SCHEMA_VERSION,
    FormulaArtifact,
    FormulaItemView,
)
from app.logging import get_logger

#: Prefixed so it sorts away from the `doc_…` directories and reads as what it is.
CACHE_DIRNAME = "_cache"
FORMULAS_DIRNAME = "formulas"

#: The temporary files an atomic write goes through, and the age after which a
#: sweep may remove one. An in-flight write is never an hour old.
TEMP_PREFIX = ".formulas-"
STALE_TEMP_SECONDS = 3600.0

logger = get_logger(__name__)


def formulas_dir(documents_dir: Path) -> Path:
    return Path(documents_dir) / CACHE_DIRNAME / FORMULAS_DIRNAME


def formulas_path(documents_dir: Path, content_hash: str) -> Path:
    """The file one paper's reconstructions live at.

    No language in the name, on purpose: mathematics has no language, so one
    artifact serves every translation target.
    """
    return formulas_dir(documents_dir) / f"{content_hash}.json"


def cache_is_compatible(
    artifact: FormulaArtifact | None,
    *,
    content_hash: str,
    ir_pipeline_version: str,
) -> bool:
    """May this stored artifact answer for this document, right now?

    Every field here answers "does this text describe *this* paper, under *this*
    generation". The provider is absent on purpose — see the module docstring —
    and so is `created_at`, which describes when rather than what.
    """
    if artifact is None:
        return False
    if not artifact.is_usable():
        return False
    if artifact.artifact_kind != FORMULA_ARTIFACT_KIND:
        return False
    if artifact.schema_version != FORMULA_SCHEMA_VERSION:
        return False
    if artifact.pipeline_version != FORMULA_PIPELINE_VERSION:
        return False
    if artifact.prompt_version != FORMULA_PROMPT_VERSION:
        return False
    if artifact.content_hash != content_hash:
        return False
    if artifact.ir_pipeline_version != ir_pipeline_version:
        return False
    return True


def read_formulas(
    documents_dir: Path,
    *,
    content_hash: str,
    ir_pipeline_version: str,
) -> FormulaArtifact | None:
    """The stored artifact, if it is still about this paper.

    A file that exists but does not parse, or parses but no longer matches, is
    reported as absent rather than raised: the caller regenerates, which is
    better than failing forever on a file nobody can read.
    """
    path = formulas_path(documents_dir, content_hash)
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        logger.warning(
            "formulas cache unreadable; treating as absent",
            extra={"path": str(path), "reason": type(error).__name__},
        )
        return None

    try:
        artifact = _from_payload(payload)
    except (KeyError, TypeError, ValueError) as error:
        logger.warning(
            "formulas cache is not in the expected shape; treating as absent",
            extra={"path": str(path), "reason": type(error).__name__},
        )
        return None

    if not cache_is_compatible(
        artifact,
        content_hash=content_hash,
        ir_pipeline_version=ir_pipeline_version,
    ):
        return None
    return artifact


def write_formulas(documents_dir: Path, artifact: FormulaArtifact) -> Path:
    """Persist an artifact, completely or not at all.

    A killed request must not leave a file that *looks* valid and is half a
    paper: the next open would render it, and the reader would read a document
    quietly missing its second half. The bytes land in a temporary file in the
    same directory, are read back as a check, and only then replace the target.
    """
    directory = formulas_dir(documents_dir)
    directory.mkdir(parents=True, exist_ok=True)
    remove_temp_files(documents_dir)
    path = formulas_path(documents_dir, artifact.content_hash)

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


def delete_formulas(documents_dir: Path, content_hash: str) -> None:
    formulas_path(documents_dir, content_hash).unlink(missing_ok=True)


def remove_temp_files(documents_dir: Path, *, now: float | None = None) -> list[str]:
    """Delete temporary files a killed process left behind.

    Only files older than an hour: a write that is *in flight* has one too, and
    removing it would corrupt a write that had done nothing wrong. Never raises —
    housekeeping must not be why a paid-for write fails.
    """
    moment = time.time() if now is None else now
    removed: list[str] = []
    for candidate in formulas_dir(documents_dir).glob(f"{TEMP_PREFIX}*.tmp"):
        try:
            if moment - candidate.stat().st_mtime < STALE_TEMP_SECONDS:
                continue
            candidate.unlink()
            removed.append(candidate.name)
        except OSError as error:
            logger.warning(
                "a stale formulas temporary file could not be removed",
                extra={"path": str(candidate), "reason": type(error).__name__},
            )
    return removed


# --- serialisation ------------------------------------------------------------
#
# Hand-written rather than `asdict`, so the file's shape is a decision rather
# than a consequence of the dataclass's field order. A stored artifact is read by
# a future version of this code, and `asdict` would let a refactor silently
# change the format.


def _to_payload(artifact: FormulaArtifact) -> dict:
    return {
        "artifact_kind": artifact.artifact_kind,
        "schema_version": artifact.schema_version,
        "pipeline_version": artifact.pipeline_version,
        "prompt_version": artifact.prompt_version,
        "content_hash": artifact.content_hash,
        "ir_pipeline_version": artifact.ir_pipeline_version,
        "status": artifact.status,
        "total_formulas": artifact.total_formulas,
        "reconstructed_count": artifact.reconstructed_count,
        "refused_count": artifact.refused_count,
        "failed_count": artifact.failed_count,
        "provider_model": artifact.provider_model,
        "provider_base_url": artifact.provider_base_url,
        "created_at": artifact.created_at,
        "input_tokens": artifact.input_tokens,
        "output_tokens": artifact.output_tokens,
        "notes": list(artifact.notes),
        "formulas": [
            {
                "block_id": item.block_id,
                "source_anchor_id": item.source_anchor_id,
                "page_number": item.page_number,
                "bbox": list(item.bbox),
                "raw_soup": item.raw_soup,
                "font_size": item.font_size,
                "status": item.status,
                "latex": item.latex,
                "equation_number": item.equation_number,
                "refusal_reason": item.refusal_reason,
                "error_reason": item.error_reason,
            }
            for item in artifact.formulas
        ],
    }


def _from_payload(payload: dict) -> FormulaArtifact:
    return FormulaArtifact(
        content_hash=payload["content_hash"],
        status=payload.get("status", "FAILED"),
        total_formulas=int(payload.get("total_formulas", 0)),
        reconstructed_count=int(payload.get("reconstructed_count", 0)),
        refused_count=int(payload.get("refused_count", 0)),
        failed_count=int(payload.get("failed_count", 0)),
        formulas=[
            FormulaItemView(
                block_id=item["block_id"],
                source_anchor_id=item.get("source_anchor_id", ""),
                page_number=int(item["page_number"]),
                bbox=tuple(float(value) for value in item["bbox"]),
                raw_soup=item.get("raw_soup", ""),
                font_size=item.get("font_size"),
                status=item.get("status", "unprocessed"),
                latex=item.get("latex", ""),
                equation_number=item.get("equation_number"),
                refusal_reason=item.get("refusal_reason"),
                error_reason=item.get("error_reason"),
            )
            for item in payload.get("formulas", [])
        ],
        ir_pipeline_version=payload.get("ir_pipeline_version", ""),
        artifact_kind=payload.get("artifact_kind", ""),
        schema_version=payload.get("schema_version", ""),
        # A file written before this dimension existed was written by the only
        # pipeline version there has been; reading it as empty would invalidate
        # everything already paid for.
        pipeline_version=payload.get("pipeline_version", FORMULA_PIPELINE_VERSION),
        prompt_version=payload.get("prompt_version", ""),
        provider_model=payload.get("provider_model", ""),
        provider_base_url=payload.get("provider_base_url", ""),
        created_at=payload.get("created_at", ""),
        input_tokens=payload.get("input_tokens"),
        output_tokens=payload.get("output_tokens"),
        notes=list(payload.get("notes", [])),
    )
