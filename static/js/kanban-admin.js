/* ═══════════════════════════════════════════════════════════════════════════
   DataBase — js/kanban-admin.js
   Admin "Manage Kanban Sheets" panel.

   Features:
     - List all sheets / templates in a left sidebar
     - Create / edit / delete sheets with a task-list builder
     - Assign a sheet to team members (user checkbox picker)
     - "Use Template" to spin up a live sheet from a saved template
     - Team View — matrix of members × tasks with status badges
   ═══════════════════════════════════════════════════════════════════════════ */

// ── State ─────────────────────────────────────────────────────────────────────
let _adminSheets      = [];   // all sheets (templates + live)
let _adminSelectedId  = null; // currently selected sheet id
let _adminModalTasks  = [];   // task list being built in create/edit modal
let _adminTeamMembers = [];   // cached team members for assign picker
let _adminViewMode    = 'detail'; // 'detail' | 'team-view'

// ── Load ──────────────────────────────────────────────────────────────────────

async function loadKanbanAdmin() {
  const root = document.getElementById('kanban-admin-root');
  if (!root) return;
  root.innerHTML = '<div class="kanban-loading">Loading sheets…</div>';

  try {
    [_adminSheets, _adminTeamMembers] = await Promise.all([
      api('GET', '/kanban/sheets'),
      api('GET', '/kanban/team-members'),
    ]);
    _adminSelectedId = _adminSheets.length ? _adminSheets[0].id : null;
    renderKanbanAdminPanel();
  } catch (err) {
    root.innerHTML = `<div class="kanban-empty-state"><div class="empty-icon">⚠️</div><p>Error: ${esc(err.message)}</p></div>`;
  }
}

// ── Render Full Admin Panel ───────────────────────────────────────────────────

