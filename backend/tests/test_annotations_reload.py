"""DS-QA-010-FIX-001 — the regression test for the reload defect.

## What went wrong, and what this asserts

`GET /documents/{id}/annotations` called `_require_ir`, which runs the full
document extraction on first read. **Fourteen seconds for a real paper.** Every
reopen of a PDF creates a new document record, so every reopen paid that cost
before a single note could be listed — and the reader saw an empty panel for as
long as it took, which reads exactly like "the notes were lost".

Five client-side fixes were attempted before anyone measured the boundary. The
browser trace showed the request still pending 1.4 seconds after it was issued,
with no response and no error, and that is what pointed at the server.

So the assertion is not "the list returns the right rows" — it always did. It is:

    **the list route does not extract the document, and still answers.**

A test that only checked the response body would have passed throughout.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tests.test_api_documents import make_pdf, upload


@pytest.fixture
def paper(client: TestClient) -> tuple[str, str]:
    """`(document_id, content_hash)` for an uploaded, **un-extracted** document.

    Registering a document does not extract it — only reading its IR does — so
    this fixture is already in the state that matters: a document the reader has
    opened, whose paper has not been read yet.
    """
    import tempfile

    from app.document.extract import _fingerprint

    with tempfile.TemporaryDirectory() as folder:
        data = make_pdf(Path(folder) / "paper.pdf").read_bytes()

    response = upload(client, data)
    assert response.status_code == 201, response.text
    document_id = response.json()["document_id"]

    directory = client.app.state.settings.documents_dir / document_id
    assert not (directory / "ir.json").is_file(), "the fixture must start unread"
    return document_id, str(_fingerprint(directory / "source.pdf")[0])


class TestListDoesNotExtract:
    def test_listing_annotations_leaves_the_ir_untouched(
        self, client: TestClient, paper: tuple[str, str]
    ) -> None:
        """The boundary this task exists for.

        The IR is deleted, so a route that extracts will recreate it — and a route
        that does not will answer from the source file's hash alone. The file's
        absence afterwards is the assertion; the response is checked too, but it
        was never the failing part.
        """
        document_id, content_hash = paper
        directory = client.app.state.settings.documents_dir / document_id

        response = client.get(f"/api/documents/{document_id}/annotations")
        assert response.status_code == 200, response.text

        body = response.json()
        assert body["content_hash"] == content_hash
        assert body["resolved"] is False
        assert body["annotations"] == []

        assert not (directory / "ir.json").is_file(), (
            "the list route extracted the document; that is the reload defect"
        )

    def test_stored_annotations_are_listed_without_an_ir(
        self, client: TestClient, paper: tuple[str, str]
    ) -> None:
        """The user's notes come back before the paper has been read.

        Written straight into the store, because creating one through the API
        would require the IR — which is the cost this route exists to avoid.
        """
        import uuid

        from app.annotations.store import AnnotationStore
        from app.db import bootstrap_database

        document_id, content_hash = paper
        directory = client.app.state.settings.documents_dir / document_id

        # Its own connection: the app's belongs to the thread its lifespan runs
        # in, and SQLite refuses to share one across threads.
        store = AnnotationStore(bootstrap_database(client.app.state.settings.database_path))
        store.create(
            content_hash=content_hash,
            document_id=document_id,
            kind="note",
            quote="The policy is optimized through multiple rollouts.",
            comment="my note",
            targets=[{
                "source_anchor_id": uuid.uuid4().hex,
                "anchor_version": "1",
                "page_number": 1,
                "original_bbox": (72.0, 110.0, 400.0, 124.0),
                "rects": [(72.0, 110.0, 400.0, 124.0)],
                "exact_quote": "The policy is optimized through multiple rollouts.",
                "prefix": "", "suffix": "",
            }],
        )

        response = client.get(f"/api/documents/{document_id}/annotations")
        assert response.status_code == 200, response.text
        body = response.json()

        assert len(body["annotations"]) == 1
        annotation = body["annotations"][0]
        assert annotation["comment"] == "my note"
        # The reader is told what the system does not yet know, rather than shown
        # a confident default or nothing at all.
        assert annotation["targets"][0]["state"] == "UNRESOLVED"
        # Geometry belongs to the immutable PDF, so it is available immediately —
        # which is what lets a highlight be drawn before the paper is read.
        assert annotation["targets"][0]["showable"] is True
        assert annotation["targets"][0]["amenable_to_jump"] is True

        assert not (directory / "ir.json").is_file()

    def test_a_document_that_was_never_extracted_is_listed_by_fingerprint(
        self, client: TestClient, paper: tuple[str, str]
    ) -> None:
        """Reopening the same PDF is a *new* document row — the case that looked
        like lost data. The list is keyed to the content hash, so the second
        document sees the first document's annotations without ever extracting."""
        import uuid

        from app.annotations.store import AnnotationStore
        from app.db import bootstrap_database

        first_id, content_hash = paper
        store = AnnotationStore(bootstrap_database(client.app.state.settings.database_path))
        store.create(
            content_hash=content_hash, document_id="a-previous-row",
            kind="highlight", quote="q", comment=None,
            targets=[{
                "source_anchor_id": uuid.uuid4().hex, "anchor_version": "1",
                "page_number": 1, "original_bbox": (0.0, 0.0, 1.0, 1.0),
                "rects": [(0.0, 0.0, 1.0, 1.0)], "exact_quote": "q",
                "prefix": "", "suffix": "",
            }],
        )

        response = client.get(f"/api/documents/{first_id}/annotations")
        assert response.status_code == 200
        assert len(response.json()["annotations"]) == 1
