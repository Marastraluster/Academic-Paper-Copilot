"""DS-BE-007 — document and translation HTTP API.

The kernel is substituted for most tests: running a real translation takes
minutes and would prove nothing about the HTTP layer. One end-to-end test does
drive the real kernel, because "the API can actually translate" is the claim that
matters.
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import fitz
import pytest
from fastapi.testclient import TestClient

from app.db import bootstrap_database
from app.documents.store import (
    PROCESS_INTERRUPTED,
    STATUS_FAILED,
    STATUS_SUCCEEDED,
    DocumentStore,
)
from app.pdfkernel import TranslationResult

SECRET = "sk-live-documents-SECRET-24680"


def make_pdf(path: Path, pages: int = 2) -> Path:
    document = fitz.open()
    for _ in range(pages):
        page = document.new_page(width=595, height=842)
        page.insert_text((72, 120), "The policy is optimized through multiple rollouts.", fontsize=11)
    document.save(str(path))
    document.close()
    return path


@pytest.fixture
def pdf_bytes() -> bytes:
    import tempfile

    with tempfile.TemporaryDirectory() as folder:
        path = make_pdf(Path(folder) / "paper.pdf")
        return path.read_bytes()


def upload(client: TestClient, data: bytes, name: str = "paper.pdf"):
    return client.post(
        "/api/documents",
        files={"file": (name, data, "application/pdf")},
    )


@pytest.fixture
def profile_id(client: TestClient) -> str:
    """Create the profile over HTTP.

    Deliberately not via ``app.state.profile_store``: that store's SQLite
    connection belongs to the lifespan's thread, and SQLite refuses cross-thread
    use. Going through the API exercises the same path a client would.
    """
    response = client.post(
        "/api/profiles",
        json={
            "name": "Test Provider",
            "base_url": "http://127.0.0.1:1/v1",
            "model": "m",
            "api_key": SECRET,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


# --- AC: import ---------------------------------------------------------------


def test_upload_returns_a_document(client: TestClient, pdf_bytes: bytes) -> None:
    response = upload(client, pdf_bytes)

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["document_id"].startswith("doc_")
    assert body["page_count"] == 2
    assert body["source"] == "upload"
    assert body["has_translation"] is False
    # No filesystem path is ever reflected back.
    assert "path" not in json.dumps(body)


def test_original_is_served_byte_identical(client: TestClient, pdf_bytes: bytes) -> None:
    """The uploaded copy is returned unchanged."""
    document_id = upload(client, pdf_bytes).json()["document_id"]

    response = client.get(f"/api/documents/{document_id}/file")

    assert response.status_code == 200
    assert response.content == pdf_bytes


def test_importing_the_same_file_twice_is_allowed(client: TestClient, pdf_bytes: bytes) -> None:
    """Two documents of the same name are distinct documents."""
    first = upload(client, pdf_bytes).json()["document_id"]
    second = upload(client, pdf_bytes).json()["document_id"]

    assert first != second
    assert client.get(f"/api/documents/{second}").status_code == 200


@pytest.mark.parametrize(
    ("payload", "status", "code"),
    [
        (b"", 400, "EMPTY_FILE"),
        (b"this is not a pdf at all", 415, "UNSUPPORTED_MEDIA_TYPE"),
        (b"%PDF-1.4\nbroken beyond repair", 422, "SOURCE_INVALID"),
    ],
)
def test_rejects_unusable_uploads(
    client: TestClient, payload: bytes, status: int, code: str
) -> None:
    response = upload(client, payload)

    assert response.status_code == status, response.text
    assert response.json()["error"]["code"] == code


def test_rejects_an_oversized_upload(app, pdf_bytes: bytes) -> None:
    """Enforced from configuration rather than by actually sending 100 MiB."""
    with TestClient(app) as client:
        # Lowered after startup, so the check is exercised without a huge body.
        client.app.state.settings.max_upload_bytes = 10
        response = upload(client, pdf_bytes)

    assert response.status_code == 413
    assert response.json()["error"]["code"] == "PAYLOAD_TOO_LARGE"


def test_path_import_never_copies_or_moves_the_source(client: TestClient, tmp_path: Path) -> None:
    """A path import reads a file the user owns, in place."""
    source = make_pdf(tmp_path / "mine.pdf")
    before = source.read_bytes()

    response = client.post("/api/documents", json={"path": str(source)})

    assert response.status_code == 201
    assert response.json()["source"] == "path"
    assert source.read_bytes() == before


def test_path_import_of_a_missing_file_is_404(client: TestClient, tmp_path: Path) -> None:
    response = client.post("/api/documents", json={"path": str(tmp_path / "nope.pdf")})

    assert response.status_code == 404


# --- AC: deletion semantics ---------------------------------------------------


def test_deleting_an_upload_removes_our_copy(client: TestClient, app, pdf_bytes: bytes) -> None:
    document_id = upload(client, pdf_bytes).json()["document_id"]
    managed = app.state.document_store.document_dir(document_id)
    assert managed.exists()

    assert client.delete(f"/api/documents/{document_id}").status_code == 204

    assert not managed.exists()
    assert client.get(f"/api/documents/{document_id}").status_code == 404


def test_deleting_a_path_import_leaves_the_users_file_alone(
    client: TestClient, app, tmp_path: Path
) -> None:
    """The single most important guarantee in this task."""
    source = make_pdf(tmp_path / "precious.pdf")
    before = source.read_bytes()
    document_id = client.post("/api/documents", json={"path": str(source)}).json()["document_id"]

    assert client.delete(f"/api/documents/{document_id}").status_code == 204

    assert source.exists(), "the user's own file was deleted"
    assert source.read_bytes() == before


def test_deleting_an_unknown_document_is_404(client: TestClient) -> None:
    assert client.delete("/api/documents/doc_nope").status_code == 404


# --- AC: translation lifecycle ------------------------------------------------


@pytest.fixture
def fake_kernel(monkeypatch):
    """Substitute the kernel so the HTTP layer can be tested quickly.

    Writes real files, because the API's job is to place artifacts where the
    frontend can fetch them.
    """
    calls: list[dict] = []

    async def _translate(source, output_dir, target_lang, config, **kwargs):
        calls.append({"source": Path(source), "output": Path(output_dir), **kwargs})

        outcome = fake_kernel.outcome
        if isinstance(outcome, BaseException):
            if fake_kernel.delay:
                await asyncio.sleep(fake_kernel.delay)
            raise outcome

        # Progress is spread across the run, as a real per-page translation is,
        # so a stream attaching shortly after the start still observes it.
        on_progress = kwargs.get("on_progress")
        for page in (1, 2):
            if fake_kernel.delay:
                await asyncio.sleep(fake_kernel.delay)
            if on_progress:
                on_progress(page, 2)

        output_dir = Path(output_dir)
        stem = Path(source).stem
        mono = output_dir / f"{stem}-mono.pdf"
        dual = output_dir / f"{stem}-dual.pdf"
        make_pdf(mono, pages=2)
        make_pdf(dual, pages=4)
        return TranslationResult(
            mono_path=mono, dual_path=dual,
            source_page_count=2, mono_page_count=2, dual_page_count=4,
        )

    fake_kernel.outcome = None
    fake_kernel.delay = 0.0
    fake_kernel.calls = calls
    monkeypatch.setattr("app.documents.tasks.translate_pdf", _translate)
    return fake_kernel


def wait_for_terminal(client: TestClient, task_id: str, timeout: float = 20.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        body = client.get(f"/api/tasks/{task_id}").json()
        if body["status"] in (STATUS_SUCCEEDED, STATUS_FAILED, "CANCELLED"):
            return body
        time.sleep(0.05)
    raise AssertionError(f"task {task_id} never reached a terminal state")


def test_starting_a_translation_returns_immediately(
    client: TestClient, profile_id: str, pdf_bytes: bytes, fake_kernel
) -> None:
    document_id = upload(client, pdf_bytes).json()["document_id"]

    started = time.perf_counter()
    response = client.post(
        f"/api/documents/{document_id}/translate", json={"profile_id": profile_id}
    )
    elapsed = time.perf_counter() - started

    assert response.status_code == 202, response.text
    assert response.json()["task_id"].startswith("task_")
    assert response.json()["status"] == "PENDING"
    assert elapsed < 2.0, "the request waited for the translation"


def test_translation_succeeds_and_artifacts_are_retrievable(
    client: TestClient, profile_id: str, pdf_bytes: bytes, fake_kernel
) -> None:
    document_id = upload(client, pdf_bytes).json()["document_id"]
    task_id = client.post(
        f"/api/documents/{document_id}/translate", json={"profile_id": profile_id}
    ).json()["task_id"]

    body = wait_for_terminal(client, task_id)

    assert body["status"] == STATUS_SUCCEEDED
    assert body["error"] is None
    # Page-level progress only — never a fabricated block count.
    assert body["progress"] == {"page": 2, "page_count": 2}
    assert "blocks_done" not in json.dumps(body)

    mono = client.get(f"/api/documents/{document_id}/translated")
    dual = client.get(f"/api/documents/{document_id}/bilingual")
    assert mono.status_code == 200 and mono.content.startswith(b"%PDF")
    assert dual.status_code == 200
    assert client.get(f"/api/documents/{document_id}").json()["has_translation"] is True


def test_translated_output_has_the_source_page_count(
    client: TestClient, profile_id: str, pdf_bytes: bytes, fake_kernel
) -> None:
    """The bilingual reader depends on mono being N pages, matching the source."""
    document_id = upload(client, pdf_bytes).json()["document_id"]
    task_id = client.post(
        f"/api/documents/{document_id}/translate", json={"profile_id": profile_id}
    ).json()["task_id"]
    wait_for_terminal(client, task_id)

    mono = client.get(f"/api/documents/{document_id}/translated").content
    with fitz.open(stream=mono, filetype="pdf") as document:
        assert document.page_count == 2

    assert client.get(f"/api/documents/{document_id}").json()["page_count"] == 2


def test_provider_failure_surfaces_a_normalised_error(
    client: TestClient, profile_id: str, pdf_bytes: bytes, fake_kernel
) -> None:
    from app.pdfkernel import TranslationServiceError

    fake_kernel.outcome = TranslationServiceError(
        f"Translation aborted — LLM_AUTHENTICATION_ERROR: rejected Bearer {SECRET}"
    )
    document_id = upload(client, pdf_bytes).json()["document_id"]
    task_id = client.post(
        f"/api/documents/{document_id}/translate", json={"profile_id": profile_id}
    ).json()["task_id"]

    body = wait_for_terminal(client, task_id)

    assert body["status"] == STATUS_FAILED
    assert body["error"]["code"] == "TRANSLATION_SERVICE_ERROR"
    assert SECRET not in json.dumps(body), "the API key reached the client"
    # The original is still readable after a failure.
    assert client.get(f"/api/documents/{document_id}/file").status_code == 200


def test_only_one_translation_runs_per_document(
    client: TestClient, profile_id: str, pdf_bytes: bytes, fake_kernel
) -> None:
    """A second start is refused rather than racing the first."""
    # Slowed *before* the first start, so the two attempts genuinely overlap.
    fake_kernel.delay = 2.0
    document_id = upload(client, pdf_bytes).json()["document_id"]

    first = client.post(
        f"/api/documents/{document_id}/translate", json={"profile_id": profile_id}
    )
    assert first.status_code == 202

    second = client.post(
        f"/api/documents/{document_id}/translate", json={"profile_id": profile_id}
    )

    assert second.status_code == 409
    assert second.json()["error"]["code"] == "DOCUMENT_BUSY"


def test_different_documents_translate_independently(
    client: TestClient, profile_id: str, pdf_bytes: bytes, fake_kernel
) -> None:
    first = upload(client, pdf_bytes, "a.pdf").json()["document_id"]
    second = upload(client, pdf_bytes, "b.pdf").json()["document_id"]

    tasks = [
        client.post(f"/api/documents/{d}/translate", json={"profile_id": profile_id}).json()["task_id"]
        for d in (first, second)
    ]

    assert wait_for_terminal(client, tasks[0])["status"] == STATUS_SUCCEEDED
    assert wait_for_terminal(client, tasks[1])["status"] == STATUS_SUCCEEDED


# --- AC: tasks ----------------------------------------------------------------


def test_unknown_task_is_404(client: TestClient) -> None:
    assert client.get("/api/tasks/task_nope").status_code == 404
    assert client.post("/api/tasks/task_nope/cancel").status_code == 404
    assert client.post("/api/tasks/task_nope/retry").status_code == 404


def test_cancelling_a_finished_task_is_refused(
    client: TestClient, profile_id: str, pdf_bytes: bytes, fake_kernel
) -> None:
    document_id = upload(client, pdf_bytes).json()["document_id"]
    task_id = client.post(
        f"/api/documents/{document_id}/translate", json={"profile_id": profile_id}
    ).json()["task_id"]
    wait_for_terminal(client, task_id)

    response = client.post(f"/api/tasks/{task_id}/cancel")

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "TASK_ALREADY_TERMINAL"


def test_retry_is_refused_rather_than_faked(
    client: TestClient, profile_id: str, pdf_bytes: bytes, fake_kernel
) -> None:
    """The kernel has no block-level retry; saying so beats pretending."""
    document_id = upload(client, pdf_bytes).json()["document_id"]
    task_id = client.post(
        f"/api/documents/{document_id}/translate", json={"profile_id": profile_id}
    ).json()["task_id"]
    wait_for_terminal(client, task_id)

    response = client.post(f"/api/tasks/{task_id}/retry")

    assert response.status_code == 501
    assert response.json()["error"]["code"] == "NOT_IMPLEMENTED"


def test_progress_events_stream_over_sse(
    client: TestClient, profile_id: str, pdf_bytes: bytes, fake_kernel
) -> None:
    # Slow enough that the stream attaches before the task finishes. Without
    # this the task can complete first and the stream would wait for an event
    # that will never come.
    fake_kernel.delay = 0.5
    document_id = upload(client, pdf_bytes).json()["document_id"]
    task_id = client.post(
        f"/api/documents/{document_id}/translate", json={"profile_id": profile_id}
    ).json()["task_id"]

    events: list[str] = []
    deadline = time.time() + 30
    with client.stream("GET", f"/api/tasks/{task_id}/events") as stream:
        for line in stream.iter_lines():
            if line.startswith("event:"):
                name = line.split(":", 1)[1].strip()
                events.append(name)
                if name in ("done", "error", "cancelled"):
                    break
            if time.time() > deadline:
                raise AssertionError(f"stream never terminated; saw {events}")

    assert "snapshot" in events, "a late subscriber never learns the current state"
    assert "progress" in events
    assert "done" in events


# --- AC: isolation, recovery, secrets -----------------------------------------


def test_interrupted_tasks_are_failed_on_startup(settings) -> None:
    """A restart orphans in-flight work; it must not look still-running."""
    connection = bootstrap_database(settings.database_path)
    try:
        store = DocumentStore(connection, settings.documents_dir)
        record = store.create_document(name="x.pdf", page_count=1, is_upload=True)
        task = store.create_task(
            document_id=record.id, profile_id="prof_x",
            lang_in="en", lang_out="zh", engine="fast",
        )
        store.update_task(task.id, status="TRANSLATING")

        reconciled = store.reconcile_interrupted_tasks()

        assert reconciled >= 1
        assert store.get_task(task.id).status == STATUS_FAILED
        assert store.get_task(task.id).error_code == PROCESS_INTERRUPTED
    finally:
        connection.close()


def test_no_secret_reaches_any_response(
    client: TestClient, profile_id: str, pdf_bytes: bytes, fake_kernel
) -> None:
    document_id = upload(client, pdf_bytes).json()["document_id"]
    task_id = client.post(
        f"/api/documents/{document_id}/translate", json={"profile_id": profile_id}
    ).json()["task_id"]
    wait_for_terminal(client, task_id)

    for path in (
        "/api/documents",
        f"/api/documents/{document_id}",
        f"/api/tasks/{task_id}",
    ):
        assert SECRET not in json.dumps(client.get(path).json())


def test_document_directories_are_derived_from_the_id_alone(
    client: TestClient, settings, tmp_path: Path
) -> None:
    """A caller-supplied name never becomes part of a path."""
    document_id = upload(client, make_pdf(tmp_path / "a.pdf").read_bytes()).json()["document_id"]

    connection = bootstrap_database(settings.database_path)
    try:
        store = DocumentStore(connection, settings.documents_dir)
        managed = store.document_dir(document_id).resolve()
        assert managed.is_relative_to(Path(settings.documents_dir).resolve())
        # The directory is the id, so a traversal attempt is just a different id.
        assert ".." not in str(managed)
    finally:
        connection.close()


# --- AC: the real kernel, through the API -------------------------------------

@pytest.mark.slow
def test_real_translation_through_the_api(tmp_path: Path) -> None:
    """The claim everything else rests on: the API can actually translate.

    Drives the genuine kernel — real layout detection, a real HTTP call to a
    loopback provider, real PDF regeneration — and asserts the provider was
    *called*, not merely that an output file appeared. A sparse page can produce
    valid-looking output while translating nothing at all (DS-PDF-001).
    """
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    from app.config import Settings
    from app.main import create_app

    calls: list[str] = []

    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
            calls.append(self.path)
            payload = {
                "id": "c", "object": "chat.completion", "model": body.get("model", "m"),
                "choices": [{"index": 0, "message": {"role": "assistant",
                                                     "content": "该策略通过多次轨迹采样进行优化。"},
                             "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 5, "completion_tokens": 5, "total_tokens": 10},
            }
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))

    server = HTTPServer(("127.0.0.1", 0), Provider)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base_url = f"http://127.0.0.1:{server.server_address[1]}/v1"

    settings = Settings(
        host="127.0.0.1", port=8000,
        database_path=tmp_path / "db.sqlite3",
        documents_dir=tmp_path / "documents",
        log_level="INFO",
        cors_origins="http://localhost:5173",
        debug=True,
    )

    # A paper-shaped source: a sparse page is classified as "abandon" and skipped.
    source = Path(tmp_path / "paper.pdf")
    document = fitz.open()
    page = document.new_page(width=595, height=842)
    y = 70
    page.insert_text((72, y), "Learning Stable Policies for Robotic Manipulation", fontsize=15)
    y += 34
    page.insert_text((72, y), "A. Author, B. Author - Institute of Robotics", fontsize=10)
    y += 30
    page.insert_text((72, y), "Abstract", fontsize=12)
    y += 18
    for line in (
        "The policy is optimized through multiple rollouts collected from the simulator.",
        "We evaluate the learned policy on three manipulation benchmarks and report means.",
        "Each rollout is a sequence of observations, actions and rewards gathered under",
        "the current policy, which is then updated from the aggregated trajectories.",
        "Results indicate the proposed representation improves sample efficiency markedly.",
    ):
        page.insert_text((72, y), line, fontsize=10)
        y += 14
    document.save(str(source))
    document.close()

    before = source.read_bytes()

    try:
        with TestClient(create_app(settings)) as client:
            profile = client.post("/api/profiles", json={
                "name": "Loopback", "base_url": base_url, "model": "fake-model",
            }).json()

            document_id = upload(client, source.read_bytes()).json()["document_id"]
            task_id = client.post(
                f"/api/documents/{document_id}/translate",
                json={"profile_id": profile["id"], "lang_in": "en", "lang_out": "zh"},
            ).json()["task_id"]

            body = wait_for_terminal(client, task_id, timeout=300)

            assert body["error"] is None, f"translation failed: {body['error']}"
            assert body["status"] == STATUS_SUCCEEDED, body
            assert calls, "the provider was never called — the run proved nothing"

            mono = client.get(f"/api/documents/{document_id}/translated").content
            with fitz.open(stream=mono, filetype="pdf") as translated:
                assert translated.page_count == 1
                # The translated text is actually present in the output.
                assert "轨迹采样" in translated[0].get_text()

            assert client.get(f"/api/documents/{document_id}/bilingual").status_code == 200
    finally:
        server.shutdown()

    # The source the user handed us is untouched.
    assert source.read_bytes() == before
