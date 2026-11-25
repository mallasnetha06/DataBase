/* ═══════════════════════════════════════════════════════════════════════════
   DataBase — js/kanban.js
   Employee "My Task Board" — Kanban panel for standard users (and admins).

   Renders a 4-column Kanban board (To Do / In Progress / Blocked / Done)
   from sheets assigned to the current user. Supports drag-and-drop between
   columns, inline note editing, and sheet switching via a dropdown selector.
   ═══════════════════════════════════════════════════════════════════════════ */

// ── State ─────────────────────────────────────────────────────────────────────
let _kanbanSheets    = [];   // all sheets with their cards for the current user
let _activeSheetIdx  = 0;   // index into _kanbanSheets
let _dragCardId      = null; // card id being dragged
let _noteCardId      = null; // card id currently editing note

const KANBAN_COLS = [
  { status: 'todo',        icon: '📭', label: 'To Do'       },
  { status: 'inprogress',  icon: '🔄', label: 'In Progress' },
  { status: 'blocked',     icon: '🚫', label: 'Blocked'     },
  { status: 'done',        icon: '✅', label: 'Done'        },
];

// ── Load & Bootstrap ──────────────────────────────────────────────────────────

async function loadMyKanban() {
  const container = document.getElementById('kanban-mine-root');
  if (!container) return;

  container.innerHTML = '<div class="kanban-loading">Loading your task board…</div>';

  try {
    _kanbanSheets = await api('GET', '/kanban/my-sheets');
    _activeSheetIdx = 0;
    renderKanbanMinePanel();
  } catch (err) {
    container.innerHTML = `<div class="kanban-empty-state">
      <div class="empty-icon">⚠️</div>
      <p>Could not load your boards: ${esc(err.message)}</p>
    </div>`;
  }
}

// ── Render Full Panel ─────────────────────────────────────────────────────────

function renderKanbanMinePanel() {
  const container = document.getElementById('kanban-mine-root');
  if (!container) return;

  if (!_kanbanSheets.length) {
    container.innerHTML = `
      <div class="kanban-empty-state">
        <div class="empty-icon">🗂️</div>
        <p>No task sheets assigned to you yet.</p>
        <p style="font-size:0.8rem;opacity:0.6">Your team lead will create and assign a sheet.</p>
      </div>`;
    return;
  }

  const sheet = _kanbanSheets[_activeSheetIdx];
  const cards = sheet.cards || [];

  // Progress calculation
  const total  = cards.length;
  const done   = cards.filter(c => c.status === 'done').length;
  const pct    = total ? Math.round((done / total) * 100) : 0;

  // Sheet selector options
  const sheetOptions = _kanbanSheets.map((s, i) =>
    `<option value="${i}" ${i === _activeSheetIdx ? 'selected' : ''}>${esc(s.title)}${s.period_label ? ' — ' + esc(s.period_label) : ''}</option>`
  ).join('');

  container.innerHTML = `
    <!-- Header -->
    <div class="kanban-header">
      <select class="sheet-selector" onchange="switchKanbanSheet(this.value)">
        ${sheetOptions}
      </select>
      <span class="kanban-type-badge ${esc(sheet.sheet_type)}">${esc(sheet.sheet_type)}</span>
      ${sheet.period_label ? `<span style="font-size:0.78rem;color:var(--text-muted)">${esc(sheet.period_label)}</span>` : ''}
      ${_nextResetLabel(sheet)}
      <div class="kanban-progress-wrap">
        <div class="kanban-progress-bar-track">
          <div class="kanban-progress-bar-fill" style="width:${pct}%"></div>
        </div>
        <span class="kanban-progress-pct">${pct}%</span>
      </div>
    </div>

    <!-- Board -->
    <div class="kanban-board" id="kanban-board">
      ${KANBAN_COLS.map(col => buildKanbanColumn(col, cards)).join('')}
    </div>

    <!-- Note Modal -->
    <div class="modal-overlay hidden" id="kanban-note-modal">
      <div class="modal" style="max-width:420px">
        <div class="modal-header">
          <h3 class="modal-title">📝 Card Note</h3>
          <button class="modal-close" onclick="closeModal('kanban-note-modal')">✕</button>
        </div>
        <div class="modal-body">
          <p id="kanban-note-task-label" style="font-weight:600;margin-bottom:0.5rem;font-size:0.9rem"></p>
          <textarea id="kanban-note-text" class="kanban-note-textarea" placeholder="Add a note or comment…"></textarea>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" onclick="closeModal('kanban-note-modal')">Cancel</button>
          <button class="btn btn-primary" onclick="saveKanbanNote()">Save Note</button>
        </div>
      </div>
    </div>
  `;

  attachDragListeners();
}

