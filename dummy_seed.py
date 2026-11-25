"""
dummy_seed.py — One-shot script that creates/resets dummy_dataapp.db with
demo data for presentation purposes.

Run once before launching dummy.bat:
    python dummy_seed.py

The script:
  1. Deletes any existing dummy_dataapp.db so every run starts fresh.
  2. Initialises the full schema via database.init_db() pointed at the dummy file.
  3. Seeds users (ranjeeta/sandeep as admins, four standard team members).
  4. Seeds data_scraping rows with realistic author/journal/invoice records.
  5. Seeds kanban sheets + live cards + 14 days of card history (for charts).
  6. Seeds manager-level invoices table records.

This file does NOT import from main.py or modify any production files.
The original dataapp.db is never touched.
"""

import json
import os
import sqlite3
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
import random

# ── Point database module at the DUMMY file BEFORE any import ─────────────────
DUMMY_DB = Path(__file__).parent / "dummy_dataapp.db"
os.environ["DUMMY_DB_PATH"] = str(DUMMY_DB)

# Delete old dummy DB so we always start clean
if DUMMY_DB.exists():
    DUMMY_DB.unlink()
    print(f"[RESET] Deleted old {DUMMY_DB.name}")

# ── Inline minimal schema (mirrors database.py exactly) ───────────────────────
# We do NOT call database.init_db() because that reads DB_PATH from module
# scope. Instead we replicate just enough here for a clean seed.

SCHEMA_SQL = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

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

CREATE TABLE IF NOT EXISTS data_scraping (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    date             TEXT    NOT NULL,
    website          TEXT    NOT NULL,
    keyword          TEXT    NOT NULL,
    article_title    TEXT    NOT NULL,
    author_name      TEXT    NOT NULL,
    journal_name     TEXT    NOT NULL,
    email            TEXT    NOT NULL UNIQUE,
    email_status     TEXT    NOT NULL DEFAULT 'Unused'
                     CHECK(email_status IN ('Unused', 'Used', 'Reserved')),
    affiliation      TEXT,
    queue_group      TEXT,
    brand            TEXT,
    country          TEXT,
    uploaded_by      INTEGER NOT NULL REFERENCES users(id),
    used_at          TEXT,
    used_at_history  TEXT    NOT NULL DEFAULT '[]',
    invoices_history TEXT    NOT NULL DEFAULT '[]',
    support_for      INTEGER REFERENCES users(id),
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS queue_meta (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    queue_name  TEXT    NOT NULL,
    color       TEXT    NOT NULL DEFAULT '#8b5cf6',
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, queue_name)
);

CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    action      TEXT    NOT NULL,
    target      TEXT,
    detail      TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS email_templates (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    subject     TEXT    NOT NULL DEFAULT '',
    body        TEXT    NOT NULL DEFAULT '',
    created_by  INTEGER NOT NULL REFERENCES users(id),
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);



