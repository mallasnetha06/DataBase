"""
routers/manager.py — Manager analytics dashboard API.
Accessible by: manager, overlord.

Endpoints:
  GET /manager/dashboard       — KPI summary cards
  GET /manager/revenue/daily   — daily revenue last 30 days
  GET /manager/revenue/weekly  — weekly revenue last 12 weeks
  GET /manager/revenue/monthly — monthly revenue last 12 months
  GET /manager/revenue/yearly  — yearly revenue all time
  GET /manager/journals/revenue — revenue by journal name
  GET /manager/admins/progress  — per-admin task completion stats
  GET /manager/invoices         — paginated invoice list
  GET /manager/approvals        — paginated journal approval list
  GET /manager/campaign-stats   — email campaign overview
"""
from fastapi import APIRouter, Depends, Query
from database import get_db
from dependencies import require_manager

router = APIRouter(prefix="/manager", tags=["manager"])


# ── Dashboard KPI Summary ─────────────────────────────────────────────────────

@router.get("/dashboard")
def manager_dashboard(user: dict = Depends(require_manager)):
    conn = get_db()
    try:
        # Total revenue (from data_scraping invoices_history)
        total_revenue = conn.execute(
            "SELECT COALESCE(SUM(CAST(json_extract(value, '$.amount') AS REAL)), 0) FROM data_scraping, json_each(invoices_history)"
        ).fetchone()[0]

        # Revenue this month
        revenue_this_month = conn.execute(
            """SELECT COALESCE(SUM(CAST(json_extract(value, '$.amount') AS REAL)), 0) FROM data_scraping, json_each(invoices_history)
               WHERE json_extract(value, '$.invoice_date') >= date('now','start of month')"""
        ).fetchone()[0]

        # Total invoices (rows with an invoice_date set)
        total_invoices = conn.execute(
            "SELECT COUNT(*) FROM data_scraping, json_each(invoices_history) WHERE json_extract(value, '$.invoice_date') IS NOT NULL AND json_extract(value, '$.invoice_date') != ''"
        ).fetchone()[0]
        pending_invoices = conn.execute(
            "SELECT COUNT(*) FROM data_scraping, json_each(invoices_history) WHERE json_extract(value, '$.invoice_status')='Pending'"
        ).fetchone()[0]
        approved_invoices = conn.execute(
            "SELECT COUNT(*) FROM data_scraping, json_each(invoices_history) WHERE json_extract(value, '$.invoice_status') IN ('Approved','Paid')"
        ).fetchone()[0]

        # Journal approvals (rows with journal_approved=1)
        approvals_this_month = conn.execute(
            """SELECT COUNT(*) FROM data_scraping, json_each(invoices_history)
               WHERE json_extract(value, '$.journal_approved')=1
               AND json_extract(value, '$.approval_date') >= date('now','start of month')"""
        ).fetchone()[0]
        total_approvals = conn.execute(
            "SELECT COUNT(*) FROM data_scraping, json_each(invoices_history) WHERE json_extract(value, '$.journal_approved')=1"
        ).fetchone()[0]

        # Campaign stats (email outreach)
        total_emails = conn.execute("SELECT COUNT(*) FROM data_scraping").fetchone()[0]
        used_emails = conn.execute(
            "SELECT COUNT(*) FROM data_scraping WHERE email_status='Used'"
        ).fetchone()[0]
        reach_rate = round((used_emails / total_emails * 100), 1) if total_emails else 0

        # Team counts
        admin_count = conn.execute(
            "SELECT COUNT(*) FROM users WHERE role='admin' AND is_approved=1"
        ).fetchone()[0]
        total_users = conn.execute(
            "SELECT COUNT(*) FROM users WHERE is_approved=1"
        ).fetchone()[0]

        # Task completion across all users
        total_tasks = conn.execute(
            """
            SELECT COUNT(*) FROM kanban_cards kc
            INNER JOIN kanban_sheets ks ON ks.id = kc.sheet_id AND ks.is_template = 0
            """
        ).fetchone()[0]

        completed_tasks = conn.execute(
            """
            SELECT COUNT(*) FROM kanban_cards kc
            INNER JOIN kanban_sheets ks ON ks.id = kc.sheet_id AND ks.is_template = 0
            WHERE kc.status = 'done'
            """
        ).fetchone()[0]

        task_completion_rate = round(
            (completed_tasks / total_tasks * 100), 1
        ) if total_tasks else 0

        # Top brand by revenue
        top_journal = conn.execute(
            """SELECT json_extract(value, '$.journal_name') AS journal_name, SUM(CAST(json_extract(value, '$.amount') AS REAL)) as rev
               FROM data_scraping ds, json_each(ds.invoices_history)
               WHERE json_extract(value, '$.journal_name') IS NOT NULL
                 AND json_extract(value, '$.journal_name') != ''
               GROUP BY json_extract(value, '$.journal_name') ORDER BY rev DESC LIMIT 1"""
        ).fetchone()

        return {
            "total_revenue": round(total_revenue, 2),
            "revenue_this_month": round(revenue_this_month, 2),
            "total_invoices": total_invoices,
            "pending_invoices": pending_invoices,
            "approved_invoices": approved_invoices,
            "total_approvals": total_approvals,
            "approvals_this_month": approvals_this_month,
            "total_emails": total_emails,
            "used_emails": used_emails,
            "reach_rate": reach_rate,
            "admin_count": admin_count,
            "total_users": total_users,
            "total_tasks": total_tasks,
            "completed_tasks": completed_tasks,
            "task_completion_rate": task_completion_rate,
            "top_journal": dict(top_journal) if top_journal else None,
        }
    finally:
        conn.close()


