/* ═══════════════════════════════════════════════════════════════════════════
   DataBase — js/overlord.js
   Overlord-exclusive UI: DB Console, Payload Inspector, Server Monitor,
   Password Reset, Role Change.
   Depends on: core.js, admin.js
═══════════════════════════════════════════════════════════════════════════ */

// ── DB Console ────────────────────────────────────────────────────────────────

let _dbTab = 'select'; // 'select' | 'exec'

function switchDbTab(tab) {
  _dbTab = tab;
  document.getElementById('db-tab-select').className = tab === 'select' ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm';
  document.getElementById('db-tab-exec').className   = tab === 'exec'   ? 'btn btn-danger btn-sm'  : 'btn btn-ghost btn-sm';
  const ta = document.getElementById('db-sql-input');
  if (tab === 'exec') {
    ta.placeholder = 'UPDATE users SET is_approved=1 WHERE id=?;\n-- or: DELETE FROM data_scraping WHERE id=?;';
  } else {
    ta.placeholder = 'SELECT * FROM users LIMIT 20;';
  }
  document.getElementById('db-query-result').innerHTML = '';
}

async function loadDbTables() {
  try {
    const data = await api('GET', '/overlord/db/tables');
    const el   = document.getElementById('db-tables-list');
    if (!el) return;
    const tableNames = Object.keys(data);
    if (!tableNames.length) { el.innerHTML = '<span class="text-muted text-sm">No tables found.</span>'; return; }
    el.innerHTML = tableNames.map(t => {
      const cols = data[t];
      const colRows = cols.map(c =>
        `<div style="padding:2px 0 2px 10px;font-size:0.72rem;color:var(--text-muted)">${c.name} <span style="color:var(--text-secondary)">${c.type || 'TEXT'}</span>${c.primary_key ? ' 🔑' : ''}</div>`
      ).join('');
      return `
        <div style="margin-bottom:0.75rem">
          <div onclick="insertTableName('${t}')" style="font-size:0.8rem;font-weight:600;padding:4px 6px;border-radius:4px;cursor:pointer;color:var(--accent,#818cf8);background:rgba(129,140,248,0.08)" title="Click to insert table name">
            📋 ${t}
          </div>
          ${colRows}
        </div>`;
    }).join('');
  } catch (err) { showToast('Failed to load tables: ' + err.message, 'error'); }
}

function insertTableName(name) {
  const ta = document.getElementById('db-sql-input');
  if (!ta) return;
  const cur = ta.selectionStart;
  ta.value = ta.value.slice(0, cur) + name + ta.value.slice(cur);
  ta.focus();
}

async function runDbQuery() {
  const sql = (document.getElementById('db-sql-input').value || '').trim();
  if (!sql) { showToast('Enter a SQL statement first.', 'warning'); return; }

  const resultEl = document.getElementById('db-query-result');
  resultEl.innerHTML = '<div class="text-muted text-sm">Running…</div>';

  try {
    if (_dbTab === 'select') {
      const data = await api('POST', '/overlord/db/query', { sql });
      if (!data.columns.length) {
        resultEl.innerHTML = '<div class="text-muted text-sm" style="padding:1rem">No columns returned.</div>';
        return;
      }
      const thead = `<thead><tr>${data.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>`;
      const tbody = `<tbody>${data.rows.map(row =>
        `<tr>${row.map(cell => `<td style="font-size:0.8rem;max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(String(cell ?? ''))}">${esc(String(cell ?? ''))}</td>`).join('')}</tr>`
      ).join('')}</tbody>`;
      resultEl.innerHTML = `
        <div style="margin-bottom:0.4rem;font-size:0.75rem;color:var(--text-muted)">${data.row_count} row(s) returned</div>
        <div class="table-wrapper" style="max-height:300px;overflow:auto">
          <table>${thead}${tbody}</table>
        </div>`;
    } else {
      const data = await api('POST', '/overlord/db/exec', { sql });
      resultEl.innerHTML = `
        <div class="olcard" style="margin-top:0.5rem">
          <div style="color:var(--success);font-size:0.85rem;margin-bottom:0.4rem">✅ ${esc(data.message)}</div>
          <div class="text-muted text-sm">Rows affected: <strong>${data.rows_affected}</strong></div>
          ${data.last_insert_id ? `<div class="text-muted text-sm">Last insert ID: <strong>${data.last_insert_id}</strong></div>` : ''}
        </div>`;
    }
  } catch (err) {
    resultEl.innerHTML = `<div class="olcard" style="border-color:var(--danger);margin-top:0.5rem"><span style="color:var(--danger)">❌ ${esc(err.message)}</span></div>`;
  }
}

// Ctrl+Enter to run query
document.addEventListener('DOMContentLoaded', () => {
  const ta = document.getElementById('db-sql-input');
  if (ta) {
    ta.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runDbQuery(); }
    });
  }
});


// ── Payload Inspector ─────────────────────────────────────────────────────────

