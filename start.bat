@echo off
title DataBase

:: Activate virtual environment
if exist venv\Scripts\activate.bat (
    call venv\Scripts\activate.bat
) else (
    echo [WARN] Virtual environment not found. Using system Python.
    echo        Run install.bat first for a clean setup.
)

echo.
echo ============================================================
echo  DataBase is starting...
echo  Open http://localhost:8000 in your browser.
echo  LAN users: open http://%COMPUTERNAME%:8000
echo  Press Ctrl+C to stop the server.
echo ============================================================
echo.

:: Start the FastAPI server (bind to all interfaces for LAN access)
python -m uvicorn main:app --host 0.0.0.0 --port 8000

pause
