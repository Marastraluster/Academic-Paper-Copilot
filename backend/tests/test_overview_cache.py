"""DS-QA-015 Phase 4-10 — the cache, addressed by what it is about.

The defect this replaces is reproduced in `test_analysis_cache_identity.py`: an
artifact stored under the document *row* is unreachable the moment the paper is
reopened. These tests are the same scenario against the new store, plus the
distinction the design rests on — what invalidates an overview versus what is
only recorded beside it.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from app.overview.cache import (
    STALE_TEMP_SECONDS,
    TEMP_PREFIX,
    cache_is_compatible,
    delete_overview,
    overview_dir,
    overview_path,
    read_overview,
    remove_temp_files,
    write_overview,
)
from app.overview.models import (
    OVERVIEW_SCHEMA_VERSION,
    READER_OVERVIEW_PROMPT_VERSION,
    EvidenceRef,
    KeyTerm,
    OverviewItem,
    ReaderOverview,
)

HASH_A = "a" * 64
HASH_B = "b" * 64


def an_overview(**over) -> ReaderOverview:
    base = dict(
        content_hash=HASH_A,
        target_language="zh-CN",
        status="READY",
        ir_pipeline_version="5",
        provider_model="deepseek-flash",
        provider_base_url="https://api.deepseek.com",
        created_at="2026-09-19T00:00:00+00:00",
        source_sections=["1. Introduction"],
        items=[
            OverviewItem(
                category="core_idea", text="残差学习框架。",
                evidence=(EvidenceRef("p_1", 1),),
            ),
        ],
        key_terms=[KeyTerm(term="ResNet-50", definition="一个模型。",
                           evidence=(EvidenceRef("p_2", 3),))],
    )
    base.update(over)
    return ReaderOverview(**base)


def store(root: Path) -> dict:
    return {
        "content_hash": HASH_A, "ir_pipeline_version": "5", "target_language": "zh-CN",
    }


class TestTheCacheIsReachableByContent:
    def test_the_directory_the_paper_was_opened_in_is_irrelevant(self) -> None:
        """The whole defect, inverted.

        Two separate trees stand for two document rows. Under the old scheme the
        artifact lived inside one of them; here it is addressed by content and the
        directory is not part of the question.
        """
        with tempfile.TemporaryDirectory() as root:
            # A row directory, a sibling that is not one, and the cache beside
            # both — the lookup never mentions any of them.
            (Path(root) / "doc_1").mkdir()
            (Path(root) / "doc_2").mkdir()
            write_overview(Path(root), an_overview())

            found = read_overview(Path(root), **store(Path(root)))
            assert found is not None
            assert found.items[0].text == "残差学习框架。"
            assert found.key_terms[0].term == "ResNet-50"

    def test_it_lives_beside_the_document_directories(self) -> None:
        """A cache one level deeper would be reachable only through the row that
        produced it, which is the defect restated."""
        with tempfile.TemporaryDirectory() as root:
            path = overview_path(Path(root), HASH_A, "zh-CN")
            assert path.parent == overview_dir(Path(root))
            # Under the documents directory, and beside every row directory in
            # it rather than inside one.
            assert Path(root) in path.parents
            assert path.parents[len(path.parents) - len(Path(root).parents) - 1] == Path(root)
            assert "doc_" not in str(path)

    def test_a_different_content_hash_does_not_reuse_the_cache(self) -> None:
        """Same filename, different bytes, is a different paper."""
        with tempfile.TemporaryDirectory() as root:
            write_overview(Path(root), an_overview())
            assert read_overview(
                Path(root), content_hash=HASH_B,
                ir_pipeline_version="5", target_language="zh-CN",
            ) is None

    def test_two_languages_coexist(self) -> None:
        """Chinese prose and English prose are different documents, not different
        opinions of the same one — and switching the interface must not destroy
        the overview already paid for in the other language."""
        with tempfile.TemporaryDirectory() as root:
            write_overview(Path(root), an_overview(target_language="zh-CN"))
            write_overview(Path(root), an_overview(target_language="en"))

            zh = read_overview(Path(root), content_hash=HASH_A,
                               ir_pipeline_version="5", target_language="zh-CN")
            en = read_overview(Path(root), content_hash=HASH_A,
                               ir_pipeline_version="5", target_language="en")
            assert zh is not None and en is not None
            assert overview_path(Path(root), HASH_A, "zh-CN") != overview_path(
                Path(root), HASH_A, "en"
            )


class TestWhatInvalidates:
    def test_a_prompt_change_invalidates(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            write_overview(Path(root), an_overview(prompt_version="0.9.0"))
            assert read_overview(Path(root), **store(Path(root))) is None

    def test_a_schema_change_invalidates(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            write_overview(Path(root), an_overview(schema_version="0"))
            assert read_overview(Path(root), **store(Path(root))) is None

    def test_a_pipeline_change_invalidates(self) -> None:
        """A third axis, and a real one: the prompt can be unchanged while the
        code around it changes what the answer becomes. The reader would be
        shown a run this pipeline no longer produces."""
        with tempfile.TemporaryDirectory() as root:
            write_overview(Path(root), an_overview(pipeline_version="0.9.0"))
            assert read_overview(Path(root), **store(Path(root))) is None

    def test_an_artifact_written_before_the_dimension_existed_still_reads(self) -> None:
        """It was written by the only pipeline version there has ever been.
        Reading it as empty would charge the reader for a rename."""
        with tempfile.TemporaryDirectory() as root:
            write_overview(Path(root), an_overview())
            path = overview_path(Path(root), HASH_A, "zh-CN")
            payload = json.loads(path.read_text(encoding="utf-8"))
            del payload["pipeline_version"]
            path.write_text(json.dumps(payload), encoding="utf-8")

            assert read_overview(Path(root), **store(Path(root))) is not None

    def test_a_re_extraction_invalidates(self) -> None:
        """Evidence ids are paragraph ids, and an extraction change renumbers
        them — DS-DOC-002 measured 145 of 160. An overview from a previous
        extraction points at text that has moved."""
        with tempfile.TemporaryDirectory() as root:
            write_overview(Path(root), an_overview(ir_pipeline_version="4"))
            assert read_overview(Path(root), **store(Path(root))) is None

    def test_a_failure_is_not_an_overview(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            write_overview(Path(root), an_overview(status="FAILED"))
            assert read_overview(Path(root), **store(Path(root))) is None

    def test_a_partial_is_still_worth_showing(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            write_overview(Path(root), an_overview(status="PARTIAL"))
            found = read_overview(Path(root), **store(Path(root)))
            assert found is not None and found.status == "PARTIAL"

    def test_reported_usage_survives_the_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            write_overview(Path(root), an_overview(input_tokens=1200, output_tokens=340))
            found = read_overview(Path(root), **store(Path(root)))
            assert found is not None
            assert (found.input_tokens, found.output_tokens) == (1200, 340)

    def test_unreported_usage_reads_back_as_absent(self) -> None:
        """Absent, not zero. Zero is a measurement; this is the absence of one,
        and the panel renders the two differently."""
        with tempfile.TemporaryDirectory() as root:
            write_overview(Path(root), an_overview(input_tokens=None, output_tokens=None))
            found = read_overview(Path(root), **store(Path(root)))
            assert found is not None
            assert found.input_tokens is None and found.output_tokens is None

    def test_another_model_does_not_invalidate(self) -> None:
        """A different model produces a different overview, but the one already
        made still describes a paper that has not changed. Throwing it away would
        charge the reader again for a fact that is still true."""
        with tempfile.TemporaryDirectory() as root:
            write_overview(Path(root), an_overview(provider_model="some-old-model"))
            found = read_overview(Path(root), **store(Path(root)))
            assert found is not None
            assert found.provider_model == "some-old-model", (
                "and the reader is told whose reading they are looking at"
            )


class TestBadFilesAreAbsentRatherThanFatal:
    def test_a_corrupt_cache_says_so_in_the_log(self, caplog) -> None:
        """AC-P0-12. "Absent" is the right answer, but a file that exists and
        cannot be read is a different situation from no file at all, and the only
        way anyone finds out is if it is said out loud."""
        import logging

        with tempfile.TemporaryDirectory() as root:
            path = overview_path(Path(root), HASH_A, "zh-CN")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("{not json at all", encoding="utf-8")

            with caplog.at_level(logging.WARNING):
                assert read_overview(Path(root), **store(Path(root))) is None

            assert any(
                "unreadable" in record.message for record in caplog.records
            ), caplog.text
            # And never the file's content: it holds paper prose.
            assert "not json at all" not in caplog.text

    def test_corrupt_json_reads_as_absent(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = overview_path(Path(root), HASH_A, "zh-CN")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("{not json at all", encoding="utf-8")
            assert read_overview(Path(root), **store(Path(root))) is None

    def test_a_truncated_cache_reads_as_absent(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            write_overview(Path(root), an_overview())
            path = overview_path(Path(root), HASH_A, "zh-CN")
            text = path.read_text(encoding="utf-8")
            path.write_text(text[: len(text) // 2], encoding="utf-8")
            assert read_overview(Path(root), **store(Path(root))) is None

    def test_an_unknown_artifact_kind_reads_as_absent(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            write_overview(Path(root), an_overview(artifact_kind="something_else"))
            assert read_overview(Path(root), **store(Path(root))) is None

    def test_a_payload_missing_a_field_reads_as_absent(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            write_overview(Path(root), an_overview())
            path = overview_path(Path(root), HASH_A, "zh-CN")
            payload = json.loads(path.read_text(encoding="utf-8"))
            del payload["content_hash"]
            path.write_text(json.dumps(payload), encoding="utf-8")
            assert read_overview(Path(root), **store(Path(root))) is None


class TestAtomicWrite:
    def test_a_failed_write_leaves_no_file_behind(self) -> None:
        """A killed request must not leave a file that looks valid and is half an
        overview: the next open would render it and the reader would see a
        truncated paper with no way to tell."""
        with tempfile.TemporaryDirectory() as root:
            # A content hash whose filename cannot be created — the write fails
            # after the temporary file exists.
            with pytest.MonkeyPatch.context() as patch:
                import app.overview.cache as cache_module

                def explode(*args, **kwargs):
                    raise OSError("disk filled up")

                patch.setattr(cache_module.json, "loads", explode)
                with pytest.raises(OSError):
                    write_overview(Path(root), an_overview())

            assert not overview_path(Path(root), HASH_A, "zh-CN").is_file()
            assert list(overview_dir(Path(root)).glob("*.tmp")) == [], (
                "the temporary file is cleaned up, not left as litter"
            )

    def test_a_write_leaves_nothing_but_the_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            write_overview(Path(root), an_overview())
            directory = overview_dir(Path(root))
            assert [p.name for p in directory.iterdir()] == [f"{HASH_A}_zh-CN.json"]

    def test_the_stored_file_is_readable_json_in_the_frozen_shape(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            write_overview(Path(root), an_overview())
            payload = json.loads(
                overview_path(Path(root), HASH_A, "zh-CN").read_text(encoding="utf-8")
            )
            assert payload["artifact_kind"] == "reader_overview"
            assert payload["schema_version"] == OVERVIEW_SCHEMA_VERSION
            assert payload["prompt_version"] == READER_OVERVIEW_PROMPT_VERSION
            assert payload["items"][0]["evidence"] == [
                {"paragraph_id": "p_1", "page_number": 1}
            ]

    def test_a_killed_process_leaves_nothing_behind_forever(self) -> None:
        """AC-P0-14. A write that dies mid-flight leaves a temporary file, and
        nothing in the process that died will ever clean it up. The next write
        does, once the file is old enough that no live writer could own it."""
        with tempfile.TemporaryDirectory() as root:
            directory = overview_dir(Path(root))
            directory.mkdir(parents=True, exist_ok=True)
            stale = directory / f"{TEMP_PREFIX}abc123.tmp"
            fresh = directory / f"{TEMP_PREFIX}def456.tmp"
            stale.write_text('{"half an ov', encoding="utf-8")
            fresh.write_text('{"half an ov', encoding="utf-8")

            import os
            import time

            old = time.time() - STALE_TEMP_SECONDS - 60
            os.utime(stale, (old, old))

            write_overview(Path(root), an_overview())

            assert not stale.exists(), "the stale temporary file was left behind"
            assert fresh.exists(), "an in-flight write was destroyed by the sweep"
            assert overview_path(Path(root), HASH_A, "zh-CN").is_file()
            assert read_overview(Path(root), **store(Path(root))) is not None

    def test_the_sweep_never_raises_on_an_unreadable_directory(self) -> None:
        """Housekeeping must not be the reason a paid-for write fails."""
        with tempfile.TemporaryDirectory() as root:
            assert remove_temp_files(Path(root) / "does-not-exist") == []

    def test_deleting_removes_only_that_language(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            write_overview(Path(root), an_overview(target_language="zh-CN"))
            write_overview(Path(root), an_overview(target_language="en"))
            delete_overview(Path(root), HASH_A, "zh-CN")
            assert read_overview(Path(root), content_hash=HASH_A,
                                 ir_pipeline_version="5", target_language="zh-CN") is None
            assert read_overview(Path(root), content_hash=HASH_A,
                                 ir_pipeline_version="5", target_language="en") is not None


class TestCompatibilityContract:
    def test_none_is_never_compatible(self) -> None:
        assert cache_is_compatible(
            None, content_hash=HASH_A, ir_pipeline_version="5", target_language="zh-CN"
        ) is False

    def test_every_invalidation_dimension_is_checked(self) -> None:
        good = an_overview()
        assert cache_is_compatible(
            good, content_hash=HASH_A, ir_pipeline_version="5", target_language="zh-CN"
        ) is True

        for changed in (
            {"content_hash": HASH_B},
            {"ir_pipeline_version": "4"},
            {"target_language": "en"},
        ):
            merged = {
                "content_hash": HASH_A, "ir_pipeline_version": "5",
                "target_language": "zh-CN", **changed,
            }
            assert cache_is_compatible(good, **merged) is False, changed
