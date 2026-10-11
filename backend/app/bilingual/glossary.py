"""One paper, one word for each of its terms.

A paper is translated in batches that never see each other, so a term of art is
translated afresh in each: measured on a real paper, "shortcut connection" came
back under two different Chinese names, 27 times one and 16 the other. Before
the first batch, one call reads the paper and returns its terms with the
translation to use throughout; every batch is then given the entries that occur
in *its* paragraphs.

The glossary is the reader's to correct. It lives beside the paper's translation

    <documents_dir>/_cache/bilingual/<content_hash>_<language>.glossary.json

and an edit names exactly which paragraphs it touches — those whose source
contains a term that was added, removed or given a new translation — so only
those are translated again.

What is sent to make it is what a translation already sends to the same model:
the paper's body text. Nothing else, and nowhere else.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from app.bilingual.cache import TEMP_PREFIX, bilingual_dir
from app.bilingual.mathguard import protect
from app.bilingual.prompt import _language_name
from app.llm.base import LLMProvider
from app.llm.models import LLMRequest

if TYPE_CHECKING:  # the pipeline imports this module for what a batch is given
    from app.bilingual.pipeline import Plan

#: The file's own shape.
GLOSSARY_SCHEMA_VERSION = "1"

#: What one extraction is asked for, and the most it may return.
MIN_TERMS = 20
MAX_TERMS = 60
#: A reader may add their own on top of what was extracted.
MAX_STORED_TERMS = 200
MAX_TERM_CHARS = 80
#: The paper is read once, in one call; a very long one is read up to here.
MAX_SOURCE_CHARS = 60_000


@dataclass(frozen=True)
class Term:
    source: str
    target: str

    def payload(self) -> dict[str, str]:
        return {"source": self.source, "target": self.target}


# --- matching ------------------------------------------------------------------


def _pattern(source: str) -> re.Pattern[str]:
    """`source` as it would occur in running text: any case, whole words.

    The boundary is only asserted where the term itself begins or ends with a
    letter or digit, so "3×3 conv" and "top-1" still match, and "gate" does not
    match inside "aggregate".
    """
    body = r"\s+".join(re.escape(part) for part in source.split())
    left = r"(?<![A-Za-z0-9])" if source[:1].isalnum() else ""
    right = r"(?![A-Za-z0-9])" if source[-1:].isalnum() else ""
    plural = r"(?:e?s)?" if source[-1:].isalpha() else ""
    return re.compile(f"{left}{body}{plural}{right}", re.IGNORECASE)


def occurs(source: str, text: str) -> bool:
    return bool(source.strip()) and _pattern(source.strip()).search(text) is not None


def terms_for(texts: list[str], terms: list[Term] | None) -> list[Term]:
    """The entries that occur in these texts — what one batch is given."""
    if not terms:
        return []
    joined = "\n".join(texts)
    return [term for term in terms if occurs(term.source, joined)]


def clean(raw: Any, *, limit: int = MAX_STORED_TERMS) -> list[Term]:
    """Usable entries from whatever came in: a model's answer or a reader's edit."""
    out: list[Term] = []
    seen: set[str] = set()
    for entry in raw if isinstance(raw, list) else []:
        if isinstance(entry, Term):
            source, target = entry.source, entry.target
        elif isinstance(entry, dict):
            source, target = entry.get("source"), entry.get("target")
        else:
            continue
        if not isinstance(source, str) or not isinstance(target, str):
            continue
        source = " ".join(source.split())
        target = " ".join(target.split())
        key = source.lower()
        if not source or not target or key in seen:
            continue
        if len(source) > MAX_TERM_CHARS or len(target) > MAX_TERM_CHARS:
            continue
        seen.add(key)
        out.append(Term(source, target))
        if len(out) >= limit:
            break
    return out


def changed_sources(old: list[Term], new: list[Term]) -> set[str]:
    """Terms whose instruction to the translator differs between two glossaries."""
    before = {term.source.lower(): term for term in old}
    after = {term.source.lower(): term for term in new}
    changed: set[str] = set()
    for key in before.keys() | after.keys():
        a, b = before.get(key), after.get(key)
        if a is None or b is None or a.target != b.target:
            changed.add((a or b).source)  # type: ignore[union-attr]
    return changed


def affected_paragraph_ids(work: Plan, sources: set[str]) -> set[str]:
    """Translatable paragraphs whose own text contains one of these terms."""
    if not sources:
        return set()
    return {
        paragraph.id
        for batch in work.batches
        for paragraph in batch.paragraphs
        if any(occurs(source, paragraph.text) for source in sources)
    }


# --- storage ---------------------------------------------------------------------


def glossary_path(documents_dir: Path, content_hash: str, target_language: str) -> Path:
    safe_language = target_language.replace("/", "_")
    return bilingual_dir(documents_dir) / f"{content_hash}_{safe_language}.glossary.json"


def read_terms(documents_dir: Path, content_hash: str, target_language: str) -> list[Term] | None:
    """The paper's glossary; ``None`` when none has been made (an empty one is ``[]``)."""
    path = glossary_path(documents_dir, content_hash, target_language)
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict) or payload.get("schema_version") != GLOSSARY_SCHEMA_VERSION:
        return None
    if payload.get("content_hash") != content_hash or payload.get("target_language") != target_language:
        return None
    return clean(payload.get("terms"))


