"""Related papers through a web-searching chat model (DeepSeek and friends).

Offline against `httpx.MockTransport`. What matters: the request uses the
service's own web-search switch with the chat profile's key; only services that
search server-side are accepted; references the paper does not list are
dropped; and a paper is "verified" only if the search really returned its page.
"""

from __future__ import annotations

import json

import httpx
import pytest

from app.related import sources
from app.related.llm_web import (
    ANTHROPIC, DASHSCOPE, OPENROUTER, RESPONSES, ZHIPU,
    LLMWebSource, WebModelConfig, detect_dialect, parse_json,
)
from app.related.service import gather
from app.related.sources import SearchError
from tests.test_bilingual import an_ir, paragraph, section
from tests.test_related import PAPER, paper  # noqa: F401 — fixture

ITEM = lambda title, **kw: {"title": title, "authors": ["K. He"], "year": 2016, **kw}  # noqa: E731

ANSWER = {
    "paper": ITEM(PAPER, doi="10.1109/CVPR.2016.90", url="https://doi.org/10.1109/CVPR.2016.90"),
    "references": [
        ITEM("Highway Networks", url="https://arxiv.org/abs/1505.00387v2"),
        ITEM("A paper the model made up", doi="10.9999/fake.1"),
    ],
    "citing": [ITEM("Identity Mappings in Deep Residual Networks", url="https://arxiv.org/pdf/1603.05027.pdf")],
    "similar": [ITEM("Densely Connected Convolutional Networks", doi="not-a-doi")],
}

SEARCH_RESULTS = [
    {"type": "web_search_result", "url": "https://doi.org/10.1109/CVPR.2016.90", "title": "x"},
    {"type": "web_search_result", "url": "https://arxiv.org/abs/1505.00387", "title": "x"},
    {"type": "web_search_result", "url": "https://arxiv.org/abs/1603.05027", "title": "x"},
]


def anthropic_reply(payload: dict) -> dict:
    return {
        "content": [
            {"type": "server_tool_use", "id": "s1", "name": "web_search", "input": {"query": "q"}},
            {"type": "web_search_tool_result", "tool_use_id": "s1", "content": SEARCH_RESULTS},
            {"type": "text", "text": "Here you go:\n```json\n" + json.dumps(payload) + "\n```"},
        ],
        "stop_reason": "end_turn",
    }


def config(dialect: str = ANTHROPIC, endpoint: str = "https://api.deepseek.com/anthropic") -> WebModelConfig:
    return WebModelConfig(dialect=dialect, endpoint=endpoint, model="deepseek-chat",
                          api_key="sk-deep-123", timeout_s=120.0, custom_headers=None)


@pytest.fixture
def recorder(monkeypatch):
    seen: list[httpx.Request] = []
    replies: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        reply = replies.get(request.url.path)
        if isinstance(reply, httpx.Response):
            return reply
        return httpx.Response(200, json=reply) if reply is not None else httpx.Response(404)

    monkeypatch.setattr(sources, "TRANSPORT", httpx.MockTransport(handler))
    return seen, replies


class TestDialects:
    @pytest.mark.parametrize(("url", "protocol", "expected"), [
        ("https://api.deepseek.com", "auto", (ANTHROPIC, "https://api.deepseek.com/anthropic")),
        ("https://api.deepseek.com/v1", "chat_completions", (ANTHROPIC, "https://api.deepseek.com/anthropic")),
        ("https://api.anthropic.com", "auto", (ANTHROPIC, "https://api.anthropic.com")),
        ("https://api.openai.com/v1", "auto", (RESPONSES, "https://api.openai.com/v1")),
        ("https://dashscope.aliyuncs.com/compatible-mode/v1", "auto",
         (DASHSCOPE, "https://dashscope.aliyuncs.com/compatible-mode/v1")),
        ("https://open.bigmodel.cn/api/paas/v4", "auto", (ZHIPU, "https://open.bigmodel.cn/api/paas/v4")),
        ("https://openrouter.ai/api/v1", "auto", (OPENROUTER, "https://openrouter.ai/api/v1")),
    ])
    def test_known_services(self, url, protocol, expected) -> None:
        assert detect_dialect(url, protocol) == expected

    def test_a_local_model_cannot_search(self) -> None:
        # It would answer from memory — the invented citations this must not show.
        assert detect_dialect("http://127.0.0.1:11434/v1") is None

    def test_json_is_found_inside_chatter(self) -> None:
        assert parse_json('Sure! {"papers": [{"title": "a {b}"}]} hope this helps') == {"papers": [{"title": "a {b}"}]}
        with pytest.raises(SearchError):
            parse_json("I could not find anything.")

    def test_an_answer_cut_off_by_the_output_limit_keeps_its_whole_items(self) -> None:
        # Seen live with DeepSeek (stop_reason "max_tokens"): the outer object
        # never closes. Its first nested object must not pass for the answer.
        whole = json.dumps({
            "paper": ITEM(PAPER),
            "references": [ITEM("Highway Networks"), ITEM("Going Deeper with Convolutions")],
            "citing": [ITEM("Identity Mappings in Deep Residual Networks"), ITEM("Group Normalization")],
        })
        cut = whole[: whole.index("Group Normalization") + 5]
        parsed = parse_json(cut)
        assert parsed["paper"]["title"] == PAPER
        assert [w["title"] for w in parsed["references"]] == ["Highway Networks", "Going Deeper with Convolutions"]
        assert [w["title"] for w in parsed["citing"]] == ["Identity Mappings in Deep Residual Networks"]
        # Cut inside the very first item, nothing whole arrived.
        with pytest.raises(SearchError):
            parse_json('{"paper": {"title": "Deep Resid')


