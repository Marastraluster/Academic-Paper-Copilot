"""The MinerU v1 HTTP API, from upload to the downloaded result.

One flow for every deployment (verified against MinerU 4.0's own client,
`mineru/parser/api_client.py`):

1. ``POST /v1/uploads`` declares the file (name, size, sha256). A server that
   already has those bytes answers ``completed`` and the upload is skipped.
2. Otherwise ``PUT`` the bytes to the ``upload_url`` it returned, then
   ``POST /v1/uploads/{id}/complete``.
3. ``POST /v1/parse/jobs`` with the file id, asking for the ``zip`` output: it
   carries ``middle_json.json`` *and* the image files the JSON refers to.
4. Poll ``GET /v1/parse/jobs/{id}`` until a terminal status.
5. ``GET /v1/files/{file_id}/content`` downloads the zip.

Two rules carried over from the rest of this backend:

* **No key in any message.** Every error message passes `sanitize_message`, and
  the key is only ever sent to the configured origin — an upload URL on another
  host (a presigned object-store URL) gets the headers *it* specified and
  nothing else.
* **Failures are named.** A wrong key, an unreachable server and a parse the
  server gave up on are different problems with different fixes, and the reader
  is told which one happened.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import time
import zipfile
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import urlparse

import httpx

from app.llm.errors import sanitize_message
from app.storage.profiles import ServiceConfig

#: Statuses after which a job will not change again.
TERMINAL_STATUSES = frozenset({"completed", "partial", "failed", "canceled"})

#: Names the result zip may use for the middle JSON, newest first.
MIDDLE_JSON_NAMES = ("middle_json.json", "layout.json")

#: A paper is minutes of work on a CPU; an hour is the ceiling MinerU's own
#: client uses before it stops waiting.
DEFAULT_TIMEOUT_S = 3600.0
DEFAULT_POLL_INTERVAL_S = 1.5

#: MinerU refuses files larger than this; checking first saves an upload.
MAX_FILE_BYTES = 200 * 1024 * 1024


class MinerUError(Exception):
    """A parse that did not produce a result, with a code a client can act on."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = sanitize_message(message)
        super().__init__(f"{code}: {self.message}")


@dataclass
class ParseOutput:
    """What one successful parse produced."""

    middle_json: dict[str, Any]
    #: Image sidecars by their path relative to the middle JSON, e.g.
    #: ``images/3f2a….jpg``.
    assets: dict[str, bytes] = field(default_factory=dict)
    job_id: str = ""
    tier: str | None = None
    #: ``partial`` when some pages failed; the result is still usable.
    status: str = "completed"
    duration_ms: int | None = None


@dataclass
class ProbeOutcome:
    ok: bool
    code: str = ""
    message: str = ""
    detail: str | None = None
    latency_ms: float | None = None


StatusCallback = Callable[[str], None]


def normalize_base_url(raw: str) -> str:
    """``http://host:8000``, ``…/`` and ``…/v1`` all name the same API root."""
    base = (raw or "").strip().rstrip("/")
    if base.endswith("/v1"):
        base = base[: -len("/v1")]
    return base


def _origin(url: str) -> tuple[str, str, int | None]:
    parsed = urlparse(url)
    port = parsed.port
    if port is None:
        port = {"http": 80, "https": 443}.get(parsed.scheme)
    return parsed.scheme.lower(), (parsed.hostname or "").lower(), port


def _auth_headers(service: ServiceConfig) -> dict[str, str]:
    headers = dict(service.custom_headers or {})
    if service.api_key:
        headers["Authorization"] = f"Bearer {service.api_key}"
    return headers


def _error_from_response(response: httpx.Response, stage: str) -> MinerUError:
    """Turn an HTTP failure into a named one, preferring the server's own words."""
    message = ""
    code = ""
    try:
        data = response.json()
        error = data.get("error") if isinstance(data, dict) else None
        if isinstance(error, dict):
            code = str(error.get("code") or "")
            message = str(error.get("message") or "")
        elif isinstance(data, dict) and data.get("detail"):
            message = str(data["detail"])
    except Exception:  # noqa: BLE001 - not JSON; fall back to the status
        pass
    status = response.status_code
    if status in (401, 403):
        return MinerUError(
            "MINERU_AUTH_FAILED",
            message or f"The parsing service refused the key during {stage} (HTTP {status}).",
        )
    if status == 413:
        return MinerUError("MINERU_FILE_TOO_LARGE", message or "The PDF is larger than the service accepts.")
    if status == 429:
        return MinerUError("MINERU_RATE_LIMITED", message or "The parsing service's quota is used up for now.")
    detail = f" [{code}]" if code else ""
    return MinerUError(
        "MINERU_ERROR",
        (message or f"The parsing service answered HTTP {status} during {stage}.") + detail,
    )


