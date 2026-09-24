"""Translating a paper paragraph by paragraph: bounded batches, validated answers.

## Why paragraphs and not the translated PDF

`mono.pdf` exists and is already paid for, which makes it tempting. It is also
*laid out*: its text has been reflowed into the original boxes, so a paragraph can
arrive as two blocks or two paragraphs as one. Aligning those fragments back onto
the IR would produce pairs that look checked and are wrong — the reader would read
a translation under the wrong sentence and have no way to tell. The pairs here are
produced by translating the paragraphs themselves, one output per input id, and an
id that does not come back is reported as untranslated rather than filled in.

## What is sent, and what is not

- **Prose paragraphs**, in reading order, in batches of at most
  `MAX_PARAGRAPHS_PER_BATCH` paragraphs and `MAX_BATCH_CHARS` characters.
  Measured on this repository's ResNet IR: 99 translatable paragraphs, 40,567
  characters, **9 batches**.
- **Section headings**, with every batch (they are a few hundred characters and a
  failed batch should not also cost the reader the titles).
- **Never**: the bibliography, the front-matter title block, formulas — and
  nothing about the reader's notes, which are their own data.

## Failure is local

A batch that cannot be parsed, or that comes back missing ids, gets **one** repair
request. A batch that fails twice leaves its paragraphs marked `untranslated`,
the rest of the paper is kept, and the artifact is `PARTIAL`: a reading with a gap
in it is worth more than no reading, as long as the gap is said out loud.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from app.bilingual.models import (
    BilingualArtifact,
    BilingualBlock,
    BilingualParagraph,
    BilingualSection,
)
from app.bilingual.prompt import (
    MAX_BATCH_CHARS,
    MAX_PARAGRAPHS_PER_BATCH,
    build_messages,
    max_translation_chars,
)
from app.document.models import DocumentIR, ParagraphIR, SectionIR
from app.llm.base import LLMProvider
from app.llm.models import LLMRequest, LLMUsage
from app.overview.pipeline import META_CLAIM_VOCABULARY

#: Headings that never reach a model. `SectionIR.is_references` is the fact the
#: extraction establishes; the words are a backstop for extractions that did not
#: set it.
REFERENCE_HEADINGS = re.compile(r"^(references|bibliography|参考文献)\b", re.IGNORECASE)

#: Non-prose units the column shows in the source, with the label it gives them.
#: A formula has no language; a caption describes something the column does not
#: draw, and a reader following "as shown in Figure 1" needs it.
#:
#: `title` is deliberately absent: the headings already render as sections, and a
#: title block in the flow would print every heading twice.
SHOWN_BLOCK_CLASSES = {
    "isolate_formula": "公式",
    "figure_caption": "图说明",
    "table_caption": "表说明",
    "formula_caption": "公式说明",
}


@dataclass
class Batch:
    """One provider call's worth of work."""

    paragraphs: list[ParagraphIR]

    def characters(self) -> int:
        return sum(len(paragraph.text) for paragraph in self.paragraphs)


@dataclass
class Plan:
    """What a generation would cost, before any of it is spent.

    Computed from the IR by the same code that will do the work, so the number the
    reader is shown and the number of calls that happen cannot disagree.
    """

    batches: list[Batch] = field(default_factory=list)
    headings: list[SectionIR] = field(default_factory=list)
    #: Paragraph ids that will be carried in the artifact without a translation,
    #: and why — a decision, not a failure.
    skipped: dict[str, str] = field(default_factory=dict)

    @property
    def batch_count(self) -> int:
        return len(self.batches)

    @property
    def paragraph_count(self) -> int:
        return sum(len(batch.paragraphs) for batch in self.batches)

    @property
    def character_count(self) -> int:
        return sum(batch.characters() for batch in self.batches)


