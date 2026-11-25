/* ═══════════════════════════════════════════════════════════════════════════
   DataBase — js/templates.js
   Email Templates panel
   Features: create / edit / delete templates, {placeholder} chip insertion
   Depends on: core.js (api, esc, showToast, showModal, closeModal)
═══════════════════════════════════════════════════════════════════════════ */

'use strict';

// ── Available DB column placeholders ──────────────────────────────────────────
// Sourced from MINE_ALL_COLS (defined in app.js) to stay in sync.
const TEMPLATE_PLACEHOLDERS = [
  { key: 'author_name',   label: 'Author Name' },
  { key: 'article_title', label: 'Article Title' },
  { key: 'journal_name',  label: 'Journal Name' },
  { key: 'email',         label: 'Email' },
  { key: 'keyword',       label: 'Keyword' },
  { key: 'website',       label: 'Website' },
  { key: 'affiliation',   label: 'Affiliation' },
  { key: 'date',          label: 'Date' },
  { key: 'email_status',  label: 'Status' },
];

// ── Module state ──────────────────────────────────────────────────────────────
let _tplList       = [];     // [{id, name, subject, body, …}, …]
let _tplActiveId   = null;   // ID of template currently open in editor
let _tplDirty      = false;  // unsaved changes flag

// ── Load & render template list ───────────────────────────────────────────────
async function loadTemplates() {
  _renderPlaceholderChips();    // render chips on every panel load

  // Inject "Compose Campaign" shortcut into top-bar actions
  const topBarActions = document.getElementById('top-bar-actions');
  if (topBarActions) {
    topBarActions.innerHTML = `
      <button class="btn btn-primary btn-sm"
              onclick="showPanel('campaign-composer')"
              title="Open the Campaign Composer to generate emails from templates + queue data">
        🎯 Compose Campaign
      </button>`;
  }

  const listEl = document.getElementById('template-list-scroll');
  if (listEl) listEl.innerHTML = '<div class="template-list-empty"><div class="template-list-empty-icon">⏳</div><p>Loading…</p></div>';

  try {
    _tplList = await api('GET', '/templates');
    _renderTemplateList();
    // If a template was previously open and still exists, keep it selected
    if (_tplActiveId && _tplList.find(t => t.id === _tplActiveId)) {
      _tplOpenEditor(_tplActiveId);
    } else {
      _tplActiveId = null;
      _renderEditorEmpty();
    }
  } catch (err) {
    if (listEl) listEl.innerHTML = `<div class="template-list-empty"><p style="color:var(--danger)">Error: ${esc(err.message)}</p></div>`;
  }
}

// ── Render the left-column list ───────────────────────────────────────────────
function _renderTemplateList() {
  const listEl = document.getElementById('template-list-scroll');
  if (!listEl) return;

  if (!_tplList.length) {
    listEl.innerHTML = `
      <div class="template-list-empty">
        <div class="template-list-empty-icon">✉️</div>
        <p>No templates yet.<br>Click <strong>+ New</strong> to create one.</p>
      </div>`;
    return;
  }

  listEl.innerHTML = _tplList.map(t => {
    const creator = t.creator_name ? `<div style="font-size:0.75rem; color:var(--text-muted); margin-top:2px;">by ${esc(t.creator_name)}</div>` : '';
    return `
    <div class="template-item ${t.id === _tplActiveId ? 'active' : ''}"
         id="tpl-item-${t.id}"
         onclick="tplSelectTemplate(${t.id})">
      <span class="template-item-icon">📄</span>
      <div class="template-item-info">
        <div class="template-item-name">${esc(t.name)}</div>
        <div class="template-item-meta">${esc(_tplSubjectPreview(t.subject))}</div>
        ${creator}
      </div>
    </div>`;
  }).join('');
}

function _tplSubjectPreview(subject) {
  if (!subject) return '(no subject)';
  return subject.length > 42 ? subject.slice(0, 42) + '…' : subject;
}

// ── Render placeholder chips into both chip bars ──────────────────────────────
function _renderPlaceholderChips() {
  const bars = document.querySelectorAll('.placeholder-chips');
  bars.forEach(bar => {
    bar.innerHTML = TEMPLATE_PLACEHOLDERS.map(p => `
      <button class="placeholder-chip"
              title="Insert {${p.key}}"
              onclick="tplInsertPlaceholder(this, '${p.key}')">
        <span class="placeholder-chip-icon">⌗</span>{${p.key}}
      </button>`).join('');
  });
}

