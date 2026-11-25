/* ═══════════════════════════════════════════════════════════════════════════
   DataBase — js/scraping-all.js
   Data Scraping — All Records panel
   Features: search, status filter, pagination, add, edit, delete, export, quick-status
   Depends on: core.js
═══════════════════════════════════════════════════════════════════════════ */


/**
 * renderEmail(r)
 * For Reserved records: only the admin and the user who reserved the email
 * (r.uploaded_by) can see it in plain text. Everyone else sees a blurred
 * placeholder to protect the reservation.
 */
function renderEmail(r) {
  const isAdmin    = currentUser?.role === 'admin';
  const isReserver = r.uploaded_by === currentUser?.id;

  if (r.email_status === 'Reserved' && !isAdmin && !isReserver) {
    return `<span style="
        filter: blur(4px);
        user-select: none;
        pointer-events: none;
        letter-spacing: 0.05em;
        color: var(--text-muted, #888);
      " title="Reserved — only visible to the person who reserved it">
      ••••@••••.•••
    </span>`;
  }

  return esc(r.email);
}

function debounceScrapingSearch() {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => { scrapingPage = 1; loadScraping(); }, 350);
}

// ── Advanced Filter Rules Engine (All Records) ────────────────────────────
let _allRuleCount = 0;
let _allFiltersOpen = false;

function toggleAllAdvFilters() {
  _allFiltersOpen = !_allFiltersOpen;
  const panel = document.getElementById('all-advanced-filters');
  const btn   = document.getElementById('btn-all-adv-filters');
  if (panel) panel.classList.toggle('hidden', !_allFiltersOpen);
  if (btn)   btn.classList.toggle('btn-active', _allFiltersOpen);
}

function addAllFilterRule() {
  const id = ++_allRuleCount;
  const container = document.getElementById('all-filter-rule-rows');
  const div = document.createElement('div');
  div.className = 'assignment-card';
  div.id = `all-rule-${id}`;
  div.innerHTML = `
    <div class="assign-card-header">
      <span class="rules-section-title" style="margin-bottom:0;font-size:0.78rem">Filter Rule #${id}</span>
      <button class="assign-remove-btn" onclick="removeAllFilterRule(${id})" title="Remove rule">✕ Remove</button>
    </div>
    <div class="assign-card-body">
      <div class="assign-logic-bar" style="margin-bottom:0.5rem;display:none;" id="all-logic-bar-${id}">
        <span class="rules-label">Match </span>
        <select class="form-select rules-input all-logic-sel" data-id="${id}" style="width:auto;display:inline-block;padding-top:0.2rem;padding-bottom:0.2rem;" onchange="applyAllFilterRules()">
          <option value="AND">ALL (AND)</option>
          <option value="OR">ANY (OR)</option>
        </select>
        <span class="rules-label"> of the following:</span>
      </div>
      <div class="all-conditions-list" id="all-conditions-${id}"></div>
      <button class="btn btn-ghost btn-sm" style="margin-top:0.5rem" onclick="addAllConditionRow(${id})">＋ Add Filter</button>
    </div>`;
  container.appendChild(div);
  addAllConditionRow(id);
}

function addAllConditionRow(ruleId) {
  const list = document.getElementById(`all-conditions-${ruleId}`);
  const div  = document.createElement('div');
  div.className = 'condition-row';
  div.style = 'display:flex;gap:0.5rem;align-items:center;margin-bottom:0.5rem;';
  div.innerHTML = `
    <select class="form-select rules-input cond-field" style="width:120px" onchange="applyAllFilterRules()">
      <option value="keyword">Keyword</option>
      <option value="website">Website</option>
      <option value="affiliation">Affiliation</option>
      <option value="date">Date</option>
      <option value="email_status">Status</option>
      <option value="email">Email</option>
      <option value="author_name">Author</option>
      <option value="article_title">Article Title</option>
      <option value="journal_name">Journal Name</option>
    </select>
    <select class="form-select rules-input cond-op" style="width:110px" onchange="applyAllFilterRules()">
      <option value="contains">contains</option>
      <option value="equals">equals</option>
      <option value="greater">greater than</option>
      <option value="less">less than</option>
    </select>
    <input type="text" class="form-input rules-input cond-val" style="flex:1" placeholder="value…" oninput="applyAllFilterRules()">
    <button class="assign-remove-btn" onclick="this.parentElement.remove(); _checkAllLogicToggle(${ruleId}); applyAllFilterRules()">✕</button>
  `;
  list.appendChild(div);
  _checkAllLogicToggle(ruleId);
}

