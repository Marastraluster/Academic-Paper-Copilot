"""DS-QA-015 Phase 0/1 — counting model calls where they actually happen.

DS-QA-014's harness watched the *page* for provider traffic and reported zero,
which was true and useless: the page never talks to a provider. Every "provider
calls: 0" claim this repository has made rests on that counter, so the first
thing this task does is move the measurement to the boundary every call crosses.

`CountingProvider` wraps every provider `detection._build_provider` constructs, so
the count is not something each caller has to remember to do.

The second half of this file is the invariant that matters most: **nothing the
reader does passively costs anything.** Those paths were claimed to be free by
five previous tasks on the strength of a browser-side counter; here they are
asserted against the backend ledger, where the calls would be.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.llm import accounting
from app.llm.accounting import CountingProvider, ProviderCall, operation
from app.llm.base import LLMProvider
from app.llm.models import LLMRequest, LLMResult, LLMUsage
from tests.test_api_documents import make_pdf, upload


class FakeProvider(LLMProvider):
    """A provider that answers without leaving the process."""

    protocol = "fake"

    def __init__(self, *, usage: LLMUsage | None = None, fail: bool = False) -> None:
        self.calls = 0
        self._usage = usage
        self._fail = fail

    async def generate(self, request: LLMRequest) -> LLMResult:
        self.calls += 1
        if self._fail:
            raise RuntimeError("provider is unhappy")
        return LLMResult(
            text="ok", model="fake-model", protocol=self.protocol, usage=self._usage,
        )

    async def test_connection(self):
        raise NotImplementedError


@pytest.fixture(autouse=True)
def clean_ledger():
    accounting.reset()
    yield
    accounting.reset()


def run(coroutine):
    return asyncio.run(coroutine)


class TestTheLedger:
    def test_every_generate_is_recorded(self) -> None:
        inner = FakeProvider()
        provider = CountingProvider(inner)
        request = LLMRequest(messages=[{"role": "user", "content": "hi"}])

        run(provider.generate(request))
        run(provider.generate(request))

        assert inner.calls == 2
        assert accounting.total() == 2
        assert all(call.ok for call in accounting.snapshot())

    def test_provider_reported_usage_is_kept(self) -> None:
        """Reported, not estimated. A character count presented as provider token
        usage is a number nobody can act on."""
        provider = CountingProvider(FakeProvider(
            usage=LLMUsage(prompt_tokens=1200, completion_tokens=340, total_tokens=1540),
        ))
        run(provider.generate(LLMRequest(messages=[{"role": "user", "content": "hi"}])))

        call = accounting.snapshot()[0]
        assert (call.input_tokens, call.output_tokens) == (1200, 340)
        assert accounting.summary()["usage_reported"] is True

    def test_unreported_usage_is_absent_rather_than_zero(self) -> None:
        provider = CountingProvider(FakeProvider(usage=None))
        run(provider.generate(LLMRequest(messages=[{"role": "user", "content": "hi"}])))

        call = accounting.snapshot()[0]
        assert call.input_tokens is None
        assert accounting.summary()["usage_reported"] is False

    def test_a_failure_is_counted_and_still_raised(self) -> None:
        """A failed call cost money and time; a ledger that only counts successes
        under-reports exactly the runs a reader would complain about."""
        provider = CountingProvider(FakeProvider(fail=True))
        with pytest.raises(RuntimeError):
            run(provider.generate(LLMRequest(messages=[{"role": "user", "content": "hi"}])))

        assert accounting.total() == 1
        assert accounting.snapshot()[0].ok is False
        assert accounting.snapshot()[0].error == "RuntimeError"

    def test_the_caller_labels_the_operation(self) -> None:
        provider = CountingProvider(FakeProvider())
        request = LLMRequest(messages=[{"role": "user", "content": "hi"}])

        with operation("translation"):
            run(provider.generate(request))
        run(provider.generate(request))

        assert [call.operation for call in accounting.snapshot()] == [
            "translation", "unlabelled",
        ]

    def test_a_nested_label_does_not_leak_outward(self) -> None:
        provider = CountingProvider(FakeProvider())
        request = LLMRequest(messages=[{"role": "user", "content": "hi"}])

        with operation("analysis"):
            with operation("repair"):
                run(provider.generate(request))
            run(provider.generate(request))

        assert [call.operation for call in accounting.snapshot()] == ["repair", "analysis"]

    def test_the_ledger_never_carries_text(self) -> None:
        """A counter that logs paper text is a worse problem than the one it
        solves. There is no field for it, and this asserts there is not."""
        provider = CountingProvider(FakeProvider())
        run(provider.generate(LLMRequest(messages=[
            {"role": "user", "content": "the secret sentence of a copyrighted paper"},
        ])))

        call = accounting.snapshot()[0]
        assert set(vars(call)) == {
            "operation", "model", "protocol", "ok",
            "input_tokens", "output_tokens", "error",
        }


class TestNothingPassiveCostsAnything:
    """The invariant five previous tasks claimed from the wrong boundary.

    Asserted here against the ledger the backend writes to, so a call made by a
    path nobody thought about shows up as loudly as one a reader asked for.
    """

    def _paper(self, client: TestClient) -> tuple[str, str]:
        import tempfile

        from app.document.extract import _fingerprint

        with tempfile.TemporaryDirectory() as folder:
            data = make_pdf(Path(folder) / "paper.pdf").read_bytes()
        response = upload(client, data)
        assert response.status_code == 201, response.text
        document_id = response.json()["document_id"]
        directory = client.app.state.settings.documents_dir / document_id
        return document_id, str(_fingerprint(directory / "source.pdf")[0])

    def test_registering_and_reading_a_paper_costs_nothing(
        self, client: TestClient
    ) -> None:
        """Opening a paper is the path the whole product promise rests on."""
        document_id, _ = self._paper(client)
        client.get(f"/api/documents/{document_id}/ir")
        assert accounting.total() == 0, accounting.summary()

    def test_listing_notes_costs_nothing(self, client: TestClient) -> None:
        document_id, content_hash = self._paper(client)
        from app.annotations.store import AnnotationStore
        from app.db import bootstrap_database

        store = AnnotationStore(bootstrap_database(client.app.state.settings.database_path))
        store.create(
            content_hash=content_hash, document_id=document_id, kind="note",
            quote="a sentence", comment="mine",
            targets=[{
                "source_anchor_id": "a", "anchor_version": "1", "page_number": 1,
                "original_bbox": (0.0, 0.0, 1.0, 1.0), "rects": [(0.0, 0.0, 1.0, 1.0)],
                "exact_quote": "a sentence", "prefix": "", "suffix": "",
            }],
        )

        response = client.get(f"/api/documents/{document_id}/annotations")
        assert response.status_code == 200
        assert accounting.total() == 0, accounting.summary()

    def test_notes_search_and_export_cost_nothing(self, client: TestClient) -> None:
        """Search runs in the browser over the loaded list and export is a file
        the server writes; neither has a reason to reach a model."""
        document_id, _ = self._paper(client)
        client.get(f"/api/documents/{document_id}/export/notes.md")
        client.get(f"/api/documents/{document_id}/export/notes.json")
        assert accounting.total() == 0, accounting.summary()

    def test_reading_the_cached_analysis_costs_nothing(self, client: TestClient) -> None:
        document_id, _ = self._paper(client)
        client.get(f"/api/documents/{document_id}/analysis")
        client.get(f"/api/documents/{document_id}/sections")
        assert accounting.total() == 0, accounting.summary()
