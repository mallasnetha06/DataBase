/* ═══════════════════════════════════════════════════════════════════════════
   DataBase — js/auth.js
   Login · Register · Logout · Boot app after authentication
   Depends on: core.js
   Updated: added manager role support in bootApp()
   Updated: added campaigner role + register team-lead dropdown
═══════════════════════════════════════════════════════════════════════════ */

function switchAuthTab(tab) {
  const isLogin = tab === 'login';
  document.getElementById('login-form').classList.toggle('hidden', !isLogin);
  document.getElementById('register-form').classList.toggle('hidden', isLogin);
  document.getElementById('tab-login').classList.toggle('active', isLogin);
  document.getElementById('tab-register').classList.toggle('active', !isLogin);

  // Populate team-lead dropdown when switching to register tab
  if (!isLogin) _loadAdminsDropdown();
}

// ── Register: role selector change ───────────────────────────────────────────
function onRegRoleChange() {
  const role  = document.getElementById('reg-role').value;
  const group = document.getElementById('reg-teamlead-group');
  group.style.display = role === 'standard' ? '' : 'none';

  // If switching to standard and the dropdown only has the placeholder, reload admins
  if (role === 'standard') {
    const sel = document.getElementById('reg-teamlead');
    if (sel.options.length <= 1) _loadAdminsDropdown();
  }
}

// ── Fetch admin list and populate team-lead dropdown ─────────────────────────
async function _loadAdminsDropdown() {
  const sel = document.getElementById('reg-teamlead');
  try {
    const admins = await api('GET', '/auth/admins');
    // Preserve placeholder option
    sel.innerHTML = '<option value="">-- Select your Team Lead --</option>';
    if (admins.length === 0) {
      const opt = document.createElement('option');
      opt.disabled = true;
      opt.textContent = '(No team leads available yet)';
      sel.appendChild(opt);
    } else {
      admins.forEach(a => {
        const opt = document.createElement('option');
        opt.value       = a.id;
        opt.textContent = a.username;
        sel.appendChild(opt);
      });
    }
  } catch (err) {
    // Show a visible hint in the dropdown instead of silently failing
    sel.innerHTML = '<option value="" disabled>⚠ Could not load team leads</option>';
    console.warn('[_loadAdminsDropdown] Failed to fetch /auth/admins:', err);
  }
}

// Pre-load admins list as soon as the page is ready (register tab may already be visible)
document.addEventListener('DOMContentLoaded', () => {
  _loadAdminsDropdown();
});

async function handleLogin(e) {
  e.preventDefault();
  const errEl = document.getElementById('login-error');
  errEl.style.display = 'none';
  setLoading('btn-login', true);
  try {
    const data = await api('POST', '/auth/login', {
      username: document.getElementById('login-username').value.trim(),
      password: document.getElementById('login-password').value,
    });
    token       = data.access_token;
    currentUser = { id: data.user_id, user_id: data.user_id, username: data.username, role: data.role };
    localStorage.setItem('db_token', token);
    localStorage.setItem('db_user', JSON.stringify(currentUser));
    bootApp();
  } catch (err) {
    errEl.textContent   = err.message;
    errEl.style.display = 'block';
  } finally {
    setLoading('btn-login', false);
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const msgEl = document.getElementById('register-msg');
  msgEl.style.display = 'none';
  setLoading('btn-register', true);

  const role        = document.getElementById('reg-role').value;
  const teamLeadRaw = document.getElementById('reg-teamlead').value;
  const teamLeadId  = (role === 'standard' && teamLeadRaw) ? parseInt(teamLeadRaw, 10) : null;

  try {
    const res = await api('POST', '/auth/register', {
      username:     document.getElementById('reg-username').value.trim(),
      password:     document.getElementById('reg-password').value,
      role,
      team_lead_id: teamLeadId,
    });
    msgEl.style.color   = 'var(--success)';
    msgEl.textContent   = res.message;
    msgEl.style.display = 'block';
    document.getElementById('register-form').reset();
    onRegRoleChange(); // restore team-lead group visibility
  } catch (err) {
    msgEl.style.color   = 'var(--danger)';
    msgEl.textContent   = err.message;
    msgEl.style.display = 'block';
  } finally {
    setLoading('btn-register', false);
  }
}

function logout() {
  token = null; currentUser = null;
  localStorage.removeItem('db_token');
  localStorage.removeItem('db_user');
  document.getElementById('auth-screen').classList.remove('hidden');
  document.getElementById('app-screen').classList.add('hidden');
  document.getElementById('login-form').reset();
}

function bootApp() {
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('app-screen').classList.remove('hidden');

  const role         = currentUser.role;
  const isAdmin      = role === 'admin';
  const isManager    = role === 'manager';
  const isOverlord   = role === 'overlord';
  const isCampaigner = role === 'campaigner';
  const isSupport    = role === 'support';

  // isElevated: admin-only items are shown to admins and overlords only (NOT managers/campaigners/support)
  const isElevated = isAdmin || isOverlord;

  // Process all role-based visibility classes
  document.querySelectorAll('.admin-only, .manager-only, .non-manager, .overlord-only, .non-campaigner, .non-overlord').forEach(el => {
    let hide = false;
    if (el.classList.contains('admin-only') && !isElevated) hide = true;
    if (el.classList.contains('manager-only') && !(isManager || isOverlord)) hide = true;
    if (el.classList.contains('overlord-only') && !isOverlord) hide = true;
    if (el.classList.contains('non-overlord') && isOverlord) hide = true;
    if (el.classList.contains('non-manager') && isManager) hide = true;
    if (el.classList.contains('non-campaigner') && isCampaigner) hide = true;
    
    el.classList.toggle('hidden', hide);
  });

  // Update sidebar user info
  const av = document.getElementById('user-avatar');
  if (av) av.textContent = currentUser.username[0].toUpperCase();
  const un = document.getElementById('sidebar-username');
  if (un) un.textContent = currentUser.username;
  const roleEl = document.getElementById('sidebar-role');
  if (roleEl) { roleEl.textContent = role; roleEl.className = `user-role ${role}`; }

  // Pre-fill progress form with today's date
  const prDate = document.getElementById('pr-date');
  if (prDate && !prDate.value) prDate.value = today();

  // ── Navigate to the right landing page per role ────────────────────────────
  if (isManager) {
    // Manager lands directly on their Analytics Dashboard
    showPanel('manager-dashboard');
  } else if (isCampaigner) {
    // Campaigner lands on All Records (their primary page)
    showPanel('scraping-all');
  } else if (isSupport) {
    // Support users land directly on the Upload panel (their primary task)
    showPanel('scraping-upload');
  } else if (isOverlord) {
    // Overlord lands on the DB Console
    showPanel('overlord-db');
  } else {
    // Admin and standard users go to the generic dashboard
    showPanel('dashboard');
  }

  // Pending user badge (admin + overlord only)
  if (isElevated) loadPendingCount();

  // Initialise My Collection table headers so they show immediately on first visit
  renderMineTableHeaders();
}
