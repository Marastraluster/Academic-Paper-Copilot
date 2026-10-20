# Desktop application

Academic PDF Copilot runs as a Windows desktop program: one window, one local backend that the
window starts and stops, no browser tab, no second terminal. Everything the app does is unchanged
— the same FastAPI backend, the same React frontend, the same data directory. What changes is how
the two are wired together and how they are shipped.

- Decision record: [`decisions/ADR-004-desktop-shell.md`](decisions/ADR-004-desktop-shell.md)
- Build script: [`scripts/build-desktop.ps1`](../scripts/build-desktop.ps1)
- Development loop: [`scripts/run-desktop.ps1`](../scripts/run-desktop.ps1) (or `start-desktop.bat`)

## 1. What runs, and where

```
Academic PDF Copilot.exe            Electron shell   (desktop/electron/main.cjs)
  └─ apc-backend.exe                FastAPI + PDF kernel, frozen  (backend/desktop_entry.py)
       ├─ serves /api/*             unchanged API surface
       └─ serves /                 the built frontend, same origin
  └─ BrowserWindow                  frameless, loads http://127.0.0.1:<ephemeral>/
```

Four consequences, each deliberate:

| Choice | Why |
|---|---|
| The backend serves the built frontend | The window and the API share an origin, so CORS never applies and no port has to be agreed on at build time. |
| An ephemeral loopback port per launch | A fixed 8000 collides with the documented dev server, with another copy of the app, or with whatever else the machine is running. |
| One process tree, started and stopped by the shell | A desktop app that leaves a server behind after the window closes is a bug the user cannot see. The shell asks the backend to shut down through its own lifespan (`POST /api/desktop/shutdown`, per-launch token), and kills it only if it does not stop. |
| The frozen backend ships the model cache | Upstream downloads ~85 MiB of ONNX models and fonts on first use. A desktop install that needs the network to translate one PDF is not a desktop install. |

Web mode is untouched: without `FRONTEND_DIR` nothing is mounted at `/`, `/` stays a 404, and Vite
on 5173 remains the only thing serving the shell (`backend/tests/test_webapp.py` pins both halves
of that).

### The window has no native frame

`frame: false` — the application's own top bar *is* the title bar. Minimise, maximise/restore and
close are drawn by the app (`frontend/src/app/WindowControls.tsx`), from the same tokens as the
rest of the bar: the same 30 px control height, the same glass hover, the same radius, and a red
hover on close. A native Windows title bar above a glass UI reads as "a browser wrapped around a
web page", which is the one thing a packaged app must not look like.

Mechanics, because two of them are easy to get wrong:

| Concern | Implementation |
|---|---|
| Moving the window | `-webkit-app-region: drag` is applied to *deliberate* grab areas only — the product mark and the two flexible gaps between control groups (`frontend/src/index.css`). Not to the bar as a whole: a drag region swallows the mouse events of everything inside it, and on a `backdrop-filter` surface (`.glass`) its children may receive neither hover nor click. Putting the drag on empty boxes keeps every real control behaving like a web control. Double-clicking a grab area maximises, natively. |
| Talking to the shell | `contextBridge` in `desktop/electron/preload.cjs` exposes exactly three verbs (`minimize`, `toggleMaximize`, `close`) plus the maximised state. There is no generic `ipcRenderer.send` in the renderer, and `contextIsolation`/`sandbox` stay on. |
| Rendering in a tab | The controls render nothing when `window.appWindow` is absent, so the same bundle keeps working in a browser during development (`frontend/src/tests/window-controls.test.tsx`). |
| Maximise state | The shell pushes `window:maximized-changed`; the button renders Restore while pressed, and the state survives across the title bar's re-renders. |
| Feedback | Hover lightens the glass, press scales to 0.9 over 75 ms, close is red on hover, and the maximise button swaps to a restore glyph — the same language as the other buttons in the bar, because these *are* buttons in the bar. |
| Proof the buttons are wired | The build smoke run does not stop at "the button exists": it clicks maximise, minimises through the same path, and asserts the window state actually changed (`maximizeToggled`, `minimizeWorked`). A title bar that only looks like a title bar fails the build. |


