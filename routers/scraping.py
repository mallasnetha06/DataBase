"""
routers/scraping.py — Data Scraping CRUD + batch upload (Excel/CSV) + My Collection + export.

Status values:
  Unused   — newly uploaded, not yet acted on
  Reserved — uploader has claimed it and is working on it
  Used     — email has been used / contacted
"""
import csv
import io
import json
import sqlite3
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any
from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form
from fastapi.responses import StreamingResponse
from database import get_db
from models import ScrapingCreate, ScrapingUpdate, ScrapingStatusPatch, QueueAssignRequest, QueueClearRequest
from dependencies import require_approved, require_admin, get_current_user

router = APIRouter(prefix="/scraping", tags=["scraping"])

STATUS_VALUES = ["Unused", "Used", "Reserved"]

# Flexible column-name aliases for batch upload
_COL_ALIASES = {
    "article_title": ["article_title", "article title", "articletitle", "title"],
    "author_name":   ["author_name", "author name", "authorname", "authors", "author"],
    "email":         ["email"],
    "website":       ["website", "site", "source url", "source"],
    "keyword":       ["keyword", "keywords", "key word"],
    "date":          ["date"],
    "affiliation":   ["affiliation", "organization", "organisation", "org"],
    "journal_name":  ["journal_name", "journal name", "journalname", "journal"],
    "brand":         ["brand"],
    "country":       ["country"],
    "amount":        ["amount", "invoice amount"],
    "invoice_status":["invoice_status", "invoice status", "inv status"],
    "invoice_date":  ["invoice_date", "invoice date", "inv date"],
    "journal_approved": ["journal_approved", "journal approved", "approved"],
    "approval_date": ["approval_date", "approval date"],
}


def _get_col(row_dict: dict, field: str) -> str:
    for alias in _COL_ALIASES.get(field, [field]):
        if alias in row_dict:
            return row_dict[alias]
    return ""


def _mail_count_this_month(used_at_history_json: Optional[str]) -> int:
    """Count how many Used events fall within the current calendar month."""
    if not used_at_history_json:
        return 0
    try:
        history = json.loads(used_at_history_json)
    except Exception:
        return 0
    now = datetime.now(timezone.utc)
    return sum(
        1 for ts in history
        if ts and _ts_in_current_month(ts, now)
    )


def _ts_in_current_month(ts_str: str, ref: datetime) -> bool:
    """Return True if the ISO timestamp falls in the same year+month as ref."""
    try:
        dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
        return dt.year == ref.year and dt.month == ref.month
    except Exception:
        return False


def _row_to_dict(row) -> dict:
    keys = row.keys()
    used_at_history = row["used_at_history"] if "used_at_history" in keys else "[]"
    return {
        "id":                   row["id"],
        "date":                 row["date"],
        "website":              row["website"],
        "keyword":              row["keyword"],
        "article_title":        row["article_title"],
        "author_name":          row["author_name"],
        "journal_name":         row["journal_name"],
        "email":                row["email"],
        "email_status":         row["email_status"],
        "affiliation":          row["affiliation"],
        "queue_group":          row["queue_group"] if "queue_group" in keys else None,
        "brand":                row["brand"] if "brand" in keys else None,
        "country":              row["country"] if "country" in keys else None,
        "uploaded_by":          row["uploaded_by"],
        "uploaded_by_username": row["uploaded_by_username"] if "uploaded_by_username" in keys else None,
        "support_for":          row["support_for"] if "support_for" in keys else None,
        "support_for_username": row["support_for_username"] if "support_for_username" in keys else None,
        "used_at":              row["used_at"] if "used_at" in keys else None,
        "used_at_history":      used_at_history,
        "mail_count_month":     _mail_count_this_month(used_at_history),

        "created_at":           row["created_at"],
        "updated_at":           row["updated_at"],
    }


def _log(conn, user_id: int, action: str, target: str = None, detail: str = None):
    conn.execute(
        "INSERT INTO audit_log (user_id, action, target, detail) VALUES (?, ?, ?, ?)",
        (user_id, action, target, detail),
    )


# ── Queue Assignment ───────────────────────────────────────────────────────────