function renderKanbanAdminPanel() {
  const root = document.getElementById('kanban-admin-root');
  if (!root) return;

  const isElevated = currentUser && (currentUser.role === 'admin' || currentUser.role === 'overlord');
  const selected = _adminSheets.find(s => s.id === _adminSelectedId) || null;

  root.innerHTML = `
    <div class="kanban-admin-layout">

      <!-- Left: Sheet List -->
      <div class="kanban-sheet-list">
        <div class="kanban-sheet-list-header">
          <h3>📋 Sheets</h3>
          ${isElevated ? `<button class="btn btn-primary btn-sm" onclick="openCreateSheetModal()">＋ New</button>` : ''}
        </div>
        ${!_adminSheets.length
          ? `<div style="padding:1.5rem;text-align:center;color:var(--text-muted);font-size:0.83rem">No sheets yet.${isElevated ? ' Click ＋ New to create one.' : ''}</div>`
          : _adminSheets.map(s => buildSheetListItem(s)).join('')
        }
      </div>

      <!-- Right: Detail / Team View -->
      <div class="kanban-detail-panel" id="kanban-detail-panel">
        ${selected ? buildDetailPanel(selected) : `<div class="detail-no-selection">Select a sheet to view details</div>`}
      </div>

    </div>

    <!-- ── Modals ── -->

    <!-- Create / Edit Sheet Modal -->
    <div class="modal-overlay hidden" id="create-sheet-modal">
      <div class="modal" style="max-width:560px">
        <div class="modal-header">
          <h3 class="modal-title" id="sheet-modal-title">📋 New Sheet</h3>
          <button class="modal-close" onclick="closeModal('create-sheet-modal')">✕</button>
        </div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:1rem">
          <input type="hidden" id="sheet-edit-id" value="">

          <div class="form-group" style="margin:0">
            <label class="form-label">Sheet Title *</label>
            <input id="sheet-title" class="form-input" type="text" placeholder="e.g. Weekly Sheet — Sep W38">
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
            <div class="form-group" style="margin:0">
              <label class="form-label">Type</label>
              <select id="sheet-type" class="form-input">
                <option value="daily">☀️ Daily</option>
                <option value="weekly">📅 Weekly</option>
                <option value="monthly">🗓️ Monthly</option>
                <option value="custom">⚙️ Custom</option>
              </select>
            </div>
            <div class="form-group" style="margin:0">
              <label class="form-label">Period Label</label>
              <input id="sheet-period" class="form-input" type="text" placeholder="e.g. 2026-W38">
            </div>
          </div>

          <div class="form-group" style="margin:0">
            <label class="form-label" style="display:flex;align-items:center;gap:0.5rem">
              <input type="checkbox" id="sheet-is-template" style="accent-color:#6366f1;width:15px;height:15px">
              Save as reusable template ⭐
            </label>
          </div>

          <div class="form-group" style="margin:0">
            <label class="form-label">Tasks</label>
            <div class="kanban-task-input-row">
              <input id="sheet-new-task" class="form-input" type="text" placeholder="Task name…"
                     onkeydown="if(event.key==='Enter'){event.preventDefault();addModalTask()}">
              <button class="btn btn-ghost btn-sm" onclick="addModalTask()">＋ Add</button>
            </div>
            <ul class="kanban-task-list" id="modal-task-list"></ul>
          </div>

          <p id="sheet-modal-error" class="text-sm" style="color:var(--danger);display:none"></p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" onclick="closeModal('create-sheet-modal')">Cancel</button>
          <button class="btn btn-primary" id="btn-save-sheet" onclick="handleSaveSheet()">Create Sheet</button>
        </div>
      </div>
    </div>

    <!-- Assign Sheet Modal -->
    <div class="modal-overlay hidden" id="assign-sheet-modal">
      <div class="modal" style="max-width:420px">
        <div class="modal-header">
          <h3 class="modal-title">👥 Assign Sheet to Team</h3>
          <button class="modal-close" onclick="closeModal('assign-sheet-modal')">✕</button>
        </div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:0.75rem">
          <p style="font-size:0.85rem;color:var(--text-muted);margin:0">
            Select team members to assign this sheet to. Their task cards will be created automatically.
          </p>
          <div class="kanban-user-checklist" id="assign-user-list"></div>
          <p id="assign-modal-error" class="text-sm" style="color:var(--danger);display:none"></p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" onclick="closeModal('assign-sheet-modal')">Cancel</button>
          <button class="btn btn-primary" id="btn-confirm-assign" onclick="handleAssignSheet()">Assign</button>
        </div>
      </div>
    </div>

    <!-- From Template Modal -->
    <div class="modal-overlay hidden" id="from-template-modal">
      <div class="modal" style="max-width:420px">
        <div class="modal-header">
          <h3 class="modal-title">⭐ Use Template</h3>
          <button class="modal-close" onclick="closeModal('from-template-modal')">✕</button>
        </div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:0.75rem">
          <p style="font-size:0.83rem;color:var(--text-muted);margin:0">A new live sheet will be created from this template with the tasks below.</p>
          <div class="form-group" style="margin:0">
            <label class="form-label">New Sheet Title</label>
            <input id="tpl-sheet-title" class="form-input" type="text" placeholder="e.g. Weekly Sheet — Oct W1">
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
            <div class="form-group" style="margin:0">
              <label class="form-label">Type</label>
              <select id="tpl-sheet-type" class="form-input">
                <option value="daily">☀️ Daily</option>
                <option value="weekly">📅 Weekly</option>
                <option value="monthly">🗓️ Monthly</option>
                <option value="custom">⚙️ Custom</option>
              </select>
            </div>
            <div class="form-group" style="margin:0">
              <label class="form-label">Period Label</label>
              <input id="tpl-sheet-period" class="form-input" type="text" placeholder="e.g. 2026-W40">
            </div>
          </div>
          <p id="tpl-modal-error" class="text-sm" style="color:var(--danger);display:none"></p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" onclick="closeModal('from-template-modal')">Cancel</button>
          <button class="btn btn-primary" id="btn-from-template" onclick="handleFromTemplate()">Create Sheet</button>
        </div>
      </div>
    </div>

    <!-- Confirm Delete Sheet Modal -->
    <div class="modal-overlay hidden" id="delete-sheet-modal">
      <div class="modal" style="max-width:400px">
        <div class="modal-header">
          <h3 class="modal-title">🗑️ Delete Sheet</h3>
          <button class="modal-close" onclick="closeModal('delete-sheet-modal')">✕</button>
        </div>
        <div class="modal-body">
          <p id="delete-sheet-msg" style="color:var(--text-secondary);font-size:0.9rem"></p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" onclick="closeModal('delete-sheet-modal')">Cancel</button>
          <button class="btn btn-danger" id="btn-confirm-delete-sheet" onclick="">Delete</button>
        </div>
      </div>
    </div>

    <!-- Edit History Status Modal -->
    <div class="modal-overlay hidden" id="edit-history-status-modal">
      <div class="modal" style="max-width:400px">
        <div class="modal-header">
          <h3 class="modal-title">✏️ Edit Final Status</h3>
          <button class="modal-close" onclick="closeModal('edit-history-status-modal')">✕</button>
        </div>
        <div class="modal-body">
          <input type="hidden" id="edit-history-id" value="">
          <input type="hidden" id="edit-history-sheet-id" value="">
          <div class="form-group" style="margin:0">
            <label class="form-label">Final Status</label>
            <select id="edit-history-status-select" class="form-input">
              <option value="todo">To Do</option>
              <option value="inprogress">In Progress</option>
              <option value="blocked">Blocked</option>
              <option value="done">Done</option>
            </select>
          </div>
          <p id="edit-history-error" class="text-sm" style="color:var(--danger);display:none;margin-top:0.75rem;"></p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" onclick="closeModal('edit-history-status-modal')">Cancel</button>
          <button class="btn btn-primary" id="btn-save-history-status" onclick="handleSaveHistoryStatus()">Save Status</button>
        </div>
      </div>
    </div>

    <!-- Confirm Delete Cycle Modal -->
    <div class="modal-overlay hidden" id="delete-cycle-modal">
      <div class="modal" style="max-width:400px">
        <div class="modal-header">
          <h3 class="modal-title">🗑️ Delete Cycle</h3>
          <button class="modal-close" onclick="closeModal('delete-cycle-modal')">✕</button>
        </div>
        <div class="modal-body">
          <p style="color:var(--text-secondary);font-size:0.9rem">Delete this entire cycle snapshot? This cannot be undone.</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" onclick="closeModal('delete-cycle-modal')">Cancel</button>
          <button class="btn btn-danger" id="btn-confirm-delete-cycle" onclick="">Delete</button>
        </div>
      </div>
    </div>
  `;

  // Auto-load team view for the initially selected sheet
  if (selected) {
    loadTeamView(selected.id);
  }
}

