"""DS-QA-007 — the dense retrieval experiment, tested deterministically.

Everything here runs offline and without an embedding model. That is deliberate
and it is the same split `test_qa_retrieval.py` uses: a **unit** test must pin the
contract — canonical identity, scope masking, determinism, the shape of the
fusion — and none of those properties become truer because a 470 MB model was
loaded to produce the numbers.

The properties a real model *could* falsify (does a Chinese question actually
find an English paragraph?) are measured by the benchmark, not asserted here.
Phase 65: a semantic claim may not rest on hand-authored fake vectors.

The synthetic vectors below are therefore honest about what they are: they encode
"this passage is close to this query" so that the *plumbing* around them can be
tested for exactness. They say nothing about embedding quality.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from app.document.models import DocumentIR
from app.qa import Scope, retrieve
from app.qa import dense
from app.qa.index import _chunk_rows, ensure_index, index_path
from app.qa.models import EvidenceBundle

from tests.test_qa_retrieval import build_ir


@pytest.fixture
def corpus(tmp_path: Path):
    ir = build_ir()
    directory = tmp_path / "doc_qa"
    directory.mkdir()
    ensure_index(directory, ir)
    return ir, directory


def unit(*values: float) -> np.ndarray:
    """A normalised synthetic vector — the state `rank()` requires."""
    vector = np.asarray(values, dtype=np.float32)
    return vector / np.linalg.norm(vector)


def synthetic_index(ir: DocumentIR, vectors: dict[str, np.ndarray]) -> dense.DenseIndex:
    ids = tuple(chunk_id for chunk_id, _ in dense.corpus(ir))
    matrix = np.stack([vectors[chunk_id] for chunk_id in ids]).astype(np.float32)
    return dense.DenseIndex(
        ids=ids, vectors=matrix, built=True, build_seconds=0.0, load_seconds=0.0
    )


# --- the corpus is the lexical corpus, by construction ------------------------


class TestCanonicalCorpus:
    def test_the_dense_corpus_is_the_lexical_corpus(self, corpus) -> None:
        """Same ids, same texts, same order — the index is the single source.

        Building the dense corpus from `_chunk_rows` is what makes a dense hit and
        a lexical hit for the same paragraph share page, section and block ids
        without a mapping table. If this drifts, hybrid deduplication silently
        stops working and evidence is returned twice under two ids.
        """
        ir, _ = corpus
        from_dense = dense.corpus(ir)
        from_lexical = [(row[0], row[6], row[7]) for row in _chunk_rows(ir)]
        assert [cid for cid, _ in from_dense] == [row[0] for row in from_lexical]
        # The text differs by exactly the section-title prefix decision I adds —
        # and by nothing else, which is the property that matters. A drift in the
        # *body* text would mean the two arms were searching different corpora.
        for (_, embedded), (_, title, raw) in zip(from_dense, from_lexical):
            assert embedded == dense.passage_text(title, raw)

    def test_captions_are_included_because_the_lexical_index_includes_them(
        self, tmp_path: Path
    ) -> None:
        """A dense corpus that disagreed with the lexical one would not compare."""
        ir = build_ir()
        kinds = {row[1] for row in _chunk_rows(ir)}
        assert "paragraph" in kinds
        # A caption row, to prove the corpus is kind-agnostic.
        from app.document.models import PageIR, TextBlockIR

        block = TextBlockIR(
            id="b_cap", page_index=0, page_number=1, layout_class="figure_caption",
            bbox=(0.0, 0.0, 10.0, 10.0), text="Figure 1: a caption.",
        )
        pages = [
            PageIR(page_index=p.page_index, page_number=p.page_number,
                   width_pt=p.width_pt, height_pt=p.height_pt, has_text=p.has_text,
                   blocks=[*p.blocks, block] if p.page_number == 1 else list(p.blocks))
            for p in ir.pages
        ]
        with_caption = ir.model_copy(update={"pages": pages})
        ids = [row[0] for row in _chunk_rows(with_caption)]
        assert "b_cap" in ids
        assert "b_cap" in [cid for cid, _ in dense.corpus(with_caption)]

    def test_the_section_title_is_prepended_to_the_embedded_text(self) -> None:
        """Decision I: a paragraph's subject is often only in its heading."""
        assert dense.passage_text("2. Residual Learning", "Body.") == (
            "2. Residual Learning\nBody."
        )
        assert dense.passage_text("", "Body.") == "Body."


# --- scope is a hard constraint ------------------------------------------------


