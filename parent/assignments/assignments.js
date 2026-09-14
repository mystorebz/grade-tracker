// ── DUE DATE & LATE TRACKING ENGINE: PARENT ASSIGNMENTS ──────────────────
// ARCHITECTURAL MANDATE: CLIENT-SIDE DUE DATES & CLOUD FUNCTION PURGE. This
// page used to call a dedicated getParentAssignments Cloud Function, which
// did both the Firestore fetch AND the due-date/late-tracking resolution
// server-side — the user vetoed that on cloud-compute-cost grounds. That
// function is now deleted outright. This page fetches directly from
// Firestore instead, mirroring student/assignments/assignments.js's own
// init() step for step:
//   students/{studentId} -> teacherId -> getTeacherDocRef(schoolId,
//   teacherId) -> loadTeacherSubjectsCache() -> loadAssignmentsForSubjects()
//   (filtered to non-draft) -> loadSubmissionsForAssignments() +
//   loadGradesIndexForStudent() in parallel -> resolveAssignmentStatus()
//   per assignment (assets/js/submissions.js — the SAME shared function
//   student/assignments/assignments.js now also imports, so a parent and
//   their child can never see contradictory statuses for the same
//   assignment; there is exactly one implementation of that logic left in
//   the whole codebase).
//
// This is safe to read directly from the client because firestore.rules
// now grants a linked parent GET/LIST on schools/{schoolId}/classes and
// its subjects/assignments subcollections, and GET on the legacy
// schools/{schoolId}/teachers/{teacherId} doc, scoped to schools where
// they have a linked student (isParentLinkedToSchool(schoolId), driven by
// a new flat `linkedSchoolIds` claim on the parent's token) — on the
// premise that class/subject/assignment documents are curriculum
// metadata, not private grades. The per-child submissions subcollection
// nested under each assignment remains strictly locked
// (isLinkedParentOf(studentId, schoolId)) so a parent can only ever read
// their OWN child's submission, never a classmate's — exactly what
// loadSubmissionsForAssignments() below queries.
//
// Theming: per this mandate, amber is reserved specifically for "Missing"
// and "Locked · Not submitted" (both genuinely need a parent's attention);
// a plain "Assigned" item — not yet due — stays neutral so the page
// doesn't cry wolf before there's anything to worry about.
import { db } from '../../assets/js/firebase-init.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectParentLayout, getActiveChild } from '../layout-parent.js';
import { getTeacherDocRef, loadTeacherSubjectsCache } from '../../assets/js/utils.js';
import {
    loadAssignmentsForSubjects,
    loadSubmissionsForAssignments,
    loadGradesIndexForStudent,
    resolveAssignmentStatus
} from '../../assets/js/submissions.js';

const session = requireAuth('parent', '../../student/login.html');
const activeChild = session ? getActiveChild(session) : null;
const studentId = activeChild?.studentId || null;
const schoolId = activeChild?.schoolId || null;

injectParentLayout('assignments', 'Assignments', "A read-only mirror of your child's assignment list");

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

function formatDate(iso) {
    if (!iso) return '';
    try {
        const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
        // Date-only strings (YYYY-MM-DD — every due date saved before the
        // due-date-&-time engine) must be parsed as local calendar
        // components — new Date('YYYY-MM-DD') parses as UTC midnight, which
        // renders a day early in any timezone behind UTC. A full ISO
        // datetime string (a due date saved with a time) now also shows
        // its time-of-day.
        const d = isDateOnly
            ? new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)))
            : new Date(iso);
        return isDateOnly
            ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
            : d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch (e) { return iso; }
}

function cacheEls() {
    ['asgLoader', 'asgError', 'asgContent', 'asgSummary',
     'cntAttention', 'cntSubmitted', 'cntGraded',
     'listAttention', 'listSubmitted', 'listGraded'
    ].forEach(id => { els[id] = document.getElementById(id); });
}

function showFatalError(message) {
    els.asgLoader.classList.add('hidden');
    els.asgError.innerHTML = `<i class="fa-solid fa-clipboard-list"></i>${escHtml(message)}`;
    els.asgError.classList.remove('hidden');
}

// Sections mirror resolveAssignmentStatus()'s `category` field: 'graded' ->
// Graded, 'done' -> Submitted (covers Done, Done Late, and Locked ·
// Submitted), and 'todo'/'missing' both land in Needs Attention (Assigned
// isn't urgent yet, but it also isn't Submitted or Graded, so it has
// nowhere else honest to go) — the badge color is what actually signals
// urgency within that section: amber for Missing and Locked · Not
// submitted, neutral for a plain Assigned that isn't due yet.
// --- START: classify ---
function classify(a) {
    if (a.category === 'graded') {
        return { section: 'graded', statusClass: 'asg-status-graded' };
    }
    if (a.category === 'done') {
        return { section: 'submitted', statusClass: a.late ? 'asg-status-attention' : 'asg-status-submitted' };
    }
    const needsAttention = a.category === 'missing' || a.status === 'Locked · Not submitted';
    return { section: 'attention', statusClass: needsAttention ? 'asg-status-attention' : 'asg-status-neutral' };
}
// --- END: classify ---

