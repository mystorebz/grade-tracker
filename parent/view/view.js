// ── PHASE 3 STEP 3: PARENT READ-ONLY STUDENT VIEW ────────────────────────
// Reached from a card on parent/dashboard/dashboard.html via
// ?studentId=...&schoolId=.... Every read below re-uses the SAME data
// models the student's own pages already use (assets/js/attendance.js's
// loadAttendanceHistoryForStudent, assets/js/utils.js's
// calculateWeightedAverage/resolveGradeWeights) rather than duplicating
// their logic — the only thing genuinely new here is that studentId/
// schoolId come from the URL (validated against this parent's own
// session.linkedStudents) instead of the caller's own session, and that
// nothing on this page ever writes anything: no submission forms, no grade
// entry, no attendance marking — every control here is view-only, same
// promise student/lessons/view.html's own header comment makes for lessons.
import { db } from '../../assets/js/firebase-init.js';
import { collection, doc, getDoc, getDocs, query, where }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getFunctions, httpsCallable }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { requireAuth } from '../../assets/js/auth.js';
import { calculateWeightedAverage, resolveGradeWeights, letterGrade, gradeColorClass } from '../../assets/js/utils.js';
import { loadAttendanceHistoryForStudent } from '../../assets/js/attendance.js';

// ── 1. AUTH ───────────────────────────────────────────────────────────────
const session = requireAuth('parent', '../../student/login.html');

// ── Functions instance (Class Stream tab — see loadClassStream() below) ──
const functions = getFunctions();
const getParentClassStreamFn = httpsCallable(functions, 'getParentClassStream');

// ── 2. URL PARAMS + OWNERSHIP CHECK ─────────────────────────────────────
// Client-side defense in depth only — the real enforcement is
// firestore.rules' isLinkedParentOf() (Phase 3 Step 4), which every read
// below is actually gated by. This check just avoids firing off a batch of
// reads (and showing a confusing generic error) for a studentId this
// parent's own session doesn't even claim, e.g. a hand-edited URL.
const urlParams = new URLSearchParams(window.location.search);
const studentId = urlParams.get('studentId');
const schoolId = urlParams.get('schoolId');

const els = {};
let currentTab = 'grades';

// Attendance tab state
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
    ['studentNameDisplay', 'studentMetaDisplay', 'viewLoader', 'viewError',
     'tabGradesBtn', 'tabAttendanceBtn', 'tabStreamBtn',
     'gradesPanel', 'gradesEmpty', 'gradesOverallRow', 'gradesGrid',
     'attendancePanel', 'prevMonthBtn', 'nextMonthBtn', 'monthLabel', 'attSummary', 'attEmpty', 'attList',
     'streamPanel', 'streamNotice', 'streamList'
    ].forEach(id => { els[id] = document.getElementById(id); });
}

function showFatalError(message) {
    els.viewLoader.classList.add('hidden');
    els.viewError.textContent = message;
    els.viewError.classList.remove('hidden');
}

// ── 3. TABS ───────────────────────────────────────────────────────────────
function setTab(tab) {
    currentTab = tab;
    els.tabGradesBtn.classList.toggle('pv-active', tab === 'grades');
    els.tabAttendanceBtn.classList.toggle('pv-active', tab === 'attendance');
    els.tabStreamBtn.classList.toggle('pv-active', tab === 'stream');
    els.gradesPanel.classList.toggle('hidden', tab !== 'grades');
    els.attendancePanel.classList.toggle('hidden', tab !== 'attendance');
    els.streamPanel.classList.toggle('hidden', tab !== 'stream');

    if (tab === 'attendance' && !els.attList.dataset.loaded) {
        els.attList.dataset.loaded = '1';
        loadAndRenderMonth();
    }
    if (tab === 'stream' && !els.streamPanel.dataset.loaded) {
        els.streamPanel.dataset.loaded = '1';
        loadClassStream();
    }
}

