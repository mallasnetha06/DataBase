"""
database.py â€” SQLite connection and schema initialisation (WAL mode).

This file reflects the current, stable schema of dataapp.db.
All legacy migration steps and one-time seeding have been removed â€” the DB
is already in the correct state.  If you ever need to set up a fresh database
from scratch, running the app will create all tables automatically via the
CREATE TABLE IF NOT EXISTS statements below.

Tables
â”€â”€â”€â”€â”€â”€
  users               â€” all user accounts (roles, approval state, team structure)
  data_scraping       â€” scraped author/journal records with email + invoice history
  queue_meta          â€” named queue groups owned by each user
  audit_log           â€” immutable record of all significant user actions
  email_templates     â€” saved email templates created by users
  employee_profiles   â€” per-user HR profile (title, skills, responsibilities)
  kanban_sheets       â€” admin-created task sheets (templates and live sheets)
  kanban_cards        â€” per-user task cards linked to a kanban sheet
  kanban_card_history â€” end-of-cycle snapshots saved before each auto-reset
"""

import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).parent / "dataapp.db"


def get_db():
    """Return a sqlite3 connection with WAL mode and row_factory set."""
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    """Create all tables if they do not already exist, then return."""
    conn = get_db()
    cur = conn.cursor()

    cur.executescript("""
        -- â”€â”€ Users â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        -- Central account table.  Every other table references users.id.
        --
        -- role:
        --   standard   â€” data-entry operators; upload and mark emails
        --   admin      â€” team lead; manages their group of standard users
        --   manager    â€” oversees all admin teams; sees revenue and KPIs
        --   overlord   â€” full system access (super-admin)
        --   campaigner â€” runs email campaigns; has their own data view
        --   support    â€” uploads data on behalf of a campaigner (see support_for)
        --
        -- is_approved:
        --   0 = pending approval by admin/overlord
        --   1 = approved and active
        --   2 = rejected
        --
        -- team_lead_id:
        --   FK back to users.id; set on standard users to link them to their
        --   admin team lead.  NULL for admins, managers, overlords, campaigners.
        CREATE TABLE IF NOT EXISTS users (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            username      TEXT    NOT NULL UNIQUE,
            password_hash TEXT    NOT NULL,
            role          TEXT    NOT NULL DEFAULT 'standard'
                          CHECK(role IN ('standard', 'admin', 'manager', 'overlord', 'campaigner', 'support')),
            is_approved   INTEGER NOT NULL DEFAULT 0,
            team_lead_id  INTEGER REFERENCES users(id),
            created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- â”€â”€ Data Scraping â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        -- One row per unique author email address scraped from the web.
        --
        -- email_status:
        --   Unused   â€” not yet contacted
        --   Used     â€” email has been sent to this author
        --   Reserved â€” locked for a future campaign
        --
        -- queue_group:
        --   Free-text group name chosen by the uploader; links to queue_meta.queue_name
        --   for colour coding in the UI.
        --
        -- used_at:
        --   ISO timestamp of the most recent time email_status was set to 'Used'.
        --
        -- used_at_history:
        --   JSON array of ISO timestamps â€” one entry per 'Used' event, e.g.
        --   ["2026-09-01T00:00:00+00:00", "2026-09-15T08:30:00+00:00"]
        --   Used for monthly mail-count tracking per user.
        --
        -- invoices_history:
        --   JSON array of invoice objects; one entry per invoice received from
        --   this author.  Each object has the shape:
        --   {
        --     "invoice_no"     : <int>,        -- sequential per author (1, 2, 3 ...)
        --     "journal_name"   : <str>,         -- journal this invoice is for
        --     "brand"          : <str|null>,    -- brand at time of invoice
        --     "amount"         : <float>,       -- invoice amount in local currency
        --     "invoice_status" : <str>,         -- Pending | Approved | Paid | Rejected
        --     "invoice_date"   : <str>,         -- ISO date string
        --     "journal_approved": <0|1>,        -- 0 = not approved, 1 = approved
        --     "approval_date"  : <str|null>     -- ISO date string or null
        --   }
        --
        -- support_for:
        --   FK to users.id; only set when a 'support' role user uploads this row
        --   on behalf of a campaigner.  uploaded_by = support user's id,
        --   support_for = campaigner user's id.  NULL for all other uploads.
        CREATE TABLE IF NOT EXISTS data_scraping (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            date             TEXT    NOT NULL,
            website          TEXT    NOT NULL,
            keyword          TEXT    NOT NULL,
            article_title    TEXT    NOT NULL,
            author_name      TEXT    NOT NULL,
            journal_name     TEXT    NOT NULL DEFAULT '',
            email            TEXT    NOT NULL UNIQUE,
            email_status     TEXT    NOT NULL DEFAULT 'Unused'
                             CHECK(email_status IN ('Unused', 'Used', 'Reserved')),
            affiliation      TEXT,
            queue_group      TEXT,
            brand            TEXT,
            country          TEXT,
            uploaded_by      INTEGER NOT NULL REFERENCES users(id),
            support_for      INTEGER REFERENCES users(id),
            used_at          TEXT,
            used_at_history  TEXT    NOT NULL DEFAULT '[]',
            invoices_history TEXT    NOT NULL DEFAULT '[]',
            created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- â”€â”€ Queue Meta â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        -- Named, colour-coded queue groups owned by a user.
        -- data_scraping.queue_group is a free-text label that matches queue_name
        -- here so the UI can look up the display colour.
        CREATE TABLE IF NOT EXISTS queue_meta (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER NOT NULL REFERENCES users(id),
            queue_name  TEXT    NOT NULL,
            color       TEXT    NOT NULL DEFAULT '#8b5cf6',
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, queue_name)
        );

        -- â”€â”€ Audit Log â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        -- Append-only log of significant actions (approvals, role changes, etc.).
        -- Records are never updated or deleted.
        CREATE TABLE IF NOT EXISTS audit_log (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER NOT NULL,
            action      TEXT    NOT NULL,
            target      TEXT,
            detail      TEXT,
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- â”€â”€ Email Templates â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        -- Reusable email templates saved by users for outreach campaigns.
        CREATE TABLE IF NOT EXISTS email_templates (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT    NOT NULL,
            subject     TEXT    NOT NULL DEFAULT '',
            body        TEXT    NOT NULL DEFAULT '',
            created_by  INTEGER NOT NULL REFERENCES users(id),
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- â”€â”€ Employee Profiles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        -- HR-style profile for each user, editable by admins/overlords.
        -- One row per user (enforced by UNIQUE on user_id).
        --
        -- responsibilities: JSON array of strings, e.g. ["Upload data", "Send emails"]
        -- skills:           JSON array of strings, e.g. ["Excel", "Data Scraping"]
        CREATE TABLE IF NOT EXISTS employee_profiles (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id           INTEGER NOT NULL UNIQUE REFERENCES users(id),
            title             TEXT    NOT NULL DEFAULT '',
            responsibilities  TEXT    NOT NULL DEFAULT '[]',
            skills            TEXT    NOT NULL DEFAULT '[]',
            department        TEXT    NOT NULL DEFAULT 'Operations',
            updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- â”€â”€ Kanban Sheets â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        -- Admin-created task sheets.  A sheet can be a reusable template
        -- (is_template=1) or a live/active sheet (is_template=0) assigned to the team.
        --
        -- sheet_type controls the auto-reset cycle:
        --   daily   â€” cards reset each new calendar day
        --   weekly  â€” cards reset each new ISO week
        --   monthly â€” cards reset each new calendar month
        --   custom  â€” no automatic reset; admin resets manually
        --
        -- tasks_json:
        --   JSON array of task name strings, e.g. ["Email Send", "Follow Up"]
        --   The app uses this list to auto-create per-user kanban_cards rows
        --   when a sheet is assigned or first loaded.
        --
        -- last_reset_at:
        --   ISO timestamp of the most recent auto-reset on this sheet.
        --   Per-user reset granularity is tracked on kanban_cards.last_reset_at.
        CREATE TABLE IF NOT EXISTS kanban_sheets (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            title          TEXT    NOT NULL,
            sheet_type     TEXT    NOT NULL DEFAULT 'weekly'
                           CHECK(sheet_type IN ('weekly', 'monthly', 'custom', 'daily')),
            period_label   TEXT    NOT NULL DEFAULT '',
            tasks_json     TEXT    NOT NULL DEFAULT '[]',
            created_by     INTEGER NOT NULL REFERENCES users(id),
            is_template    INTEGER NOT NULL DEFAULT 0,
            last_reset_at  TEXT,
            created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- â”€â”€ Kanban Cards â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        -- One row per (sheet_id, user_id, task_name) triplet.
        -- Auto-created when a sheet is first loaded by each user.
        --
        -- status:
        --   todo       â€” not started
        --   inprogress â€” actively being worked on
        --   blocked    â€” waiting on something external
        --   done       â€” completed for this cycle
        --
        -- last_reset_at:
        --   Per-card reset timestamp so User A loading the page never triggers
        --   an auto-reset of User B's cards.
        CREATE TABLE IF NOT EXISTS kanban_cards (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            sheet_id       INTEGER NOT NULL REFERENCES kanban_sheets(id) ON DELETE CASCADE,
            user_id        INTEGER NOT NULL REFERENCES users(id),
            task_name      TEXT    NOT NULL,
            status         TEXT    NOT NULL DEFAULT 'todo'
                           CHECK(status IN ('todo', 'inprogress', 'blocked', 'done')),
            note           TEXT    NOT NULL DEFAULT '',
            position       INTEGER NOT NULL DEFAULT 0,
            last_reset_at  TEXT,
            updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- â”€â”€ Kanban Card History â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        -- Snapshot of every team member's card status captured just before an
        -- auto-reset.  Allows admins to analyse performance across past cycles.
        --
        -- period_label is copied from the parent kanban_sheet at reset time so
        -- the history record remains self-contained even if the sheet is renamed.
        CREATE TABLE IF NOT EXISTS kanban_card_history (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            sheet_id     INTEGER NOT NULL REFERENCES kanban_sheets(id) ON DELETE CASCADE,
            user_id      INTEGER NOT NULL REFERENCES users(id),
            task_name    TEXT    NOT NULL,
            final_status TEXT    NOT NULL,
            note         TEXT    NOT NULL DEFAULT '',
            period_label TEXT    NOT NULL DEFAULT '',
            reset_at     DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        -- ── Allowed Websites ────────────────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS allowed_websites (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    """)

    # ── Seed default overlord account (only when the DB has no users at all) ──
    # This block runs once on a fresh install. The credentials are printed to
    # the console exactly once so the operator knows how to log in.
    user_count = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    if user_count == 0:
        import bcrypt
        _default_username = "overlord"
        _default_password = "overlord123"
        pw_hash = bcrypt.hashpw(_default_password.encode(), bcrypt.gensalt()).decode()
        conn.execute(
            "INSERT INTO users (username, password_hash, role, is_approved) VALUES (?, ?, 'overlord', 1)",
            (_default_username, pw_hash),
        )
        conn.commit()
        print("[SEED] No users found — default overlord account created.")
        print(f"[SEED]   Username : {_default_username}")
        print(f"[SEED]   Password : {_default_password}")
        print("[SEED] Change this password after your first login!")

    # ── Seed default allowed websites ──
    _default_websites = [
        "sciencedirect", "onlinelibrary", "tandfonline", "hubmed", "sage",
        "bmc", "thelancet", "bmj", "umin", "preprints", "biorxiv",
        "medrxiv", "researchsquare", "pulsus", "mdpi"
    ]
    for w in _default_websites:
        conn.execute("INSERT OR IGNORE INTO allowed_websites (name) VALUES (?)", (w,))

    conn.commit()
    conn.close()
    print("[OK] Database initialised (WAL mode active).")

