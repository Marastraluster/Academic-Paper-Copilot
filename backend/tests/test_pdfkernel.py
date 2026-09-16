"""DS-PDF-001 — the PDF translation kernel.

The end-to-end test runs the **real** upstream pipeline against a loopback HTTP
server standing in for the user's provider. Nothing is mocked in that path: it is
the integration claim this task exists to make. The branch tests substitute the
upstream call, because a 72 MiB model load per branch would make the suite
unusable and would prove nothing extra.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import fitz
import pytest

from app.llm.models import ProviderConfig
from app.pdfkernel import (
    LayoutModelUnavailableError,
    OutputFileExistsError,
    PDFEngineUnsupportedError,
    PDFKernelError,
    PDFSourceInvalidError,
    PDFSourceNotFoundError,
    TranslationOutputMissingError,
    TranslationResult,
    TranslationServiceError,
    ensure_layout_model,
    layout_model_path,
    translate_pdf,
)
from app.pdfkernel import adapter as adapter_module

SECRET = "sk-live-pdfkernel-SECRET-13579"

#: Long enough to be laid out as a paragraph, distinct per page so the
#: interleaving test can tell the pages apart.
PAGE_MARKERS = [
    "PAGE-ONE-MARKER The policy is optimized through multiple rollouts.",
    "PAGE-TWO-MARKER The learned policy produces stable trajectories.",
]


# --- fixtures ----------------------------------------------------------------


_BODY = [
    "The policy is optimized through multiple rollouts collected from the simulator.",
    "We evaluate the learned policy on three manipulation benchmarks and report means.",
    "Each rollout is a sequence of observations, actions and rewards gathered under",
    "the current policy, which is then updated from the aggregated trajectories.",
    "Results indicate the proposed representation improves sample efficiency markedly.",
]


def _build_pdf(path: Path, markers: list[str]) -> Path:
    """A deliberately paper-*shaped* fixture.

    Not cosmetic: the layout model classifies a nearly empty page as overlapping
    "plain text" and "abandon" regions, and upstream lets the preserve class win —
    so the text is treated as a formula and never reaches the translator. A page
    that looks like a paper is classified cleanly and actually gets translated.
    """
    document = fitz.open()
    for index, marker in enumerate(markers):
        page = document.new_page(width=595, height=842)
        y = 70
        page.insert_text((72, y), "Learning Stable Policies for Robotic Manipulation", fontsize=15)
        y += 34
        page.insert_text((72, y), "A. Author, B. Author — Institute of Robotics", fontsize=10)
        y += 30
        page.insert_text((72, y), "Abstract" if index == 0 else f"{index + 1}. Method", fontsize=12)
        y += 18
        for line in _BODY[:3]:
            page.insert_text((72, y), line, fontsize=10)
            y += 14
        y += 16
        page.insert_text((72, y), f"{index + 2}. Experiment", fontsize=12)
        y += 18
        # The unique marker rides inside a normal body line, so it is classified
        # and translated like any other text rather than standing alone.
        for line in [*_BODY[3:], marker]:
            page.insert_text((72, y), line, fontsize=10)
            y += 14
    document.save(str(path))
    document.close()
    return path


@pytest.fixture
def source_pdf(tmp_path: Path) -> Path:
    return _build_pdf(tmp_path / "paper.pdf", PAGE_MARKERS)


class FakeLLM(BaseHTTPRequestHandler):
    """A minimal OpenAI-compatible endpoint, on loopback only."""

    requests: list[dict] = []
    #: How many failures a "flaky" endpoint emits before it starts working.
    failures_remaining = 0

    def log_message(self, *args):  # silence
        pass

    def _fail(self, status: int, message: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"error": {"message": message}}).encode())

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        FakeLLM.requests.append({"path": self.path, "auth": self.headers.get("Authorization"), "body": body})

        # Path-routed failure modes, so one fake serves every scenario.
        if "always500" in self.path:
            self._fail(500, "persistent server error")
            return
        if "unauthorized" in self.path:
            self._fail(401, "invalid api key")
            return
        if "forbidden" in self.path:
            self._fail(403, "forbidden")
            return
        if "ratelimit" in self.path:
            self._fail(429, "slow down")
            return
        if "flaky" in self.path and FakeLLM.failures_remaining > 0:
            FakeLLM.failures_remaining -= 1
            self._fail(500, "upstream exploded")
            return

        payload = {
            "id": "c1", "object": "chat.completion", "model": body.get("model", "m"),
            "choices": [{"index": 0, "message": {"role": "assistant",
                                                 "content": "这是翻译后的测试文本。"},
                         "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 5, "completion_tokens": 5, "total_tokens": 10},
        }
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode())


@pytest.fixture
def fake_llm():
    FakeLLM.requests = []
    FakeLLM.failures_remaining = 0
    server = HTTPServer(("127.0.0.1", 0), FakeLLM)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}/v1"
    server.shutdown()


def provider_config(base_url: str, **overrides) -> ProviderConfig:
    fields = {"base_url": base_url, "api_key": SECRET, "model": "fake-model", "timeout_s": 30.0}
    fields.update(overrides)
    return ProviderConfig(**fields)


@pytest.fixture
def stub_upstream(monkeypatch):
    """Substitute upstream's ``translate`` itself.

    Patched *inside* the adapter rather than replacing `_run_upstream`, so the
    adapter's own error handling — the thing several of these tests are about —
    still executes. The ONNX model is stubbed out so no load is attempted.
    """
    import pdf2zh.doclayout as doclayout
    import pdf2zh.high_level as high_level

    monkeypatch.setattr(doclayout.ModelInstance, "value", object())

    def install(func):
        monkeypatch.setattr(high_level, "translate", func)

    return install


def _failure_config(base_url: str, route: str) -> ProviderConfig:
    """A provider config pointing at one of the fake's failure routes."""
    return provider_config(base_url.replace("/v1", f"/{route}/v1"))


