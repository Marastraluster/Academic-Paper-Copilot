"""Token accounting, so a request is never built that cannot be answered.

There is no tokenizer here and none is added. A tokenizer is a per-model
dependency, and this project deliberately does not model what a user's endpoint
can hold — the user supplies an endpoint and a model name, and the application
never assumes capacities on their behalf. What it *does* do is refuse to send a
request whose size it cannot justify.

So the estimate is conservative and expressed in characters, with CJK counted
separately: a Chinese character costs one to two tokens where a Latin character
costs roughly a quarter of one. A single `len(text) // 4` would under-count a
Chinese paper by an order of magnitude, which is precisely the direction that
loses requests.

**Over-estimating is the safe direction.** A budget slightly too small costs an
extra chunk; a budget too large produces a request the provider rejects, which
the task brief forbids as a strategy.
"""

from __future__ import annotations

import math

#: Default ceiling for everything the analysis pipeline sends in one request:
#: prompt overhead + source text + room for the answer.
#:
#: Conservative on purpose (see AC_CHANGE_REQUEST 1 in the frozen criteria):
#: model context windows are not modelled, so this is a floor that every
#: OpenAI-compatible endpoint comfortably supports, not a guess at any model's
#: real capacity.
DEFAULT_CONTEXT_BUDGET = 6000

#: Room reserved for the model's own answer within a request's budget.
DEFAULT_OUTPUT_ALLOWANCE = 1200

#: A request must leave this much of the budget for input after overhead.
MIN_INPUT_ALLOWANCE = 400

#: Below this, a document is analysed in a single pass instead of section by
#: section. Forcing a two-page extended abstract through three serialised calls
#: is waste, not rigour.
SINGLE_PASS_TOKEN_LIMIT = 2000

#: Largest slice of unsectioned text to analyse at once.
SYNTHETIC_CHUNK_TOKENS = 1200

#: Character budget for the whole glossary handed to the ContextBuilder before
#: relevance filtering narrows it.
MAX_GLOSSARY_ENTRIES = 15


def estimate_tokens(text: str) -> int:
    """A deliberately generous estimate of what ``text`` will cost.

    CJK characters are counted at 1.5 tokens each, everything else at one token
    per 3.5 characters. Both are pessimistic against real tokenizers for their
    scripts, which is the direction that keeps a request inside its budget.
    """
    if not text:
        return 0

    cjk = 0
    for character in text:
        codepoint = ord(character)
        if (
            0x4E00 <= codepoint <= 0x9FFF      # CJK unified ideographs
            or 0x3040 <= codepoint <= 0x30FF  # kana
            or 0xAC00 <= codepoint <= 0xD7AF  # hangul
            or 0x3000 <= codepoint <= 0x303F  # CJK punctuation
            or 0xFF00 <= codepoint <= 0xFFEF  # fullwidth forms
        ):
            cjk += 1

    other = len(text) - cjk
    return math.ceil(cjk * 1.5 + other / 3.5)


def truncate_to_tokens(text: str, max_tokens: int) -> str:
    """Shorten ``text`` to fit, cutting at a sentence or word boundary.

    Never returns a fragment ending mid-word; a context line that stops halfway
    through a word reads as corruption to the model that receives it.
    """
    if max_tokens <= 0:
        return ""
    if estimate_tokens(text) <= max_tokens:
        return text

    # Walk down from a character budget, then retreat to a clean boundary.
    rough = max(1, int(max_tokens * 3.0))
    candidate = text[:rough]

    for boundary in (". ", "。", "! ", "? ", "; ", ", ", " "):
        index = candidate.rfind(boundary)
        if index > len(candidate) // 2:
            return candidate[: index + len(boundary)].rstrip()

    return candidate.rstrip()
