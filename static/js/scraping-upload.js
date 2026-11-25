/* ═══════════════════════════════════════════════════════════════════════════
   DataBase — js/scraping-upload.js
   Two-Step Smart Batch Upload:
     Step 1 — Analysis: parse file client-side → POST /scraping/analyse
              → render rich report (new / updatable / duplicate / blocked / invalid)
              → expandable history card for updatable rows
              → ✕ remove-from-upload for blocked rows
     Step 2 — Upload:  status assignment rules engine → live preview → commit
   Depends on: core.js, SheetJS (CDN)
═══════════════════════════════════════════════════════════════════════════ */

/* ── State ──────────────────────────────────────────────────────────────── */
let _scrapingFile    = null;   // raw File object
let _parsedRows      = [];     // array of normalised row objects from the file
let _analysisResults = [];     // per-row result objects from /analyse
let _currentStep     = 1;      // 1 = analysis, 2 = upload
let _assignRowCount  = 0;      // counter for unique assignment-row IDs
let _rulesOpen       = true;   // collapsible state

// Allowed websites list (loaded dynamically from API)
let _allowedWebsites = [];

async function addAllowedWebsite() {
  const input = document.getElementById('new-website-input');
  if (!input) return;
  const val = input.value.trim().toLowerCase();
  if (!val) return;
  if (_allowedWebsites.includes(val)) {
    showToast('This website is already in the allowed list.', 'warning');
    return;
  }
  
  try {
    const data = await api('POST', '/scraping/allowed_websites', { name: val });
    _allowedWebsites.push(data.name);
    input.value = '';
    
    // Update the UI
    const container = document.getElementById('allowed-websites-container');
    if (container) {
      const span = document.createElement('span');
      span.style = 'background:var(--bg-elevated);border:1px solid var(--border);padding:0.2rem 0.5rem;border-radius:4px;font-family:monospace;font-size:0.8rem;color:var(--text-primary)';
      span.textContent = data.name;
      container.appendChild(span);
    }
    showToast(`Added '${data.name}' to allowed websites.`, 'success');
  } catch (err) {
    showToast('Could not add website: ' + err.message, 'error');
  }
}

async function loadAllowedWebsites() {
  try {
    const list = await api('GET', '/scraping/allowed_websites');
    _allowedWebsites = list;
    const container = document.getElementById('allowed-websites-container');
    if (container) {
      container.innerHTML = '';
      _allowedWebsites.forEach(site => {
        const span = document.createElement('span');
        span.style = 'background:var(--bg-elevated);border:1px solid var(--border);padding:0.2rem 0.5rem;border-radius:4px;font-family:monospace;font-size:0.8rem;color:var(--text-primary)';
        span.textContent = site;
        container.appendChild(span);
      });
    }
  } catch (err) {
    console.error('Failed to load allowed websites:', err);
  }
}

/* ── Column alias map (mirrors backend) ─────────────────────────────────── */
const COL_ALIASES = {
  article_title: ['article_title','article title','articletitle','title'],
  journal_name:  ['journal_name','journal name','journalname','journal'],
  author_name:   ['author_name','author name','authorname','authors','author'],
  email:         ['email'],
  website:       ['website','site','source url','source'],
  keyword:       ['keyword','keywords','key word'],
  date:          ['date'],
  affiliation:   ['affiliation','organization','organisation','org'],
};

function _getCol(rowObj, field) {
  for (const alias of (COL_ALIASES[field] || [field])) {
    if (rowObj[alias] !== undefined) return rowObj[alias];
  }
  return '';
}

/* ── Drag / Drop / File selection ───────────────────────────────────────── */
function handleDragOver(e) {
  e.preventDefault();
  document.getElementById('upload-zone').classList.add('dragover');
}

function handleDragLeave() {
  document.getElementById('upload-zone').classList.remove('dragover');
}

function handleDrop(e) {
  e.preventDefault();
  document.getElementById('upload-zone').classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) setScrapingFile(file);
}

function handleScrapingFileSelect(e) {
  const file = e.target.files[0];
  if (file) setScrapingFile(file);
}

