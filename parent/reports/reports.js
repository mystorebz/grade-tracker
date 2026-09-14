// ── PHASE 3: PARENT REPORTS (native HTML/CSS, print-to-PDF) ──────────────
// Per this mandate: no external PDF library. The "report" is just this
// page's own HTML/CSS, and "Generate Report" is a plain window.print() —
// the browser's own print dialog already offers "Save as PDF" on every
// platform this app supports, so that's the entire PDF story. The
// @media print block below hides the sidebar/topbar/button and lets the
// four content sections (Current Grades, Academic History, Attendance,
// Evaluations) print as a single clean sheet — this mirrors the same four
// areas the student portal's own nav groups under Grades/History/
// Attendance/Evaluations, even though the student side doesn't have a
// combined single-page version of its own to literally copy from (there's
// no student/history or student/reports page in this codebase yet — the
// nav link exists in assets/js/layout-student.js but nothing is behind
// it). Active child comes from the sidebar's Student Selector, same
// convention as every other parent drill-down page.
import { db } from '../../assets/js/firebase-init.js';
import { collection, doc, getDoc, getDocs, query, where }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectParentLayout, getActiveChild } from '../layout-parent.js';
import { calculateWeightedAverage, resolveGradeWeights, letterGrade, gradeColorClass, getTeacherDocRef } from '../../assets/js/utils.js';
import { loadAttendanceHistoryForStudent } from '../../assets/js/attendance.js';

const session = requireAuth('parent', '../../student/login.html');
const activeChild = session ? getActiveChild(session) : null;
const studentId = activeChild?.studentId || null;
const schoolId = activeChild?.schoolId || null;

injectParentLayout('reports', 'Reports', 'Print or save a full progress report');

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
    ['reportLoader', 'reportError', 'reportSheet', 'printBtn',
     'rptStudentName', 'rptStudentMeta', 'rptGeneratedAt',
     'rptCurrentGrades', 'rptHistory', 'rptAttendance', 'rptEvaluations'
    ].forEach(id => { els[id] = document.getElementById(id); });
}

function showFatalError(message) {
    els.reportLoader.classList.add('hidden');
    els.reportError.textContent = message;
    els.reportError.classList.remove('hidden');
}

// ── CURRENT GRADES — same read shape as parent/view/view.js's loadGrades ──
async function renderCurrentGrades(studentData, schoolData) {
    const semId = schoolData.activeSemesterId;
    if (!semId) {
        els.rptCurrentGrades.innerHTML = '<p class="rpt-empty">No active grading period set by the school.</p>';
        return;
    }

    const teacherId = studentData.teacherId;
    const [tSnap, gSnap] = await Promise.all([
        teacherId ? getDoc(getTeacherDocRef(schoolId, teacherId)) : Promise.resolve(null),
        getDocs(query(
            collection(db, 'students', studentId, 'grades'),
            where('schoolId', '==', schoolId),
            where('semesterId', '==', semId)
        ))
    ]);

    let teacherRubric = null;
    if (tSnap && tSnap.exists()) {
        teacherRubric = await resolveGradeWeights(schoolId, teacherId, { legacyTeacherData: tSnap.data() });
    }

    const grades = gSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (!grades.length) {
        els.rptCurrentGrades.innerHTML = '<p class="rpt-empty">No grades recorded for the current grading period yet.</p>';
        return;
    }

    const bySub = {};
    grades.forEach(g => {
        const sub = g.subject || 'Uncategorized';
        (bySub[sub] = bySub[sub] || []).push(g);
    });

    const entries = Object.entries(bySub).sort((a, b) => a[0].localeCompare(b[0]));
    els.rptCurrentGrades.innerHTML = `<div class="rpt-grade-grid">${entries.map(([subject, subGrades]) => {
        const avg = calculateWeightedAverage(subGrades, teacherRubric);
        const avgRnd = avg !== null ? Math.round(avg) : null;
        return `
        <div class="rpt-grade-tile">
            <p class="g-subject">${escHtml(subject)}</p>
            ${avgRnd !== null
                ? `<p class="g-avg ${gradeColorClass(avgRnd)}">${avgRnd}% <span style="font-size:12px;font-weight:700;color:#94a3b8;">${letterGrade(avgRnd)}</span></p>`
                : `<p class="g-avg text-slate-300">—</p>`}
        </div>`;
    }).join('')}</div>`;
}

