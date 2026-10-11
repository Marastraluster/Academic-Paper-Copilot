"""MinerU — profiles, the v1 client, the conversion to IR, the parse job, and
formula-safe translation.

Offline throughout: the client is exercised against an `httpx.MockTransport`
that plays a MinerU server, and the job against a fake client. What is checked
is what a reader would notice if it broke — a formula translated into prose, a
key sent to a third-party upload host, a paragraph split at a page break, a
bibliography read as body text.
"""

from __future__ import annotations

import io
import json
import time
import zipfile
from pathlib import Path

import fitz
import httpx
import pytest

from app.bilingual.mathguard import protect, restore
from app.bilingual.pipeline import generate_bilingual, non_prose_blocks
from app.document.service import is_reusable
from app.llm.base import LLMProvider
from app.llm.models import LLMRequest, LLMResult
from app.mineru import jobs
from app.mineru.client import MinerUClient, MinerUError, ParseOutput, normalize_base_url, probe_mineru
from app.mineru.convert import (
    MINERU_PIPELINE_VERSION,
    MinerUConversionError,
    PageGeometry,
    middle_json_to_ir,
)
from app.storage.profiles import ServiceConfig

PAGES = [PageGeometry(600.0, 800.0), PageGeometry(600.0, 800.0)]


def span(text: str) -> dict:
    return {"type": "text", "content": text}


def math(latex: str) -> dict:
    return {"type": "equation_inline", "content": latex}


def middle_v4() -> dict:
    """Two pages of a small paper, in MinerU 4's middle JSON."""
    return {
        "schema": "docvortex.middle",
        "schema_version": "2.0",
        "is_full_document": True,
        "metadata": {"file_suffix": "pdf", "producer": {"name": "mineru", "version": "4.0.12"}},
        "pages": [
            {
                "page_idx": 0,
                "blocks": [
                    {"type": "header", "index": 0, "bbox": [0.1, 0.01, 0.9, 0.03], "content": [span("arXiv preprint")]},
                    {"type": "doc_title", "index": 1, "level": 1, "bbox": [0.2, 0.05, 0.8, 0.1],
                     "content": [span("Residual Shortcuts for Image Recognition")]},
                    {"type": "paragraph_title", "index": 2, "level": 2, "bbox": [0.1, 0.12, 0.4, 0.14],
                     "content": [span("Abstract")]},
                    {"type": "text", "index": 3, "bbox": [0.1, 0.15, 0.9, 0.3],
                     "content": [span("Deep networks are hard to train.")]},
                    {"type": "paragraph_title", "index": 4, "level": 2, "bbox": [0.1, 0.32, 0.5, 0.34],
                     "content": [span("1 Introduction")]},
                    {"type": "text", "index": 5, "bbox": [0.1, 0.35, 0.9, 0.9],
                     "content": [span("We let the layers fit"), math("F(x) = H(x) - x"), span("and add the input")]},
                    {"type": "page_number", "index": 6, "bbox": [0.48, 0.96, 0.52, 0.98], "content": [span("1")]},
                ],
            },
            {
                "page_idx": 1,
                "blocks": [
                    {"type": "text", "index": 0, "bbox": [0.1, 0.05, 0.9, 0.1], "continues_prev": True,
                     "content": [span("back, so a deeper network is no harder to optimise.")]},
                    {"type": "equation", "index": 1, "bbox": [0.3, 0.12, 0.7, 0.16],
                     "content": "y = \\mathcal{F}(x, \\{W_i\\}) + x", "image_path": "images/eq1.jpg"},
                    {"type": "paragraph_title", "index": 2, "level": 3, "bbox": [0.1, 0.18, 0.5, 0.2],
                     "content": [span("1.1 Shortcuts")]},
                    {"type": "image", "index": 3, "bbox": [0.1, 0.22, 0.9, 0.4], "content": [
                        {"type": "image_body", "index": 3, "bbox": [0.1, 0.22, 0.9, 0.4], "content": "",
                         "image_path": "images/fig1.jpg"},
                        {"type": "image_caption", "bbox": [0.1, 0.41, 0.9, 0.43],
                         "content": [span("Figure 1. Training error.")]},
                    ]},
                    {"type": "table", "index": 4, "bbox": [0.1, 0.45, 0.9, 0.6], "content": [
                        {"type": "table_caption", "bbox": [0.1, 0.44, 0.9, 0.45], "content": [span("Table 1. Stages.")]},
                        {"type": "table_body", "index": 4, "bbox": [0.1, 0.45, 0.9, 0.6],
                         "content": "<table><tr><td>conv2_x</td><td>56</td></tr></table>",
                         "image_path": "images/tab1.jpg"},
                    ]},
                    {"type": "list", "index": 5, "bbox": [0.1, 0.62, 0.9, 0.9], "sub_type": "ref_text", "content": [
                        {"type": "ref_text", "bbox": [0.1, 0.62, 0.9, 0.7], "content": [span("[1] K. He. Deep residual learning.")]},
                        {"type": "ref_text", "bbox": [0.1, 0.71, 0.9, 0.8], "content": [span("[2] R. Srivastava. Highway networks.")]},
                    ]},
                ],
            },
        ],
    }


