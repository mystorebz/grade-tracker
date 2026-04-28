import { logout, getSessionData } from './auth.js';

/**
 * Injects the Admin Sidebar and Topbar into the page.
 * @param {string}  activePageId - The ID of the current page (e.g., 'overview', 'teachers')
 * @param {string}  pageTitle    - The big title for the topbar
 * @param {string}  pageSub      - The small subtitle for the topbar
 * @param {boolean} showSearch   - Whether to show the topbar search input
 * @param {boolean} showPeriod   - Whether to show the period dropdown
 */
export function injectAdminLayout(activePageId, pageTitle, pageSub, showSearch = false, showPeriod = false) {

    // ── Read session ──────────────────────────────────────────────────────────
    const session      = getSessionData('admin') || {};
    const isSuperAdmin = session.isSuperAdmin === true;
    const schoolName   = session.schoolName || 'Your School';
    const schoolId     = session.schoolId   || '—';

    const displayName    = isSuperAdmin ? schoolName : (session.adminName || 'Administrator');
    const roleBadgeClass = isSuperAdmin ? 'sidebar-role-badge sidebar-role-super' : 'sidebar-role-badge sidebar-role-admin';
    const roleBadgeText  = isSuperAdmin ? 'Super Admin' : 'Administrator';

    // Initials for avatar fallback
    const initials = displayName.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

    // ── 1. Sidebar HTML ───────────────────────────────────────────────────────
    const sidebarHTML = `
      <aside id="sidebar" class="flex flex-col flex-shrink-0 h-screen z-20" style="width:256px">

        <div class="sidebar-brand">
          <div class="sidebar-brand-logo">
            <img src="../../assets/images/logo.png" alt="ConnectUs" style="width: 50px; height: 50px; min-width: 50px; border-radius: 50%; object-fit: contain; flex-shrink: 0;" onerror="this.parentElement.textContent='C'">
          </div>
          <span class="sidebar-brand-text">ConnectUs</span>
        </div>

        <div class="sidebar-profile">
          <div class="sidebar-profile-row">
            <div class="sidebar-avatar" id="sidebarAvatar">${initials}</div>
            <div>
              <p class="sidebar-school-name" id="displaySchoolName">${displayName}</p>
              <span class="${roleBadgeClass}">${roleBadgeText}</span>
            </div>
          </div>
        </div>

        <nav class="sidebar-nav">

          <span class="nav-section-label">Main Menu</span>
          <a href="../home/home.html"                id="nav-overview"    class="nav-item"><i class="fa-solid fa-chart-pie"></i> Overview</a>
          <a href="../teachers/teachers.html"        id="nav-teachers"    class="nav-item"><i class="fa-solid fa-chalkboard-user"></i> Teachers</a>
          <a href="../evaluations/evaluations.html"   id="nav-evaluations" class="nav-item"><i class="fa-solid fa-star-half-stroke"></i> Evaluations</a>
          <a href="../classes/classes.html"          id="nav-classes"     class="nav-item"><i class="fa-solid fa-school"></i> Classes</a>
          <a href="../students/students.html"        id="nav-students"    class="nav-item"><i class="fa-solid fa-user-graduate"></i> Students</a>
          <a href="../grading_periods/grading_periods.html" id="nav-semesters"   class="nav-item"><i class="fa-solid fa-calendar-days"></i> Grading Periods</a>

          <span class="nav-section-label">Grades &amp; Reports</span>
          <a href="../reports/reports.html"          id="nav-reports"     class="nav-item"><i class="fa-solid fa-chart-column"></i> Reports</a>

          <span class="nav-section-label">System</span>
          <a href="../settings/settings.html"        id="nav-settings"    class="nav-item"><i class="fa-solid fa-gear"></i> Settings</a>
          <a href="../archives/archives.html"        id="nav-archives"    class="nav-item"><i class="fa-solid fa-box-archive"></i> Archives</a>

          ${isSuperAdmin ? `
          <a href="../settings/settings.html#admins" id="nav-admins"  class="nav-item"><i class="fa-solid fa-user-shield"></i> Manage Admins</a>
          ` : ''}

        </nav>

        <div class="sidebar-footer">
          <div class="sidebar-school-id-block">
            <span class="sidebar-school-id-label">School ID</span>
            <span class="sidebar-school-id-val" id="sidebarSchoolId">${schoolId}</span>
          </div>
          <button id="logoutBtn" class="sidebar-logout-btn">
            <i class="fa-solid fa-power-off"></i> Log Out
          </button>
        </div>

      </aside>
    `;

    // ── 2. Topbar HTML ────────────────────────────────────────────────────────
    const topbarHTML = `
      <header class="topbar">
        <div>
          <h1 class="topbar-title">${pageTitle}</h1>
          <p class="topbar-sub">${pageSub}</p>
        </div>
        <div class="topbar-right">

          <div class="topbar-search ${showSearch ? '' : 'hidden'}" id="topbarSearch">
            <i class="fa-solid fa-magnifying-glass topbar-search-icon"></i>
            <input type="text" id="searchInput" placeholder="Search..." class="topbar-search-input">
          </div>

          <div class="topbar-period-wrap ${showPeriod ? '' : 'hidden'}" id="topbarPeriod">
            <i class="fa-solid fa-calendar-days topbar-period-icon"></i>
            <span class="topbar-period-label">Period:</span>
            <select id="globalPeriodSelect" class="topbar-period-select">
              <option value="">—</option>
            </select>
          </div>

          ${!isSuperAdmin ? `
          <div style="display:flex;align-items:center;gap:6px;background:rgba(37,99,235,0.06);border:1px solid rgba(37,99,235,0.15);border-radius:var(--r-md);padding:5px 10px;">
            <i class="fa-solid fa-user-shield" style="font-size:11px;color:var(--blue-500)"></i>
            <span style="font-size:11.5px;font-weight:600;color:var(--blue-600)">${session.adminName || 'Sub-Admin'}</span>
          </div>
          ` : ''}

        </div>
      </header>
    `;

    // ── 3. Inject ─────────────────────────────────────────────────────────────
    document.getElementById('layout-sidebar-container').innerHTML = sidebarHTML;
    document.getElementById('layout-topbar-container').innerHTML  = topbarHTML;

    // ── 4. Highlight active nav ───────────────────────────────────────────────
    const activeNav = document.getElementById(`nav-${activePageId}`);
    if (activeNav) activeNav.classList.add('active');

    // ── 5. Logout ─────────────────────────────────────────────────────────────
    document.getElementById('logoutBtn').addEventListener('click', () => {
        logout('../../admin/login.html');
    });
}