class TestScopeIsAHardConstraint:
    def test_allowed_ids_uses_the_lexical_paths_own_rule(self, corpus) -> None:
        ir, directory = corpus
        assert dense.allowed_ids(directory, Scope(type="whole_paper")) == {
            chunk_id for chunk_id, _ in dense.corpus(ir)
        }
        page_two = dense.allowed_ids(directory, Scope(type="page", page=2))
        assert page_two == {"p5"}
        assert dense.allowed_ids(directory, Scope(type="section", section_id="s2")) == {
            "p3", "p4"
        }
        assert dense.allowed_ids(
            directory, Scope(type="selection", paragraph_ids=["p1", "p6"])
        ) == {"p1", "p6"}

    def test_a_page_scope_cannot_return_an_out_of_scope_paragraph(self, corpus) -> None:
        """The bug this prevents: scoring the paper, then filtering.

        Under that order an out-of-scope paragraph consumes a rank slot and
        changes what the in-scope evidence is compared against — which is why
        `retrieval.py` opens by naming it.
        """
        ir, directory = corpus
        # p3 is semantically nearest the query, but it is on page 1.
        index = synthetic_index(ir, {
            "p1": unit(0, 1), "p2": unit(0, 1), "p3": unit(1, 0),
            "p4": unit(0, 1), "p5": unit(0, 1), "p6": unit(0, 1),
        })
        allowed = dense.allowed_ids(directory, Scope(type="page", page=2))
        result = dense.rank(index, "anything", allowed=allowed, query_vector=unit(1, 0))
        assert result.order == ("p5",)

    def test_an_empty_scope_is_not_the_same_as_no_scope(self, corpus) -> None:
        """`None` means unconstrained; `set()` means nothing is in scope.

        Conflating them turns a Page scope that matches nothing into a whole-paper
        search — the failure mode where a narrowed question silently gets a
        paper-wide answer.
        """
        ir, _ = corpus
        index = synthetic_index(ir, {
            "p1": unit(1, 0), "p2": unit(1, 0), "p3": unit(1, 0),
            "p4": unit(1, 0), "p5": unit(1, 0), "p6": unit(1, 0),
        })
        constrained = dense.rank(index, "q", allowed=set(), query_vector=unit(1, 0))
        unconstrained = dense.rank(index, "q", allowed=None, query_vector=unit(1, 0))
        assert constrained.order == ()
        assert constrained.candidates_scored == 0
        assert len(unconstrained.order) == len(index.ids)

    def test_selection_scope_ranks_only_the_selected_ids(self, corpus) -> None:
        ir, directory = corpus
        index = synthetic_index(ir, {
            "p1": unit(0, 1), "p2": unit(0, 1), "p3": unit(1, 0),
            "p4": unit(0, 1), "p5": unit(1, 0), "p6": unit(0, 1),
        })
        allowed = dense.allowed_ids(
            directory, Scope(type="selection", paragraph_ids=["p1", "p2"])
        )
        result = dense.rank(index, "q", allowed=allowed, query_vector=unit(1, 0))
        assert set(result.order) <= {"p1", "p2"}


# --- determinism ---------------------------------------------------------------


class TestDeterminism:
    def test_ranking_is_by_similarity_descending(self, corpus) -> None:
        ir, _ = corpus
        index = synthetic_index(ir, {
            "p1": unit(1, 0), "p2": unit(0.9, 0.1), "p3": unit(0.5, 0.5),
            "p4": unit(0.1, 0.9), "p5": unit(0, 1), "p6": unit(0, 1),
        })
        result = dense.rank(index, "q", query_vector=unit(1, 0))
        assert result.order[:2] == ("p1", "p2")
        scores = [score for _, score in result.scores]
        assert scores == sorted(scores, reverse=True)

    def test_equal_similarities_break_on_canonical_id(self, corpus) -> None:
        """Stable, and stable for a reason: a rerun cannot reorder equals."""
        ir, _ = corpus
        index = synthetic_index(ir, {pid: unit(1, 0) for pid in
                                     ("p1", "p2", "p3", "p4", "p5", "p6")})
        first = dense.rank(index, "q", query_vector=unit(1, 0))
        second = dense.rank(index, "q", query_vector=unit(1, 0))
        assert first.order == second.order == ("p1", "p2", "p3", "p4", "p5", "p6")

    def test_the_candidate_depth_is_bounded(self, corpus) -> None:
        """Phase 51: a bounded dense depth, not every paragraph in the paper."""
        ir, _ = corpus
        index = synthetic_index(ir, {pid: unit(1, 0) for pid in
                                     ("p1", "p2", "p3", "p4", "p5", "p6")})
        result = dense.rank(index, "q", limit=3, query_vector=unit(1, 0))
        assert len(result.order) == 3


# --- identity and normalisation ------------------------------------------------


