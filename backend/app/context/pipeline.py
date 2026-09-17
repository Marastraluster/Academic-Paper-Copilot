"""Turning a Document IR into a DocumentAnalysis.

The shape of the work is dictated by one constraint: a fifty-page paper cannot be
sent to a model in one request. So the document is analysed section by section,
each section is chunked if it is itself too large, and the document-level summary
is synthesised from the section summaries rather than from the paper — by the
time synthesis runs, the text has already been read once and distilled.

Three properties matter more than the flow.

**One failure does not lose the rest.** Sections are independent units of work; a
timeout in section 3 of 8 must not discard sections 1, 2 and 4 through 8. Each
failure is recorded and the run is reported `PARTIAL`. Throwing away five minutes
of successful extraction because of one request is the behaviour this avoids.

**Every request is checked against a budget before it is sent**, never after it
is rejected.

**Nothing is persisted unless it validated.** A malformed or empty response is
retried once and then recorded as a failure, never written as a `READY` analysis.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from app.context import prompts
from app.context.budget import (
    DEFAULT_CONTEXT_BUDGET,
    DEFAULT_OUTPUT_ALLOWANCE,
    MIN_INPUT_ALLOWANCE,
    SINGLE_PASS_TOKEN_LIMIT,
    SYNTHETIC_CHUNK_TOKENS,
    estimate_tokens,
)
from app.context.evidence import AnalysisValidationError, EvidenceValidator
from app.context.models import (
    PIPELINE_VERSION,
    AcronymEntry,
    AnalysisErrorRecord,
    AnalysisProvenance,
    AnalysisStatus,
    DocumentAnalysis,
    DomainRecord,
    EntityEntry,
    GlossaryEntry,
    SectionAnalysis,
)
from app.document.models import DocumentIR, ParagraphIR
from app.llm.errors import (
    LLMAuthenticationError,
    LLMBadRequestError,
    LLMError,
    LLMInvalidResponseError,
    LLMNotFoundError,
    LLMOutputTruncatedError,
    LLMPermissionDeniedError,
    LLMRateLimitError,
    LLMServerError,
    LLMTimeoutError,
)
from app.logging import get_logger

logger = get_logger(__name__)

#: Sends one prompt and returns the model's raw text.
#:
#: A function rather than a provider object so the pipeline can be driven by a
#: deterministic fake in tests without constructing a provider, an HTTP client or
#: a credential. The production implementation wraps the existing LLM layer and
#: is the only place that knows about `LLMProvider`.
CompletionFn = Callable[[list[dict[str, str]], int], Awaitable[str]]

#: Attempts per unit, by failure kind. Auth and bad-request failures are absent
#: deliberately: retrying a rejected key produces the same rejection.
_RETRYABLE: dict[type[LLMError], int] = {
    LLMRateLimitError: 3,
    LLMServerError: 2,
    LLMTimeoutError: 2,
}

#: No-retry failures. Named rather than implied, so a new error type added to the
#: hierarchy is treated as retryable only if someone decides it is.
_FATAL = (
    LLMAuthenticationError,
    LLMPermissionDeniedError,
    LLMBadRequestError,
    LLMNotFoundError,
)

_BACKOFF_SECONDS = (1.0, 2.0)

_JSON_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)


class CancelledError(Exception):
    """Raised internally when the caller's cancellation event is set."""


def _now() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


@dataclass
class _Unit:
    """One independently-analysed piece of the document."""

    section_id: str
    title: str
    page_range: tuple[int, int]
    paragraphs: list[ParagraphIR]
    synthetic: bool = False


@dataclass
class _Accumulated:
    """Everything extracted so far, merged across units."""

    glossary: dict[str, GlossaryEntry] = field(default_factory=dict)
    acronyms: dict[str, AcronymEntry] = field(default_factory=dict)
    entities: dict[str, EntityEntry] = field(default_factory=dict)


