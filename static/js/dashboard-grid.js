/* ═══════════════════════════════════════════════════════════════════════════
   dashboard-grid.js — Draggable & Resizable Manager Dashboard
   Depends on: interact.js (CDN), manager.js (mgrCharts)
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

// ── Constants ──────────────────────────────────────────────────────────────────
const STORAGE_KEY        = 'mgr_dashboard_layout_v2';
const PRESETS_KEY        = 'mgr_dashboard_presets_v1';   // { name: layout[] }[]
const ACTIVE_DEFAULT_KEY = 'mgr_dashboard_default_v1';   // name of preset used as reset target
const GRID_COLS     = 12;
const COL_UNIT_PX   = () => {
  const grid = document.getElementById('dashboard-grid');
  return grid ? grid.clientWidth / GRID_COLS : 80;
};
const ROW_UNIT_PX   = 8;
const MIN_W_COLS    = 3;
const MIN_H_PX      = 140;

// ── Default layout ─────────────────────────────────────────────────────────────
const DEFAULT_LAYOUT = [
  { id: 'kpi-row',         col: 1,  row: 1, colSpan: 12, rowSpan: 1, height: '' },
  { id: 'revenue-trend',   col: 1,  row: 2, colSpan: 7,  rowSpan: 2, height: '' },
  { id: 'invoice-status',  col: 8,  row: 2, colSpan: 5,  rowSpan: 2, height: '' },
  { id: 'journal-rev',     col: 1,  row: 4, colSpan: 7,  rowSpan: 2, height: '' },
  { id: 'admin-perf',      col: 8,  row: 4, colSpan: 5,  rowSpan: 2, height: '' },
  { id: 'campaign',        col: 1,  row: 6, colSpan: 6,  rowSpan: 2, height: '' },
  { id: 'reach-journal',   col: 7,  row: 6, colSpan: 6,  rowSpan: 2, height: '' },
  { id: 'recent-invoices', col: 1,  row: 8, colSpan: 12, rowSpan: 2, height: '' },
];

// ── State ──────────────────────────────────────────────────────────────────────
let dashEditMode = false;

// ── Helpers ────────────────────────────────────────────────────────────────────
function snapToCol(px) {
  const unit = COL_UNIT_PX();
  return Math.max(MIN_W_COLS, Math.round(px / unit));
}

function snapToRow(px) {
  return Math.max(MIN_H_PX, Math.round(px / ROW_UNIT_PX) * ROW_UNIT_PX);
}

function getWidget(id) {
  return document.getElementById('widget-' + id);
}

// ── Layout storage ─────────────────────────────────────────────────────────────
function saveLayout() {
  const layout = DEFAULT_LAYOUT.map(function(def) {
    const el = getWidget(def.id);
    if (!el) return def;
    return {
      id:      def.id,
      col:     parseInt(el.style.gridColumnStart) || def.col,
      row:     parseInt(el.style.gridRowStart)    || def.row,
      colSpan: (function() {
        const ce = el.style.gridColumnEnd || '';
        const m  = ce.match(/span\s+(\d+)/);
        return m ? parseInt(m[1]) : def.colSpan;
      })(),
      rowSpan: (function() {
        const re = el.style.gridRowEnd || '';
        const m  = re.match(/span\s+(\d+)/);
        return m ? parseInt(m[1]) : def.rowSpan;
      })(),
      height:  el.style.height || '',
    };
  });
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(layout)); } catch(_) {}
}

function loadLayout() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : DEFAULT_LAYOUT;
  } catch (_) {
    return DEFAULT_LAYOUT;
  }
}

// ── Apply layout to DOM ────────────────────────────────────────────────────────
function applyLayout(layout) {
  layout.forEach(function(item) {
    const el = getWidget(item.id);
    if (!el) return;
    el.style.gridColumnStart = item.col;
    el.style.gridColumnEnd   = 'span ' + item.colSpan;
    el.style.gridRowStart    = item.row;
    el.style.gridRowEnd      = 'span ' + item.rowSpan;
    if (item.height) {
      el.style.height = item.height;
    } else {
      el.style.height = '';
    }
  });
}

// ── Resize all Chart.js charts inside a widget ─────────────────────────────────
function resizeChartsIn(el) {
  if (typeof mgrCharts === 'undefined') return;
  var canvases = el.querySelectorAll('canvas');
  canvases.forEach(function(c) {
    var chartId = Object.keys(mgrCharts).find(function(k) {
      return mgrCharts[k] && mgrCharts[k].canvas === c;
    });
    if (chartId && mgrCharts[chartId]) {
      try { mgrCharts[chartId].resize(); } catch(_) {}
    }
  });
}

// ── Drag (free-placement) ──────────────────────────────────────────────────────
// On drop the widget's pixel position is converted to a grid col/row and the
// widget is placed there directly — no forced swap, any layout is possible.
function makeDraggable() {
  try { interact('.dashboard-widget').unset(); } catch(_) {}

  var startX = 0, startY = 0;

  interact('.dashboard-widget').draggable({
    allowFrom:  '.widget-drag-handle',
    inertia:    false,
    autoScroll: true,
    listeners: {

      start: function(event) {
        startX = 0; startY = 0;
        event.target.classList.add('widget-dragging');
        event.target.style.zIndex  = '999';
        event.target.style.opacity = '0.82';
      },

      move: function(event) {
        startX += event.dx;
        startY += event.dy;
        event.target.style.transform = 'translate(' + startX + 'px,' + startY + 'px)';
      },

      end: function(event) {
        var target = event.target;

        // Read the visually-moved bounding rect before clearing transform
        var movedRect = target.getBoundingClientRect();

        // Clear all drag visuals
        target.style.transform = '';
        target.style.zIndex    = '';
        target.style.opacity   = '';
        target.classList.remove('widget-dragging');

        // ── Convert pixel drop position to grid column & row ───────────────
        var grid     = document.getElementById('dashboard-grid');
        var gridRect = grid.getBoundingClientRect();
        var gapPx    = parseFloat(getComputedStyle(grid).columnGap) || 16;
        var colUnit  = COL_UNIT_PX();   // px width of one column

        // Widget centre relative to the grid container
        var relX = (movedRect.left + movedRect.width  / 2) - gridRect.left;
        var relY = (movedRect.top  + movedRect.height / 2) - gridRect.top;

        // Preserve current column span
        var colSpanStr = target.style.gridColumnEnd || 'span 6';
        var colSpanM   = colSpanStr.match(/span\s+(\d+)/);
        var colSpan    = colSpanM ? parseInt(colSpanM[1]) : 6;

        // Target column: 1-based left edge of widget
        var rawCol    = Math.round((relX - (colSpan * colUnit) / 2) / colUnit) + 1;
        var targetCol = Math.max(1, Math.min(rawCol, GRID_COLS - colSpan + 1));

        // Estimate row height from average widget heights
        var allWidgets = grid.querySelectorAll('.dashboard-widget');
        var totalH     = 0;
        allWidgets.forEach(function(w) { totalH += w.offsetHeight; });
        var avgH       = allWidgets.length ? totalH / allWidgets.length : 200;
        var rowStep    = avgH + gapPx;
        var targetRow  = Math.max(1, Math.round(relY / rowStep) + 1);

        // Preserve current row span
        var rowSpanStr = target.style.gridRowEnd || 'span 2';
        var rowSpanM   = rowSpanStr.match(/span\s+(\d+)/);
        var rowSpan    = rowSpanM ? parseInt(rowSpanM[1]) : 2;

        // Apply new free position
        target.style.gridColumnStart = targetCol;
        target.style.gridColumnEnd   = 'span ' + colSpan;
        target.style.gridRowStart    = targetRow;
        target.style.gridRowEnd      = 'span ' + rowSpan;

        saveLayout();
        setTimeout(function() { resizeChartsIn(target); }, 60);
      },
    },
  });
}

// ── Resize (bottom-right handle) ───────────────────────────────────────────────
function makeResizable() {
  // Track accumulated deltas so we can compute column span from pixel movement
  var startW = 0, startH = 0;

  interact('.dashboard-widget').resizable({
    // Enable BOTH right and bottom edges so width AND height can be changed
    edges:     { right: true, bottom: true, left: false, top: false },
    allowFrom: '.widget-resize-handle',
    inertia:   false,
    // Prevent interact from writing inline width/height — we manage those ourselves
    // via grid column spans and explicit height
    modifiers: [],
    listeners: {
      start: function(event) {
        var target = event.target;
        startW = target.offsetWidth;
        startH = target.offsetHeight;
        // Lock a pixel width so the grid cell doesn't collapse while dragging
        target.style.width = startW + 'px';
      },
      move: function(event) {
        var target = event.target;

        // --- Width (column span) ---
        var newW = Math.max(event.rect.width, MIN_W_COLS * COL_UNIT_PX());
        var colStart  = parseInt(target.style.gridColumnStart) || 1;
        var maxCols   = GRID_COLS - colStart + 1;
        var snappedCols = Math.min(snapToCol(newW), maxCols);
        target.style.gridColumnEnd = 'span ' + snappedCols;
        // Remove pixel width lock so the grid controls layout width again
        target.style.width = '';

        // --- Height ---
        var newH = Math.max(event.rect.height, MIN_H_PX);
        var snappedH = snapToRow(newH);
        target.style.height    = snappedH + 'px';
        target.style.minHeight = MIN_H_PX + 'px';

        // --- Live chart resize ---
        resizeChartsIn(target);
      },
      end: function(event) {
        // Final snap + save
        var target = event.target;
        target.style.width = ''; // ensure no leftover pixel width
        saveLayout();
        // Give the browser a frame to re-layout before final chart resize
        requestAnimationFrame(function() { resizeChartsIn(target); });
      },
    },
  });
}

// ── Toggle edit mode ───────────────────────────────────────────────────────────
function toggleDashboardEdit() {
  dashEditMode = !dashEditMode;
  var grid  = document.getElementById('dashboard-grid');
  var icon  = document.getElementById('edit-layout-icon');
  var label = document.getElementById('edit-layout-label');
  var btn   = document.getElementById('btn-edit-layout');

  if (dashEditMode) {
    grid.classList.add('edit-mode');
    icon.textContent  = '✅';
    label.textContent = 'Done';
    btn.classList.add('active');
    makeDraggable();
    makeResizable();
  } else {
    grid.classList.remove('edit-mode');
    icon.textContent  = '✏️';
    label.textContent = 'Edit Layout';
    btn.classList.remove('active');
    try {
      interact('.dashboard-widget').draggable({ enabled: false });
      interact('.dashboard-widget').resizable({ enabled: false });
    } catch(_) {}
  }
}

// ── Reset to default layout ────────────────────────────────────────────────────
// Respects a user-pinned preset as the default; falls back to the built-in DEFAULT_LAYOUT.
function resetDashboardLayout() {
  try { localStorage.removeItem(STORAGE_KEY); } catch(_) {}

  var resetLayout = DEFAULT_LAYOUT;
  try {
    var activeName = localStorage.getItem(ACTIVE_DEFAULT_KEY);
    if (activeName) {
      var presets = loadAllPresets();
      var found   = presets.find(function(p) { return p.name === activeName; });
      if (found) resetLayout = found.layout;
    }
  } catch(_) {}

  applyLayout(resetLayout);
  resetLayout.forEach(function(item) {
    var el = getWidget(item.id);
    if (el) el.style.height = item.height || '';
  });
  setTimeout(function() {
    document.querySelectorAll('.dashboard-widget').forEach(resizeChartsIn);
  }, 100);
  if (typeof showToast === 'function') showToast('Dashboard layout reset to default', 'success');
}

// ── Preset storage helpers ─────────────────────────────────────────────────────
function loadAllPresets() {
  try {
    var raw = localStorage.getItem(PRESETS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch(_) { return []; }
}

function saveAllPresets(presets) {
  try { localStorage.setItem(PRESETS_KEY, JSON.stringify(presets)); } catch(_) {}
}

// ── Capture the live grid state as a layout array ──────────────────────────────
function captureCurrentLayout() {
  return DEFAULT_LAYOUT.map(function(def) {
    var el = getWidget(def.id);
    if (!el) return def;
    var ceStr = el.style.gridColumnEnd || '';
    var reStr = el.style.gridRowEnd    || '';
    var colM  = ceStr.match(/span\s+(\d+)/);
    var rowM  = reStr.match(/span\s+(\d+)/);
    return {
      id:      def.id,
      col:     parseInt(el.style.gridColumnStart) || def.col,
      row:     parseInt(el.style.gridRowStart)    || def.row,
      colSpan: colM ? parseInt(colM[1]) : def.colSpan,
      rowSpan: rowM ? parseInt(rowM[1]) : def.rowSpan,
      height:  el.style.height || '',
    };
  });
}

// ── Save current layout as a named preset ─────────────────────────────────────
function saveCurrentAsPreset(name) {
  name = (name || '').trim();
  if (!name) {
    if (typeof showToast === 'function') showToast('Please enter a layout name', 'warning');
    return false;
  }
  var presets = loadAllPresets();
  var existing = presets.findIndex(function(p) { return p.name === name; });
  var layout   = captureCurrentLayout();
  if (existing >= 0) {
    presets[existing].layout = layout;
    presets[existing].savedAt = new Date().toISOString();
  } else {
    presets.push({ name: name, layout: layout, savedAt: new Date().toISOString() });
  }
  saveAllPresets(presets);
  if (typeof showToast === 'function') showToast('Layout \u201c' + name + '\u201d saved!', 'success');
  return true;
}

// ── Apply a named preset ───────────────────────────────────────────────────────
function applyPreset(name) {
  var presets = loadAllPresets();
  var preset  = presets.find(function(p) { return p.name === name; });
  if (!preset) {
    if (typeof showToast === 'function') showToast('Preset not found', 'danger');
    return;
  }
  applyLayout(preset.layout);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(preset.layout)); } catch(_) {}
  setTimeout(function() {
    document.querySelectorAll('.dashboard-widget').forEach(resizeChartsIn);
  }, 100);
  if (typeof showToast === 'function') showToast('Layout \u201c' + name + '\u201d applied', 'success');
  renderPresetsPanel();
}

// ── Set a preset as the reset default ─────────────────────────────────────────
function setPresetAsDefault(name) {
  try { localStorage.setItem(ACTIVE_DEFAULT_KEY, name); } catch(_) {}
  if (typeof showToast === 'function') showToast('\u201c' + name + '\u201d is now the default layout', 'success');
  renderPresetsPanel();
}

// ── Clear the custom default (revert to built-in) ─────────────────────────────
function clearCustomDefault() {
  try { localStorage.removeItem(ACTIVE_DEFAULT_KEY); } catch(_) {}
  if (typeof showToast === 'function') showToast('Reset target restored to built-in default', 'success');
  renderPresetsPanel();
}

// ── Delete a named preset ─────────────────────────────────────────────────────
function deletePreset(name) {
  var presets = loadAllPresets().filter(function(p) { return p.name !== name; });
  saveAllPresets(presets);
  // If this was the active default, clear it
  try {
    if (localStorage.getItem(ACTIVE_DEFAULT_KEY) === name) {
      localStorage.removeItem(ACTIVE_DEFAULT_KEY);
    }
  } catch(_) {}
  if (typeof showToast === 'function') showToast('Layout \u201c' + name + '\u201d deleted', 'success');
  renderPresetsPanel();
}

// ── Open/close presets panel ───────────────────────────────────────────────────
function openLayoutPresetsPanel() {
  var panel = document.getElementById('layout-presets-panel');
  var btn   = document.getElementById('btn-layout-presets');
  if (!panel) return;

  // If already open, close it (toggle)
  if (panel.classList.contains('open')) {
    closeLayoutPresetsPanel();
    return;
  }

  renderPresetsPanel();

  // Position below the button using fixed coords (escapes overflow:hidden)
  if (btn) {
    var rect = btn.getBoundingClientRect();
    panel.style.top  = (rect.bottom + 8) + 'px';
    panel.style.left = rect.left + 'px';
    // Prevent overflow off right edge of viewport
    var panelW = 340;
    if (rect.left + panelW > window.innerWidth - 8) {
      panel.style.left = (window.innerWidth - panelW - 8) + 'px';
    }
  }

  panel.classList.add('open');

  // Click-outside to close
  setTimeout(function() {
    document.addEventListener('mousedown', _presetsOutsideClick);
  }, 50);
}

function closeLayoutPresetsPanel() {
  var panel = document.getElementById('layout-presets-panel');
  if (panel) panel.classList.remove('open');
  document.removeEventListener('mousedown', _presetsOutsideClick);
}

function _presetsOutsideClick(e) {
  var panel = document.getElementById('layout-presets-panel');
  var btn   = document.getElementById('btn-layout-presets');
  if (panel && !panel.contains(e.target) && btn && !btn.contains(e.target)) {
    closeLayoutPresetsPanel();
  }
}

// ── Render the presets panel contents ─────────────────────────────────────────
function renderPresetsPanel() {
  var panel = document.getElementById('layout-presets-panel');
  if (!panel) return;

  var presets     = loadAllPresets();
  var activeDefault = '';
  try { activeDefault = localStorage.getItem(ACTIVE_DEFAULT_KEY) || ''; } catch(_) {}

  // ── Save-new section ──
  var html = '<div class="lpp-section">';
  html += '<div class="lpp-section-title">💾 Save Current Layout</div>';
  html += '<div class="lpp-save-row">';
  html += '<input id="lpp-name-input" class="lpp-name-input" type="text" placeholder="Layout name…" maxlength="40" autocomplete="off">';
  html += '<button class="lpp-btn lpp-btn-save" onclick="_lppSave()">Save</button>';
  html += '</div>';
  html += '</div>';

  // ── Preset list ──
  html += '<div class="lpp-section">';
  html += '<div class="lpp-section-title">📋 Saved Layouts';
  if (presets.length > 0) html += ' <span class="lpp-count">' + presets.length + '</span>';
  html += '</div>';

  if (presets.length === 0) {
    html += '<div class="lpp-empty">No saved layouts yet.<br>Arrange the dashboard then save a layout above.</div>';
  } else {
    html += '<div class="lpp-list">';
    presets.forEach(function(p) {
      var isDefault = (p.name === activeDefault);
      html += '<div class="lpp-item' + (isDefault ? ' lpp-item-default' : '') + '">';
      html += '<div class="lpp-item-info">';
      html += '<span class="lpp-item-name">' + _escHtmlLpp(p.name) + '</span>';
      if (isDefault) html += '<span class="lpp-default-badge">🔒 Default</span>';
      html += '<span class="lpp-item-date">' + _lppFmtDate(p.savedAt) + '</span>';
      html += '</div>';
      html += '<div class="lpp-item-actions">';
      var encodedName = JSON.stringify(p.name).replace(/"/g, '&quot;');
      html += '<button class="lpp-btn lpp-btn-apply" onclick="applyPreset(' + encodedName + ')" title="Apply this layout">Apply</button>';
      if (isDefault) {
        html += '<button class="lpp-btn lpp-btn-unpin" onclick="clearCustomDefault()" title="Remove as default">Unpin</button>';
      } else {
        html += '<button class="lpp-btn lpp-btn-pin" onclick="setPresetAsDefault(' + encodedName + ')" title="Set as reset default">Set Default</button>';
      }
      html += '<button class="lpp-btn lpp-btn-del" onclick="_lppConfirmDelete(' + encodedName + ')" title="Delete">🗑</button>';
      html += '</div>';
      html += '</div>';
    });
    html += '</div>';
  }

  // Built-in default info
  html += '<div class="lpp-builtin-note">';
  if (activeDefault) {
    html += '↺ Reset will restore <strong>\u201c' + _escHtmlLpp(activeDefault) + '\u201d</strong>.';
  } else {
    html += '↺ Reset will restore the <strong>built-in</strong> default layout.';
  }
  html += '</div>';

  html += '</div>'; // /lpp-section

  panel.innerHTML = html;

  // Bind Enter key for the input
  var inp = document.getElementById('lpp-name-input');
  if (inp) inp.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') _lppSave();
  });
}

function _lppSave() {
  var inp  = document.getElementById('lpp-name-input');
  var name = inp ? inp.value.trim() : '';
  if (saveCurrentAsPreset(name)) {
    if (inp) inp.value = '';
    renderPresetsPanel();
  }
}

function _lppConfirmDelete(name) {
  if (confirm('Delete layout \u201c' + name + '\u201d?')) deletePreset(name);
}

function _lppFmtDate(iso) {
  if (!iso) return '';
  try {
    var d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch(_) { return ''; }
}

function _escHtmlLpp(str) {
  if (str == null) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Init — called from manager.js loadManagerDashboard() ──────────────────────
function initDashboardGrid() {
  requestAnimationFrame(function() {
    var layout = loadLayout();
    applyLayout(layout);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROGRESS CHARTS GRID — parallel drag/resize system for the admin Progress
// Charts panel.  Uses the global `charts` map from progress-charts.js.
// All IDs, storage keys, and DOM targets are prefixed with `pc` / `progress`
// so they never collide with the manager dashboard above.
// ═══════════════════════════════════════════════════════════════════════════════

const PC_STORAGE_KEY        = 'progress_dashboard_layout_v2';
const PC_PRESETS_KEY        = 'progress_dashboard_presets_v1';
const PC_ACTIVE_DEFAULT_KEY = 'progress_dashboard_default_v1';

// ── Default layout — "sample1" preset saved by ranjeeta (admin) ───────────────
// Positions and sizes are exact copies of the saved preset so every new system
// opens the Progress Charts panel with this layout out of the box.
const PC_DEFAULT_LAYOUT = [
  { id: 'pc-kpi',             col: 1, row:  1, colSpan: 12, rowSpan: 1, height: ''      },
  { id: 'pc-by-date',         col: 1, row:  2, colSpan:  4, rowSpan: 2, height: '416px' },
  { id: 'pc-status',          col: 5, row:  2, colSpan:  4, rowSpan: 2, height: '416px' },
  { id: 'pc-per-user',        col: 9, row:  2, colSpan:  4, rowSpan: 2, height: '416px' },
  { id: 'pc-revenue',         col: 1, row:  6, colSpan:  4, rowSpan: 2, height: '416px' },
  { id: 'pc-journal-rev',     col: 5, row:  6, colSpan:  4, rowSpan: 2, height: '416px' },
  { id: 'pc-invoice-donut',   col: 9, row:  6, colSpan:  4, rowSpan: 2, height: '416px' },
  { id: 'pc-campaign',        col: 1, row: 10, colSpan:  4, rowSpan: 2, height: '400px' },
  { id: 'pc-reach-journal',   col: 5, row: 10, colSpan:  4, rowSpan: 2, height: '400px' },
  { id: 'pc-admin-perf',      col: 9, row: 10, colSpan:  4, rowSpan: 2, height: '400px' },
  { id: 'pc-recent-invoices', col: 1, row: 12, colSpan: 12, rowSpan: 2, height: ''      },
];

let pcEditMode = false;

// ── Helpers ──────────────────────────────────────────────────────────────────

function _pcGetWidget(id) {
  return document.getElementById('widget-' + id);
}

function _pcColUnit() {
  var grid = document.getElementById('progress-dashboard-grid');
  return grid ? grid.clientWidth / GRID_COLS : 80;
}

// ── Resize all Chart.js instances inside a widget (uses `charts` global) ─────

function resizeProgressChartsIn(el) {
  if (typeof charts === 'undefined') return;
  var canvases = el.querySelectorAll('canvas');
  canvases.forEach(function(c) {
    var key = Object.keys(charts).find(function(k) {
      return charts[k] && charts[k].canvas === c;
    });
    if (key && charts[key]) {
      try { charts[key].resize(); } catch(_) {}
    }
  });
}

// ── Layout persistence ────────────────────────────────────────────────────────

function _pcSaveLayout() {
  var layout = PC_DEFAULT_LAYOUT.map(function(def) {
    var el = _pcGetWidget(def.id);
    if (!el) return def;
    var ceStr = el.style.gridColumnEnd || '';
    var reStr = el.style.gridRowEnd    || '';
    var colM  = ceStr.match(/span\s+(\d+)/);
    var rowM  = reStr.match(/span\s+(\d+)/);
    return {
      id:      def.id,
      col:     parseInt(el.style.gridColumnStart) || def.col,
      row:     parseInt(el.style.gridRowStart)    || def.row,
      colSpan: colM ? parseInt(colM[1]) : def.colSpan,
      rowSpan: rowM ? parseInt(rowM[1]) : def.rowSpan,
      height:  el.style.height || '',
    };
  });
  try { localStorage.setItem(PC_STORAGE_KEY, JSON.stringify(layout)); } catch(_) {}
}

function _pcLoadLayout() {
  try {
    var stored = localStorage.getItem(PC_STORAGE_KEY);
    return stored ? JSON.parse(stored) : PC_DEFAULT_LAYOUT;
  } catch(_) { return PC_DEFAULT_LAYOUT; }
}

function _pcApplyLayout(layout) {
  layout.forEach(function(item) {
    var el = _pcGetWidget(item.id);
    if (!el) return;
    el.style.gridColumnStart = item.col;
    el.style.gridColumnEnd   = 'span ' + item.colSpan;
    el.style.gridRowStart    = item.row;
    el.style.gridRowEnd      = 'span ' + item.rowSpan;
    el.style.height = item.height || '';
  });
}

// ── Drag ──────────────────────────────────────────────────────────────────────

function _makeProgressDraggable() {
  try { interact('#progress-dashboard-grid .dashboard-widget').unset(); } catch(_) {}

  var startX = 0, startY = 0;

  interact('#progress-dashboard-grid .dashboard-widget').draggable({
    allowFrom:  '.widget-drag-handle',
    inertia:    false,
    autoScroll: true,
    listeners: {
      start: function(event) {
        startX = 0; startY = 0;
        event.target.classList.add('widget-dragging');
        event.target.style.zIndex  = '999';
        event.target.style.opacity = '0.82';
      },
      move: function(event) {
        startX += event.dx;
        startY += event.dy;
        event.target.style.transform = 'translate(' + startX + 'px,' + startY + 'px)';
      },
      end: function(event) {
        var target = event.target;
        var movedRect = target.getBoundingClientRect();

        target.style.transform = '';
        target.style.zIndex    = '';
        target.style.opacity   = '';
        target.classList.remove('widget-dragging');

        var grid     = document.getElementById('progress-dashboard-grid');
        var gridRect = grid.getBoundingClientRect();
        var colUnit  = _pcColUnit();

        // ── Column placement (unchanged, works fine) ──────────────────────
        var relX = (movedRect.left + movedRect.width / 2) - gridRect.left;
        var colSpanStr = target.style.gridColumnEnd || 'span 6';
        var colSpanM   = colSpanStr.match(/span\s+(\d+)/);
        var colSpan    = colSpanM ? parseInt(colSpanM[1]) : 6;

        var rawCol    = Math.round((relX - (colSpan * colUnit) / 2) / colUnit) + 1;
        var targetCol = Math.max(1, Math.min(rawCol, GRID_COLS - colSpan + 1));

        // ── Row placement — map pixel Y to actual grid rows ───────────────
        // Drop centre Y relative to the grid container (account for scroll)
        var dropY = (movedRect.top + movedRect.height / 2) - gridRect.top
                    + grid.scrollTop;

        // Build a map: gridRowStart → pixelTop for every other widget
        // so we can find the closest real row number.
        var rowMap = [];   // [{ row, pixelTop }]
        var allWidgets = grid.querySelectorAll('.dashboard-widget');
        allWidgets.forEach(function(w) {
          if (w === target) return;
          var r = parseInt(w.style.gridRowStart);
          if (!r) return;
          var wRect = w.getBoundingClientRect();
          var wTop  = wRect.top - gridRect.top + grid.scrollTop;
          rowMap.push({ row: r, pixelTop: wTop });
        });

        var targetRow;
        if (rowMap.length === 0) {
          // No reference points — fall back to a simple estimate
          var estRowH = 260; // px per row band
          targetRow = Math.max(1, Math.round(dropY / estRowH) + 1);
        } else {
          // Sort by pixelTop
          rowMap.sort(function(a, b) { return a.pixelTop - b.pixelTop; });

          // Find the closest row by pixel distance
          var best = rowMap[0];
          var bestDist = Math.abs(dropY - best.pixelTop);
          for (var i = 1; i < rowMap.length; i++) {
            var dist = Math.abs(dropY - rowMap[i].pixelTop);
            if (dist < bestDist) { bestDist = dist; best = rowMap[i]; }
          }

          // Also consider a new row *after* the last widget
          var lastEntry = rowMap[rowMap.length - 1];
          var lastWidget = grid.querySelector('[style*="grid-row-start: ' + lastEntry.row + '"], .dashboard-widget');
          // Estimate pixel top of the row *after* the last widget
          var afterLastTop = lastEntry.pixelTop + 280;
          if (Math.abs(dropY - afterLastTop) < bestDist) {
            // Place after the last occupied row
            var maxRow = Math.max.apply(null, rowMap.map(function(r) { return r.row; }));
            var rowSpanStr2 = target.style.gridRowEnd || 'span 2';
            var rowSpanM2   = rowSpanStr2.match(/span\s+(\d+)/);
            var rowSpan2    = rowSpanM2 ? parseInt(rowSpanM2[1]) : 2;
            targetRow = maxRow + rowSpan2;
          } else {
            targetRow = best.row;
          }
        }

        targetRow = Math.max(1, targetRow);

        var rowSpanStr = target.style.gridRowEnd || 'span 2';
        var rowSpanM   = rowSpanStr.match(/span\s+(\d+)/);
        var rowSpan    = rowSpanM ? parseInt(rowSpanM[1]) : 2;

        // ── Collision nudge: if exact row/col overlaps another widget, bump down ──
        var placed = false;
        var tryRow = targetRow;
        for (var attempt = 0; attempt < 20 && !placed; attempt++) {
          var overlap = false;
          allWidgets.forEach(function(w) {
            if (w === target || overlap) return;
            var wCol     = parseInt(w.style.gridColumnStart) || 1;
            var wColSpan = (function() {
              var ce = w.style.gridColumnEnd || '';
              var m  = ce.match(/span\s+(\d+)/);
              return m ? parseInt(m[1]) : 6;
            })();
            var wRow     = parseInt(w.style.gridRowStart) || 1;
            var wRowSpan = (function() {
              var re = w.style.gridRowEnd || '';
              var m  = re.match(/span\s+(\d+)/);
              return m ? parseInt(m[1]) : 2;
            })();

            // Check grid-area overlap
            var colOverlap = targetCol < wCol + wColSpan && targetCol + colSpan > wCol;
            var rowOverlap = tryRow    < wRow + wRowSpan && tryRow    + rowSpan  > wRow;
            if (colOverlap && rowOverlap) overlap = true;
          });

          if (!overlap) {
            placed = true;
          } else {
            tryRow++;
          }
        }

        target.style.gridColumnStart = targetCol;
        target.style.gridColumnEnd   = 'span ' + colSpan;
        target.style.gridRowStart    = tryRow;
        target.style.gridRowEnd      = 'span ' + rowSpan;

        _pcSaveLayout();
        setTimeout(function() { resizeProgressChartsIn(target); }, 60);
      },
    },
  });
}

// ── Resize ────────────────────────────────────────────────────────────────────


function _makeProgressResizable() {
  var startW = 0, startH = 0;

  // Local snap helper that always reads the PROGRESS grid width, not the
  // manager grid (COL_UNIT_PX reads #dashboard-grid and would give wrong values).
  function _pcSnapToCol(px) {
    var unit = _pcColUnit();
    return Math.max(MIN_W_COLS, Math.round(px / unit));
  }

  interact('#progress-dashboard-grid .dashboard-widget').resizable({
    edges:     { right: true, bottom: true, left: false, top: false },
    allowFrom: '.widget-resize-handle',
    inertia:   false,
    modifiers: [],
    listeners: {
      start: function(event) {
        var target = event.target;
        startW = target.offsetWidth;
        startH = target.offsetHeight;
        // Lock a pixel width so the grid cell does not collapse while dragging
        target.style.width = startW + 'px';
      },
      move: function(event) {
        var target  = event.target;
        var colUnit = _pcColUnit();

        // --- Width (column span) ---
        var newW        = Math.max(event.rect.width, MIN_W_COLS * colUnit);
        var colStart    = parseInt(target.style.gridColumnStart) || 1;
        var maxCols     = GRID_COLS - colStart + 1;
        var snappedCols = Math.min(_pcSnapToCol(newW), maxCols);
        target.style.gridColumnEnd = 'span ' + snappedCols;
        // Remove the pixel width lock so the grid controls width again
        target.style.width = '';

        // --- Height ---
        var newH     = Math.max(event.rect.height, MIN_H_PX);
        var snappedH = snapToRow(newH);
        target.style.height    = snappedH + 'px';
        target.style.minHeight = MIN_H_PX + 'px';

        // --- Live chart resize ---
        resizeProgressChartsIn(target);
      },
      end: function(event) {
        event.target.style.width = ''; // ensure no leftover pixel width
        _pcSaveLayout();
        requestAnimationFrame(function() { resizeProgressChartsIn(event.target); });
      },
    },
  });
}

// ── Toggle edit mode ──────────────────────────────────────────────────────────

function toggleProgressEdit() {
  pcEditMode = !pcEditMode;
  var grid  = document.getElementById('progress-dashboard-grid');
  var icon  = document.getElementById('pc-edit-layout-icon');
  var label = document.getElementById('pc-edit-layout-label');
  var btn   = document.getElementById('pc-btn-edit-layout');

  if (pcEditMode) {
    grid.classList.add('edit-mode');
    icon.textContent  = '✅';
    label.textContent = 'Done';
    btn.classList.add('active');
    _makeProgressDraggable();
    _makeProgressResizable();
  } else {
    grid.classList.remove('edit-mode');
    icon.textContent  = '✏️';
    label.textContent = 'Edit Layout';
    btn.classList.remove('active');
    try {
      interact('#progress-dashboard-grid .dashboard-widget').draggable({ enabled: false });
      interact('#progress-dashboard-grid .dashboard-widget').resizable({ enabled: false });
    } catch(_) {}
  }
}

// ── Reset ─────────────────────────────────────────────────────────────────────

function resetProgressLayout() {
  try { localStorage.removeItem(PC_STORAGE_KEY); } catch(_) {}

  var resetLayout = PC_DEFAULT_LAYOUT;
  try {
    var activeName = localStorage.getItem(PC_ACTIVE_DEFAULT_KEY);
    if (activeName) {
      var presets = _pcLoadAllPresets();
      var found   = presets.find(function(p) { return p.name === activeName; });
      if (found) resetLayout = found.layout;
    }
  } catch(_) {}

  _pcApplyLayout(resetLayout);
  setTimeout(function() {
    document.querySelectorAll('#progress-dashboard-grid .dashboard-widget').forEach(resizeProgressChartsIn);
  }, 100);
  if (typeof showToast === 'function') showToast('Progress layout reset to default', 'success');
}

// ── Preset helpers ────────────────────────────────────────────────────────────

function _pcLoadAllPresets() {
  try {
    var raw = localStorage.getItem(PC_PRESETS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch(_) { return []; }
}

function _pcSaveAllPresets(presets) {
  try { localStorage.setItem(PC_PRESETS_KEY, JSON.stringify(presets)); } catch(_) {}
}

function _pcCaptureLayout() {
  return PC_DEFAULT_LAYOUT.map(function(def) {
    var el = _pcGetWidget(def.id);
    if (!el) return def;
    var ceStr = el.style.gridColumnEnd || '';
    var reStr = el.style.gridRowEnd    || '';
    var colM  = ceStr.match(/span\s+(\d+)/);
    var rowM  = reStr.match(/span\s+(\d+)/);
    return {
      id:      def.id,
      col:     parseInt(el.style.gridColumnStart) || def.col,
      row:     parseInt(el.style.gridRowStart)    || def.row,
      colSpan: colM ? parseInt(colM[1]) : def.colSpan,
      rowSpan: rowM ? parseInt(rowM[1]) : def.rowSpan,
      height:  el.style.height || '',
    };
  });
}

function _pcSavePreset(name) {
  name = (name || '').trim();
  if (!name) {
    if (typeof showToast === 'function') showToast('Please enter a layout name', 'warning');
    return false;
  }
  var presets  = _pcLoadAllPresets();
  var existing = presets.findIndex(function(p) { return p.name === name; });
  var layout   = _pcCaptureLayout();
  if (existing >= 0) {
    presets[existing].layout  = layout;
    presets[existing].savedAt = new Date().toISOString();
  } else {
    presets.push({ name: name, layout: layout, savedAt: new Date().toISOString() });
  }
  _pcSaveAllPresets(presets);
  if (typeof showToast === 'function') showToast('Layout \u201c' + name + '\u201d saved!', 'success');
  return true;
}

function applyProgressPreset(name) {
  var preset = _pcLoadAllPresets().find(function(p) { return p.name === name; });
  if (!preset) { if (typeof showToast === 'function') showToast('Preset not found', 'danger'); return; }
  _pcApplyLayout(preset.layout);
  try { localStorage.setItem(PC_STORAGE_KEY, JSON.stringify(preset.layout)); } catch(_) {}
  setTimeout(function() {
    document.querySelectorAll('#progress-dashboard-grid .dashboard-widget').forEach(resizeProgressChartsIn);
  }, 100);
  if (typeof showToast === 'function') showToast('Layout \u201c' + name + '\u201d applied', 'success');
  _pcRenderPresetsPanel();
}

function setProgressPresetDefault(name) {
  try { localStorage.setItem(PC_ACTIVE_DEFAULT_KEY, name); } catch(_) {}
  if (typeof showToast === 'function') showToast('\u201c' + name + '\u201d is now the default layout', 'success');
  _pcRenderPresetsPanel();
}

function clearProgressCustomDefault() {
  try { localStorage.removeItem(PC_ACTIVE_DEFAULT_KEY); } catch(_) {}
  if (typeof showToast === 'function') showToast('Reset target restored to built-in default', 'success');
  _pcRenderPresetsPanel();
}

function deleteProgressPreset(name) {
  var presets = _pcLoadAllPresets().filter(function(p) { return p.name !== name; });
  _pcSaveAllPresets(presets);
  try {
    if (localStorage.getItem(PC_ACTIVE_DEFAULT_KEY) === name) localStorage.removeItem(PC_ACTIVE_DEFAULT_KEY);
  } catch(_) {}
  if (typeof showToast === 'function') showToast('Layout \u201c' + name + '\u201d deleted', 'success');
  _pcRenderPresetsPanel();
}

// ── Presets panel open/close ──────────────────────────────────────────────────

function openProgressPresetsPanel() {
  var panel = document.getElementById('pc-layout-presets-panel');
  var btn   = document.getElementById('pc-btn-layout-presets');
  if (!panel) return;

  if (panel.classList.contains('open')) { closeProgressPresetsPanel(); return; }

  _pcRenderPresetsPanel();

  if (btn) {
    var rect   = btn.getBoundingClientRect();
    var panelW = 340;
    panel.style.top  = (rect.bottom + 8) + 'px';
    panel.style.left = Math.min(rect.left, window.innerWidth - panelW - 8) + 'px';
  }

  panel.classList.add('open');
  setTimeout(function() { document.addEventListener('mousedown', _pcOutsideClick); }, 50);
}

function closeProgressPresetsPanel() {
  var panel = document.getElementById('pc-layout-presets-panel');
  if (panel) panel.classList.remove('open');
  document.removeEventListener('mousedown', _pcOutsideClick);
}

function _pcOutsideClick(e) {
  var panel = document.getElementById('pc-layout-presets-panel');
  var btn   = document.getElementById('pc-btn-layout-presets');
  if (panel && !panel.contains(e.target) && btn && !btn.contains(e.target)) {
    closeProgressPresetsPanel();
  }
}

// ── Render presets panel HTML ─────────────────────────────────────────────────

function _pcRenderPresetsPanel() {
  var panel = document.getElementById('pc-layout-presets-panel');
  if (!panel) return;

  var presets       = _pcLoadAllPresets();
  var activeDefault = '';
  try { activeDefault = localStorage.getItem(PC_ACTIVE_DEFAULT_KEY) || ''; } catch(_) {}

  var html = '<div class="lpp-section">';
  html += '<div class="lpp-section-title">💾 Save Current Layout</div>';
  html += '<div class="lpp-save-row">';
  html += '<input id="pc-lpp-name-input" class="lpp-name-input" type="text" placeholder="Layout name…" maxlength="40" autocomplete="off">';
  html += '<button class="lpp-btn lpp-btn-save" onclick="_pcLppSave()">Save</button>';
  html += '</div></div>';

  html += '<div class="lpp-section">';
  html += '<div class="lpp-section-title">📋 Saved Layouts';
  if (presets.length > 0) html += ' <span class="lpp-count">' + presets.length + '</span>';
  html += '</div>';

  if (presets.length === 0) {
    html += '<div class="lpp-empty">No saved layouts yet.<br>Arrange the widgets then save a layout above.</div>';
  } else {
    html += '<div class="lpp-list">';
    presets.forEach(function(p) {
      var isDefault   = (p.name === activeDefault);
      var encodedName = JSON.stringify(p.name).replace(/"/g, '&quot;');
      html += '<div class="lpp-item' + (isDefault ? ' lpp-item-default' : '') + '">';
      html += '<div class="lpp-item-info">';
      html += '<span class="lpp-item-name">' + _escHtmlLpp(p.name) + '</span>';
      if (isDefault) html += '<span class="lpp-default-badge">🔒 Default</span>';
      html += '<span class="lpp-item-date">' + _lppFmtDate(p.savedAt) + '</span>';
      html += '</div>';
      html += '<div class="lpp-item-actions">';
      html += '<button class="lpp-btn lpp-btn-apply" onclick="applyProgressPreset(' + encodedName + ')" title="Apply">Apply</button>';
      if (isDefault) {
        html += '<button class="lpp-btn lpp-btn-unpin" onclick="clearProgressCustomDefault()" title="Remove as default">Unpin</button>';
      } else {
        html += '<button class="lpp-btn lpp-btn-pin" onclick="setProgressPresetDefault(' + encodedName + ')" title="Set as default">Set Default</button>';
      }
      html += '<button class="lpp-btn lpp-btn-del" onclick="_pcLppConfirmDelete(' + encodedName + ')" title="Delete">🗑</button>';
      html += '</div></div>';
    });
    html += '</div>';
  }

  html += '<div class="lpp-builtin-note">';
  if (activeDefault) {
    html += '↺ Reset will restore <strong>\u201c' + _escHtmlLpp(activeDefault) + '\u201d</strong>.';
  } else {
    html += '↺ Reset will restore the <strong>built-in</strong> default layout.';
  }
  html += '</div></div>';

  panel.innerHTML = html;

  var inp = document.getElementById('pc-lpp-name-input');
  if (inp) inp.addEventListener('keydown', function(e) { if (e.key === 'Enter') _pcLppSave(); });
}

function _pcLppSave() {
  var inp  = document.getElementById('pc-lpp-name-input');
  var name = inp ? inp.value.trim() : '';
  if (_pcSavePreset(name)) {
    if (inp) inp.value = '';
    _pcRenderPresetsPanel();
  }
}

function _pcLppConfirmDelete(name) {
  if (confirm('Delete layout \u201c' + name + '\u201d?')) deleteProgressPreset(name);
}

// ── Init — called from progress-charts.js after charts render ─────────────────

function initProgressGrid() {
  requestAnimationFrame(function() {
    var layout = _pcLoadLayout();
    _pcApplyLayout(layout);
    // Trigger a resize pass so charts fill their new widget dimensions
    setTimeout(function() {
      document.querySelectorAll('#progress-dashboard-grid .dashboard-widget').forEach(resizeProgressChartsIn);
    }, 80);
  });
}
