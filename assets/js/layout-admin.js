import { logout, getSessionData } from './auth.js';
import { initNotifications } from './notifications.js';

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

    // STRICT ROLE CHECK: Prevents the UI from ever confusing a sub_admin for a super_admin
    const isSuperAdmin = session.role === 'super_admin';
    const schoolName   = session.schoolName || 'Your School';
    const schoolId     = session.schoolId   || '—';

    const displayName    = isSuperAdmin ? schoolName : (session.adminName || 'Sub-Admin');
    const roleBadgeClass = isSuperAdmin ? 'sidebar-role-badge sidebar-role-super' : 'sidebar-role-badge sidebar-role-admin';
    const roleBadgeText  = isSuperAdmin ? 'Super Admin' : 'Sub-Admin';

    const initials = displayName.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

    // ── 1. Sidebar HTML — unchanged ───────────────────────────────────────────
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
          <a href="../home/home.html"                        id="nav-overview"     class="nav-item"><i class="fa-solid fa-chart-pie"></i> Overview</a>
          <a href="../teachers/teachers.html"                id="nav-teachers"     class="nav-item"><i class="fa-solid fa-chalkboard-user"></i> Teachers</a>
          <a href="../evaluations/evaluations.html"          id="nav-evaluations"  class="nav-item"><i class="fa-solid fa-star-half-stroke"></i> Evaluations</a>
          <a href="../classes/classes.html"                  id="nav-classes"      class="nav-item"><i class="fa-solid fa-school"></i> Classes</a>
          <a href="../students/students.html"                id="nav-students"     class="nav-item"><i class="fa-solid fa-user-graduate"></i> Students</a>
          <a href="../grading_periods/grading_periods.html"  id="nav-semesters"    class="nav-item"><i class="fa-solid fa-calendar-days"></i> Grading Periods</a>

          <span class="nav-section-label">Grades &amp; Reports</span>
          <a href="../reports/reports.html"                  id="nav-reports"      class="nav-item"><i class="fa-solid fa-chart-column"></i> Reports</a>

          <span class="nav-section-label">System</span>
          <a href="../settings/settings.html"                id="nav-settings"     class="nav-item"><i class="fa-solid fa-gear"></i> Settings</a>
          <a href="../archives/archives.html"                id="nav-archives"     class="nav-item"><i class="fa-solid fa-box-archive"></i> Archives</a>

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
    // Hamburger: flex md:hidden — mobile only, never visible on desktop.
    // Search hidden on mobile (not critical on small screen).
    // Period and sub-admin badge compact on small screens.
    const topbarHTML = `
      <header class="topbar">
        <div class="flex items-center gap-3">
          <button id="sidebarToggle" aria-label="Open menu"
            class="flex md:hidden items-center justify-center w-9 h-9 rounded-lg bg-slate-100 text-slate-600 hover:bg-blue-50 hover:text-blue-600 transition flex-shrink-0"
            style="border:none;cursor:pointer;">
            <i class="fa-solid fa-bars" style="font-size:14px;"></i>
          </button>
          <div>
            <h1 class="topbar-title">${pageTitle}</h1>
            <p class="topbar-sub hidden sm:block">${pageSub}</p>
          </div>
        </div>
        <div class="topbar-right">

          <div class="topbar-search ${showSearch ? '' : 'hidden'} hidden md:flex" id="topbarSearch">
            <i class="fa-solid fa-magnifying-glass topbar-search-icon"></i>
            <input type="text" id="searchInput" placeholder="Search..." class="topbar-search-input">
          </div>

          <div class="topbar-period-wrap ${showPeriod ? '' : 'hidden'}" id="topbarPeriod">
            <i class="fa-solid fa-calendar-days topbar-period-icon"></i>
            <span class="topbar-period-label hidden md:inline">Period:</span>
            <select id="globalPeriodSelect" class="topbar-period-select">
              <option value="">—</option>
            </select>
          </div>

          ${!isSuperAdmin ? `
          <div class="hidden sm:flex" style="align-items:center;gap:6px;background:rgba(37,99,235,0.06);border:1px solid rgba(37,99,235,0.15);border-radius:var(--r-md);padding:5px 10px;">
            <i class="fa-solid fa-user-shield" style="font-size:11px;color:var(--blue-500)"></i>
            <span style="font-size:11.5px;font-weight:600;color:var(--blue-600)">${session.adminName || 'Sub-Admin'}</span>
          </div>
          ` : ''}

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

        </div>
      </header>
    `;

    // ── 3. Inject ─────────────────────────────────────────────────────────────
    document.getElementById('layout-sidebar-container').innerHTML = sidebarHTML;
    document.getElementById('layout-topbar-container').innerHTML  = topbarHTML;

    // ── 4. Inject overlay into body ───────────────────────────────────────────
    // z-index: 15 in CSS — below the sidebar container's stacking context (z-20)
    // so the sidebar paints above it and all nav taps reach their links.
    // Visibility controlled by opacity + pointer-events only — never display.
    const overlay  = document.createElement('div');
    overlay.id     = 'sidebarOverlay';
    document.body.appendChild(overlay);

    // ── 5. Highlight active nav ───────────────────────────────────────────────
    const activeNav = document.getElementById(`nav-${activePageId}`);
    if (activeNav) activeNav.classList.add('active');

    // ── 6. Logout ─────────────────────────────────────────────────────────────
    document.getElementById('logoutBtn').addEventListener('click', () => {
        logout('../../admin/login.html');
    });

    // ── 6b. Notifications ──────────────────────────────────────────────────────
    initNotifications('admin', session);

    // ── 7. Mobile sidebar toggle ──────────────────────────────────────────────
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
