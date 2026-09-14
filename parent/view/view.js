// ── PHASE 3 STEP 3: PARENT READ-ONLY STUDENT VIEW (Grades / Attendance) ──
// Reached from the persistent parent sidebar (parent/layout-parent.js) via
// ../view/view.html?tab=grades or ?tab=attendance — NOT a per-student URL.
// Phase 3 Step 3's Layout Strategy moved child selection into the sidebar's
// Student Selector dropdown, shared across every drill-down page, so which
// child this page reads comes from getActiveChild(session)
// (parent/layout-parent.js's localStorage-backed selection, itself always
// re-validated against this session's own linkedStudents) rather than a URL
// param a hand-edited link could tamper with.
//
// Every read below re-uses the SAME data models the student's own pages
// already use (assets/js/attendance.js's loadAttendanceHistoryForStudent,
// assets/js/utils.js's calculateWeightedAverage/resolveGradeWeights) rather
// than duplicating their logic. Nothing on this page ever writes anything:
// no submission forms, no grade entry, no attendance marking — every
// control here is view-only, same promise student/lessons/view.html's own
// header comment makes for lessons, and now also backed by firestore.rules'
// explicit parent-write-deny (Phase 3 Step 2).
import { db } from '../../assets/js/firebase-init.js';
import { collection, doc, getDoc, getDocs, query, where }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectParentLayout, getActiveChild } from '../layout-parent.js';
import { calculateWeightedAverage, resolveGradeWeights, letterGrade, gradeColorClass } from '../../assets/js/utils.js';
import { loadAttendanceHistoryForStudent } from '../../assets/js/attendance.js';

// ── 1. TAB + AUTH + ACTIVE CHILD ────────────────────────────────────────
const urlParams = new URLSearchParams(window.location.search);
const tab = urlParams.get('tab') === 'attendance' ? 'attendance' : 'grades';

const session = requireAuth('parent', '../../student/login.html');
const activeChild = session ? getActiveChild(session) : null;
const studentId = activeChild?.studentId || null;
const schoolId = activeChild?.schoolId || null;

injectParentLayout(
    tab,
    tab === 'attendance' ? 'Attendance' : 'Current Grades',
    'Loading…'
);

const els = {};

// Attendance panel state
let viewYear, viewMonth; // viewMonth is 0-indexed, same as Date's own convention

const STATUS_META = {
    present: { label: 'Present', color: '#059669', bg: '#ecfdf5', border: '#a7f3d0' },
    absent:  { label: 'Absent',  color: '#dc2626', bg: '#fef2f2', border: '#fecaca' },
    tardy:   { label: 'Tardy',   color: '#d97706', bg: '#fffbeb', border: '#fde68a' },
    excused: { label: 'Excused', color: '#475569', bg: '#f1f5f9', border: '#cbd5e1' },
};

function escHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function pad2(n) { return String(n).padStart(2, '0'); }
function ymd(y, m, d) { return `${y}-${pad2(m + 1)}-${pad2(d)}`; }
function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }

function cacheEls() {
    ['viewLoader', 'viewError',
     'gradesPanel', 'gradesEmpty', 'gradesOverallRow', 'gradesGrid',
     'attendancePanel', 'prevMonthBtn', 'nextMonthBtn', 'monthLabel', 'attSummary', 'attEmpty', 'attList'
    ].forEach(id => { els[id] = document.getElementById(id); });
}

function showFatalError(message) {
    els.viewLoader.classList.add('hidden');
    els.viewError.textContent = message;
    els.viewError.classList.remove('hidden');
}

function updateTopbarSub(studentData) {
    const sub = document.getElementById('topbarSub');
    if (!sub) return;
    sub.textContent = studentData?.name
        ? `${studentData.name}${studentData.className ? ' · Class: ' + studentData.className : ''}`
        : '';
}

function wireEvents() {
    if (els.prevMonthBtn) els.prevMonthBtn.addEventListener('click', () => {
        viewMonth -= 1;
        if (viewMonth < 0) { viewMonth = 11; viewYear -= 1; }
        loadAndRenderMonth();
    });
    if (els.nextMonthBtn) els.nextMonthBtn.addEventListener('click', () => {
        viewMonth += 1;
        if (viewMonth > 11) { viewMonth = 0; viewYear += 1; }
        loadAndRenderMonth();
    });
}

// ── 2. INIT ──────────────────────────────────────────────────────────────
async function init() {
    if (!session) return;
    cacheEls();
    wireEvents();

    if (!studentId || !schoolId) {
        showFatalError('No student is linked to your account yet — contact your school to get linked.');
        return;
    }

    try {
        const studentSnap = await getDoc(doc(db, 'students', studentId));
        if (!studentSnap.exists()) {
            showFatalError('This student record is no longer available.');
            return;
        }
        const studentData = studentSnap.data();
        updateTopbarSub(studentData);

        els.viewLoader.classList.add('hidden');

        if (tab === 'attendance') {
            els.attendancePanel.classList.remove('hidden');
            const today = new Date();
            viewYear = today.getFullYear();
            viewMonth = today.getMonth();
            await loadAndRenderMonth();
        } else {
            els.gradesPanel.classList.remove('hidden');
            await loadGrades(studentData);
        }
    } catch (e) {
        console.error('[Parent View] init:', e);
        showFatalError('Something went wrong loading this student. Please try again later.');
    }
}