@pytest.fixture
def no_backoff(monkeypatch):
    """Zero the retry backoff so failure tests are fast and deterministic.

    Required by the criteria (AC-FIX-19): without it every failure case would
    sleep 1s + 2s, and the suite would measure sleeps rather than behaviour.
    """
    from app.pdfkernel.bounded_translator import BoundedOpenAIlikedTranslator

    monkeypatch.setattr(BoundedOpenAIlikedTranslator, "BACKOFF_SECONDS", (0.0, 0.0))
    return BoundedOpenAIlikedTranslator


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# --- AC-13: layout model pre-flight ------------------------------------------


def test_layout_model_is_cached_locally() -> None:
    """The model was fetched out-of-band; the end-to-end test depends on it."""
    path = ensure_layout_model()

    assert path.exists()
    assert path.stat().st_size > 1024 * 1024


def test_absent_layout_model_fails_fast_without_downloading(monkeypatch, tmp_path) -> None:
    """AC-13 — checked *before* upstream, so no download is attempted at all.

    Upstream would try to fetch ~72 MiB here and, failing to reach a mirror, call
    ``exit(1)``. A typed error in well under a second beats both.
    """
    import babeldoc.const as babeldoc_const

    monkeypatch.setattr(babeldoc_const, "CACHE_FOLDER", tmp_path / "empty-cache")

    started = time.perf_counter()
    with pytest.raises(LayoutModelUnavailableError) as excinfo:
        ensure_layout_model()
    elapsed = time.perf_counter() - started

    assert excinfo.value.code == "LAYOUT_MODEL_UNAVAILABLE"
    assert elapsed < 5.0, f"took {elapsed:.2f}s; the ceiling is 5.0s"


def test_translation_without_the_model_raises_before_any_work(
    monkeypatch, tmp_path, source_pdf
) -> None:
    """AC-13 — and the source is untouched, because nothing ran."""
    import babeldoc.const as babeldoc_const

    monkeypatch.setattr(babeldoc_const, "CACHE_FOLDER", tmp_path / "empty-cache")
    before = sha256(source_pdf)

    with pytest.raises(LayoutModelUnavailableError):
        asyncio.run(
            translate_pdf(source_pdf, tmp_path / "out", "zh", provider_config("http://127.0.0.1:1/v1"))
        )

    assert sha256(source_pdf) == before
    assert not (tmp_path / "out").exists() or not any((tmp_path / "out").iterdir())


# --- AC-10 / AC-11 / AC-03: engine, input validation, typed errors -----------


def test_unsupported_engine_is_rejected_before_work(tmp_path, source_pdf) -> None:
    """AC-10 — no silent fallback to a different engine."""
    with pytest.raises(PDFEngineUnsupportedError) as excinfo:
        asyncio.run(
            translate_pdf(
                source_pdf, tmp_path / "out", "zh",
                provider_config("http://127.0.0.1:1/v1"), engine="precise",
            )
        )

    assert excinfo.value.code == "ENGINE_UNSUPPORTED"


def test_missing_source_is_a_typed_error(tmp_path) -> None:
    """AC-11."""
    with pytest.raises(PDFSourceNotFoundError):
        asyncio.run(
            translate_pdf(tmp_path / "nope.pdf", tmp_path / "out", "zh",
                          provider_config("http://127.0.0.1:1/v1"))
        )


def test_non_pdf_source_is_a_typed_error(tmp_path) -> None:
    """AC-11 — a text file must not reach upstream as if it were a PDF."""
    bogus = tmp_path / "bogus.pdf"
    bogus.write_text("this is not a pdf", encoding="utf-8")

    with pytest.raises(PDFSourceInvalidError):
        asyncio.run(
            translate_pdf(bogus, tmp_path / "out", "zh", provider_config("http://127.0.0.1:1/v1"))
        )


def test_upstream_failure_is_wrapped_not_propagated(stub_upstream, tmp_path, source_pdf) -> None:
    """AC-11 — no raw upstream exception escapes the package."""
    def explode(*args, **kwargs):
        raise RuntimeError("upstream crash")

    stub_upstream(explode)

    with pytest.raises(TranslationServiceError) as excinfo:
        asyncio.run(
            translate_pdf(source_pdf, tmp_path / "out", "zh",
                          provider_config("http://127.0.0.1:1/v1"))
        )

    assert isinstance(excinfo.value, PDFKernelError)
    assert excinfo.value.cause is not None


def test_upstream_process_exit_is_contained(stub_upstream, tmp_path, source_pdf) -> None:
    """AC-11, and a real hazard: upstream calls ``exit(1)`` when it cannot reach
    a model mirror. Uncaught, that would terminate the server process."""
    def exit_the_process(*args, **kwargs):
        raise SystemExit(1)

    stub_upstream(exit_the_process)

    with pytest.raises(TranslationServiceError):
        asyncio.run(
            translate_pdf(source_pdf, tmp_path / "out", "zh",
                          provider_config("http://127.0.0.1:1/v1"))
        )


# --- AC-12: secrets -----------------------------------------------------------


def test_key_is_not_in_the_failure_message(stub_upstream, tmp_path, source_pdf) -> None:
    """AC-12."""
    def explode(*args, **kwargs):
        raise RuntimeError(f"auth rejected for Bearer {SECRET}")

    stub_upstream(explode)

    with pytest.raises(TranslationServiceError) as excinfo:
        asyncio.run(
            translate_pdf(source_pdf, tmp_path / "out", "zh",
                          provider_config("http://127.0.0.1:1/v1"))
        )

    assert SECRET not in f"{excinfo.value} {excinfo.value.message}"