async function setScrapingFile(file) {
  _scrapingFile = file;

  try {
    _parsedRows = await parseFileClientSide(file);
    if (_parsedRows.length === 0) { 
      showToast('File has no data rows.', 'warning');
      clearScrapingFile();
      return; 
    }

    document.getElementById('file-name').textContent  = file.name;
    document.getElementById('file-size').textContent  = `${(file.size / 1024).toFixed(1)} KB`;
    document.getElementById('file-selected').classList.remove('hidden');
    document.getElementById('shared-preview-filters').classList.remove('hidden');
    document.getElementById('upload-result').classList.add('hidden');

    // Show the 'Uploaded For' dropdown for campaigner role users
    const sfGroup = document.getElementById('support-for-group');
    if (sfGroup && currentUser && currentUser.role === 'campaigner') {
      sfGroup.classList.remove('hidden');
      _loadCampaignersDropdown();
    }

    // Hide upload zone & instructions, expand container
    const uploadZone = document.getElementById('upload-zone');
    if (uploadZone) uploadZone.classList.add('hidden');
    const instrBlock = document.getElementById('upload-instructions-block');
    if (instrBlock) instrBlock.classList.add('hidden');
    const mainContainer = document.getElementById('upload-main-container');
    if (mainContainer) mainContainer.style.maxWidth = '100%';

    _goToStep(1);

    await runAnalysis();
  } catch (err) {
    showToast('Could not parse file: ' + err.message, 'error');
    clearScrapingFile();
  }
}

function clearScrapingFile() {
  _scrapingFile    = null;
  _parsedRows      = [];
  _analysisResults = [];
  _currentStep     = 1;
  document.getElementById('scraping-file-input').value = '';
  document.getElementById('file-selected').classList.add('hidden');
  document.getElementById('shared-preview-filters').classList.add('hidden');
  document.getElementById('upload-step-1').classList.add('hidden');
  document.getElementById('upload-step-2').classList.add('hidden');
  document.getElementById('upload-result').classList.add('hidden');

  // Clear upload filter rule rows
  const uploadRuleRows = document.getElementById('upload-filter-rule-rows');
  if (uploadRuleRows) uploadRuleRows.innerHTML = '';
  _uploadRuleCount = 0;
  window._uploadActiveRules = null;

  // Keep the support-for dropdown visible for campaigner role users; hide for everyone else
  const sfGroup = document.getElementById('support-for-group');
  if (sfGroup) {
    if (currentUser && currentUser.role === 'campaigner') {
      sfGroup.classList.remove('hidden');
    } else {
      sfGroup.classList.add('hidden');
    }
  }

  // Show upload zone & instructions, restore container width
  const uploadZone = document.getElementById('upload-zone');
  if (uploadZone) uploadZone.classList.remove('hidden');
  const instrBlock = document.getElementById('upload-instructions-block');
  if (instrBlock) instrBlock.classList.remove('hidden');
  const mainContainer = document.getElementById('upload-main-container');
  if (mainContainer) mainContainer.style.maxWidth = '820px';

  _updateStepNav(0);
}

/* ── Step navigation ────────────────────────────────────────────────────── */
function _goToStep(n) {
  _currentStep = n;
  const s1 = document.getElementById('upload-step-1');
  const s2 = document.getElementById('upload-step-2');
  if (n === 1) { s1.classList.remove('hidden'); s2.classList.add('hidden'); }
  if (n === 2) { s1.classList.add('hidden');    s2.classList.remove('hidden'); }
  _updateStepNav(n);
}

function _updateStepNav(active) {
  document.querySelectorAll('.upload-step-pill').forEach(el => {
    const n = parseInt(el.dataset.step, 10);
    el.classList.toggle('step-pill-active',   n === active);
    el.classList.toggle('step-pill-done',     n < active);
    el.classList.toggle('step-pill-inactive', n > active);
  });
}

function goBackToAnalysis() {
  _goToStep(1);
}

