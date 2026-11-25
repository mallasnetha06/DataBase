/* ═══════════════════════════════════════════════════════════════════════════
   DataBase v2 — app.js
   Modules: Auth · Dashboard · Data Scraping · Employee Progress · Users · Audit
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
  { key: 'email',         label: 'Email' },
  { key: 'email_status',  label: 'Status' },
  { key: 'keyword',       label: 'Keyword' },
  { key: 'website',       label: 'Website' },
  { key: 'affiliation',   label: 'Affiliation' },
  { key: 'update_status', label: 'Update Status' },
];
// Keys visible by default (action col is always present)
let mineVisibleCols = ['date','author_name','article_title','email','email_status','keyword','website','affiliation','update_status'];

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
  // Handle yyyy-mm-dd-hh/mm/ss or yyyy-mm-dd or ISO strings → dd-mm-yyyy
  // Normalise: replace the datetime separator pattern
  const norm = String(str).replace(/(\d{4})-(\d{2})-(\d{2}).*/, '$3-$2-$1');
  if (/^\d{2}-\d{2}-\d{4}$/.test(norm)) return norm;
  // Fallback: try parsing as Date
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


// ── Auth ──────────────────────────────────────────────────────────────────────
function switchAuthTab(tab) {
  const isLogin = tab === 'login';
  document.getElementById('login-form').classList.toggle('hidden', !isLogin);
  document.getElementById('register-form').classList.toggle('hidden', isLogin);
  document.getElementById('tab-login').classList.toggle('active', isLogin);
  document.getElementById('tab-register').classList.toggle('active', !isLogin);
}

async function handleLogin(e) {
  e.preventDefault();
  const errEl = document.getElementById('login-error');
  errEl.style.display = 'none';
  setLoading('btn-login', true);
  try {
    const data = await api('POST', '/auth/login', {
      username: document.getElementById('login-username').value.trim(),
      password: document.getElementById('login-password').value,
    });
    token       = data.access_token;
    currentUser = { id: data.user_id, username: data.username, role: data.role };
    localStorage.setItem('db_token', token);
    localStorage.setItem('db_user', JSON.stringify(currentUser));
    bootApp();
  } catch (err) {
    errEl.textContent    = err.message;
    errEl.style.display  = 'block';
  } finally {
    setLoading('btn-login', false);
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const msgEl = document.getElementById('register-msg');
  msgEl.style.display = 'none';
  setLoading('btn-register', true);
  try {
    await api('POST', '/auth/register', {
      username: document.getElementById('reg-username').value.trim(),
      password: document.getElementById('reg-password').value,
    });
    msgEl.style.color   = 'var(--success)';
    msgEl.textContent   = 'Registration submitted! An admin will approve your account.';
    msgEl.style.display = 'block';
    document.getElementById('register-form').reset();
  } catch (err) {
    msgEl.style.color   = 'var(--danger)';
    msgEl.textContent   = err.message;
    msgEl.style.display = 'block';
  } finally {
    setLoading('btn-register', false);
  }
}

function logout() {
  token = null; currentUser = null;
  localStorage.removeItem('db_token');
  localStorage.removeItem('db_user');
  document.getElementById('auth-screen').classList.remove('hidden');
  document.getElementById('app-screen').classList.add('hidden');
  document.getElementById('login-form').reset();
}

function bootApp() {
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('app-screen').classList.remove('hidden');

  const isAdmin = currentUser.role === 'admin';
  document.querySelectorAll('.admin-only').forEach(el => el.classList.toggle('hidden', !isAdmin));

  const av = document.getElementById('user-avatar');
  if (av) av.textContent = currentUser.username[0].toUpperCase();
  const un = document.getElementById('sidebar-username');
  if (un) un.textContent = currentUser.username;
  const roleEl = document.getElementById('sidebar-role');
  if (roleEl) { roleEl.textContent = currentUser.role; roleEl.className = `user-role ${currentUser.role}`; }

  // Pre-fill progress form with user info
  const prDate = document.getElementById('pr-date');
  if (prDate && !prDate.value) prDate.value = today();

  showPanel('dashboard');
  if (isAdmin) loadPendingCount();
  // Initialise My Collection table headers so they show immediately on first visit
  renderMineTableHeaders();
}


// ── Navigation ────────────────────────────────────────────────────────────────
const PANEL_TITLES = {
  'dashboard':       'Dashboard',
  'scraping-all':    'Data Scraping — All Records',
  'scraping-mine':   'My Collection',
  'scraping-upload': 'Batch Upload',
  'progress-mine':   'My Progress',
  'progress-team':   'Team Progress',
  'progress-charts': 'Progress Charts',
  'users':           'User Management',
  'audit':           'Audit Log',
};

function showPanel(id) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const panel = document.getElementById(`panel-${id}`);
  if (panel) panel.classList.add('active');
  const nav   = document.getElementById(`nav-${id}`);
  if (nav)   nav.classList.add('active');
  const title = document.getElementById('page-title');
  if (title) title.textContent = PANEL_TITLES[id] || id;

  // Update top-bar actions
  const actions = document.getElementById('top-bar-actions');
  if (actions) actions.innerHTML = '';

  // Lazy-load panel data
  const loaders = {
    'dashboard':       loadDashboard,
    'scraping-all':    loadScraping,
    'scraping-mine':   loadMineCollection,
    'progress-mine':   loadMyProgress,
    'progress-team':   loadTeamProgress,
    'progress-charts': loadProgressCharts,
    'users':           () => { loadPendingUsers(); loadUsers(); },
    'audit':           loadAudit,
  };
  if (loaders[id]) loaders[id]();
}


