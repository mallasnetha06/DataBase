"""
routers/templates.py — Email Template CRUD.

Endpoints:
  GET    /templates        — list all templates for the current user
  POST   /templates        — create a new template
  GET    /templates/{id}   — get a single template
  PUT    /templates/{id}   — update a template
  DELETE /templates/{id}   — delete a template
"""
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from database import get_db
from models import TemplateCreate, TemplateUpdate, TemplateResponse
from dependencies import require_approved, get_current_user

router = APIRouter(prefix="/templates", tags=["templates"])


def _row_to_dict(row) -> dict:
    return {
        "id":          row["id"],
        "name":        row["name"],
        "subject":     row["subject"] or "",
        "body":        row["body"] or "",
        "created_by":  row["created_by"],
        "creator_name": dict(row).get("creator_name") if hasattr(row, "keys") else getattr(row, "creator_name", None),
        "created_at":  row["created_at"],
        "updated_at":  row["updated_at"],
    }


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


# ── List all templates ─────────────────────────────────────────────────────────
@router.get("", response_model=list[TemplateResponse])
def list_templates(
    current_user: dict = Depends(require_approved),
    db=Depends(get_db),
):
    user_id   = int(current_user["sub"])
    is_admin  = current_user.get("role") == "admin"

    if is_admin:
        rows = db.execute(
            """SELECT t.*, u.username as creator_name 
               FROM email_templates t
               LEFT JOIN users u ON t.created_by = u.id
               ORDER BY t.updated_at DESC"""
        ).fetchall()
    else:
        rows = db.execute(
            """SELECT t.*, u.username as creator_name 
               FROM email_templates t
               LEFT JOIN users u ON t.created_by = u.id
               WHERE t.created_by = ? 
               ORDER BY t.updated_at DESC""",
            (user_id,),
        ).fetchall()

    db.close()
    return [_row_to_dict(r) for r in rows]


# ── Get a single template ──────────────────────────────────────────────────────
@router.get("/{template_id}", response_model=TemplateResponse)
def get_template(
    template_id: int,
    current_user: dict = Depends(require_approved),
    db=Depends(get_db),
):
    user_id  = int(current_user["sub"])
    is_admin = current_user.get("role") == "admin"

    row = db.execute(
        """SELECT t.*, u.username as creator_name
           FROM email_templates t
           LEFT JOIN users u ON t.created_by = u.id
           WHERE t.id = ?""", (template_id,)
    ).fetchone()
    db.close()
    if not row:
        raise HTTPException(status_code=404, detail="Template not found")
    if not is_admin and row["created_by"] != user_id:
        raise HTTPException(status_code=403, detail="You do not have permission to view this template")
    return _row_to_dict(row)


# ── Create a template ──────────────────────────────────────────────────────────
@router.post("", response_model=TemplateResponse, status_code=201)
def create_template(
    payload: TemplateCreate,
    current_user: dict = Depends(require_approved),
    db=Depends(get_db),
):
    if not payload.name.strip():
        raise HTTPException(status_code=400, detail="Template name cannot be empty")

    now = _now()
    cur = db.execute(
        """INSERT INTO email_templates (name, subject, body, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (payload.name.strip(), payload.subject, payload.body, int(current_user["sub"]), now, now),
    )
    db.commit()
    row = db.execute(
        """SELECT t.*, u.username as creator_name
           FROM email_templates t
           LEFT JOIN users u ON t.created_by = u.id
           WHERE t.id = ?""", (cur.lastrowid,)
    ).fetchone()
    db.close()
    return _row_to_dict(row)


# ── Update a template ──────────────────────────────────────────────────────────
@router.put("/{template_id}", response_model=TemplateResponse)
def update_template(
    template_id: int,
    payload: TemplateUpdate,
    current_user: dict = Depends(require_approved),
    db=Depends(get_db),
):
    user_id  = int(current_user["sub"])
    is_admin = current_user.get("role") == "admin"

    row = db.execute(
        "SELECT * FROM email_templates WHERE id = ?", (template_id,)
    ).fetchone()
    if not row:
        db.close()
        raise HTTPException(status_code=404, detail="Template not found")
    if not is_admin and row["created_by"] != user_id:
        db.close()
        raise HTTPException(status_code=403, detail="You do not have permission to edit this template")

    new_name    = payload.name.strip()    if payload.name    is not None else row["name"]
    new_subject = payload.subject         if payload.subject is not None else row["subject"]
    new_body    = payload.body            if payload.body    is not None else row["body"]

    if not new_name:
        db.close()
        raise HTTPException(status_code=400, detail="Template name cannot be empty")

    now = _now()
    db.execute(
        """UPDATE email_templates
           SET name = ?, subject = ?, body = ?, updated_at = ?
           WHERE id = ?""",
        (new_name, new_subject, new_body, now, template_id),
    )
    db.commit()
    row = db.execute(
        """SELECT t.*, u.username as creator_name
           FROM email_templates t
           LEFT JOIN users u ON t.created_by = u.id
           WHERE t.id = ?""", (template_id,)
    ).fetchone()
    db.close()
    return _row_to_dict(row)


# ── Delete a template ──────────────────────────────────────────────────────────
@router.delete("/{template_id}", status_code=204)
def delete_template(
    template_id: int,
    current_user: dict = Depends(require_approved),
    db=Depends(get_db),
):
    user_id  = int(current_user["sub"])
    is_admin = current_user.get("role") == "admin"

    row = db.execute(
        "SELECT id, created_by FROM email_templates WHERE id = ?", (template_id,)
    ).fetchone()
    if not row:
        db.close()
        raise HTTPException(status_code=404, detail="Template not found")
    if not is_admin and row["created_by"] != user_id:
        db.close()
        raise HTTPException(status_code=403, detail="You do not have permission to delete this template")

    db.execute("DELETE FROM email_templates WHERE id = ?", (template_id,))
    db.commit()
    db.close()
