"""Retrieval expansion and fusion — DS-QA-004.

Runs offline. The corpus is a hand-built `DocumentIR` plus a hand-built
`DocumentAnalysis`, so every assertion about what was searched is deterministic
and needs no provider.

The two things worth stating about the shape of these tests. First, the **raw**
path is a control: expansion may add queries, and it may not change what the
user's own words retrieve, because that path is what finds an exact model name.
Second, **identity is the chunk, not the text** — a paper repeats its own
sentences, and two paragraphs that read alike are two pieces of evidence with two
pages.
"""
from __future__ import annotations

import json
import re

import pytest

from app.context.models import (
    AcronymEntry,
    AnalysisProvenance,
    AnalysisStatus,
    DocumentAnalysis,
    EntityEntry,
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
from app.qa.fusion import RRF_K, fuse
from app.qa.index import index_path
from app.qa.query import (
    MAX_ENTITY_EXPANSIONS,
    content_terms,
    coverage,
    MIN_ENTITY_PARAGRAPHS,
    expand,
    expand_entities,
    prepare,
)
from app.qa.retrieval import needs_rewrite
from app.qa.rewrite import RewriteUnavailable, parse_queries

# --- corpus -------------------------------------------------------------------

P1 = "Deep networks expose a degradation problem as depth increases."
P2 = "We adopt residual learning so layers fit a residual mapping."
P3 = "Shortcut connections perform identity mapping and add no parameters."
P4 = "We evaluate on CIFAR-10 and ImageNet."          # the two datasets
P5 = "The optimizer was momentum with a learning rate of 0.1."
P6 = "We evaluate on CIFAR-10 and ImageNet."          # identical text, other page


def build_ir() -> DocumentIR:
    """Six paragraphs across three pages, with one repeated sentence.

    `p4` and `p6` carry identical text on purpose: deduplicating by text would
    merge them and lose a page and a citation.
    """
    paragraphs = [
        ParagraphIR(id="p1", section_id="s1", text=P1, page_number=1, page_range=(1, 1), block_ids=["b1"]),
        ParagraphIR(id="p2", section_id="s1", text=P2, page_number=1, page_range=(1, 1), block_ids=["b2"]),
        ParagraphIR(id="p3", section_id="s2", text=P3, page_number=2, page_range=(2, 2), block_ids=["b3"]),
        ParagraphIR(id="p4", section_id="s2", text=P4, page_number=2, page_range=(2, 2), block_ids=["b4"]),
        ParagraphIR(id="p5", section_id="s3", text=P5, page_number=3, page_range=(3, 3), block_ids=["b5"]),
        ParagraphIR(id="p6", section_id="s3", text=P6, page_number=3, page_range=(3, 3), block_ids=["b6"]),
    ]
    blocks = [
        TextBlockIR(id=f"b{n}", page_index=p.page_number - 1, page_number=p.page_number,
                    layout_class="plain text", bbox=(0.0, 0.0, 100.0, 20.0), text=p.text)
        for n, p in zip("123456", paragraphs)
    ]
    sections = [
        SectionIR(id="s1", title="1. Introduction", level=1, page_range=(1, 1)),
        # Deliberately *not* "Datasets": the section title is an indexed column
        # weighted 5.0, so a heading named after the question would answer it and
        # the test would measure the fixture instead of the expansion.
        SectionIR(id="s2", title="2. Experiments", level=1, page_range=(2, 2)),
        SectionIR(id="s3", title="3. Training", level=1, page_range=(3, 3)),
    ]
    pages = [
        PageIR(page_index=n - 1, page_number=n, width_pt=595.0, height_pt=842.0,
               has_text=True, blocks=[b for b in blocks if b.page_number == n])
        for n in (1, 2, 3)
    ]
    return DocumentIR(
        document_id="doc_x", content_hash="hash-x", source_filename="paper.pdf",
        page_count=3, metadata=DocumentMetadata(title="A Paper"),
        sections=sections, pages=pages, paragraphs=paragraphs,
        page_mapping={p.id: p.page_number for p in paragraphs},
        has_text_layer=True, ocr_required=False,
    )


def build_analysis(entities: list[EntityEntry] | None = None) -> DocumentAnalysis:
    provenance = AnalysisProvenance(
        document_id="doc_x", content_hash="hash-x", pipeline_version="1",
        prompt_version="1", provider_base_url="http://x", provider_model="m",
        provider_protocol="chat_completions", target_language="zh-CN",
        created_at="2026-09-18T00:00:00+00:00",
    )
    return DocumentAnalysis(
        document_id="doc_x", provenance=provenance, status=AnalysisStatus.READY,
        glossary=[
            GlossaryEntry(source_term="degradation problem", suggested_translation="退化问题"),
            GlossaryEntry(source_term="residual learning", suggested_translation="残差学习"),
        ],
        acronyms=[
            AcronymEntry(acronym="PPO", expansion="proximal policy optimization"),
            # No expansion: the paper never spells it out, and inventing one is
            # exactly the fabrication the analysis refuses to make.
            AcronymEntry(acronym="SGD", expansion=None),
        ],
        entities=entities if entities is not None else [
            EntityEntry(name="CIFAR-10", kind="dataset", paragraph_ids=["p4", "p6"]),
            EntityEntry(name="ImageNet", kind="dataset", paragraph_ids=["p4", "p6"]),
            EntityEntry(name="Something-Something", kind="dataset", paragraph_ids=["p1"]),
            EntityEntry(name="ResNet", kind="model", paragraph_ids=["p1", "p2", "p3"]),
            EntityEntry(name="VGG", kind="model", paragraph_ids=["p2"]),
        ],
    )


@pytest.fixture
def corpus(tmp_path):
    ir = build_ir()
    directory = tmp_path / "doc_x"
    directory.mkdir()
    return ir, directory


# --- the raw path is a control ------------------------------------------------


def test_the_users_own_query_is_always_the_first_variant(corpus) -> None:
    """Expansion supplements retrieval; it never replaces the direct search.

    That search is what finds `ResNet-50` in one millisecond, and spending it
    would trade the fastest path for the slowest.
    """
    prepared = prepare("residual learning", build_analysis())

    assert prepared.variants[0].source == "raw"
    assert prepared.variants[0].match == '"residual" OR "learning"'


def test_expansion_without_analysis_adds_nothing(corpus) -> None:
    prepared = prepare("What datasets are used?", None)

    assert [v.source for v in prepared.variants] == ["raw"]
    assert prepare("What datasets are used?", None).expansions == ()


def test_an_unattested_acronym_is_not_expanded(corpus) -> None:
    """`SGD` has no expansion in the analysis, so none is invented."""
    expansions = expand("What does SGD stand for?", build_analysis())

    assert not any("SGD" in term for term, _, _ in expansions)


# --- glossary and acronyms, both directions -----------------------------------


def test_the_glossary_expands_both_ways(corpus) -> None:
    """A reader may hold either word, and the same row evidences both."""
    forward = expand("如何解决退化问题", build_analysis())
    assert any(expansion == "degradation problem" for _, expansion, _ in forward)

    backward = expand("the degradation problem", build_analysis())
    assert any(expansion == "退化问题" for _, expansion, _ in backward)


def test_an_acronym_expands_both_ways(corpus) -> None:
    forward = expand("What is PPO?", build_analysis())
    assert any(expansion == "proximal policy optimization" for _, expansion, _ in forward)

    backward = expand("proximal policy optimization", build_analysis())
    assert any(expansion == "PPO" for _, expansion, _ in backward)


def test_a_multi_word_expansion_searches_as_a_phrase(corpus) -> None:
    """`"degradation" AND "problem"` is not adjacency, and used to claim it was."""
    prepared = prepare("退化问题", build_analysis())
    glossary = [v for v in prepared.variants if v.source == "glossary"]

    assert glossary
    assert glossary[0].match == '"degradation problem"'


# --- entities and their bound -------------------------------------------------


def test_an_entity_type_question_expands_to_bounded_entities(corpus) -> None:
    """The measured ENTITY_TYPE miss: "datasets" vs CIFAR-10 / ImageNet."""
    chosen = expand_entities("What datasets are used for evaluation?", build_analysis())

    names = [name for name, _, _ in chosen]
    assert "CIFAR-10" in names and "ImageNet" in names
    assert len(chosen) <= MAX_ENTITY_EXPANSIONS


def test_a_single_mention_entity_is_not_injected(corpus) -> None:
    """Mentioned once: a citation or a passing comparison, not something used."""
    chosen = expand_entities("What datasets are used?", build_analysis())

    assert "Something-Something" not in [name for name, _, _ in chosen]
    assert MIN_ENTITY_PARAGRAPHS == 2


def test_the_entity_bound_holds_when_a_paper_has_many(corpus) -> None:
    """A paper with thirty datasets must not put thirty terms in one variant."""
    many = [
        EntityEntry(name=f"Dataset-{n}", kind="dataset", paragraph_ids=["p1", "p2"])
        for n in range(30)
    ]
    chosen = expand_entities("Which datasets are used?", build_analysis(many))

    assert len(chosen) == MAX_ENTITY_EXPANSIONS


def test_entity_expansion_is_deterministic_under_ties(corpus) -> None:
    """A cap of three is only reproducible if ties break the same way every run."""
    tied = [
        EntityEntry(name=name, kind="dataset", paragraph_ids=["p1", "p2"])
        for name in ("Zeta", "Alpha", "Mid", "Beta")
    ]
    first = [name for name, _, _ in expand_entities("datasets", build_analysis(tied))]
    second = [name for name, _, _ in expand_entities("datasets", build_analysis(tied))]

    assert first == second == ["Alpha", "Beta", "Mid"]


def test_a_question_with_no_type_word_injects_no_entities(corpus) -> None:
    """Expansion is triggered by the question, not sprayed at every query."""
    assert expand_entities("How does the method work?", build_analysis()) == []


def test_entities_are_searched_as_their_own_variant(corpus) -> None:
    prepared = prepare("What datasets are used for evaluation?", build_analysis())

    entity_variants = [v.match for v in prepared.variants if v.source == "entity"]
    assert entity_variants
    assert all(match.startswith('"') and " OR " not in match for match in entity_variants)


# --- retrieval through the whole path -----------------------------------------


def test_entity_expansion_finds_the_dataset_paragraph(corpus) -> None:
    """The fix, end to end: the question's word is not the paper's word."""
    ir, directory = corpus
    without = retrieve(ir, directory, query="What datasets are used for evaluation?",
                       scope=Scope(type="whole_paper"), top_k=3)
    assert "p4" not in [item.paragraph_id for item in without.items]

    with_analysis = retrieve(ir, directory, query="What datasets are used for evaluation?",
                             analysis=build_analysis(), scope=Scope(type="whole_paper"),
                             top_k=3)
    assert "p4" in [item.paragraph_id for item in with_analysis.items]


def test_two_identical_paragraphs_stay_two_pieces_of_evidence(corpus) -> None:
    """Deduplication is by chunk identity, never by text."""
    ir, directory = corpus
    bundle = retrieve(ir, directory, query="CIFAR-10 ImageNet",
                      scope=Scope(type="whole_paper"))

    found = {item.paragraph_id: item.page_number for item in bundle.items}
    assert found.get("p4") == 2 and found.get("p6") == 3


def test_expansion_cannot_widen_the_scope(corpus) -> None:
    """Every variant runs inside the scope, not globally with a filter after."""
    ir, directory = corpus
    bundle = retrieve(ir, directory, query="What datasets are used for evaluation?",
                      analysis=build_analysis(), scope=Scope(type="page", page=2))

    assert bundle.items
    assert {item.page_number for item in bundle.items} == {2}

    section = retrieve(ir, directory, query="What datasets are used for evaluation?",
                       analysis=build_analysis(), scope=Scope(type="section", section_id="s3"))
    assert all(item.section_id == "s3" for item in section.items if item.is_direct_hit)


def test_a_variant_that_matches_nothing_contributes_nothing(corpus) -> None:
    """The property that made variants the right shape: no drag, no dilution."""
    ir, directory = corpus
    bundle = retrieve(ir, directory, query="residual learning",
                      scope=Scope(type="whole_paper"), rewrites=["zzz nonexistent phrase"])

    assert any(item.paragraph_id == "p2" for item in bundle.items)
    assert bundle.diagnostics.query_variants[0] == "raw"
    assert "rewrite" in bundle.diagnostics.query_variants


def test_variants_are_reported_in_diagnostics(corpus) -> None:
    ir, directory = corpus
    bundle = retrieve(ir, directory, query="What datasets are used for evaluation?",
                      analysis=build_analysis(), scope=Scope(type="whole_paper"))

    assert bundle.diagnostics.query_variants[0] == "raw"
    assert "entity" in bundle.diagnostics.query_variants


def test_the_index_is_not_written_to(corpus) -> None:
    """Expansion changes queries, not the corpus."""
    ir, directory = corpus
    retrieve(ir, directory, query="degradation", scope=Scope(type="whole_paper"))
    before = index_path(directory).read_bytes()

    retrieve(ir, directory, query="What datasets are used?", analysis=build_analysis(),
             scope=Scope(type="whole_paper"))

    assert index_path(directory).read_bytes() == before


# --- fusion -------------------------------------------------------------------


def test_fusion_rewards_agreement() -> None:
    """A chunk two queries found outranks one that only a single query found."""
    fused = fuse({"a": ["x", "y"], "b": ["y", "x"]})
    scores = {key: score for key, score, _ in fused}

    assert scores["x"] == scores["y"], "same ranks in the same positions"


def test_fusion_is_deterministic_and_stable() -> None:
    """Identical input, identical order — or no benchmark is reproducible."""
    rankings = {"a": ["p", "q", "r"], "b": ["r", "q", "p"]}
    first = fuse(rankings)
    second = fuse(dict(reversed(list(rankings.items()))))

    assert first == second
    # `p` and `r` have the same fused score — first in one list, last in the
    # other — so they tie, and a tie breaks by key rather than by dictionary
    # order. `q` is genuinely lower: second in both is worth less than
    # first-plus-last.
    assert [key for key, _, _ in first] == ["p", "r", "q"]


def test_fusion_uses_rank_not_raw_score() -> None:
    """`1/(k+1)` beats `1/(k+2)`, and the constant is the published one."""
    fused = fuse({"only": ["first", "second"]})
    assert fused[0][0] == "first"
    assert fused[0][1] == pytest.approx(1 / (RRF_K + 1))


def test_fusion_reports_which_queries_found_a_chunk() -> None:
    fused = fuse({"raw:0": ["a"], "entity:1": ["a"]})
    key, _, contributors = fused[0]

    assert key == "a"
    assert set(contributors) == {"raw:0", "entity:1"}


# --- the rewrite trigger ------------------------------------------------------


def test_an_empty_result_asks_for_a_rewrite() -> None:
    assert needs_rewrite("anything", []) == (True, ["no_match"])


def test_a_cross_script_question_asks_for_a_rewrite(corpus) -> None:
    """A Chinese question against an English index: knowable without a model."""
    ir, directory = corpus
    bundle = retrieve(ir, directory, query="如何解决退化问题", scope=Scope(type="whole_paper"))

    # Nothing matched at all, which is itself the trigger.
    assert bundle.diagnostics.suggest_rewrite
    assert bundle.diagnostics.rewrite_reasons == ["no_match"]


def test_an_answered_question_does_not_ask_for_a_rewrite(corpus) -> None:
    """An exact-term lookup must not pay for a provider round trip."""
    ir, directory = corpus
    bundle = retrieve(ir, directory, query="residual learning", scope=Scope(type="whole_paper"))

    assert bundle.diagnostics.suggest_rewrite is False
    assert bundle.diagnostics.rewrite_reasons == []


# --- rewrite output validation ------------------------------------------------


def test_rewrite_output_is_parsed_strictly() -> None:
    assert parse_queries(json.dumps({"queries": ["a b", "c d"]})) == ["a b", "c d"]


def test_a_fenced_rewrite_reply_is_accepted() -> None:
    raw = '```json\n{"queries": ["alpha beta", "gamma delta"]}\n```'
    assert parse_queries(raw) == ["alpha beta", "gamma delta"]


@pytest.mark.parametrize(
    "reply",
    [
        "",                                  # empty
        "I cannot help with that.",          # prose, not the contract
        '{"queries": ["only one"]}',         # below the floor
        '{"queries": "a string"}',           # wrong type
        '{"other": []}',                     # wrong shape
    ],
)
def test_a_reply_that_does_not_meet_the_contract_is_refused(reply: str) -> None:
    """Scraping a phrase out of prose is as likely to lift the refusal."""
    with pytest.raises(RewriteUnavailable):
        parse_queries(reply)


def test_the_rewrite_bound_is_enforced() -> None:
    many = {"queries": [f"phrase {n}" for n in range(20)]}
    assert len(parse_queries(json.dumps(many))) <= 4


def test_a_sentence_longer_than_a_query_is_dropped() -> None:
    reply = json.dumps({"queries": ["short phrase", "x " * 200, "another phrase"]})
    assert parse_queries(reply) == ["short phrase", "another phrase"]


# --- AC-06: the selection fast path -------------------------------------------


def test_a_selection_never_asks_for_a_rewrite(corpus) -> None:
    """A selection is the evidence; a rewrite could not widen it.

    DS-QA-005 will send paragraph ids from a browser selection, and a mapping
    bug that produces ids this document does not have must cost nothing — not a
    provider call spent searching for something the scope forbids finding.
    """
    ir, directory = corpus
    bundle = retrieve(
        ir, directory, query="anything at all",
        scope=Scope(type="selection", paragraph_ids=["not_a_real_paragraph"]),
    )

    assert bundle.items == []
    assert bundle.diagnostics.suggest_rewrite is False
    assert bundle.diagnostics.rewrite_reasons == []


def test_a_selection_ignores_analysis_expansion(corpus) -> None:
    """The entities a selection query would inject can only be searched inside
    the selection, which the query already names in full."""
    ir, directory = corpus
    bundle = retrieve(
        ir, directory, query="What datasets are used for evaluation?",
        analysis=build_analysis(),
        scope=Scope(type="selection", paragraph_ids=["p1", "p2"]),
    )

    assert bundle.diagnostics.query_variants == ["raw"]


# --- AC-10: no corpus-specific hardcoding -------------------------------------


def test_no_benchmark_term_reaches_executable_code() -> None:
    """AC-10, as amended by AC_CHANGE_REQUEST 1.

    The criterion as written was a plain `git grep`, and it matched five files of
    docstrings and comments — including the one recording *why* `MATCH
    'ResNet-50'` is an error, which is the whole justification for sanitisation.
    Satisfying it literally would mean deleting the record of why the code is
    shaped the way it is, and this repository already ruled on that in
    `test_isolation.py`: *"a guard that fires on documentation teaches people to
    delete the documentation."*

    So the guard reads **executed string literals and identifiers**, not prose.
    A paper name in a lookup table is hardcoding; a paper name in a comment that
    explains a parse error is not.
    """
    import ast
    from pathlib import Path

    forbidden = (
        "resnet", "schulman", "cifar", "imagenet", "ppo", "trpo",
        "diffusion policy", "proximal policy optimization",
    )
    qa_root = Path(__file__).resolve().parents[1] / "app" / "qa"

    offenders: list[str] = []
    for source in sorted(qa_root.rglob("*.py")):
        tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))

        docstrings: set[int] = set()
        for node in ast.walk(tree):
            if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
                body = getattr(node, "body", [])
                first = body[0] if body else None
                if (
                    isinstance(first, ast.Expr)
                    and isinstance(first.value, ast.Constant)
                    and isinstance(first.value.value, str)
                ):
                    docstrings.add(id(first.value))

        for node in ast.walk(tree):
            if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
                continue
            if id(node) in docstrings:
                continue
            lowered = node.value.casefold()
            for term in forbidden:
                # Word-bounded: `supported` contains `ppo` and is not a match.
                if re.search(rf"(?<![a-z]){re.escape(term)}(?![a-z])", lowered):
                    offenders.append(f"{source.name}:{node.lineno} {term!r} in a live literal")

    assert not offenders, f"benchmark terms in executable code: {offenders}"


