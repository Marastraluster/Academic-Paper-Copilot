"""Related papers: two indexes, identification, ties to the text, and the
routes — all offline against `httpx.MockTransport`.

The rules that matter: nothing is sent without a search profile; a paper is
never confused with a different one that merely has a similar title; the key
goes where the index wants it; "import" fetches only what the index listed, and
never from this machine or a private network.
"""

from __future__ import annotations

import io
import json
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import fitz
import httpx
import pytest

from app.document.extract import _fingerprint
from app.document.persistence import read_ir, write_ir
from app.llm.base import LLMProvider
from app.llm.models import LLMRequest, LLMResult
from app.mineru.convert import middle_json_to_ir
from app.mineru.jobs import page_geometry
from app.related import sources
from app.related.service import find_identifier, link_references
from app.related.sources import OpenAlexSource, SemanticScholarSource, Work
from app.storage.profiles import ServiceConfig
from tests.test_bilingual import an_ir, block, paragraph, section
from tests.test_mineru import make_pdf, middle_v4

PAPER = "Residual Shortcuts for Image Recognition"


def oa_raw(key: str, title: str, *, refs=(), related=(), pdf: str | None = None, cited=10) -> dict:
    return {
        "id": f"https://openalex.org/{key}",
        "display_name": title,
        "publication_year": 2016,
        "authorships": [{"author": {"display_name": "K. He"}}],
        "primary_location": {"source": {"display_name": "CVPR"}},
        "doi": f"https://doi.org/10.1/{key.lower()}",
        "cited_by_count": cited,
        "abstract_inverted_index": {"Deep": [0], "networks": [1], "train": [3], "hard": [2]},
        "best_oa_location": {"pdf_url": pdf} if pdf else None,
        "referenced_works": [f"https://openalex.org/{r}" for r in refs],
        "related_works": [f"https://openalex.org/{r}" for r in related],
    }


class FakeOpenAlex:
    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.pdf = b""

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        url = urlparse(str(request.url))
        query = {k: v[0] for k, v in parse_qs(url.query).items()}
        if url.hostname == "oa.example.org":
            return httpx.Response(200, content=self.pdf, headers={"content-type": "application/pdf"})
        if url.path.startswith("/works/doi:"):
            return httpx.Response(404)
        if url.path == "/works" and "search" in query:
            if query["search"] == PAPER:
                return httpx.Response(200, json={"results": [
                    oa_raw("W9", "Residual shortcuts for image recognition",
                           refs=["W1", "W2"], related=["W5", "W1"]),
                    oa_raw("W8", "Residual learning for speech"),
                ]})
            return httpx.Response(200, json={"results": [oa_raw("W7", "A search hit")]})
        if url.path == "/works" and query.get("filter", "").startswith("openalex_id:"):
            ids = query["filter"].split(":", 1)[1].split("|")
            titles = {"W1": "Deep residual learning", "W2": "Highway networks", "W5": "Densely connected networks"}
            return httpx.Response(200, json={"results": [
                oa_raw(i, titles[i], pdf="https://oa.example.org/w1.pdf" if i == "W1" else None)
                for i in reversed(ids)
            ]})
        if url.path == "/works" and query.get("filter", "").startswith("cites:"):
            return httpx.Response(200, json={"results": [oa_raw("W3", "Identity mappings", cited=900)]})
        return httpx.Response(404)


def search_service(protocol: str = "openalex", key: str = "oa-key-123") -> ServiceConfig:
    base = "https://api.openalex.org" if protocol == "openalex" else "https://api.semanticscholar.org"
    return ServiceConfig(kind="search", protocol=protocol, base_url=base, model="",
                         api_key=key, timeout_s=30.0, custom_headers=None)


@pytest.fixture
def openalex(monkeypatch) -> FakeOpenAlex:
    fake = FakeOpenAlex()
    monkeypatch.setattr(sources, "TRANSPORT", httpx.MockTransport(fake))
    return fake


class TestOpenAlex:
    async def test_identify_by_title_then_batch_the_references(self, openalex) -> None:
        source = OpenAlexSource(search_service())
        work = await source.identify(PAPER, "10.1/missing")
        assert work is not None and work.key == "W9"
        refs = await source.references(work, 60)
        assert [w.key for w in refs] == ["W1", "W2"]  # the paper's own order, not the API's
        assert refs[0].abstract == "Deep networks hard train"
        # One batched call for every reference, not one per reference.
        assert sum(1 for r in openalex.requests if "openalex_id" in str(r.url)) == 1
        assert all(r.headers["authorization"] == "Bearer oa-key-123" for r in openalex.requests)

    async def test_a_different_paper_with_a_similar_title_is_not_accepted(self, openalex) -> None:
        source = OpenAlexSource(search_service())
        assert await source.identify("Residual learning for speech recognition systems", None) is None