// ── Sheet List Item ───────────────────────────────────────────────────────────

function buildSheetListItem(sheet) {
  const isActive  = sheet.id === _adminSelectedId;
  const tasks     = safeParseJSON(sheet.tasks_json, []);
  const members   = sheet.assigned_members || [];
  const comp      = sheet.completion || { done: 0, total: 0, pct: 0 };

  // Member avatar pills (initials), max 4 shown + overflow count
  const MAX_AVATARS = 4;
  const avatarPills = members.slice(0, MAX_AVATARS).map(name => {
    const initials = name.split(' ').map(p => p[0]).join('').toUpperCase().slice(0, 2);
    return `<span class="sheet-member-avatar" title="${esc(name)}">${esc(initials)}</span>`;
  }).join('');
  const overflow = members.length > MAX_AVATARS
    ? `<span class="sheet-member-avatar sheet-member-more">+${members.length - MAX_AVATARS}</span>`
    : '';
  const memberRow = members.length
    ? `<div class="sheet-members-row">${avatarPills}${overflow}</div>`
    : `<div class="sheet-members-row" style="color:var(--text-muted);font-size:0.72rem;font-style:italic">No members</div>`;

  // Mini progress bar + label
  const pct       = comp.pct;
  const barColor  = pct === 100 ? '#34d399' : pct >= 50 ? '#60a5fa' : '#f59e0b';
  const progressRow = comp.total > 0 ? `
    <div class="sheet-progress-row">
      <div class="sheet-progress-bar-bg">
        <div class="sheet-progress-bar-fill" style="width:${pct}%;background:${barColor}"></div>
      </div>
      <span class="sheet-progress-label" style="color:${barColor}">${pct}%</span>
      <span class="sheet-progress-detail">${comp.done}/${comp.total} done</span>
    </div>` : '';

  return `
    <div class="kanban-sheet-item ${isActive ? 'active' : ''}"
         onclick="selectAdminSheet(${sheet.id})">
      <div class="kanban-sheet-item-title">
        ${sheet.is_template ? '<span class="kanban-template-star">⭐</span>' : ''}
        ${esc(sheet.title)}
      </div>
      <div class="kanban-sheet-item-meta">
        <span class="kanban-type-badge ${esc(sheet.sheet_type)}" style="font-size:0.65rem">${esc(sheet.sheet_type)}</span>
        ${sheet.period_label ? `<span>${esc(sheet.period_label)}</span>` : ''}
        <span>${tasks.length} task${tasks.length !== 1 ? 's' : ''}</span>
      </div>
      ${memberRow}
      ${progressRow}
    </div>`;
}

// ── Detail Panel ──────────────────────────────────────────────────────────────

