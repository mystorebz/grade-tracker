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
import { db, functions } from '../assets/js/firebase-init.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
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
 * @param {string} activePageId - 'dashboard' | 'assignments' | 'portfolio' | 'grades' | 'history' | 'attendance' | 'evaluations' | 'reports'
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
            /* The student selector's closed state is styled white-on-burgundy
               (text-white) to match the sidebar, but the browser renders its
               OPEN option list as its own plain white popup. Options inherit
               that white text color unless told otherwise, so without this
               rule every student name is invisible (white on white) once the
               dropdown is opened. */
            #parentStudentSelector option {
                color: #1e293b;
                background: #ffffff;
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
          <a href="../portfolio/portfolio.html" id="nav-portfolio" class="nav-item w-full flex items-center gap-3 px-4 py-3 text-left font-bold text-sm text-slate-400"><i class="fa-solid fa-images w-5 text-base opacity-70"></i> Portfolio</a>
          <a href="../grades/grades.html" id="nav-grades" class="nav-item w-full flex items-center gap-3 px-4 py-3 text-left font-bold text-sm text-slate-400"><i class="fa-solid fa-book-open w-5 text-base opacity-70"></i> Current Grades</a>
          <a href="../history/history.html" id="nav-history" class="nav-item w-full flex items-center gap-3 px-4 py-3 text-left font-bold text-sm text-slate-400"><i class="fa-solid fa-clock-rotate-left w-5 text-base opacity-70"></i> Academic History</a>
          <a href="../attendance/attendance.html" id="nav-attendance" class="nav-item w-full flex items-center gap-3 px-4 py-3 text-left font-bold text-sm text-slate-400"><i class="fa-solid fa-calendar-check w-5 text-base opacity-70"></i> Attendance</a>
          <a href="../evaluations/evaluations.html" id="nav-evaluations" class="nav-item w-full flex items-center gap-3 px-4 py-3 text-left font-bold text-sm text-slate-400"><i class="fa-solid fa-star-half-stroke w-5 text-base opacity-70"></i> Evaluations</a>
          <a href="../reports/reports.html" id="nav-reports" class="nav-item w-full flex items-center gap-3 px-4 py-3 text-left font-bold text-sm text-slate-400"><i class="fa-solid fa-file-lines w-5 text-base opacity-70"></i> Reports</a>
        </nav>

        <div class="p-4 border-t border-white/5 space-y-3">
          <button id="parentSettingsBtn" class="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white transition font-black text-sm border border-white/10">
            <i class="fa-solid fa-user-gear"></i> Account Settings
          </button>
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

    // ── 5b. ACCOUNT SETTINGS (PIN + contact) ─────────────────────────────
    document.getElementById('parentSettingsBtn').addEventListener('click', () => openParentSettings(session));

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


// ── ACCOUNT SETTINGS MODAL (Module 2: parent self-service) ───────────────
// parents/{parentId} is client-read-only, so both forms go through Admin
// SDK callables (functions/index.js): updateMyParentContact and
// changeParentPin. Identity comes from the parent's verified token there,
// never from anything this form sends.
const SETTINGS_CSS = `
#parentSettingsModal { position:fixed; inset:0; z-index:100; display:flex; align-items:center; justify-content:center; padding:16px; background:rgba(15,23,42,0.55); }
#parentSettingsModal.hidden { display:none; }
.ps-box { width:100%; max-width:480px; max-height:calc(100vh - 32px); overflow-y:auto; background:#fff; border-radius:16px; box-shadow:0 24px 60px rgba(15,23,42,0.3); font-family:'DM Sans',sans-serif; }
.ps-head { display:flex; align-items:center; justify-content:space-between; padding:18px 22px; background:linear-gradient(120deg,#3f0d1f,#7f1d3d); color:#fff; border-radius:16px 16px 0 0; }
.ps-head h2 { font-size:16px; font-weight:800; margin:0; }
.ps-close { background:rgba(255,255,255,0.12); border:none; color:#fff; width:32px; height:32px; border-radius:8px; cursor:pointer; }
.ps-section { padding:18px 22px; border-bottom:1px solid #f1f5f9; }
.ps-section:last-child { border-bottom:none; }
.ps-title { font-size:11px; font-weight:800; color:#7f1d3d; text-transform:uppercase; letter-spacing:0.08em; margin:0 0 12px; }
.ps-field { margin-bottom:10px; }
.ps-field label { display:block; font-size:11px; font-weight:800; color:#64748b; margin-bottom:4px; }
.ps-field input { width:100%; padding:10px 12px; border:1px solid #cbd5e1; border-radius:10px; font-size:14px; font-family:inherit; color:#0f172a; outline:none; }
.ps-field input:focus { border-color:#f59e0b; box-shadow:0 0 0 3px rgba(245,158,11,0.15); }
.ps-row { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.ps-btn { display:inline-flex; align-items:center; gap:8px; padding:10px 16px; border:none; border-radius:10px; background:#7f1d3d; color:#fff; font-weight:800; font-size:13px; cursor:pointer; font-family:inherit; }
.ps-btn:disabled { opacity:0.6; cursor:not-allowed; }
.ps-msg { font-size:12.5px; font-weight:700; margin:10px 0 0; padding:8px 10px; border-radius:8px; }
.ps-msg.ok { background:#ecfdf5; color:#047857; }
.ps-msg.err { background:#fef2f2; color:#b91c1c; }
.ps-hint { font-size:11.5px; color:#94a3b8; font-weight:600; margin:0 0 10px; }
@media (max-width:480px) { .ps-row { grid-template-columns:1fr; } }
`;

