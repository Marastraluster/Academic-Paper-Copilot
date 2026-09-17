"""Turning laid-out lines into prose, without changing what the paper said.

Normalization here is deliberately narrow. It joins what the PDF broke, and
leaves alone everything a later reader, translator, or citation resolver needs to
still recognise. Nothing is dropped, reordered, or summarised.

The one genuinely ambiguous decision is de-hyphenation. A line ending in a hyphen
is *usually* a word wrapped for justification, but occasionally it is a real
compound that happened to break at its own hyphen — joining `self-` +
`attention` into `selfattention` would corrupt the text. Even a human needs a
dictionary to tell those apart, so this module uses a conservative rule and
**states its failure mode** rather than pretending to certainty:

* a line-final hyphen followed by a lowercase continuation is treated as a wrap
  and removed;
* unless the fragment before the hyphen is a common compound-forming prefix, in
  which case the hyphen is kept and only the break is closed.

The residue is real: an unusual compound that breaks after its own hyphen and is
not in the prefix list will be joined. That is why the prefix list exists and why
it is small, explicit, and testable.
"""

from __future__ import annotations

import re
import unicodedata

#: Fragments that, when a line ends with one plus a hyphen, are far more likely
#: to be the first half of a compound than a wrapped word. Deliberately compact:
#: a long list would be a dictionary, and a wrong entry silently corrupts text.
_COMPOUND_PREFIXES = frozenset(
    {
        "self", "state", "multi", "non", "well", "real", "fine", "end",
        "long", "high", "low", "cross", "deep", "zero", "few", "one",
        "two", "three", "co", "pre", "post", "semi", "sub", "part",
    }
)

#: In-text academic citations, which must survive normalization verbatim.
#: Accepts the bracket and author-year forms, and the dash variants a typesetter
#: may have used for a range.
CITATION_PATTERN = re.compile(
    r"\[\s*\d+\s*(?:[-–—,;]\s*\d+\s*)*\]"
    r"|\(\s*[A-Z][A-Za-z'’\-]+(?:\s+(?:et\s+al\.?|and|&)\s*[A-Za-z'’\-]*)?"
    r",?\s*(?:19|20)\d{2}[a-z]?\s*\)"
)

#: Horizontal whitespace only — a newline is structure here, not noise, because
#: the line-joining rules below depend on seeing where lines ended.
#:
#: Written as an explicit set rather than `[^\S\n]` so the intent is visible and
#: the class also catches the non-breaking and zero-width spaces that PDF
#: typesetters scatter through justified text. A U+00A0 left in place would make
#: two words unmatchable by any later search.
_WHITESPACE = re.compile("[	    -​  　]+")
_LINE_HYPHEN = re.compile(r"(\S+?)-$")


def normalize_unicode(text: str) -> str:
    """NFKC normalization.

    Turns compatibility forms into their canonical equivalents — the ``ﬁ``
    ligature becomes ``fi``, full-width Latin becomes half-width — so downstream
    matching and translation see ordinary characters. Applied per line, before
    line joining, because the joining rules reason about plain ASCII punctuation.
    """
    return unicodedata.normalize("NFKC", text)


def normalize_line(line: str) -> str:
    """Whitespace-collapse a single line. Does not join anything."""
    return _WHITESPACE.sub(" ", normalize_unicode(line)).strip()


def join_wrapped_lines(lines: list[str]) -> str:
    """Join layout lines into a single prose string.

    Handles the two things a PDF does to a paragraph: it breaks lines mid-
    sentence, and sometimes mid-word.
    """
    cleaned = [normalize_line(line) for line in lines]
    cleaned = [line for line in cleaned if line]
    if not cleaned:
        return ""

    out = cleaned[0]
    for line in cleaned[1:]:
        match = _LINE_HYPHEN.search(out)
        if match and line[:1].islower():
            fragment = match.group(1).lower()
            if fragment in _COMPOUND_PREFIXES:
                # A compound that broke at its own hyphen: keep the hyphen.
                out = f"{out}{line}"
            else:
                # A wrapped word: remove the hyphen and close the gap.
                out = f"{out[:-1]}{line}"
            continue
        out = f"{out} {line}"

    return _WHITESPACE.sub(" ", out).strip()


def citations_in(text: str) -> list[str]:
    """Every citation in ``text``. Used to prove none were stripped."""
    return CITATION_PATTERN.findall(text)


def looks_like_prose(text: str) -> bool:
    """Whether a block is worth treating as a sentence.

    Guards against single glyphs, bare numbers, and stray marks being promoted to
    paragraphs — a page number that slipped past classification, for instance.
    """
    stripped = text.strip()
    if len(stripped) < 2:
        return False
    return any(character.isalpha() for character in stripped)


def ends_sentence(text: str) -> bool:
    """Whether a paragraph can be considered complete.

    Used when deciding whether the next block continues it. Terminal punctuation
    in a non-Latin script counts too, or a Chinese paragraph would be treated as
    permanently unterminated.
    """
    stripped = text.rstrip()
    if not stripped:
        return False
    return stripped[-1] in ".!?。！？:;…"