def convert(middle: dict):
    return middle_json_to_ir(
        middle,
        document_id="doc_1",
        content_hash="c" * 64,
        source_filename="paper.pdf",
        pages=PAGES,
    )


# --- conversion ----------------------------------------------------------------


class TestConversion:
    def test_paragraphs_keep_inline_math_and_join_across_pages(self) -> None:
        ir = convert(middle_v4())
        assert ir.pipeline_version == MINERU_PIPELINE_VERSION
        texts = [p.text for p in ir.paragraphs]
        joined = next(t for t in texts if t.startswith("We let"))
        # One paragraph, not two: MinerU said the page-2 block continues it.
        assert joined == (
            "We let the layers fit $F(x) = H(x) - x$ and add the input "
            "back, so a deeper network is no harder to optimise."
        )
        paragraph = next(p for p in ir.paragraphs if p.text.startswith("We let"))
        assert paragraph.page_range == (1, 2)
        assert len(paragraph.block_ids) == 2

    def test_a_paragraph_continues_past_a_floating_figure_or_table(self) -> None:
        # Seen on a real two-column paper (ResNet, MinerU 4.0.7): the figure at
        # the top of the next column sits between a paragraph's two halves, and
        # MinerU marks the second half `continues_prev`. Eight paragraphs were
        # cut mid-sentence there, one of them mid-word.
        middle = middle_v4()
        middle["pages"][1]["blocks"] = [
            {"type": "text", "index": 0, "bbox": [0.1, 0.05, 0.45, 0.2],
             "content": [span("VGG's paper re-")]},
            {"type": "table", "index": 1, "bbox": [0.55, 0.05, 0.9, 0.2], "content": [
                {"type": "table_body", "index": 1, "bbox": [0.55, 0.05, 0.9, 0.2],
                 "content": "<table><tr><td>9.0</td></tr></table>"},
                {"type": "table_caption", "bbox": [0.55, 0.21, 0.9, 0.23], "content": [span("Table 13. Error.")]},
            ]},
            {"type": "text", "index": 2, "bbox": [0.55, 0.25, 0.9, 0.4], "continues_prev": True,
             "content": [span("ports a center-crop error of 33.1%.")]},
            {"type": "image", "index": 3, "bbox": [0.55, 0.42, 0.9, 0.6], "content": [
                {"type": "image_body", "index": 3, "bbox": [0.55, 0.42, 0.9, 0.6], "content": ""},
            ]},
            {"type": "text", "index": 4, "bbox": [0.55, 0.62, 0.9, 0.7],
             "content": [span("A new paragraph after the figure.")]},
        ]
        texts = [p.text for p in convert(middle).paragraphs]
        assert "VGG's paper reports a center-crop error of 33.1%." in texts
        # Text MinerU did not mark still starts its own paragraph.
        assert "A new paragraph after the figure." in texts
        assert all("Table 13" not in t for t in texts)

    def test_an_unmarked_page_break_mid_sentence_is_still_one_paragraph(self) -> None:
        # Real case (ResNet p.4→5): no `continues_prev`, but the page ends on
        # "… the degradation problem - the" and the next opens "34-layer plain net".
        cut = "We compare their training errors during the whole procedure and observe the degradation problem - the"
        middle = middle_v4()
        middle["pages"][0]["blocks"][5] = {
            "type": "text", "index": 5, "bbox": [0.55, 0.6, 0.9, 0.9], "content": [span(cut)]}
        middle["pages"][1]["blocks"] = [
            {"type": "text", "index": 0, "bbox": [0.1, 0.05, 0.45, 0.2],
             "content": [span("34-layer plain net has higher training error.")]},
            # Below it in the same column, after a finished sentence: its own paragraph.
            {"type": "text", "index": 1, "bbox": [0.1, 0.22, 0.45, 0.4],
             "content": [span("We argue that this is not caused by vanishing gradients, and neither is it caused by")]},
            {"type": "text", "index": 2, "bbox": [0.1, 0.42, 0.45, 0.6],
             "content": [span("A paragraph right below an unfinished one is not joined to it.")]},
        ]
        texts = [p.text for p in convert(middle).paragraphs]
        assert f"{cut} 34-layer plain net has higher training error." in texts
        assert "A paragraph right below an unfinished one is not joined to it." in texts

    def test_furniture_is_abandoned_and_never_prose(self) -> None:
        ir = convert(middle_v4())
        assert all("arXiv" not in p.text for p in ir.paragraphs)
        classes = [b.layout_class for b in ir.pages[0].blocks]
        assert classes.count("abandon") == 2

    def test_title_sections_levels_and_abstract(self) -> None:
        ir = convert(middle_v4())
        assert ir.metadata.title == "Residual Shortcuts for Image Recognition"
        titles = [s.title for s in ir.sections]
        assert titles[:3] == ["Abstract", "1 Introduction", "1.1 Shortcuts"]
        intro = ir.sections[1]
        sub = ir.sections[2]
        assert sub.parent_id == intro.id
        abstract = [p for p in ir.paragraphs if p.is_abstract]
        assert [p.text for p in abstract] == ["Deep networks are hard to train."]

    def test_bibliography_is_a_references_section(self) -> None:
        ir = convert(middle_v4())
        refs = [s for s in ir.sections if s.is_references]
        assert len(refs) == 1
        ref_paragraphs = [p for p in ir.paragraphs if p.section_id == refs[0].id]
        assert [p.text[:3] for p in ref_paragraphs] == ["[1]", "[2]"]

    def test_formula_table_and_figure_carry_what_mineru_recovered(self) -> None:
        ir = convert(middle_v4())
        blocks = {b.layout_class: b for b in ir.pages[1].blocks}
        assert blocks["isolate_formula"].latex == "y = \\mathcal{F}(x, \\{W_i\\}) + x"
        assert blocks["table"].html.startswith("<table>")
        assert blocks["figure"].image_path == "images/fig1.jpg"
        assert blocks["figure_caption"].caption_of == blocks["figure"].id
        assert blocks["table_caption"].caption_of == blocks["table"].id
        # The formula is annotatable, like under the in-house extractor.
        assert blocks["isolate_formula"].source_anchor_id

    def test_coordinates_are_points(self) -> None:
        ir = convert(middle_v4())
        first = ir.pages[0].blocks[0]
        assert first.bbox == (60.0, 8.0, 540.0, 24.0)

    def test_ids_and_anchors_are_deterministic(self) -> None:
        a, b = convert(middle_v4()), convert(middle_v4())
        assert [p.id for p in a.paragraphs] == [p.id for p in b.paragraphs]
        assert [p.source_anchor_id for p in a.paragraphs] == [p.source_anchor_id for p in b.paragraphs]
        assert a.paragraphs[0].id == "p_doc_1_0001"

    def test_legacy_pdf_info_is_read(self) -> None:
        legacy = {
            "pdf_info": [
                {
                    "page_idx": 0,
                    "page_size": [300, 400],
                    "para_blocks": [
                        {"type": "title", "bbox": [10, 10, 100, 20], "lines": [{"spans": [{"type": "text", "content": "2 Method"}]}]},
                        {"type": "text", "bbox": [10, 30, 290, 80], "lines": [
                            {"spans": [{"type": "text", "content": "The residual"}, {"type": "inline_equation", "content": "F"}, {"type": "text", "content": "is learned by recog-"}]},
                            {"spans": [{"type": "text", "content": "nition layers."}]},
                        ]},
                        {"type": "interline_equation", "bbox": [50, 90, 250, 110], "lines": [{"spans": [{"type": "interline_equation", "content": "y = F(x) + x"}]}]},
                    ],
                    "discarded_blocks": [{"type": "discarded", "bbox": [0, 390, 300, 400], "lines": [{"spans": [{"type": "text", "content": "3"}]}]}],
                }
            ]
        }
        ir = middle_json_to_ir(
            legacy, document_id="doc_2", content_hash="d" * 64, source_filename="x.pdf",
            pages=[PageGeometry(600.0, 800.0)],
        )
        assert ir.paragraphs[0].text == "The residual $F$ is learned by recognition layers."
        assert ir.sections[0].title == "2 Method"
        formula = next(b for b in ir.pages[0].blocks if b.layout_class == "isolate_formula")
        assert formula.latex == "y = F(x) + x"
        # Scaled from the 300×400 space MinerU worked in to the PDF's own points.
        assert formula.bbox == (100.0, 180.0, 500.0, 220.0)

    def test_unknown_json_is_refused(self) -> None:
        with pytest.raises(MinerUConversionError):
            convert({"nothing": []})

    def test_a_mineru_ir_is_reused_rather_than_re_extracted(self) -> None:
        assert is_reusable(convert(middle_v4()), "doc_1")