## 2. Files this added

| Path | Owns |
|---|---|
| `backend/app/webapp.py` | Serving the built frontend: `/assets` mount, SPA fallback, the token-gated shutdown route. |
| `backend/app/config.py` | One new setting, `frontend_dir` (`FRONTEND_DIR`), unset in web mode. |
| `backend/desktop_entry.py` | The desktop entry point: port, data directory, cache seeding, uvicorn in-process. |
| `backend/packaging/backend.spec` | The PyInstaller recipe, including the lazily-imported PDF kernel. |
| `desktop/electron/main.cjs` | The shell: port choice, child process, health gate, frameless window, menus, shutdown, smoke check. |
| `desktop/electron/preload.cjs` | The only renderer↔shell surface: three window verbs and the maximised state. |
| `desktop/electron-builder.yml` | Packaging: what goes in the asar, what goes beside it, installer behaviour. |
| `desktop/scripts/make-icon.mjs` | Renders `assets/logo.svg` into the icon set, so the brand lives in one file. |
| `frontend/src/app/WindowControls.tsx` | The title-bar buttons, in the app's own visual language. |
| `frontend/src/desktop/bridge.ts` | Typed access to the shell bridge; `undefined` in a browser. |
| `backend/tests/test_webapp.py` | Eight tests over the desktop serving contract. |
| `frontend/src/tests/window-controls.test.tsx` | Five tests over the window controls, including the browser-tab case. |

## 3. Building it

```powershell
pwsh ./scripts/build-desktop.ps1            # installers
pwsh ./scripts/build-desktop.ps1 -Dir       # unpacked app only (fast check)
pwsh ./scripts/build-desktop.ps1 -SkipBackend -SkipFrontend   # shell-only iteration
```

The script runs five steps, in this order, and stops at the first failure:

1. **Icon** — `npm run icon` in `desktop/`, rendering `assets/logo.svg` to
   `desktop/assets/icon.ico` (and a 512 px PNG for other platform tooling).
2. **Frontend** — `npm run build:desktop`, which builds with `VITE_API_BASE_URL="/"` so every API
   call is same-origin (`frontend/vite.config.ts`, `mode === "desktop"`).
3. **Backend** — PyInstaller, one-dir, from `backend/packaging/backend.spec`.
4. **Model cache** — copied from `~/.cache/babeldoc` with the `.optimized` graph cache excluded
   (it is rebuilt on first use; shipping it would add 72 MiB of derived bytes).
5. **Installer** — `electron-builder --win nsis zip`.

Prerequisites: `backend/.venv` (with PyInstaller, installed by the script if missing) and
`desktop/node_modules` (`npm install`). Builds are offline after that, except for
`electron-builder`'s own tooling on a first run.

### Why the "green" build is a zip and not an NSIS portable exe

electron-builder's `portable` target is a self-extracting launcher: every double-click unpacks the
whole ~1 GB application into `%TEMP%` and runs it from there. Measured here: ~35 s from click to
first paint on a warm SSD, and a second double-click while the first copy is still unpacking hits
the single-instance lock and exits — which looks exactly like "the app does not open". A zip is the
same promise (nothing to install) with none of that: the user extracts once, and the extracted
`.exe` starts in about two seconds like any other program.

## 4. Runtime behaviour worth knowing

| Topic | Behaviour |
|---|---|
| Data directory | `%LOCALAPPDATA%\AcademicPDFCopilot` — the frozen backend never writes next to its own executable. Override with `APC_DATA_DIR`. |
| Logs | `%APPDATA%\Academic PDF Copilot\backend.log` (shell + backend, one file). **帮助 → 打开日志文件夹** opens it. |
| Window geometry | Remembered in `%APPDATA%\Academic PDF Copilot\window-state.json`, including whether it was maximised. |
| Closing the window | Quits the app and stops the backend. Second launch focuses the first instance instead of starting a second. |
| Menus | The shell sets an application menu for its keyboard accelerators; a frameless Windows window shows no menu bar, so every command a reader needs is in the app's own top bar. |
| Links | Anything that is not the app's own origin opens in the default browser; the window never navigates away. |
| DevTools | Only in a source run (`npm start` in `desktop/`), never in the packaged app. |

