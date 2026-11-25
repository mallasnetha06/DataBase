/* ═══════════════════════════════════════════════════════════════════════════
   DataBase — js/scraping-analysis.js
   Step 1 — Analysis:
     parse file client-side → POST /scraping/analyse
     → render rich report (new / updatable / duplicate / blocked / invalid)
     → filter bar: category chips + text search + result dropdown
     → select-all / uncheck-all / bulk delete for filtered rows
     → expandable history card for updatable rows
     → ✕ remove-from-upload for blocked rows
   Depends on: core.js, scraping-upload.js (shared state: _parsedRows,
               _analysisResults, _goToStep, _updateStepNav)
═══════════════════════════════════════════════════════════════════════════ */

/* ── Analysis filter state ───────────────────────────────────────────────── */
let _anFilterCat    = 'all';   // 'all' | 'new' | 'updatable' | 'duplicate' | 'blocked' | 'invalid'
let _anFilterSearch = '';      // free-text search across email / author / journal / keyword
let _anFilterResult = 'all';   // result-based dropdown filter

/* ── Selection state ─────────────────────────────────────────────────────── */
let _anSelectedRows = new Set(); // Set of original indices that are checked

/* ═══════════════════════════════════════════════════════════════════════════
   STEP 1 — ANALYSIS
═══════════════════════════════════════════════════════════════════════════ */

async function runAnalysis() {
  const panel = document.getElementById('upload-step-1');
  panel.classList.remove('hidden');
  _updateStepNav(1);

  // Reset filters each time a new file is analysed
  _anFilterCat    = 'all';
  _anFilterSearch = '';
  _anFilterResult = 'all';
  _anSelectedRows = new Set();

  const body = document.getElementById('analysis-body');
  body.innerHTML = `<div class="analysis-loading">
    <div class="analysis-spinner"></div>
    <span>Checking ${_parsedRows.length} rows against database…</span>
  </div>`;

  try {
    const payload = _parsedRows.map(r => ({
      email:         r.email,
      journal_name:  r.journal_name,
      keyword:       r.keyword,
      article_title: r.article_title,
      author_name:   r.author_name,
    }));
    const data = await api('POST', '/scraping/analyse', { rows: payload });
    _analysisResults = data.results;
    renderAnalysisReport();
  } catch (err) {
    body.innerHTML = `<div class="analysis-error">❌ Analysis failed: ${esc(err.message)}</div>`;
  }
}

/* ── Filter helpers ──────────────────────────────────────────────────────── */
function _anRowMatchesFilters(r, idx) {
  // Category chip filter
  if (_anFilterCat !== 'all' && r.category !== _anFilterCat) return false;
  // Result dropdown filter (stacks on top of chip)
  if (_anFilterResult !== 'all' && r.category !== _anFilterResult) return false;
  // Free-text search
  if (_anFilterSearch) {
    const q   = _anFilterSearch.toLowerCase();
    const row = _parsedRows[idx] || {};
    const haystack = [
      r.email || '',
      row.author_name   || '',
      row.journal_name  || '',
      row.keyword       || '',
      r.reason          || '',
    ].join(' ').toLowerCase();
    if (!haystack.includes(q)) return false;
  }

  // Shared Data Filters
  const filters = buildRulesFromUI().preview_filters;
  if (!rowMatchesFilter(_parsedRows[idx] || {}, filters)) return false;

  return true;
}

/* ── Result dropdown filter ──────────────────────────────────────────────── */
function onAnResultFilterChange(val) {
  _anFilterResult = val;
  _anSelectedRows = new Set(); // clear selection when filter changes
  _renderAnTableBody();
  _syncSelectAllCheckbox();
}

/* ── Set category chip ───────────────────────────────────────────────────── */
function setAnFilterCat(cat) {
  _anFilterCat = cat;
  _anSelectedRows = new Set(); // clear selection on chip change
  _renderAnFilterBar();
  _renderAnTableBody();
  _syncSelectAllCheckbox();
}

/* ── Typing in the search box ────────────────────────────────────────────── */
function onAnSearchInput(val) {
  _anFilterSearch = val.trim();
  _anSelectedRows = new Set(); // clear selection on search change
  _renderAnTableBody();
  _syncSelectAllCheckbox();
}