// ── ACADEMIC HISTORY — every grade this child has, grouped by semester ───
// Unlike Current Grades (which resolves the CURRENT teacher's real
// weighting rubric, exactly as parent/view/view.js already does), a past
// semester's grades may have been entered by a different teacher whose
// rubric would need its own lookup. Grade docs do carry their own
// teacherId (saveGrade in utils.js writes it), so this resolves each
// distinct historical teacherId's rubric once and applies it to that
// teacher's own grades — calculateWeightedAverage's own built-in fallback
// (flat average when no weights are found) covers any teacher whose
// rubric can't be resolved, so a subject's historical average is never
// just silently dropped for lack of a configured weighting.
async function renderAcademicHistory() {
    const snap = await getDocs(query(
        collection(db, 'students', studentId, 'grades'),
        where('schoolId', '==', schoolId)
    ));
    const allGrades = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (!allGrades.length) {
        els.rptHistory.innerHTML = '<p class="rpt-empty">No historical grade records for this student yet.</p>';
        return;
    }

    const teacherIds = [...new Set(allGrades.map(g => g.teacherId).filter(Boolean))];
    const teacherDocs = await Promise.all(teacherIds.map(id => getDoc(getTeacherDocRef(schoolId, id)).catch(() => null)));
    const rubricByTeacher = new Map();
    await Promise.all(teacherIds.map(async (id, i) => {
        const tSnap = teacherDocs[i];
        const legacyTeacherData = tSnap && tSnap.exists() ? tSnap.data() : null;
        rubricByTeacher.set(id, legacyTeacherData ? await resolveGradeWeights(schoolId, id, { legacyTeacherData }) : null);
    }));

    // Group by semester (semesterName, falling back to semesterId), then subject.
    const bySemester = new Map();
    allGrades.forEach(g => {
        const semKey = g.semesterName || g.semesterId || 'Unspecified Term';
        if (!bySemester.has(semKey)) bySemester.set(semKey, { grades: [], minDate: g.date || g.createdAt || '' });
        const bucket = bySemester.get(semKey);
        bucket.grades.push(g);
        const d = g.date || g.createdAt || '';
        if (d && (!bucket.minDate || d < bucket.minDate)) bucket.minDate = d;
    });

    // Most recent term first.
    const semesterEntries = [...bySemester.entries()].sort((a, b) => (b[1].minDate || '').localeCompare(a[1].minDate || ''));

    const tables = semesterEntries.map(([semName, bucket]) => {
        const bySub = {};
        bucket.grades.forEach(g => {
            const sub = g.subject || 'Uncategorized';
            (bySub[sub] = bySub[sub] || []).push(g);
        });
        const rows = Object.entries(bySub).sort((a, b) => a[0].localeCompare(b[0])).map(([subject, subGrades]) => {
            const teacherId = subGrades.find(g => g.teacherId)?.teacherId;
            const rubric = teacherId ? rubricByTeacher.get(teacherId) : null;
            const avg = calculateWeightedAverage(subGrades, rubric);
            const avgRnd = avg !== null ? Math.round(avg) : null;
            return `<tr><td>${escHtml(subject)}</td><td>${subGrades.length}</td><td class="${avgRnd !== null ? gradeColorClass(avgRnd) : ''}">${avgRnd !== null ? avgRnd + '% (' + letterGrade(avgRnd) + ')' : '—'}</td></tr>`;
        }).join('');
        const overall = calculateWeightedAverage(bucket.grades, null);
        const overallRnd = overall !== null ? Math.round(overall) : null;
        return `
        <div style="margin-bottom:16px;">
            <p style="font-size:12.5px;font-weight:800;color:#0d1f35;margin:0 0 6px;">${escHtml(semName)}</p>
            <table class="rpt-history-table">
                <thead><tr><th>Subject</th><th># Grades</th><th>Average</th></tr></thead>
                <tbody>${rows}
                <tr class="rpt-overall-row"><td>Overall</td><td>${bucket.grades.length}</td><td>${overallRnd !== null ? overallRnd + '%' : '—'}</td></tr>
                </tbody>
            </table>
        </div>`;
    }).join('');

    els.rptHistory.innerHTML = tables;
}

