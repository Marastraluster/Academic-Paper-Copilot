"""One sentence per related paper: how it relates to the open one.

Grounded in the two abstracts and nothing else — the model is told so, and a
candidate with no abstract gets no sentence rather than a guess from its title.
One call covers up to `MAX_PER_CALL` candidates; answers are kept with the
cached results so a paper is explained once.
"""

from __future__ import annotations

import json
import re

from app.document.models import DocumentIR
from app.llm.base import LLMProvider
from app.llm.models import LLMRequest
from app.related.sources import Work

MAX_PER_CALL = 8
ABSTRACT_CHARS = 900

_SYSTEM = """\
You explain to a reader how other papers relate to the paper they are reading.

Rules:
1. Write in Simplified Chinese, one sentence per candidate, at most 60 characters.
2. Use ONLY the two abstracts given. If they do not support a relationship, say
   what the candidate is about instead. Never invent results or numbers.
3. Name the relationship concretely: builds on, is compared against, proposes an
   alternative to, applies it to, analyses why it works, and so on.
4. Keep model, dataset and method names exactly as written.

Return JSON only: {"items": [{"key": "...", "relation": "..."}]}
"""


def _abstract(ir: DocumentIR) -> str:
    text = " ".join(p.text for p in ir.paragraphs if p.is_abstract)
    if not text and ir.paragraphs:
        text = ir.paragraphs[0].text
    return text[:ABSTRACT_CHARS * 2]


def build_messages(ir: DocumentIR, works: list[Work]) -> list[dict[str, str]]:
    lines = [
        f"The paper being read: {ir.metadata.title or ir.source_filename}",
        f"Its abstract: {_abstract(ir)}",
        "",
        "Candidates:",
    ]
    for work in works:
        lines.append(json.dumps({
            "key": work.key,
            "title": work.title,
            "year": work.year,
            "abstract": (work.abstract or "")[:ABSTRACT_CHARS],
        }, ensure_ascii=False))
    return [
        {"role": "system", "content": _SYSTEM},
        {"role": "user", "content": "\n".join(lines)},
    ]


def _parse(raw: str) -> dict[str, str]:
    text = raw.strip()
    text = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return {}
    try:
        data = json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return {}
    out: dict[str, str] = {}
    for item in data.get("items") or []:
        if isinstance(item, dict) and isinstance(item.get("key"), str) and isinstance(item.get("relation"), str):
            relation = item["relation"].strip()
            if relation and len(relation) <= 120:
                out[item["key"]] = relation
    return out


async def explain(ir: DocumentIR, works: list[Work], provider: LLMProvider) -> dict[str, str]:
    """``key → sentence`` for the candidates that have an abstract."""
    with_abstract = [w for w in works if (w.abstract or "").strip()]
    allowed = {w.key for w in with_abstract}
    found: dict[str, str] = {}
    for start in range(0, len(with_abstract), MAX_PER_CALL):
        chunk = with_abstract[start:start + MAX_PER_CALL]
        result = await provider.generate(LLMRequest(messages=build_messages(ir, chunk)))
        for key, relation in _parse(result.text).items():
            if key in allowed:
                found[key] = relation
    return found
