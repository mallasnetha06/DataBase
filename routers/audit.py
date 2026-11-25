"""
routers/audit.py — Audit log viewer (Admin-only).
"""
from fastapi import APIRouter, Depends, Query
from database import get_db
from dependencies import require_admin

router = APIRouter(prefix="/audit", tags=["audit"])


@router.get("")
def get_audit_log(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    user: dict = Depends(require_admin),
):
    conn = get_db()
    try:
        offset = (page - 1) * page_size
        total = conn.execute("SELECT COUNT(*) FROM audit_log").fetchone()[0]
        rows = conn.execute(
            """
            SELECT al.id, al.action, al.target, al.detail, al.created_at,
                   u.username
            FROM audit_log al
            LEFT JOIN users u ON u.id = al.user_id
            ORDER BY al.created_at DESC
            LIMIT ? OFFSET ?
            """,
            (page_size, offset),
        ).fetchall()

        return {
            "total": total,
            "page": page,
            "page_size": page_size,
            "data": [
                {
                    "id": r["id"],
                    "username": r["username"],
                    "action": r["action"],
                    "target": r["target"],
                    "detail": r["detail"],
                    "created_at": r["created_at"],
                }
                for r in rows
            ],
        }
    finally:
        conn.close()