async function loadPayloads() {
  const limit = document.getElementById('payload-limit')?.value || 50;
  const el = document.getElementById('payload-list');
  if (!el) return;
  el.innerHTML = '<div class="text-muted text-sm" style="padding:1rem;text-align:center">Loading…</div>';
  try {
    const data = await api('GET', `/overlord/payload/recent?limit=${limit}`);
    if (!data.entries.length) {
      el.innerHTML = '<div class="text-muted text-sm" style="padding:2rem;text-align:center">No requests captured yet. Make some API calls first.</div>';
      return;
    }
    el.innerHTML = data.entries.map(e => {
      const statusColor = e.response_status >= 500 ? 'var(--danger)' :
                          e.response_status >= 400 ? 'var(--warning)' : 'var(--success)';
      const bodyPreview = e.body && e.body.length > 0 && e.body !== '*** redacted ***'
        ? `<div style="font-family:monospace;font-size:0.73rem;color:var(--text-secondary);background:var(--bg-base);border-radius:4px;padding:0.5rem;max-height:80px;overflow-y:auto;word-break:break-all;margin-top:0.4rem">${esc(e.body)}</div>` : '';
      const redacted = e.body === '*** redacted ***' ? `<span style="color:var(--text-muted);font-size:0.72rem;font-style:italic">body redacted</span>` : '';
      return `
        <div class="olcard" style="padding:0.75rem">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:0.75rem;flex-wrap:wrap">
            <div style="display:flex;align-items:center;gap:0.5rem">
              <span style="font-size:0.7rem;font-weight:700;background:rgba(129,140,248,0.15);color:#a78bfa;padding:2px 7px;border-radius:4px">${esc(e.method)}</span>
              <span style="font-size:0.82rem;font-family:monospace;color:var(--text-primary)">${esc(e.path)}${e.query_params && Object.keys(e.query_params).length ? '<span style="color:var(--text-muted)">?' + esc(new URLSearchParams(e.query_params).toString()) + '</span>' : ''}</span>
            </div>
            <div style="display:flex;gap:0.75rem;align-items:center">
              <span style="color:${statusColor};font-weight:700;font-size:0.82rem">${e.response_status}</span>
              <span style="color:var(--text-muted);font-size:0.75rem">${e.duration_ms} ms</span>
              <span style="color:var(--text-muted);font-size:0.72rem">${esc(e.timestamp)}</span>
            </div>
          </div>
          ${bodyPreview}${redacted}
        </div>`;
    }).join('');
    const info = document.createElement('div');
    info.style = 'text-align:center;color:var(--text-muted);font-size:0.72rem;padding:0.5rem';
    info.textContent = `Showing ${data.returned} of ${data.captured} captured requests (buffer max: ${data.buffer_size})`;
    el.prepend(info);
  } catch (err) { el.innerHTML = `<div style="color:var(--danger);padding:1rem">${esc(err.message)}</div>`; }
}

async function clearPayloadLog() {
  try {
    await api('DELETE', '/overlord/payload/clear');
    showToast('Payload log cleared.', 'success');
    document.getElementById('payload-list').innerHTML =
      '<div class="text-muted text-sm" style="padding:2rem;text-align:center">Log cleared. Make some API calls and refresh.</div>';
  } catch (err) { showToast(err.message, 'error'); }
}


// ── Server Monitor ────────────────────────────────────────────────────────────

let _monitorTimer = null;
let _monitorRunning = false;

function startMonitor() {
  if (_monitorRunning) return;
  _monitorRunning = true;
  const btn = document.getElementById('btn-monitor-toggle');
  if (btn) btn.textContent = '⏸ Pause';
  fetchMonitor();
  _monitorTimer = setInterval(fetchMonitor, 5000);
}

function stopMonitor() {
  _monitorRunning = false;
  clearInterval(_monitorTimer);
  _monitorTimer = null;
  const btn = document.getElementById('btn-monitor-toggle');
  if (btn) btn.textContent = '▶ Resume';
}

function toggleMonitor() {
  if (_monitorRunning) stopMonitor(); else startMonitor();
}

async function fetchMonitor() {
  try {
    const d = await api('GET', '/overlord/monitor');

    const setMon = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    const setBar = (id, pct) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.style.width = pct + '%';
      el.style.background = pct > 85 ? 'var(--danger)' : pct > 65 ? 'var(--warning)' : '#6366f1';
    };

    setMon('mon-cpu',    d.cpu_percent.toFixed(1) + '%');
    setMon('mon-ram',    d.ram_percent.toFixed(1) + '%');
    setMon('mon-disk',   d.disk_percent.toFixed(1) + '%');
    setMon('mon-uptime', d.uptime_human);
    setMon('mon-reqs',   d.requests_total);
    setMon('mon-db',     d.db_size_kb.toFixed(1));

    setBar('mon-ram-bar',  d.ram_percent);
    setBar('mon-disk-bar', d.disk_percent);

    setMon('mon-ram-detail',  `${d.ram_used_mb.toFixed(0)} MB / ${d.ram_total_mb.toFixed(0)} MB`);
    setMon('mon-disk-detail', `${d.disk_used_gb.toFixed(2)} GB / ${d.disk_total_gb.toFixed(2)} GB`);
  } catch (err) {
    if (_monitorRunning) showToast('Monitor error: ' + err.message, 'error');
    stopMonitor();
  }
}

