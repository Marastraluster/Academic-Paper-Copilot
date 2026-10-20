# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the desktop backend (one-dir build).

Why a spec file rather than a command line: three things here are decisions, not
flags, and they deserve to be readable.

1. **The PDF stack is imported lazily.** ``app/pdfkernel/adapter.py`` imports
   ``pdf2zh`` inside a function so a web run never pays for it. A static analyser
   therefore never sees it, and the whole translation kernel would be missing
   from the bundle. It is named explicitly below.
2. **Some upstream modules must not ship.** ``pdf2zh.gui`` (gradio),
   ``pdf2zh.backend`` (flask + celery) and ``pdf2zh.mcp_server`` are alternative
   front ends for the upstream project. This app drives ``pdf2zh.converter``
   in-process and imports none of them; collecting them would add hundreds of
   megabytes of framework we never call.
3. **Data that is not Python.** The built frontend and the babeldoc model/font
   cache are shipped as data, because the packaged app must work offline on its
   first translation.

Build (from the repository root):

    backend/.venv/Scripts/python -m PyInstaller --noconfirm --clean \
        --distpath desktop/backend-dist --workpath desktop/.pyinstaller \
        backend/packaging/backend.spec
"""

import os
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules

spec_dir = Path(SPECPATH).resolve()
backend_dir = spec_dir.parent
repo_root = backend_dir.parent

# The helper functions below import packages to inspect them, so the backend has
# to be importable at spec evaluation time — regardless of the directory
# PyInstaller was invoked from.
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

#: Upstream modules that belong to other front ends, never to this app.
_EXCLUDED_PDF2ZH = frozenset(
    {
        "pdf2zh.gui",
        "pdf2zh.backend",
        "pdf2zh.mcp_server",
        "pdf2zh.converter_docx",
        "pdf2zh.pdf2zh",
    }
)

datas = []
binaries = []
hiddenimports = []

# Packages whose imports are dynamic, data-carrying, or reached only through the
# lazy kernel import. `app` is included so an endpoint added later with a
# deferred import still ships.
for package in (
    "app",
    "babeldoc",
    "pymupdf",
    "fitz",
    "onnxruntime",
    "keyring",
    "uvicorn",
):
    package_datas, package_binaries, package_hidden = collect_all(package)
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_hidden

hiddenimports += collect_submodules(
    "pdf2zh", filter=lambda name: name not in _EXCLUDED_PDF2ZH
)
hiddenimports += [
    "pdf2zh.converter",
    "pdf2zh.doclayout",
    "pdf2zh.pdfinterp",
    "pdf2zh.cache",
    "pdf2zh.config",
    "pdf2zh.translator",
    "pdf2zh.ocr",
    "keyring.backends.Windows",
    "uvicorn.loops.auto",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan.on",
]

# The window's origin. Without it the packaged app starts and shows a blank page.
frontend_dist = Path(os.environ.get("APC_FRONTEND_DIST", repo_root / "frontend" / "dist"))
if (frontend_dist / "index.html").is_file():
    datas.append((str(frontend_dist), "web"))

# Upstream downloads ~150 MiB of models and fonts on first use. Ship them; the
# entry point seeds them into ~/.cache/babeldoc on first launch.
#
# The `.optimized` sibling of the layout model is an onnxruntime optimisation
# cache this machine produced — it is rebuilt on first use, so shipping it would
# add 72 MiB of derived bytes for nothing.
babeldoc_cache = Path(
    os.environ.get("APC_BABELDOC_CACHE_SRC", Path.home() / ".cache" / "babeldoc")
)
if babeldoc_cache.is_dir():
    for item in babeldoc_cache.rglob("*"):
        if not item.is_file() or item.name.endswith(".optimized"):
            continue
        relative_parent = item.relative_to(babeldoc_cache).parent
        datas.append((str(item), str(Path("babeldoc_cache") / relative_parent)))

icon_path = repo_root / "desktop" / "assets" / "icon.ico"

a = Analysis(
    [str(backend_dir / "desktop_entry.py")],
    pathex=[str(backend_dir)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Never imported by this app; excluding them keeps the analyser from
        # following a transitive import into a framework we would not use.
        "tkinter",
        "matplotlib",
        "IPython",
        "pytest",
        "ruff",
        "gradio",
        "gradio_pdf",
        "celery",
        "flask",
        "mcp",
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="apc-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(icon_path) if icon_path.is_file() else None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="apc-backend",
)
