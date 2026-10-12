"""The paper's glossary: read once, given to every batch, and the reader's to fix.

What matters: a term a model invented is not kept; a batch is told only the
terms it contains; a paper's glossary is made once and never silently replaced;
and correcting a term re-translates the paragraphs that contain it — those, and
no others.
"""

from __future__ import annotations

from pathlib import Path

from app.bilingual import jobs
from app.bilingual.cache import (
    bilingual_path, read_bilingual, read_partial, write_bilingual, write_partial,
)
from app.bilingual.glossary import (
    Term, affected_paragraph_ids, changed_sources, clean, extract, occurs, read_terms,
    terms_for, write_terms,
)
from app.bilingual.models import BILINGUAL_PIPELINE_VERSION, BILINGUAL_PROMPT_VERSION
from app.bilingual.pipeline import Batch, generate_bilingual, heading_views_for, plan, translate_batch
from tests.test_bilingual import an_ir, paragraph, section
from tests.test_bilingual_jobs import Translator, new_job, paper, provider, wait_for  # noqa: F401 — fixtures

RESIDUAL = "We adopt residual learning in every few stacked layers. " * 12
SHORTCUT = "Shortcut connections skip one or more layers, and identity shortcuts add no parameters. " * 8
PLAIN = "The plain baselines are inspired by the philosophy of VGG nets and use small filters. " * 8

TERMS = [
    {"source": "residual learning", "target": "残差学习"},
    {"source": "shortcut connection", "target": "捷径连接"},
]


def three_paragraphs():
    return an_ir(
        [
            paragraph("p1", RESIDUAL, section="s1"),
            paragraph("p2", SHORTCUT, section="s1"),
            paragraph("p3", PLAIN, section="s1"),
        ],
        [section("s1", "3 Deep Residual Learning")],
    )


class TestMatching:
    def test_whole_words_any_case_and_plurals(self) -> None:
        assert occurs("shortcut connection", "Shortcut connections skip layers.")
        assert occurs("residual learning", "deep  Residual\nLearning framework")
        # Not inside another word, and not a different term that shares a prefix.
        assert not occurs("gate", "we aggregate the features")
        assert not occurs("deep network", "a deeper network")
        assert occurs("top-1 error", "the top-1 error is 3.57%")

    def test_a_batch_is_given_only_the_terms_it_contains(self) -> None:
        terms = clean(TERMS)
        assert [t.source for t in terms_for([SHORTCUT], terms)] == ["shortcut connection"]
        assert terms_for([PLAIN], terms) == []

    def test_entries_are_cleaned_and_deduplicated(self) -> None:
        terms = clean([
            {"source": "  residual   learning ", "target": "残差学习"},
            {"source": "Residual Learning", "target": "别的译法"},  # the same term again
            {"source": "", "target": "x"}, {"source": "x", "target": ""},
            {"source": "y" * 200, "target": "太长"}, "not an entry", {"source": 3, "target": 4},
        ])
        assert terms == [Term("residual learning", "残差学习")]


class TestExtraction:
    async def test_only_terms_the_paper_contains_are_kept(self) -> None:
        provider = Translator(glossary=[  # noqa: F811
            *TERMS,
            {"source": "attention mechanism", "target": "注意力机制"},  # not in this paper
            {"source": "VGG", "target": "VGG"},  # stays as it is: not a glossary entry
        ])
        terms = await extract(plan(three_paragraphs()), provider, target_language="zh-CN")
        assert [t.source for t in terms] == ["residual learning", "shortcut connection"]
        assert provider.glossary_calls == 1 and provider.calls == 0

    async def test_an_answer_that_is_not_json_is_an_empty_glossary(self) -> None:
        provider = Translator(glossary="Here are some terms you might like!")  # noqa: F811
        assert await extract(plan(three_paragraphs()), provider, target_language="zh-CN") == []


