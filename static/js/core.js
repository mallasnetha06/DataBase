/* ═══════════════════════════════════════════════════════════════════════════
   DataBase — js/core.js
   Global state · API helpers · Shared utility functions · App init
═══════════════════════════════════════════════════════════════════════════ */

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let token       = null;
let currentUser = null;

// Scraping — All Records
let scrapingPage   = 1;
let scrapingSearch = '';
let scrapingStatus = 'All';

// Scraping — My Collection
let minePage = 1;

// All possible columns in My Collection (key → header label)
const MINE_ALL_COLS = [
  { key: 'date',          label: 'Date' },
  { key: 'author_name',   label: 'Author' },
  { key: 'article_title', label: 'Article Title' },
  { key: 'journal_name',  label: 'Journal Name' },
  { key: 'email',         label: 'Email' },
  { key: 'email_status',  label: 'Status' },
  { key: 'queue_group',   label: 'Queue' },
  { key: 'keyword',       label: 'Keyword' },
  { key: 'website',       label: 'Website' },
  { key: 'affiliation',   label: 'Affiliation' },
  { key: 'update_status', label: 'Update Status' },
];
// Keys visible by default (action col is always present)
let mineVisibleCols = ['date','author_name','article_title','journal_name','email','email_status','queue_group','keyword','website','affiliation','update_status'];

// Progress — Mine
let myProgressPage         = 1;
let myProgressStatusFilter = 'All';
let myProgressDateFilter   = '';

// Progress — Team
let teamProgressPage         = 1;
let teamProgressStatusFilter = 'All';
let teamProgressDateFilter   = '';

// Audit
let auditPage = 1;

// Charts
const charts = {};

let _searchTimer = null;


// ── API Helper ────────────────────────────────────────────────────────────────
async function api(method, url, body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (token) opts.headers['Authorization'] = `Bearer ${token}`;
  if (body)  opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  if (res.status === 204) return null;

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.detail || `HTTP ${res.status}`;
    throw new Error(Array.isArray(msg) ? msg.map(e => e.msg).join(', ') : msg);
  }
  return data;
}

async function apiForm(url, formData) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: formData,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}


// ── Utilities ─────────────────────────────────────────────────────────────────
function fmtDate(str) {
  if (!str) return '—';
  // Handle yyyy-mm-dd or ISO strings → dd-mm-yyyy
  const norm = String(str).replace(/(\d{4})-(\d{2})-(\d{2}).*/, '$3-$2-$1');
  if (/^\d{2}-\d{2}-\d{4}$/.test(norm)) return norm;
  const d = new Date(str);
  if (isNaN(d)) return str;
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

function today() {
  return new Date().toISOString().split('T')[0];
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function scrapingBadge(status) {
  const map = {
    'Unused':   ['badge-unused',    '●', 'Unused'],
    'Reserved': ['badge-reserved',  '⬤', 'Reserved'],
    'Used':     ['badge-used',      '✓', 'Used'],
  };
  const [cls, icon, label] = map[status] || ['badge-unused', '●', status];
  return `<span class="status-badge ${cls}">${icon} ${label}</span>`;
}

function progressBadge(status) {
  const map = {
    'Not Started': ['task-not-started', '🕐'],
    'In Progress': ['task-in-progress', '⚡'],
    'Completed':   ['task-completed',   '✅'],
  };
  const [cls, icon] = map[status] || ['task-not-started', '🕐'];
  return `<span class="status-badge ${cls}">${icon} ${status}</span>`;
}

function renderPagination(controlsId, infoId, page, pages, total, cb) {
  const info     = document.getElementById(infoId);
  const controls = document.getElementById(controlsId);
  if (info) info.textContent = `${total} record${total !== 1 ? 's' : ''}`;
  if (!controls) return;
  controls.innerHTML = '';

  const addBtn = (label, p, active, disabled) => {
    const b = document.createElement('button');
    b.className = 'page-btn' + (active ? ' active' : '');
    b.disabled  = disabled;
    b.innerHTML = label;
    b.onclick   = () => cb(p);
    controls.appendChild(b);
  };

  addBtn('‹', page - 1, false, page <= 1);
  const start = Math.max(1, page - 2);
  const end   = Math.min(pages, start + 4);
  for (let i = start; i <= end; i++) addBtn(i, i, i === page, false);
  addBtn('›', page + 1, false, page >= pages);
}

function showToast(msg, type = 'info') {
  const icons = { success:'✅', error:'❌', warning:'⚠️', info:'ℹ️' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ️'}</span><span class="toast-msg">${esc(msg)}</span>`;
  document.getElementById('toast-container').prepend(el);
  setTimeout(() => { el.classList.add('fade-out'); setTimeout(() => el.remove(), 300); }, 3500);
}

function showModal(id)  { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

function setLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = loading;
  btn.style.opacity = loading ? '0.65' : '';
}

function emptyRow(colspan, msg = 'No records found.') {
  return `<tr><td colspan="${colspan}" style="padding:3rem;text-align:center;color:var(--text-muted);font-size:0.85rem">${msg}</td></tr>`;
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val ?? '—';
}


// ── Keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(m => m.classList.add('hidden'));
  }
});

document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.classList.add('hidden');
  });
});


// ── Init ──────────────────────────────────────────────────────────────────────
(function init() {
  const savedToken = localStorage.getItem('db_token');
  const savedUser  = localStorage.getItem('db_user');
  if (savedToken && savedUser) {
    token       = savedToken;
    currentUser = JSON.parse(savedUser);
    bootApp();
  }
})();