def write_terms(
    documents_dir: Path, content_hash: str, target_language: str, terms: list[Term]
) -> Path:
    directory = bilingual_dir(documents_dir)
    directory.mkdir(parents=True, exist_ok=True)
    path = glossary_path(documents_dir, content_hash, target_language)
    payload = {
        "schema_version": GLOSSARY_SCHEMA_VERSION,
        "content_hash": content_hash,
        "target_language": target_language,
        "terms": [term.payload() for term in terms],
    }
    handle, temporary = tempfile.mkstemp(prefix=TEMP_PREFIX, suffix=".tmp", dir=directory)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as file:
            json.dump(payload, file, ensure_ascii=False)
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise
    return path


# --- extraction ------------------------------------------------------------------

_SYSTEM = """\
You are preparing a glossary for translating one academic paper into {language}.
The paper will be translated in separate pieces, and the glossary is what keeps
a term translated the same way in every piece.

From the paper below, list between {low} and {high} of its technical terms, each
with the single {language} translation to use everywhere.

## Rules

1. Only terms of art that occur in the paper, spelled as the paper spells them:
   methods, concepts, components, phenomena, task and metric names that have a
   translation. Prefer the terms that recur and the ones a translator could
   plausibly render two different ways.
2. Leave out anything that stays in its original form in a translation — model
   and dataset names, acronyms, identifiers, symbols (ResNet-50, ImageNet, SGD,
   BN) — and ordinary academic vocabulary (method, result, experiment).
3. One translation per term: the established one in the field where there is
   one. No alternatives, no explanations, no parentheses.

Return JSON exactly in this shape, with no commentary around it:

{{"terms": [{{"source": "...", "target": "..."}}]}}
"""

#: The marker a caller (and a test double) can recognise this request by.
GLOSSARY_REQUEST_MARKER = "Paper text:"


def source_text(work: Plan) -> str:
    """The headings and the body the translation will send, formulas left out."""
    parts = [section.title for section in work.headings if section.title.strip()]
    used = sum(len(part) for part in parts)
    for batch in work.batches:
        for paragraph in batch.paragraphs:
            text = re.sub(r"⟦m\d+⟧", " ", protect(paragraph.text)[0])
            if used + len(text) > MAX_SOURCE_CHARS:
                return "\n\n".join(parts)
            parts.append(text)
            used += len(text)
    return "\n\n".join(parts)


def build_messages(work: Plan, *, target_language: str) -> list[dict[str, str]]:
    system = _SYSTEM.format(language=_language_name(target_language), low=MIN_TERMS, high=MAX_TERMS)
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": f"{GLOSSARY_REQUEST_MARKER}\n\n{source_text(work)}"},
    ]


async def extract(work: Plan, provider: LLMProvider, *, target_language: str) -> list[Term]:
    """One call: the paper's terms and the translation each should keep.

    Nothing a model says is taken on its word: an entry is kept only if its
    source really occurs in the paper and its translation is not the source
    again. An answer that is not the expected JSON is an empty glossary — the
    paper is still translated, as it was before there were glossaries.
    """
    from app.bilingual.pipeline import _parse

    if not work.batches:
        return []
    messages = build_messages(work, target_language=target_language)
    result = await provider.generate(LLMRequest(messages=messages))
    payload = _parse(result.text)
    if payload is None:
        return []
    paper = messages[1]["content"]
    return [
        term
        for term in clean(payload.get("terms"), limit=MAX_TERMS * 2)
        if term.target.lower() != term.source.lower() and occurs(term.source, paper)
    ][:MAX_TERMS]