// ── Dashboard ─────────────────────────────────────────────────────────────────
async function loadDashboard() {
  // Scraping stats
  try {
    const s = await api('GET', '/scraping/stats');
    setText('stat-total-scraping', s.total);
    setText('stat-unused',  s.unused);
    setText('stat-reserved', s.reserved);
    setText('stat-used',    s.used);
  } catch (_) {}

  // Progress stats
  try {
    const p = await api('GET', '/kanban/my-stats');
    setText('stat-total-progress', p.total);
    setText('stat-completed',      p.completed);
    setText('stat-in-progress',    p.in_progress);
    setText('stat-not-started',    p.not_started);
  } catch (_) {}

  // Admin: user count
  if (currentUser?.role === 'admin') {
    try {
      const u = await api('GET', '/users');
      setText('stat-users', u.length || 0);
    } catch (_) {}
  }

  // Recent scraping entries
  try {
    const data = await api('GET', '/scraping?page=1&page_size=5');
    const tbody = document.getElementById('dashboard-scraping-tbody');
    if (!tbody) return;
    if (!data.data.length) { tbody.innerHTML = emptyRow(6, 'No records yet.'); return; }
    tbody.innerHTML = data.data.map(r => `
      <tr>
        <td class="td-truncate" style="max-width:120px">${esc(r.author_name)}</td>
        <td class="td-truncate">${esc(r.article_title)}</td>
        <td class="td-truncate" style="max-width:160px">${esc(r.email)}</td>
        <td>${scrapingBadge(r.email_status)}</td>
        <td class="td-truncate" style="max-width:120px">${esc(r.website)}</td>
        <td style="white-space:nowrap">${fmtDate(r.created_at)}</td>
      </tr>`).join('');
  } catch (_) {}
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val ?? '—';
}


// ── Data Scraping — All Records ───────────────────────────────────────────────
function debounceScrapingSearch() {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => { scrapingPage = 1; loadScraping(); }, 350);
}

async function loadScraping() {
  scrapingSearch = document.getElementById('scraping-search')?.value?.trim() || '';
  scrapingStatus = document.getElementById('scraping-status-filter')?.value || 'All';

  const params = new URLSearchParams({ page: scrapingPage, page_size: 25 });
  if (scrapingSearch) params.set('search', scrapingSearch);
  if (scrapingStatus !== 'All') params.set('status', scrapingStatus);

  const tbody = document.getElementById('scraping-all-tbody');
  if (tbody) tbody.innerHTML = emptyRow(10, 'Loading…');

  try {
    const data = await api('GET', `/scraping?${params}`);
    renderScrapingAllTable(data);
  } catch (err) {
    if (tbody) tbody.innerHTML = emptyRow(10, `Error: ${err.message}`);
  }
}

function renderScrapingAllTable(data) {
  const tbody = document.getElementById('scraping-all-tbody');
  if (!tbody) return;
  const isAdmin = currentUser?.role === 'admin';

  if (!data.data.length) { tbody.innerHTML = emptyRow(10); return; }

  tbody.innerHTML = data.data.map(r => {
    const canEdit   = isAdmin;
    const canStatus = isAdmin || r.uploaded_by === currentUser?.id;
    const actions = `
      <div class="td-actions">
        ${canStatus && r.email_status !== 'Used' ? `
          <select class="form-select" style="width:110px;font-size:0.75rem;padding:0.3rem 0.5rem"
                  onchange="quickUpdateStatus(${r.id}, this.value, this)">
            <option value="Unused"   ${r.email_status==='Unused'   ? 'selected' : ''}>Unused</option>
            <option value="Reserved" ${r.email_status==='Reserved' ? 'selected' : ''}>Reserved</option>
            <option value="Used"     ${r.email_status==='Used'     ? 'selected' : ''}>Used</option>
          </select>` : ''}
        ${canEdit ? `<button class="btn btn-ghost btn-icon btn-sm" onclick="openEditScraping(${r.id})" title="Edit">✏️</button>` : ''}
        ${isAdmin ? `<button class="btn btn-danger btn-icon btn-sm" onclick="confirmDeleteScraping(${r.id})" title="Delete">🗑️</button>` : ''}
      </div>`;
    return `
      <tr>
        <td style="white-space:nowrap">${esc(r.date) || '—'}</td>
        <td class="td-truncate" style="max-width:120px">${esc(r.author_name)}</td>
        <td class="td-truncate" style="max-width:180px" title="${esc(r.article_title)}">${esc(r.article_title)}</td>
        <td class="td-truncate" style="max-width:160px">${esc(r.email)}</td>
        <td>${scrapingBadge(r.email_status)}</td>
        <td class="td-truncate" style="max-width:100px">${esc(r.keyword)}</td>
        <td class="td-truncate" style="max-width:120px">${esc(r.website)}</td>
        <td class="td-truncate" style="max-width:110px">${esc(r.affiliation) || '—'}</td>
        <td>${esc(r.uploaded_by_username || '—')}</td>
        <td>${actions}</td>
      </tr>`;
  }).join('');

  renderPagination('scraping-all-controls', 'scraping-all-info',
    data.page, data.pages, data.total, p => { scrapingPage = p; loadScraping(); });
}