// Stop monitor when navigating away
const _origShowPanel = typeof showPanel !== 'undefined' ? showPanel : null;
document.addEventListener('click', e => {
  const navItem = e.target.closest('.nav-item');
  if (navItem && navItem.id !== 'nav-overlord-monitor' && _monitorRunning) {
    stopMonitor();
  }
});


// ── Password Reset Modal ──────────────────────────────────────────────────────

let _resetPwUserId = null;

function openResetPw(userId, username) {
  _resetPwUserId = userId;
  document.getElementById('reset-pw-msg').textContent = `Reset password for user: "${username}" (id=${userId})`;
  document.getElementById('reset-pw-new').value = '';
  document.getElementById('reset-pw-error').style.display = 'none';
  showModal('reset-pw-modal');
}

async function doResetPassword() {
  const pw = document.getElementById('reset-pw-new').value;
  const errEl = document.getElementById('reset-pw-error');
  errEl.style.display = 'none';
  if (!pw || pw.length < 6) {
    errEl.textContent = 'Password must be at least 6 characters.';
    errEl.style.display = 'block';
    return;
  }
  setLoading('btn-do-reset-pw', true);
  try {
    const data = await api('PATCH', `/users/${_resetPwUserId}/password`, { new_password: pw });
    closeModal('reset-pw-modal');
    showToast(data.message || 'Password reset successfully.', 'success');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  } finally {
    setLoading('btn-do-reset-pw', false);
  }
}


// ── Rename Username Modal ─────────────────────────────────────────────────────

let _renameUserId = null;

function openRenameUser(userId, username) {
  _renameUserId = userId;
  document.getElementById('rename-user-msg').textContent =
    `Rename account: "${username}" (id=${userId})`;
  document.getElementById('rename-user-input').value = username;
  document.getElementById('rename-user-error').style.display = 'none';
  showModal('rename-user-modal');
  // Auto-select the text so the overlord can type immediately
  setTimeout(() => {
    const inp = document.getElementById('rename-user-input');
    if (inp) { inp.focus(); inp.select(); }
  }, 120);
}

async function doRenameUser() {
  const newUsername = (document.getElementById('rename-user-input').value || '').trim();
  const errEl = document.getElementById('rename-user-error');
  errEl.style.display = 'none';

  if (!newUsername) {
    errEl.textContent = 'Username must not be empty.';
    errEl.style.display = 'block';
    return;
  }
  if (newUsername.length < 3) {
    errEl.textContent = 'Username must be at least 3 characters.';
    errEl.style.display = 'block';
    return;
  }

  setLoading('btn-do-rename-user', true);
  try {
    // Use the overlord's own token to call PATCH /auth/rename on behalf of
    // the target user — but the endpoint only renames the caller.
    // So we call the admin-level user PATCH endpoint instead.
    const data = await api('PATCH', `/users/${_renameUserId}/username`, { new_username: newUsername });
    closeModal('rename-user-modal');
    showToast(data.message || `Renamed to "${newUsername}".`, 'success');
    loadUsers();
    // If the overlord renamed themselves, refresh the stored token
    if (data.access_token && currentUser && String(currentUser.sub) === String(_renameUserId)) {
      localStorage.setItem('token', data.access_token);
      currentUser.username = newUsername;
      const nameEl = document.getElementById('nav-username');
      if (nameEl) nameEl.textContent = newUsername;
    }
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  } finally {
    setLoading('btn-do-rename-user', false);
  }
}


// ── Role Change Modal ─────────────────────────────────────────────────────────

let _changeRoleUserId = null;

function openChangeRole(userId, username, currentRole) {
  _changeRoleUserId = userId;
  document.getElementById('change-role-msg').textContent = `Change role for user: "${username}" (current: ${currentRole})`;
  document.getElementById('change-role-select').value = currentRole;
  document.getElementById('change-role-error').style.display = 'none';
  showModal('change-role-modal');
}

async function doChangeRole() {
  const role = document.getElementById('change-role-select').value;
  const errEl = document.getElementById('change-role-error');
  errEl.style.display = 'none';
  setLoading('btn-do-change-role', true);
  try {
    const data = await api('PATCH', `/users/${_changeRoleUserId}/role`, { role });
    closeModal('change-role-modal');
    showToast(data.message || 'Role updated.', 'success');
    loadUsers();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  } finally {
    setLoading('btn-do-change-role', false);
  }
}
