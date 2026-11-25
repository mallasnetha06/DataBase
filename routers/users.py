"""
routers/users.py — User management.
  Admin:    list, approve/reject, create (standard only), delete — scoped to own team.
  Overlord: all of the above + password reset + role promotion/demotion (full access).
"""
import bcrypt
from fastapi import APIRouter, HTTPException, Depends
from database import get_db
from models import UserCreate, ApproveUserRequest, PasswordResetRequest, RoleChangeRequest, RenameRequest
from dependencies import require_admin, require_overlord, require_approved

router = APIRouter(prefix="/users", tags=["users"])

VALID_ROLES = ("standard", "admin", "overlord", "campaigner", "support")


def _user_to_dict(row) -> dict:
    return {
        "id": row["id"],
        "username": row["username"],
        "role": row["role"],
        "is_approved": row["is_approved"],
        "team_lead_id": row["team_lead_id"] if "team_lead_id" in row.keys() else None,
        "created_at": row["created_at"],
    }


def _is_overlord(user: dict) -> bool:
    return user.get("role") == "overlord"


def _caller_id(user: dict) -> int:
    return int(user["sub"])


# ── Read ───────────────────────────────────────────────────────────────────────

@router.get("")
def list_users(user: dict = Depends(require_admin)):
    conn = get_db()
    try:
        if _is_overlord(user):
            # Overlords see everyone
            rows = conn.execute(
                "SELECT id, username, role, is_approved, team_lead_id, created_at "
                "FROM users ORDER BY created_at DESC"
            ).fetchall()
        else:
            # Admins see only their own team members
            rows = conn.execute(
                "SELECT id, username, role, is_approved, team_lead_id, created_at "
                "FROM users WHERE team_lead_id = ? ORDER BY created_at DESC",
                (_caller_id(user),),
            ).fetchall()
        return [_user_to_dict(r) for r in rows]
    finally:
        conn.close()


@router.get("/pending")
def list_pending(user: dict = Depends(require_admin)):
    conn = get_db()
    try:
        if _is_overlord(user):
            rows = conn.execute(
                "SELECT id, username, role, is_approved, team_lead_id, created_at "
                "FROM users WHERE is_approved = 0 ORDER BY created_at"
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id, username, role, is_approved, team_lead_id, created_at "
                "FROM users WHERE is_approved = 0 AND team_lead_id = ? ORDER BY created_at",
                (_caller_id(user),),
            ).fetchall()
        return [_user_to_dict(r) for r in rows]
    finally:
        conn.close()


@router.get("/campaigners")
def list_campaigners(user: dict = Depends(require_approved)):
    """Return all approved users (any role).
    Used by the 'campaigner' role to populate the 'Uploaded For' dropdown
    when uploading data on behalf of another user."""
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT id, username, role FROM users "
            "WHERE is_approved=1 ORDER BY username"
        ).fetchall()
        return [{"id": r["id"], "username": r["username"], "role": r["role"]} for r in rows]
    finally:
        conn.close()


# ── Create ─────────────────────────────────────────────────────────────────────

@router.post("", status_code=201)
def create_user(body: UserCreate, user: dict = Depends(require_admin)):
    if len(body.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters.")

    caller_role = user.get("role")
    if body.role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail=f"Role must be one of: {', '.join(VALID_ROLES)}.")
    if caller_role == "admin" and body.role in ("admin", "overlord"):
        raise HTTPException(
            status_code=403,
            detail="Admins may only create 'standard' users. Use an overlord account to assign elevated roles.",
        )

    pw_hash = bcrypt.hashpw(body.password.encode(), bcrypt.gensalt()).decode()

    # Auto-assign new standard users to the creating admin's team
    team_lead_id = _caller_id(user) if caller_role == "admin" and body.role == "standard" else None

    conn = get_db()
    try:
        existing = conn.execute("SELECT id FROM users WHERE username = ?", (body.username,)).fetchone()
        if existing:
            raise HTTPException(status_code=409, detail="Username already exists.")

        cur = conn.execute(
            "INSERT INTO users (username, password_hash, role, is_approved, team_lead_id) VALUES (?, ?, ?, 1, ?)",
            (body.username, pw_hash, body.role, team_lead_id),
        )
        conn.commit()
        row = conn.execute(
            "SELECT id, username, role, is_approved, team_lead_id, created_at FROM users WHERE id = ?",
            (cur.lastrowid,),
        ).fetchone()
        return _user_to_dict(row)
    finally:
        conn.close()


# ── Approve / Reject ───────────────────────────────────────────────────────────

