// ── PARENT PORTAL LAYOUT — sidebar, topbar, theme, active-child state ────
// Mirrors assets/js/layout-student.js's own shape and conventions exactly
// (same #layout-sidebar-container/#layout-topbar-container mount points,
// same .nav-item/#sidebar/#sidebarOverlay mechanics from
// assets/css/student.css, same mobile-toggle behavior) so parent pages get
// the same battle-tested sidebar plumbing rather than a second
// implementation of it. The only real visual difference is the theme
// (Deep Burgundy/Maroon primary, Amber reserved for interactive accents/
// alerts) — applied by overriding student.css's own --sb-accent* CSS
// custom properties from here, so .nav-item.active/.nav-item:hover pick it
// up automatically with no changes needed to the shared stylesheet itself.
//
// Every parent page must still <link> assets/css/student.css itself (same
// as every student page already does) — this module only injects the DOM
// and the theme override, not the stylesheet link.
import { db } from '../assets/js/firebase-init.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { logout, requireAuth } from '../assets/js/auth.js';

const ACTIVE_CHILD_KEY = 'connectus_parent_activeChild';

// ── ACTIVE-CHILD STATE ───────────────────────────────────────────────────
// Persisted client-side only (localStorage, this browser/device) — not part
// of the parent's Firestore record or token. Multi-page site (real <a href>
// navigation, no SPA router, same architecture as every other portal in
// this app), so switching children reloads the current page rather than
// re-rendering in place; each page's own init() re-reads this on load.
export function getActiveChild(session) {
    const linked = Array.isArray(session?.linkedStudents) ? session.linkedStudents : [];
    if (!linked.length) return null;

    try {
        const raw = localStorage.getItem(ACTIVE_CHILD_KEY);
        if (raw) {
            const saved = JSON.parse(raw);
            const stillLinked = linked.find(l => l.studentId === saved.studentId && l.schoolId === saved.schoolId);
            if (stillLinked) return stillLinked;
        }
    } catch (e) {
        console.error('[Parent Layout] Corrupt active-child selection, resetting:', e);
    }

    // Default: first linked child. Persist it so every page (not just this
    // one) agrees on the same default without each re-deriving it.
    setActiveChild(linked[0]);
    return linked[0];
}

export function setActiveChild(child) {
    try {
        localStorage.setItem(ACTIVE_CHILD_KEY, JSON.stringify({ studentId: child.studentId, schoolId: child.schoolId }));
    } catch (e) {
        console.error('[Parent Layout] Could not persist active-child selection:', e);
    }
}

// ── STUDENT SELECTOR (populated after injection — needs a Firestore read
//    for each child's display name, so it can't be part of the synchronous
//    injectParentLayout() below; same fire-and-forget-after-render pattern
//    every student page already uses for loadSchoolHeaderInfo()). ────────
export async function populateStudentSelector(session) {
    const select = document.getElementById('parentStudentSelector');
    if (!select) return;

    const linked = Array.isArray(session?.linkedStudents) ? session.linkedStudents : [];
    if (!linked.length) {
        select.innerHTML = '<option>No students linked</option>';
        select.disabled = true;
        return;
    }

    const active = getActiveChild(session);

    try {
        const snaps = await Promise.all(linked.map(l => getDoc(doc(db, 'students', l.studentId))));
        const children = snaps.map((snap, i) => ({
            studentId: linked[i].studentId,
            schoolId: linked[i].schoolId,
            name: snap.exists() ? (snap.data().name || 'Student') : 'Student record unavailable'
        }));
        children.sort((a, b) => a.name.localeCompare(b.name));

        select.innerHTML = children.map(c => `<option value="${c.studentId}|${c.schoolId}" ${active && c.studentId === active.studentId ? 'selected' : ''}>${escHtmlAttr(c.name)}</option>`).join('');
        select.disabled = children.length <= 1;
    } catch (e) {
        console.error('[Parent Layout] populateStudentSelector:', e);
        select.innerHTML = '<option>Could not load students</option>';
    }

    select.addEventListener('change', () => {
        const [studentId, schoolId] = select.value.split('|');
        setActiveChild({ studentId, schoolId });
        window.location.reload();
    });
}