class TestThePrompt:
    async def test_each_batch_carries_its_own_terms_as_an_instruction(self) -> None:
        ir = three_paragraphs()
        work = plan(ir)
        provider = Translator()  # noqa: F811
        p2, p3 = (next(p for b in work.batches for p in b.paragraphs if p.id == i) for i in ("p2", "p3"))
        await translate_batch(Batch(paragraphs=[p2]), heading_views_for(work), provider,
                              target_language="zh-CN", terms=clean(TERMS))
        await translate_batch(Batch(paragraphs=[p3]), heading_views_for(work), provider,
                              target_language="zh-CN", terms=clean(TERMS))
        with_term, without = provider.prompts
        assert "shortcut connection → 捷径连接" in with_term
        assert "residual learning" not in with_term.partition("Section headings:")[0]
        assert "Glossary for this paper" not in without

    async def test_the_one_request_path_uses_a_stored_glossary_too(self) -> None:
        provider = Translator()  # noqa: F811
        await generate_bilingual(three_paragraphs(), provider, target_language="zh-CN", terms=clean(TERMS))
        assert any("residual learning → 残差学习" in prompt for prompt in provider.prompts)

    def test_readings_made_before_glossaries_are_not_reused(self, tmp_path: Path) -> None:
        # The prompt and the pipeline changed, so an older reading answers a
        # different question; both versions moved to say so.
        assert (BILINGUAL_PIPELINE_VERSION, BILINGUAL_PROMPT_VERSION) == ("1.2.0", "1.2.0")
        ir = three_paragraphs()
        identity = dict(content_hash=ir.content_hash, ir_pipeline_version=ir.pipeline_version,
                        target_language="zh-CN")
        import asyncio

        artifact = asyncio.run(generate_bilingual(ir, Translator(), target_language="zh-CN")).artifact
        write_bilingual(tmp_path, artifact)
        write_partial(tmp_path, translated={"p1": "旧"}, headings={}, **identity)
        assert read_bilingual(tmp_path, **identity) is not None

        path = bilingual_path(tmp_path, ir.content_hash, "zh-CN")
        path.write_text(path.read_text(encoding="utf-8").replace('"prompt_version": "1.2.0"',
                                                                 '"prompt_version": "1.1.0"'), encoding="utf-8")
        partial = path.with_name(path.name.replace(".json", ".partial.json"))
        partial.write_text(partial.read_text(encoding="utf-8").replace('"pipeline_version": "1.2.0"',
                                                                       '"pipeline_version": "1.1.0"'),
                           encoding="utf-8")
        assert read_bilingual(tmp_path, **identity) is None
        assert read_partial(tmp_path, **identity) is None