class TestSemanticScholar:
    async def test_key_header_and_citing_sorted_by_citations(self, monkeypatch) -> None:
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            path = request.url.path
            if path.startswith("/graph/v1/paper/DOI:"):
                return httpx.Response(200, json={"paperId": "S9", "title": PAPER})
            if path.endswith("/citations"):
                return httpx.Response(200, json={"data": [
                    {"citingPaper": {"paperId": "a", "title": "A", "citationCount": 3}},
                    {"citingPaper": {"paperId": "b", "title": "B", "citationCount": 40}},
                ]})
            return httpx.Response(404)

        monkeypatch.setattr(sources, "TRANSPORT", httpx.MockTransport(handler))
        source = SemanticScholarSource(search_service("semantic_scholar", key="s2-key"))
        work = await source.identify(None, "10.48550/arXiv.1512.03385")
        citing = await source.citing(work, 5)
        assert [w.key for w in citing] == ["b", "a"]
        assert seen[0].headers["x-api-key"] == "s2-key"
        assert "authorization" not in seen[0].headers


class TestTiesToTheText:
    def test_doi_and_arxiv_are_found_on_the_first_pages(self) -> None:
        ir = an_ir([], [], blocks=[block("b1", 1, "arXiv:1512.03385v1 [cs.CV] 10 Dec 2015")])
        assert find_identifier(ir) == "10.48550/arXiv.1512.03385"
        ir2 = an_ir([], [], blocks=[block("b1", 1, "https://doi.org/10.1109/CVPR.2016.90.")])
        assert find_identifier(ir2) == "10.1109/CVPR.2016.90"

    def test_a_reference_finds_its_entry_and_the_first_sentence_citing_it(self) -> None:
        ir = an_ir(
            [
                paragraph("p1", "Depth matters [3].", section="s1"),
                paragraph("p2", "Plain nets degrade [1, 4-6].", section="s1"),
                paragraph("r1", "[1] R. Srivastava, K. Greff. Highway networks. arXiv 2015.", section="refs"),
                paragraph("r2", "[5] K. He et al. Deep residual learning for image recognition. CVPR.", section="refs"),
            ],
            [section("s1", "1 Introduction"), section("refs", "References", references=True)],
        )
        links = link_references(ir, [
            Work(key="W2", title="Highway Networks"),
            Work(key="W1", title="Deep Residual Learning for Image Recognition"),
            Work(key="W0", title="Something not in the bibliography"),
        ])
        assert links["W2"].entry_paragraph_id == "r1" and links["W2"].cited_in_paragraph_id == "p2"
        assert links["W1"].marker == 5 and links["W1"].cited_in_paragraph_id == "p2"
        assert "W0" not in links


# --- over HTTP ----------------------------------------------------------------


@pytest.fixture
def paper(client, tmp_path: Path):
    source = make_pdf(tmp_path / "paper.pdf")
    document_id = client.post("/api/documents", json={"path": str(source)}).json()["document_id"]
    middle = middle_v4()
    middle["pages"][0]["blocks"][1]["content"] = [{"type": "text", "content": PAPER}]
    ir = middle_json_to_ir(
        middle, document_id=document_id, content_hash=_fingerprint(source)[0],
        source_filename="paper.pdf", pages=page_geometry(source),
    )
    write_ir(client.app.state.document_store.document_dir(document_id), ir)
    return document_id


def add_search_profile(client) -> str:
    response = client.post("/api/profiles", json={
        "name": "OpenAlex", "kind": "search", "base_url": "https://api.openalex.org", "api_key": "oa-key-123",
    })
    assert response.status_code == 201, response.text
    return response.json()["id"]


class Explainer(LLMProvider):
    protocol = "scripted"

    def __init__(self) -> None:
        self.calls = 0

    async def generate(self, request: LLMRequest) -> LLMResult:
        self.calls += 1
        keys = [json.loads(line)["key"] for line in request.messages[1].content.splitlines() if line.startswith("{")]
        body = {"items": [{"key": k, "relation": f"{k} 与本文相关"} for k in keys]}
        return LLMResult(text=json.dumps(body, ensure_ascii=False), model="m", protocol="scripted")

    async def test_connection(self):  # pragma: no cover
        raise NotImplementedError


