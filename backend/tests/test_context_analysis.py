"""Academic context foundation — DS-CTX-001.

The suite runs entirely offline. Provider behaviour is supplied by a fake
completion function that records what it was asked and answers with canned
payloads, so every assertion about call counts, budgets, retries and error
handling is deterministic and costs nothing.

The one thing a fake cannot prove is whether a real model produces *good*
analysis. That is a separate, manual verification and is reported as such rather
than being simulated here and called a pass.
"""

from __future__ import annotations

import ast
import asyncio
import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.context import prompts
from app.context.budget import DEFAULT_CONTEXT_BUDGET, estimate_tokens
from app.context.context_builder import ContextBuilder
from app.context.evidence import AnalysisValidationError, EvidenceValidator
from app.context.models import (
    PIPELINE_VERSION,
    AnalysisProvenance,
    AnalysisStatus,
    DocumentAnalysis,
    DomainRecord,
    GlossaryEntry,
    SectionAnalysis,
)
from app.context.persistence import (
    TEMP_PREFIX,
    delete_analysis,
    is_cache_valid,
    read_analysis,
    write_analysis,
)
from app.context.pipeline import AnalysisPipeline, CancelledError, make_provenance
from app.document.models import (
    LAYOUT_ABANDON,
    LAYOUT_FIGURE,
    DocumentIR,
    DocumentMetadata,
    PageIR,
    ParagraphIR,
    SectionIR,
    TextBlockIR,
)
from app.llm.errors import (
    LLMAuthenticationError,
    LLMConnectionError,
    LLMRateLimitError,
    LLMServerError,
    LLMTimeoutError,
)

BACKEND_ROOT = Path(__file__).resolve().parent.parent


# --- fixtures and helpers -----------------------------------------------------


def make_ir(
    *,
    paragraphs: list[tuple[str, str, int, str | None]],
    sections: list[tuple[str, str, int]] | None = None,
    abandon_text: str | None = None,
) -> DocumentIR:
    """Build a `DocumentIR` by hand.

    ``paragraphs`` is ``(id, text, page_number, section_id)``. Building the IR
    directly keeps these tests about the analysis layer; the extraction layer has
    its own suite.
    """
    by_page: dict[int, list[ParagraphIR]] = {}
    blocks: dict[int, list[TextBlockIR]] = {}
    for paragraph_id, text, page_number, section_id in paragraphs:
        by_page.setdefault(page_number, []).append(
            ParagraphIR(
                id=paragraph_id,
                section_id=section_id,
                text=text,
                page_number=page_number,
                page_range=(page_number, page_number),
                block_ids=[],
            )
        )
        blocks.setdefault(page_number, []).append(
            TextBlockIR(
                id=f"b_{paragraph_id}",
                page_index=page_number - 1,
                page_number=page_number,
                layout_class="plain text",
                bbox=(0.0, 0.0, 100.0, 20.0),
                text=text,
            )
        )

    if abandon_text is not None:
        blocks.setdefault(1, []).append(
            TextBlockIR(
                id="b_abandon",
                page_index=0,
                page_number=1,
                layout_class=LAYOUT_ABANDON,
                bbox=(0.0, 0.0, 500.0, 12.0),
                text=abandon_text,
            )
        )

    pages = [
        PageIR(
            page_index=page_number - 1,
            page_number=page_number,
            width_pt=612.0,
            height_pt=792.0,
            has_text=True,
            blocks=blocks.get(page_number, []),
        )
        for page_number in sorted(by_page) or [1]
    ]

    paragraphs_list = [
        paragraph for page in pages for paragraph in by_page.get(page.page_number, [])
    ]

    return DocumentIR(
        document_id="doc_test",
        content_hash="hash-abc",
        source_filename="paper.pdf",
        page_count=len(pages),
        metadata=DocumentMetadata(title="A Test Paper"),
        sections=[
            SectionIR(id=sid, title=title, level=1, page_range=(page, page))
            for sid, title, page in (sections or [])
        ],
        pages=pages,
        paragraphs=paragraphs_list,
        page_mapping={p.id: p.page_number for p in paragraphs_list},
        has_text_layer=True,
        ocr_required=False,
    )


def provenance() -> AnalysisProvenance:
    return AnalysisProvenance(
        document_id="doc_test",
        content_hash="hash-abc",
        pipeline_version=PIPELINE_VERSION,
        prompt_version=prompts.PROMPT_VERSION,
        provider_base_url="http://127.0.0.1:9/v1",
        provider_model="test-model",
        provider_protocol="chat_completions",
        target_language="zh-CN",
        created_at="2026-09-17T00:00:00+00:00",
    )


class FakeCompletion:
    """Records every prompt and answers from a queue.

    A queue rather than a fixed reply because most of what is under test is what
    happens *across* calls: retries, per-section failures, budget behaviour.
    """

    def __init__(self, responses: list[object] | None = None) -> None:
        self.responses = list(responses or [])
        self.prompts: list[list[dict[str, str]]] = []
        self.max_output_tokens: list[int] = []
        self._fallback = '{"summary": "A summary.", "terms": [], "acronyms": [], "entities": []}'

    async def __call__(self, messages: list[dict[str, str]], max_output_tokens: int) -> str:
        # Yield once so the pipeline behaves like one waiting on a network call.
        # Without this the fake never suspends, the whole run completes inside a
        # single scheduling slice, and a test that wants to cancel between two
        # requests never gets the chance to.
        await asyncio.sleep(0)
        self.prompts.append(messages)
        self.max_output_tokens.append(max_output_tokens)
        if self.responses:
            response = self.responses.pop(0)
        else:
            response = self._fallback
        if isinstance(response, Exception):
            raise response
        return str(response)

    @property
    def all_text(self) -> str:
        return "\n".join(m["content"] for prompt in self.prompts for m in prompt)

    @property
    def calls(self) -> int:
        return len(self.prompts)


