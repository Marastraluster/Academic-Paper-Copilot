"""Result types for the PDF kernel."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class TranslationResult:
    """What a completed translation produced.

    Both page counts are reported rather than assumed: the caller's whole premise
    is that the output mirrors the source, so the numbers belong in the result
    where they can be checked, not inferred later from the files.
    """

    mono_path: Path
    """Translated only — same page count as the source."""

    dual_path: Path
    """Bilingual, interleaved ``[orig0, trans0, orig1, trans1, …]`` — twice the pages."""

    source_page_count: int
    mono_page_count: int
    dual_page_count: int

    duration_seconds: float = 0.0
    """Wall-clock time for the whole translation, including model load."""

    @property
    def pages_per_minute(self) -> float:
        """Throughput over the source page count. Useful for estimating a long run."""
        if self.duration_seconds <= 0 or self.source_page_count <= 0:
            return 0.0
        return self.source_page_count / (self.duration_seconds / 60.0)
