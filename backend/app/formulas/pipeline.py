"""Reconstructing a paper's display formulas as LaTeX: bounded batches, honest answers.

## Why reconstruction and not extraction

There is no LaTeX in a compiled PDF, and there cannot be. The format stores
positioned glyph indices and vector curves, so the text the extractor reads from
a formula region is scrambled soup — measured on the reader's paper:

    LInfoNCE = −1 / 2B / B / X / i=1 / " / log / exp(zv / i · zt / i/τ) / ...

The sum is read as a capital `X` with its bounds flattened beside it, fraction
bars are lost, superscripts collapse. So a rendered formula is **never** an
extraction: it is a reconstruction the model writes by interpreting the soup in
the light of the surrounding prose. And because a reconstruction can look right
and be wrong, the failure modes are the design: the model may refuse, a refused
or failed formula shows the paper's own pixels, and the artifact says which is
which.

## What is sent, and what is not

- **Display formulas** (`isolate_formula` blocks), in reading order, in batches
  of at most `MAX_FORMULAS_PER_BATCH` — measured: 7 formulas on the reader's
  paper, 1 batch; 66 on Mamba-3, 5 batches.
- **Each with its geometry and a prose window**: the block's id and anchor, its
  page, font size and bbox, the glyph stream itself, and the nearest prose
  paragraphs within ±`PROSE_WINDOW_CHARS` characters — the variables are
  resolved in the prose, not in the formula.
- **Never**: prose beyond the window, the bibliography, the reader's notes.

## Failure is local

A batch that cannot be parsed gets **one** repair request. A batch that fails
twice leaves its formulas marked `failed`, the rest of the paper is kept, and
the artifact is `PARTIAL` — formulas with a reconstruction are worth more than
no formulas, as long as the gap is said out loud. A refusal is not a failure:
it is the model's honest answer, it is recorded as such, and the formula shows
the paper's own pixels.

## The equation number is not this pipeline's to pair

The artifact carries an `equation_number` slot, and this pipeline always leaves
it empty. Pairing a formula with the number printed beside it is a *view*
concern — the reading column's assembler, which already owns the IR's blocks —
and one rule implemented in two places is a rule that will disagree in one of
them. The number a model's answer may carry is ignored for the same reason:
a number is a fact about the printed page, and the model never saw the page.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from app.document.models import DocumentIR, ParagraphIR, TextBlockIR
from app.formulas.models import (
    FormulaArtifact,
    FormulaItemView,
    ItemReconstructionStatus,
)
from app.formulas.prompt import (
    DEFAULT_REFUSAL_REASON,
    MAX_FORMULAS_PER_BATCH,
    PROSE_WINDOW_CHARS,
    FormulaPromptEntry,
    build_messages,
)
from app.llm.base import LLMProvider
from app.llm.models import LLMRequest, LLMUsage


@dataclass
class Batch:
    """One provider call's worth of formulas."""

    entries: list[FormulaPromptEntry]


@dataclass
class Plan:
    """What a generation would cost, before any of it is spent.

    Computed from the IR by the same code that will do the work, so the number
    the reader is shown and the number of calls that happen cannot disagree.
    """

    batches: list[Batch] = field(default_factory=list)

    @property
    def batch_count(self) -> int:
        return len(self.batches)

    @property
    def formula_count(self) -> int:
        return sum(len(batch.entries) for batch in self.batches)

    @property
    def character_volume(self) -> int:
        """How much glyph soup the calls will carry, in characters.

        Reported beside the call count, for the same reason the paragraph
        pipeline reports it: a reader deciding whether to spend has two facts
        worth knowing — how many requests, and how much paper each one carries.
        """
        return sum(len(entry.raw_soup) for batch in self.batches for entry in batch.entries)


def plan(ir: DocumentIR) -> Plan:
    """Which formulas will be reconstructed, in which calls.

    Every `isolate_formula` block, in reading order — the extraction's own:
    `page.blocks` is already in the order the page reads (DS-DOC-002), so this
    walks pages in order and blocks within them — batched at most
    `MAX_FORMULAS_PER_BATCH` per call. Deterministic: the same IR always
    produces the same plan, which is what lets the pre-generation disclosure be
    a fact rather than an estimate.
    """
    blocks = [
        block
        for page in ir.pages
        for block in page.blocks
        if block.layout_class == "isolate_formula"
    ]
    entries = [
        FormulaPromptEntry(
            block_id=block.id,
            source_anchor_id=block.source_anchor_id,
            page_number=block.page_number,
            bbox=tuple(block.bbox),
            raw_soup=block.text.strip(),
            font_size=block.font_size,
            surrounding_prose=prose_window(ir, block),
        )
        for block in blocks
    ]
    return Plan(batches=[
        Batch(entries=entries[offset:offset + MAX_FORMULAS_PER_BATCH])
        for offset in range(0, len(entries), MAX_FORMULAS_PER_BATCH)
    ])