// ── Insert placeholder at cursor in the associated textarea/input ─────────────
// Each chip bar has a `data-target` attribute pointing to the field ID.
function tplInsertPlaceholder(chipEl, key) {
  const bar    = chipEl.closest('[data-target]');
  const target = bar ? document.getElementById(bar.dataset.target) : null;
  if (!target) return;

  const placeholder = `{${key}}`;
  const start = target.selectionStart ?? target.value.length;
  const end   = target.selectionEnd   ?? target.value.length;
  target.value = target.value.slice(0, start) + placeholder + target.value.slice(end);
  // Restore cursor position after inserted text
  const newPos = start + placeholder.length;
  target.focus();
  target.setSelectionRange(newPos, newPos);
  _tplMarkDirty();
}

// ── Open a template in the editor ────────────────────────────────────────────
function tplSelectTemplate(id) {
  if (_tplDirty && _tplActiveId !== id) {
    if (!confirm('You have unsaved changes. Discard them and open a different template?')) return;
  }
  _tplActiveId = id;
  _tplDirty    = false;
  _tplOpenEditor(id);
  _renderTemplateList(); // update active highlight
}

function _tplOpenEditor(id) {
  const t = _tplList.find(x => x.id === id);
  if (!t) return;

  const editorPane = document.getElementById('template-editor-pane');
  if (!editorPane) return;

  editorPane.innerHTML = _tplEditorHTML(t);
  _renderPlaceholderChips();
  _tplWireDirtyListeners();
}

// ── Render empty editor state ─────────────────────────────────────────────────
function _renderEditorEmpty() {
  const editorPane = document.getElementById('template-editor-pane');
  if (!editorPane) return;
  editorPane.innerHTML = `
    <div class="template-editor-empty">
      <div class="template-editor-empty-icon">✉️</div>
      <h3>No Template Selected</h3>
      <p>Choose a template from the list or create a new one to start editing.</p>
      <button class="btn btn-primary btn-sm" style="margin-top:0.75rem" onclick="tplNewTemplate()">＋ New Template</button>
    </div>`;
}

// ── Build editor inner HTML ───────────────────────────────────────────────────
function _tplEditorHTML(t) {
  const isNew = !t.id;
  return `
    <!-- Editor header: name input + action buttons -->
    <div class="template-editor-header">
      <input  id="tpl-name"
              class="template-name-input form-input"
              type="text"
              placeholder="Template name…"
              value="${esc(t.name || '')}"
              oninput="_tplMarkDirty()"
              autocomplete="off">
      <div class="template-editor-actions">
        ${!isNew ? `<button class="btn btn-danger btn-sm" onclick="tplDeleteTemplate(${t.id})">🗑 Delete</button>` : ''}
        <button class="btn btn-primary btn-sm" id="btn-tpl-save" onclick="tplSaveTemplate()">
          ${isNew ? '＋ Create Template' : '💾 Save Changes'}
        </button>
      </div>
    </div>

    <!-- Scrollable editor body -->
    <div class="template-editor-body">

      <!-- Subject field with placeholder chips -->
      <div class="template-field-group">
        <label class="template-field-label" for="tpl-subject">
          Subject Line
          <span class="template-field-hint">— use chips below to insert placeholders</span>
        </label>
        <div class="placeholder-section" data-target="tpl-subject">
          <div class="placeholder-section-label">📌 Click a placeholder to insert into Subject</div>
          <div class="placeholder-chips"></div>
        </div>
        <input  id="tpl-subject"
                class="form-input"
                type="text"
                placeholder="e.g. Enhance Visibility of Your Research | Submit to {journal_name}"
                value="${esc(t.subject || '')}"
                oninput="_tplMarkDirty()">
      </div>

      <!-- Body field with placeholder chips -->
      <div class="template-field-group" style="flex:1;display:flex;flex-direction:column;gap:0.4rem">
        <label class="template-field-label" for="tpl-body">
          Email Body
          <span class="template-field-hint">— use chips below to insert placeholders</span>
        </label>
        <div class="placeholder-section" data-target="tpl-body">
          <div class="placeholder-section-label">📌 Click a placeholder to insert into Body</div>
          <div class="placeholder-chips"></div>
        </div>
        <textarea id="tpl-body"
                  class="form-input template-body-textarea"
                  placeholder="Dear Dr. {author_name},\n\nWe truly appreciate your valuable contribution entitled &quot;{article_title}&quot;…"
                  oninput="_tplMarkDirty()"
                  style="flex:1">${esc(t.body || '')}</textarea>
      </div>

    </div>`;
}

