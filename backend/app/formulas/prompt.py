"""Asking a model to reconstruct a paper's display formulas as LaTeX.

The audience is a reader, and every rule below exists because of something
measured or something this repository already paid for:

- **One output per input, keyed by the id it was given.** The column places a
  reconstruction under the formula it belongs to, so a missing id is a hole and
  an invented one is a formula that does not exist. Neither is repaired by
  guessing; both are reported.
- **A refusal is a real answer.** The glyph stream a compiled PDF yields has
  lost fraction bars, flattened superscripts and misread symbols; when not
  enough survives to know what the author wrote, the model must refuse rather
  than emit mathematics that looks right and is not. The column then shows the
  paper's own pixels.
- **The surrounding prose is the disambiguation.** The variables are resolved
  in the prose, not in the formula — the paper says "where τ is the temperature
  parameter" beside it — so a window of nearby prose travels with each formula.
- **Long formulas are split, not squeezed.** An equation longer than ~50
  characters is asked for as a multiline `aligned` environment, breaking before
  relational operators, because the column must never scroll sideways.

The formula entries are JSON objects on purpose: the loopback stub provider the
harness runs against locates the ids by their `"block_id"` keys, so the shape of
this prompt *is* the interface the tests exercise.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

#: How many formulas may go into one call. A paper in one request is cheaper and
#: worse: the model loses the thread of a long paper, and a single malformed
#: answer costs every formula in it. Fifteen keeps every batch answerable and
#: every failure local — measured, that is one call for the reader's paper (7
#: formulas) and five for Mamba-3 (66).
MAX_FORMULAS_PER_BATCH = 15

#: How much surrounding prose travels with each formula, either side of it.
#: The resolved variables live there, which is what makes reconstruction
#: possible at all.
PROSE_WINDOW_CHARS = 800

#: The refusal reason recorded when the model refused without saying why.
#: Presenting a reason is the pipeline's duty; inventing one for the model is
#: not, so the default names the refusal and nothing more.
DEFAULT_REFUSAL_REASON = "模型无法根据字形重建该公式"


@dataclass(frozen=True)
class FormulaPromptEntry:
    """One formula as a prompt sees it: the glyph soup, its geometry, and the
    prose that resolves its variables."""

    block_id: str
    source_anchor_id: str
    page_number: int
    bbox: tuple[float, float, float, float]
    raw_soup: str
    font_size: float | None
    surrounding_prose: str


_SYSTEM = """\
You are reconstructing the LaTeX of the display formulas of an academic paper,
for a reader who will see the typeset mathematics beside the original page.

The "glyph_stream" you are given was read out of a compiled PDF, and it is not
mathematics: fraction bars are lost, summations appear as letters with their
bounds flattened beside them, superscripts and subscripts collapse onto their
base, and symbols degenerate. Your job is to reconstruct the mathematics the
author wrote, using the surrounding prose to resolve the variables.

## Hard rules

1. Return exactly one entry for every block_id you are given, and none for any
   id you were not given. Never merge two formulas, never split one, never add
   one.
2. Reconstruct only mathematics the glyph stream supports. The surrounding
   prose resolves the variables; it does not license a formula the paper does
   not state.
3. Answer with KaTeX-compatible LaTeX for a display equation. Do not wrap it in
   $ or $$, do not add \\begin{equation}, and do not renumber it.
4. If an equation is longer than ~50 characters, split it across lines with an
   aligned environment (\\begin{aligned} ... \\end{aligned}), breaking before
   relational operators (=, \\approx, \\le) or major binary additions.
5. If the glyph stream is unresolvable — not enough survives to know what the
   author wrote — answer with status "refusal" and a short refusal_reason
   saying what is missing. A plausible-looking guess is worse than a refusal:
   the reader will see the paper's own pixels instead, and an invented bound or
   a swapped subscript would be read as the author's mathematics.

Return JSON exactly in this shape, with no commentary around it. The id goes
where <id> is shown, one entry per id you were given:

{
  "formulas": [
    {"block_id": <id>, "status": "reconstructed", "latex": "..."},
    {"block_id": <id>, "status": "refusal", "refusal_reason": "..."}
  ]
}
"""


def build_messages(entries: list[FormulaPromptEntry]) -> list[dict[str, str]]:
    """The two messages one batch is reconstructed from.

    Each entry carries everything a reconstruction needs and nothing else: the
    soup, the geometry, and the prose that resolves the variables. The window
    belongs to *this* formula, so a batch's entries each bring their own.
    """
    return [
        {"role": "system", "content": _SYSTEM},
        {
            "role": "user",
            "content": "Formulas to reconstruct:\n\n"
            + "\n".join(
                json.dumps(_entry_payload(entry), ensure_ascii=False)
                for entry in entries
            ),
        },
    ]


def _entry_payload(entry: FormulaPromptEntry) -> dict:
    # The bbox is PDF points and the page number 1-based: the same numbers the
    # reader's own view carries, so the model sees the layout the way the paper
    # printed it.
    return {
        "block_id": entry.block_id,
        "source_anchor_id": entry.source_anchor_id,
        "page_number": entry.page_number,
        "font_size": entry.font_size,
        "bbox": list(entry.bbox),
        "glyph_stream": entry.raw_soup,
        "surrounding_prose": entry.surrounding_prose,
    }