/* ── Selection helpers ───────────────────────────────────────────────────── */
function _anGetVisibleIndices() {
  const visible = [];
  _analysisResults.forEach((r, idx) => {
    if (_anRowMatchesFilters(r, idx)) visible.push(idx);
  });
  return visible;
}

function toggleAnRow(idx) {
  if (_anSelectedRows.has(idx)) {
    _anSelectedRows.delete(idx);
  } else {
    _anSelectedRows.add(idx);
  }
  _updateAnRowCheckbox(idx);
  _syncSelectAllCheckbox();
  _syncBulkToolbar();
}

function _updateAnRowCheckbox(idx) {
  const cb = document.getElementById(`an-chk-${idx}`);
  if (cb) cb.checked = _anSelectedRows.has(idx);
  const row = document.getElementById(`an-row-${idx}`);
  if (row) row.classList.toggle('an-row-selected', _anSelectedRows.has(idx));
}

function selectAllVisible() {
  const visible = _anGetVisibleIndices();
  visible.forEach(idx => _anSelectedRows.add(idx));
  _renderAnTableBody();
  _syncSelectAllCheckbox();
  _syncBulkToolbar();
}

function uncheckAll() {
  _anSelectedRows = new Set();
  _renderAnTableBody();
  _syncSelectAllCheckbox();
  _syncBulkToolbar();
}

function onSelectAllChange(checked) {
  if (checked) { selectAllVisible(); }
  else         { uncheckAll(); }
}

function _syncSelectAllCheckbox() {
  const cb = document.getElementById('an-select-all');
  if (!cb) return;
  const visible = _anGetVisibleIndices();
  if (visible.length === 0) {
    cb.checked       = false;
    cb.indeterminate = false;
    return;
  }
  const selCount = visible.filter(i => _anSelectedRows.has(i)).length;
  cb.indeterminate = selCount > 0 && selCount < visible.length;
  cb.checked       = selCount === visible.length;
}

function _syncBulkToolbar() {
  const bar = document.getElementById('an-bulk-toolbar');
  if (!bar) return;
  const n = _anSelectedRows.size;
  bar.classList.toggle('hidden', n === 0);
  const label = bar.querySelector('.an-bulk-count');
  if (label) label.textContent = `${n} row${n !== 1 ? 's' : ''} selected`;
}

/* ── Bulk delete selected rows ───────────────────────────────────────────── */
function deleteSelectedRows() {
  if (_anSelectedRows.size === 0) return;
  const toRemove = Array.from(_anSelectedRows).sort((a, b) => b - a); // descending so splice indices stay valid
  toRemove.forEach(idx => {
    _parsedRows.splice(idx, 1);
    _analysisResults.splice(idx, 1);
  });
  _anSelectedRows = new Set();
  renderAnalysisReport();
  showToast(`${toRemove.length} row${toRemove.length !== 1 ? 's' : ''} removed from this upload batch.`, 'success');
}

/* ── Re-render only the chip bar (fast) ─────────────────────────────────── */
function _renderAnFilterBar() {
  const results = _analysisResults;
  const counts  = { new: 0, updatable: 0, duplicate: 0, blocked: 0, invalid: 0 };
  results.forEach(r => { counts[r.category] = (counts[r.category] || 0) + 1; });

  const CATS = [
    { key: 'all',       label: 'All',       emoji: '📋', cls: '' },
    { key: 'new',       label: 'New',       emoji: '🟢', cls: 'an-chip-new' },
    { key: 'updatable', label: 'Updatable', emoji: '🔵', cls: 'an-chip-updatable' },
    { key: 'duplicate', label: 'Duplicate', emoji: '🟡', cls: 'an-chip-duplicate' },
    { key: 'blocked',   label: 'Blocked',   emoji: '🔴', cls: 'an-chip-blocked' },
    { key: 'invalid',   label: 'Invalid',   emoji: '⚫', cls: 'an-chip-invalid' },
  ];

  const allCount = results.length;
  const el = document.getElementById('an-filter-bar');
  if (!el) return;

  el.innerHTML = CATS.map(c => {
    const n      = c.key === 'all' ? allCount : (counts[c.key] || 0);
    const active = _anFilterCat === c.key ? ' an-chip-active' : '';
    return `<button class="an-chip ${c.cls}${active}" onclick="setAnFilterCat('${c.key}')">${c.emoji} ${c.label} <span class="an-chip-count">${n}</span></button>`;
  }).join('');
}