/* ==========================================================================
   CONNECTUS — ADMIN PORTAL
   Unified Design System · 2026 Edition

   FONT NOTE: Do NOT use @import here — it blocks rendering.
   Add this to every page's <head> instead:

   <link rel="preconnect" href="https://fonts.googleapis.com">
   <link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
   ========================================================================== */

/* ── DESIGN TOKENS ───────────────────────────────────────────────────────── */
:root {
  --page-bg:          #f4f7fb;
  --surface:          #ffffff;
  --border:           #dce3ed;
  --border-strong:    #b8c5d4;

  --text-primary:     #0d1f35;
  --text-secondary:   #374f6b;
  --text-muted:       #6b84a0;
  --text-faint:       #9ab0c6;

  --blue-50:          #eef4ff;
  --blue-100:         #c7d9fd;
  --blue-500:         #2563eb;
  --blue-600:         #1d4ed8;

  --green-50:         #edfaf4;
  --green-100:        #c6f0db;
  --green-200:        #89deb8;
  --green-500:        #0ea871;
  --green-600:        #0b8f5e;
  --green-700:        #08754d;
  --green-900:        #053d29;

  --rose-50:          #fff0f3;
  --rose-100:         #ffd6de;
  --rose-400:         #fb6f8a;
  --rose-500:         #e31b4a;
  --rose-600:         #be1240;

  --amber-50:         #fffbeb;
  --amber-100:        #fef3c7;
  --amber-500:        #f59e0b;

  --sb-bg:            #071929;
  --sb-border:        rgba(255,255,255,0.05);
  --sb-hover:         rgba(255,255,255,0.06);
  --sb-text:          rgba(255,255,255,0.65);
  --sb-muted:         rgba(255,255,255,0.35);
  --sb-accent:        #34d399;
  --sb-accent-bg:     rgba(52,211,153,0.10);
  --sb-accent-border: rgba(52,211,153,0.18);

  --r-sm:   6px;
  --r-md:   10px;
  --r-lg:   14px;
  --r-xl:   18px;

  --shadow-xs:    0 1px 2px rgba(13,31,53,0.06);
  --shadow-sm:    0 1px 3px rgba(13,31,53,0.09), 0 1px 2px rgba(13,31,53,0.05);
  --shadow-md:    0 4px 14px rgba(13,31,53,0.09), 0 2px 4px rgba(13,31,53,0.05);
  --shadow-blue:  0 0 0 3px rgba(37,99,235,0.18);
  --shadow-green: 0 0 0 3px rgba(14,168,113,0.20);
}

