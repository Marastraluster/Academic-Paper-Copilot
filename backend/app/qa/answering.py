"""Turning retrieved evidence into an answer, or into an honest refusal.

The shape of one request:

```
question → scope → DS-QA-001 retrieval → answerability gate → LLM
         → parse → validate → resolve citations → AnswerResult
```

Four properties are load-bearing.

**Abstention is an outcome, not an error.** `insufficient_evidence` is a
successful product result. A provider timeout is not — it is raised as an
`LLMError` and surfaces as a failed request, because reporting "the evidence does
not answer this" when the truth is "the provider timed out" is a lie the user
cannot detect.

**Empty evidence costs nothing.** Zero items, or `NO_MATCH_TOKEN`, or evidence
that is entirely whitespace, returns before any provider call. Asking a model to
look at nothing and report back is a way to spend money and get an answer from
memory.

**Every claim is checked, and the checks are mechanical.** Unknown markers and
uncited claims are detectable exactly. Anchors — numbers, identifiers — are
checked against the cited text. What cannot be checked mechanically is not
pretended to be: see `app.qa.citations`.

**The model is given no page numbers and asked for none.** It names `E2`; the
application resolves that against the `DocumentIR`.
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

from app.context.budget import (
    DEFAULT_CONTEXT_BUDGET,
    DEFAULT_OUTPUT_ALLOWANCE,
    estimate_tokens,
)
from app.context.models import DocumentAnalysis
from app.document.models import DocumentIR
from app.llm.base import LLMProvider
from app.llm.errors import LLMError
from app.llm.models import ChatMessage, LLMRequest
from app.logging import get_logger
from app.qa import prompts
from app.qa.citations import (
    dedupe_in_order,
    extract_markers,
    grounding_problems,
    resolve,
    unknown_markers,
)
from app.qa.models import (
    ANSWERED,
    CODE_MALFORMED_OUTPUT,
    CODE_NO_EVIDENCE,
    CODE_OK,
    CODE_UNGROUNDED_OUTPUT,
    INSUFFICIENT_EVIDENCE,
    PARTIAL,
    AnswerDiagnostics,
    AnswerResult,
    EvidenceBundle,
    EvidenceItem,
    Scope,
)
from app.qa.retrieval import DEFAULT_TOP_K, _is_cjk, retrieve
from app.qa.rewrite import RewriteUnavailable, rewrite_queries, terminology_hint

logger = get_logger(__name__)

#: Room for the model's own answer. Not a guess about verbosity: a reasoning model
#: emits its thinking first and that thinking is billed against this same budget,
#: so a value sized only for the answer produces `finish_reason="length"` with no
#: content at all. Measured on this project's own provider at 950-1500 tokens of
#: thinking on a realistic prompt.
MAX_OUTPUT_TOKENS = DEFAULT_OUTPUT_ALLOWANCE

#: Total attempts for a *retryable* provider error (1 initial + retries). Matches
#: `BoundedOpenAIlikedTranslator`, which is this repository's existing answer to
#: the same question. Class-level so tests can zero the backoff.
RETRYABLE_ATTEMPTS = 3
BACKOFF_SECONDS = (1.0, 2.0)

#: Statuses the model may return.
_STATUSES = (ANSWERED, PARTIAL, INSUFFICIENT_EVIDENCE)


class AnswerError(Exception):
    """The answer could not be produced for a reason that is not the evidence.

    Carries the provider's own code, so the API reports `LLM_RATE_LIMIT` rather
    than flattening every failure into one opaque "QA failed".
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


# --- the deterministic gate ---------------------------------------------------


def no_evidence_result(
    *,
    ir: DocumentIR,
    question: str,
    bundle: EvidenceBundle,
    code: str,
    rationale: str,
    diagnostics: AnswerDiagnostics | None = None,
) -> AnswerResult:
    """Abstain without asking a model anything.

    ``diagnostics`` carries the running counters when the abstention happens
    *after* a provider call — a demotion caused by an ungrounded reply is not the
    same thing as never having asked, and the codes differ. Passing nothing is
    the genuinely free path.
    """
    carried = diagnostics or AnswerDiagnostics()
    carried.code = code
    if not carried.evidence_items:
        carried.evidence_items = len(bundle.items)
    return AnswerResult(
        document_id=ir.document_id,
        question=question,
        status=INSUFFICIENT_EVIDENCE,
        missing_evidence_rationale=rationale,
        diagnostics=carried,
    )


def _is_empty(bundle: EvidenceBundle) -> bool:
    if not bundle.items:
        return True
    if bundle.diagnostics.code == "NO_MATCH_TOKEN":
        return True
    return all(not item.text.strip() for item in bundle.items)


# --- budgeting ----------------------------------------------------------------