/* ── Re-render only the table tbody (fast) ───────────────────────────────── */
function _renderAnTableBody() {
  const results = _analysisResults;
  let rowsHTML  = '';
  let shown     = 0;

  results.forEach((r, idx) => {
    if (!_anRowMatchesFilters(r, idx)) return;
    shown++;

    const cat       = r.category;
    const catCls    = `an-row-${cat}`;
    const badge     = _categoryBadge(cat);
    const line      = (_parsedRows[idx] && _parsedRows[idx]._line) ? _parsedRows[idx]._line : idx + 2;
    const email     = esc(r.email);
    const author    = esc(trunc((_parsedRows[idx] && _parsedRows[idx].author_name) || '', 28));
    const journal   = esc(trunc((_parsedRows[idx] && _parsedRows[idx].journal_name) || '', 24));
    const kw        = esc(trunc((_parsedRows[idx] && _parsedRows[idx].keyword) || '', 20));
    const isChecked = _anSelectedRows.has(idx) ? 'checked' : '';
    const selCls    = _anSelectedRows.has(idx) ? ' an-row-selected' : '';

    const removeBtn = (cat === 'blocked')
      ? `<button class="an-remove-btn" onclick="event.stopPropagation(); removeRowFromUpload(${idx})" title="Remove from upload (does not delete from DB)">✕ Remove</button>`
      : '';

    const expandable = ['updatable','duplicate','blocked'].includes(cat);
    const expandIcon = expandable ? `<span class="an-expand-icon" id="an-exp-icon-${idx}">▸</span>` : '';

    rowsHTML += `
      <tr class="an-row ${catCls}${selCls} ${expandable ? 'an-row-expandable' : ''}"
          ${expandable ? `onclick="toggleAnalysisExpand(${idx})"` : ''} id="an-row-${idx}">
        <td class="an-td-chk" onclick="event.stopPropagation()">
          <input type="checkbox" class="an-row-chk" id="an-chk-${idx}" ${isChecked}
                 onchange="toggleAnRow(${idx})">
        </td>
        <td class="an-td-num">${line}</td>
        <td class="an-td-email" title="${email}">${email}</td>
        <td class="an-td-text" title="${esc((_parsedRows[idx]||{}).author_name||'')}">${author}</td>
        <td class="an-td-text">${journal}</td>
        <td class="an-td-kw">${kw}</td>
        <td class="an-td-result">${badge} ${expandIcon}</td>
        <td class="an-td-reason">${esc(r.reason || '')} ${removeBtn}</td>
      </tr>
      <tr class="an-expand-row hidden" id="an-expand-${idx}">
        <td colspan="8" class="an-expand-td">${_buildExpandCard(r, idx)}</td>
      </tr>`;
  });

  const tbody = document.getElementById('an-tbody');
  if (tbody) tbody.innerHTML = rowsHTML;

  // Keep the result-filter dropdown in sync
  const rfSel = document.getElementById('an-result-filter-sel');
  if (rfSel && rfSel.value !== _anFilterResult) rfSel.value = _anFilterResult;

  const footer = document.getElementById('an-table-footer');
  if (footer) {
    footer.textContent = shown < results.length
      ? `Showing ${shown} of ${results.length} rows matching filter`
      : `${results.length} rows total`;
  }

  _syncSelectAllCheckbox();
  _syncBulkToolbar();
}

