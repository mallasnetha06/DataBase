/* ═══════════════════════════════════════════════════════════════════════════
   DataBase — js/nav.js
   Sidebar navigation · Panel switching · Page titles
   Depends on: core.js, and each page's loader function
═══════════════════════════════════════════════════════════════════════════ */

const PANEL_TITLES = {
  'dashboard':            'Dashboard',
  'scraping-all':         'Data Scraping — All Records',
  'scraping-mine':        'My Collection',
  'scraping-upload':      'Batch Upload',
  'templates':            'Email Templates',
  'campaign-composer':    '🎯 Campaign Composer',
  'kanban-mine':          '🗂️ My Task Board',
  'kanban-admin':         '📋 Manage Kanban Sheets',
  'progress-mine':        'My Progress',
  'progress-team':        'Team Progress',
  'progress-charts':      'Progress Charts',
  'users':                'User Management',
  'audit':                'Audit Log',
  'overlord-db':          '⚡ DB Console',
  'overlord-payload':     '⚡ Payload Inspector',
  'overlord-monitor':     '⚡ Server Monitor',
  // ── Manager panels ────────────────────────────────────────────────────────
  'manager-dashboard':    '📊 Analytics Dashboard',
  'manager-invoices':     '🧾 Invoices',
  'employee-details':     '👥 Employee Directory',
};

function showPanel(id) {

  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const panel = document.getElementById(`panel-${id}`);
  if (panel) panel.classList.add('active');

  const nav = document.getElementById(`nav-${id}`);
  if (nav) nav.classList.add('active');

  const title = document.getElementById('page-title');
  if (title) title.textContent = PANEL_TITLES[id] || id;

  const topBarActions = document.getElementById('top-bar-actions');
  if (topBarActions) topBarActions.innerHTML = '';

  // ── Lazy-load panel data ──────────────────────────────────────────────────
  const loaders = {
    'dashboard':            loadDashboard,
    'scraping-all':         loadScraping,
    'scraping-mine':        loadMineCollection,
    'scraping-upload':      () => { if (typeof initUploadPanel === 'function') initUploadPanel(); },
    'templates':            () => loadTemplates(),
    'campaign-composer':    () => loadCampaignComposer(),
    'kanban-mine':        loadMyKanban,
    'kanban-admin':       loadKanbanAdmin,
    'progress-mine':        () => { if (typeof loadMyProgress      === 'function') loadMyProgress();      },
    'progress-team':        () => { if (typeof loadTeamProgress    === 'function') loadTeamProgress();    },
    'progress-charts':      () => { if (typeof loadProgressCharts  === 'function') loadProgressCharts();  },
    'users':                () => { loadPendingUsers(); loadUsers(); },
    'audit':                loadAudit,
    'overlord-db':          loadDbTables,
    'overlord-payload':     loadPayloads,
    'overlord-monitor':     startMonitor,
    // ── Manager panels ──────────────────────────────────────────────────────
    'manager-dashboard':    () => { if (typeof loadManagerDashboard === 'function') loadManagerDashboard(); },
    'manager-invoices':     () => { if (typeof loadManagerInvoices  === 'function') loadManagerInvoices();  },
    'employee-details':     () => { if (typeof loadEmployeeDetails  === 'function') loadEmployeeDetails();  },
  };

  if (loaders[id]) loaders[id]();
}