/* ── RESET & BASE ────────────────────────────────────────────────────────── */
*, *::before, *::after { box-sizing: border-box; }

html, body {
  margin: 0; padding: 0;
  width: 100%; height: 100%;
  overflow: hidden;
  font-family: 'DM Sans', ui-sans-serif, system-ui, sans-serif;
  font-size: 14px;
  background: var(--page-bg);
  color: var(--text-primary);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

::-webkit-scrollbar              { width: 5px; height: 5px; }
::-webkit-scrollbar-track        { background: transparent; }
::-webkit-scrollbar-thumb        { background: #c3cdd8; border-radius: 99px; }
::-webkit-scrollbar-thumb:hover { background: #9baab8; }

/* ── SIDEBAR SHELL ───────────────────────────────────────────────────────── */
#sidebar {
  background: var(--sb-bg) !important;
  border-right: 1px solid var(--sb-border) !important;
  box-shadow: 3px 0 28px rgba(0,0,0,0.25) !important;
}

/* ── SIDEBAR: BRAND ──────────────────────────────────────────────────────── */
.sidebar-brand {
  display: flex; align-items: center; gap: 10px;
  padding: 18px 20px 16px;
  border-bottom: 1px solid var(--sb-border);
}

.sidebar-brand-logo {
  width: 30px; height: 30px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0; overflow: hidden;
}

.sidebar-brand-logo img { width: 100%; height: 100%; object-fit: contain; }

.sidebar-brand-text {
  font-size: 14.5px; font-weight: 700;
  color: #ffffff; letter-spacing: -0.3px;
}

/* ── SIDEBAR: PROFILE CARD ───────────────────────────────────────────────── */
.sidebar-profile {
  margin: 12px 12px 4px; padding: 14px;
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: var(--r-lg);
}

.sidebar-profile-row { display: flex; align-items: center; gap: 10px; }

.sidebar-avatar {
  width: 36px; height: 36px; border-radius: 9px;
  background: linear-gradient(135deg, #1d4ed8, #0d1f35);
  color: #fff; font-size: 16px; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}

.sidebar-school-name {
  font-size: 13px; font-weight: 700;
  color: #ffffff; letter-spacing: -0.2px;
  margin: 0 0 3px; line-height: 1.3;
}

.sidebar-role-badge {
  display: inline-block; padding: 2px 8px; border-radius: 99px;
  font-size: 10px; font-weight: 600;
  letter-spacing: 0.05em; text-transform: uppercase;
}

.sidebar-role-super {
  background: rgba(52,211,153,0.12); border: 1px solid rgba(52,211,153,0.20);
  color: var(--sb-accent);
}

.sidebar-role-admin {
  background: rgba(96,165,250,0.12); border: 1px solid rgba(96,165,250,0.20);
  color: #93c5fd;
}

/* ── SIDEBAR: NAV ────────────────────────────────────────────────────────── */
.sidebar-nav { flex: 1; padding: 8px 10px; overflow-y: auto; }

.nav-section-label {
  font-size: 9.5px !important; font-weight: 700 !important;
  color: var(--sb-muted) !important;
  text-transform: uppercase !important; letter-spacing: 0.13em !important;
  padding: 0 10px !important; margin: 18px 0 4px !important; display: block;
}

.nav-item {
  display: flex !important; align-items: center !important; gap: 10px !important;
  padding: 9px 12px !important; margin: 1px 0 !important;
  border-radius: var(--r-md) !important;
  font-size: 13px !important; font-weight: 500 !important;
  color: var(--sb-text) !important; text-decoration: none !important;
  transition: background 0.14s, color 0.14s !important;
  position: relative !important; border: 1px solid transparent !important;
  letter-spacing: -0.1px !important; cursor: pointer;
}

.nav-item i {
  width: 15px; font-size: 12.5px; text-align: center;
  opacity: 0.55; flex-shrink: 0; transition: opacity 0.14s;
}

.nav-item:hover { background: var(--sb-hover) !important; color: rgba(255,255,255,0.92) !important; }
.nav-item:hover i { opacity: 0.9; }

.nav-item.active {
  background: var(--sb-accent-bg) !important;
  color: var(--sb-accent) !important;
  border-color: var(--sb-accent-border) !important;
  font-weight: 600 !important;
}

.nav-item.active i { opacity: 1; color: var(--sb-accent); }

.nav-item.active::before {
  content: ''; position: absolute; left: -10px; top: 22%; height: 56%;
  width: 3px; background: var(--sb-accent); border-radius: 0 3px 3px 0;
}

/* ── SIDEBAR: FOOTER ─────────────────────────────────────────────────────── */
.sidebar-footer {
  padding: 14px 12px; border-top: 1px solid var(--sb-border);
  display: flex; flex-direction: column; gap: 10px;
}

.sidebar-school-id-block {
  background: rgba(52,211,153,0.07); border: 1px solid rgba(52,211,153,0.14);
  border-radius: var(--r-md); padding: 8px 12px; text-align: center;
}

.sidebar-school-id-label {
  font-size: 9px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.14em;
  color: var(--sb-accent); margin: 0 0 2px; display: block;
}

.sidebar-school-id-val {
  font-family: 'DM Mono', 'Fira Mono', monospace;
  font-size: 13px; font-weight: 700;
  color: #ffffff; letter-spacing: 0.18em; margin: 0; display: block;
}

.sidebar-logout-btn {
  width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px;
  padding: 9px 16px; border-radius: var(--r-md);
  background: rgba(239,68,68,0.07); border: 1px solid rgba(239,68,68,0.15);
  color: #fca5a5; font-size: 13px; font-weight: 600; font-family: inherit;
  cursor: pointer; transition: background 0.15s, color 0.15s, border-color 0.15s;
}

.sidebar-logout-btn:hover { background: #ef4444; border-color: #ef4444; color: #ffffff; }

/* ── TOPBAR ──────────────────────────────────────────────────────────────── */
.topbar {
  background: var(--surface) !important;
  border-bottom: 1px solid var(--border) !important;
  box-shadow: var(--shadow-xs) !important;
  height: 54px !important;
  display: flex !important; align-items: center !important;
  justify-content: space-between !important;
  padding: 0 26px !important; flex-shrink: 0;
}

.topbar-title {
  font-size: 16px !important; font-weight: 700 !important;
  color: var(--text-primary) !important; letter-spacing: -0.3px !important;
  line-height: 1.2 !important; margin: 0 !important;
}

.topbar-sub {
  font-size: 11.5px !important; color: var(--text-muted) !important;
  font-weight: 400 !important; margin: 1px 0 0 !important;
}

.topbar-right { display: flex; align-items: center; gap: 10px; }

.topbar-search {
  display: flex; align-items: center; gap: 7px;
  background: var(--page-bg); border: 1px solid var(--border);
  border-radius: var(--r-md); padding: 7px 12px;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.topbar-search:focus-within { border-color: var(--blue-500); box-shadow: var(--shadow-blue); }
.topbar-search-icon { font-size: 12px; color: var(--text-faint); }

.topbar-search-input {
  border: none; background: transparent; outline: none;
  font-size: 13px; font-family: inherit;
  color: var(--text-primary); width: 160px; font-weight: 500;
}

.topbar-search-input::placeholder { color: var(--text-faint); }

.topbar-period-wrap {
  display: flex; align-items: center; gap: 7px;
  background: var(--blue-50); border: 1px solid var(--blue-100);
  border-radius: var(--r-md); padding: 7px 12px;
}

.topbar-period-icon  { font-size: 12px; color: var(--blue-500); flex-shrink: 0; }
.topbar-period-label { font-size: 10.5px; font-weight: 700; color: var(--blue-600); text-transform: uppercase; letter-spacing: 0.07em; white-space: nowrap; }
.topbar-period-select { background: transparent; border: none; outline: none; font-size: 13px; font-weight: 700; color: var(--blue-600); font-family: inherit; cursor: pointer; max-width: 140px; }
.topbar-logo { height: 28px; width: auto; opacity: 0.2; }

/* ── ANIMATIONS ──────────────────────────────────────────────────────────── */
@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
.view-section { animation: fadeIn 0.25s ease; }

/* ── STAT CARDS ──────────────────────────────────────────────────────────── */
.stat-card {
  background: var(--surface) !important; border: 1px solid var(--border) !important;
  border-radius: var(--r-lg) !important; box-shadow: var(--shadow-sm) !important;
  transition: box-shadow 0.18s, border-color 0.18s, transform 0.18s !important;
}

.stat-card:hover { border-color: var(--border-strong) !important; box-shadow: var(--shadow-md) !important; transform: translateY(-1px) !important; }

/* ── QUICK ACTION BUTTONS ────────────────────────────────────────────────── */
.qa-btn {
  display: flex !important; align-items: center !important; gap: 11px !important;
  padding: 12px 14px !important; background: var(--surface) !important;
  border: 1px solid var(--border) !important; border-radius: var(--r-md) !important;
  text-decoration: none !important; color: var(--text-primary) !important;
  font-size: 13px !important; font-weight: 600 !important; letter-spacing: -0.1px !important;
  transition: border-color 0.15s, box-shadow 0.15s, background 0.15s !important;
  box-shadow: var(--shadow-xs) !important; cursor: pointer;
}

.qa-btn:hover { border-color: var(--blue-500) !important; box-shadow: var(--shadow-blue) !important; background: var(--blue-50) !important; color: var(--blue-600) !important; }

.qa-icon {
  width: 32px !important; height: 32px !important; border-radius: var(--r-sm) !important;
  background: var(--blue-50) !important; border: 1px solid var(--blue-100) !important;
  color: var(--blue-500) !important; display: flex !important; align-items: center !important;
  justify-content: center !important; font-size: 12px !important; flex-shrink: 0 !important;
  transition: background 0.15s, border-color 0.15s !important;
}

.qa-btn:hover .qa-icon { background: var(--blue-100) !important; border-color: var(--blue-500) !important; }

/* ── TABLE ROWS ──────────────────────────────────────────────────────────── */
.trow, .gb-row { border-bottom: 1px solid #f0f4f9; transition: background 0.12s; }
.trow:hover, .gb-row:hover { background: #f8fafc !important; }
.gb-row:nth-child(even) { background: #fafbfc; }

/* ── FORM INPUTS ─────────────────────────────────────────────────────────── */
.form-input {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--r-md); font-size: 13.5px; color: var(--text-primary);
  font-family: inherit; transition: border-color 0.15s, box-shadow 0.15s; outline: none;
}

.form-input:focus { border-color: var(--blue-500); box-shadow: var(--shadow-blue); }
.form-input::placeholder { color: var(--text-faint); }

/* ── BUTTON PRIMITIVES ───────────────────────────────────────────────────── */
.btn-primary {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 9px 18px; background: var(--blue-500); color: #fff;
  border: none; border-radius: var(--r-md);
  font-size: 13.5px; font-weight: 600; font-family: inherit;
  cursor: pointer; transition: background 0.15s, box-shadow 0.15s, transform 0.15s;
  box-shadow: 0 1px 2px rgba(37,99,235,0.22);
}

.btn-primary:hover { background: var(--blue-600); box-shadow: 0 4px 12px rgba(37,99,235,0.28); transform: translateY(-1px); }
.btn-primary:disabled { opacity: 0.55; cursor: not-allowed; transform: none; }

.btn-secondary {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 8px 16px; background: var(--surface);
  color: var(--text-secondary); border: 1px solid var(--border);
  border-radius: var(--r-md); font-size: 13px; font-weight: 600;
  font-family: inherit; cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s; box-shadow: var(--shadow-xs);
}

.btn-secondary:hover { border-color: var(--border-strong); color: var(--text-primary); }

/* ── OVERLAYS & MODALS ───────────────────────────────────────────────────── */
.overlay { transition: opacity 0.2s ease; }
.overlay.opacity-0 { opacity: 0; pointer-events: none; }
.side-panel { transition: transform 0.32s cubic-bezier(0.4, 0, 0.2, 1); }

/* ── ACCORDIONS ──────────────────────────────────────────────────────────── */
.subject-body { overflow: hidden; transition: max-height 0.3s ease; max-height: 0; }
.subject-body.open { max-height: 2000px; }

/* ── TABS ────────────────────────────────────────────────────────────────── */
.stab {
  cursor: pointer; padding: 8px 18px; font-weight: 600; font-size: 13px;
  border-bottom: 2px solid transparent; color: var(--text-muted);
  transition: color 0.15s, border-color 0.15s;
  font-family: inherit; background: transparent;
  border-top: none; border-left: none; border-right: none;
}

.stab:hover { color: var(--text-secondary); }
.stab.active { border-bottom-color: var(--blue-500); color: var(--blue-500); font-weight: 700; }

/* ── BADGES ──────────────────────────────────────────────────────────────── */
.badge {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 3px 10px; border-radius: 99px;
  font-size: 11px; font-weight: 700; letter-spacing: 0.01em;
  text-transform: uppercase; white-space: nowrap;
}

.badge-active   { background: #dcfce7; color: #15803d; border: 1px solid #bbf7d0; }
.badge-archived { background: #fee2e2; color: #991b1b; border: 1px solid #fecaca; }
.badge-pending  { background: #fef3c7; color: #92400e; border: 1px solid #fde68a; }
.badge-info     { background: var(--blue-50); color: var(--blue-600); border: 1px solid var(--blue-100); }

.s-exc   { background: #dcfce7; color: #15803d; border: 1px solid #bbf7d0; }
.s-good  { background: var(--blue-50); color: var(--blue-600); border: 1px solid var(--blue-100); }
.s-track { background: #ccfbf1; color: #0f766e; border: 1px solid #99f6e4; }
.s-attn  { background: #fef3c7; color: #92400e; border: 1px solid #fde68a; }
.s-risk  { background: #fee2e2; color: #991b1b; border: 1px solid #fecaca; }
.s-none  { background: #f1f5f9; color: #475569; border: 1px solid #e2e8f0; }

/* ── GRADE COLORS ────────────────────────────────────────────────────────── */
.g-a { color: #15803d; font-weight: 700; }
.g-b { color: var(--blue-600); font-weight: 700; }
.g-c { color: #0f766e; font-weight: 700; }
.g-d { color: #92400e; font-weight: 700; }
.g-f { color: #991b1b; font-weight: 700; }

/* ── GRADE DISTRIBUTION BAR ──────────────────────────────────────────────── */
.dist-bar { height: 24px; border-radius: var(--r-sm); overflow: hidden; display: flex; }

/* ── DANGER ZONE ─────────────────────────────────────────────────────────── */
.danger-zone { border: 1px solid #fecaca; border-radius: var(--r-lg); background: #fff5f5; }

/* ── LOGIN PAGE ──────────────────────────────────────────────────────────── */
#loginScreen { background: var(--sb-bg); position: relative; overflow: hidden; }

#loginScreen::before {
  content: ''; position: absolute; inset: 0;
  background-image: radial-gradient(rgba(255,255,255,0.04) 1px, transparent 1px);
  background-size: 28px 28px; pointer-events: none;
}

.login-input {
  width: 100%; padding: 0.85rem 1rem;
  background: var(--page-bg); border: 1px solid var(--border);
  border-radius: var(--r-md); font-size: 13.5px; font-family: inherit;
  outline: none; transition: border-color 0.15s, box-shadow 0.15s;
  color: var(--text-primary); font-weight: 500;
}

.login-input:focus { border-color: var(--blue-500); box-shadow: var(--shadow-blue); background: var(--surface); }

/* ── RESPONSIVE ──────────────────────────────────────────────────────────── */
@media (max-width: 768px) {
  .view-section { padding: 16px !important; }
  .stat-card    { padding: 14px 16px !important; }
}
