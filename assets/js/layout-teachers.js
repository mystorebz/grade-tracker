import { logout } from './auth.js';

/**
 * Injects the Teacher Sidebar and Topbar into the page.
 * @param {string} activePageId - The ID of the current page (e.g., 'overview', 'students')
 * @param {string} pageTitle - The big title for the topbar
 * @param {string} pageSub - The small subtitle for the topbar
 * @param {boolean} showSearch - Whether to show the topbar search input
 */
export function injectTeacherLayout(activePageId, pageTitle, pageSub, showSearch = false) {
    // 1. The Sidebar HTML
    const sidebarHTML = `
      <aside id="sidebar" class="text-slate-300 flex flex-col shadow-2xl z-20 flex-shrink-0 h-screen" style="width:268px">
        <div class="p-5 border-b border-white/5">
          <div class="school-badge rounded-xl p-4 flex flex-col items-center text-center">
            <div id="teacherAvatar" class="h-12 w-12 bg-emerald-800/70 border border-emerald-600/30 rounded-xl flex items-center justify-center text-xl font-black text-white mb-2">T</div>
            <h2 id="displayTeacherName" class="font-black text-white text-sm leading-tight">Loading...</h2>
            <div id="displayTeacherClasses" class="flex flex-wrap justify-center gap-1 mt-1.5"></div>
            <div class="quick-stat-strip w-full">
              <div class="quick-stat-item border-r border-white/8 pr-2"><span class="quick-stat-label">Students</span><span class="quick-stat-val" id="sb-students">0</span></div>
              <div class="quick-stat-item border-r border-white/8 px-2"><span class="quick-stat-label">Period</span><span class="quick-stat-val text-emerald-400 text-[11px]" id="sb-period">—</span></div>
              <div class="quick-stat-item pl-2"><span class="quick-stat-label">At Risk</span><span class="quick-stat-val text-rose-400" id="sb-risk">0</span></div>
            </div>
          </div>
        </div>
        <nav class="flex-1 p-3 overflow-y-auto">
          <p class="nav-section-label">Main</p>
          <a href="../home/home.html" id="nav-overview" class="nav-item w-full flex items-center gap-3 px-3 py-2.5 text-left font-bold text-sm text-slate-400 mb-0.5"><i class="fa-solid fa-chart-pie w-4 text-sm opacity-85"></i> Overview</a>
          <a href="../roster/roster.html" id="nav-students" class="nav-item w-full flex items-center gap-3 px-3 py-2.5 text-left font-bold text-sm text-slate-400 mb-0.5"><i class="fa-solid fa-users w-4 text-sm opacity-65"></i> My Roster</a>
          <a href="../grade_form/grade_form.html" id="nav-enter-grade" class="nav-item w-full flex items-center gap-3 px-3 py-2.5 text-left font-bold text-sm text-slate-400 mb-0.5"><i class="fa-solid fa-plus-circle w-4 text-sm opacity-65"></i> Enter Grade</a>
          <a href="../subjects/subjects.html" id="nav-subjects" class="nav-item w-full flex items-center gap-3 px-3 py-2.5 text-left font-bold text-sm text-slate-400 mb-0.5"><i class="fa-solid fa-layer-group w-4 text-sm opacity-65"></i> Subjects</a>
          <a href="../gradebook/gradebook.html" id="nav-gradebook" class="nav-item w-full flex items-center gap-3 px-3 py-2.5 text-left font-bold text-sm text-slate-400 mb-0.5"><i class="fa-solid fa-book w-4 text-sm opacity-65"></i> Gradebook</a>
          <p class="nav-section-label">Records</p>
          <a href="../archives/archives.html" id="nav-archives" class="nav-item w-full flex items-center gap-3 px-3 py-2.5 text-left font-bold text-sm text-slate-400 mb-0.5"><i class="fa-solid fa-box-archive w-4 text-sm opacity-65"></i> Archives</a>
          <p class="nav-section-label">System</p>
          <a href="../settings/settings.html" id="nav-settings" class="nav-item w-full flex items-center gap-3 px-3 py-2.5 text-left font-bold text-sm text-slate-400 mb-0.5"><i class="fa-solid fa-gear w-4 text-sm opacity-65"></i> Settings</a>
        </nav>
        <div class="p-4 border-t border-white/5 space-y-3">
          <div class="rounded-xl p-2.5 text-center" style="background:rgba(5,150,105,0.1);border:1px solid rgba(52,211,153,0.15)">
            <p class="text-[9px] text-emerald-400 font-black uppercase tracking-widest">School ID</p>
            <p id="sidebarSchoolId" class="text-white font-black text-sm mt-0.5 font-mono tracking-[0.2em]">—</p>
          </div>
          <button id="logoutBtn" class="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-red-500/8 text-red-400 hover:bg-red-500 hover:text-white transition font-black text-sm border border-red-500/15 hover:border-red-500">
            <i class="fa-solid fa-power-off"></i> Log Out
          </button>
        </div>
      </aside>
    `;

    // 2. The Topbar HTML
    const topbarHTML = `
      <header class="topbar h-16 bg-white border-b border-slate-200 flex items-center px-8 z-10 justify-between flex-shrink-0 shadow-sm">
        <div>
          <h1 id="topbarTitle" class="text-xl font-black text-slate-800 leading-none">${pageTitle}</h1>
          <p id="topbarSub" class="text-xs text-slate-400 font-semibold mt-0.5">${pageSub}</p>
        </div>
        <div class="flex items-center gap-3">
          <div id="topbarSearch" class="${showSearch ? 'flex' : 'hidden'} items-center gap-2 bg-slate-50 border-2 border-slate-200 rounded-xl px-3 py-2 focus-within:border-emerald-400 transition">
            <i class="fa-solid fa-magnifying-glass text-slate-400 text-sm"></i>
            <input type="text" id="searchInput" placeholder="Search..." class="bg-transparent text-sm outline-none w-40 font-semibold text-slate-700">
          </div>
          <div id="topbarLockedBadge" class="hidden items-center gap-1.5 bg-rose-100 text-rose-700 px-3 py-2 rounded-xl text-xs font-black uppercase tracking-wider border border-rose-200">
            <i class="fa-solid fa-lock"></i> Locked
          </div>
          <div class="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2">
            <i class="fa-solid fa-calendar-days text-emerald-500 text-sm"></i>
            <span class="text-xs font-black text-emerald-700 uppercase tracking-wider">Period:</span>
            <select id="activeSemester" class="bg-transparent text-sm font-black text-emerald-700 outline-none cursor-pointer"><option value="">Loading...</option></select>
          </div>
          <img src="../../assets/images/logo.png" alt="ConnectUs" class="h-8 w-auto opacity-25">
        </div>
      </header>
    `;

    // 3. Inject into the page
    document.getElementById('layout-sidebar-container').innerHTML = sidebarHTML;
    document.getElementById('layout-topbar-container').innerHTML = topbarHTML;

    // 4. Highlight the Active Tab
    const activeNav = document.getElementById(`nav-${activePageId}`);
    if (activeNav) {
        activeNav.classList.remove('text-slate-400');
        activeNav.classList.add('active');
    }

    // 5. Attach the Logout Button functionality
    document.getElementById('logoutBtn').addEventListener('click', () => {
        logout('../../teacher/login.html'); // Redirect to Teacher Login
    });
}