def pdf_bytes() -> bytes:
    document = fitz.open()
    document.new_page()
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


class TestOverHttp:
    def test_nothing_is_sent_without_a_search_profile(self, client, paper, openalex) -> None:
        response = client.get(f"/api/documents/{paper}/related")
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "SEARCH_NOT_CONFIGURED"
        assert openalex.requests == []

    def test_related_explain_and_import(self, client, paper, openalex, monkeypatch) -> None:
        add_search_profile(client)
        body = client.get(f"/api/documents/{paper}/related").json()
        kinds = {p["key"]: p["kind"] for p in body["papers"]}
        assert kinds == {"W1": "reference", "W2": "reference", "W3": "citing", "W5": "similar"}
        assert body["identified"]["key"] == "W9" and body["cached"] is False
        # The bibliography entry the reference came from, found by title.
        w2 = next(p for p in body["papers"] if p["key"] == "W2")
        assert w2["entry_paragraph_id"] is not None

        sent = len(openalex.requests)
        assert client.get(f"/api/documents/{paper}/related").json()["cached"] is True
        assert len(openalex.requests) == sent

        explainer = Explainer()

        async def resolve(config, protocol):
            return explainer

        import app.llm.detection as detection

        monkeypatch.setattr(detection, "resolve_provider", resolve)
        chat = client.post("/api/profiles", json={"name": "Chat", "base_url": "http://127.0.0.1:1/v1", "model": "m"}).json()
        explained = client.post(f"/api/documents/{paper}/related/explain",
                                json={"profile_id": chat["id"], "keys": ["W1", "W3"]}).json()
        assert explained["relations"] == {"W1": "W1 与本文相关", "W3": "W3 与本文相关"}
        client.post(f"/api/documents/{paper}/related/explain", json={"profile_id": chat["id"], "keys": ["W1"]})
        assert explainer.calls == 1  # explained once, then read back

        openalex.pdf = pdf_bytes()
        imported = client.post(f"/api/documents/{paper}/related/import", json={"key": "W1"})
        assert imported.status_code == 201, imported.text
        assert imported.json()["name"].startswith("Deep residual learning")
        no_pdf = client.post(f"/api/documents/{paper}/related/import", json={"key": "W2"})
        assert no_pdf.status_code == 409
        unknown = client.post(f"/api/documents/{paper}/related/import", json={"key": "W999"})
        assert unknown.status_code == 404

    def test_cached_links_follow_the_paper_when_it_is_parsed_again(self, client, paper, openalex) -> None:
        # Seen live: results cached under the built-in reading, the paper then
        # parsed with MinerU — same content hash, different paragraph ids.
        add_search_profile(client)
        first = client.get(f"/api/documents/{paper}/related").json()
        entry = next(p for p in first["papers"] if p["key"] == "W2")["entry_paragraph_id"]

        directory = client.app.state.document_store.document_dir(paper)
        ir = read_ir(directory)
        for paragraph in ir.paragraphs:
            paragraph.id = paragraph.id + "_again"
        write_ir(directory, ir)

        sent = len(openalex.requests)
        again = client.get(f"/api/documents/{paper}/related").json()
        assert again["cached"] is True and len(openalex.requests) == sent
        assert next(p for p in again["papers"] if p["key"] == "W2")["entry_paragraph_id"] == entry + "_again"

    def test_a_private_address_is_never_fetched(self, client, paper, openalex) -> None:
        from app.api.related import _public_http_url

        assert not _public_http_url("http://127.0.0.1:8000/api/documents")
        assert not _public_http_url("http://192.168.1.10/paper.pdf")
        assert not _public_http_url("http://localhost/paper.pdf")
        assert not _public_http_url("file:///etc/passwd")
        assert _public_http_url("https://arxiv.org/pdf/1512.03385")

    def test_free_text_search(self, client, paper, openalex) -> None:
        add_search_profile(client)
        body = client.get(f"/api/documents/{paper}/related/search", params={"q": "highway"}).json()
        assert [p["key"] for p in body["papers"]] == ["W7"]

    def test_the_profile_test_runs_one_search(self, client, openalex) -> None:
        pid = add_search_profile(client)
        result = client.post(f"/api/profiles/{pid}/test").json()
        assert result["ok"] is True and result["protocol"] == "openalex"