# ── Revenue — Daily (last 30 days) ────────────────────────────────────────────

@router.get("/revenue/daily")
def revenue_daily(user: dict = Depends(require_manager)):
    conn = get_db()
    try:
        rows = conn.execute(
            """SELECT json_extract(value, '$.invoice_date') as date,
                      COALESCE(SUM(CAST(json_extract(value, '$.amount') AS REAL)), 0) as revenue,
                      COUNT(*) as invoices
               FROM data_scraping, json_each(invoices_history)
               WHERE json_extract(value, '$.invoice_date') >= date('now', '-30 days')
               GROUP BY date
               ORDER BY date ASC"""
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# ── Revenue — Weekly (last 12 weeks) ─────────────────────────────────────────

@router.get("/revenue/weekly")
def revenue_weekly(user: dict = Depends(require_manager)):
    conn = get_db()
    try:
        rows = conn.execute(
            """SELECT strftime('%Y-W%W', json_extract(value, '$.invoice_date')) as week,
                      MIN(json_extract(value, '$.invoice_date')) as start_date,
                      COALESCE(SUM(CAST(json_extract(value, '$.amount') AS REAL)), 0) as revenue,
                      COUNT(*) as invoices
               FROM data_scraping, json_each(invoices_history)
               WHERE json_extract(value, '$.invoice_date') >= date('now', '-84 days')
               GROUP BY week
               ORDER BY week ASC"""
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# ── Revenue — Monthly (last 12 months) ───────────────────────────────────────

@router.get("/revenue/monthly")
def revenue_monthly(user: dict = Depends(require_manager)):
    conn = get_db()
    try:
        rows = conn.execute(
            """SELECT strftime('%Y-%m', json_extract(value, '$.invoice_date')) as month,
                      COALESCE(SUM(CAST(json_extract(value, '$.amount') AS REAL)), 0) as revenue,
                      COUNT(*) as invoices
               FROM data_scraping, json_each(invoices_history)
               WHERE json_extract(value, '$.invoice_date') >= date('now', '-365 days')
               GROUP BY month
               ORDER BY month ASC"""
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# ── Revenue — Yearly ──────────────────────────────────────────────────────────

@router.get("/revenue/yearly")
def revenue_yearly(user: dict = Depends(require_manager)):
    conn = get_db()
    try:
        rows = conn.execute(
            """SELECT strftime('%Y', json_extract(value, '$.invoice_date')) as year,
                      COALESCE(SUM(CAST(json_extract(value, '$.amount') AS REAL)), 0) as revenue,
                      COUNT(*) as invoices
               FROM data_scraping, json_each(invoices_history)
               WHERE json_extract(value, '$.invoice_date') IS NOT NULL AND json_extract(value, '$.invoice_date') != ''
               GROUP BY year
               ORDER BY year ASC"""
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# ── Revenue by Brand ────────────────────────────────────────────────────────

@router.get("/journals/revenue")
def journals_revenue(
    limit: int = Query(8, ge=1, le=50),
    user: dict = Depends(require_manager),
):
    """Revenue grouped by brand (calculated from data_scraping.amount)."""
    manager_id = int(user["sub"])
    conn = get_db()
    try:
        rows = conn.execute(
            """SELECT json_extract(value, '$.brand') AS brand_name,
                      COALESCE(SUM(CAST(json_extract(value, '$.amount') AS REAL)), 0) as total_revenue,
                      COUNT(*) as approvals
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
            (manager_id, manager_id, limit),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()

# ── Admin Performance ─────────────────────────────────────────────────────────

@router.get("/admins/progress")
def admins_progress(user: dict = Depends(require_manager)):
    """
    All team members by task completion rate.
    """
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
            GROUP BY u.id, u.username
            ORDER BY completed DESC, total DESC
            """
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


# ── Invoice List ──────────────────────────────────────────────────────────────

@router.get("/invoices")
def list_invoices(
    status: str = Query("All"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    user: dict = Depends(require_manager),
):
    """List data_scraping rows that have an invoice (invoice_date IS NOT NULL)."""
    conn = get_db()
    try:
        where_parts = ["json_extract(value, '$.invoice_date') IS NOT NULL AND json_extract(value, '$.invoice_date') != ''"]
        params = []
        if status != "All":
            where_parts.append("json_extract(value, '$.invoice_status') = ?")
            params.append(status)

        where = "WHERE " + " AND ".join(where_parts)

        rows = conn.execute(
            f"""SELECT ds.id, ds.author_name as client_name, json_extract(value, '$.journal_name') as journal_name,
                    CAST(json_extract(value, '$.amount') AS REAL) as amount, 
                    json_extract(value, '$.invoice_status') as status, 
                    json_extract(value, '$.invoice_date') as invoice_date,
                    ds.created_at, u.username as approver_name
                FROM data_scraping ds, json_each(ds.invoices_history)
                LEFT JOIN users u ON ds.uploaded_by = u.id
                {where}
                ORDER BY invoice_date DESC
                LIMIT ? OFFSET ?""",
            params + [limit, offset],
        ).fetchall()
        total = conn.execute(
            f"SELECT COUNT(*) FROM data_scraping ds, json_each(ds.invoices_history) {where}", params
        ).fetchone()[0]

        return {
            "total": total,
            "items": [dict(r) for r in rows],
        }
    finally:
        conn.close()


# ── Journal Approvals List ────────────────────────────────────────────────────

@router.get("/approvals")
def list_approvals(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    user: dict = Depends(require_manager),
):
    """List data_scraping rows where journal_approved=1."""
    conn = get_db()
    try:
        rows = conn.execute(
            """SELECT ds.id, json_extract(value, '$.journal_name') as journal_name, ds.author_name as client_name,
                      json_extract(value, '$.approval_date') as approval_date, 
                      json_extract(value, '$.journal_approved') as journal_approved,
                      COALESCE(CAST(json_extract(value, '$.amount') AS REAL), 0) as revenue, ds.created_at,
                      u.username as approver_name
               FROM data_scraping ds, json_each(ds.invoices_history)
               LEFT JOIN users u ON ds.uploaded_by = u.id
               WHERE json_extract(value, '$.journal_approved') = 1
               ORDER BY approval_date DESC
               LIMIT ? OFFSET ?""",
            (limit, offset),
        ).fetchall()
        total = conn.execute(
            "SELECT COUNT(*) FROM data_scraping ds, json_each(ds.invoices_history) WHERE json_extract(value, '$.journal_approved')=1"
        ).fetchone()[0]
        return {"total": total, "items": [dict(r) for r in rows]}
    finally:
        conn.close()


# ── Campaign Stats (email outreach) ──────────────────────────────────────────

@router.get("/campaign-stats")
def campaign_stats(user: dict = Depends(require_manager)):
    conn = get_db()
    try:
        # Outreach by journal
        by_journal = conn.execute(
            """SELECT brand as journal_name,
                      COUNT(*) as total,
                      SUM(CASE WHEN email_status='Used' THEN 1 ELSE 0 END) as used,
                      SUM(CASE WHEN email_status='Unused' THEN 1 ELSE 0 END) as unused
               FROM data_scraping
               WHERE brand IS NOT NULL
               GROUP BY brand
               ORDER BY total DESC
               LIMIT 10"""
        ).fetchall()

        # Outreach by admin (who uploaded records)
        by_admin = conn.execute(
            """SELECT u.username,
                      COUNT(*) as total,
                      SUM(CASE WHEN ds.email_status='Used' THEN 1 ELSE 0 END) as used
               FROM data_scraping ds
               JOIN users u ON ds.uploaded_by = u.id
               GROUP BY ds.uploaded_by
               ORDER BY total DESC"""
        ).fetchall()

        # Daily outreach last 30 days
        daily_used = conn.execute(
            """SELECT date(used_at) as day, COUNT(*) as used
               FROM data_scraping
               WHERE email_status='Used' AND used_at IS NOT NULL
               AND used_at >= date('now', '-30 days')
               GROUP BY day
               ORDER BY day ASC"""
        ).fetchall()

        return {
            "by_journal": [dict(r) for r in by_journal],
            "by_admin": [dict(r) for r in by_admin],
            "daily_used": [dict(r) for r in daily_used],
        }
    finally:
        conn.close()
