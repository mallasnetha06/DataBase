/* ═══════════════════════════════════════════════════════════════════════════
   DataBase — js/dashboard.js
   Dashboard panel: stats from scraping + progress + recent records
   Depends on: core.js
═══════════════════════════════════════════════════════════════════════════ */

async function loadDashboard() {
  // Scraping stats
  try {
    const s = await api('GET', '/scraping/stats');
    setText('stat-total-scraping', s.total);
    setText('stat-unused',  s.unused);
    setText('stat-reserved', s.reserved);
    setText('stat-used',    s.used);
  } catch (_) {}

  // Progress stats (my own)
  try {
    const p = await api('GET', '/kanban/my-stats');
    setText('stat-total-progress', p.total);
    setText('stat-completed',      p.completed);
    setText('stat-in-progress',    p.in_progress);
    setText('stat-not-started',    p.not_started);
  } catch (_) {}

  // Admin: total user count
  if (currentUser?.role === 'admin') {
    try {
      const u = await api('GET', '/users');
      setText('stat-users', u.length || 0);
    } catch (_) {}
  }

  // Recent scraping entries (latest 5)
  try {
    const data = await api('GET', '/scraping?page=1&page_size=5');
    const tbody = document.getElementById('dashboard-scraping-tbody');
    if (!tbody) return;
    if (!data.data.length) { tbody.innerHTML = emptyRow(7, 'No records yet.'); return; }
    tbody.innerHTML = data.data.map(r => `
      <tr>
        <td class="td-truncate" style="max-width:120px">${esc(r.author_name)}</td>
        <td class="td-truncate">${esc(r.article_title)}</td>
        <td class="td-truncate">${esc(r.journal_name)}</td>
        <td class="td-truncate" style="max-width:160px">${esc(r.email)}</td>
        <td>${scrapingBadge(r.email_status)}</td>
        <td class="td-truncate" style="max-width:120px">${esc(r.website)}</td>
        <td style="white-space:nowrap">${fmtDate(r.created_at)}</td>
      </tr>`).join('');
  } catch (_) {}
}
