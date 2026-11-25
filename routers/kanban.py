"""
routers/kanban.py — Kanban Task Tracking System.

Roles:
  - admin / overlord : create / edit / delete sheets, assign to team members,
                       view team-wide card status matrix.
  - standard         : view their own cards, update status & note on each card.

Endpoints:
  GET    /kanban/sheets                  — list all sheets (admin) or own sheets (standard)
  POST   /kanban/sheets                  — create a sheet / template (admin)
  PUT    /kanban/sheets/{id}             — edit sheet title/tasks/type (admin)
  DELETE /kanban/sheets/{id}             — delete sheet + all cards (admin)
  POST   /kanban/sheets/{id}/assign      — assign sheet to user_ids (auto-creates cards) (admin)
  POST   /kanban/sheets/{id}/from-template — create a live sheet from a template (admin)
  GET    /kanban/my-sheets               — sheets assigned to me with my card states (any approved)
  GET    /kanban/team-view/{sheet_id}    — matrix: all users × all tasks for a sheet (admin)
  PATCH  /kanban/cards/{card_id}         — update status/note on a single card (owner or admin)
  GET    /kanban/team-members            — list of users the admin can assign sheets to (admin)
"""
import json
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Query
from database import get_db
from models import (
    KanbanSheetCreate, KanbanSheetUpdate, KanbanSheetResponse,
    KanbanCardPatch, KanbanCardResponse, KanbanAssignRequest,
    KanbanHistoryStatusPatch,
)
from dependencies import require_approved, require_admin

router = APIRouter(prefix="/kanban", tags=["kanban"])

VALID_STATUSES    = ("todo", "inprogress", "blocked", "done")
VALID_SHEET_TYPES = ("weekly", "monthly", "custom", "daily")


# ── Helpers ────────────────────────────────────────────────────────────────────

def _sheet_to_dict(row) -> dict:
    keys = row.keys()
    return {
        "id":             row["id"],
        "title":          row["title"],
        "sheet_type":     row["sheet_type"],
        "period_label":   row["period_label"],
        "tasks_json":     row["tasks_json"],
        "created_by":     row["created_by"],
        "creator_name":   row["username"] if "username" in keys else None,
        "is_template":    row["is_template"],
        "last_reset_at":  row["last_reset_at"] if "last_reset_at" in keys else None,
        "created_at":     row["created_at"],
        "updated_at":     row["updated_at"],
    }


def _card_to_dict(row) -> dict:
    keys = row.keys()
    return {
        "id":        row["id"],
        "sheet_id":  row["sheet_id"],
        "user_id":   row["user_id"],
        "username":  row["username"] if "username" in keys else None,
        "task_name": row["task_name"],
        "status":    row["status"],
        "note":      row["note"],
        "position":  row["position"],
        "updated_at": row["updated_at"],
    }


def _log(conn, user_id: int, action: str, target: str = None, detail: str = None):
    conn.execute(
        "INSERT INTO audit_log (user_id, action, target, detail) VALUES (?, ?, ?, ?)",
        (user_id, action, target, detail),
    )


# ── Reset Helpers ────────────────────────────────────────────────────────────

from datetime import date as _date


def _is_reset_due(sheet_type: str, last_reset_at) -> bool:
    """
    Returns True if the sheet is due for an auto-reset based on its type and
    the timestamp of the last reset.  Custom sheets never auto-reset.

    Behaviour for NULL last_reset_at:
      - daily  : treated as "initialise now" (reset is safe; cycle starts today)
      - weekly / monthly : NO reset — we don't wipe pre-existing cards just
        because the column is new.  The sheet will reset at the next natural
        boundary (next week / next month) once last_reset_at is set.
    """
    if sheet_type not in ("daily", "weekly", "monthly"):
        return False
    if last_reset_at is None:
        # For daily sheets only: initialise the cycle silently on first load.
        # For weekly/monthly: wait for a natural boundary — never wipe blindly.
        return sheet_type == "daily"
    try:
        last = _date.fromisoformat(str(last_reset_at)[:10])
    except (ValueError, TypeError):
        return True  # Malformed timestamp — safe to reset

    today = _date.today()
    if sheet_type == "daily":
        return today > last
    if sheet_type == "weekly":
        # New ISO week has started
        return today.isocalendar()[:2] > last.isocalendar()[:2]
    if sheet_type == "monthly":
        return (today.year, today.month) > (last.year, last.month)
    return False


