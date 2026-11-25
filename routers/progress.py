"""
routers/progress.py — Kanban progress tracking.

Sourcing data from kanban_sheets + kanban_cards.
Standard users see/manage only their own boards.
Admins see everything + chart data.
"""
import csv
import io
import json
from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from database import get_db
from models import ScrapingInvoicePatch, ScrapingApprovalPatch, ScrapingBrandPatch
from dependencies import require_approved, require_admin

router = APIRouter(prefix="/progress", tags=["progress"])

def _log(conn, user_id: int, action: str, target: str = None, detail: str = None):
    conn.execute(
        "INSERT INTO audit_log (user_id, action, target, detail) VALUES (?, ?, ?, ?)",
        (user_id, action, target, detail),
    )



# ── Admin Chart Stats (Kanban-based) ──────────────────────────────────────────
#
# Sources data from kanban_sheets + kanban_cards.
# Only cards belonging to the calling admin's
# own team members are included (users.team_lead_id = admin_id, plus
# cards owned by the admin themselves).
#
# Status mapping (kanban → chart labels):
#   done        → completed  / "Completed"
#   inprogress  → in_progress / "In Progress"
#   todo|blocked → not_started / "Not Started"
#
# "by_date" groups by DATE(kc.updated_at) within the requested `days` window.
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/stats")
def progress_stats(
    days: int = Query(30, ge=1, le=365),
    user: dict = Depends(require_admin),
):
    from collections import defaultdict

    admin_id = int(user["sub"])
    conn = get_db()
    try:
        # ── Fetch kanban cards for the admin's team within the date window ──────
        #   Team = admin themselves  OR  standard users whose team_lead_id = admin_id
        cards = conn.execute(
            """
            WITH all_cards AS (
                SELECT
                    status,
                    updated_at AS event_time,
                    user_id,
                    sheet_id
                FROM kanban_cards

                UNION ALL

                SELECT
                    final_status AS status,
                    reset_at AS event_time,
                    user_id,
                    sheet_id
                FROM kanban_card_history
            )
            SELECT
                ac.status,
                DATE(ac.event_time) AS card_date,
                ac.user_id,
                u.username
            FROM all_cards ac
            INNER JOIN kanban_sheets ks ON ks.id = ac.sheet_id AND ks.is_template = 0
            LEFT JOIN  users u          ON u.id  = ac.user_id
            WHERE ac.user_id IN (
                SELECT id FROM users
                WHERE is_approved = 1
                  AND (
                      id = ?
                      OR (role = 'standard' AND team_lead_id = ?)
                  )
            )
              AND DATE(ac.event_time) >= DATE('now', ?)
            ORDER BY DATE(ac.event_time) ASC
            """,
            (admin_id, admin_id, f"-{days} days"),
        ).fetchall()

        # ── Status normalisation helper ─────────────────────────────────────────
        def _norm(raw_status: str):
            """Map kanban status → chart bucket."""
            s = (raw_status or "").lower()
            if s == "done":
                return "completed", "Completed"
            if s == "inprogress":
                return "in_progress", "In Progress"
            return "not_started", "Not Started"   # todo | blocked | anything else

        # ── Accumulators ────────────────────────────────────────────────────────
        date_buckets  = defaultdict(lambda: {"completed": 0, "in_progress": 0, "not_started": 0})
        user_buckets  = defaultdict(lambda: {"username": None, "total": 0, "completed": 0})
        status_tally  = {"Completed": 0, "In Progress": 0, "Not Started": 0}

        for c in cards:
            bucket_key, tally_key = _norm(c["status"])
            card_date = c["card_date"] or "unknown"
            uid       = c["user_id"]

            date_buckets[card_date][bucket_key] += 1
            status_tally[tally_key] += 1

            user_buckets[uid]["username"] = c["username"] or "Unknown"
            user_buckets[uid]["total"]   += 1
            if bucket_key == "completed":
                user_buckets[uid]["completed"] += 1

        # ── Build response lists ─────────────────────────────────────────────────
        by_date_list = [
            {
                "date":        d,
                "completed":   v["completed"],
                "in_progress": v["in_progress"],
                "not_started": v["not_started"],
            }
            for d, v in sorted(date_buckets.items())
        ]

        per_user_list = sorted(
            [
                {
                    "username":  v["username"],
                    "total":     v["total"],
                    "completed": v["completed"],
                }
                for v in user_buckets.values()
            ],
            key=lambda x: x["total"],
            reverse=True,
        )[:10]

        status_counts_list = [
            {"task_status": k, "count": v}
            for k, v in status_tally.items()
            if v > 0
        ]

        return {
            "by_date":       by_date_list,
            "per_user":      per_user_list,
            "status_counts": status_counts_list,
        }
    finally:
        conn.close()