/* ── Panel init (called every time the upload panel is opened) ─────────── */
function initUploadPanel() {
  // Load allowed websites first
  loadAllowedWebsites();

  // Show / hide the 'Uploaded For' group based on current user role
  const sfGroup = document.getElementById('support-for-group');
  if (sfGroup) {
    if (currentUser && currentUser.role === 'campaigner') {
      sfGroup.classList.remove('hidden');
      _loadCampaignersDropdown();
    } else {
      sfGroup.classList.add('hidden');
    }
  }
}

/* ── Upload Panel Filter Rules Engine ─────────────────────────────────── */
let _uploadRuleCount = 0;

function addUploadFilterRule() {
  const id = ++_uploadRuleCount;
  const container = document.getElementById('upload-filter-rule-rows');
  const div = document.createElement('div');
  div.className = 'assignment-card';
  div.id = `up-rule-${id}`;
  div.innerHTML = `
    <div class="assign-card-header">
      <span class="rules-section-title" style="margin-bottom:0;font-size:0.78rem">Filter Rule #${id}</span>
      <button class="assign-remove-btn" onclick="removeUploadFilterRule(${id})" title="Remove rule">✕ Remove</button>
    </div>
    <div class="assign-card-body">
      <div class="assign-logic-bar" style="margin-bottom:0.5rem;display:none;" id="up-logic-bar-${id}">
        <span class="rules-label">Match </span>
        <select class="form-select rules-input up-logic-sel" data-id="${id}" style="width:auto;display:inline-block;padding-top:0.2rem;padding-bottom:0.2rem;" onchange="onSharedFilterChange()">
          <option value="AND">ALL (AND)</option>
          <option value="OR">ANY (OR)</option>
        </select>
        <span class="rules-label"> of the following:</span>
      </div>
      <div class="up-conditions-list" id="up-conditions-${id}"></div>
      <button class="btn btn-ghost btn-sm" style="margin-top:0.5rem" onclick="addUploadConditionRow(${id})">＋ Add Filter</button>
    </div>`;
  container.appendChild(div);
  addUploadConditionRow(id);
}

function addUploadConditionRow(ruleId) {
  const list = document.getElementById(`up-conditions-${ruleId}`);
  const div  = document.createElement('div');
  div.className = 'condition-row';
  div.style = 'display:flex;gap:0.5rem;align-items:center;margin-bottom:0.5rem;';
  div.innerHTML = `
    <select class="form-select rules-input cond-field" style="width:120px" onchange="onSharedFilterChange()">
      <option value="keyword">Keyword</option>
      <option value="website">Website</option>
      <option value="affiliation">Affiliation</option>
      <option value="date">Date</option>
      <option value="email">Email</option>
      <option value="author_name">Author</option>
      <option value="article_title">Article Title</option>
      <option value="journal_name">Journal Name</option>
    </select>
    <select class="form-select rules-input cond-op" style="width:110px" onchange="onSharedFilterChange()">
      <option value="contains">contains</option>
      <option value="equals">equals</option>
      <option value="greater">greater than</option>
      <option value="less">less than</option>
    </select>
    <input type="text" class="form-input rules-input cond-val" style="flex:1" placeholder="value…" oninput="onSharedFilterChange()">
    <button class="assign-remove-btn" onclick="this.parentElement.remove(); _checkUploadLogicToggle(${ruleId}); onSharedFilterChange()">✕</button>
  `;
  list.appendChild(div);
  _checkUploadLogicToggle(ruleId);
}

function _checkUploadLogicToggle(ruleId) {
  const list = document.getElementById(`up-conditions-${ruleId}`);
  const bar  = document.getElementById(`up-logic-bar-${ruleId}`);
  if (list && bar) bar.style.display = list.children.length > 1 ? 'block' : 'none';
}

function removeUploadFilterRule(id) {
  const el = document.getElementById(`up-rule-${id}`);
  if (el) el.remove();
  onSharedFilterChange();
}

function clearUploadFilterRules() {
  const rows = document.getElementById('upload-filter-rule-rows');
  if (rows) rows.innerHTML = '';
  _uploadRuleCount = 0;
  onSharedFilterChange();
}

/* Keep old name for compat */
function clearUploadFilters() { clearUploadFilterRules(); }