function buildDetailPanel(sheet) {
  const isElevated = currentUser && (currentUser.role === 'admin' || currentUser.role === 'overlord');
  const tasks = safeParseJSON(sheet.tasks_json, []);
  const taskChips = tasks.length
    ? tasks.map(t => `<span class="kanban-task-chip">📌 ${esc(t)}</span>`).join('')
    : `<span style="font-size:0.78rem;color:var(--text-muted)">No tasks defined yet.</span>`;

  const templateActions = (sheet.is_template && isElevated ? `<button class="btn btn-ghost btn-sm" onclick="openFromTemplateModal(${sheet.id})" title="Create a live sheet from this template">⭐ Use Template</button>` : '') +
     (isElevated ? `<button class="btn btn-ghost btn-sm" onclick="openAssignModal(${sheet.id})" title="Assign to team members">👥 Assign</button>` : '') +
       (['daily','weekly','monthly'].includes(sheet.sheet_type)
           ? `<button class="btn btn-ghost btn-sm" onclick="loadResetHistory(${sheet.id})" title="View past reset cycles">📜 History</button>`
           : '');

  return `
    <!-- Detail Header -->
    <div class="kanban-detail-header">
      <div>
        <h3>${sheet.is_template ? '⭐' : '📋'} ${esc(sheet.title)}</h3>
        <div style="display:flex;gap:0.5rem;align-items:center;margin-top:0.4rem;flex-wrap:wrap">
          <span class="kanban-type-badge ${esc(sheet.sheet_type)}">${esc(sheet.sheet_type)}</span>
          ${sheet.period_label ? `<span style="font-size:0.78rem;color:var(--text-muted)">${esc(sheet.period_label)}</span>` : ''}
          <span style="font-size:0.75rem;color:var(--text-muted)">by ${esc(sheet.creator_name || '—')}</span>
        </div>
      </div>
      <div class="kanban-detail-actions">
        ${templateActions}
        ${isElevated ? `<button class="btn btn-ghost btn-sm" onclick="openEditSheetModal(${sheet.id})" title="Edit sheet">✏️ Edit</button>
        <button class="btn btn-danger btn-sm" onclick="confirmDeleteSheet(${sheet.id})" title="Delete sheet">🗑️</button>` : ''}
      </div>
    </div>

    <!-- Tasks List -->
    <div>
      <div style="font-size:0.78rem;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:0.5rem">
        Tasks (${tasks.length})
      </div>
      <div class="kanban-task-chips" id="detail-task-chips">
        ${taskChips}
      </div>
    </div>

    <!-- Team Progress Matrix (auto-loaded for all sheets) -->
    <div id="kanban-team-view-area"><div class="kanban-loading">Loading team view…</div></div>
  `;
}

// ── Select Sheet ──────────────────────────────────────────────────────────────

function selectAdminSheet(sheetId) {
  _adminSelectedId = sheetId;
  _adminViewMode = 'detail';
  // Re-render list (to update active class) and detail panel
  const listEl = document.querySelector('.kanban-sheet-list');
  if (listEl) {
    const header = listEl.querySelector('.kanban-sheet-list-header');
    // Rebuild items
    const itemsHtml = _adminSheets.map(s => buildSheetListItem(s)).join('');
    listEl.innerHTML = '';
    listEl.appendChild(header);
    listEl.insertAdjacentHTML('beforeend', itemsHtml);
    // Re-attach click listeners (already inline)
  }
  const detailEl = document.getElementById('kanban-detail-panel');
  const selected = _adminSheets.find(s => s.id === sheetId);
  if (detailEl && selected) {
    detailEl.innerHTML = buildDetailPanel(selected);
    loadTeamView(selected.id);
  }
}

// ── Create Sheet Modal ────────────────────────────────────────────────────────

function openCreateSheetModal() {
  _adminModalTasks = [];
  document.getElementById('sheet-modal-title').textContent = '📋 New Sheet';
  document.getElementById('btn-save-sheet').textContent = 'Create Sheet';
  document.getElementById('sheet-edit-id').value = '';
  document.getElementById('sheet-title').value = '';
  document.getElementById('sheet-type').value = 'weekly';
  document.getElementById('sheet-period').value = '';
  document.getElementById('sheet-is-template').checked = false;
  document.getElementById('sheet-modal-error').style.display = 'none';
  renderModalTaskList();
  showModal('create-sheet-modal');
  setTimeout(() => document.getElementById('sheet-title').focus(), 100);
}