async function quickUpdateStatus(id, status, selectEl) {
  try {
    await api('PATCH', `/scraping/${id}/status`, { email_status: status });
    showToast(`Status updated to "${status}"`, 'success');
    loadScraping();
    if (currentUser?.role !== 'admin') loadMineCollection();
  } catch (err) {
    showToast(err.message, 'error');
    if (selectEl) selectEl.value = selectEl.dataset.prev || 'Unused';
  }
}

async function handleAddScraping(e) {
  e.preventDefault();
  const errEl = document.getElementById('add-scraping-error');
  errEl.style.display = 'none';
  setLoading('btn-add-scraping', true);
  try {
    await api('POST', '/scraping', {
      date:          document.getElementById('sc-date').value,
      website:       document.getElementById('sc-website').value.trim() || 'N/A',
      keyword:       document.getElementById('sc-keyword').value.trim() || 'N/A',
      article_title: document.getElementById('sc-title').value.trim(),
      author_name:   document.getElementById('sc-author').value.trim(),
      email:         document.getElementById('sc-email').value.trim(),
      affiliation:   document.getElementById('sc-affiliation').value.trim() || null,
    });
    closeModal('add-scraping-modal');
    document.querySelector('#add-scraping-modal form').reset();
    showToast('Record added successfully!', 'success');
    loadScraping();
  } catch (err) {
    errEl.textContent   = err.message;
    errEl.style.display = 'block';
  } finally {
    setLoading('btn-add-scraping', false);
  }
}

async function openEditScraping(id) {
  try {
    const data = await api('GET', `/scraping?page=1&page_size=1`);
    // Need to get individual record - fetch from list matching id
    const allData = await api('GET', `/scraping?page=1&page_size=1000`);
    const r = allData.data.find(x => x.id === id);
    if (!r) { showToast('Record not found', 'error'); return; }
    document.getElementById('edit-sc-id').value          = r.id;
    document.getElementById('edit-sc-date').value        = r.date || '';
    document.getElementById('edit-sc-website').value     = r.website || '';
    document.getElementById('edit-sc-keyword').value     = r.keyword || '';
    document.getElementById('edit-sc-email').value       = r.email || '';
    document.getElementById('edit-sc-title').value       = r.article_title || '';
    document.getElementById('edit-sc-author').value      = r.author_name || '';
    document.getElementById('edit-sc-affiliation').value = r.affiliation || '';
    document.getElementById('edit-sc-status').value      = r.email_status || 'Unused';
    showModal('edit-scraping-modal');
  } catch (err) { showToast(err.message, 'error'); }
}

async function handleEditScraping(e) {
  e.preventDefault();
  const id    = document.getElementById('edit-sc-id').value;
  const errEl = document.getElementById('edit-scraping-error');
  errEl.style.display = 'none';
  setLoading('btn-save-scraping', true);
  try {
    await api('PUT', `/scraping/${id}`, {
      date:          document.getElementById('edit-sc-date').value        || undefined,
      website:       document.getElementById('edit-sc-website').value.trim()     || undefined,
      keyword:       document.getElementById('edit-sc-keyword').value.trim()     || undefined,
      email:         document.getElementById('edit-sc-email').value.trim()       || undefined,
      article_title: document.getElementById('edit-sc-title').value.trim()       || undefined,
      author_name:   document.getElementById('edit-sc-author').value.trim()      || undefined,
      affiliation:   document.getElementById('edit-sc-affiliation').value.trim() || undefined,
      email_status:  document.getElementById('edit-sc-status').value             || undefined,
    });
    closeModal('edit-scraping-modal');
    showToast('Record updated!', 'success');
    loadScraping();
  } catch (err) {
    errEl.textContent   = err.message;
    errEl.style.display = 'block';
  } finally {
    setLoading('btn-save-scraping', false);
  }
}