class TestTheJob:
    async def test_the_glossary_is_made_once_and_kept(self, tmp_path: Path) -> None:
        ir = three_paragraphs()
        first = Translator(glossary=TERMS)
        job = await jobs.run(new_job(ir), ir=ir, provider=first, documents_dir=tmp_path, make_glossary=True)
        assert job.status == "completed" and job.glossary_terms == 2 and job.phase == "translating"
        assert first.glossary_calls == 1
        assert read_terms(tmp_path, ir.content_hash, "zh-CN") == clean(TERMS)
        assert any("residual learning → 残差学习" in prompt for prompt in first.prompts)

        # The reader corrects it; a later run must use theirs, not ask again.
        write_terms(tmp_path, ir.content_hash, "zh-CN", [Term("residual learning", "残差式学习")])
        bilingual_path(tmp_path, ir.content_hash, "zh-CN").unlink()
        second = Translator(glossary=TERMS)
        await jobs.run(new_job(ir), ir=ir, provider=second, documents_dir=tmp_path, make_glossary=True)
        assert second.glossary_calls == 0
        assert any("residual learning → 残差式学习" in prompt for prompt in second.prompts)

    async def test_an_empty_glossary_is_remembered_not_asked_for_again(self, tmp_path: Path) -> None:
        ir = three_paragraphs()
        provider = Translator(glossary="no json here")  # noqa: F811
        job = await jobs.run(new_job(ir), ir=ir, provider=provider, documents_dir=tmp_path, make_glossary=True)
        assert job.status == "completed" and job.translated_paragraphs == 3
        assert read_terms(tmp_path, ir.content_hash, "zh-CN") == []

    async def test_a_refused_key_stops_the_job_at_its_first_calls(self, tmp_path: Path) -> None:
        ir = three_paragraphs()
        provider = Translator(fail_after=-1, glossary=TERMS)  # noqa: F811
        job = await jobs.run(new_job(ir), ir=ir, provider=provider, documents_dir=tmp_path, make_glossary=True)
        assert job.status == "failed" and job.code == "LLM_AUTHENTICATION_ERROR"
        # The glossary and the first batches go out together; none got anywhere.
        assert provider.sent_ids == [] and read_terms(tmp_path, ir.content_hash, "zh-CN") is None

    def test_the_first_batch_is_small(self) -> None:
        work = plan(three_paragraphs())
        assert [[p.id for p in batch.paragraphs] for batch in work.batches] == [["p1", "p2"], ["p3"]]

    async def test_translation_does_not_wait_for_the_glossary(self, tmp_path: Path) -> None:
        # The glossary is the slowest call of a run. Here it is still being read
        # when every batch has been sent — and nothing waited for it.
        ir = three_paragraphs()
        provider = Translator(glossary=TERMS, glossary_delay=0.15)  # noqa: F811
        job = await jobs.run(new_job(ir), ir=ir, provider=provider, documents_dir=tmp_path, make_glossary=True)
        assert job.status == "completed" and job.translated_paragraphs == 3 and job.glossary_terms == 2
        first_pass = provider.prompts[:2]
        assert all("Glossary for this paper" not in prompt for prompt in first_pass)
        assert sorted(provider.sent_ids[:3]) == ["p1", "p2", "p3"]
        # Then, one word per term: the two paragraphs that contain a term and
        # did not use its translation go again, with the glossary. `p3` contains
        # no term and is not paid for twice.
        assert sorted(provider.sent_ids[3:]) == ["p1", "p2"] and job.restated_paragraphs == 2
        assert all("Glossary for this paper" in prompt for prompt in provider.prompts[2:])
        assert job.done_batches == job.total_batches == 2 and job.phase == "translating"

    async def test_a_glossary_that_arrives_first_is_simply_used(self, tmp_path: Path) -> None:
        ir = three_paragraphs()
        provider = Translator(glossary=TERMS, delay=0.01)  # noqa: F811
        job = await jobs.run(new_job(ir), ir=ir, provider=provider, documents_dir=tmp_path,
                             make_glossary=True, concurrency=1)
        assert job.status == "completed"
        # The second batch was sent after the terms were known: nothing restated
        # beyond the lead, which went out with them still unread.
        assert provider.sent_ids.count("p3") == 1
        assert any("Glossary for this paper" in prompt for prompt in provider.prompts)

    async def test_early_paragraphs_that_already_agree_are_kept(self, tmp_path: Path) -> None:
        ir = three_paragraphs()
        # The only term is one the first batch does not contain.
        provider = Translator(glossary=[{"source": "plain baselines", "target": "普通基线"}],  # noqa: F811
                              glossary_delay=0.15)
        job = await jobs.run(new_job(ir), ir=ir, provider=provider, documents_dir=tmp_path, make_glossary=True)
        assert job.status == "completed"
        # `p3` contains it and was translated without it: once more. The others: once.
        assert sorted(provider.sent_ids) == ["p1", "p2", "p3", "p3"]

    async def test_only_missing_paragraphs_are_sent_not_their_batch(self, tmp_path: Path) -> None:
        ir = three_paragraphs()
        await jobs.run(new_job(ir), ir=ir, provider=Translator(), documents_dir=tmp_path)
        identity = dict(content_hash=ir.content_hash, ir_pipeline_version=ir.pipeline_version,
                        target_language="zh-CN")
        done = read_bilingual(tmp_path, **identity)
        kept = {p.paragraph_id: p.translated_text for p in done.paragraphs if p.paragraph_id != "p2"}
        write_partial(tmp_path, translated=kept, headings={}, **identity)
        bilingual_path(tmp_path, ir.content_hash, "zh-CN").unlink()

        again = Translator()
        job = await jobs.run(new_job(ir), ir=ir, provider=again, documents_dir=tmp_path)
        assert job.status == "completed" and again.sent_ids == ["p2"]