def test_envs_carry_the_configuration_and_never_touch_upstream_config() -> None:
    """AC-08 — configuration is passed per call; upstream's plaintext config
    manager is never involved."""
    config = provider_config("https://api.example.com/v1", model="m-1")

    envs = adapter_module._upstream_envs(config)

    assert envs == {
        "OPENAILIKED_BASE_URL": "https://api.example.com/v1",
        "OPENAILIKED_API_KEY": SECRET,
        "OPENAILIKED_MODEL": "m-1",
    }


# --- AC-16: output collision --------------------------------------------------


def test_existing_output_is_refused(monkeypatch, tmp_path, source_pdf) -> None:
    """AC-16 — refusal happens before any expensive work."""
    out = tmp_path / "out"
    out.mkdir()
    (out / f"{source_pdf.stem}-mono.pdf").write_bytes(b"stale")
    called = []
    monkeypatch.setattr(adapter_module, "_run_upstream", lambda *a, **k: called.append(1))

    with pytest.raises(OutputFileExistsError) as excinfo:
        asyncio.run(
            translate_pdf(source_pdf, out, "zh", provider_config("http://127.0.0.1:1/v1"))
        )

    assert excinfo.value.code == "OUTPUT_FILE_ALREADY_EXISTS"
    assert called == [], "upstream must not run when the output already exists"


# --- AC-09: only recognised arguments reach upstream --------------------------


def _stub_writing_outputs(record: dict | None = None):
    """A stand-in for upstream that records its arguments and produces outputs.

    Producing real files matters: the adapter verifies its outputs exist, so a
    stub that only records would be testing the wrong failure.
    """
    def fake(**kwargs):
        if record is not None:
            record.update(kwargs)
        out = Path(kwargs["output"])
        stem = Path(kwargs["files"][0]).stem
        for name, pages in ((f"{stem}-mono.pdf", 1), (f"{stem}-dual.pdf", 2)):
            document = fitz.open()
            for _ in range(pages):
                document.new_page()
            document.save(str(out / name))
            document.close()

    return fake


def test_only_recognised_arguments_are_passed_upstream(stub_upstream, tmp_path, source_pdf) -> None:
    """AC-09 — upstream forwards ``**locals()`` internally.

    If the adapter let its own local variables into the call, a stray name could
    silently become an upstream parameter — or override a real one. So the
    keyword set is pinned exactly.
    """
    captured: dict = {}
    stub_upstream(_stub_writing_outputs(captured))

    asyncio.run(
        translate_pdf(source_pdf, tmp_path / "out", "zh",
                      provider_config("http://127.0.0.1:1/v1"))
    )

    assert set(captured) == {
        "files", "output", "lang_in", "lang_out", "service",
        "thread", "envs", "model", "ignore_cache",
    }, f"unexpected or missing upstream arguments: {sorted(captured)}"

    # And nothing adapter-local leaked in.
    for leaked in ("self", "provider_config", "config", "work_dir", "staged_source",
                   "source", "output_dir", "overwrite", "engine", "threads"):
        assert leaked not in captured, f"adapter local {leaked!r} reached upstream"


def test_upstream_receives_the_staged_copy_not_the_original(
    stub_upstream, tmp_path, source_pdf
) -> None:
    """The original must never be handed to a library that deletes temp-dir
    inputs. Upstream is given a copy inside the working directory."""
    captured: dict = {}
    stub_upstream(_stub_writing_outputs(captured))

    asyncio.run(
        translate_pdf(source_pdf, tmp_path / "out", "zh",
                      provider_config("http://127.0.0.1:1/v1"))
    )

    handed = Path(captured["files"][0])
    assert handed != source_pdf, "the original was handed to upstream"
    assert handed.name == source_pdf.name


# --- AC-19: temporary artifacts are cleaned up --------------------------------


@pytest.mark.parametrize("fail", [False, True])
def test_working_directory_is_removed(stub_upstream, tmp_path, source_pdf, fail: bool) -> None:
    """AC-19 — a work directory must not survive, on success or failure."""
    out = tmp_path / "out"

    def maybe_fail(**kwargs):
        if fail:
            raise RuntimeError("boom")

    stub_upstream(maybe_fail)

    try:
        asyncio.run(translate_pdf(source_pdf, out, "zh", provider_config("http://127.0.0.1:1/v1")))
    except (TranslationServiceError, Exception):  # noqa: B014 - the failure case
        pass

    leftovers = [p.name for p in out.iterdir() if p.name.startswith(".pdfkernel-")]
    assert leftovers == [], f"work directory survived: {leftovers}"


def test_a_failed_run_leaves_no_output_files(stub_upstream, tmp_path, source_pdf) -> None:
    """A partial output would be mistaken for a finished one by a later run."""
    out = tmp_path / "out"
    stub_upstream(lambda **kwargs: (_ for _ in ()).throw(RuntimeError("boom")))

    with pytest.raises(TranslationServiceError):
        asyncio.run(translate_pdf(source_pdf, out, "zh", provider_config("http://127.0.0.1:1/v1")))

    assert list(out.iterdir()) == [], "a failed translation left files behind"


# --- AC-17 / AC-18: lifecycle and envelope ------------------------------------


