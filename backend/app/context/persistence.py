"""Reading and writing ``analysis.json``.

Beside ``ir.json``, in the document's own directory, for the same reasons the IR
is: no SQLite table (the table set is pinned exactly, and a table for a phase that
has not started is caught by a test), deleted automatically with the document, and
no contention with the database's single writer.

Analysis is a **derived** artifact. Everything here is rebuildable from the IR, so
a file that does not parse is treated as absent and regenerated rather than being
allowed to fail the document permanently.
"""

from __future__ import annotations

from pathlib import Path

from app.context.models import AnalysisStatus, DocumentAnalysis
from app.storage.atomic import remove_temp_files, write_text_atomic

ANALYSIS_FILENAME = "analysis.json"

#: Prefix for the temporary file an atomic write goes through, and what a leak
#: check looks for. A stray one means a write died mid-flight.
TEMP_PREFIX = ".analysis-"


def analysis_path(document_dir: Path) -> Path:
    return Path(document_dir) / ANALYSIS_FILENAME


def write_analysis(document_dir: Path, analysis: DocumentAnalysis) -> Path:
    """Persist an analysis atomically."""
    return write_text_atomic(
        document_dir,
        ANALYSIS_FILENAME,
        analysis.model_dump_json(indent=2),
        temp_prefix=TEMP_PREFIX,
    )


def read_analysis(document_dir: Path) -> DocumentAnalysis | None:
    """Load the stored analysis, or ``None`` if there is not a usable one."""
    path = analysis_path(document_dir)
    if not path.is_file():
        return None
    try:
        return DocumentAnalysis.model_validate_json(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 - an unreadable cache is simply a miss
        return None


def delete_analysis(document_dir: Path) -> None:
    """Remove the stored analysis and any temporary file left by a failed write."""
    analysis_path(document_dir).unlink(missing_ok=True)
    remove_temp_files(Path(document_dir), TEMP_PREFIX)


def is_cache_valid(
    analysis: DocumentAnalysis | None,
    *,
    content_hash: str,
    pipeline_version: str,
    prompt_version: str,
    provider_base_url: str,
    provider_model: str,
    target_language: str,
    ir_pipeline_version: str | None = None,
) -> bool:
    """Whether a stored analysis may be reused for the given configuration.

    Every field here is a **semantic** input to the result. The API key is not
    among them and never will be: rotating a credential changes who is allowed to
    answer, not what the answer means, and invalidating an expensive analysis
    because a key was renewed would be a defect with a cost.

    The provider's *display name* is also absent. It is free text the user may
    edit at any time, and two profiles for different endpoints may share one — the
    same reasoning that makes `base_url` the identity, and the same defect the
    upstream translation cache has.
    """
    if analysis is None:
        return False
    if analysis.status not in (AnalysisStatus.READY, AnalysisStatus.PARTIAL):
        # A failed or cancelled run left nothing worth reusing.
        return False

    provenance = analysis.provenance
    # An analysis that predates this field parses with `"0"` and is invalidated by
    # comparison, which is the honest outcome: it was built against an IR this
    # build cannot vouch for.
    if ir_pipeline_version is not None and (
        provenance.ir_pipeline_version != ir_pipeline_version
    ):
        return False
    return (
        provenance.content_hash == content_hash
        and provenance.pipeline_version == pipeline_version
        and provenance.prompt_version == prompt_version
        and provenance.provider_base_url == provider_base_url
        and provenance.provider_model == provider_model
        and provenance.target_language == target_language
    )
