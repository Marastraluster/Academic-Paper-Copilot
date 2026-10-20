@echo off
rem Academic PDF Copilot - desktop shell, run from source.
rem Builds the frontend in desktop mode, then starts the Electron window with the
rem backend taken from backend\.venv. For the packaged app, run
rem scripts\build-desktop.ps1 and use the installer in desktop\release\.
cd /d "%~dp0"
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run-desktop.ps1" %*
