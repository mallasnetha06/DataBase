"""
main.py — FastAPI application entry point.
"""
import time
from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path

from database import init_db
from routers import auth, users, audit, scraping, progress, templates
from routers import overlord as overlord_router
from routers import manager as manager_router
from routers import employee_profiles as employee_profiles_router
from routers import kanban as kanban_router

app = FastAPI(title="DataBase — Internal Data Management", version="2.0.0")

# CORS — allow LAN access from any origin (internal network only)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Request Logging Middleware (feeds overlord payload inspector) ───────────────

@app.middleware("http")
async def request_logging_middleware(request: Request, call_next):
    """
    Capture each HTTP request into the overlord in-memory ring buffer.
    Starlette's Request.body() caches the bytes in request._body after the
    first read, so downstream handlers receive the full body without any
    receive-patching needed.
    Sensitive paths (/auth/login, /auth/register) have their body redacted.
    """
    from routers.overlord import request_log, MAX_PAYLOAD_ENTRIES

    start = time.time()
    REDACT_PATHS = {"/auth/login", "/auth/register"}

    # Read body — Starlette caches result in request._body automatically.
    # All downstream handlers calling request.body() get the same bytes.
    raw_body = await request.body()
    try:
        body_text = raw_body.decode("utf-8", errors="replace")
    except Exception:
        body_text = "<binary>"

    # Redact sensitive endpoints
    if request.url.path in REDACT_PATHS:
        body_text = "*** redacted ***"

    response = await call_next(request)
    duration_ms = round((time.time() - start) * 1000, 2)

    entry = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(start)),
        "method": request.method,
        "path": request.url.path,
        "query_params": dict(request.query_params),
        "headers": {
            k: v for k, v in request.headers.items()
            if k.lower() not in ("authorization",)  # mask auth header value
        },
        "body": body_text,
        "response_status": response.status_code,
        "duration_ms": duration_ms,
    }

    # Ring-buffer: keep only the latest MAX_PAYLOAD_ENTRIES entries
    if len(request_log) >= MAX_PAYLOAD_ENTRIES:
        request_log.pop(0)
    request_log.append(entry)

    return response


# Register routers
app.include_router(auth.router)
app.include_router(scraping.router)
app.include_router(progress.router)
app.include_router(users.router)
app.include_router(audit.router)
app.include_router(templates.router)
app.include_router(overlord_router.router)
app.include_router(manager_router.router)
app.include_router(employee_profiles_router.router)
app.include_router(kanban_router.router)

# Serve static frontend files
static_dir = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


@app.get("/", include_in_schema=False)
def serve_index():
    return FileResponse(str(static_dir / "index.html"))


@app.on_event("startup")
def on_startup():
    init_db()
    print("[OK] Database initialised (WAL mode active).")
    print("[APP] Server running — open http://localhost:8000 in your browser.")
    # print("[APP] Overlord role available — default credentials: overlord / overlord123")
    # print("[APP] Manager role available — default credentials: manager / manager123")
