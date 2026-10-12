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

import inspect
import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from app.bilingual.glossary import Term, terms_for
from app.bilingual.models import (
    BilingualArtifact,
    BilingualBlock,
    BilingualParagraph,
    BilingualSection,
)
from app.bilingual.mathguard import protect, restore
from app.bilingual.prompt import (
    LEAD_BATCH_CHARS,
    LEAD_PARAGRAPHS,
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

#: Shown only when a structural parser recovered them as something a reader can
#: see — an image file or a table's cells. The in-house extractor's figure and
#: table "text" is run-together labels (`identityweight layerrelu…`), which is
#: why these were never shown before.
RECOVERED_BLOCK_CLASSES = {
    "figure": "图",
    "table": "表",
    "table_footnote": "表注",
    "code": "代码",
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
        # The first batch is the lead: small, so the reader has something soon.
        lead = len(result.batches) == 1
        too_many = batch is not None and len(batch.paragraphs) >= (
            LEAD_PARAGRAPHS if lead else MAX_PARAGRAPHS_PER_BATCH
        )
        too_long = (
            batch is not None
            and batch.characters() + len(paragraph.text) > (LEAD_BATCH_CHARS if lead else MAX_BATCH_CHARS)
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
            recovered = bool(block.latex or block.html or block.image_path)
            if block.layout_class in SHOWN_BLOCK_CLASSES:
                if not ((block.text or "").strip() or recovered):
                    continue
            elif block.layout_class in RECOVERED_BLOCK_CLASSES:
                # A table footnote or a code listing is real text under MinerU;
                # under the in-house extractor these classes are only fragments.
                parsed_text = (
                    ir.pipeline_version.startswith("mineru")
                    and block.layout_class in ("table_footnote", "code")
                    and bool((block.text or "").strip())
                )
                if not (recovered or parsed_text):
                    continue
            else:
                continue
            blocks.append(BilingualBlock(
                block_id=block.id,
                page_number=block.page_number,
                layout_class=block.layout_class,
                text=(block.text or "").strip(),
                bbox=tuple(block.bbox) if getattr(block, "bbox", None) else None,
                latex=block.latex,
                html=block.html,
                image_path=block.image_path,
                caption_of=block.caption_of,
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


@dataclass
class BatchResult:
    """What one batch produced. A failed batch has no translations, not wrong ones."""

    translations: dict[str, str] = field(default_factory=dict)
    headings: dict[str, str] = field(default_factory=dict)
    usages: list[LLMUsage | None] = field(default_factory=list)
    calls: int = 0
    repaired: int = 0
    failed: bool = False
    model: str = ""


class StreamedObjects:
    """The complete ``{…}`` items of a JSON answer, found while it is still arriving.

    The answer is ``{"headings": [{…}], "paragraphs": [{…}, {…}]}``; a paragraph is
    readable the moment its own object closes, long before the array or the
    answer does. This scans the text as it grows — strings and escapes respected,
    so a brace inside a translation is not a brace — and hands back each object
    that sits directly inside an array, once, when it is whole. Anything that is
    not such an object (prose around the JSON, a code fence) is simply not found.
    """

    def __init__(self) -> None:
        self._text = ""
        self._position = 0
        self._stack: list[str] = []
        self._in_string = False
        self._escape = False
        self._start: int | None = None
        self._start_depth = 0

    @property
    def text(self) -> str:
        return self._text

    def feed(self, chunk: str) -> list[dict]:
        self._text += chunk
        found: list[dict] = []
        text = self._text
        for index in range(self._position, len(text)):
            char = text[index]
            if self._in_string:
                if self._escape:
                    self._escape = False
                elif char == "\\":
                    self._escape = True
                elif char == '"':
                    self._in_string = False
            elif char == '"':
                self._in_string = True
            elif char == "{":
                if self._start is None and self._stack and self._stack[-1] == "[":
                    self._start, self._start_depth = index, len(self._stack)
                self._stack.append("{")
            elif char == "[":
                self._stack.append("[")
            elif char in "}]":
                if self._stack:
                    self._stack.pop()
                if char == "}" and self._start is not None and len(self._stack) == self._start_depth:
                    try:
                        value = json.loads(text[self._start:index + 1])
                    except ValueError:
                        value = None
                    if isinstance(value, dict):
                        found.append(value)
                    self._start = None
        self._position = len(text)
        return found


#: Called with ``(paragraph_id, translation)`` the moment one is usable.
OnParagraph = Callable[[str, str], Awaitable[None] | None]


def heading_views_for(work: Plan) -> list[BilingualSection]:
    """The section titles every batch carries, untranslated."""
    return [
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


async def translate_batch(
    batch: Batch,
    heading_views: list[BilingualSection],
    provider: LLMProvider,
    *,
    target_language: str,
    glossary: list[str] | None = None,
    terms: list[Term] | None = None,
    on_paragraph: OnParagraph | None = None,
) -> BatchResult:
    """One provider call (and at most one repair) for one batch.

    Independent of every other batch, which is what lets a background run do
    them in any order, keep each one as it lands, and resume after a restart
    with only the batches that are still missing.

    With ``on_paragraph`` the answer is read as it is written, and each
    paragraph is handed over the moment its own translation is complete and has
    passed every check a finished answer would be put through — the reader sees
    the first paragraph after a few seconds instead of the fifteenth after a
    minute. A provider that cannot stream is asked the ordinary way.
    """
    out = BatchResult()
    # Inline formulas travel as placeholders and come back verbatim; the model
    # never sees LaTeX it could rewrite (`mathguard`).
    guarded = {paragraph.id: protect(paragraph.text) for paragraph in batch.paragraphs}
    rows = [
        BilingualParagraph(
            paragraph_id=paragraph.id,
            page_number=paragraph.page_number,
            source_text=guarded[paragraph.id][0],
            section_id=paragraph.section_id,
        )
        for paragraph in batch.paragraphs
    ]
    # Only the glossary entries this batch can use: the paper's whole glossary on
    # every call is mostly noise, and "which paragraphs does an edit touch" has
    # the same answer here as it has for the reader.
    used = terms_for([paragraph.text for paragraph in batch.paragraphs], terms)
    messages = build_messages(
        rows, heading_views, target_language=target_language, glossary=glossary,
        terms=[(term.source, term.target) for term in used],
    )
    allowed = {paragraph.id for paragraph in batch.paragraphs}
    allowed_headings = {section.section_id for section in heading_views}
    source_chars = {paragraph.paragraph_id: len(paragraph.source_text) for paragraph in rows}

    def usable(payload: dict) -> dict[str, str]:
        """Paragraph translations that pass every check, formulas put back."""
        kept: dict[str, str] = {}
        for identifier, text in _translations(payload, "paragraphs", allowed, source_chars).items():
            restored = restore(text, guarded[identifier][1])
            if restored is not None:
                kept[identifier] = restored
        return kept

    streamed_text: str | None = None
    if on_paragraph is not None:
        scanner = StreamedObjects()
        try:
            async for chunk in provider.generate_stream(LLMRequest(messages=messages)):
                for item in scanner.feed(chunk):
                    for identifier, text in usable({"paragraphs": [item]}).items():
                        if identifier in out.translations:
                            continue
                        out.translations[identifier] = text
                        handed = on_paragraph(identifier, text)
                        if inspect.isawaitable(handed):
                            await handed
            streamed_text = scanner.text
        except NotImplementedError:
            streamed_text = None  # this adapter cannot stream: ask the ordinary way
        if streamed_text is not None and not streamed_text.strip():
            # Nothing was written (a reasoning model out of budget, typically).
            # The ordinary call knows how to name that failure.
            streamed_text = None

    if streamed_text is not None:
        out.calls += 1
        out.usages.append(None)  # a streamed call reports no usage
        out.model = getattr(provider, "model", "") or ""
        payload = _parse(streamed_text)
        if payload is None and out.translations:
            # The answer was cut off or malformed after some paragraphs had
            # arrived whole. Those stand; the rest are gaps a resumed run fills
            # by sending only them — asking for the whole batch again would pay
            # twice for what was just read.
            return out
        result_text = streamed_text
    else:
        result = await provider.generate(LLMRequest(messages=messages))
        out.calls += 1
        out.usages.append(result.usage)
        out.model = getattr(result, "model", "") or ""
        payload = _parse(result.text)
        result_text = result.text

    if payload is None:
        out.repaired += 1
        retry = list(messages) + [
            {"role": "assistant", "content": result_text[:2000]},
            {
                "role": "user",
                "content": (
                    "That was not valid JSON. Reply with the JSON object only, "
                    "with no other text before or after it."
                ),
            },
        ]
        result = await provider.generate(LLMRequest(messages=retry))
        out.calls += 1
        out.usages.append(result.usage)
        out.model = getattr(result, "model", "") or out.model
        payload = _parse(result.text)

    if payload is None:
        out.failed = True
        return out

    for identifier, text in usable(payload).items():
        # What was handed over while streaming is what the reader already has.
        out.translations.setdefault(identifier, text)
    for identifier, text in _translations(payload, "headings", allowed_headings).items():
        out.headings.setdefault(identifier, text)
    return out


def assemble(
    ir: DocumentIR,
    work: Plan,
    heading_views: list[BilingualSection],
    translated: dict[str, str],
    heading_text: dict[str, str],
    *,
    target_language: str,
    failed_batches: int = 0,
    usages: list[LLMUsage | None] | None = None,
    provider_model: str = "",
    provider_base_url: str = "",
    created_at: str = "",
    pending: set[str] | None = None,
) -> BilingualArtifact:
    """The artifact the column renders, from whatever translations exist.

    ``pending`` names paragraphs a running job has not reached yet: they are
    carried as ``pending`` rather than ``untranslated``, so the column can show
    a placeholder that will fill in instead of a failure that will not.
    """
    pending = pending or set()
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
        if not text and paragraph.id in pending:
            paragraphs.append(BilingualParagraph(
                paragraph_id=paragraph.id,
                page_number=paragraph.page_number,
                source_text=paragraph.text,
                status="pending",
                section_id=paragraph.section_id,
                bboxes=tuple(paragraph.bboxes),
            ))
            continue
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

    missing = [p.paragraph_id for p in paragraphs if p.status == "untranslated"]
    notes: list[str] = []
    if failed_batches:
        notes.append(f"{failed_batches} 个批次未能翻译")
    if missing:
        notes.append(f"{len(missing)} 个段落未翻译")
    if not paragraphs:
        notes.append("这篇论文没有可翻译的段落")

    if not paragraphs:
        status = "FAILED"
    elif missing or any(p.status == "pending" for p in paragraphs):
        status = "PARTIAL"
    else:
        status = "READY"

    return _with_usage(
        BilingualArtifact(
            content_hash=ir.content_hash,
            target_language=target_language,
            status=status,
            paragraphs=paragraphs,
            sections=sections,
            blocks=non_prose_blocks(ir),
            ir_pipeline_version=ir.pipeline_version,
            provider_model=provider_model,
            provider_base_url=provider_base_url,
            created_at=created_at,
            notes=notes,
        ),
        list(usages or []),
    )


async def generate_bilingual(
    ir: DocumentIR,
    provider: LLMProvider,
    *,
    target_language: str,
    provider_base_url: str = "",
    created_at: str = "",
    glossary: list[str] | None = None,
    terms: list[Term] | None = None,
) -> GenerationOutcome:
    """Translate what the plan says, in the batches it says, and report the gaps.

    Bounded: one call per batch, one repair per batch, and the paper is never sent
    in a single request — a model given a whole paper loses the thread, and one
    malformed answer would cost everything. The background job
    (`app.bilingual.jobs`) runs the same two halves, batch by batch.
    """
    work = plan(ir)
    heading_views = heading_views_for(work)
    translated: dict[str, str] = {}
    heading_text: dict[str, str] = {}
    usages: list[LLMUsage | None] = []
    calls = repaired = failed_batches = 0
    model = ""

    for batch in work.batches:
        result = await translate_batch(
            batch, heading_views, provider,
            target_language=target_language, glossary=glossary, terms=terms,
        )
        calls += result.calls
        repaired += result.repaired
        usages.extend(result.usages)
        model = result.model or model
        if result.failed:
            failed_batches += 1
            continue
        translated.update(result.translations)
        for identifier, text in result.headings.items():
            heading_text.setdefault(identifier, text)

    artifact = assemble(
        ir, work, heading_views, translated, heading_text,
        target_language=target_language,
        failed_batches=failed_batches,
        usages=usages,
        provider_model=model,
        provider_base_url=provider_base_url,
        created_at=created_at,
    )
    return GenerationOutcome(
        artifact=artifact,
        provider_calls=calls,
        repaired=repaired,
        failed_batches=failed_batches,
    )