function _checkAllLogicToggle(ruleId) {
  const list = document.getElementById(`all-conditions-${ruleId}`);
  const bar  = document.getElementById(`all-logic-bar-${ruleId}`);
  if (list && bar) bar.style.display = list.children.length > 1 ? 'block' : 'none';
}

function removeAllFilterRule(id) {
  const el = document.getElementById(`all-rule-${id}`);
  if (el) el.remove();
  applyAllFilterRules();
}

function clearAllFilterRules() {
  document.getElementById('all-filter-rule-rows').innerHTML = '';
  _allRuleCount = 0;
  // Remove client-side filter and re-render last data
  window._allActiveRules = null;
  const last = window._allLastData;
  if (last) renderScrapingAllTable(last);
}

function _buildAllRules() {
  const rules = [];
  document.querySelectorAll('#all-filter-rule-rows .assignment-card').forEach(card => {
    const id = card.id.replace('all-rule-', '');
    const logicSel = card.querySelector(`.all-logic-sel[data-id="${id}"]`);
    const logic = logicSel ? logicSel.value : 'AND';
    const conditions = [];
    const condList = document.getElementById(`all-conditions-${id}`);
    if (condList) {
      condList.querySelectorAll('.condition-row').forEach(row => {
        const field = row.querySelector('.cond-field').value;
        const op    = row.querySelector('.cond-op').value;
        const val   = row.querySelector('.cond-val').value.trim();
        if (val) conditions.push({ field, operator: op, value: val });
      });
    }
    if (conditions.length) rules.push({ logic, conditions });
  });
  return rules;
}

function _rowMatchesAllRules(row, rules) {
  if (!rules || !rules.length) return true;
  return rules.every(rule => {
    if (!rule.conditions.length) return true;
    const evaluate = cond => {
      const rowVal  = String(row[cond.field] || '').toLowerCase();
      const condVal = String(cond.value || '').toLowerCase();
      switch (cond.operator) {
        case 'contains': return rowVal.includes(condVal);
        case 'equals':   return rowVal === condVal;
        case 'greater':  return rowVal > condVal;
        case 'less':     return rowVal < condVal;
        default:         return false;
      }
    };
    return rule.logic === 'OR'
      ? rule.conditions.some(evaluate)
      : rule.conditions.every(evaluate);
  });
}

function applyAllFilterRules() {
  const rules = _buildAllRules();
  window._allActiveRules = rules.length ? rules : null;
  const last = window._allLastData;
  if (!last) return;
  if (!rules.length) {
    renderScrapingAllTable(last);
    return;
  }
  const filtered = { ...last, data: last.data.filter(r => _rowMatchesAllRules(r, rules)) };
  renderScrapingAllTable(filtered);
}

function clearAllFilters() {
  clearAllFilterRules();
}

