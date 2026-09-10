import { logout, getSessionData } from './auth.js';
import { initNotifications } from './notifications.js';

/**
 * Injects the Teacher Sidebar and Topbar into the page.
 * @param {string} activePageId - The ID of the current page (e.g., 'overview', 'students')
 * @param {string} pageTitle    - The big title shown in the topbar
 * @param {string} pageSub      - The small subtitle shown in the topbar
 * @param {boolean} showSearch  - Whether to show the topbar search input
 */
export function injectTeacherLayout(activePageId, pageTitle, pageSub, showSearch = false) {

    // ── SIDEBAR ──────────────────────────────────────────────────────────────
    const sidebarHTML = `
      <aside id="sidebar" class="flex flex-col flex-shrink-0 h-screen" style="width:256px">

        <div class="sidebar-brand">
          <div class="sidebar-logo-mark">C</div>
          <span class="sidebar-logo-text">ConnectUs</span>
        </div>

        <div class="sidebar-profile">
          <div class="sidebar-profile-top">
            <div id="teacherAvatar" class="sidebar-avatar">T</div>
            <div class="sidebar-profile-info">
              <p id="displayTeacherName" class="sidebar-teacher-name">Loading…</p>
              <div id="displayTeacherClasses" class="sidebar-class-pills"></div>
            </div>
          </div>

          <div class="sidebar-prop-table">
            <div class="sidebar-prop-row">
              <span class="sidebar-prop-key">Students</span>
              <span class="sidebar-prop-val" id="sb-students">—</span>
            </div>
            <div class="sidebar-prop-row">
              <span class="sidebar-prop-key">Period</span>
              <span class="sidebar-prop-val sidebar-prop-green" id="sb-period">—</span>
            </div>
            <div class="sidebar-prop-row sidebar-prop-row-last">
              <span class="sidebar-prop-key">At Risk</span>
              <span class="sidebar-prop-val sidebar-prop-risk" id="sb-risk">0</span>
            </div>
          </div>
        </div>

        <nav class="sidebar-nav">
          <p class="nav-section-label">Main</p>
          <a href="../home/home.html"             id="nav-overview"     class="nav-item"><i class="fa-solid fa-chart-pie"></i><span>Overview</span></a>
          <a href="../roster/roster.html"         id="nav-students"     class="nav-item"><i class="fa-solid fa-users"></i><span>My Roster</span></a>
          <a href="../grade_form/grade_form.html" id="nav-enter-grade"  class="nav-item"><i class="fa-solid fa-plus-circle"></i><span>Enter Grade</span></a>
          <a href="../subjects/subjects.html"     id="nav-subjects"     class="nav-item"><i class="fa-solid fa-layer-group"></i><span>Subjects</span></a>
          <a href="../gradebook/gradebook.html"   id="nav-gradebook"    class="nav-item"><i class="fa-solid fa-book"></i><span>Gradebook</span></a>

          <p class="nav-section-label">Reports & Analytics</p>
          <a href="../analytics/analytics.html"   id="nav-analytics"    class="nav-item"><i class="fa-solid fa-star-half-stroke"></i><span>My Evaluations</span></a>
          <a href="../archives/archives.html"     id="nav-archives"     class="nav-item"><i class="fa-solid fa-box-archive"></i><span>Archives</span></a>

          <p class="nav-section-label">System</p>
          <a href="../reports/reports.html"       id="nav-reports"      class="nav-item"><i class="fa-solid fa-chart-column"></i><span>Reports</span></a>
          <a href="../settings/settings.html"     id="nav-settings"     class="nav-item"><i class="fa-solid fa-gear"></i><span>Settings</span></a>
        </nav>

        <div class="sidebar-footer">
          <div class="sidebar-school-id-block">
            <p class="sidebar-school-id-label">School ID</p>
            <p id="sidebarSchoolId" class="sidebar-school-id-val">—</p>
          </div>
          <button id="logoutBtn" class="sidebar-logout-btn">
            <i class="fa-solid fa-power-off"></i>
            <span>Log Out</span>
          </button>
        </div>

      </aside>
    `;

    // ── TOPBAR ───────────────────────────────────────────────────────────────
    // Hamburger: flex md:hidden — mobile only, never visible on desktop.
    // Logo: hidden on mobile to save topbar space.
    // Period label: hidden on mobile, select stays.
    // Locked badge: hidden on very small screens.
    const topbarHTML = `
      <header class="topbar">
        <div class="topbar-left" style="display:flex;align-items:center;gap:10px;">
          <button id="sidebarToggle" aria-label="Open menu"
            class="flex md:hidden items-center justify-center w-9 h-9 rounded-lg bg-slate-100 text-slate-600 hover:bg-green-50 hover:text-green-700 transition flex-shrink-0"
            style="border:none;cursor:pointer;">
            <i class="fa-solid fa-bars" style="font-size:14px;"></i>
          </button>
          <div>
            <h1 class="topbar-title">${pageTitle}</h1>
            <p class="topbar-sub hidden sm:block">${pageSub}</p>
          </div>
        </div>
        <div class="topbar-right">

          <div id="topbarSearch" class="topbar-search ${showSearch ? 'topbar-search-visible' : 'topbar-search-hidden'} hidden md:flex">
            <i class="fa-solid fa-magnifying-glass topbar-search-icon"></i>
            <input type="text" id="searchInput" placeholder="Search students…" class="topbar-search-input">
          </div>

          <div id="topbarLockedBadge" class="topbar-locked-badge hidden">
            <i class="fa-solid fa-lock"></i>
            <span class="hidden sm:inline">Locked</span>
          </div>

          <div class="topbar-period-wrap">
            <i class="fa-solid fa-calendar-days topbar-period-icon"></i>
            <span class="topbar-period-label hidden md:inline">Period</span>
            <select id="activeSemester" class="topbar-period-select">
              <option value="">Loading…</option>
            </select>
          </div>

          <div class="notif-wrap">
            <button id="notifBellBtn" class="notif-bell" aria-label="Notifications">
              <i class="fa-solid fa-bell"></i>
              <span id="notifBadge" class="notif-badge hidden">0</span>
            </button>
            <div id="notifDropdown" class="notif-dropdown hidden">
              <div class="notif-dropdown-head">Notifications</div>
              <div id="notifList" class="notif-list"></div>
            </div>
          </div>

          <img src="../../assets/images/logo.png" alt="ConnectUs" class="topbar-logo hidden sm:block">
        </div>
      </header>
    `;

    // ── INJECT ───────────────────────────────────────────────────────────────
    document.getElementById('layout-sidebar-container').innerHTML = sidebarHTML;
    document.getElementById('layout-topbar-container').innerHTML  = topbarHTML;

    // ── INJECT OVERLAY INTO BODY ─────────────────────────────────────────────
    // z-index: 15 in CSS — below the sidebar container stacking context (z-20)
    // so the sidebar paints above it and all nav taps reach their links.
    // Visibility controlled by opacity + pointer-events only — never display.
    const overlay  = document.createElement('div');
    overlay.id     = 'sidebarOverlay';
    document.body.appendChild(overlay);

    // ── POPULATE TEACHER PROFILE DATA ────────────────────────────────────────
    const session = getSessionData('teacher');
    if (session && session.teacherData) {
        document.getElementById('displayTeacherName').textContent = session.teacherData.name || 'Teacher';
        document.getElementById('teacherAvatar').textContent = (session.teacherData.name || 'T').charAt(0).toUpperCase();
        document.getElementById('sidebarSchoolId').textContent = session.schoolId || '—';

        // ── CLASSES SYNC FIX ──
        const cachedClasses = localStorage.getItem('connectus_cached_classes');
        let classesToDisplay = session.teacherData.classes || [session.teacherData.className || ''];

        if (cachedClasses) {
            try { classesToDisplay = JSON.parse(cachedClasses); } catch(e) {}
        }

        document.getElementById('displayTeacherClasses').innerHTML =
            classesToDisplay.filter(Boolean).map(c => `<span class="class-pill">${c}</span>`).join('');
    }

    // ── INJECT CACHED SIDEBAR STATS ──────────────────────────────────────────
    try {
        const cachedStats = localStorage.getItem('connectus_sidebar_stats');
        if (cachedStats) {
            const stats = JSON.parse(cachedStats);
            const sbStudents = document.getElementById('sb-students');
            const sbRisk     = document.getElementById('sb-risk');

            if (sbStudents && stats.students !== undefined) {
                sbStudents.textContent = stats.students;
            }
            if (sbRisk && stats.risk !== undefined) {
                sbRisk.textContent = stats.risk;
                sbRisk.classList.toggle('is-risk', stats.risk > 0);
            }
        }
    } catch (e) {
        console.error('[Layout] Error loading cached sidebar stats:', e);
    }

    // ── ACTIVE NAV HIGHLIGHT ─────────────────────────────────────────────────
    const activeNav = document.getElementById(`nav-${activePageId}`);
    if (activeNav) activeNav.classList.add('active');

    // ── LOGOUT ───────────────────────────────────────────────────────────────
    document.getElementById('logoutBtn').addEventListener('click', () => {
        logout('../../teacher/login.html');
    });

    // ── NOTIFICATIONS ─────────────────────────────────────────────────────────
    initNotifications('teacher', session);

    // ── MOBILE SIDEBAR TOGGLE ────────────────────────────────────────────────
    // Class toggles only — no body overflow manipulation, no display toggling.
    // Nav <a> links navigate naturally on their own.
    const sidebar   = document.getElementById('sidebar');
    const toggleBtn = document.getElementById('sidebarToggle');

    function openSidebar() {
        sidebar.classList.add('sidebar-open');
        overlay.classList.add('visible');
    }

    function closeSidebar() {
        sidebar.classList.remove('sidebar-open');
        overlay.classList.remove('visible');
    }

    if (toggleBtn) toggleBtn.addEventListener('click', openSidebar);
    overlay.addEventListener('click', closeSidebar);
}
