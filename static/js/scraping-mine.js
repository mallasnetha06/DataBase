/* ═══════════════════════════════════════════════════════════════════════════
   DataBase — js/scraping-mine.js
   My Collection panel
   Features: dynamic column visibility, drag-and-drop reorder/hide/restore,
             status update, pagination, queue grouping with advanced filters
   Depends on: core.js
═══════════════════════════════════════════════════════════════════════════ */

// ── DnD state ─────────────────────────────────────────────────────────────────
let _mineDragKey    = null;  // column key being dragged
let _mineDragSource = null;  // 'table' | 'widget'
let _mineDropTarget = null;  // key of th currently hovered over

// ── Queue state ───────────────────────────────────────────────────────────────
const _mineSelectedIds = new Set();          // checked row IDs
let   _mineQueueMeta   = [];                 // [{queue_name, color, count}, …]
let   _mineQueueRuleCount = 0;               // counter for queue rule row IDs
const QUEUE_COLORS = [
  { name: 'Violet',  hex: '#8b5cf6' },
  { name: 'Blue',    hex: '#3b82f6' },
  { name: 'Cyan',    hex: '#06b6d4' },
  { name: 'Emerald', hex: '#10b981' },
  { name: 'Amber',   hex: '#f59e0b' },
  { name: 'Rose',    hex: '#f43f5e' },
  { name: 'Pink',    hex: '#ec4899' },
  { name: 'Indigo',  hex: '#6366f1' },
];

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

// ── Table header render (sets HTML only — no listener wiring) ─────────────────
function renderMineTableHeaders() {
  const thead = document.getElementById('scraping-mine-thead');
  if (!thead) return;
  const cols = mineVisibleCols.map(key => MINE_ALL_COLS.find(c => c.key === key)).filter(Boolean);
  thead.innerHTML = `<tr class="mine-header-row">
    <th class="mine-th-check"><input type="checkbox" id="mine-select-all" onchange="mineToggleSelectAll(this.checked)" title="Select all"></th>
    ${cols.map(c => `
      <th class="mine-th" draggable="true" data-key="${c.key}">
        <span class="th-drag-handle" title="Drag to reorder or drag to widget area to hide">⠿</span>
        <span class="th-label">${esc(c.label)}</span>
        <button class="col-remove-btn" onclick="event.stopPropagation();mineRemoveCol('${c.key}')" title="Hide ${esc(c.label)}">&#215;</button>
      </th>`).join('')}
  </tr>`;
}