def test_importing_the_kernel_touches_nothing_outside_upstreams_cache(tmp_path) -> None:
    """AC-17 — the kernel's own import is inert.

    Upstream's ``init_db()`` side effect under ``~/.cache/pdf2zh`` is unavoidable
    without patching a library we do not modify, so it is allowed explicitly. What
    must not happen is *additional* side effects of our own.
    """
    import os
    import subprocess
    import sys

    from app.config import BACKEND_DIR

    env = {**os.environ, "DATABASE_PATH": str(tmp_path / "must-not-appear.sqlite3")}
    before = sorted(p.name for p in tmp_path.iterdir())

    result = subprocess.run(
        [sys.executable, "-c", "import app.pdfkernel; print('ok')"],
        cwd=BACKEND_DIR, env=env, capture_output=True, text=True, timeout=90,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "ok"
    assert sorted(p.name for p in tmp_path.iterdir()) == before
    assert not (tmp_path / "must-not-appear.sqlite3").exists()


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (PDFKernelError("x"), "PDF_KERNEL_ERROR"),
        (PDFEngineUnsupportedError("x"), "ENGINE_UNSUPPORTED"),
        (PDFSourceNotFoundError("x"), "SOURCE_NOT_FOUND"),
        (PDFSourceInvalidError("x"), "SOURCE_INVALID"),
        (OutputFileExistsError("x"), "OUTPUT_FILE_ALREADY_EXISTS"),
        (LayoutModelUnavailableError("x"), "LAYOUT_MODEL_UNAVAILABLE"),
        (TranslationServiceError("x"), "TRANSLATION_SERVICE_ERROR"),
        (TranslationOutputMissingError("x"), "TRANSLATION_OUTPUT_MISSING"),
    ],
)
def test_errors_serialise_to_the_backend_envelope(error: PDFKernelError, code: str) -> None:
    """AC-18 — every kernel error renders as the standard envelope, so an HTTP
    layer can surface it without re-mapping."""
    payload = error.to_dict()

    assert set(payload) == {"error"}
    assert set(payload["error"]) == {"code", "message", "detail"}
    assert payload["error"]["code"] == code


# --- AC-20 / AC-22 / AC-23: validation, metrics, executor ---------------------


def test_non_pdf_extension_is_rejected(tmp_path, source_pdf) -> None:
    """AC-20 — before any expensive work."""
    renamed = tmp_path / "paper.txt"
    renamed.write_bytes(source_pdf.read_bytes())

    with pytest.raises(PDFSourceInvalidError):
        asyncio.run(
            translate_pdf(renamed, tmp_path / "out", "zh",
                          provider_config("http://127.0.0.1:1/v1"))
        )


def test_empty_file_is_rejected(tmp_path) -> None:
    """AC-20."""
    empty = tmp_path / "empty.pdf"
    empty.touch()

    with pytest.raises(PDFSourceInvalidError):
        asyncio.run(
            translate_pdf(empty, tmp_path / "out", "zh",
                          provider_config("http://127.0.0.1:1/v1"))
        )


def test_result_reports_duration_and_throughput(fake_llm, tmp_path, source_pdf) -> None:
    """AC-22 — enough to estimate a long run."""
    result = asyncio.run(
        translate_pdf(source_pdf, tmp_path / "out", "zh",
                      provider_config(fake_llm), ignore_cache=True)
    )

    assert result.duration_seconds > 0
    assert result.pages_per_minute > 0


def test_throughput_is_zero_rather_than_a_division_error() -> None:
    """AC-22 — a degenerate result must not raise."""
    result = TranslationResult(
        mono_path=Path("m.pdf"), dual_path=Path("d.pdf"),
        source_page_count=0, mono_page_count=0, dual_page_count=0,
        duration_seconds=0.0,
    )

    assert result.pages_per_minute == 0.0


def test_a_custom_executor_is_used(stub_upstream, tmp_path, source_pdf) -> None:
    """AC-23 — callers can supply their own concurrency pool."""
    from concurrent.futures import ThreadPoolExecutor

    stub_upstream(_stub_writing_outputs())
    executor = ThreadPoolExecutor(max_workers=1)

    async def scenario() -> TranslationResult:
        return await translate_pdf(
            source_pdf, tmp_path / "out", "zh",
            provider_config("http://127.0.0.1:1/v1"), executor=executor,
        )

    try:
        result = asyncio.run(scenario())
    finally:
        executor.shutdown(wait=False)

    assert result.mono_path.is_file()


# --- AC-21: overwrite never leaves a half-written file ------------------------


def test_failed_overwrite_leaves_the_previous_output_intact(
    stub_upstream, tmp_path, source_pdf
) -> None:
    """AC-21 — an existing output survives a failed replacement."""
    out = tmp_path / "out"
    stub_upstream(_stub_writing_outputs())
    first = asyncio.run(
        translate_pdf(source_pdf, out, "zh", provider_config("http://127.0.0.1:1/v1"))
    )
    original_bytes = first.mono_path.read_bytes()

    # Now make the replacement fail partway.
    def explode(**kwargs):
        raise RuntimeError("boom mid-translation")

    stub_upstream(explode)
    with pytest.raises(TranslationServiceError):
        asyncio.run(
            translate_pdf(source_pdf, out, "zh",
                          provider_config("http://127.0.0.1:1/v1"), overwrite=True)
        )

    assert first.mono_path.read_bytes() == original_bytes, "the previous output was damaged"


# --- DS-BE-FIX-002: bounded provider failure ---------------------------------
#
# The defect these cover: upstream wraps its per-paragraph worker in an
# unbounded retry, so a failing provider caused the call to never return.
#
# Every test here asserts exact PROVIDER CALL COUNTS, not merely that an
# exception surfaced. A run that produced no output because it never contacted
# the provider would otherwise look identical to one that failed correctly.


