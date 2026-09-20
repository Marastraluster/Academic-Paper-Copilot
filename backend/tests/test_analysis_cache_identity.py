"""DS-QA-015 Phase 2 — the analysis cache is bound to the wrong identity.

Reproduced before it is fixed, because the fix is to a contract and the contract
has to be shown to be broken first.

`app/context/persistence.py` stores an analysis at `<document_dir>/analysis.json`,
and the directory is derived from the document **row** — `uuid4().hex`, minted
fresh every time a file is opened. So the second open of a byte-identical PDF
finds nothing, offers to generate, and pays the whole cost again. Measured for
DS-QA-014: 1565.8 seconds and several provider calls, per reopen.

This is DS-QA-010-FIX-001's defect exactly — the notes list was keyed on the
document row and fixed by keying on `content_hash`. The analysis was never given
that fix because nothing used it until the reader overview did.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from fastapi.testclient import TestClient

from app.context.models import (
    AnalysisProvenance,
    AnalysisStatus,
    DocumentAnalysis,
)
from app.context.persistence import read_analysis, write_analysis
from tests.test_api_documents import make_pdf, upload


def register(client: TestClient, data: bytes) -> str:
    response = upload(client, data)
    assert response.status_code == 201, response.text
    return response.json()["document_id"]


def an_analysis(document_id: str, content_hash: str) -> DocumentAnalysis:
    return DocumentAnalysis(
        document_id=document_id,
        provenance=AnalysisProvenance(
            document_id=document_id, content_hash=content_hash,
            pipeline_version="1.0.0", prompt_version="1.0.0",
            ir_pipeline_version="5", provider_base_url="https://example.invalid",
            provider_model="m", provider_protocol="chat_completions",
            target_language="zh-CN", created_at="2026-09-19T00:00:00+00:00",
        ),
        status=AnalysisStatus.READY,
        summary="A summary the reader paid for.",
    )


class TestTheDefect:
    def test_the_same_pdf_reopened_cannot_find_its_own_analysis(
        self, client: TestClient
    ) -> None:
        """The reproduction, asserted as the *broken* behaviour.

        Written as a failing expectation on purpose: when the cache is keyed on
        content, this test is the one that has to change, and its name says why.
        """
        with tempfile.TemporaryDirectory() as folder:
            data = make_pdf(Path(folder) / "paper.pdf").read_bytes()

        first = register(client, data)
        first_dir = client.app.state.settings.documents_dir / first
        content_hash = str(
            __import__("app.document.extract", fromlist=["_fingerprint"])
            ._fingerprint(first_dir / "source.pdf")[0]
        )
        write_analysis(first_dir, an_analysis(first, content_hash))
        assert read_analysis(first_dir) is not None

        # The same bytes, opened again — which is what reopening a paper is.
        second = register(client, data)
        second_dir = client.app.state.settings.documents_dir / second

        assert second != first, "reopening must mint a new row; that is the lifecycle"
        assert not (second_dir / "analysis.json").is_file(), (
            "the second row has no analysis, because the cache lives under the "
            "first row's directory — this is the defect DS-QA-015 exists for"
        )

    def test_the_old_artifact_still_exists_under_the_old_row(
        self, client: TestClient
    ) -> None:
        """Nothing is lost; it is unreachable. That distinction is the fix's shape:
        the bytes on disk are fine, and what has to change is where they are found.
        """
        with tempfile.TemporaryDirectory() as folder:
            data = make_pdf(Path(folder) / "paper.pdf").read_bytes()

        first = register(client, data)
        first_dir = client.app.state.settings.documents_dir / first
        write_analysis(first_dir, an_analysis(first, "some-hash"))

        second = register(client, data)
        assert second != first
        assert read_analysis(first_dir) is not None, "the paid-for artifact was not deleted"

    def test_different_bytes_are_a_different_document(self, client: TestClient) -> None:
        """The other half of the contract, and it already holds: two files are two
        documents. Whatever the fix does, it must not make these collide."""
        with tempfile.TemporaryDirectory() as folder:
            one = make_pdf(Path(folder) / "a.pdf", pages=2).read_bytes()
            two = make_pdf(Path(folder) / "b.pdf", pages=4).read_bytes()

        first = register(client, one)
        second = register(client, two)

        from app.document.extract import _fingerprint

        hash_one = str(_fingerprint(
            client.app.state.settings.documents_dir / first / "source.pdf"
        )[0])
        hash_two = str(_fingerprint(
            client.app.state.settings.documents_dir / second / "source.pdf"
        )[0])
        assert hash_one != hash_two