function renderCard(a, cls) {
    return `
    <div class="asg-card">
        <p class="a-title">${escHtml(a.title)}</p>
        <div class="a-tags">
            ${a.subjectName ? `<span class="a-tag">${escHtml(a.subjectName)}</span>` : ''}
            <span class="a-tag">${escHtml(a.type)}</span>
            <span class="a-tag">/ ${a.maxScore}</span>
        </div>
        ${a.dueDate ? `<p class="a-due"><i class="fa-regular fa-calendar mr-1"></i>Due ${escHtml(formatDate(a.dueDate))}</p>` : '<p class="a-due">No due date set</p>'}
        <span class="a-status ${cls.statusClass}">${escHtml(a.status)}</span>
    </div>`;
}

function renderEmpty(container, message) {
    container.innerHTML = `<div class="asg-empty-section">${escHtml(message)}</div>`;
}

function render(assignments) {
    // Soonest due date first; undated assignments sink to the bottom.
    const sorted = assignments.slice().sort((a, b) => {
        if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
        if (a.dueDate) return -1;
        if (b.dueDate) return 1;
        return 0;
    });

    const buckets = { attention: [], submitted: [], graded: [] };
    sorted.forEach(a => {
        const cls = classify(a);
        buckets[cls.section].push(renderCard(a, cls));
    });

    els.cntAttention.textContent = buckets.attention.length;
    els.cntSubmitted.textContent = buckets.submitted.length;
    els.cntGraded.textContent = buckets.graded.length;

    if (buckets.attention.length) els.listAttention.innerHTML = buckets.attention.join('');
    else renderEmpty(els.listAttention, 'Nothing needs attention right now.');

    if (buckets.submitted.length) els.listSubmitted.innerHTML = buckets.submitted.join('');
    else renderEmpty(els.listSubmitted, 'Nothing submitted yet.');

    if (buckets.graded.length) els.listGraded.innerHTML = buckets.graded.join('');
    else renderEmpty(els.listGraded, 'Nothing graded yet.');

    els.asgSummary.textContent = `${sorted.length} assignment${sorted.length === 1 ? '' : 's'} on record.`;
}

function renderAllEmpty(message) {
    renderEmpty(els.listAttention, 'Nothing needs attention right now.');
    renderEmpty(els.listSubmitted, 'Nothing submitted yet.');
    renderEmpty(els.listGraded, 'Nothing graded yet.');
    els.cntAttention.textContent = '0';
    els.cntSubmitted.textContent = '0';
    els.cntGraded.textContent = '0';
    els.asgSummary.textContent = message;
}

async function init() {
    if (!session) return;
    cacheEls();

    if (!studentId || !schoolId) {
        showFatalError('No student is linked to your account yet — contact your school to get linked.');
        return;
    }

    try {
        // Same resolution path student/assignments/assignments.js uses for
        // itself — every query below is built from this child's own
        // studentId/schoolId, never any other family's.
        const studentSnap = await getDoc(doc(db, 'students', studentId));
        if (!studentSnap.exists()) {
            showFatalError('Student record not found.');
            return;
        }
        const teacherId = studentSnap.data().teacherId;
        if (!teacherId) {
            els.asgLoader.classList.add('hidden');
            els.asgContent.classList.remove('hidden');
            renderAllEmpty("Your child doesn't have a teacher assigned yet.");
            return;
        }

        const teacherSnap = await getDoc(getTeacherDocRef(schoolId, teacherId));
        const legacyTeacherData = teacherSnap.exists() ? teacherSnap.data() : null;

        const { subjectsCache, resolvedClasses } = await loadTeacherSubjectsCache(schoolId, teacherId, legacyTeacherData);

        // Two schema generations exist side by side: legacy assignments use
        // type/maxScore/date, the new "Add Work" model uses workType/
        // pointsPossible/dueDate instead — normalized here exactly as
        // student/assignments/assignments.js's normalizeAssignment() does,
        // so every render function below works unchanged for both. 'draft'
        // status is filtered out here, matching the student view.
        const assignments = loadAssignmentsForSubjects(subjectsCache, resolvedClasses)
            .filter(a => a.status !== 'draft')
            .map(a => ({
                ...a,
                title: a.title || 'Untitled assignment',
                type: a.workType || a.type || 'Assignment',
                maxScore: a.pointsPossible ?? a.maxScore ?? 0,
                dueDate: a.dueDate || a.date || '',
            }));

        els.asgLoader.classList.add('hidden');
        els.asgContent.classList.remove('hidden');

        if (!assignments.length) {
            renderAllEmpty("No assignments have been prepared for this student's class yet.");
            return;
        }

        const [subMap, gradeMap] = await Promise.all([
            loadSubmissionsForAssignments(schoolId, assignments, studentId),
            loadGradesIndexForStudent(schoolId, studentId)
        ]);

        // Same three-question resolution order as the (now-deleted)
        // getParentAssignments Cloud Function used to run server-side —
        // here it's the exact same shared function the student portal
        // calls, imported from assets/js/submissions.js.
        const resolved = assignments.map(a => {
            const submission = subMap.get(a.id) || null;
            const grade = gradeMap.get(a.id) || null;
            const { status, category, late } = resolveAssignmentStatus({
                grade, locked: !!a.locked, hasSubmission: !!submission,
                submittedAt: submission?.submittedAt, dueDate: a.dueDate,
            });
            return {
                id: a.id,
                title: a.title,
                type: a.type,
                maxScore: a.maxScore,
                dueDate: a.dueDate,
                subjectName: a.subjectName,
                className: a.className,
                status, category, late,
            };
        });

        render(resolved);
    } catch (e) {
        console.error('[Parent Assignments] init:', e);
        showFatalError('Something went wrong loading assignments. Please try again later.');
    }
}

init();