class AnalysisPipeline:
    """Runs the hierarchical analysis for one document."""

    def __init__(
        self,
        completion: CompletionFn,
        *,
        target_language: str = "zh-CN",
        context_budget: int = DEFAULT_CONTEXT_BUDGET,
        output_allowance: int = DEFAULT_OUTPUT_ALLOWANCE,
        cancellation_event: asyncio.Event | None = None,
    ) -> None:
        # Room for input *and* for doubling the output allowance on a truncated
        # retry. Without the second part a chunk that truncates cannot be given
        # more room, which is the failure this budget exists to prevent.
        if context_budget <= 2 * output_allowance + MIN_INPUT_ALLOWANCE:
            raise ValueError(
                "context_budget leaves no room for input once the output allowance "
                "and its retry headroom are reserved"
            )
        self._complete = completion
        self._target_language = target_language
        self._budget = context_budget
        self._output_allowance = output_allowance
        self._cancel = cancellation_event
        self.validator: EvidenceValidator | None = None
        self._requests = 0

    # -- public ----------------------------------------------------------

    @property
    def requests_made(self) -> int:
        """Provider requests issued. Reported so tests can prove boundedness."""
        return self._requests

    async def analyse(self, ir: DocumentIR, provenance: AnalysisProvenance) -> DocumentAnalysis:
        self.validator = EvidenceValidator(
            {paragraph.id: paragraph.text for paragraph in ir.paragraphs}
        )
        accumulated = _Accumulated()
        errors: list[AnalysisErrorRecord] = []
        #: Each successfully-analysed unit, with its summary. The unit is kept
        #: rather than just its title so the section record can be rebuilt from
        #: the same object that produced the work — matching summaries back to
        #: units by title would break the moment two sections shared one.
        analysed: list[tuple[_Unit, str]] = []

        total_tokens = estimate_tokens(
            "\n".join(paragraph.text for paragraph in ir.paragraphs)
        )
        title = ir.metadata.title or ir.source_filename

        if total_tokens <= SINGLE_PASS_TOKEN_LIMIT:
            domain, summary = await self._single_pass(
                ir, title, accumulated, errors, analysed
            )
        else:
            for unit in self._build_units(ir):
                try:
                    unit_summary = await self._analyse_unit(unit, accumulated)
                except CancelledError:
                    raise
                except _FATAL:
                    # A rejected key, a forbidden endpoint, a bad request: these
                    # describe the *configuration*, not this section. Carrying on
                    # would repeat the same failure once per section — eight
                    # pointless requests against an endpoint that has already
                    # refused us — so the run stops here and the caller decides.
                    raise
                except (LLMError, AnalysisValidationError) as exc:
                    # Everything else is local to a request and may be transient.
                    # One unit's failure is recorded, not propagated: discarding
                    # minutes of successful extraction over one bad request is
                    # exactly what `PARTIAL` exists to prevent.
                    errors.append(
                        AnalysisErrorRecord(
                            scope=unit.section_id,
                            code=getattr(exc, "code", "LLM_ERROR"),
                            message=getattr(exc, "message", str(exc)),
                        )
                    )
                    logger.warning(
                        "analysis unit failed",
                        extra={
                            "document_id": ir.document_id,
                            "section_id": unit.section_id,
                            "code": getattr(exc, "code", "LLM_ERROR"),
                        },
                    )
                    continue

                analysed.append((unit, unit_summary))

            domain, summary = await self._synthesise(
                ir, title, analysed, accumulated, errors
            )

        return self._build(ir, provenance, domain, summary, accumulated, errors, analysed)

    # -- units -----------------------------------------------------------

    def _build_units(self, ir: DocumentIR) -> list[_Unit]:
        """Group paragraphs into sections, or into synthetic partitions.

        Papers with usable structure use it. Papers without get contiguous
        partitions bounded by page and size — because "this document has no
        sections" must not mean "this document is not analysed".
        """
        by_section: dict[str, list[ParagraphIR]] = {}
        unsectioned: list[ParagraphIR] = []

        for paragraph in ir.paragraphs:
            if paragraph.section_id:
                by_section.setdefault(paragraph.section_id, []).append(paragraph)
            else:
                unsectioned.append(paragraph)

        units: list[_Unit] = []
        for section in ir.sections:
            paragraphs = by_section.get(section.id, [])
            if paragraphs:
                units.append(
                    _Unit(
                        section_id=section.id,
                        title=section.title,
                        page_range=section.page_range,
                        paragraphs=paragraphs,
                    )
                )

        for index, partition in enumerate(self._partition(unsectioned)):
            first, last = partition[0], partition[-1]
            units.append(
                _Unit(
                    section_id=f"synthetic_chunk_p{first.page_number}_p{last.page_number}_{index}",
                    title=f"Unsectioned Content (Pages {first.page_number}-{last.page_number})",
                    page_range=(first.page_number, last.page_number),
                    paragraphs=partition,
                    synthetic=True,
                )
            )

        return units

    def _partition(self, paragraphs: list[ParagraphIR]) -> list[list[ParagraphIR]]:
        """Split unsectioned paragraphs on page and size boundaries."""
        partitions: list[list[ParagraphIR]] = []
        current: list[ParagraphIR] = []
        size = 0

        for paragraph in paragraphs:
            tokens = estimate_tokens(paragraph.text)
            page_break = bool(current) and current[-1].page_number != paragraph.page_number
            too_big = size + tokens > SYNTHETIC_CHUNK_TOKENS
            if current and too_big:
                partitions.append(current)
                current, size = [], 0
            elif current and page_break and size + tokens > SYNTHETIC_CHUNK_TOKENS // 2:
                partitions.append(current)
                current, size = [], 0
            current.append(paragraph)
            size += tokens

        if current:
            partitions.append(current)
        return partitions

    # -- per-unit analysis -----------------------------------------------

    async def _analyse_unit(self, unit: _Unit, accumulated: _Accumulated) -> str:
        """Analyse one unit, chunking it if it is too large for one request."""
        chunks = self._chunk(unit.paragraphs)
        summaries: list[str] = []

        for chunk in chunks:
            payload = await self._request_json(
                lambda: prompts.section_analysis_messages(
                    section_title=unit.title,
                    paragraphs=[
                        (paragraph.id, paragraph.page_number, paragraph.text)
                        for paragraph in chunk
                    ],
                    target_language=self._target_language,
                ),
                scope=unit.section_id,
            )
            summaries.append(str(payload.get("summary", "")).strip())
            self._merge(payload, accumulated)

        joined = " ".join(summary for summary in summaries if summary)
        if not joined.strip():
            raise AnalysisValidationError(
                "EMPTY_SECTION_SUMMARY",
                f"section {unit.section_id!r} produced no summary",
            )
        return joined

    def _chunk(self, paragraphs: list[ParagraphIR]) -> list[list[ParagraphIR]]:
        """Group paragraphs so each request fits the budget.

        Boundaries are always paragraph boundaries. A chunk that split a
        paragraph would hand the model half a sentence, and for a formula-heavy
        paragraph it could hand it half an equation.
        """
        # Sized so a truncated chunk can be retried at double the output
        # allowance without exceeding the budget.
        input_allowance = self._budget - 2 * self._output_allowance
        chunks: list[list[ParagraphIR]] = []
        current: list[ParagraphIR] = []
        size = input_allowance - MIN_INPUT_ALLOWANCE

        for paragraph in paragraphs:
            tokens = estimate_tokens(paragraph.text)
            if current and size + tokens > input_allowance:
                chunks.append(current)
                current, size = [], 0
            # A single paragraph larger than the allowance still becomes a chunk;
            # dropping it would silently lose text, which is worse than sending a
            # long one.
            current.append(paragraph)
            size += tokens

        if current:
            chunks.append(current)
        return chunks

    # -- synthesis --------------------------------------------------------

    async def _single_pass(
        self,
        ir: DocumentIR,
        title: str,
        accumulated: _Accumulated,
        errors: list[AnalysisErrorRecord],
        analysed: list[tuple[_Unit, str]],
    ) -> tuple[DomainRecord | None, str | None]:
        """Analyse a short document in one request."""
        paragraphs = self._chunk(ir.paragraphs)
        payload: dict[str, Any] = {}
        summaries: list[str] = []

        try:
            for chunk in paragraphs:
                payload = await self._request_json(
                    lambda: prompts.single_pass_messages(
                        title=title,
                        paragraphs=[
                            (paragraph.id, paragraph.page_number, paragraph.text)
                            for paragraph in chunk
                        ],
                        target_language=self._target_language,
                    ),
                    scope="document",
                )
                self._merge(payload, accumulated)
                if payload.get("summary"):
                    summaries.append(str(payload["summary"]).strip())
        except _FATAL:
            # Configuration failures abort the run rather than being recorded as
            # a partial result: a rejected key is not a fact about this chunk.
            raise
        except LLMError as exc:
            errors.append(
                AnalysisErrorRecord(
                    scope="document",
                    code=getattr(exc, "code", "LLM_ERROR"),
                    message=getattr(exc, "message", str(exc)),
                )
            )
            return None, None
        except AnalysisValidationError as exc:
            errors.append(
                AnalysisErrorRecord(scope="document", code=exc.code, message=exc.message)
            )
            return None, None

        domain = self._domain_from(payload)
        summary = " ".join(summaries).strip() or None

        if summary:
            # A single-pass run has no section boundaries to report, but leaving
            # `sections` empty would make a successful analysis indistinguishable
            # from one that analysed nothing. One partition covering the whole
            # document is the truthful shape: all of it was read, as one unit.
            analysed.append(
                (
                    _Unit(
                        section_id="synthetic_chunk_document",
                        title=ir.metadata.title or ir.source_filename,
                        page_range=(1, ir.page_count),
                        paragraphs=list(ir.paragraphs),
                        synthetic=True,
                    ),
                    summary,
                )
            )

        return domain, summary

    async def _synthesise(
        self,
        ir: DocumentIR,
        title: str,
        analysed: list[tuple[_Unit, str]],
        accumulated: _Accumulated,
        errors: list[AnalysisErrorRecord],
    ) -> tuple[DomainRecord | None, str | None]:
        """Produce the document-level summary and domain from section summaries."""
        if not analysed:
            errors.append(
                AnalysisErrorRecord(
                    scope="document",
                    code="NO_SECTIONS_ANALYSED",
                    message="no section was analysed successfully, so no document summary exists",
                )
            )
            return None, None

        try:
            payload = await self._request_json(
                lambda: prompts.document_synthesis_messages(
                    section_summaries=[(unit.title, text) for unit, text in analysed],
                    hints=f"title: {title}",
                    target_language=self._target_language,
                ),
                scope="document",
            )
        except CancelledError:
            raise
        except _FATAL:
            raise
        except (LLMError, AnalysisValidationError) as exc:
            errors.append(
                AnalysisErrorRecord(
                    scope="document",
                    code=getattr(exc, "code", "LLM_ERROR"),
                    message=getattr(exc, "message", str(exc)),
                )
            )
            return None, None

        return self._domain_from(payload), str(payload.get("summary", "")).strip() or None

    # -- provider interaction --------------------------------------------

    async def _request_json(
        self, build: Callable[[], list[dict[str, str]]], *, scope: str
    ) -> dict[str, Any]:
        """Send a prompt, parse the reply, and repair it once if need be.

        The retry budget is explicit and per failure kind. Auth and bad-request
        failures are not retried at all: the same key will be rejected the same
        way, and a loop that keeps trying is the defect DS-BE-FIX-002 removed
        from the translation path.
        """
        messages = build()
        input_tokens = sum(
            estimate_tokens(message["content"]) for message in messages
        )
        # The allowance is per-request, not instance state. Growing it for one
        # truncated reply and keeping it would starve every later request in the
        # run, since each chunk is sized against the original figure — which is
        # exactly how a request of 1731 tokens came to be reported as exceeding
        # a 6000 budget.
        allowance = self._output_allowance

        if input_tokens + allowance > self._budget:
            raise AnalysisValidationError(
                "BUDGET_EXCEEDED",
                f"a request needs {input_tokens} input tokens plus {allowance} reserved "
                f"for the answer, which exceeds the {self._budget} token budget",
            )

        # `attempts` counts calls to the provider, not retries, so the table
        # above reads as a total: a rate limit allows three calls, not three
        # retries after an initial one. Auth failures are not in the table at
        # all — `_FATAL` raises before any allowance is consulted.
        attempts = 0
        repair_attempts_left = 1
        #: Truncation is retried with a *larger* allowance, so it gets its own
        #: small counter rather than sharing the transport one — a retry at the
        #: same size would truncate the same way.
        truncation_retries_left = 2

        while True:
            self._check_cancelled()
            attempts += 1
            try:
                text = await self._complete(messages, allowance)
                self._requests += 1
                return self._parse(text)
            except _FATAL:
                # A rejected key is rejected the same way next time. Fail now.
                raise
            except LLMOutputTruncatedError:
                # The model was cut off before it wrote anything — for a
                # reasoning model, because its thinking is billed against the
                # same budget. Retrying identically would truncate identically,
                # so the retry buys more room, taken from what this request has
                # left. When there is none left, retrying cannot help and the
                # unit fails honestly.
                if truncation_retries_left <= 0:
                    raise
                grown = min(allowance * 2, self._budget - input_tokens)
                if grown <= allowance:
                    raise
                truncation_retries_left -= 1
                allowance = grown
            except AnalysisValidationError as exc:
                # Structurally wrong JSON: one repair attempt, with the error fed
                # back to the model, and then done. A model that produced
                # unparseable JSON twice will produce it a third time.
                if repair_attempts_left <= 0:
                    raise
                repair_attempts_left -= 1
                messages = prompts.repair_messages("", exc.message)
            except LLMError as exc:
                allowed = _RETRYABLE.get(type(exc), 0)
                if allowed <= 0 or attempts >= allowed:
                    raise
                await asyncio.sleep(
                    _BACKOFF_SECONDS[min(attempts - 1, len(_BACKOFF_SECONDS) - 1)]
                )

    def _check_cancelled(self) -> None:
        if self._cancel is not None and self._cancel.is_set():
            raise CancelledError()

    def _parse(self, text: str) -> dict[str, Any]:
        """Extract a JSON object from a model reply.

        Models wrap JSON in fences or preface it with a sentence even when told
        not to. Recovering a well-formed object from that is not the same as
        parsing important fields out of prose — the payload still has to be a
        JSON object with the expected shape, and shape errors are still failures.
        """
        if not text or not text.strip():
            raise AnalysisValidationError("LLM_EMPTY_RESPONSE", "the model returned nothing")

        candidate = text.strip()
        fenced = _JSON_FENCE.search(candidate)
        if fenced:
            candidate = fenced.group(1).strip()

        try:
            payload = json.loads(candidate)
        except json.JSONDecodeError:
            start, end = candidate.find("{"), candidate.rfind("}")
            if start == -1 or end <= start:
                raise AnalysisValidationError(
                    "LLM_INVALID_RESPONSE", "the reply contained no JSON object"
                ) from None
            try:
                payload = json.loads(candidate[start : end + 1])
            except json.JSONDecodeError as exc:
                raise AnalysisValidationError(
                    "LLM_INVALID_RESPONSE", f"the reply was not valid JSON: {exc}"
                ) from exc

        if not isinstance(payload, dict):
            raise AnalysisValidationError(
                "LLM_INVALID_RESPONSE", "the reply was not a JSON object"
            )
        return payload

    def _domain_from(self, payload: dict[str, Any]) -> DomainRecord | None:
        raw = payload.get("domain")
        if not isinstance(raw, dict):
            return None
        primary = str(raw.get("primary", "")).strip()
        if not primary:
            return None
        secondary = raw.get("secondary")
        confidence = raw.get("confidence", 0.5)
        try:
            confidence_value = float(confidence)
        except (TypeError, ValueError):
            confidence_value = 0.5
        return DomainRecord(
            primary=primary,
            secondary=[str(item) for item in secondary if str(item).strip()]
            if isinstance(secondary, list)
            else [],
            confidence=min(max(confidence_value, 0.0), 1.0),
            rationale=str(raw.get("rationale", "")).strip(),
        )

    # -- merging ----------------------------------------------------------

    def _merge(self, payload: dict[str, Any], accumulated: _Accumulated) -> None:
        """Fold one unit's findings into the document-wide accumulator.

        Evidence is filtered here rather than afterwards, so an item citing a
        paragraph that does not exist never reaches the persisted analysis — and
        a term that appears in several sections ends up with the union of their
        paragraph ids rather than being duplicated.
        """
        validator = self.validator
        assert validator is not None  # set in analyse() before any request

        terms = payload.get("terms")
        if isinstance(terms, list):
            for item in terms:
                if not isinstance(item, dict):
                    continue
                term = str(item.get("source_term", "")).strip()
                if not term:
                    continue
                ids = validator.filter_ids(_as_id_list(item.get("paragraph_ids")))
                if not ids:
                    # No surviving evidence: the term cannot be traced to the
                    # paper, so it is not recorded. This is the rule that stops a
                    # model's general knowledge entering the glossary.
                    continue
                key = term.casefold()
                existing = accumulated.glossary.get(key)
                if existing is None:
                    accumulated.glossary[key] = GlossaryEntry(
                        source_term=term,
                        suggested_translation=_optional_str(item.get("suggested_translation")),
                        definition=_optional_str(item.get("definition")),
                        is_translatable=bool(item.get("is_translatable", True)),
                        category=_optional_str(item.get("category")),
                        paragraph_ids=ids,
                    )
                else:
                    existing.paragraph_ids = _union(existing.paragraph_ids, ids)
                    if existing.suggested_translation is None:
                        existing.suggested_translation = _optional_str(
                            item.get("suggested_translation")
                        )

        acronyms = payload.get("acronyms")
        if isinstance(acronyms, list):
            for item in acronyms:
                if not isinstance(item, dict):
                    continue
                acronym = str(item.get("acronym", "")).strip()
                if not acronym:
                    continue
                ids = validator.filter_ids(_as_id_list(item.get("paragraph_ids")))
                if not ids:
                    continue
                expansion = _optional_str(item.get("expansion"))
                if expansion is not None and not self._expansion_is_supported(
                    acronym, expansion, ids
                ):
                    # The paper does not pair these two strings. Keeping the
                    # acronym and dropping the expansion is the honest outcome —
                    # the acronym is real, the expansion is the model's memory.
                    expansion = None
                key = acronym.casefold()
                existing = accumulated.acronyms.get(key)
                if existing is None:
                    accumulated.acronyms[key] = AcronymEntry(
                        acronym=acronym, expansion=expansion, paragraph_ids=ids
                    )
                else:
                    existing.paragraph_ids = _union(existing.paragraph_ids, ids)
                    if existing.expansion is None:
                        existing.expansion = expansion

        entities = payload.get("entities")
        if isinstance(entities, list):
            for item in entities:
                if not isinstance(item, dict):
                    continue
                name = str(item.get("name", "")).strip()
                if not name:
                    continue
                ids = validator.filter_ids(_as_id_list(item.get("paragraph_ids")))
                if not ids:
                    continue
                key = name.casefold()
                existing = accumulated.entities.get(key)
                if existing is None:
                    accumulated.entities[key] = EntityEntry(
                        name=name,
                        kind=str(item.get("kind", "other")).strip() or "other",
                        paragraph_ids=ids,
                    )
                else:
                    existing.paragraph_ids = _union(existing.paragraph_ids, ids)

    def _expansion_is_supported(
        self, acronym: str, expansion: str, paragraph_ids: list[str]
    ) -> bool:
        """Whether the paper itself pairs an acronym with its expansion.

        The accepted forms are the ones academic prose actually uses:
        ``Vision-Language-Action (VLA)`` and ``VLA (Vision-Language-Action)``,
        allowing for the spacing and dashes a typesetter may have chosen.
        """
        validator = self.validator
        assert validator is not None

        shape = re.sub(r"[\s\-_]+", "", expansion).casefold()
        acronym_key = acronym.casefold()

        for paragraph_id in paragraph_ids:
            text = validator.text_of(paragraph_id)
            folded = re.sub(r"[\s\-_]+", "", text).casefold()
            if f"{shape}({acronym_key})" in folded or f"{acronym_key}({shape})" in folded:
                return True
        return False

    # -- assembly ---------------------------------------------------------

    def _build(
        self,
        ir: DocumentIR,
        provenance: AnalysisProvenance,
        domain: DomainRecord | None,
        summary: str | None,
        accumulated: _Accumulated,
        errors: list[AnalysisErrorRecord],
        analysed: list[tuple[_Unit, str]],
    ) -> DocumentAnalysis:
        sections = [
            SectionAnalysis(
                section_id=unit.section_id,
                title=unit.title,
                summary=unit_summary,
                page_range=unit.page_range,
                synthetic=unit.synthetic,
            )
            for unit, unit_summary in analysed
        ]

        # Nothing usable came back at all. A single-pass document has no section
        # summaries by design, so the test is whether *anything* survived.
        if not sections and summary is None and domain is None:
            status = AnalysisStatus.FAILED
        elif errors:
            # Something worked and something did not. Saying `READY` would claim
            # the analysis covers the paper when part of it does not.
            status = AnalysisStatus.PARTIAL
        else:
            status = AnalysisStatus.READY

        return DocumentAnalysis(
            document_id=ir.document_id,
            provenance=provenance,
            status=status,
            domain=domain,
            summary=summary,
            sections=sections,
            glossary=list(accumulated.glossary.values()),
            acronyms=list(accumulated.acronyms.values()),
            entities=list(accumulated.entities.values()),
            errors=errors,
        )


# --- helpers ------------------------------------------------------------------


def _as_id_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str)]
    if isinstance(value, str) and value:
        return [value]
    return []


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _union(first: list[str], second: list[str]) -> list[str]:
    """Ordered union — order is preserved so ids read as they occur in the paper."""
    seen = set(first)
    return first + [item for item in second if item not in seen]


def make_provenance(
    ir: DocumentIR,
    *,
    provider_base_url: str,
    provider_model: str,
    provider_protocol: str,
    provider_profile_name: str | None,
    target_language: str,
) -> AnalysisProvenance:
    return AnalysisProvenance(
        document_id=ir.document_id,
        content_hash=ir.content_hash,
        pipeline_version=PIPELINE_VERSION,
        prompt_version=prompts.PROMPT_VERSION,
        provider_base_url=provider_base_url,
        provider_model=provider_model,
        provider_protocol=provider_protocol,
        provider_profile_name=provider_profile_name,
        target_language=target_language,
        created_at=_now(),
    )