function confirmDeleteScraping(id) {
  document.getElementById('confirm-delete-msg').textContent = `Delete scraping record #${id}? This cannot be undone.`;
  document.getElementById('btn-confirm-delete').onclick = () => deleteScraping(id);
  showModal('confirm-delete-modal');
}

async function deleteScraping(id) {
  closeModal('confirm-delete-modal');
  try {
    await api('DELETE', `/scraping/${id}`);
    showToast('Record deleted.', 'success');
    loadScraping();
    loadDashboard();
  } catch (err) { showToast(err.message, 'error'); }
}

async function exportScrapingCSV() {
  window.location = '/scraping/export';
}


// ── Data Scraping — My Collection ─────────────────────────────────────────────

// ── DnD state ────────────────────────────────────────────────────────────────
let _mineDragKey    = null;  // column key being dragged
let _mineDragSource = null;  // 'table' | 'widget'
let _mineDropTarget = null;  // key of th currently hovered over

// ── Widget bar render ─────────────────────────────────────────────────────────
function renderMineColWidgets() {
  const bar = document.getElementById('mine-col-widgets');
  if (!bar) return;

  // Always wire drop-target events on the bar
  bar.ondragover  = mineBarDragOver;
  bar.ondragleave = mineBarDragLeave;
  bar.ondrop      = mineBarDrop;

  // Bar is ALWAYS visible — it's a permanent drop zone
  bar.style.display = 'flex';

  const hidden = MINE_ALL_COLS.filter(c => !mineVisibleCols.includes(c.key));
  if (!hidden.length) {
    bar.innerHTML = '';
    bar.classList.add('col-widgets-empty');
    return;
  }
  bar.classList.remove('col-widgets-empty');
  bar.innerHTML = hidden.map(c => `
    <button class="col-chip"
            draggable="true"
            data-key="${c.key}"
            onclick="mineAddCol('${c.key}')"
            title="Drag onto table or click to show ${esc(c.label)}">
      <span class="col-chip-plus">＋</span>${esc(c.label)}
    </button>`).join('');

  // Attach drag events to chips
  bar.querySelectorAll('.col-chip').forEach(btn => {
    btn.addEventListener('dragstart', e => {
      _mineDragKey    = btn.dataset.key;
      _mineDragSource = 'widget';
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', btn.dataset.key);
      setTimeout(() => btn.classList.add('dragging'), 0);
    });
    btn.addEventListener('dragend', () => {
      btn.classList.remove('dragging');
      _mineCleanupDrag();
    });
  });
}

// ── Table header render (only sets HTML — no listener wiring here) ────────────
function renderMineTableHeaders() {
  const thead = document.getElementById('scraping-mine-thead');
  if (!thead) return;
  const cols = mineVisibleCols.map(key => MINE_ALL_COLS.find(c => c.key === key)).filter(Boolean);
  thead.innerHTML = `<tr class="mine-header-row">
    ${cols.map(c => `
      <th class="mine-th" draggable="true" data-key="${c.key}">
        <span class="th-drag-handle" title="Drag to reorder or drag to widget area to hide">⠿</span>
        <span class="th-label">${esc(c.label)}</span>
        <button class="col-remove-btn" onclick="event.stopPropagation();mineRemoveCol('${c.key}')" title="Hide ${esc(c.label)}">&#215;</button>
      </th>`).join('')}
  </tr>`;
}

