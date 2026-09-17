"""Assembling the bounded context a future translation call will receive.

Everything about the *source* side of this comes from the Document IR, not from
the model: neighbours are the actual adjacent paragraphs in canonical reading
order, sections are the real `section_id`, page numbers are real. The analysis
enriches that structure — it supplies the summary, the domain and the glossary —
but it never redefines which paragraph comes next.

## Budget shedding

The context has a fixed token budget, and when the material exceeds it something
has to go. The order is not arbitrary; it is "how much would losing this hurt the
translation of *this* paragraph":

1. glossary terms that do not occur in the target paragraph,
2. the document summary,
3. the section summary,
4. the neighbouring paragraphs.

Two things are never shed: the **section title**, which is a handful of tokens and
tells the model where it is, and any glossary term that actually occurs in the
target paragraph, which is precisely the terminology the context exists to fix.

What was dropped is recorded in `shed`, because a context that quietly shrank
looks identical to one where the analysis had nothing to say.
"""

from __future__ import annotations

from app.context.budget import MAX_GLOSSARY_ENTRIES, estimate_tokens, truncate_to_tokens
from app.context.models import (
    ContextGlossaryTerm,
    DocumentAnalysis,
    GlossaryEntry,
    TranslationContext,
)
from app.document.models import DocumentIR, ParagraphIR

#: Relative weight of a neighbour paragraph against its actual length. A
#: neighbour is *useful* for disambiguation but is not the thing being translated,
#: so when space is short it is the first prose to go.
_NEIGHBOUR_ALLOWANCE_RATIO = 0.25


def _occurs(term: str, text: str) -> bool:
    """Whether a term appears in the paragraph, tolerating case and spacing.

    Case-insensitive and whitespace-normalised, because a glossary records the
    term as it was written where it was first found, and prose is not obliged to
    repeat that capitalisation.
    """
    if not term:
        return False
    haystack = " ".join(text.casefold().split())
    needle = " ".join(term.casefold().split())
    return needle in haystack