async function loadScraping() {
  scrapingSearch = document.getElementById('scraping-search')?.value?.trim() || '';
  scrapingStatus = document.getElementById('scraping-status-filter')?.value || 'All';

  const params = new URLSearchParams({ page: scrapingPage, page_size: 25 });
  if (scrapingSearch) params.set('search', scrapingSearch);
  if (scrapingStatus !== 'All') params.set('status', scrapingStatus);

  const tbody = document.getElementById('scraping-all-tbody');
  if (tbody) tbody.innerHTML = emptyRow(10, 'Loading…');

  try {
    const data = await api('GET', `/scraping?${params}`);
    window._allLastData = data;
    // Re-apply active filter rules if any
    const rules = window._allActiveRules;
    if (rules && rules.length) {
      const filtered = { ...data, data: data.data.filter(r => _rowMatchesAllRules(r, rules)) };
      renderScrapingAllTable(filtered);
    } else {
      renderScrapingAllTable(data);
    }
  } catch (err) {
    if (tbody) tbody.innerHTML = emptyRow(10, `Error: ${err.message}`);
  }
}

function renderScrapingAllTable(data) {
  const tbody = document.getElementById('scraping-all-tbody');
  if (!tbody) return;
  const isAdmin = currentUser?.role === 'admin';

  if (!data.data.length) { tbody.innerHTML = emptyRow(10); return; }

  tbody.innerHTML = data.data.map(r => {
    const canEdit   = isAdmin;
    const canStatus = isAdmin || r.uploaded_by === currentUser?.id;
    const actions = `
      <div class="td-actions">
        ${canStatus && r.email_status !== 'Used' ? `
          <select class="form-select" style="width:110px;font-size:0.75rem;padding:0.3rem 0.5rem"
                  onchange="quickUpdateStatus(${r.id}, this.value, this)">
            <option value="Unused"   ${r.email_status==='Unused'   ? 'selected' : ''}>Unused</option>
            <option value="Reserved" ${r.email_status==='Reserved' ? 'selected' : ''}>Reserved</option>
            <option value="Used"     ${r.email_status==='Used'     ? 'selected' : ''}>Used</option>
          </select>` : ''}
        ${canEdit ? `<button class="btn btn-ghost btn-icon btn-sm" onclick="openEditScraping(${r.id})" title="Edit">✏️</button>` : ''}
        ${isAdmin ? `<button class="btn btn-danger btn-icon btn-sm" onclick="confirmDeleteScraping(${r.id})" title="Delete">🗑️</button>` : ''}
      </div>`;
    return `
      <tr>
        <td style="white-space:nowrap">${esc(r.date) || '—'}</td>
        <td class="td-truncate" style="max-width:120px">${esc(r.author_name)}</td>
        <td class="td-truncate" style="max-width:180px" title="${esc(r.article_title)}">${esc(r.article_title)}</td>
        <td class="td-truncate" style="max-width:180px" title="${esc(r.journal_name)}">${esc(r.journal_name)}</td>
        <td class="td-truncate" style="max-width:160px">${renderEmail(r)}</td>
        <td>${scrapingBadge(r.email_status)}</td>
        <td class="td-truncate" style="max-width:100px">${esc(r.keyword)}</td>
        <td class="td-truncate" style="max-width:120px">${esc(r.website)}</td>
        <td class="td-truncate" style="max-width:110px">${esc(r.affiliation) || '—'}</td>
        <td>${esc(r.uploaded_by_username || '—')}</td>
        <td>${actions}</td>
      </tr>`;
  }).join('');

  renderPagination('scraping-all-controls', 'scraping-all-info',
    data.page, data.pages, data.total, p => { scrapingPage = p; loadScraping(); });
}

async function quickUpdateStatus(id, status, selectEl) {
  try {
    await api('PATCH', `/scraping/${id}/status`, { email_status: status });
    showToast(`Status updated to "${status}"`, 'success');
    loadScraping();
    if (currentUser?.role !== 'admin') loadMineCollection();
  } catch (err) {
    showToast(err.message, 'error');
    if (selectEl) selectEl.value = selectEl.dataset.prev || 'Unused';
  }
}