// ── Wire DnD via event delegation — called ONCE, not on every render ──────────
function initMineTheadDnD() {
  const thead = document.getElementById('scraping-mine-thead');
  if (!thead || thead._dndReady) return;   // guard: only wire once
  thead._dndReady = true;

  // ── dragstart ──────────────────────────────────────────────────────────────
  thead.addEventListener('dragstart', e => {
    const th = e.target.closest('th.mine-th');
    if (!th) return;
    _mineDragKey    = th.dataset.key;
    _mineDragSource = 'table';
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', _mineDragKey);
    setTimeout(() => th.classList.add('dragging'), 0);
    _mineShowBarDropZone(true);
  });

  // ── dragend ────────────────────────────────────────────────────────────────
  thead.addEventListener('dragend', e => {
    const th = e.target.closest('th.mine-th');
    if (th) th.classList.remove('dragging');
    _mineCleanupDrag();
  });

  // ── dragover ───────────────────────────────────────────────────────────────
  thead.addEventListener('dragover', e => {
    if (!_mineDragKey) return;
    const th = e.target.closest('th.mine-th');

    if (_mineDragSource === 'table') {
      if (!th || th.dataset.key === _mineDragKey) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (_mineDropTarget !== th.dataset.key) {
        thead.querySelectorAll('th.mine-th').forEach(t => t.classList.remove('col-drag-over'));
        th.classList.add('col-drag-over');
        _mineDropTarget = th.dataset.key;
      }
    } else if (_mineDragSource === 'widget') {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      thead.querySelectorAll('th.mine-th').forEach(t => t.classList.remove('col-drag-over'));
      if (th) { th.classList.add('col-drag-over'); _mineDropTarget = th.dataset.key; }
    }
  });

  // ── dragleave ──────────────────────────────────────────────────────────────
  thead.addEventListener('dragleave', e => {
    // Only clear if the pointer truly left the thead
    if (!thead.contains(e.relatedTarget)) {
      thead.querySelectorAll('th.mine-th').forEach(t => t.classList.remove('col-drag-over'));
      _mineDropTarget = null;
    }
  });

  // ── drop ───────────────────────────────────────────────────────────────────
  thead.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation();   // don't bubble further
    thead.querySelectorAll('th.mine-th').forEach(t => t.classList.remove('col-drag-over'));

    const dragKey = _mineDragKey;
    const source  = _mineDragSource;
    const th      = e.target.closest('th.mine-th');
    const dropKey = th ? th.dataset.key : null;

    _mineCleanupDrag();   // clear state FIRST before mutating cols

    if (source === 'table' && dragKey && dropKey && dragKey !== dropKey) {
      // ── Reorder ────────────────────────────────────────────────────────────
      const from = mineVisibleCols.indexOf(dragKey);
      let   to   = mineVisibleCols.indexOf(dropKey);
      if (from !== -1 && to !== -1) {
        mineVisibleCols.splice(from, 1);
        // After removing the element at `from`, every index after it shifts
        // down by 1.  Compensate so the column lands ON the drop target.
        if (from < to) to -= 1;
        mineVisibleCols.splice(to, 0, dragKey);
      }
    } else if (source === 'widget' && dragKey && !mineVisibleCols.includes(dragKey)) {
      // ── Restore chip at specific position or end ───────────────────────────
      if (dropKey) {
        const to = mineVisibleCols.indexOf(dropKey);
        mineVisibleCols.splice(to >= 0 ? to : mineVisibleCols.length, 0, dragKey);
      } else {
        const order = MINE_ALL_COLS.map(c => c.key);
        mineVisibleCols = order.filter(k => mineVisibleCols.includes(k) || k === dragKey);
      }
    }

    _mineRefreshView();
  });
}

// ── Widget bar as drop target (remove column) ─────────────────────────────────
function mineBarDragOver(e) {
  if (_mineDragSource !== 'table') return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  this.classList.add('col-drag-over');
}
function mineBarDragLeave(e) {
  if (!this.contains(e.relatedTarget)) this.classList.remove('col-drag-over');
}
function mineBarDrop(e) {
  e.preventDefault();
  this.classList.remove('col-drag-over');
  const dragKey = _mineDragKey;
  const source  = _mineDragSource;
  _mineCleanupDrag();   // clear BEFORE mutating
  if (source === 'table' && dragKey) {
    mineVisibleCols = mineVisibleCols.filter(k => k !== dragKey);
  }
  _mineRefreshView();
}

// ── Shared refresh: re-render headers + rows without touching listeners ────────
function _mineRefreshView() {
  renderMineColWidgets();
  renderMineTableHeaders();
  const lastData = window._mineLastData;
  if (lastData) renderMineRows(lastData);
}

function _mineShowBarDropZone(show) {
  const bar = document.getElementById('mine-col-widgets');
  if (!bar) return;
  if (show) {
    bar.classList.add('mine-drop-zone-active');
  } else {
    bar.classList.remove('mine-drop-zone-active');
  }
}

function _mineCleanupDrag() {
  _mineDragKey    = null;
  _mineDragSource = null;
  _mineDropTarget = null;
  document.querySelectorAll('.col-drag-over, .dragging').forEach(el =>
    el.classList.remove('col-drag-over', 'dragging'));
  _mineShowBarDropZone(false);
}

function mineAddCol(key) {
  const order = MINE_ALL_COLS.map(c => c.key);
  mineVisibleCols = order.filter(k => mineVisibleCols.includes(k) || k === key);
  _mineRefreshView();
}

function mineRemoveCol(key) {
  mineVisibleCols = mineVisibleCols.filter(k => k !== key);
  _mineRefreshView();
}