CREATE TABLE IF NOT EXISTS employee_profiles (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           INTEGER NOT NULL UNIQUE REFERENCES users(id),
    title             TEXT    NOT NULL DEFAULT '',
    responsibilities  TEXT    NOT NULL DEFAULT '[]',
    skills            TEXT    NOT NULL DEFAULT '[]',
    department        TEXT    NOT NULL DEFAULT 'Operations',
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS kanban_sheets (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    title          TEXT    NOT NULL,
    sheet_type     TEXT    NOT NULL DEFAULT 'weekly'
                   CHECK(sheet_type IN ('weekly','monthly','custom','daily')),
    period_label   TEXT    NOT NULL DEFAULT '',
    tasks_json     TEXT    NOT NULL DEFAULT '[]',
    created_by     INTEGER NOT NULL REFERENCES users(id),
    is_template    INTEGER NOT NULL DEFAULT 0,
    last_reset_at  TEXT,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS kanban_cards (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    sheet_id       INTEGER NOT NULL REFERENCES kanban_sheets(id) ON DELETE CASCADE,
    user_id        INTEGER NOT NULL REFERENCES users(id),
    task_name      TEXT    NOT NULL,
    status         TEXT    NOT NULL DEFAULT 'todo'
                   CHECK(status IN ('todo','inprogress','blocked','done')),
    note           TEXT    NOT NULL DEFAULT '',
    position       INTEGER NOT NULL DEFAULT 0,
    last_reset_at  TEXT,
    updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);

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
"""

# ── Helper ────────────────────────────────────────────────────────────────────

def get_conn():
    conn = sqlite3.connect(str(DUMMY_DB), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def ts(d: date, hour: int = 9) -> str:
    """Return ISO timestamp string for a given date and hour (UTC)."""
    return datetime(d.year, d.month, d.day, hour, 0, 0, tzinfo=timezone.utc).isoformat()


# ── Seed helpers ──────────────────────────────────────────────────────────────

DAILY_TASKS = ["100 mails", "data collection", "ET", "admin", "cmts"]

# Brand → journal name mappings for realistic scraping data
BRAND_JOURNALS = {
    "ABAcademics": [
        "Journal of Applied Biology",
        "International Review of Applied Chemistry",
        "ABA Research Quarterly",
    ],
    "primeScholarLibrary": [
        "Prime Medical Sciences Review",
        "Scholar Library Advances",
        "PSL Journal of Engineering",
    ],
    "Interesjournal": [
        "Interes Journal of Physics",
        "International Ecology Letters",
        "Interes Computational Research",
    ],
    "scitechnol": [
        "SciTechnol Journal of Biochemistry",
        "Journal of Advanced Technology",
        "SciTechnol Clinical Reports",
    ],
    "omics": [
        "OMICS Journal of Genomics",
        "OMICS Proteomics Review",
        "Journal of Pharmacogenomics",
    ],
    "pulsus": [
        "Pulsus Journal of Cardiology",
        "Pulsus Neurology Reports",
        "Pulsus Medical Case Studies",
    ],
}

COUNTRIES = ["USA", "UK", "India", "Germany", "Australia", "Canada", "Japan", "Brazil", "France", "Italy"]
AFFILIATIONS = [
    "Harvard Medical School",
    "University of Tokyo",
    "Indian Institute of Technology",
    "University of Oxford",
    "MIT",
    "Stanford University",
    "University of Cambridge",
    "ETH Zurich",
    "National University of Singapore",
    "University of Melbourne",
]

FIRST_NAMES = [
    "James", "Maria", "David", "Sarah", "Michael", "Emily", "Robert", "Priya",
    "Wei", "Fatima", "Ahmed", "Sophie", "Carlos", "Yuki", "Lena", "Raj",
    "Ivan", "Anna", "Liu", "Aisha", "Pedro", "Hana", "Marco", "Nina",
    "Kevin", "Grace", "Thomas", "Elena", "Ali", "Chen",
]
LAST_NAMES = [
    "Smith", "Johnson", "Chen", "Patel", "Garcia", "Kim", "Muller", "Ibrahim",
    "Wang", "Martinez", "Brown", "Wilson", "Anderson", "Taylor", "Lee",
    "Kumar", "Nguyen", "Ivanov", "Rossi", "Yamamoto", "Santos", "Fischer",
    "Okafor", "Sharma", "Kowalski", "Park", "Nakamura", "Ali", "Das", "Ferreira",
]

KEYWORDS = [
    "cancer therapy", "machine learning", "climate change", "drug delivery",
    "genomics", "neural networks", "renewable energy", "protein folding",
    "epidemiology", "materials science",
]

WEBSITES = [
    "pubmed.ncbi.nlm.nih.gov",
    "scholar.google.com",
    "researchgate.net",
    "semanticscholar.org",
    "academia.edu",
]

INVOICE_STATUSES = ["Pending", "Approved", "Paid", "Rejected"]
INVOICE_STATUS_WEIGHTS = [0.2, 0.35, 0.4, 0.05]


def random_author(idx: int) -> tuple:
    """Return (name, email) for a unique dummy author."""
    first = FIRST_NAMES[idx % len(FIRST_NAMES)]
    last  = LAST_NAMES[(idx * 7 + 3) % len(LAST_NAMES)]
    name  = f"{first} {last}"
    email = f"{first.lower()}.{last.lower()}{idx}@dummymail.test"
    return name, email


def random_invoice_history(journal_name: str, brand: str, base_date: date, count: int = 1) -> list:
    """Generate count invoice entries for an author."""
    history = []
    for i in range(count):
        inv_date = base_date - timedelta(days=random.randint(0, 60))
        amount   = round(random.uniform(500, 2500), 2)
        status   = random.choices(INVOICE_STATUSES, weights=INVOICE_STATUS_WEIGHTS)[0]
        approved = 1 if status in ("Approved", "Paid") else 0
        appr_date = (inv_date + timedelta(days=random.randint(3, 14))).isoformat() if approved else None
        history.append({
            "invoice_no"      : i + 1,
            "journal_name"    : journal_name,
            "brand"           : brand,
            "amount"          : amount,
            "invoice_status"  : status,
            "invoice_date"    : inv_date.isoformat(),
            "journal_approved": approved,
            "approval_date"   : appr_date,
        })
    return history


# ── Status distribution for history records ───────────────────────────────────
# Varied per-user so charts look realistic

USER_PROFILES = {
    # (done_pct, inprogress_pct) rest = todo
    "ranjeeta" : (0.75, 0.15),
    "sandeep"  : (0.70, 0.20),
    "saivamshi": (0.80, 0.10),
    "akshay"   : (0.65, 0.25),
    "snetha"   : (0.72, 0.18),
    "rista"    : (0.60, 0.30),
}


def pick_status(username: str, rng: random.Random) -> str:
    done_p, ip_p = USER_PROFILES.get(username, (0.65, 0.20))
    r = rng.random()
    if r < done_p:
        return "done"
    if r < done_p + ip_p:
        return "inprogress"
    return "todo"


# ═════════════════════════════════════════════════════════════════════════════
# MAIN SEED
# ═════════════════════════════════════════════════════════════════════════════

def main():
    import bcrypt

    random.seed(42)  # reproducible
    rng = random.Random(42)

    conn = get_conn()
    cur  = conn.cursor()

    # ── 1. Schema ─────────────────────────────────────────────────────────────
    cur.executescript(SCHEMA_SQL)
    conn.commit()
    print("[OK] Schema created.")

    # ── 2. Users ──────────────────────────────────────────────────────────────
    def make_hash(pw: str) -> str:
        return bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()

    admin_pw   = make_hash("admin123")
    std_pw     = make_hash("user123")
    manager_pw = make_hash("manager123")
    overlord_pw = make_hash("overlord123")

    # Insert overlord & manager (needed for full app functionality)
    cur.execute(
        "INSERT INTO users (username, password_hash, role, is_approved) VALUES (?,?,'overlord',1)",
        ("overlord", overlord_pw),
    )
    cur.execute(
        "INSERT INTO users (username, password_hash, role, is_approved) VALUES (?,?,'manager',1)",
        ("manager", manager_pw),
    )

    # Admins
    cur.execute(
        "INSERT INTO users (username, password_hash, role, is_approved) VALUES (?,?,'admin',1)",
        ("ranjeeta", admin_pw),
    )
    cur.execute(
        "INSERT INTO users (username, password_hash, role, is_approved) VALUES (?,?,'admin',1)",
        ("sandeep", admin_pw),
    )

    conn.commit()

    ranjeeta_id = cur.execute("SELECT id FROM users WHERE username='ranjeeta'").fetchone()[0]
    sandeep_id  = cur.execute("SELECT id FROM users WHERE username='sandeep'").fetchone()[0]

    # Standard members — ranjeeta's team
    for uname in ("saivamshi", "akshay"):
        cur.execute(
            "INSERT INTO users (username, password_hash, role, is_approved, team_lead_id) VALUES (?,?,'standard',1,?)",
            (uname, std_pw, ranjeeta_id),
        )

    # Standard members — sandeep's team
    for uname in ("snetha", "rista"):
        cur.execute(
            "INSERT INTO users (username, password_hash, role, is_approved, team_lead_id) VALUES (?,?,'standard',1,?)",
            (uname, std_pw, sandeep_id),
        )

    conn.commit()
    print("[OK] Users seeded (ranjeeta, sandeep + 4 team members).")

    # Fetch all user IDs
    all_users = {
        row["username"]: row["id"]
        for row in cur.execute("SELECT id, username FROM users").fetchall()
    }

    ranjeeta_members = [all_users["saivamshi"], all_users["akshay"]]
    sandeep_members  = [all_users["snetha"],    all_users["rista"]]

    # Uploader mapping: ranjeeta's team uploads for ranjeeta's brands, etc.
    BRAND_UPLOADER = {
        "ABAcademics"        : ranjeeta_id,
        "primeScholarLibrary": ranjeeta_id,
        "Interesjournal"     : ranjeeta_id,
        "scitechnol"         : sandeep_id,
        "omics"              : sandeep_id,
        "pulsus"             : sandeep_id,
    }

    # ── 3. Employee Profiles ──────────────────────────────────────────────────
    role_profiles = {
        "standard": {
            "title": "Data Operations Specialist",
            "department": "Operations",
            "responsibilities": json.dumps([
                "Scrape and collect author/journal data",
                "Maintain data accuracy and completeness",
                "Update email statuses after outreach",
                "Report daily task progress",
            ]),
            "skills": json.dumps(["Data Scraping", "Email Outreach", "Excel", "Attention to Detail"]),
        },
        "admin": {
            "title": "Team Lead — Data Operations",
            "department": "Operations",
            "responsibilities": json.dumps([
                "Manage and approve team member accounts",
                "Oversee email campaign execution",
                "Review and validate scraped data",
                "Track team KPIs and progress",
                "Coordinate with manager on campaign strategy",
            ]),
            "skills": json.dumps(["Team Management", "Campaign Planning", "Data Analysis", "Reporting", "CRM Tools"]),
        },
        "manager": {
            "title": "Operations Manager",
            "department": "Management",
            "responsibilities": json.dumps([
                "Set team targets and KPIs",
                "Manage budgets and invoicing",
                "Coordinate cross-team campaigns",
            ]),
            "skills": json.dumps(["Leadership", "Budgeting", "Strategic Planning", "Analytics"]),
        },
        "overlord": {
            "title": "System Administrator",
            "department": "IT",
            "responsibilities": json.dumps(["Full system access and user management"]),
            "skills": json.dumps(["System Admin", "Database Management", "Security"]),
        },
    }

    for row in cur.execute("SELECT id, role FROM users").fetchall():
        p = role_profiles.get(row["role"], role_profiles["standard"])
        cur.execute(
            "INSERT OR IGNORE INTO employee_profiles (user_id, title, responsibilities, skills, department) VALUES (?,?,?,?,?)",
            (row["id"], p["title"], p["responsibilities"], p["skills"], p["department"]),
        )
    conn.commit()
    print("[OK] Employee profiles seeded.")

    # ── 4. Data Scraping Records ──────────────────────────────────────────────
    today = date.today()
    author_idx = 0

    for brand, journals in BRAND_JOURNALS.items():
        uploader_id = BRAND_UPLOADER[brand]
        records_per_brand = 32  # ~32 authors per brand → ~192 total

        for i in range(records_per_brand):
            author_name, email = random_author(author_idx)
            author_idx += 1

            journal  = journals[i % len(journals)]
            keyword  = KEYWORDS[i % len(KEYWORDS)]
            website  = WEBSITES[i % len(WEBSITES)]
            country  = COUNTRIES[i % len(COUNTRIES)]
            affil    = AFFILIATIONS[i % len(AFFILIATIONS)]
            rec_date = (today - timedelta(days=rng.randint(1, 90))).isoformat()
            article  = f"A study on {keyword} using {journal.split()[0]} methods"

            # 60% Used, 40% Unused — Used ones get invoice history
            if i % 5 < 3:   # 60 % used
                email_status = "Used"
                used_dt = datetime(
                    today.year, today.month, today.day,
                    rng.randint(8, 18), rng.randint(0, 59),
                    tzinfo=timezone.utc,
                ) - timedelta(days=rng.randint(0, 45))
                used_at_str     = used_dt.isoformat()
                used_at_history = json.dumps([used_at_str])

                # 70% of used authors have at least one invoice
                inv_count = 1 if rng.random() < 0.7 else 0
                if inv_count:
                    inv_history = random_invoice_history(
                        journal_name=journal,
                        brand=brand,
                        base_date=today - timedelta(days=rng.randint(0, 45)),
                        count=rng.choices([1, 2], weights=[0.75, 0.25])[0],
                    )
                else:
                    inv_history = []
            else:
                email_status    = "Unused"
                used_at_str     = None
                used_at_history = "[]"
                inv_history     = []

            cur.execute(
                """INSERT INTO data_scraping
                   (date, website, keyword, article_title, author_name, journal_name,
                    email, email_status, affiliation, brand, country,
                    uploaded_by, used_at, used_at_history, invoices_history)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    rec_date, website, keyword, article_title := article, author_name,
                    journal, email, email_status, affil, brand, country,
                    uploader_id, used_at_str, used_at_history, json.dumps(inv_history),
                ),
            )

    conn.commit()
    total_records = cur.execute("SELECT COUNT(*) FROM data_scraping").fetchone()[0]
    print(f"[OK] Data scraping: {total_records} records seeded across 6 brands.")


    # ── 6. Kanban Sheets ──────────────────────────────────────────────────────
    tasks_json = json.dumps(DAILY_TASKS)
    today_str  = today.isoformat()

    def create_sheet(admin_id: int, admin_name: str) -> int:
        sheet_title = f"{admin_name.capitalize()} Team — Daily Tasks"
        cur.execute(
            """INSERT INTO kanban_sheets
               (title, sheet_type, period_label, tasks_json, created_by, is_template, last_reset_at)
               VALUES (?,?,?,?,?,0,?)""",
            (sheet_title, "daily", today_str, tasks_json, admin_id, today_str),
        )
        return cur.lastrowid

    ranjeeta_sheet = create_sheet(ranjeeta_id, "ranjeeta")
    sandeep_sheet  = create_sheet(sandeep_id,  "sandeep")
    conn.commit()
    print(f"[OK] Kanban sheets created: sheet#{ranjeeta_sheet} (ranjeeta), sheet#{sandeep_sheet} (sandeep).")

    TEAM_SHEETS = [
        (ranjeeta_sheet, ranjeeta_id, ranjeeta_members),
        (sandeep_sheet,  sandeep_id,  sandeep_members),
    ]

    # ── 7. Kanban Cards — today + 14 days of history ─────────────────────────
    #
    # /progress/stats groups kanban_cards by DATE(updated_at), so to get
    # rich "Tasks by Date" bar chart data we insert one row per
    # (sheet, user, task, day) with the appropriate updated_at timestamp.
    # The "live" cards (today) represent what the user sees on screen;
    # past-day rows provide historic chart data.

    live_card_rows = 0
    history_rows   = 0

    for days_back in range(0, 15):   # 0 = today, 1–14 = past days
        past_day   = today - timedelta(days=days_back)
        past_label = past_day.isoformat()
        # Spread card timestamps throughout working hours for that day
        hour        = rng.randint(9, 17)
        card_ts     = datetime(past_day.year, past_day.month, past_day.day,
                               hour, rng.randint(0, 59), 0,
                               tzinfo=timezone.utc).isoformat()
        reset_ts    = datetime(past_day.year, past_day.month, past_day.day,
                               18, 0, 0, tzinfo=timezone.utc).isoformat()

        for sheet_id, admin_id, member_ids in TEAM_SHEETS:
            all_member_ids = [admin_id] + member_ids
            for uid in all_member_ids:
                uname = next(u for u, i in all_users.items() if i == uid)
                for pos, task in enumerate(DAILY_TASKS):
                    if uid == admin_id:
                        # Admins finish most tasks every day
                        status = "done" if pos < 4 else rng.choice(["done", "inprogress"])
                    else:
                        status = pick_status(uname, rng)

                    if days_back == 0:
                        # TODAY: insert as live kanban_cards row (what user sees)
                        cur.execute(
                            """INSERT INTO kanban_cards
                               (sheet_id, user_id, task_name, status, note,
                                position, last_reset_at, updated_at)
                               VALUES (?,?,?,?,?,?,?,?)""",
                            (sheet_id, uid, task, status, "",
                             pos, today_str, card_ts),
                        )
                        live_card_rows += 1
                    else:
                        # PAST DAYS: insert ONLY into kanban_card_history
                        # (kanban_cards is exclusively for live cards)
                        cur.execute(
                            """INSERT INTO kanban_card_history
                               (sheet_id, user_id, task_name, final_status,
                                note, period_label, reset_at)
                               VALUES (?,?,?,?,?,?,?)""",
                            (sheet_id, uid, task, status, "", past_label, reset_ts),
                        )
                        history_rows += 1

    conn.commit()
    print(f"[OK] Kanban live cards: {live_card_rows} (today).")
    print(f"[OK] Kanban history cards: {history_rows} rows over 14 days (also stored in kanban_card_history).")

    # ── 8. Summary ───────────────────────────────────────────────────────────
    print()
    print("=" * 60)
    print(" Dummy database ready!")
    print(f" File   : {DUMMY_DB}")
    print(f" Size   : {DUMMY_DB.stat().st_size / 1024:.1f} KB")
    print()
    print(" Credentials:")
    print("   ranjeeta  / admin123  (admin — ABAcademics, primeScholarLibrary, Interesjournal)")
    print("   sandeep   / admin123  (admin — scitechnol, omics, pulsus)")
    print("   saivamshi / user123   (team member of ranjeeta)")
    print("   akshay    / user123   (team member of ranjeeta)")
    print("   snetha    / user123   (team member of sandeep)")
    print("   rista     / user123   (team member of sandeep)")
    print("   manager   / manager123")
    print("   overlord  / overlord123")
    print()
    print(" Start dummy server:  dummy.bat")
    print(" URL                : http://localhost:8001")
    print("=" * 60)

    conn.close()


if __name__ == "__main__":
    main()
