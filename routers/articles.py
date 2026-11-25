"""
routers/articles.py — Article CRUD + CSV/Excel batch upload + export.
"""
import csv
import io
import sqlite3
from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File
from fastapi.responses import StreamingResponse
from database import get_db
from models import ArticleCreate, ArticleUpdate, ArticleStatusPatch
from dependencies import require_approved, require_admin, get_current_user

router = APIRouter(prefix="/articles", tags=["articles"])

STATUS_VALUES = ["Not Used", "Used"]


def _row_to_dict(row) -> dict:
    return {
        "id": row["id"],
        "authors": row["authors"],
        "title": row["title"],
        "url": row["url"],
        "email": row["email"],
        "status": row["status"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _log_action(conn, user_id: int, action: str, target: str = None, detail: str = None):
    conn.execute(
        "INSERT INTO audit_log (user_id, action, target, detail) VALUES (?, ?, ?, ?)",
        (user_id, action, target, detail),
    )


# ── List / Search ─────────────────────────────────────────────────────────────

@router.get("")
def list_articles(
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
    search: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    user: dict = Depends(require_approved),
):
    conn = get_db()
    try:
        conditions = []
        params = []

        if search:
            conditions.append("(authors LIKE ? OR title LIKE ? OR email LIKE ?)")
            like = f"%{search}%"
            params.extend([like, like, like])

        if status and status != "All":
            conditions.append("status = ?")
            params.append(status)

        where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
        offset = (page - 1) * page_size

        total = conn.execute(
            f"SELECT COUNT(*) FROM articles {where}", params
        ).fetchone()[0]

        rows = conn.execute(
            f"SELECT * FROM articles {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
            params + [page_size, offset],
        ).fetchall()

        return {
            "total": total,
            "page": page,
            "page_size": page_size,
            "pages": max(1, -(-total // page_size)),
            "data": [_row_to_dict(r) for r in rows],
        }
    finally:
        conn.close()


# ── Single Upload ─────────────────────────────────────────────────────────────

@router.post("", status_code=201)
def create_article(body: ArticleCreate, user: dict = Depends(require_approved)):
    conn = get_db()
    try:
        existing = conn.execute(
            "SELECT id FROM articles WHERE email = ?", (body.email,)
        ).fetchone()
        if existing:
            raise HTTPException(
                status_code=409,
                detail=f"Upload blocked: email '{body.email}' already exists (Record ID: {existing['id']}).",
            )

        cur = conn.execute(
            "INSERT INTO articles (authors, title, url, email) VALUES (?, ?, ?, ?)",
            (body.authors, body.title, body.url, body.email),
        )
        conn.commit()
        _log_action(conn, int(user["sub"]), "CREATE_ARTICLE", f"article:{cur.lastrowid}", body.title)
        conn.commit()
        row = conn.execute("SELECT * FROM articles WHERE id = ?", (cur.lastrowid,)).fetchone()
        return _row_to_dict(row)
    except sqlite3.IntegrityError:
        raise HTTPException(
            status_code=409,
            detail=f"Upload blocked: email '{body.email}' already exists (DB integrity).",
        )
    finally:
        conn.close()


# ── CSV / Excel Batch Upload ──────────────────────────────────────────────────

@router.post("/upload")
async def batch_upload(
    file: UploadFile = File(...),
    user: dict = Depends(require_approved),
):
    filename = file.filename.lower()
    content = await file.read()

    rows = []

    if filename.endswith(".csv"):
        text = content.decode("utf-8-sig")
        reader = csv.DictReader(io.StringIO(text))
        for i, r in enumerate(reader, start=2):
            rows.append({"line": i, **{k.strip().lower(): v.strip() for k, v in r.items()}})

    elif filename.endswith((".xlsx", ".xls")):
        import openpyxl
        wb = openpyxl.load_workbook(io.BytesIO(content), read_only=True, data_only=True)
        ws = wb.active
        headers = None
        for i, row in enumerate(ws.iter_rows(values_only=True), start=1):
            if i == 1:
                headers = [str(c).strip().lower() if c else "" for c in row]
            else:
                row_dict = {"line": i + 1}
                for h, v in zip(headers, row):
                    row_dict[h] = str(v).strip() if v is not None else ""
                rows.append(row_dict)
        wb.close()
    else:
        raise HTTPException(status_code=400, detail="Only .csv, .xlsx, or .xls files are supported.")

    if not rows:
        raise HTTPException(status_code=400, detail="File is empty or has no data rows.")

    # Validate required columns
    required = {"authors", "title", "email"}
    if rows:
        missing = required - set(rows[0].keys())
        if missing:
            raise HTTPException(
                status_code=400,
                detail=f"Missing required columns: {', '.join(missing)}. Expected: authors, title, email (and optionally url).",
            )

    conn = get_db()
    try:
        inserted = []
        failed = []

        for r in rows:
            email = r.get("email", "").strip()
            authors = r.get("authors", "").strip()
            title = r.get("title", "").strip()
            url = r.get("url", "").strip() or None
            line = r.get("line", "?")

            if not email or not authors or not title:
                failed.append({"line": line, "email": email, "reason": "Missing required field (authors/title/email)"})
                continue

            existing = conn.execute("SELECT id FROM articles WHERE email = ?", (email,)).fetchone()
            if existing:
                failed.append({"line": line, "email": email, "reason": f"Duplicate email (Record ID: {existing['id']})"})
                continue

            try:
                cur = conn.execute(
                    "INSERT INTO articles (authors, title, url, email) VALUES (?, ?, ?, ?)",
                    (authors, title, url, email),
                )
                inserted.append({"line": line, "email": email, "id": cur.lastrowid})
            except sqlite3.IntegrityError:
                failed.append({"line": line, "email": email, "reason": "Duplicate email (race condition)"})

        conn.commit()
        _log_action(
            conn, int(user["sub"]), "BATCH_UPLOAD",
            f"{len(inserted)} inserted / {len(failed)} failed",
        )
        conn.commit()

        return {
            "inserted": len(inserted),
            "failed": len(failed),
            "inserted_rows": inserted,
            "failed_rows": failed,
        }
    finally:
        conn.close()


# ── Export CSV (Admin only) — MUST be before /{article_id} routes ───────────────

@router.get("/export")
def export_csv(user: dict = Depends(require_admin)):
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT id, authors, title, url, email, status, created_at, updated_at FROM articles ORDER BY id"
        ).fetchall()

        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(["ID", "Authors", "Title", "URL", "Email", "Status", "Created At", "Updated At"])
        for r in rows:
            writer.writerow([r["id"], r["authors"], r["title"], r["url"], r["email"], r["status"], r["created_at"], r["updated_at"]])

        output.seek(0)
        filename = f"articles_export_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
        return StreamingResponse(
            iter([output.getvalue()]),
            media_type="text/csv",
            headers={"Content-Disposition": f"attachment; filename={filename}"},
        )
    finally:
        conn.close()


# ── Update (Admin only) ───────────────────────────────────────────────────────

@router.put("/{article_id}")
def update_article(
    article_id: int,
    body: ArticleUpdate,
    user: dict = Depends(require_admin),
):
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM articles WHERE id = ?", (article_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Article not found.")

        fields = {}
        if body.authors is not None:
            fields["authors"] = body.authors
        if body.title is not None:
            fields["title"] = body.title
        if body.url is not None:
            fields["url"] = body.url
        if body.email is not None:
            # Check for duplicate email (excluding current record)
            dup = conn.execute(
                "SELECT id FROM articles WHERE email = ? AND id != ?", (body.email, article_id)
            ).fetchone()
            if dup:
                raise HTTPException(
                    status_code=409,
                    detail=f"Email '{body.email}' already exists (Record ID: {dup['id']}).",
                )
            fields["email"] = body.email
        if body.status is not None:
            fields["status"] = body.status

        if not fields:
            raise HTTPException(status_code=400, detail="No fields provided to update.")

        fields["updated_at"] = datetime.now(timezone.utc).isoformat()
        set_clause = ", ".join(f"{k} = ?" for k in fields)
        values = list(fields.values()) + [article_id]

        conn.execute(f"UPDATE articles SET {set_clause} WHERE id = ?", values)
        conn.commit()
        _log_action(conn, int(user["sub"]), "UPDATE_ARTICLE", f"article:{article_id}", str(body.dict(exclude_none=True)))
        conn.commit()

        updated = conn.execute("SELECT * FROM articles WHERE id = ?", (article_id,)).fetchone()
        return _row_to_dict(updated)
    finally:
        conn.close()


# ── Patch Status (Admin only) ─────────────────────────────────────────────────

@router.patch("/{article_id}/status")
def patch_status(
    article_id: int,
    body: ArticleStatusPatch,
    user: dict = Depends(require_admin),
):
    if body.status not in STATUS_VALUES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid status. Allowed: {STATUS_VALUES}",
        )
    conn = get_db()
    try:
        row = conn.execute("SELECT id FROM articles WHERE id = ?", (article_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Article not found.")

        now = datetime.now(timezone.utc).isoformat()
        conn.execute(
            "UPDATE articles SET status = ?, updated_at = ? WHERE id = ?",
            (body.status, now, article_id),
        )
        conn.commit()
        _log_action(conn, int(user["sub"]), "PATCH_STATUS", f"article:{article_id}", body.status)
        conn.commit()
        return {"id": article_id, "status": body.status}
    finally:
        conn.close()


# ── Delete (Admin only) ───────────────────────────────────────────────────────

@router.delete("/{article_id}", status_code=204)
def delete_article(article_id: int, user: dict = Depends(require_admin)):
    conn = get_db()
    try:
        row = conn.execute("SELECT id FROM articles WHERE id = ?", (article_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Article not found.")

        conn.execute("DELETE FROM articles WHERE id = ?", (article_id,))
        conn.commit()
        _log_action(conn, int(user["sub"]), "DELETE_ARTICLE", f"article:{article_id}")
        conn.commit()
    finally:
        conn.close()



