"""
routers/auth.py — Login and self-registration endpoints.
"""
import bcrypt
from fastapi import APIRouter, HTTPException, Depends
from database import get_db
from models import LoginRequest, RegisterRequest, TokenResponse, RenameRequest
from dependencies import create_access_token, require_approved

router = APIRouter(prefix="/auth", tags=["auth"])

# Roles that are allowed to self-register via the public form
SELF_REGISTER_ROLES = {"standard", "campaigner"}


@router.post("/login", response_model=TokenResponse)
def login(body: LoginRequest):
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT * FROM users WHERE username = ?", (body.username,)
        ).fetchone()

        if not row:
            raise HTTPException(status_code=401, detail="Invalid username or password.")

        if not bcrypt.checkpw(body.password.encode(), row["password_hash"].encode()):
            raise HTTPException(status_code=401, detail="Invalid username or password.")

        if row["is_approved"] == 0:
            raise HTTPException(
                status_code=403,
                detail="Your account is awaiting admin approval. Please check back later.",
            )
        if row["is_approved"] == 2:
            raise HTTPException(
                status_code=403,
                detail="Your registration has been rejected. Contact an administrator.",
            )

        token = create_access_token(
            {
                "sub": str(row["id"]),
                "username": row["username"],
                "role": row["role"],
                "is_approved": row["is_approved"],
            }
        )
        return TokenResponse(
            access_token=token,
            role=row["role"],
            username=row["username"],
            user_id=row["id"],
        )
    finally:
        conn.close()


@router.post("/register", status_code=201)
def register(body: RegisterRequest):
    if len(body.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters.")

    # Only standard / campaigner roles may self-register
    if body.role not in SELF_REGISTER_ROLES:
        raise HTTPException(
            status_code=400,
            detail=f"Self-registration is only allowed for: {', '.join(SELF_REGISTER_ROLES)}.",
        )

    # Campaigners must not supply a team_lead_id
    if body.role == "campaigner" and body.team_lead_id is not None:
        raise HTTPException(status_code=400, detail="Campaigners do not belong to a team.")

    # Validate team_lead_id if provided (must be an approved admin)
    team_lead_id = None
    if body.role == "standard" and body.team_lead_id is not None:
        conn = get_db()
        try:
            lead = conn.execute(
                "SELECT id FROM users WHERE id = ? AND role = 'admin' AND is_approved = 1",
                (body.team_lead_id,),
            ).fetchone()
            if not lead:
                raise HTTPException(status_code=400, detail="Invalid team lead selected.")
            team_lead_id = body.team_lead_id
        finally:
            conn.close()

    pw_hash = bcrypt.hashpw(body.password.encode(), bcrypt.gensalt()).decode()

    # Standard users pending approval; campaigners auto-approved
    is_approved = 1 if body.role == "campaigner" else 0

    conn = get_db()
    try:
        existing = conn.execute(
            "SELECT id FROM users WHERE username = ?", (body.username,)
        ).fetchone()
        if existing:
            raise HTTPException(status_code=409, detail="Username already taken.")

        conn.execute(
            "INSERT INTO users (username, password_hash, role, is_approved, team_lead_id) "
            "VALUES (?, ?, ?, ?, ?)",
            (body.username, pw_hash, body.role, is_approved, team_lead_id),
        )
        conn.commit()

        if body.role == "campaigner":
            return {"message": "Campaigner account created. You can log in immediately."}
        return {"message": "Registration submitted. An administrator will review your account shortly."}
    finally:
        conn.close()


@router.get("/admins")
def list_admins():
    """Public endpoint — returns approved admins for the register form team-lead dropdown."""
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT id, username FROM users WHERE role = 'admin' AND is_approved = 1 ORDER BY username"
        ).fetchall()
        return [{"id": r["id"], "username": r["username"]} for r in rows]
    finally:
        conn.close()

@router.patch("/rename")
def rename_username(body: RenameRequest, user: dict = Depends(require_approved)):
    """Allow any approved user to rename their own account.

    Returns a fresh access token with the updated username so the client
    can replace the stored token immediately without re-logging-in.
    """
    new_username = body.new_username.strip()
    if not new_username:
        raise HTTPException(status_code=400, detail="New username must not be empty.")
    if len(new_username) < 3:
        raise HTTPException(status_code=400, detail="Username must be at least 3 characters.")

    caller_id = int(user["sub"])
    conn = get_db()
    try:
        # Check the new name is not already taken by someone else
        existing = conn.execute(
            "SELECT id FROM users WHERE username = ?", (new_username,)
        ).fetchone()
        if existing and existing["id"] != caller_id:
            raise HTTPException(status_code=409, detail="Username already taken.")

        conn.execute(
            "UPDATE users SET username = ? WHERE id = ?", (new_username, caller_id)
        )
        conn.commit()

        # Issue a fresh token with the updated username
        new_token = create_access_token(
            {
                "sub": user["sub"],
                "username": new_username,
                "role": user["role"],
                "is_approved": user["is_approved"],
            }
        )
        return {
            "message": f"Username updated to '{new_username}'.",
            "access_token": new_token,
            "username": new_username,
        }
    finally:
        conn.close()
