"""What was paid for is kept when the paper is parsed again.

A reading is stored by paragraph id, and a new extraction renumbers every
paragraph. Two things must then hold: a converter upgrade rebuilds a MinerU IR
from the result already on disk rather than discarding the parse; and the
paragraphs whose text did not change keep their translations, so only what is
really new is translated — and paid for — again.
"""

from __future__ import annotations

import json
from pathlib import Path

from app.bilingual import jobs
from app.bilingual.cache import read_bilingual, read_partial
from app.bilingual.carry import carry_over
from app.document import service
from app.document.extract import IR_PIPELINE_VERSION
from app.document.persistence import read_ir, write_ir
from app.mineru.convert import MINERU_PIPELINE_VERSION
from app.mineru.jobs import MIDDLE_FILENAME, build_ir_from_result, mineru_dir
from tests.test_bilingual import an_ir, paragraph, section
from tests.test_bilingual_jobs import Translator, new_job, paper, provider, wait_for  # noqa: F401 — fixtures
from tests.test_mineru import make_pdf, middle_v4

FIRST = "Deeper neural networks are more difficult to train. " * 8
SECOND = "We present a residual learning framework to ease the training. " * 8
THIRD = "The plain baselines are inspired by the philosophy of VGG nets. " * 8


def extraction(version: str, texts: dict[str, str]):
    ir = an_ir(
        [paragraph(identifier, text, section="s1") for identifier, text in texts.items()],
        [section("s1", "1 Introduction")],
    )
    ir.pipeline_version = version
    return ir


def identity(ir):
    return dict(content_hash=ir.content_hash, ir_pipeline_version=ir.pipeline_version, target_language="zh-CN")


class TestCarryingAReadingAcross:
    async def test_the_same_sentences_under_new_ids_cost_nothing(self, tmp_path: Path) -> None:
        old = extraction("5", {"p1": FIRST, "p2": SECOND, "p3": THIRD})
        await jobs.run(new_job(old), ir=old, provider=Translator(), documents_dir=tmp_path)
        before = {p.source_text: p.translated_text for p in read_bilingual(tmp_path, **identity(old)).paragraphs}

        # Parsed again: every id moved, and an extractor spaced one differently.
        new = extraction("6", {"x9": FIRST, "x8": SECOND.replace(". ", ".  "), "x7": THIRD})
        assert read_bilingual(tmp_path, **identity(new)) is None
        assert carry_over(new, tmp_path, "zh-CN") == 3

        reading = read_bilingual(tmp_path, **identity(new))
        assert reading is not None and reading.status == "READY"
        assert {p.paragraph_id for p in reading.paragraphs} == {"x9", "x8", "x7"}
        assert next(p for p in reading.paragraphs if p.paragraph_id == "x9").translated_text == before[FIRST]
        assert reading.sections[0].title_translated == "" or reading.sections[0].title == "1 Introduction"
        # Asking again finds this extraction's own reading and does nothing.
        assert carry_over(new, tmp_path, "zh-CN") == 0

    async def test_only_what_really_changed_is_translated_again(self, tmp_path: Path) -> None:
        old = extraction("5", {"p1": FIRST, "p2": SECOND, "p3": THIRD})
        await jobs.run(new_job(old), ir=old, provider=Translator(), documents_dir=tmp_path)

        # MinerU joined two paragraphs and recovered a formula in another.
        new = extraction("mineru-9", {"m1": FIRST, "m2": SECOND + "It lets $F(x)$ be learned.", "m3": THIRD})
        assert carry_over(new, tmp_path, "zh-CN") == 2
        kept = read_partial(tmp_path, **identity(new))
        assert kept is not None and set(kept["translated"]) == {"m1", "m3"}

        again = Translator()
        job = await jobs.run(new_job(new), ir=new, provider=again, documents_dir=tmp_path)
        assert job.status == "completed" and again.sent_ids == ["m2"]
        assert read_bilingual(tmp_path, **identity(new)).status == "READY"

    async def test_nothing_is_done_without_another_reading_or_a_matching_sentence(self, tmp_path: Path) -> None:
        new = extraction("6", {"x1": FIRST})
        assert carry_over(new, tmp_path, "zh-CN") == 0  # the paper has no reading at all

        old = extraction("5", {"p1": SECOND})
        await jobs.run(new_job(old), ir=old, provider=Translator(), documents_dir=tmp_path)
        assert carry_over(new, tmp_path, "zh-CN") == 0  # nothing in common
        assert read_partial(tmp_path, **identity(new)) is None
        # And a reading in another language is another reading.
        same = extraction("6", {"x1": SECOND})
        assert carry_over(same, tmp_path, "en") == 0

    def test_over_http_the_reading_is_there_after_the_paper_is_parsed_again(self, client, paper, provider) -> None:  # noqa: F811
        document_id, profile_id = paper
        base = f"/api/documents/{document_id}/bilingual-text"
        client.post(f"{base}/jobs", json={"profile_id": profile_id})
        wait_for(client, f"{base}/jobs", lambda b: b["status"] != "running")
        first = client.get(base).json()
        assert first["status"] == "READY"
        calls = provider.calls + provider.glossary_calls

        # The same paper under another extraction: ids renumbered, version moved.
        directory = client.app.state.document_store.document_dir(document_id)
        ir = read_ir(directory)
        assert ir.pipeline_version == MINERU_PIPELINE_VERSION
        ir.pipeline_version = IR_PIPELINE_VERSION  # as if read by the in-house extractor instead
        for item in ir.paragraphs:
            item.id = item.id + "_n"
        ir.page_mapping = {p.id: p.page_number for p in ir.paragraphs}
        write_ir(directory, ir)

        again = client.get(base).json()
        assert again["status"] == "READY", again.get("error")
        assert provider.calls + provider.glossary_calls == calls  # nothing was sent
        translated = lambda body: sorted(  # noqa: E731
            p["translated_text"] for p in body["paragraphs"] if p["status"] == "translated")
        assert translated(again) == translated(first)
        assert all(p["paragraph_id"].endswith("_n") for p in again["paragraphs"])