# --- formula guard -----------------------------------------------------------


class TestMathGuard:
    def test_round_trip(self) -> None:
        masked, formulas = protect("Let $F(x)$ be the residual and $x$ the input.")
        assert "$" not in masked and formulas == ["$F(x)$", "$x$"]
        back = restore("设 ⟦m1⟧ 为残差，⟦m2⟧ 为输入。", formulas)
        assert back == "设 $F(x)$ 为残差，$x$ 为输入。"

    def test_a_lost_or_repeated_formula_is_rejected(self) -> None:
        _, formulas = protect("Let $F$ and $x$.")
        assert restore("设 ⟦m1⟧。", formulas) is None
        assert restore("设 ⟦m1⟧ ⟦m1⟧ ⟦m2⟧。", formulas) is None
        assert restore("plain", []) == "plain"
        assert restore("stray ⟦m1⟧", []) is None

    def test_escaped_dollars_are_not_math(self) -> None:
        masked, formulas = protect(r"costs \$5 and $y$")
        assert formulas == ["$y$"] and r"\$5" in masked


class EchoProvider(LLMProvider):
    """Translates by echoing the masked text, so placeholders come back."""

    protocol = "scripted"

    def __init__(self, drop_placeholders: bool = False) -> None:
        self.drop = drop_placeholders
        self.prompts: list[str] = []

    async def generate(self, request: LLMRequest) -> LLMResult:
        import re

        content = next(m.content for m in request.messages if "Paragraphs:" in m.content)
        self.prompts.append(content)
        paragraph_part = content.partition("Paragraphs:")[2]
        pairs = re.findall(r"^\[([^\]]+)\] (.*)$", paragraph_part, re.MULTILINE)
        out = []
        for key, text in pairs:
            translated = "译：" + text
            if self.drop:
                translated = re.sub(r"⟦m\d+⟧", "", translated)
            out.append({"id": key, "text": translated})
        return LLMResult(text=json.dumps({"headings": [], "paragraphs": out}), model="m", protocol="scripted")

    async def test_connection(self):  # pragma: no cover
        raise NotImplementedError


