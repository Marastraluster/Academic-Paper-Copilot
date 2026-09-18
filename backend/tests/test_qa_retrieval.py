"""Paper QA retrieval — DS-QA-001.

Runs offline. The corpus is a hand-built `DocumentIR`, so every assertion about
scopes, ranking, expansion and citation identity is deterministic and needs no
model. The real-paper benchmark lives beside this file and drives the real
extracted IRs.

The unit of the task is not "did BM25 return a good paragraph" but "did the
evidence come out carrying real citation identity, inside the scope it was asked
for, with nothing invented".
"""

from __future__ import annotations

import sqlite3

import pytest

from app.context.models import (
    AcronymEntry,
    AnalysisProvenance,
    AnalysisStatus,
    DocumentAnalysis,
    GlossaryEntry,
)
from app.document.models import (
    DocumentIR,
    DocumentMetadata,
    PageIR,
    ParagraphIR,
    SectionIR,
    TextBlockIR,
)
from app.qa import Scope, retrieve
from app.qa.index import ensure_index, index_path, is_stale
from app.qa.models import EvidenceItem
from app.qa.query import normalize_terms, prepare

# --- a small but real corpus --------------------------------------------------


def _paragraph(pid: str, text: str, page: int, section: str | None) -> ParagraphIR:
    return ParagraphIR(
        id=pid, section_id=section, text=text, page_number=page,
        page_range=(page, page), block_ids=[f"b_{pid}"],
    )


def build_ir() -> DocumentIR:
    """Two sections on one page, plus a references section.

    Deliberately mirrors the layout that broke section assignment in the real
    pipeline: several sections sharing a page.
    """
    paragraphs = [
        _paragraph("p1", "Deep networks have led to breakthroughs in image recognition.", 1, "s1"),
        _paragraph("p2", "The degradation problem shows accuracy saturating as depth increases.",
                   1, "s1"),
        _paragraph("p3", "We adopt residual learning so layers fit a residual mapping.", 1, "s2"),
        _paragraph("p4", "Identity mapping is achieved by shortcut connections.", 1, "s2"),
        _paragraph("p5", "Improving accuracy by stacking more layers requires care.", 2, "s3"),
        _paragraph("p6", "He, K. Deep residual learning for image recognition. 2016.", 3, "sref"),
    ]
    blocks = [
        TextBlockIR(
            id=f"b_{p.id}", page_index=p.page_number - 1, page_number=p.page_number,
            layout_class="plain text", bbox=(0.0, 0.0, 100.0, 20.0), text=p.text,
        )
        for p in paragraphs
    ]
    blocks.append(
        TextBlockIR(
            id="b_header", page_index=0, page_number=1, layout_class="abandon",
            bbox=(0.0, 0.0, 500.0, 12.0),
            text="Proceedings of the Test Conference 2025",
        )
    )
    sections = [
        SectionIR(id="s1", title="1. Introduction", level=1, page_range=(1, 1)),
        SectionIR(id="s2", title="2. Residual Learning", level=1, page_range=(1, 1)),
        SectionIR(id="s3", title="3. Experiments", level=1, page_range=(2, 2)),
        SectionIR(id="sref", title="References", level=1, page_range=(3, 3), is_references=True),
    ]
    pages: list[PageIR] = []
    for number in (1, 2, 3):
        pages.append(
            PageIR(
                page_index=number - 1, page_number=number, width_pt=595.0, height_pt=842.0,
                has_text=True,
                blocks=[b for b in blocks if b.page_number == number],
            )
        )
    return DocumentIR(
        document_id="doc_qa", content_hash="hash-qa", source_filename="paper.pdf",
        page_count=3, metadata=DocumentMetadata(title="A Paper"),
        sections=sections, pages=pages, paragraphs=paragraphs,
        page_mapping={p.id: p.page_number for p in paragraphs},
        has_text_layer=True, ocr_required=False,
    )


