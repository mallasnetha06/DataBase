/* ═══════════════════════════════════════════════════════════════════════════
   DataBase — js/campaign-composer.js
   Campaign Composer panel — temporary email queue builder
   Features:
     - Pick a queue from My Collection
     - Pick templates + assign row counts per template
     - Generate temporary list: email | subject | body (never written to DB)
     - Export as CSV (client-side)
     - Sequential Copy Mode: Ctrl+D advances forward / Ctrl+W goes back one step
       (global hotkeys delivered via Chrome extension → content.js → ccCopyNext / ccCopyPrev)
     - Auto-status update: when all fields of a row have been copied via Ctrl+D,
       the source queue row's status is automatically set to "used" via API
   Depends on: core.js (api, esc, showToast)
═══════════════════════════════════════════════════════════════════════════ */

'use strict';

// ── Module state ──────────────────────────────────────────────────────────────
let _ccQueueMeta = [];   // [{queue_name, color, count}, …] from API
let _ccQueueRows = [];   // all rows for the selected queue
let _ccTemplateList = [];   // [{id, name, subject, body}, …]
let _ccSelectedQueueName = null;
let _ccCurrentStep = 1;    // 1 | 2 | 3
let _ccGeneratedRows = [];   // [{email, subject, body, template_name, row_num, _source_idx}, …]
let _ccAssignMode = 'sequential'; // 'sequential' | 'roundrobin' | 'random'

// ── Sequential Copy Mode state ────────────────────────────────────────────────
let _ccCopyActive = false;           // is copy mode running?
let _ccCopyOrder = ['subject', 'email', 'body', 'status']; // user-defined field order (includes 'status' action chip)
let _ccCopyRowIdx = 0;              // which row we're on (0-based)
let _ccCopyFieldIdx = 0;             // which field in _ccCopyOrder we're on
let _ccCopyDragSrc = null;          // drag-and-drop source index
// Maps sourceIdx → original email_status, so Ctrl+W can undo a "Used" marking
let _ccRowPrevStatuses = {};          // { [_source_idx]: 'Unused' | 'Reserved' | … }

// ── Session persistence ───────────────────────────────────────────────────────
const _CC_SESSION_KEY = 'cc_session_v1';

/** Save current state to sessionStorage so navigating away and back restores it. */
function _ccSaveSession() {
  try {
    sessionStorage.setItem(_CC_SESSION_KEY, JSON.stringify({
      step: _ccCurrentStep,
      selectedQueue: _ccSelectedQueueName,
      assignMode: _ccAssignMode,
      generatedRows: _ccGeneratedRows,
      queueRows: _ccQueueRows,
      copyOrder: _ccCopyOrder,
      copyActive: _ccCopyActive,
      copyRowIdx: _ccCopyRowIdx,
      copyFieldIdx: _ccCopyFieldIdx,
      rowPrevStatuses: _ccRowPrevStatuses,
    }));
  } catch (_) { /* storage full / private mode — fail silently */ }
}

/** Load saved state from sessionStorage. Returns true if a session was found. */
function _ccLoadSession() {
  try {
    const raw = sessionStorage.getItem(_CC_SESSION_KEY);
    if (!raw) return false;
    const s = JSON.parse(raw);
    _ccCurrentStep = s.step ?? 1;
    _ccSelectedQueueName = s.selectedQueue ?? null;
    _ccAssignMode = s.assignMode ?? 'sequential';
    _ccGeneratedRows = s.generatedRows ?? [];
    _ccQueueRows = s.queueRows ?? [];
    _ccCopyOrder = s.copyOrder ?? ['subject', 'email', 'body', 'status'];
    // Migrate old sessions that don't have the 'status' chip yet
    if (!_ccCopyOrder.includes('status')) {
      _ccCopyOrder.push('status');
    }
    _ccRowPrevStatuses = s.rowPrevStatuses ?? {};
    // If copy mode was active when user left, keep the position but pause it
    // (the keydown listener is gone; they can hit Start / it will resume from
    // where they were because rowIdx/fieldIdx are preserved)
    _ccCopyActive = false;            // always pause on return
    _ccCopyRowIdx = s.copyRowIdx ?? 0;
    _ccCopyFieldIdx = s.copyFieldIdx ?? 0;
    return true;
  } catch (_) { return false; }
}

/** Clear the saved session (called by "Start Over"). */
function _ccClearSession() {
  try { sessionStorage.removeItem(_CC_SESSION_KEY); } catch (_) { }
}

// ── Entry point — called by showPanel('campaign-composer') ────────────────────
async function loadCampaignComposer() {
  // ── Try to restore a previous session ──────────────────────────────────────
  const resumed = _ccLoadSession();

  if (!resumed) {
    // Fresh start — reset everything
    _ccCurrentStep = 1;
    _ccQueueRows = [];
    _ccGeneratedRows = [];
    _ccSelectedQueueName = null;
    _ccAssignMode = 'sequential';
    _ccCopyActive = false;
    _ccCopyRowIdx = 0;
    _ccCopyFieldIdx = 0;
  }

  _ccRenderSteps();
  _ccShowStep(_ccCurrentStep);
  _ccRenderResultsSection(_ccGeneratedRows.length > 0);

  // Always reload queue/template metadata from the server (lightweight)
  try {
    const [qData, tData] = await Promise.all([
      api('GET', '/scraping/mine/queues').catch(() => ({ queues: [] })),
      api('GET', '/templates').catch(() => []),
    ]);
    _ccQueueMeta = qData.queues || [];
    _ccTemplateList = tData || [];
  } catch (e) {
    showToast('Failed to load data: ' + e.message, 'error');
    _ccQueueMeta = [];
    _ccTemplateList = [];
  }

  _ccRenderStep1();
  _ccRenderStep2();

  // If we resumed with generated rows, re-render the results table
  if (resumed && _ccGeneratedRows.length > 0) {
    _ccRenderResultsSection(true);
    // If copy mode was running, restore position indicator (paused state)
    if (_ccCopyRowIdx > 0 || _ccCopyFieldIdx > 0) {
      _ccUpdateCopyStatus();
      _ccHighlightCurrentCell();
    }
    showToast('Session restored — pick up where you left off', 'info');
  }
}

// ── Step navigation ───────────────────────────────────────────────────────────
function _ccShowStep(n) {
  _ccCurrentStep = n;
  [1, 2, 3].forEach(i => {
    const card = document.getElementById(`cc-step-card-${i}`);
    if (!card) return;
    card.style.display = '';          // clear any inline override
    card.classList.toggle('visible', i === n);
  });
  _ccRenderSteps();
  _ccSaveSession();
}

function ccGoStep(n) {
  // Validate before advancing
  if (n === 2 && !_ccSelectedQueueName) {
    showToast('Please select a queue first', 'warning');
    return;
  }
  if (n === 3) {
    if (!_ccSelectedQueueName) { showToast('Please select a queue first', 'warning'); return; }
    if (!_ccGetSelectedTemplates().length) { showToast('Please select at least one template', 'warning'); return; }
    _ccGenerateCampaign();
    return;
  }
  _ccShowStep(n);
}