class TestEditing:
    def test_what_an_edit_touches(self) -> None:
        work = plan(three_paragraphs())
        old = clean(TERMS)
        retargeted = clean([TERMS[0], {"source": "shortcut connection", "target": "快捷连接"}])
        assert changed_sources(old, retargeted) == {"shortcut connection"}
        assert affected_paragraph_ids(work, changed_sources(old, retargeted)) == {"p2"}
        # Adding and removing count; reordering does not.
        assert changed_sources(old, clean(TERMS[:1])) == {"shortcut connection"}
        assert changed_sources(old, clean([*TERMS, {"source": "plain baseline", "target": "普通基线"}])) == {
            "plain baseline"}
        assert changed_sources(old, list(reversed(old))) == set()

    def test_over_http_an_edit_retranslates_only_its_paragraphs(self, client, paper, provider) -> None:  # noqa: F811
        document_id, profile_id = paper
        provider.glossary = [{"source": "deeper network", "target": "更深的网络"}]
        base = f"/api/documents/{document_id}/bilingual-text"
        assert client.get(f"{base}/glossary").json() == {"exists": False, "target_language": "zh-CN", "terms": []}
        # The call that reads the paper for its terms is part of the disclosed cost.
        assert client.get(base).json()["error"]["detail"]["plan"]["glossary_calls"] == 1

        client.post(f"{base}/jobs", json={"profile_id": profile_id})
        job = wait_for(client, f"{base}/jobs", lambda b: b["status"] != "running")
        assert job["status"] == "completed" and job["glossary_terms"] == 1
        assert client.get(f"{base}/glossary").json()["terms"] == [
            {"source": "deeper network", "target": "更深的网络"}]
        reading = client.get(base).json()
        assert reading["status"] == "READY"
        target = next(p for p in reading["paragraphs"] if "deeper network" in p["source_text"])
        others = {p["paragraph_id"]: p["translated_text"] for p in reading["paragraphs"]
                  if p["status"] == "translated" and p["paragraph_id"] != target["paragraph_id"]}
        assert others

        # A term the paper does not contain touches nothing, and costs nothing.
        calls, sent = provider.calls, len(provider.sent_ids)
        untouched = client.post(f"{base}/glossary", json={"terms": [
            {"source": "deeper network", "target": "更深的网络"},
            {"source": "attention", "target": "注意力"},
        ]}).json()
        assert untouched["affected_paragraphs"] == 0
        assert client.get(base).json()["status"] == "READY" and provider.calls == calls

        saved = client.post(f"{base}/glossary", json={"terms": [
            {"source": "deeper network", "target": "深层网络"}]}).json()
        assert saved["affected_paragraphs"] == 1 and provider.calls == calls  # saving spends nothing
        waiting = client.get(base).json()
        assert waiting["resumable"] is True
        gap = next(p for p in waiting["paragraphs"] if p["paragraph_id"] == target["paragraph_id"])
        assert gap["status"] == "untranslated"

        client.post(f"{base}/jobs", json={"profile_id": profile_id})
        job = wait_for(client, f"{base}/jobs", lambda b: b["status"] != "running")
        assert job["status"] == "completed"
        assert provider.sent_ids[sent:] == [target["paragraph_id"]]
        assert "deeper network → 深层网络" in provider.prompts[-1]
        assert provider.glossary_calls == 1  # the reader's glossary was not replaced
        final = client.get(base).json()
        assert final["status"] == "READY"
        assert {p["paragraph_id"]: p["translated_text"] for p in final["paragraphs"]
                if p["paragraph_id"] in others} == others

    def test_extracting_again_is_a_proposal_that_stores_and_touches_nothing(self, client, paper, provider) -> None:  # noqa: F811
        document_id, profile_id = paper
        base = f"/api/documents/{document_id}/bilingual-text"
        provider.glossary = [{"source": "deeper network", "target": "更深的网络"}]
        client.post(f"{base}/jobs", json={"profile_id": profile_id})
        wait_for(client, f"{base}/jobs", lambda b: b["status"] != "running")
        client.post(f"{base}/glossary", json={"terms": [{"source": "deeper network", "target": "深层网络"}]})
        calls = provider.calls

        provider.glossary = [{"source": "deeper network", "target": "较深的网络"},
                             {"source": "attention", "target": "注意力"}]  # the second is not in the paper
        proposed = client.post(f"{base}/glossary/extract", json={"profile_id": profile_id})
        assert proposed.status_code == 200, proposed.text
        assert proposed.json()["terms"] == [{"source": "deeper network", "target": "较深的网络"}]
        assert provider.glossary_calls == 2 and provider.calls == calls
        # The reader's own glossary is still the one on disk.
        assert client.get(f"{base}/glossary").json()["terms"] == [
            {"source": "deeper network", "target": "深层网络"}]