/* ── Full report render (called once after API returns) ──────────────────── */
function renderAnalysisReport() {
  const results  = _analysisResults;
  const counts   = { new: 0, updatable: 0, duplicate: 0, blocked: 0, invalid: 0 };
  results.forEach(r => { counts[r.category] = (counts[r.category] || 0) + 1; });
  const uploadable = counts.new + counts.updatable;

  // Proceed / warning block
  const proceedHTML = uploadable > 0
    ? `<div style="display:flex;gap:0.75rem;flex-wrap:wrap;align-items:center;margin-top:1rem">
         <button class="btn btn-primary" id="btn-proceed-upload" onclick="proceedToStep2()">
           Proceed to Upload →  <span style="font-size:0.8rem;opacity:0.75">(${uploadable} uploadable rows)</span>
         </button>
         <button class="btn btn-ghost" onclick="downloadBatchExcel()" title="Download current batch rows as Excel (excludes deleted rows)">
           ⬇️ Download Batch Excel <span style="font-size:0.8rem;opacity:0.75">(${results.length} rows)</span>
         </button>
       </div>`
    : `<div class="an-no-rows-warn" style="margin-top:1rem">
         ⚠️ Nothing to upload — all rows are duplicate, blocked, or invalid.
       </div>
       <button class="btn btn-ghost" onclick="downloadBatchExcel()" style="margin-top:0.75rem" title="Download current batch rows as Excel">
         ⬇️ Download Batch Excel
       </button>`;

  document.getElementById('analysis-body').innerHTML = `
    <!-- ── Summary badges ── -->
    <div class="analysis-summary-bar">
      ${counts.new       ? `<span class="an-badge an-new">🟢 New: ${counts.new}</span>`             : ''}
      ${counts.updatable ? `<span class="an-badge an-updatable">🔵 Updatable: ${counts.updatable}</span>` : ''}
      ${counts.duplicate ? `<span class="an-badge an-duplicate">🟡 Duplicate: ${counts.duplicate}</span>` : ''}
      ${counts.blocked   ? `<span class="an-badge an-blocked">🔴 Blocked: ${counts.blocked}</span>`   : ''}
      ${counts.invalid   ? `<span class="an-badge an-invalid">⚫ Invalid: ${counts.invalid}</span>`   : ''}
      <span class="an-total-note">${results.length} rows in file</span>
    </div>

    <!-- ── Filter bar ── -->
    <div class="an-filter-wrap">
      <div id="an-filter-bar" class="an-chip-bar"><!-- chips injected by _renderAnFilterBar --></div>
      <div class="an-search-wrap">
        <span class="an-search-icon">🔍</span>
        <input
          id="an-search-input"
          class="an-search-input"
          type="text"
          placeholder="Search email, author, journal, keyword…"
          oninput="onAnSearchInput(this.value)"
          value="${esc(_anFilterSearch)}"
        >
        <select
          id="an-result-filter-sel"
          class="an-result-filter-sel"
          title="Filter by result"
          onchange="onAnResultFilterChange(this.value)"
        >
          <option value="all">All Results</option>
          <option value="new">🟢 New</option>
          <option value="updatable">🔵 Updatable</option>
          <option value="duplicate">🟡 Duplicate</option>
          <option value="blocked">🔴 Blocked</option>
          <option value="invalid">⚫ Invalid</option>
        </select>
      </div>
    </div>

    <!-- ── Bulk action toolbar (shown only when rows are selected) ── -->
    <div id="an-bulk-toolbar" class="an-bulk-toolbar hidden">
      <span class="an-bulk-count">0 rows selected</span>
      <button class="an-bulk-btn an-bulk-uncheck" onclick="uncheckAll()" title="Deselect all">✗ Uncheck All</button>
      <button class="an-bulk-btn an-bulk-delete" onclick="deleteSelectedRows()" title="Remove selected rows from upload batch">🗑 Delete Selected</button>
    </div>

    <!-- ── Analysis table ── -->
    <div class="an-table-wrap">
      <table class="an-table">
        <thead>
          <tr>
            <th class="an-th-chk">
              <input type="checkbox" id="an-select-all" title="Select / deselect all visible rows"
                     onchange="onSelectAllChange(this.checked)">
            </th>
            <th class="an-th-num">#</th>
            <th class="an-th-email">Email</th>
            <th class="an-th-text">Author</th>
            <th class="an-th-text">Journal</th>
            <th class="an-th-kw">Keyword</th>
            <th class="an-th-result">Result</th>
            <th class="an-th-detail">Detail</th>
          </tr>
        </thead>
        <tbody id="an-tbody"></tbody>
      </table>
    </div>
    <div id="an-table-footer" class="an-table-footer"></div>

    ${proceedHTML}
  `;

  _renderAnFilterBar();
  _renderAnTableBody();
}