def test_persistent_500_fails_fast_with_bounded_retries(
    fake_llm, no_backoff, tmp_path, source_pdf
) -> None:
    """AC-FIX-01 / AC-FIX-02 / AC-FIX-04 / AC-FIX-08.

    Exactly 3 calls: one paragraph exhausts its budget, and every later paragraph
    aborts without issuing a request.
    """
    before = sha256(source_pdf)
    started = time.perf_counter()

    with pytest.raises(TranslationServiceError) as excinfo:
        asyncio.run(
            translate_pdf(source_pdf, tmp_path / "out", "zh",
                          _failure_config(fake_llm, "always500"), ignore_cache=True, threads=1)
        )

    elapsed = time.perf_counter() - started
    assert len(FakeLLM.requests) == 3, f"expected 3 attempts, saw {len(FakeLLM.requests)}"
    assert elapsed < 5.0, f"took {elapsed:.2f}s to give up"
    assert excinfo.value.cause is not None
    assert sha256(source_pdf) == before


def test_unauthorized_fails_immediately_without_retry(
    fake_llm, no_backoff, tmp_path, source_pdf
) -> None:
    """AC-FIX-03 / AC-FIX-08 — 401 cannot be fixed by retrying."""
    with pytest.raises(TranslationServiceError):
        asyncio.run(
            translate_pdf(source_pdf, tmp_path / "out", "zh",
                          _failure_config(fake_llm, "unauthorized"), ignore_cache=True, threads=1)
        )

    assert len(FakeLLM.requests) == 1, f"401 was retried: {len(FakeLLM.requests)} calls"


def test_forbidden_fails_immediately_without_retry(
    fake_llm, no_backoff, tmp_path, source_pdf
) -> None:
    """AC-FIX-03 — 403 is likewise terminal."""
    with pytest.raises(TranslationServiceError):
        asyncio.run(
            translate_pdf(source_pdf, tmp_path / "out", "zh",
                          _failure_config(fake_llm, "forbidden"), ignore_cache=True, threads=1)
        )

    assert len(FakeLLM.requests) == 1


def test_rate_limit_is_retried_within_budget_then_fails(
    fake_llm, no_backoff, tmp_path, source_pdf
) -> None:
    """AC-FIX-02 — 429 is retryable, but not indefinitely."""
    with pytest.raises(TranslationServiceError):
        asyncio.run(
            translate_pdf(source_pdf, tmp_path / "out", "zh",
                          _failure_config(fake_llm, "ratelimit"), ignore_cache=True, threads=1)
        )

    assert len(FakeLLM.requests) == 3


def test_flaky_provider_recovers_within_the_retry_budget(
    fake_llm, no_backoff, tmp_path, source_pdf
) -> None:
    """AC-FIX-02 / AC-FIX-11 — retrying must still be *useful*.

    Two failures then success: the translation completes, which is the whole
    reason retrying exists. Without this, the fix would be indistinguishable
    from "give up immediately".
    """
    FakeLLM.failures_remaining = 2

    result = asyncio.run(
        translate_pdf(source_pdf, tmp_path / "out", "zh",
                      _failure_config(fake_llm, "flaky"), ignore_cache=True, threads=1)
    )

    assert result.mono_path.is_file()
    assert result.dual_path.is_file()
    assert result.mono_page_count == result.source_page_count


def test_the_sentinel_escapes_an_unbounded_tenacity_retry() -> None:
    """AC-FIX-05 — the mechanism itself, isolated.

    Upstream's worker is decorated with an unbounded ``@retry``. Anything that is
    an ``Exception`` is retried forever; a ``BaseException`` is not. This asserts
    the property the whole fix rests on, so that if tenacity's default predicate
    ever changes, it fails here rather than as a hang in production.
    """
    from tenacity import retry, wait_fixed

    from app.pdfkernel.abort import TranslationAbortSentinel

    class _StopTheLoop(BaseException):
        """A guard — must be a BaseException or tenacity would retry it too."""

    attempts = {"exception": 0, "sentinel": 0}

    @retry(wait=wait_fixed(0))
    def raises_exception() -> None:
        attempts["exception"] += 1
        if attempts["exception"] > 5:
            raise _StopTheLoop
        raise ValueError("ordinary failure")

    @retry(wait=wait_fixed(0))
    def raises_sentinel() -> None:
        attempts["sentinel"] += 1
        raise TranslationAbortSentinel(ValueError("terminal"))

    # An Exception is retried without bound — the defect, reproduced in isolation.
    with pytest.raises(_StopTheLoop):
        raises_exception()
    assert attempts["exception"] == 6, "an Exception should be retried repeatedly"

    # The sentinel is not.
    with pytest.raises(TranslationAbortSentinel):
        raises_sentinel()
    assert attempts["sentinel"] == 1, "the sentinel must not be retried"

    assert issubclass(TranslationAbortSentinel, BaseException)
    assert not issubclass(TranslationAbortSentinel, Exception)


def test_the_sentinel_never_escapes_the_kernel(fake_llm, no_backoff, tmp_path, source_pdf) -> None:
    """AC-FIX-06 — callers see an ordinary Exception, never the sentinel."""
    from app.pdfkernel.abort import TranslationAbortSentinel

    with pytest.raises(TranslationServiceError) as excinfo:
        asyncio.run(
            translate_pdf(source_pdf, tmp_path / "out", "zh",
                          _failure_config(fake_llm, "always500"), ignore_cache=True, threads=1)
        )

    error = excinfo.value
    assert isinstance(error, PDFKernelError)
    assert isinstance(error, Exception)
    assert not isinstance(error, TranslationAbortSentinel)
    assert error.to_dict()["error"]["code"] == "TRANSLATION_SERVICE_ERROR"