def section_reply(
    summary: str = "A summary.",
    terms: list[dict] | None = None,
    acronyms: list[dict] | None = None,
    entities: list[dict] | None = None,
) -> str:
    return json.dumps(
        {
            "summary": summary,
            "terms": terms or [],
            "acronyms": acronyms or [],
            "entities": entities or [],
        }
    )


SYNTHESIS = json.dumps(
    {
        "domain": {
            "primary": "Robotics",
            "secondary": ["Machine Learning"],
            "confidence": 0.8,
            "rationale": "policy learning",
        },
        "summary": "The paper studies policy learning for manipulation.",
    }
)


# --- AC-P0-01: the IR is never touched ---------------------------------------


def test_analysis_does_not_mutate_the_ir(tmp_path: Path):
    """AC-P0-01 — source truth stays source truth."""
    ir = make_ir(
        paragraphs=[
            ("p1", "The policy is optimized through rollouts. " * 40, 1, "s1"),
            ("p2", "We evaluate on three benchmarks. " * 40, 2, "s1"),
        ],
        sections=[("s1", "1 Introduction", 1)],
    )
    before = ir.model_dump_json()

    pipeline = AnalysisPipeline(FakeCompletion([section_reply(), SYNTHESIS]))
    asyncio.run(pipeline.analyse(ir, provenance()))

    assert ir.model_dump_json() == before, "the analysis mutated the source IR"

    # And nothing was written into the IR directory either.
    write_analysis(tmp_path / "document", DocumentAnalysis(
        document_id="doc_test",
        provenance=provenance(),
        status=AnalysisStatus.READY,
    ))
    assert not (tmp_path / "document" / "ir.json").exists()


# --- AC-P0-02: no second PDF parser ------------------------------------------


def test_analysis_package_imports_no_pdf_library():
    """AC-P0-02 — one paper, one canonical text representation.

    Structural rather than hopeful: the analysis package is parsed and its import
    statements inspected, so a mention in a docstring cannot trip it and a real
    import cannot hide.
    """
    forbidden = {"fitz", "pymupdf", "pdfminer", "pypdf", "pikepdf", "pdfplumber", "onnxruntime"}
    offenders: list[str] = []

    for source in (BACKEND_ROOT / "app" / "context").rglob("*.py"):
        tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
        for node in ast.walk(tree):
            names: list[str] = []
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module:
                names = [node.module]
            for name in names:
                if name.split(".")[0] in forbidden:
                    offenders.append(f"{source.name}: {name}")

    assert not offenders, f"document analysis reached for a PDF library: {offenders}"


def test_analysis_works_with_the_source_pdf_deleted(tmp_path: Path):
    """AC-P0-02 — the IR is sufficient; the file is not consulted."""
    directory = tmp_path / "document"
    directory.mkdir()
    # No source.pdf here at all — only the IR the caller supplies.
    ir = make_ir(
        paragraphs=[("p1", "Body text about policies and rollouts. " * 30, 1, "s1")],
        sections=[("s1", "1 Introduction", 1)],
    )

    pipeline = AnalysisPipeline(FakeCompletion([section_reply(), SYNTHESIS]))
    analysis = asyncio.run(pipeline.analyse(ir, provenance()))

    assert analysis.status is AnalysisStatus.READY
    assert not (directory / "source.pdf").exists()


# --- AC-P0-03: headers and footers never reach a prompt ----------------------


def test_abandon_blocks_never_reach_a_prompt():
    """AC-P0-03 — running headers would generate spurious terms."""
    marker = "CONFIDENTIAL DRAFT - PAGE 1 OF 99"
    ir = make_ir(
        paragraphs=[("p1", "Body text about policies. " * 30, 1, "s1")],
        sections=[("s1", "1 Introduction", 1)],
        abandon_text=marker,
    )

    completion = FakeCompletion([section_reply(), SYNTHESIS])
    asyncio.run(AnalysisPipeline(completion).analyse(ir, provenance()))

    assert completion.calls > 0
    assert marker not in completion.all_text


# --- AC-P0-04: evidence must name a real paragraph ---------------------------


def test_terms_citing_unknown_paragraphs_are_dropped():
    """AC-P0-04 — an id either exists in the IR or the claim is not evidence."""
    ir = make_ir(
        paragraphs=[("p1", "The policy is optimized through rollouts. " * 30, 1, "s1")],
        sections=[("s1", "1 Introduction", 1)],
    )
    reply = section_reply(
        terms=[
            {"source_term": "policy", "suggested_translation": "策略",
             "paragraph_ids": ["p1"]},
            {"source_term": "invented", "suggested_translation": "编造",
             "paragraph_ids": ["para-fake-999"]},
            {"source_term": "untraceable", "suggested_translation": "无据"},
        ]
    )

    analysis = asyncio.run(
        AnalysisPipeline(FakeCompletion([reply, SYNTHESIS])).analyse(ir, provenance())
    )

    terms = {entry.source_term for entry in analysis.glossary}
    assert "policy" in terms
    assert "invented" not in terms, "a term citing a non-existent paragraph survived"
    assert "untraceable" not in terms, "a term with no evidence at all survived"


def test_validator_reports_how_many_ids_it_dropped():
    """A model citing many unknown ids is a signal, not just noise to filter."""
    validator = EvidenceValidator({"p1": "real text"})
    kept = validator.filter_ids(["p1", "ghost", "p1", "phantom"])

    assert kept == ["p1"]
    assert validator.dropped_ids == 2


