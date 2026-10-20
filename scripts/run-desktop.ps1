#Requires -Version 7.0
<#
.SYNOPSIS
    Runs the desktop shell from source, for development.

.DESCRIPTION
    The packaged app is built by `build-desktop.ps1`. This script is the faster
    loop: rebuild the frontend in desktop mode, then start the Electron shell
    with the backend taken from `backend/.venv` instead of the frozen bundle.

    No installer, no PyInstaller run — editing a React component takes one Vite
    build (~5 s) and a restart.

.PARAMETER SkipFrontend
    Start the shell against the existing `frontend/dist` (backend-only changes).

.EXAMPLE
    pwsh ./scripts/run-desktop.ps1
#>
[CmdletBinding()]
param([switch]$SkipFrontend)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$python = Join-Path $root 'backend\.venv\Scripts\python.exe'
$dist = Join-Path $root 'frontend\dist\index.html'
$electron = Join-Path $root 'desktop\node_modules\.bin\electron.cmd'

foreach ($path in @($python, $electron)) {
    if (-not (Test-Path $path)) {
        throw "Missing $path. Run: cd backend; uv sync   and   cd desktop; npm install"
    }
}

if ($SkipFrontend) {
    if (-not (Test-Path $dist)) {
        throw "No built frontend at $dist. Drop -SkipFrontend and let the script build it."
    }
}
else {
    Push-Location (Join-Path $root 'frontend')
    try {
        npm run build:desktop
        if ($LASTEXITCODE -ne 0) { throw "frontend build failed ($LASTEXITCODE)" }
    }
    finally { Pop-Location }
}

# A terminal launched by another tool may carry ELECTRON_RUN_AS_NODE, which turns
# the shell into a bare Node process and fails on `app.isPackaged`.
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

Push-Location (Join-Path $root 'desktop')
try {
    & $electron .
    exit $LASTEXITCODE
}
finally { Pop-Location }
