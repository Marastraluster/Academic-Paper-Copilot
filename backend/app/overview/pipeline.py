"""Generating a reader overview: one bounded call, validated before it is stored.

## The shape, and what it replaces

The measured baseline issued **one serial provider call per section unit** — each
fed the accumulated prior summaries — plus a synthesis call: eleven calls and
1565.8 seconds for ResNet. The cost came from the fan-out, and the content defects
came from the same place, because "every section, unconditionally" is also why
the bibliography got summarised and why a page of arXiv stationery became a card
called *Unsectioned Content*.

This asks once, about a packet that was already bounded and classified
(`app/overview/evidence.py`), and validates the answer before anything is stored.

## Validation is not politeness

A model asked for JSON returns JSON *most* of the time. The rest of the time it
returns JSON wrapped in prose, or a category nobody defined, or an evidence id
that does not exist — and each of those, stored, is a reader looking at a citation
that goes nowhere. So every field is checked, items that fail are **dropped and
counted** rather than the whole run discarded, and a run that loses too much is
`PARTIAL` instead of `READY`. One bounded repair call is allowed, because a
malformed brace is not a reason to spend the reader's money again.

## What the model is not allowed to say

`meta_claims` counts generated strings that address a translator. The list is a
constant, so adding a phrase is a reviewable change and the check cannot drift;
the measured baseline produced three such sentences in forty-eight claims.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from app.document.models import DocumentIR
from app.llm.base import LLMProvider
from app.llm.models import LLMRequest, LLMUsage
from app.overview.evidence import EvidencePacket, EvidenceUnit, build_evidence_packet
from app.overview.models import (
    READER_OVERVIEW_PROMPT_VERSION,
    EvidenceRef,
    KeyTerm,
    OverviewItem,
    ReaderOverview,
)
from app.overview.prompt import MAX_ITEM_CHARS, MAX_ITEMS, MAX_KEY_TERMS, build_messages

#: Addresses a translator rather than the reader. Derived from the measured
#: DS-QA-014 output — *"It is useful for preserving author names and affiliation
#: spelling during translation"*, *"For translation, venue acronyms … should be
#: preserved"* — and applied to every generated string.
META_CLAIM_VOCABULARY = (
    "translation", "translator", "translating", "translate",
    "preserve spelling", "spelling consistency",
    "terminology consistency", "term consistency",
    "rendered in chinese", "render in chinese",
)

#: At most this many characters may appear in one generated field.
MAX_DEFINITION_CHARS = 240


@dataclass
class GenerationOutcome:
    """What happened, including what was thrown away."""

    overview: ReaderOverview
    provider_calls: int = 0
    repaired: bool = False
    #: Items the model produced that did not survive validation, with the reason.
    dropped: list[str] = field(default_factory=list)


def _meta_claim(text: str) -> bool:
    lowered = text.lower()
    return any(phrase in lowered for phrase in META_CLAIM_VOCABULARY)


def _with_usage(overview: ReaderOverview, usages: list[LLMUsage | None]) -> ReaderOverview:
    """Record what the provider said the run cost — or record nothing.

    Nothing is the honest answer when any call left usage unreported: summing the
    calls that did report would understate the run and be presented to the reader
    as though it were the whole of it. The panel says "unavailable" instead, and
    a character count dressed up as token usage never appears.
    """
    if usages and all(usage is not None for usage in usages):
        overview.input_tokens = sum(usage.prompt_tokens for usage in usages if usage)
        overview.output_tokens = sum(usage.completion_tokens for usage in usages if usage)
    return overview


def _parse(raw: str) -> dict | None:
    """The JSON an answer contains, or `None`.

    Models wrap JSON in prose or in a fenced block often enough that refusing
    anything but a bare object would throw away good answers. The first `{` to
    the last `}` is the envelope; whether it *means* anything is validation's job.
    """
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


def _evidence(raw: object, index: dict[str, EvidenceUnit]) -> tuple[EvidenceRef, ...]:
    """Resolve the ids the model cited, ignoring any that do not exist.

    An id that was never offered is not evidence. Dropping it rather than failing
    the item is deliberate: an item grounded in two good excerpts and one
    invented id is still supported by the two, and the alternative — discarding
    the item — loses a true claim over a bad citation.
    """
    if not isinstance(raw, list):
        return ()
    refs: list[EvidenceRef] = []
    seen: set[str] = set()
    for entry in raw:
        key = str(entry).strip().strip("[]").upper()
        if key in seen:
            continue
        unit = index.get(key)
        if unit is None:
            continue
        seen.add(key)
        refs.append(EvidenceRef(paragraph_id=unit.paragraph_id, page_number=unit.page_number))
    return tuple(refs)


def build_overview(
    payload: dict,
    packet: EvidencePacket,
    *,
    content_hash: str,
    ir_pipeline_version: str,
    target_language: str,
    provider_model: str,
    provider_base_url: str,
    created_at: str,
) -> tuple[ReaderOverview, list[str]]:
    """Validate a generated payload into an artifact, or say what it lost.

    Pure, so the rules can be tested without a provider and so the two failure
    modes stay distinguishable: a *malformed* answer and a *thin* one are
    different problems and a combined test would not say which happened.
    """
    index = packet.id_index()
    dropped: list[str] = []
    items: list[OverviewItem] = []
    counts: dict[str, int] = {}

    for raw in payload.get("items", []) if isinstance(payload.get("items"), list) else []:
        if not isinstance(raw, dict):
            dropped.append("an item that was not an object")
            continue
        category = str(raw.get("category", "")).strip()
        text = str(raw.get("text", "")).strip()
        if category not in MAX_ITEMS:
            dropped.append(f"unknown category {category!r}")
            continue
        if not text:
            dropped.append(f"an empty {category} item")
            continue
        if len(text) > MAX_ITEM_CHARS * 2:
            dropped.append(f"an over-long {category} item ({len(text)} chars)")
            continue
        if counts.get(category, 0) >= MAX_ITEMS[category]:
            dropped.append(f"a {category} item beyond the {MAX_ITEMS[category]} allowed")
            continue
        if _meta_claim(text):
            # Not softened and not repaired: an item that talks to a translator is
            # the measured defect, and passing it through would make the audit a
            # formality.
            dropped.append(f"a {category} item addressed a translator")
            continue
        evidence = _evidence(raw.get("evidence"), index)
        if not evidence:
            # Every displayed item must be checkable. An ungrounded claim renders
            # identically to a grounded one, which is the whole problem.
            dropped.append(f"an ungrounded {category} item")
            continue
        counts[category] = counts.get(category, 0) + 1
        items.append(OverviewItem(
            category=category, text=text, evidence=evidence,
            inferred=bool(raw.get("inferred", False)),
            # Said by the synthesis when its evidence supports part of the claim
            # rather than all of it. Carried through rather than inferred here:
            # only the model has seen what the excerpts say, and a rule that
            # guessed at support from the shape of the evidence would be marking
            # claims on a criterion nobody applied.
            partial=bool(raw.get("partial", False)),
        ))

    terms: list[KeyTerm] = []
    raw_terms = payload.get("key_terms")
    for raw in raw_terms if isinstance(raw_terms, list) else []:
        if not isinstance(raw, dict) or len(terms) >= MAX_KEY_TERMS:
            continue
        term = str(raw.get("term", "")).strip()
        definition = str(raw.get("definition", "")).strip()
        if not term or not definition or len(definition) > MAX_DEFINITION_CHARS:
            dropped.append(f"a key term that could not be used ({term!r})")
            continue
        if _meta_claim(definition):
            dropped.append(f"a translator-directed definition for {term!r}")
            continue
        evidence = _evidence(raw.get("evidence"), index)
        if not evidence:
            dropped.append(f"an ungrounded definition for {term!r}")
            continue
        terms.append(KeyTerm(term=term, definition=definition, evidence=evidence))

    # READY means every category the paper can be expected to support is
    # present. `limitations` is exempt: a paper that states none is a paper with
    # no limitations to report, and calling that incomplete would be a lie about
    # the paper rather than about the answer.
    required = [name for name in MAX_ITEMS if name != "limitations"]
    missing = [name for name in required if counts.get(name, 0) == 0]
    status = "READY" if not missing else "PARTIAL"

    notes: list[str] = []
    if missing:
        notes.append("no overview item for: " + ", ".join(missing))
    if dropped:
        notes.append(f"{len(dropped)} generated item(s) did not pass validation")

    overview = ReaderOverview(
        content_hash=content_hash,
        target_language=target_language,
        status=status,
        items=items,
        key_terms=terms,
        ir_pipeline_version=ir_pipeline_version,
        prompt_version=READER_OVERVIEW_PROMPT_VERSION,
        provider_model=provider_model,
        provider_base_url=provider_base_url,
        created_at=created_at,
        source_sections=list(packet.sections),
        notes=notes,
    )
    return overview, dropped


async def generate_overview(
    ir: DocumentIR,
    provider: LLMProvider,
    *,
    target_language: str,
    provider_base_url: str = "",
    created_at: str = "",
    char_budget: int | None = None,
) -> GenerationOutcome:
    """One bounded call, then one bounded repair if the answer was unusable.

    The repair is bounded at one because a model that has produced unparseable
    output twice will produce it a third time, and each attempt is the reader's
    money. It is *counted* either way, so the ledger shows what the overview
    really cost rather than what a successful run costs.
    """
    packet = (
        build_evidence_packet(ir)
        if char_budget is None
        else build_evidence_packet(ir, char_budget=char_budget)
    )
    messages = build_messages(ir, packet.text_for_prompt(), target_language=target_language)

    result = await provider.generate(LLMRequest(messages=messages))
    calls = 1
    usage = [result.usage]
    payload = _parse(result.text)
    repaired = False

    if payload is None:
        repaired = True
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
        usage.append(result.usage)
        payload = _parse(result.text)

    if payload is None:
        return GenerationOutcome(
            overview=_with_usage(ReaderOverview(
                content_hash=ir.content_hash, target_language=target_language,
                status="FAILED", ir_pipeline_version=ir.pipeline_version,
                provider_model=result.model or "", provider_base_url=provider_base_url,
                created_at=created_at, source_sections=list(packet.sections),
                notes=["the model did not return a usable JSON object"],
            ), usage),
            provider_calls=calls,
            repaired=repaired,
            dropped=["the whole response"],
        )

    overview, dropped = build_overview(
        payload, packet,
        content_hash=ir.content_hash,
        ir_pipeline_version=ir.pipeline_version,
        target_language=target_language,
        provider_model=result.model or "",
        provider_base_url=provider_base_url,
        created_at=created_at,
    )
    return GenerationOutcome(
        overview=_with_usage(overview, usage),
        provider_calls=calls, repaired=repaired, dropped=dropped,
    )