def build_analysis() -> DocumentAnalysis:
    provenance = AnalysisProvenance(
        document_id="doc_qa", content_hash="hash-qa", pipeline_version="1",
        prompt_version="1", provider_base_url="http://x", provider_model="m",
        provider_protocol="chat_completions", target_language="zh-CN",
        created_at="2026-09-18T00:00:00+00:00",
    )
    return DocumentAnalysis(
        document_id="doc_qa", provenance=provenance, status=AnalysisStatus.READY,
        summary="A paper about residual learning.",
        glossary=[
            GlossaryEntry(source_term="degradation problem", suggested_translation="退化问题",
                          paragraph_ids=["p2"]),
            GlossaryEntry(source_term="residual learning", suggested_translation="残差学习",
                          paragraph_ids=["p3"]),
        ],
        acronyms=[
            AcronymEntry(acronym="ResNet", expansion=None, paragraph_ids=["p6"]),
        ],
    )


@pytest.fixture
def corpus(tmp_path):
    ir = build_ir()
    directory = tmp_path / "doc_qa"
    directory.mkdir()
    return ir, directory


# --- AC-P0-1: the index, and where it lives ----------------------------------


class TestIndex:
    def test_the_index_is_a_file_beside_the_other_artifacts(self, corpus) -> None:
        """AC-P0-1 — per-document, so isolation is structural rather than a WHERE clause."""
        ir, directory = corpus
        ensure_index(directory, ir)

        assert index_path(directory).is_file()
        assert index_path(directory).name == "search.db"
        # The application database is untouched: the index owns its own file.
        assert not (directory / "app.db").exists()

    def test_the_application_table_set_is_unchanged(self, client, settings) -> None:
        """AC-P0-1 — no migration, no schema bump, guards unmodified."""
        connection = sqlite3.connect(str(settings.database_path))
        try:
            tables = sorted(
                row[0] for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' "
                    "AND name NOT LIKE 'sqlite_%'"
                )
            )
        finally:
            connection.close()
        assert tables == ["annotation_targets", "annotations", "documents", "profiles", "schema_version", "translation_tasks"]

    def test_reindexing_does_not_duplicate(self, corpus) -> None:
        """AC-P0-7 — idempotent."""
        ir, directory = corpus
        first = ensure_index(directory, ir)
        second = ensure_index(directory, ir)

        assert first.chunks == second.chunks
        assert second.rebuilt is False

        connection = sqlite3.connect(str(index_path(directory)))
        try:
            count = connection.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
        finally:
            connection.close()
        assert count == first.chunks

    def test_a_changed_source_hash_makes_the_index_stale(self, corpus) -> None:
        """AC-P0-7 — a stale index must not quietly answer for a new document."""
        ir, directory = corpus
        ensure_index(directory, ir)
        assert not is_stale(directory, ir)

        changed = ir.model_copy(update={"content_hash": "a-different-document"})
        assert is_stale(directory, changed)

        stats = ensure_index(directory, changed)
        assert stats.rebuilt is True
        assert not is_stale(directory, changed)


# --- AC-P0-4: boilerplate never becomes evidence ------------------------------


def test_abandon_regions_are_not_indexed(corpus) -> None:
    """AC-P0-4 — a paper's title repeats on every page and would score well."""
    ir, directory = corpus
    ensure_index(directory, ir)

    connection = sqlite3.connect(str(index_path(directory)))
    try:
        rows = connection.execute(
            "SELECT text FROM chunks WHERE chunks MATCH ?", ("Proceedings",)
        ).fetchall()
    finally:
        connection.close()

    assert rows == [], "a running header reached the index"

    bundle = retrieve(ir, directory, query="Proceedings Test Conference",
                      scope=Scope(type="whole_paper"))
    assert bundle.diagnostics.code == "NO_MATCH_TOKEN"


# --- AC-P0-3: citation identity -----------------------------------------------


class TestCitationGrounding:
    def test_every_item_matches_its_source_paragraph_exactly(self, corpus) -> None:
        """AC-P0-3 — byte-for-byte, and the page is the IR's page."""
        ir, directory = corpus
        by_id = {p.id: p for p in ir.paragraphs}

        bundle = retrieve(ir, directory, query="degradation problem residual",
                          scope=Scope(type="whole_paper"), top_k=5)

        assert bundle.items
        for item in bundle.items:
            source = by_id[item.paragraph_id]
            assert item.text == source.text
            assert item.page_number == source.page_number
            assert item.section_id == source.section_id
            assert item.page_range == list(source.page_range)

    def test_evidence_ids_are_sequential_from_e1(self, corpus) -> None:
        """AC-P0-3 — the ids a later answer will cite."""
        ir, directory = corpus
        bundle = retrieve(ir, directory, query="degradation", scope=Scope(type="whole_paper"))
        assert [item.id for item in bundle.items] == [
            f"E{index}" for index in range(1, len(bundle.items) + 1)
        ]

    def test_no_field_is_model_derived(self, corpus) -> None:
        """AC-P0-3 — the analysis may expand a query; it never supplies evidence."""
        ir, directory = corpus
        with_analysis = retrieve(ir, directory, query="degradation", analysis=build_analysis(),
                                 scope=Scope(type="whole_paper"))
        without = retrieve(ir, directory, query="degradation", scope=Scope(type="whole_paper"))

        assert {i.chunk_id for i in with_analysis.items} == {i.chunk_id for i in without.items}