function renderMineRows(data) {
  const tbody = document.getElementById('scraping-mine-tbody');
  if (!tbody) return;

  if (!data.data.length) {
    const totalCols = mineVisibleCols.length;
    tbody.innerHTML = `<tr><td colspan="${totalCols}" style="padding:3rem;text-align:center">
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        <h3>Your collection is empty</h3>
        <p>Upload an Excel file or add records manually — they'll appear here until marked as Used.</p>
      </div></td></tr>`;
    return;
  }

  const cellVal = (r, key) => {
    switch (key) {
      case 'date':          return `<td style="white-space:nowrap">${fmtDate(r.date) || '—'}</td>`;
      case 'author_name':   return `<td class="td-truncate" style="max-width:120px">${esc(r.author_name)}</td>`;
      case 'article_title': return `<td class="td-truncate" style="max-width:180px" title="${esc(r.article_title)}">${esc(r.article_title)}</td>`;
      case 'email':         return `<td class="td-truncate" style="max-width:160px">${esc(r.email)}</td>`;
      case 'email_status':  return `<td>${scrapingBadge(r.email_status)}</td>`;
      case 'keyword':       return `<td class="td-truncate" style="max-width:100px">${esc(r.keyword)}</td>`;
      case 'website':       return `<td class="td-truncate" style="max-width:120px">${esc(r.website)}</td>`;
      case 'affiliation':   return `<td class="td-truncate" style="max-width:110px">${esc(r.affiliation) || '—'}</td>`;
      case 'update_status': return `
        <td>
          <select class="form-select" style="width:115px;font-size:0.75rem;padding:0.3rem 0.5rem"
                  onchange="updateMineStatus(${r.id}, this.value)">
            <option value="Unused"   ${r.email_status==='Unused'   ? 'selected' : ''}>Unused</option>
            <option value="Reserved" ${r.email_status==='Reserved' ? 'selected' : ''}>Reserved</option>
            <option value="Used"     ${r.email_status==='Used'     ? 'selected' : ''}>Used ✓</option>
          </select>
        </td>`;
      default:              return `<td>—</td>`;
    }
  };

  tbody.innerHTML = data.data.map(r => `
    <tr>
      ${mineVisibleCols.map(key => cellVal(r, key)).join('')}
    </tr>`).join('');
}

async function loadMineCollection() {
  const totalCols = mineVisibleCols.length + 1;
  const tbody = document.getElementById('scraping-mine-tbody');
  if (tbody) tbody.innerHTML = emptyRow(totalCols, 'Loading…');
  renderMineColWidgets();
  renderMineTableHeaders();
  initMineTheadDnD(); // wire DnD once on first load

  try {
    const data = await api('GET', `/scraping/mine?page=${minePage}&page_size=25`);
    window._mineLastData = data;
    renderMineTable(data);
  } catch (err) {
    if (tbody) tbody.innerHTML = emptyRow(totalCols, `Error: ${err.message}`);
  }
}

function renderMineTable(data) {
  renderMineTableHeaders(); // refresh headers (no listener re-wiring)
  renderMineRows(data);
  renderPagination('scraping-mine-controls', 'scraping-mine-info',
    data.page, data.pages, data.total, p => { minePage = p; loadMineCollection(); });
}

async function updateMineStatus(id, status) {
  try {
    await api('PATCH', `/scraping/${id}/status`, { email_status: status });
    showToast(`Status updated to "${status}"`, 'success');
    setTimeout(() => { loadMineCollection(); loadDashboard(); }, 400);
  } catch (err) { showToast(err.message, 'error'); }
}


// ── Data Scraping — Upload ─────────────────────────────────────────────────────
let _scrapingFile = null;

function handleDragOver(e) { e.preventDefault(); document.getElementById('upload-zone').classList.add('dragover'); }
function handleDragLeave()  { document.getElementById('upload-zone').classList.remove('dragover'); }

function handleDrop(e) {
  e.preventDefault();
  document.getElementById('upload-zone').classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) setScrapingFile(file);
}

function handleScrapingFileSelect(e) {
  const file = e.target.files[0];
  if (file) setScrapingFile(file);
}

function setScrapingFile(file) {
  _scrapingFile = file;
  document.getElementById('file-name').textContent   = file.name;
  document.getElementById('file-size').textContent   = `${(file.size / 1024).toFixed(1)} KB`;
  document.getElementById('file-selected').classList.remove('hidden');
  document.getElementById('btn-upload-scraping').classList.remove('hidden');
  document.getElementById('upload-result').classList.add('hidden');
}

function clearScrapingFile() {
  _scrapingFile = null;
  document.getElementById('scraping-file-input').value = '';
  document.getElementById('file-selected').classList.add('hidden');
  document.getElementById('btn-upload-scraping').classList.add('hidden');
  document.getElementById('upload-result').classList.add('hidden');
}

async function uploadScrapingFile() {
  if (!_scrapingFile) return;
  const btn = document.getElementById('btn-upload-scraping');
  btn.disabled = true; btn.textContent = '⏳ Uploading…';

  const fd = new FormData();
  fd.append('file', _scrapingFile);

  try {
    const data = await apiForm('/scraping/upload', fd);
    const res  = document.getElementById('upload-result');
    res.classList.remove('hidden');

    let html = `<div class="upload-result">
      <div style="margin-bottom:0.75rem;font-weight:700;font-size:0.9rem">Upload Complete</div>
      <div class="result-success">✅ ${data.inserted} record${data.inserted !== 1 ? 's' : ''} inserted</div>
      <div class="result-failed" style="margin-top:0.25rem">⏭️ ${data.skipped} skipped (duplicates / missing fields)</div>`;

    if (data.skipped_rows?.length) {
      html += `<div style="margin-top:0.75rem;font-weight:600;font-size:0.8rem;color:var(--text-secondary)">Skipped rows:</div>`;
      data.skipped_rows.forEach(r => {
        html += `<div class="result-item"><span style="color:var(--danger)">Row ${r.line}</span><span style="color:var(--text-secondary)">${esc(r.email)} — ${esc(r.reason)}</span></div>`;
      });
    }
    html += '</div>';
    res.innerHTML = html;
    showToast(`${data.inserted} inserted, ${data.skipped} skipped`, data.inserted > 0 ? 'success' : 'warning');
    loadDashboard();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '⬆️ Upload File';
  }
}