def test_a_failed_translation_does_not_terminate_the_process(tmp_path, source_pdf) -> None:
    """AC-FIX-07 — a failed translation is a task failure, not a server death.

    Run in a subprocess so a process-level exit would actually be observable.
    """
    import os
    import subprocess
    import sys

    from app.config import BACKEND_DIR

    script = (
        "import asyncio, tempfile, threading, json\n"
        "from http.server import BaseHTTPRequestHandler, HTTPServer\n"
        "from pathlib import Path\n"
        "from app.llm.models import ProviderConfig\n"
        "from app.pdfkernel import translate_pdf, TranslationServiceError\n"
        "from app.pdfkernel.bounded_translator import BoundedOpenAIlikedTranslator\n"
        "BoundedOpenAIlikedTranslator.BACKOFF_SECONDS = (0.0, 0.0)\n"
        "class H(BaseHTTPRequestHandler):\n"
        "    def log_message(self, *a): pass\n"
        "    def do_POST(self):\n"
        "        self.rfile.read(int(self.headers.get('Content-Length', 0)))\n"
        "        self.send_response(500); self.send_header('Content-Type','application/json')\n"
        "        self.end_headers(); self.wfile.write(b'{}')\n"
        "s = HTTPServer(('127.0.0.1', 0), H)\n"
        "threading.Thread(target=s.serve_forever, daemon=True).start()\n"
        f"src = Path(r'{source_pdf}')\n"
        "work = Path(tempfile.mkdtemp())\n"
        "cfg = ProviderConfig(base_url=f'http://127.0.0.1:{s.server_address[1]}/v1',"
        " api_key='sk-x', model='m', timeout_s=10)\n"
        "try:\n"
        "    asyncio.run(translate_pdf(src, work/'out', 'zh', cfg, ignore_cache=True, threads=1))\n"
        "    print('UNEXPECTED_SUCCESS')\n"
        "except TranslationServiceError:\n"
        "    print('CONTROLLED_FAILURE')\n"
        "s.shutdown()\n"
    )

    result = subprocess.run(
        [sys.executable, "-c", script], cwd=BACKEND_DIR,
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180,
    )

    assert result.returncode == 0, f"process died: {result.returncode}\n{result.stderr[-500:]}"
    assert "CONTROLLED_FAILURE" in result.stdout, result.stdout


@pytest.mark.parametrize("route", ["always500", "unauthorized", "forbidden", "ratelimit"])
def test_source_is_immutable_across_every_failure_mode(
    fake_llm, no_backoff, tmp_path, source_pdf, route: str
) -> None:
    """AC-FIX-09 — immutability must hold on the failure paths too."""
    before_hash = sha256(source_pdf)
    before_mtime = source_pdf.stat().st_mtime

    with pytest.raises(TranslationServiceError):
        asyncio.run(
            translate_pdf(source_pdf, tmp_path / "out", "zh",
                          _failure_config(fake_llm, route), ignore_cache=True, threads=1)
        )

    assert sha256(source_pdf) == before_hash
    assert source_pdf.stat().st_mtime == before_mtime


def test_provider_failure_leaves_no_partial_output(fake_llm, no_backoff, tmp_path, source_pdf) -> None:
    """AC-FIX-15 — a half-written PDF would be mistaken for a finished one."""
    out = tmp_path / "out"

    with pytest.raises(TranslationServiceError):
        asyncio.run(
            translate_pdf(source_pdf, out, "zh",
                          _failure_config(fake_llm, "always500"), ignore_cache=True, threads=1)
        )

    assert list(out.iterdir()) == [], f"left behind: {[p.name for p in out.iterdir()]}"


def test_provider_failure_within_the_latency_ceiling(
    fake_llm, no_backoff, tmp_path, source_pdf
) -> None:
    """AC-FIX-14 — with backoff zeroed, giving up must be quick."""
    started = time.perf_counter()

    with pytest.raises(TranslationServiceError):
        asyncio.run(
            translate_pdf(source_pdf, tmp_path / "out", "zh",
                          _failure_config(fake_llm, "always500"), ignore_cache=True, threads=1)
        )

    assert time.perf_counter() - started < 5.0


def test_the_failure_message_carries_no_secret(fake_llm, no_backoff, tmp_path, source_pdf) -> None:
    """AC-FIX-10."""
    with pytest.raises(TranslationServiceError) as excinfo:
        asyncio.run(
            translate_pdf(source_pdf, tmp_path / "out", "zh",
                          _failure_config(fake_llm, "unauthorized"), ignore_cache=True, threads=1)
        )

    rendered = f"{excinfo.value} {excinfo.value.message} {excinfo.value.to_dict()}"
    assert SECRET not in rendered


def test_the_failure_names_the_underlying_provider_error(
    fake_llm, no_backoff, tmp_path, source_pdf
) -> None:
    """AC-FIX-10 / AC-FIX-20 — a diagnosable failure, without leaking."""
    with pytest.raises(TranslationServiceError) as excinfo:
        asyncio.run(
            translate_pdf(source_pdf, tmp_path / "out", "zh",
                          _failure_config(fake_llm, "unauthorized"), ignore_cache=True, threads=1)
        )

    from app.llm.errors import LLMAuthenticationError

    assert isinstance(excinfo.value.cause, LLMAuthenticationError)
    assert "LLM_AUTHENTICATION_ERROR" in excinfo.value.message


# --- AC-FIX-13 / AC-FIX-17 / AC-FIX-18 / AC-FIX-19: mechanics ----------------