# --- AC-P0-2: scope constrains candidates -------------------------------------


class TestScopes:
    def test_whole_paper_can_cross_pages(self, corpus) -> None:
        ir, directory = corpus
        bundle = retrieve(ir, directory, query="accuracy", scope=Scope(type="whole_paper"))
        assert {item.page_number for item in bundle.items} == {1, 2}

    def test_page_scope_returns_only_that_page(self, corpus) -> None:
        ir, directory = corpus
        bundle = retrieve(ir, directory, query="degradation accuracy",
                          scope=Scope(type="page", page=2))
        assert bundle.items
        assert {item.page_number for item in bundle.items} == {2}

    def test_a_wrong_page_returns_nothing_rather_than_the_right_answer(self, corpus) -> None:
        """AC-P0-2 — the failure this criterion exists for.

        `degradation` is on page 1 and `accuracy` on page 2. Asking for page 2
        must not hand back page 1's better match.
        """
        ir, directory = corpus
        bundle = retrieve(ir, directory, query="degradation", scope=Scope(type="page", page=2))
        assert bundle.items == []
        assert bundle.diagnostics.code == "NO_MATCH_TOKEN"

    def test_section_scope_stays_inside_the_section(self, corpus) -> None:
        ir, directory = corpus
        bundle = retrieve(ir, directory, query="residual mapping identity",
                          scope=Scope(type="section", section_id="s2"))
        assert bundle.items
        assert all(item.section_id == "s2" for item in bundle.items if item.is_direct_hit)

    def test_selection_never_leaks_outside_itself(self, corpus) -> None:
        """AC-P0-2 — the strictest scope. Neighbours must not escape it either."""
        ir, directory = corpus
        chosen = ["p3"]
        bundle = retrieve(ir, directory, query="residual",
                          scope=Scope(type="selection", paragraph_ids=chosen))

        assert {item.chunk_id for item in bundle.items} <= set(chosen)

    def test_a_selection_without_a_query_returns_the_selection(self, corpus) -> None:
        """The "explain what I highlighted" case: there is no search to run."""
        ir, directory = corpus
        bundle = retrieve(ir, directory, query="",
                          scope=Scope(type="selection", paragraph_ids=["p2", "p3"]))

        assert [item.paragraph_id for item in bundle.items] == ["p2", "p3"]
        assert all(item.is_direct_hit for item in bundle.items)

    def test_a_scope_missing_its_field_is_refused(self, corpus) -> None:
        from app.qa import RetrievalError

        ir, directory = corpus
        for scope in (Scope(type="page"), Scope(type="section"),
                      Scope(type="selection")):
            with pytest.raises(RetrievalError):
                retrieve(ir, directory, query="x", scope=scope)


# --- AC-P0-5: sanitisation ----------------------------------------------------