class TestTranslationKeepsFormulas:
    async def test_formulas_never_reach_the_model_and_come_back_verbatim(self) -> None:
        ir = convert(middle_v4())
        provider = EchoProvider()
        outcome = await generate_bilingual(ir, provider, target_language="zh-CN")
        assert all("F(x) = H(x)" not in prompt for prompt in provider.prompts)
        row = next(p for p in outcome.artifact.paragraphs if p.source_text.startswith("We let"))
        assert "$F(x) = H(x) - x$" in row.translated_text
        assert row.status == "translated"

    async def test_a_translation_that_drops_a_formula_is_reported_not_shown(self) -> None:
        ir = convert(middle_v4())
        outcome = await generate_bilingual(ir, EchoProvider(drop_placeholders=True), target_language="zh-CN")
        row = next(p for p in outcome.artifact.paragraphs if p.source_text.startswith("We let"))
        assert row.status == "untranslated"
        plain = next(p for p in outcome.artifact.paragraphs if p.source_text.startswith("Deep networks"))
        assert plain.status == "translated"

    def test_the_column_receives_latex_tables_and_images(self) -> None:
        blocks = non_prose_blocks(convert(middle_v4()))
        by_class = {b.layout_class: b for b in blocks}
        assert by_class["isolate_formula"].latex
        assert by_class["table"].html
        assert by_class["figure"].image_path == "images/fig1.jpg"
        assert by_class["figure_caption"].caption_of == by_class["figure"].block_id


