"""Rewriting a question into lexical queries the paper might actually contain.

This is **not** answering. The model is asked for search phrases, never for facts,
and what comes back is put through the same FTS5 path as everything else — so a
hallucinated phrase retrieves nothing and a hallucinated *fact* is impossible by
construction, because nothing here produces a claim.

## Why it exists at all

Two of the measured failure classes cannot be reached lexically. A Chinese
question against an English paper shares no token with the index and retrieves
zero rows; a paraphrase ("how does the method limit how far the policy may
change") shares no token with the paper's phrasing ("constraint on the size of the
policy update"). Together they were 10 of 13 misses. Appending metadata cannot
fix either, because there is no metadata to append on a paper nobody has analysed.

## Why it is reached rarely

It runs only when `needs_rewrite` says the local paths have already failed —
nothing matched, or the question's script cannot appear in the paper. An exact
model-name lookup, which lexical retrieval answers in about a millisecond, never
pays for a provider round trip.

## Output budget

Measured against the configured provider rather than guessed. This project's
provider is a reasoning model whose thinking is billed against the output budget:
DS-QA-002 recorded that at a 1200-token allowance it returned *nothing at all*,
and set `DEFAULT_OUTPUT_ALLOWANCE = 4000` for that reason. A small budget here
would produce a rewriter that always returns empty — indistinguishable, in the
results, from one that was never needed.
"""

from __future__ import annotations

import asyncio
import json

from app.llm.base import LLMProvider
from app.llm.errors import LLMError
from app.llm.models import ChatMessage, LLMRequest
from app.logging import get_logger

logger = get_logger(__name__)

#: Bump when the wording changes what the model is asked to produce.
REWRITE_PROMPT_VERSION = "1.0.0"

#: How many search queries to accept. The floor is 2 because one rewrite that is
#: worse than the original leaves the bundle exactly as it was; the ceiling is 4
#: because each one is an independent FTS5 query and beyond a handful the fused
#: ranking starts reflecting volume rather than relevance.
MIN_REWRITES = 2
MAX_REWRITES = 4

#: Output allowance. See the module docstring: 4000 is this repository's measured
#: value for a reasoning model, not a guess about how long four phrases take.
MAX_OUTPUT_TOKENS = 4000

#: How long a rewrite may take before the local path answers instead.
#:
#: Measured, not chosen: a reasoning model on this project's provider spent
#: 1.5-3.5 s per call in the DS-CTX-004 benchmarks, so a budget of a second or two
#: would abort every rewrite and silently disable the stage. The local path is
#: always available and costs nothing, so the cost of this being generous is a
#: slower answer to a question that would otherwise retrieve nothing at all.
REWRITE_TIMEOUT_S = 30.0

_SYSTEM = """\
You turn a reader's question about an academic paper into search queries.

You are NOT answering the question. Do not explain, do not summarise, do not
provide facts, and do not state what the paper says. Your only output is search
phrases.

The paper is written in the language named below. Produce short phrases in THAT
language, because that is what its text contains. If the question is in another
language, translate its *concepts* into the terminology the paper itself would use.

Rules:

1. Two to four phrases. Each is a short sequence of words likely to appear
   verbatim in the paper, not a sentence and not a question.
2. Prefer the paper's technical vocabulary over the question's everyday words.
   A question about "the method for limiting how much the policy changes" is
   looking for "trust region", "surrogate objective", "constraint on the policy
   update" — the words an author would write.
3. Preserve identifiers exactly: model names, dataset names, acronyms, symbols,
   numbers. Never translate or lowercase them.
4. Do not invent facts, names, numbers or citations. If the question mentions no
   model or dataset, none belongs in the output.
5. Reply with a single JSON object and nothing else:

   {"queries": ["phrase one", "phrase two"]}"""


class RewriteUnavailable(Exception):
    """The rewrite could not be produced. Callers fall back to the local path."""