class TestAConverterUpgrade:
    def test_a_stale_mineru_ir_is_rebuilt_from_the_stored_result(self, tmp_path: Path, monkeypatch) -> None:
        source = make_pdf(tmp_path / "paper.pdf")
        directory = tmp_path / "doc_1"
        directory.mkdir()
        stale = build_ir_from_result(middle_v4(), source=source, document_id="doc_1", source_filename="paper.pdf")
        stale.pipeline_version = "mineru-0"  # written by an older converter
        write_ir(directory, stale)
        mineru_dir(directory).mkdir()
        (mineru_dir(directory) / MIDDLE_FILENAME).write_text(json.dumps(middle_v4()), encoding="utf-8")

        def never(*_args, **_kwargs):
            raise AssertionError("the in-house extractor must not replace a MinerU parse")

        monkeypatch.setattr(service, "extract_document_ir", never)
        ir, summary = service.extract_and_store(directory, source, "doc_1")
        assert ir.pipeline_version == MINERU_PIPELINE_VERSION and summary.reused is False
        assert read_ir(directory).pipeline_version == MINERU_PIPELINE_VERSION
        # The paragraph MinerU marked as continuing is still one paragraph: this
        # is the stored result converted again, not a different extraction.
        assert any("no harder to optimise" in p.text and p.text.startswith("We let") for p in ir.paragraphs)

    def test_without_a_stored_result_there_is_nothing_to_rebuild_from(self, tmp_path: Path) -> None:
        source = make_pdf(tmp_path / "paper.pdf")
        directory = tmp_path / "doc_1"
        directory.mkdir()
        stale = build_ir_from_result(middle_v4(), source=source, document_id="doc_1", source_filename="paper.pdf")
        stale.pipeline_version = "mineru-0"
        assert service.rebuild_from_stored_mineru(directory, source, "doc_1", stale) is None
        current = build_ir_from_result(middle_v4(), source=source, document_id="doc_1", source_filename="paper.pdf")
        assert service.rebuild_from_stored_mineru(directory, source, "doc_1", current) is None
        assert service.rebuild_from_stored_mineru(directory, source, "doc_1", None) is None
