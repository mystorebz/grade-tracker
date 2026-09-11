// ── PHASE 1 MILESTONE 6: ATTENDANCE (student read-only flow) ────────────
// Shows the student's own attendance history, one month at a time — each
// month view is a single bounded range query (loadAttendanceHistoryForStudent,
// assets/js/attendance.js), so paging through a whole semester is cheap and
// needs no semester-boundary logic. Deliberately no percentage/rate math
// here (out of scope for this milestone) — raw per-day status only.
import { requireAuth } from '../../assets/js/auth.js';
import { injectStudentLayout } from '../../assets/js/layout-student.js';
import { loadSchoolClasses, resolveClassNamesToIds, loadSchoolHeaderInfo } from '../../assets/js/utils.js';
import { loadAttendanceHistoryForStudent } from '../../assets/js/attendance.js';

// ── 1. AUTH & LAYOUT ──────────────────────────────────────────────────────
const session = requireAuth('student', '../login.html');
if (session) {
    injectStudentLayout('attendance', 'Attendance', 'Your attendance history, month by month');
}

// ── 2. STATE ──────────────────────────────────────────────────────────────
let classId = null;
let viewYear, viewMonth; // viewMonth is 0-indexed, same as Date's own convention

const STATUS_META = {
    present: { label: 'Present', color: '#059669', bg: '#ecfdf5', border: '#a7f3d0' },
    absent:  { label: 'Absent',  color: '#dc2626', bg: '#fef2f2', border: '#fecaca' },
    tardy:   { label: 'Tardy',   color: '#d97706', bg: '#fffbeb', border: '#fde68a' },
    excused: { label: 'Excused', color: '#475569', bg: '#f1f5f9', border: '#cbd5e1' },
};

const els = {};

function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function pad2(n) { return String(n).padStart(2, '0'); }
function ymd(y, m, d) { return `${y}-${pad2(m + 1)}-${pad2(d)}`; }
function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }

// ── 3. INIT ───────────────────────────────────────────────────────────────
async function init() {
    if (!session) return;
    cacheEls();
    wireEvents();

    const today = new Date();
    viewYear = today.getFullYear();
    viewMonth = today.getMonth();

    loadSchoolHeaderInfo(session.schoolId).then(({ schoolName, semesterName }) => {
        const schoolEl = document.getElementById('displaySchoolName');
        const semEl = document.getElementById('activeSemesterDisplay');
        if (schoolEl) schoolEl.textContent = schoolName;
        if (semEl) semEl.textContent = semesterName;
    });

    const className = session.studentData?.className;
    if (!className) {
        showEmptyState("You aren't assigned to a class yet — check back once you're enrolled.");
        return;
    }

    try {
        const schoolClasses = await loadSchoolClasses(session.schoolId);
        const resolved = resolveClassNamesToIds([className], schoolClasses).resolved;
        if (!resolved.length) {
            showEmptyState("Your class couldn't be found. Check back later or contact your teacher.");
            return;
        }
        classId = resolved[0].id;
    } catch (e) {
        console.error('[Student Attendance] init:', e);
        showEmptyState('Something went wrong loading your class. Please try again later.');
        return;
    }

    await loadAndRenderMonth();
}

function cacheEls() {
    ['monthLabel', 'prevMonthBtn', 'nextMonthBtn', 'attLoader', 'attEmpty', 'monthSummary', 'attList']
        .forEach(id => { els[id] = document.getElementById(id); });
}

function wireEvents() {
    els.prevMonthBtn.addEventListener('click', () => {
        viewMonth -= 1;
        if (viewMonth < 0) { viewMonth = 11; viewYear -= 1; }
        loadAndRenderMonth();
    });
    els.nextMonthBtn.addEventListener('click', () => {
        viewMonth += 1;
        if (viewMonth > 11) { viewMonth = 0; viewYear += 1; }
        loadAndRenderMonth();
    });
}

function showEmptyState(message) {
    els.attLoader?.classList.add('hidden');
    els.attList.innerHTML = '';
    els.monthSummary.innerHTML = '';
    els.attEmpty.textContent = message;
    els.attEmpty.classList.remove('hidden');
}

// ── 4. LOAD + RENDER ONE MONTH ───────────────────────────────────────────
async function loadAndRenderMonth() {
    els.monthLabel.textContent = new Date(viewYear, viewMonth, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    els.attEmpty.classList.add('hidden');
    els.attLoader.classList.remove('hidden');
    els.attList.innerHTML = '';
    els.monthSummary.innerHTML = '';

    const startDate = ymd(viewYear, viewMonth, 1);
    const endDate = ymd(viewYear, viewMonth, daysInMonth(viewYear, viewMonth));

    try {
        const history = await loadAttendanceHistoryForStudent(session.schoolId, classId, session.studentId, startDate, endDate);
        els.attLoader.classList.add('hidden');

        if (!history.length) {
            showEmptyState('No attendance has been recorded for this month yet.');
            return;
        }

        renderSummary(history);
        renderList(history);
    } catch (e) {
        console.error('[Student Attendance] loadAndRenderMonth:', e);
        showEmptyState('Something went wrong loading your attendance for this month.');
    }
}

function renderSummary(history) {
    const counts = { present: 0, absent: 0, tardy: 0, excused: 0 };
    history.forEach(h => { if (counts[h.status] !== undefined) counts[h.status]++; });

    els.monthSummary.innerHTML = Object.keys(STATUS_META).map(st => `
        <div class="flex items-center gap-2 bg-white border border-slate-200 rounded-xl px-3.5 py-2.5">
            <span class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background:${STATUS_META[st].color}"></span>
            <span class="text-lg font-black text-slate-700">${counts[st] || 0}</span>
            <span class="text-[11px] font-bold text-slate-400 uppercase tracking-wider">${STATUS_META[st].label}</span>
        </div>`).join('');
}

function renderList(history) {
    const sorted = history.slice().sort((a, b) => a.date.localeCompare(b.date));
    els.attList.innerHTML = sorted.map(h => {
        const meta = STATUS_META[h.status] || STATUS_META.excused;
        const dateObj = new Date(Number(h.date.slice(0, 4)), Number(h.date.slice(5, 7)) - 1, Number(h.date.slice(8, 10)));
        return `
        <div class="flex items-center justify-between gap-3 bg-white border border-slate-200 rounded-xl px-4 py-3">
            <p class="font-bold text-slate-700 text-sm">${escHtml(dateObj.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }))}</p>
            <span class="text-[11px] font-black uppercase tracking-wider px-2.5 py-1 rounded-lg" style="color:${meta.color};background:${meta.bg};border:1px solid ${meta.border}">${meta.label}</span>
        </div>`;
    }).join('');
}

init();
