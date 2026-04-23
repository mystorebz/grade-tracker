import { logout } from './auth.js';

/**
 * Injects the Admin Sidebar and Topbar into the page.
 * @param {string} activePageId - The ID of the current page (e.g., 'overview', 'teachers')
 * @param {string} pageTitle - The big title for the topbar
 * @param {string} pageSub - The small subtitle for the topbar
 * @param {boolean} showSearch - Whether to show the topbar search input
 * @param {boolean} showPeriod - Whether to show the period dropdown (mostly for Classes tab)
 */
export function injectAdminLayout(activePageId, pageTitle, pageSub, showSearch = false, showPeriod = false) {
    // 1. The Admin Sidebar HTML
    const sidebarHTML = `
      <aside id="sidebar" class="text-slate-300 flex flex-col shadow-2xl z-20 flex-shrink-0 h-screen" style="width:272px">
        <div class="p-5 border-b border-white/5">
          <div class="school-badge rounded-2xl p-4 flex flex-col items-center text-center">
            <div id="schoolLogoFallback" class="h-14 w-14 bg-blue-800/50 border border-blue-600/40 rounded-xl flex items-center justify-center text-2xl mb-2 shadow-inner">🏫</div>
            <img id="schoolLogo" src="" alt="Logo" class="h-14 w-14 object-contain rounded-xl bg-white p-1 mb-2 hidden shadow-md">
            <h2 id="displaySchoolName" class="font-black text-white text-sm leading-tight">Loading...</h2>
            <span class="text-[10px] text-blue-300 mt-1.5 uppercase tracking-[0.18em] font-black bg-blue-900/50 py-0.5 px-2.5 rounded-full">Administrator</span>
          </div>
        </div>
        <nav class="flex-1 p-4 space-y-1 overflow-y-auto mt-1">
          <p class="text-[10px] font-black text-slate-600 uppercase tracking-widest px-3 mb-2">Main Menu</p>
          <a href="../home/home.html" id="nav-overview" class="nav-item w-full flex items-center gap-3 px-4 py-3 text-left font-bold text-sm text-slate-400"><i class="fa-solid fa-chart-pie w-5 text-base opacity-90"></i> Overview</a>
          <a href="../teachers/teachers.html" id="nav-teachers" class="nav-item w-full flex items-center gap-3 px-4 py-3 text-left font-bold text-sm text-slate-400"><i class="fa-solid fa-chalkboard-user w-5 text-base opacity-70"></i> Teachers</a>
          <a href="../classes/classes.html" id="nav-classes" class="nav-item w-full flex items-center gap-3 px-4 py-3 text-left font-bold text-sm text-slate-400"><i class="fa-solid fa-school w-5 text-base opacity-70"></i> Classes</a>
          <a href="../students/students.html" id="nav-students" class="nav-item w-full flex items-center gap-3 px-4 py-3 text-left font-bold text-sm text-slate-400"><i class="fa-solid fa-user-graduate w-5 text-base opacity-70"></i> Students</a>
          <a href="../semesters/semesters.html" id="nav-semesters" class="nav-item w-full flex items-center gap-3 px-4 py-3 text-left font-bold text-sm text-slate-400"><i class="fa-solid fa-calendar-days w-5 text-base opacity-70"></i> Grading Periods</a>
          <p class="text-[10px] font-black text-slate-600 uppercase tracking-widest px-3 mt-4 mb-2">System</p>
          <a href="../settings/settings.html" id="nav-settings" class="nav-item w-full flex items-center gap-3 px-4 py-3 text-left font-bold text-sm text-slate-400"><i class="fa-solid fa-gear w-5 text-base opacity-70"></i> Settings</a>
        </nav>
        <div class="p-4 border-t border-white/5 space-y-3">
          <div class="rounded-xl p-3 text-center" style="background:rgba(37,99,235,0.12);border:1px solid rgba(96,165,250,0.2)">
            <p class="text-[10px] text-blue-400 font-black uppercase tracking-widest">School ID</p>
            <p id="sidebarSchoolId" class="text-white font-black text-base mt-0.5 font-mono tracking-[0.2em]">—</p>
          </div>
          <button id="logoutBtn" class="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-red-500/10 text-red-400 hover:bg-red-500 hover:text-white transition font-black text-sm border border-red-500/20 hover:border-red-500"><i class="fa-solid fa-power-off"></i> Log Out</button>
        </div>
      </aside>
    `;

    // 2. The Admin Topbar HTML
    const topbarHTML = `
      <header class="topbar h-16 bg-white border-b border-slate-200 flex items-center px-8 z-10 justify-between flex-shrink-0 shadow-sm">
        <div>
          <h1 id="topbarTitle" class="text-xl font-black text-slate-800 leading-none">${pageTitle}</h1>
          <p id="topbarSub" class="text-xs text-slate-400 font-semibold mt-0.5">${pageSub}</p>
        </div>
        <div class="flex items-center gap-3">
          <div id="topbarSearch" class="${showSearch ? 'flex' : 'hidden'} items-center gap-2 bg-slate-50 border-2 border-slate-200 rounded-xl px-3 py-2 focus-within:border-blue-400 transition">
            <i class="fa-solid fa-magnifying-glass text-slate-400 text-sm"></i>
            <input type="text" id="searchInput" placeholder="Search..." class="bg-transparent text-sm outline-none w-44 font-semibold text-slate-700">
          </div>
          <div id="topbarPeriod" class="${showPeriod ? 'flex' : 'hidden'} items-center gap-2 bg-blue-50 border border-blue-200 rounded-xl px-3 py-2">
            <i class="fa-solid fa-calendar-days text-blue-500 text-sm"></i>
            <span class="text-xs font-black text-blue-700 uppercase tracking-wider">Period:</span>
            <select id="globalPeriodSelect" class="bg-transparent text-sm font-black text-blue-700 outline-none cursor-pointer"><option value="">—</option></select>
          </div>
          <img src="../../assets/images/logo.png" alt="ConnectUs" class="h-8 w-auto opacity-30">
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
        logout('../../admin/login.html'); // Redirect to Admin Login
    });
}