function wireEvents() {
    els.tabGradesBtn.addEventListener('click', () => setTab('grades'));
    els.tabAttendanceBtn.addEventListener('click', () => setTab('attendance'));
    els.tabStreamBtn.addEventListener('click', () => setTab('stream'));
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

// ── 4. INIT ───────────────────────────────────────────────────────────────
async function init() {
    if (!session) return;
    cacheEls();
    wireEvents();

    if (!studentId || !schoolId) {
        showFatalError('This link is missing information — go back to your dashboard and select a child again.');
        return;
    }

    const isLinked = (session.linkedStudents || []).some(l => l.studentId === studentId && l.schoolId === schoolId);
    if (!isLinked) {
        showFatalError("This student isn't linked to your account.");
        return;
    }

    try {
        const studentSnap = await getDoc(doc(db, 'students', studentId));
        if (!studentSnap.exists()) {
            showFatalError('This student record is no longer available.');
            return;
        }
        const studentData = studentSnap.data();

        els.studentNameDisplay.textContent = studentData.name || 'Student';
        els.studentMetaDisplay.textContent = studentData.className
            ? `Class: ${studentData.className}` : 'Unassigned class';

        els.viewLoader.classList.add('hidden');

        const today = new Date();
        viewYear = today.getFullYear();
        viewMonth = today.getMonth();

        await loadGrades(studentData);
    } catch (e) {
        console.error('[Parent View] init:', e);
        showFatalError('Something went wrong loading this student. Please try again later.');
    }
}

// ── 5. GRADES TAB ─────────────────────────────────────────────────────────
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

// ── 6. ATTENDANCE TAB ─────────────────────────────────────────────────────
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

// ── 7. CLASS STREAM TAB ───────────────────────────────────────────────────
// Reads via the getParentClassStream callable (functions/index.js) rather
// than a direct client-side Firestore query — see that function's own
// comment for why a rules-only grant (like Grades/Attendance got) isn't
// possible here: posts live under schools/{schoolId}/classes/{classId}/
// subjects/{subjectId}/posts, gated by a schoolId token claim a parent's
// token deliberately never carries, with no per-student path to hang a
// rule off. This is a one-shot fetch, not a live onSnapshot subscription
// the way the student's own Class Stream page gets — a parent re-opening
// this tab (or the whole page) re-fetches, which is an acceptable staleness
// trade-off for a read a parent checks occasionally rather than leaves open
// in a classroom all day.
//
// No "Open Lesson" link is rendered for lesson-linked posts here (unlike
// stream.js's own renderPostCard) — that page (student/lessons/view.html)
// calls requireAuth('student', ...) and would just bounce a parent straight
// back to the login screen. Surfacing a link that's guaranteed to dead-end
// is worse than not showing it; a parent-accessible lesson viewer is its
// own follow-up scope, not part of this mandate.
async function loadClassStream() {
    els.streamNotice.classList.remove('hidden');
    els.streamNotice.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin" style="font-size:22px;color:#6366f1;"></i>';
    els.streamList.innerHTML = '';

    try {
        const result = await getParentClassStreamFn({ studentId, schoolId });
        const posts = Array.isArray(result.data?.posts) ? result.data.posts : [];

        if (!posts.length) {
            els.streamNotice.textContent = "No posts yet from this student's teacher.";
            return;
        }

        els.streamNotice.classList.add('hidden');
        els.streamList.innerHTML = posts.map(renderStreamPostCard).join('');
    } catch (e) {
        console.error('[Parent View] loadClassStream:', e);
        els.streamNotice.classList.remove('hidden');
        els.streamNotice.textContent = 'Something went wrong loading Class Stream. Please try again later.';
    }
}

function formatPostDate(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
    catch (e) { return iso; }
}

function renderStreamPostCard(post) {
    const isLessonPlan = post.type === 'lesson_plan';
    const iconBg = isLessonPlan ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-indigo-50 text-indigo-600 border-indigo-200';
    const icon = isLessonPlan ? 'fa-calendar-days' : 'fa-bullhorn';

    return `
    <div class="pv-post-card">
        <div class="flex items-start gap-3">
            <div class="w-8 h-8 rounded-lg ${iconBg} border flex items-center justify-center flex-shrink-0 mt-0.5">
                <i class="fa-solid ${icon} text-sm"></i>
            </div>
            <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2 flex-wrap">
                    ${post.pinned ? '<i class="fa-solid fa-thumbtack text-[10px] text-rose-500" title="Pinned"></i>' : ''}
                    <p class="font-black text-slate-800 text-[14px] m-0">${escHtml(post.title) || (isLessonPlan ? 'Untitled Lesson' : 'Announcement')}</p>
                    ${isLessonPlan && post.lessonDate ? `<span class="text-[10.5px] font-black bg-amber-50 text-amber-700 px-2 py-0.5 rounded border border-amber-200">${escHtml(formatPostDate(post.lessonDate))}</span>` : ''}
                    <span class="text-[10.5px] font-bold bg-slate-100 text-slate-500 px-2 py-0.5 rounded">${escHtml(post.subjectName || '')}</span>
                </div>
                ${post.body ? `<p class="text-[12.5px] text-slate-600 mt-1.5 mb-0 whitespace-pre-wrap">${escHtml(post.body)}</p>` : ''}
                ${isLessonPlan && post.objectives ? `<p class="text-[11.5px] text-slate-500 mt-1.5 mb-0"><span class="font-bold">Objectives:</span> ${escHtml(post.objectives)}</p>` : ''}
                <p class="text-[10.5px] text-slate-400 font-semibold mt-2 mb-0">${escHtml(post.authorName || '')} · ${escHtml(formatPostDate(post.createdAt))}</p>
            </div>
        </div>
    </div>`;
}

init();