# ── Scraping Email Search (for Employee Progress action blocks) ───────────────

@router.get("/scraping-search")
def scraping_email_search(
    email: str = Query(..., min_length=1),
    user: dict  = Depends(require_approved),
):
    """
    Search data_scraping by partial email match.
    Returns up to 10 matching rows for the user to select from.
    """
    conn = get_db()
    try:
        rows = conn.execute(
            """SELECT id, author_name, email, journal_name, brand, country
               FROM data_scraping
               WHERE email LIKE ?
               ORDER BY created_at DESC
               LIMIT 10""",
            (f"%{email}%",),
        ).fetchall()
        return [{"id": r["id"], "author_name": r["author_name"], "email": r["email"],
                 "journal_name": r["journal_name"], "brand": r["brand"], "country": r["country"]}
                for r in rows]
    finally:
        conn.close()


# ── Brand PATCH — update brand column on a data_scraping row ────────────────

@router.patch("/scraping/{scraping_id}/brand", status_code=200)
def patch_scraping_brand(
    scraping_id: int,
    body: ScrapingBrandPatch,
    user: dict = Depends(require_approved),
):
    """
    Any approved user: set or update the brand field on a data_scraping row.
    Called from the Brand Approval block when the selected record has no brand.
    """
    brand = body.brand.strip()
    if not brand:
        raise HTTPException(status_code=400, detail="Brand must not be empty.")

    conn = get_db()
    try:
        row = conn.execute(
            "SELECT id, author_name FROM data_scraping WHERE id=?",
            (scraping_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Scraping record not found.")

        now_ts = datetime.now(timezone.utc).isoformat()
        conn.execute(
            "UPDATE data_scraping SET brand=?, updated_at=? WHERE id=?",
            (brand, now_ts, scraping_id),
        )
        conn.commit()
        _log(
            conn, int(user["sub"]), "PATCH_BRAND",
            f"scraping:{scraping_id}",
            f"brand set to '{brand}'",
        )
        conn.commit()
        return {"id": scraping_id, "author_name": row["author_name"], "brand": brand}
    finally:
        conn.close()


# ── History GET — return full invoices_history for a row ────────────────────

@router.get("/scraping/{scraping_id}/history", status_code=200)
def get_scraping_history(
    scraping_id: int,
    user: dict = Depends(require_approved),
):
    """
    Any approved user: return the full invoices_history JSON array for a data_scraping
    row so the UI can display existing entries before the user acts.
    """
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT id, author_name, journal_name, brand, invoices_history FROM data_scraping WHERE id=?",
            (scraping_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Scraping record not found.")
        try:
            history: list = json.loads(row["invoices_history"] or "[]")
            if not isinstance(history, list):
                history = []
        except Exception:
            history = []
        return {
            "id"           : scraping_id,
            "author_name"  : row["author_name"],
            "brand"        : row["brand"],
            "journal_name" : row["journal_name"],
            "history"      : history,
        }
    finally:
        conn.close()


# ── Invoice PATCH — append a new entry to invoices_history ───────────────────

@router.patch("/scraping/{scraping_id}/invoice", status_code=200)
def patch_scraping_invoice(
    scraping_id: int,
    body: ScrapingInvoicePatch,
    user: dict = Depends(require_approved),
):
    """
    Any approved user: update or append an invoice entry in invoices_history.

    - If body.invoice_no is set → update that specific entry in-place.
    - If body.invoice_no is None → append a brand-new entry (original behaviour).
    """
    valid_statuses = ("Pending", "Approved", "Paid", "Rejected")
    if body.invoice_status is not None and body.invoice_status not in valid_statuses:
        raise HTTPException(status_code=400, detail=f"Invalid invoice_status. Allowed: {valid_statuses}")

    if body.invoice_no is None and body.amount is None and body.invoice_status is None and body.invoice_date is None:
        raise HTTPException(status_code=400, detail="No invoice fields provided.")

    conn = get_db()
    try:
        row = conn.execute(
            "SELECT id, author_name, journal_name, brand, invoices_history FROM data_scraping WHERE id=?",
            (scraping_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Scraping record not found.")

        # ── Load existing history ──────────────────────────────────────────────
        try:
            history: list = json.loads(row["invoices_history"] or "[]")
            if not isinstance(history, list):
                history = []
        except Exception:
            history = []

        # ── Determine mode: in-place update vs. append new ────────────────────
        if body.invoice_no is not None:
            target_idx = next(
                (i for i, e in enumerate(history) if e.get("invoice_no") == body.invoice_no),
                None,
            )
            if target_idx is None:
                raise HTTPException(
                    status_code=404,
                    detail=f"Invoice #{body.invoice_no} not found in history for record {scraping_id}.",
                )
            entry = history[target_idx]
            if body.amount is not None:
                entry["amount"] = body.amount
            if body.invoice_status is not None:
                entry["invoice_status"] = body.invoice_status
            if body.invoice_date is not None:
                entry["invoice_date"] = body.invoice_date
            result_entry = entry
            log_action = "UPDATE_INVOICE"
        else:
            result_entry = {
                "invoice_no"     : len(history) + 1,
                "journal_name"   : row["journal_name"] or "",
                "brand"          : row["brand"],
                "amount"         : body.amount if body.amount is not None else 0.0,
                "invoice_status" : body.invoice_status if body.invoice_status is not None else "Pending",
                "invoice_date"   : body.invoice_date if body.invoice_date is not None else "",
                "journal_approved": 0,
                "approval_date"  : None,
            }
            history.append(result_entry)
            log_action = "PATCH_INVOICE"

        now_ts = datetime.now(timezone.utc).isoformat()
        conn.execute(
            "UPDATE data_scraping SET invoices_history=?, updated_at=? WHERE id=?",
            (json.dumps(history), now_ts, scraping_id),
        )
        conn.commit()
        _log(
            conn, int(user["sub"]), log_action,
            f"scraping:{scraping_id}",
            f"invoice_no={result_entry['invoice_no']} amount={result_entry['amount']} "
            f"status={result_entry['invoice_status']} date={result_entry['invoice_date']}",
        )
        conn.commit()

        return {
            "id"                  : scraping_id,
            "author_name"         : row["author_name"],
            "brand"               : row["brand"],
            "invoice_no"          : result_entry["invoice_no"],
            "amount"              : result_entry["amount"],
            "invoice_status"      : result_entry["invoice_status"],
            "invoice_date"        : result_entry["invoice_date"],
            "total_invoices"      : len(history),
        }
    finally:
        conn.close()



# ── Approval PATCH — update the last un-approved entry in invoices_history ────

@router.patch("/scraping/{scraping_id}/approval", status_code=200)
def patch_scraping_approval(
    scraping_id: int,
    body: ScrapingApprovalPatch,
    user: dict = Depends(require_approved),
):
    """
    Any approved user: mark the most-recent un-approved invoice entry in
    invoices_history as approved (journal_approved=1) and record the
    approval_date.  If no un-approved entry exists, a new approval-only
    entry is appended so the event is never lost.
    """
    if body.journal_approved is not None and body.journal_approved not in (0, 1):
        raise HTTPException(status_code=400, detail="journal_approved must be 0 or 1.")

    if body.journal_approved is None and body.approval_date is None:
        raise HTTPException(status_code=400, detail="No approval fields provided.")

    conn = get_db()
    try:
        row = conn.execute(
            "SELECT id, author_name, journal_name, brand, invoices_history FROM data_scraping WHERE id=?",
            (scraping_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Scraping record not found.")

        try:
            history: list = json.loads(row["invoices_history"] or "[]")
            if not isinstance(history, list):
                history = []
        except Exception:
            history = []

        target_idx = None
        for i in range(len(history) - 1, -1, -1):
            if not history[i].get("journal_approved", 0):
                target_idx = i
                break

        if target_idx is not None:
            if body.journal_approved is not None:
                history[target_idx]["journal_approved"] = body.journal_approved
            if body.approval_date is not None:
                history[target_idx]["approval_date"] = body.approval_date
            updated_entry = history[target_idx]
        else:
            updated_entry = {
                "invoice_no"     : len(history) + 1,
                "journal_name"   : row["journal_name"] or "",
                "brand"          : row["brand"],
                "amount"         : 0.0,
                "invoice_status" : "Pending",
                "invoice_date"   : None,
                "journal_approved": body.journal_approved if body.journal_approved is not None else 1,
                "approval_date"  : body.approval_date,
            }
            history.append(updated_entry)

        now_ts = datetime.now(timezone.utc).isoformat()
        conn.execute(
            "UPDATE data_scraping SET invoices_history=?, updated_at=? WHERE id=?",
            (json.dumps(history), now_ts, scraping_id),
        )
        conn.commit()
        _log(
            conn, int(user["sub"]), "PATCH_APPROVAL",
            f"scraping:{scraping_id}",
            f"invoice_no={updated_entry['invoice_no']} "
            f"journal_approved={updated_entry['journal_approved']} "
            f"approval_date={updated_entry['approval_date']}",
        )
        conn.commit()

        return {
            "id"              : scraping_id,
            "author_name"     : row["author_name"],
            "brand"           : row["brand"],
            "invoice_no"      : updated_entry["invoice_no"],
            "journal_approved": updated_entry["journal_approved"],
            "approval_date"   : updated_entry["approval_date"],
            "total_invoices"  : len(history),
        }
    finally:
        conn.close()


# ════════════════════════════════════════════════════════════════════════════════
# ADMIN ANALYTICS — KPI charts for the Progress Dashboard
# These mirror the manager dashboard charts but are accessible to all admins.
# ════════════════════════════════════════════════════════════════════════════════

@router.get("/analytics/revenue/{period}")
def analytics_revenue(
    period: str,
    user: dict = Depends(require_admin),
):
    """
    Revenue trend for the admin Progress Dashboard.
    period: daily | weekly | monthly | yearly
    """
    conn = get_db()
    try:
        if period == "daily":
            rows = conn.execute(
                """SELECT json_extract(value, '$.invoice_date') as date,
                          COALESCE(SUM(CAST(json_extract(value, '$.amount') AS REAL)), 0) as revenue,
                          COUNT(*) as invoices
                   FROM data_scraping, json_each(invoices_history)
                   WHERE json_extract(value, '$.invoice_date') >= date('now', '-30 days')
                   GROUP BY date ORDER BY date ASC"""
            ).fetchall()
        elif period == "weekly":
            rows = conn.execute(
                """SELECT strftime('%Y-W%W', json_extract(value, '$.invoice_date')) as week,
                          MIN(json_extract(value, '$.invoice_date')) as start_date,
                          COALESCE(SUM(CAST(json_extract(value, '$.amount') AS REAL)), 0) as revenue,
                          COUNT(*) as invoices
                   FROM data_scraping, json_each(invoices_history)
                   WHERE json_extract(value, '$.invoice_date') >= date('now', '-84 days')
                   GROUP BY week ORDER BY week ASC"""
            ).fetchall()
        elif period == "monthly":
            rows = conn.execute(
                """SELECT strftime('%Y-%m', json_extract(value, '$.invoice_date')) as month,
                          COALESCE(SUM(CAST(json_extract(value, '$.amount') AS REAL)), 0) as revenue,
                          COUNT(*) as invoices
                   FROM data_scraping, json_each(invoices_history)
                   WHERE json_extract(value, '$.invoice_date') >= date('now', '-365 days')
                   GROUP BY month ORDER BY month ASC"""
            ).fetchall()
        else:  # yearly
            rows = conn.execute(
                """SELECT strftime('%Y', json_extract(value, '$.invoice_date')) as year,
                          COALESCE(SUM(CAST(json_extract(value, '$.amount') AS REAL)), 0) as revenue,
                          COUNT(*) as invoices
                   FROM data_scraping, json_each(invoices_history)
                   WHERE json_extract(value, '$.invoice_date') IS NOT NULL
                     AND json_extract(value, '$.invoice_date') != ''
                   GROUP BY year ORDER BY year ASC"""
            ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.get("/analytics/invoice-summary")
def analytics_invoice_summary(
    days: int = Query(30, ge=1, le=365),
    user: dict = Depends(require_admin),
):
    """Invoice counts by status for the admin donut chart, filtered by the given day window."""
    date_filter = f"-{days} days"
    conn = get_db()
    try:
        total = conn.execute(
            "SELECT COUNT(*) FROM data_scraping, json_each(invoices_history) "
            "WHERE json_extract(value, '$.invoice_date') IS NOT NULL "
            "  AND json_extract(value, '$.invoice_date') != '' "
            "  AND json_extract(value, '$.invoice_date') >= date('now', ?)",
            (date_filter,),
        ).fetchone()[0]
        pending = conn.execute(
            "SELECT COUNT(*) FROM data_scraping, json_each(invoices_history) "
            "WHERE json_extract(value, '$.invoice_status')='Pending' "
            "  AND json_extract(value, '$.invoice_date') >= date('now', ?)",
            (date_filter,),
        ).fetchone()[0]
        approved = conn.execute(
            "SELECT COUNT(*) FROM data_scraping, json_each(invoices_history) "
            "WHERE json_extract(value, '$.invoice_status') IN ('Approved','Paid') "
            "  AND json_extract(value, '$.invoice_date') >= date('now', ?)",
            (date_filter,),
        ).fetchone()[0]
        return {
            "total_invoices":    total,
            "pending_invoices":  pending,
            "approved_invoices": approved,
        }
    finally:
        conn.close()


@router.get("/analytics/journals-revenue")
def analytics_journals_revenue(
    limit: int = Query(8, ge=1, le=50),
    user: dict  = Depends(require_admin),
):
    """Top brands by revenue for the admin bar chart.
    Groups by the brand stored inside each invoices_history entry.
    """
    admin_id = int(user["sub"])
    conn = get_db()
    try:
        rows = conn.execute(
            """SELECT json_extract(value, '$.brand') AS brand_name,
                      COALESCE(SUM(CAST(json_extract(value, '$.amount') AS REAL)), 0) AS total_revenue,
                      COUNT(*) AS approvals
               FROM data_scraping ds, json_each(ds.invoices_history)
               WHERE json_extract(value, '$.brand') IS NOT NULL
                 AND json_extract(value, '$.brand') != ''
                 AND ds.uploaded_by IN (
                     SELECT id FROM users
                     WHERE is_approved = 1
                       AND (id = ? OR (role = 'standard' AND team_lead_id = ?))
                 )
               GROUP BY json_extract(value, '$.brand')
               ORDER BY total_revenue DESC
               LIMIT ?""",
            (admin_id, admin_id, limit),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.get("/analytics/recent-invoices")
def analytics_recent_invoices(
    limit:  int = Query(15, ge=1, le=100),
    offset: int = Query(0, ge=0),
    status: str = Query("All"),
    user: dict  = Depends(require_admin),
):
    """
    Most recent invoice records for the admin Progress Dashboard table.
    Admin-accessible mirror of /manager/invoices (which requires manager role).
    Returns invoices from data_scraping.invoices_history, newest first.
    """
    conn = get_db()
    try:
        where_parts = [
            "json_extract(value, '$.invoice_date') IS NOT NULL",
            "json_extract(value, '$.invoice_date') != ''"
        ]
        params: list = []
        if status != "All":
            where_parts.append("json_extract(value, '$.invoice_status') = ?")
            params.append(status)

        where = "WHERE " + " AND ".join(where_parts)

        rows = conn.execute(
            f"""SELECT
                    ds.id,
                    ds.author_name                              AS client_name,
                    json_extract(value, '$.journal_name')       AS journal_name,
                    CAST(json_extract(value, '$.amount') AS REAL) AS amount,
                    json_extract(value, '$.invoice_status')    AS status,
                    json_extract(value, '$.invoice_date')      AS invoice_date,
                    ds.created_at,
                    u.username                                  AS approver_name
                FROM data_scraping ds, json_each(ds.invoices_history)
                LEFT JOIN users u ON ds.uploaded_by = u.id
                {where}
                ORDER BY invoice_date DESC
                LIMIT ? OFFSET ?""",
            params + [limit, offset],
        ).fetchall()

        total = conn.execute(
            f"SELECT COUNT(*) FROM data_scraping ds, json_each(ds.invoices_history) {where}",
            params,
        ).fetchone()[0]

        return {
            "total": total,
            "items": [dict(r) for r in rows],
        }
    finally:
        conn.close()


@router.get("/analytics/campaign")
def analytics_campaign(
    days: int = Query(30, ge=1, le=365),
    user: dict = Depends(require_admin),
):
    """Campaign outreach stats for the admin bar/polar charts, filtered by the given day window."""
    admin_id = int(user["sub"])
    date_filter = f"-{days} days"
    conn = get_db()
    try:
        by_journal = conn.execute(
            """SELECT ds.brand as journal_name,
                      COUNT(*) as total,
                      SUM(CASE WHEN ds.email_status='Used' THEN 1 ELSE 0 END) as used,
                      SUM(CASE WHEN ds.email_status='Unused' THEN 1 ELSE 0 END) as unused
               FROM data_scraping ds
               WHERE ds.brand IS NOT NULL
                 AND ds.created_at >= date('now', ?)
                 AND ds.uploaded_by IN (
                     SELECT id FROM users
                     WHERE is_approved = 1
                       AND (id = ? OR (role = 'standard' AND team_lead_id = ?))
                 )
               GROUP BY ds.brand
               ORDER BY total DESC
               LIMIT 10""",
            (date_filter, admin_id, admin_id),
        ).fetchall()
        daily_used = conn.execute(
            """SELECT date(ds.used_at) as day, COUNT(*) as used
               FROM data_scraping ds
               WHERE ds.email_status='Used' AND ds.used_at IS NOT NULL
               AND ds.used_at >= date('now', ?)
               AND ds.uploaded_by IN (
                   SELECT id FROM users
                   WHERE is_approved = 1
                     AND (id = ? OR (role = 'standard' AND team_lead_id = ?))
               )
               GROUP BY day ORDER BY day ASC""",
            (date_filter, admin_id, admin_id),
        ).fetchall()
        return {
            "by_journal":  [dict(r) for r in by_journal],
            "daily_used":  [dict(r) for r in daily_used],
        }
    finally:
        conn.close()


@router.get("/analytics/admin-perf")
def analytics_admin_perf(user: dict = Depends(require_admin)):
    """
    Top 3 standard team members by task completion rate.
    Scoped to the calling admin's team (users.team_lead_id = admin_id).
    Data sourced from live kanban_cards (non-template sheets).
    """
    admin_id = int(user["sub"])
    conn = get_db()
    try:
        rows = conn.execute(
            """
            SELECT
                u.id,
                u.username,
                COUNT(kc.id)                                                AS total,
                SUM(CASE WHEN kc.status = 'done'       THEN 1 ELSE 0 END)  AS completed,
                SUM(CASE WHEN kc.status = 'inprogress' THEN 1 ELSE 0 END)  AS in_progress
            FROM users u
            INNER JOIN kanban_cards kc  ON kc.user_id  = u.id
            INNER JOIN kanban_sheets ks ON ks.id = kc.sheet_id AND ks.is_template = 0
            WHERE u.is_approved = 1
              AND u.role        = 'standard'
              AND u.team_lead_id = ?
            GROUP BY u.id, u.username
            ORDER BY completed DESC, total DESC
            LIMIT 3
            """,
            (admin_id,),
        ).fetchall()

        result = []
        for r in rows:
            total      = r["total"]       or 0
            completed  = r["completed"]   or 0
            in_prog    = r["in_progress"] or 0
            result.append({
                "user_id":         r["id"],
                "username":        r["username"],
                "total":           total,
                "completed":       completed,
                "in_progress":     in_prog,
                "not_started":     max(0, total - completed - in_prog),
                "completion_rate": round((completed / total * 100), 1) if total else 0,
            })
        return result
    finally:
        conn.close()


@router.get("/analytics/kpi-summary")
def analytics_kpi_summary(
    days: int = Query(30, ge=1, le=365),
    user: dict = Depends(require_admin),
):
    """
    Full KPI summary for the admin Progress Dashboard stat cards.
    All time-series metrics are filtered to the requested `days` window.
    Task completion metrics are sourced from kanban_cards (non-template sheets),
    scoped to the calling admin's own team (team_lead_id = admin_id) plus themselves.
    """
    admin_id = int(user["sub"])
    date_filter = f"-{days} days"
    conn = get_db()
    try:
        # Revenue within the selected window
        total_revenue = conn.execute(
            "SELECT COALESCE(SUM(CAST(json_extract(value, '$.amount') AS REAL)), 0) "
            "FROM data_scraping, json_each(invoices_history) "
            "WHERE json_extract(value, '$.invoice_date') >= date('now', ?)",
            (date_filter,),
        ).fetchone()[0]

        # Revenue in the current calendar month (always fixed; unaffected by days filter)
        revenue_this_month = conn.execute(
            "SELECT COALESCE(SUM(CAST(json_extract(value, '$.amount') AS REAL)), 0) "
            "FROM data_scraping, json_each(invoices_history) "
            "WHERE json_extract(value, '$.invoice_date') >= date('now','start of month')"
        ).fetchone()[0]

        total_invoices = conn.execute(
            "SELECT COUNT(*) FROM data_scraping, json_each(invoices_history) "
            "WHERE json_extract(value, '$.invoice_date') IS NOT NULL "
            "  AND json_extract(value, '$.invoice_date') != '' "
            "  AND json_extract(value, '$.invoice_date') >= date('now', ?)",
            (date_filter,),
        ).fetchone()[0]

        pending_invoices = conn.execute(
            "SELECT COUNT(*) FROM data_scraping, json_each(invoices_history) "
            "WHERE json_extract(value, '$.invoice_status')='Pending' "
            "  AND json_extract(value, '$.invoice_date') >= date('now', ?)",
            (date_filter,),
        ).fetchone()[0]

        approved_invoices = conn.execute(
            "SELECT COUNT(*) FROM data_scraping, json_each(invoices_history) "
            "WHERE json_extract(value, '$.invoice_status') IN ('Approved','Paid') "
            "  AND json_extract(value, '$.invoice_date') >= date('now', ?)",
            (date_filter,),
        ).fetchone()[0]

        total_approvals = conn.execute(
            "SELECT COUNT(*) FROM data_scraping, json_each(invoices_history) "
            "WHERE json_extract(value, '$.journal_approved')=1 "
            "  AND json_extract(value, '$.approval_date') >= date('now', ?)",
            (date_filter,),
        ).fetchone()[0]

        approvals_this_month = conn.execute(
            "SELECT COUNT(*) FROM data_scraping, json_each(invoices_history) "
            "WHERE json_extract(value, '$.journal_approved')=1 "
            "AND json_extract(value, '$.approval_date') >= date('now','start of month')"
        ).fetchone()[0]

        # Reach rate filtered to the window
        total_emails = conn.execute(
            "SELECT COUNT(*) FROM data_scraping "
            "WHERE created_at >= date('now', ?)",
            (date_filter,),
        ).fetchone()[0]
        used_emails = conn.execute(
            "SELECT COUNT(*) FROM data_scraping "
            "WHERE email_status='Used' AND created_at >= date('now', ?)",
            (date_filter,),
        ).fetchone()[0]
        reach_rate = round((used_emails / total_emails * 100), 1) if total_emails else 0

        admin_count = conn.execute(
            "SELECT COUNT(*) FROM users WHERE role='admin' AND is_approved=1"
        ).fetchone()[0]
        total_users = conn.execute(
            "SELECT COUNT(*) FROM users WHERE is_approved=1"
        ).fetchone()[0]

        # Task completion — kanban_cards updated within the window, scoped to this admin's team
        total_tasks = conn.execute(
            """
            SELECT COUNT(*) FROM kanban_cards kc
            INNER JOIN kanban_sheets ks ON ks.id = kc.sheet_id AND ks.is_template = 0
            WHERE DATE(kc.updated_at) >= DATE('now', ?)
              AND kc.user_id IN (
                SELECT id FROM users
                WHERE is_approved = 1
                  AND (id = ? OR (role = 'standard' AND team_lead_id = ?))
            )
            """,
            (date_filter, admin_id, admin_id),
        ).fetchone()[0]
        completed_tasks = conn.execute(
            """
            SELECT COUNT(*) FROM kanban_cards kc
            INNER JOIN kanban_sheets ks ON ks.id = kc.sheet_id AND ks.is_template = 0
            WHERE kc.status = 'done'
              AND DATE(kc.updated_at) >= DATE('now', ?)
              AND kc.user_id IN (
                SELECT id FROM users
                WHERE is_approved = 1
                  AND (id = ? OR (role = 'standard' AND team_lead_id = ?))
              )
            """,
            (date_filter, admin_id, admin_id),
        ).fetchone()[0]
        task_completion_rate = round(
            (completed_tasks / total_tasks * 100), 1
        ) if total_tasks else 0

        return {
            "total_revenue":         round(total_revenue, 2),
            "revenue_this_month":    round(revenue_this_month, 2),
            "total_invoices":        total_invoices,
            "pending_invoices":      pending_invoices,
            "approved_invoices":     approved_invoices,
            "total_approvals":       total_approvals,
            "approvals_this_month":  approvals_this_month,
            "total_emails":          total_emails,
            "used_emails":           used_emails,
            "reach_rate":            reach_rate,
            "admin_count":           admin_count,
            "total_users":           total_users,
            "total_tasks":           total_tasks,
            "completed_tasks":       completed_tasks,
            "task_completion_rate":  task_completion_rate,
        }
    finally:
        conn.close()
