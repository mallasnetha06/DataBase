"""
models.py — Pydantic schemas for request/response validation.
"""
from pydantic import BaseModel
from typing import Optional, List, Any


# ── Auth ──────────────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    username: str
    password: str


class RegisterRequest(BaseModel):
    username: str
    password: str
    role: str = "standard"          # 'standard' | 'campaigner' | 'support'
    team_lead_id: Optional[int] = None  # set when a standard user picks their team lead


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: str
    username: str
    user_id: int


# ── Users ─────────────────────────────────────────────────────────────────────

class UserCreate(BaseModel):
    username: str
    password: str
    role: str = "standard"


class UserResponse(BaseModel):
    id: int
    username: str
    role: str
    is_approved: int
    team_lead_id: Optional[int]
    created_at: str


class ApproveUserRequest(BaseModel):
    is_approved: int  # 1 = approved, 2 = rejected


class PasswordResetRequest(BaseModel):
    new_password: str  # overlord-only: forcibly set a user's password


class RenameRequest(BaseModel):
    new_username: str  # authenticated user: rename their own account


class RoleChangeRequest(BaseModel):
    role: str  # overlord-only: 'standard' | 'admin' | 'manager' | 'overlord' | 'support'


# ── Data Scraping ──────────────────────────────────────────────────────────────

class ScrapingCreate(BaseModel):
    date: str
    website: str
    keyword: str
    article_title: str
    author_name: str
    journal_name: str
    email: str
    affiliation: Optional[str] = None
    brand: Optional[str] = None
    country: Optional[str] = None


class ScrapingUpdate(BaseModel):
    date: Optional[str] = None
    website: Optional[str] = None
    keyword: Optional[str] = None
    article_title: Optional[str] = None
    author_name: Optional[str] = None
    journal_name: Optional[str] = None
    email: Optional[str] = None
    email_status: Optional[str] = None
    affiliation: Optional[str] = None
    brand: Optional[str] = None
    country: Optional[str] = None



class ScrapingStatusPatch(BaseModel):
    email_status: str


class ScrapingResponse(BaseModel):
    id: int
    date: str
    website: str
    keyword: str
    article_title: str
    author_name: str
    journal_name: str
    email: str
    email_status: str
    affiliation: Optional[str]
    queue_group: Optional[str]
    brand: Optional[str]
    country: Optional[str]
    uploaded_by: int
    uploaded_by_username: Optional[str]
    support_for: Optional[int]           # campaigner user_id when uploaded by a support user
    support_for_username: Optional[str]  # campaigner username when uploaded by a support user
    used_at: Optional[str]                # ISO timestamp of most-recent Used event
    used_at_history: Optional[str]        # JSON array of all Used-event timestamps
    mail_count_month: Optional[int]       # how many times mailed in current calendar month

    created_at: str
    updated_at: str


# ── Queue Grouping ─────────────────────────────────────────────────────────────

class QueueAssignRequest(BaseModel):
    queue_name: str
    record_ids: List[int]
    color: str = "#8b5cf6"


class QueueClearRequest(BaseModel):
    record_ids: List[int]



# ── Kanban Sheets ──────────────────────────────────────────────────────────────

class KanbanSheetCreate(BaseModel):
    title:        str
    sheet_type:   str = "weekly"   # weekly | monthly | custom
    period_label: str = ""
    tasks_json:   str = "[]"       # JSON array of task name strings
    is_template:  int = 0          # 1 = reusable template


class KanbanSheetUpdate(BaseModel):
    title:        Optional[str] = None
    sheet_type:   Optional[str] = None
    period_label: Optional[str] = None
    tasks_json:   Optional[str] = None
    is_template:  Optional[int] = None


class KanbanSheetResponse(BaseModel):
    id:           int
    title:        str
    sheet_type:   str
    period_label: str
    tasks_json:   str
    created_by:   int
    creator_name: Optional[str]
    is_template:  int
    created_at:   str
    updated_at:   str


