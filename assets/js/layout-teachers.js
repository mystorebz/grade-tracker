import { logout } from './auth.js';

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

        <!-- Brand -->
        <div class="sidebar-brand">
          <div class="sidebar-logo-mark">C</div>
          <span class="sidebar-logo-text">ConnectUs</span>
        </div>

        <!-- Teacher Profile Card -->
        <div class="sidebar-profile">
          <div class="sidebar-profile-top">
            <div id="teacherAvatar" class="sidebar-avatar">T</div>
            <div class="sidebar-profile-info">
              <p id="displayTeacherName" class="sidebar-teacher-name">Loading…</p>
              <div id="displayTeacherClasses" class="sidebar-class-pills"></div>
            </div>
          </div>

          <!-- Prop table: Students / Period / At Risk -->
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

        <!-- Navigation -->
        <nav class="sidebar-nav">
          <p class="nav-section-label">Main</p>
          <a href="../home/home.html"            id="nav-overview"     class="nav-item"><i class="fa-solid fa-chart-pie"></i><span>Overview</span></a>
          <a href="../roster/roster.html"         id="nav-students"     class="nav-item"><i class="fa-solid fa-users"></i><span>My Roster</span></a>
          <a href="../grade_form/grade_form.html" id="nav-enter-grade"  class="nav-item"><i class="fa-solid fa-plus-circle"></i><span>Enter Grade</span></a>
          <a href="../subjects/subjects.html"     id="nav-subjects"     class="nav-item"><i class="fa-solid fa-layer-group"></i><span>Subjects</span></a>
          <a href="../gradebook/gradebook.html"   id="nav-gradebook"    class="nav-item"><i class="fa-solid fa-book"></i><span>Gradebook</span></a>

          <p class="nav-section-label">Records</p>
          <a href="../archives/archives.html"     id="nav-archives"     class="nav-item"><i class="fa-solid fa-box-archive"></i><span>Archives</span></a>

          <p class="nav-section-label">System</p>
          <a href="../reports/reports.html"       id="nav-reports"      class="nav-item"><i class="fa-solid fa-chart-column"></i><span>Reports</span></a>
          <a href="../settings/settings.html"     id="nav-settings"     class="nav-item"><i class="fa-solid fa-gear"></i><span>Settings</span></a>
        </nav>

        <!-- Footer: School ID + Logout -->
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
    const topbarHTML = `
      <header class="topbar">
        <div class="topbar-left">
          <h1 class="topbar-title">${pageTitle}</h1>
          <p class="topbar-sub">${pageSub}</p>
        </div>
        <div class="topbar-right">

          <!-- Search (shown only on pages that request it) -->
          <div id="topbarSearch" class="topbar-search ${showSearch ? 'topbar-search-visible' : 'topbar-search-hidden'}">
            <i class="fa-solid fa-magnifying-glass topbar-search-icon"></i>
            <input type="text" id="searchInput" placeholder="Search students…" class="topbar-search-input">
          </div>

          <!-- Locked badge (hidden by default, shown by JS when semester is locked) -->
          <div id="topbarLockedBadge" class="topbar-locked-badge hidden">
            <i class="fa-solid fa-lock"></i>
            <span>Locked</span>
          </div>

          <!-- Active semester / period selector -->
          <div class="topbar-period-wrap">
            <i class="fa-solid fa-calendar-days topbar-period-icon"></i>
            <span class="topbar-period-label">Period</span>
            <select id="activeSemester" class="topbar-period-select">
              <option value="">Loading…</option>
            </select>
          </div>

          <!-- Logo -->
          <img src="../../assets/images/logo.png" alt="ConnectUs" class="topbar-logo">
        </div>
      </header>
    `;

    // ── INJECT ───────────────────────────────────────────────────────────────
    document.getElementById('layout-sidebar-container').innerHTML = sidebarHTML;
    document.getElementById('layout-topbar-container').innerHTML  = topbarHTML;

    // ── ACTIVE NAV HIGHLIGHT ─────────────────────────────────────────────────
    const activeNav = document.getElementById(`nav-${activePageId}`);
    if (activeNav) activeNav.classList.add('active');

    // ── LOGOUT ───────────────────────────────────────────────────────────────
    document.getElementById('logoutBtn').addEventListener('click', () => {
        logout('../../teacher/login.html');
    });
}