function openEditSheetModal(sheetId) {
  const sheet = _adminSheets.find(s => s.id === sheetId);
  if (!sheet) return;
  _adminModalTasks = safeParseJSON(sheet.tasks_json, []);
  document.getElementById('sheet-modal-title').textContent = '✏️ Edit Sheet';
  document.getElementById('btn-save-sheet').textContent = 'Save Changes';
  document.getElementById('sheet-edit-id').value = sheetId;
  document.getElementById('sheet-title').value = sheet.title;
  document.getElementById('sheet-type').value = sheet.sheet_type;
  document.getElementById('sheet-period').value = sheet.period_label || '';
  document.getElementById('sheet-is-template').checked = !!sheet.is_template;
  document.getElementById('sheet-modal-error').style.display = 'none';
  renderModalTaskList();
  showModal('create-sheet-modal');
}

function renderModalTaskList() {
  const ul = document.getElementById('modal-task-list');
  if (!ul) return;
  ul.innerHTML = _adminModalTasks.map((t, i) => `
    <li>
      <span class="task-drag-handle">⠿</span>
      <span style="flex:1">${esc(t)}</span>
      <button class="task-remove" onclick="_adminModalTasks.splice(${i},1);renderModalTaskList()" title="Remove">✕</button>
    </li>`).join('') || `<li style="justify-content:center;color:var(--text-muted);font-size:0.78rem;border:none;background:none">No tasks yet</li>`;
}

function addModalTask() {
  const inp = document.getElementById('sheet-new-task');
  const val = (inp?.value || '').trim();
  if (!val) return;
  _adminModalTasks.push(val);
  inp.value = '';
  renderModalTaskList();
  inp.focus();
}

async function handleSaveSheet() {
  const errEl = document.getElementById('sheet-modal-error');
  errEl.style.display = 'none';

  const title    = document.getElementById('sheet-title').value.trim();
  const type     = document.getElementById('sheet-type').value;
  const period   = document.getElementById('sheet-period').value.trim();
  const isTpl    = document.getElementById('sheet-is-template').checked ? 1 : 0;
  const editId   = document.getElementById('sheet-edit-id').value;

  if (!title) { errEl.textContent = 'Title is required.'; errEl.style.display = 'block'; return; }

  const payload = {
    title,
    sheet_type:   type,
    period_label: period,
    tasks_json:   JSON.stringify(_adminModalTasks),
    is_template:  isTpl,
  };

  setLoading('btn-save-sheet', true);
  try {
    let sheet;
    if (editId) {
      sheet = await api('PUT', `/kanban/sheets/${editId}`, payload);
      const idx = _adminSheets.findIndex(s => s.id === parseInt(editId));
      if (idx !== -1) _adminSheets[idx] = sheet;
      showToast('Sheet updated!', 'success');
    } else {
      sheet = await api('POST', '/kanban/sheets', payload);
      _adminSheets.unshift(sheet);
      _adminSelectedId = sheet.id;
      showToast('Sheet created!', 'success');
    }
    closeModal('create-sheet-modal');
    renderKanbanAdminPanel();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  } finally {
    setLoading('btn-save-sheet', false);
  }
}

// ── Delete Sheet ──────────────────────────────────────────────────────────────

function confirmDeleteSheet(sheetId) {
  const sheet = _adminSheets.find(s => s.id === sheetId);
  document.getElementById('delete-sheet-msg').textContent =
    `Delete "${sheet?.title || 'this sheet'}"? All assigned cards will also be deleted. This cannot be undone.`;
  document.getElementById('btn-confirm-delete-sheet').onclick = () => deleteSheet(sheetId);
  showModal('delete-sheet-modal');
}