// ── Steps rail render ─────────────────────────────────────────────────────────
function _ccRenderSteps() {
  const rail = document.getElementById('cc-steps-rail');
  if (!rail) return;
  const steps = [
    { n: 1, icon: '1', label: 'Select Queue' },
    { n: 2, icon: '2', label: 'Pick Templates' },
    { n: 3, icon: '✓', label: 'Generate' },
  ];
  rail.innerHTML = steps.map((s, idx) => {
    const state = s.n < _ccCurrentStep ? 'done' : s.n === _ccCurrentStep ? 'active' : '';
    const connActive = s.n < _ccCurrentStep ? 'active' : '';
    const connector = idx < steps.length - 1
      ? `<div class="cc-step-connector ${connActive}"></div>`
      : '';
    return `
      <div class="cc-step ${state}">
        <div class="cc-step-bubble">${s.n < _ccCurrentStep ? '✓' : s.n}</div>
        <div class="cc-step-label">${s.label}</div>
      </div>
      ${connector}`;
  }).join('');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  STEP 1 — Select Queue
// ═══════════════════════════════════════════════════════════════════════════════

function _ccRenderStep1() {
  const body = document.getElementById('cc-step1-body');
  if (!body) return;

  if (!_ccQueueMeta.length) {
    body.innerHTML = `
      <div class="cc-template-empty">
        <div style="font-size:1.8rem;margin-bottom:0.5rem">📭</div>
        <p>No queues found in My Collection.<br>
        Go to <strong>My Collection</strong> → select rows → Assign to Queue first.</p>
      </div>
      <div class="cc-nav-btns">
        <button class="btn btn-ghost btn-sm" onclick="showPanel('scraping-mine')">Go to My Collection →</button>
      </div>`;
    return;
  }

  const options = _ccQueueMeta.map(q =>
    `<option value="${esc(q.queue_name)}" data-color="${esc(q.color)}" data-count="${q.count}">${esc(q.queue_name)} (${q.count} rows)</option>`
  ).join('');

  body.innerHTML = `
    <div class="cc-queue-select-row">
      <select id="cc-queue-sel" class="form-select cc-queue-select" onchange="ccOnQueueChange(this)">
        <option value="">— Choose a queue —</option>
        ${options}
      </select>
      <div class="cc-queue-info-pill" id="cc-queue-pill">
        <span class="cc-queue-dot" id="cc-queue-dot"></span>
        <span id="cc-queue-pill-text"></span>
      </div>
    </div>
    <div class="cc-nav-btns">
      <button class="btn btn-primary btn-sm" onclick="ccGoStep(2)" id="cc-btn-next-1">
        Next: Pick Templates →
      </button>
    </div>`;

  // Restore previous selection
  if (_ccSelectedQueueName) {
    const sel = document.getElementById('cc-queue-sel');
    if (sel) {
      sel.value = _ccSelectedQueueName;
      ccOnQueueChange(sel);
    }
  }
}

async function ccOnQueueChange(sel) {
  const name = sel.value;
  const opt = sel.options[sel.selectedIndex];
  const color = opt?.dataset?.color || '#6366f1';
  const count = opt?.dataset?.count || 0;

  _ccSelectedQueueName = name || null;

  const pill = document.getElementById('cc-queue-pill');
  const dot = document.getElementById('cc-queue-dot');
  const pillTxt = document.getElementById('cc-queue-pill-text');

  if (!name) {
    if (pill) pill.classList.remove('visible');
    _ccQueueRows = [];
    return;
  }

  if (pill) { pill.classList.add('visible'); pill.style.setProperty('--q-color', color); }
  if (dot) { dot.style.background = color; }
  if (pillTxt) pillTxt.textContent = `${count} rows`;

  // Eagerly fetch all rows for this queue (all pages, silent)
  _ccQueueRows = await _ccFetchAllQueueRows(name);
  // Update count display with actual fetched row count
  if (pillTxt) pillTxt.textContent = `${_ccQueueRows.length} rows loaded`;
}

async function _ccFetchAllQueueRows(queueName) {
  try {
    // Paginate through all pages (API max page_size is 100)
    const PAGE_SIZE = 100;
    let page = 1;
    let allRows = [];

    while (true) {
      const data = await api('GET', `/scraping/mine?page=${page}&page_size=${PAGE_SIZE}&queue_group=${encodeURIComponent(queueName)}`);
      const rows = data.data || [];
      // Client-side queue filter to be safe
      const filtered = rows.filter(r => r.queue_group === queueName);
      allRows = allRows.concat(filtered);

      // Stop if we got fewer rows than a full page (last page)
      if (rows.length < PAGE_SIZE) break;
      page++;
    }

    return allRows;
  } catch (e) {
    showToast('Could not load queue rows: ' + e.message, 'error');
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  STEP 2 — Pick Templates
// ═══════════════════════════════════════════════════════════════════════════════

function _ccRenderStep2() {
  const body = document.getElementById('cc-step2-body');
  if (!body) return;

  if (!_ccTemplateList.length) {
    body.innerHTML = `
      <div class="cc-template-empty">
        <div style="font-size:1.8rem;margin-bottom:0.5rem">✉️</div>
        <p>No templates found. Create one in the <strong>Templates</strong> panel first.</p>
      </div>
      <div class="cc-nav-btns">
        <button class="btn btn-ghost btn-sm" onclick="_ccShowStep(1)">← Back</button>
        <button class="btn btn-ghost btn-sm" onclick="showPanel('templates')">Go to Templates →</button>
      </div>`;
    return;
  }

  body.innerHTML = `
    <!-- ── Assignment mode selector ─────────────────────────────────────── -->
    <div class="cc-assign-mode-bar">
      <span class="cc-assign-mode-label">Assignment Mode:</span>
      <div class="cc-assign-mode-btns" id="cc-assign-mode-btns">
        <button class="cc-assign-mode-btn ${_ccAssignMode === 'sequential' ? 'active' : ''}"
                onclick="ccSetAssignMode('sequential')"
                title="Each template gets a fixed block of rows (set count below)">
          <span class="cc-mode-icon">▬▬▬</span> Sequential
        </button>
        <button class="cc-assign-mode-btn ${_ccAssignMode === 'roundrobin' ? 'active' : ''}"
                onclick="ccSetAssignMode('roundrobin')"
                title="Templates rotate one-by-one: T1, T2, T1, T2, …">
          <span class="cc-mode-icon">🔄</span> One-by-One
        </button>
        <button class="cc-assign-mode-btn ${_ccAssignMode === 'random' ? 'active' : ''}"
                onclick="ccSetAssignMode('random')"
                title="Each row gets a randomly chosen template">
          <span class="cc-mode-icon">🎲</span> Random
        </button>
      </div>
      <span class="cc-mode-hint" id="cc-mode-hint">${_ccModeModeHint(_ccAssignMode)}</span>
    </div>
    <!-- ── Template grid ─────────────────────────────────────────────────── -->
    <div class="cc-template-grid" id="cc-template-grid">
      ${_ccTemplateList.map(t => _ccTplCardHTML(t)).join('')}
    </div>
    <div class="cc-assign-summary" id="cc-assign-summary">
      <div class="cc-assign-summary-item">
        <span>Queue rows:</span>
        <span class="cc-assign-summary-val" id="cc-sum-total">—</span>
      </div>
      <div class="cc-assign-summary-divider">|</div>
      <div class="cc-assign-summary-item">
        <span>Templates selected:</span>
        <span class="cc-assign-summary-val" id="cc-sum-tpls">0</span>
      </div>
      <div class="cc-assign-summary-divider">|</div>
      <div class="cc-assign-summary-item">
        <span>Rows assigned:</span>
        <span class="cc-assign-summary-val" id="cc-sum-assigned">0</span>
      </div>
      <div class="cc-assign-summary-divider">|</div>
      <div id="cc-sum-status" class="cc-assign-summary-item"></div>
    </div>
    <div class="cc-nav-btns" style="margin-top:0.5rem">
      <button class="btn btn-ghost btn-sm" onclick="_ccShowStep(1)">← Back</button>
      <button class="btn btn-primary btn-sm" onclick="ccGoStep(3)" id="cc-btn-generate">
        🎯 Generate Campaign
      </button>
    </div>`;

  _ccUpdateAssignSummary();
  _ccApplyModeToCards();
}

/** Returns the helper hint text for the current mode. */
function _ccModeModeHint(mode) {
  if (mode === 'roundrobin') return 'Templates will cycle one-by-one: T1 → T2 → T1 → T2 …';
  if (mode === 'random') return 'Each row will be assigned a randomly chosen template.';
  return 'Set row counts per template below. Blank = use all remaining rows.';
}

/** Called when user clicks a mode button. */
function ccSetAssignMode(mode) {
  _ccAssignMode = mode;
  // Update button active states
  document.querySelectorAll('.cc-assign-mode-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  const activeBtn = document.querySelector(`.cc-assign-mode-btn[onclick="ccSetAssignMode('${mode}')"]`);
  if (activeBtn) activeBtn.classList.add('active');
  // Update hint
  const hintEl = document.getElementById('cc-mode-hint');
  if (hintEl) hintEl.textContent = _ccModeModeHint(mode);
  // Show/hide count inputs based on mode
  _ccApplyModeToCards();
  _ccUpdateAssignSummary();
  _ccSaveSession();
}

/** Shows/hides the "Rows to assign" count section based on current mode. */
function _ccApplyModeToCards() {
  const isSequential = _ccAssignMode === 'sequential';
  document.querySelectorAll('.cc-tpl-count-row').forEach(row => {
    row.style.display = isSequential ? '' : 'none';
  });
}

function _ccTplCardHTML(t) {
  const subjectPreview = t.subject ? (t.subject.length > 50 ? t.subject.slice(0, 50) + '…' : t.subject) : '(no subject)';
  return `
    <div class="cc-tpl-card" id="cc-tpl-${t.id}" onclick="ccToggleTemplate(${t.id})">
      <div class="cc-tpl-card-check">✓</div>
      <div class="cc-tpl-card-name">📄 ${esc(t.name)}</div>
      <div class="cc-tpl-card-subject">${esc(subjectPreview)}</div>
      <div class="cc-tpl-count-row">
        <span class="cc-tpl-count-label">Rows to assign:</span>
        <input type="number"
               id="cc-count-${t.id}"
               class="cc-tpl-count-input form-input"
               min="1"
               placeholder="all"
               title="Leave blank to use all remaining rows"
               oninput="event.stopPropagation(); _ccUpdateAssignSummary()"
               onclick="event.stopPropagation()">
        <span class="cc-tpl-row-badge" id="cc-badge-${t.id}">—</span>
      </div>
    </div>`;
}

function ccToggleTemplate(id) {
  const card = document.getElementById(`cc-tpl-${id}`);
  if (!card) return;
  card.classList.toggle('selected');
  _ccUpdateAssignSummary();
}

function _ccGetSelectedTemplates() {
  return _ccTemplateList.filter(t => {
    const card = document.getElementById(`cc-tpl-${t.id}`);
    return card && card.classList.contains('selected');
  });
}

function _ccUpdateAssignSummary() {
  const totalEl = document.getElementById('cc-sum-total');
  const tplsEl = document.getElementById('cc-sum-tpls');
  const assignedEl = document.getElementById('cc-sum-assigned');
  const statusEl = document.getElementById('cc-sum-status');

  const totalRows = _ccQueueRows.length;
  if (totalEl) totalEl.textContent = totalRows || '—';

  const selected = _ccGetSelectedTemplates();
  if (tplsEl) tplsEl.textContent = selected.length;

  // ── Non-sequential modes: every row gets a template automatically ─────────
  if (_ccAssignMode === 'roundrobin' || _ccAssignMode === 'random') {
    // Clear badges on all selected cards
    selected.forEach(t => {
      const badge = document.getElementById(`cc-badge-${t.id}`);
      if (badge) badge.textContent = '—';
    });
    if (assignedEl) assignedEl.textContent = selected.length ? totalRows : 0;
    if (statusEl) {
      if (!selected.length) {
        statusEl.innerHTML = '';
      } else {
        statusEl.innerHTML = '<span class="cc-ok">✓ All rows covered</span>';
      }
    }
    return;
  }

  // ── Sequential mode: compute block counts ─────────────────────────────────
  let totalAssigned = 0;
  let remaining = totalRows;

  selected.forEach((t, idx) => {
    const inp = document.getElementById(`cc-count-${t.id}`);
    const badge = document.getElementById(`cc-badge-${t.id}`);
    const isLast = idx === selected.length - 1;

    let count;
    if (inp && inp.value.trim() !== '') {
      count = Math.max(1, parseInt(inp.value, 10) || 1);
    } else {
      // Blank = "use all remaining"
      count = isLast ? remaining : Math.ceil(remaining / (selected.length - idx));
    }
    count = Math.min(count, remaining);
    remaining = Math.max(0, remaining - count);

    totalAssigned += count;
    if (badge) badge.textContent = count > 0 ? `${count} rows` : '0 rows';
  });

  if (assignedEl) assignedEl.textContent = totalAssigned;

  if (statusEl) {
    if (!selected.length) {
      statusEl.innerHTML = '';
    } else if (totalAssigned === totalRows) {
      statusEl.innerHTML = '<span class="cc-ok">✓ All rows covered</span>';
    } else if (totalAssigned < totalRows) {
      statusEl.innerHTML = `<span class="cc-warn">⚠ ${totalRows - totalAssigned} rows unassigned</span>`;
    } else {
      statusEl.innerHTML = `<span class="cc-warn">⚠ Over by ${totalAssigned - totalRows} rows</span>`;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  STEP 3 — Generate Campaign
// ═══════════════════════════════════════════════════════════════════════════════

function _ccGenerateCampaign() {
  const selected = _ccGetSelectedTemplates();
  const totalRows = _ccQueueRows.length;

  _ccGeneratedRows = [];

  if (_ccAssignMode === 'roundrobin') {
    // ── One-by-One (round-robin): T1, T2, T1, T2, … ───────────────────────
    _ccQueueRows.forEach((row, i) => {
      const t = selected[i % selected.length];
      _ccGeneratedRows.push({
        row_num: _ccGeneratedRows.length + 1,
        email: row.email || '',
        subject: _ccResolvePlaceholders(t.subject || '', row),
        body: _ccResolvePlaceholders(t.body || '', row),
        template_name: t.name,
        template_id: t.id,
        author_name: row.author_name || '',
        _source_idx: i,
      });
    });

  } else if (_ccAssignMode === 'random') {
    // ── Random: each row picks a random template ───────────────────────────
    _ccQueueRows.forEach((row, i) => {
      const t = selected[Math.floor(Math.random() * selected.length)];
      _ccGeneratedRows.push({
        row_num: _ccGeneratedRows.length + 1,
        email: row.email || '',
        subject: _ccResolvePlaceholders(t.subject || '', row),
        body: _ccResolvePlaceholders(t.body || '', row),
        template_name: t.name,
        template_id: t.id,
        author_name: row.author_name || '',
        _source_idx: i,
      });
    });

  } else {
    // ── Sequential (default): fixed blocks per template ────────────────────
    let remaining = totalRows;
    let rowIdx = 0;

    selected.forEach((t, idx) => {
      const inp = document.getElementById(`cc-count-${t.id}`);
      const isLast = idx === selected.length - 1;

      let count;
      if (inp && inp.value.trim() !== '') {
        count = Math.max(1, parseInt(inp.value, 10) || 1);
      } else {
        count = isLast ? remaining : Math.ceil(remaining / (selected.length - idx));
      }
      count = Math.min(count, remaining);
      remaining = Math.max(0, remaining - count);

      for (let i = 0; i < count; i++) {
        if (rowIdx >= _ccQueueRows.length) break;
        const row = _ccQueueRows[rowIdx];
        _ccGeneratedRows.push({
          row_num: _ccGeneratedRows.length + 1,
          email: row.email || '',
          subject: _ccResolvePlaceholders(t.subject || '', row),
          body: _ccResolvePlaceholders(t.body || '', row),
          template_name: t.name,
          template_id: t.id,
          author_name: row.author_name || '',
          _source_idx: rowIdx,
        });
        rowIdx++;
      }
    });
  }

  // Show the results panel
  _ccRenderResultsSection(true);
  _ccShowStep(3);

  // Persist the generated campaign so navigation away and back restores it
  _ccSaveSession();

  // Scroll to results
  const resultsEl = document.getElementById('cc-results-section');
  if (resultsEl) resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });

  showToast(`Generated ${_ccGeneratedRows.length} rows`, 'success');
}

function _ccResolvePlaceholders(template, row) {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const val = row[key];
    return (val !== null && val !== undefined) ? String(val) : '';
  });
}

// ── Results table ─────────────────────────────────────────────────────────────
function _ccRenderResultsSection(show) {
  const section = document.getElementById('cc-results-section');
  if (!section) return;

  if (!show) {
    section.classList.remove('visible');
    return;
  }

  section.classList.add('visible');

  const countBadge = document.getElementById('cc-results-count');
  if (countBadge) countBadge.textContent = `${_ccGeneratedRows.length} rows`;

  // Inject / refresh the copy-mode bar into the results header
  _ccRenderCopyModeBar();

  const tbody = document.getElementById('cc-results-tbody');
  if (!tbody) return;

  if (!_ccGeneratedRows.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="cc-empty-state">
      <div class="cc-empty-icon">📭</div>
      <p>No rows generated. Check queue and template settings.</p>
    </td></tr>`;
    return;
  }

  // Build options list from selected templates so user can pick any of them
  const _selectedTpls = _ccGetSelectedTemplates();

  tbody.innerHTML = _ccGeneratedRows.map((r, ri) => {
    const tplOptions = _selectedTpls.map(t =>
      `<option value="${t.id}"${t.id === r.template_id ? ' selected' : ''}>${esc(t.name)}</option>`
    ).join('');
    return `
    <tr id="cc-row-${ri}">
      <td class="cc-td-num">${r.row_num}</td>
      <td class="cc-td-email" id="cc-cell-${ri}-email" title="${esc(r.email)}">${esc(r.email)}</td>
      <td class="cc-td-tpl">
        <select class="cc-tpl-inline-select" id="cc-tpl-sel-${ri}"
                onchange="ccUpdateRowTemplate(${ri}, parseInt(this.value))">
          ${tplOptions}
        </select>
      </td>
      <td class="cc-td-subject" id="cc-cell-${ri}-subject" title="${esc(r.subject)}">${esc(r.subject) || '<span style="color:var(--text-muted)">(empty)</span>'}</td>
      <td class="cc-td-body" id="cc-cell-${ri}-body" title="${esc(r.body)}">${esc(r.body) || '<span style="color:var(--text-muted)">(empty)</span>'}</td>
    </tr>`;
  }).join('');
}

// ── Per-row template override (Step 3 dropdown) ──────────────────────────────
/**
 * Called when the user changes the template dropdown for a row in Step 3.
 * Re-resolves placeholders using the original source queue row and updates
 * the subject / body cells live — no full regeneration needed.
 *
 * @param {number} rowIndex   - index into _ccGeneratedRows
 * @param {number} templateId - id of the newly selected template
 */
function ccUpdateRowTemplate(rowIndex, templateId) {
  const genRow = _ccGeneratedRows[rowIndex];
  if (!genRow) return;

  const newTpl = _ccTemplateList.find(t => t.id === templateId);
  if (!newTpl) return;

  // Re-resolve placeholders from the original queue source row
  const sourceRow = _ccQueueRows[genRow._source_idx] || {};
  const newSubject = _ccResolvePlaceholders(newTpl.subject || '', sourceRow);
  const newBody = _ccResolvePlaceholders(newTpl.body || '', sourceRow);

  // Update in-memory data
  genRow.template_name = newTpl.name;
  genRow.template_id = templateId;
  genRow.subject = newSubject;
  genRow.body = newBody;

  // Update DOM cells live
  const subjectCell = document.getElementById(`cc-cell-${rowIndex}-subject`);
  const bodyCell = document.getElementById(`cc-cell-${rowIndex}-body`);
  if (subjectCell) {
    subjectCell.title = newSubject;
    subjectCell.innerHTML = newSubject
      ? esc(newSubject)
      : '<span style="color:var(--text-muted)">(empty)</span>';
  }
  if (bodyCell) {
    bodyCell.title = newBody;
    bodyCell.innerHTML = newBody
      ? esc(newBody)
      : '<span style="color:var(--text-muted)">(empty)</span>';
  }

  showToast(`Row ${genRow.row_num}: template updated to "${newTpl.name}"`, 'info');
}

// ── CSV Export ────────────────────────────────────────────────────────────────
function exportCampaignCSV() {
  if (!_ccGeneratedRows.length) {
    showToast('No rows to export', 'warning');
    return;
  }

  const headers = ['#', 'Email', 'Template', 'Subject', 'Body'];
  const escape = v => `"${String(v).replace(/"/g, '""')}"`;

  const csvRows = [
    headers.join(','),
    ..._ccGeneratedRows.map(r => [
      r.row_num,
      escape(r.email),
      escape(r.template_name),
      escape(r.subject),
      escape(r.body),
    ].join(',')),
  ];

  const blob = new Blob([csvRows.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `campaign_${_ccSelectedQueueName || 'export'}_${ts}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`Exported ${_ccGeneratedRows.length} rows to CSV`, 'success');
}

// ── Regenerate from step 3 shortcut ──────────────────────────────────────────
function ccBackToStep2() {
  // Stop copy mode before going back
  if (_ccCopyActive) ccStopCopyMode();
  _ccShowStep(2);
  const resultsSection = document.getElementById('cc-results-section');
  if (resultsSection) resultsSection.classList.remove('visible');
  _ccRenderStep2();
  _ccSaveSession();
}

// ── Start Over — wipes session and reloads from scratch ───────────────────────
function ccStartOver() {
  if (_ccCopyActive) ccStopCopyMode();
  _ccClearSession();
  _ccCurrentStep = 1;
  _ccQueueRows = [];
  _ccGeneratedRows = [];
  _ccSelectedQueueName = null;
  _ccAssignMode = 'sequential';
  _ccCopyActive = false;
  _ccCopyRowIdx = 0;
  _ccCopyFieldIdx = 0;
  _ccRowPrevStatuses = {};
  _ccRenderSteps();
  _ccShowStep(1);
  _ccRenderResultsSection(false);
  _ccRenderStep1();
  _ccRenderStep2();
  showToast('Campaign Composer reset', 'info');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SEQUENTIAL COPY MODE
//  Ctrl+D is delivered globally by the Chrome extension → background.js →
//  content.js → ccCopyNext() (exposed on window so content.js can call it)
// ═══════════════════════════════════════════════════════════════════════════════

// Field label display names
const _CC_FIELD_LABELS = { email: 'Email', subject: 'Subject', body: 'Body', status: 'Update Status' };
// All possible chips (canonical order used when re-adding from tray)
const _CC_ALL_FIELDS = ['subject', 'email', 'body', 'status'];

// ── Render the copy-mode control bar above the table ─────────────────────────
function _ccRenderCopyModeBar() {
  // Remove any existing bar first
  const existing = document.getElementById('cc-copy-mode-bar');
  if (existing) existing.remove();

  const header = document.getElementById('cc-results-header')
    || document.querySelector('#cc-results-section .cc-results-header');
  if (!header) { console.warn('[CC] cc-results-header not found'); return; }

  const bar = document.createElement('div');
  bar.id = 'cc-copy-mode-bar';
  bar.className = 'cc-copy-mode-bar';
  bar.innerHTML = `
    <div class="cc-copy-bar-top">
      <div class="cc-copy-bar-label">⚡ Sequential Copy Mode</div>
      <div class="cc-copy-bar-hint">Drag to reorder · × to remove · click ＋ in tray to restore · <kbd>Ctrl+D</kbd> next · <kbd>Ctrl+R</kbd> back · <strong>Status</strong> chip marks row as <em>Used</em></div>
    </div>
    <div class="cc-copy-controls">
      <div class="cc-order-chips" id="cc-order-chips">
        ${_ccBuildChipsHTML()}
      </div>
      <div class="cc-copy-actions">
        <button id="cc-copy-start-btn" class="btn btn-success btn-sm cc-copy-btn-start" onclick="ccStartCopyMode()">
          ▶ Start
        </button>
        <button id="cc-copy-stop-btn" class="btn btn-ghost btn-sm cc-copy-btn-stop" onclick="ccStopCopyMode()" style="display:none">
          ■ Stop
        </button>
        <button id="cc-copy-next-btn" class="btn btn-primary btn-sm" onclick="ccCopyNext()" style="display:none" title="Same as Ctrl+D">
          Next →
        </button>
      </div>
    </div>
    <div id="cc-chip-tray" class="cc-chip-tray">
      ${_ccBuildInactiveTrayHTML()}
    </div>
    <div id="cc-copy-status" class="cc-copy-status" style="display:none"></div>`;

  // Insert the bar right after the results header
  header.insertAdjacentElement('afterend', bar);
  _ccBindChipDragEvents();
}

function _ccBuildChipsHTML() {
  return _ccCopyOrder.map((field, i) => {
    const isStatus = field === 'status';
    return `
    <div class="cc-order-chip${isStatus ? ' cc-chip-status' : ''}" data-field="${field}" data-idx="${i}"
         draggable="true"
         ondragstart="_ccChipDragStart(event, ${i})"
         ondragover="_ccChipDragOver(event)"
         ondrop="_ccChipDrop(event, ${i})"
         ondragend="_ccChipDragEnd(event)"
         title="${isStatus ? 'Sets row status to Used' : 'Copy ' + (field.charAt(0).toUpperCase() + field.slice(1)) + ' to clipboard'}">
      <span class="cc-chip-drag-handle">⠿</span>
      <span class="cc-chip-num">${i + 1}</span>
      <span class="cc-chip-label">${isStatus ? '🏷 ' : ''}${_CC_FIELD_LABELS[field] || field}</span>
      <button class="cc-chip-remove" onclick="event.stopPropagation(); ccRemoveChip('${field}')" title="Remove from order">×</button>
    </div>`;
  }).join('');
}

/** Build the HTML for the tray of chips NOT currently in _ccCopyOrder. */
function _ccBuildInactiveTrayHTML() {
  const inactive = _CC_ALL_FIELDS.filter(f => !_ccCopyOrder.includes(f));
  if (!inactive.length) return '';
  return inactive.map(field => {
    const isStatus = field === 'status';
    return `
    <button class="cc-tray-chip${isStatus ? ' cc-chip-status' : ''}" data-field="${field}"
            onclick="ccAddChip('${field}')"
            title="Click to add, or drag onto active chips">
      <span class="cc-tray-chip-plus">＋</span>
      ${isStatus ? '🏷 ' : ''}${_CC_FIELD_LABELS[field] || field}
    </button>`;
  }).join('');
}

/** Refresh both the active chips area and the tray in place. */
function _ccRefreshChips() {
  const chipsEl = document.getElementById('cc-order-chips');
  if (chipsEl) chipsEl.innerHTML = _ccBuildChipsHTML();
  const trayEl = document.getElementById('cc-chip-tray');
  if (trayEl) trayEl.innerHTML = _ccBuildInactiveTrayHTML();
  // Update tray visibility
  if (trayEl) trayEl.style.display = _CC_ALL_FIELDS.some(f => !_ccCopyOrder.includes(f)) ? '' : 'none';
  _ccSaveSession();
}

/** Remove a chip from the active order and send it to the tray. */
function ccRemoveChip(field) {
  if (_ccCopyActive) {
    showToast('Stop copy mode before changing the order', 'warning');
    return;
  }
  if (_ccCopyOrder.length <= 1) {
    showToast('At least one chip must remain in the order', 'warning');
    return;
  }
  _ccCopyOrder = _ccCopyOrder.filter(f => f !== field);
  // Clamp fieldIdx in case it's now out of bounds
  if (_ccCopyFieldIdx >= _ccCopyOrder.length) _ccCopyFieldIdx = 0;
  _ccRefreshChips();
}

/** Add a chip from the tray back into the active order (appended at end). */
function ccAddChip(field) {
  if (_ccCopyActive) {
    showToast('Stop copy mode before changing the order', 'warning');
    return;
  }
  if (_ccCopyOrder.includes(field)) return;
  // Insert in canonical order
  const canonical = _CC_ALL_FIELDS.filter(f => _ccCopyOrder.includes(f) || f === field);
  _ccCopyOrder = canonical;
  _ccRefreshChips();
}

// ── Drag-and-drop reordering for chips ───────────────────────────────────────
function _ccBindChipDragEvents() {
  // Active chip events are bound inline.
  // Wire the active chip zone as a drop target for tray chips.
  const chipsEl = document.getElementById('cc-order-chips');
  if (chipsEl && !chipsEl._trayDropWired) {
    chipsEl._trayDropWired = true;
    chipsEl.addEventListener('dragover', e => {
      if (_ccCopyDragSrc === null) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
    });
    chipsEl.addEventListener('drop', e => {
      const field = e.dataTransfer.getData('text/plain');
      if (field && !_ccCopyOrder.includes(field)) {
        e.preventDefault();
        ccAddChip(field);
      }
    });
  }
  // Wire tray chip drag events
  _ccWireTrayDragEvents();
}

function _ccWireTrayDragEvents() {
  const trayEl = document.getElementById('cc-chip-tray');
  if (!trayEl) return;
  trayEl.querySelectorAll('.cc-tray-chip').forEach(btn => {
    btn.setAttribute('draggable', 'true');
    btn.addEventListener('dragstart', e => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', btn.dataset.field);
      setTimeout(() => btn.classList.add('cc-tray-dragging'), 0);
    });
    btn.addEventListener('dragend', () => btn.classList.remove('cc-tray-dragging'));
  });
}

function _ccChipDragStart(e, idx) {
  _ccCopyDragSrc = idx;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', _ccCopyOrder[idx]);
  e.currentTarget.classList.add('cc-chip-dragging');
}

function _ccChipDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('cc-chip-over');
}

function _ccChipDrop(e, targetIdx) {
  e.preventDefault();
  e.stopPropagation();

  const fromTray = _ccCopyDragSrc === null;
  if (fromTray) {
    // Tray chip dropped onto an active chip — insert before targetIdx
    const field = e.dataTransfer.getData('text/plain');
    if (field && !_ccCopyOrder.includes(field)) {
      _ccCopyOrder.splice(targetIdx, 0, field);
      _ccRefreshChips();
    }
    return;
  }

  if (_ccCopyDragSrc === targetIdx) { _ccCopyDragSrc = null; return; }

  // Reorder active chips
  const moved = _ccCopyOrder.splice(_ccCopyDragSrc, 1)[0];
  _ccCopyOrder.splice(targetIdx, 0, moved);
  _ccRefreshChips();
  _ccCopyDragSrc = null;
}

function _ccChipDragEnd(e) {
  _ccCopyDragSrc = null;
  document.querySelectorAll('.cc-order-chip').forEach(c => {
    c.classList.remove('cc-chip-dragging', 'cc-chip-over');
  });
}

// ── Start copy mode ───────────────────────────────────────────────────────────

function ccStartCopyMode() {
  if (!_ccGeneratedRows.length) {
    showToast('No rows to copy — generate a campaign first', 'warning');
    return;
  }
  if (_ccCopyOrder.length === 0) {
    showToast('Copy order is empty', 'warning');
    return;
  }

  _ccCopyActive = true;
  // If resuming from a saved position (e.g. after navigating away),
  // keep the existing rowIdx / fieldIdx. Only reset if at the very start.
  if (_ccCopyRowIdx === 0 && _ccCopyFieldIdx === 0) {
    // Fresh start — indices are already 0, nothing to do
  }

  // Swap Start → Stop + Next buttons
  const startBtn = document.getElementById('cc-copy-start-btn');
  const stopBtn = document.getElementById('cc-copy-stop-btn');
  const nextBtn = document.getElementById('cc-copy-next-btn');
  if (startBtn) startBtn.style.display = 'none';
  if (stopBtn) stopBtn.style.display = '';
  if (nextBtn) nextBtn.style.display = '';

  // Disable chip dragging while running
  document.querySelectorAll('.cc-order-chip').forEach(c => {
    c.setAttribute('draggable', 'false');
    c.style.cursor = 'default';
  });

  // Also listen for in-page Ctrl+D / Ctrl+W as a fallback (when tab is focused)
  document.addEventListener('keydown', _ccInPageKeyHandler, true);

  _ccSaveSession();
  _ccUpdateCopyStatus();
  _ccHighlightCurrentCell();
  showToast('Copy mode started — Ctrl+D → next · Ctrl+R → back', 'success');
}

// ── Stop copy mode ────────────────────────────────────────────────────────────
function ccStopCopyMode() {
  _ccCopyActive = false;

  document.removeEventListener('keydown', _ccInPageKeyHandler, true);

  // Restore buttons
  const startBtn = document.getElementById('cc-copy-start-btn');
  const stopBtn = document.getElementById('cc-copy-stop-btn');
  const nextBtn = document.getElementById('cc-copy-next-btn');
  if (startBtn) startBtn.style.display = '';
  if (stopBtn) stopBtn.style.display = 'none';
  if (nextBtn) nextBtn.style.display = 'none';

  // Re-enable chip dragging
  document.querySelectorAll('.cc-order-chip').forEach(c => {
    c.setAttribute('draggable', 'true');
    c.style.cursor = '';
  });

  // Clear all cell highlights
  document.querySelectorAll('.cc-cell-active').forEach(el => {
    el.classList.remove('cc-cell-active');
  });

  const statusEl = document.getElementById('cc-copy-status');
  if (statusEl) statusEl.style.display = 'none';

  showToast('Copy mode stopped', 'info');
}

// ── In-page Ctrl+D / Ctrl+R fallback (fires when browser tab is focused) ────────
function _ccInPageKeyHandler(e) {
  if (e.ctrlKey && e.key === 'd') {
    e.preventDefault(); // stop Chrome from bookmarking the page
    e.stopPropagation();
    ccCopyNext();
  } else if (e.ctrlKey && e.key === 'r') {
    e.preventDefault(); // stop Chrome from reloading the page
    e.stopPropagation();
    ccCopyPrev();
  }
}

// ── Core: advance pointer, update UI, return the copied value ────────────────
// Returns the field value to write to clipboard, or:
//   null  = 'status' chip was processed (no clipboard write needed)
//   false = copy mode is off / done (caller should abort entirely)
function _ccAdvanceAndGetValue() {
  if (!_ccCopyActive) return false;

  const totalRows = _ccGeneratedRows.length;
  const totalFields = _ccCopyOrder.length;

  if (_ccCopyRowIdx >= totalRows) {
    _ccFinishCopyMode();
    return false;
  }

  const row = _ccGeneratedRows[_ccCopyRowIdx];
  const field = _ccCopyOrder[_ccCopyFieldIdx];

  // For the 'status' action chip: fire the API update, skip clipboard write
  const isStatusField = field === 'status';
  const value = isStatusField
    ? null
    : (row[field] !== null && row[field] !== undefined) ? String(row[field]) : '';

  if (isStatusField) {
    _ccMarkRowUsed(row);
  }

  // Advance pointer
  const prevRow = _ccCopyRowIdx;
  const prevField = _ccCopyFieldIdx;

  _ccCopyFieldIdx++;
  if (_ccCopyFieldIdx >= totalFields) {
    _ccCopyFieldIdx = 0;
    _ccCopyRowIdx++;
  }

  // Update UI
  _ccUpdateCopyStatus(prevRow, prevField, field, value, isStatusField);
  _ccHighlightCurrentCell();
  _ccSaveSession();

  // Trigger finish if all rows are done
  if (_ccCopyRowIdx >= totalRows) {
    _ccFinishCopyMode();
  }

  return value; // null for status chip, string for copy fields
}

/**
 * Fire-and-forget API call: mark the source queue row's status as "Used".
 * Saves the original status in _ccRowPrevStatuses so Ctrl+W can revert it.
 * Also updates the in-memory email_status so the revert knows the old value.
 *
 * @param {Object} genRow - a row from _ccGeneratedRows (must have _source_idx)
 */
async function _ccMarkRowUsed(genRow) {
  const sourceRow = _ccQueueRows[genRow._source_idx];
  if (!sourceRow || !sourceRow.id) return;

  // Save original status BEFORE overwriting so Ctrl+W can restore it
  if (!(_ccRowPrevStatuses[genRow._source_idx] !== undefined)) {
    _ccRowPrevStatuses[genRow._source_idx] = sourceRow.email_status ?? 'Unused';
  }

  // Optimistically update in-memory status
  sourceRow.email_status = 'Used';

  try {
    await api('PATCH', `/scraping/${sourceRow.id}/status`, { email_status: 'Used' });
    // Visual feedback: add a subtle badge to the table row
    const trEl = document.getElementById(`cc-row-${genRow.row_num - 1}`);
    if (trEl && !trEl.querySelector('.cc-used-badge')) {
      const badge = document.createElement('span');
      badge.className = 'cc-used-badge';
      badge.textContent = '✓ used';
      badge.title = 'Status automatically set to "Used" after all fields were copied';
      const firstTd = trEl.querySelector('td');
      if (firstTd) firstTd.appendChild(badge);
    }
  } catch (err) {
    // Revert in-memory status on failure
    sourceRow.email_status = _ccRowPrevStatuses[genRow._source_idx];
    showToast(
      `Row ${genRow.row_num}: could not mark as used — ${err.message}`,
      'warning'
    );
  }
}

/**
 * Fire-and-forget API call: revert the source queue row's status back to its
 * original value (called when Ctrl+W steps back across a row boundary).
 *
 * @param {Object} genRow - a row from _ccGeneratedRows (must have _source_idx)
 */
async function _ccUnmarkRowUsed(genRow) {
  const sourceRow = _ccQueueRows[genRow._source_idx];
  if (!sourceRow || !sourceRow.id) return;

  // If we never recorded a previous status, there's nothing to revert
  if (_ccRowPrevStatuses[genRow._source_idx] === undefined) return;

  const prevStatus = _ccRowPrevStatuses[genRow._source_idx];

  // Optimistically restore in-memory status
  sourceRow.email_status = prevStatus;
  // Remove the saved original — this row is no longer "completed"
  delete _ccRowPrevStatuses[genRow._source_idx];

  try {
    await api('PATCH', `/scraping/${sourceRow.id}/status`, { email_status: prevStatus });
    // Remove the "✓ used" badge from the table row
    const trEl = document.getElementById(`cc-row-${genRow.row_num - 1}`);
    if (trEl) {
      const badge = trEl.querySelector('.cc-used-badge');
      if (badge) badge.remove();
    }
    showToast(`Row ${genRow.row_num}: status reverted to "${prevStatus}"`, 'info');
  } catch (err) {
    // Revert our optimistic update if the API call failed
    sourceRow.email_status = 'Used';
    _ccRowPrevStatuses[genRow._source_idx] = prevStatus;
    showToast(
      `Row ${genRow.row_num}: could not revert status — ${err.message}`,
      'warning'
    );
  }
}

// ── Core: step pointer BACK one position, update UI, return the value ─────────
// Returns the field value to write to clipboard, or:
//   null  = landed on a 'status' chip (no clipboard write, status was reverted)
//   false = copy mode is off, or already at the first field
function _ccGoBackAndGetValue() {
  if (!_ccCopyActive) return false;

  const totalFields = _ccCopyOrder.length;

  // Already at the very start — nothing to go back to
  if (_ccCopyRowIdx === 0 && _ccCopyFieldIdx === 0) {
    showToast('Already at the first field — nothing to go back to', 'info');
    return false;
  }

  // If copy mode auto-finished (rowIdx === totalRows) rewind into the last cell
  if (_ccCopyRowIdx >= _ccGeneratedRows.length) {
    _ccCopyRowIdx = _ccGeneratedRows.length - 1;
    _ccCopyFieldIdx = totalFields - 1;
    // Re-activate copy mode visuals
    _ccCopyActive = true;
    const startBtn = document.getElementById('cc-copy-start-btn');
    const stopBtn = document.getElementById('cc-copy-stop-btn');
    const nextBtn = document.getElementById('cc-copy-next-btn');
    if (startBtn) startBtn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = '';
    if (nextBtn) nextBtn.style.display = '';
  } else {
    // Step backward one field
    _ccCopyFieldIdx--;
    if (_ccCopyFieldIdx < 0) {
      _ccCopyFieldIdx = totalFields - 1;
      _ccCopyRowIdx--;
    }
  }

  const row = _ccGeneratedRows[_ccCopyRowIdx];
  const field = _ccCopyOrder[_ccCopyFieldIdx];

  // If we landed on a 'status' chip, revert the status update that was applied here
  const isStatusField = field === 'status';
  if (isStatusField) {
    _ccUnmarkRowUsed(row);
  }

  const value = isStatusField
    ? null
    : (row[field] !== null && row[field] !== undefined) ? String(row[field]) : '';

  // Update UI
  _ccUpdateCopyStatus(_ccCopyRowIdx, _ccCopyFieldIdx, field, value, isStatusField);
  _ccHighlightCurrentCell();
  _ccSaveSession();

  return value; // null for status chip, string for copy fields
}

// ── In-page path: called by Ctrl+D when tab is focused OR by "Next →" button ──
// Writes to clipboard directly (tab is focused so clipboard API works).
// value === false  → copy mode off, do nothing
// value === null   → status chip was processed, skip clipboard write
// value === string → write to clipboard
function ccCopyNext() {
  const value = _ccAdvanceAndGetValue();
  if (value === false) return;  // mode off / done
  if (value === null) return;  // status chip — no clipboard write

  navigator.clipboard.writeText(value).catch(() => {
    // execCommand fallback for older browsers / permission edge cases
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (_) {
      showToast('Clipboard write failed — check browser permissions', 'error');
    }
  });
}

// ── In-page path: called by Ctrl+W when tab is focused (go back one step) ─────
// Writes the previous cell's value to clipboard directly.
function ccCopyPrev() {
  const value = _ccGoBackAndGetValue();
  if (value === false) return; // mode off
  if (value === null) return; // landed on status chip — no clipboard write

  navigator.clipboard.writeText(value).catch(() => {
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (_) {
      showToast('Clipboard write failed — check browser permissions', 'error');
    }
  });
}

// ── Update the status banner ──────────────────────────────────────────────────
// isStatusField: true when the just-processed chip was the 'status' action chip
function _ccUpdateCopyStatus(lastRow, lastField, lastFieldName, lastValue, isStatusField) {
  const statusEl = document.getElementById('cc-copy-status');
  if (!statusEl) return;

  statusEl.style.display = '';

  const totalRows = _ccGeneratedRows.length;

  if (lastRow === undefined) {
    // Initial state — just started
    const nextField = _ccCopyOrder[0];
    const isNextStatus = nextField === 'status';
    statusEl.innerHTML = `
      <span class="cc-copy-pos">Row ${_ccCopyRowIdx + 1} / ${totalRows}</span>
      <span class="cc-copy-field-indicator">
        Waiting for Ctrl+D → will ${isNextStatus ? 'update status' : 'copy'}
        <strong>${_CC_FIELD_LABELS[nextField] || nextField}</strong>
      </span>`;
    return;
  }

  if (_ccCopyRowIdx >= totalRows) {
    // Just finished
    statusEl.innerHTML = `<span class="cc-copy-done">🎉 All ${totalRows} rows done!</span>`;
    return;
  }

  const nextField = _ccCopyOrder[_ccCopyFieldIdx];
  const isNextStatus = nextField === 'status';

  if (isStatusField) {
    // Status chip was just processed — show a distinct confirmation
    statusEl.innerHTML = `
      <span class="cc-copy-used-badge">🏷 Status → Used</span>
      <span class="cc-copy-sep">→</span>
      <span class="cc-copy-pos">Row ${_ccCopyRowIdx + 1} / ${totalRows}</span>
      <span class="cc-copy-next-label">Next: <strong>${_CC_FIELD_LABELS[nextField] || nextField}</strong></span>`;
  } else {
    const preview = (lastValue ?? '').length > 60 ? lastValue.slice(0, 57) + '…' : (lastValue ?? '');
    statusEl.innerHTML = `
      <span class="cc-copy-copied-badge">✓ copied</span>
      <span class="cc-copy-preview" title="${esc(lastValue ?? '')}">${esc(preview)}</span>
      <span class="cc-copy-sep">→</span>
      <span class="cc-copy-pos">Row ${_ccCopyRowIdx + 1} / ${totalRows}</span>
      <span class="cc-copy-next-label">Next: ${isNextStatus ? '🏷 ' : ''}<strong>${_CC_FIELD_LABELS[nextField] || nextField}</strong></span>`;
  }
}

// ── Highlight the currently targeted cell in the table ───────────────────────
function _ccHighlightCurrentCell() {
  // Clear previous highlight
  document.querySelectorAll('.cc-cell-active').forEach(el => el.classList.remove('cc-cell-active'));

  if (!_ccCopyActive || _ccCopyRowIdx >= _ccGeneratedRows.length) return;

  const field = _ccCopyOrder[_ccCopyFieldIdx];
  const cellId = `cc-cell-${_ccCopyRowIdx}-${field}`;
  const cell = document.getElementById(cellId);
  if (cell) {
    cell.classList.add('cc-cell-active');
    // Scroll into view so the user can see where they are
    cell.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // Also highlight the matching chip
  document.querySelectorAll('.cc-order-chip').forEach((chip, i) => {
    chip.classList.toggle('cc-chip-active', i === _ccCopyFieldIdx);
  });
}

// ── All rows done ─────────────────────────────────────────────────────────────
function _ccFinishCopyMode() {
  _ccCopyActive = false;
  document.removeEventListener('keydown', _ccInPageKeyHandler, true);

  const startBtn = document.getElementById('cc-copy-start-btn');
  const stopBtn = document.getElementById('cc-copy-stop-btn');
  const nextBtn = document.getElementById('cc-copy-next-btn');
  if (startBtn) startBtn.style.display = '';
  if (stopBtn) stopBtn.style.display = 'none';
  if (nextBtn) nextBtn.style.display = 'none';

  document.querySelectorAll('.cc-cell-active').forEach(el => el.classList.remove('cc-cell-active'));
  document.querySelectorAll('.cc-chip-active').forEach(el => el.classList.remove('cc-chip-active'));
  document.querySelectorAll('.cc-order-chip').forEach(c => {
    c.setAttribute('draggable', 'true');
    c.style.cursor = '';
  });

  showToast(`🎉 All ${_ccGeneratedRows.length} rows copied!`, 'success');
}

// window export for direct in-page use / testing console
window.ccCopyNext = ccCopyNext;
window.ccCopyPrev = ccCopyPrev;
window.ccStartOver = ccStartOver;