def prose_window(
    ir: DocumentIR, formula: TextBlockIR, *, radius: int = PROSE_WINDOW_CHARS
) -> str:
    """The prose paragraphs nearest a formula, within ±`radius` characters.

    The window is a slice of the paragraphs' reading order — the extraction's
    own (DS-DOC-002) — centred on the paragraph nearest the formula, snapped to
    paragraph boundaries so the model gets whole sentences, never half of one.
    The variables a reconstruction needs are resolved in this prose ("where τ
    is the temperature parameter"), which is what makes reconstruction possible
    at all.
    """
    paragraphs = [item for item in ir.paragraphs if item.text.strip()]
    if not paragraphs:
        return ""
    starts: list[int] = []
    total = 0
    for item in paragraphs:
        starts.append(total)
        # Two characters for the join boundary, so offsets stay honest.
        total += len(item.text) + 2

    centre = starts[_nearest_paragraph(paragraphs, formula)]
    chosen = [
        item.text
        for item, start in zip(paragraphs, starts)
        if start < centre + radius and start + len(item.text) > centre - radius
    ]
    return "\n\n".join(chosen)


def _nearest_paragraph(paragraphs: list[ParagraphIR], formula: TextBlockIR) -> int:
    """The index of the paragraph the formula sits closest to.

    The primary key is page distance, measured against the paragraph's whole
    page range, because a paragraph can span pages and a formula on its second
    page is still inside it. The tie-breaker is the vertical distance between
    midpoints, so a formula at the top of a page prefers the paragraph above it
    and one at the bottom the paragraph below.
    """
    formula_mid = (formula.bbox[1] + formula.bbox[3]) / 2
    best_index = 0
    best_key: tuple[int, float] | None = None
    for index, item in enumerate(paragraphs):
        first, last = item.page_range
        if first <= formula.page_number <= last:
            page_distance = 0
        else:
            page_distance = min(
                abs(formula.page_number - first), abs(formula.page_number - last)
            )
        if item.bboxes:
            box = item.bboxes[0]
            vertical = abs((box[1] + box[3]) / 2 - formula_mid)
        else:
            vertical = float("inf")
        key = (page_distance, vertical)
        if best_key is None or key < best_key:
            best_key = key
            best_index = index
    return best_index


def _parse(raw: str) -> dict | None:
    """The JSON an answer contains, or `None`."""
    text = raw.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        parsed = json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _answers(
    payload: dict, allowed: set[str]
) -> tuple[dict[str, tuple[str | None, str | None]], set[str]]:
    """The id → (latex | None, refusal | None) pairs an answer contains, and
    only usable ones — plus the ids the model answered in any shape at all.

    An id the batch never offered is not a reconstruction of anything and is
    dropped; a reconstruction without LaTeX is not one either; and a status that
    is neither `reconstructed` nor `refusal` is not an answer. All three are
    reported rather than shown wrong, and a formula the model did not answer is
    never invented.
    """
    entries = payload.get("formulas")
    if not isinstance(entries, list):
        return {}, set()
    found: dict[str, tuple[str | None, str | None]] = {}
    answered: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        identifier = str(entry.get("block_id", "")).strip()
        if identifier not in allowed or identifier in found:
            continue
        answered.add(identifier)
        status = str(entry.get("status", "")).strip()
        if status == "reconstructed":
            latex = str(entry.get("latex", "")).strip()
            if latex:
                found[identifier] = (latex, None)
        elif status == "refusal":
            reason = (
                str(entry.get("refusal_reason", "")).strip() or DEFAULT_REFUSAL_REASON
            )
            found[identifier] = (None, reason)
    return found, answered


def _with_usage(
    artifact: FormulaArtifact, usages: list[LLMUsage | None]
) -> FormulaArtifact:
    """Provider-reported totals, or nothing.

    Nothing is the honest answer when any call left usage unreported: a partial
    sum presented as the run's cost is a number nobody measured in the place a
    measured one belongs.
    """
    if usages and all(usage is not None for usage in usages):
        artifact.input_tokens = sum(usage.prompt_tokens for usage in usages if usage)
        artifact.output_tokens = sum(usage.completion_tokens for usage in usages if usage)
    return artifact


@dataclass
class GenerationOutcome:
    artifact: FormulaArtifact
    provider_calls: int = 0
    repaired: int = 0
    failed_batches: int = 0