function _categoryBadge(cat) {
  const map = {
    new:       '<span class="an-badge an-new an-badge-sm">🟢 New</span>',
    updatable: '<span class="an-badge an-updatable an-badge-sm">🔵 Updatable</span>',
    duplicate: '<span class="an-badge an-duplicate an-badge-sm">🟡 Duplicate</span>',
    blocked:   '<span class="an-badge an-blocked an-badge-sm">🔴 Blocked</span>',
    invalid:   '<span class="an-badge an-invalid an-badge-sm">⚫ Invalid</span>',
  };
  return map[cat] || cat;
}

function _buildExpandCard(r, idx) {
  if (r.category === 'invalid' || r.category === 'new') return '';

  if (r.category === 'blocked') {
    return `<div class="an-card">
      <div class="an-card-row">
        <span class="an-card-label">📧 Mail Activity</span>
      </div>
      <div class="an-card-section">
        <div class="an-card-item">
          <span class="an-card-k">Total times emailed:</span>
          <span class="an-card-v">${r.mail_count_total ?? '—'}</span>
        </div>
        <div class="an-card-item">
          <span class="an-card-k">This month:</span>
          <span class="an-card-v an-blocked-text">${r.mail_count_month} / 3 — limit reached</span>
        </div>
        ${r.last_used_at ? `<div class="an-card-item">
          <span class="an-card-k">Last used:</span>
          <span class="an-card-v">${esc(r.last_used_at)}</span>
        </div>` : ''}
      </div>
      <div class="an-card-note">This row will be skipped on upload. Use ✕ Remove to exclude it from this batch.</div>
    </div>`;
  }

  // Updatable or Duplicate
  const sendHistory = (r.used_at_history || []).map(ts => ts.slice(0,10)).join(' · ') || '—';

  // Journals & keywords
  const existingJ = (r.existing_journals || []).join(', ') || '—';
  const existingK = (r.existing_keywords || []).join(', ') || '—';
  const addingJ   = r.journal_is_new && r.incoming_journal ? `<span class="an-adding-tag">＋ ${esc(r.incoming_journal)}</span>` : '';
  const addingK   = r.keyword_is_new && r.incoming_keyword ? `<span class="an-adding-tag">＋ ${esc(r.incoming_keyword)}</span>` : '';

  // Invoice table
  let invoiceHTML = '<div class="an-card-item"><span class="an-card-k">No invoices on record.</span></div>';
  if (r.invoices_history && r.invoices_history.length > 0) {
    const rows = r.invoices_history.map(inv => {
      const approvedCell = inv.journal_approved
        ? `<span class="an-inv-approved">✅ ${esc(inv.approval_date || '—')}</span>`
        : `<span class="an-inv-pending">⏳ —</span>`;
      const statusCls = {
        Paid: 'an-inv-paid', Approved: 'an-inv-approved-st',
        Pending: 'an-inv-pending-st', Rejected: 'an-inv-rejected'
      }[inv.invoice_status] || '';
      return `<tr>
        <td class="an-inv-no">${inv.invoice_no ?? '—'}</td>
        <td>${esc(trunc(inv.journal_name || '', 20))}</td>
        <td>${inv.brand ? esc(trunc(inv.brand, 14)) : '<span class="an-muted">—</span>'}</td>
        <td class="an-inv-amount">${inv.amount != null ? '$' + Number(inv.amount).toFixed(2) : '—'}</td>
        <td><span class="an-inv-status ${statusCls}">${esc(inv.invoice_status || '—')}</span></td>
        <td>${approvedCell}</td>
        <td class="an-muted">${esc(inv.invoice_date || '—')}</td>
      </tr>`;
    }).join('');
    invoiceHTML = `
      <div class="an-inv-table-wrap">
        <table class="an-inv-table">
          <thead><tr>
            <th>#</th><th>Journal</th><th>Brand</th><th>Amount</th>
            <th>Status</th><th>Approved?</th><th>Date</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  return `<div class="an-card">
    <div class="an-card-row">
      <div class="an-card-section">
        <div class="an-card-label">📧 Mail Activity</div>
        <div class="an-card-item">
          <span class="an-card-k">Total times emailed:</span>
          <span class="an-card-v">${r.mail_count_total ?? '—'}</span>
        </div>
        <div class="an-card-item">
          <span class="an-card-k">This month:</span>
          <span class="an-card-v">${r.mail_count_month} / 3</span>
        </div>
        ${r.last_used_at ? `<div class="an-card-item">
          <span class="an-card-k">Last used:</span>
          <span class="an-card-v">${esc(r.last_used_at)}</span>
        </div>` : ''}
        <div class="an-card-item">
          <span class="an-card-k">Send history:</span>
          <span class="an-card-v an-history-dates">${sendHistory}</span>
        </div>
      </div>

      <div class="an-card-section">
        <div class="an-card-label">📚 Journal / Keyword History</div>
        <div class="an-card-item">
          <span class="an-card-k">Existing journals:</span>
          <span class="an-card-v">${esc(existingJ)}</span>
        </div>
        ${addingJ ? `<div class="an-card-item">
          <span class="an-card-k">Adding journal:</span>
          <span class="an-card-v">${addingJ}</span>
        </div>` : ''}
        <div class="an-card-item">
          <span class="an-card-k">Existing keywords:</span>
          <span class="an-card-v">${esc(existingK)}</span>
        </div>
        ${addingK ? `<div class="an-card-item">
          <span class="an-card-k">Adding keyword:</span>
          <span class="an-card-v">${addingK}</span>
        </div>` : ''}
      </div>

      <div class="an-card-section">
        <div class="an-card-label">🗂️ Record Info</div>
        ${r.email_status ? `<div class="an-card-item"><span class="an-card-k">Current status:</span><span class="an-card-v">${esc(r.email_status)}</span></div>` : ''}
        ${r.brand        ? `<div class="an-card-item"><span class="an-card-k">Brand:</span><span class="an-card-v">${esc(r.brand)}</span></div>` : ''}
        ${r.affiliation  ? `<div class="an-card-item"><span class="an-card-k">Affiliation:</span><span class="an-card-v">${esc(r.affiliation)}</span></div>` : ''}
        ${r.created_at   ? `<div class="an-card-item"><span class="an-card-k">Record created:</span><span class="an-card-v">${esc(r.created_at)}</span></div>` : ''}
        ${r.record_id    ? `<div class="an-card-item"><span class="an-card-k">Record ID:</span><span class="an-card-v">#${r.record_id}</span></div>` : ''}
      </div>
    </div>

    <div class="an-card-label" style="margin-top:0.75rem;margin-bottom:0.4rem">
      💰 Invoice History
      <span class="an-card-hint">(${(r.invoices_history||[]).length} invoice${(r.invoices_history||[]).length !== 1 ? 's' : ''})</span>
    </div>
    ${invoiceHTML}
  </div>`;
}

function toggleAnalysisExpand(idx) {
  const row  = document.getElementById(`an-expand-${idx}`);
  const icon = document.getElementById(`an-exp-icon-${idx}`);
  if (!row) return;
  const open = !row.classList.contains('hidden');
  row.classList.toggle('hidden', open);
  if (icon) icon.textContent = open ? '▸' : '▾';
}

function removeRowFromUpload(idx) {
  // Remove from state arrays
  _parsedRows.splice(idx, 1);
  _analysisResults.splice(idx, 1);
  _anSelectedRows.delete(idx);
  // Re-render
  renderAnalysisReport();
  showToast('Row removed from this upload batch (not deleted from DB).', 'success');
}

function proceedToStep2() {
  const uploadable = _analysisResults.filter(r => r.category === 'new' || r.category === 'updatable');
  if (uploadable.length === 0) {
    showToast('Nothing to upload — all rows are duplicate, blocked, or invalid.', 'warning');
    return;
  }
  _goToStep(2);
  document.getElementById('status-rules-panel').classList.remove('hidden');
  document.getElementById('btn-upload-scraping').classList.remove('hidden');
  refreshUploadPreview();
}