// ── Wire DnD via event delegation — called ONCE per session ──────────────────
function initMineTheadDnD() {
  const thead = document.getElementById('scraping-mine-thead');
  if (!thead || thead._dndReady) return;   // guard: only wire once
  thead._dndReady = true;

  // dragstart
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

  // dragend
  thead.addEventListener('dragend', e => {
    const th = e.target.closest('th.mine-th');
    if (th) th.classList.remove('dragging');
    _mineCleanupDrag();
  });

  // dragover
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

  // dragleave
  thead.addEventListener('dragleave', e => {
    if (!thead.contains(e.relatedTarget)) {
      thead.querySelectorAll('th.mine-th').forEach(t => t.classList.remove('col-drag-over'));
      _mineDropTarget = null;
    }
  });

  // drop
  thead.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation();
    thead.querySelectorAll('th.mine-th').forEach(t => t.classList.remove('col-drag-over'));

    const dragKey = _mineDragKey;
    const source  = _mineDragSource;
    const th      = e.target.closest('th.mine-th');
    const dropKey = th ? th.dataset.key : null;

    _mineCleanupDrag();   // clear state FIRST before mutating cols

    if (source === 'table' && dragKey && dropKey && dragKey !== dropKey) {
      // Reorder
      const from = mineVisibleCols.indexOf(dragKey);
      let   to   = mineVisibleCols.indexOf(dropKey);
      if (from !== -1 && to !== -1) {
        mineVisibleCols.splice(from, 1);
        if (from < to) to -= 1;
        mineVisibleCols.splice(to, 0, dragKey);
      }
    } else if (source === 'widget' && dragKey && !mineVisibleCols.includes(dragKey)) {
      // Restore chip at specific position or end
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

// ── Widget bar as drop target (remove column by dragging onto bar) ────────────
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

// ── Shared refresh: re-render headers + rows without re-wiring listeners ──────
function _mineRefreshView() {
  renderMineColWidgets();
  renderMineTableHeaders();
  const lastData = window._mineLastData;
  if (lastData) renderMineRows(lastData);
  renderMineQueueLegend();
  _renderMineSelectionToolbar();
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

// ── Get queue colour for a queue name ─────────────────────────────────────────
function _getQueueColor(queueName) {
  if (!queueName) return null;
  const meta = _mineQueueMeta.find(q => q.queue_name === queueName);
  return meta ? meta.color : '#8b5cf6';
}

// ── Row rendering ─────────────────────────────────────────────────────────────
function renderMineRows(data) {
  const tbody = document.getElementById('scraping-mine-tbody');
  if (!tbody) return;

  if (!data.data.length) {
    const totalCols = mineVisibleCols.length + 1; // +1 for checkbox
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
      case 'journal_name':  return `<td class="td-truncate" style="max-width:180px" title="${esc(r.journal_name)}">${esc(r.journal_name)}</td>`;
      case 'email':         return `<td class="td-truncate" style="max-width:160px">${esc(r.email)}</td>`;
      case 'email_status':  return `<td>${scrapingBadge(r.email_status)}</td>`;
      case 'queue_group':   return `<td>${r.queue_group ? _queueBadge(r.queue_group) : '<span class="text-muted">—</span>'}</td>`;
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

  tbody.innerHTML = data.data.map(r => {
    const qColor = _getQueueColor(r.queue_group);
    const borderStyle = qColor ? `border-left: 3px solid ${qColor};` : '';
    const bgStyle = qColor ? `background: ${qColor}0d;` : '';
    const checked = _mineSelectedIds.has(r.id) ? 'checked' : '';
    return `
    <tr style="${borderStyle}${bgStyle}" data-id="${r.id}" class="mine-data-row">
      <td class="mine-td-check"><input type="checkbox" class="mine-row-cb" data-id="${r.id}" ${checked} onchange="mineToggleRow(${r.id}, this.checked)"></td>
      ${mineVisibleCols.map(key => cellVal(r, key)).join('')}
    </tr>`;
  }).join('');
}

// ── Queue badge helper ────────────────────────────────────────────────────────
function _queueBadge(queueName) {
  const color = _getQueueColor(queueName);
  return `<span class="queue-badge" style="--q-color:${color}"><span class="queue-dot" style="background:${color}"></span>${esc(queueName)}</span>`;
}

// ── Selection logic ───────────────────────────────────────────────────────────
function mineToggleSelectAll(checked) {
  const lastData = window._mineLastData;
  if (!lastData) return;
  if (checked) {
    lastData.data.forEach(r => _mineSelectedIds.add(r.id));
  } else {
    _mineSelectedIds.clear();
  }
  // Update all checkboxes
  document.querySelectorAll('.mine-row-cb').forEach(cb => { cb.checked = checked; });
  _renderMineSelectionToolbar();
}

function mineToggleRow(id, checked) {
  if (checked) {
    _mineSelectedIds.add(id);
  } else {
    _mineSelectedIds.delete(id);
  }
  // Update select-all state
  const allCb = document.getElementById('mine-select-all');
  const lastData = window._mineLastData;
  if (allCb && lastData) {
    allCb.checked = lastData.data.every(r => _mineSelectedIds.has(r.id));
  }
  _renderMineSelectionToolbar();
}

// ── Selection Toolbar ─────────────────────────────────────────────────────────
function _renderMineSelectionToolbar() {
  const bar = document.getElementById('mine-selection-toolbar');
  if (!bar) return;

  if (_mineSelectedIds.size === 0) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  bar.innerHTML = `
    <div class="sel-toolbar-inner">
      <span class="sel-count">${_mineSelectedIds.size} row${_mineSelectedIds.size !== 1 ? 's' : ''} selected</span>
      <div class="sel-actions">
        <button class="btn btn-sm btn-accent" onclick="openQueueModal()">🏷️ Assign to Queue</button>
        <button class="btn btn-sm btn-ghost" onclick="clearQueueSelection()">✕ Clear Queue</button>
        <button class="btn btn-sm btn-ghost" onclick="mineClearSelection()">Deselect</button>
      </div>
    </div>`;
}

function mineClearSelection() {
  _mineSelectedIds.clear();
  document.querySelectorAll('.mine-row-cb').forEach(cb => { cb.checked = false; });
  const allCb = document.getElementById('mine-select-all');
  if (allCb) allCb.checked = false;
  _renderMineSelectionToolbar();
}

// ── Queue Legend ───────────────────────────────────────────────────────────────
function renderMineQueueLegend() {
  const legend = document.getElementById('mine-queue-legend');
  if (!legend) return;

  if (!_mineQueueMeta.length) {
    legend.classList.add('hidden');
    return;
  }
  legend.classList.remove('hidden');
  legend.innerHTML = `
    <span class="queue-legend-label">Queues:</span>
    ${_mineQueueMeta.map(q => `
      <button class="queue-legend-item" style="--q-color:${q.color}" title="${q.count} records"
              onclick="mineFilterByQueue('${esc(q.queue_name)}')">
        <span class="queue-dot" style="background:${q.color}"></span>
        <span>${esc(q.queue_name)}</span>
        <span class="queue-legend-count">${q.count}</span>
      </button>
    `).join('')}
    <button class="queue-legend-clear" onclick="mineFilterByQueue(null)" title="Show all">All</button>
  `;
}

let _mineQueueFilter = null;
function mineFilterByQueue(queueName) {
  _mineQueueFilter = queueName;
  loadMineCollection();
}

// ── Load Collection ───────────────────────────────────────────────────────────
async function loadMineCollection() {
  const totalCols = mineVisibleCols.length + 2;
  const tbody = document.getElementById('scraping-mine-tbody');
  if (tbody) tbody.innerHTML = emptyRow(totalCols, 'Loading…');
  renderMineColWidgets();
  renderMineTableHeaders();
  initMineTheadDnD(); // wire DnD once on first load

  try {
    // Load queue meta first
    try {
      const qData = await api('GET', '/scraping/mine/queues');
      _mineQueueMeta = qData.queues || [];
    } catch (e) { _mineQueueMeta = []; }

    let url = `/scraping/mine?page=${minePage}&page_size=25`;
    if (_mineQueueFilter) {
      url += `&queue_group=${encodeURIComponent(_mineQueueFilter)}`;
    }
    const data = await api('GET', url);
    window._mineLastData = data;

    // Client-side queue filter (since backend may not support it yet)
    if (_mineQueueFilter && data.data) {
      data.data = data.data.filter(r => r.queue_group === _mineQueueFilter);
    }

    renderMineTable(data);
    renderMineQueueLegend();
  } catch (err) {
    if (tbody) tbody.innerHTML = emptyRow(totalCols, `Error: ${err.message}`);
  }
}

function renderMineTable(data) {
  renderMineTableHeaders(); // refresh headers (no listener re-wiring)
  renderMineRows(data);
  renderPagination('scraping-mine-controls', 'scraping-mine-info',
    data.page, data.pages, data.total, p => { minePage = p; loadMineCollection(); });
  _renderMineSelectionToolbar();
}

async function updateMineStatus(id, status) {
  try {
    await api('PATCH', `/scraping/${id}/status`, { email_status: status });
    showToast(`Status updated to "${status}"`, 'success');
    setTimeout(() => { loadMineCollection(); loadDashboard(); }, 400);
  } catch (err) { showToast(err.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Queue Assignment Modal
// ═══════════════════════════════════════════════════════════════════════════════

// ── Queue modal mode: 'select' | 'new' | 'empty' ─────────────────────────────
let _queueModalMode = 'empty'; // tracks active UI mode

function openQueueModal() {
  _mineQueueRuleCount = 0;
  const modal = document.getElementById('queue-assign-modal');
  if (!modal) return;

  // Reset rule rows / preview
  document.getElementById('queue-rule-rows').innerHTML = '';
  document.getElementById('queue-preview-tbody').innerHTML = '';
  document.getElementById('queue-preview-section').classList.add('hidden');

  // Reset colour picker
  const picker = document.getElementById('queue-color-picker');
  if (picker) {
    picker.querySelectorAll('.q-color-opt').forEach((el, i) => {
      el.classList.toggle('active', i === 0);
    });
  }

  // Populate dropdown & choose initial mode
  const sel = document.getElementById('queue-select');
  if (sel && _mineQueueMeta.length > 0) {
    sel.innerHTML =
      _mineQueueMeta.map(q =>
        `<option value="${esc(q.queue_name)}" data-color="${q.color}">${esc(q.queue_name)} (${q.count})</option>`
      ).join('') +
      `<option value="__new__">＋ Create new queue…</option>`;
    _setQueueModalMode('select');
  } else {
    _setQueueModalMode('empty');
  }

  showModal('queue-assign-modal');
  _refreshQueuePreview();
}

/** Switch the modal between 'select', 'new', and 'empty' modes. */
function _setQueueModalMode(mode) {
  _queueModalMode = mode;
  const selectWrap   = document.getElementById('queue-select-wrap');
  const newWrap      = document.getElementById('queue-new-name-wrap');
  const emptyWrap    = document.getElementById('queue-empty-name-wrap');
  const colorGroup   = document.getElementById('queue-color-group');
  const backBtn      = document.getElementById('btn-back-to-queue-select');
  const nameInput    = document.getElementById('queue-name-input');
  const emptyInput   = document.getElementById('queue-name-input-empty');

  if (mode === 'select') {
    // Showing existing-queue dropdown
    if (selectWrap)  selectWrap.style.display  = 'block';
    if (newWrap)     newWrap.style.display     = 'none';
    if (emptyWrap)   emptyWrap.style.display   = 'none';
    if (colorGroup)  colorGroup.style.display  = 'none'; // no new color needed
    if (nameInput)   nameInput.value = '';
  } else if (mode === 'new') {
    // Showing new-queue text input (with back button)
    if (selectWrap)  selectWrap.style.display  = 'none';
    if (newWrap)     newWrap.style.display     = 'block';
    if (emptyWrap)   emptyWrap.style.display   = 'none';
    if (colorGroup)  colorGroup.style.display  = 'block';
    if (backBtn)     backBtn.style.display     = 'inline-flex';
    if (nameInput)   nameInput.value = '';
    setTimeout(() => nameInput && nameInput.focus(), 50);
  } else {
    // 'empty' — no existing queues at all
    if (selectWrap)  selectWrap.style.display  = 'none';
    if (newWrap)     newWrap.style.display     = 'none';
    if (emptyWrap)   emptyWrap.style.display   = 'block';
    if (colorGroup)  colorGroup.style.display  = 'block';
    if (emptyInput)  emptyInput.value = '';
  }
}

/** Called when the existing-queue <select> changes. */
function onQueueSelectChange(val) {
  if (val === '__new__') {
    _setQueueModalMode('new');
  }
  // If user picks an existing queue, color picker stays hidden — nothing more to do
}

/** Switch back from 'new' mode to the existing-queue dropdown. */
function switchToQueueSelect() {
  const sel = document.getElementById('queue-select');
  // Reset dropdown to first real option
  if (sel && sel.options.length > 0) sel.selectedIndex = 0;
  _setQueueModalMode('select');
}

/**
 * Returns the resolved queue name from whichever UI element is active.
 * Returns null if nothing is entered/selected.
 */
function _getResolvedQueueName() {
  if (_queueModalMode === 'select') {
    const sel = document.getElementById('queue-select');
    return (sel && sel.value && sel.value !== '__new__') ? sel.value.trim() : null;
  } else if (_queueModalMode === 'new') {
    const inp = document.getElementById('queue-name-input');
    return inp ? inp.value.trim() || null : null;
  } else {
    // 'empty'
    const inp = document.getElementById('queue-name-input-empty');
    return inp ? inp.value.trim() || null : null;
  }
}

function closeQueueModal() {
  closeModal('queue-assign-modal');
}

function getSelectedQueueColor() {
  const active = document.querySelector('.q-color-opt.active');
  return active ? active.dataset.color : QUEUE_COLORS[0].hex;
}

function selectQueueColor(el) {
  document.querySelectorAll('.q-color-opt').forEach(o => o.classList.remove('active'));
  el.classList.add('active');
}

// ── Queue Filter Rules (reuse upload pattern) ─────────────────────────────────

function addQueueFilterRule() {
  const id = ++_mineQueueRuleCount;
  const container = document.getElementById('queue-rule-rows');
  const div = document.createElement('div');
  div.className = 'queue-rule-card';
  div.id = `q-rule-${id}`;
  div.innerHTML = `
    <div class="queue-rule-header">
      <span class="queue-rule-title">Filter Rule #${id}</span>
      <button class="assign-remove-btn" onclick="removeQueueRule(${id})" title="Remove rule">✕ Remove</button>
    </div>
    <div class="queue-rule-body">
      <div class="assign-logic-bar" style="margin-bottom: 0.5rem; display: none;" id="q-logic-bar-${id}">
        <span class="rules-label">Match </span>
        <select class="form-select rules-input q-logic-sel" data-id="${id}" style="width: auto; display: inline-block; padding-top: 0.2rem; padding-bottom: 0.2rem;" onchange="_refreshQueuePreview()">
          <option value="AND">ALL (AND)</option>
          <option value="OR">ANY (OR)</option>
        </select>
        <span class="rules-label"> of the following:</span>
      </div>
      <div class="q-conditions-list" id="q-conditions-${id}"></div>
      <button class="btn btn-ghost btn-sm" style="margin-top:0.5rem" onclick="addQueueCondition(${id})">＋ Add Filter</button>
    </div>`;
  container.appendChild(div);
  _refreshQueuePreview();
}

function addQueueCondition(ruleId) {
  const list = document.getElementById(`q-conditions-${ruleId}`);
  const div = document.createElement('div');
  div.className = 'condition-row';
  div.style = 'display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.5rem;';
  div.innerHTML = `
    <select class="form-select rules-input cond-field" style="width:120px" onchange="_refreshQueuePreview()">
      <option value="keyword">Keyword</option>
      <option value="website">Website</option>
      <option value="affiliation">Affiliation</option>
      <option value="date">Date</option>
      <option value="email_status">Status</option>
      <option value="email">Email</option>
      <option value="author_name">Author</option>
      <option value="article_title">Article Title</option>
      <option value="journal_name">Journal Name</option>
      <option value="count">Count (rows)</option>
    </select>
    <select class="form-select rules-input cond-op" style="width:110px" onchange="_refreshQueuePreview()">
      <option value="contains">contains</option>
      <option value="equals">equals</option>
      <option value="greater">greater than</option>
      <option value="less">less than</option>
    </select>
    <input type="text" class="form-input rules-input cond-val" style="flex:1" placeholder="value…" oninput="_refreshQueuePreview()">
    <button class="assign-remove-btn" onclick="this.parentElement.remove(); _checkQueueLogicToggle(${ruleId}); _refreshQueuePreview()">✕</button>
  `;
  list.appendChild(div);
  _checkQueueLogicToggle(ruleId);
  _refreshQueuePreview();
}

function _checkQueueLogicToggle(ruleId) {
  const list = document.getElementById(`q-conditions-${ruleId}`);
  const bar = document.getElementById(`q-logic-bar-${ruleId}`);
  if (list && bar) {
    bar.style.display = list.children.length > 1 ? 'block' : 'none';
  }
}

function removeQueueRule(id) {
  const el = document.getElementById(`q-rule-${id}`);
  if (el) el.remove();
  _refreshQueuePreview();
}

// ── Build queue rules from modal UI ───────────────────────────────────────────
function _buildQueueRules() {
  const rules = [];
  document.querySelectorAll('.queue-rule-card').forEach(card => {
    const id = card.id.replace('q-rule-', '');
    const logicSel = card.querySelector(`.q-logic-sel[data-id="${id}"]`);
    const logic = logicSel ? logicSel.value : 'AND';
    const conditions = [];

    const condList = document.getElementById(`q-conditions-${id}`);
    if (condList) {
      condList.querySelectorAll('.condition-row').forEach(row => {
        const field = row.querySelector('.cond-field').value;
        const op    = row.querySelector('.cond-op').value;
        const val   = row.querySelector('.cond-val').value.trim();
        if (val) {
          conditions.push({ field, operator: op, value: val });
        }
      });
    }
    rules.push({ logic, conditions });
  });
  return rules;
}

// ── Filter matching (same logic as upload) ────────────────────────────────────
function _queueRowMatchesRule(row, conditions, logic, ruleState) {
  if (!conditions || conditions.length === 0) return true;

  const evaluate = (cond) => {
    if (cond.field === 'count') {
      const limit = parseInt(cond.value, 10);
      if (isNaN(limit)) return false;
      switch (cond.operator) {
        case 'greater': return ruleState.matches > limit;
        case 'less':    return ruleState.matches < limit;
        case 'equals':  return ruleState.matches === limit;
        default:        return ruleState.matches < limit;
      }
    }

    const rowVal = String(row[cond.field] || '').toLowerCase();
    const condVal = String(cond.value || '').toLowerCase();

    switch (cond.operator) {
      case 'contains': return rowVal.includes(condVal);
      case 'equals':   return rowVal === condVal;
      case 'greater':  return rowVal > condVal;
      case 'less':     return rowVal < condVal;
      default:         return false;
    }
  };

  return logic === 'OR' ? conditions.some(evaluate) : conditions.every(evaluate);
}

// ── Preview which rows match the filter rules ─────────────────────────────────
function _refreshQueuePreview() {
  const lastData = window._mineLastData;
  if (!lastData || !lastData.data) return;

  const rules = _buildQueueRules();
  const previewSection = document.getElementById('queue-preview-section');
  const tbody = document.getElementById('queue-preview-tbody');
  const infoEl = document.getElementById('queue-preview-info');

  // Determine matching rows: if no rules, use selected checkboxes; if rules exist, filter
  let matchIds;
  if (rules.length > 0 && rules.some(r => r.conditions.length > 0)) {
    matchIds = new Set();
    let matchesCount = 0;
    lastData.data.forEach(r => {
      // Row matches if ALL rules match (rules are AND-combined)
      const allMatch = rules.every(rule => _queueRowMatchesRule(r, rule.conditions, rule.logic, { matches: matchesCount }));
      if (allMatch) {
        matchIds.add(r.id);
        matchesCount++;
      }
    });
  } else {
    matchIds = new Set(_mineSelectedIds);
  }

  if (previewSection) previewSection.classList.remove('hidden');
  if (infoEl) infoEl.textContent = `${matchIds.size} row${matchIds.size !== 1 ? 's' : ''} will be assigned`;

  if (tbody) {
    const rows = lastData.data.filter(r => matchIds.has(r.id));
    tbody.innerHTML = rows.slice(0, 100).map(r => `
      <tr>
        <td class="preview-td-num">${r.id}</td>
        <td class="preview-td-email" title="${esc(r.email)}">${esc(r.email)}</td>
        <td class="preview-td-text" title="${esc(r.author_name)}">${esc(r.author_name || '')}</td>
        <td class="preview-td-text" title="${esc(r.keyword)}">${esc(r.keyword || '')}</td>
        <td>${scrapingBadge(r.email_status)}</td>
      </tr>
    `).join('') || '<tr><td colspan="5" style="text-align:center;padding:1rem;color:var(--text-muted)">No matching rows</td></tr>';
  }

  // Store match IDs for the apply action
  window._queueMatchIds = matchIds;
}

// ── Apply Queue Assignment ────────────────────────────────────────────────────
async function applyQueueAssignment() {
  const queueName = _getResolvedQueueName();
  if (!queueName) {
    showToast('Please enter or select a queue name', 'warning');
    return;
  }

  const ids = window._queueMatchIds ? Array.from(window._queueMatchIds) : Array.from(_mineSelectedIds);
  if (!ids.length) {
    showToast('No rows selected or matched', 'warning');
    return;
  }

  // For 'select' mode (appending to existing queue) we don't send a new color;
  // for 'new' / 'empty' mode we send the chosen color.
  const isAppend = _queueModalMode === 'select';
  const color = isAppend ? undefined : getSelectedQueueColor();

  const btn = document.getElementById('btn-apply-queue');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Assigning…'; }

  try {
    const payload = { queue_name: queueName, record_ids: ids };
    if (color) payload.color = color;
    const result = await api('PATCH', '/scraping/queue-assign', payload);
    const verb = isAppend ? 'Appended' : 'Assigned';
    showToast(`${verb} ${result.updated} records to "${queueName}"`, 'success');
    closeQueueModal();
    _mineSelectedIds.clear();
    window._queueMatchIds = null;
    await loadMineCollection();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '✓ Apply Queue'; }
  }
}

// ── Clear Queue from selected rows ────────────────────────────────────────────
async function clearQueueSelection() {
  const ids = Array.from(_mineSelectedIds);
  if (!ids.length) {
    showToast('No rows selected', 'warning');
    return;
  }

  try {
    const result = await api('PATCH', '/scraping/queue-clear', { record_ids: ids });
    showToast(`Cleared queue from ${result.updated} records`, 'success');
    _mineSelectedIds.clear();
    await loadMineCollection();
  } catch (err) {
    showToast(err.message, 'error');
  }
}