def plan(ir: DocumentIR) -> Plan:
    """Which paragraphs will be translated, in which calls, and which will not.

    Deterministic: the same IR always produces the same plan, which is what lets
    the pre-generation disclosure be a fact rather than an estimate.
    """
    headings_by_id = {section.id: section for section in ir.sections}

    abstract_pages = {
        paragraph.page_number for paragraph in ir.paragraphs if paragraph.is_abstract
    }
    first_abstract = next(
        (index for index, paragraph in enumerate(ir.paragraphs) if paragraph.is_abstract),
        None,
    )
    references = {
        section.id
        for section in ir.sections
        if section.is_references or REFERENCE_HEADINGS.match(section.title.strip())
    }

    result = Plan()
    for index, paragraph in enumerate(ir.paragraphs):
        if not paragraph.text.strip():
            continue
        if paragraph.section_id in references:
            result.skipped[paragraph.id] = "参考文献不予翻译"
            continue
        if _is_stationery(paragraph, index, abstract_pages, first_abstract):
            result.skipped[paragraph.id] = "文档题头信息"
            continue
        batch = result.batches[-1] if result.batches else None
        too_many = batch is not None and len(batch.paragraphs) >= MAX_PARAGRAPHS_PER_BATCH
        too_long = (
            batch is not None
            and batch.characters() + len(paragraph.text) > MAX_BATCH_CHARS
        )
        if batch is None or too_many or too_long:
            result.batches.append(Batch(paragraphs=[paragraph]))
        else:
            batch.paragraphs.append(paragraph)

    # Headings in the order the paper reads them: the order their paragraphs
    # appear, which is the order the extraction established (DS-DOC-002). Any
    # heading with no paragraphs under it follows, because it still belongs in
    # the column. The bibliography is left out — its heading is shown in the
    # source and never sent to a model (DS-DOC-006 AC-P0-08).
    seen: set[str] = set()
    for paragraph in ir.paragraphs:
        section = headings_by_id.get(paragraph.section_id or "")
        if section is None or section.id in seen:
            continue
        seen.add(section.id)
        if section.id in references or not section.title.strip():
            continue
        result.headings.append(section)
    for section in ir.sections:
        if section.id in seen or section.id in references or not section.title.strip():
            continue
        result.headings.append(section)
    return result


def non_prose_blocks(ir: DocumentIR) -> list[BilingualBlock]:
    """The formulas and captions the column carries, in reading order.

    Reading order is the extraction's own: `page.blocks` is already in the order
    the page reads (DS-DOC-002), so this walks pages in order and blocks within
    them. Nothing here is ever sent to a provider — the loop above never sees
    these units, which is why a formula cannot reach a prompt.
    """
    blocks: list[BilingualBlock] = []
    for page in ir.pages:
        for block in page.blocks:
            if block.layout_class not in SHOWN_BLOCK_CLASSES:
                continue
            if not (block.text or "").strip():
                continue
            blocks.append(BilingualBlock(
                block_id=block.id,
                page_number=block.page_number,
                layout_class=block.layout_class,
                text=block.text.strip(),
                bbox=tuple(block.bbox) if getattr(block, "bbox", None) else None,
            ))
    return blocks


def _is_stationery(
    paragraph: ParagraphIR,
    index: int,
    abstract_pages: set[int],
    first_abstract_index: int | None,
) -> bool:
    """Is this unsectioned paragraph the paper's stationery, or its prose?

    The same positional test the reader overview applies
    (`app/overview/evidence.py`) with **one deliberate difference**: the abstract
    is not stationery here. The overview treats it as front matter because it
    presents the abstract separately; the reading column shows it as the paper's
    first prose, which is what D1 asks for and what a reader expects at the top of
    a paper.
    """
    if paragraph.is_abstract:
        return False
    if not abstract_pages or first_abstract_index is None:
        return False
    return paragraph.page_number in abstract_pages and index < first_abstract_index


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


def _meta_claim(text: str) -> bool:
    lowered = text.lower()
    return any(phrase in lowered for phrase in META_CLAIM_VOCABULARY)


def _translations(
    payload: dict, key: str, allowed: set[str], sources: dict[str, int] | None = None
) -> dict[str, str]:
    """The id → text pairs an answer actually contains, and only usable ones.

    An id the batch never offered is not a translation of anything; empty text is
    not a translation either; a paragraph that talks to a translator is the
    measured defect; and a text many times its source is an essay, not a
    translation. All four are dropped, and the paragraph is reported missing
    rather than shown wrong.
    """
    entries = payload.get(key)
    if not isinstance(entries, list):
        return {}
    found: dict[str, str] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        identifier = str(entry.get("id", "")).strip()
        text = str(entry.get("text", "")).strip()
        if identifier not in allowed or identifier in found or not text:
            continue
        if _meta_claim(text):
            continue
        source_chars = (sources or {}).get(identifier, 0)
        if len(text) > max_translation_chars(source_chars):
            continue
        found[identifier] = text
    return found