async def rewrite_queries(
    question: str,
    *,
    provider: LLMProvider,
    paper_language: str,
    terminology: list[str] | None = None,
) -> list[str]:
    """Produce bounded source-language search queries, or raise.

    `terminology` is a short list of terms the paper is known to use — taken from
    a stored analysis when one exists. It is optional: the whole point is to work
    on a paper nobody has analysed.
    """
    hints = ""
    if terminology:
        joined = ", ".join(terminology[:12])
        hints = (
            "\n\nThe paper is known to use these terms, among others. Use them "
            f"where they fit the question; do not list them all:\n{joined}"
        )

    messages = [
        {"role": "system", "content": _SYSTEM},
        {
            "role": "user",
            "content": (
                f"Paper language: {paper_language}\n\n"
                f"Question: {question.strip()}{hints}"
            ),
        },
    ]

    try:
        result = await asyncio.wait_for(
            provider.generate(
                LLMRequest(
                    messages=[ChatMessage(role=m["role"], content=m["content"]) for m in messages],
                    # Deterministic: the same question should produce the same
                    # queries, or the benchmark is not reproducible and a cache
                    # would be pointless.
                    temperature=0.0,
                    max_output_tokens=MAX_OUTPUT_TOKENS,
                )
            ),
            timeout=REWRITE_TIMEOUT_S,
        )
    except asyncio.TimeoutError as exc:
        raise RewriteUnavailable(f"rewrite exceeded {REWRITE_TIMEOUT_S:.0f}s") from exc
    except LLMError as exc:
        raise RewriteUnavailable(f"{exc.code}: {exc.message}") from exc

    return parse_queries(result.text)


def parse_queries(text: str) -> list[str]:
    """Read the queries out of a reply, or raise.

    Structured output, parsed strictly. A conversational reply is a failure of the
    contract, not something to scrape with a regex — a phrase lifted out of prose
    is as likely to be the model's refusal as its answer.
    """
    candidate = (text or "").strip()
    if candidate.startswith("```"):
        body = candidate.split("\n", 1)[1] if "\n" in candidate else ""
        candidate = body.rstrip().removesuffix("```").strip()

    try:
        payload = json.loads(candidate)
    except json.JSONDecodeError:
        start, end = candidate.find("{"), candidate.rfind("}")
        if start < 0 or end <= start:
            raise RewriteUnavailable("reply was not JSON") from None
        try:
            payload = json.loads(candidate[start : end + 1])
        except json.JSONDecodeError as exc:
            raise RewriteUnavailable(f"reply was not JSON: {exc.msg}") from exc

    if not isinstance(payload, dict):
        raise RewriteUnavailable("reply was not a JSON object")

    raw = payload.get("queries")
    if not isinstance(raw, list):
        raise RewriteUnavailable('"queries" was not a list')

    queries: list[str] = []
    for entry in raw:
        if not isinstance(entry, str):
            continue
        cleaned = " ".join(entry.split())
        # A phrase with no letters or digits tokenizes to nothing, and a very long
        # one is a sentence the model answered the question with instead.
        if not cleaned or len(cleaned) > 120:
            continue
        if not any(character.isalnum() for character in cleaned):
            continue
        if cleaned not in queries:
            queries.append(cleaned)

    if len(queries) < MIN_REWRITES:
        raise RewriteUnavailable(f"only {len(queries)} usable queries")

    return queries[:MAX_REWRITES]


def terminology_hint(analysis) -> list[str]:
    """A few terms the paper is known to use, for the rewrite prompt.

    Deliberately tiny. Sending the whole glossary would be uploading the paper's
    analysis to rewrite a search query, and the acronyms without expansions are
    skipped because they say nothing about how the paper writes.
    """
    if analysis is None:
        return []

    terms: list[str] = []
    for entry in analysis.acronyms:
        if entry.expansion:
            terms.append(entry.expansion)
    for entry in analysis.entities:
        terms.append(entry.name)
    for entry in analysis.glossary:
        if entry.category:
            terms.append(entry.source_term)

    seen: set[str] = set()
    unique: list[str] = []
    for term in terms:
        folded = term.casefold()
        if folded in seen or len(term) > 60:
            continue
        seen.add(folded)
        unique.append(term)
    return unique[:12]
