#Requires -Version 7.0
<#
.SYNOPSIS
    Builds the Academic PDF Copilot desktop application for Windows.

.DESCRIPTION
    One command, four artefacts, in dependency order:

      1. the icon            — rendered from assets/logo.svg
      2. the frontend        — Vite build with a relative API base (desktop mode)
      3. the backend         — PyInstaller one-dir bundle of FastAPI + the PDF kernel
      4. the installer       — electron-builder: NSIS installer + portable exe

    Everything it writes is under desktop/ and ignored by git, except the icon,
    which is small and belongs in the tree so a build needs no image toolchain.

.PARAMETER SkipBackend
    Reuse the existing desktop/backend-dist bundle (useful while iterating on the
    shell: the backend takes minutes, the shell takes seconds).

.PARAMETER SkipFrontend
    Reuse the existing frontend/dist build.

.PARAMETER Dir
    Build an unpacked app instead of installers (fast sanity check).

.EXAMPLE
    pwsh ./scripts/build-desktop.ps1

.EXAMPLE
    pwsh ./scripts/build-desktop.ps1 -SkipBackend -Dir
#>
[CmdletBinding()]
param(
    [switch]$SkipBackend,
    [switch]$SkipFrontend,
    [switch]$Dir
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$desktop = Join-Path $root 'desktop'
$frontend = Join-Path $root 'frontend'
$backend = Join-Path $root 'backend'
$python = Join-Path $backend '.venv\Scripts\python.exe'
$cacheSource = Join-Path $env:USERPROFILE '.cache\babeldoc'

function Write-Step {
    param([string]$Title)
    Write-Host ''
    Write-Host "== $Title" -ForegroundColor Cyan
}

function Invoke-Checked {
    param([string]$File, [string[]]$Arguments, [string]$WorkDir)
    Push-Location $WorkDir
    try {
        & $File @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "$File $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}

function Get-DirectorySize {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return 0 }
    return (Get-ChildItem $Path -Recurse -File | Measure-Object -Property Length -Sum).Sum
}

function Format-Size {
    param([long]$Bytes)
    if ($Bytes -ge 1GB) { return '{0:N2} GB' -f ($Bytes / 1GB) }
    if ($Bytes -ge 1MB) { return '{0:N1} MB' -f ($Bytes / 1MB) }
    return '{0:N0} KB' -f ($Bytes / 1KB)
}

foreach ($tool in @($python, (Join-Path $desktop 'node_modules'))) {
    if (-not (Test-Path $tool)) {
        throw "Missing $tool. Run: cd backend; uv sync   and   cd desktop; npm install"
    }
}
foreach ($command in @('npm', 'node')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "$command is not on PATH."
    }
}

# 1 ---------------------------------------------------------------- icon
Write-Step 'Icon'
Invoke-Checked -File 'npm' -Arguments @('run', 'icon', '--silent') -WorkDir $desktop

# 2 ------------------------------------------------------------ frontend
if ($SkipFrontend) {
    Write-Step 'Frontend (reused)'
}
else {
    Write-Step 'Frontend (desktop mode: relative API base)'
    Invoke-Checked -File 'npm' -Arguments @('run', 'build:desktop') -WorkDir $frontend
}
if (-not (Test-Path (Join-Path $frontend 'dist\index.html'))) {
    throw 'frontend/dist is missing index.html; the frontend build did not produce a shell.'
}

# 3 ------------------------------------------------------------- backend
if (-not $SkipBackend) {
    Write-Step 'Backend bundle (PyInstaller, one-dir)'
    $hasPyInstaller = (& $python -c "import PyInstaller, sys; print(PyInstaller.__version__)" 2>$null)
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'PyInstaller not present in the venv; installing.'
        Invoke-Checked -File 'uv' -Arguments @(
            'pip', 'install', '--python', $python, 'pyinstaller>=6.16,<7'
        ) -WorkDir $backend
    }
    else {
        Write-Host "PyInstaller $hasPyInstaller"
    }

    Invoke-Checked -File $python -Arguments @(
        '-m', 'PyInstaller',
        '--noconfirm', '--clean',
        '--distpath', (Join-Path $desktop 'backend-dist'),
        '--workpath', (Join-Path $desktop '.pyinstaller'),
        (Join-Path $backend 'packaging\backend.spec')
    ) -WorkDir $root
}
$backendExe = Join-Path $desktop 'backend-dist\apc-backend\apc-backend.exe'
if (-not (Test-Path $backendExe)) {
    throw "Backend bundle missing: $backendExe"
}
Write-Host ("backend bundle: {0}" -f (Format-Size (Get-DirectorySize (Join-Path $desktop 'backend-dist'))))

# 4 ------------------------------------------------- model/font cache copy
Write-Step 'Translation assets (model + fonts for offline first run)'
if (-not (Test-Path $cacheSource)) {
    throw "No babeldoc cache at $cacheSource. Run the app once with network access " +
        '(or a translation) so upstream downloads its ~150 MiB of models, then build again.'
}
$cacheTarget = Join-Path $desktop 'babeldoc-cache'
& robocopy $cacheSource $cacheTarget /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }
Write-Host ("assets: {0}" -f (Format-Size (Get-DirectorySize $cacheTarget)))

# 5 ---------------------------------------------------------- installer
Write-Step 'Installer (electron-builder)'
$builderArgs = @('--win', 'nsis', 'zip')
if ($Dir) { $builderArgs = @('--dir') }
Invoke-Checked -File (Join-Path $desktop 'node_modules\.bin\electron-builder.cmd') -Arguments $builderArgs -WorkDir $desktop

Write-Step 'Artifacts'
$release = Join-Path $desktop 'release'
Get-ChildItem $release -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in '.exe', '.blockmap', '.yml' } |
    Sort-Object Name |
    ForEach-Object { '{0,-58} {1}' -f $_.Name, (Format-Size $_.Length) }
Write-Host ''
Write-Host "Done. Output: $release" -ForegroundColor Green