class TestDeepSeek:
    async def test_web_search_tool_key_and_verification(self, recorder) -> None:
        seen, replies = recorder
        replies["/anthropic/v1/messages"] = anthropic_reply(ANSWER)
        ir = an_ir(
            [
                paragraph("p1", "Gates help [2].", section="s1"),
                paragraph("r1", "[2] R. Srivastava. Highway networks. arXiv 2015.", section="refs"),
            ],
            [section("s1", "1 Introduction"), section("refs", "References", references=True)],
        )
        ir.paragraphs.insert(0, paragraph("t", PAPER, section="s1"))
        result = await gather(ir, LLMWebSource(config()))

        body = json.loads(seen[0].content)
        assert seen[0].headers["x-api-key"] == "sk-deep-123"
        assert body["tools"][0]["type"].startswith("web_search")
        assert len(seen) == 1  # one call for all three lists

        # The made-up reference is not in the paper's bibliography: dropped.
        assert [w.title for w in result.references] == ["Highway Networks"]
        assert result.links[result.references[0].key].cited_in_paragraph_id == "p1"
        # Versioned arXiv link vs. search result, /pdf/ vs. /abs/: still the same page.
        assert result.references[0].verified is True
        assert result.citing[0].verified is True
        # Never seen in the search results, and the DOI was not a DOI.
        assert result.similar[0].verified is False and result.similar[0].doi is None

    async def test_a_bibliography_run_together_is_matched_entry_by_entry(self, recorder) -> None:
        # The built-in extractor returns a column of references as one paragraph;
        # matched whole, every reference took that paragraph's first marker.
        seen, replies = recorder
        replies["/anthropic/v1/messages"] = anthropic_reply({
            "paper": ITEM(PAPER),
            "references": [
                ITEM("Highway Networks"),
                ITEM("Going Deeper with Convolutions"),
                # Words scattered over several entries, but no entry of its own.
                ITEM("Deep Highway Convolutions"),
            ],
            "citing": [], "similar": [],
        })
        ir = an_ir(
            [
                paragraph("p1", "Depth matters [3].", section="s1"),
                paragraph("p2", "Gated shortcuts [2, 3] came first.", section="s1"),
                paragraph(
                    "r1",
                    "[1] K. Simonyan. Very deep networks. In ICLR, 2015. "
                    "[2] R. Srivastava. Highway networks. arXiv, 2015, see also [1]. "
                    "[3] C. Szegedy. Going deeper with convolutions. In CVPR, 2015.",
                    section="refs",
                ),
            ],
            [section("s1", "1 Introduction"), section("refs", "References", references=True)],
        )
        ir.paragraphs.insert(0, paragraph("t", PAPER, section="s1"))
        result = await gather(ir, LLMWebSource(config()))

        assert json.loads(seen[0].content)["max_tokens"] >= 8192  # thinking shares the budget
        assert [w.title for w in result.references] == ["Highway Networks", "Going Deeper with Convolutions"]
        highway, deeper = (result.links[w.key] for w in result.references)
        assert (highway.marker, highway.cited_in_paragraph_id) == (2, "p2")
        assert (deeper.marker, deeper.cited_in_paragraph_id) == (3, "p1")
        # Neither link was among the search results, but the paper lists both.
        assert all(w.verified is True for w in result.references)

    async def test_a_paused_search_turn_is_continued(self, recorder) -> None:
        seen, _replies = recorder
        calls = iter([
            {"content": [{"type": "server_tool_use", "id": "s1", "name": "web_search", "input": {}}],
             "stop_reason": "pause_turn"},
            anthropic_reply({"papers": [ITEM("Highway Networks", url="https://arxiv.org/abs/1505.00387")]}),
        ])
        _replies["/anthropic/v1/messages"] = None

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json=next(calls))

        sources.TRANSPORT = httpx.MockTransport(handler)
        found = await LLMWebSource(config()).search("highway", 5)
        assert [w.title for w in found] == ["Highway Networks"] and found[0].verified
        assert json.loads(seen[1].content)["messages"][-1]["role"] == "assistant"

    async def test_a_refused_tool_is_named(self, recorder) -> None:
        _seen, replies = recorder
        replies["/anthropic/v1/messages"] = httpx.Response(
            400, json={"error": {"message": "Unknown tool type: web_search_20250305"}})
        with pytest.raises(SearchError) as caught:
            await LLMWebSource(config()).search("x", 3)
        assert caught.value.code == "SEARCH_UNSUPPORTED"