function _buildUploadFilterRules() {
  const rules = [];
  document.querySelectorAll('#upload-filter-rule-rows .assignment-card').forEach(card => {
    const id = card.id.replace('up-rule-', '');
    const logicSel = card.querySelector(`.up-logic-sel[data-id="${id}"]`);
    const logic = logicSel ? logicSel.value : 'AND';
    const conditions = [];
    const condList = document.getElementById(`up-conditions-${id}`);
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

function _uploadRowMatchesRules(row, rules) {
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

/* ── Shared Filter Handler ──────────────────────────────────────────────── */
function onSharedFilterChange() {
  if (_currentStep === 1 && typeof _renderAnTableBody === 'function') {
    _renderAnTableBody();
  } else if (_currentStep === 2 && typeof refreshUploadPreview === 'function') {
    refreshUploadPreview();
  }
}

/* ── Support role: load campaigners into dropdown ───────────────────────── */
async function _loadCampaignersDropdown() {
  const sel = document.getElementById('support-for-sel');
  if (!sel) return;
  try {
    const list = await api('GET', '/users/campaigners');
    sel.innerHTML = '<option value="">-- Select Campaigner --</option>';
    if (!list || list.length === 0) {
      sel.innerHTML += '<option disabled>(No users available)</option>';
    } else {
      list.forEach(c => {
        const opt = document.createElement('option');
        opt.value       = c.id;
        opt.textContent = c.role ? `${c.username} (${c.role})` : c.username;
        sel.appendChild(opt);
      });
    }
  } catch (err) {
    sel.innerHTML = '<option value="" disabled>⚠ Could not load campaigners</option>';
    console.warn('[_loadCampaignersDropdown] Failed:', err);
  }
}

/* ── Client-side file parser ────────────────────────────────────────────── */
async function parseFileClientSide(file) {
  const name = file.name.toLowerCase();
  const buf  = await file.arrayBuffer();
  let rawRows = [];

  if (name.endsWith('.csv')) {
    const text = new TextDecoder('utf-8').decode(buf).replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/);
    if (lines.length < 2) throw new Error('CSV has no data rows');
    const headers = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase());
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const vals = parseCSVLine(lines[i]);
      const obj  = { _line: i + 1 };
      headers.forEach((h, idx) => { obj[h] = (vals[idx] || '').trim(); });
      rawRows.push(obj);
    }
  } else if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    if (typeof XLSX === 'undefined') throw new Error('SheetJS not loaded');
    const wb   = XLSX.read(buf, { type: 'array', cellDates: true });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, dateNF: 'yyyy-mm-dd' });
    if (data.length < 2) throw new Error('Excel has no data rows');
    const headers = (data[0] || []).map(h => String(h || '').trim().toLowerCase());
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (!row || row.every(v => !v)) continue;
      const obj = { _line: i + 2 };
      headers.forEach((h, idx) => { obj[h] = String(row[idx] ?? '').trim(); });
      rawRows.push(obj);
    }
  } else {
    throw new Error('Unsupported file type');
  }

  const today = new Date().toISOString().slice(0, 10);
  return rawRows.map(r => {
    const website = _getCol(r, 'website');
    const keyword = _getCol(r, 'keyword');

    if (!website) {
      throw new Error(`Row ${r._line} is missing required 'website' (or 'site', 'source') value.`);
    }
    if (!_allowedWebsites.includes(String(website).trim().toLowerCase())) {
      throw new Error(`Row ${r._line} has invalid website '${website}'. Allowed values are: ${_allowedWebsites.join(', ')}`);
    }
    if (!keyword) {
      throw new Error(`Row ${r._line} is missing required 'keyword' (or 'keywords') value.`);
    }

    return {
      _line:         r._line,
      email:         _getCol(r, 'email'),
      article_title: _getCol(r, 'article_title'),
      journal_name:  _getCol(r, 'journal_name'),
      author_name:   _getCol(r, 'author_name'),
      website:       website,
      keyword:       keyword,
      date:          _getCol(r, 'date')    || today,
      affiliation:   _getCol(r, 'affiliation') || '',
    };
  });
}

