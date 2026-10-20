"""Serve the built frontend from this process (desktop mode).

The web deployment runs two processes: Vite on 5173 and uvicorn on 8000, joined
by CORS. A desktop app should not depend on two processes or on CORS at all, so
the packaged shell hands the backend a directory of static assets and the window
talks to the *same origin* it was loaded from.

Mounting is opt-in: :class:`app.config.Settings` only carries a ``frontend_dir``
when the desktop launcher sets it, so the development server keeps behaving
exactly as documented (frontend on 5173, backend on 8000).

Two rules are worth stating because they are the ones that break in practice:

1. **The catch-all must stay behind the API.** It is registered after every
   router, so ``/api/...`` keeps resolving to its endpoint. An unknown ``/api``
   path is reported as a 404 rather than being handed the SPA shell — otherwise
   a typo in a fetch path would return HTML and fail as a parse error.
2. **Only files inside the asset directory may be served.** ``resolve()`` plus a
   parent check keeps ``..%2F..%2F.env`` from walking out of the bundle.
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

#: Assets that live at the root of the build rather than under ``/assets``.
_ROOT_FILES = frozenset({"favicon.svg", "favicon.ico", "robots.txt"})

#: The shell is the one file that must never be cached: after an update the
#: window has to pick up the new asset hashes rather than a stale document.
_NO_STORE = {"Cache-Control": "no-store, max-age=0"}


def mount_frontend(app: FastAPI, directory: Path) -> None:
    """Serve ``directory`` as the application root, with SPA fallback."""
    root = Path(directory).resolve()
    index = root / "index.html"
    if not index.is_file():
        raise RuntimeError(
            f"frontend_dir={root} does not contain index.html; build the frontend "
            "(npm run build:desktop) before starting desktop mode."
        )

    assets = root / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=str(assets)), name="assets")

    router = APIRouter(include_in_schema=False)

    shutdown_token = os.environ.get("APC_SHUTDOWN_TOKEN")
    if shutdown_token:
        # The window closes the application; this is how it asks the backend to
        # shut down through its own lifespan instead of being killed. The token
        # is per-launch and passed through the environment, so nothing else on
        # the machine can reach it — the port is ephemeral, but it is still
        # loopback-reachable by any local process.
        @router.post("/api/desktop/shutdown")
        async def desktop_shutdown(request: Request) -> dict[str, str]:
            if request.headers.get("x-desktop-token") != shutdown_token:
                raise HTTPException(status_code=404, detail="Not Found")
            request_shutdown = getattr(request.app.state, "request_shutdown", None)
            if request_shutdown is not None:
                request_shutdown()
            return {"status": "stopping"}

    @router.get("/{full_path:path}")
    async def spa(full_path: str) -> FileResponse:
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not Found")

        if full_path and full_path.split("/", 1)[0] in _ROOT_FILES:
            candidate = (root / full_path).resolve()
            if candidate.is_file() and root in candidate.parents:
                return FileResponse(candidate)

        if full_path:
            candidate = (root / full_path).resolve()
            if candidate.is_file() and root in candidate.parents:
                return FileResponse(candidate)

        return FileResponse(index, headers=_NO_STORE)

    app.include_router(router)
