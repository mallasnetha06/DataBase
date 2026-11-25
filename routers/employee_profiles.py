"""
routers/employee_profiles.py — Employee skill/responsibility profiles.
Manager can view all profiles and edit any. Users can view their own.

Endpoints:
  GET  /employee-profiles           — all profiles (manager/admin)
  GET  /employee-profiles/me        — my own profile
  GET  /employee-profiles/{user_id} — single profile
  PUT  /employee-profiles/{user_id} — upsert profile (manager only)
"""
import json
from fastapi import APIRouter, Depends, HTTPException
from database import get_db
from models import EmployeeProfileUpdate, EmployeeProfileResponse
from dependencies import require_approved, require_admin, require_manager

router = APIRouter(prefix="/employee-profiles", tags=["employee-profiles"])


def _row_to_dict(row) -> dict:
    return {
        "user_id": row["user_id"],
        "username": row["username"],
        "role": row["role"],
        "title": row["title"] or "",
        "responsibilities": json.loads(row["responsibilities"] or "[]"),
        "skills": json.loads(row["skills"] or "[]"),
        "department": row["department"] or "Operations",
        "updated_at": row["updated_at"],
    }


# ── List All Profiles ─────────────────────────────────────────────────────────

@router.get("")
def list_profiles(user: dict = Depends(require_admin)):
    conn = get_db()
    try:
        rows = conn.execute(
            """SELECT ep.*, u.username, u.role
               FROM employee_profiles ep
               JOIN users u ON ep.user_id = u.id
               WHERE u.is_approved = 1
               ORDER BY u.role, u.username"""
        ).fetchall()
        return [_row_to_dict(r) for r in rows]
    finally:
        conn.close()


# ── My Profile ────────────────────────────────────────────────────────────────

@router.get("/me")
def my_profile(user: dict = Depends(require_approved)):
    me = int(user["sub"])
    conn = get_db()
    try:
        row = conn.execute(
            """SELECT ep.*, u.username, u.role
               FROM employee_profiles ep
               JOIN users u ON ep.user_id = u.id
               WHERE ep.user_id = ?""",
            (me,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Profile not found.")
        return _row_to_dict(row)
    finally:
        conn.close()


# ── Get Single Profile ────────────────────────────────────────────────────────

@router.get("/{user_id}")
def get_profile(user_id: int, user: dict = Depends(require_approved)):
    conn = get_db()
    try:
        row = conn.execute(
            """SELECT ep.*, u.username, u.role
               FROM employee_profiles ep
               JOIN users u ON ep.user_id = u.id
               WHERE ep.user_id = ?""",
            (user_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Profile not found.")
        return _row_to_dict(row)
    finally:
        conn.close()


# ── Upsert Profile (manager only) ─────────────────────────────────────────────

@router.put("/{user_id}")
def upsert_profile(
    user_id: int,
    body: EmployeeProfileUpdate,
    user: dict = Depends(require_manager),
):
    conn = get_db()
    try:
        target = conn.execute(
            "SELECT id FROM users WHERE id = ?", (user_id,)
        ).fetchone()
        if not target:
            raise HTTPException(status_code=404, detail="User not found.")

        existing = conn.execute(
            "SELECT id FROM employee_profiles WHERE user_id = ?", (user_id,)
        ).fetchone()

        if existing:
            # Partial update — only set fields that were provided
            updates = []
            params = []
            if body.title is not None:
                updates.append("title = ?")
                params.append(body.title)
            if body.responsibilities is not None:
                updates.append("responsibilities = ?")
                params.append(json.dumps(body.responsibilities))
            if body.skills is not None:
                updates.append("skills = ?")
                params.append(json.dumps(body.skills))
            if body.department is not None:
                updates.append("department = ?")
                params.append(body.department)
            if updates:
                updates.append("updated_at = datetime('now')")
                params.append(user_id)
                conn.execute(
                    f"UPDATE employee_profiles SET {', '.join(updates)} WHERE user_id = ?",
                    params,
                )
        else:
            conn.execute(
                """INSERT INTO employee_profiles (user_id, title, responsibilities, skills, department)
                   VALUES (?, ?, ?, ?, ?)""",
                (
                    user_id,
                    body.title or "",
                    json.dumps(body.responsibilities or []),
                    json.dumps(body.skills or []),
                    body.department or "Operations",
                ),
            )

        conn.commit()

        row = conn.execute(
            """SELECT ep.*, u.username, u.role
               FROM employee_profiles ep
               JOIN users u ON ep.user_id = u.id
               WHERE ep.user_id = ?""",
            (user_id,),
        ).fetchone()
        return _row_to_dict(row)
    finally:
        conn.close()