def _with_usage(artifact: BilingualArtifact, usages: list[LLMUsage | None]) -> BilingualArtifact:
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
    artifact: BilingualArtifact
    provider_calls: int = 0
    repaired: int = 0
    failed_batches: int = 0


async def generate_bilingual(
    ir: DocumentIR,
    provider: LLMProvider,
    *,
    target_language: str,
    provider_base_url: str = "",
    created_at: str = "",
    glossary: list[str] | None = None,
) -> GenerationOutcome:
    """Translate what the plan says, in the batches it says, and report the gaps.

    Bounded: one call per batch, one repair per batch, and the paper is never sent
    in a single request — a model given a whole paper loses the thread, and one
    malformed answer would cost everything.
    """
    work = plan(ir)
    translated: dict[str, str] = {}
    heading_text: dict[str, str] = {}
    usages: list[LLMUsage | None] = []
    calls = 0
    repaired = 0
    failed_batches = 0
    #: The last provider answer, for its model name. `None` for a paper with
    #: nothing to translate, which never reaches a provider at all.
    result = None

    heading_views = [
        BilingualSection(
            section_id=section.id,
            title=section.title,
            title_translated="",
            level=section.level,
            page_number=section.page_range[0] if section.page_range else 1,
            is_references=section.is_references,
        )
        for section in work.headings
    ]

    for batch in work.batches:
        rows = [
            BilingualParagraph(
                paragraph_id=paragraph.id,
                page_number=paragraph.page_number,
                source_text=paragraph.text,
                section_id=paragraph.section_id,
            )
            for paragraph in batch.paragraphs
        ]
        messages = build_messages(
            rows, heading_views, target_language=target_language, glossary=glossary
        )
        allowed = {paragraph.id for paragraph in batch.paragraphs}
        allowed_headings = {section.section_id for section in heading_views}

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
            continue

        translated.update(_translations(
            payload, "paragraphs", allowed,
            {paragraph.paragraph_id: len(paragraph.source_text) for paragraph in rows},
        ))
        for identifier, text in _translations(payload, "headings", allowed_headings).items():
            heading_text.setdefault(identifier, text)

    # --- assemble -------------------------------------------------------------
    paragraphs: list[BilingualParagraph] = []
    for paragraph in ir.paragraphs:
        if not paragraph.text.strip():
            continue
        if paragraph.id in work.skipped:
            paragraphs.append(BilingualParagraph(
                paragraph_id=paragraph.id,
                page_number=paragraph.page_number,
                source_text=paragraph.text,
                status="skipped",
                section_id=paragraph.section_id,
                note=work.skipped[paragraph.id],
                bboxes=tuple(paragraph.bboxes),
            ))
            continue
        text = translated.get(paragraph.id, "")
        paragraphs.append(BilingualParagraph(
            paragraph_id=paragraph.id,
            page_number=paragraph.page_number,
            source_text=paragraph.text,
            translated_text=text,
            status="translated" if text else "untranslated",
            section_id=paragraph.section_id,
            note="" if text else "本段未能翻译",
            bboxes=tuple(paragraph.bboxes),
        ))

    sections = [
        BilingualSection(
            section_id=section.section_id,
            title=section.title,
            title_translated=heading_text.get(section.section_id, ""),
            level=section.level,
            page_number=section.page_number,
            is_references=section.is_references,
        )
        for section in heading_views
    ]

    missing = [
        paragraph.paragraph_id
        for paragraph in paragraphs
        if paragraph.status == "untranslated"
    ]
    notes: list[str] = []
    if failed_batches:
        notes.append(f"{failed_batches} 个批次未能翻译")
    if missing:
        notes.append(f"{len(missing)} 个段落未翻译")
    if not paragraphs:
        notes.append("这篇论文没有可翻译的段落")

    if not paragraphs:
        status = "FAILED"
    elif missing:
        status = "PARTIAL"
    else:
        status = "READY"

    artifact = _with_usage(
        BilingualArtifact(
            content_hash=ir.content_hash,
            target_language=target_language,
            status=status,
            paragraphs=paragraphs,
            sections=sections,
            blocks=non_prose_blocks(ir),
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
