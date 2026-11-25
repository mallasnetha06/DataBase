/* ═══════════════════════════════════════════════════════════════════════════
   manager.js — Manager Dashboard & Employee Details
   Depends on: core.js (api, token, currentUser, showToast, fmtDate, etc.)
═══════════════════════════════════════════════════════════════════════════ */

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let mgrCharts       = {};
let currentRevPeriod = 'daily';
let allEmpProfiles  = [];
let empRoleFilter   = 'all';
let invoicePage     = 0;
const INVOICE_LIMIT = 50;

// ── Chart defaults ─────────────────────────────────────────────────────────────
const CHART_DEFAULTS = {
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 600, easing: 'easeOutQuart' },
  plugins: {
    legend: {
      labels: { color: 'rgba(148,163,184,0.9)', font: { size: 11, family: "'Inter','Segoe UI',sans-serif" } },
    },
    tooltip: {
      backgroundColor: 'rgba(15,23,42,0.95)',
      titleColor: '#f8fafc',
      bodyColor: '#94a3b8',
      borderColor: 'rgba(139,92,246,0.3)',
      borderWidth: 1,
      padding: 10,
    },
  },
};

// Palette
const PURPLE_GRADIENT_FN = (ctx) => {
  if (!ctx || !ctx.chart || !ctx.chart.ctx) return '#8b5cf6';
  const gradient = ctx.chart.ctx.createLinearGradient(0, 0, 0, ctx.chart.height || 300);
  gradient.addColorStop(0, 'rgba(139,92,246,0.5)');
  gradient.addColorStop(1, 'rgba(139,92,246,0)');
  return gradient;
};
const PALETTE = ['#8b5cf6','#3b82f6','#10b981','#f59e0b','#ec4899','#14b8a6','#6366f1','#f87171'];

function destroyChart(id) {
  if (mgrCharts[id]) { mgrCharts[id].destroy(); delete mgrCharts[id]; }
}

// ── Utility ────────────────────────────────────────────────────────────────────
function fmtMoney(v) {
  if (v == null) return '—';
  const n = Number(v);
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(2);
}

function invoiceStatusBadge(status) {
  const cls = (status || '').toLowerCase();
  return `<span class="invoice-status-badge ${cls}">${status}</span>`;
}



// ═══════════════════════════════════════════════════════════════════════════════
// MANAGER DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════

async function loadManagerDashboard() {
  // Greet
  const el = document.getElementById('mgr-greeting');
  if (el && currentUser) el.textContent = `Welcome back, ${currentUser.username} 👋`;

  try {
    const [kpiRes, adminPerfRes, campaignRes, journalRevRes] = await Promise.allSettled([
      api('GET', '/manager/dashboard'),
      api('GET', '/manager/admins/progress'),
      api('GET', '/manager/campaign-stats'),
      api('GET', '/manager/journals/revenue?limit=8'),
    ]);

    const kpi = kpiRes.status === 'fulfilled' ? kpiRes.value : null;
    const adminPerf = adminPerfRes.status === 'fulfilled' ? adminPerfRes.value : [];
    const campaignData = campaignRes.status === 'fulfilled' ? campaignRes.value : { daily_used: [], by_journal: [] };
    const journalRev = journalRevRes.status === 'fulfilled' ? journalRevRes.value : [];

    if (kpi) {
      renderKPIs(kpi);
      renderInvoiceDonut(kpi);
    }
    renderAdminPerf(adminPerf);
    renderJournalRevChart(journalRev);
    renderCampaignChart(campaignData);
    renderReachJournalChart(campaignData.by_journal || []);
    await loadRevenuChart('daily', document.querySelector('.chart-period-tab.active'));
    await loadRecentInvoices();

    // Initialise drag/resize grid (restores saved layout)
    if (typeof initDashboardGrid === 'function') initDashboardGrid();
  } catch(e) {
    console.error('[Manager Dashboard]', e);
  }
}


// ── KPI Cards ─────────────────────────────────────────────────────────────────
function renderKPIs(d) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('kpi-total-rev',   fmtMoney(d.total_revenue));
  set('kpi-month-rev',   fmtMoney(d.revenue_this_month));
  set('kpi-invoices',    d.total_invoices.toLocaleString());
  set('kpi-invoices-sub', `${d.approved_invoices} approved`);
  set('kpi-pending',     d.pending_invoices.toLocaleString());
  set('kpi-approvals',   d.total_approvals.toLocaleString());
  set('kpi-approvals-sub', `${d.approvals_this_month} this month`);
  set('kpi-reach',       `${d.reach_rate}%`);
  set('kpi-admins',      d.admin_count.toLocaleString());
  set('kpi-users-sub',   `${d.total_users} total users`);
  set('kpi-task-rate',   `${d.task_completion_rate}%`);
  set('kpi-task-sub',    `${d.completed_tasks}/${d.total_tasks} tasks done`);
}