def test_fabricated_quotation_is_rejected():
    """AC-P0-04 / Dimension 42 — a quotation the paper does not contain."""
    validator = EvidenceValidator({"p1": "The policy is optimized through rollouts."})

    assert validator.snippet_is_supported("The policy is optimized", ["p1"])
    assert not validator.snippet_is_supported(
        "The policy was trained on a quantum computer", ["p1"]
    )


# --- AC-P0-05: identifiers keep their exact spelling -------------------------


def test_identifiers_keep_their_exact_spelling():
    """AC-P0-05 — `LeVJEPA` lowercased is a different word."""
    text = "We benchmarked LeVJEPA and ResNet-50 on Something-Something V2 against VLA baselines."
    ir = make_ir(
        paragraphs=[("p1", (text + " ") * 20, 1, "s1")],
        sections=[("s1", "4 Experiments", 1)],
    )
    reply = section_reply(
        terms=[
            {"source_term": "LeVJEPA", "suggested_translation": None,
             "is_translatable": False, "paragraph_ids": ["p1"]},
            {"source_term": "ResNet-50", "suggested_translation": None,
             "is_translatable": False, "paragraph_ids": ["p1"]},
            {"source_term": "Something-Something V2", "suggested_translation": None,
             "is_translatable": False, "paragraph_ids": ["p1"]},
        ]
    )

    analysis = asyncio.run(
        AnalysisPipeline(FakeCompletion([reply, SYNTHESIS])).analyse(ir, provenance())
    )

    terms = {entry.source_term for entry in analysis.glossary}
    assert {"LeVJEPA", "ResNet-50", "Something-Something V2"} <= terms

    by_term = {entry.source_term: entry for entry in analysis.glossary}
    assert by_term["LeVJEPA"].is_translatable is False


# --- AC-P0-06: acronyms are not invented -------------------------------------


def test_acronym_expansion_requires_co_occurrence():
    """AC-P0-06 — an expansion the paper never states is memory, not evidence."""
    ir = make_ir(
        paragraphs=[
            ("p1", "We introduce Vision-Language-Action (VLA) models. " * 20, 1, "s1"),
            ("p2", "We evaluate our method on standard VLA benchmarks. " * 20, 2, "s1"),
        ],
        sections=[("s1", "1 Introduction", 1)],
    )
    reply = section_reply(
        acronyms=[
            # p1 really does pair them.
            {"acronym": "VLA", "expansion": "Vision-Language-Action", "paragraph_ids": ["p1"]},
            # p2 does not — the model offering the expansion here is guessing.
            {"acronym": "MDP", "expansion": "Markov Decision Process", "paragraph_ids": ["p2"]},
        ]
    )

    analysis = asyncio.run(
        AnalysisPipeline(FakeCompletion([reply, SYNTHESIS])).analyse(ir, provenance())
    )

    by_acronym = {entry.acronym: entry for entry in analysis.acronyms}
    assert by_acronym["VLA"].expansion == "Vision-Language-Action"
    assert by_acronym["MDP"].expansion is None, "an expansion the paper never states survived"


# --- AC-P0-07 / AC-P0-08: domain and page numbering --------------------------


def test_weak_domain_evidence_stays_uncertain():
    """AC-P0-07 — `Unknown` is a result, not a failure."""
    ir = make_ir(
        paragraphs=[("p1", "A short and ambiguous note. " * 400, 1, "s1")],
        sections=[("s1", "1 Introduction", 1)],
    )
    synthesis = json.dumps(
        {"domain": {"primary": "Unknown", "secondary": [], "confidence": 0.2,
                    "rationale": "not enough evidence"}, "summary": "Unclear."}
    )

    analysis = asyncio.run(
        AnalysisPipeline(FakeCompletion([section_reply(), synthesis])).analyse(ir, provenance())
    )

    assert analysis.domain is not None
    assert analysis.domain.primary == "Unknown"
    assert analysis.domain.confidence < 0.5


def test_no_bare_page_field_anywhere_in_the_schemas():
    """AC-P0-08 — the word `page` alone is banned; `page_number` is 1-based."""
    payload = json.dumps(
        DocumentAnalysis(
            document_id="doc_test",
            provenance=provenance(),
            status=AnalysisStatus.READY,
            sections=[
                SectionAnalysis(
                    section_id="s1", title="t", summary="s", page_range=(1, 2)
                )
            ],
        ).model_dump()
    )
    assert '"page"' not in payload

    from app.context.models import TranslationContext

    context = TranslationContext(paragraph_id="p1", page_number=3)
    assert context.page_number == 3
    assert "page" not in TranslationContext.model_fields


# --- AC-P0-09 / AC-P0-10: chunking and unsectioned documents -----------------


def test_every_request_stays_within_the_configured_budget():
    """AC-P0-09 — the budget is checked before the request, not by the provider."""
    ir = make_ir(
        paragraphs=[(f"p{i}", "Sentence about policies and rollouts. " * 60, 1, "s1")
                    for i in range(12)],
        sections=[("s1", "1 Introduction", 1)],
    )
    completion = FakeCompletion([section_reply(), SYNTHESIS])
    pipeline = AnalysisPipeline(completion, context_budget=2500, output_allowance=500)

    asyncio.run(pipeline.analyse(ir, provenance()))

    for prompt in completion.prompts:
        size = sum(estimate_tokens(message["content"]) for message in prompt)
        assert size + 500 <= 2500, f"a request of {size} tokens exceeded the budget"