# --- the v1 client -------------------------------------------------------------


def result_zip(middle: dict) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as bundle:
        bundle.writestr("middle_json.json", json.dumps(middle))
        bundle.writestr("markdown.md", "# x")
        bundle.writestr("images/fig1.jpg", b"\xff\xd8jpeg")
        bundle.writestr("../evil.jpg", b"nope")
    return buffer.getvalue()


def service(base: str = "http://127.0.0.1:8100", key: str = "sk-secret-123456", tier: str = "flash") -> ServiceConfig:
    return ServiceConfig(
        kind="parser", protocol="mineru_v1", base_url=base, model=tier,
        api_key=key, timeout_s=30.0, custom_headers=None,
    )


class FakeMinerU:
    """A v1 server whose uploads go to a presigned URL on another host."""

    def __init__(self, *, fail_auth: bool = False, polls_before_done: int = 2) -> None:
        self.fail_auth = fail_auth
        self.polls_left = polls_before_done
        self.seen: list[httpx.Request] = []
        self.submitted: dict | None = None

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.seen.append(request)
        path, host = request.url.path, request.url.host
        if host == "objects.example":
            return httpx.Response(200)
        if self.fail_auth:
            return httpx.Response(401, json={"error": {"code": "invalid_api_key", "message": "bad key"}})
        if path == "/v1/health":
            return httpx.Response(200, json={"status": "ok", "version": "4.0.12"})
        if path == "/v1/usage":
            return httpx.Response(200, json={"used": 1})
        if path == "/v1/uploads":
            return httpx.Response(200, json={
                "id": "up_1", "status": "pending",
                "upload_url": "https://objects.example/bucket/up_1?sig=abc",
                "upload_headers": {"Content-Type": "application/pdf"},
            })
        if path == "/v1/uploads/up_1/complete":
            return httpx.Response(200, json={"status": "completed", "file": {"id": "file_src"}})
        if path == "/v1/parse/jobs" and request.method == "POST":
            self.submitted = json.loads(request.content)
            return httpx.Response(202, json={"job_id": "job_1", "status": "queued", "files": []})
        if path == "/v1/parse/jobs/job_1":
            self.polls_left -= 1
            if self.polls_left > 0:
                return httpx.Response(200, json={"job_id": "job_1", "status": "running", "files": []})
            return httpx.Response(200, json={
                "job_id": "job_1", "status": "completed", "tier": "flash",
                "files": [{"status": "completed", "output_files": {"zip": {"file_id": "file_zip"}},
                           "parse": {"duration_ms": 1234}}],
            })
        if path == "/v1/files/file_zip/content":
            return httpx.Response(200, content=result_zip(middle_v4()))
        return httpx.Response(404)


