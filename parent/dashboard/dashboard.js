// ── PHASE 3 STEP 3: PARENT DASHBOARD (landing hub) ───────────────────────
// A parent's session (set at login by student/login.js's handleParentLogin)
// carries linkedStudents straight off the mintParentToken custom-token
// claims — [{ studentId, schoolId }, ...]. This page resolves each entry
// into a display card (student name, school name, class) and routes a
// click into the read-only unified view (parent/view/view.js) for that
// one child. No child-management UI here (add/remove a linked student is
// entirely a teacher/admin action via linkOrCreateParent, never the
// parent's own) — this page only ever reads.
import { db, auth } from '../../assets/js/firebase-init.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth, logout } from '../../assets/js/auth.js';

// ── 1. AUTH ───────────────────────────────────────────────────────────────
const session = requireAuth('parent', '../../student/login.html');

const els = {};

function escHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function cacheEls() {
    ['dashLoader', 'childCount', 'childGrid', 'parentIdDisplay', 'logoutBtn']
        .forEach(id => { els[id] = document.getElementById(id); });
}

function wireEvents() {
    els.logoutBtn.addEventListener('click', () => logout('../../student/login.html'));
}

function showEmptyState(message) {
    els.dashLoader.classList.add('hidden');
    els.childCount.classList.add('hidden');
    els.childGrid.innerHTML = `<div class="col-span-full text-center py-10 text-slate-400 text-[13px] font-bold bg-white rounded-xl border border-slate-200">${escHtml(message)}</div>`;
}

function childViewUrl(studentId, schoolId) {
    const params = new URLSearchParams({ studentId, schoolId });
    return `../view/view.html?${params.toString()}`;
}

const AVATAR_COLORS = ['#4f46e5', '#0d9488', '#d97706', '#dc2626', '#0ea5e9', '#7c3aed'];

function renderChildCard(child, idx) {
    const initial = (child.name || 'S').charAt(0).toUpperCase();
    const color = AVATAR_COLORS[idx % AVATAR_COLORS.length];
    return `
    <a href="${escHtml(childViewUrl(child.studentId, child.schoolId))}" class="pd-card">
        <div class="pd-avatar" style="background:${color}22;color:${color}">${escHtml(initial)}</div>
        <div>
            <p class="pd-card-name">${escHtml(child.name) || 'Student'}</p>
            <p class="pd-card-meta">${escHtml(child.className) || 'Unassigned class'}</p>
            <p class="pd-card-meta">${escHtml(child.schoolName) || ''}</p>
        </div>
        <span class="pd-card-cta">View Grades, Attendance &amp; Class Stream <i class="fa-solid fa-arrow-right"></i></span>
    </a>`;
}

// ── 2. LOAD EACH LINKED CHILD ─────────────────────────────────────────────
// One getDoc per linked student + per distinct school, all in parallel —
// a family's linkedStudents list is small by construction (mintParentToken's
// own comment notes the ~1000-byte custom-claim ceiling), so this never
// approaches a query-fanout concern the way a school-wide list would.
async function loadChildren() {
    const linked = Array.isArray(session.linkedStudents) ? session.linkedStudents : [];

    if (!linked.length) {
        showEmptyState("No students are linked to your account yet. Contact your child's school to have your account linked.");
        return;
    }

    try {
        const schoolIds = [...new Set(linked.map(l => l.schoolId).filter(Boolean))];
        const [studentSnaps, schoolSnaps] = await Promise.all([
            Promise.all(linked.map(l => getDoc(doc(db, 'students', l.studentId)))),
            Promise.all(schoolIds.map(id => getDoc(doc(db, 'schools', id))))
        ]);

        const schoolNameById = {};
        schoolSnaps.forEach((snap, i) => {
            schoolNameById[schoolIds[i]] = snap.exists() ? (snap.data().schoolName || '') : '';
        });

        const children = studentSnaps.map((snap, i) => {
            const link = linked[i];
            if (!snap.exists()) {
                return { studentId: link.studentId, schoolId: link.schoolId, name: 'Student record unavailable', className: '', schoolName: schoolNameById[link.schoolId] || '' };
            }
            const data = snap.data();
            return {
                studentId: snap.id,
                schoolId: link.schoolId,
                name: data.name || 'Student',
                className: data.className || '',
                schoolName: schoolNameById[link.schoolId] || ''
            };
        });

        children.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

        els.dashLoader.classList.add('hidden');
        els.childCount.classList.remove('hidden');
        els.childCount.textContent = `${children.length} student${children.length === 1 ? '' : 's'} linked to your account`;
        els.childGrid.innerHTML = children.map(renderChildCard).join('');
    } catch (e) {
        console.error('[Parent Dashboard] loadChildren:', e);
        showEmptyState('Something went wrong loading your children. Please try again later.');
    }
}

// ── 3. INIT ───────────────────────────────────────────────────────────────
function init() {
    if (!session) return;
    cacheEls();
    wireEvents();
    els.parentIdDisplay.textContent = `Parent ID: ${session.parentId}`;
    loadChildren();
}

init();
