"""Asking a model to describe a paper to a person who has not read it.

## Why this is not the analysis prompt

The existing synthesis prompt opens *"Produce a compact orientation for a
translation system that must choose the right sense of a term."* It was measured:
six of forty-eight generated claims were unsupported, and the three lowest were
sentences addressed to a machine — *"It is useful for preserving author names and
affiliation spelling during translation."* The audience was the failure, not the
wording, so this one names a different audience and every rule below follows from
it.

## Every rule here exists because of something measured

- **The language is an instruction, not metadata.** The DS-QA-014 defect was that
  `target_language` was passed as context and the model answered in English. It
  is now stated as a requirement, with the identifier exception spelled out.
- **Evidence ids are the only thing the model may cite.** It never sees a page
  number or a rectangle, so it cannot invent one; the rules say so twice, because
  a model that has never been given a page number will otherwise supply one.
- **Short items, one claim each.** A paragraph under a single citation cannot be
  audited — the reader cannot tell which sentence the paper supports and neither
  can the audit.
- **Limitations are reported, never invented.** A model asked for weaknesses will
  produce them whether or not the authors admitted any.
- **Numbers need evidence that actually contains them.** Otherwise the number is
  dropped, not softened.
"""

from __future__ import annotations

from app.document.models import DocumentIR

#: The reader-facing categories, and what each may contain. Bounds are enforced
#: after generation as well — a prompt is a request, not a guarantee.
MAX_ITEMS = {
    "research_question": 1,
    "core_idea": 2,
    "contributions": 5,
    "method": 5,
    "experiments": 5,
    "findings": 5,
    "limitations": 3,
}
MAX_KEY_TERMS = 15
#: Roughly a sentence and a half. Long enough to be a claim, short enough that a
#: reader can check it against the evidence without hunting.
MAX_ITEM_CHARS = 220

_SYSTEM = """\
You are writing a short orientation to an academic paper for a researcher or a \
student who has NOT read it. They want to decide whether to read it, and what to \
look for when they do.

You will be given numbered excerpts of the paper. Every excerpt has an id like \
[E7]. You may cite ONLY those ids.

## Hard rules

1. Write every piece of prose in {language}. This is required, not a suggestion.
2. Keep technical identifiers exactly as the paper writes them — model names \
(ResNet-50, Mamba, Diffusion Policy), datasets (CIFAR-10, ImageNet), metrics, and \
mathematical symbols. Do not translate, expand or explain them.
3. Cite evidence ids for every item. Use only ids that appear in the excerpts. \
Never write a page number, a figure number or a quotation — you have not been \
given any of those, and anything you supply would be invented.
4. One short claim per item, at most about {max_chars} characters. Do not put \
several claims in one item under one citation; they cannot be checked and the \
reader cannot tell which part the paper supports.
5. State only what the excerpts say. If they do not answer a category, leave that \
category empty — an empty list is a correct answer and a guess is not.
6. Do not mention translation, translators, terminology consistency, or how a \
term should be rendered in another language. The reader is not translating.
7. Do not include a number unless an excerpt you cite contains that number.
8. Limitations: report only limitations the authors themselves state. If they \
state none, return an empty list. Never speculate about weaknesses.

## Categories

- research_question (0 or 1): the problem the paper sets out to solve, as the \
authors frame it. Do not widen it into a general research area.
- core_idea (0-2): the central mechanism or insight, and why it is the idea.
- contributions (0-5): what the paper claims to add. Prefer the authors' own \
claims; if you group their material into a contribution they did not state as \
one, set "inferred": true.
- method (0-5): the components and how they connect. Not a section-by-section walk.
- experiments (0-5): what was evaluated, on what, and against what.
- findings (0-5): what the experiments showed. A method claim is not a finding.
- limitations (0-3): stated by the authors only.
- key_terms (0-{max_terms}): terms a reader needs in order to follow this paper, \
defined as THIS paper uses them.

Return JSON exactly in this shape, with no commentary around it:

{{
  "items": [
    {{"category": "research_question", "text": "...", "evidence": ["E1"],
      "inferred": false}}
  ],
  "key_terms": [
    {{"term": "ResNet-50", "definition": "...", "evidence": ["E4"]}}
  ]
}}
"""


def _language_name(target_language: str) -> str:
    """The language, named the way an instruction can use it.

    Models follow `Chinese` more reliably than `zh-CN`, which reads as a form
    field. The tag is kept for the cache key; this is only for the prompt.
    """
    if target_language.lower().startswith("zh"):
        return "Simplified Chinese (简体中文)"
    if target_language.lower().startswith("en"):
        return "English"
    return target_language


def build_messages(
    ir: DocumentIR,
    packet_text: str,
    *,
    target_language: str,
) -> list[dict[str, str]]:
    """The two messages the overview is generated from.

    The paper's own title is included because a model that knows what the paper is
    called does not have to infer it from an excerpt, and gets the identifiers
    right more often.
    """
    title = ir.metadata.title or ir.source_filename
    system = _SYSTEM.format(
        language=_language_name(target_language),
        max_chars=MAX_ITEM_CHARS,
        max_terms=MAX_KEY_TERMS,
    )
    return [
        {"role": "system", "content": system},
        {
            "role": "user",
            "content": (
                f"Paper title: {title}\n\n"
                f"Excerpts from the paper:\n\n{packet_text}"
            ),
        },
    ]
