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


# --- context-aware translation -----------------------------------------------

#: Bump when the envelope below changes what the model is asked to produce. Part
#: of the translation cache identity, so a prompt change cannot silently reuse
#: translations produced under the previous wording.
TRANSLATION_PROMPT_VERSION = "2.0.0"

_REFERENCE_OPEN = "=== ACADEMIC CONTEXT (REFERENCE ONLY - DO NOT TRANSLATE) ==="
_REFERENCE_CLOSE = "=== END ACADEMIC CONTEXT ==="
_TARGET_OPEN = "=== TARGET SOURCE TEXT (TRANSLATE THIS ONLY) ==="
_TARGET_CLOSE = "=== END TARGET SOURCE TEXT ==="
_GLOSSARY_OPEN = "=== GLOSSARY (use these renderings where the term occurs) ==="
_GLOSSARY_CLOSE = "=== END GLOSSARY ==="
_PREV_OPEN = "=== PREVIOUS PARAGRAPH (reference only, do not translate) ==="
_NEXT_OPEN = "=== NEXT PARAGRAPH (reference only, do not translate) ==="
_NEIGHBOUR_CLOSE = "=== END NEIGHBOUR ==="

#: The prompt when there is no document context at all.
#:
#: A separate text rather than the contextual one with its sections removed: that
#: one opens by explaining what the ACADEMIC CONTEXT, GLOSSARY and NEIGHBOUR
#: markers mean, and in this mode none of them exist. Instructions about absent
#: material are tokens spent describing something the model will never see.
_ACADEMIC_SYSTEM = """\
You are a professional academic translator working on a research paper.

Translate the text between the TARGET SOURCE TEXT markers into the target
language, using rigorous and natural academic language and preserving the
technical meaning of the source.

Preserve exactly, without translation or alteration:
- placeholders of the form {v0}, {v1}, ... — copy each one exactly, once, in place
- mathematical notation and symbols
- citation markers such as [12], [3, 7], (Figure 2), Eq. (4), Author et al. (2024)
- model, dataset, benchmark and framework names (ResNet, ImageNet, CIFAR-10, ...)
- acronyms, code identifiers, URLs and DOIs

Where terminology is ambiguous, choose the reading most appropriate to the
immediate sentence and to academic usage.

Output only the translation. Do not summarise it, explain it, add commentary or
notes, or wrap it in quotes or code fences. Do not write anything before or after
the translation."""

_TRANSLATION_SYSTEM = """\
You are a professional academic translator working on a research paper.

Translate ONLY the text between TARGET SOURCE TEXT markers.

Everything between the ACADEMIC CONTEXT, GLOSSARY and NEIGHBOUR markers is
reference material. It is there so you can choose the right sense of a term and
keep terminology consistent across the paper. It is NOT to be translated, quoted,
summarised or mentioned. Never repeat it in your output.

Where the glossary gives a rendering for a term that occurs in the target text,
use it.

Preserve exactly, without translation or alteration:
- placeholders of the form {v0}, {v1}, ... — copy each one exactly, once, in place
- mathematical notation and symbols
- citation markers such as [12], [3, 7], (Figure 2), Eq. (4)
- model, dataset, benchmark and framework names (ResNet, ImageNet, CIFAR-10, ...)
- acronyms, code identifiers, URLs and DOIs

Output only the translation of the target text. Do not summarise it, explain it,
add notes, or wrap it in quotes or code fences. Do not write anything before or
after the translation."""


def _render_glossary(terms: list[tuple[str, str | None, bool]]) -> str:
    lines = []
    for source_term, translation, translatable in terms:
        if not translatable or not translation:
            lines.append(f"- {source_term}  (keep as-is; do not translate)")
        else:
            lines.append(f"- {source_term} -> {translation}")
    return "\n".join(lines)


def translation_messages(
    *,
    target_text: str,
    target_language: str,
    document_summary: str | None = None,
    academic_domain: str | None = None,
    section_title: str | None = None,
    section_summary: str | None = None,
    glossary: list[tuple[str, str | None, bool]] | None = None,
    previous_paragraph: str | None = None,
    next_paragraph: str | None = None,
) -> list[dict[str, str]]:
    """Build the delimited envelope for one context-aware translation unit.

    The delimiters are the point. A model given a summary and a paragraph in one
    undifferentiated block will translate the summary too — it has no way to know
    which part is the job. Explicit markers that name the target as *the thing to
    translate* and everything else as *reference you must not translate* are the
    difference between context that helps and context that leaks into the PDF.
    """
    parts: list[str] = []

    reference: list[str] = []
    if academic_domain:
        reference.append(f"Domain: {academic_domain}")
    if document_summary:
        reference.append(f"Document summary: {document_summary}")
    if section_title:
        reference.append(f"Current section: {section_title}")
    if section_summary:
        reference.append(f"Section summary: {section_summary}")
    if reference:
        parts.append(f"{_REFERENCE_OPEN}\n" + "\n\n".join(reference) + f"\n{_REFERENCE_CLOSE}")

    if glossary:
        parts.append(
            f"{_GLOSSARY_OPEN}\n{_render_glossary(glossary)}\n{_GLOSSARY_CLOSE}"
        )

    if previous_paragraph:
        parts.append(
            f"{_PREV_OPEN}\n{previous_paragraph}\n{_NEIGHBOUR_CLOSE}"
        )

    parts.append(f"{_TARGET_OPEN}\n{target_text}\n{_TARGET_CLOSE}")

    if next_paragraph:
        parts.append(f"{_NEXT_OPEN}\n{next_paragraph}\n{_NEIGHBOUR_CLOSE}")

    instruction = (
        f"Translate the TARGET SOURCE TEXT into {target_language}. "
        "Output the translation only."
    )
    # With nothing to reference, the academic instructions stand alone. Keeping
    # the contextual text would mean describing sections that are not present.
    has_reference = bool(reference or glossary or previous_paragraph or next_paragraph)
    system = _TRANSLATION_SYSTEM if has_reference else _ACADEMIC_SYSTEM
    return [
        {"role": "system", "content": f"{system}\n\n{instruction}"},
        {"role": "user", "content": "\n\n".join(parts)},
    ]


def placeholder_repair_messages(
    *, target_text: str, bad_translation: str, hint: str, target_language: str
) -> list[dict[str, str]]:
    """One targeted repair, naming exactly which markers are wrong.

    A model told "the placeholders were wrong" reproduces the mistake; a model
    told "you dropped {v4}" fixes it. This is the single retry the criteria
    allow, so it has to be specific.
    """
    return [
        {
            "role": "system",
            "content": (
                "You are correcting a translation whose formula placeholders are "
                "wrong. Placeholders look like {v0}, {v1} and must appear exactly "
                "once each, in the same positions as the source. Return only the "
                "corrected translation, with nothing else."
            ),
        },
        {
            "role": "user",
            "content": (
                f"{hint}\n\n"
                f"SOURCE (translate into {target_language}, keeping every "
                f"placeholder):\n{target_text}\n\n"
                f"INCORRECT TRANSLATION:\n{bad_translation}\n\n"
                "Return the corrected translation only."
            ),
        },
    ]
