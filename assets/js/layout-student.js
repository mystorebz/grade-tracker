import { logout } from './auth.js';

/**
 * Injects the Family/Student Sidebar and Topbar into the page.
 * @param {string} activePageId - The ID of the current page (e.g., 'overview', 'gradebook')
 * @param {string} pageTitle - The big title for the topbar
 * @param {string} pageSub - The small subtitle for the topbar
 */
export function injectStudentLayout(activePageId, pageTitle, pageSub) {
    // 1. The Family/Student Sidebar HTML
    const sidebarHTML = `
      <aside id="sidebar" class="text-slate-300 flex flex-col shadow-2xl z-20 flex-shrink-0 h-screen" style="width:272px">
        <div class="p-5 border-b border-white/5">
          <div class="bg-white/5 border border-white/10 rounded-2xl p-4 flex flex-col items-center text-center">
            <div id="studentAvatar" class="h-14 w-14 bg-indigo-600 border border-indigo-400/50 rounded-xl flex items-center justify-center text-2xl font-black text-white mb-3 shadow-inner">S</div>
            <h2 id="displayStudentName" class="font-black text-white text-base leading-tight">Loading...</h2>
            <p id="displayStudentClass" class="text-xs text-indigo-300 font-bold mt-1">—</p>
          </div>
        </div>
        <nav class="flex-1 p-4 space-y-1 overflow-y-auto mt-1">
          <p class="text-[10px] font-black text-slate-500 uppercase tracking-widest px-3 mb-2">Main Menu</p>
          <a href="../home/home.html" id="nav-overview" class="nav-item w-full flex items-center gap-3 px-4 py-3 text-left font-bold text-sm text-slate-400"><i class="fa-solid fa-house w-5 text-base opacity-90"></i> Dashboard</a>
          <a href="../gradebook/gradebook.html" id="nav-gradebook" class="nav-item w-full flex items-center gap-3 px-4 py-3 text-left font-bold text-sm text-slate-400"><i class="fa-solid fa-book-open w-5 text-base opacity-70"></i> Current Grades</a>
          <a href="../history/history.html" id="nav-history" class="nav-item w-full flex items-center gap-3 px-4 py-3 text-left font-bold text-sm text-slate-400"><i class="fa-solid fa-clock-rotate-left w-5 text-base opacity-70"></i> Academic History</a>
        </nav>
        <div class="p-4 border-t border-white/5 space-y-3">
          <div class="rounded-xl p-3 text-center" style="background:rgba(99,102,241,0.12);border:1px solid rgba(99,102,241,0.2)">
            <p class="text-[10px] text-indigo-400 font-black uppercase tracking-widest">School</p>
            <p id="displaySchoolName" class="text-white font-black text-sm mt-0.5 truncate px-2">Loading...</p>
          </div>
          <button id="logoutBtn" class="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-white/5 text-slate-300 hover:bg-rose-500 hover:text-white transition font-black text-sm border border-white/10 hover:border-rose-500">
            <i class="fa-solid fa-power-off"></i> Log Out
          </button>
        </div>
      </aside>
    `;

    // 2. The Family/Student Topbar HTML
    const topbarHTML = `
      <header class="topbar h-16 bg-white border-b border-slate-200 flex items-center px-8 z-10 justify-between flex-shrink-0 shadow-sm">
        <div>
          <h1 id="topbarTitle" class="text-xl font-black text-slate-800 leading-none">${pageTitle}</h1>
          <p id="topbarSub" class="text-xs text-slate-400 font-semibold mt-0.5">${pageSub}</p>
        </div>
        <div class="flex items-center gap-4">
          <div class="flex items-center gap-2 bg-indigo-50 border border-indigo-100 rounded-xl px-3 py-2">
            <i class="fa-solid fa-calendar-days text-indigo-500 text-sm"></i>
            <span class="text-xs font-black text-indigo-700 uppercase tracking-wider">Current Period:</span>
            <span id="activeSemesterDisplay" class="text-sm font-black text-indigo-800">Loading...</span>
          </div>
          <img src="../../assets/images/logo.png" alt="ConnectUs" class="h-8 w-auto opacity-30 hidden sm:block">
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
        logout('../../student/login.html'); // Redirect to Student Login
    });
}