// ── Employee Progress ──────────────────────────────────────────────────────────
// Functions moved to static/js/progress-mine.js and static/js/progress-team.js
// (loadMyProgress, loadTeamProgress, renderTeamProgressTable,
//  handleAddProgress, handleEditProgress, openEditBoardModal,
//  confirmDeleteProgress, deleteProgress, clearProgressFilters,
//  clearTeamProgressFilters, exportProgressCSV)



// ── Progress Charts ────────────────────────────────────────────────────────────
async function loadProgressCharts() {
  const days = document.getElementById('chart-days-filter')?.value || '30';
  try {
    const data = await api('GET', `/progress/stats?days=${days}`);
    renderByDateChart(data.by_date);
    renderStatusChart(data.status_counts);
    renderPerUserChart(data.per_user);
  } catch (err) {
    showToast('Could not load chart data: ' + err.message, 'error');
  }
}

function destroyChart(key) {
  if (charts[key]) { charts[key].destroy(); delete charts[key]; }
}

function renderByDateChart(byDate) {
  destroyChart('byDate');
  const ctx = document.getElementById('chart-by-date');
  if (!ctx) return;
  charts['byDate'] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: byDate.map(d => d.date),
      datasets: [
        { label: 'Completed',   data: byDate.map(d => d.completed),   backgroundColor: 'rgba(34,197,94,0.75)',  borderRadius: 4 },
        { label: 'In Progress', data: byDate.map(d => d.in_progress), backgroundColor: 'rgba(56,189,248,0.75)', borderRadius: 4 },
        { label: 'Not Started', data: byDate.map(d => d.not_started), backgroundColor: 'rgba(239,68,68,0.75)',  borderRadius: 4 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#8b9fc5', font: { family: 'Inter' } } } },
      scales: {
        x: { stacked: true, ticks: { color: '#8b9fc5' }, grid: { color: 'rgba(99,140,255,0.06)' } },
        y: { stacked: true, ticks: { color: '#8b9fc5', stepSize: 1 }, grid: { color: 'rgba(99,140,255,0.06)' } },
      },
    },
  });
}

function renderStatusChart(statusCounts) {
  destroyChart('status');
  const ctx = document.getElementById('chart-status');
  if (!ctx) return;
  const colorMap = { 'Completed': 'rgba(34,197,94,0.85)', 'In Progress': 'rgba(56,189,248,0.85)', 'Not Started': 'rgba(239,68,68,0.85)' };
  charts['status'] = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: statusCounts.map(s => s.task_status),
      datasets: [{ data: statusCounts.map(s => s.count), backgroundColor: statusCounts.map(s => colorMap[s.task_status] || '#4f8aff'), borderWidth: 0 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#8b9fc5', font: { family: 'Inter' }, padding: 12 } },
      },
      cutout: '65%',
    },
  });
}

function renderPerUserChart(perUser) {
  destroyChart('perUser');
  const ctx = document.getElementById('chart-per-user');
  if (!ctx) return;
  charts['perUser'] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: perUser.map(u => u.username || 'Unknown'),
      datasets: [
        { label: 'Total Tasks',  data: perUser.map(u => u.total),     backgroundColor: 'rgba(79,138,255,0.5)',  borderRadius: 4 },
        { label: 'Completed',    data: perUser.map(u => u.completed), backgroundColor: 'rgba(34,197,94,0.75)', borderRadius: 4 },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#8b9fc5', font: { family: 'Inter' } } } },
      scales: {
        x: { ticks: { color: '#8b9fc5', stepSize: 1 }, grid: { color: 'rgba(99,140,255,0.06)' } },
        y: { ticks: { color: '#8b9fc5' }, grid: { display: false } },
      },
    },
  });
}


// ── Users ─────────────────────────────────────────────────────────────────────
async function loadPendingCount() {
  try {
    const data = await api('GET', '/users/pending');
    const badge = document.getElementById('pending-badge');
    if (badge) {
      badge.textContent = data.length;
      badge.classList.toggle('hidden', data.length === 0);
    }
  } catch (_) {}
}