@router.patch("/queue-assign")
def queue_assign(body: QueueAssignRequest, user: dict = Depends(require_approved)):
    """Assign a queue_group name + colour to specified record IDs."""
    user_id  = int(user["sub"])
    is_admin = user.get("role") == "admin"
    conn = get_db()
    try:
        if not body.record_ids:
            raise HTTPException(status_code=400, detail="No record IDs provided.")
        if not body.queue_name.strip():
            raise HTTPException(status_code=400, detail="Queue name cannot be empty.")

        now = datetime.now(timezone.utc).isoformat()
        updated = 0
        for rid in body.record_ids:
            row = conn.execute("SELECT uploaded_by FROM data_scraping WHERE id=?", (rid,)).fetchone()
            if not row:
                continue
            if not is_admin and row["uploaded_by"] != user_id:
                continue
            conn.execute(
                "UPDATE data_scraping SET queue_group=?, updated_at=? WHERE id=?",
                (body.queue_name.strip(), now, rid),
            )
            updated += 1

        # Upsert colour in queue_meta
        existing = conn.execute(
            "SELECT id FROM queue_meta WHERE user_id=? AND queue_name=?",
            (user_id, body.queue_name.strip()),
        ).fetchone()
        if existing:
            conn.execute(
                "UPDATE queue_meta SET color=? WHERE id=?",
                (body.color, existing["id"]),
            )
        else:
            conn.execute(
                "INSERT INTO queue_meta (user_id, queue_name, color) VALUES (?, ?, ?)",
                (user_id, body.queue_name.strip(), body.color),
            )

        conn.commit()
        _log(conn, user_id, "QUEUE_ASSIGN", body.queue_name, f"{updated} records")
        conn.commit()
        return {"updated": updated, "queue_name": body.queue_name.strip(), "color": body.color}
    finally:
        conn.close()


@router.patch("/queue-clear")
def queue_clear(body: QueueClearRequest, user: dict = Depends(require_approved)):
    """Remove queue_group from specified record IDs."""
    user_id  = int(user["sub"])
    is_admin = user.get("role") == "admin"
    conn = get_db()
    try:
        now = datetime.now(timezone.utc).isoformat()
        updated = 0
        for rid in body.record_ids:
            row = conn.execute("SELECT uploaded_by FROM data_scraping WHERE id=?", (rid,)).fetchone()
            if not row:
                continue
            if not is_admin and row["uploaded_by"] != user_id:
                continue
            conn.execute(
                "UPDATE data_scraping SET queue_group=NULL, updated_at=? WHERE id=?",
                (now, rid),
            )
            updated += 1
        conn.commit()
        _log(conn, user_id, "QUEUE_CLEAR", None, f"{updated} records")
        conn.commit()
        return {"updated": updated}
    finally:
        conn.close()


@router.get("/mine/queues")
def my_queues(user: dict = Depends(require_approved)):
    """Return distinct queue names + colours for the current user's records."""
    user_id = int(user["sub"])
    conn = get_db()
    try:
        # Get distinct queue names from the user's records
        rows = conn.execute(
            """SELECT DISTINCT ds.queue_group
               FROM data_scraping ds
               WHERE ds.uploaded_by = ? AND ds.queue_group IS NOT NULL AND ds.email_status != 'Used'
               ORDER BY ds.queue_group""",
            (user_id,),
        ).fetchall()

        queues = []
        for r in rows:
            qname = r["queue_group"]
            meta = conn.execute(
                "SELECT color FROM queue_meta WHERE user_id=? AND queue_name=?",
                (user_id, qname),
            ).fetchone()
            queues.append({
                "queue_name": qname,
                "color": meta["color"] if meta else "#8b5cf6",
                "count": conn.execute(
                    "SELECT COUNT(*) FROM data_scraping WHERE uploaded_by=? AND queue_group=? AND email_status != 'Used'",
                    (user_id, qname),
                ).fetchone()[0],
            })
        return {"queues": queues}
    finally:
        conn.close()


# ── Stats (any approved user) ──────────────────────────────────────────────────

@router.get("/stats")
def scraping_stats(user: dict = Depends(require_approved)):
    user_id  = int(user["sub"])
    is_admin = user.get("role") == "admin"
    conn = get_db()
    try:
        if is_admin:
            total    = conn.execute("SELECT COUNT(*) FROM data_scraping").fetchone()[0]
            unused   = conn.execute("SELECT COUNT(*) FROM data_scraping WHERE email_status='Unused'").fetchone()[0]
            used     = conn.execute("SELECT COUNT(*) FROM data_scraping WHERE email_status='Used'").fetchone()[0]
            reserved = conn.execute("SELECT COUNT(*) FROM data_scraping WHERE email_status='Reserved'").fetchone()[0]
        else:
            total    = conn.execute("SELECT COUNT(*) FROM data_scraping WHERE uploaded_by=?", (user_id,)).fetchone()[0]
            unused   = conn.execute("SELECT COUNT(*) FROM data_scraping WHERE uploaded_by=? AND email_status='Unused'", (user_id,)).fetchone()[0]
            used     = conn.execute("SELECT COUNT(*) FROM data_scraping WHERE uploaded_by=? AND email_status='Used'", (user_id,)).fetchone()[0]
            reserved = conn.execute("SELECT COUNT(*) FROM data_scraping WHERE uploaded_by=? AND email_status='Reserved'", (user_id,)).fetchone()[0]
        return {"total": total, "unused": unused, "used": used, "reserved": reserved}
    finally:
        conn.close()


# ── My Collection ──────────────────────────────────────────────────────────────

