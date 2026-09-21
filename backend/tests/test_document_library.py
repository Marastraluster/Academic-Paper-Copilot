"""DS-DOC-005 — the library's read surface: what each registered paper has.

The record this reports is the one the database actually holds. It is worth a
test file of its own because the failure mode is not a crash: a library that
reports a model, a token count or a date it did not record is a screen that reads
as authoritative and is not, and that is the thing DS-DOC-005 §2.5 exists to
refuse.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.documents.store import STATUS_SUCCEEDED, DocumentStore  # noqa: F401
from tests.test_api_documents import make_pdf, upload


def a_document(client: TestClient, name: str = "paper.pdf") -> str:
    with tempfile.TemporaryDirectory() as folder:
        data = make_pdf(Path(folder) / name).read_bytes()
    response = upload(client, data, name=name)
    assert response.status_code == 201, response.text
    return response.json()["document_id"]


def the_store(client: TestClient) -> DocumentStore:
    """A store over the same database file, on this thread.

    Deliberately not `app.state.document_store`: that connection belongs to the
    lifespan's thread and SQLite refuses to be used from another one. The same
    pattern `test_provider_accounting.py` uses for annotations, and for the same
    reason.
    """
    from app.db import bootstrap_database

    settings = client.app.state.settings
    return DocumentStore(
        bootstrap_database(settings.database_path), settings.documents_dir
    )


def record_a_translation(
    client: TestClient,
    document_id: str,
    *,
    status: str = STATUS_SUCCEEDED,
    lang_in: str = "en",
    lang_out: str = "zh",
    engine: str = "fast",
) -> str:
    store = the_store(client)
    task = store.create_task(
        document_id=document_id, profile_id="prof_test",
        lang_in=lang_in, lang_out=lang_out, engine=engine,
    )
    if status != task.status:
        store.update_task(task.id, status=status)
    return task.id


def a_translated_artifact(client: TestClient, document_id: str) -> None:
    """A `mono.pdf` on disk — the library reports the file, not the task."""
    path = the_store(client).mono_file(document_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"%PDF-1.4\n")


class TestTheRecord:
    def test_a_paper_nobody_translated_says_so(self, client: TestClient) -> None:
        document_id = a_document(client)
        payload = client.get(f"/api/documents/{document_id}").json()
        assert payload["translation_record"] is None
        assert payload["has_translation"] is False

    def test_a_translated_paper_reports_the_language_pair_and_engine(
        self, client: TestClient
    ) -> None:
        document_id = a_document(client)
        record_a_translation(client, document_id, lang_in="en", lang_out="zh-CN", engine="fast")

        payload = client.get(f"/api/documents/{document_id}").json()
        assert payload["translation_record"] is not None
        assert payload["translation_record"]["lang_in"] == "en"
        assert payload["translation_record"]["lang_out"] == "zh-CN"
        assert payload["translation_record"]["engine"] == "fast"
        assert payload["translation_record"]["translated_at"]
        assert payload["translation_record"]["profile_id"] == "prof_test"

    def test_it_reports_no_model_and_no_tokens(self, client: TestClient) -> None:
        """The two things nothing recorded, and which a screen must not invent."""
        document_id = a_document(client)
        record_a_translation(client, document_id)

        record = client.get(f"/api/documents/{document_id}").json()["translation_record"]
        assert set(record) == {
            "lang_in", "lang_out", "engine", "translated_at", "profile_id",
        }, "a field appeared that nothing measured"

    def test_a_run_that_failed_is_not_a_record(self, client: TestClient) -> None:
        document_id = a_document(client)
        record_a_translation(client, document_id, status="FAILED")
        assert client.get(f"/api/documents/{document_id}").json()["translation_record"] is None

    def test_the_newest_successful_run_is_the_one_reported(self, client: TestClient) -> None:
        document_id = a_document(client)
        record_a_translation(client, document_id, lang_in="en", lang_out="zh")
        record_a_translation(client, document_id, lang_in="en", lang_out="ja")

        record = client.get(f"/api/documents/{document_id}").json()["translation_record"]
        assert record["lang_out"] == "ja"

    def test_a_later_failure_does_not_erase_the_success_before_it(
        self, client: TestClient
    ) -> None:
        document_id = a_document(client)
        record_a_translation(client, document_id, lang_out="zh")
        record_a_translation(client, document_id, status="FAILED", lang_out="fr")

        record = client.get(f"/api/documents/{document_id}").json()["translation_record"]
        assert record["lang_out"] == "zh"

    def test_the_artifact_and_the_record_are_separate_facts(self, client: TestClient) -> None:
        """`has_translation` is a file on disk; the record is a task row."""
        document_id = a_document(client)
        a_translated_artifact(client, document_id)
        payload = client.get(f"/api/documents/{document_id}").json()
        assert payload["has_translation"] is True
        assert payload["translation_record"] is None


class TestTheList:
    def test_every_row_carries_its_own_record(self, client: TestClient) -> None:
        first = a_document(client, "one.pdf")
        second = a_document(client, "two.pdf")
        record_a_translation(client, first, lang_out="zh")
        record_a_translation(client, second, lang_out="ja")

        rows = {row["document_id"]: row for row in client.get("/api/documents").json()}
        assert rows[first]["translation_record"]["lang_out"] == "zh"
        assert rows[second]["translation_record"]["lang_out"] == "ja"

    def test_the_record_costs_one_lookup_for_the_whole_page(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Not one per row: a library of a hundred papers is one question."""
        for index in range(3):
            a_document(client, f"paper{index}.pdf")

        calls = {"n": 0}
        original = DocumentStore.latest_succeeded_tasks

        def counted(self: DocumentStore):
            calls["n"] += 1
            return original(self)

        monkeypatch.setattr(DocumentStore, "latest_succeeded_tasks", counted)
        rows = client.get("/api/documents").json()

        assert len(rows) == 3
        assert calls["n"] == 1, f"the list asked {calls['n']} times"

    def test_the_newest_registration_comes_first(self, client: TestClient) -> None:
        first = a_document(client, "first.pdf")
        second = a_document(client, "second.pdf")
        rows = client.get("/api/documents").json()
        assert [row["document_id"] for row in rows][:2] == [second, first]


class TestDeletion:
    def test_deleting_removes_the_row_its_artifacts_and_its_tasks(
        self, client: TestClient
    ) -> None:
        document_id = a_document(client)
        record_a_translation(client, document_id)
        a_translated_artifact(client, document_id)
        store = the_store(client)

        assert client.delete(f"/api/documents/{document_id}").status_code == 204

        assert client.get(f"/api/documents/{document_id}").status_code == 404
        assert not store.mono_file(document_id).exists()
        assert store.latest_succeeded_tasks() == {}