async function loadPendingUsers() {
  try {
    const data = await api('GET', '/users/pending');
    const el   = document.getElementById('pending-list');
    if (!el) return;
    if (!data.length) { el.innerHTML = '<p class="text-muted text-sm">No pending approvals.</p>'; return; }
    el.innerHTML = data.map(u => `
      <div class="pending-card">
        <div class="pending-info">
          <div class="user-avatar" style="width:36px;height:36px;font-size:0.85rem">${u.username[0].toUpperCase()}</div>
          <div>
            <div class="pending-name">${esc(u.username)}</div>
            <div class="pending-time">Registered ${fmtDate(u.created_at)}</div>
          </div>
        </div>
        <div class="td-actions">
          <button class="btn btn-success btn-sm" onclick="approveUser(${u.id},1)">✓ Approve</button>
          <button class="btn btn-danger btn-sm"  onclick="approveUser(${u.id},2)">✕ Reject</button>
        </div>
      </div>`).join('');
  } catch (err) { showToast(err.message, 'error'); }
}

async function loadUsers() {
  try {
    const data  = await api('GET', '/users');
    const tbody = document.getElementById('users-tbody');
    if (!tbody) return;
    if (!data.length) { tbody.innerHTML = emptyRow(6); return; }
    const statusMap = { 0: ['⏳ Pending', 'var(--warning)'], 1: ['✅ Approved', 'var(--success)'], 2: ['❌ Rejected', 'var(--danger)'] };
    tbody.innerHTML = data.map(u => {
      const [label, color] = statusMap[u.is_approved] || ['—', 'inherit'];
      return `
        <tr>
          <td>${u.id}</td>
          <td><strong>${esc(u.username)}</strong></td>
          <td><span class="user-role ${u.role}" style="display:inline-block">${u.role}</span></td>
          <td style="color:${color};font-size:0.82rem;font-weight:600">${label}</td>
          <td>${fmtDate(u.created_at)}</td>
          <td>
            <div class="td-actions">
              ${u.is_approved === 0 ? `<button class="btn btn-success btn-sm" onclick="approveUser(${u.id},1)">Approve</button>` : ''}
              ${u.role !== 'admin'  ? `<button class="btn btn-danger  btn-icon btn-sm" onclick="confirmDeleteUser(${u.id}, '${esc(u.username)}')">🗑️</button>` : ''}
            </div>
          </td>
        </tr>`;
    }).join('');
    setText('stat-users', data.length);
  } catch (err) { showToast(err.message, 'error'); }
}

async function approveUser(id, status) {
  try {
    await api('PATCH', `/users/${id}/approve`, { is_approved: status });
    showToast(status === 1 ? 'User approved!' : 'User rejected.', status === 1 ? 'success' : 'warning');
    loadPendingUsers(); loadUsers(); loadPendingCount();
  } catch (err) { showToast(err.message, 'error'); }
}

async function handleCreateUser(e) {
  e.preventDefault();
  const errEl = document.getElementById('create-user-error');
  errEl.style.display = 'none';
  setLoading('btn-create-user', true);
  try {
    await api('POST', '/users', {
      username: document.getElementById('new-username').value.trim(),
      password: document.getElementById('new-password').value,
      role:     document.getElementById('new-role').value,
    });
    closeModal('add-user-modal');
    document.querySelector('#add-user-modal form').reset();
    showToast('User created!', 'success');
    loadUsers();
  } catch (err) {
    errEl.textContent   = err.message;
    errEl.style.display = 'block';
  } finally {
    setLoading('btn-create-user', false);
  }
}

function confirmDeleteUser(id, username) {
  document.getElementById('confirm-delete-msg').textContent = `Delete user "${username}"? This cannot be undone.`;
  document.getElementById('btn-confirm-delete').onclick = () => deleteUser(id);
  showModal('confirm-delete-modal');
}

async function deleteUser(id) {
  closeModal('confirm-delete-modal');
  try {
    await api('DELETE', `/users/${id}`);
    showToast('User deleted.', 'success');
    loadUsers(); loadPendingCount();
  } catch (err) { showToast(err.message, 'error'); }
}


// ── Audit Log ─────────────────────────────────────────────────────────────────
async function loadAudit() {
  const params = new URLSearchParams({ page: auditPage, page_size: 50 });
  try {
    const data = await api('GET', `/audit?${params}`);
    const el   = document.getElementById('audit-list');
    if (!el) return;
    if (!data.data.length) { el.innerHTML = '<div class="text-muted text-sm" style="padding:2rem;text-align:center">No audit entries.</div>'; return; }
    el.innerHTML = data.data.map(a => `
      <div class="audit-item">
        <div class="audit-dot"></div>
        <div style="flex:1">
          <div class="audit-action">${esc(a.action)} <span style="color:var(--text-muted);font-weight:400">by ${esc(a.username || `User #${a.user_id}`)}</span></div>
          <div class="audit-detail">${esc(a.target || '')} ${a.detail ? '— ' + esc(a.detail) : ''}</div>
        </div>
        <div class="audit-time">${fmtDate(a.created_at)}</div>
      </div>`).join('');
    renderPagination('audit-pagination-controls', 'audit-pagination-info',
      data.page, data.pages, data.total, p => { auditPage = p; loadAudit(); });
  } catch (err) { showToast(err.message, 'error'); }
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
