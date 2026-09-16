"""AC-08, AC-15, AC-29 — structured logging, correlation ids, secret redaction."""

from __future__ import annotations

import json
import logging
import subprocess
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import BACKEND_DIR
from app.logging import REDACTED, JsonFormatter, is_sensitive_key, redact_mapping, redact_text


def make_record(message: str = "hello world", args: tuple[Any, ...] = (), **extra: Any):
    record = logging.LogRecord(
        name="test",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg=message,
        args=args,
        exc_info=None,
    )
    for key, value in extra.items():
        setattr(record, key, value)
    return record


def format_record(record: logging.LogRecord) -> dict[str, Any]:
    return json.loads(JsonFormatter().format(record))


# --- Shape (AC-08) ----------------------------------------------------------


def test_record_is_a_single_line_of_json() -> None:
    rendered = JsonFormatter().format(make_record())
    assert "\n" not in rendered
    json.loads(rendered)


def test_record_carries_required_fields() -> None:
    payload = format_record(make_record(request_id="abc-123"))

    assert payload["level"] == "INFO"
    assert payload["message"] == "hello world"
    assert payload["request_id"] == "abc-123"
    assert "T" in payload["timestamp"]  # ISO 8601


def test_placeholder_arguments_are_interpolated() -> None:
    assert format_record(make_record("hello %s", ("world",)))["message"] == "hello world"


# --- Redaction (AC-29) ------------------------------------------------------


@pytest.mark.parametrize(
    "key",
    ["api_key", "API_KEY", "authorization", "Authorization", "token", "secret", "password", "db_password"],
)
def test_sensitive_keys_are_detected(key: str) -> None:
    assert is_sensitive_key(key)


@pytest.mark.parametrize("key", ["model", "base_url", "status_code", "path", "duration_ms"])
def test_ordinary_keys_are_not_flagged(key: str) -> None:
    assert not is_sensitive_key(key)


def test_structured_secrets_are_redacted() -> None:
    """AC-38.12."""
    payload = format_record(make_record(api_key="sk-12345", token="secret"))

    assert payload["api_key"] == REDACTED
    assert payload["token"] == REDACTED
    assert "sk-12345" not in json.dumps(payload)


def test_redaction_survives_nested_values() -> None:
    payload = format_record(make_record(api_key="sk-abcdef", model="gpt-4o-mini"))

    assert payload["api_key"] == REDACTED
    assert payload["model"] == "gpt-4o-mini"  # non-secret fields are untouched


@pytest.mark.parametrize(
    "text",
    [
        "Authorization: Bearer sk-live-abc123",
        "authorization=Bearer sk-live-abc123",
        "api_key=sk-live-abc123",
        "token: sk-live-abc123",
        "password='hunter2'",
    ],
)
def test_credentials_in_free_text_are_redacted(text: str) -> None:
    cleaned = redact_text(text)

    assert "sk-live-abc123" not in cleaned
    assert "hunter2" not in cleaned


def test_bearer_token_never_appears_in_a_rendered_record() -> None:
    payload = format_record(make_record("call failed with Authorization: Bearer sk-live-TOPSECRET"))

    assert "sk-live-TOPSECRET" not in json.dumps(payload)


def test_message_placeholder_args_are_redacted_after_interpolation() -> None:
    """Formatting happens before the scan, so `%s` cannot smuggle a key through."""
    payload = format_record(make_record("key is %s", ("api_key=sk-live-SMUGGLED",)))

    assert "sk-live-SMUGGLED" not in json.dumps(payload)


def test_redact_mapping_is_non_destructive() -> None:
    original = {"api_key": "sk-1", "model": "m"}

    redacted = redact_mapping(original)

    assert original["api_key"] == "sk-1", "the caller's dict must not be mutated"
    assert redacted["api_key"] == REDACTED


# --- Integration: real request through the app (AC-08, AC-15) ---------------