// ── 3. GRADES PANEL ──────────────────────────────────────────────────────
// Same read shape as student/grades/grades.js's own loadGrades(): school doc
// for the active semester, the student's teacher's rubric for weighting, and
// students/{studentId}/grades filtered to that school+semester — just
// rendered as a simpler read-only tile grid (no drill-down modal, no CSV
// export) since this page's job is a quick read, not a full gradebook.
async function loadGrades(studentData) {
    els.gradesGrid.innerHTML = '<div class="page-loader" style="grid-column:1/-1"><i class="fa-solid fa-circle-notch fa-spin"></i><p>Loading grades…</p></div>';

    try {
        const schoolSnap = await getDoc(doc(db, 'schools', schoolId));
        const schoolData = schoolSnap.data() || {};
        const semId = schoolData.activeSemesterId;

        if (!semId) {
            els.gradesGrid.innerHTML = '';
            els.gradesEmpty.textContent = 'No active grading period set by the school.';
            els.gradesEmpty.classList.remove('hidden');
            return;
        }

        const teacherId = studentData.teacherId;

        const [tSnap, gSnap] = await Promise.all([
            teacherId ? getDoc(doc(db, 'teachers', teacherId)) : Promise.resolve(null),
            getDocs(query(
                collection(db, 'students', studentId, 'grades'),
                where('schoolId', '==', schoolId),
                where('semesterId', '==', semId)
            ))
        ]);

        let teacherRubric = [];
        if (tSnap && tSnap.exists()) {
            teacherRubric = await resolveGradeWeights(schoolId, teacherId, { legacyTeacherData: tSnap.data() }) || [];
        }

        const allGrades = gSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        if (!allGrades.length) {
            els.gradesGrid.innerHTML = '';
            els.gradesEmpty.classList.remove('hidden');
            return;
        }

        const bySub = {};
        allGrades.forEach(g => {
            const sub = g.subject || 'Uncategorized';
            if (!bySub[sub]) bySub[sub] = [];
            bySub[sub].push(g);
        });

        let totalAvg = 0, subCount = 0;
        const entries = Object.entries(bySub).sort((a, b) => a[0].localeCompare(b[0]));
        entries.forEach(([, grades]) => {
            const avg = calculateWeightedAverage(grades, teacherRubric);
            if (avg !== null) { totalAvg += avg; subCount++; }
        });
        const overall = subCount > 0 ? Math.round(totalAvg / subCount) : null;

        els.gradesOverallRow.classList.remove('hidden');
        els.gradesOverallRow.textContent = overall !== null
            ? `Overall average: ${overall}% (${letterGrade(overall)})`
            : `${entries.length} subject${entries.length === 1 ? '' : 's'} with grades`;

        els.gradesGrid.innerHTML = entries.map(([subject, grades]) => {
            const avg = calculateWeightedAverage(grades, teacherRubric);
            const avgRnd = avg !== null ? Math.round(avg) : null;
            return `
            <div class="pv-grade-tile">
                <p class="g-subject">${escHtml(subject)}</p>
                ${avgRnd !== null
                    ? `<p class="g-avg ${gradeColorClass(avgRnd)}">${avgRnd}%<span style="font-size:14px;font-weight:700;margin-left:6px;color:#94a3b8;">${letterGrade(avgRnd)}</span></p>`
                    : `<p class="g-avg text-slate-300">—</p>`}
                <p class="g-count">${grades.length} grade${grades.length === 1 ? '' : 's'} recorded</p>
            </div>`;
        }).join('');
    } catch (e) {
        console.error('[Parent View] loadGrades:', e);
        els.gradesGrid.innerHTML = '';
        els.gradesEmpty.textContent = 'Something went wrong loading grades. Please try again later.';
        els.gradesEmpty.classList.remove('hidden');
    }
}

// ── 4. ATTENDANCE PANEL ──────────────────────────────────────────────────
// Direct reuse of loadAttendanceHistoryForStudent (assets/js/attendance.js)
// — the exact same fanned-out students/{studentId}/attendance read the
// student's own attendance.js page uses. classId is accepted for call-site
// compatibility only (see that function's own comment); this page has no
// need to resolve the student's className to a classId just to pass a value
// the query never actually uses.
async function loadAndRenderMonth() {
    els.monthLabel.textContent = new Date(viewYear, viewMonth, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    els.attEmpty.classList.add('hidden');
    els.attList.innerHTML = '<div class="page-loader"><i class="fa-solid fa-circle-notch fa-spin"></i><p>Loading attendance…</p></div>';
    els.attSummary.innerHTML = '';

    const startDate = ymd(viewYear, viewMonth, 1);
    const endDate = ymd(viewYear, viewMonth, daysInMonth(viewYear, viewMonth));

    try {
        const history = await loadAttendanceHistoryForStudent(schoolId, '', studentId, startDate, endDate);
        els.attList.innerHTML = '';

        if (!history.length) {
            els.attEmpty.textContent = 'No attendance has been recorded for this month yet.';
            els.attEmpty.classList.remove('hidden');
            return;
        }

        const counts = { present: 0, absent: 0, tardy: 0, excused: 0 };
        history.forEach(h => { if (counts[h.status] !== undefined) counts[h.status]++; });
        els.attSummary.innerHTML = Object.keys(STATUS_META).map(st => `
            <div class="flex items-center gap-2 bg-white border border-slate-200 rounded-xl px-3.5 py-2.5">
                <span class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background:${STATUS_META[st].color}"></span>
                <span class="text-lg font-black text-slate-700">${counts[st] || 0}</span>
                <span class="text-[11px] font-bold text-slate-400 uppercase tracking-wider">${STATUS_META[st].label}</span>
            </div>`).join('');

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
    } catch (e) {
        console.error('[Parent View] loadAndRenderMonth:', e);
        els.attList.innerHTML = '';
        els.attEmpty.textContent = 'Something went wrong loading attendance. Please try again later.';
        els.attEmpty.classList.remove('hidden');
    }
}

init();