def render_items(items: list[EvidenceItem]) -> list[tuple[str, str | None, str]]:
    return [(item.id, item.section_title, item.text) for item in items]


def fit_to_budget(
    *, question: str, items: list[EvidenceItem], language: str | None
) -> tuple[list[EvidenceItem], int]:
    """Trim the evidence until the rendered prompt fits, best-ranked first.

    Measured on the **rendered prompt** with `budget.estimate_tokens`, not on the
    bundle's own `token_estimate` — that one is `len // 4`, which is optimistic
    for English and wrong by roughly six times for Chinese. The budget exists to
    keep a request inside what the provider will accept, so it has to be the
    pessimistic estimate.

    Items arrive in rank order with direct hits first, because that is the order
    retrieval returns them in; stopping at the first that does not fit therefore
    drops neighbours before it drops evidence.
    """
    room = DEFAULT_CONTEXT_BUDGET - MAX_OUTPUT_TOKENS
    system_cost = estimate_tokens(
        prompts.answer_messages(question=question, items=[], language=language)[0]["content"]
    )
    kept: list[EvidenceItem] = []

    for item in items:
        candidate = kept + [item]
        rendered = prompts.answer_messages(
            question=question, items=render_items(candidate), language=language
        )
        cost = system_cost + estimate_tokens(rendered[1]["content"])
        if cost > room:
            break
        kept = candidate

    return kept, len(items) - len(kept)


# --- provider -----------------------------------------------------------------


async def _ask(
    provider: LLMProvider, messages: list[dict[str, str]], diagnostics: AnswerDiagnostics
) -> str:
    """One generation, retrying only what is retryable, within a fixed budget."""
    last: LLMError | None = None

    for attempt in range(1, RETRYABLE_ATTEMPTS + 1):
        diagnostics.requests_made += 1
        try:
            result = await provider.generate(
                LLMRequest(
                    messages=[ChatMessage(role=m["role"], content=m["content"]) for m in messages],
                    max_output_tokens=MAX_OUTPUT_TOKENS,
                )
            )
            diagnostics.prompt_tokens += result.usage.prompt_tokens if result.usage else 0
            diagnostics.completion_tokens += (
                result.usage.completion_tokens if result.usage else 0
            )
            return result.text
        except LLMError as exc:
            last = exc
            if not exc.retryable:
                raise
            if attempt < RETRYABLE_ATTEMPTS:
                await asyncio.sleep(BACKOFF_SECONDS[attempt - 1])

    raise last if last is not None else AnswerError("LLM_ERROR", "No attempt was made.")


# --- parsing ------------------------------------------------------------------


def _strip_fences(text: str) -> str:
    stripped = text.strip()
    if not stripped.startswith("```"):
        return stripped
    body = stripped.split("\n", 1)[1] if "\n" in stripped else ""
    if body.rstrip().endswith("```"):
        body = body.rstrip()[:-3]
    return body.strip()


def parse_reply(text: str) -> tuple[dict | None, str]:
    """Parse the model's reply into ``(payload, problem)``.

    Exactly one of the two is set. The problem text is written to be handed back
    to the model verbatim in the repair call, so it names what was wrong rather
    than saying "invalid JSON".
    """
    if not text or not text.strip():
        return None, "Your reply was empty. Return the JSON object described above."

    candidate = _strip_fences(text)
    payload: object = None
    try:
        payload = json.loads(candidate)
    except json.JSONDecodeError:
        start, end = candidate.find("{"), candidate.rfind("}")
        if start >= 0 and end > start:
            try:
                payload = json.loads(candidate[start : end + 1])
            except json.JSONDecodeError as exc:
                return None, f"Your reply was not valid JSON ({exc.msg})."

    if not isinstance(payload, dict):
        return None, "Your reply was not a JSON object."

    status = payload.get("status")
    if status not in _STATUSES:
        return None, (
            f'"status" was {status!r}. It must be one of {list(_STATUSES)}.'
        )

    answer = payload.get("answer", "")
    if not isinstance(answer, str):
        return None, '"answer" must be a string.'

    aspects = payload.get("unanswered_aspects", [])
    if not isinstance(aspects, list) or not all(isinstance(a, str) for a in aspects):
        return None, '"unanswered_aspects" must be a list of strings.'

    if status == INSUFFICIENT_EVIDENCE:
        return payload, ""

    if not answer.strip():
        return None, f'"answer" was empty while status was "{status}".'

    if not extract_markers(answer):
        return None, (
            f'status was "{status}" but the answer cites no evidence. Every '
            "claim needs an [E1]-style marker for the evidence that supports it."
        )

    if status == PARTIAL and not [a for a in aspects if a.strip()]:
        return None, (
            'status was "partial" but "unanswered_aspects" was empty. Name each '
            "part of the question the evidence could not answer."
        )

    return payload, ""