# --- DS-QA-006: term coverage as a ranking signal -----------------------------


class TestCoverage:
    """The signal, its bounds, and what it must not do."""

    def test_coverage_is_the_fraction_of_content_words_present(self) -> None:
        assert coverage("residual learning", "We adopt residual learning.") == 1.0
        assert coverage("residual learning", "We adopt residual mapping.") == 0.5
        assert coverage("residual learning", "Nothing related here.") == 0.0

    def test_stopwords_are_ignored(self) -> None:
        # Otherwise a paragraph repeating "the" would look like an answer.
        assert content_terms("What is the role of a paper") == []
        assert coverage("What is the role of a paper", "the a of") == 0.0

    def test_a_single_digit_is_a_content_term_and_a_single_letter_is_not(self) -> None:
        """The exception that makes `Algorithm 1` findable.

        An academic question names things as `Algorithm 1`, `Figure 3`, `Eq. 4`.
        Dropping the digit leaves only the common word, and every paragraph
        mentioning "algorithm" then ties with the one titled "Algorithm 1 PPO" —
        measured: keeping it lifts a fourth miss and regresses none.
        """
        assert content_terms("Algorithm 1") == ["algorithm", "1"]
        assert content_terms("Figure 3 shows") == ["figure", "3", "shows"]
        # A stray letter is still noise.
        assert content_terms("variable x here") == ["variable", "here"]
        assert coverage("Algorithm 1", "Algorithm 1 PPO, Actor-Critic Style") == 1.0
        assert coverage("Algorithm 1", "In the simplest instantiation of this algorithm") == 0.5

    def test_a_question_with_no_content_terms_scores_zero(self) -> None:
        """A CJK query, or one of pure stopwords, leaves ranking untouched."""
        assert coverage("作者如何解决退化问题？", "residual learning solves it") == 0.0
        assert coverage("what is it", "anything at all") == 0.0

    def test_dotted_and_hyphenated_tokens_are_kept_whole(self) -> None:
        assert content_terms("ResNet-50 and CIFAR-10") == ["resnet-50", "cifar-10"]
        assert coverage("CIFAR-10", "We evaluate on CIFAR-10.") == 1.0

    def test_coverage_breaks_a_tie_that_rrf_leaves_open(self) -> None:
        """The whole point: two candidates at the same fused rank."""
        # Both retrieved once, at the same rank; only one answers the question.
        rankings = {"raw:0": ["generic", "relevant"]}
        without = fuse(rankings)
        assert [key for key, _, _ in without] == ["generic", "relevant"]

        with_coverage = fuse(rankings, coverage={"generic": 0.0, "relevant": 1.0})
        assert [key for key, _, _ in with_coverage] == ["relevant", "generic"]

    def test_coverage_outweighs_the_fused_rank_band(self) -> None:
        """The signal is stronger than "a tie-break", and the tests say so.

        The whole RRF band spans 0.0125 to 0.0313, so a full coverage unit at 0.05
        beats any rank difference. That is the intended behaviour — a candidate
        matching every content word should outrank one that matched none even from
        several ranks back — but it is a larger claim than "it nudges", which is
        what this was first described as. Asserted so the strength is visible.
        """
        rankings = {"raw:0": ["first", "second", "third"]}
        fused = fuse(rankings, coverage={"first": 0.0, "second": 0.0, "third": 1.0})
        assert [key for key, _, _ in fused] == ["third", "first", "second"]

    def test_a_partial_coverage_gain_still_outweighs_a_rank_gap(self) -> None:
        """One more content word is worth more than a few ranks of consensus."""
        rankings = {"raw:0": ["first", "second", "third"]}
        fused = fuse(rankings, coverage={"first": 0.0, "third": 0.34})
        assert [key for key, _, _ in fused][0] == "third"

    def test_fusion_is_unchanged_when_coverage_is_absent(self) -> None:
        """The parameter is additive; every existing caller behaves as before."""
        rankings = {"a:0": ["x", "y"], "b:1": ["y", "x"]}
        assert fuse(rankings) == fuse(rankings, coverage=None)

    def test_fusion_stays_deterministic_with_coverage(self) -> None:
        rankings = {"a:0": ["p", "q", "r"], "b:1": ["r", "q", "p"]}
        first = fuse(rankings, coverage={"p": 0.5, "q": 0.5, "r": 0.5})
        second = fuse(rankings, coverage={"r": 0.5, "q": 0.5, "p": 0.5})
        assert first == second
