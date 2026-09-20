"""DS-QA-015 — the reader overview over HTTP.

Every other overview test measures a module. The frozen criteria describe a
*surface*: a `GET` that answers `404` rather than generating, a `POST` that is the
only thing in the application that spends on a reader's behalf, a document row
that can be deleted and re-imported, and a ledger that counts what really crossed
the boundary. Those criteria named HTTP responses that no test had ever asked
for, and this file asks for them.

The provider is replaced at `detection.resolve_provider` and wrapped in the real
`CountingProvider`, so the route, the pipeline, the validation, the cache, the
payload and the accounting all run for real and only the network call is fake.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.document.extract import _fingerprint
from app.llm import accounting
from app.llm.accounting import CountingProvider
from app.overview.cache import overview_path
from tests.test_api_documents import upload

#: What the model would say if it were a model. Every id is one the packet
#: offers, because an invented one is dropped and the run turns PARTIAL.
ANSWER = json.dumps({
    "items": [
        {"category": name, "text": f"{name} 的中文说明。", "evidence": ["E1"]}
        for name in (
            "research_question", "core_idea", "contributions",
            "method", "experiments", "findings", "limitations",
        )
    ],
    "key_terms": [{"term": "ResNet-50", "definition": "残差网络。", "evidence": ["E1"]}],
})


class FakeProvider:
    """A provider that answers without leaving the process."""

    protocol = "chat_completions"

    def __init__(self, *responses: str) -> None:
        self.responses = list(responses) or [ANSWER]
        self.requests: list[object] = []

    async def generate(self, request):  # noqa: ANN001 - provider protocol
        from app.llm.models import LLMResult, LLMUsage

        self.requests.append(request)
        text = self.responses.pop(0) if len(self.responses) > 1 else self.responses[0]
        return LLMResult(
            text=text, model="fake-reader-model", protocol=self.protocol,
            usage=LLMUsage(prompt_tokens=1200, completion_tokens=340, total_tokens=1540),
        )

    async def test_connection(self):  # pragma: no cover - not exercised
        raise NotImplementedError


def _async(value):
    async def resolved(*_args, **_kwargs):
        return value

    return resolved()


def install(monkeypatch: pytest.MonkeyPatch, *responses: str) -> CountingProvider:
    """Put a counted fake where the route resolves its provider."""
    from app.llm import detection

    provider = CountingProvider(FakeProvider(*responses))
    monkeypatch.setattr(detection, "resolve_provider", lambda *a, **k: _async(provider))
    return provider


@pytest.fixture(autouse=True)
def clean_ledger():
    accounting.reset()
    yield
    accounting.reset()


@pytest.fixture
def counted(monkeypatch: pytest.MonkeyPatch) -> CountingProvider:
    return install(monkeypatch)


@pytest.fixture
def profile_id(client: TestClient) -> str:
    response = client.post(
        "/api/profiles",
        json={"name": "Overview Test", "base_url": "http://127.0.0.1:9/v1",
              "model": "fake-reader-model"},
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def a_pdf(text: str = "The policy is optimized through multiple rollouts.") -> bytes:
    """Two pages carrying the given text. Different text, different bytes."""
    import fitz

    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "paper.pdf"
        document = fitz.open()
        for _ in range(2):
            page = document.new_page(width=595, height=842)
            page.insert_text((72, 120), text, fontsize=11)
        document.save(str(path))
        document.close()
        return path.read_bytes()


def overview_of(client: TestClient, document_id: str, language: str = "zh-CN"):
    return client.get(f"/api/documents/{document_id}/overview?target_language={language}")


def generate(client: TestClient, document_id: str, profile_id: str, **body):
    return client.post(
        f"/api/documents/{document_id}/overview",
        json={"profile_id": profile_id, **body},
    )


class TestTheCacheIsAddressedByContent:
    def test_generation_writes_beside_the_document_directories(
        self, client: TestClient, profile_id: str, counted: CountingProvider
    ) -> None:
        """AC-P0-01. The whole defect in one assertion: a cache one level deeper
        is reachable only through the row that produced it."""
        document_id = upload(client, a_pdf()).json()["document_id"]
        response = generate(client, document_id, profile_id)
        assert response.status_code == 200, response.text

        content_hash = response.json()["content_hash"]
        documents_dir = client.app.state.settings.documents_dir
        cached = documents_dir / "_cache" / "overview" / f"{content_hash}_zh-CN.json"

        assert cached.is_file()
        assert cached.parent == documents_dir / "_cache" / "overview"
        assert documents_dir in cached.parents
        assert not (documents_dir / document_id / "overview.json").exists()
        assert "doc_" not in str(cached.parent)

    def test_reopening_the_same_bytes_finds_it_under_a_new_row(
        self, client: TestClient, profile_id: str, counted: CountingProvider
    ) -> None:
        """AC-P0-02. The paid-for artifact, reached through a row it was not
        generated from, without a second provider call."""
        data = a_pdf()
        first = upload(client, data).json()["document_id"]
        generated = generate(client, first, profile_id)
        assert generated.status_code == 200, generated.text

        second = upload(client, data).json()["document_id"]
        assert second != first, "reopening must mint a new row"

        accounting.reset()
        found = overview_of(client, second)
        assert found.status_code == 200, found.text
        assert found.json()["content_hash"] == generated.json()["content_hash"]
        assert found.json()["items"] == generated.json()["items"]
        assert accounting.total() == 0, accounting.summary()

    def test_the_same_name_with_different_bytes_is_a_different_paper(
        self, client: TestClient, profile_id: str, counted: CountingProvider
    ) -> None:
        """AC-P0-03. Same filename is not the same paper."""
        first = upload(client, a_pdf("Paper one body."), name="paper.pdf").json()
        second = upload(client, a_pdf("Paper two body."), name="paper.pdf").json()
        assert first["document_id"] != second["document_id"]

        directory = client.app.state.settings.documents_dir
        hash_a = _fingerprint(directory / first["document_id"] / "source.pdf")[0]
        hash_b = _fingerprint(directory / second["document_id"] / "source.pdf")[0]
        assert hash_a != hash_b

        assert generate(client, first["document_id"], profile_id).status_code == 200
        assert overview_of(client, second["document_id"]).status_code == 404

    def test_one_changed_byte_changes_the_address(self, tmp_path: Path) -> None:
        """AC-P0-04. Not "a different file" — one byte of one file."""
        path = tmp_path / "source.pdf"
        original = a_pdf()
        path.write_bytes(original)
        before, _, _ = _fingerprint(path)

        middle = len(original) // 2
        path.write_bytes(
            original[:middle] + bytes([original[middle] ^ 0xFF]) + original[middle + 1:]
        )
        after, _, _ = _fingerprint(path)

        assert before != after

    def test_both_languages_coexist_side_by_side(
        self, client: TestClient, profile_id: str, counted: CountingProvider
    ) -> None:
        """AC-P0-55. Chinese prose and English prose are different documents."""
        document_id = upload(client, a_pdf()).json()["document_id"]
        assert generate(client, document_id, profile_id, target_language="en").status_code == 200
        assert generate(client, document_id, profile_id, target_language="zh-CN").status_code == 200

        content_hash = overview_of(client, document_id).json()["content_hash"]
        documents_dir = client.app.state.settings.documents_dir
        assert overview_path(documents_dir, content_hash, "en").is_file()
        assert overview_path(documents_dir, content_hash, "zh-CN").is_file()

        accounting.reset()
        assert overview_of(client, document_id, "en").json()["target_language"] == "en"
        assert overview_of(client, document_id, "zh-CN").json()["target_language"] == "zh-CN"
        assert accounting.total() == 0, accounting.summary()

    def test_a_reimport_after_deleting_the_row_hits_the_cache(
        self, client: TestClient, profile_id: str, counted: CountingProvider
    ) -> None:
        """AC-P0-54. Deleting the paper must not delete the reading of it."""
        data = a_pdf()
        first = upload(client, data).json()["document_id"]
        assert generate(client, first, profile_id).status_code == 200

        deleted = client.delete(f"/api/documents/{first}")
        assert deleted.status_code == 204, deleted.text

        reimported = upload(client, data).json()["document_id"]
        assert reimported != first

        accounting.reset()
        found = overview_of(client, reimported)
        assert found.status_code == 200, found.text
        assert accounting.total() == 0, accounting.summary()


class TestWhatTheEndpointRefusesToServe:
    def test_a_corrupt_cache_is_a_miss_not_a_500(
        self, client: TestClient, profile_id: str, counted: CountingProvider
    ) -> None:
        """AC-P0-12. A file nobody can read is a file that is not there."""
        document_id = upload(client, a_pdf()).json()["document_id"]
        assert generate(client, document_id, profile_id).status_code == 200

        content_hash = overview_of(client, document_id).json()["content_hash"]
        cached = overview_path(
            client.app.state.settings.documents_dir, content_hash, "zh-CN"
        )
        cached.write_text('{"status":', encoding="utf-8")

        assert overview_of(client, document_id).status_code == 404

    def test_a_legacy_analysis_at_the_cache_path_is_not_served(
        self, client: TestClient, profile_id: str, counted: CountingProvider
    ) -> None:
        """AC-P0-05. A translation-analysis artifact is not a reader overview,
        wherever it is found."""
        document_id = upload(client, a_pdf()).json()["document_id"]
        assert generate(client, document_id, profile_id).status_code == 200

        content_hash = overview_of(client, document_id).json()["content_hash"]
        cached = overview_path(
            client.app.state.settings.documents_dir, content_hash, "zh-CN"
        )
        payload = json.loads(cached.read_text(encoding="utf-8"))
        payload["artifact_kind"] = "translation_analysis"
        cached.write_text(json.dumps(payload), encoding="utf-8")

        assert overview_of(client, document_id).status_code == 404

    def test_an_older_extraction_is_not_served(
        self, client: TestClient, profile_id: str, counted: CountingProvider
    ) -> None:
        """AC-P0-06. Evidence ids are paragraph ids, and a re-extraction renumbers
        them. Serving the old artifact would resolve citations to moved text."""
        document_id = upload(client, a_pdf()).json()["document_id"]
        assert generate(client, document_id, profile_id).status_code == 200

        content_hash = overview_of(client, document_id).json()["content_hash"]
        cached = overview_path(
            client.app.state.settings.documents_dir, content_hash, "zh-CN"
        )
        payload = json.loads(cached.read_text(encoding="utf-8"))
        payload["ir_pipeline_version"] = "4"
        cached.write_text(json.dumps(payload), encoding="utf-8")

        assert overview_of(client, document_id).status_code == 404

    def test_a_failed_run_is_reported_and_never_stored(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch, profile_id: str
    ) -> None:
        """AC-P0-13. A run that produced nothing is not an overview, and must not
        become one on the next open."""
        install(monkeypatch, "not json", "still not json")

        document_id = upload(client, a_pdf()).json()["document_id"]
        response = generate(client, document_id, profile_id)

        assert response.status_code == 200, response.text
        assert response.json()["status"] == "FAILED"

        documents_dir = client.app.state.settings.documents_dir
        stored = list((documents_dir / "_cache" / "overview").glob("*.json"))
        assert stored == [], f"a failed run was stored: {stored}"
        assert overview_of(client, document_id).status_code == 404

    def test_a_partial_run_is_stored_and_served(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch, profile_id: str
    ) -> None:
        """AC-P0-13, the other half: PARTIAL is worth showing. It describes a
        paper incompletely; it is not a failure."""
        install(monkeypatch, json.dumps({
            "items": [{"category": "findings", "text": "只找到这一条。", "evidence": ["E1"]}],
            "key_terms": [],
        }))

        document_id = upload(client, a_pdf()).json()["document_id"]
        response = generate(client, document_id, profile_id)

        assert response.status_code == 200, response.text
        assert response.json()["status"] == "PARTIAL"

        accounting.reset()
        served = overview_of(client, document_id)
        assert served.status_code == 200, served.text
        assert served.json()["status"] == "PARTIAL"
        assert accounting.total() == 0, accounting.summary()

    def test_reading_never_generates(
        self, client: TestClient, profile_id: str, counted: CountingProvider
    ) -> None:
        """AC-P0-15/16. Opening a paper reaches no provider — with a cache and
        without one."""
        document_id = upload(client, a_pdf()).json()["document_id"]

        accounting.reset()
        assert overview_of(client, document_id).status_code == 404
        assert accounting.total() == 0, accounting.summary()

        assert generate(client, document_id, profile_id).status_code == 200
        accounting.reset()
        assert overview_of(client, document_id).status_code == 200
        assert accounting.total() == 0, accounting.summary()


class TestProvenanceAndAccounting:
    def test_an_older_models_overview_is_served_with_its_name(
        self, client: TestClient, profile_id: str, counted: CountingProvider
    ) -> None:
        """AC-P0-10. A different model's reading is still a true description of an
        unchanged paper — so it is kept, and the reader is told whose it is."""
        document_id = upload(client, a_pdf()).json()["document_id"]
        assert generate(client, document_id, profile_id).status_code == 200

        served = overview_of(client, document_id).json()
        assert served["cached"] is True
        assert served["provider_model"] == "fake-reader-model"
        assert served["created_at"]

    def test_the_reader_is_told_what_the_run_cost(
        self, client: TestClient, profile_id: str, counted: CountingProvider
    ) -> None:
        """AC-P0-20. Provider-reported or absent — never estimated."""
        document_id = upload(client, a_pdf()).json()["document_id"]
        body = generate(client, document_id, profile_id).json()

        assert body["input_tokens"] == 1200
        assert body["output_tokens"] == 340

    def test_generation_is_recorded_under_the_readers_operation(
        self, client: TestClient, profile_id: str, counted: CountingProvider
    ) -> None:
        """AC-P0-18. The bound is on the labelled synthesis, and every call it
        made carries the label."""
        document_id = upload(client, a_pdf()).json()["document_id"]
        assert generate(client, document_id, profile_id).status_code == 200

        calls = accounting.snapshot()
        assert len(calls) <= 2, accounting.summary()
        assert {call.operation for call in calls} == {"reader_overview"}
        assert all(call.ok for call in calls)


class TestEvidenceAndIsolation:
    def test_every_item_carries_the_paragraph_it_came_from(
        self, client: TestClient, profile_id: str, counted: CountingProvider
    ) -> None:
        """AC-P0-37 and AC-P0-39. The page is where the reader is sent; the
        paragraph id is how the client finds the rectangle to draw, out of the IR
        it already holds. Neither is ever supplied by the model."""
        document_id = upload(client, a_pdf()).json()["document_id"]
        body = generate(client, document_id, profile_id).json()
        assert body["items"], "the fake provider produced items"

        known = {
            paragraph["id"]
            for paragraph in client.get(f"/api/documents/{document_id}/ir").json()["paragraphs"]
        }
        for item in body["items"]:
            assert item["evidence"], f"ungrounded item survived: {item}"
            for ref in item["evidence"]:
                assert ref["paragraph_id"] in known
                assert isinstance(ref["page_number"], int) and ref["page_number"] >= 1
        for term in body["key_terms"]:
            assert term["evidence"], f"ungrounded term survived: {term}"

    def test_generation_and_deletion_leave_the_legacy_analysis_alone(
        self, client: TestClient, profile_id: str, counted: CountingProvider
    ) -> None:
        """AC-P0-11. The translation context artifact is not this feature's to
        touch — it is still what the translation engine reads."""
        from app.overview.cache import delete_overview

        document_id = upload(client, a_pdf()).json()["document_id"]
        documents_dir = client.app.state.settings.documents_dir
        legacy = documents_dir / document_id / "analysis.json"
        legacy.parent.mkdir(parents=True, exist_ok=True)
        legacy.write_text('{"artifact_kind": "translation_analysis"}', encoding="utf-8")
        before = legacy.read_bytes()

        generated = generate(client, document_id, profile_id)
        assert generated.status_code == 200, generated.text
        assert legacy.read_bytes() == before

        delete_overview(documents_dir, generated.json()["content_hash"], "zh-CN")
        assert legacy.read_bytes() == before

    def test_user_notes_never_reach_the_request_or_the_overview(
        self, client: TestClient, profile_id: str, counted: CountingProvider
    ) -> None:
        """AC-P0-47. A note is the reader's own marginalia. It is not evidence
        about the paper, and the synthesis is never shown it."""
        from app.annotations.store import AnnotationStore
        from app.db import bootstrap_database

        document_id = upload(client, a_pdf()).json()["document_id"]
        content_hash = _fingerprint(
            client.app.state.settings.documents_dir / document_id / "source.pdf"
        )[0]

        store = AnnotationStore(bootstrap_database(client.app.state.settings.database_path))
        for index in range(10):
            store.create(
                content_hash=content_hash, document_id=document_id, kind="note",
                quote=f"CONFIDENTIAL-MARGINALIA-{index}",
                comment=f"my private thought {index}",
                targets=[{
                    "source_anchor_id": f"a{index}", "anchor_version": "1",
                    "page_number": 1, "original_bbox": (0.0, 0.0, 1.0, 1.0),
                    "rects": [(0.0, 0.0, 1.0, 1.0)], "exact_quote": "a sentence",
                    "prefix": "", "suffix": "",
                }],
            )

        body = generate(client, document_id, profile_id).json()
        inner = counted.unwrap()
        sent = " ".join(
            message.content for request in inner.requests for message in request.messages
        )
        assert inner.requests, "the provider really was asked"
        assert "CONFIDENTIAL-MARGINALIA" not in sent
        assert "private thought" not in sent
        assert "CONFIDENTIAL-MARGINALIA" not in json.dumps(body)


class TestTheOverviewAndTheNotesStore:
    def test_a_stored_overview_is_not_disturbed_by_the_notes_routes(
        self, client: TestClient, profile_id: str, counted: CountingProvider
    ) -> None:
        """AC-P0-47/48 over HTTP: notes keep working, and the overview is
        byte-identical before and after they are read and exported."""
        document_id = upload(client, a_pdf()).json()["document_id"]
        assert generate(client, document_id, profile_id).status_code == 200

        content_hash = overview_of(client, document_id).json()["content_hash"]
        cached = overview_path(
            client.app.state.settings.documents_dir, content_hash, "zh-CN"
        )
        before = cached.read_bytes()

        assert client.get(f"/api/documents/{document_id}/annotations").status_code == 200
        assert client.get(f"/api/documents/{document_id}/export/notes.md").status_code == 200

        assert cached.read_bytes() == before
        assert overview_of(client, document_id).status_code == 200
