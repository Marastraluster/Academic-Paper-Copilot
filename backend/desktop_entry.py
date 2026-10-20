"""Desktop entry point: one process, one loopback port, one window.

The packaged shell (``desktop/``) starts this module instead of the ``uvicorn``
CLI, because a frozen build has no CLI to hand it arguments and no console to
read warnings from. Everything the window needs is decided here:

* **Where the frontend lives.** ``FRONTEND_DIR`` if set, otherwise ``<bundle>/web``.
  The backend then serves it on the same origin the window loaded (``app/webapp``),
  which is what removes CORS and the second process from the desktop build.
* **Which port.** ``APC_PORT``, chosen by the shell from an ephemeral bind. The
  settings validator still refuses anything but loopback — the desktop app is not
  a way to expose this service.
* **Where user data goes.** ``APC_DATA_DIR`` if set, otherwise the per-user
  application data directory the settings already default to. A packaged app must
  never write next to its own executable: that directory is under Program Files.
* **That translation assets exist offline.** Upstream downloads a ~150 MiB model
  and font cache on first use. The installer ships them; this module seeds them
  into ``~/.cache/babeldoc`` (the only location that library reads) before the
  first import of it, so a first translation works without a network.

Nothing here forks or re-executes: the server runs in the main thread with
uvicorn's own signal handling, so the shell's terminate request closes the SQLite
connection through the normal lifespan shutdown rather than by killing it.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

#: Environment keys this module reads. Named here so the shell and this file
#: cannot drift apart silently.
PORT_ENV = "APC_PORT"
DATA_DIR_ENV = "APC_DATA_DIR"
FRONTEND_ENV = "FRONTEND_DIR"
CACHE_ENV = "APC_BABELDOC_CACHE"

#: Same filename upstream looks for; a copy that stops short of this size is a
#: truncated download, not a usable model.
_LAYOUT_MODEL = "doclayout_yolo_docstructbench_imgsz1024.onnx"
_MIN_MODEL_BYTES = 1024 * 1024


def _bundle_root() -> Path:
    """Directory holding bundled data, frozen or not.

    PyInstaller lays data out under ``sys._MEIPASS`` for a one-file build and next
    to the executable for a one-dir build; the shell ships ``resources/`` next to
    the executable, so both cases resolve to the same directory.
    """
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        return Path(meipass)
    return Path(sys.executable).resolve().parent


def _source_root() -> Path:
    """The backend directory when running from source (development)."""
    return Path(__file__).resolve().parent


def _prepare_streams() -> None:
    """Force UTF-8 on stdio.

    A frozen Windows build inherits the console code page (936 here), and any
    non-ASCII log line — a document title, a provider error — would otherwise
    raise ``UnicodeEncodeError`` inside the logging handler.
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except (OSError, ValueError):
            pass


def _seed_babeldoc_cache() -> str | None:
    """Copy the bundled model/font cache into the location babeldoc reads.

    ``babeldoc.const.CACHE_FOLDER`` is ``~/.cache/babeldoc`` on every platform and
    is not configurable, so seeding is the only way to ship the assets. Files are
    copied only when missing or too small: an existing cache (from a previous run
    or a manual download) is never overwritten.
    """
    bundled = os.environ.get(CACHE_ENV)
    if not bundled:
        return None

    source = Path(bundled)
    if not source.is_dir():
        return None

    target = Path.home() / ".cache" / "babeldoc"
    model = target / "models" / _LAYOUT_MODEL
    if model.is_file() and model.stat().st_size >= _MIN_MODEL_BYTES:
        return str(target)

    target.mkdir(parents=True, exist_ok=True)
    for item in source.iterdir():
        destination = target / item.name
        if item.is_dir():
            shutil.copytree(item, destination, dirs_exist_ok=True)
        elif not destination.exists():
            shutil.copy2(item, destination)
    return str(target)


def _configure_environment() -> Path:
    """Translate the shell's environment into settings the app already reads."""
    data_dir = Path(os.environ.get(DATA_DIR_ENV) or _default_data_dir())
    data_dir.mkdir(parents=True, exist_ok=True)

    os.environ.setdefault("DATABASE_PATH", str(data_dir / "db.sqlite3"))
    os.environ.setdefault("DOCUMENTS_DIR", str(data_dir / "documents"))

    # The settings field is `port` and therefore reads PORT; the shell speaks
    # APC_PORT so it can never collide with a PORT the user already exported.
    if os.environ.get(PORT_ENV):
        os.environ["PORT"] = os.environ[PORT_ENV]

    if not os.environ.get(FRONTEND_ENV):
        candidates = (_bundle_root() / "web", _source_root().parent / "frontend" / "dist")
        for candidate in candidates:
            if (candidate / "index.html").is_file():
                os.environ[FRONTEND_ENV] = str(candidate)
                break
    return data_dir


def _default_data_dir() -> str:
    """Mirror ``app.config.default_data_dir`` without importing the app yet."""
    base = os.environ.get("LOCALAPPDATA")
    if os.name == "nt" and base:
        return str(Path(base) / "AcademicPDFCopilot")
    return str(Path.home() / ".local" / "share" / "AcademicPDFCopilot")


def _port() -> int:
    raw = os.environ.get(PORT_ENV) or os.environ.get("PORT") or "8000"
    try:
        return int(raw)
    except ValueError:
        return 8000


def main() -> int:
    _prepare_streams()

    # Frozen builds that touch multiprocessing (onnxruntime does) need this before
    # any worker is created, otherwise a child re-runs this entry point.
    import multiprocessing

    multiprocessing.freeze_support()

    data_dir = _configure_environment()
    _seed_babeldoc_cache()

    import uvicorn

    from app.config import Settings
    from app.main import create_app
    from app import __version__

    settings = Settings()
    if settings.frontend_dir is None:
        print(
            "desktop_entry: no built frontend found; the window would load an empty "
            "page. Build it with `npm run build:desktop` in frontend/.",
            file=sys.stderr,
        )

    print(
        f"desktop_entry: Academic PDF Copilot {__version__} serving on "
        f"http://{settings.host}:{settings.port} (data: {data_dir})",
        file=sys.stderr,
        flush=True,
    )

    application = create_app(settings)
    config = uvicorn.Config(
        application,
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
        # The desktop window is the only client; identifying the server to it
        # buys nothing and the CLI flag that suppresses this is unavailable here.
        server_header=False,
        date_header=False,
        access_log=False,
    )
    server = uvicorn.Server(config)
    # Exposed for the shell's shutdown route (app/webapp.py): setting
    # `should_exit` is uvicorn's own "stop at the next loop pass", which runs the
    # lifespan shutdown rather than tearing the process down.
    application.state.request_shutdown = lambda: setattr(server, "should_exit", True)
    server.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
