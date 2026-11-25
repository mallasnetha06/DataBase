# DataBase — AI Support Company

A FastAPI + SQLite backend for managing article scraping, email outreach,
employee progress tracking, invoice management, and user administration.

---

## Tech Stack

| Layer      | Technology                        |
|------------|-----------------------------------|
| Backend    | FastAPI (Python)                  |
| Database   | SQLite 3 (WAL mode, FK enforced)  |
| Auth       | JWT Bearer tokens + bcrypt        |
| Validation | Pydantic v2                       |

---

## Roles

| Role       | Description                                          |
|------------|------------------------------------------------------|
| `standard` | Data Operations Specialist — scrape & email outreach |
| `admin`    | Team Lead — manages users, reviews data              |
| `manager`  | Operations Manager — invoices, revenue analytics     |
| `overlord` | System Administrator — full DB & user control        |
| `campaigner`| Campaign Manager — runs campaigns                    |
| `support`  | Support Specialist — assists campaigners             |

---

## Database Schema

```text
                      ┌─────────────────────────────────┐
                      │             users               │
                      │  Used by: ALL roles (auth core) │
                      ├─────────────────────────────────┤
                      │ PK id            INTEGER        │
                      │    username      TEXT UNIQUE    │
                      │    password_hash TEXT           │
                      │    role          TEXT           │
                      │    │  CHECK: standard | admin   │
                      │    │         manager | overlord │
                      │    │         campaigner| support│
                      │    is_approved   INTEGER        │
                      │    │  0=pending 1=approved      │
                      │    │  2=rejected                │
                      │ FK team_lead_id  INTEGER        │
                      │    created_at    DATETIME       │
                      └────┬────────────────────────────┘
                           │ id  (FK referenced by all tables below)
         ┌─────────────────┼──────────────────────────────────────────┐
         │                 │                  │                       │
         ▼                 ▼                  ▼                       ▼
┌──────────────────────┐  ┌──────────────┐  ┌───────────────────┐  ┌────────────────────────┐
│    data_scraping     │  │  queue_meta  │  │    kanban_sheets  │  │    email_templates     │
│ standard, admin,     │  │ standard,    │  │ admin, overlord   │  │ admin, overlord        │
│ overlord, support    │  │ admin        │  │                   │  ├────────────────────────┤
├──────────────────────┤  ├──────────────┤  ├───────────────────┤  │ PK id        INTEGER   │
│ PK id      INTEGER   │  │ PK id  INT   │  │ PK id   INTEGER   │  │    name      TEXT      │
│    date    TEXT      │  │ FK user_id   │  │    title TEXT     │  │    subject   TEXT      │
│    website TEXT      │  │    queue_name│  │    sheet_type     │  │    body      TEXT      │
│    keyword TEXT      │  │    color TEXT│  │    tasks_json     │  │ FK created_by → users  │
│    article_title     │  │    created_at│  │    is_template    │  │    created_at DATETIME │
│    author_name       │  │    UNIQUE    │  │ FK created_by     │  │    updated_at DATETIME │
│    journal_name      │  │  (user_id,   │  │    last_reset_at  │  └────────────────────────┘
│    email   UNIQUE    │  │  queue_name) │  │    created_at     │
│    email_status      │  └──────────────┘  │    updated_at     │
│    CHECK: Unused     │                    └─────────┬─────────┘
│          Used        │                              │
│          Reserved    │                              ▼
│    affiliation TEXT  │                    ┌───────────────────┐  ┌────────────────────────┐
│    queue_group TEXT  │                    │    kanban_cards   │  │  kanban_card_history   │
│    brand       TEXT  │                    ├───────────────────┤  ├────────────────────────┤
│    country     TEXT  │                    │ PK id   INTEGER   │  │ PK id   INTEGER        │
│ FK uploaded_by       │                    │ FK sheet_id       │  │ FK sheet_id            │
│ FK support_for       │                    │ FK user_id        │  │ FK user_id             │
│    used_at TEXT      │                    │    task_name TEXT │  │    task_name TEXT      │
│    used_at_history   │                    │    status TEXT    │  │    final_status TEXT   │
│    invoices_history  │                    │    note TEXT      │  │    note TEXT           │
│    created_at        │                    │    position INT   │  │    period_label TEXT   │
│    updated_at        │                    │    last_reset_at  │  │    reset_at DATETIME   │
└──────────────────────┘                    │    updated_at     │  └────────────────────────┘
                                            └───────────────────┘

                    ┌─────────────────────────────────────────────┐
                    │  audit_log   (overlord read-only)           │
                    ├─────────────────────────────────────────────┤
                    │ PK id        INTEGER                        │
                    │    user_id   INTEGER  (no FK constraint)    │
                    │    action    TEXT                           │
                    │    target    TEXT                           │
                    │    detail    TEXT                           │
                    │    created_at DATETIME                      │
                    └─────────────────────────────────────────────┘

           ┌──────────────────────────────────────────────────────┐
           │          employee_profiles                           │
           │  Used by: ALL roles (self-view) / overlord (edit)    │
           └──────────┬───────────────────────────────────────────┘
                      │
                      ▼
        ┌─────────────────────────────┐
        │      employee_profiles      │
        ├─────────────────────────────┤
        │ PK id             INTEGER   │
        │ FK user_id  UNIQUE → users  │
        │    title          TEXT      │
        │    responsibilities TEXT    │
        │    │  (JSON array)          │
        │    skills         TEXT      │
        │    │  (JSON array)          │
        │    department     TEXT      │
        │    updated_at     DATETIME  │
        └─────────────────────────────┘
```

---

## Role → Table Access Matrix

| Table                | standard | admin  | manager | overlord | campaigner | support |
|----------------------|:--------:|:------:|:-------:|:--------:|:----------:|:-------:|
| `users`              | read self| ✅ full| read self| ✅ full  | read self  | read self|
| `data_scraping`      | ✅ full  | ✅ full| —       | ✅ full  | ✅ full    | ✅ full |
| `queue_meta`         | ✅ full  | ✅ full| —       | ✅ full  | ✅ full    | ✅ full |
| `email_templates`    | read     | ✅ full| —       | ✅ full  | read       | read    |
| `audit_log`          | —        | —      | —       | ✅ read  | —          | —       |
| `kanban_sheets`      | read     | ✅ full| —       | ✅ full  | read       | read    |
| `kanban_cards`       | ✅ full  | ✅ full| —       | ✅ full  | ✅ full    | ✅ full |
| `employee_profiles`  | read self| ✅ full| ✅ read | ✅ full  | read self  | read self|

---

## Relationships Summary

```
users ──< data_scraping       (uploaded_by, support_for)
users ──< queue_meta          (user_id)
users ──< email_templates     (created_by)
users ──< kanban_sheets       (created_by)
users ──< kanban_cards        (user_id)
users ──< kanban_card_history (user_id)
users ──| employee_profiles   (user_id — 1-to-1 UNIQUE)
```

---

## Default Seeded Accounts

| Username   | Password      | Role       |
|------------|---------------|------------|
| `admin`    | `admin123`    | admin      |
| `manager`  | `manager123`  | manager    |
| `overlord` | `overlord123` | overlord   |

> ⚠️ Change all default passwords immediately after first deployment.

---

## Running the App

```bash
# Install dependencies
pip install -r requirements.txt

# Start the server (Windows)
start.bat

# Or directly
uvicorn main:app --reload
```

API docs available at: `http://localhost:8000/docs`