/** Minimal RFC-4180 CSV line parser */
function parseCSVLine(line) {
  const result = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i+1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ) {
      result.push(cur); cur = '';
    } else { cur += c; }
  }
  result.push(cur);
  return result;
}

/* ═══════════════════════════════════════════════════════════════════════════
   STEP 1 — ANALYSIS  →  see scraping-analysis.js
═══════════════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════════════════
   STEP 2 — STATUS RULES + UPLOAD
═══════════════════════════════════════════════════════════════════════════ */

/* ── Rules Panel toggle ─────────────────────────────────────────────────── */
function toggleRulesPanel() {
  _rulesOpen = !_rulesOpen;
  const body = document.getElementById('rules-body');
  const icon = document.getElementById('rules-toggle-icon');
  body.style.display = _rulesOpen ? '' : 'none';
  icon.textContent   = _rulesOpen ? '▾' : '▸';
}

/* ── Assignment Rows ────────────────────────────────────────────────────── */
function addAssignmentRow(status = 'Reserved') {
  const id  = ++_assignRowCount;
  const container = document.getElementById('assignment-rows');
  const div = document.createElement('div');
  div.className = 'assignment-card';
  div.id        = `assign-${id}`;
  div.innerHTML = `
    <div class="assign-card-header">
      <div class="assignment-pill status-pill-${status.toLowerCase()}" id="assign-pill-${id}">
        <select class="assign-status-sel" data-id="${id}" onchange="onAssignStatusChange(${id})">
          <option value="Reserved" ${status==='Reserved'?'selected':''}>Reserved</option>
          <option value="Used"     ${status==='Used'    ?'selected':''}>Used</option>
          <option value="Unused"   ${status==='Unused'  ?'selected':''}>Unused</option>
        </select>
      </div>
      <button class="assign-remove-btn" onclick="removeAssignmentRow(${id})" title="Remove rule">✕ Remove</button>
    </div>
    <div class="assign-card-body">
      <div class="assign-logic-bar" style="margin-bottom:0.5rem;display:none;" id="assign-logic-bar-${id}">
        <span class="rules-label">Match </span>
        <select class="form-select rules-input assign-logic-sel" data-id="${id}" style="width:auto;display:inline-block;padding-top:0.2rem;padding-bottom:0.2rem;" onchange="refreshUploadPreview()">
          <option value="AND">ALL (AND)</option>
          <option value="OR">ANY (OR)</option>
        </select>
        <span class="rules-label"> of the following:</span>
      </div>
      <div class="assign-conditions-list" id="assign-conditions-${id}"></div>
      <button class="btn btn-ghost btn-sm" style="margin-top:0.5rem" onclick="addConditionRow(${id})">＋ Add Filter</button>
    </div>`;
  container.appendChild(div);
  refreshUploadPreview();
}

function addConditionRow(ruleId) {
  const list = document.getElementById(`assign-conditions-${ruleId}`);
  const div  = document.createElement('div');
  div.className = 'condition-row';
  div.style = 'display:flex;gap:0.5rem;align-items:center;margin-bottom:0.5rem;';
  div.innerHTML = `
    <select class="form-select rules-input cond-field" style="width:110px" onchange="refreshUploadPreview()">
      <option value="keyword">Keyword</option>
      <option value="website">Website</option>
      <option value="affiliation">Affiliation</option>
      <option value="date">Date</option>
      <option value="article_title">Article Title</option>
      <option value="journal_name">Journal Name</option>
      <option value="count">Count (rows)</option>
    </select>
    <select class="form-select rules-input cond-op" style="width:100px" onchange="refreshUploadPreview()">
      <option value="contains">contains</option>
      <option value="equals">equals</option>
      <option value="greater">greater than</option>
      <option value="less">less than</option>
    </select>
    <input type="text" class="form-input rules-input cond-val" style="flex:1" oninput="refreshUploadPreview()">
    <button class="assign-remove-btn" onclick="this.parentElement.remove(); checkLogicToggle(${ruleId}); refreshUploadPreview()">✕</button>
  `;
  list.appendChild(div);
  checkLogicToggle(ruleId);
  refreshUploadPreview();
}

