"""
dummy_main.py — Entry point for the DUMMY presentation server.

This module redirects database.DB_PATH to dummy_dataapp.db BEFORE any router
imports, then re-exports main.app unchanged so uvicorn can serve it.

Usage (via dummy.bat):
    python -m uvicorn dummy_main:app --host 0.0.0.0 --port 8001

The original dataapp.db and main.py are NEVER modified.
"""

from pathlib import Path
import database  # import first so we can patch DB_PATH before routers load

# ── Redirect DB path to the dummy file ───────────────────────────────────────
_DUMMY_DB = Path(__file__).parent / "dummy_dataapp.db"
database.DB_PATH = _DUMMY_DB


def _patched_get_db():
    """Return a sqlite3 connection pointing to dummy_dataapp.db."""
    import sqlite3
    conn = sqlite3.connect(str(_DUMMY_DB), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


# Monkey-patch get_db so every router uses the dummy DB
database.get_db = _patched_get_db

# ── Import main AFTER patching so all routers pick up the patched get_db ─────
from main import app  # noqa: E402  (import not at top intentional)


# ── Override startup to skip init_db (schema already seeded by dummy_seed.py) ─
from fastapi import FastAPI  # noqa: F401

# Re-register startup so it prints the dummy notice and does NOT call init_db()
for handler in app.router.on_startup[:]:
    app.router.on_startup.remove(handler)


@app.on_event("startup")
def dummy_startup():
    print("[DUMMY] Dummy presentation server started.")
    print(f"[DUMMY] Using database: {_DUMMY_DB}")
    print("[DUMMY] URL: http://localhost:8001")
    print("[DUMMY] Credentials — ranjeeta/admin123  |  sandeep/admin123")
    print("[DUMMY] Team members — saivamshi, akshay (ranjeeta) | snetha, rista (sandeep)")