function escHtmlAttr(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── PARENT NAME (fire-and-forget, same pattern as loadSchoolHeaderInfo) ──
export async function fillParentHeader(session) {
    try {
        const snap = await getDoc(doc(db, 'parents', session.parentId));
        const nameEl = document.getElementById('displayParentName');
        if (nameEl && snap.exists() && snap.data().name) nameEl.textContent = snap.data().name;
    } catch (e) {
        console.error('[Parent Layout] fillParentHeader:', e);
    }
}

/**
 * Injects the Parent Portal sidebar and topbar.
 * @param {string} activePageId - 'dashboard' | 'assignments' | 'grades' | 'history' | 'attendance' | 'evaluations' | 'reports'
 * @param {string} pageTitle - topbar title
 * @param {string} pageSub - topbar subtitle
 */
export function injectParentLayout(activePageId, pageTitle, pageSub) {
    const session = requireAuth('parent', '../../student/login.html');
    const parentId = session?.parentId || '—';
    const linkedCount = Array.isArray(session?.linkedStudents) ? session.linkedStudents.length : 0;

    // ── THEME OVERRIDE — Deep Burgundy/Maroon + Amber accent ────────────
    // Redefines student.css's own --sb-accent* custom properties so
    // .nav-item.active/.nav-item:hover (and anything else already built on
    // those variables) automatically re-themes with zero duplicated CSS.
    if (!document.getElementById('parent-theme-override')) {
        const style = document.createElement('style');
        style.id = 'parent-theme-override';
        style.textContent = `
            :root {
                --sb-accent: #f59e0b;
                --sb-accent-bg: rgba(245,158,11,0.14);
                --sb-accent-border: rgba(245,158,11,0.30);
                --sb-hover: rgba(255,255,255,0.07);
            }
        `;
        document.head.appendChild(style);
    }

    // ── 1. SIDEBAR HTML ──────────────────────────────────────────────────
    const sidebarHTML = `
      <aside id="sidebar" class="text-slate-300 flex flex-col shadow-2xl z-20 flex-shrink-0 h-screen" style="width:272px; background: linear-gradient(180deg, #3f0d1f 0%, #5c1230 50%, #7f1d3d 100%); border-right: 1px solid rgba(255,255,255,0.05);">
        <div class="p-5 border-b border-white/5">
          <div class="bg-white/5 border border-white/10 rounded-2xl p-4 flex flex-col items-center text-center">
            <div class="h-14 w-14 bg-amber-500 border border-amber-300/50 rounded-xl flex items-center justify-center text-2xl font-black text-white mb-3 shadow-inner"><i class="fa-solid fa-user-group"></i></div>
            <p class="text-[11px] text-amber-300 font-mono font-bold mb-1 tracking-wider">ID: ${parentId}</p>
            <h2 id="displayParentName" class="font-black text-white text-base leading-tight">Parent Portal</h2>
            <p class="text-xs text-amber-200/80 font-bold mt-1">${linkedCount} student${linkedCount === 1 ? '' : 's'} linked</p>
          </div>
        </div>

        <div class="px-4 pt-4">
          <label class="text-[10px] font-black text-white/40 uppercase tracking-widest px-1 mb-1.5 block">Viewing</label>
          <select id="parentStudentSelector" class="w-full p-2.5 bg-white/5 border border-white/10 rounded-lg text-[13px] font-bold text-white outline-none focus:border-amber-400">
            <option>Loading…</option>
          </select>
        </div>

        <nav class="flex-1 p-4 space-y-1 overflow-y-auto mt-1">
          <p class="text-[10px] font-black text-slate-500 uppercase tracking-widest px-3 mb-2">Overview</p>
          <a href="../dashboard/dashboard.html" id="nav-dashboard" class="nav-item w-full flex items-center gap-3 px-4 py-3 text-left font-bold text-sm text-slate-400"><i class="fa-solid fa-chart-line w-5 text-base opacity-90"></i> Dashboard</a>

          <p class="text-[10px] font-black text-slate-500 uppercase tracking-widest px-3 mt-6 mb-2">Selected Student</p>
          <a href="../assignments/assignments.html" id="nav-assignments" class="nav-item w-full flex items-center gap-3 px-4 py-3 text-left font-bold text-sm text-slate-400"><i class="fa-solid fa-clipboard-list w-5 text-base opacity-70"></i> Assignments</a>
          <a href="../grades/grades.html" id="nav-grades" class="nav-item w-full flex items-center gap-3 px-4 py-3 text-left font-bold text-sm text-slate-400"><i class="fa-solid fa-book-open w-5 text-base opacity-70"></i> Current Grades</a>
          <a href="../history/history.html" id="nav-history" class="nav-item w-full flex items-center gap-3 px-4 py-3 text-left font-bold text-sm text-slate-400"><i class="fa-solid fa-clock-rotate-left w-5 text-base opacity-70"></i> Academic History</a>
          <a href="../attendance/attendance.html" id="nav-attendance" class="nav-item w-full flex items-center gap-3 px-4 py-3 text-left font-bold text-sm text-slate-400"><i class="fa-solid fa-calendar-check w-5 text-base opacity-70"></i> Attendance</a>
          <a href="../evaluations/evaluations.html" id="nav-evaluations" class="nav-item w-full flex items-center gap-3 px-4 py-3 text-left font-bold text-sm text-slate-400"><i class="fa-solid fa-star-half-stroke w-5 text-base opacity-70"></i> Evaluations</a>
          <a href="../reports/reports.html" id="nav-reports" class="nav-item w-full flex items-center gap-3 px-4 py-3 text-left font-bold text-sm text-slate-400"><i class="fa-solid fa-file-lines w-5 text-base opacity-70"></i> Reports</a>
        </nav>

        <div class="p-4 border-t border-white/5 space-y-3">
          <button id="logoutBtn" class="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-white/5 text-slate-300 hover:bg-amber-500 hover:text-white transition font-black text-sm border border-white/10 hover:border-amber-500">
            <i class="fa-solid fa-power-off"></i> Log Out
          </button>
        </div>
      </aside>
    `;

    // ── 2. TOPBAR HTML ───────────────────────────────────────────────────
    const topbarHTML = `
      <header class="topbar h-16 bg-white border-b border-slate-200 flex items-center px-4 md:px-8 z-10 justify-between flex-shrink-0 shadow-sm">
        <div class="flex items-center gap-3">
          <button id="sidebarToggle" aria-label="Open menu"
            class="flex md:hidden items-center justify-center w-10 h-10 rounded-xl bg-slate-100 text-slate-600 hover:bg-amber-100 hover:text-amber-700 transition flex-shrink-0">
            <i class="fa-solid fa-bars text-base"></i>
          </button>
          <div>
            <h1 id="topbarTitle" class="text-lg md:text-xl font-black text-slate-800 leading-none">${pageTitle}</h1>
            <p id="topbarSub" class="text-xs text-slate-400 font-semibold mt-0.5 hidden sm:block">${pageSub}</p>
          </div>
        </div>
        <div class="flex items-center gap-2 md:gap-4">
          <span class="text-[11px] font-black uppercase tracking-widest px-3 py-1.5 rounded-lg" style="background:rgba(127,29,61,0.08);color:#7f1d3d;border:1px solid rgba(127,29,61,0.18)"><i class="fa-solid fa-eye mr-1.5"></i>Read-Only</span>
        </div>
      </header>
    `;

    document.getElementById('layout-sidebar-container').innerHTML = sidebarHTML;
    document.getElementById('layout-topbar-container').innerHTML = topbarHTML;

    // ── 3. OVERLAY (mobile) — same mechanics as layout-student.js ────────
    const overlay = document.createElement('div');
    overlay.id = 'sidebarOverlay';
    document.body.appendChild(overlay);

    // ── 4. ACTIVE NAV ─────────────────────────────────────────────────────
    const activeNav = document.getElementById(`nav-${activePageId}`);
    if (activeNav) {
        activeNav.classList.remove('text-slate-400');
        activeNav.classList.add('active');
    }

    // ── 5. LOGOUT ─────────────────────────────────────────────────────────
    document.getElementById('logoutBtn').addEventListener('click', () => {
        logout('../../student/login.html');
    });

    // ── 6. MOBILE SIDEBAR TOGGLE ──────────────────────────────────────────
    const sidebar = document.getElementById('sidebar');
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

    // ── 7. FILL IN ASYNC HEADER DATA (fire-and-forget) ────────────────────
    if (session) {
        fillParentHeader(session);
        populateStudentSelector(session);
    }

    return session;
}