class TestQuerySanitisation:
    @pytest.mark.parametrize(
        "query",
        ["ResNet-50", "F(x)", "p < 0.05", "AND NOT", "a:b", "(unbalanced",
         'has "quotes"', "neural*", "CIFAR-10", "ResNet-50 and VGG-16"],
    )
    def test_no_user_string_can_break_the_query(self, corpus, query: str) -> None:
        """AC-P0-5 — measured: every one of these raises `OperationalError` raw.

        `MATCH 'ResNet-50'` is `OperationalError: no such column: 50`;
        `MATCH 'F(x)'` is a syntax error. The ordinary vocabulary of an academic
        question used to be a 500.
        """
        ir, directory = corpus
        bundle = retrieve(ir, directory, query=query, scope=Scope(type="whole_paper"))
        assert bundle.diagnostics.code in ("SUCCESS", "NO_MATCH_TOKEN")

    def test_operators_are_treated_as_words(self) -> None:
        """Every term is quoted, which is what makes user input inert."""
        assert normalize_terms("AND NOT") == ['"AND"', '"NOT"']
        assert normalize_terms("a:b") == ['"a"', '"b"']

    def test_a_hyphenated_identifier_stays_one_phrase(self) -> None:
        """Splitting it would trade a precise match for two loose terms."""
        assert normalize_terms("ResNet-50") == ['"ResNet-50"']

    def test_a_query_with_no_words_is_reported_rather_than_run(self) -> None:
        assert prepare("   ").is_empty
        assert prepare("!!!").is_empty


# --- AC-P1-1: expansion -------------------------------------------------------


class TestExpansion:
    def test_a_chinese_query_reaches_english_source(self, corpus) -> None:
        """The strongest reason to reuse `DocumentAnalysis` here."""
        ir, directory = corpus
        without = retrieve(ir, directory, query="退化问题", scope=Scope(type="whole_paper"))
        assert without.items == []

        with_analysis = retrieve(ir, directory, query="退化问题", analysis=build_analysis(),
                                 scope=Scope(type="whole_paper"))
        assert any(item.paragraph_id == "p2" for item in with_analysis.items)

    def test_the_expansion_is_its_own_query_not_a_conjunct(self, corpus) -> None:
        """The bug this test exists for, in its DS-QA-004 form.

        `原句 AND 英文扩展` returns nothing, because the Chinese characters match
        no English paragraph and drag the expansion down with them. The first fix
        was to OR everything into one expression; DS-QA-004 replaced that, because
        within one MATCH every term shares the score and the common words dilute
        the rare ones. The expansion is now a separate query, fused by rank.
        """
        prepared = prepare("退化问题", build_analysis())

        assert prepared.expansions
        sources = prepared.sources
        assert sources[0] == "raw", "the user's own query is always first"
        assert "glossary" in sources
        # One expression per variant: no expansion is ORed into another's query.
        assert len(prepared.variants) == len({v.match for v in prepared.variants})
        assert all(v.match for v in prepared.variants)

    def test_an_unattested_acronym_is_not_expanded(self, corpus) -> None:
        """`ResNet` has no expansion in the analysis, so none is invented."""
        prepared = prepare("ResNet", build_analysis())
        assert prepared.expansions == ()

    def test_expansion_without_analysis_is_a_no_op(self, corpus) -> None:
        assert prepare("退化问题", None).expansions == ()


# --- AC-P0-6: neighbour expansion ---------------------------------------------


class TestNeighbourExpansion:
    def test_neighbours_are_added_but_marked_as_not_direct(self, corpus) -> None:
        ir, directory = corpus
        bundle = retrieve(ir, directory, query="degradation", scope=Scope(type="whole_paper"),
                          top_k=1)
        direct = [item for item in bundle.items if item.is_direct_hit]
        neighbours = [item for item in bundle.items if not item.is_direct_hit]

        assert direct
        assert neighbours, "a hit with no neighbours should still expand"
        assert all(item.score is None for item in neighbours)

    def test_neighbours_never_cross_a_section_boundary(self, corpus) -> None:
        """The paragraph after the Abstract is the Introduction, not its context."""
        ir, directory = corpus
        bundle = retrieve(ir, directory, query="degradation", scope=Scope(type="whole_paper"),
                          top_k=3)

        sections = {item.section_id for item in bundle.items}
        assert len(sections) == 1, f"expansion crossed sections: {sections}"

    def test_no_paragraph_appears_twice(self, corpus) -> None:
        """Overlapping windows must merge rather than repeat."""
        ir, directory = corpus
        bundle = retrieve(ir, directory, query="residual learning mapping identity",
                          scope=Scope(type="whole_paper"), top_k=6)
        ids = [item.chunk_id for item in bundle.items]
        assert len(ids) == len(set(ids))


# --- AC-P0-8: no analysis required --------------------------------------------