// ── Build Column HTML ─────────────────────────────────────────────────────────

function buildKanbanColumn(col, allCards) {
  const colCards = allCards.filter(c => c.status === col.status);
  const cardsHtml = colCards.length
    ? colCards.map(c => buildKanbanCard(c)).join('')
    : `<div style="padding:1rem;text-align:center;font-size:0.78rem;color:var(--text-muted);opacity:0.6">Drop cards here</div>`;

  return `
    <div class="kanban-column" data-status="${col.status}"
         ondragover="onColumnDragOver(event, '${col.status}')"
         ondragleave="onColumnDragLeave(event)"
         ondrop="onColumnDrop(event, '${col.status}')">
      <div class="kanban-col-header">
        <span class="col-icon">${col.icon}</span>
        <span class="col-title">${col.label}</span>
        <span class="col-count">${colCards.length}</span>
      </div>
      <div class="kanban-cards-area" id="cards-area-${col.status}">
        ${cardsHtml}
      </div>
    </div>`;
}

// ── Build Single Card HTML ─────────────────────────────────────────────────────

function buildKanbanCard(card) {
  const notePreview = card.note
    ? `<div class="kanban-card-note">💬 ${esc(card.note)}</div>`
    : '';
  return `
    <div class="kanban-card"
         id="kcard-${card.id}"
         draggable="true"
         data-card-id="${card.id}"
         data-status="${card.status}"
         ondragstart="onCardDragStart(event, ${card.id})"
         ondragend="onCardDragEnd(event)">
      <div class="kanban-card-task">${esc(card.task_name)}</div>
      ${notePreview}
      <div class="kanban-card-footer">
        <span class="kanban-status-pill ${card.status}">${statusLabel(card.status)}</span>
        <button class="kanban-card-note-btn"
                onclick="openNoteModal(${card.id}, '${esc(card.task_name).replace(/'/g,"\\'")}', ${JSON.stringify(card.note || '')})"
                title="Add/edit note">✏️ note</button>
      </div>
    </div>`;
}

// ── Sheet Switching ───────────────────────────────────────────────────────────

function switchKanbanSheet(idx) {
  _activeSheetIdx = parseInt(idx, 10);
  renderKanbanMinePanel();
}

// ── Drag & Drop ───────────────────────────────────────────────────────────────

function attachDragListeners() {
  // Nothing extra needed — listeners are inline in the HTML
}

function onCardDragStart(event, cardId) {
  _dragCardId = cardId;
  event.dataTransfer.effectAllowed = 'move';
  // Mark card as dragging after a brief delay so it renders before opacity change
  requestAnimationFrame(() => {
    const el = document.getElementById(`kcard-${cardId}`);
    if (el) el.classList.add('dragging');
  });
}

function onCardDragEnd(event) {
  document.querySelectorAll('.kanban-card.dragging').forEach(el => el.classList.remove('dragging'));
  document.querySelectorAll('.kanban-column.drag-over').forEach(el => el.classList.remove('drag-over'));
  _dragCardId = null;
}

function onColumnDragOver(event, status) {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  const col = event.currentTarget;
  col.classList.add('drag-over');
}

function onColumnDragLeave(event) {
  // Only remove if we're actually leaving the column (not entering a child)
  const col = event.currentTarget;
  if (!col.contains(event.relatedTarget)) {
    col.classList.remove('drag-over');
  }
}

