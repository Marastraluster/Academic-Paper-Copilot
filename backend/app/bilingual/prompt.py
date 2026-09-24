"""Asking a model to translate a paper, paragraph by paragraph.

The audience is a reader, and every rule below exists because of something
measured or something this repository already paid for:

- **One output per input, keyed by the id it was given.** The column places a
  translation under the paragraph it belongs to, so a missing id is a hole and an
  invented one is a paragraph that does not exist. Neither is repaired by
  guessing; both are reported.
- **The translation is read beside its source**, so it is prose and nothing else —
  no numbering, no headings that were not in the input, no notes about the
  translating. The reader overview's `META_CLAIM_VOCABULARY` filter is the
  enforcement, and this prompt is the instruction it backstops.
- **Identifiers keep their exact spelling** (`ResNet-50`, `ImageNet`, `BN`,
  `F(x) + x`): a translated model name is a different model.
- **Formulas are not translated and are not sent.** The IR marks them; a
  mathematical expression has no language.
"""

from __future__ import annotations

from app.bilingual.models import BilingualParagraph, BilingualSection

#: How much may go into one call. A paper in one request is cheaper and worse:
#: the model loses the thread of a long paper, and a single malformed answer
#: costs the whole document. These bounds keep every batch answerable and every
#: failure local.
MAX_PARAGRAPHS_PER_BATCH = 15
MAX_BATCH_CHARS = 5_000

#: A translation that is many times its source is not a translation. Generous
#: enough for Chinese prose (which is usually shorter than its English source)
#: and strict enough to catch a model that answered with an essay.
def max_translation_chars(source_chars: int) -> int:
    return max(2_000, source_chars * 4)

_SYSTEM = """\
You are translating the body of an academic paper into {language} for a reader who
is reading it beside the original, paragraph by paragraph.

## Hard rules

1. Translate into {language}. This is required, not a suggestion.
2. Return exactly one translation for every paragraph id you are given, and none
   for any id you were not given. Never merge two paragraphs, never split one,
   never add a paragraph.
3. Translate the prose only. Keep technical identifiers, model and dataset names,
   metric names and mathematical symbols exactly as they are written
   (ResNet-50, ImageNet, BN, SGD, F(x) + x). Do not translate, expand or explain
   them.
4. The translation is shown directly beneath its source paragraph. Write the
   translation and nothing else — no numbering, no headings that were not in the
   input, no notes, no mentions of translating, translators, terminology or
   spelling.
5. Keep the author's meaning exactly. Do not summarise, do not explain, do not add
   information the paragraph does not contain.

Return JSON exactly in this shape, with no commentary around it:

{{
  "headings": [{{"id": "s_1", "text": "..."}}],
  "paragraphs": [{{"id": "p_1", "text": "..."}}]
}}
"""


def _language_name(target_language: str) -> str:
    """The language, named the way an instruction can use it."""
    if target_language.lower().startswith("zh"):
        return "Simplified Chinese (简体中文)"
    if target_language.lower().startswith("en"):
        return "English"
    return target_language


def build_messages(
    paragraphs: list[BilingualParagraph],
    headings: list[BilingualSection],
    *,
    target_language: str,
    glossary: list[str] | None = None,
) -> list[dict[str, str]]:
    """The two messages one batch is translated from.

    The headings go with **every** batch rather than only the first: they are a
    few hundred characters, and a batch that fails should not be able to cost the
    reader the section titles as well as its own paragraphs.

    `glossary` is the context pipeline's own terminology, when that artifact
    exists — supplied as hints, never as instructions, because it was built for a
    different purpose and the paper's own wording wins.
    """
    system = _SYSTEM.format(language=_language_name(target_language))
    parts: list[str] = []
    if glossary:
        parts.append(
            "Terminology this project collected earlier (use it when it fits, and "
            "follow the paper when it does not):\n"
            + "\n".join(f"- {entry}" for entry in glossary[:40])
        )
    if headings:
        parts.append(
            "Section headings:\n"
            + "\n".join(f"[{heading.section_id}] {heading.title}" for heading in headings)
        )
    parts.append(
        "Paragraphs:\n"
        + "\n\n".join(
            f"[{paragraph.paragraph_id}] {paragraph.source_text}"
            for paragraph in paragraphs
        )
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": "\n\n".join(parts)},
    ]
