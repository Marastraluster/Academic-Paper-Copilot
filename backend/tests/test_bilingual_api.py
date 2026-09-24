"""DS-DOC-006 — the paragraph reading over HTTP.

The surface the criteria name: a `GET` that never reaches a provider, a `POST`
that is the only thing here that spends, a `plan` route that answers what a run
would cost before it happens, and a cache that survives the row it was made from.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.bilingual.cache import bilingual_path
from app.llm import accounting
from app.llm.accounting import CountingProvider
from tests.test_api_documents import upload
from tests.test_bilingual import ScriptedProvider, an_ir, paragraph, section
from tests.test_overview_api import a_pdf, install, profile_id  # noqa: F401 - a fixture


@pytest.fixture(autouse=True)
def clean_ledger():
    accounting.reset()
    yield
    accounting.reset()


@pytest.fixture
def counted(monkeypatch: pytest.MonkeyPatch) -> CountingProvider:
    """The scripted provider, counted — the ledger is the measurement."""
    from app.llm import detection

    provider = CountingProvider(ScriptedProvider())

    async def resolved(*_args, **_kwargs):
        return provider

    monkeypatch.setattr(detection, "resolve_provider", resolved)
    return provider


def reading_of(client: TestClient, document_id: str, language: str = "zh-CN"):
    return client.get(
        f"/api/documents/{document_id}/bilingual-text?target_language={language}"
    )


def generate(client: TestClient, document_id: str, profile_id: str, **body):
    return client.post(
        f"/api/documents/{document_id}/bilingual-text",
        json={"profile_id": profile_id, **body},
    )


class TestReading:
    def test_a_paper_with_no_reading_answers_404(
        self, client: TestClient, counted: CountingProvider
    ) -> None:
        document_id = upload(client, a_pdf()).json()["document_id"]

        response = reading_of(client, document_id)
        assert response.status_code == 404, response.text
        assert response.json()["error"]["code"] == "BILINGUAL_TEXT_NOT_FOUND"
        assert accounting.total() == 0, accounting.summary()

    def test_generating_costs_calls_and_the_second_read_costs_none(
        self, client: TestClient, profile_id: str, counted: CountingProvider
    ) -> None:
        document_id = upload(client, a_pdf()).json()["document_id"]

        generated = generate(client, document_id, profile_id)
        assert generated.status_code == 200, generated.text
        body = generated.json()
        assert body["cached"] is False
        assert body["status"] in ("READY", "PARTIAL")
        assert body["total_paragraphs"] >= 1
        calls_for_generation = accounting.total()
        assert calls_for_generation >= 1, accounting.summary()

        accounting.reset()
        read = reading_of(client, document_id)
        assert read.status_code == 200, read.text
        assert read.json()["cached"] is True
        assert read.json()["paragraphs"] == body["paragraphs"]
        assert accounting.total() == 0, accounting.summary()

    def test_a_second_generation_returns_the_cache_instead_of_paying_again(
        self, client: TestClient, profile_id: str, counted: CountingProvider
    ) -> None:
        document_id = upload(client, a_pdf()).json()["document_id"]
        assert generate(client, document_id, profile_id).status_code == 200

        accounting.reset()
        again = generate(client, document_id, profile_id)
        assert again.status_code == 200, again.text
        assert again.json()["cached"] is True
        assert accounting.total() == 0, accounting.summary()

    def test_the_answer_that_there_is_nothing_yet_carries_the_cost(
        self, client: TestClient, profile_id: str
    ) -> None:
        """One read answers both questions: nothing to show, and what showing one
        would cost. Computed from the IR by the same `plan()` the pipeline runs,
        so the disclosure and the work cannot disagree."""
        document_id = upload(client, a_pdf()).json()["document_id"]

        response = reading_of(client, document_id)
        assert response.status_code == 404, response.text
        plan_body = response.json()["error"]["detail"]["plan"]
        assert plan_body["batches"] >= 1
        assert plan_body["paragraphs"] >= 1
        assert plan_body["characters"] > 0
        assert accounting.total() == 0, accounting.summary()

    def test_the_payload_carries_source_and_translation_side_by_side(
        self, client: TestClient, profile_id: str, counted: CountingProvider
    ) -> None:
        document_id = upload(client, a_pdf()).json()["document_id"]
        body = generate(client, document_id, profile_id).json()

        first = body["paragraphs"][0]
        assert first["source_text"].strip()
        assert first["status"] in ("translated", "skipped", "untranslated")
        assert first["page_number"] >= 1
        assert "paragraph_id" in first
        # The geometry travels so a click can put the reader on the paragraph.
        assert isinstance(first["bboxes"], list)


class TestCacheIdentity:
    def test_a_reimport_after_deleting_the_row_reads_for_free(
        self, client: TestClient, profile_id: str, counted: CountingProvider
    ) -> None:
        data = a_pdf()
        first = upload(client, data).json()["document_id"]
        generated = generate(client, first, profile_id)
        assert generated.status_code == 200, generated.text
        content_hash = generated.json()["content_hash"]

        assert client.delete(f"/api/documents/{first}").status_code == 204
        cached = bilingual_path(
            client.app.state.settings.documents_dir, content_hash, "zh-CN"
        )
        assert cached.is_file(), "the reading outlived the row it was made from"

        second = upload(client, data).json()["document_id"]
        assert second != first
        accounting.reset()
        found = reading_of(client, second)
        assert found.status_code == 200, found.text
        assert found.json()["content_hash"] == content_hash
        assert accounting.total() == 0, accounting.summary()

    def test_another_language_is_a_different_reading(
        self, client: TestClient, profile_id: str, counted: CountingProvider
    ) -> None:
        document_id = upload(client, a_pdf()).json()["document_id"]
        assert generate(client, document_id, profile_id, target_language="zh-CN").status_code == 200

        assert reading_of(client, document_id, "en").status_code == 404
        assert generate(client, document_id, profile_id, target_language="en").status_code == 200

        content_hash = reading_of(client, document_id).json()["content_hash"]
        documents_dir = client.app.state.settings.documents_dir
        assert bilingual_path(documents_dir, content_hash, "en").is_file()
        assert bilingual_path(documents_dir, content_hash, "zh-CN").is_file()


class TestFailure:
    def test_a_run_in_progress_is_refused_rather_than_paid_for_twice(
        self, client: TestClient, profile_id: str, counted: CountingProvider
    ) -> None:
        document_id = upload(client, a_pdf()).json()["document_id"]
        # The extraction is lazy: reading the IR is what writes ir.json.
        assert client.get(f"/api/documents/{document_id}/ir").status_code == 200
        ir_hash = json.loads(
            (client.app.state.settings.documents_dir / document_id / "ir.json").read_text(
                encoding="utf-8"
            )
        )["content_hash"]

        from app.api import bilingual as module

        module._IN_FLIGHT.add((ir_hash, "zh-CN"))
        try:
            response = generate(client, document_id, profile_id)
            assert response.status_code == 409, response.text
            assert response.json()["error"]["code"] == "GENERATION_ALREADY_IN_PROGRESS"
            assert accounting.total() == 0, accounting.summary()
        finally:
            module._IN_FLIGHT.discard((ir_hash, "zh-CN"))

    def test_an_unusable_answer_leaves_a_partial_reading_not_nothing(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch, profile_id: str
    ) -> None:
        from app.llm import detection

        provider = CountingProvider(ScriptedProvider("not json", "still not json"))

        async def resolved(*_args, **_kwargs):
            return provider

        monkeypatch.setattr(detection, "resolve_provider", resolved)
        document_id = upload(client, a_pdf()).json()["document_id"]

        response = generate(client, document_id, profile_id)
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["status"] == "PARTIAL"
        assert body["translated_paragraphs"] == 0
        # And the gap is said out loud rather than shown as prose.
        assert all(item["status"] != "translated" for item in body["paragraphs"])
        assert body["notes"]


class TestTheGlossary:
    """AC-P1-05: the context pipeline's terminology, when it happens to exist.

    Best effort in both directions — offered when it is there, and never a reason
    to wait or to fail when it is not.
    """

    def _write_analysis(self, client: TestClient, document_id: str, *, with_term: bool) -> None:
        from app.context.models import (
            AnalysisStatus,
            DocumentAnalysis,
            GlossaryEntry,
        )
        from app.context.persistence import write_analysis
        from tests.test_context_analysis import provenance

        store_dir = client.app.state.settings.documents_dir / document_id
        write_analysis(store_dir, DocumentAnalysis(
            document_id=document_id,
            provenance=provenance(),
            status=AnalysisStatus.READY,
            glossary=[GlossaryEntry(
                source_term="GLOSSARY_MARKER",
                suggested_translation="术语标记",
                is_translatable=True,
            )] if with_term else [],
        ))

    def test_the_glossary_is_offered_to_the_model(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch, profile_id: str
    ) -> None:
        from app.llm import detection

        provider = ScriptedProvider()

        async def resolved(*_args, **_kwargs):
            return provider

        monkeypatch.setattr(detection, "resolve_provider", resolved)
        document_id = upload(client, a_pdf()).json()["document_id"]
        self._write_analysis(client, document_id, with_term=True)

        assert generate(client, document_id, profile_id).status_code == 200
        sent = " ".join(
            message.content for request in provider.requests for message in request.messages
        )
        assert "GLOSSARY_MARKER" in sent
        assert "术语标记" in sent

    def test_a_paper_without_one_reads_the_same(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch, profile_id: str
    ) -> None:
        from app.llm import detection

        provider = ScriptedProvider()

        async def resolved(*_args, **_kwargs):
            return provider

        monkeypatch.setattr(detection, "resolve_provider", resolved)
        document_id = upload(client, a_pdf()).json()["document_id"]

        response = generate(client, document_id, profile_id)
        assert response.status_code == 200, response.text
        sent = " ".join(
            message.content for request in provider.requests for message in request.messages
        )
        assert "GLOSSARY_MARKER" not in sent


class TestThePrompt:
    def test_the_bibliography_and_formulas_never_reach_a_provider(
        self, client: TestClient, profile_id: str, counted: CountingProvider, tmp_path
    ) -> None:
        """The one test that reads the request itself: a bibliography line and a
        formula must not be in it, whatever else is."""
        from app.document.models import DocumentIR
        from tests.test_bilingual import block

        ir = an_ir(
            [paragraph("p1", "Body text " * 20, section="s1"),
             paragraph("p2", "Vaswani et al. 2017. " * 20, page=2, section="s2")],
            [section("s1", "1. Introduction"), section("s2", "References", 2, references=True)],
            blocks=[block("b9", 1, "FORMULA_MARKER", layout_class="isolate_formula")],
            pages=2,
        )
        document_id = upload(client, a_pdf()).json()["document_id"]
        from app.bilingual.pipeline import generate_bilingual

        provider = ScriptedProvider()
        import asyncio

        asyncio.run(generate_bilingual(ir, provider, target_language="zh-CN"))
        sent = "\n".join(
            message.content for request in provider.requests for message in request.messages
        )
        assert "Vaswani" not in sent
        assert "FORMULA_MARKER" not in sent
        assert "Body text" in sent
