"""Display formulas a model reconstructed from a PDF's scrambled glyph stream.

This is the artifact behind the reflow's typeset equations — where the column
shows LaTeX a model wrote instead of the pixel crop the extractor could only
copy. It is **not** an extraction, and it must never look like one. A compiled
PDF stores positioned glyphs and vector curves, not mathematics, so the text the
extractor reads from a formula region is soup — measured on the reader's paper:
fraction bars lost, sums read as letters with their bounds flattened beside
them, superscripts collapsed. The LaTeX here is a model's *reconstruction* of
the mathematics the author wrote, disambiguated by the surrounding prose.

Because a reconstruction can look right and be wrong, the honest states are the
whole design: an item is `reconstructed`, or the model `refusal`d it, or it
`failed` — and only the first is ever rendered as mathematics. The other two
show the paper's own pixels, and the artifact says which is which.

## What is recorded, and what is not

The three version axes the bilingual reading and the reader overview already use
are here for the same reasons — the schema (what a stored file means), the
pipeline (what this code produces) and the prompt (what was asked) — beside the
source identity and the extraction it points into. A formula's identity is its
block's `source_anchor_id`: the digest of document fingerprint, page, quantized
geometry and glyphs the extraction computes, which survives re-extraction and
re-import, so a reconstruction a reader paid for is paid for once. Everything
else about the run is *provenance*: the model, the endpoint, when it ran, what
the provider said it cost.

There is deliberately no language axis: mathematics has no language, so one
artifact per content hash serves every translation target.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

#: Distinguishes this artifact from the bilingual reading and the reader
#: overview wherever either is described. They are not interchangeable files,
#: and this one never lives in `_cache/bilingual/`.
FORMULA_ARTIFACT_KIND = "formula_reconstruction"

#: The artifact's own shape. Bumped when a stored file stops meaning what it
#: meant — not when the generation changes (that is `pipeline_version`) and not
#: when the extraction does (that is `ir_pipeline_version`).
FORMULA_SCHEMA_VERSION = "1"

#: The generation pipeline's version: this module, the batching, the repair.
FORMULA_PIPELINE_VERSION = "1.0.0"

#: How the formulas are asked for. Bumped when the prompt changes materially.
FORMULA_PROMPT_VERSION = "1.0.0"

FormulaStatus = Literal["READY", "PARTIAL", "FAILED"]

#: A formula is reconstructed, refused by the model, or failed. The second is a
#: real answer — the model judged the glyph soup unresolvable, and a refusal is
#: the only defence the pipeline itself has against a formula that looks right
#: and is not — and the third is what a batch that could not be repaired, or a
#: model that did not answer, leaves behind. Only `reconstructed` is ever
#: rendered as mathematics; the rest show the paper's own pixels.
ItemReconstructionStatus = Literal["reconstructed", "refusal", "failed", "unprocessed"]


@dataclass(frozen=True)
class FormulaItemView:
    """One display formula block, its reconstructed LaTeX, and the reason it has
    none.

    `raw_soup` is verbatim from the IR — the glyph stream the extractor read —
    and `bbox` is the source geometry, so a click can put the reader on the
    formula in the PDF. `equation_number` is never a model's answer, and this
    pipeline never fills it: pairing a formula with the number printed beside
    it is the reading column's own assembly, done where the IR's blocks are
    already owned — the frontend's reflow stream.
    """

    block_id: str
    source_anchor_id: str
    page_number: int
    bbox: tuple[float, float, float, float]
    raw_soup: str
    font_size: float | None = None
    status: ItemReconstructionStatus = "unprocessed"
    latex: str = ""
    equation_number: str | None = None
    refusal_reason: str | None = None
    error_reason: str | None = None

    def is_renderable_latex(self) -> bool:
        """Is this mathematics the column may typeset?"""
        return self.status == "reconstructed" and bool(self.latex.strip())


@dataclass
class FormulaArtifact:
    """Everything the reading column needs to typeset one paper's formulas."""

    content_hash: str
    status: FormulaStatus = "FAILED"
    total_formulas: int = 0
    reconstructed_count: int = 0
    refused_count: int = 0
    failed_count: int = 0
    formulas: list[FormulaItemView] = field(default_factory=list)

    # --- provenance -----------------------------------------------------------
    #: Which extraction the anchor ids point into. Part of the key: a
    #: re-extraction renumbers blocks, and this artifact names them.
    ir_pipeline_version: str = ""
    artifact_kind: str = FORMULA_ARTIFACT_KIND
    schema_version: str = FORMULA_SCHEMA_VERSION
    pipeline_version: str = FORMULA_PIPELINE_VERSION
    prompt_version: str = FORMULA_PROMPT_VERSION
    #: Recorded for the reader, not part of the key — see the module docstring.
    provider_model: str = ""
    provider_base_url: str = ""
    created_at: str = ""
    input_tokens: int | None = None
    output_tokens: int | None = None
    #: Why a PARTIAL or FAILED run is not complete. Never empty for those.
    notes: list[str] = field(default_factory=list)

    def is_usable(self) -> bool:
        """READY and PARTIAL are worth showing; nothing else is a reading.

        PARTIAL includes a paper the model refused in full: a refusal is an
        honest answer the reader should not be charged twice for, so it is kept
        and shown, formula by formula.
        """
        return self.status in ("READY", "PARTIAL") and bool(self.formulas)