class TestIdentityAndNormalisation:
    def test_similarity_is_an_inner_product_of_normalised_vectors(self, corpus) -> None:
        ir, _ = corpus
        index = synthetic_index(ir, {
            "p1": unit(1, 0), "p2": unit(0, 1), "p3": unit(0, 1),
            "p4": unit(0, 1), "p5": unit(0, 1), "p6": unit(0, 1),
        })
        result = dense.rank(index, "q", query_vector=unit(1, 0))
        scores = dict(result.scores)
        assert scores["p1"] == pytest.approx(1.0, abs=1e-6)
        assert scores["p2"] == pytest.approx(0.0, abs=1e-6)

    def test_dense_returns_canonical_ids_and_nothing_else(self, corpus) -> None:
        """Dense never owns citation metadata; it returns ids and stops."""
        ir, _ = corpus
        index = synthetic_index(ir, {pid: unit(1, 0) for pid in
                                     ("p1", "p2", "p3", "p4", "p5", "p6")})
        result = dense.rank(index, "q", query_vector=unit(1, 0))
        known = {chunk_id for chunk_id, _ in dense.corpus(ir)}
        assert set(result.order) <= known


# --- the cache is invalidated by everything that changes the numbers ----------


class TestCacheFingerprint:
    def test_the_same_inputs_give_the_same_fingerprint(self) -> None:
        ir = build_ir()
        ids = [chunk_id for chunk_id, _ in dense.corpus(ir)]
        assert dense._fingerprint(ir, ids) == dense._fingerprint(ir, ids)

    @pytest.mark.parametrize(
        "field,value",
        [
            ("EMBEDDING_MODEL", "some/other-model"),
            ("EMBEDDING_REVISION", "a-different-revision"),
            ("PIPELINE_VERSION", "2"),
        ],
    )
    def test_a_model_or_pipeline_change_invalidates_every_vector(
        self, monkeypatch: pytest.MonkeyPatch, field: str, value: str
    ) -> None:
        """Phase 43: cache validity is tied to model identity and version.

        Without this, upgrading the model would silently compare new query
        vectors against old document vectors — two different embedding spaces,
        one cosine similarity, and no error to notice.
        """
        ir = build_ir()
        ids = [chunk_id for chunk_id, _ in dense.corpus(ir)]
        before = dense._fingerprint(ir, ids)
        monkeypatch.setattr(dense, field, value)
        assert dense._fingerprint(ir, ids) != before

    def test_a_changed_document_invalidates_every_vector(self) -> None:
        ir = build_ir()
        ids = [chunk_id for chunk_id, _ in dense.corpus(ir)]
        before = dense._fingerprint(ir, ids)
        changed = ir.model_copy(update={"content_hash": "hash-qa-2"})
        assert dense._fingerprint(changed, ids) != before

    def test_a_changed_chunk_set_invalidates_every_vector(self) -> None:
        ir = build_ir()
        ids = [chunk_id for chunk_id, _ in dense.corpus(ir)]
        before = dense._fingerprint(ir, ids)
        assert dense._fingerprint(ir, ids[:-1]) != before


# --- fallback: a missing runtime is never "nothing matched" -------------------