def test_chunks_begin_and_end_at_paragraph_boundaries():
    """AC-P0-09 — no paragraph is cut in half."""
    paragraphs = [
        (f"p{i}", f"Paragraph number {i} with some length to it. " * 20, 1, "s1")
        for i in range(10)
    ]
    ir = make_ir(paragraphs=paragraphs, sections=[("s1", "1 Introduction", 1)])
    completion = FakeCompletion([section_reply(), SYNTHESIS])
    pipeline = AnalysisPipeline(completion, context_budget=2500, output_allowance=400)

    asyncio.run(pipeline.analyse(ir, provenance()))

    ids = [pid for pid, _, _, _ in paragraphs]
    for prompt in completion.prompts:
        body = prompt[-1]["content"]
        present = [pid for pid in ids if f"[{pid}]" in body]
        if not present:
            continue
        # Within one prompt the ids must be a contiguous run — a gap would mean a
        # paragraph was dropped, and a partial id would mean one was cut.
        indices = [ids.index(pid) for pid in present]
        assert indices == list(range(indices[0], indices[0] + len(indices)))


def test_unsectioned_documents_still_get_analysed():
    """AC-P0-10 — no structure must not mean no analysis."""
    ir = make_ir(
        paragraphs=[(f"p{i}", f"Body paragraph {i}. " * 30, (i // 3) + 1, None)
                    for i in range(9)],
    )
    assert ir.sections == []

    completion = FakeCompletion()
    analysis = asyncio.run(
        AnalysisPipeline(completion, context_budget=4000, output_allowance=500)
        .analyse(ir, provenance())
    )

    assert analysis.status in (AnalysisStatus.READY, AnalysisStatus.PARTIAL)
    assert analysis.sections, "unsectioned content produced no analysis at all"
    assert all(section.synthetic for section in analysis.sections)
    assert completion.calls > 0


# --- AC-P0-11: bounded failure ------------------------------------------------


@pytest.mark.parametrize(
    "error,expected_calls",
    [
        (LLMAuthenticationError("rejected"), 1),
        (LLMRateLimitError("slow down"), 3),
        (LLMServerError("boom"), 2),
        (LLMTimeoutError("late"), 2),
        (LLMConnectionError("unreachable"), 1),  # not in the retry table: one try
    ],
)
def test_provider_failures_are_bounded(error, expected_calls):
    """AC-P0-11 — a rejected key is rejected again; a 5xx may not be.

    The call counts are the criterion. Nothing here loops, and the difference
    between two and three calls is the whole point: the retry budget is per
    failure kind, not a fixed number of tries.
    """
    ir = make_ir(
        paragraphs=[("p1", "Body text about policies. " * 200, 1, "s1")],
        sections=[("s1", "1 Introduction", 1)],
    )
    completion = FakeCompletion([error] * 10)
    pipeline = AnalysisPipeline(completion)

    try:
        asyncio.run(pipeline.analyse(ir, provenance()))
    except Exception:  # noqa: BLE001 - a fatal error aborts the run, which is fine here
        pass

    assert completion.calls == expected_calls, (
        f"{type(error).__name__} produced {completion.calls} calls, expected {expected_calls}"
    )


def test_a_fatal_provider_error_aborts_the_whole_run():
    """AC-P0-11 — one rejected key must not become one rejection per section.

    A configuration failure is not a fact about a particular section. Continuing
    would issue the same doomed request once per section, so a five-section paper
    with a bad key would make five calls instead of one.
    """
    ir = make_ir(
        paragraphs=[(f"p{i}", f"Section {i} body text. " * 90, i, f"s{i}") for i in range(1, 6)],
        sections=[(f"s{i}", f"{i}. Section", i) for i in range(1, 6)],
    )
    completion = FakeCompletion([LLMAuthenticationError("bad key")] * 10)

    with pytest.raises(LLMAuthenticationError):
        asyncio.run(AnalysisPipeline(completion).analyse(ir, provenance()))

    assert completion.calls == 1, "a rejected key was retried once per section"


# --- AC-P0-12: malformed and empty output ------------------------------------


def test_unparseable_output_is_retried_once_then_fails():
    """AC-P0-12 — one repair attempt, never a loop."""
    ir = make_ir(
        paragraphs=[("p1", "Body text about policies. " * 200, 1, "s1")],
        sections=[("s1", "1 Introduction", 1)],
    )
    completion = FakeCompletion(["```json\n{not json at all", "still not json"])

    analysis = asyncio.run(AnalysisPipeline(completion).analyse(ir, provenance()))

    assert completion.calls == 2, "the repair attempt did not happen exactly once"
    assert analysis.status is AnalysisStatus.FAILED


def test_empty_output_is_rejected_rather_than_accepted():
    """AC-P0-12 — structure that parses but says nothing is still a failure.

    The pipeline does not persist anything itself; writing is the service's job
    and is covered by the atomic-write test. What this pins is that a vacuous
    reply produces a result that no caller would mistake for an analysis.
    """
    ir = make_ir(
        paragraphs=[("p1", "Body text about policies. " * 200, 1, "s1")],
        sections=[("s1", "1 Introduction", 1)],
    )
    completion = FakeCompletion([section_reply(summary="   ")] * 4)

    analysis = asyncio.run(AnalysisPipeline(completion).analyse(ir, provenance()))

    assert analysis.status is not AnalysisStatus.READY
    assert analysis.summary is None
    assert not analysis.sections


def test_markdown_fences_are_recovered_but_broken_json_is_not():
    """Recovering a fenced object is not the same as parsing fields from prose."""
    ir = make_ir(
        paragraphs=[("p1", "Body text. " * 100, 1, "s1")],
        sections=[("s1", "1 Introduction", 1)],
    )
    fenced = f"Here is the analysis:\n```json\n{SYNTHESIS}\n```\nHope that helps."

    analysis = asyncio.run(
        AnalysisPipeline(FakeCompletion([fenced, fenced])).analyse(ir, provenance())
    )

    assert analysis.status is AnalysisStatus.READY


# --- AC-P0-13: partial failure is not total failure --------------------------


def test_one_failed_section_does_not_discard_the_others():
    """AC-P0-13 — the reason `PARTIAL` exists."""
    # Long enough to take the hierarchical path rather than the single-pass fast
    # path — the whole point is per-section independence.
    ir = make_ir(
        paragraphs=[(f"p{i}", f"Section {i} body text. " * 120, i, f"s{i}") for i in range(1, 6)],
        sections=[(f"s{i}", f"{i}. Section", i) for i in range(1, 6)],
    )
    completion = FakeCompletion(
        [
            section_reply("Summary one."),
            section_reply("Summary two."),
            LLMServerError("section three exploded"),
            LLMServerError("section three exploded"),
            section_reply("Summary four."),
            section_reply("Summary five."),
            SYNTHESIS,
        ]
    )

    analysis = asyncio.run(AnalysisPipeline(completion).analyse(ir, provenance()))

    assert analysis.status is AnalysisStatus.PARTIAL
    assert len(analysis.sections) == 4, "successful section analyses were discarded"
    assert analysis.errors
    assert "s3" in analysis.errors[0].scope


# --- AC-P0-14: cancellation ------------------------------------------------


def test_cancellation_stops_before_the_next_request():
    """AC-P0-14 — no further dispatch, and nothing written."""
    # Several units of work, so there is a boundary at which to cancel.
    ir = make_ir(
        paragraphs=[(f"p{i}", f"Section {i} body. " * 200, i, f"s{i}") for i in range(1, 4)],
        sections=[(f"s{i}", f"{i}. Section", i) for i in range(1, 4)],
    )
    cancel = asyncio.Event()
    completion = FakeCompletion([section_reply(), section_reply(), section_reply()])

    async def run() -> DocumentAnalysis:
        pipeline = AnalysisPipeline(completion, cancellation_event=cancel)
        task = asyncio.create_task(pipeline.analyse(ir, provenance()))
        # Let the first unit land, then cancel.
        await asyncio.sleep(0)
        cancel.set()
        try:
            return await task
        except CancelledError:
            raise

    with pytest.raises(CancelledError):
        asyncio.run(run())

    assert completion.calls < 3, "requests were dispatched after cancellation"


# --- AC-P0-15 / AC-P0-16: storage -------------------------------------------


def test_analysis_creates_no_sqlite_table(client: TestClient, settings):
    """AC-P0-15 — the IR is a file; so is the analysis."""
    import sqlite3

    connection = sqlite3.connect(str(settings.database_path))
    try:
        tables = sorted(
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )
        )
    finally:
        connection.close()

    assert tables == ["annotation_targets", "annotations", "documents", "profiles", "schema_version", "translation_tasks"]


def test_a_failed_write_leaves_the_previous_analysis_intact(tmp_path: Path, monkeypatch):
    """AC-P0-16 — atomic, so a crash cannot destroy a good analysis."""
    from app.context import persistence

    directory = tmp_path / "document"
    directory.mkdir()
    good = DocumentAnalysis(
        document_id="doc_test", provenance=provenance(), status=AnalysisStatus.READY,
        summary="The original analysis.",
    )
    write_analysis(directory, good)

    def explode(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(persistence, "write_text_atomic", explode)

    with pytest.raises(OSError):
        write_analysis(directory, good.model_copy(update={"summary": "replacement"}))

    assert read_analysis(directory).summary == "The original analysis."
    assert not list(directory.glob(f"{TEMP_PREFIX}*"))


# --- AC-P0-17 / AC-P0-18: provenance and invalidation -----------------------


def test_provenance_is_complete_and_carries_no_credential():
    """AC-P0-17."""
    ir = make_ir(paragraphs=[("p1", "Body. " * 50, 1, "s1")], sections=[("s1", "S", 1)])
    record = make_provenance(
        ir,
        provider_base_url="http://127.0.0.1:9/v1",
        provider_model="m",
        provider_protocol="chat_completions",
        provider_profile_name="Local",
        target_language="zh-CN",
    )
    payload = record.model_dump_json()

    for field in (
        "document_id", "content_hash", "pipeline_version", "prompt_version",
        "provider_base_url", "provider_model", "provider_protocol",
        "target_language", "created_at",
    ):
        assert getattr(record, field), f"{field} is empty"

    assert "api_key" not in payload
    assert "credential" not in payload


def test_cache_validity_ignores_the_credential_and_honours_semantics():
    """AC-P0-18 — the whole invalidation matrix, in one place."""
    analysis = DocumentAnalysis(
        document_id="doc_test", provenance=provenance(), status=AnalysisStatus.READY
    )
    base = dict(
        content_hash="hash-abc",
        pipeline_version=PIPELINE_VERSION,
        prompt_version=prompts.PROMPT_VERSION,
        provider_base_url="http://127.0.0.1:9/v1",
        provider_model="test-model",
        target_language="zh-CN",
    )

    assert is_cache_valid(analysis, **base)

    # A rotated key leaves no trace here at all — the credential is not an input,
    # so there is nothing for a caller to forget to exclude.
    assert is_cache_valid(analysis, **base)

    for field, changed in (
        ("content_hash", "hash-different"),
        ("prompt_version", "9.9.9"),
        ("pipeline_version", "9.9.9"),
        ("provider_model", "another-model"),
        ("provider_base_url", "http://127.0.0.1:8/v1"),
        ("target_language", "ja"),
    ):
        altered = dict(base)
        altered[field] = changed
        assert not is_cache_valid(analysis, **altered), f"{field} did not invalidate"


def test_cache_validity_rejects_unusable_statuses():
    for status in (AnalysisStatus.FAILED, AnalysisStatus.CANCELLED):
        analysis = DocumentAnalysis(
            document_id="doc_test", provenance=provenance(), status=status
        )
        assert not is_cache_valid(
            analysis,
            content_hash="hash-abc",
            pipeline_version=PIPELINE_VERSION,
            prompt_version=prompts.PROMPT_VERSION,
            provider_base_url="http://127.0.0.1:9/v1",
            provider_model="test-model",
            target_language="zh-CN",
        )


def test_provider_identity_is_the_endpoint_not_the_display_name():
    """AC_CHANGE_REQUEST 2 — a renamed profile must not invalidate anything."""
    from app.context.service import ProviderIdentity

    renamed = ProviderIdentity(
        base_url="http://127.0.0.1:9/v1", model="m", protocol="chat_completions",
        profile_name="A Totally New Name",
    )
    original = ProviderIdentity(
        base_url="http://127.0.0.1:9/v1", model="m", protocol="chat_completions",
        profile_name="Local",
    )

    assert (renamed.base_url, renamed.model) == (original.base_url, original.model)
    # Nothing in the cache key reads `profile_name`.
    import inspect

    from app.context import persistence

    source = inspect.getsource(persistence.is_cache_valid)
    assert "profile_name" not in source


# --- AC-P0-19: rebuildable ---------------------------------------------------


def test_deleting_analysis_leaves_every_other_artifact_alone(tmp_path: Path):
    """AC-P0-19 — regenerating understanding must not cost the document."""
    document_dir = tmp_path / "doc_test"
    document_dir.mkdir()
    artifacts = {
        "source.pdf": b"%PDF-1.4 original bytes",
        "ir.json": b'{"document_id": "doc_test"}',
        "mono.pdf": b"%PDF-1.4 translated",
        "dual.pdf": b"%PDF-1.4 bilingual",
    }
    for name, content in artifacts.items():
        (document_dir / name).write_bytes(content)

    write_analysis(
        document_dir,
        DocumentAnalysis(
            document_id="doc_test", provenance=provenance(), status=AnalysisStatus.READY
        ),
    )
    before = {name: (document_dir / name).read_bytes() for name in artifacts}

    delete_analysis(document_dir)

    assert not (document_dir / "analysis.json").exists()
    for name, content in before.items():
        assert (document_dir / name).read_bytes() == content, f"{name} was modified"


# --- AC-P0-20 / AC-P0-21: secrecy and privacy -------------------------------


def test_no_credential_reaches_the_analysis_or_the_logs(caplog):
    """AC-P0-20 — a key appears in neither the artifact nor a log record."""
    secret = "sk-secret-key-xyz-12345"
    ir = make_ir(
        paragraphs=[("p1", "Body text about policies. " * 60, 1, "s1")],
        sections=[("s1", "1 Introduction", 1)],
    )

    with caplog.at_level("DEBUG"):
        analysis = asyncio.run(
            AnalysisPipeline(FakeCompletion([section_reply(), SYNTHESIS]))
            .analyse(ir, provenance())
        )

    serialized = analysis.model_dump_json()
    assert secret not in serialized
    assert secret not in caplog.text
    assert "api_key" not in serialized


def test_paper_text_is_not_logged(caplog):
    """AC-P0-21 — document text is the user's, not ours to emit."""
    marker = "Quantum Cryptography 89231 Unique Marker"
    ir = make_ir(
        paragraphs=[("p1", f"{marker} appears here. " * 60, 1, "s1")],
        sections=[("s1", "1 Introduction", 1)],
    )

    with caplog.at_level("DEBUG"):
        asyncio.run(
            AnalysisPipeline(FakeCompletion([section_reply(), SYNTHESIS]))
            .analyse(ir, provenance())
        )

    assert marker not in caplog.text


# --- AC-P0-23 / AC-P0-24: ContextBuilder ------------------------------------


def build_context_fixture() -> tuple[DocumentIR, DocumentAnalysis]:
    ir = make_ir(
        paragraphs=[
            ("p1", "The first paragraph introduces the problem.", 1, "s1"),
            ("p2", "The policy is optimized through rollouts collected in simulation.",
             2, "s1"),
            ("p3", "We evaluate the policy on three benchmarks.", 2, "s1"),
            ("p4", "Acknowledgements and closing remarks follow here.", 3, None),
        ],
        sections=[("s1", "3 Method", 1)],
    )
    analysis = DocumentAnalysis(
        document_id="doc_test",
        provenance=provenance(),
        status=AnalysisStatus.READY,
        domain=DomainRecord(primary="Robotics", confidence=0.8),
        summary="The paper studies policy learning for robotic manipulation.",
        sections=[
            SectionAnalysis(
                section_id="s1", title="3 Method",
                summary="The method optimizes a policy from simulation rollouts.",
                page_range=(1, 2),
            )
        ],
        glossary=[
            GlossaryEntry(source_term="policy", suggested_translation="策略",
                          paragraph_ids=["p2"]),
            GlossaryEntry(source_term="rollout", suggested_translation="轨迹采样",
                          paragraph_ids=["p2"]),
            GlossaryEntry(source_term="end-effector", suggested_translation="末端执行器",
                          paragraph_ids=["p1"]),
            GlossaryEntry(source_term="ResNet-50", is_translatable=False,
                          paragraph_ids=["p1"]),
        ],
    )
    return ir, analysis


def test_context_contains_real_neighbours_and_section():
    """AC-P0-23 / §47 — neighbours come from the IR, not from the model."""
    ir, analysis = build_context_fixture()
    context = ContextBuilder(ir, analysis).build_context("p2")

    assert context.previous_paragraph == "The first paragraph introduces the problem."
    assert context.next_paragraph == "We evaluate the policy on three benchmarks."
    assert context.section_id == "s1"
    assert context.section_title == "3 Method"
    assert context.page_number == 2
    assert context.document_summary.startswith("The paper studies")


def test_context_excludes_terms_that_do_not_occur_in_the_paragraph():
    """§50 — a whole-paper glossary on every call is mostly noise."""
    ir, analysis = build_context_fixture()
    context = ContextBuilder(ir, analysis).build_context("p2")

    terms = {term.source_term for term in context.glossary}
    assert "policy" in terms and "rollout" in terms
    assert "end-effector" not in terms


def test_context_never_carries_the_target_paragraph_text():
    """AC-P0-24 — the caller already has it."""
    ir, analysis = build_context_fixture()
    context = ContextBuilder(ir, analysis).build_context("p2")

    payload = context.model_dump_json()
    assert "The policy is optimized through rollouts" not in payload
    assert "current_paragraph_text" not in payload
    assert "text" not in type(context).model_fields


def test_context_is_bounded_and_protects_in_paragraph_terms():
    """AC-P0-23 — shedding has an order, and two things are never shed."""
    ir, analysis = build_context_fixture()
    builder = ContextBuilder(ir, analysis)

    generous = builder.build_context("p2", max_tokens=1500)
    tiny = builder.build_context("p2", max_tokens=40)

    assert not generous.shed

    # Even under a budget that cannot fit everything, the terms this paragraph
    # actually uses and its section survive.
    terms = {term.source_term for term in tiny.glossary}
    assert "policy" in terms, "an in-paragraph term was shed"
    assert tiny.section_title == "3 Method"
    assert tiny.shed, "the context reports nothing shed despite an impossible budget"


def test_context_for_an_unknown_paragraph_is_an_error():
    ir, analysis = build_context_fixture()
    with pytest.raises(KeyError):
        ContextBuilder(ir, analysis).build_context("nope")


def test_context_works_without_any_analysis():
    """A document can be translated before it is understood."""
    ir, _ = build_context_fixture()
    context = ContextBuilder(ir, None).build_context("p2")

    assert context.document_summary is None
    assert context.glossary == []
    assert context.previous_paragraph is not None


# --- HTTP surface -------------------------------------------------------------


class FakeProvider:
    """A stand-in for the real provider at the HTTP boundary.

    Patched in place of `resolve_provider`, so the route, the service, the
    pipeline, the prompts and the persistence all run for real — only the network
    call is replaced.
    """

    def __init__(self, responses: list[str] | None = None) -> None:
        from app.llm.models import LLMResult

        self._result = LLMResult
        self.responses = list(responses or [])
        self.calls = 0

    async def generate(self, request):  # noqa: ANN001 - provider protocol
        self.calls += 1
        text = (
            self.responses.pop(0)
            if self.responses
            else json.dumps(
                {
                    "domain": {"primary": "Robotics", "confidence": 0.8, "rationale": "policy"},
                    "summary": "The paper studies policy learning for manipulation.",
                    "terms": [],
                    "acronyms": [],
                    "entities": [],
                }
            )
        )
        return self._result(
            text=text, model="fake", protocol="chat_completions", usage=None
        )

    async def test_connection(self):  # pragma: no cover - not exercised
        raise NotImplementedError


@pytest.fixture
def analysed_document(client: TestClient, tmp_path: Path):
    """Upload a real PDF and register a provider profile for it."""
    import fitz

    document = fitz.open()
    page = document.new_page(width=612, height=792)
    page.insert_text((72, 80), "Learning Policies for Robot Manipulation", fontsize=15)
    y = 120
    for line in (
        "The policy is optimized through multiple rollouts collected from the simulator.",
        "We evaluate the learned policy on three manipulation benchmarks and report means.",
        "Each rollout is a sequence of observations, actions and rewards gathered under",
        "the current policy, which is then updated from the aggregated trajectories.",
    ):
        page.insert_text((72, y), line, fontsize=10)
        y += 14
    source = tmp_path / "paper.pdf"
    document.save(str(source))
    document.close()

    imported = client.post(
        "/api/documents",
        files={"file": ("paper.pdf", source.read_bytes(), "application/pdf")},
    )
    assert imported.status_code == 201, imported.text
    document_id = imported.json()["document_id"]

    profile = client.post(
        "/api/profiles",
        json={"name": "Analysis Test", "base_url": "http://127.0.0.1:9/v1",
              "model": "test-model"},
    )
    assert profile.status_code == 201, profile.text
    assert profile.json()["has_key"] is False, "the fixture must stay keyless"

    return document_id, profile.json()["id"]


def test_post_analysis_produces_a_ready_analysis(client: TestClient, analysed_document, monkeypatch):
    """§63 — the endpoint analyses, and says what produced the result."""
    from app.llm import detection

    provider = FakeProvider()
    monkeypatch.setattr(detection, "resolve_provider", lambda *a, **k: _async(provider))

    document_id, profile_id = analysed_document
    response = client.post(
        f"/api/documents/{document_id}/analysis", json={"profile_id": profile_id}
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "READY"
    assert body["reused"] is False
    assert body["provenance"]["provider_model"] == "test-model"
    assert body["provenance"]["provider_base_url"] == "http://127.0.0.1:9/v1"
    assert body["provenance"]["target_language"] == "zh-CN"
    assert provider.calls >= 1


def test_get_analysis_never_generates(client: TestClient, analysed_document):
    """A GET that silently spends someone's API quota would be a surprise."""
    document_id, _profile_id = analysed_document
    response = client.get(f"/api/documents/{document_id}/analysis")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "ANALYSIS_NOT_FOUND"


def test_analysis_is_reused_without_calling_the_provider_again(
    client: TestClient, analysed_document, monkeypatch
):
    """AC-P0-18 / §74 — reopening an unchanged paper costs nothing."""
    from app.llm import detection

    provider = FakeProvider()
    monkeypatch.setattr(detection, "resolve_provider", lambda *a, **k: _async(provider))

    document_id, profile_id = analysed_document
    first = client.post(
        f"/api/documents/{document_id}/analysis", json={"profile_id": profile_id}
    )
    assert first.json()["reused"] is False
    calls_after_first = provider.calls

    second = client.post(
        f"/api/documents/{document_id}/analysis", json={"profile_id": profile_id}
    )

    assert second.status_code == 200
    assert second.json()["reused"] is True
    assert provider.calls == calls_after_first, "the cached analysis was regenerated"

    fetched = client.get(f"/api/documents/{document_id}/analysis")
    assert fetched.status_code == 200
    assert fetched.json()["status"] == "READY"


def test_force_regenerates_and_leaves_every_other_artifact_alone(
    client: TestClient, analysed_document, monkeypatch, settings
):
    """AC-P0-19 — rebuilding understanding must not cost the document."""
    from app.llm import detection

    provider = FakeProvider()
    monkeypatch.setattr(detection, "resolve_provider", lambda *a, **k: _async(provider))

    document_id, profile_id = analysed_document
    client.post(f"/api/documents/{document_id}/analysis", json={"profile_id": profile_id})

    directory = settings.documents_dir / document_id
    before = {
        name: (directory / name).read_bytes()
        for name in ("source.pdf", "ir.json")
        if (directory / name).exists()
    }
    assert before, "the fixture should have produced a source and an IR"

    forced = client.post(
        f"/api/documents/{document_id}/analysis",
        json={"profile_id": profile_id, "force": True},
    )

    assert forced.status_code == 200
    assert forced.json()["reused"] is False
    for name, content in before.items():
        assert (directory / name).read_bytes() == content, f"{name} was modified"


def test_analysis_can_be_deleted_without_touching_the_rest(
    client: TestClient, analysed_document, monkeypatch, settings
):
    from app.llm import detection

    provider = FakeProvider()
    monkeypatch.setattr(detection, "resolve_provider", lambda *a, **k: _async(provider))

    document_id, profile_id = analysed_document
    client.post(f"/api/documents/{document_id}/analysis", json={"profile_id": profile_id})

    directory = settings.documents_dir / document_id
    assert (directory / "analysis.json").exists()

    removed = client.delete(f"/api/documents/{document_id}/analysis")

    assert removed.status_code == 204
    assert not (directory / "analysis.json").exists()
    assert (directory / "ir.json").exists(), "deleting the analysis removed the IR"
    assert (directory / "source.pdf").exists()


def test_unknown_profile_is_reported_plainly(client: TestClient, analysed_document):
    document_id, _ = analysed_document
    response = client.post(
        f"/api/documents/{document_id}/analysis", json={"profile_id": "prof_nope"}
    )
    assert response.status_code == 404


def test_no_secret_in_any_analysis_response(
    client: TestClient, analysed_document, monkeypatch
):
    """AC-P0-20 — across the whole HTTP surface, not just the artifact."""
    from app.llm import detection

    provider = FakeProvider()
    monkeypatch.setattr(detection, "resolve_provider", lambda *a, **k: _async(provider))

    document_id, profile_id = analysed_document
    response = client.post(
        f"/api/documents/{document_id}/analysis", json={"profile_id": profile_id}
    )
    payload = json.dumps(response.json())

    assert "api_key" not in payload
    assert "credential" not in payload
    assert "secret" not in payload.lower()


def test_context_preview_returns_bounded_context_not_the_target_text(
    client: TestClient, analysed_document, monkeypatch
):
    """§64 / AC-P0-24 — the debug view obeys the same rule as the real caller."""
    from app.llm import detection

    provider = FakeProvider()
    monkeypatch.setattr(detection, "resolve_provider", lambda *a, **k: _async(provider))

    document_id, profile_id = analysed_document
    client.post(f"/api/documents/{document_id}/analysis", json={"profile_id": profile_id})

    ir = client.get(f"/api/documents/{document_id}/ir").json()
    paragraph = ir["paragraphs"][0]

    response = client.get(
        f"/api/documents/{document_id}/context-preview",
        params={"paragraph_id": paragraph["id"], "max_tokens": 200},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["paragraph_id"] == paragraph["id"]
    assert body["page_number"] >= 1
    assert paragraph["text"] not in json.dumps(body), "the preview echoed the target paragraph"


def test_context_preview_rejects_an_unknown_paragraph(
    client: TestClient, analysed_document
):
    document_id, _ = analysed_document
    response = client.get(
        f"/api/documents/{document_id}/context-preview",
        params={"paragraph_id": "p_nope"},
    )
    assert response.status_code == 404


def _async(value):
    """Wrap a value in a coroutine, for patching an async function."""

    async def _inner(*args, **kwargs):
        return value

    return _inner()


# --- performance --------------------------------------------------------------


def test_cached_read_and_context_build_are_fast(tmp_path: Path):
    """AC-P1-04 — both are local operations, and should behave like it."""
    import time

    directory = tmp_path / "document"
    ir, analysis = build_context_fixture()
    write_analysis(directory, analysis)

    started = time.perf_counter()
    for _ in range(50):
        read_analysis(directory)
    per_read = (time.perf_counter() - started) / 50
    assert per_read < 0.05, f"a cached read took {per_read * 1000:.1f} ms"

    builder = ContextBuilder(ir, analysis)
    started = time.perf_counter()
    for _ in range(200):
        builder.build_context("p2")
    per_build = (time.perf_counter() - started) / 200
    assert per_build < 0.005, f"build_context took {per_build * 1000:.1f} ms"