class MinerUClient:
    """A small async client for one configured MinerU deployment."""

    def __init__(
        self,
        service: ServiceConfig,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        poll_interval_s: float = DEFAULT_POLL_INTERVAL_S,
        timeout_s: float = DEFAULT_TIMEOUT_S,
    ) -> None:
        self.service = service
        self.base_url = normalize_base_url(service.base_url)
        self._transport = transport
        self._poll_interval_s = poll_interval_s
        self._timeout_s = timeout_s

    # -- plumbing -----------------------------------------------------------

    def _client(self) -> httpx.AsyncClient:
        request_timeout = max(30.0, float(self.service.timeout_s or 60.0))
        return httpx.AsyncClient(
            transport=self._transport,
            timeout=httpx.Timeout(request_timeout, connect=15.0),
            follow_redirects=True,
        )

    async def _send(
        self,
        client: httpx.AsyncClient,
        method: str,
        url: str,
        *,
        stage: str,
        headers: dict[str, str] | None = None,
        **kwargs: Any,
    ) -> httpx.Response:
        try:
            response = await client.request(method, url, headers=headers, **kwargs)
        except httpx.TimeoutException as exc:
            raise MinerUError("MINERU_TIMEOUT", f"The parsing service timed out during {stage}.") from exc
        except httpx.TransportError as exc:
            raise MinerUError(
                "MINERU_UNREACHABLE",
                f"Could not reach the parsing service at {self.base_url} during {stage}: "
                f"{type(exc).__name__}.",
            ) from exc
        if response.status_code >= 400:
            raise _error_from_response(response, stage)
        return response

    @staticmethod
    def _json(response: httpx.Response, stage: str) -> dict[str, Any]:
        try:
            data = response.json()
        except Exception as exc:  # noqa: BLE001
            raise MinerUError("MINERU_INVALID_RESPONSE", f"The {stage} answer was not JSON.") from exc
        if not isinstance(data, dict):
            raise MinerUError("MINERU_INVALID_RESPONSE", f"The {stage} answer was not a JSON object.")
        if isinstance(data.get("error"), dict):
            error = data["error"]
            raise MinerUError("MINERU_ERROR", str(error.get("message") or error.get("code") or error))
        return data

    # -- the flow -----------------------------------------------------------

    async def _upload(self, client: httpx.AsyncClient, data: bytes, filename: str) -> str:
        headers = _auth_headers(self.service)
        created = self._json(
            await self._send(
                client,
                "POST",
                f"{self.base_url}/v1/uploads",
                stage="upload creation",
                headers=headers,
                json={
                    "filename": filename,
                    "bytes": len(data),
                    "mime_type": "application/pdf",
                    "purpose": "parse",
                    "sha256sum": hashlib.sha256(data).hexdigest(),
                },
            ),
            "upload creation",
        )
        if created.get("status") == "completed":
            # The server already holds these exact bytes.
            return str(created["file"]["id"])

        upload_url = str(created.get("upload_url") or "")
        if not upload_url:
            raise MinerUError("MINERU_INVALID_RESPONSE", "The upload answer named no upload URL.")
        if upload_url.startswith("/"):
            upload_url = f"{self.base_url}{upload_url}"
        put_headers = {
            str(k): str(v) for k, v in (created.get("upload_headers") or {}).items()
        }
        # The key goes to the configured origin and nowhere else: a presigned
        # object-store URL must not receive it.
        if _origin(upload_url) == _origin(self.base_url):
            put_headers.update(headers)
        await self._send(client, "PUT", upload_url, stage="upload", headers=put_headers, content=data)

        completed = self._json(
            await self._send(
                client,
                "POST",
                f"{self.base_url}/v1/uploads/{created['id']}/complete",
                stage="upload completion",
                headers=headers,
            ),
            "upload completion",
        )
        try:
            return str(completed["file"]["id"])
        except (KeyError, TypeError) as exc:
            raise MinerUError("MINERU_INVALID_RESPONSE", "The completed upload named no file.") from exc

    async def _submit(self, client: httpx.AsyncClient, file_id: str) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "files": [{"source": {"type": "file_id", "file_id": file_id}}],
            "output_formats": ["zip"],
        }
        if self.service.model:
            payload["tier"] = self.service.model
        return self._json(
            await self._send(
                client,
                "POST",
                f"{self.base_url}/v1/parse/jobs",
                stage="job submission",
                headers=_auth_headers(self.service),
                json=payload,
            ),
            "job submission",
        )

    async def _poll(
        self, client: httpx.AsyncClient, job: dict[str, Any], on_status: StatusCallback | None
    ) -> dict[str, Any]:
        started = time.monotonic()
        last = None
        while True:
            status = str(job.get("status") or "")
            if status != last and on_status is not None:
                on_status(status)
                last = status
            if status in TERMINAL_STATUSES:
                return job
            if time.monotonic() - started > self._timeout_s:
                raise MinerUError(
                    "MINERU_TIMEOUT",
                    f"Parsing did not finish within {int(self._timeout_s)} seconds.",
                )
            await asyncio.sleep(self._poll_interval_s)
            job = self._json(
                await self._send(
                    client,
                    "GET",
                    f"{self.base_url}/v1/parse/jobs/{job['job_id']}",
                    stage="job polling",
                    headers=_auth_headers(self.service),
                ),
                "job polling",
            )

    async def _download(self, client: httpx.AsyncClient, file_id: str) -> bytes:
        response = await self._send(
            client,
            "GET",
            f"{self.base_url}/v1/files/{file_id}/content",
            stage="result download",
            headers=_auth_headers(self.service),
        )
        return response.content

    async def parse(
        self,
        pdf_path: Path,
        *,
        on_status: StatusCallback | None = None,
    ) -> ParseOutput:
        """Parse one PDF and return its middle JSON and images."""
        data = Path(pdf_path).read_bytes()
        if len(data) > MAX_FILE_BYTES:
            raise MinerUError("MINERU_FILE_TOO_LARGE", "The PDF is larger than 200 MiB.")

        async with self._client() as client:
            if on_status is not None:
                on_status("uploading")
            file_id = await self._upload(client, data, Path(pdf_path).name)
            job = await self._submit(client, file_id)
            job = await self._poll(client, job, on_status)

            status = str(job.get("status"))
            files = job.get("files") or []
            first = files[0] if files and isinstance(files[0], dict) else {}
            if status in ("failed", "canceled"):
                error = job.get("error") or first.get("error") or {}
                message = (
                    str(error.get("message") or error.get("code"))
                    if isinstance(error, dict) and error
                    else f"The parse job ended as {status}."
                )
                raise MinerUError("MINERU_PARSE_FAILED", message)

            zip_ref = (first.get("output_files") or {}).get("zip") or {}
            zip_id = zip_ref.get("file_id") if isinstance(zip_ref, dict) else None
            if not zip_id:
                raise MinerUError("MINERU_INVALID_RESPONSE", "The finished job returned no zip output.")
            archive = await self._download(client, str(zip_id))

        middle, assets = read_result_zip(archive)
        parse_info = first.get("parse") or {}
        return ParseOutput(
            middle_json=middle,
            assets=assets,
            job_id=str(job.get("job_id") or ""),
            tier=str(job.get("tier")) if job.get("tier") else None,
            status=status,
            duration_ms=parse_info.get("duration_ms") if isinstance(parse_info, dict) else None,
        )


