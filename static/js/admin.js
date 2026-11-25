/* ═══════════════════════════════════════════════════════════════════════════
   DataBase — js/admin.js
   Admin panels: Users management + Audit Log
   Features: pending users, approve/reject, create user, delete user, audit log
   Depends on: core.js
═══════════════════════════════════════════════════════════════════════════ */

// ── Pending Users Badge ───────────────────────────────────────────────────────
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

// ── Pending Approvals List ────────────────────────────────────────────────────
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

// ── All Users Table ───────────────────────────────────────────────────────────
async function loadUsers() {
  try {
    const data  = await api('GET', '/users');
    const tbody = document.getElementById('users-tbody');
    if (!tbody) return;
    if (!data.length) { tbody.innerHTML = emptyRow(6); return; }
    const statusMap = {
      0: ['⏳ Pending',  'var(--warning)'],
      1: ['✅ Approved', 'var(--success)'],
      2: ['❌ Rejected', 'var(--danger)'],
    };
    const isOverlord = currentUser && currentUser.role === 'overlord';
    tbody.innerHTML = data.map(u => {
      const [label, color] = statusMap[u.is_approved] || ['—', 'inherit'];
      const overlordActions = isOverlord ? `
        <button class="btn btn-warning btn-icon btn-sm" title="Reset Password" onclick="openResetPw(${u.id}, '${esc(u.username)}')">🔑</button>
        <button class="btn btn-secondary btn-icon btn-sm" title="Change Role" onclick="openChangeRole(${u.id}, '${esc(u.username)}', '${u.role}')">🎭</button>
        <button class="btn btn-info btn-icon btn-sm" title="Rename Username" onclick="openRenameUser(${u.id}, '${esc(u.username)}')">✏️</button>` : '';
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
              ${u.role !== 'overlord' ? `<button class="btn btn-danger  btn-icon btn-sm" onclick="confirmDeleteUser(${u.id}, '${esc(u.username)}')">🗑️</button>` : ''}
              ${overlordActions}
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
    if (!data.data.length) {
      el.innerHTML = '<div class="text-muted text-sm" style="padding:2rem;text-align:center">No audit entries.</div>';
      return;
    }
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