class TestOtherServices:
    async def test_dashscope_turns_on_enable_search(self, recorder) -> None:
        seen, replies = recorder
        replies["/compatible-mode/v1/chat/completions"] = {
            "choices": [{"message": {"content": json.dumps({"papers": [ITEM("Highway Networks")]})}}],
        }
        cfg = config(DASHSCOPE, "https://dashscope.aliyuncs.com/compatible-mode/v1")
        found = await LLMWebSource(cfg).search("highway", 5)
        body = json.loads(seen[0].content)
        assert body["enable_search"] is True and seen[0].headers["authorization"] == "Bearer sk-deep-123"
        assert found[0].verified is False  # no sources returned, so not verified

    async def test_responses_web_search_and_citations(self, recorder) -> None:
        seen, replies = recorder
        replies["/v1/responses"] = {"output": [
            {"type": "web_search_call", "action": {"query": "q"}},
            {"type": "message", "content": [{
                "type": "output_text",
                "text": json.dumps({"papers": [ITEM("Highway Networks", url="https://arxiv.org/abs/1505.00387")]}),
                "annotations": [{"type": "url_citation", "url": "https://arxiv.org/abs/1505.00387"}],
            }]},
        ]}
        found = await LLMWebSource(config(RESPONSES, "https://api.openai.com/v1")).search("highway", 5)
        assert json.loads(seen[0].content)["tools"] == [{"type": "web_search"}]
        assert found[0].verified is True


class TestOverHttp:
    def test_a_search_profile_borrows_a_chat_profile(self, client, paper, recorder) -> None:  # noqa: F811
        _seen, replies = recorder
        replies["/anthropic/v1/messages"] = anthropic_reply(ANSWER)
        chat = client.post("/api/profiles", json={
            "name": "DeepSeek", "base_url": "https://api.deepseek.com", "model": "deepseek-chat",
            "api_key": "sk-deep-123",
        }).json()
        local = client.post("/api/profiles", json={
            "name": "Local", "base_url": "http://127.0.0.1:11434/v1", "model": "qwen",
        }).json()

        models = {m["name"]: m for m in client.get("/api/related/web-models").json()["models"]}
        assert models["DeepSeek"]["supported"] and not models["Local"]["supported"]

        created = client.post("/api/profiles", json={
            "name": "AI 联网搜索", "kind": "search", "protocol": "llm_web",
            "base_url": "https://api.deepseek.com", "model": chat["id"],
        })
        assert created.status_code == 201, created.text
        body = client.get(f"/api/documents/{paper}/related").json()
        assert body["source"] == "llm_web" and body["identified"]["doi"] == "10.1109/CVPR.2016.90"
        assert {p["kind"] for p in body["papers"]} >= {"citing"}
        assert all("verified" in p for p in body["papers"])
        assert client.get(f"/api/documents/{paper}/related").json()["cached"] is True

        # Pointing it at a model that cannot search is refused by name.
        client.patch(f"/api/profiles/{created.json()['id']}", json={"model": local["id"]})
        refused = client.get(f"/api/documents/{paper}/related", params={"refresh": "1"})
        assert refused.status_code == 422
        assert refused.json()["error"]["code"] == "SEARCH_UNSUPPORTED"