def _validate(answer: str, items: list[EvidenceItem]) -> str:
    """Every grounding problem with the answer, as one repair-ready message."""
    # The section title counts as part of what the citation vouches for, because
    # the envelope shows it to the model as part of the item. Leaving it out
    # rejects a correct sentence for using the one piece of context we handed it:
    # a paragraph in "4.2. CIFAR-10 and Analysis" whose own text never says
    # "CIFAR-10" produces an answer the validator calls fabricated. Found by
    # running the real benchmark, where it withheld two honest answers in 25.
    texts_by_marker = {
        item.id: [item.text, item.section_title or ""] for item in items
    }
    valid = set(texts_by_marker)
    problems: list[str] = []

    unknown = unknown_markers(answer, valid)
    if unknown:
        problems.append(
            f"The answer cites {unknown}, which are not in the evidence archive. "
            f"The only valid markers are {sorted(valid)}."
        )
    problems.extend(grounding_problems(answer, texts_by_marker))
    return "\n".join(problems)


# --- the pipeline -------------------------------------------------------------


async def generate_answer(
    ir: DocumentIR,
    document_dir: Path,
    *,
    question: str,
    scope: Scope,
    provider: LLMProvider,
    analysis: DocumentAnalysis | None = None,
    top_k: int = DEFAULT_TOP_K,
    language: str | None = None,
) -> AnswerResult:
    """Retrieve, decide whether the evidence can answer, then either answer or refuse.

    Raises :class:`~app.llm.errors.LLMError` subclasses for provider failures —
    including a truncated reply, which is a system failure rather than a verdict
    on the evidence.
    """
    started = time.perf_counter()
    directory = Path(document_dir)

    bundle = retrieve(
        ir, directory, query=question, scope=scope, analysis=analysis, top_k=top_k
    )
    diagnostics = AnswerDiagnostics()

    # --- the cascade: reach for a rewriter only after the local paths failed ---
    #
    # `needs_rewrite` is decided from what came back, not from a score, so an
    # exact model-name lookup answers in about a millisecond and never pays for a
    # provider round trip. A rewrite that fails — no provider, timeout, malformed
    # reply — leaves the local bundle exactly as it was.
    if bundle.diagnostics.suggest_rewrite:
        rewrites, failure = await _rewrites_for(provider, question, ir, analysis)
        if rewrites:
            bundle = retrieve(
                ir, directory, query=question, scope=scope, analysis=analysis,
                top_k=top_k, rewrites=rewrites,
            )
            diagnostics.rewrite_outcome = f"used:{len(rewrites)}"
        else:
            diagnostics.rewrite_outcome = f"unavailable:{failure}" if failure else "unavailable"
    else:
        diagnostics.rewrite_outcome = "not_needed"

    def finish(result: AnswerResult) -> AnswerResult:
        result.diagnostics.execution_time_ms = round(
            (time.perf_counter() - started) * 1000, 2
        )
        logger.info(
            "paper qa",
            extra={
                "document_id": ir.document_id,
                "scope": scope.describe(),
                "status": result.status,
                "code": result.diagnostics.code,
                "evidence": result.diagnostics.evidence_items,
                "citations": len(result.citations),
                "requests": result.diagnostics.requests_made,
                "repair": result.diagnostics.repair_attempted,
                "latency_ms": result.diagnostics.execution_time_ms,
            },
        )
        return result

    async def abstain(
        code: str, rationale: str, carried: AnswerDiagnostics | None = None
    ) -> AnswerResult:
        """Return an abstention, and note whether a wider scope would have found any.

        Asked even on the free path: a question asked of page 3 that the whole
        paper answers is the case where the hint earns its keep, and the extra
        retrieval is local — no provider is called either way.
        """
        result = no_evidence_result(
            ir=ir, question=question, bundle=bundle,
            code=code, rationale=rationale, diagnostics=carried,
        )
        result.diagnostics.suggest_scope_expansion = await _scope_hint(
            ir, directory, question, scope, analysis
        )
        return finish(result)

    # --- the gate, before any money is spent --------------------------------
    #
    # `carried=diagnostics` matters: this path runs *after* a rewrite may have
    # been attempted, and a fresh diagnostics object would report
    # `rewrite_outcome="not_needed"` for a question that did try. That is how a
    # silently-dead stage looks from the outside.
    if _is_empty(bundle):
        rationale = (
            "No text in this document matched the question."
            if bundle.diagnostics.code == "NO_MATCH_TOKEN"
            else "No evidence was retrieved for this question."
        )
        return await abstain(CODE_NO_EVIDENCE, rationale, carried=diagnostics)

    kept, dropped = fit_to_budget(
        question=question, items=bundle.items, language=language
    )
    if not kept:
        return await abstain(
            CODE_NO_EVIDENCE, "The retrieved evidence does not fit in one request.",
            carried=diagnostics,
        )

    diagnostics.evidence_items = len(kept)
    diagnostics.evidence_dropped = dropped
    rendered = render_items(kept)
    messages = prompts.answer_messages(
        question=question, items=rendered, language=language
    )

    # --- one answer, and at most one repair ---------------------------------
    text = await _ask(provider, messages, diagnostics)
    payload, problem = parse_reply(text)

    if not problem:
        grounding = _validate(payload["answer"], kept)
        if grounding:
            problem = grounding
            payload = None

    if problem:
        diagnostics.repair_attempted = True
        diagnostics.dropped_citations = (
            unknown_markers(payload.get("answer", ""), {i.id for i in kept})
            if payload else []
        )
        repaired_text = await _ask(
            provider,
            prompts.repair_messages(
                question=question, items=rendered, previous=text,
                problem=problem, language=language,
            ),
            diagnostics,
        )
        repaired, repair_problem = parse_reply(repaired_text)
        if not repair_problem:
            still_bad = _validate(repaired["answer"], kept)
            if not still_bad:
                payload, problem = repaired, ""
            else:
                problem = still_bad

        if problem:
            # The bounded repair did not fix it. The answer is not trustworthy, so
            # it is not shown — an ungrounded answer with a real-looking citation
            # is precisely the failure this whole layer exists to prevent.
            code = (
                CODE_MALFORMED_OUTPUT
                if not payload and "JSON" in problem
                else CODE_UNGROUNDED_OUTPUT
            )
            return await abstain(
                code,
                "The generated answer could not be verified against the retrieved "
                "evidence, so it was withheld.",
                carried=diagnostics,
            )

    status = payload["status"]
    answer = payload.get("answer", "")
    citations = resolve(
        dedupe_in_order(extract_markers(answer)) if answer else [], kept, ir
    )

    result = AnswerResult(
        document_id=ir.document_id,
        question=question,
        status=status,
        answer=answer,
        citations=citations,
        unanswered_aspects=[
            aspect for aspect in payload.get("unanswered_aspects", []) if aspect.strip()
        ],
        missing_evidence_rationale=payload.get("missing_evidence_rationale") or None,
        diagnostics=diagnostics,
    )
    if status == INSUFFICIENT_EVIDENCE:
        result.diagnostics.suggest_scope_expansion = await _scope_hint(
            ir, directory, question, scope, analysis
        )
    return finish(result)