def _check_and_reset_sheet_for_user(conn, sheet, user_id: int) -> bool:
    """
    Per-user auto-reset: checks whether THIS USER's cards on the given sheet
    are due for a reset based on the sheet's type.

    The last_reset_at timestamp is stored directly on each user's kanban_cards
    rows (not on the shared kanban_sheets table), so User A's reset never
    affects User B's cards or clock.

    If a reset is due:
      1. Snapshots only this user's non-todo cards into kanban_card_history.
      2. Resets only this user's cards to status='todo', note=''.
      3. Updates last_reset_at only on this user's cards.
    Returns True if a reset was performed, False otherwise.
    """
    sheet_id   = sheet["id"]
    sheet_type = sheet["sheet_type"]
    period_label = sheet["period_label"] or ""

    # Read this user's own last_reset_at from their cards (MAX so we get the
    # most recent value; NULL means the user's cards have never been reset).
    row = conn.execute(
        """SELECT MAX(last_reset_at) AS last_reset
           FROM kanban_cards
           WHERE sheet_id = ? AND user_id = ?""",
        (sheet_id, user_id),
    ).fetchone()
    last_reset = row["last_reset"] if row else None

    if not _is_reset_due(sheet_type, last_reset):
        return False

    now_ts = datetime.now(timezone.utc).isoformat()

    # 1. Snapshot — only THIS user's cards that have been touched
    non_todo_cards = conn.execute(
        """SELECT id, user_id, task_name, status, note
           FROM kanban_cards
           WHERE sheet_id = ? AND user_id = ? AND (status != 'todo' OR note != '')""",
        (sheet_id, user_id),
    ).fetchall()

    for c in non_todo_cards:
        conn.execute(
            """INSERT INTO kanban_card_history
               (sheet_id, user_id, task_name, final_status, note, period_label, reset_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (sheet_id, c["user_id"], c["task_name"], c["status"], c["note"],
             period_label, now_ts),
        )

    # 2. Reset only THIS user's cards back to 'todo' with empty notes
    conn.execute(
        """UPDATE kanban_cards
           SET status='todo', note='', updated_at=?, last_reset_at=?
           WHERE sheet_id=? AND user_id=?""",
        (now_ts, now_ts, sheet_id, user_id),
    )

    conn.commit()
    return True


# ── List Sheets ────────────────────────────────────────────────────────────────

@router.get("/sheets")
def list_sheets(
    include_templates: int = Query(1, ge=0, le=1),
    user: dict = Depends(require_approved),
):
    """
    Admin: returns all sheets (templates + live).
    Standard: returns only sheets that have cards assigned to them.
    Each sheet includes `assigned_members` (list of usernames) and
    `completion` {done, total, pct} for quick sidebar display.
    """
    user_id = int(user["sub"])
    is_admin = user.get("role") in ("admin", "overlord")
    conn = get_db()
    try:
        if is_admin:
            is_overlord = user.get("role") == "overlord"
            if is_overlord:
                # Overlords see every sheet regardless of creator
                if include_templates:
                    where  = ""
                    params = ()
                else:
                    where  = "WHERE ks.is_template=0"
                    params = ()
            else:
                # Admins see sheets they created OR sheets assigned to their team
                if include_templates:
                    where  = """WHERE (ks.created_by = ?
                                       OR ks.id IN (
                                           SELECT DISTINCT kc.sheet_id
                                           FROM kanban_cards kc
                                           INNER JOIN users u2 ON kc.user_id = u2.id
                                           WHERE u2.team_lead_id = ?
                                       ))"""
                else:
                    where  = """WHERE ks.is_template=0
                                AND (ks.created_by = ?
                                     OR ks.id IN (
                                         SELECT DISTINCT kc.sheet_id
                                         FROM kanban_cards kc
                                         INNER JOIN users u2 ON kc.user_id = u2.id
                                         WHERE u2.team_lead_id = ?
                                     ))"""
                params = (user_id, user_id)
            rows = conn.execute(
                f"""SELECT ks.*, u.username
                    FROM kanban_sheets ks
                    LEFT JOIN users u ON ks.created_by = u.id
                    {where}
                    ORDER BY ks.created_at DESC""",
                params,
            ).fetchall()
        else:
            # Standard users: only sheets they have cards on
            rows = conn.execute(
                """SELECT DISTINCT ks.*, u.username
                   FROM kanban_sheets ks
                   LEFT JOIN users u ON ks.created_by = u.id
                   INNER JOIN kanban_cards kc ON kc.sheet_id = ks.id AND kc.user_id = ?
                   ORDER BY ks.created_at DESC""",
                (user_id,),
            ).fetchall()

        result = []
        for r in rows:
            d = _sheet_to_dict(r)
            sheet_id = d["id"]

            # Assigned member usernames (distinct users with cards on this sheet)
            member_rows = conn.execute(
                """SELECT DISTINCT u.username
                   FROM kanban_cards kc
                   LEFT JOIN users u ON kc.user_id = u.id
                   WHERE kc.sheet_id = ?
                   ORDER BY u.username ASC""",
                (sheet_id,),
            ).fetchall()
            d["assigned_members"] = [m["username"] for m in member_rows if m["username"]]

            # Completion stats across all assigned members
            stats = conn.execute(
                """SELECT
                       COUNT(*) AS total,
                       SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done
                   FROM kanban_cards
                   WHERE sheet_id = ?""",
                (sheet_id,),
            ).fetchone()
            total = stats["total"] or 0
            done  = stats["done"]  or 0
            d["completion"] = {
                "done":  done,
                "total": total,
                "pct":   round(done / total * 100) if total else 0,
            }

            result.append(d)
        return result
    finally:
        conn.close()


# ── Create Sheet ───────────────────────────────────────────────────────────────

@router.post("/sheets", status_code=201)
def create_sheet(body: KanbanSheetCreate, user: dict = Depends(require_admin)):
    """Admin creates a new sheet or template."""
    user_id = int(user["sub"])

    # Validate tasks_json
    try:
        tasks = json.loads(body.tasks_json)
        if not isinstance(tasks, list):
            raise ValueError
    except Exception:
        raise HTTPException(status_code=400, detail="tasks_json must be a valid JSON array.")

    if body.sheet_type not in VALID_SHEET_TYPES:
        raise HTTPException(status_code=400, detail=f"sheet_type must be one of: {', '.join(VALID_SHEET_TYPES)}.")

    now_ts = datetime.now(timezone.utc).isoformat()
    conn = get_db()
    try:
        cur = conn.execute(
            """INSERT INTO kanban_sheets
               (title, sheet_type, period_label, tasks_json, created_by, is_template, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (body.title.strip(), body.sheet_type, body.period_label.strip(),
             body.tasks_json, user_id, body.is_template, now_ts, now_ts),
        )
        conn.commit()
        sheet_id = cur.lastrowid
        _log(conn, user_id, "CREATE_KANBAN_SHEET", f"kanban_sheet:{sheet_id}",
             f"title={body.title} type={body.sheet_type} tasks={len(tasks)}")
        conn.commit()

        row = conn.execute(
            """SELECT ks.*, u.username FROM kanban_sheets ks
               LEFT JOIN users u ON ks.created_by = u.id WHERE ks.id=?""",
            (sheet_id,)
        ).fetchone()
        return _sheet_to_dict(row)
    finally:
        conn.close()


# ── Update Sheet ───────────────────────────────────────────────────────────────

@router.put("/sheets/{sheet_id}")
def update_sheet(sheet_id: int, body: KanbanSheetUpdate, user: dict = Depends(require_admin)):
    """Admin edits sheet metadata and/or task list."""
    user_id = int(user["sub"])
    conn = get_db()
    try:
        existing = conn.execute(
            "SELECT * FROM kanban_sheets WHERE id=?", (sheet_id,)
        ).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Sheet not found.")

        fields = {}
        if body.title        is not None: fields["title"]        = body.title.strip()
        if body.sheet_type   is not None:
            if body.sheet_type not in VALID_SHEET_TYPES:
                raise HTTPException(status_code=400, detail=f"Invalid sheet_type.")
            fields["sheet_type"] = body.sheet_type
        if body.period_label is not None: fields["period_label"] = body.period_label.strip()
        if body.is_template  is not None: fields["is_template"]  = body.is_template
        if body.tasks_json   is not None:
            try:
                tasks = json.loads(body.tasks_json)
                if not isinstance(tasks, list):
                    raise ValueError
            except Exception:
                raise HTTPException(status_code=400, detail="tasks_json must be a valid JSON array.")
            fields["tasks_json"] = body.tasks_json

        if not fields:
            raise HTTPException(status_code=400, detail="No fields provided.")

        fields["updated_at"] = datetime.now(timezone.utc).isoformat()
        set_clause = ", ".join(f"{k}=?" for k in fields)
        conn.execute(f"UPDATE kanban_sheets SET {set_clause} WHERE id=?",
                     list(fields.values()) + [sheet_id])
        conn.commit()
        _log(conn, user_id, "UPDATE_KANBAN_SHEET", f"kanban_sheet:{sheet_id}")
        conn.commit()

        row = conn.execute(
            """SELECT ks.*, u.username FROM kanban_sheets ks
               LEFT JOIN users u ON ks.created_by = u.id WHERE ks.id=?""",
            (sheet_id,)
        ).fetchone()
        return _sheet_to_dict(row)
    finally:
        conn.close()


# ── Delete Sheet ───────────────────────────────────────────────────────────────

@router.delete("/sheets/{sheet_id}", status_code=204)
def delete_sheet(sheet_id: int, user: dict = Depends(require_admin)):
    """Admin deletes a sheet and all its cards/history.

    Explicit child-row deletion is performed before removing the parent sheet
    so that the operation is safe even on SQLite databases where the
    ON DELETE CASCADE foreign-key action was never activated (i.e. the DB was
    initialised before PRAGMA foreign_keys=ON was in effect).
    """
    user_id = int(user["sub"])
    conn = get_db()
    try:
        row = conn.execute("SELECT id FROM kanban_sheets WHERE id=?", (sheet_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Sheet not found.")
        # Explicitly delete child rows first (safety net for legacy DBs where
        # the CASCADE PRAGMA may not have been active when the DB was created).
        conn.execute("DELETE FROM kanban_card_history WHERE sheet_id=?", (sheet_id,))
        conn.execute("DELETE FROM kanban_cards WHERE sheet_id=?", (sheet_id,))
        conn.execute("DELETE FROM kanban_sheets WHERE id=?", (sheet_id,))
        conn.commit()
        _log(conn, user_id, "DELETE_KANBAN_SHEET", f"kanban_sheet:{sheet_id}")
        conn.commit()
    finally:
        conn.close()


# ── Assign Sheet to Users ──────────────────────────────────────────────────────

@router.post("/sheets/{sheet_id}/assign")
def assign_sheet(sheet_id: int, body: KanbanAssignRequest, user: dict = Depends(require_admin)):
    """
    Admin assigns a sheet to one or more users.
    Auto-creates a kanban_card row for each (user, task) pair.
    If a user already has a card for that task on this sheet, it is skipped (idempotent).
    """
    user_id = int(user["sub"])
    conn = get_db()
    try:
        sheet = conn.execute(
            "SELECT * FROM kanban_sheets WHERE id=?", (sheet_id,)
        ).fetchone()
        if not sheet:
            raise HTTPException(status_code=404, detail="Sheet not found.")

        try:
            tasks = json.loads(sheet["tasks_json"] or "[]")
            if not isinstance(tasks, list):
                tasks = []
        except Exception:
            tasks = []

        if not tasks:
            raise HTTPException(status_code=400, detail="Sheet has no tasks. Add tasks before assigning.")

        now_ts = datetime.now(timezone.utc).isoformat()
        created_count = 0

        for uid in body.user_ids:
            # Verify user exists and is approved
            u_row = conn.execute(
                "SELECT id FROM users WHERE id=? AND is_approved=1", (uid,)
            ).fetchone()
            if not u_row:
                continue

            for pos, task_name in enumerate(tasks):
                existing = conn.execute(
                    "SELECT id FROM kanban_cards WHERE sheet_id=? AND user_id=? AND task_name=?",
                    (sheet_id, uid, task_name),
                ).fetchone()
                if not existing:
                    conn.execute(
                        """INSERT INTO kanban_cards
                           (sheet_id, user_id, task_name, status, note, position, updated_at)
                           VALUES (?, ?, ?, 'todo', '', ?, ?)""",
                        (sheet_id, uid, task_name, pos, now_ts),
                    )
                    created_count += 1

        conn.commit()
        _log(conn, user_id, "ASSIGN_KANBAN_SHEET", f"kanban_sheet:{sheet_id}",
             f"users={body.user_ids} cards_created={created_count}")
        conn.commit()

        return {"sheet_id": sheet_id, "users_assigned": len(body.user_ids), "cards_created": created_count}
    finally:
        conn.close()


# ── Create Sheet from Template ─────────────────────────────────────────────────

@router.post("/sheets/{sheet_id}/from-template", status_code=201)
def sheet_from_template(
    sheet_id: int,
    body: KanbanSheetCreate,
    user: dict = Depends(require_admin),
):
    """
    Admin creates a new live sheet using an existing template as source.
    The new sheet copies tasks_json from the template but gets its own
    title, sheet_type, period_label, and is_template=0 from the request body.
    """
    user_id = int(user["sub"])
    conn = get_db()
    try:
        template = conn.execute(
            "SELECT * FROM kanban_sheets WHERE id=? AND is_template=1", (sheet_id,)
        ).fetchone()
        if not template:
            raise HTTPException(status_code=404, detail="Template not found.")

        now_ts = datetime.now(timezone.utc).isoformat()
        tasks_json = template["tasks_json"]  # inherit tasks from template

        cur = conn.execute(
            """INSERT INTO kanban_sheets
               (title, sheet_type, period_label, tasks_json, created_by, is_template, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 0, ?, ?)""",
            (body.title.strip(), body.sheet_type, body.period_label.strip(),
             tasks_json, user_id, now_ts, now_ts),
        )
        conn.commit()
        new_id = cur.lastrowid
        _log(conn, user_id, "CREATE_KANBAN_FROM_TEMPLATE", f"kanban_sheet:{new_id}",
             f"template={sheet_id} title={body.title}")
        conn.commit()

        row = conn.execute(
            """SELECT ks.*, u.username FROM kanban_sheets ks
               LEFT JOIN users u ON ks.created_by = u.id WHERE ks.id=?""",
            (new_id,)
        ).fetchone()
        return _sheet_to_dict(row)
    finally:
        conn.close()


# ── My Stats (Dashboard KPI) ───────────────────────────────────────────────────

@router.get("/my-stats")
def my_stats(user: dict = Depends(require_approved)):
    """
    Returns the user's card stats for the dashboard KPI.
    Aggregates both live cards and history (completed/touched past tasks).
    """
    user_id = int(user["sub"])
    conn = get_db()
    try:
        live_cards = conn.execute(
            "SELECT sheet_id, status FROM kanban_cards WHERE user_id=?",
            (user_id,)
        ).fetchall()
        
        # Group cards by sheet_id
        sheets_status = {}
        for row in live_cards:
            sid = row["sheet_id"]
            if sid not in sheets_status:
                sheets_status[sid] = []
            sheets_status[sid].append(row["status"])
            
        total = len(sheets_status)
        completed = 0
        not_started = 0
        in_progress = 0
        
        for sid, statuses in sheets_status.items():
            if all(s == 'done' for s in statuses):
                completed += 1
            elif all(s == 'todo' for s in statuses):
                not_started += 1
            else:
                in_progress += 1

        return {
            "total": total,
            "completed": completed,
            "in_progress": in_progress,
            "not_started": not_started,
        }
    finally:
        conn.close()


# ── My Sheets (Employee View) ──────────────────────────────────────────────────

@router.get("/my-sheets")
def my_sheets(user: dict = Depends(require_approved)):
    """
    Returns sheets assigned to the current user along with their card states.
    Response: list of sheets, each with a `cards` array.
    """
    user_id = int(user["sub"])
    conn = get_db()
    try:
        sheets = conn.execute(
            """SELECT DISTINCT ks.*, u.username
               FROM kanban_sheets ks
               LEFT JOIN users u ON ks.created_by = u.id
               INNER JOIN kanban_cards kc ON kc.sheet_id = ks.id AND kc.user_id = ?
               ORDER BY ks.created_at DESC""",
            (user_id,),
        ).fetchall()

        result = []
        for sheet in sheets:
            # ── Per-user auto-reset check ─────────────────────────────────────
            # Fires silently on every board load.  Only resets THIS user's
            # cards if a new cycle has started since their own last_reset_at.
            # Other users' cards and timestamps are never touched.
            # Wrapped in try/except so a reset failure never blocks the board.
            try:
                _check_and_reset_sheet_for_user(conn, sheet, user_id)
            except Exception:
                pass  # reset failure is non-fatal; user still sees their board

            cards = conn.execute(
                """SELECT kc.*, u.username FROM kanban_cards kc
                   LEFT JOIN users u ON kc.user_id = u.id
                   WHERE kc.sheet_id=? AND kc.user_id=?
                   ORDER BY kc.position ASC""",
                (sheet["id"], user_id),
            ).fetchall()
            sheet_dict = _sheet_to_dict(sheet)
            sheet_dict["cards"] = [_card_to_dict(c) for c in cards]
            result.append(sheet_dict)
        return result
    finally:
        conn.close()


# ── Team View — Matrix ─────────────────────────────────────────────────────────

@router.get("/team-view/{sheet_id}")
def team_view(sheet_id: int, user: dict = Depends(require_approved)):
    """
    Returns a matrix for a given sheet:
      {
        sheet: {...},
        tasks: ["Task A", "Task B", ...],
        members: [
          {user_id, username, cards: {task_name: {id, status, note}, ...}},
          ...
        ]
      }
    """
    user_id = int(user["sub"])
    is_admin = user.get("role") in ("admin", "overlord")
    conn = get_db()
    try:
        sheet = conn.execute(
            """SELECT ks.*, u.username FROM kanban_sheets ks
               LEFT JOIN users u ON ks.created_by = u.id WHERE ks.id=?""",
            (sheet_id,)
        ).fetchone()
        if not sheet:
            raise HTTPException(status_code=404, detail="Sheet not found.")

        try:
            tasks = json.loads(sheet["tasks_json"] or "[]")
        except Exception:
            tasks = []

        if is_admin:
            where_user = ""
            params = (sheet_id,)
        else:
            where_user = "AND kc.user_id = ?"
            params = (sheet_id, user_id)

        # All cards for this sheet, grouped by user
        cards = conn.execute(
            f"""SELECT kc.*, u.username FROM kanban_cards kc
               LEFT JOIN users u ON kc.user_id = u.id
               WHERE kc.sheet_id=? {where_user}
               ORDER BY kc.user_id ASC, kc.position ASC""",
            params,
        ).fetchall()

        # Build member map
        member_map: dict[int, dict] = {}
        for c in cards:
            uid = c["user_id"]
            if uid not in member_map:
                member_map[uid] = {
                    "user_id":  uid,
                    "username": c["username"] or "Unknown",
                    "cards":    {},
                }
            member_map[uid]["cards"][c["task_name"]] = {
                "id":     c["id"],
                "status": c["status"],
                "note":   c["note"],
            }

        return {
            "sheet":   _sheet_to_dict(sheet),
            "tasks":   tasks,
            "members": list(member_map.values()),
        }
    finally:
        conn.close()


# ── Update Card Status / Note ──────────────────────────────────────────────────

@router.patch("/cards/{card_id}")
def patch_card(card_id: int, body: KanbanCardPatch, user: dict = Depends(require_approved)):
    """
    Employee updates the status and/or note on their own card.
    Admin can update any card.
    """
    user_id  = int(user["sub"])
    is_admin = user.get("role") in ("admin", "overlord")
    conn = get_db()
    try:
        card = conn.execute(
            "SELECT * FROM kanban_cards WHERE id=?", (card_id,)
        ).fetchone()
        if not card:
            raise HTTPException(status_code=404, detail="Card not found.")
        if not is_admin and card["user_id"] != user_id:
            raise HTTPException(status_code=403, detail="You can only update your own cards.")

        fields = {}
        if body.status is not None:
            if body.status not in VALID_STATUSES:
                raise HTTPException(status_code=400, detail=f"status must be one of: {VALID_STATUSES}")
            fields["status"] = body.status
        if body.note is not None:
            fields["note"] = body.note

        if not fields:
            raise HTTPException(status_code=400, detail="No fields provided.")

        fields["updated_at"] = datetime.now(timezone.utc).isoformat()
        set_clause = ", ".join(f"{k}=?" for k in fields)
        conn.execute(f"UPDATE kanban_cards SET {set_clause} WHERE id=?",
                     list(fields.values()) + [card_id])
        conn.commit()
        _log(conn, user_id, "UPDATE_KANBAN_CARD", f"kanban_card:{card_id}",
             f"status={body.status} note_set={body.note is not None}")
        conn.commit()

        updated = conn.execute(
            """SELECT kc.*, u.username FROM kanban_cards kc
               LEFT JOIN users u ON kc.user_id = u.id WHERE kc.id=?""",
            (card_id,)
        ).fetchone()
        return _card_to_dict(updated)
    finally:
        conn.close()


# ── Team Members (for assignment picker) ──────────────────────────────────────

@router.get("/team-members")
def team_members(user: dict = Depends(require_approved)):
    """
    Returns the calling admin themselves plus all approved standard users
    whose team_lead_id matches the admin's id (their direct team members).
    This scopes the assign picker so admins can only assign to themselves
    and their own team, not to every user in the system.
    """
    user_id = int(user["sub"])
    conn = get_db()
    try:
        rows = conn.execute(
            """SELECT id, username, role, team_lead_id
               FROM users
               WHERE is_approved = 1
               AND (
                   id = ?
                   OR (role = 'standard' AND team_lead_id = ?)
               )
               ORDER BY
                   CASE WHEN id = ? THEN 0 ELSE 1 END,
                   username ASC""",
            (user_id, user_id, user_id),
        ).fetchall()
        return [{"id": r["id"], "username": r["username"], "role": r["role"]} for r in rows]
    finally:
        conn.close()


# ── Reset History (admin view of past cycles) ─────────────────────────────────

@router.get("/sheets/{sheet_id}/reset-history")
def reset_history(sheet_id: int, user: dict = Depends(require_approved)):
    """
    Admin: returns all kanban_card_history rows for a sheet.
    Response groups entries by reset_at (cycle) so admins can analyse
    how team members performed across past daily/weekly/monthly periods.

    Response shape:
    {
        "sheet": {...},
        "cycles": [
            {
                "reset_at": "2026-09-16T...",
                "period_label": "2026-W38",
                "entries": [
                    {"username": "alice", "task_name": "Email Send",
                     "final_status": "done", "note": "..."},
                    ...
                ]
            },
            ...
        ]
    }
    """
    user_id = int(user["sub"])
    is_admin = user.get("role") in ("admin", "overlord")
    conn = get_db()
    try:
        sheet = conn.execute(
            """SELECT ks.*, u.username FROM kanban_sheets ks
               LEFT JOIN users u ON ks.created_by = u.id WHERE ks.id=?""",
            (sheet_id,)
        ).fetchone()
        if not sheet:
            raise HTTPException(status_code=404, detail="Sheet not found.")

        if is_admin:
            where_user = ""
            params = (sheet_id,)
        else:
            where_user = "AND kch.user_id = ?"
            params = (sheet_id, user_id)

        rows = conn.execute(
            f"""SELECT kch.*, u.username AS member_username
               FROM kanban_card_history kch
               LEFT JOIN users u ON kch.user_id = u.id
               WHERE kch.sheet_id = ? {where_user}
               ORDER BY kch.reset_at DESC, u.username ASC, kch.task_name ASC""",
            params,
        ).fetchall()

        # Group by reset_at cycle (truncated to seconds for grouping)
        from collections import OrderedDict
        cycles: OrderedDict = OrderedDict()
        for r in rows:
            key = r["reset_at"]
            if key not in cycles:
                cycles[key] = {
                    "reset_at":     key,
                    "period_label": r["period_label"],
                    "entries":      [],
                }
            cycles[key]["entries"].append({
                "id":           r["id"],
                "username":     r["member_username"] or "Unknown",
                "task_name":    r["task_name"],
                "final_status": r["final_status"],
                "note":         r["note"],
            })

        return {
            "sheet":  _sheet_to_dict(sheet),
            "cycles": list(cycles.values()),
        }
    finally:
        conn.close()


# ── History Card Status / Cycle Deletion (admin) ────────────────────────────────

@router.patch("/history/{history_id}/status")
def patch_history_status(history_id: int, body: KanbanHistoryStatusPatch, user: dict = Depends(require_admin)):
    """Admin updates the final_status on a past reset cycle entry."""
    user_id = int(user["sub"])
    conn = get_db()
    try:
        if body.final_status not in VALID_STATUSES:
            raise HTTPException(status_code=400, detail=f"status must be one of: {VALID_STATUSES}")
        
        row = conn.execute("SELECT id FROM kanban_card_history WHERE id=?", (history_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="History entry not found.")
            
        conn.execute("UPDATE kanban_card_history SET final_status=? WHERE id=?", 
                     (body.final_status, history_id))
        conn.commit()
        _log(conn, user_id, "UPDATE_KANBAN_HISTORY", f"kanban_card_history:{history_id}",
             f"final_status={body.final_status}")
        conn.commit()
        
        updated = conn.execute("SELECT * FROM kanban_card_history WHERE id=?", (history_id,)).fetchone()
        return dict(updated)
    finally:
        conn.close()


@router.delete("/history/cycle", status_code=204)
def delete_history_cycle(sheet_id: int, reset_at: str, user: dict = Depends(require_admin)):
    """Admin deletes an entire reset cycle snapshot."""
    user_id = int(user["sub"])
    conn = get_db()
    try:
        cursor = conn.execute("DELETE FROM kanban_card_history WHERE sheet_id=? AND reset_at=?", (sheet_id, reset_at))
        conn.commit()
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Cycle not found or already deleted.")
            
        _log(conn, user_id, "DELETE_KANBAN_HISTORY_CYCLE", f"kanban_sheet:{sheet_id}",
             f"reset_at={reset_at} deleted={cursor.rowcount}")
        conn.commit()
    finally:
        conn.close()
