"""DS-DOC-010 — the formula reconstruction over HTTP.

The surface the criteria name: a `GET` that never reaches a provider, a `POST`
that is the only thing here that spends, a 404 that carries the plan, and a
formulas cache that sits beside the bilingual reading's without touching it.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.llm import accounting
from app.llm.accounting import CountingProvider
from tests.test_api_documents import upload
from tests.test_bilingual import paragraph, section
from tests.test_formulas import ScriptedProvider, formula, number
from tests.test_overview_api import a_pdf, profile_id  # noqa: F401 - a fixture


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


def install_formula_ir(client: TestClient, document_id: str) -> str:
    """Pin a formula-bearing IR where the routes will read it, and return its
    content hash.

    Extraction is expensive, and its layout model decides for itself what a
    formula is; overwriting the stored IR pins the fixture instead. The routes
    reuse a stored IR whose id and pipeline version match (document/service.py),
    so they read exactly this and nothing re-extracts.
    """
    from app.document.models import DocumentIR, DocumentMetadata, PageIR
    from app.document.persistence import ir_path

    directory = client.app.state.settings.documents_dir / document_id
    stored = DocumentIR.model_validate_json(
        ir_path(directory).read_text(encoding="utf-8")
    )
    ir = DocumentIR(
        document_id=stored.document_id,
        content_hash="f" * 64,
        pipeline_version="5",
        source_filename="paper.pdf",
        page_count=1,
        metadata=DocumentMetadata(title="A Paper"),
        pages=[PageIR(
            page_index=0, page_number=1, width_pt=612, height_pt=792,
            rotation=0, has_text=True,
            blocks=[
                formula("b1", 1, "LInfoNCE = -1 / 2B ..."),
                number("n1", 1, "(1)"),
                formula("b2", 1, "LSigLIP = -1 / B ...", bbox=(72.0, 420.0, 400.0, 450.0)),
                number("n2", 1, "(2)", bbox=(500.0, 430.0, 540.0, 450.0)),
            ],
        )],
        paragraphs=[paragraph(
            "p1", "The contrastive loss uses a temperature parameter. " * 10,
            section="s1",
        )],
        sections=[section("s1", "1. Introduction")],
    )
    ir_path(directory).write_text(ir.model_dump_json(indent=2), encoding="utf-8")
    return ir.content_hash


def reading_of(client: TestClient, document_id: str):
    return client.get(f"/api/documents/{document_id}/formulas")


def generate(client: TestClient, document_id: str, profile_id: str, **body):
    return client.post(
        f"/api/documents/{document_id}/formulas",
        json={"profile_id": profile_id, **body},
    )


class TestReading:
    def test_a_paper_with_no_reconstructions_answers_404_with_the_plan(
        self, client: TestClient, counted: CountingProvider
    ) -> None:
        document_id = upload(client, a_pdf()).json()["document_id"]
        assert client.get(f"/api/documents/{document_id}/ir").status_code == 200
        install_formula_ir(client, document_id)

        response = reading_of(client, document_id)
        assert response.status_code == 404, response.text
        body = response.json()["error"]
        assert body["code"] == "FORMULA_NOT_FOUND"
        # The keys the frontend and the criteria agree on — a rename here is a
        # blank number in the reader's upgrade banner, which is how this was found.
        assert body["detail"]["plan"]["total_formulas"] == 2
        assert body["detail"]["plan"]["batch_count"] == 1
        assert body["detail"]["plan"]["character_volume"] > 0
        assert accounting.total() == 0, accounting.summary()

    def test_generating_costs_calls_and_the_second_read_costs_none(
        self, client: TestClient, profile_id: str, counted: CountingProvider
    ) -> None:
        document_id = upload(client, a_pdf()).json()["document_id"]
        assert client.get(f"/api/documents/{document_id}/ir").status_code == 200
        install_formula_ir(client, document_id)

        generated = generate(client, document_id, profile_id)
        assert generated.status_code == 200, generated.text
        body = generated.json()
        assert body["cached"] is False
        assert body["status"] == "READY"
        assert body["total_formulas"] == 2
        assert body["reconstructed_count"] == 2
        # The ledger labels the calls, so a harness can tell what a reader
        # action paid for.
        assert accounting.summary()["by_operation"].get("formula_latex", 0) >= 1
        # Pairing is the reading column's view, assembled in the frontend's
        # reflow stream — the backend leaves the slot empty even though a
        # number block sits on the page.
        assert body["formulas"][0]["equation_number"] is None

        accounting.reset()
        read = reading_of(client, document_id)
        assert read.status_code == 200, read.text
        assert read.json()["cached"] is True
        assert read.json()["formulas"] == body["formulas"]
        assert accounting.total() == 0, accounting.summary()

    def test_a_second_generation_returns_the_cache_instead_of_paying_again(
        self, client: TestClient, profile_id: str, counted: CountingProvider
    ) -> None:
        document_id = upload(client, a_pdf()).json()["document_id"]
        assert client.get(f"/api/documents/{document_id}/ir").status_code == 200
        install_formula_ir(client, document_id)
        assert generate(client, document_id, profile_id).status_code == 200

        accounting.reset()
        again = generate(client, document_id, profile_id)
        assert again.status_code == 200, again.text
        assert again.json()["cached"] is True
        assert accounting.total() == 0, accounting.summary()

    def test_the_payload_carries_each_formula_verbatim(
        self, client: TestClient, profile_id: str, counted: CountingProvider
    ) -> None:
        document_id = upload(client, a_pdf()).json()["document_id"]
        assert client.get(f"/api/documents/{document_id}/ir").status_code == 200
        install_formula_ir(client, document_id)

        body = generate(client, document_id, profile_id).json()
        first = body["formulas"][0]
        assert first["raw_soup"].startswith("LInfoNCE")
        assert first["source_anchor_id"] == "fx_b1"
        assert first["page_number"] == 1
        assert isinstance(first["bbox"], list)
        assert first["status"] == "reconstructed"
        assert first["latex"].strip()


class TestFailure:
    def test_a_run_in_progress_is_refused_rather_than_paid_for_twice(
        self, client: TestClient, profile_id: str, counted: CountingProvider
    ) -> None:
        document_id = upload(client, a_pdf()).json()["document_id"]
        assert client.get(f"/api/documents/{document_id}/ir").status_code == 200
        content_hash = install_formula_ir(client, document_id)

        from app.api import formulas as module

        module._IN_FLIGHT.add(content_hash)
        try:
            response = generate(client, document_id, profile_id)
            assert response.status_code == 409, response.text
            assert response.json()["error"]["code"] == "GENERATION_ALREADY_IN_PROGRESS"
            assert accounting.total() == 0, accounting.summary()
        finally:
            module._IN_FLIGHT.discard(content_hash)

    def test_an_unusable_answer_answers_a_failed_artifact_not_nothing(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch, profile_id: str
    ) -> None:
        from app.llm import detection

        provider = CountingProvider(ScriptedProvider("not json", "still not json"))

        async def resolved(*_args, **_kwargs):
            return provider

        monkeypatch.setattr(detection, "resolve_provider", resolved)
        document_id = upload(client, a_pdf()).json()["document_id"]
        assert client.get(f"/api/documents/{document_id}/ir").status_code == 200
        install_formula_ir(client, document_id)

        response = generate(client, document_id, profile_id)
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["status"] == "FAILED"
        assert body["reconstructed_count"] == 0
        # And the gap is said out loud rather than shown as mathematics.
        assert all(item["status"] == "failed" and item["error_reason"] for item in body["formulas"])
        assert body["notes"]
        # Nothing was written, so the next read answers the plan again rather
        # than serving a failed artifact forever.
        assert reading_of(client, document_id).status_code == 404


class TestCacheIsolation:
    def test_generating_formulas_leaves_the_bilingual_reading_untouched(
        self, client: TestClient, profile_id: str, counted: CountingProvider
    ) -> None:
        """AC-P0-01: the reader's paid-for translation is untouched by
        reconstruction — bytes and mtime both."""
        from app.bilingual.cache import bilingual_path, write_bilingual
        from app.bilingual.models import BilingualArtifact, BilingualParagraph
        from app.formulas.cache import formulas_path

        document_id = upload(client, a_pdf()).json()["document_id"]
        assert client.get(f"/api/documents/{document_id}/ir").status_code == 200
        content_hash = install_formula_ir(client, document_id)

        directory = client.app.state.settings.documents_dir
        write_bilingual(directory, BilingualArtifact(
            content_hash=content_hash, target_language="zh-CN", status="READY",
            ir_pipeline_version="5",
            paragraphs=[BilingualParagraph(
                paragraph_id="p_1", page_number=1, source_text="Prose.",
                translated_text="译文。",
            )],
        ))
        bilingual = bilingual_path(directory, content_hash, "zh-CN")
        before_bytes = bilingual.read_bytes()
        before_mtime = bilingual.stat().st_mtime_ns

        assert generate(client, document_id, profile_id).status_code == 200

        assert bilingual.read_bytes() == before_bytes
        assert bilingual.stat().st_mtime_ns == before_mtime
        assert formulas_path(directory, content_hash).is_file()