class ContextBuilder:
    """Builds translation context for one paragraph of one document."""

    def __init__(self, ir: DocumentIR, analysis: DocumentAnalysis | None) -> None:
        self._ir = ir
        self._analysis = analysis
        self._by_id = {paragraph.id: paragraph for paragraph in ir.paragraphs}
        # Reading order is the IR's own, so a "previous paragraph" is the
        # paragraph a reader would actually have read before this one — not the
        # nearest one by coordinates, which is a different thing on a two-column
        # page and a wrong one across a column break.
        self._order = {paragraph.id: index for index, paragraph in enumerate(ir.paragraphs)}

    def build_context(
        self, paragraph_id: str, *, max_tokens: int = 1500
    ) -> TranslationContext:
        target = self._by_id.get(paragraph_id)
        if target is None:
            raise KeyError(f"no paragraph {paragraph_id!r} in document {self._ir.document_id}")

        section = self._section_of(target)
        context = TranslationContext(
            paragraph_id=target.id,
            page_number=target.page_number,
            section_id=target.section_id,
            section_title=section.title if section else None,
            section_summary=section.summary if section else None,
            document_summary=(self._analysis.summary if self._analysis else None),
            academic_domain=(
                self._analysis.domain.primary
                if self._analysis and self._analysis.domain
                else None
            ),
            glossary=self._select_glossary(target),
            previous_paragraph=self._neighbour(target, -1),
            next_paragraph=self._neighbour(target, +1),
        )

        return self._fit(context, max_tokens)

    # -- source-side lookups ----------------------------------------------

    def _section_of(self, paragraph: ParagraphIR):
        if self._analysis is None or paragraph.section_id is None:
            return None
        for section in self._analysis.sections:
            if section.section_id == paragraph.section_id:
                return section
        return None

    def _neighbour(self, paragraph: ParagraphIR, offset: int) -> str | None:
        """The adjacent paragraph in reading order, if there is one.

        Only prose has neighbours. A figure caption or a formula is not the next
        sentence of anything, and offering one as "the previous paragraph" would
        put an equation fragment where the model expects a sentence.
        """
        index = self._order.get(paragraph.id)
        if index is None:
            return None
        neighbour_index = index + offset
        if not 0 <= neighbour_index < len(self._ir.paragraphs):
            return None
        neighbour = self._ir.paragraphs[neighbour_index]
        if not neighbour.text.strip():
            return None
        return neighbour.text

    def _select_glossary(self, target: ParagraphIR) -> list[ContextGlossaryTerm]:
        """Terms worth carrying for this paragraph.

        A whole-paper glossary sent with every paragraph would be mostly noise,
        and noise that costs the model's attention on every single call. What
        earns a place is a term that actually occurs here, or — when there is
        room — one from the same section.
        """
        if self._analysis is None:
            return []

        section_text = " ".join(
            paragraph.text
            for paragraph in self._ir.paragraphs
            if paragraph.section_id and paragraph.section_id == target.section_id
        )

        matched: list[GlossaryEntry] = []
        nearby: list[GlossaryEntry] = []
        for entry in self._analysis.glossary:
            if _occurs(entry.source_term, target.text):
                matched.append(entry)
            elif section_text and _occurs(entry.source_term, section_text):
                nearby.append(entry)

        # Identifiers that must not be translated outrank ordinary vocabulary when
        # space is short: getting `ResNet-50` wrong is worse than getting a
        # generic noun wrong.
        matched.sort(key=lambda entry: (entry.is_translatable, entry.source_term))
        selected = (matched + nearby)[:MAX_GLOSSARY_ENTRIES]

        return [
            ContextGlossaryTerm(
                source_term=entry.source_term,
                suggested_translation=entry.suggested_translation,
                is_translatable=entry.is_translatable,
            )
            for entry in selected
        ]

    # -- budget ------------------------------------------------------------

    def _fit(self, context: TranslationContext, max_tokens: int) -> TranslationContext:
        """Reduce the context until it fits, in the documented order."""
        if self._measure(context) <= max_tokens:
            return context

        # 1. Glossary terms that do not occur in the target paragraph. These are
        #    the least relevant material in the package by construction: they were
        #    included because they occur *nearby*, not here.
        #
        #    Terms that do occur here are protected — they are the terminology the
        #    context exists to pin down, and a translation that got them wrong
        #    would be wrong in exactly the way this layer is meant to prevent.
        target_text = self._by_id[context.paragraph_id].text
        protected = [term for term in context.glossary if _occurs(term.source_term, target_text)]
        shed_order = [term for term in context.glossary if term not in protected]

        glossary = protected + shed_order
        dropped_any = False
        while self._measure(context) > max_tokens and len(glossary) > len(protected):
            glossary.pop()
            dropped_any = True
        context.glossary = glossary
        if dropped_any:
            context.shed.append("glossary")

        # 2, 3, 4. Then the prose, in decreasing order of usefulness.
        for attribute, label in (
            ("document_summary", "document_summary"),
            ("section_summary", "section_summary"),
            ("previous_paragraph", "previous_paragraph"),
            ("next_paragraph", "next_paragraph"),
        ):
            value = getattr(context, attribute)
            if value is None:
                continue
            if self._measure(context) <= max_tokens:
                break
            remaining = max_tokens - (self._measure(context) - estimate_tokens(value))
            trimmed = truncate_to_tokens(value, max(0, remaining))
            setattr(context, attribute, trimmed or None)
            if label not in context.shed:
                context.shed.append(label)

        return context

    def _measure(self, context: TranslationContext) -> int:
        total = 0
        for value in (
            context.section_title,
            context.section_summary,
            context.document_summary,
            context.academic_domain,
            context.previous_paragraph,
            context.next_paragraph,
        ):
            if value:
                total += estimate_tokens(value)
        for term in context.glossary:
            total += estimate_tokens(term.source_term) + estimate_tokens(
                term.suggested_translation or ""
            )
        return total
