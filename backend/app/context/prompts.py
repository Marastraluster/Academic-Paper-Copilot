"""Versioned prompts for document analysis.

`PROMPT_VERSION` is part of the analysis cache key. If the wording here changes
in a way that changes what the model returns, that string must be bumped or every
cached analysis silently claims to have been produced by a prompt it was not.

The prompts are built around three rules that the criteria enforce mechanically
afterwards, and they say so to the model rather than hoping:

* **Use only the supplied text.** Every extracted item is later checked against
  the IR; an item citing a paragraph that does not exist is dropped. Saying so up
  front is cheaper than repairing it afterwards.
* **Preserve identifiers exactly.** Model, dataset and benchmark names are the
  things most likely to be mangled and most costly to mangle — a translation that
  renames `ResNet-50` is worse than one that leaves a term in English.
* **Omit rather than guess.** An acronym expansion the paper never spells out is
  not knowledge, it is a confident error, and the pipeline records `None` for it.
"""

from __future__ import annotations

#: Bump whenever a prompt below changes what the model is asked to produce.
PROMPT_VERSION = "1.0.0"

_JSON_RULES = """\
Reply with a single JSON object and nothing else. No prose, no markdown fences.

Use only the supplied source text. Do not add knowledge from elsewhere. Where the
source does not support an item, omit the item — an omission is correct, and a
plausible guess is a defect.

Cite evidence using the paragraph ids given in the source, e.g. "para-0007".
Never invent an id. If you include a short verbatim quotation, copy it exactly
from the source text."""

_IDENTIFIER_RULES = """\
Preserve identifiers exactly as they appear: model names, dataset names,
benchmark names, acronyms and mathematical symbols keep their original spelling,
capitalisation, hyphens and punctuation. Never lowercase or translate them.

Mark a term as not translatable when it is a proper identifier that should stay
in its original form in any language (for example LeVJEPA, ResNet-50, ImageNet,
Something-Something V2, VLA, CLIP). Ordinary technical vocabulary is
translatable and only becomes a glossary entry when its translation genuinely
depends on this paper's subject matter."""


def section_analysis_messages(
    *,
    section_title: str,
    paragraphs: list[tuple[str, int, str]],
    target_language: str,
) -> list[dict[str, str]]:
    """Analyse one section: its summary, plus terms and entities found in it.

    ``paragraphs`` is ``(paragraph_id, page_number, text)``. Page numbers are
    1-based and are passed through so a term can be located without the model
    needing to count pages itself.
    """
    source = "\n\n".join(
        f"[{paragraph_id}] (page {page_number})\n{text}"
        for paragraph_id, page_number, text in paragraphs
    )

    return [
        {
            "role": "system",
            "content": (
                "You analyse one section of an academic paper so that a later "
                "translation step can use consistent, paper-specific terminology.\n\n"
                f"{_IDENTIFIER_RULES}\n\n{_JSON_RULES}\n\n"
                "Return this shape:\n"
                "{\n"
                '  "summary": "2-4 sentences: what this section does and why",\n'
                '  "terms": [{"source_term": "...", "suggested_translation": "...",\n'
                '             "definition": "...", "is_translatable": true,\n'
                '             "paragraph_ids": ["..."]}],\n'
                '  "acronyms": [{"acronym": "...", "expansion": "..." or null,\n'
                '                "paragraph_ids": ["..."]}],\n'
                '  "entities": [{"name": "...", "kind": "model|dataset|benchmark|'
                'metric|framework", "paragraph_ids": ["..."]}]\n'
                "}"
            ),
        },
        {
            "role": "user",
            "content": (
                f"Section: {section_title}\n"
                f"Target translation language: {target_language}\n\n"
                f"Source:\n{source}"
            ),
        },
    ]


