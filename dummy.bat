@echo off
title DataBase — DUMMY Presentation Mode (Port 8001)

:: Activate virtual environment
if exist venv\Scripts\activate.bat (
    call venv\Scripts\activate.bat
) else (
    echo [WARN] Virtual environment not found. Using system Python.
    echo        Run install.bat first for a clean setup.
)

echo.
echo ============================================================
echo  DUMMY Presentation Mode
echo  Seeding dummy database...
echo ============================================================
echo.

:: Seed the dummy database (creates dummy_dataapp.db fresh each run)
python dummy_seed.py
if errorlevel 1 (
    echo [ERROR] Seed script failed. Aborting.
    pause
    exit /b 1
)

echo.
echo ============================================================
echo  Dummy server is starting on PORT 8001
echo  Open http://localhost:8001 in your browser.
echo  LAN users: open http://%COMPUTERNAME%:8001
echo.
echo  Logins:
echo    ranjeeta  / admin123  (ABAcademics, primeScholarLibrary, Interesjournal)
echo    sandeep   / admin123  (scitechnol, omics, pulsus)
echo    saivamshi / user123   (ranjeeta team member)
echo    akshay    / user123   (ranjeeta team member)
echo    snetha    / user123   (sandeep team member)
echo    rista     / user123   (sandeep team member)
echo    manager   / manager123
echo    overlord  / overlord123
echo.
echo  NOTE: This is a DUMMY server. Real data is on port 8000.
echo  Press Ctrl+C to stop.
echo ============================================================
echo.

:: Start dummy FastAPI server on port 8001 (separate from real server on 8000)
python -m uvicorn dummy_main:app --host 0.0.0.0 --port 8001

pause
