@echo off
rem Academic PDF Copilot - start backend and frontend in two windows, then open the app.
cd /d "%~dp0"
start "PDF Copilot backend" /D "%~dp0backend" cmd /k .venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --no-server-header --no-date-header
start "PDF Copilot frontend" /D "%~dp0frontend" cmd /k npm run dev
timeout /t 8 /nobreak >nul
start "" http://127.0.0.1:5173/