function checkLogicToggle(ruleId) {
  const list     = document.getElementById(`assign-conditions-${ruleId}`);
  const logicBar = document.getElementById(`assign-logic-bar-${ruleId}`);
  if (list && logicBar) {
    logicBar.style.display = list.children.length > 1 ? 'block' : 'none';
  }
}

function onAssignStatusChange(id) {
  const sel  = document.querySelector(`.assign-status-sel[data-id="${id}"]`);
  const pill = document.getElementById(`assign-pill-${id}`);
  pill.className = `assignment-pill status-pill-${sel.value.toLowerCase()}`;
  refreshUploadPreview();
}

function removeAssignmentRow(id) {
  const el = document.getElementById(`assign-${id}`);
  if (el) el.remove();
  refreshUploadPreview();
}

/* ── Build rules object from UI ─────────────────────────────────────────── */
function buildRulesFromUI() {
  const assignments = [];
  document.querySelectorAll('.assign-status-sel').forEach(sel => {
    const id     = sel.dataset.id;
    const logic  = document.querySelector(`.assign-logic-sel[data-id="${id}"]`).value;
    const conditions = [];
    document.getElementById(`assign-conditions-${id}`).querySelectorAll('.condition-row').forEach(row => {
      const field = row.querySelector('.cond-field').value;
      const op    = row.querySelector('.cond-op').value;
      const val   = row.querySelector('.cond-val').value.trim();
      if (val) conditions.push({ field, operator: op, value: val });
    });
    assignments.push({ status: sel.value, logic, conditions });
  });

  const default_status = document.getElementById('default-status').value;
  // preview_filters now driven by upload filter rule engine
  return { preview_filters: {}, assignments, default_status };
}

/* ── Filter a row against the global preview filter config ──────────────── */
function rowMatchesFilter(row) {
  const rules = _buildUploadFilterRules();
  return _uploadRowMatchesRules(row, rules);
}