def document_synthesis_messages(
    *,
    section_summaries: list[tuple[str, str]],
    hints: str,
    target_language: str,
) -> list[dict[str, str]]:
    """Synthesise the whole document from its section summaries.

    Deliberately fed summaries rather than the paper. Sending the full text again
    would double the cost and defeat the hierarchy — and the section summaries
    are already the distilled form of text the model has read once.
    """
    joined = "\n\n".join(f"## {title}\n{summary}" for title, summary in section_summaries)

    return [
        {
            "role": "system",
            "content": (
                "You are given summaries of every section of one academic paper, "
                "in order. Produce a compact orientation for a translation system "
                "that must choose the right sense of a term.\n\n"
                f"{_IDENTIFIER_RULES}\n\n{_JSON_RULES}\n\n"
                "Return this shape:\n"
                "{\n"
                '  "domain": {"primary": "...", "secondary": ["..."],\n'
                '             "confidence": 0.0-1.0, "rationale": "..."},\n'
                '  "summary": "120-250 words: the problem, the approach, the key '
                'concepts and terminology, and the main findings. Synthesise; do '
                'not copy an abstract."\n'
                "}\n\n"
                'If the evidence does not support a domain, use "Unknown" or '
                '"Interdisciplinary" and a confidence below 0.5. Do not force a '
                "confident label."
            ),
        },
        {
            "role": "user",
            "content": (
                f"Target translation language: {target_language}\n"
                f"Document context: {hints}\n\n{joined}"
            ),
        },
    ]


def single_pass_messages(
    *,
    title: str,
    paragraphs: list[tuple[str, int, str]],
    target_language: str,
) -> list[dict[str, str]]:
    """Analyse a short document in one request.

    A two-page extended abstract does not need section chunking followed by a
    synthesis pass; three serialised round trips to learn four technical terms is
    cost without rigour. Below the threshold, one pass does everything.
    """
    source = "\n\n".join(
        f"[{paragraph_id}] (page {page_number})\n{text}"
        for paragraph_id, page_number, text in paragraphs
    )

    return [
        {
            "role": "system",
            "content": (
                "You analyse a short academic paper so that a later translation "
                "step can use consistent, paper-specific terminology.\n\n"
                f"{_IDENTIFIER_RULES}\n\n{_JSON_RULES}\n\n"
                "Return this shape:\n"
                "{\n"
                '  "domain": {"primary": "...", "secondary": ["..."],\n'
                '             "confidence": 0.0-1.0, "rationale": "..."},\n'
                '  "summary": "120-250 words: problem, approach, key concepts, findings",\n'
                '  "terms": [{"source_term": "...", "suggested_translation": "...",\n'
                '             "definition": "...", "is_translatable": true,\n'
                '             "paragraph_ids": ["..."]}],\n'
                '  "acronyms": [{"acronym": "...", "expansion": "..." or null,\n'
                '                "paragraph_ids": ["..."]}],\n'
                '  "entities": [{"name": "...", "kind": "model|dataset|benchmark|'
                'metric|framework", "paragraph_ids": ["..."]}]\n'
                "}\n\n"
                'If the evidence does not support a domain, use "Unknown" and a '
                "confidence below 0.5."
            ),
        },
        {
            "role": "user",
            "content": (
                f"Title: {title}\n"
                f"Target translation language: {target_language}\n\n"
                f"Source:\n{source}"
            ),
        },
    ]


def repair_messages(previous: str, error: str) -> list[dict[str, str]]:
    """Ask once more, showing the model exactly what was wrong with its output.

    One attempt, not a loop. A model that produced unparseable JSON twice will
    produce it a third time, and the task forbids unbounded retrying in a new
    layer just as it did in the translation kernel.
    """
    return [
        {
            "role": "system",
            "content": (
                "Your previous reply could not be parsed. Return a single valid "
                "JSON object with the same shape, and nothing else.\n\n"
                f"{_JSON_RULES}"
            ),
        },
        {
            "role": "user",
            "content": (
                f"The error was: {error}\n\n"
                f"Your previous reply was:\n{previous[:4000]}"
            ),
        },
    ]
