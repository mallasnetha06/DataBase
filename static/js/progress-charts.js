/* ═══════════════════════════════════════════════════════════════════════════
   DataBase — js/progress-charts.js
   Progress Charts panel — renders three Chart.js graphs driven by the
   /progress/stats admin endpoint.

   Charts:
     1. Tasks by Date  — stacked bar  (chart-by-date)
     2. Status Distribution — doughnut (chart-status)
     3. Top Contributors — horizontal bar (chart-per-user)

   Entry point: loadProgressCharts()  — called by nav.js showPanel()
   Depends on: core.js (api, charts, showToast), Chart.js CDN
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

// -- Palette -------------------------------------------------------------------

const _PC_COLORS = {
  completed:   { bg: 'rgba( 34,197, 94,0.80)', border: '#22c55e' },
  in_progress: { bg: 'rgba(251,191, 36,0.80)', border: '#fbbf24' },
  not_started: { bg: 'rgba(148,163,184,0.55)', border: '#94a3b8' },
};

// -- Chart.js global defaults --------------------------------------------------

(function _setChartDefaults() {
  if (typeof Chart === 'undefined') return;
  Chart.defaults.color            = '#94a3b8';
  Chart.defaults.font.family      = 'Inter, system-ui, sans-serif';
  Chart.defaults.font.size        = 12;
  Chart.defaults.plugins.legend.labels.boxWidth = 12;
})();

// -- Teardown helper -----------------------------------------------------------

function _destroyChart(key) {
  if (charts[key]) {
    charts[key].destroy();
    delete charts[key];
  }
}

// -- Entry point ---------------------------------------------------------------

async function loadProgressCharts() {
  const days = parseInt(
    (document.getElementById('chart-days-filter') || {}).value || 30, 10
  );

  console.log('[ProgressCharts] Loading with days =', days);

  ['chart-by-date', 'chart-status', 'chart-per-user'].forEach(id => {
    const canvas = document.getElementById(id);
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (parent && !parent.querySelector('.pc-loading')) {
      const loader = document.createElement('div');
      loader.className = 'pc-loading';
      loader.style.cssText = [
        'position:absolute;inset:0;display:flex;align-items:center;',
        'justify-content:center;font-size:0.8rem;color:var(--text-muted);',
        'background:rgba(15,23,42,0.55);border-radius:inherit;z-index:5;',
        'backdrop-filter:blur(2px);pointer-events:none',
      ].join('');
      loader.textContent = 'Loading...';
      if (getComputedStyle(parent).position === 'static') {
        parent.style.position = 'relative';
      }
      parent.appendChild(loader);
    }
  });

  let data, kpiData;
  try {
    // Cache-bust the stats request so the browser always fetches fresh data
    // when the user changes the day-range dropdown.
    const cacheBust = '&_t=' + Date.now();
    [data, kpiData] = await Promise.all([
      api('GET', '/progress/stats?days=' + days + cacheBust),
      _pcFetchKpiData(days),
    ]);
  } catch (err) {
    showToast('Failed to load chart data: ' + err.message, 'error');
    document.querySelectorAll('.pc-loading').forEach(el => el.remove());
    return;
  }

  document.querySelectorAll('.pc-loading').forEach(el => el.remove());

  _renderByDate(data.by_date      || []);
  _renderStatus(data.status_counts || []);
  _renderPerUser(data.per_user     || []);

  _pcRenderKPIs(kpiData.kpiSummary);
  _pcRenderInvoiceDonut(kpiData.invoiceSummary);
  _pcRenderJournalRev(kpiData.journalsRevenue);
  _pcRenderCampaign(kpiData.campaign);
  _pcRenderAdminPerf(kpiData.adminPerf);
  _pcRenderReachJournal(kpiData.campaign.by_journal || []);
  _pcRenderRecentInvoices((kpiData.recentInvoices || {}).items || []);
  await loadPcRevenueTrend('daily', document.querySelector('#pc-revenue-tabs .chart-period-tab.active'));

  if (typeof initProgressGrid === 'function') initProgressGrid();
}

// -- 1. Stacked Bar: Tasks by Date ---------------------------------------------

function _renderByDate(byDate) {
  _destroyChart('byDate');
  const canvas = document.getElementById('chart-by-date');
  if (!canvas) return;

  const labels     = byDate.map(d => d.date);
  const completed  = byDate.map(d => d.completed);
  const inProgress = byDate.map(d => d.in_progress);
  const notStarted = byDate.map(d => d.not_started);

  charts['byDate'] = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Completed',   data: completed,  backgroundColor: _PC_COLORS.completed.bg,   borderColor: _PC_COLORS.completed.border,   borderWidth: 1, borderRadius: 3, stack: 'status' },
        { label: 'In Progress', data: inProgress, backgroundColor: _PC_COLORS.in_progress.bg, borderColor: _PC_COLORS.in_progress.border, borderWidth: 1, borderRadius: 3, stack: 'status' },
        { label: 'Not Started', data: notStarted, backgroundColor: _PC_COLORS.not_started.bg, borderColor: _PC_COLORS.not_started.border, borderWidth: 1, borderRadius: 3, stack: 'status' },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', labels: { padding: 16, usePointStyle: true, pointStyleWidth: 10 } },
        tooltip: { callbacks: { footer: items => 'Total: ' + items.reduce((s, i) => s + i.parsed.y, 0) } },
      },
      scales: {
        x: { stacked: true, grid: { color: 'rgba(148,163,184,0.08)' }, ticks: { maxRotation: 45, autoSkip: true, maxTicksLimit: 14 } },
        y: { stacked: true, beginAtZero: true, grid: { color: 'rgba(148,163,184,0.08)' }, ticks: { stepSize: 1 } },
      },
      animation: { duration: 600, easing: 'easeOutQuart' },
    },
  });
}

// -- 2. Doughnut: Status Distribution ------------------------------------------

function _renderStatus(statusCounts) {
  _destroyChart('status');
  const canvas = document.getElementById('chart-status');
  if (!canvas) return;

  const COLOR_MAP  = { 'Completed': _PC_COLORS.completed.bg,   'In Progress': _PC_COLORS.in_progress.bg,   'Not Started': _PC_COLORS.not_started.bg   };
  const BORDER_MAP = { 'Completed': _PC_COLORS.completed.border,'In Progress': _PC_COLORS.in_progress.border,'Not Started': _PC_COLORS.not_started.border };

  const labels = statusCounts.map(s => s.task_status);
  const values = statusCounts.map(s => s.count);
  const total  = values.reduce((a, b) => a + b, 0);

  charts['status'] = new Chart(canvas.getContext('2d'), {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: labels.map(l => COLOR_MAP[l]  || 'rgba(100,116,139,0.6)'),
        borderColor:     labels.map(l => BORDER_MAP[l] || '#64748b'),
        borderWidth: 2, hoverOffset: 8,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '62%',
      plugins: {
        legend: { position: 'bottom', labels: { padding: 14, usePointStyle: true, pointStyleWidth: 9 } },
        tooltip: { callbacks: { label: item => { const pct = total ? Math.round((item.parsed / total) * 100) : 0; return ' ' + item.label + ': ' + item.parsed + ' (' + pct + '%)'; } } },
      },
      animation: { duration: 700, easing: 'easeOutBack' },
    },
    plugins: [{
      id: 'centreLabel',
      afterDraw(chart) {
        if (chart.config.type !== 'doughnut') return;
        const { ctx: c, chartArea: { width, height, top, left } } = chart;
        c.save();
        c.font = '700 1.35rem Inter, system-ui, sans-serif'; c.fillStyle = '#f1f5f9'; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(total, left + width / 2, top + height / 2 - 8);
        c.font = '0.7rem Inter, system-ui, sans-serif'; c.fillStyle = '#94a3b8';
        c.fillText('Total Tasks', left + width / 2, top + height / 2 + 12);
        c.restore();
      },
    }],
  });
}

// -- 3. Horizontal Bar: Top Contributors ---------------------------------------

function _renderPerUser(perUser) {
  _destroyChart('perUser');
  const canvas = document.getElementById('chart-per-user');
  if (!canvas) return;

  const labels    = perUser.map(u => u.username);
  const totals    = perUser.map(u => u.total);
  const completed = perUser.map(u => u.completed);
  const barBgs    = perUser.map(u => { const r = u.total ? u.completed / u.total : 0; const g = Math.round(r * 200 + 55); return 'rgba(34,' + g + ',94,0.75)'; });

  charts['perUser'] = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Total Tasks', data: totals,    backgroundColor: 'rgba(99,102,241,0.50)', borderColor: '#6366f1', borderWidth: 1, borderRadius: 4 },
        { label: 'Completed',   data: completed, backgroundColor: barBgs,                 borderColor: '#22c55e', borderWidth: 1, borderRadius: 4 },
      ],
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top', labels: { padding: 14, usePointStyle: true, pointStyleWidth: 9 } },
        tooltip: { callbacks: { afterLabel: item => { if (item.datasetIndex === 1) { const t = totals[item.dataIndex]; const pct = t ? Math.round((item.parsed.x / t) * 100) : 0; return 'Completion: ' + pct + '%'; } return ''; } } },
      },
      scales: {
        x: { beginAtZero: true, grid: { color: 'rgba(148,163,184,0.08)' }, ticks: { stepSize: 1 } },
        y: { grid: { display: false }, ticks: { font: { size: 11 } } },
      },
      animation: { duration: 650, easing: 'easeOutQuart' },
    },
  });
}

// =============================================================================
// KPI / Financial Charts — fetched from /progress/analytics/* endpoints
// Admin-accessible mirrors of the manager dashboard charts.
// =============================================================================

const _PC_PALETTE = ['#8b5cf6','#3b82f6','#10b981','#f59e0b','#ec4899','#14b8a6','#6366f1','#f87171'];

function _pcFmtMoney(v) {
  if (v == null) return 'u2014';
  const n = Number(v);
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(2);
}

// -- Parallel fetch of all KPI data -------------------------------------------

async function _pcFetchKpiData(days) {
  const qs = `?days=${days}&_t=` + Date.now();
  try {
    const [kpiSummary, invoiceSummary, journalsRevenue, campaign, adminPerf, recentInvoices] = await Promise.all([
      api('GET', '/progress/analytics/kpi-summary'     + qs),
      api('GET', '/progress/analytics/invoice-summary' + qs),
      api('GET', '/progress/analytics/journals-revenue?limit=8&_t=' + Date.now()),
      api('GET', '/progress/analytics/campaign'        + qs),
      api('GET', '/progress/analytics/admin-perf'),
      api('GET', '/progress/analytics/recent-invoices?limit=15&offset=0'),
    ]);
    return { kpiSummary, invoiceSummary, journalsRevenue, campaign, adminPerf, recentInvoices };
  } catch (err) {
    console.warn('[Progress KPI]', err.message);
    return { kpiSummary: {}, invoiceSummary: {}, journalsRevenue: [], campaign: {}, adminPerf: [], recentInvoices: { items: [] } };
  }
}

// -- KPI Stat Cards -----------------------------------------------------------

function _pcRenderKPIs(d) {
  if (!d) return;
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('pc-kpi-total-rev',    _pcFmtMoney(d.total_revenue));
  set('pc-kpi-month-rev',    _pcFmtMoney(d.revenue_this_month));
  set('pc-kpi-invoices',     (d.total_invoices   || 0).toLocaleString());
  set('pc-kpi-invoices-sub', (d.approved_invoices || 0) + ' approved');
  set('pc-kpi-pending',      (d.pending_invoices  || 0).toLocaleString());
  set('pc-kpi-approvals',    (d.total_approvals   || 0).toLocaleString());
  set('pc-kpi-approvals-sub',(d.approvals_this_month || 0) + ' this month');
  set('pc-kpi-reach',        (d.reach_rate || 0) + '%');
  set('pc-kpi-task-rate',    (d.task_completion_rate || 0) + '%');
  set('pc-kpi-task-sub',     (d.completed_tasks || 0) + '/' + (d.total_tasks || 0) + ' tasks done');
}

// -- 4. Revenue Trend Line Chart -----------------------------------------------

let _pcRevPeriod = 'daily';

async function loadPcRevenueTrend(period, btn) {
  _pcRevPeriod = period;
  document.querySelectorAll('#pc-revenue-tabs .chart-period-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  try {
    const data   = await api('GET', '/progress/analytics/revenue/' + period);
    const labels = data.map(r => {
      if (period === 'weekly' && r.start_date) {
        const d = new Date(r.start_date);
        const month = d.toLocaleString('en-US', { month: 'short' });
        const weekOfMonth = Math.ceil(d.getDate() / 7);
        return d.getFullYear() + '-' + month + '-W' + weekOfMonth;
      }
      return r.week || r.month || r.year || r.date || '';
    });
    const values = data.map(r => r.revenue || 0);

    if (charts['pcRevenue']) { charts['pcRevenue'].destroy(); delete charts['pcRevenue']; }
    const ctx = document.getElementById('chart-pc-revenue');
    if (!ctx) return;

    const makeGradient = (c) => {
      if (!c || !c.chart || !c.chart.ctx) return '#8b5cf6';
      const g = c.chart.ctx.createLinearGradient(0, 0, 0, c.chart.height || 300);
      g.addColorStop(0, 'rgba(139,92,246,0.5)');
      g.addColorStop(1, 'rgba(139,92,246,0)');
      return g;
    };

    charts['pcRevenue'] = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets: [{ label: 'Revenue', data: values, borderColor: '#8b5cf6', backgroundColor: makeGradient, borderWidth: 2.5, tension: 0.4, fill: true, pointBackgroundColor: '#8b5cf6', pointRadius: 3, pointHoverRadius: 6 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 600, easing: 'easeOutQuart' },
        plugins: {
          legend: { labels: { color: 'rgba(148,163,184,0.9)', font: { size: 11 } } },
          tooltip: { backgroundColor: 'rgba(15,23,42,0.95)', titleColor: '#f8fafc', bodyColor: '#94a3b8', borderColor: 'rgba(139,92,246,0.3)', borderWidth: 1, padding: 10, callbacks: { label: ctx => ' ' + _pcFmtMoney(ctx.parsed.y) } },
        },
        scales: {
          x: { ticks: { color: '#64748b', maxTicksLimit: 10, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
          y: { ticks: { color: '#64748b', callback: v => _pcFmtMoney(v), font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.06)' } },
        },
      },
    });
  } catch(e) { console.error('[PC Revenue]', e); }
}

// -- 5. Breakdown by Approval Status (Invoice Donut) ---------------------------

function _pcRenderInvoiceDonut(d) {
  if (charts['pcInvoiceDonut']) { charts['pcInvoiceDonut'].destroy(); delete charts['pcInvoiceDonut']; }
  const ctx = document.getElementById('chart-pc-invoice-donut');
  if (!ctx) return;
  if (!d || !d.total_invoices) {
    ctx.parentElement.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;padding:1rem;text-align:center">No invoice data yet</div>';
    return;
  }
  const approved = d.approved_invoices || 0;
  const pending  = d.pending_invoices  || 0;
  const rejected = Math.max(0, (d.total_invoices || 0) - approved - pending);

  charts['pcInvoiceDonut'] = new Chart(ctx, {
    type: 'doughnut',
    data: { labels: ['Approved/Paid', 'Pending', 'Rejected'], datasets: [{ data: [approved, pending, rejected], backgroundColor: ['#10b981','#f59e0b','#ef4444'], borderColor: '#1e2130', borderWidth: 3, hoverOffset: 8 }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '65%',
      animation: { duration: 700, easing: 'easeOutBack' },
      plugins: {
        legend: { position: 'bottom', labels: { color: '#94a3b8', font: { size: 11 } } },
        tooltip: { backgroundColor: 'rgba(15,23,42,0.95)', titleColor: '#f8fafc', bodyColor: '#94a3b8', borderColor: 'rgba(139,92,246,0.3)', borderWidth: 1, padding: 10 },
      },
    },
  });
}

// -- 6. Top 8 Journals by Revenue (Horizontal Bar) ----------------------------

function _pcRenderJournalRev(journals) {
  if (charts['pcJournalRev']) { charts['pcJournalRev'].destroy(); delete charts['pcJournalRev']; }
  const ctx = document.getElementById('chart-pc-journal-rev');
  if (!ctx) return;

  charts['pcJournalRev'] = new Chart(ctx, {
    type: 'bar',
    data: { labels: (journals || []).map(j => j.brand_name), datasets: [{ label: 'Revenue ($)', data: (journals || []).map(j => j.total_revenue), backgroundColor: _PC_PALETTE, borderRadius: 6, borderSkipped: false }] },
    options: {
      responsive: true, maintainAspectRatio: false, indexAxis: 'y',
      animation: { duration: 600, easing: 'easeOutQuart' },
      plugins: {
        legend: { labels: { color: 'rgba(148,163,184,0.9)', font: { size: 11 } } },
        tooltip: { backgroundColor: 'rgba(15,23,42,0.95)', titleColor: '#f8fafc', bodyColor: '#94a3b8', borderColor: 'rgba(139,92,246,0.3)', borderWidth: 1, padding: 10, callbacks: { label: c => ' ' + _pcFmtMoney(c.parsed.x) } },
      },
      scales: {
        x: { ticks: { color: '#64748b', callback: v => _pcFmtMoney(v), font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.06)' } },
        y: { ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.02)' } },
      },
    },
  });
}

// -- 7. Daily Emails Sent — last 30 days (Campaign Bar) -----------------------

function _pcRenderCampaign(data) {
  if (charts['pcCampaign']) { charts['pcCampaign'].destroy(); delete charts['pcCampaign']; }
  const ctx   = document.getElementById('chart-pc-campaign');
  if (!ctx) return;
  const daily = (data && data.daily_used) || [];

  charts['pcCampaign'] = new Chart(ctx, {
    type: 'bar',
    data: { labels: daily.map(r => r.day), datasets: [{ label: 'Emails Used', data: daily.map(r => r.used), backgroundColor: 'rgba(59,130,246,0.7)', borderColor: '#3b82f6', borderWidth: 1, borderRadius: 4 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 600, easing: 'easeOutQuart' },
      plugins: {
        legend: { labels: { color: 'rgba(148,163,184,0.9)', font: { size: 11 } } },
        tooltip: { backgroundColor: 'rgba(15,23,42,0.95)', titleColor: '#f8fafc', bodyColor: '#94a3b8', borderColor: 'rgba(139,92,246,0.3)', borderWidth: 1, padding: 10 },
      },
      scales: {
        x: { ticks: { color: '#64748b', maxTicksLimit: 10, font: { size: 9 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
        y: { ticks: { color: '#64748b', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.06)' } },
      },
    },
  });
}

// -- 8. Admin Performance List ------------------------------------------------

function _pcRenderAdminPerf(admins) {
  const container = document.getElementById('pc-admin-perf-list');
  if (!container) return;
  if (!admins || admins.length === 0) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:0.82rem;padding:1rem;text-align:center">No admin data yet</div>';
    return;
  }
  container.innerHTML = admins.map(a =>
    '<div class="admin-perf-item">' +
    '<div class="admin-perf-avatar">' + a.username.charAt(0).toUpperCase() + '</div>' +
    '<div class="admin-perf-info">' +
    '<div class="admin-perf-name">' + String(a.username).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</div>' +
    '<div class="admin-perf-stats">' + a.completed + '/' + a.total + ' tasks u00b7 ' + a.in_progress + ' in progress</div>' +
    '</div>' +
    '<div class="admin-perf-bar-wrap">' +
    '<div class="admin-perf-bar-bg"><div class="admin-perf-bar-fill" style="width:' + a.completion_rate + '%"></div></div>' +
    '<div class="admin-perf-rate">' + a.completion_rate + '%</div>' +
    '</div></div>'
  ).join('');
}

// -- 9. Email Records Scraped per Journal (Polar Area) -------------------------

function _pcRenderReachJournal(byJournal) {
  if (charts['pcReachJournal']) { charts['pcReachJournal'].destroy(); delete charts['pcReachJournal']; }
  const ctx = document.getElementById('chart-pc-reach-journal');
  if (!ctx) return;
  const top = (byJournal || []).slice(0, 8);
  if (top.length === 0) {
    ctx.parentElement.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;padding:1rem;text-align:center">No scraping data yet</div>';
    return;
  }
  charts['pcReachJournal'] = new Chart(ctx, {
    type: 'polarArea',
    data: { labels: top.map(j => j.journal_name), datasets: [{ data: top.map(j => j.total), backgroundColor: _PC_PALETTE.map(c => c + 'aa'), borderColor: _PC_PALETTE, borderWidth: 1.5 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 700, easing: 'easeOutBack' },
      plugins: {
        legend: { position: 'bottom', labels: { color: '#94a3b8', font: { size: 10 } } },
        tooltip: {
          backgroundColor: 'rgba(15,23,42,0.95)', titleColor: '#f8fafc', bodyColor: '#94a3b8', borderColor: 'rgba(139,92,246,0.3)', borderWidth: 1, padding: 10,
          callbacks: { label: item => { const j = top[item.dataIndex]; return ' Total: ' + j.total + '  Used: ' + j.used + '  Unused: ' + j.unused; } },
        },
      },
    },
  });
}

// -- 10. Most Recent Invoice Records Table ------------------------------------

function _pcRenderRecentInvoices(items) {
  const tbody = document.getElementById('pc-recent-invoices-tbody');
  if (!tbody) return;
  if (!items || items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:1.5rem">No invoices yet</td></tr>';
    return;
  }
  const esc   = s => s == null ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const badge = status => '<span class="invoice-status-badge ' + (status || '').toLowerCase() + '">' + esc(status) + '</span>';
  tbody.innerHTML = items.map(inv =>
    '<tr>' +
    '<td>' + esc(inv.invoice_date || 'u2014') + '</td>' +
    '<td>' + esc(inv.client_name) + '</td>' +
    '<td>' + esc(inv.journal_name || 'u2014') + '</td>' +
    '<td style="font-weight:700;color:#34d399">$' + Number(inv.amount || 0).toFixed(2) + '</td>' +
    '<td>' + badge(inv.status) + '</td>' +
    '</tr>'
  ).join('');
}