def test_upstream_source_is_never_modified() -> None:
    """AC-FIX-13 — the fix lives entirely in our adapter (ADR-001)."""
    import pdf2zh.converter
    import pdf2zh.high_level

    assert pdf2zh.converter.__file__.endswith(".py")
    # The injected class is a *subclass* defined by us, not a patched upstream file.
    from app.pdfkernel import adapter

    adapter._ensure_upstream_patched()
    from app.pdfkernel.bounded_translator import BoundedOpenAIlikedTranslator

    assert pdf2zh.converter.OpenAIlikedTranslator is BoundedOpenAIlikedTranslator
    assert BoundedOpenAIlikedTranslator.__module__ == "app.pdfkernel.bounded_translator"


def test_injection_is_idempotent() -> None:
    """AC-FIX-17 — repeated calls converge on the same substitution."""
    from app.pdfkernel import adapter
    from app.pdfkernel.bounded_translator import BoundedOpenAIlikedTranslator

    adapter._ensure_upstream_patched()
    adapter._ensure_upstream_patched()

    import pdf2zh.converter

    assert pdf2zh.converter.OpenAIlikedTranslator is BoundedOpenAIlikedTranslator


def test_importing_the_kernel_does_not_patch_upstream(tmp_path) -> None:
    """AC-FIX-17 — substitution is deferred, so importing stays cheap.

    Checked in a subprocess: this process has already translated something, so
    upstream is patched here by now.
    """
    import os
    import subprocess
    import sys

    from app.config import BACKEND_DIR

    script = (
        "import app.pdfkernel, pdf2zh.converter, sys\n"
        "patched = 'bounded_translator' in getattr(pdf2zh.converter.OpenAIlikedTranslator, '__module__', '')\n"
        "print('PATCHED' if patched else 'UNPATCHED')\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", script], cwd=BACKEND_DIR,
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        # Decoding must be pinned: the child writes UTF-8, but this machine's
        # locale is GBK, which would otherwise fail to decode its output.
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120,
    )

    assert result.returncode == 0, result.stderr[-400:]
    assert "UNPATCHED" in result.stdout, "importing the kernel patched upstream eagerly"


def test_backoff_is_configurable_for_fast_tests(no_backoff) -> None:
    """AC-FIX-19 — the budget is real but the sleeping is not mandatory."""
    assert no_backoff.BACKOFF_SECONDS == (0.0, 0.0)
    assert no_backoff.RETRYABLE_ATTEMPTS == 3


def test_failure_detail_is_structured_and_non_sensitive(
    fake_llm, no_backoff, tmp_path, source_pdf
) -> None:
    """AC-FIX-20 — enough to diagnose, nothing that could leak."""
    with pytest.raises(TranslationServiceError) as excinfo:
        asyncio.run(
            translate_pdf(source_pdf, tmp_path / "out", "zh",
                          _failure_config(fake_llm, "always500"), ignore_cache=True, threads=1)
        )

    detail = excinfo.value.to_dict()["error"]["detail"]
    assert detail["failed_phase"] == "paragraph_translation"
    assert detail["provider_error_code"] == "LLM_SERVER_ERROR"
    assert detail["retryable"] is True
    assert SECRET not in json.dumps(detail)


def test_cancellation_cleans_up_working_files(stub_upstream, tmp_path, source_pdf) -> None:
    """AC-FIX-16 — abandoning a translation must not leave scratch directories."""
    out = tmp_path / "out"

    def slow(**kwargs):
        time.sleep(1.5)

    stub_upstream(slow)

    async def scenario() -> None:
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(
                translate_pdf(source_pdf, out, "zh", provider_config("http://127.0.0.1:1/v1")),
                timeout=0.3,
            )

    asyncio.run(scenario())

    leftovers = [p.name for p in out.iterdir() if p.name.startswith(".pdfkernel-")]
    assert leftovers == [], f"work directory survived cancellation: {leftovers}"


def test_upstream_still_reraises_base_exceptions(fake_llm, no_backoff, tmp_path, source_pdf) -> None:
    """AC-FIX-18 — the contract our sentinel depends on, asserted end to end.

    If upstream ever caught ``BaseException`` without re-raising, the sentinel
    would be swallowed and this translation would appear to *succeed*. That the
    persistent-500 case raises at all is the contract holding.
    """
    with pytest.raises(TranslationServiceError):
        asyncio.run(
            translate_pdf(source_pdf, tmp_path / "out", "zh",
                          _failure_config(fake_llm, "always500"), ignore_cache=True, threads=1)
        )


# --- AC-07: the event loop stays free ----------------------------------------


def test_translation_does_not_block_the_event_loop(monkeypatch, tmp_path, source_pdf) -> None:
    """AC-07 — upstream is synchronous and CPU-heavy; it must run off-loop."""
    def slow_upstream(*args, **kwargs):
        time.sleep(0.6)

    monkeypatch.setattr(adapter_module, "_run_upstream", slow_upstream)

    async def scenario() -> float:
        lags: list[float] = []
        stop = asyncio.Event()

        async def heartbeat() -> None:
            while not stop.is_set():
                started = time.perf_counter()
                await asyncio.sleep(0.01)
                lags.append((time.perf_counter() - started) * 1000)

        beat = asyncio.create_task(heartbeat())
        try:
            await asyncio.wait_for(
                translate_pdf(source_pdf, tmp_path / "out", "zh",
                              provider_config("http://127.0.0.1:1/v1")),
                timeout=30,
            )
        except PDFKernelError:
            pass  # outputs were not produced; the timing is what is under test
        finally:
            stop.set()
            await beat
        return max(lags) if lags else 0.0

    worst_lag = asyncio.run(scenario())

    assert worst_lag < 50.0, f"event loop stalled for {worst_lag:.1f}ms"


# --- AC-04 / AC-05: source immutability --------------------------------------