async function deleteSheet(sheetId) {
  closeModal('delete-sheet-modal');
  try {
    await api('DELETE', `/kanban/sheets/${sheetId}`);
    _adminSheets = _adminSheets.filter(s => s.id !== sheetId);
    _adminSelectedId = _adminSheets.length ? _adminSheets[0].id : null;
    showToast('Sheet deleted.', 'success');
    renderKanbanAdminPanel();

    // ── Sync other panels that depend on kanban data ──────────────────────────
    // Reset My Task Board state so it re-fetches from the server on next visit.
    // If the board panel is currently visible, reload it immediately.
    _kanbanSheets   = [];
    _activeSheetIdx = 0;
    const minePanelActive = document.getElementById('panel-kanban-mine')?.classList.contains('active');
    if (minePanelActive && typeof loadMyKanban === 'function') {
      loadMyKanban();
    } else {
      // Panel is not visible — just clear its root so it shows a fresh load
      // spinner next time the user switches to it (nav.js will call loadMyKanban).
      const mineRoot = document.getElementById('kanban-mine-root');
      if (mineRoot) mineRoot.innerHTML = '';
    }

    // Force-refresh Progress Charts if currently active.
    const chartsPanelActive = document.getElementById('panel-progress-charts')?.classList.contains('active');
    if (chartsPanelActive && typeof loadProgressCharts === 'function') {
      loadProgressCharts();
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ── Assign Sheet Modal ────────────────────────────────────────────────────────

function openAssignModal(sheetId) {
  _adminSelectedId = sheetId;
  const listEl = document.getElementById('assign-user-list');
  if (!listEl) return;

  // _adminTeamMembers[0] is always the admin themselves (ordered first by the API)
  listEl.innerHTML = _adminTeamMembers.length
    ? _adminTeamMembers.map(u => {
        const isSelf = u.role === 'admin';
        const badge  = isSelf
          ? `<span style="font-size:0.68rem;font-weight:700;color:#6366f1;background:rgba(99,102,241,0.15);
                          border:1px solid rgba(99,102,241,0.35);border-radius:20px;padding:0.1rem 0.45rem;margin-left:auto">👑 You</span>`
          : `<span style="font-size:0.72rem;color:var(--text-muted);margin-left:auto">${u.role}</span>`;
        return `
        <label class="kanban-user-check-item" style="${isSelf ? 'border-color:rgba(99,102,241,0.3);background:rgba(99,102,241,0.05)' : ''}">
          <input type="checkbox" value="${u.id}" checked>
          <span>${esc(u.username)}</span>
          ${badge}
        </label>`;
      }).join('')
    : `<div style="padding:0.75rem;color:var(--text-muted);font-size:0.83rem;text-align:center">No team members found.</div>`;

  document.getElementById('assign-modal-error').style.display = 'none';
  showModal('assign-sheet-modal');
}

async function handleAssignSheet() {
  const errEl = document.getElementById('assign-modal-error');
  errEl.style.display = 'none';

  const checked = [...document.querySelectorAll('#assign-user-list input[type="checkbox"]:checked')];
  const userIds = checked.map(cb => parseInt(cb.value));

  if (!userIds.length) {
    errEl.textContent = 'Select at least one team member.';
    errEl.style.display = 'block';
    return;
  }

  setLoading('btn-confirm-assign', true);
  try {
    const result = await api('POST', `/kanban/sheets/${_adminSelectedId}/assign`, { user_ids: userIds });
    closeModal('assign-sheet-modal');
    showToast(`Assigned to ${result.users_assigned} member(s). ${result.cards_created} cards created.`, 'success');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  } finally {
    setLoading('btn-confirm-assign', false);
  }
}

// ── From Template ─────────────────────────────────────────────────────────────

function openFromTemplateModal(templateId) {
  _adminSelectedId = templateId;
  document.getElementById('tpl-sheet-title').value = '';
  document.getElementById('tpl-sheet-type').value = 'weekly';
  document.getElementById('tpl-sheet-period').value = '';
  document.getElementById('tpl-modal-error').style.display = 'none';
  showModal('from-template-modal');
  setTimeout(() => document.getElementById('tpl-sheet-title').focus(), 100);
}

async function handleFromTemplate() {
  const errEl = document.getElementById('tpl-modal-error');
  errEl.style.display = 'none';

  const title  = document.getElementById('tpl-sheet-title').value.trim();
  const type   = document.getElementById('tpl-sheet-type').value;
  const period = document.getElementById('tpl-sheet-period').value.trim();

  if (!title) { errEl.textContent = 'Title is required.'; errEl.style.display = 'block'; return; }

  setLoading('btn-from-template', true);
  try {
    const sheet = await api('POST', `/kanban/sheets/${_adminSelectedId}/from-template`, {
      title, sheet_type: type, period_label: period, tasks_json: '[]', is_template: 0,
    });
    _adminSheets.unshift(sheet);
    _adminSelectedId = sheet.id;
    closeModal('from-template-modal');
    showToast('Sheet created from template!', 'success');
    renderKanbanAdminPanel();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  } finally {
    setLoading('btn-from-template', false);
  }
}

// ── Team View ─────────────────────────────────────────────────────────────────

async function loadTeamView(sheetId) {
  const areaEl = document.getElementById('kanban-team-view-area');
  if (!areaEl) return;
  areaEl.innerHTML = '<div class="kanban-loading">Loading team view…</div>';

  try {
    const data = await api('GET', `/kanban/team-view/${sheetId}`);
    areaEl.innerHTML = buildTeamViewHTML(data);
  } catch (err) {
    areaEl.innerHTML = `<div style="color:var(--danger);font-size:0.85rem;padding:0.5rem">Error: ${esc(err.message)}</div>`;
  }
}

function buildTeamViewHTML(data) {
  const isElevated = currentUser && (currentUser.role === 'admin' || currentUser.role === 'overlord');
  const { sheet, tasks, members } = data;

  if (!members.length) {
    return `<div style="padding:1rem;color:var(--text-muted);font-size:0.85rem">
      No team members assigned to this sheet yet.
      ${isElevated ? `<button class="btn btn-ghost btn-sm" style="margin-left:0.5rem" onclick="openAssignModal(${sheet.id})">👥 Assign Now</button>` : ''}
    </div>`;
  }

  const headerCells = tasks.map(t =>
    `<th title="${esc(t)}" style="max-width:120px;overflow:hidden;text-overflow:ellipsis">${esc(t)}</th>`
  ).join('');

  const rows = members.map(member => {
    const cells = tasks.map(task => {
      const card = member.cards[task];
      if (!card) return `<td><span class="matrix-status unassigned">—</span></td>`;
      const icon = { todo: '📭', inprogress: '🔄', blocked: '🚫', done: '✅' }[card.status] || '❓';
      const label = { todo: 'To Do', inprogress: 'In Progress', blocked: 'Blocked', done: 'Done' }[card.status] || card.status;
      return `<td><span class="matrix-status ${card.status}" title="${card.note ? 'Note: ' + esc(card.note) : ''}">${icon} ${label}</span></td>`;
    }).join('');
    return `<tr>
      <td><strong>${esc(member.username)}</strong></td>
      ${cells}
    </tr>`;
  }).join('');

  // Summary row
  const summaryRow = tasks.map(task => {
    const total  = members.filter(m => m.cards[task]).length;
    const done   = members.filter(m => m.cards[task]?.status === 'done').length;
    const pct    = total ? Math.round(done / total * 100) : 0;
    return `<td style="font-size:0.72rem;font-weight:700;color:${pct === 100 ? '#34d399' : '#94a3b8'}">${done}/${total} done</td>`;
  }).join('');

  return `
    <div class="kanban-team-header">
      <strong style="font-size:0.88rem">📊 Team Progress Matrix</strong>
      ${isElevated ? `<button class="btn btn-ghost btn-sm" onclick="openAssignModal(${sheet.id})">👥 Assign More</button>` : ''}
    </div>
    <div class="kanban-team-matrix-wrap">
      <table class="kanban-team-matrix">
        <thead>
          <tr>
            <th>Member</th>
            ${headerCells}
          </tr>
        </thead>
        <tbody>
          ${rows}
          <tr style="background:rgba(255,255,255,0.03)">
            <td style="font-size:0.75rem;color:var(--text-muted);font-weight:600">Completion</td>
            ${summaryRow}
          </tr>
        </tbody>
      </table>
    </div>`;
}

// ── Util ──────────────────────────────────────────────────────────────────────

function safeParseJSON(str, fallback = []) {
  try { const p = JSON.parse(str); return Array.isArray(p) ? p : fallback; }
  catch { return fallback; }
}

// ── Reset History (admin) ─────────────────────────────────────────────────────

async function loadResetHistory(sheetId) {
  const areaEl = document.getElementById('kanban-team-view-area');
  if (!areaEl) return;
  areaEl.innerHTML = '<div class="kanban-loading">Loading reset history…</div>';

  try {
    const data = await api('GET', `/kanban/sheets/${sheetId}/reset-history`);
    areaEl.innerHTML = buildResetHistoryHTML(data);
  } catch (err) {
    areaEl.innerHTML = `<div style="color:var(--danger);font-size:0.85rem;padding:0.5rem">Error: ${esc(err.message)}</div>`;
  }
}

function buildResetHistoryHTML({ sheet, cycles }) {
  const isElevated = currentUser && (currentUser.role === 'admin' || currentUser.role === 'overlord');
  if (!cycles.length) {
    return `
      <div class="kanban-team-header">
        <strong style="font-size:0.88rem">📜 Reset History — ${esc(sheet.title)}</strong>
      </div>
      <div style="padding:1rem;color:var(--text-muted);font-size:0.85rem">
        No reset cycles recorded yet. Cards will be snapshotted here automatically on the next reset.
      </div>`;
  }

  const STATUS_COLORS = {
    todo:       '#94a3b8',
    inprogress: '#60a5fa',
    blocked:    '#f87171',
    done:       '#34d399',
  };
  const STATUS_ICONS = { todo: '📭', inprogress: '🔄', blocked: '🚫', done: '✅' };

  const cycleBlocks = cycles.map(cycle => {
    const resetDate = cycle.reset_at ? cycle.reset_at.slice(0, 10) : '—';
    const periodTag = cycle.period_label ? ` <span style="font-size:0.72rem;color:var(--text-muted);margin-left:0.4rem">${esc(cycle.period_label)}</span>` : '';

    const rows = cycle.entries.map(e => {
      const color = STATUS_COLORS[e.final_status] || '#94a3b8';
      const icon  = STATUS_ICONS[e.final_status] || '❓';
      const note  = e.note ? `<span style="font-size:0.72rem;color:var(--text-muted);margin-left:0.4rem">💬 ${esc(e.note)}</span>` : '';
      return `
        <tr>
          <td style="font-weight:600">${esc(e.username)}</td>
          <td>${esc(e.task_name)}</td>
          <td>
            <span style="color:${color};font-weight:600">${icon} ${e.final_status}</span>${note}
            ${isElevated ? `<button class="btn btn-ghost btn-sm" style="padding:0.1rem 0.3rem;font-size:0.7rem;margin-left:0.5rem" onclick="openEditHistoryStatusModal(${e.id}, '${e.final_status}', ${sheet.id})" title="Edit status">✏️</button>` : ''}
          </td>
        </tr>`;
    }).join('');

    return `
      <div style="margin-bottom:1.25rem">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem;">
          <div style="font-size:0.8rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;
                      letter-spacing:0.06em;padding:0.3rem 0.6rem;
                      background:rgba(255,255,255,0.04);border-radius:6px;display:inline-flex;align-items:center">
            🗓 Reset on ${resetDate}${periodTag}
          </div>
          ${isElevated ? `<button class="btn btn-danger btn-sm" onclick="confirmDeleteHistoryCycle(${sheet.id}, '${cycle.reset_at}')" title="Delete cycle">🗑️ Delete Snapshot</button>` : ''}
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:0.83rem">
          <thead>
            <tr style="color:var(--text-muted);font-size:0.72rem;text-transform:uppercase;letter-spacing:0.05em">
              <th style="text-align:left;padding:0.3rem 0.5rem;border-bottom:1px solid rgba(255,255,255,0.07)">Member</th>
              <th style="text-align:left;padding:0.3rem 0.5rem;border-bottom:1px solid rgba(255,255,255,0.07)">Task</th>
              <th style="text-align:left;padding:0.3rem 0.5rem;border-bottom:1px solid rgba(255,255,255,0.07)">Final Status</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }).join('');

  return `
    <div class="kanban-team-header">
      <strong style="font-size:0.88rem">📜 Reset History — ${esc(sheet.title)}</strong>
      <span style="font-size:0.75rem;color:var(--text-muted)">${cycles.length} cycle${cycles.length !== 1 ? 's' : ''} recorded</span>
    </div>
    <div style="max-height:420px;overflow-y:auto;padding-right:0.25rem">
      ${cycleBlocks}
    </div>`;
}

// ── Edit / Delete History (admin) ─────────────────────────────────────────────

function openEditHistoryStatusModal(historyId, currentStatus, sheetId) {
  document.getElementById('edit-history-id').value = historyId;
  document.getElementById('edit-history-sheet-id').value = sheetId;
  document.getElementById('edit-history-status-select').value = currentStatus;
  document.getElementById('edit-history-error').style.display = 'none';
  showModal('edit-history-status-modal');
}

async function handleSaveHistoryStatus() {
  const historyId = document.getElementById('edit-history-id').value;
  const sheetId = document.getElementById('edit-history-sheet-id').value;
  const status = document.getElementById('edit-history-status-select').value;
  const errEl = document.getElementById('edit-history-error');
  
  setLoading('btn-save-history-status', true);
  try {
    await api('PATCH', `/kanban/history/${historyId}/status`, { final_status: status });
    closeModal('edit-history-status-modal');
    showToast('Status updated!', 'success');
    loadResetHistory(sheetId);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  } finally {
    setLoading('btn-save-history-status', false);
  }
}

function confirmDeleteHistoryCycle(sheetId, resetAt) {
  document.getElementById('btn-confirm-delete-cycle').onclick = () => deleteHistoryCycle(sheetId, resetAt);
  showModal('delete-cycle-modal');
}

async function deleteHistoryCycle(sheetId, resetAt) {
  closeModal('delete-cycle-modal');
  try {
    await api('DELETE', `/kanban/history/cycle?sheet_id=${sheetId}&reset_at=${encodeURIComponent(resetAt)}`);
    showToast('Snapshot deleted.', 'success');
    loadResetHistory(sheetId);
  } catch (err) {
    showToast(err.message, 'error');
  }
}