## 5. What was measured

Run on 2026-10-20, Windows 11, x64. Numbers are single observations of the commands named, not
averages.

| Claim | Evidence |
|---|---|
| The frozen backend parses a real paper | `resnet.pdf`, 12 pages → `extract-ir` returned `page_count=12, paragraph_count=101, section_count=16, duration_seconds=13.175`, and `GET /documents/{id}/ir` returned 221,283 bytes of IR. |
| The packaged window renders the application, frameless, with its own controls | Smoke run of `release/win-unpacked/Academic PDF Copilot.exe` (`APC_SMOKE=1`) reported `SMOKE_OK title="Academic PDF Copilot" rootChildren=1 windowControls=true`, and captured a screenshot showing the app's own minimise/maximise/close at the right of the top bar. |
| The title-bar buttons actually work | The same smoke run clicks them: `maximizeToggled=true minimizeWorked=true`, i.e. `BrowserWindow.isMaximized()` and `isMinimized()` changed after the app's own buttons were pressed. The build fails (`exit 3`) if they do not. |
| The installed application works, not just the unpacked directory | The NSIS package was installed silently (`/S`, exit 0), the installed executable passed the same smoke check (`exit 0`), and the uninstaller removed the directory and both shortcuts (`/S`, exit 0). |
| Shutdown is graceful, not a kill | Backend log after each smoke run: `POST /api/desktop/shutdown 200` → `Shutting down` → `Backend stopped` → `backend exited (code 0)`. |
| The desktop serving contract holds | `python -m pytest tests/test_webapp.py` → **8 passed**. |
| The controls behave in both environments | `npx vitest run src/tests/window-controls.test.tsx` → **5 passed** (nothing rendered in a tab; three verbs routed; maximise state followed). |
| Footprint | Installer **384.8 MB**; green zip **467.8 MB**; installed tree **986 MB** (`resources/backend` 529 MB, `resources/babeldoc_cache` 85 MB, Electron 368 MB). |
| The green build starts like a program, not like an unzip | Extracted from the zip, the app's smoke run finished in **13.4 s** including its own 7 s delay — i.e. first paint in a few seconds, against ~35 s for the NSIS portable target. |

## 6. Known limits

- **Windows x64 only.** `electron-builder.yml` configures `nsis` and `zip` for `win`. macOS
  and Linux are a target list away, not a code change, but they have not been built or tested.
- **The executables are unsigned.** Windows SmartScreen will warn on first run; signing needs a
  certificate this repository does not have.
- **The installer is large** (986 MB installed, 385 MB downloaded). Most of it is the PDF stack
  (`cv2` ~111 MB, `pymupdf` ~43 MB, `onnxruntime` ~40 MB, `scipy` ~65 MB), the 85 MB model cache
  and Electron itself (~368 MB). Trimming it means dropping a dependency the translation pipeline
  uses, which is a decision about behaviour, not packaging.
- **No system menu on the title bar.** A frameless window has no right-click system menu and no
  native snap-layouts button on the maximise control; resizing, snapping and double-click-to-
  maximise all still work.
- **Unseen fonts still download.** The shipped cache carries the layout model and the CJK serif
  face this pipeline uses; a document whose embedded font needs a *different* upstream asset will
  fetch it on first use (needs network), exactly as upstream behaves.
- **No Content-Security-Policy on the shell's HTML.** The renderer loads only its own origin (the
  backend that served it) and talks to nothing else, so the policy buys little; Electron still logs
  a development warning about it. Adding one is a small follow-up, but it has to be checked against
  PDF.js workers (`blob:`) and KaTeX's inline styles before it is switched on, which is why it is
  not switched on here.
- **One window, no tray.** Closing the window ends the session; there is no "keep running in the
  background" mode. That is a product decision, not an omission.
