# ADR-004 — A Desktop Shell, and Shipping the Frontend From the Backend

- **Status:** **Accepted**
- **Date:** 2026-10-20
- **Phase:** post-DS-FE-004
- **Deciders:** project maintainer
- **Evidence:** `docs/DESKTOP.md` §5 (every number below was produced by the commands named there);
  `backend/tests/test_webapp.py` (8 tests); the smoke run of the packaged executable
  (`SMOKE_OK … rootChildren=1`) and its backend log (graceful shutdown, exit 0)

## Context

The application is a local web app: FastAPI on 8000, Vite on 5173, joined by an explicit CORS
allow-list (`AC-31`). That is the right shape for development and the wrong shape for a
deliverable: a user who is handed this has to install Python, a virtualenv, Node, and run two
processes in two terminals before a PDF opens.

A desktop build has to answer three questions that the web build never had to.

1. **Which origin is the application?** With two servers, the answer is "the frontend's, and the
   API is a second origin." Any packaging that keeps two processes keeps CORS, a fixed port, and a
   startup race as permanent facts of the design.
2. **What is the boundary of the product?** The backend is not a small program: PyMuPDF, ONNX
   Runtime, OpenCV, the in-process PDF kernel and an 85 MiB model cache all have to be present and
   importable, or the first translation fails after an install that looked successful.
3. **How does it stop?** A desktop program that leaves a server bound to a port after its window
   closes has shipped a bug the user cannot see, and one that will collide with the next launch.

## Decision

**One window, one process, one origin.** The desktop shell is Electron (`desktop/`) and its only
structural job is to start the backend and load the page it serves:

- The backend serves the built frontend when `FRONTEND_DIR` is set (`backend/app/webapp.py`).
  `/assets` is mounted, everything that is not `/api/…` falls back to `index.html`, and an unknown
  `/api/…` path is still a 404 so a mistyped fetch fails honestly instead of parsing HTML.
- Web mode is unchanged. `frontend_dir` is unset there, nothing is mounted, `/` is a 404, and Vite
  remains the only thing serving the shell.
- The desktop frontend is built with `VITE_API_BASE_URL="/"`, so every call is same-origin. No port
  is baked in, no CORS rule is consulted.
- The shell picks an ephemeral loopback port per launch, waits on `/api/health`, then opens the
  window. Shutdown is `POST /api/desktop/shutdown` with a per-launch token, which sets uvicorn's
  own `should_exit` — the lifespan runs, the SQLite connection closes, and the window's exit is
  observable in the log as `Backend stopped`.
- The backend is frozen with PyInstaller (one-dir) and placed beside the shell; the model cache is
  shipped and seeded into `~/.cache/babeldoc` on first launch, because that library reads no other
  location.
- **The window has no native frame.** `frame: false`, and the application's top bar is the title
  bar: minimise / maximise-restore / close are drawn by the app (`frontend/src/app/WindowControls.tsx`)
  in the same glass language as every other control, with `-webkit-app-region` for dragging and a
  three-verb `contextBridge` preload for the buttons. A native frame above a glass UI makes the
  window read as a browser wrapped around a web page — the one impression a packaged app must not
  create — and it is also the reason the controls are absent in a tab: there, the frame already
  has them.

## Alternatives considered, and why not

| Alternative | Why it was not chosen |
|---|---|
| **Electron + the same two processes** (bundle the frontend as files, point it at `127.0.0.1:8000`) | Keeps CORS, keeps a fixed port, adds a `file://` origin that PDF.js workers and app-relative fetches behave differently under, and adds a startup race the shell must paper over. |
| **Electron with the native frame** (default window chrome) | Two visual languages stacked: an OS title bar, then a glass app bar whose first control is 30 px and rounded. It is the difference between "a program" and "a page in a frame", and the user asked for the former. `titleBarOverlay` was also rejected: it paints OS-drawn buttons over the app's own colours, which is the same seam in a different place. |
| **Tauri** (Rust shell, system WebView) | A second native toolchain (Rust + MSVC) in a repository that has no Rust, for a smaller shell. The window is not where the size is: the 529 MB is the Python PDF stack, which Tauri does not change. |
| **pywebview** (Python shell + WebView2) | No Node toolchain, but no installer story either, and the shell would then own both the UI process and the server lifecycle with a much thinner set of primitives (menus, single-instance lock, log/diagnostics) than Electron provides. |
| **One-file PyInstaller** | A one-file build unpacks 529 MB into a temp directory on every launch. Measured startup cost and antivirus noise for no benefit the installer does not already provide. |
| **Ship the virtualenv** | Not relocatable in principle: `pyvenv.cfg` names an absolute base interpreter, which the user's machine may not have. |

## Consequences

- **The frontend has two build modes**, and they differ in exactly one value. `mode === "desktop"`
  in `frontend/vite.config.ts` sets the API base to `/`; everything else is the same build. This is
  the one place the desktop build can silently diverge, so it is defined once, not per call site
  (`src/api/config.ts` remains the only reader).
- **The desktop entry point is now the documented way to start a packaged run**, and
  `uvicorn app.main:app` stays the documented way to start a development run. Two entry points is
  a cost; it is paid because a frozen build has no CLI to hand arguments to and no console to
  explain itself in.
- **A shutdown route exists in desktop mode only**, gated on an environment token the shell
  generates per launch. It is not present when the token is unset, which is why web mode cannot
  reach it.
- **The installer is large and unsigned.** Both are recorded as limits in `docs/DESKTOP.md` §6
  rather than hidden: trimming the dependency stack is a behaviour decision, and signing needs a
  certificate this repository does not have.
- **Windows is the only configured target.** macOS/Linux are a target list away; they have not
  been built, and this ADR does not claim they work.