// ── Dirty tracking ────────────────────────────────────────────────────────────
function _tplMarkDirty() {
  if (!_tplDirty) {
    _tplDirty = true;
    const btn = document.getElementById('btn-tpl-save');
    if (btn && !btn.querySelector('.template-dirty-dot')) {
      btn.insertAdjacentHTML('beforeend', '<span class="template-dirty-dot"></span>');
    }
  }
}

function _tplWireDirtyListeners() {
  // Already wired via oninput attributes in the HTML template
}

// ── New template ──────────────────────────────────────────────────────────────
function tplNewTemplate() {
  if (_tplDirty) {
    if (!confirm('You have unsaved changes. Discard them and start a new template?')) return;
  }
  _tplActiveId = null;
  _tplDirty    = false;

  // Deselect any active list item
  document.querySelectorAll('.template-item.active').forEach(el => el.classList.remove('active'));

  const editorPane = document.getElementById('template-editor-pane');
  if (!editorPane) return;

  editorPane.innerHTML = _tplEditorHTML({ id: null, name: '', subject: '', body: '' });
  _renderPlaceholderChips();
  document.getElementById('tpl-name')?.focus();
}

// ── Save (create or update) ───────────────────────────────────────────────────
async function tplSaveTemplate() {
  const name    = (document.getElementById('tpl-name')?.value    || '').trim();
  const subject = (document.getElementById('tpl-subject')?.value || '').trim();
  const body    = (document.getElementById('tpl-body')?.value    || '');

  if (!name) {
    showToast('Please enter a template name', 'warning');
    document.getElementById('tpl-name')?.focus();
    return;
  }

  const btn = document.getElementById('btn-tpl-save');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Saving…'; }

  try {
    let saved;
    if (_tplActiveId) {
      // Update existing
      saved = await api('PUT', `/templates/${_tplActiveId}`, { name, subject, body });
      showToast(`Template "${saved.name}" updated`, 'success');
    } else {
      // Create new
      saved = await api('POST', '/templates', { name, subject, body });
      showToast(`Template "${saved.name}" created`, 'success');
    }

    _tplActiveId = saved.id;
    _tplDirty    = false;
    await loadTemplates();               // refresh list
    _tplOpenEditor(_tplActiveId);        // re-render editor in clean state
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; }
  }
}

// ── Delete ────────────────────────────────────────────────────────────────────
async function tplDeleteTemplate(id) {
  const t = _tplList.find(x => x.id === id);
  if (!t) return;

  // Use the existing confirm-delete modal if available, else native confirm
  const confirmDeleteModal = document.getElementById('confirm-delete-modal');
  if (confirmDeleteModal) {
    const msgEl = document.getElementById('confirm-delete-msg');
    if (msgEl) msgEl.textContent = `Delete template "${t.name}"? This cannot be undone.`;
    const btn = document.getElementById('btn-confirm-delete');
    if (btn) {
      // Clone to remove old listeners
      const newBtn = btn.cloneNode(true);
      btn.parentNode.replaceChild(newBtn, btn);
      newBtn.onclick = async () => {
        closeModal('confirm-delete-modal');
        await _tplDoDelete(id, t.name);
      };
    }
    showModal('confirm-delete-modal');
  } else {
    if (!confirm(`Delete template "${t.name}"? This cannot be undone.`)) return;
    await _tplDoDelete(id, t.name);
  }
}

async function _tplDoDelete(id, name) {
  try {
    await api('DELETE', `/templates/${id}`);
    showToast(`Template "${name}" deleted`, 'success');
    if (_tplActiveId === id) {
      _tplActiveId = null;
      _tplDirty    = false;
    }
    await loadTemplates();
    if (!_tplActiveId) _renderEditorEmpty();
  } catch (err) {
    showToast(err.message, 'error');
  }
}
