"""DS-QA-012 — taking the reader's notes out of the application.

Two properties matter more than the rest and both are about *not losing*:

**Nothing user-written is dropped or rewritten.** A note whose paragraph the
current extraction cannot place still exports, in full, with the geometry it was
made with. An orphaned note is frequently the one a reader most wants a copy of,
because it is the one the app cannot show them.

**Nothing is extracted to produce it.** Reading a cached IR enriches the export
with a title and section names; producing one is a fourteen-second ONNX pass, and
a download that silently paid it would be DS-QA-010-FIX-001's defect in a new
place.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.annotations.export import (
    NOTES_EXPORT_SCHEMA_VERSION,
    export_filename,
    sanitize_stem,
)
from app.annotations.store import AnnotationStore
from app.db import bootstrap_database
from tests.test_api_documents import make_pdf, upload
from tests.test_annotations import paragraph, source_anchor_id_for

FINGERPRINT = "sha-of-the-pdf"


@pytest.fixture
def paper(client: TestClient) -> tuple[str, str]:
    """`(document_id, content_hash)` for an uploaded, **un-extracted** document."""
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


def add_note(
    client: TestClient,
    *,
    content_hash: str,
    document_id: str,
    comment: str | None,
    quote: str,
    page: int = 1,
    kind: str = "note",
    targets: int = 1,
    top: float = 110.0,
) -> str:
    """Write an annotation straight into the store.

    Straight in, because creating one through the API needs the IR — which is the
    cost these routes exist to avoid, and a fixture that paid it could not test
    the no-IR path at all.
    """
    store = AnnotationStore(bootstrap_database(client.app.state.settings.database_path))
    payload = []
    for index in range(targets):
        # Each target gets the anchor its **own** paragraph would really have.
        # Fabricating one — by truncating and re-suffixing the first — produced a
        # fixture that could never resolve, which silently turned every
        # resolution assertion into a test of the fixture.
        own = paragraph(f"p_x{index}", quote, page=page + index)
        payload.append({
            "source_anchor_id": source_anchor_id_for(own, content_hash),
            "anchor_version": "1",
            "page_number": page + index,
            "original_bbox": (72.0, top + index * 20, 400.0, top + 14.0 + index * 20),
            "rects": [(72.0, top + index * 20, 400.0, top + 14.0 + index * 20)],
            "exact_quote": quote,
            "prefix": "before ", "suffix": " after",
        })
    created = store.create(
        content_hash=content_hash, document_id=document_id, kind=kind,
        quote=quote, comment=comment, targets=payload,
    )
    return created.id


class TestMarkdownExport:
    def test_the_header_carries_the_document_and_the_export(
        self, client: TestClient, paper: tuple[str, str]
    ) -> None:
        document_id, content_hash = paper
        add_note(client, content_hash=content_hash, document_id=document_id,
                 comment="mine", quote="A sentence from the paper.")

        response = client.get(f"/api/documents/{document_id}/export/notes.md")
        assert response.status_code == 200, response.text
        body = response.text

        assert body.startswith("# Notes: ")
        assert content_hash in body
        assert "- **Annotations:** 1" in body
        assert "- **Exported:** " in body
        # Copy-pasteable back into the API, which the content hash's presence is
        # what makes possible.
        assert document_id not in body  # the id is ephemeral; the hash is not

    def test_a_note_keeps_the_paper_quote_and_the_users_words_apart(
        self, client: TestClient, paper: tuple[str, str]
    ) -> None:
        document_id, content_hash = paper
        add_note(client, content_hash=content_hash, document_id=document_id,
                 comment="This is the part I care about.", kind="note",
                 quote="Residual connections ease optimisation.")

        body = client.get(
            f"/api/documents/{document_id}/export/notes.md"
        ).text

        assert "> Residual connections ease optimisation." in body
        assert "**Note:**" in body
        assert "This is the part I care about." in body
        # The user's sentence must not be inside the blockquote: a reader has to
        # be able to tell their own writing from the paper's at a glance.
        assert "> This is the part I care about." not in body

    def test_a_highlight_without_a_note_still_exports(self, client, paper) -> None:
        document_id, content_hash = paper
        add_note(client, content_hash=content_hash, document_id=document_id,
                 comment=None, quote="Marked, not annotated.", kind="highlight")

        body = client.get(f"/api/documents/{document_id}/export/notes.md").text
        assert "> Marked, not annotated." in body
        assert "1. Highlight" in body
        assert "**Note:**" not in body

    def test_a_cross_page_note_is_one_entry_with_a_page_range(self, client, paper) -> None:
        """DS-QA-011's annotation: one user gesture, one entry.

        Repeating the note once per page would turn one thing the reader wrote
        into two things they did not.
        """
        document_id, content_hash = paper
        add_note(client, content_hash=content_hash, document_id=document_id,
                 comment="spans the boundary", quote="Spans two pages.",
                 page=3, targets=2)

        body = client.get(f"/api/documents/{document_id}/export/notes.md").text
        assert "**Pages:** 3–4" in body
        assert body.count("spans the boundary") == 1
        assert body.count("2 source locations") == 1

    def test_user_text_cannot_restructure_the_file(self, client, paper) -> None:
        """A note beginning `#` is a note, not a heading.

        The failure this prevents is not cosmetic: a note whose first character
        makes the rest of its line a heading pushes every later entry down a
        level, and a note containing a fenced block can swallow the entries after
        it entirely.
        """
        document_id, content_hash = paper
        add_note(
            client, content_hash=content_hash, document_id=document_id,
            comment="# Injected Heading\n- fake list item", kind="note",
            quote="> quote-looking source text",
        )

        body = client.get(f"/api/documents/{document_id}/export/notes.md").text
        assert "\n# Injected Heading" not in body
        assert "\\# Injected Heading" in body
        # The quote's own `>` is inside a blockquote, so the line reads as a
        # quote of a quote rather than escaping the block.
        assert "> > quote-looking source text" in body

    def test_an_html_looking_note_is_preserved_as_text(self, client, paper) -> None:
        """The note is data. Deleting it to make it safe would be the real loss."""
        document_id, content_hash = paper
        note = "<script>alert(1)</script>"
        add_note(client, content_hash=content_hash, document_id=document_id,
                 comment=note, quote="source")

        body = client.get(f"/api/documents/{document_id}/export/notes.md").text
        assert note in body


class TestJsonExport:
    def test_the_envelope_is_versioned_and_parses(self, client, paper) -> None:
        document_id, content_hash = paper
        add_note(client, content_hash=content_hash, document_id=document_id,
                 comment="mine", quote="A sentence.")

        response = client.get(f"/api/documents/{document_id}/export/notes.json")
        assert response.status_code == 200, response.text
        payload = json.loads(response.text)

        assert payload["schema_version"] == NOTES_EXPORT_SCHEMA_VERSION == "1"
        assert payload["exported_at"]
        assert payload["document"]["content_hash"] == content_hash
        assert payload["document"]["filename"]
        assert len(payload["annotations"]) == 1

    def test_every_target_keeps_the_anchor_that_identifies_it(
        self, client, paper
    ) -> None:
        """The reason this route is server-side at all.

        The client's view of an annotation carries no anchor — deliberately, since
        a digest is the server's business. An archive whose purpose is to survive
        a re-extraction has to keep it, so it is built where the anchor lives.
        """
        document_id, content_hash = paper
        add_note(client, content_hash=content_hash, document_id=document_id,
                 comment="mine", quote="Two paragraphs.", targets=2)

        payload = json.loads(
            client.get(f"/api/documents/{document_id}/export/notes.json").text
        )
        targets = payload["annotations"][0]["targets"]

        assert len(targets) == 2
        assert [t["target_order"] for t in targets] == [0, 1]
        for target in targets:
            assert target["source_anchor_id"]
            assert target["anchor_version"] == "1"
            assert len(target["original_bbox"]) == 4
            assert target["rects"]
            assert target["exact_quote"]
            assert "resolution_state" in target

    def test_no_runtime_paragraph_ordinal_is_exported(self, client, paper) -> None:
        """`p_<doc>_<ordinal>` is an index into one extraction.

        DS-DOC-002 measured a single layout constant renumbering 145 of 160
        paragraphs of a paper whose bytes had not changed. An archive that
        recorded that ordinal would identify a paragraph by a number that moves.
        """
        document_id, content_hash = paper
        add_note(client, content_hash=content_hash, document_id=document_id,
                 comment="mine", quote="A sentence.")

        body = client.get(f"/api/documents/{document_id}/export/notes.json").text
        payload = json.loads(body)
        target = payload["annotations"][0]["targets"][0]

        assert "paragraph_id" not in target
        assert "resolved_paragraph_id" not in target
        assert "p_" not in json.dumps(payload["annotations"][0]["targets"])

    def test_a_note_the_extraction_cannot_place_is_still_exported(
        self, client, paper
    ) -> None:
        """The one that matters most, and the one that is easiest to lose."""
        document_id, content_hash = paper
        add_note(client, content_hash=content_hash, document_id=document_id,
                 comment="still my words", quote="Its paragraph moved.")

        payload = json.loads(
            client.get(f"/api/documents/{document_id}/export/notes.json").text
        )
        annotation = payload["annotations"][0]

        assert annotation["comment"] == "still my words"
        assert annotation["resolution_state"] == "UNRESOLVED"
        assert annotation["targets"][0]["exact_quote"] == "Its paragraph moved."
        assert annotation["targets"][0]["rects"]

    def test_unicode_and_control_characters_round_trip(self, client, paper) -> None:
        document_id, content_hash = paper
        note = '退化问题 — "quoted"\tback\\slash\nnewline 🎯 <b>bold</b>'
        add_note(client, content_hash=content_hash, document_id=document_id,
                 comment=note, quote="残差连接")

        payload = json.loads(
            client.get(f"/api/documents/{document_id}/export/notes.json").text
        )
        assert payload["annotations"][0]["comment"] == note
        assert payload["annotations"][0]["quote"] == "残差连接"


class TestScopeAndImmutability:
    def test_a_soft_deleted_note_is_absent_from_both_formats(
        self, client: TestClient, paper: tuple[str, str]
    ) -> None:
        document_id, content_hash = paper
        keep = add_note(client, content_hash=content_hash, document_id=document_id,
                        comment="keep me", quote="Kept.")
        drop = add_note(client, content_hash=content_hash, document_id=document_id,
                        comment="delete me", quote="Deleted.")

        assert client.delete(f"/api/annotations/{drop}").status_code == 204

        markdown = client.get(f"/api/documents/{document_id}/export/notes.md").text
        payload = json.loads(
            client.get(f"/api/documents/{document_id}/export/notes.json").text
        )

        assert "keep me" in markdown and "delete me" not in markdown
        assert [a["comment"] for a in payload["annotations"]] == ["keep me"]
        assert keep

    def test_another_papers_notes_are_not_exported(self, client, paper) -> None:
        document_id, content_hash = paper
        add_note(client, content_hash=content_hash, document_id=document_id,
                 comment="mine", quote="Mine.")
        add_note(client, content_hash="a-different-pdf", document_id="elsewhere",
                 comment="theirs", quote="Theirs.")

        payload = json.loads(
            client.get(f"/api/documents/{document_id}/export/notes.json").text
        )
        assert [a["comment"] for a in payload["annotations"]] == ["mine"]

    def test_export_writes_nothing(self, client, paper) -> None:
        """A download is a read. A `max(updated_at)` that moved would be a bug.

        `updated_at` has second precision, so the assertion is on the stored
        values rather than on a timestamp that a fast test could not distinguish
        anyway — and on the row count, which a stray write would move.
        """
        import sqlite3

        document_id, content_hash = paper
        add_note(client, content_hash=content_hash, document_id=document_id,
                 comment="mine", quote="Mine.")

        database = client.app.state.settings.database_path
        before = client.get(f"/api/documents/{document_id}/export/notes.md")
        assert before.status_code == 200
        client.get(f"/api/documents/{document_id}/export/notes.json")

        connection = sqlite3.connect(database)
        try:
            rows = connection.execute(
                "SELECT id, comment, updated_at FROM annotations ORDER BY id"
            ).fetchall()
            targets = connection.execute(
                "SELECT COUNT(*) FROM annotation_targets"
            ).fetchone()[0]
        finally:
            connection.close()

        assert len(rows) == 1 and targets == 1
        assert rows[0][1] == "mine"

    def test_no_notes_is_a_valid_empty_export(self, client, paper) -> None:
        """The UI refuses to offer an empty download; the route still answers.

        A route that 404'd on an empty document would make "this paper has no
        notes" and "this paper does not exist" the same answer.
        """
        document_id, _ = paper
        response = client.get(f"/api/documents/{document_id}/export/notes.json")
        assert response.status_code == 200
        assert json.loads(response.text)["annotations"] == []
        assert "no notes" in client.get(
            f"/api/documents/{document_id}/export/notes.md"
        ).text


class TestWithoutAnExtraction:
    def test_export_does_not_extract_the_document(
        self, client: TestClient, paper: tuple[str, str]
    ) -> None:
        """The boundary this task inherits and must not break.

        `ir.json`'s absence afterwards is the assertion: a route that extracts
        recreates it. The response is checked too, but it was never the part that
        would fail.
        """
        document_id, content_hash = paper
        directory = client.app.state.settings.documents_dir / document_id
        add_note(client, content_hash=content_hash, document_id=document_id,
                 comment="before the paper was read", quote="Unread source.")

        for suffix in ("notes.md", "notes.json"):
            response = client.get(f"/api/documents/{document_id}/export/{suffix}")
            assert response.status_code == 200, response.text

        assert not (directory / "ir.json").is_file(), (
            "the export route extracted the document"
        )

    def test_the_no_ir_export_carries_the_notes_and_says_what_it_does_not_know(
        self, client: TestClient, paper: tuple[str, str]
    ) -> None:
        document_id, content_hash = paper
        add_note(client, content_hash=content_hash, document_id=document_id,
                 comment="my note", quote="Some source.", page=2)

        payload = json.loads(
            client.get(f"/api/documents/{document_id}/export/notes.json").text
        )
        annotation = payload["annotations"][0]

        assert annotation["comment"] == "my note"
        assert annotation["page_first"] == 2
        # Honest about the gap rather than asserting a resolution it never made.
        assert annotation["resolution_state"] == "UNRESOLVED"
        assert "**Status:** UNRESOLVED" in client.get(
            f"/api/documents/{document_id}/export/notes.md"
        ).text


class TestDelivery:
    def test_both_routes_name_the_file_and_its_type(
        self, client: TestClient, paper: tuple[str, str]
    ) -> None:
        document_id, content_hash = paper
        add_note(client, content_hash=content_hash, document_id=document_id,
                 comment="mine", quote="Mine.")

        markdown = client.get(f"/api/documents/{document_id}/export/notes.md")
        payload = client.get(f"/api/documents/{document_id}/export/notes.json")

        assert markdown.headers["content-type"].startswith("text/markdown")
        assert payload.headers["content-type"].startswith("application/json")
        for response, extension in ((markdown, "md"), (payload, "json")):
            disposition = response.headers["content-disposition"]
            assert disposition.startswith("attachment;")
            assert f"-notes.{extension}" in disposition

    def test_the_same_data_exports_the_same_body(self, client, paper) -> None:
        """Determinism, stated as the criteria state it.

        The export timestamp is required by two other criteria, so two exports a
        second apart *must* differ by it. What must not differ is anything else —
        order, fields, bytes — and that is what is compared, with the one
        permitted field normalised out.
        """
        import re

        document_id, content_hash = paper
        # Distinct positions on the same page, so the assertion exercises the
        # **primary** sort key rather than a timestamp tie-break — which would
        # pass on a clock with microsecond resolution and fail on one without.
        for page, top, comment in ((2, 110.0, "second"), (1, 500.0, "first"),
                                   (1, 200.0, "third")):
            add_note(client, content_hash=content_hash, document_id=document_id,
                     comment=comment, quote=f"Quote {comment}", page=page, top=top)

        def normalised(body: str) -> str:
            return re.sub(r'("?exported_at"?\s*[:=]\s*"?)[^"\n]+', r"\1<stamp>", body)

        first_md = client.get(f"/api/documents/{document_id}/export/notes.md").text
        second_md = client.get(f"/api/documents/{document_id}/export/notes.md").text
        first_json = client.get(f"/api/documents/{document_id}/export/notes.json").text
        second_json = client.get(f"/api/documents/{document_id}/export/notes.json").text

        assert normalised(first_md) == normalised(second_md)
        assert normalised(first_json) == normalised(second_json)

        # And the order is the paper's, not the order they were written in.
        # Page 1 first (by position: y=200 then y=500), page 2 last.
        assert first_md.index("third") < first_md.index("first") < first_md.index("second")
        assert first_json.index("third") < first_json.index("first") < first_json.index("second")


class TestFilename:
    def test_the_worked_example_from_the_criteria(self) -> None:
        """`深度学习: 卷积/循环 "测试".pdf` -> one underscore per unsafe char.

        The criteria's own example, asserted as given: `:` and the space that
        follows it each become one underscore.
        """
        assert sanitize_stem('深度学习: 卷积/循环 "测试".pdf') == "深度学习__卷积_循环__测试_"

    def test_a_name_with_nothing_usable_left_falls_back(self) -> None:
        assert sanitize_stem("///.pdf") == "document"
        assert export_filename("", "md") == "document-notes.md"

    def test_the_extension_is_normalised_away_and_the_length_capped(self) -> None:
        assert sanitize_stem("Paper.PDF") == "Paper"
        assert len(sanitize_stem("x" * 400)) == 100

    def test_unicode_survives(self) -> None:
        assert sanitize_stem("残差网络.pdf") == "残差网络"


class TestEvidentiarySeparation:
    def test_paper_qa_never_reaches_for_a_note(self) -> None:
        """Notes are the reader's commentary, not the paper's evidence.

        Asserted as an import graph rather than by grepping for a string: a
        future `from app.annotations import ...` is the shape this would take,
        and a text search would miss it while matching a comment that mentions
        the word.
        """
        import ast
        from pathlib import Path as PathlibPath

        qa_dir = PathlibPath(__file__).resolve().parents[1] / "app" / "qa"
        offenders: list[str] = []
        for source in qa_dir.rglob("*.py"):
            tree = ast.parse(source.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    if any("annotations" in alias.name for alias in node.names):
                        offenders.append(f"{source.name}: import {node.names[0].name}")
                elif isinstance(node, ast.ImportFrom):
                    if node.module and "annotations" in node.module:
                        offenders.append(f"{source.name}: from {node.module}")

        assert offenders == [], (
            "the QA evidence path imports annotations: " + ", ".join(offenders)
        )


class TestDegradedStates:
    """A note the current extraction cannot place is still the reader's note.

    These are the annotations an export must never drop, and the reason is not
    sentimental: the paper was re-parsed, the paragraph the note was made against
    no longer exists in the same shape, and the export is the only copy of that
    note that is not behind an application that cannot show it.
    """

    def _with_ir(self, client, document_id: str, content_hash: str, paragraphs):
        """Cache an extraction for the document, built for **this** document.

        The fingerprint matters: `_export` reads the announcement's content hash
        from the IR when one is present, so an IR carrying a different hash is
        correctly treated as belonging to a different paper — and the export then
        finds no annotations. Asserting on that would have been a test of the
        fixture rather than of the export.
        """
        from app.document.persistence import write_ir
        from tests.test_annotations import ir_with

        directory = client.app.state.settings.documents_dir / document_id
        ir = ir_with(*paragraphs, fingerprint=content_hash)
        write_ir(directory, ir)
        return ir

    def test_an_orphaned_note_is_exported_with_everything_it_was_made_with(
        self, client: TestClient, paper: tuple[str, str]
    ) -> None:
        document_id, content_hash = paper
        add_note(client, content_hash=content_hash, document_id=document_id,
                 comment="still my words", quote="a paragraph that is gone now")

        # A cached extraction that does not contain the note's paragraph at all.
        self._with_ir(client, document_id, content_hash, [])

        markdown = client.get(f"/api/documents/{document_id}/export/notes.md").text
        payload = json.loads(
            client.get(f"/api/documents/{document_id}/export/notes.json").text
        )
        annotation = payload["annotations"][0]

        assert annotation["comment"] == "still my words"
        assert annotation["resolution_state"] == "ORPHANED"
        assert annotation["targets"][0]["exact_quote"] == "a paragraph that is gone now"
        assert "**Status:** ORPHANED" in markdown
        assert "still my words" in markdown

    def test_a_mixed_annotation_reports_the_weaker_of_its_targets(
        self, client: TestClient, paper: tuple[str, str]
    ) -> None:
        """One target placed exactly, one not.

        Reporting EXACT would be understating what is uncertain, and the reader
        is being told exactly that. The state is the worst present, not the best.
        """
        document_id, content_hash = paper
        add_note(client, content_hash=content_hash, document_id=document_id,
                 comment="spans two paragraphs", quote="first paragraph text",
                 page=1, targets=2)

        # An extraction holding only the first target's page.
        self._with_ir(
            client, document_id, content_hash,
            [paragraph("p_keep", "first paragraph text", page=1)],
        )

        payload = json.loads(
            client.get(f"/api/documents/{document_id}/export/notes.json").text
        )
        annotation = payload["annotations"][0]

        assert len(annotation["targets"]) == 2
        assert annotation["resolution_state"] == "ORPHANED"

        # Each target keeps its **own** verdict. Recording the annotation's worst
        # against both would claim the first target is uncertain when it is not,
        # and an archive that cannot say which half was placed is an archive a
        # future import cannot use — which is the whole reason the JSON exists.
        assert [t["resolution_state"] for t in annotation["targets"]] == [
            "EXACT", "ORPHANED",
        ]
        # Both targets are still exported, with their own geometry.
        assert all(t["rects"] for t in annotation["targets"])


class TestPaperQaIsolation:
    """The reader's own words must never become the paper's evidence.

    Asserted against the **index that is actually built**, not against the import
    graph alone. An import test proves the modules do not reach for each other
    today; this proves the searchable text a question runs against does not
    contain a note, whatever the call graph looks like.
    """

    def test_a_note_is_not_searchable_as_paper_evidence(
        self, client: TestClient, paper: tuple[str, str]
    ) -> None:
        import sqlite3

        from app.document.persistence import write_ir
        from app.qa.index import ensure_index, index_path
        from tests.test_annotations import ir_with

        document_id, content_hash = paper
        # Distinctive enough that finding it in the index could not be a coincidence.
        marker = "zzmarkerqq the reader wrote this and the paper did not"
        add_note(client, content_hash=content_hash, document_id=document_id,
                 comment=marker, quote="a sentence that is genuinely in the paper")

        directory = client.app.state.settings.documents_dir / document_id
        ir = ir_with(
            paragraph("p_1", "a sentence that is genuinely in the paper", page=1),
            fingerprint=content_hash,
        )
        write_ir(directory, ir)
        ensure_index(directory, ir)

        connection = sqlite3.connect(index_path(directory))
        try:
            rows = connection.execute("SELECT text FROM chunks").fetchall()
        finally:
            connection.close()

        assert rows, "the index should hold the paper's own text"
        assert any("genuinely in the paper" in row[0] for row in rows)
        assert not any(marker in row[0] for row in rows), (
            "a user note reached the Paper QA index"
        )
        assert not any("zzmarkerqq" in row[0] for row in rows)
