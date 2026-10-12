"""Paragraph translation as a background job: kept as it lands, resumable,
bounded, and readable while it runs.

The failure cases are the point. A refused key half-way through must keep the
batches that succeeded and name the failure; starting again must send only what
is missing; a batch the model garbles twice is a gap, not a stop.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from pathlib import Path

import pytest

from app.bilingual import jobs
from app.bilingual.cache import partial_path, read_bilingual, read_partial
from app.bilingual.glossary import GLOSSARY_REQUEST_MARKER
from app.bilingual.pipeline import plan
from app.document.extract import _fingerprint
from app.document.persistence import write_ir
from app.llm.base import LLMProvider
from app.llm.errors import LLMAuthenticationError
from app.llm.models import LLMRequest, LLMResult
from app.mineru.convert import middle_json_to_ir
from app.mineru.jobs import page_geometry
from tests.test_bilingual import an_ir, paragraph, section
from tests.test_mineru import make_pdf, middle_v4


class Translator(LLMProvider):
    """Translates every id it is sent; can be told to fail or garble."""

    protocol = "scripted"

    def __init__(self, *, fail_after: int | None = None, garble_ids: set[str] | None = None,
                 delay: float = 0.0, glossary: list[dict] | str | None = None,
                 glossary_delay: float = 0.0) -> None:
        #: Translation calls only; a glossary request is counted on its own.
        self.calls = 0
        self.glossary = glossary if glossary is not None else []
        self.glossary_calls = 0
        self.glossary_delay = glossary_delay
        self.prompts: list[str] = []
        self.fail_after = fail_after
        self.garble_ids = garble_ids or set()
        self.delay = delay
        self.in_flight = 0
        self.max_in_flight = 0
        self.sent_ids: list[str] = []

    async def generate(self, request: LLMRequest) -> LLMResult:
        if any(GLOSSARY_REQUEST_MARKER in m.content for m in request.messages):
            self.glossary_calls += 1
            if self.glossary_delay:
                await asyncio.sleep(self.glossary_delay)
            if self.fail_after is not None and self.fail_after < 0:
                raise LLMAuthenticationError("key refused")
            text = self.glossary if isinstance(self.glossary, str) else json.dumps({"terms": self.glossary})
            return LLMResult(text=text, model="m", protocol="scripted")
        self.calls += 1
        self.in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self.in_flight)
        try:
            if self.delay:
                await asyncio.sleep(self.delay)
            if self.fail_after is not None and self.calls > self.fail_after:
                raise LLMAuthenticationError("key refused")
            content = next(m.content for m in request.messages if "Paragraphs:" in m.content)
            self.prompts.append(content)
            rows = re.findall(r"^\[([^\]]+)\] (.*)$", content.partition("Paragraphs:")[2], re.MULTILINE)
            ids = [i for i, _ in rows]
            self.sent_ids.extend(ids)
            if self.garble_ids & set(ids):
                return LLMResult(text="not json at all", model="m", protocol="scripted")
            # A model doing its job keeps the formula placeholders it was given.
            body = {"headings": [], "paragraphs": [
                {"id": i, "text": " ".join([f"{i} 的译文", *re.findall(r"⟦m\d+⟧", text)])}
                for i, text in rows
            ]}
            return LLMResult(text=json.dumps(body), model="m", protocol="scripted")
        finally:
            self.in_flight -= 1

    async def test_connection(self):  # pragma: no cover
        raise NotImplementedError


def long_ir():
    """Enough prose for several batches."""
    return an_ir(
        [paragraph(f"p{i:02d}", "word " * 200, section="s1") for i in range(1, 46)],
        [section("s1", "1 Introduction")],
    )


def new_job(ir) -> jobs.TranslationJob:
    return jobs.TranslationJob(document_id="doc_1", content_hash=ir.content_hash, target_language="zh-CN")


class TestTheJob:
    async def test_it_finishes_writes_the_reading_and_clears_its_progress(self, tmp_path: Path) -> None:
        ir = long_ir()
        batches = len(plan(ir).batches)
        assert batches >= 3
        job = await jobs.run(new_job(ir), ir=ir, provider=Translator(), documents_dir=tmp_path)
        assert job.status == "completed"
        assert job.done_batches == job.total_batches == batches
        assert job.translated_paragraphs == job.total_paragraphs == 45
        artifact = read_bilingual(tmp_path, content_hash=ir.content_hash,
                                  ir_pipeline_version=ir.pipeline_version, target_language="zh-CN")
        assert artifact is not None and artifact.status == "READY"
        assert not partial_path(tmp_path, ir.content_hash, "zh-CN").exists()

    async def test_a_refused_key_stops_it_keeps_what_landed_and_resume_sends_only_the_rest(
        self, tmp_path: Path
    ) -> None:
        ir = long_ir()
        first = Translator(fail_after=1)
        job = await jobs.run(new_job(ir), ir=ir, provider=first, documents_dir=tmp_path, concurrency=1)
        assert job.status == "failed" and job.code == "LLM_AUTHENTICATION_ERROR"
        # The LLM layer has already scrubbed the configured key from this message.
        assert job.message == "key refused"

        kept = read_partial(tmp_path, content_hash=ir.content_hash,
                            ir_pipeline_version=ir.pipeline_version, target_language="zh-CN")
        assert kept is not None and len(kept["translated"]) == len(first.sent_ids) > 0

        second = Translator()
        resumed = await jobs.run(new_job(ir), ir=ir, provider=second, documents_dir=tmp_path)
        assert resumed.status == "completed" and resumed.resumed_batches == 1
        assert not set(second.sent_ids) & set(first.sent_ids)
        assert len(set(first.sent_ids) | set(second.sent_ids)) == 45

    async def test_a_garbled_batch_is_a_gap_and_resume_redoes_only_that_batch(self, tmp_path: Path) -> None:
        ir = long_ir()
        bad = plan(ir).batches[1].paragraphs[0].id
        job = await jobs.run(new_job(ir), ir=ir, provider=Translator(garble_ids={bad}), documents_dir=tmp_path)
        assert job.status == "completed" and job.failed_batches == 1
        artifact = read_bilingual(tmp_path, content_hash=ir.content_hash,
                                  ir_pipeline_version=ir.pipeline_version, target_language="zh-CN")
        assert artifact.status == "PARTIAL"
        assert partial_path(tmp_path, ir.content_hash, "zh-CN").exists()

        retry = Translator()
        await jobs.run(new_job(ir), ir=ir, provider=retry, documents_dir=tmp_path)
        assert set(retry.sent_ids) == {p.id for p in plan(ir).batches[1].paragraphs}

    async def test_stopping_keeps_what_landed_and_the_reading_shows_it(self, tmp_path: Path) -> None:
        ir = long_ir()
        provider = Translator(delay=0.05)
        jobs.start(document_id="doc_1", ir=ir, provider=provider, documents_dir=tmp_path,
                   target_language="zh-CN", concurrency=1)
        while provider.calls < 2:
            await asyncio.sleep(0.01)
        job = await jobs.stop(ir.content_hash, "zh-CN")
        assert job.status == "cancelled"
        snapshot = jobs.snapshot(ir, tmp_path, "zh-CN")
        assert snapshot is not None
        statuses = {p.status for p in snapshot.paragraphs}
        # Stopped, so the rest is missing rather than "on its way".
        assert statuses == {"translated", "untranslated"}

    async def test_a_job_is_readable_before_its_first_batch_lands(self, tmp_path: Path) -> None:
        # Seen live: the column asked right after starting, was told there was
        # no reading, and went back to "generate" while the job ran on.
        ir = long_ir()
        assert jobs.snapshot(ir, tmp_path, "zh-CN") is None  # nothing running, nothing stored
        provider = Translator(delay=0.2)
        jobs.start(document_id="doc_1", ir=ir, provider=provider, documents_dir=tmp_path,
                   target_language="zh-CN", concurrency=1)
        try:
            await asyncio.sleep(0)
            assert read_partial(tmp_path, content_hash=ir.content_hash,
                                ir_pipeline_version=ir.pipeline_version, target_language="zh-CN") is None
            snapshot = jobs.snapshot(ir, tmp_path, "zh-CN")
            assert snapshot is not None and len(snapshot.paragraphs) == 45
            assert {p.status for p in snapshot.paragraphs} == {"pending"}
        finally:
            await jobs.stop(ir.content_hash, "zh-CN")

    async def test_concurrency_is_bounded(self, tmp_path: Path) -> None:
        ir = long_ir()
        provider = Translator(delay=0.02)
        await jobs.run(new_job(ir), ir=ir, provider=provider, documents_dir=tmp_path, concurrency=2)
        assert provider.max_in_flight == 2
        capped = Translator(delay=0.02)
        await jobs.run(new_job(ir), ir=ir, provider=capped, documents_dir=tmp_path / "b", concurrency=99)
        assert capped.max_in_flight <= jobs.MAX_CONCURRENCY


# --- over HTTP ----------------------------------------------------------------


@pytest.fixture
def paper(client, tmp_path: Path):
    """An imported PDF whose cached IR came from MinerU — no layout model needed."""
    source = make_pdf(tmp_path / "paper.pdf")
    document_id = client.post("/api/documents", json={"path": str(source)}).json()["document_id"]
    ir = middle_json_to_ir(
        middle_v4(), document_id=document_id, content_hash=_fingerprint(source)[0],
        source_filename="paper.pdf", pages=page_geometry(source),
    )
    store = client.app.state.document_store
    write_ir(store.document_dir(document_id), ir)
    profile = client.post("/api/profiles", json={
        "name": "Chat", "base_url": "http://127.0.0.1:1/v1", "model": "m",
    }).json()
    return document_id, profile["id"]


@pytest.fixture
def provider(monkeypatch):
    translator = Translator()

    async def resolve(config, protocol):
        return translator

    import app.llm.detection as detection

    monkeypatch.setattr(detection, "resolve_provider", resolve)
    return translator


def wait_for(client, url: str, done) -> dict:
    deadline = time.monotonic() + 10
    body = client.get(url).json()
    while not done(body) and time.monotonic() < deadline:
        time.sleep(0.05)
        body = client.get(url).json()
    return body


class TestOverHttp:
    def test_start_watch_read_and_retranslate_one_paragraph(self, client, paper, provider) -> None:
        document_id, profile_id = paper
        started = client.post(f"/api/documents/{document_id}/bilingual-text/jobs",
                              json={"profile_id": profile_id})
        assert started.status_code == 202, started.text

        job = wait_for(client, f"/api/documents/{document_id}/bilingual-text/jobs",
                       lambda b: b["status"] != "running")
        assert job["status"] == "completed", job

        reading = client.get(f"/api/documents/{document_id}/bilingual-text").json()
        assert reading["status"] == "READY"
        first = reading["paragraphs"][0]
        assert "的译文" in first["translated_text"]

        # A finished reading is not paid for again.
        again = client.post(f"/api/documents/{document_id}/bilingual-text/jobs",
                            json={"profile_id": profile_id}).json()
        assert again["cached"] is True

        calls = provider.calls
        fixed = client.post(
            f"/api/documents/{document_id}/bilingual-text/paragraphs/{first['paragraph_id']}/retranslate",
            json={"profile_id": profile_id},
        )
        assert fixed.status_code == 200, fixed.text
        assert provider.calls == calls + 1
        assert provider.sent_ids[-1] == first["paragraph_id"]

    def test_a_reference_cannot_be_retranslated(self, client, paper, provider) -> None:
        document_id, profile_id = paper
        reading_ids = client.get(f"/api/documents/{document_id}/ir").json()["paragraphs"]
        ref = next(p["id"] for p in reading_ids if p["text"].startswith("[1]"))
        response = client.post(
            f"/api/documents/{document_id}/bilingual-text/paragraphs/{ref}/retranslate",
            json={"profile_id": profile_id},
        )
        assert response.status_code == 400

    def test_a_parser_profile_is_not_a_translator(self, client, paper, provider) -> None:
        document_id, _ = paper
        parser = client.post("/api/profiles", json={
            "name": "MinerU", "kind": "parser", "base_url": "http://127.0.0.1:8100",
        }).json()
        response = client.post(f"/api/documents/{document_id}/bilingual-text/jobs",
                               json={"profile_id": parser["id"]})
        assert response.status_code == 400