def test_retrieval_works_with_no_analysis_present(corpus) -> None:
    """AC-P0-8 — a search must not cost 468 seconds of analysis."""
    ir, directory = corpus
    assert not (directory / "analysis.json").exists()

    bundle = retrieve(ir, directory, query="degradation problem",
                      scope=Scope(type="whole_paper"))

    assert bundle.items
    assert bundle.diagnostics.expansions == []


# --- AC-P0-5, completed: the token survives what sanitisation does to it -------


def _one_paragraph_corpus(directory, text: str) -> DocumentIR:
    paragraph = _paragraph("p1", text, 1, "s1")
    block = TextBlockIR(
        id="b_p1", page_index=0, page_number=1, layout_class="plain text",
        bbox=(0.0, 0.0, 100.0, 20.0), text=text,
    )
    directory.mkdir(parents=True, exist_ok=True)
    return DocumentIR(
        document_id="doc_qa", content_hash="hash-qa", source_filename="paper.pdf",
        page_count=1, metadata=DocumentMetadata(title="A Paper"),
        sections=[SectionIR(id="s1", title="1. Introduction", level=1, page_range=(1, 1))],
        pages=[PageIR(page_index=0, page_number=1, width_pt=595.0, height_pt=842.0,
                      has_text=True, blocks=[block])],
        paragraphs=[paragraph], page_mapping={"p1": 1},
        has_text_layer=True, ocr_required=False,
    )


@pytest.mark.parametrize("identifier", ["ResNet-50", "CIFAR-10", "F(x)", "p < 0.05"])
def test_a_technical_token_retrieves_the_paragraph_that_contains_it(
    tmp_path, identifier: str
) -> None:
    """AC-P0-5 — sanitisation must preserve the term, not merely survive it.

    The parametrised test above proves these tokens no longer raise. This one
    proves the fix does not achieve that by throwing the token away: a sanitiser
    that stripped every non-word character would pass that test and fail this
    one, and `ResNet-50` would quietly stop retrieving anything.
    """
    directory = tmp_path / "doc_qa"
    ir = _one_paragraph_corpus(directory, f"We evaluate {identifier} on the benchmark.")

    bundle = retrieve(ir, directory, query=identifier, scope=Scope(type="whole_paper"))

    assert [item.paragraph_id for item in bundle.items] == ["p1"]


# --- AC-P0-7, completed: the index is derived, never written back -------------


def test_indexing_and_querying_never_modify_a_stored_artifact(corpus) -> None:
    """AC-P0-7 — `ir.json` and `analysis.json` are read-only inputs.

    They are the analysis pipeline's expensive output and the translation
    layer's input; an index build that rewrote either would corrupt work this
    task has no business touching.
    """
    ir, directory = corpus
    (directory / "ir.json").write_text(ir.model_dump_json(indent=2), encoding="utf-8")
    (directory / "analysis.json").write_text(
        build_analysis().model_dump_json(indent=2), encoding="utf-8"
    )
    before = {name: (directory / name).read_bytes() for name in ("ir.json", "analysis.json")}

    retrieve(ir, directory, query="degradation", analysis=build_analysis(),
             scope=Scope(type="whole_paper"))

    for name, original in before.items():
        assert (directory / name).read_bytes() == original, f"{name} was modified"


# --- privacy ------------------------------------------------------------------


def test_the_query_is_not_written_to_the_index(corpus) -> None:
    """The index holds the paper, not what the user asked about it."""
    ir, directory = corpus
    retrieve(ir, directory, query="a-very-distinctive-question-phrase",
             scope=Scope(type="whole_paper"))

    blob = index_path(directory).read_bytes()
    assert b"a-very-distinctive-question-phrase" not in blob


def test_the_log_carries_a_digest_and_a_length_but_never_the_question(
    corpus, caplog
) -> None:
    """AC-P1-6 — a search is about the user's paper *and* their question."""
    import hashlib

    ir, directory = corpus
    question = "a-very-distinctive-question-phrase"

    with caplog.at_level("INFO", logger="app.qa.retrieval"):
        retrieve(ir, directory, query=question, scope=Scope(type="whole_paper"))

    record = next(r for r in caplog.records if r.getMessage() == "retrieval")
    assert record.query_sha256 == hashlib.sha256(question.encode("utf-8")).hexdigest()
    assert record.query_length == len(question)

    # Neither the question nor any retrieved source text reaches the log.
    assert question not in caplog.text
    assert "degradation problem" not in caplog.text