def _paper_language(ir: DocumentIR) -> str:
    """A name for the script the paper is written in.

    Not language detection — a count of one script against another over the first
    few paragraphs. It exists so the rewriter is told which language its phrases
    must be in, and its failure mode is a vaguer instruction rather than a wrong
    one.
    """
    sample = " ".join(paragraph.text for paragraph in ir.paragraphs[:12])
    cjk = sum(1 for character in sample if _is_cjk(character))
    if not sample.strip():
        return "English"
    return "Chinese" if cjk > len(sample) * 0.2 else "English"


async def _rewrites_for(
    provider: LLMProvider, question: str, ir: DocumentIR, analysis: DocumentAnalysis | None
) -> tuple[list[str], str | None]:
    """Ask for lexical queries, and never let a failure reach the caller.

    A rewrite is an enhancement to retrieval, so its failure must not become a
    failure of the question: the local bundle is still there and is still what
    answers.
    """
    try:
        rewrites = await rewrite_queries(
            question,
            provider=provider,
            paper_language=_paper_language(ir),
            terminology=terminology_hint(analysis),
        )
    except RewriteUnavailable as exc:
        logger.info("rewrite unavailable", extra={"document_id": ir.document_id, "reason": str(exc)})
        return [], str(exc)
    return rewrites, None


async def _scope_hint(
    ir: DocumentIR,
    directory: Path,
    question: str,
    scope: Scope,
    analysis: DocumentAnalysis | None,
) -> bool:
    """Whether the whole paper holds evidence the chosen scope excluded.

    Only asked when the answer was an abstention under a narrow scope. The
    retrieval is local and costs about a millisecond; the alternative is a user
    concluding the paper does not answer their question when the scope they
    picked is the only thing that did not.
    """
    if scope.type not in ("page", "section"):
        return False
    try:
        wider = await asyncio.to_thread(
            retrieve, ir, directory,
            query=question, scope=Scope(type="whole_paper"),
            analysis=analysis, top_k=3,
        )
    except Exception:  # noqa: BLE001 - a hint is never worth failing a request for
        return False
    return bool(wider.items)