@contextmanager
def capture_log_records() -> Iterator[list[dict[str, Any]]]:
    """Collect rendered log records.

    Deliberately not ``capsys``: the logging handler binds ``sys.stdout`` when
    the app configures logging during its lifespan, which happens in fixture
    setup — before ``capsys`` swaps in the per-test stream. Attaching our own
    handler sidesteps that entirely.
    """
    records: list[dict[str, Any]] = []

    class _Collect(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            records.append(format_record(record))

    handler = _Collect()
    root = logging.getLogger()
    root.addHandler(handler)
    try:
        yield records
    finally:
        root.removeHandler(handler)


def test_access_log_contains_required_fields(client: TestClient) -> None:
    """AC-08 — one structured line per request with the required keys."""
    with capture_log_records() as records:
        client.get("/api/health", headers={"X-Request-ID": "log-trace-1"})

    access = [r for r in records if r.get("message") == "request"]
    assert access, "no access log line was emitted"

    entry = access[-1]
    for field in ("timestamp", "level", "request_id", "method", "path", "status_code"):
        assert field in entry, f"access log missing {field!r}"
    assert entry["request_id"] == "log-trace-1"
    assert entry["method"] == "GET"
    assert entry["path"] == "/api/health"
    assert entry["status_code"] == 200


def test_request_id_is_echoed_when_supplied(client: TestClient) -> None:
    """AC-15."""
    response = client.get("/api/health", headers={"X-Request-ID": "test-req-42"})

    assert response.headers["X-Request-ID"] == "test-req-42"


def test_request_id_is_generated_when_absent(client: TestClient) -> None:
    """AC-15."""
    import uuid

    response = client.get("/api/health")
    generated = response.headers.get("X-Request-ID")

    assert generated, "no request id was returned"
    uuid.UUID(generated, version=4)  # raises if not a valid UUID4


def test_generated_request_ids_are_unique(client: TestClient) -> None:
    ids = {client.get("/api/health").headers["X-Request-ID"] for _ in range(10)}

    assert len(ids) == 10


def test_unencodable_characters_do_not_destroy_the_log_record() -> None:
    """Regression: a record must arrive even if the console cannot encode it.

    On a GBK console (this machine), logging the mask bullet (U+2022) used to
    raise ``UnicodeEncodeError`` inside ``logging``, which swallowed it and
    **dropped the entire record**, emitting a ``--- Logging error ---`` block
    instead. Asserting only that a secret is *absent* cannot catch that — a line
    that never arrived trivially contains no secret. So this asserts arrival.

    Run in a subprocess with stdout redirected, because that is the case that
    fails; a real Windows console handles Unicode via a different path.
    """
    script = (
        "from app.logging import configure_logging\n"
        "import logging\n"
        "configure_logging('INFO')\n"
        "logging.getLogger('probe').info('display', extra={'masked_display': 'sk-••••ab12'})\n"
    )

    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=BACKEND_DIR,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
    )

    assert result.returncode == 0, result.stderr
    assert "Logging error" not in result.stdout + result.stderr
    assert '"message": "display"' in result.stdout, "the record never arrived"
    # The value survives, escaped rather than dropped.
    assert "sk-" in result.stdout


def test_encoding_safe_stream_leaves_normal_streams_alone() -> None:
    """The helper must not break ordinary streams."""
    import io

    from app.logging import _encoding_safe_stream

    plain = io.StringIO()
    assert _encoding_safe_stream(plain) is plain

    class NotReconfigurable:
        pass

    odd = NotReconfigurable()
    assert _encoding_safe_stream(odd) is odd


def test_no_secret_reaches_the_log_stream(client: TestClient) -> None:
    """AC-29 — end-to-end guard: a request carrying credentials logs none of them."""
    with capture_log_records() as records:
        client.get(
            "/api/health",
            headers={
                "Authorization": "Bearer sk-live-NEVERLOG",
                "X-Api-Key": "sk-live-NEVERLOG",
            },
        )

    serialised = json.dumps(records)
    assert records, "no logs were captured, so the guard proved nothing"
    assert "sk-live-NEVERLOG" not in serialised
    assert "Bearer sk-live-NEVERLOG" not in serialised
