"""Deciding whether to analyse at all, and doing it through the real provider.

Two jobs:

* **Decide.** If a stored analysis was produced from this source, by this
  pipeline, from this prompt, against this provider and model, for this target
  language — reuse it. Otherwise generate. The comparison lives in
  `persistence.is_cache_valid` so the rule has exactly one statement.
* **Adapt.** Turn the existing LLM layer into the plain function the pipeline
  takes. The pipeline knows nothing about providers, protocols, credentials or
  SDKs; this module is the only place that does.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path

from app.context import prompts
from app.context.models import PIPELINE_VERSION, AnalysisStatus, DocumentAnalysis
from app.context.persistence import is_cache_valid, read_analysis, write_analysis
from app.context.pipeline import AnalysisPipeline, CancelledError, make_provenance
from app.document.models import DocumentIR
from app.llm import LLMProvider
from app.llm.detection import resolve_provider
from app.llm.models import ChatMessage, LLMRequest, ProviderConfig
from app.logging import get_logger

logger = get_logger(__name__)


@dataclass(frozen=True)
class ProviderIdentity:
    """Which endpoint and model produced an analysis.

    Identity is the endpoint and the model — not the profile's display name,
    which the user may rename at any time, and not the credential, which decides
    who may answer rather than what the answer means.
    """

    base_url: str
    model: str
    protocol: str
    profile_name: str | None = None


class AnalysisUnavailableError(Exception):
    """The provider could not be resolved or the credential store was unusable."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def build_completion(provider: LLMProvider, *, timeout_s: float | None = None):
    """Adapt an ``LLMProvider`` to the pipeline's plain function.

    The pipeline gets text and nothing else: no SDK object, no HTTP status, no
    header. Every failure arrives as an `LLMError` from the existing hierarchy,
    which is what lets the pipeline's retry rules be written against a small
    closed set of types rather than against whatever an SDK raises today.
    """

    async def complete(messages: list[dict[str, str]], max_output_tokens: int) -> str:
        request = LLMRequest(
            messages=[ChatMessage(role=m["role"], content=m["content"]) for m in messages],
            max_output_tokens=max_output_tokens,
            timeout_s=timeout_s,
        )
        result = await provider.generate(request)
        return result.text

    return complete


async def get_or_create_analysis(
    document_dir: Path,
    ir: DocumentIR,
    *,
    provider: LLMProvider,
    identity: ProviderIdentity,
    target_language: str = "zh-CN",
    force: bool = False,
    cancellation_event: asyncio.Event | None = None,
) -> tuple[DocumentAnalysis, bool]:
    """Return the analysis for a document, generating it only if needed.

    Returns ``(analysis, reused)``. Blocking work is CPU-light but network-bound,
    so this is async throughout.
    """
    pipeline_version = PIPELINE_VERSION
    prompt_version = prompts.PROMPT_VERSION

    if not force:
        cached = read_analysis(document_dir)
        if is_cache_valid(
            cached,
            content_hash=ir.content_hash,
            pipeline_version=pipeline_version,
            prompt_version=prompt_version,
            provider_base_url=identity.base_url,
            provider_model=identity.model,
            target_language=target_language,
        ):
            logger.info(
                "analysis cache hit",
                extra={"document_id": ir.document_id, "model": identity.model},
            )
            return cached, True  # type: ignore[return-value]

    provenance = make_provenance(
        ir,
        provider_base_url=identity.base_url,
        provider_model=identity.model,
        provider_protocol=identity.protocol,
        provider_profile_name=identity.profile_name,
        target_language=target_language,
    )
    pipeline = AnalysisPipeline(
        build_completion(provider),
        target_language=target_language,
        cancellation_event=cancellation_event,
    )

    try:
        analysis = await pipeline.analyse(ir, provenance)
    except CancelledError:
        # **Nothing is written.** A cancelled run produced a fraction of an
        # analysis, and a file on disk is indistinguishable from a finished one
        # to anything that reads it later. The status is reported to the caller
        # and nowhere else.
        logger.info("analysis cancelled", extra={"document_id": ir.document_id})
        return (
            DocumentAnalysis(
                document_id=ir.document_id,
                provenance=provenance,
                status=AnalysisStatus.CANCELLED,
            ),
            False,
        )

    write_analysis(document_dir, analysis)
    logger.info(
        "analysis generated",
        extra={
            "document_id": ir.document_id,
            "status": analysis.status.value,
            "sections": len(analysis.sections),
            "glossary": len(analysis.glossary),
            "requests": pipeline.requests_made,
        },
    )
    return analysis, False


async def resolve_provider_for(
    config: ProviderConfig, protocol: str
) -> LLMProvider:
    """Resolve a provider, mapping resolution failures onto a code the API reports."""
    try:
        return await resolve_provider(config, protocol)
    except Exception as exc:  # noqa: BLE001 - any resolution failure is the same to a caller
        from app.llm.errors import sanitize_message

        raise AnalysisUnavailableError(
            "PROVIDER_UNAVAILABLE",
            sanitize_message(f"Could not reach the configured provider: {exc}"),
        ) from exc