function ensureSettingsModal() {
    if (document.getElementById('parentSettingsModal')) return;
    const style = document.createElement('style');
    style.textContent = SETTINGS_CSS;
    document.head.appendChild(style);

    const wrap = document.createElement('div');
    wrap.id = 'parentSettingsModal';
    wrap.className = 'hidden';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.innerHTML = `
      <div class="ps-box">
        <div class="ps-head">
          <h2><i class="fa-solid fa-user-gear" style="margin-right:8px;"></i>Account Settings</h2>
          <button type="button" class="ps-close" data-ps-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <form class="ps-section" id="psContactForm" novalidate>
          <p class="ps-title">Contact Details</p>
          <div class="ps-field"><label for="psName">Full name</label><input id="psName" type="text" maxlength="80" autocomplete="name"></div>
          <div class="ps-field"><label for="psEmail">Email</label><input id="psEmail" type="email" maxlength="120" autocomplete="email"></div>
          <div class="ps-field"><label for="psPhone">Phone</label><input id="psPhone" type="tel" maxlength="25" autocomplete="tel"></div>
          <button type="submit" class="ps-btn" id="psContactBtn"><i class="fa-solid fa-floppy-disk"></i> Save Contact Details</button>
          <p class="ps-msg hidden" id="psContactMsg"></p>
        </form>
        <form class="ps-section" id="psPinForm" novalidate>
          <p class="ps-title">Change PIN</p>
          <p class="ps-hint">4–6 digits. Avoid repeated or sequential numbers like 1111 or 1234.</p>
          <div class="ps-field"><label for="psCurPin">Current PIN</label><input id="psCurPin" type="password" inputmode="numeric" maxlength="6" autocomplete="current-password"></div>
          <div class="ps-row">
            <div class="ps-field"><label for="psNewPin">New PIN</label><input id="psNewPin" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password"></div>
            <div class="ps-field"><label for="psNewPin2">Confirm new PIN</label><input id="psNewPin2" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password"></div>
          </div>
          <button type="submit" class="ps-btn" id="psPinBtn"><i class="fa-solid fa-key"></i> Change PIN</button>
          <p class="ps-msg hidden" id="psPinMsg"></p>
        </form>
      </div>`;
    document.body.appendChild(wrap);

    const close = () => wrap.classList.add('hidden');
    wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-ps-close]')) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !wrap.classList.contains('hidden')) close(); });

    const showMsg = (id, text, ok) => {
        const el = document.getElementById(id);
        el.textContent = text;
        el.className = `ps-msg ${ok ? 'ok' : 'err'}`;
    };
    const busy = (btn, on, label) => { btn.disabled = on; if (label) btn.innerHTML = label; };
    const errText = (e, fallback) => (e && e.code && String(e.code).startsWith('functions/') && e.message && e.message !== 'internal') ? e.message : fallback;

    document.getElementById('psContactForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('psContactBtn');
        const name = document.getElementById('psName').value.trim();
        const email = document.getElementById('psEmail').value.trim();
        const phone = document.getElementById('psPhone').value.trim();
        if (!name) return showMsg('psContactMsg', 'Name cannot be empty.', false);
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showMsg('psContactMsg', 'Enter a valid email address.', false);

        const original = btn.innerHTML;
        busy(btn, true, '<i class="fa-solid fa-spinner fa-spin"></i> Saving…');
        try {
            await httpsCallable(functions, 'updateMyParentContact')({ name, email, phone });
            showMsg('psContactMsg', 'Contact details saved.', true);
            const nameEl = document.getElementById('displayParentName');
            if (nameEl) nameEl.textContent = name;
        } catch (err) {
            console.error('[Parent Settings] updateMyParentContact:', err);
            showMsg('psContactMsg', errText(err, 'Could not save your details. Please try again.'), false);
        }
        busy(btn, false, original);
    });

    document.getElementById('psPinForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('psPinBtn');
        const cur = document.getElementById('psCurPin').value.trim();
        const np = document.getElementById('psNewPin').value.trim();
        const np2 = document.getElementById('psNewPin2').value.trim();
        if (!cur) return showMsg('psPinMsg', 'Enter your current PIN.', false);
        if (!/^\d{4,6}$/.test(np)) return showMsg('psPinMsg', 'New PIN must be 4 to 6 digits.', false);
        if (np !== np2) return showMsg('psPinMsg', 'New PINs do not match.', false);
        if (np === cur) return showMsg('psPinMsg', 'New PIN must be different from your current PIN.', false);

        const original = btn.innerHTML;
        busy(btn, true, '<i class="fa-solid fa-spinner fa-spin"></i> Updating…');
        try {
            await httpsCallable(functions, 'changeParentPin')({ currentPin: cur, newPin: np });
            showMsg('psPinMsg', 'PIN changed. Use your new PIN next time you sign in.', true);
            ['psCurPin', 'psNewPin', 'psNewPin2'].forEach(id => { document.getElementById(id).value = ''; });
        } catch (err) {
            console.error('[Parent Settings] changeParentPin:', err);
            showMsg('psPinMsg', errText(err, 'Could not change your PIN. Please try again.'), false);
        }
        busy(btn, false, original);
    });
}

async function openParentSettings(session) {
    if (!session) return;
    ensureSettingsModal();
    ['psContactMsg', 'psPinMsg'].forEach(id => document.getElementById(id).className = 'ps-msg hidden');
    document.getElementById('parentSettingsModal').classList.remove('hidden');
    try {
        const snap = await getDoc(doc(db, 'parents', session.parentId));
        if (snap.exists()) {
            const d = snap.data();
            document.getElementById('psName').value = d.name || '';
            document.getElementById('psEmail').value = d.email || '';
            document.getElementById('psPhone').value = d.phone || '';
        }
    } catch (e) {
        console.error('[Parent Settings] load contact:', e);
    }
    document.getElementById('psName').focus();
}