async function onColumnDrop(event, newStatus) {
  event.preventDefault();
  const col = event.currentTarget;
  col.classList.remove('drag-over');

  if (!_dragCardId) return;

  // Find the card in state
  const sheet  = _kanbanSheets[_activeSheetIdx];
  const card   = (sheet.cards || []).find(c => c.id === _dragCardId);
  if (!card || card.status === newStatus) return;

  // Optimistic UI update
  const prevStatus = card.status;
  card.status = newStatus;
  renderKanbanMinePanel();

  try {
    await api('PATCH', `/kanban/cards/${_dragCardId}`, { status: newStatus });
    showToast(`Moved to ${statusLabel(newStatus)}`, 'success');
  } catch (err) {
    // Rollback
    card.status = prevStatus;
    renderKanbanMinePanel();
    showToast(`Failed to update: ${err.message}`, 'error');
  }
}

// ── Note Modal ─────────────────────────────────────────────────────────────────

function openNoteModal(cardId, taskName, currentNote) {
  _noteCardId = cardId;
  document.getElementById('kanban-note-task-label').textContent = taskName;
  document.getElementById('kanban-note-text').value = currentNote || '';
  showModal('kanban-note-modal');
}

async function saveKanbanNote() {
  if (!_noteCardId) return;
  const note = document.getElementById('kanban-note-text').value;
  try {
    const updated = await api('PATCH', `/kanban/cards/${_noteCardId}`, { note });
    // Update local state
    const sheet = _kanbanSheets[_activeSheetIdx];
    const card = (sheet.cards || []).find(c => c.id === _noteCardId);
    if (card) card.note = note;
    closeModal('kanban-note-modal');
    showToast('Note saved!', 'success');
    // Re-render just the card
    const cardEl = document.getElementById(`kcard-${_noteCardId}`);
    if (cardEl) {
      const newEl = document.createElement('div');
      newEl.innerHTML = buildKanbanCard({ ...card, note });
      cardEl.replaceWith(newEl.firstElementChild);
    }
  } catch (err) {
    showToast(`Failed to save note: ${err.message}`, 'error');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusLabel(status) {
  return { todo: 'To Do', inprogress: 'In Progress', blocked: 'Blocked', done: 'Done' }[status] || status;
}

/**
 * Returns a small badge HTML string showing when the sheet will next auto-reset,
 * e.g. "🔄 Resets tomorrow" or "🔄 Resets in 3 days".
 * Returns empty string for custom sheets or if the type is unknown.
 */
function _nextResetLabel(sheet) {
  const type      = sheet.sheet_type;
  const lastReset = sheet.last_reset_at;
  if (!['daily', 'weekly', 'monthly'].includes(type)) return '';

  // Compute next reset date
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let nextReset;

  if (type === 'daily') {
    nextReset = new Date(today);
    nextReset.setDate(nextReset.getDate() + 1);
  } else if (type === 'weekly') {
    // Next Monday after today
    const day = today.getDay(); // 0=Sun, 1=Mon, ...
    const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7 || 7;
    nextReset = new Date(today);
    nextReset.setDate(today.getDate() + daysUntilMonday);
  } else if (type === 'monthly') {
    // 1st of next month
    nextReset = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  }

  if (!nextReset) return '';

  const diffMs   = nextReset - today;
  const diffDays = Math.round(diffMs / 86400000);

  let label;
  if (diffDays <= 0)  label = '🔄 Resets today';
  else if (diffDays === 1) label = '🔄 Resets tomorrow';
  else label = `🔄 Resets in ${diffDays} day${diffDays !== 1 ? 's' : ''}`;

  return `<span style="font-size:0.72rem;color:#60a5fa;background:rgba(96,165,250,0.1);
                  border:1px solid rgba(96,165,250,0.25);border-radius:20px;
                  padding:0.15rem 0.55rem;white-space:nowrap">${label}</span>`;
}

/* ══════════════════════════════════════════════════════════════════════════════
   Brand Approval & Invoice block — Kanban page (mirrors progress-actions.js)
   All element IDs are prefixed "kb-" and functions prefixed "kb" to avoid
   conflicts with the identical block on the My Progress page.
   ══════════════════════════════════════════════════════════════════════════════ */

/* ── Shared state ─────────────────────────────────────────────────────────── */

let _kbSelectedRow = null;   // selected data_scraping row
let _kbDebounce    = null;
let _kbHistoryData = [];     // cached invoices_history for the selected row

/* ── Init ────────────────────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
  // Toggle approved text
  const toggle = document.getElementById('kb-approved-toggle');
  if (toggle) {
    toggle.addEventListener('change', () => {
      document.getElementById('kb-approved-text').textContent =
        toggle.checked ? 'Yes — Approved' : 'No — Not Approved';
    });
  }

  // Set today's date as default in date pickers
  const today   = new Date().toISOString().split('T')[0];
  const jaDate  = document.getElementById('kb-approval-date');
  const invDate = document.getElementById('kb-inv-date');
  if (jaDate)  jaDate.value  = today;
  if (invDate) invDate.value = today;
});

/* ══════════════════════════ SEARCH & SELECT ══════════════════════════════════ */

function kbSearchDebounce() {
  clearTimeout(_kbDebounce);
  _kbDebounce = setTimeout(kbSearchEmail, 350);
}

async function kbSearchEmail() {
  const q   = (document.getElementById('kb-email-search').value || '').trim();
  const box = document.getElementById('kb-search-results');
  if (!q) { box.classList.add('hidden'); return; }

  box.classList.remove('hidden');
  box.innerHTML = '<div class="text-muted text-sm" style="padding:0.5rem">Searching…</div>';

  try {
    const results = await api('GET', `/progress/scraping-search?email=${encodeURIComponent(q)}`);
    if (!results.length) {
      box.innerHTML = '<div class="text-muted text-sm" style="padding:0.5rem">No records found.</div>';
      return;
    }
    box.innerHTML = results.map(r => `
      <div class="action-result-row" onclick="kbSelectRow(${JSON.stringify(r).replace(/"/g, '&quot;')})">
        <span class="action-result-name">${r.author_name || '—'}</span>
        <span class="action-result-email">${r.email}</span>
        ${r.brand
          ? `<span class="action-block-tag">${r.brand}</span>`
          : `<span class="action-block-tag" style="color:var(--danger);font-style:italic">⚠ No brand set</span>`
        }
        ${r.country ? `<span class="text-muted text-sm">${r.country}</span>` : ''}
      </div>`).join('');
  } catch (e) {
    box.innerHTML = `<div class="text-sm" style="color:var(--danger);padding:0.5rem">Error: ${e.message || 'Search failed'}</div>`;
  }
}

async function kbSelectRow(row) {
  _kbSelectedRow = row;

  document.getElementById('kb-sel-name').textContent  = row.author_name || '—';
  document.getElementById('kb-sel-email').textContent = row.email;

  const brandEl  = document.getElementById('kb-sel-brand');
  const editRow  = document.getElementById('kb-brand-edit-row');
  const brandInp = document.getElementById('kb-brand-input');

  if (row.brand) {
    brandEl.textContent    = `Brand: ${row.brand}`;
    brandEl.style.color    = '';
    brandEl.style.fontStyle = '';
    editRow.style.display  = 'none';
  } else {
    brandEl.textContent    = '⚠ No brand set';
    brandEl.style.color    = 'var(--danger)';
    brandEl.style.fontStyle = 'italic';
    brandInp.value         = '';
    editRow.style.display  = 'flex';
  }

  document.getElementById('kb-search-results').classList.add('hidden');
  document.getElementById('kb-selected-info').classList.remove('hidden');
  document.getElementById('kb-error').style.display    = 'none';
  document.getElementById('kb-inv-error').style.display = 'none';

  // Fetch and render history
  await _kbLoadHistory(row.id);
}

function kbClearSelection() {
  _kbSelectedRow = null;
  _kbHistoryData = [];
  document.getElementById('kb-email-search').value = '';
  document.getElementById('kb-search-results').classList.add('hidden');
  document.getElementById('kb-selected-info').classList.add('hidden');
  document.getElementById('kb-error').style.display    = 'none';
  document.getElementById('kb-inv-error').style.display = 'none';
  document.getElementById('kb-brand-edit-row').style.display = 'none';
  document.getElementById('kb-brand-input').value = '';
  document.getElementById('kb-brand-err').style.display = 'none';
  _kbRenderHistory([]);
}

async function kbSaveBrand() {
  const errEl = document.getElementById('kb-brand-err');
  errEl.style.display = 'none';

  if (!_kbSelectedRow) return;
  const brand = (document.getElementById('kb-brand-input').value || '').trim();
  if (!brand) {
    errEl.textContent  = 'Brand name cannot be empty.';
    errEl.style.display = 'inline';
    return;
  }

  const btn = document.getElementById('kb-btn-save-brand');
  btn.disabled    = true;
  btn.textContent = 'Saving…';
  try {
    const result = await api('PATCH', `/progress/scraping/${_kbSelectedRow.id}/brand`, { brand });
    _kbSelectedRow.brand = result.brand;

    const brandEl = document.getElementById('kb-sel-brand');
    brandEl.textContent    = `Brand: ${result.brand}`;
    brandEl.style.color    = '';
    brandEl.style.fontStyle = '';

    document.getElementById('kb-brand-edit-row').style.display = 'none';
    showToast(`✅ Brand saved: ${result.brand}`, 'success');
  } catch (e) {
    errEl.textContent  = e.message || 'Failed to save brand.';
    errEl.style.display = 'inline';
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Save Brand';
  }
}

/* ══════════════════════════ HISTORY TABLE ════════════════════════════════════ */

const KB_STATUS_COLORS = {
  'Pending'  : 'color:#f59e0b',
  'Approved' : 'color:#22c55e',
  'Paid'     : 'color:#6ee7b7',
  'Rejected' : 'color:#f87171',
};

async function _kbLoadHistory(scrapingId) {
  const tbody = document.getElementById('kb-history-tbody');
  tbody.innerHTML = '<tr><td colspan="6" class="text-muted text-sm" style="padding:0.75rem;text-align:center">Loading…</td></tr>';

  try {
    const data = await api('GET', `/progress/scraping/${scrapingId}/history`);
    _kbHistoryData = data.history || [];
    _kbRenderHistory(_kbHistoryData);
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:var(--danger);padding:0.75rem;text-align:center;font-size:0.82rem">Failed to load history: ${e.message}</td></tr>`;
    _kbHistoryData = [];
    _kbPopulateInvoiceDropdown([]);
  }
}

function _kbRenderHistory(history) {
  const tbody = document.getElementById('kb-history-tbody');

  if (!history.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-muted text-sm" style="padding:0.75rem;text-align:center">No records yet</td></tr>';
    _kbPopulateInvoiceDropdown([]);
    return;
  }

  tbody.innerHTML = history.map(e => {
    const statusStyle = KB_STATUS_COLORS[e.invoice_status] || '';
    const approved = e.journal_approved
      ? '<span style="color:#22c55e;font-weight:600">✅ Yes</span>'
      : '<span style="color:var(--text-muted)">—</span>';
    const amount = (e.amount != null && e.amount !== '') ? `$${Number(e.amount).toFixed(2)}` : '—';
    const invDate = e.invoice_date || '—';
    const appDate = e.approval_date || '—';
    return `
      <tr>
        <td style="font-weight:600">#${e.invoice_no}</td>
        <td>${amount}</td>
        <td style="${statusStyle};font-weight:500">${e.invoice_status || '—'}</td>
        <td>${invDate}</td>
        <td>${approved}</td>
        <td>${appDate}</td>
      </tr>`;
  }).join('');

  _kbPopulateInvoiceDropdown(history);
}

function _kbPopulateInvoiceDropdown(history) {
  const sel = document.getElementById('kb-inv-no-select');
  sel.innerHTML = '<option value="">— select —</option>';
  history.forEach(e => {
    const label = `#${e.invoice_no} — ${e.invoice_status || 'Pending'} — ${e.invoice_date || 'no date'}`;
    const opt = document.createElement('option');
    opt.value       = e.invoice_no;
    opt.textContent = label;
    sel.appendChild(opt);
  });

  sel.onchange = () => {
    const no = parseInt(sel.value, 10);
    if (!no) return;
    const entry = _kbHistoryData.find(e => e.invoice_no === no);
    if (!entry) return;
    const amtEl = document.getElementById('kb-inv-amount');
    const stEl  = document.getElementById('kb-inv-status');
    const dtEl  = document.getElementById('kb-inv-date');
    if (amtEl) amtEl.value = entry.amount != null ? entry.amount : '';
    if (stEl)  stEl.value  = entry.invoice_status || 'Pending';
    if (dtEl)  dtEl.value  = entry.invoice_date   || '';
  };
}

/* ══════════════════════════ NEW APPROVAL (LEFT) ══════════════════════════════ */

async function kbSubmitJournalApproval() {
  const errEl = document.getElementById('kb-error');
  errEl.style.display = 'none';

  if (!_kbSelectedRow) {
    errEl.textContent = 'Please search and select a record first.';
    errEl.style.display = 'block'; return;
  }
  if (!_kbSelectedRow.brand) {
    errEl.textContent = '⚠ Brand is not set for this record. Please fill in the brand name above before submitting.';
    errEl.style.display = 'block';
    document.getElementById('kb-brand-input').focus();
    return;
  }
  const approvalDate = document.getElementById('kb-approval-date').value;
  const approved     = document.getElementById('kb-approved-toggle').checked;

  if (!approvalDate) {
    errEl.textContent = 'Date of Approval is required.';
    errEl.style.display = 'block'; return;
  }
  if (!approved) {
    errEl.textContent = 'Toggle must be set to "Yes — Approved" to log an approval.';
    errEl.style.display = 'block'; return;
  }

  const btn = document.getElementById('kb-btn-submit-ja');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const result = await api('PATCH', `/progress/scraping/${_kbSelectedRow.id}/approval`, {
      journal_approved: 1,
      approval_date:    approvalDate,
    });
    const brand = result.brand || _kbSelectedRow.brand || _kbSelectedRow.journal_name || '—';
    const invNo = result.invoice_no ? ` | Invoice #${result.invoice_no}` : '';
    showToast(
      `✅ Approval saved! Author: ${result.author_name} | Brand: ${brand}${invNo} | Date: ${result.approval_date}`,
      'success'
    );
    await _kbLoadHistory(_kbSelectedRow.id);
  } catch (e) {
    errEl.textContent = e.message || 'Failed to save brand approval.';
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = '✅ Submit Approval';
  }
}

/* ══════════════════════════ UPDATE INVOICE (RIGHT) ═══════════════════════════ */

async function kbSubmitInvoiceUpdate() {
  const errEl = document.getElementById('kb-inv-error');
  errEl.style.display = 'none';

  if (!_kbSelectedRow) {
    errEl.textContent = 'Please search and select a record first.';
    errEl.style.display = 'block'; return;
  }
  if (!_kbSelectedRow.brand) {
    errEl.textContent = '⚠ Brand is not set for this record. Please fill in the brand name above before submitting.';
    errEl.style.display = 'block';
    document.getElementById('kb-brand-input').focus();
    return;
  }

  const invoiceNo = parseInt(document.getElementById('kb-inv-no-select').value, 10) || null;
  if (!invoiceNo) {
    errEl.textContent = 'Please select an invoice # to update.';
    errEl.style.display = 'block'; return;
  }

  const amount      = document.getElementById('kb-inv-amount').value;
  const status      = document.getElementById('kb-inv-status').value;
  const invoiceDate = document.getElementById('kb-inv-date').value;

  if (!invoiceDate) {
    errEl.textContent = 'Invoice Date is required.';
    errEl.style.display = 'block'; return;
  }
  if (amount === '' || isNaN(parseFloat(amount)) || parseFloat(amount) < 0) {
    errEl.textContent = 'Please enter a valid amount.';
    errEl.style.display = 'block'; return;
  }

  const btn = document.getElementById('kb-btn-submit-inv');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const result = await api('PATCH', `/progress/scraping/${_kbSelectedRow.id}/invoice`, {
      invoice_no:     invoiceNo,
      amount:         parseFloat(amount),
      invoice_status: status,
      invoice_date:   invoiceDate,
    });
    const brand = result.brand || _kbSelectedRow.brand || _kbSelectedRow.journal_name || '—';
    showToast(
      `🧾 Invoice #${result.invoice_no} updated! Author: ${result.author_name} | Brand: ${brand} | Amount: $${Number(result.amount).toFixed(2)} | Status: ${result.invoice_status}`,
      'success'
    );
    await _kbLoadHistory(_kbSelectedRow.id);
  } catch (e) {
    errEl.textContent = e.message || 'Failed to update invoice.';
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = '🧾 Update Invoice';
  }
}