# ── Kanban Cards ───────────────────────────────────────────────────────────────

class KanbanHistoryStatusPatch(BaseModel):
    final_status: str


class KanbanCardPatch(BaseModel):
    status: Optional[str] = None   # todo | inprogress | blocked | done
    note:   Optional[str] = None


class KanbanCardResponse(BaseModel):
    id:        int
    sheet_id:  int
    user_id:   int
    username:  Optional[str]
    task_name: str
    status:    str
    note:      str
    position:  int
    updated_at: str


# ── Kanban Assign ──────────────────────────────────────────────────────────────

class KanbanAssignRequest(BaseModel):
    user_ids: List[int]   # list of user IDs to assign the sheet to


# ── Email Templates ────────────────────────────────────────────────────────────

class TemplateCreate(BaseModel):
    name: str
    subject: str = ""
    body: str = ""


class TemplateUpdate(BaseModel):
    name: Optional[str] = None
    subject: Optional[str] = None
    body: Optional[str] = None


class TemplateResponse(BaseModel):
    id: int
    name: str
    subject: str
    body: str
    created_by: int
    creator_name: Optional[str]
    created_at: str
    updated_at: str


# ── Overlord — Raw DB Access ───────────────────────────────────────────────────

class RawQueryRequest(BaseModel):
    sql: str
    params: Optional[List[Any]] = None  # positional ? parameters


class RawQueryResponse(BaseModel):
    columns: List[str]
    rows: List[List[Any]]
    row_count: int


class RawExecRequest(BaseModel):
    sql: str
    params: Optional[List[Any]] = None


class RawExecResponse(BaseModel):
    rows_affected: int
    last_insert_id: Optional[int]
    message: str


# ── Manager — Invoices ─────────────────────────────────────────────────────────

class InvoiceResponse(BaseModel):
    id: int
    client_name: str
    journal_name: str
    amount: float
    status: str
    approved_by: Optional[int]
    invoice_date: str
    created_at: str


class InvoiceCreate(BaseModel):
    client_name: str
    journal_name: str
    amount: float
    invoice_date: str
    status: str = "Pending"


class InvoicePatch(BaseModel):
    status: str


# ── Manager — Journal Approvals ────────────────────────────────────────────────

class JournalApprovalResponse(BaseModel):
    id: int
    journal_name: str
    client_name: str
    approved_by: Optional[int]
    revenue: float
    approval_date: str
    created_at: str


class JournalApprovalCreate(BaseModel):
    journal_name: str
    client_name: str
    revenue: float
    approval_date: str


# ── Employee Progress — Invoice & Approval PATCH models ───────────────────────

class ScrapingInvoicePatch(BaseModel):
    """PATCH invoice fields on a data_scraping row (admin-only).

    invoice_no: if supplied → update that specific entry in invoices_history in-place.
                if None     → append a new entry (original behaviour).
    """
    invoice_no: Optional[int] = None       # target entry to update; None = append new
    amount: Optional[float] = None
    invoice_status: Optional[str] = None   # Pending | Approved | Paid | Rejected
    invoice_date: Optional[str] = None     # ISO date string


class ScrapingApprovalPatch(BaseModel):
    """PATCH journal approval fields on a data_scraping row (admin-only)."""
    journal_approved: Optional[int] = None  # 0 or 1
    approval_date: Optional[str] = None     # ISO date string


class ScrapingBrandPatch(BaseModel):
    """PATCH brand field on a data_scraping row (admin-only)."""
    brand: str  # must be non-empty


class EmployeeProfileUpdate(BaseModel):
    title: Optional[str] = None
    responsibilities: Optional[List[str]] = None
    skills: Optional[List[str]] = None
    department: Optional[str] = None


class EmployeeProfileResponse(BaseModel):
    user_id: int
    username: str
    role: str
    title: str
    responsibilities: List[str]
    skills: List[str]
    department: str
    updated_at: str