/* ── Evaluate a row against dynamic rule conditions ─────────────────────── */
function rowMatchesRuleLogic(row, conditions, logic, ruleState) {
  if (!conditions || conditions.length === 0) return true;
  const evaluateCondition = (cond) => {
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
  return logic === 'OR'
    ? conditions.some(evaluateCondition)
    : conditions.every(evaluateCondition);
}

/* ── Compute resolved status for every row ───────────────────────────────── */
function resolveStatuses(rows, rules) {
  const { assignments, default_status } = rules;
  const resolved = new Array(rows.length).fill(default_status);
  const unassignedIdxs = new Set(rows.map((_, i) => i));
  if (assignments.length > 0) {
    for (const rule of assignments) {
      const ruleState = { matches: 0 };
      for (const i of unassignedIdxs) {
        if (rowMatchesRuleLogic(rows[i], rule.conditions, rule.logic, ruleState)) {
          resolved[i] = rule.status;
          unassignedIdxs.delete(i);
          ruleState.matches++;
        }
      }
    }
  }
  return resolved;
}

/* ── Live Preview (Step 2) ──────────────────────────────────────────────── */
const STATUS_EMOJI = { Unused: '⚪', Reserved: '🟡', Used: '🟢' };

// Build a lookup map from analysis results (by email)
function _buildAnalysisMap() {
  const map = {};
  (_analysisResults || []).forEach((r, i) => { map[r.email] = r; });
  return map;
}

function refreshUploadPreview() {
  if (!_parsedRows.length) return;

  const rules    = buildRulesFromUI();
  const resolved = resolveStatuses(_parsedRows, rules);
  const anMap    = _buildAnalysisMap();

  // Count by status (skip invalid rows; updatable rows now follow the rules engine too)
  const counts = { Unused: 0, Reserved: 0, Used: 0, Skip: 0 };
  _parsedRows.forEach((r, i) => {
    const an = anMap[r.email];
    if (!r.email || !r.article_title || !r.author_name || !r.journal_name || !r.website || !r.keyword) {
      counts.Skip++;
      return;
    }
    counts[resolved[i]] = (counts[resolved[i]] || 0) + 1;
  });

  const summaryEl = document.getElementById('preview-summary');
  summaryEl.innerHTML = `
    <span class="summary-badge badge-unused">⚪ Unused: ${counts.Unused}</span>
    <span class="summary-badge badge-reserved">🟡 Reserved: ${counts.Reserved}</span>
    <span class="summary-badge badge-used">🟢 Used: ${counts.Used}</span>
    ${counts.Skip ? `<span class="summary-badge badge-skip">⏭ Skip: ${counts.Skip}</span>` : ''}
  `;

  const displayRows = [];
  _parsedRows.forEach((r, i) => {
    if (rowMatchesFilter(r)) displayRows.push({ row: r, originalIndex: i });
  });

  const tbody = document.getElementById('upload-preview-tbody');
  const MAX_PREVIEW = 200;
  let html = '';
  displayRows.slice(0, MAX_PREVIEW).forEach((item) => {
    const r       = item.row;
    const an      = anMap[r.email];
    const isInvalid = !r.email || !r.article_title || !r.author_name || !r.journal_name || !r.website || !r.keyword;
    const isUpdatable = an && an.category === 'updatable';

    let status, rowClass, badge;
    if (isInvalid) {
      status = 'Skip'; rowClass = 'preview-row-skip';
      badge  = `<span class="status-preview-badge status-badge-skip">⏭ Skip</span>`;
    } else {
      status   = resolved[item.originalIndex];
      rowClass = `preview-row-${status.toLowerCase()}`;
      badge    = `<span class="status-preview-badge status-badge-${status.toLowerCase()}">${STATUS_EMOJI[status] || '⏭'} ${status}</span>`;
    }

    // DB status annotation for existing rows
    const dbNote = (an && an.category !== 'new')
      ? `<span class="preview-db-note">${_categoryBadge(an.category)}</span>`
      : '';

    html += `<tr class="${rowClass}">
      <td class="preview-td-num">${r._line}</td>
      <td class="preview-td-email" title="${esc(r.email)}">${esc(r.email) || '<span class="text-muted">—</span>'}</td>
      <td class="preview-td-text" title="${esc(r.author_name)}">${esc(trunc(r.author_name, 22))}</td>
      <td class="preview-td-text" title="${esc(r.website)}">${esc(trunc(r.website, 18))}</td>
      <td class="preview-td-text" title="${esc(r.keyword)}">${esc(trunc(r.keyword, 18))}</td>
      <td class="preview-td-text" title="${esc(r.affiliation)}">${esc(trunc(r.affiliation, 20)) || '<span class="text-muted">—</span>'}</td>
      <td class="preview-td-date">${esc(r.date)}</td>
      <td>${badge} ${dbNote}</td>
    </tr>`;
  });
  tbody.innerHTML = html;

  const footerEl = document.getElementById('preview-footer');
  footerEl.textContent = displayRows.length > MAX_PREVIEW
    ? `Showing first ${MAX_PREVIEW} of ${displayRows.length} matching rows. (Total: ${_parsedRows.length})`
    : `Showing ${displayRows.length} matching rows. (Total: ${_parsedRows.length})`;

  document.getElementById('upload-preview-section').classList.remove('hidden');
}

function trunc(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/* ── Upload ─────────────────────────────────────────────────────────────── */
async function uploadScrapingFile() {
  if (!_scrapingFile) return;

  // Validate 'Uploading On Behalf Of' for campaigner role users
  if (currentUser && currentUser.role === 'campaigner') {
    const sfSel = document.getElementById('support-for-sel');
    if (sfSel && !sfSel.value) {
      showToast('Please select who you are uploading on behalf of.', 'warning');
      sfSel.focus();
      return;
    }
  }

  const btn = document.getElementById('btn-upload-scraping');
  btn.disabled = true; btn.textContent = '⏳ Uploading…';

  const rules = buildRulesFromUI();
  const fd    = new FormData();
  fd.append('file', _scrapingFile);
  fd.append('status_rules', JSON.stringify(rules));

  // Append support_for_id if the user is in the support role
  const sfSel = document.getElementById('support-for-sel');
  if (sfSel && sfSel.value) fd.append('support_for_id', sfSel.value);

  try {
    const data = await apiForm('/scraping/upload', fd);
    const res  = document.getElementById('upload-result');
    res.classList.remove('hidden');

    let html = `<div class="upload-result">
      <div style="margin-bottom:0.75rem;font-weight:700;font-size:0.9rem">Upload Complete</div>
      <div class="result-success">✅ ${data.inserted} record${data.inserted !== 1 ? 's' : ''} inserted</div>`;

    if (data.updated) {
      html += `<div class="result-success" style="margin-top:0.25rem">🔵 ${data.updated} record${data.updated !== 1 ? 's' : ''} updated (journal/keyword appended)</div>`;
    }

    html += `<div class="result-failed" style="margin-top:0.25rem">⏭️ ${data.skipped} skipped (duplicates / missing fields)</div>`;

    if (data.blocked) {
      html += `<div style="margin-top:0.25rem;color:var(--danger);font-weight:600;font-size:0.82rem">🔴 ${data.blocked} blocked (mail limit reached)</div>`;
    }

    if (data.status_breakdown) {
      const b = data.status_breakdown;
      html += `<div style="margin-top:0.6rem;font-size:0.8rem;color:var(--text-secondary)">
        ⚪ Unused: ${b.Unused||0} &nbsp; 🟡 Reserved: ${b.Reserved||0} &nbsp; 🟢 Used: ${b.Used||0}
      </div>`;
    }

    if (data.skipped_rows?.length) {
      html += `<div style="margin-top:0.75rem;font-weight:600;font-size:0.8rem;color:var(--text-secondary)">Skipped rows:</div>`;
      data.skipped_rows.forEach(r => {
        html += `<div class="result-item"><span style="color:var(--danger)">Row ${r.line}</span><span style="color:var(--text-secondary)">${esc(r.email)} — ${esc(r.reason)}</span></div>`;
      });
    }

    if (data.blocked_rows?.length) {
      html += `<div style="margin-top:0.75rem;font-weight:600;font-size:0.8rem;color:var(--text-secondary)">Blocked rows:</div>`;
      data.blocked_rows.forEach(r => {
        html += `<div class="result-item"><span style="color:var(--danger)">Row ${r.line}</span><span style="color:var(--text-secondary)">${esc(r.email)} — ${esc(r.reason)}</span></div>`;
      });
    }

    html += '</div>';
    res.innerHTML = html;
    showToast(`${data.inserted} inserted, ${data.skipped} skipped`, data.inserted > 0 ? 'success' : 'warning');
    loadDashboard();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '⬆️ Upload File';
  }
}

/* ── Download current batch as Excel ────────────────────────────────────── */
/**
 * Exports _parsedRows (the live in-memory array, AFTER any rows deleted
 * during analysis) as a .xlsx download using SheetJS.
 * Only includes rows still in the batch — deleted rows are excluded.
 */
function downloadBatchExcel() {
  if (!_parsedRows || _parsedRows.length === 0) {
    showToast('No rows to download.', 'warning');
    return;
  }
  if (typeof XLSX === 'undefined') {
    showToast('SheetJS not loaded — cannot generate Excel file.', 'error');
    return;
  }

  // Build worksheet data — header row + one row per parsed record
  const headers = ['Email', 'Author Name', 'Article Title', 'Journal Name', 'Website', 'Keyword', 'Date', 'Affiliation'];
  const wsData  = [headers];
  _parsedRows.forEach(r => {
    wsData.push([
      r.email        || '',
      r.author_name  || '',
      r.article_title|| '',
      r.journal_name || '',
      r.website      || '',
      r.keyword      || '',
      r.date         || '',
      r.affiliation  || '',
    ]);
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // Auto-fit column widths
  ws['!cols'] = headers.map((h, i) => ({
    wch: Math.max(h.length, ...wsData.slice(1).map(row => String(row[i] || '').length)) + 2,
  }));

  XLSX.utils.book_append_sheet(wb, ws, 'Batch');

  const ts       = new Date().toISOString().slice(0, 10);
  const filename = `upload_batch_${ts}.xlsx`;
  XLSX.writeFile(wb, filename);
  showToast(`Downloaded ${_parsedRows.length} rows as ${filename}`, 'success');
}