// ── Revenue Trend Chart ───────────────────────────────────────────────────────
async function loadRevenuChart(period, btn) {
  currentRevPeriod = period;
  // Update tab state
  document.querySelectorAll('.chart-period-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  try {
    const data = await api('GET', `/manager/revenue/${period}`);
    const labels = data.map(r => {
      if (period === 'weekly' && r.start_date) {
        const d = new Date(r.start_date);
        const year = d.getFullYear();
        const month = d.toLocaleString('en-US', { month: 'short' });
        const weekOfMonth = Math.ceil(d.getDate() / 7);
        return `${year}-${month}-W${weekOfMonth}`;
      }
      return r.week || r.month || r.year || r.date || '';
    });
    const values = data.map(r => r.revenue || 0);

    destroyChart('revenue-trend');
    const ctx = document.getElementById('chart-revenue-trend');
    if (!ctx) return;

    mgrCharts['revenue-trend'] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Revenue',
          data: values,
          borderColor: '#8b5cf6',
          backgroundColor: PURPLE_GRADIENT_FN,
          borderWidth: 2.5,
          tension: 0.4,
          fill: true,
          pointBackgroundColor: '#8b5cf6',
          pointRadius: 3,
          pointHoverRadius: 6,
        }],
      },
      options: {
        ...CHART_DEFAULTS,
        scales: {
          x: { ticks: { color: '#64748b', maxTicksLimit: 10, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
          y: { ticks: { color: '#64748b', callback: v => fmtMoney(v), font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.06)' } },
        },
        plugins: {
          ...CHART_DEFAULTS.plugins,
          tooltip: { ...CHART_DEFAULTS.plugins.tooltip, callbacks: { label: ctx => ' ' + fmtMoney(ctx.parsed.y) } },
        },
      },
    });
  } catch(e) { console.error('Revenue chart', e); }
}

// ── Invoice Donut ─────────────────────────────────────────────────────────────
function renderInvoiceDonut(d) {
  destroyChart('invoice-donut');
  const ctx = document.getElementById('chart-invoice-donut');
  if (!ctx) return;

  const paid     = d.total_invoices - d.pending_invoices - (d.total_invoices - d.approved_invoices - d.pending_invoices);
  const approved = d.approved_invoices;
  const pending  = d.pending_invoices;
  const rejected = Math.max(0, d.total_invoices - approved - pending);

  mgrCharts['invoice-donut'] = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Approved/Paid', 'Pending', 'Rejected'],
      datasets: [{
        data: [approved, pending, rejected],
        backgroundColor: ['#10b981', '#f59e0b', '#ef4444'],
        borderColor: '#1e2130',
        borderWidth: 3,
        hoverOffset: 8,
      }],
    },
    options: {
      ...CHART_DEFAULTS,
      cutout: '65%',
      plugins: { ...CHART_DEFAULTS.plugins, legend: { position: 'bottom', labels: { color: '#94a3b8', font: { size: 11 } } } },
    },
  });
}

// ── Journal Revenue Bar ───────────────────────────────────────────────────────
function renderJournalRevChart(journals) {
  destroyChart('journal-rev');
  const ctx = document.getElementById('chart-journal-rev');
  if (!ctx) return;

  mgrCharts['journal-rev'] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: journals.map(j => j.brand_name),
      datasets: [{
        label: 'Revenue ($)',
        data: journals.map(j => j.total_revenue),
        backgroundColor: PALETTE,
        borderRadius: 6,
        borderSkipped: false,
      }],
    },
    options: {
      ...CHART_DEFAULTS,
      indexAxis: 'y',
      scales: {
        x: { ticks: { color: '#64748b', callback: v => fmtMoney(v), font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.06)' } },
        y: { ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.02)' } },
      },
    },
  });
}

