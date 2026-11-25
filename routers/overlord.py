"""
routers/overlord.py — Overlord-exclusive power tools.

Endpoints
─────────
POST /overlord/db/query     — Execute a raw SELECT and return columns + rows
POST /overlord/db/exec      — Execute a raw INSERT / UPDATE / DELETE
GET  /overlord/payload/recent — Last N captured request payloads (ring buffer)
GET  /overlord/monitor       — Live server metrics (CPU, RAM, disk, uptime, req/s)

All endpoints require the 'overlord' role.  The payload ring-buffer is populated
by RequestLoggingMiddleware registered in main.py.
"""
import time
import sqlite3
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends, Query
from database import get_db, DB_PATH
from models import RawQueryRequest, RawQueryResponse, RawExecRequest, RawExecResponse
from dependencies import require_overlord

router = APIRouter(prefix="/overlord", tags=["overlord"])

# ── In-memory ring buffer (populated by middleware in main.py) ─────────────────
# Imported by main.py so it can push entries; read here to serve them.
MAX_PAYLOAD_ENTRIES = 500
request_log: list[dict] = []   # mutated by middleware — no lock needed for CPython GIL


# ── Raw DB Query (SELECT) ──────────────────────────────────────────────────────

@router.post("/db/query", response_model=RawQueryResponse)
def raw_db_query(body: RawQueryRequest, _: dict = Depends(require_overlord)):
    """
    Execute an arbitrary SELECT statement against the live database.
    Returns column names + rows as JSON.

    ⚠ For SELECT only — use /db/exec for mutations.
    """
    sql = body.sql.strip()
    # Soft guard: refuse obvious non-SELECT statements
    first_word = sql.split()[0].upper() if sql else ""
    if first_word not in ("SELECT", "PRAGMA", "EXPLAIN", "WITH"):
        raise HTTPException(
            status_code=400,
            detail="Only SELECT / PRAGMA / EXPLAIN / WITH statements are allowed here. Use /overlord/db/exec for mutations.",
        )

    conn = get_db()
    try:
        params = body.params or []
        cur = conn.execute(sql, params)
        columns = [desc[0] for desc in cur.description] if cur.description else []
        rows = [list(r) for r in cur.fetchall()]
        return RawQueryResponse(columns=columns, rows=rows, row_count=len(rows))
    except sqlite3.Error as exc:
        raise HTTPException(status_code=400, detail=f"SQL error: {exc}")
    finally:
        conn.close()


# ── Raw DB Exec (INSERT / UPDATE / DELETE / etc.) ──────────────────────────────

@router.post("/db/exec", response_model=RawExecResponse)
def raw_db_exec(body: RawExecRequest, _: dict = Depends(require_overlord)):
    """
    Execute an arbitrary mutating SQL statement (INSERT, UPDATE, DELETE, DROP …).
    Returns rows_affected and last_insert_id.

    ⚠ No safety nets — you have full write access. Use carefully.
    """
    conn = get_db()
    try:
        params = body.params or []
        cur = conn.execute(body.sql.strip(), params)
        conn.commit()
        return RawExecResponse(
            rows_affected=cur.rowcount,
            last_insert_id=cur.lastrowid if cur.lastrowid else None,
            message="Statement executed successfully.",
        )
    except sqlite3.Error as exc:
        raise HTTPException(status_code=400, detail=f"SQL error: {exc}")
    finally:
        conn.close()


# ── List All Tables ────────────────────────────────────────────────────────────

@router.get("/db/tables")
def list_tables(_: dict = Depends(require_overlord)):
    """Return all user tables with their column schemas."""
    conn = get_db()
    try:
        tables = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ).fetchall()
        result = {}
        for t in tables:
            name = t["name"]
            cols = conn.execute(f"PRAGMA table_info({name})").fetchall()
            result[name] = [
                {
                    "cid": c["cid"],
                    "name": c["name"],
                    "type": c["type"],
                    "notnull": bool(c["notnull"]),
                    "default_value": c["dflt_value"],
                    "primary_key": bool(c["pk"]),
                }
                for c in cols
            ]
        return result
    finally:
        conn.close()


# ── API Payload Inspector ──────────────────────────────────────────────────────

@router.get("/payload/recent")
def recent_payloads(
    limit: int = Query(50, ge=1, le=MAX_PAYLOAD_ENTRIES),
    _: dict = Depends(require_overlord),
):
    """
    Return the last *limit* captured HTTP request payloads from the in-memory
    ring buffer.  The buffer holds the most recent MAX_PAYLOAD_ENTRIES requests.
    Each entry contains: timestamp, method, path, query_params, headers, body,
    response_status, duration_ms.
    """
    entries = request_log[-limit:]
    return {
        "buffer_size": MAX_PAYLOAD_ENTRIES,
        "captured": len(request_log),
        "returned": len(entries),
        "entries": list(reversed(entries)),  # newest first
    }


@router.delete("/payload/clear")
def clear_payload_log(_: dict = Depends(require_overlord)):
    """Flush the in-memory payload ring buffer."""
    request_log.clear()
    return {"message": "Payload log cleared.", "entries": 0}


# ── Server Monitor ─────────────────────────────────────────────────────────────

# Track server start-time for uptime calculation
_SERVER_START = time.time()


@router.get("/monitor")
def server_monitor(_: dict = Depends(require_overlord)):
    """
    Return live server health metrics:
      • cpu_percent     — CPU usage % across all cores
      • ram_percent     — RAM usage %
      • ram_used_mb     — RAM used in MB
      • ram_total_mb    — Total RAM in MB
      • disk_percent    — Disk usage % for the partition containing the DB
      • disk_used_gb    — Disk used in GB
      • disk_total_gb   — Total disk in GB
      • uptime_seconds  — Seconds since the FastAPI process started
      • uptime_human    — Human-readable uptime string
      • requests_total  — Total requests captured in the payload buffer
      • db_size_kb      — Size of the SQLite database file in KB
      • python_pid      — OS process ID of the server
    """
    try:
        import psutil, os
    except ImportError:
        raise HTTPException(
            status_code=503,
            detail="psutil is not installed. Run: pip install psutil",
        )

    cpu = psutil.cpu_percent(interval=0.2)
    ram = psutil.virtual_memory()
    disk = psutil.disk_usage(str(DB_PATH.parent))
    uptime_s = time.time() - _SERVER_START

    def fmt_uptime(s: float) -> str:
        s = int(s)
        d, s = divmod(s, 86400)
        h, s = divmod(s, 3600)
        m, s = divmod(s, 60)
        parts = []
        if d:
            parts.append(f"{d}d")
        if h:
            parts.append(f"{h}h")
        if m:
            parts.append(f"{m}m")
        parts.append(f"{s}s")
        return " ".join(parts)

    db_size_kb = round(DB_PATH.stat().st_size / 1024, 2) if DB_PATH.exists() else 0

    return {
        "cpu_percent": cpu,
        "ram_percent": ram.percent,
        "ram_used_mb": round(ram.used / 1024 / 1024, 1),
        "ram_total_mb": round(ram.total / 1024 / 1024, 1),
        "disk_percent": disk.percent,
        "disk_used_gb": round(disk.used / 1024 ** 3, 2),
        "disk_total_gb": round(disk.total / 1024 ** 3, 2),
        "uptime_seconds": round(uptime_s, 1),
        "uptime_human": fmt_uptime(uptime_s),
        "requests_total": len(request_log),
        "db_size_kb": db_size_kb,
        "python_pid": __import__("os").getpid(),
    }