class TestFallback:
    def test_a_missing_model_raises_rather_than_returning_nothing(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Phase 46 and the reason this is an exception, not an empty list.

        Returning `[]` would make "the embedding runtime is absent" and "nothing
        was semantically similar" the same observable, and an evaluation would
        record the second when the first is true.
        """
        monkeypatch.setenv("APC_EMBEDDING_MODEL_DIR", str(tmp_path / "nowhere"))
        monkeypatch.setattr(dense, "_session", None)
        monkeypatch.setattr(dense, "_tokenizer", None)
        with pytest.raises(dense.DenseUnavailable) as raised:
            dense.embed_query("anything")
        assert raised.value.code == "MODEL_MISSING"

    def test_lexical_retrieval_is_unaffected_when_dense_is_unavailable(
        self, corpus, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The experiment must not turn working local QA into an all-or-nothing
        dependency on a model the user may not have downloaded."""
        monkeypatch.setenv("APC_EMBEDDING_MODEL_DIR", "/nonexistent")
        ir, directory = corpus
        bundle = retrieve(ir, directory, query="residual mapping",
                          scope=Scope(type="whole_paper"))
        assert bundle.items
        assert bundle.diagnostics.ranking_strategy == "rrf_coverage"


# --- the hybrid path: fusion, dedup, provenance, and the unchanged default ----


class TestHybridFusion:
    def test_the_default_path_is_untouched(self, corpus) -> None:
        """AC-P0-11 and Phase 3. With no dense ranking, nothing changes."""
        ir, directory = corpus
        plain = retrieve(ir, directory, query="residual mapping",
                         scope=Scope(type="whole_paper"), top_k=10)
        explicit_none = retrieve(ir, directory, query="residual mapping",
                                 scope=Scope(type="whole_paper"), top_k=10,
                                 dense_ranking=None)
        assert [item.paragraph_id for item in plain.items] == [
            item.paragraph_id for item in explicit_none.items
        ]
        assert plain.diagnostics.ranking_strategy == "rrf_coverage"
        assert all(item.sources == ["lexical"] for item in plain.items)

    def test_dense_alone_can_supply_evidence_the_lexical_path_cannot(
        self, corpus
    ) -> None:
        """The point of the whole task, in miniature: a query that matches no
        indexed term, and a dense ranking that finds the paragraph anyway.

        This is a plumbing test, not a semantic claim — the vector is
        hand-authored (Phase 65)."""
        ir, directory = corpus
        lexical = retrieve(ir, directory, query="zzzzunmatchable",
                           scope=Scope(type="whole_paper"), top_k=10)
        assert lexical.items == []

        hybrid = retrieve(ir, directory, query="zzzzunmatchable",
                          scope=Scope(type="whole_paper"), top_k=10,
                          dense_ranking=["p3"])
        # `p4` follows `p3` in the same section, so neighbour expansion attaches
        # it — unchanged production behaviour, and correct: it is the context of
        # the hit, not a second hit. Ranked evidence is the direct hits.
        direct = [item for item in hybrid.items if item.is_direct_hit]
        assert [item.paragraph_id for item in direct] == ["p3"]
        assert direct[0].sources == ["dense"]
        assert hybrid.diagnostics.ranking_strategy == "rrf_coverage_hybrid"
        assert hybrid.diagnostics.dense_candidates_scored == 1

    def test_a_paragraph_found_by_both_paths_is_one_candidate(self, corpus) -> None:
        """Phase 18: deduplication is by canonical id.

        Two retrieval provenance paths, one evidence item — duplicating it would
        spend two of the bounded evidence slots on the same paragraph and push a
        genuinely different one out of the window."""
        ir, directory = corpus
        bundle = retrieve(ir, directory, query="residual mapping",
                          scope=Scope(type="whole_paper"), top_k=10,
                          dense_ranking=["p3", "p4"])
        by_id = [item.paragraph_id for item in bundle.items]
        assert len(by_id) == len(set(by_id))
        p3 = next(item for item in bundle.items if item.paragraph_id == "p3")
        assert set(p3.sources) == {"lexical", "dense"}

    def test_a_dense_id_outside_the_scope_is_dropped(self, corpus) -> None:
        """Defence in depth: even if a caller passes an out-of-scope id, the
        clause is re-applied inside `retrieve` and the id cannot enter."""
        ir, directory = corpus
        bundle = retrieve(ir, directory, query="residual mapping",
                          scope=Scope(type="page", page=2), top_k=10,
                          dense_ranking=["p1", "p3", "p5"])
        assert {item.paragraph_id for item in bundle.items} <= {"p5"}

    def test_an_unknown_dense_id_is_dropped_rather_than_invented(self, corpus) -> None:
        ir, directory = corpus
        bundle = retrieve(ir, directory, query="residual mapping",
                          scope=Scope(type="whole_paper"), top_k=10,
                          dense_ranking=["not-a-real-paragraph"])
        assert all(item.paragraph_id != "not-a-real-paragraph"
                   for item in bundle.items)

    def test_citation_identity_survives_the_hybrid_path(self, corpus) -> None:
        """AC-P0-04/AC-P0-08: page, section and blocks come from the index."""
        ir, directory = corpus
        bundle = retrieve(ir, directory, query="zzzzunmatchable",
                          scope=Scope(type="whole_paper"), top_k=10,
                          dense_ranking=["p3"])
        item = bundle.items[0]
        assert item.paragraph_id == "p3"
        assert item.page_number == 1
        assert item.section_id == "s2"
        assert item.block_ids == ["b_p3"]
        assert item.text == next(p.text for p in ir.paragraphs if p.id == "p3")

    def test_a_scope_that_forbids_a_rewrite_still_forbids_it(self, corpus) -> None:
        """Selection remains explicit evidence: dense does not become a way to
        escape a selection (Phase 21/60)."""
        ir, directory = corpus
        bundle = retrieve(ir, directory, query="zzzzunmatchable",
                          scope=Scope(type="selection", paragraph_ids=["p1"]),
                          top_k=10, dense_ranking=["p3"])
        assert [item.paragraph_id for item in bundle.items] == ["p1"]
        assert bundle.diagnostics.suggest_rewrite is False