def _safe_member(name: str) -> str | None:
    """A zip member path that stays inside the extraction directory, or None."""
    if not name or name.endswith("/") or "\\" in name:
        return None
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts:
        return None
    return str(path)


def read_result_zip(archive: bytes) -> tuple[dict[str, Any], dict[str, bytes]]:
    """The middle JSON and every image in a MinerU result zip."""
    try:
        with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
            names = set(bundle.namelist())
            middle: dict[str, Any] | None = None
            for candidate in MIDDLE_JSON_NAMES:
                if candidate in names:
                    loaded = json.loads(bundle.read(candidate))
                    if isinstance(loaded, dict):
                        middle = loaded
                        break
            if middle is None:
                # MinerU 2.x/3.x local runs name it after the file.
                for name in sorted(names):
                    if name.endswith("_middle.json"):
                        loaded = json.loads(bundle.read(name))
                        if isinstance(loaded, dict):
                            middle = loaded
                            break
            if middle is None:
                raise MinerUError(
                    "MINERU_INVALID_RESPONSE", "The result contained no middle JSON."
                )
            assets: dict[str, bytes] = {}
            for name in names:
                safe = _safe_member(name)
                if safe is None:
                    continue
                if safe.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg")):
                    assets[safe] = bundle.read(name)
            return middle, assets
    except zipfile.BadZipFile as exc:
        raise MinerUError("MINERU_INVALID_RESPONSE", "The result was not a valid zip.") from exc
    except json.JSONDecodeError as exc:
        raise MinerUError("MINERU_INVALID_RESPONSE", "The middle JSON did not parse.") from exc


async def probe_mineru(
    service: ServiceConfig, *, transport: httpx.AsyncBaseTransport | None = None
) -> ProbeOutcome:
    """Is the service there, and — when a key is set — does it accept the key?

    ``/v1/health`` answers without a key, so a wrong key would pass it; when one
    is configured, ``/v1/usage`` is asked as well, because that is the request a
    bad key fails.
    """
    client = MinerUClient(service, transport=transport)
    started = time.perf_counter()
    try:
        async with client._client() as http:
            health = client._json(
                await client._send(
                    http, "GET", f"{client.base_url}/v1/health",
                    stage="health check", headers=_auth_headers(service),
                ),
                "health check",
            )
            if service.api_key:
                await client._send(
                    http, "GET", f"{client.base_url}/v1/usage",
                    stage="key check", headers=_auth_headers(service),
                )
    except MinerUError as exc:
        return ProbeOutcome(ok=False, code=exc.code, message=exc.message)
    latency = round((time.perf_counter() - started) * 1000, 1)
    version = health.get("version")
    return ProbeOutcome(
        ok=True,
        detail=f"MinerU {version}" if version else "MinerU",
        latency_ms=latency,
    )
