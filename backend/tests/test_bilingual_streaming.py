"""A paragraph is shown when it is translated, not when its batch is.

The answer to one batch is read as the model writes it. What matters: a
paragraph is handed over the moment its own translation is whole — and only
after the checks a finished answer gets; what arrived stands when the rest is
cut off; the partial file has it while the batch is still running; and a
provider that cannot stream changes nothing.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import httpx
import openai
import pytest

from app.bilingual import jobs
from app.bilingual.cache import read_bilingual, read_partial
from app.bilingual.pipeline import Batch, StreamedObjects, heading_views_for, plan, translate_batch
from app.llm import LLMAuthenticationError, LLMRequest, OpenAIChatCompletionsProvider, ProviderConfig
from app.llm.base import LLMProvider
from app.llm.models import LLMResult
from tests.test_bilingual import an_ir, paragraph, section
from tests.test_bilingual_jobs import new_job

ANSWER = {
    "headings": [{"id": "s1", "text": "3 深度残差学习"}],
    "paragraphs": [
        {"id": "p1", "text": '我们采用残差学习 {见下} 与 "捷径"。'},
        {"id": "p2", "text": "映射记为 ⟦m1⟧ 。"},
        {"id": "p3", "text": "普通网络。"},
    ],
}


def pieces(text: str, size: int = 7) -> list[str]:
    return [text[i:i + size] for i in range(0, len(text), size)]


def three():
    return an_ir(
        [
            paragraph("p1", "We adopt residual learning. " * 6, section="s1"),
            paragraph("p2", "Denote the mapping as $H(x)$ . " + "It is what the layers fit. " * 5, section="s1"),
            paragraph("p3", "The plain baselines. " * 6, section="s1"),
        ],
        [section("s1", "3 Deep Residual Learning")],
    )


class Streamer(LLMProvider):
    """Writes a scripted answer a few characters at a time."""

    protocol = "scripted"
    model = "stream-model"

    def __init__(self, chunks: list[str], *, hold_after: int | None = None,
                 fail_after: int | None = None) -> None:
        self.chunks = chunks
        self.hold_after = hold_after
        self.fail_after = fail_after
        self.release = asyncio.Event()
        self.reached_hold = asyncio.Event()
        self.stream_calls = 0
        self.plain_calls = 0

    async def generate_stream(self, request: LLMRequest):
        self.stream_calls += 1
        for index, chunk in enumerate(self.chunks):
            if self.fail_after is not None and index >= self.fail_after:
                raise LLMAuthenticationError("key refused")
            if self.hold_after is not None and index == self.hold_after:
                self.reached_hold.set()
                await self.release.wait()
            yield chunk

    async def generate(self, request: LLMRequest) -> LLMResult:
        self.plain_calls += 1
        return LLMResult(text=json.dumps(ANSWER), model="plain-model", protocol="scripted")

    async def test_connection(self):  # pragma: no cover
        raise NotImplementedError


class TestReadingAnAnswerAsItArrives:
    def test_each_item_is_found_once_when_it_closes(self) -> None:
        text = "```json\n" + json.dumps(ANSWER, ensure_ascii=False) + "\n```"
        for size in (1, 3, 7, 50, len(text)):
            scanner = StreamedObjects()
            found = [item for chunk in pieces(text, size) for item in scanner.feed(chunk)]
            # The heading and the three paragraphs: braces and quotes inside a
            # translation did not end anything early.
            assert [item["id"] for item in found] == ["s1", "p1", "p2", "p3"], size
            assert found[1]["text"] == '我们采用残差学习 {见下} 与 "捷径"。'
            assert scanner.text == text

    def test_an_item_that_is_not_whole_is_not_found(self) -> None:
        scanner = StreamedObjects()
        whole = json.dumps(ANSWER, ensure_ascii=False)
        cut = whole[: whole.index("普通网络")]
        assert [item["id"] for item in scanner.feed(cut)] == ["s1", "p1", "p2"]
        assert scanner.feed("") == []


class TestOneBatch:
    async def _run(self, provider, **kw):
        ir = three()
        work = plan(ir)
        handed: list[tuple[str, str]] = []
        result = await translate_batch(
            work.batches[0], heading_views_for(work), provider, target_language="zh-CN",
            on_paragraph=lambda identifier, text: handed.append((identifier, text)), **kw,
        )
        return result, handed

    async def test_paragraphs_are_handed_over_before_the_answer_ends(self) -> None:
        text = json.dumps(ANSWER, ensure_ascii=False)
        provider = Streamer(pieces(text), hold_after=len(pieces(text[: text.index('"p3"')])))
        ir = three()
        work = plan(ir)
        handed: list[str] = []
        task = asyncio.create_task(translate_batch(
            work.batches[0], heading_views_for(work), provider, target_language="zh-CN",
            on_paragraph=lambda identifier, _text: handed.append(identifier),
        ))
        await provider.reached_hold.wait()
        await asyncio.sleep(0)
        # The answer has not finished — and two paragraphs are already out.
        assert handed == ["p1", "p2"] and not task.done()
        provider.release.set()
        result = await task
        assert handed == ["p1", "p2", "p3"]
        assert result.translations["p2"] == "映射记为 $H(x)$ 。"  # the formula is back
        assert result.headings == {"s1": "3 深度残差学习"}
        assert (provider.stream_calls, provider.plain_calls, result.calls) == (1, 0, 1)
        assert result.model == "stream-model" and result.usages == [None]

    async def test_a_paragraph_that_lost_its_formula_is_never_handed_over(self) -> None:
        bad = json.loads(json.dumps(ANSWER))
        bad["paragraphs"][1]["text"] = "映射记为 H 。"  # the placeholder is gone
        bad["paragraphs"].append({"id": "p_invented", "text": "没有这一段。"})
        result, handed = await self._run(Streamer(pieces(json.dumps(bad, ensure_ascii=False))))
        assert [identifier for identifier, _ in handed] == ["p1", "p3"]
        assert set(result.translations) == {"p1", "p3"}

    async def test_what_arrived_stands_when_the_answer_is_cut_off(self) -> None:
        text = json.dumps(ANSWER, ensure_ascii=False)
        provider = Streamer(pieces(text[: text.index("普通网络")]))
        result, handed = await self._run(provider)
        assert [identifier for identifier, _ in handed] == ["p1", "p2"]
        assert set(result.translations) == {"p1", "p2"} and result.failed is False
        # Not asked again for the whole batch: the gap is what a resumed run sends.
        assert (provider.stream_calls, provider.plain_calls, result.repaired) == (1, 0, 0)

    async def test_an_answer_that_is_not_json_at_all_gets_the_one_repair(self) -> None:
        provider = Streamer(["Sure! Here is ", "the translation you asked for."])
        result, handed = await self._run(provider)
        assert handed == []  # nothing whole ever arrived on the stream
        assert provider.plain_calls == 1 and result.repaired == 1
        assert set(result.translations) == {"p1", "p2", "p3"}

    async def test_a_provider_that_cannot_stream_is_asked_the_ordinary_way(self) -> None:
        class Plain(Streamer):
            async def generate_stream(self, request: LLMRequest):
                raise NotImplementedError("no streaming here")
                yield ""  # pragma: no cover

        provider = Plain([])
        result, handed = await self._run(provider)
        assert provider.plain_calls == 1 and result.model == "plain-model"
        assert set(result.translations) == {"p1", "p2", "p3"}
        # Nothing was streamed, so nothing was handed over early.
        assert handed == []

    async def test_without_a_listener_nothing_streams(self) -> None:
        provider = Streamer(pieces(json.dumps(ANSWER, ensure_ascii=False)))
        ir = three()
        work = plan(ir)
        await translate_batch(work.batches[0], heading_views_for(work), provider, target_language="zh-CN")
        assert (provider.stream_calls, provider.plain_calls) == (0, 1)


class TestTheJob:
    async def test_the_reading_has_a_paragraph_while_its_batch_is_still_running(
        self, tmp_path: Path, monkeypatch
    ) -> None:
        monkeypatch.setattr(jobs, "PARTIAL_WRITE_INTERVAL_S", 0.0)
        ir = three()
        text = json.dumps(ANSWER, ensure_ascii=False)
        provider = Streamer(pieces(text), hold_after=len(pieces(text[: text.index('"p2"')])))
        job = jobs.start(document_id="doc_1", ir=ir, provider=provider, documents_dir=tmp_path,
                         target_language="zh-CN")
        identity = dict(content_hash=ir.content_hash, ir_pipeline_version=ir.pipeline_version,
                        target_language="zh-CN")
        try:
            await provider.reached_hold.wait()
            for _ in range(200):
                if read_partial(tmp_path, **identity) is not None:
                    break
                await asyncio.sleep(0.01)
            kept = read_partial(tmp_path, **identity)
            assert kept is not None and set(kept["translated"]) == {"p1"}
            assert job.status == "running" and job.translated_paragraphs == 1 and job.done_batches == 0
            # What the column reads: one translated, the others on their way.
            snapshot = jobs.snapshot(ir, tmp_path, "zh-CN")
            assert {p.paragraph_id: p.status for p in snapshot.paragraphs} == {
                "p1": "translated", "p2": "pending", "p3": "pending"}
        finally:
            provider.release.set()
        for _ in range(500):
            if job.status != "running":
                break
            await asyncio.sleep(0.01)
        assert job.status == "completed" and job.translated_paragraphs == 3
        assert read_bilingual(tmp_path, **identity).status == "READY"

    async def test_a_key_refused_mid_answer_keeps_the_paragraphs_already_read(
        self, tmp_path: Path, monkeypatch
    ) -> None:
        monkeypatch.setattr(jobs, "PARTIAL_WRITE_INTERVAL_S", 0.0)
        ir = three()
        text = json.dumps(ANSWER, ensure_ascii=False)
        provider = Streamer(pieces(text), fail_after=len(pieces(text[: text.index('"p3"')])))
        job = await jobs.run(new_job(ir), ir=ir, provider=provider, documents_dir=tmp_path)
        assert job.status == "failed" and job.code == "LLM_AUTHENTICATION_ERROR"
        kept = read_partial(tmp_path, content_hash=ir.content_hash,
                            ir_pipeline_version=ir.pipeline_version, target_language="zh-CN")
        assert set(kept["translated"]) == {"p1", "p2"}


# --- the adapter ------------------------------------------------------------------


class _Chunks:
    def __init__(self, deltas: list[str | None], error: BaseException | None = None) -> None:
        self.deltas, self.error = deltas, error

    def __aiter__(self):
        return self._iterate()

    async def _iterate(self):
        for delta in self.deltas:
            yield SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content=delta))])
        yield SimpleNamespace(choices=[])  # the trailing chunk some vendors send
        if self.error is not None:
            raise self.error


class _Client:
    def __init__(self, stream: _Chunks) -> None:
        self.calls: list[dict] = []
        outer = self

        class Completions:
            async def create(self, **kwargs):
                outer.calls.append(kwargs)
                return stream

        self.chat = SimpleNamespace(completions=Completions())


CONFIG = ProviderConfig(base_url="https://api.example.com/v1", api_key="sk-live-SECRET-123456", model="m")


class TestChatCompletionsStreaming:
    async def test_text_deltas_in_order_and_nothing_else(self) -> None:
        client = _Client(_Chunks(["你", None, "", "好", "。"]))
        provider = OpenAIChatCompletionsProvider(CONFIG, client=client)
        request = LLMRequest(messages=[{"role": "user", "content": "hi"}])
        assert [chunk async for chunk in provider.generate_stream(request)] == ["你", "好", "。"]
        assert client.calls[0]["stream"] is True and client.calls[0]["model"] == "m"
        # Only what every compatible vendor accepts.
        assert "stream_options" not in client.calls[0]

    async def test_a_failure_mid_stream_is_named_and_carries_no_key(self) -> None:
        request = httpx.Request("POST", "https://api.example.com/v1/chat/completions")
        error = openai.AuthenticationError(
            "Incorrect API key provided: sk-live-SECRET-123456",
            response=httpx.Response(401, request=request), body=None,
        )
        provider = OpenAIChatCompletionsProvider(CONFIG, client=_Client(_Chunks(["你"], error)))
        got: list[str] = []
        with pytest.raises(LLMAuthenticationError) as caught:
            async for chunk in provider.generate_stream(LLMRequest(messages=[{"role": "user", "content": "hi"}])):
                got.append(chunk)
        assert got == ["你"]
        assert "sk-live-SECRET-123456" not in str(caught.value)
