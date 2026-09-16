"""Structured logging with secret redaction (AC-08, AC-29).

Every log line is a single JSON object. Two redaction paths run on every record:

1. **By key** — any structured field whose name looks sensitive
   (``api_key``, ``authorization``, ``token``, ``secret``, ``password``…) has its
   value replaced with ``[REDACTED]``.
2. **By content** — the rendered message and any traceback are scanned for
   ``Bearer <token>`` and ``key=value`` credential patterns.

This matters more than it looks: from DS-BE-005 onward, provider API keys flow
through this code. A key that reaches a log file cannot be un-leaked, so
redaction is applied centrally here rather than trusted to each call site.
"""

from __future__ import annotations

import json
import logging
import re
import sys
from contextvars import ContextVar
from datetime import datetime, timezone
from typing import Any

#: Request id for the in-flight request, if any. A ContextVar (not a global) so
#: concurrent requests cannot observe each other's ids.
request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)

#: Correlation header. Defined here rather than in ``app.main`` so that
#: ``app.errors`` can use it without importing the app factory (which would be
#: a circular import).
REQUEST_ID_HEADER = "X-Request-ID"

REDACTED = "[REDACTED]"

#: Substrings that mark a field name as secret-bearing (compared case-insensitively).
SENSITIVE_KEY_MARKERS = (
    "api_key",
    "apikey",
    "authorization",
    "auth",
    "token",
    "secret",
    "password",
    "passwd",
    "credential",
)

#: ``Bearer abc123`` / ``sk-abc123`` style values inside free text.
_BEARER_RE = re.compile(r"(?i)\b(bearer)\s+[A-Za-z0-9._\-]+")
#: ``api_key=abc123`` / ``token: abc123`` style pairs inside free text.
_KEYVALUE_RE = re.compile(
    r"(?i)\b(api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*[\"']?([^\s,;\"'}]+)"
)

_RESERVED_ATTRS = frozenset(
    {
        "name", "msg", "args", "levelname", "levelno", "pathname", "filename",
        "module", "exc_info", "exc_text", "stack_info", "lineno", "funcName",
        "created", "msecs", "relativeCreated", "thread", "threadName",
        "processName", "process", "taskName", "message", "asctime",
        "request_id",
    }
)


def is_sensitive_key(key: str) -> bool:
    """True if a field name suggests its value must not be logged."""
    lowered = key.lower()
    return any(marker in lowered for marker in SENSITIVE_KEY_MARKERS)


def redact_text(text: str) -> str:
    """Strip credential-looking substrings from free text."""
    if not text:
        return text
    text = _BEARER_RE.sub(lambda m: f"{m.group(1)} {REDACTED}", text)
    return _KEYVALUE_RE.sub(lambda m: f"{m.group(1)}={REDACTED}", text)


def redact_mapping(data: dict[str, Any]) -> dict[str, Any]:
    """Return a copy of ``data`` with sensitive values replaced."""
    return {
        key: (REDACTED if is_sensitive_key(str(key)) else redact_text(value) if isinstance(value, str) else value)
        for key, value in data.items()
    }


def _coerce(value: Any) -> Any:
    """Make a value JSON-serialisable without losing useful information."""
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, (list, tuple)):
        return [_coerce(item) for item in value]
    if isinstance(value, dict):
        return {str(k): _coerce(v) for k, v in value.items()}
    return repr(value)


class JsonFormatter(logging.Formatter):
    """Render one log record as a single-line JSON object."""

    def format(self, record: logging.LogRecord) -> str:  # noqa: A003
        payload: dict[str, Any] = {
            "timestamp": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": redact_text(record.getMessage()),
        }

        request_id = getattr(record, "request_id", None) or request_id_var.get()
        if request_id:
            payload["request_id"] = request_id

        # Any non-standard attribute passed via ``extra=`` becomes a structured field.
        for key, value in record.__dict__.items():
            if key in _RESERVED_ATTRS or key.startswith("_"):
                continue
            if is_sensitive_key(key):
                payload[key] = REDACTED
            else:
                payload[key] = _coerce(value)

        if record.exc_info:
            payload["exception"] = redact_text(self.formatException(record.exc_info))

        return json.dumps(payload, ensure_ascii=False, default=str)


def _encoding_safe_stream(stream: object) -> object:
    """Make a text stream degrade rather than raise on unencodable characters.

    Windows consoles frequently use a legacy code page — GBK on this machine —
    which cannot encode every character the application may log. The mask bullet
    (U+2022) used to display API keys is one such character.

    Without this, ``logging`` catches the resulting ``UnicodeEncodeError``, prints
    a ``--- Logging error ---`` traceback, and **drops the entire record**. A lost
    log line is worse than an escaped one, so unencodable characters become
    ``\\uXXXX`` escapes instead.
    """
    reconfigure = getattr(stream, "reconfigure", None)
    if callable(reconfigure):
        try:
            reconfigure(errors="backslashreplace")
        except (ValueError, OSError):
            # Not a reconfigurable text stream; leave it alone.
            pass
    return stream


def configure_logging(level: str = "INFO") -> None:
    """Install the JSON formatter on the root logger.

    Called from the application lifespan, never at import time (AC-01).
    """
    handler = logging.StreamHandler(_encoding_safe_stream(sys.stdout))
    handler.setFormatter(JsonFormatter())

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level.upper())

    # uvicorn installs its own handlers; route them through ours instead.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        uvicorn_logger = logging.getLogger(name)
        uvicorn_logger.handlers.clear()
        uvicorn_logger.propagate = True


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)