@router.get("/mine")
def my_collection(
    page:      int = Query(1,  ge=1),
    page_size: int = Query(25, ge=1, le=100),
    user: dict = Depends(require_approved),
):
    """Returns the logged-in user's own uploads that are NOT yet Used."""
    user_id = int(user["sub"])
    conn = get_db()
    try:
        offset = (page - 1) * page_size
        total = conn.execute(
            "SELECT COUNT(*) FROM data_scraping WHERE uploaded_by=? AND email_status != 'Used'",
            (user_id,),
        ).fetchone()[0]
        rows = conn.execute(
            """SELECT ds.*, u.username AS uploaded_by_username,
                      su.username AS support_for_username
               FROM data_scraping ds
               LEFT JOIN users u  ON ds.uploaded_by = u.id
               LEFT JOIN users su ON ds.support_for  = su.id
               WHERE ds.uploaded_by = ? AND ds.email_status != 'Used'
               ORDER BY ds.created_at DESC LIMIT ? OFFSET ?""",
            (user_id, page_size, offset),
        ).fetchall()
        return {
            "total": total, "page": page, "page_size": page_size,
            "pages": max(1, -(-total // page_size)),
            "data": [_row_to_dict(r) for r in rows],
        }
    finally:
        conn.close()


# ── Export CSV (admin) — must appear before /{id} routes ─────────────────────

@router.get("/export")
def export_csv(user: dict = Depends(require_admin)):
    conn = get_db()
    try:
        rows = conn.execute(
            """SELECT ds.id, ds.date, ds.website, ds.keyword, ds.article_title,
                      ds.author_name, ds.journal_name, ds.email, ds.email_status,
                      ds.affiliation, ds.brand, ds.country,
                      u.username AS uploaded_by_username, ds.created_at, ds.updated_at
               FROM data_scraping ds
               LEFT JOIN users u ON ds.uploaded_by = u.id
               ORDER BY ds.id"""
        ).fetchall()
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(["ID","Date","Website","Keyword","Article Title","Author Name",
                         "Journal Name","Email","Email Status","Affiliation","Brand","Country",
                         "Uploaded By","Created At","Updated At"])
        for r in rows:
            writer.writerow([r["id"],r["date"],r["website"],r["keyword"],r["article_title"],
                             r["author_name"],r["journal_name"],r["email"],r["email_status"],r["affiliation"],
                             r["brand"],r["country"],
                             r["uploaded_by_username"],r["created_at"],r["updated_at"]])
        output.seek(0)
        filename = f"scraping_export_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
        return StreamingResponse(
            iter([output.getvalue()]),
            media_type="text/csv",
            headers={"Content-Disposition": f"attachment; filename={filename}"},
        )
    finally:
        conn.close()


# ── List All Records ───────────────────────────────────────────────────────────

@router.get("")
def list_scraping(
    page:        int           = Query(1,    ge=1),
    page_size:   int           = Query(25,   ge=1, le=100),
    search:      Optional[str] = Query(None),
    status:      Optional[str] = Query(None),
    date_from:   Optional[str] = Query(None),
    date_to:     Optional[str] = Query(None),
    keyword:     Optional[str] = Query(None),
    website:     Optional[str] = Query(None),
    affiliation: Optional[str] = Query(None),
    user: dict = Depends(require_approved),
):
    conn = get_db()
    try:
        conditions, params = [], []

        if search:
            conditions.append(
                "(ds.author_name LIKE ? OR ds.article_title LIKE ? OR ds.email LIKE ? "
                "OR ds.keyword LIKE ? OR ds.website LIKE ?)"
            )
            like = f"%{search}%"
            params.extend([like, like, like, like, like])

        if status and status != "All":
            conditions.append("ds.email_status = ?")
            params.append(status)

        if date_from:
            conditions.append("ds.date >= ?")
            params.append(date_from)
        
        if date_to:
            conditions.append("ds.date <= ?")
            params.append(date_to)
            
        if keyword:
            conditions.append("LOWER(ds.keyword) LIKE ?")
            params.append(f"%{keyword.lower()}%")
            
        if website:
            conditions.append("LOWER(ds.website) LIKE ?")
            params.append(f"%{website.lower()}%")
            
        if affiliation:
            conditions.append("LOWER(ds.affiliation) LIKE ?")
            params.append(f"%{affiliation.lower()}%")

        where  = ("WHERE " + " AND ".join(conditions)) if conditions else ""
        offset = (page - 1) * page_size

        total = conn.execute(f"SELECT COUNT(*) FROM data_scraping ds {where}", params).fetchone()[0]
        rows  = conn.execute(
            f"""SELECT ds.*, u.username AS uploaded_by_username,
                      su.username AS support_for_username
                FROM data_scraping ds
                LEFT JOIN users u  ON ds.uploaded_by = u.id
                LEFT JOIN users su ON ds.support_for  = su.id
                {where} ORDER BY ds.created_at DESC LIMIT ? OFFSET ?""",
            params + [page_size, offset],
        ).fetchall()

        return {
            "total": total, "page": page, "page_size": page_size,
            "pages": max(1, -(-total // page_size)),
            "data": [_row_to_dict(r) for r in rows],
        }
    finally:
        conn.close()


# ── Create Single Record ───────────────────────────────────────────────────────

@router.post("", status_code=201)
def create_scraping(body: ScrapingCreate, user: dict = Depends(require_approved)):
    conn = get_db()
    try:
        existing = conn.execute("SELECT id FROM data_scraping WHERE email=?", (body.email,)).fetchone()
        if existing:
            raise HTTPException(
                status_code=409,
                detail=f"Email '{body.email}' already exists (Record ID: {existing['id']}).",
            )
        cur = conn.execute(
            """INSERT INTO data_scraping
               (date, website, keyword, article_title, author_name, journal_name, email,
                affiliation, brand, country, uploaded_by)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (body.date, body.website, body.keyword, body.article_title,
             body.author_name, body.journal_name, body.email,
             body.affiliation, body.brand, body.country, int(user["sub"])),
        )
        conn.commit()
        _log(conn, int(user["sub"]), "CREATE_SCRAPING", f"scraping:{cur.lastrowid}", body.email)
        conn.commit()
        row = conn.execute(
            """SELECT ds.*, u.username AS uploaded_by_username,
                      su.username AS support_for_username
               FROM data_scraping ds
               LEFT JOIN users u  ON ds.uploaded_by = u.id
               LEFT JOIN users su ON ds.support_for  = su.id
               WHERE ds.id = ?""",
            (cur.lastrowid,)
        ).fetchone()
        return _row_to_dict(row)
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail=f"Email '{body.email}' already exists.")
    finally:
        conn.close()


# ── Batch Upload (Excel / CSV) ─────────────────────────────────────────────────

@router.post("/upload")
async def batch_upload(
    file:           UploadFile = File(...),
    status_rules:   str        = Form(default="{}"),
    support_for_id: str        = Form(default=""),   # optional: campaigner user_id (support role)
    user: dict = Depends(require_approved),
):
    """
    Batch upload with optional status assignment rules.

    status_rules JSON shape (sent by the front-end):
    {
      "filters":        { "date_from": "", "date_to": "", "keyword": "", "website": "", "affiliation": "" },
      "assignments":    [ { "status": "Reserved", "count": 50 }, ... ],   // applied in order to filtered rows
      "default_status": "Unused"                                            // fallback for every other row
    }
    Rows that fail validation (missing required fields) are always skipped regardless of rules.
    """
    # ── Parse rules ────────────────────────────────────────────────────────
    try:
        rules = json.loads(status_rules or "{}")
    except Exception:
        rules = {}

    filters     = rules.get("preview_filters", {}) or {}
    assignments = rules.get("assignments", []) or []
    default_st  = rules.get("default_status", "Unused")
    if default_st not in STATUS_VALUES:
        default_st = "Unused"

    # Validate assignment statuses
    for a in assignments:
        if a.get("status") not in STATUS_VALUES:
            a["status"] = "Unused"

    # ── Parse file ─────────────────────────────────────────────────────────
    filename = file.filename.lower()
    content  = await file.read()
    raw_rows = []

    if filename.endswith(".csv"):
        # Try multiple encodings: UTF-8 (with BOM), then Windows cp1252, then latin-1 (never fails)
        text = None
        for encoding in ("utf-8-sig", "cp1252", "latin-1"):
            try:
                text = content.decode(encoding)
                break
            except (UnicodeDecodeError, ValueError):
                continue
        reader = csv.DictReader(io.StringIO(text))
        for i, r in enumerate(reader, start=2):
            raw_rows.append({"line": i, **{k.strip().lower(): str(v).strip() if v else "" for k, v in r.items()}})

    elif filename.endswith((".xlsx", ".xls")):
        import openpyxl
        wb = openpyxl.load_workbook(io.BytesIO(content), read_only=True, data_only=True)
        ws = wb.active
        headers = None
        for i, row in enumerate(ws.iter_rows(values_only=True), start=1):
            if i == 1:
                headers = [str(c).strip().lower() if c else "" for c in row]
            else:
                rd = {"line": i + 1}
                for h, v in zip(headers, row):
                    rd[h] = str(v).strip() if v is not None else ""
                raw_rows.append(rd)
        wb.close()
    else:
        raise HTTPException(status_code=400, detail="Only .csv, .xlsx, or .xls files are supported.")

    if not raw_rows:
        raise HTTPException(status_code=400, detail="File is empty or has no data rows.")

    # ── Normalise rows ─────────────────────────────────────────────────────
    today = datetime.now().strftime("%Y-%m-%d")

    normalised = []
    for r in raw_rows:
        date_val = _get_col(r, "date").strip() or today
        website_val = _get_col(r, "website").strip() or "N/A"
        keyword_val = _get_col(r, "keyword").strip() or "N/A"
        affiliation_val = _get_col(r, "affiliation").strip() or None
        
        # Apply shared data filters
        if filters:
            df = filters.get("date_from")
            dt = filters.get("date_to")
            kw = str(filters.get("keyword") or "").strip().lower()
            wb = str(filters.get("website") or "").strip().lower()
            af = str(filters.get("affiliation") or "").strip().lower()
            
            if df and date_val and date_val < df: continue
            if dt and date_val and date_val > dt: continue
            if kw and kw not in keyword_val.lower(): continue
            if wb and wb not in website_val.lower(): continue
            if af and af not in (affiliation_val or "").lower(): continue

        normalised.append({
            "line":          r.get("line", "?"),
            "email":         _get_col(r, "email").strip(),
            "article_title": _get_col(r, "article_title").strip(),
            "author_name":   _get_col(r, "author_name").strip(),
            "journal_name":  _get_col(r, "journal_name").strip(),
            "website":       website_val,
            "keyword":       keyword_val,
            "date":          date_val,
            "affiliation":   affiliation_val,
            "brand":         _get_col(r, "brand").strip() or None,
            "country":       _get_col(r, "country").strip() or None,
        })

    # ── Resolve status per row ─────────────────────────────────────────────
    def _evaluate_condition(row: dict, cond: dict, rule_state: dict) -> bool:
        field = cond.get("field", "")
        op = cond.get("operator", "contains")
        cond_val = str(cond.get("value", "")).lower()

        if field == "count":
            try:
                limit = int(cond_val)
            except ValueError:
                return False
            
            matches = rule_state["matches"]
            if op == "greater": return matches > limit
            if op == "less":    return matches < limit
            if op == "equals":  return matches == limit
            return matches < limit # fallback for contains

        if field not in row:
            return False
            
        row_val = str(row[field] or "").lower()
        
        if op == "contains": return cond_val in row_val
        if op == "equals":   return row_val == cond_val
        if op == "greater":  return row_val > cond_val
        if op == "less":     return row_val < cond_val
        return False

    def _matches_rule(row: dict, conditions: list, logic: str, rule_state: dict) -> bool:
        if not conditions:
            return True
        if logic == "OR":
            return any(_evaluate_condition(row, c, rule_state) for c in conditions)
        else:
            return all(_evaluate_condition(row, c, rule_state) for c in conditions)

    resolved = [default_st] * len(normalised)
    unassigned_idxs = set(range(len(normalised)))

    if assignments:
        for a in assignments:
            st    = a.get("status", default_st)
            logic = a.get("logic", "AND")
            conditions = a.get("conditions", [])
            rule_state = {"matches": 0}
            for i in sorted(unassigned_idxs):
                if _matches_rule(normalised[i], conditions, logic, rule_state):
                    resolved[i] = st
                    unassigned_idxs.remove(i)
                    rule_state["matches"] += 1

    # ── Insert / Update into DB ──────────────────────────────────────────────
    conn     = get_db()
    inserted = []
    updated  = []   # duplicate email, different journal/keyword -> updated
    skipped  = []
    blocked  = []   # duplicate email, mailed >=3 times this month -> blocked
    status_breakdown = {s: 0 for s in STATUS_VALUES}
    user_id  = int(user["sub"])
    # Parse support_for_id — only used when the uploader has role='support'
    _sf_raw = (support_for_id or "").strip()
    support_for_val = int(_sf_raw) if _sf_raw.isdigit() else None
    MONTHLY_MAIL_LIMIT = 3

    try:
        for i, r in enumerate(normalised):
            email         = r["email"]
            article_title = r["article_title"]
            author_name   = r["author_name"]
            journal_name  = r["journal_name"]
            line          = r["line"]

            if not email or not article_title or not author_name or not journal_name:
                skipped.append({"line": line, "email": email or "(empty)",
                                "reason": "Missing required field (email / article_title / author_name / journal_name)"})
                continue

            existing = conn.execute(
                "SELECT id, keyword, journal_name, used_at_history FROM data_scraping WHERE email=?",
                (email,)
            ).fetchone()

            if existing:
                # ── Monthly mail-count check ────────────────────────────────────────
                count_month = _mail_count_this_month(existing["used_at_history"])
                if count_month >= MONTHLY_MAIL_LIMIT:
                    blocked.append({
                        "line": line, "email": email,
                        "reason": f"Blocked — already mailed {count_month} time(s) this month (limit: {MONTHLY_MAIL_LIMIT})",
                        "mail_count_month": count_month,
                    })
                    continue

                # ── Check if journal/keyword differ ────────────────────────────────
                existing_keywords = [k.strip() for k in (existing["keyword"] or "").split(",")]
                existing_journals  = [j.strip() for j in (existing["journal_name"] or "").split(",")]

                new_keywords = [k.strip() for k in journal_name.split(",") if k.strip()]
                # Note: 'journal_name' in CSV maps to journal; 'keyword' is keyword
                incoming_keyword = r["keyword"].strip()
                incoming_journal = journal_name.strip()

                keyword_is_new = incoming_keyword and incoming_keyword not in existing_keywords
                journal_is_new = incoming_journal and incoming_journal not in existing_journals

                if not keyword_is_new and not journal_is_new:
                    skipped.append({
                        "line": line, "email": email,
                        "reason": f"Duplicate — same journal & keyword already in DB (Record ID: {existing['id']})",
                        "mail_count_month": count_month,
                    })
                    continue

                # ── Append new keyword / journal to existing row ──────────────────
                merged_keywords = existing_keywords[:]
                if keyword_is_new:
                    merged_keywords.append(incoming_keyword)

                merged_journals = existing_journals[:]
                if journal_is_new:
                    merged_journals.append(incoming_journal)

                new_kw_str  = ", ".join(merged_keywords)
                new_jn_str  = ", ".join(merged_journals)
                now_ts      = datetime.now(timezone.utc).isoformat()

                row_status = resolved[i]
                conn.execute(
                    "UPDATE data_scraping SET keyword=?, journal_name=?, updated_at=?, email_status=?, uploaded_by=?, support_for=? WHERE id=?",
                    (new_kw_str, new_jn_str, now_ts, row_status, user_id, support_for_val, existing["id"]),
                )
                status_breakdown[row_status] = status_breakdown.get(row_status, 0) + 1
                updated.append({
                    "line": line, "email": email, "id": existing["id"],
                    "added_keyword": incoming_keyword if keyword_is_new else None,
                    "added_journal": incoming_journal if journal_is_new else None,
                    "mail_count_month": count_month,
                })
                continue

            # ── Brand-new email — insert ───────────────────────────────────────────────
            row_status = resolved[i]
            try:
                cur = conn.execute(
                    """INSERT INTO data_scraping
                       (date, website, keyword, article_title, author_name, journal_name, email,
                        affiliation, brand, country, uploaded_by, support_for, email_status)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (r["date"], r["website"], r["keyword"], article_title,
                     author_name, journal_name, email,
                     r["affiliation"], r["brand"], r["country"], user_id, support_for_val, row_status),
                )
                inserted.append({"line": line, "email": email, "id": cur.lastrowid, "status": row_status})
                status_breakdown[row_status] = status_breakdown.get(row_status, 0) + 1
            except sqlite3.IntegrityError:
                skipped.append({"line": line, "email": email, "reason": "Duplicate (race condition)"})

        conn.commit()
        _log(
            conn, user_id, "BATCH_UPLOAD_SCRAPING",
            f"{len(inserted)} inserted / {len(updated)} updated / {len(skipped)} skipped / {len(blocked)} blocked"
        )
        conn.commit()

        return {
            "inserted":         len(inserted),
            "updated":          len(updated),
            "skipped":          len(skipped),
            "blocked":          len(blocked),
            "inserted_rows":    inserted,
            "updated_rows":     updated,
            "skipped_rows":     skipped,
            "blocked_rows":     blocked,
            "status_breakdown": status_breakdown,
        }
    finally:
        conn.close()


# ── Analyse (rich pre-upload read-only scan) ─────────────────────────────────────────

class AnalyseItem(BaseModel):
    email: str
    journal_name: str
    keyword: str
    article_title: str = ""
    author_name: str   = ""

class AnalyseRequest(BaseModel):
    rows: List[AnalyseItem]


@router.post("/analyse")
def analyse_upload(
    body: AnalyseRequest,
    user: dict = Depends(require_approved),
):
    """
    Read-only pre-upload analysis.
    Returns per-row DB classification:
      new | duplicate | updatable | blocked | invalid
    For existing rows (updatable / blocked / duplicate) it also returns the full
    mail-send history, existing journal/keyword lists, and invoices_history so the
    front-end can render a rich expandable detail card.
    """
    MONTHLY_MAIL_LIMIT = 3
    conn = get_db()
    results = []
    try:
        for item in body.rows[:2000]:
            email         = item.email.strip()
            incoming_jn   = item.journal_name.strip()
            incoming_kw   = item.keyword.strip()
            has_required  = bool(email and item.article_title.strip()
                                 and item.author_name.strip() and incoming_jn)

            if not has_required:
                results.append({
                    "email":       email or "(empty)",
                    "category":    "invalid",
                    "reason":      "Missing required field (email / article_title / author_name / journal_name)",
                })
                continue

            row = conn.execute(
                """SELECT id, email_status, affiliation, brand, created_at,
                          keyword, journal_name, used_at_history, invoices_history
                   FROM data_scraping WHERE email=?""",
                (email,)
            ).fetchone()

            if not row:
                results.append({
                    "email":    email,
                    "category": "new",
                    "reason":   "Not in DB — will be inserted",
                })
                continue

            # ── Parse histories ────────────────────────────────────────────
            try:
                used_history: list = json.loads(row["used_at_history"] or "[]")
                if not isinstance(used_history, list):
                    used_history = []
            except Exception:
                used_history = []

            try:
                invoices_history: list = json.loads(row["invoices_history"] or "[]")
                if not isinstance(invoices_history, list):
                    invoices_history = []
            except Exception:
                invoices_history = []

            count_month  = _mail_count_this_month(row["used_at_history"])
            count_total  = len(used_history)
            last_used_at = used_history[-1][:10] if used_history else None

            existing_keywords = [k.strip() for k in (row["keyword"] or "").split(",") if k.strip()]
            existing_journals  = [j.strip() for j in (row["journal_name"] or "").split(",") if j.strip()]
            keyword_is_new = bool(incoming_kw and incoming_kw not in existing_keywords)
            journal_is_new = bool(incoming_jn and incoming_jn not in existing_journals)

            # ── Common rich payload ────────────────────────────────────────
            rich = {
                "email":              email,
                "record_id":          row["id"],
                "email_status":       row["email_status"],
                "affiliation":        row["affiliation"] or "",
                "brand":              row["brand"] or "",
                "created_at":         row["created_at"][:10] if row["created_at"] else "",
                "mail_count_month":   count_month,
                "mail_count_total":   count_total,
                "used_at_history":    used_history,
                "last_used_at":       last_used_at,
                "existing_keywords":  existing_keywords,
                "existing_journals":  existing_journals,
                "incoming_keyword":   incoming_kw,
                "incoming_journal":   incoming_jn,
                "keyword_is_new":     keyword_is_new,
                "journal_is_new":     journal_is_new,
                "invoices_history":   invoices_history,
            }

            if count_month >= MONTHLY_MAIL_LIMIT:
                rich["category"] = "blocked"
                rich["reason"]   = f"Blocked — emailed {count_month}× this month (limit: {MONTHLY_MAIL_LIMIT})"
            elif keyword_is_new or journal_is_new:
                rich["category"] = "updatable"
                parts = []
                if journal_is_new: parts.append(f"journal '{incoming_jn}'")
                if keyword_is_new: parts.append(f"keyword '{incoming_kw}'")
                rich["reason"]  = "Will append " + " and ".join(parts) + " to existing record"
            else:
                rich["category"] = "duplicate"
                rich["reason"]   = (
                    f"Duplicate — same journal & keyword already in DB "
                    f"(Record ID: {row['id']})"
                )

            results.append(rich)

        return {"results": results}
    finally:
        conn.close()


# ── Check Duplicates (lightweight pre-upload query) ──────────────────────────────────


class DupCheckItem(BaseModel):
    email: str
    journal_name: str
    keyword: str

class DupCheckRequest(BaseModel):
    rows: List[DupCheckItem]



@router.post("/check-duplicates")
def check_duplicates(
    body: DupCheckRequest,
    user: dict = Depends(require_approved),
):
    """
    Lightweight endpoint called by the upload-preview UI.
    Accepts up to 500 {email, journal_name, keyword} objects and returns
    per-email DB status so the preview table can show 'DB Status' badges.
    """
    MONTHLY_MAIL_LIMIT = 3
    conn = get_db()
    results: Dict[str, Any] = {}
    try:
        for item in body.rows[:500]:  # cap at 500 to avoid abuse
            email = item.email.strip()
            if not email:
                continue

            row = conn.execute(
                "SELECT id, keyword, journal_name, used_at_history FROM data_scraping WHERE email=?",
                (email,)
            ).fetchone()

            if not row:
                results[email] = {"exists": False, "mail_count_month": 0, "blocked": False,
                                  "same_journal_keyword": False,
                                  "existing_keywords": "", "existing_journals": ""}
                continue

            count_month = _mail_count_this_month(row["used_at_history"])
            existing_keywords = [k.strip() for k in (row["keyword"] or "").split(",")]
            existing_journals  = [j.strip() for j in (row["journal_name"] or "").split(",")]

            keyword_is_new = item.keyword.strip() and item.keyword.strip() not in existing_keywords
            journal_is_new = item.journal_name.strip() and item.journal_name.strip() not in existing_journals

            results[email] = {
                "exists":               True,
                "record_id":            row["id"],
                "mail_count_month":     count_month,
                "blocked":              count_month >= MONTHLY_MAIL_LIMIT,
                "same_journal_keyword": not keyword_is_new and not journal_is_new,
                "existing_keywords":    row["keyword"] or "",
                "existing_journals":    row["journal_name"] or "",
            }

        return {"results": results}
    finally:
        conn.close()


# ── Patch Status (uploader or admin) ──────────────────────────────────────────

@router.patch("/{record_id:int}/status")
def patch_status(
    record_id: int,
    body: ScrapingStatusPatch,
    user: dict = Depends(require_approved),
):
    if body.email_status not in STATUS_VALUES:
        raise HTTPException(status_code=400, detail=f"Invalid status. Allowed: {STATUS_VALUES}")

    user_id  = int(user["sub"])
    is_admin = user.get("role") == "admin"
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM data_scraping WHERE id=?", (record_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Record not found.")
        if not is_admin and row["uploaded_by"] != user_id:
            raise HTTPException(status_code=403, detail="You can only update your own records.")

        now = datetime.now(timezone.utc).isoformat()

        # When marking as 'Used', append current timestamp to used_at_history
        # so monthly mail-count tracking stays accurate.
        extra_fields = ""
        extra_params: list = []
        if body.email_status == "Used":
            existing_history_raw = row["used_at_history"] if row["used_at_history"] else "[]"
            try:
                history: list = json.loads(existing_history_raw)
                if not isinstance(history, list):
                    history = []
            except Exception:
                history = []
            history.append(now)
            new_history = json.dumps(history)
            extra_fields = ", used_at=?, used_at_history=?"
            extra_params = [now, new_history]

        conn.execute(
            f"UPDATE data_scraping SET email_status=?, updated_at=?{extra_fields} WHERE id=?",
            [body.email_status, now] + extra_params + [record_id],
        )
        conn.commit()
        _log(conn, user_id, "PATCH_SCRAPING_STATUS", f"scraping:{record_id}", body.email_status)
        conn.commit()

        # Compute updated monthly count to return to caller
        updated_row = conn.execute("SELECT used_at_history FROM data_scraping WHERE id=?", (record_id,)).fetchone()
        mail_count = _mail_count_this_month(updated_row["used_at_history"] if updated_row else None)

        return {
            "id": record_id,
            "email_status": body.email_status,
            "mail_count_month": mail_count,
        }
    finally:
        conn.close()


# ── Full Update (admin only) ───────────────────────────────────────────────────

@router.put("/{record_id:int}")
def update_scraping(
    record_id: int,
    body: ScrapingUpdate,
    user: dict = Depends(require_admin),
):
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM data_scraping WHERE id=?", (record_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Record not found.")

        fields = {}
        for field in [
            "date", "website", "keyword", "article_title", "author_name",
            "journal_name", "affiliation", "email_status",
            "brand", "country",
        ]:
            val = getattr(body, field)
            if val is not None:
                fields[field] = val
        if body.email is not None:
            dup = conn.execute(
                "SELECT id FROM data_scraping WHERE email=? AND id!=?", (body.email, record_id)
            ).fetchone()
            if dup:
                raise HTTPException(status_code=409, detail=f"Email already exists (Record ID: {dup['id']}).")
            fields["email"] = body.email

        if not fields:
            raise HTTPException(status_code=400, detail="No fields provided to update.")

        fields["updated_at"] = datetime.now(timezone.utc).isoformat()
        set_clause = ", ".join(f"{k}=?" for k in fields)
        conn.execute(f"UPDATE data_scraping SET {set_clause} WHERE id=?",
                     list(fields.values()) + [record_id])
        conn.commit()
        _log(conn, int(user["sub"]), "UPDATE_SCRAPING", f"scraping:{record_id}")
        conn.commit()

        updated = conn.execute(
            """SELECT ds.*, u.username AS uploaded_by_username,
                      su.username AS support_for_username
               FROM data_scraping ds
               LEFT JOIN users u  ON ds.uploaded_by = u.id
               LEFT JOIN users su ON ds.support_for  = su.id
               WHERE ds.id=?""",
            (record_id,)
        ).fetchone()
        return _row_to_dict(updated)
    finally:
        conn.close()


# ── Delete (admin only) ────────────────────────────────────────────────────────

@router.delete("/{record_id:int}", status_code=204)
def delete_scraping(record_id: int, user: dict = Depends(require_admin)):
    conn = get_db()
    try:
        row = conn.execute("SELECT id FROM data_scraping WHERE id=?", (record_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Record not found.")
        conn.execute("DELETE FROM data_scraping WHERE id=?", (record_id,))
        conn.commit()
        _log(conn, int(user["sub"]), "DELETE_SCRAPING", f"scraping:{record_id}")
        conn.commit()
    finally:
        conn.close()

# ── Allowed Websites ────────────────────────────────────────────────────────

class WebsiteAdd(BaseModel):
    name: str

@router.get("/allowed_websites")
def get_allowed_websites(user: dict = Depends(get_current_user)):
    conn = get_db()
    try:
        rows = conn.execute("SELECT name FROM allowed_websites ORDER BY created_at ASC").fetchall()
        return [r["name"] for r in rows]
    finally:
        conn.close()

@router.post("/allowed_websites", status_code=201)
def add_allowed_website(body: WebsiteAdd, user: dict = Depends(get_current_user)):
    name = body.name.strip().lower()
    if not name:
        raise HTTPException(status_code=400, detail="Website name cannot be empty.")
    
    conn = get_db()
    try:
        dup = conn.execute("SELECT id FROM allowed_websites WHERE name=?", (name,)).fetchone()
        if dup:
            raise HTTPException(status_code=409, detail="Website already in allowed list.")
        
        conn.execute("INSERT INTO allowed_websites (name) VALUES (?)", (name,))
        conn.commit()
        return {"detail": f"Added '{name}' to allowed websites.", "name": name}
    finally:
        conn.close()