// ── ATTENDANCE — full-history summary (counts, not a day-by-day list) ────
async function renderAttendance() {
    const end = new Date();
    const start = new Date(2000, 0, 1); // effectively "all-time" for this app's lifetime
    const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    const history = await loadAttendanceHistoryForStudent(schoolId, '', studentId, ymd(start), ymd(end));
    if (!history.length) {
        els.rptAttendance.innerHTML = '<p class="rpt-empty">No attendance records for this student yet.</p>';
        return;
    }

    const counts = { present: 0, absent: 0, tardy: 0, excused: 0 };
    history.forEach(h => { if (counts[h.status] !== undefined) counts[h.status]++; });

    const LABELS = { present: 'Present', absent: 'Absent', tardy: 'Tardy', excused: 'Excused' };
    els.rptAttendance.innerHTML = `<div class="rpt-att-summary">${Object.keys(LABELS).map(k => `
        <div class="rpt-att-chip"><span class="n">${counts[k]}</span><span class="l">${LABELS[k]}</span></div>`).join('')}
        <div class="rpt-att-chip"><span class="n">${history.length}</span><span class="l">Total Days Recorded</span></div>
    </div>`;
}

// ── EVALUATIONS — condensed list (type, term, teacher, date, status) ─────
// Full ratings/written notes are already available on the dedicated
// parent/evaluations page — this report keeps each entry to one line so a
// printed multi-year history stays a reasonable page count.
function classifyEvalLabel(ev) {
    const LABELS = {
        academic: 'Academic Progress', academic_report_card: 'Report Card', end_of_year: 'End-of-Year',
        behavioral: 'Behavioral & Conduct', midterm_review: 'Mid-Term Review', parent_conference: 'Parent Conference',
        learning_support: 'Learning Support Plan'
    };
    return ev.type === 'custom' ? (ev.customTypeName || 'Custom Evaluation') : (LABELS[ev.type] || ev.type || 'Evaluation');
}

async function renderEvaluations() {
    const snap = await getDocs(query(
        collection(db, 'students', studentId, 'evaluations'),
        where('schoolId', '==', schoolId)
    ));
    const evaluations = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    if (!evaluations.length) {
        els.rptEvaluations.innerHTML = '<p class="rpt-empty">No evaluations have been filed for this student yet.</p>';
        return;
    }

    els.rptEvaluations.innerHTML = evaluations.map(ev => `
        <div class="rpt-eval-card">
            <p class="e-type">${escHtml(classifyEvalLabel(ev))}${ev.status ? ' — ' + escHtml(ev.status) : ''}</p>
            <p class="e-meta">${escHtml(ev.semesterName || '')} &middot; Filed by ${escHtml(ev.teacherName || 'a teacher')} on ${escHtml(ev.date || '')}</p>
        </div>`).join('');
}

// ── INIT ───────────────────────────────────────────────────────────────
async function init() {
    if (!session) return;
    cacheEls();
    els.printBtn.addEventListener('click', () => window.print());

    if (!studentId || !schoolId) {
        showFatalError('No student is linked to your account yet — contact your school to get linked.');
        return;
    }

    try {
        const [studentSnap, schoolSnap] = await Promise.all([
            getDoc(doc(db, 'students', studentId)),
            getDoc(doc(db, 'schools', schoolId))
        ]);
        if (!studentSnap.exists()) {
            showFatalError('This student record is no longer available.');
            return;
        }
        const studentData = studentSnap.data();
        const schoolData = schoolSnap.exists() ? schoolSnap.data() : {};

        els.rptStudentName.textContent = studentData.name || 'Student';
        els.rptStudentMeta.textContent = `${schoolData.schoolName || ''}${studentData.className ? ' · Class: ' + studentData.className : ''}`;
        els.rptGeneratedAt.textContent = `Generated ${new Date().toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}`;

        await Promise.all([
            renderCurrentGrades(studentData, schoolData),
            renderAcademicHistory(),
            renderAttendance(),
            renderEvaluations()
        ]);

        els.reportLoader.classList.add('hidden');
        els.reportSheet.classList.remove('hidden');
    } catch (e) {
        console.error('[Parent Reports] init:', e);
        showFatalError('Something went wrong building this report. Please try again later.');
    }
}

init();