class TestClient:
    async def test_the_whole_flow_and_the_key_stays_home(self, tmp_path: Path) -> None:
        pdf = tmp_path / "paper.pdf"
        pdf.write_bytes(b"%PDF-1.4 fake")
        server = FakeMinerU()
        statuses: list[str] = []
        client = MinerUClient(service(), transport=httpx.MockTransport(server), poll_interval_s=0)
        out = await client.parse(pdf, on_status=statuses.append)

        assert out.middle_json["pages"][0]["page_idx"] == 0
        assert out.assets == {"images/fig1.jpg": b"\xff\xd8jpeg"}  # the traversal entry is dropped
        assert out.duration_ms == 1234 and out.tier == "flash"
        assert statuses == ["uploading", "queued", "running", "completed"]
        assert server.submitted == {
            "files": [{"source": {"type": "file_id", "file_id": "file_src"}}],
            "output_formats": ["zip"],
            "tier": "flash",
        }
        for request in server.seen:
            if request.url.host == "objects.example":
                assert "authorization" not in request.headers
            else:
                assert request.headers["authorization"] == "Bearer sk-secret-123456"

    async def test_a_refused_key_is_named_and_not_repeated(self, tmp_path: Path) -> None:
        pdf = tmp_path / "paper.pdf"
        pdf.write_bytes(b"%PDF-1.4 fake")
        client = MinerUClient(service(), transport=httpx.MockTransport(FakeMinerU(fail_auth=True)))
        with pytest.raises(MinerUError) as caught:
            await client.parse(pdf)
        assert caught.value.code == "MINERU_AUTH_FAILED"
        assert "sk-secret" not in str(caught.value)

    async def test_an_unreachable_server_is_named(self, tmp_path: Path) -> None:
        def down(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("refused", request=request)

        outcome = await probe_mineru(service(), transport=httpx.MockTransport(down))
        assert not outcome.ok and outcome.code == "MINERU_UNREACHABLE"

    async def test_probe_checks_the_key_when_one_is_set(self) -> None:
        server = FakeMinerU()
        outcome = await probe_mineru(service(), transport=httpx.MockTransport(server))
        assert outcome.ok and outcome.detail == "MinerU 4.0.12"
        assert [r.url.path for r in server.seen] == ["/v1/health", "/v1/usage"]

    def test_base_url_forms(self) -> None:
        assert normalize_base_url("https://mineru.net/api/") == "https://mineru.net/api"
        assert normalize_base_url("http://127.0.0.1:8000/v1") == "http://127.0.0.1:8000"


# --- profiles ---------------------------------------------------------------


class TestParserProfiles:
    def test_create_list_and_read_back(self, client) -> None:
        created = client.post("/api/profiles", json={
            "name": "MinerU local", "base_url": "http://127.0.0.1:8100", "kind": "parser", "model": "basic",
        })
        assert created.status_code == 201, created.text
        body = created.json()
        assert body["kind"] == "parser" and body["protocol"] == "mineru_v1" and body["model"] == "basic"
        client.post("/api/profiles", json={"name": "Chat", "base_url": "http://127.0.0.1:1/v1", "model": "m"})
        parsers = client.get("/api/profiles", params={"kind": "parser"}).json()
        assert [p["name"] for p in parsers] == ["MinerU local"]
        assert len(client.get("/api/profiles").json()) == 2

    def test_bad_tier_and_wrong_protocol_are_refused(self, client) -> None:
        bad = client.post("/api/profiles", json={
            "name": "x", "base_url": "http://127.0.0.1:1", "kind": "parser", "model": "turbo",
        })
        assert bad.status_code == 400
        wrong = client.post("/api/profiles", json={
            "name": "y", "base_url": "http://127.0.0.1:1", "kind": "parser", "protocol": "responses",
        })
        assert wrong.status_code == 400
        chat_without_model = client.post("/api/profiles", json={"name": "z", "base_url": "http://127.0.0.1:1"})
        assert chat_without_model.status_code == 400


# --- the job, end to end over HTTP --------------------------------------------


class FakeClient:
    def __init__(self, service: ServiceConfig, **_: object) -> None:
        self.service = service

    async def parse(self, pdf_path: Path, *, on_status=None) -> ParseOutput:
        if on_status:
            on_status("running")
        return ParseOutput(middle_json=middle_v4(), assets={"images/fig1.jpg": b"\xff\xd8jpeg"}, status="completed")


def make_pdf(path: Path) -> Path:
    document = fitz.open()
    for _ in range(2):
        page = document.new_page(width=600, height=800)
        page.insert_text((72, 72), "Deep networks are hard to train.")
    document.save(str(path))
    document.close()
    return path


class TestParseJob:
    def test_parse_replaces_the_ir_and_serves_its_images(self, client, monkeypatch, tmp_path: Path) -> None:
        monkeypatch.setattr(jobs, "MinerUClient", FakeClient)
        source = make_pdf(tmp_path / "paper.pdf")
        document_id = client.post("/api/documents", json={"path": str(source)}).json()["document_id"]
        profile = client.post("/api/profiles", json={
            "name": "MinerU", "base_url": "http://127.0.0.1:8100", "kind": "parser",
        }).json()

        started = client.post(f"/api/documents/{document_id}/parse", json={"profile_id": profile["id"]})
        assert started.status_code == 202

        deadline = time.monotonic() + 10
        status = started.json()
        while status["status"] not in ("completed", "failed") and time.monotonic() < deadline:
            time.sleep(0.05)
            status = client.get(f"/api/documents/{document_id}/parse").json()
        assert status["status"] == "completed", status
        assert status["paragraphs"] == 4

        ir = client.get(f"/api/documents/{document_id}/ir").json()
        assert ir["pipeline_version"] == MINERU_PIPELINE_VERSION
        assert any("$F(x) = H(x) - x$" in p["text"] for p in ir["paragraphs"])

        image = client.get(f"/api/documents/{document_id}/assets/images/fig1.jpg")
        assert image.status_code == 200 and image.content == b"\xff\xd8jpeg"
        assert image.headers["content-type"] == "image/jpeg"
        assert client.get(f"/api/documents/{document_id}/assets/middle.json").status_code == 404
        assert client.get(f"/api/documents/{document_id}/assets/..%2F..%2Fdb.jpg").status_code in (400, 404)

    def test_a_chat_profile_cannot_start_a_parse(self, client, tmp_path: Path) -> None:
        source = make_pdf(tmp_path / "paper.pdf")
        document_id = client.post("/api/documents", json={"path": str(source)}).json()["document_id"]
        chat = client.post("/api/profiles", json={"name": "Chat", "base_url": "http://127.0.0.1:1/v1", "model": "m"}).json()
        response = client.post(f"/api/documents/{document_id}/parse", json={"profile_id": chat["id"]})
        assert response.status_code == 400