async def generate_formulas(
    ir: DocumentIR,
    provider: LLMProvider,
    *,
    provider_base_url: str = "",
    created_at: str = "",
) -> GenerationOutcome:
    """Reconstruct what the plan says, in the batches it says, and report the gaps.

    Bounded: one call per batch, one repair per batch, and the paper's formulas
    are never sent in a single request — a model given a whole paper loses the
    thread, and one malformed answer would cost everything.
    """
    work = plan(ir)
    found: dict[str, tuple[str | None, str | None]] = {}
    answered: set[str] = set()
    usages: list[LLMUsage | None] = []
    calls = 0
    repaired = 0
    failed_batches = 0
    failed_in: set[str] = set()
    #: The last provider answer, for its model name. `None` for a paper with
    #: no formulas, which never reaches a provider at all.
    result = None

    for batch in work.batches:
        messages = build_messages(batch.entries)
        allowed = {entry.block_id for entry in batch.entries}

        result = await provider.generate(LLMRequest(messages=messages))
        calls += 1
        usages.append(result.usage)
        payload = _parse(result.text)

        if payload is None:
            repaired += 1
            retry = list(messages) + [
                {"role": "assistant", "content": result.text[:2000]},
                {
                    "role": "user",
                    "content": (
                        "That was not valid JSON. Reply with the JSON object only, "
                        "with no other text before or after it."
                    ),
                },
            ]
            result = await provider.generate(LLMRequest(messages=retry))
            calls += 1
            usages.append(result.usage)
            payload = _parse(result.text)

        if payload is None:
            failed_batches += 1
            failed_in.update(allowed)
            continue

        batch_found, batch_answered = _answers(payload, allowed)
        found.update(batch_found)
        answered.update(batch_answered)

    # --- assemble -------------------------------------------------------------
    blocks = [
        block
        for page in ir.pages
        for block in page.blocks
        if block.layout_class == "isolate_formula"
    ]
    items: list[FormulaItemView] = []
    for block in blocks:
        latex, refusal = found.get(block.id, (None, None))
        if latex:
            item_status: ItemReconstructionStatus = "reconstructed"
            refusal_reason = None
            error_reason = None
        elif refusal:
            item_status = "refusal"
            refusal_reason = refusal
            error_reason = None
        elif block.id in failed_in:
            item_status = "failed"
            refusal_reason = None
            error_reason = "该批次未能重建"
        elif block.id in answered:
            item_status = "failed"
            refusal_reason = None
            error_reason = "模型返回的条目无效"
        else:
            item_status = "failed"
            refusal_reason = None
            error_reason = "模型未给出该公式的答案"
        items.append(FormulaItemView(
            block_id=block.id,
            source_anchor_id=block.source_anchor_id,
            page_number=block.page_number,
            bbox=tuple(block.bbox),
            raw_soup=block.text.strip(),
            font_size=block.font_size,
            status=item_status,
            latex=latex or "",
            # Left empty on purpose: pairing a formula with the number printed
            # beside it is the reading column's assembly, not reconstruction.
            equation_number=None,
            refusal_reason=refusal_reason,
            error_reason=error_reason,
        ))

    reconstructed = sum(1 for item in items if item.is_renderable_latex())
    refused = sum(1 for item in items if item.status == "refusal")
    failed = sum(1 for item in items if item.status == "failed")

    notes: list[str] = []
    if failed_batches:
        notes.append(f"{failed_batches} 个批次未能重建")
    if refused:
        notes.append(f"{refused} 个公式被模型拒绝重建")
    if failed:
        notes.append(f"{failed} 个公式未能重建")
    if not items:
        notes.append("这篇论文没有行间公式")

    # A refusal is a real answer, so an all-refused paper is PARTIAL and is
    # kept: the reader must not be charged again for formulas the model already
    # judged unresolvable. Only a paper where nothing usable came back at all
    # is FAILED.
    if not items or (reconstructed == 0 and refused == 0):
        status = "FAILED"
    elif failed == 0 and refused == 0:
        status = "READY"
    else:
        status = "PARTIAL"

    artifact = _with_usage(
        FormulaArtifact(
            content_hash=ir.content_hash,
            status=status,
            total_formulas=len(items),
            reconstructed_count=reconstructed,
            refused_count=refused,
            failed_count=failed,
            formulas=items,
            ir_pipeline_version=ir.pipeline_version,
            provider_model=getattr(result, "model", "") or "" if result is not None else "",
            provider_base_url=provider_base_url,
            created_at=created_at,
            notes=notes,
        ),
        usages,
    )
    return GenerationOutcome(
        artifact=artifact,
        provider_calls=calls,
        repaired=repaired,
        failed_batches=failed_batches,
    )