async function handleAddScraping(e) {
  e.preventDefault();
  const errEl = document.getElementById('add-scraping-error');
  errEl.style.display = 'none';
  setLoading('btn-add-scraping', true);
  try {
    await api('POST', '/scraping', {
      date:          document.getElementById('sc-date').value,
      website:       document.getElementById('sc-website').value.trim() || 'N/A',
      keyword:       document.getElementById('sc-keyword').value.trim() || 'N/A',
      article_title: document.getElementById('sc-title').value.trim(),
      journal_name:  document.getElementById('sc-journal').value.trim(),
      author_name:   document.getElementById('sc-author').value.trim(),
      email:         document.getElementById('sc-email').value.trim(),
      affiliation:   document.getElementById('sc-affiliation').value.trim() || null,
    });
    closeModal('add-scraping-modal');
    document.querySelector('#add-scraping-modal form').reset();
    showToast('Record added successfully!', 'success');
    loadScraping();
  } catch (err) {
    errEl.textContent   = err.message;
    errEl.style.display = 'block';
  } finally {
    setLoading('btn-add-scraping', false);
  }
}

async function openEditScraping(id) {
  try {
    const allData = await api('GET', `/scraping?page=1&page_size=1000`);
    const r = allData.data.find(x => x.id === id);
    if (!r) { showToast('Record not found', 'error'); return; }
    document.getElementById('edit-sc-id').value          = r.id;
    document.getElementById('edit-sc-date').value        = r.date || '';
    document.getElementById('edit-sc-website').value     = r.website || '';
    document.getElementById('edit-sc-keyword').value     = r.keyword || '';
    document.getElementById('edit-sc-email').value       = r.email || '';
    document.getElementById('edit-sc-title').value       = r.article_title || '';
    document.getElementById('edit-sc-journal').value     = r.journal_name || '';
    document.getElementById('edit-sc-author').value      = r.author_name || '';
    document.getElementById('edit-sc-affiliation').value = r.affiliation || '';
    document.getElementById('edit-sc-status').value      = r.email_status || 'Unused';
    showModal('edit-scraping-modal');
  } catch (err) { showToast(err.message, 'error'); }
}

async function handleEditScraping(e) {
  e.preventDefault();
  const id    = document.getElementById('edit-sc-id').value;
  const errEl = document.getElementById('edit-scraping-error');
  errEl.style.display = 'none';
  setLoading('btn-save-scraping', true);
  try {
    await api('PUT', `/scraping/${id}`, {
      date:          document.getElementById('edit-sc-date').value        || undefined,
      website:       document.getElementById('edit-sc-website').value.trim()     || undefined,
      keyword:       document.getElementById('edit-sc-keyword').value.trim()     || undefined,
      email:         document.getElementById('edit-sc-email').value.trim()       || undefined,
      article_title: document.getElementById('edit-sc-title').value.trim()       || undefined,
      journal_name:  document.getElementById('edit-sc-journal').value.trim()     || undefined,
      author_name:   document.getElementById('edit-sc-author').value.trim()      || undefined,
      affiliation:   document.getElementById('edit-sc-affiliation').value.trim() || undefined,
      email_status:  document.getElementById('edit-sc-status').value             || undefined,
    });
    closeModal('edit-scraping-modal');
    showToast('Record updated!', 'success');
    loadScraping();
  } catch (err) {
    errEl.textContent   = err.message;
    errEl.style.display = 'block';
  } finally {
    setLoading('btn-save-scraping', false);
  }
}

function confirmDeleteScraping(id) {
  document.getElementById('confirm-delete-msg').textContent = `Delete scraping record #${id}? This cannot be undone.`;
  document.getElementById('btn-confirm-delete').onclick = () => deleteScraping(id);
  showModal('confirm-delete-modal');
}

async function deleteScraping(id) {
  closeModal('confirm-delete-modal');
  try {
    await api('DELETE', `/scraping/${id}`);
    showToast('Record deleted.', 'success');
    loadScraping();
    loadDashboard();
  } catch (err) { showToast(err.message, 'error'); }
}

async function exportScrapingCSV() {
  window.location = '/scraping/export';
}
