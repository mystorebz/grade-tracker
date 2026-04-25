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

    const displayName   = isSuperAdmin ? schoolName : (session.adminName || 'Administrator');
    const roleBadgeClass = isSuperAdmin ? 'sidebar-role-badge sidebar-role-super' : 'sidebar-role-badge sidebar-role-admin';
    const roleBadgeText  = isSuperAdmin ? 'Super Admin' : 'Administrator';

    // Initials for avatar fallback
    const initials = displayName.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

    // ── 1. Sidebar HTML ───────────────────────────────────────────────────────
    const sidebarHTML = `
      <aside id="sidebar" class="flex flex-col flex-shrink-0 h-screen z-20" style="width:256px">

        <div class="sidebar-brand">
          <div class="sidebar-brand-logo">
            <img src="../../assets/images/logo.png" alt="ConnectUs" onerror="this.parentElement.textContent='C'">
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
          <a href="../home/home.html"               id="nav-overview"    class="nav-item"><i class="fa-solid fa-chart-pie"></i> Overview</a>
          <a href="../teachers/teachers.html"        id="nav-teachers"    class="nav-item"><i class="fa-solid fa-chalkboard-user"></i> Teachers</a>
          <a href="../classes/classes.html"          id="nav-classes"     class="nav-item"><i class="fa-solid fa-school"></i> Classes</a>
          <a href="../students/students.html"        id="nav-students"    class="nav-item"><i class="fa-solid fa-user-graduate"></i> Students</a>
          <a href="../grading_periods/grading_periods.html" id="nav-semesters"   class="nav-item"><i class="fa-solid fa-calendar-days"></i> Grading Periods</a>

          <span class="nav-section-label">Grades &amp; Reports</span>
          <a href="../grade-entry/grade-entry.html"  id="nav-grade-entry" class="nav-item"><i class="fa-solid fa-pen-to-square"></i> Enter Grade</a>
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

          <img src="../../assets/images/logo.png" alt="ConnectUs" class="topbar-logo">
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