@router.patch("/{user_id}/approve")
def approve_user(user_id: int, body: ApproveUserRequest, user: dict = Depends(require_admin)):
    if body.is_approved not in (1, 2):
        raise HTTPException(status_code=400, detail="is_approved must be 1 (approve) or 2 (reject).")

    conn = get_db()
    try:
        row = conn.execute(
            "SELECT id, team_lead_id FROM users WHERE id = ?", (user_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User not found.")

        # Admins may only approve/reject members of their own team
        if not _is_overlord(user) and row["team_lead_id"] != _caller_id(user):
            raise HTTPException(status_code=403, detail="You can only manage users in your own team.")

        conn.execute("UPDATE users SET is_approved = ? WHERE id = ?", (body.is_approved, user_id))
        conn.commit()
        return {"message": "User status updated.", "user_id": user_id, "is_approved": body.is_approved}
    finally:
        conn.close()


# ── Password Reset (overlord-only) ─────────────────────────────────────────────

@router.patch("/{user_id}/password")
def reset_user_password(
    user_id: int,
    body: PasswordResetRequest,
    caller: dict = Depends(require_overlord),
):
    if len(body.new_password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters.")

    conn = get_db()
    try:
        row = conn.execute("SELECT id, username FROM users WHERE id = ?", (user_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User not found.")

        pw_hash = bcrypt.hashpw(body.new_password.encode(), bcrypt.gensalt()).decode()
        conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (pw_hash, user_id))
        conn.commit()
        return {
            "message": f"Password for user '{row['username']}' (id={user_id}) has been reset.",
            "user_id": user_id,
        }
    finally:
        conn.close()


# ── Role Promotion / Demotion (overlord-only) ──────────────────────────────────

@router.patch("/{user_id}/role")
def change_user_role(
    user_id: int,
    body: RoleChangeRequest,
    caller: dict = Depends(require_overlord),
):
    if body.role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail=f"Role must be one of: {', '.join(VALID_ROLES)}.")

    # Prevent overlord from demoting themselves
    if str(user_id) == caller["sub"] and body.role != "overlord":
        raise HTTPException(status_code=400, detail="You cannot change your own overlord role.")

    conn = get_db()
    try:
        row = conn.execute("SELECT id, username, role FROM users WHERE id = ?", (user_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User not found.")

        conn.execute("UPDATE users SET role = ? WHERE id = ?", (body.role, user_id))
        conn.commit()
        return {
            "message": f"Role for user '{row['username']}' changed from '{row['role']}' to '{body.role}'.",
            "user_id": user_id,
            "new_role": body.role,
        }
    finally:
        conn.close()


# ── Rename Username (overlord-only) ──────────────────────────────────────────────

@router.patch("/{user_id}/username")
def rename_user(
    user_id: int,
    body: RenameRequest,
    caller: dict = Depends(require_overlord),
):
    new_username = body.new_username.strip()
    if not new_username:
        raise HTTPException(status_code=400, detail="New username must not be empty.")
    if len(new_username) < 3:
        raise HTTPException(status_code=400, detail="Username must be at least 3 characters.")

    conn = get_db()
    try:
        row = conn.execute("SELECT id, username FROM users WHERE id = ?", (user_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User not found.")

        # Ensure the new name is not taken by a *different* user
        clash = conn.execute(
            "SELECT id FROM users WHERE username = ?", (new_username,)
        ).fetchone()
        if clash and clash["id"] != user_id:
            raise HTTPException(status_code=409, detail="Username already taken.")

        old_username = row["username"]
        conn.execute("UPDATE users SET username = ? WHERE id = ?", (new_username, user_id))
        conn.commit()

        response: dict = {
            "message": f"Username changed from '{old_username}' to '{new_username}'.",
            "user_id": user_id,
            "new_username": new_username,
        }
        # If the overlord is renaming themselves, issue a fresh token
        if str(user_id) == caller["sub"]:
            from dependencies import create_access_token
            new_token = create_access_token({
                "sub": caller["sub"],
                "username": new_username,
                "role": caller["role"],
                "is_approved": caller["is_approved"],
            })
            response["access_token"] = new_token
        return response
    finally:
        conn.close()


# ── Delete ─────────────────────────────────────────────────────────────────────

@router.delete("/{user_id}", status_code=204)
def delete_user(user_id: int, user: dict = Depends(require_admin)):
    if str(user_id) == user["sub"]:
        raise HTTPException(status_code=400, detail="You cannot delete your own account.")

    conn = get_db()
    try:
        row = conn.execute(
            "SELECT id, role, team_lead_id FROM users WHERE id = ?", (user_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User not found.")

        # Only overlords can delete other overlords
        if row["role"] == "overlord" and user.get("role") != "overlord":
            raise HTTPException(status_code=403, detail="Only overlords can delete other overlord accounts.")

        # Admins may only delete their own team members
        if not _is_overlord(user) and row["team_lead_id"] != _caller_id(user):
            raise HTTPException(status_code=403, detail="You can only delete users in your own team.")

        # ── Resolve FK constraints before deleting ───────────────────────────
        # 1. Nullify team_lead_id for any users whose lead is being deleted
        conn.execute(
            "UPDATE users SET team_lead_id = NULL WHERE team_lead_id = ?", (user_id,)
        )
        # 2. Nullify support_for on data_scraping rows (nullable FK)
        conn.execute(
            "UPDATE data_scraping SET support_for = NULL WHERE support_for = ?", (user_id,)
        )
        # 3. Reassign data_scraping rows uploaded_by this user to the caller
        caller_id = int(user["sub"])
        conn.execute(
            "UPDATE data_scraping SET uploaded_by = ? WHERE uploaded_by = ?",
            (caller_id, user_id),
        )
        # 4. Delete records owned exclusively by this user
        conn.execute("DELETE FROM queue_meta WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM email_templates WHERE created_by = ?", (user_id,))
        conn.execute("DELETE FROM employee_profiles WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM kanban_cards WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM kanban_card_history WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM kanban_sheets WHERE created_by = ?", (user_id,))
        # 5. Now it is safe to delete the user
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        conn.commit()
    finally:
        conn.close()