def test_source_is_untouched_by_a_real_translation(fake_llm, tmp_path, source_pdf) -> None:
    """AC-04 — asserted on the real end-to-end path, not a mock."""
    before_hash = sha256(source_pdf)
    before_mtime = source_pdf.stat().st_mtime

    result = asyncio.run(
        translate_pdf(source_pdf, tmp_path / "out", "zh", provider_config(fake_llm), ignore_cache=True)
    )

    assert sha256(source_pdf) == before_hash
    assert source_pdf.stat().st_mtime == before_mtime
    assert result.mono_path.is_file()


def test_source_is_untouched_when_translation_fails(stub_upstream, tmp_path, source_pdf) -> None:
    """AC-05 — the failure path matters more than the success path."""
    def explode(*args, **kwargs):
        raise RuntimeError("boom")

    stub_upstream(explode)
    before_hash = sha256(source_pdf)
    before_mtime = source_pdf.stat().st_mtime

    with pytest.raises(TranslationServiceError):
        asyncio.run(
            translate_pdf(source_pdf, tmp_path / "out", "zh",
                          provider_config("http://127.0.0.1:1/v1"))
        )

    assert sha256(source_pdf) == before_hash
    assert source_pdf.stat().st_mtime == before_mtime


def test_source_survives_a_flaky_provider(fake_llm, tmp_path, source_pdf) -> None:
    """AC-05 on the real failure path — and it pins an upstream hazard.

    Upstream retries a failed translation *forever*: ``converter.py`` decorates its
    worker with ``@retry(wait=wait_fixed(1))`` and **no stop condition**. Observed
    live: an endpoint returning 500 is retried indefinitely and the call never
    returns. A user whose provider starts failing would hang, not error.

    This endpoint fails three times and then recovers, so the run terminates and
    the retrying is observable. Bounding it properly needs a replacement
    translator, which is the Context Engine phase's job; recorded as a known
    limitation until then.
    """
    FakeLLM.failures_remaining = 3
    before = sha256(source_pdf)
    flaky = fake_llm.replace("/v1", "/flaky/v1")

    result = asyncio.run(translate_pdf(source_pdf, tmp_path / "out", "zh", provider_config(flaky), ignore_cache=True))

    assert result.mono_path.is_file()
    assert sha256(source_pdf) == before, "the source was damaged during retries"
    assert len(FakeLLM.requests) > 3, (
        "upstream did not retry a failing provider — if this changes, the "
        "unbounded-retry limitation has been resolved upstream and can be dropped"
    )


# --- AC-14 / AC-06: the real end-to-end run ----------------------------------


@pytest.mark.slow
def test_end_to_end_translation_against_a_loopback_provider(
    fake_llm, tmp_path, source_pdf
) -> None:
    """AC-14 / AC-03 / AC-06 — the integration claim.

    The genuine upstream pipeline runs: layout detection with the real ONNX
    model, paragraph reconstruction, a real HTTP call to a loopback provider, and
    PDF regeneration. No mocking, no external network.
    """
    result = asyncio.run(
        translate_pdf(source_pdf, tmp_path / "out", "zh", provider_config(fake_llm), ignore_cache=True)
    )

    # AC-03: the result type
    assert isinstance(result, TranslationResult)
    assert result.mono_path.is_file()
    assert result.dual_path.is_file()

    # AC-06: page-count invariants
    assert result.source_page_count == 2
    assert result.mono_page_count == 2, "translated copy must mirror the source page count"
    assert result.dual_page_count == 4, "bilingual copy interleaves both"

    # The provider was genuinely contacted, with the configured key.
    assert FakeLLM.requests, "no request reached the provider"
    assert FakeLLM.requests[0]["auth"] == f"Bearer {SECRET}"
    assert FakeLLM.requests[0]["path"] == "/v1/chat/completions"

    # AC-03: interchangeable naming
    assert result.mono_path.name == f"{source_pdf.stem}-mono.pdf"
    assert result.dual_path.name == f"{source_pdf.stem}-dual.pdf"


@pytest.mark.slow
def test_dual_pdf_alternates_original_and_translated(fake_llm, tmp_path, source_pdf) -> None:
    """AC-06 — dual is [orig0, trans0, orig1, trans1], not originals-then-translations."""
    result = asyncio.run(
        translate_pdf(source_pdf, tmp_path / "out", "zh", provider_config(fake_llm), ignore_cache=True)
    )

    with fitz.open(str(result.dual_path)) as dual:
        pages = [dual[i].get_text() for i in range(dual.page_count)]

    originals = [i for i, text in enumerate(pages) if "MARKER" in text]
    assert originals == [0, 2], f"originals are not at the even positions: {originals}"


@pytest.mark.slow
def test_outputs_are_valid_openable_pdfs(fake_llm, tmp_path, source_pdf) -> None:
    """AC-06 — the outputs must be usable, not merely present."""
    result = asyncio.run(
        translate_pdf(source_pdf, tmp_path / "out", "zh", provider_config(fake_llm), ignore_cache=True)
    )

    for path in (result.mono_path, result.dual_path):
        with fitz.open(str(path)) as document:
            assert document.page_count > 0
            assert document.metadata is not None  # opens cleanly enough to read metadata


@pytest.mark.slow
def test_overwrite_replaces_existing_outputs(fake_llm, tmp_path, source_pdf) -> None:
    """AC-16 — replacement is opt-in."""
    out = tmp_path / "out"
    asyncio.run(translate_pdf(source_pdf, out, "zh", provider_config(fake_llm), ignore_cache=True))
    first = (out / f"{source_pdf.stem}-mono.pdf").stat().st_mtime_ns

    result = asyncio.run(
        translate_pdf(source_pdf, out, "zh", provider_config(fake_llm), overwrite=True, ignore_cache=True)
    )

    assert result.mono_path.is_file()
    assert result.mono_path.stat().st_mtime_ns >= first