// ── Admin Performance ─────────────────────────────────────────────────────────
function renderAdminPerf(admins) {
  const container = document.getElementById('admin-perf-list');
  if (!container) return;
  if (!admins || admins.length === 0) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:0.82rem;padding:1rem;text-align:center">No admin data yet</div>';
    return;
  }
  container.innerHTML = admins.map(a => `
    <div class="admin-perf-item">
      <div class="admin-perf-avatar">${a.username.charAt(0).toUpperCase()}</div>
      <div class="admin-perf-info">
        <div class="admin-perf-name">${escHtml(a.username)}</div>
        <div class="admin-perf-stats">${a.completed}/${a.total} tasks · ${a.in_progress} in progress</div>
      </div>
      <div class="admin-perf-bar-wrap">
        <div class="admin-perf-bar-bg">
          <div class="admin-perf-bar-fill" style="width:${a.completion_rate}%"></div>
        </div>
        <div class="admin-perf-rate">${a.completion_rate}%</div>
      </div>
    </div>`).join('');
}

// ── Campaign Chart ────────────────────────────────────────────────────────────
function renderCampaignChart(data) {
  destroyChart('campaign');
  const ctx = document.getElementById('chart-campaign');
  if (!ctx) return;
  const daily = data.daily_used || [];

  mgrCharts['campaign'] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: daily.map(r => r.day),
      datasets: [{
        label: 'Emails Used',
        data: daily.map(r => r.used),
        backgroundColor: 'rgba(59,130,246,0.7)',
        borderColor: '#3b82f6',
        borderWidth: 1,
        borderRadius: 4,
      }],
    },
    options: {
      ...CHART_DEFAULTS,
      scales: {
        x: { ticks: { color: '#64748b', maxTicksLimit: 10, font: { size: 9 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
        y: { ticks: { color: '#64748b', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.06)' } },
      },
    },
  });
}

// ── Reach by Journal chart ────────────────────────────────────────────────────
function renderReachJournalChart(byJournal) {
  destroyChart('reach-journal');
  const ctx = document.getElementById('chart-reach-journal');
  if (!ctx) return;
  const top = (byJournal || []).slice(0, 8);

  mgrCharts['reach-journal'] = new Chart(ctx, {
    type: 'polarArea',
    data: {
      labels: top.map(j => j.journal_name),
      datasets: [{
        data: top.map(j => j.total),
        backgroundColor: PALETTE.map(c => c + 'aa'),
        borderColor: PALETTE,
        borderWidth: 1.5,
      }],
    },
    options: {
      ...CHART_DEFAULTS,
      plugins: { ...CHART_DEFAULTS.plugins, legend: { position: 'bottom', labels: { color: '#94a3b8', font: { size: 10 } } } },
    },
  });
}

// ── Recent Invoices Table ─────────────────────────────────────────────────────
async function loadRecentInvoices() {
  const tbody = document.getElementById('mgr-invoice-tbody');
  if (!tbody) return;
  try {
    const data = await api('GET', '/manager/invoices?limit=15&offset=0');
    const items = data.items || [];
    if (items.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:1.5rem">No invoices yet</td></tr>';
      return;
    }
    tbody.innerHTML = items.map(inv => `
      <tr>
        <td>${inv.invoice_date || '—'}</td>
        <td>${escHtml(inv.client_name)}</td>
        <td>${escHtml(inv.journal_name || '—')}</td>
        <td style="font-weight:700;color:#34d399">$${Number(inv.amount || 0).toFixed(2)}</td>
        <td>${invoiceStatusBadge(inv.status)}</td>
      </tr>`).join('');
  } catch(e) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--danger)">Failed to load</td></tr>';
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// MANAGER INVOICES (full page)
// ═══════════════════════════════════════════════════════════════════════════════

async function loadManagerInvoices() {
  const tbody = document.getElementById('invoice-full-tbody');
  if (!tbody) return;
  const status = document.getElementById('invoice-status-filter')?.value || 'All';
  const qs = `?status=${encodeURIComponent(status)}&limit=${INVOICE_LIMIT}&offset=${invoicePage * INVOICE_LIMIT}`;

  try {
    const data = await api('GET', '/manager/invoices' + qs);
    const items = data.items || [];
    if (items.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:2rem">No invoices found</td></tr>';
      return;
    }
    tbody.innerHTML = items.map(inv => `
      <tr>
        <td>${inv.invoice_date || '—'}</td>
        <td>${escHtml(inv.client_name)}</td>
        <td>${escHtml(inv.journal_name || '—')}</td>
        <td style="font-weight:700;color:#34d399">$${Number(inv.amount || 0).toFixed(2)}</td>
        <td>${invoiceStatusBadge(inv.status)}</td>
        <td>${escHtml(inv.approver_name || '—')}</td>
      </tr>`).join('');
  } catch(e) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--danger)">Error loading invoices</td></tr>';
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// EMPLOYEE DETAILS
// ═══════════════════════════════════════════════════════════════════════════════

async function loadEmployeeDetails() {
  try {
    allEmpProfiles = await api('GET', '/employee-profiles');
    renderEmpGrid();
  } catch(e) {
    const grid = document.getElementById('emp-grid');
    if (grid) grid.innerHTML = '<div style="color:var(--danger)">Failed to load profiles</div>';
  }
}

function filterEmpByRole(role, btn) {
  empRoleFilter = role;
  document.querySelectorAll('.emp-role-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderEmpGrid();
}

function renderEmpGrid() {
  const grid = document.getElementById('emp-grid');
  if (!grid) return;
  const filtered = empRoleFilter === 'all'
    ? allEmpProfiles
    : allEmpProfiles.filter(p => p.role === empRoleFilter);

  if (filtered.length === 0) {
    grid.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;padding:2rem">No employees in this category</div>';
    return;
  }

  const isManager = currentUser && (currentUser.role === 'manager' || currentUser.role === 'overlord');

  grid.innerHTML = filtered.map(p => `
    <div class="emp-card">
      <span class="emp-role-badge ${p.role}">${p.role}</span>
      <div class="emp-card-header">
        <div class="emp-avatar-lg ${p.role}">${p.username.charAt(0).toUpperCase()}</div>
        <div>
          <div class="emp-card-name">${escHtml(p.username)}</div>
          <div class="emp-card-title">${escHtml(p.title || 'No title set')}</div>
          <div class="emp-card-dept">🏢 ${escHtml(p.department)}</div>
        </div>
      </div>
      ${(p.responsibilities || []).length > 0 ? `
        <div class="emp-section-label">Responsibilities</div>
        <ul class="emp-responsibilities">
          ${p.responsibilities.map(r => `<li>${escHtml(r)}</li>`).join('')}
        </ul>` : ''}
      ${(p.skills || []).length > 0 ? `
        <div class="emp-section-label">Skills</div>
        <div class="emp-skills-wrap">
          ${p.skills.map(s => `<span class="emp-skill-tag">${escHtml(s)}</span>`).join('')}
        </div>` : ''}
      ${isManager ? `<button class="emp-edit-btn" onclick="openEmpEditModal(${p.user_id})">✏️ Edit Profile</button>` : ''}
    </div>`).join('');
}

function openEmpEditModal(userId) {
  const profile = userId ? allEmpProfiles.find(p => p.user_id === userId) : null;
  document.getElementById('emp-edit-user-id').value = userId || '';
  document.getElementById('emp-edit-title').value  = profile?.title || '';
  document.getElementById('emp-edit-dept').value   = profile?.department || 'Operations';
  document.getElementById('emp-edit-skills').value = (profile?.skills || []).join(', ');
  document.getElementById('emp-edit-resp').value   = (profile?.responsibilities || []).join('\n');
  document.getElementById('emp-edit-error').style.display = 'none';
  openModal('emp-edit-modal');
}

async function saveEmpProfile() {
  const userId = document.getElementById('emp-edit-user-id').value;
  if (!userId) return;
  const errEl = document.getElementById('emp-edit-error');
  errEl.style.display = 'none';

  const title = document.getElementById('emp-edit-title').value.trim();
  const dept  = document.getElementById('emp-edit-dept').value.trim();
  const skills = document.getElementById('emp-edit-skills').value
    .split(',').map(s => s.trim()).filter(Boolean);
  const responsibilities = document.getElementById('emp-edit-resp').value
    .split('\n').map(s => s.trim()).filter(Boolean);

  if (!title) { errEl.textContent = 'Job title is required.'; errEl.style.display = 'block'; return; }

  const btn = document.getElementById('btn-save-emp');
  btn.disabled = true; btn.textContent = 'Saving…';

  try {
    await api('PUT', `/employee-profiles/${userId}`, { title, department: dept, skills, responsibilities });
    closeModal('emp-edit-modal');
    showToast('Profile updated successfully', 'success');
    await loadEmployeeDetails();
  } catch(e) {
    errEl.textContent = e.message || 'Failed to save.';
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = 'Save Profile';
  }
}

// ── HTML escape helper ─────────────────────────────────────────────────────────
function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

