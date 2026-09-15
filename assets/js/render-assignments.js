// ── SHARED ASSIGNMENTS RENDERER (student + parent) ──────────────────────
// ARCHITECTURAL MANDATE: Dashboard Analytics & Parent Portal "Mirror" Sync.
// Extracted from student/assignments/assignments.js and merged with the
// Parent portal's own previously-separate read-only detail renderers
// (parent/assignments/assignments.js: renderParentAnswerDisplay,
// renderParentAnswerSnippet, renderParentRevisionHistory,
// renderParentQuestionCard, renderParentDetailBody) into ONE shared module
// gated by a `readOnly` flag, per this mandate's explicit directive:
// "Implement a state flag (e.g., readOnly: true/false) that the Parent
// portal passes into these shared modules to strip interactivity while
// preserving exact visual parity." There is now exactly one implementation
// of every card/list/detail-panel render function in the whole codebase;
// role only ever branches at a handful of clearly-marked leaves below
// (search for "pageReadOnly").
//
// READ-ONLY ENFORCEMENT: when readOnly is true —
//   - the submission form (textarea/link/file/canvas inputs) and the
//     Submit/Update buttons never render; a plain read-only answer display
//     (ported from the Parent portal's own prior per-type renderer) is
//     used in their place, for every question type.
//   - window.saveMySubmission / window.submitAssessmentResponses both
//     bail out immediately (defense in depth — the buttons that call them
//     are never rendered for a read-only caller, but these are global
//     `window.*` functions, so the guard is enforced here too, not only by
//     hiding the button).
//   - granular detail — per-question scores, teacher notes, attachments,
//     full revision history — is fully preserved; only the ability to
//     type/pick/draw/submit is removed.
// Everything else (card list, subject filter, status pills, the detail
// panel's header/meta chips, revision banners, teacher notes, materials)
// is rendered by the SAME code for both roles.
//
// NORMALIZATIONS made necessary by merging two previously-independent
// implementations into one shared source of truth (called out here so
// they're visible in review, not silently folded in):
//   - Read-only multiple-choice answers now show a Correct/Incorrect badge
//     when the submission carries an objectiveAutoGrade (the Parent
//     portal already did this; the interactive Student input never did
//     and still doesn't — this only affects the read-only leaf).
//   - The "Overall Remarks" section (grade.notes) is now rendered the same
//     way for both assessment AND standard-work assignments, for both
//     roles, instead of standard-work inlining notes into the score card.
//   - The assessment section's top-of-list "your teacher asked you to
//     revise..." banner (previously Student-only) now also appears,
//     re-worded for a parent reader, on the Parent side, since it's purely
//     informational and this is now one shared function.
//   - The detail header's score-vs-due-date chip now uses the same
//     (more precise) submission-status gate for both roles.
//
// Parent sessions carry no session.studentData, so this module (like the
// other four shared render-*.js modules) re-fetches students/{studentId}
// itself for name/teacherId rather than assuming an ambient session shape.
import { getDoc, doc, updateDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { db } from './firebase-init.js';
import { loadTeacherSubjectsCache, getTeacherDocRef, openOverlay, closeOverlay, showMsg, loadSchoolHeaderInfo } from './utils.js';
import {
    loadAssignmentsForSubjects,
    loadSubmissionsForAssignments,
    loadGradesIndexForStudent,
    saveSubmission,
    uploadSubmissionAttachment,
    isSubmissionFrozen,
    isQuestionOpenForRevision,
    resolveAssignmentStatus
} from './submissions.js';

// ── STATE ─────────────────────────────────────────────────────────────
let pageStudentId = null;
let pageSchoolId = null;
let pageReadOnly = false;
let pageStudentName = '';
let assignmentsCache = [];       // merged legacy + new-model, from loadAssignmentsForSubjects
let submissionsById = new Map(); // assignmentId -> submission | null
let gradesById = new Map();      // assignmentId -> grade record | null
let currentSubjectFilter = '';   // '' = All Subjects, else a subjectId
let currentAssignmentId = null;  // assignment currently shown in the detail panel

const els = {};

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function escHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function normalizeAssignment(a) {
    return {
        ...a,
        type: a.workType || a.type || 'Assignment',
        maxScore: a.pointsPossible ?? a.maxScore ?? 0,
        date: a.dueDate || a.date || '',
    };
}

function formatDate(iso) {
    if (!iso) return '';
    try {
        const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
        // Date-only strings (YYYY-MM-DD) must be parsed as local calendar
        // components — new Date('YYYY-MM-DD') parses as UTC midnight, which
        // renders a day early in any timezone behind UTC. A full ISO
        // datetime string parses fine as-is and also renders its time-of-day.
        const d = isDateOnly
            ? new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)))
            : new Date(iso);
        return isDateOnly
            ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
            : d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch (e) { return iso; }
}

// 'todo' vs 'done' bucketing: the shared category's 'graded' and 'done' are
// done, 'todo'/'missing'/'revision' are todo — independent of `locked`.
function statusCategory(assignment) {
    const grade = gradesById.get(assignment.id);
    const submission = submissionsById.get(assignment.id);
    const { category } = resolveAssignmentStatus({
        grade, locked: !!assignment.locked, hasSubmission: !!submission,
        submittedAt: submission?.submittedAt, dueDate: assignment.date,
    });
    return (category === 'graded' || category === 'done') ? 'done' : 'todo';
}

// ── PUBLIC ENTRY POINT ────────────────────────────────────────────────
export async function initAssignmentsPage({ studentId, schoolId, readOnly = false }) {
    pageStudentId = studentId;
    pageSchoolId = schoolId;
    pageReadOnly = !!readOnly;

    cacheEls();
    wireEvents();

    // Fire-and-forget: paints the layout's school/semester header whenever
    // it resolves, independent of the assignments fetch below. Guarded via
    // setText() since the Parent layout has no displaySchoolName/
    // activeSemesterDisplay elements of its own.
    loadSchoolHeaderInfo(schoolId).then(({ schoolName, semesterName }) => {
        setText('displaySchoolName', schoolName);
        setText('activeSemesterDisplay', semesterName);
    });

    let teacherId = null;
    try {
        const studentSnap = await getDoc(doc(db, 'students', studentId));
        if (studentSnap.exists()) {
            const sd = studentSnap.data();
            teacherId = sd.teacherId || null;
            pageStudentName = sd.name || '';
        }
    } catch (e) {
        console.error('[Assignments] initAssignmentsPage:', e);
    }

    if (!teacherId) {
        showEmptyState(pageReadOnly
            ? "This student doesn't have a teacher assigned yet."
            : "You don't have a teacher assigned yet — check back once you're enrolled in a class.");
        return;
    }

    try {
        // Same resolution path the teacher's own pages use for themselves —
        // every query below is built from this student's own
        // studentId/schoolId, never any other class's or family's.
        const teacherSnap = await getDoc(getTeacherDocRef(schoolId, teacherId));
        const legacyTeacherData = teacherSnap.exists() ? teacherSnap.data() : null;

        const { subjectsCache, resolvedClasses } = await loadTeacherSubjectsCache(schoolId, teacherId, legacyTeacherData);

        // Two schema generations exist side by side: legacy assignments use
        // type/maxScore/date, the new "Add Work" model uses workType/
        // pointsPossible/dueDate instead. normalizeAssignment() maps the new
        // names onto the old ones so every render function below keeps
        // working unchanged for both. 'draft' status is filtered out here so
        // there is exactly one place that decides "is this visible yet."
        assignmentsCache = loadAssignmentsForSubjects(subjectsCache, resolvedClasses)
            .filter(a => a.status !== 'draft')
            .map(normalizeAssignment);

        renderSubjectFilterOptions();

        if (!assignmentsCache.length) {
            showEmptyState(pageReadOnly
                ? "No assignments have been prepared for this student's class yet."
                : "Your teacher hasn't prepared any assignments yet.");
            return;
        }

        const [subMap, gradeMap] = await Promise.all([
            loadSubmissionsForAssignments(schoolId, assignmentsCache, studentId),
            loadGradesIndexForStudent(schoolId, studentId)
        ]);
        submissionsById = subMap;
        gradesById = gradeMap;

        els.assignmentsLoader.classList.add('hidden');
        els.assignmentSections.classList.remove('hidden');
        renderList();
    } catch (e) {
        console.error('[Assignments] initAssignmentsPage:', e);
        showEmptyState('Something went wrong loading assignments. Please try again later.');
    }
}

function cacheEls() {
    ['subjectFilter', 'assignmentsLoader', 'assignmentsEmpty', 'assignmentSections',
     'todoCount', 'todoList', 'doneCount', 'doneList',
     'adSubjectLabel', 'adTitle', 'adMetaRow', 'assignmentDetailBody'
    ].forEach(id => { els[id] = document.getElementById(id); });
}

function wireEvents() {
    els.subjectFilter.addEventListener('change', () => {
        currentSubjectFilter = els.subjectFilter.value;
        renderList();
    });
}

function showEmptyState(message) {
    els.assignmentsLoader.classList.add('hidden');
    els.assignmentSections.classList.add('hidden');
    els.assignmentsEmpty.textContent = message;
    els.assignmentsEmpty.classList.remove('hidden');
}

// ── SUBJECT FILTER ───────────────────────────────────────────────────
function renderSubjectFilterOptions() {
    const seen = new Set();
    const options = ['<option value="">All Subjects</option>'];
    assignmentsCache.forEach(a => {
        if (seen.has(a.subjectId)) return;
        seen.add(a.subjectId);
        options.push(`<option value="${escHtml(a.subjectId)}">${escHtml(a.subjectName)}</option>`);
    });
    els.subjectFilter.innerHTML = options.join('');
}

// ── LIST ─────────────────────────────────────────────────────────────
function getVisibleAssignments() {
    let list = assignmentsCache;
    if (currentSubjectFilter) {
        list = list.filter(a => a.subjectId === currentSubjectFilter);
    }
    // Soonest due date first; undated assignments sink to the bottom, newest first among themselves.
    return list.slice().sort((a, b) => {
        if (a.date && b.date) return a.date.localeCompare(b.date);
        if (a.date) return -1;
        if (b.date) return 1;
        return (b.createdAt || '').localeCompare(a.createdAt || '');
    });
}

// Thin wrapper around the shared resolveAssignmentStatus(): this module's
// own job is only to pick a Tailwind badge color for each {status,
// category, late} the shared function can return.
function statusPill(assignment) {
    const grade = gradesById.get(assignment.id);
    const submission = submissionsById.get(assignment.id);
    const result = resolveAssignmentStatus({
        grade, locked: !!assignment.locked, hasSubmission: !!submission,
        submittedAt: submission?.submittedAt, dueDate: assignment.date,
    });

    if (result.category === 'revision') {
        return { label: result.status, classes: 'bg-orange-50 text-orange-700 border-orange-200' };
    }
    if (result.category === 'graded') {
        return { label: result.status, classes: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
    }
    if (result.status === 'Locked · Submitted' || result.status === 'Locked · Not submitted') {
        return { label: result.status, classes: 'bg-amber-50 text-amber-700 border-amber-200' };
    }
    if (result.category === 'done') {
        return result.late
            ? { label: result.status, classes: 'bg-amber-50 text-amber-700 border-amber-200' }
            : { label: result.status, classes: 'bg-indigo-50 text-indigo-700 border-indigo-200' };
    }
    if (result.category === 'missing') {
        return { label: result.status, classes: 'bg-red-50 text-red-700 border-red-200' };
    }
    return { label: result.status, classes: 'bg-slate-100 text-slate-500 border-slate-200' };
}

function renderSectionEmpty(container, message) {
    container.innerHTML = `<div class="text-center py-10 text-slate-400 text-[13px] font-bold bg-white rounded-xl border border-slate-200">${escHtml(message)}</div>`;
}

function renderList() {
    if (!els.assignmentSections) return;
    const list = getVisibleAssignments();
    const todo = list.filter(a => statusCategory(a) === 'todo');
    const done = list.filter(a => statusCategory(a) === 'done');

    els.todoCount.textContent = `${todo.length} to do`;
    els.doneCount.textContent = `${done.length} done`;

    if (todo.length) els.todoList.innerHTML = todo.map(renderAssignmentCard).join('');
    else renderSectionEmpty(els.todoList, `Nothing to do${currentSubjectFilter ? ' for this subject' : ''} — ${pageReadOnly ? 'nothing needs attention' : "you're all caught up"}.`);

    if (done.length) els.doneList.innerHTML = done.map(renderAssignmentCard).join('');
    else renderSectionEmpty(els.doneList, `Nothing done yet${currentSubjectFilter ? ' for this subject' : ''}.`);
}

function renderAssignmentCard(a) {
    const pill = statusPill(a);
    return `
    <div class="asg-card bg-white rounded-xl shadow-sm border border-slate-200 p-4" onclick="openAssignmentDetail('${a.id}')">
        <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
                <div class="flex items-center gap-2 flex-wrap mb-1">
                    <p class="font-black text-slate-800 text-[14px] m-0">${escHtml(a.title)}</p>
                    <span class="text-[10.5px] font-bold bg-slate-100 text-slate-500 px-2 py-0.5 rounded">${escHtml(a.subjectName || '')}</span>
                </div>
                <div class="flex items-center gap-2 flex-wrap">
                    <span class="text-[10px] font-black uppercase bg-indigo-50 text-indigo-600 border border-indigo-200 px-2 py-0.5 rounded-md">${escHtml(a.type)}</span>
                    <span class="text-[10px] font-black text-slate-500 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded-md">/ ${a.maxScore}</span>
                    ${a.date ? `<span class="text-[10.5px] text-slate-400 font-semibold"><i class="fa-regular fa-calendar mr-1"></i>Due ${escHtml(formatDate(a.date))}</span>` : ''}
                </div>
            </div>
            <span class="text-[10.5px] font-black uppercase tracking-wide border px-2.5 py-1 rounded-md flex-shrink-0 whitespace-nowrap ${pill.classes}">${pill.label}</span>
        </div>
    </div>`;
}

// ── DETAIL PANEL ─────────────────────────────────────────────────────
window.openAssignmentDetail = function(assignmentId) {
    const a = assignmentsCache.find(x => x.id === assignmentId);
    if (!a) return;
    currentAssignmentId = assignmentId;

    els.adSubjectLabel.textContent = a.subjectName || '';
    els.adTitle.textContent = a.title || 'Assignment';

    const pill = statusPill(a);
    const metaChips = [
        `<span class="text-[10px] font-black uppercase bg-indigo-50 text-indigo-600 border border-indigo-200 px-2 py-0.5 rounded-md">${escHtml(a.type)}</span>`,
        `<span class="text-[10px] font-black text-slate-500 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded-md">/ ${a.maxScore} pts</span>`
    ];

    // Once an assessment has an actual score on record — the submission's
    // status is 'graded' or 'revision_requested', both of which only ever
    // exist alongside a grade doc — the Due Date chip stops being the
    // interesting fact about this assignment; the score is. Gated to real
    // assessments only: a standard-work/legacy grade has no per-question
    // breakdown, so its header falls back to the due-date chip.
    const grade = gradesById.get(a.id);
    const submission = submissionsById.get(a.id);
    const isAssessment = a.category === 'assessment' && Array.isArray(a.questions) && a.questions.length > 0;
    const showScoreInHeader = isAssessment && grade && submission &&
        (submission.status === 'graded' || submission.status === 'revision_requested');

    if (showScoreInHeader) {
        metaChips.push(`<span class="text-[10px] font-black uppercase bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-0.5 rounded-md"><i class="fa-solid fa-circle-check mr-1"></i>${grade.score}/${grade.max}</span>`);
    } else if (a.date) {
        metaChips.push(`<span class="text-[10.5px] text-slate-400 font-semibold"><i class="fa-regular fa-calendar mr-1"></i>Due ${escHtml(formatDate(a.date))}</span>`);
    }
    metaChips.push(`<span class="text-[10px] font-black uppercase border px-2 py-0.5 rounded-md ${pill.classes}">${escHtml(pill.label)}</span>`);
    els.adMetaRow.innerHTML = metaChips.join('');

    els.assignmentDetailBody.innerHTML = renderDetailBody(a);
    // READONLY GATE: drawing canvases only ever exist in the editable
    // (student) form path — nothing to wire for a read-only viewer.
    if (!pageReadOnly) wireDetailFormEvents(a);

    openOverlay('assignmentDetailOverlay', 'assignmentDetailInner', true);
};

window.closeAssignmentDetail = function() {
    closeOverlay('assignmentDetailOverlay', 'assignmentDetailInner', true);
    currentAssignmentId = null;
};

// Standard-work-only: teacher media attachments (Add Work's rich-attachment
// model). Legacy assignments never have this field, so it renders nothing
// for them. Purely informational — shared as-is for both roles.
function renderAssignmentAttachments(attachments) {
    if (!Array.isArray(attachments) || attachments.length === 0) return '';
    const rows = attachments.map(att => `
        <div class="flex items-center gap-2 text-[12.5px] bg-white border border-slate-200 rounded-lg px-3 py-2">
            <i class="fa-solid fa-paperclip text-slate-400 flex-shrink-0"></i>
            <a href="${escHtml(att.url)}" target="_blank" rel="noopener" class="text-indigo-600 font-bold hover:underline truncate">${escHtml(att.name || att.url)}</a>
        </div>`).join('');
    return `
        <div>
            <p class="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-1.5">Materials</p>
            <div class="space-y-1.5">${rows}</div>
        </div>`;
}

// Score card, shared by assessment and standard-work paths, for both
// roles — label and empty-state differ slightly by audience (a parent
// sees an explicit "Not graded yet." card; a student's own assessment view
// simply omits the card until there's a grade, matching prior behavior).
function renderGradeBlock(grade) {
    if (grade) {
        const label = pageReadOnly ? 'Score' : 'Your Grade';
        return `
        <div class="bg-emerald-50 border border-emerald-200 rounded-xl p-4">
            <p class="text-[11px] font-black text-emerald-600 uppercase tracking-wider mb-1"><i class="fa-solid fa-circle-check mr-1"></i>${label}</p>
            <p class="text-2xl font-black text-emerald-700 m-0">${grade.score}<span class="text-base text-emerald-500">/${grade.max}</span></p>
        </div>`;
    }
    return pageReadOnly
        ? `<div class="bg-slate-50 border border-dashed border-slate-200 rounded-xl p-4 text-[12.5px] text-slate-400 font-semibold text-center">Not graded yet.</div>`
        : '';
}

function renderRemarksBlock(grade) {
    return grade?.notes ? `
        <div>
            <p class="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-1.5">Overall Remarks</p>
            <div class="bg-slate-50 border border-slate-200 rounded-xl p-4 text-[13px] text-slate-700 whitespace-pre-wrap leading-relaxed">${escHtml(grade.notes)}</div>
        </div>` : '';
}

function renderDetailBody(a) {
    const grade = gradesById.get(a.id) || null;
    const submission = submissionsById.get(a.id) || null;
    const frozen = isSubmissionFrozen(a, gradesById);
    // Only Add Work's assessment category carries a real questions[] array —
    // a legacy assignment or a standard-work item both fall through to the
    // generic instructions + submission block below, unchanged.
    const isAssessment = a.category === 'assessment' && Array.isArray(a.questions) && a.questions.length > 0;

    if (isAssessment) {
        return renderGradeBlock(grade) + renderAssessmentSection(a, submission, frozen, grade);
    }

    // Assessments never populate instructions/attachments (Add Work always
    // writes '' / [] for category:'assessment'), so these two blocks are
    // standard-work- and legacy-only in practice.
    const instructionsBlock = `
        <div>
            <p class="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-1.5">Instructions</p>
            ${a.instructions
                ? `<div class="bg-white border border-slate-200 rounded-xl p-4 text-[13px] text-slate-700 whitespace-pre-wrap leading-relaxed">${escHtml(a.instructions)}</div>`
                : `<div class="bg-slate-50 border border-dashed border-slate-200 rounded-xl p-4 text-[12.5px] text-slate-400 font-semibold">No additional instructions were provided for this assignment.</div>`}
        </div>`;
    const attachmentsBlock = renderAssignmentAttachments(a.attachments);
    const gradeBlock = renderGradeBlock(grade);

    let submissionBlock;
    if (pageReadOnly) {
        // READONLY GATE: no lock messaging (that's about the student's own
        // inability to act, not relevant to a viewer who could never act
        // here anyway) — just what was submitted, or that nothing was.
        submissionBlock = submission ? `
        <div>
            <p class="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-1.5">Submission</p>
            <div class="bg-white border border-slate-200 rounded-xl p-4 space-y-2">
                ${submission.responseText ? `<p class="text-[13px] text-slate-700 whitespace-pre-wrap">${escHtml(submission.responseText)}</p>` : ''}
                ${submission.linkUrl ? `<p class="text-[12.5px]"><a href="${escHtml(submission.linkUrl)}" target="_blank" rel="noopener" class="text-indigo-600 font-bold hover:underline break-all"><i class="fa-solid fa-link mr-1"></i>${escHtml(submission.linkUrl)}</a></p>` : ''}
                ${!submission.responseText && !submission.linkUrl ? `<p class="italic text-slate-400 text-sm">Submitted with no text or link.</p>` : ''}
                <p class="text-[10.5px] text-slate-400 font-semibold">Submitted ${escHtml(formatDate(submission.submittedAt))}</p>
            </div>
        </div>` : `
        <div class="bg-slate-50 border border-dashed border-slate-200 rounded-xl p-4 text-[12.5px] text-slate-400 font-semibold text-center">
            No submission on file yet.
        </div>`;
    } else if (frozen) {
        const note = grade
            ? 'This assignment has been graded, so your submission is now locked.'
            : 'Your teacher has closed submissions for this assignment.';
        submissionBlock = `
        <div>
            <p class="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-1.5">Your Submission</p>
            <div class="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-3 text-[12px] font-bold text-amber-700 flex items-center gap-2">
                <i class="fa-solid fa-lock"></i> ${escHtml(note)}
            </div>
            ${submission
                ? `<div class="bg-white border border-slate-200 rounded-xl p-4 space-y-2">
                        ${submission.responseText ? `<p class="text-[13px] text-slate-700 whitespace-pre-wrap">${escHtml(submission.responseText)}</p>` : ''}
                        ${submission.linkUrl ? `<p class="text-[12.5px]"><a href="${escHtml(submission.linkUrl)}" target="_blank" rel="noopener" class="text-indigo-600 font-bold hover:underline"><i class="fa-solid fa-link mr-1"></i>${escHtml(submission.linkUrl)}</a></p>` : ''}
                        <p class="text-[10.5px] text-slate-400 font-semibold">Submitted ${escHtml(formatDate(submission.submittedAt))}</p>
                   </div>`
                : `<div class="bg-slate-50 border border-dashed border-slate-200 rounded-xl p-4 text-[12.5px] text-slate-400 font-semibold">No submission was made.</div>`}
        </div>`;
    } else {
        submissionBlock = `
        <div>
            <p class="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-1.5">Your Submission</p>
            <div class="mb-3">
                <label class="block text-[11px] font-black text-slate-500 uppercase tracking-wider mb-1.5">Response</label>
                <textarea id="adResponseText" placeholder="Write your response here…"
                    class="form-input w-full p-3 bg-white border border-slate-200 rounded-xl text-sm resize-none leading-relaxed" style="height: 8rem;">${escHtml(submission?.responseText || '')}</textarea>
            </div>
            <div class="mb-3">
                <label class="block text-[11px] font-black text-slate-500 uppercase tracking-wider mb-1.5">Link <span class="normal-case font-semibold text-slate-400">(optional)</span></label>
                <input type="url" id="adLinkUrl" placeholder="https://…" value="${escHtml(submission?.linkUrl || '')}"
                    class="form-input w-full p-2.5 bg-white border border-slate-200 rounded-xl text-sm">
            </div>
            <button id="adSubmitBtn" onclick="saveMySubmission()" class="w-full bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 text-white font-black py-3 rounded-xl transition shadow-md text-sm flex items-center justify-center gap-2">
                <i class="fa-solid ${submission ? 'fa-rotate' : 'fa-paper-plane'}"></i> ${submission ? 'Update Submission' : 'Submit'}
            </button>
            ${submission ? `<p class="text-[10.5px] text-slate-400 font-semibold text-center mt-2">Last updated ${escHtml(formatDate(submission.updatedAt))}</p>` : ''}
            <p id="adSubMsg" class="text-sm hidden font-bold p-2.5 mt-2 rounded-xl text-center"></p>
        </div>`;
    }

    return instructionsBlock + attachmentsBlock + gradeBlock + submissionBlock + renderRemarksBlock(grade);
}

function wireDetailFormEvents(a) {
    // Drawing canvases need pointer-event handlers attached after their
    // markup lands in the DOM — everything else on this panel is either a
    // plain inline onclick or a value read at submit time.
    if (a.category === 'assessment') initAssessmentCanvases();
}

// ─────────────────────────────────────────────────────────────────────────
// Assessment rendering — questions[], per-question scores/notes, revision
// history. Interactive inputs only ever render when !pageReadOnly.
// ─────────────────────────────────────────────────────────────────────────

const AW_STUDENT_REQUIRES_LABEL = { file: 'Upload a file', photo: 'Take a photo', drawing: 'Draw your answer' };

// Is THIS question individually editable right now — distinct from
// isSubmissionFrozen(a, gradesById), which only answers "can the student
// touch this assignment AT ALL." Once a grade exists, every question is
// locked by default EXCEPT one(s) the teacher specifically flagged with an
// open (not-yet-answered) revision request. Only ever consulted on the
// interactive (!pageReadOnly) path — a read-only viewer never gets an
// editable question regardless of this.
function isQuestionFrozen(a, grade, questionId) {
    if (a.locked) return true;
    if (!grade) return false;
    return !isQuestionOpenForRevision(grade, questionId);
}

// One saved response, rendered as plain text/link/image rather than an
// editable control — used both for a read-only viewer's current answer and
// for anyone's revision-history trail (original + resubmission).
function renderAnswerSnippet(resp) {
    if (!resp) return '<span class="italic text-slate-400">No answer</span>';
    const url = resp.attachmentUrl;
    if (url) {
        return /^data:image\//i.test(url) || /\.(png|jpe?g|gif|webp)(\?|$)/i.test(url)
            ? `<a href="${escHtml(url)}" target="_blank" rel="noopener noreferrer"><img src="${escHtml(url)}" class="max-h-32 rounded-lg border border-slate-200 mt-1" alt="Submitted attachment"></a>`
            : `<a href="${escHtml(url)}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1.5 font-bold text-indigo-600"><i class="fa-solid fa-paperclip"></i>View attachment</a>`;
    }
    return resp.responseText ? escHtml(resp.responseText) : '<span class="italic text-slate-400">No answer</span>';
}

// Full original -> prompt -> resubmission trail. Only ever called once a
// resubmission exists (revision.studentSubmission set); an OPEN,
// not-yet-answered revision shows its prompt via the banner in
// renderQuestionCard instead.
function renderRevisionHistory(revision) {
    const mine = pageReadOnly ? '' : 'Your ';
    return `
    <div class="mt-3 pt-3 border-t border-dashed border-slate-200 space-y-2">
        <p class="text-[9.5px] font-black text-slate-400 uppercase tracking-widest">Revision History</p>
        <div class="bg-slate-50 border border-slate-200 rounded-lg p-2.5">
            <p class="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">${mine}Original Answer</p>
            <p class="text-[12px] text-slate-600 whitespace-pre-wrap m-0">${renderAnswerSnippet(revision.originalResponse)}</p>
        </div>
        <div class="bg-orange-50 border border-orange-200 rounded-lg p-2.5">
            <p class="text-[9px] font-black text-orange-500 uppercase tracking-widest mb-1">Teacher Asked</p>
            <p class="text-[12px] text-orange-800 whitespace-pre-wrap m-0">${escHtml(revision.prompt || '')}</p>
        </div>
        <div class="bg-emerald-50 border border-emerald-200 rounded-lg p-2.5">
            <p class="text-[9px] font-black text-emerald-500 uppercase tracking-widest mb-1">${mine}Resubmission${revision.submittedAt ? ` · ${escHtml(formatDate(revision.submittedAt))}` : ''}</p>
            <p class="text-[12px] text-emerald-800 whitespace-pre-wrap m-0">${renderAnswerSnippet(revision.studentSubmission)}</p>
        </div>
    </div>`;
}

// READONLY LEAF: one question's read-only answer, by type — ported from
// the Parent portal's prior renderParentAnswerDisplay(). Only ever called
// when pageReadOnly is true.
function renderAnswerDisplay(q, saved, autoGrade) {
    if (q.type === 'multiple_choice') {
        const selectedIndex = saved && saved.responseText !== '' && saved.responseText != null ? Number(saved.responseText) : null;
        const graded = !!autoGrade && Object.prototype.hasOwnProperty.call(autoGrade.perQuestion || {}, q.id);
        const isCorrect = graded ? autoGrade.perQuestion[q.id] : null;
        const optionsHtml = (q.options || []).map((opt, oi) => {
            const isSelected = selectedIndex === oi;
            return `<div class="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[13px] ${isSelected ? 'bg-indigo-50 border border-indigo-200 font-bold text-slate-800' : 'text-slate-500'}">
                <span class="w-4 h-4 flex-shrink-0 rounded-full border ${isSelected ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-slate-300'} flex items-center justify-center text-[9px] font-bold">${isSelected ? '<i class="fa-solid fa-check"></i>' : String.fromCharCode(65 + oi)}</span>
                <span>${escHtml(opt)}</span>
            </div>`;
        }).join('');
        const badge = selectedIndex === null
            ? `<span class="text-[10px] font-bold uppercase tracking-widest text-slate-400 bg-slate-50 border border-slate-200 px-2 py-0.5 rounded">Not answered</span>`
            : !graded ? ''
                : isCorrect
                    ? `<span class="text-[10px] font-bold uppercase tracking-widest text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded"><i class="fa-solid fa-check text-[9px] mr-1"></i>Correct</span>`
                    : `<span class="text-[10px] font-bold uppercase tracking-widest text-red-700 bg-red-50 border border-red-200 px-2 py-0.5 rounded"><i class="fa-solid fa-xmark text-[9px] mr-1"></i>Incorrect</span>`;
        return `<div class="space-y-1 mt-2">${optionsHtml}</div>${badge ? `<div class="mt-2">${badge}</div>` : ''}`;
    }
    if (q.type === 'free_response' || q.type === 'short_answer' || q.type === 'math') {
        const text = saved?.responseText || '';
        return text
            ? `<p class="text-[13px] text-slate-700 whitespace-pre-wrap bg-slate-50 border border-slate-200 rounded-lg p-3 mt-2">${escHtml(text)}</p>`
            : `<p class="text-[12px] text-slate-400 italic mt-2">No answer provided.</p>`;
    }
    if (q.type === 'attachment_response') {
        const url = saved?.attachmentUrl || null;
        if (!url) return `<p class="text-[12px] text-slate-400 italic mt-2">No file/drawing submitted.</p>`;
        if (/^data:image\//i.test(url) || /\.(png|jpe?g|gif|webp)(\?|$)/i.test(url)) {
            return `<a href="${escHtml(url)}" target="_blank" rel="noopener noreferrer" class="block mt-2"><img src="${escHtml(url)}" class="max-h-48 rounded-lg border border-slate-200" alt="Submitted answer"></a>`;
        }
        return `<a href="${escHtml(url)}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1.5 text-[12.5px] font-bold text-indigo-600 mt-2"><i class="fa-solid fa-paperclip"></i>View submitted file</a>`;
    }
    return '';
}

// INTERACTIVE LEAF: one question's editable input, by type. Only ever
// called when !pageReadOnly.
function renderStudentQuestionInput(q, saved, frozen) {
    const disabledAttr = frozen ? 'disabled' : '';

    if (q.type === 'multiple_choice') {
        const savedIndex = saved ? Number(saved.responseText) : null;
        const options = (q.options || []).map((opt, i) => `
            <label class="flex items-center gap-2 text-[13px] text-slate-700 py-1 ${frozen ? '' : 'cursor-pointer'}">
                <input type="radio" name="q-${escHtml(q.id)}" value="${i}" data-question-id="${escHtml(q.id)}"
                    data-question-type="multiple_choice" data-option-index="${i}"
                    ${savedIndex === i ? 'checked' : ''} ${disabledAttr}
                    class="w-4 h-4 accent-indigo-600">
                <span>${escHtml(opt)}</span>
            </label>`).join('');
        return `<div class="pl-8">${options}</div>`;
    }

    if (q.type === 'free_response' || q.type === 'short_answer') {
        const isShort = q.type === 'short_answer';
        return `
            <div class="pl-8">
                ${q.hint ? `<p class="text-[11px] text-slate-400 font-semibold italic mb-1.5">${escHtml(q.hint)}</p>` : ''}
                ${isShort
                    ? `<input type="text" data-question-id="${escHtml(q.id)}" data-question-type="short_answer" ${disabledAttr}
                           value="${escHtml(saved?.responseText || '')}"
                           class="form-input w-full p-2.5 bg-white border border-slate-200 rounded-lg text-sm">`
                    : `<textarea data-question-id="${escHtml(q.id)}" data-question-type="free_response" ${disabledAttr}
                           class="form-input w-full p-2.5 bg-white border border-slate-200 rounded-lg text-sm resize-none" style="height:5.5rem;">${escHtml(saved?.responseText || '')}</textarea>`}
            </div>`;
    }

    if (q.type === 'math') {
        return `
            <div class="pl-8">
                ${q.hint ? `<p class="text-[11px] text-slate-400 font-semibold italic mb-1.5">${escHtml(q.hint)}</p>` : ''}
                <input type="text" data-question-id="${escHtml(q.id)}" data-question-type="math" ${disabledAttr}
                    value="${escHtml(saved?.responseText || '')}" placeholder="Type your answer…"
                    class="form-input w-full p-2.5 bg-white border border-slate-200 rounded-lg text-sm font-mono">
            </div>`;
    }

    if (q.type === 'attachment_response') {
        const requires = q.studentResponse?.requires || 'file';
        const label = AW_STUDENT_REQUIRES_LABEL[requires] || AW_STUDENT_REQUIRES_LABEL.file;

        if (frozen) {
            const url = saved?.attachmentUrl || null;
            if (!url) {
                return `<div class="pl-8"><p class="text-[11px] text-slate-400 italic">No file/drawing submitted.</p></div>`;
            }
            if (/^data:image\//i.test(url) || /\.(png|jpe?g|gif|webp)(\?|$)/i.test(url)) {
                return `<div class="pl-8"><a href="${escHtml(url)}" target="_blank" rel="noopener noreferrer" class="block"><img src="${escHtml(url)}" class="max-h-48 rounded-lg border border-slate-200" alt="Your submitted answer"></a></div>`;
            }
            return `<div class="pl-8"><a href="${escHtml(url)}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1.5 text-[12.5px] font-bold text-indigo-600"><i class="fa-solid fa-paperclip"></i>View your submitted file</a></div>`;
        }

        if (requires === 'drawing') {
            return `
                <div class="pl-8">
                    <p class="text-[11px] text-slate-400 font-semibold italic mb-1.5">${escHtml(label)}</p>
                    <canvas id="canvas-${escHtml(q.id)}" data-aw-canvas data-question-id="${escHtml(q.id)}"
                        width="400" height="220" class="border border-slate-200 rounded-lg bg-white w-full touch-none" style="max-width:400px;"></canvas>
                    ${!frozen ? `<button type="button" data-aw-clear-canvas="${escHtml(q.id)}" class="text-[11px] font-bold text-slate-400 hover:text-rose-500 mt-1.5">Clear</button>` : ''}
                </div>`;
        }

        const acceptAttr = requires === 'photo' ? 'accept="image/*" capture="environment"' : '';
        return `
            <div class="pl-8">
                <p class="text-[11px] text-slate-400 font-semibold italic mb-1.5">${escHtml(label)} — uploading wires up in a later step</p>
                <input type="file" ${acceptAttr} data-question-id="${escHtml(q.id)}" data-question-type="attachment_response" ${disabledAttr}
                    class="text-[12.5px] text-slate-600">
            </div>`;
    }

    return '';
}

// ONE shared question card for both roles. Structure (banner / answer /
// feedback / history) is identical either way — only the "answer" leaf
// differs: an editable input for the interactive path, a plain display for
// the read-only path.
function renderQuestionCard(q, index, saved, frozen, pq, autoGrade) {
    const hasScore = pq && typeof pq.score === 'number';
    const pointsLabel = hasScore
        ? `${pq.score} / ${q.points ?? 0} pt${(q.points ?? 0) === 1 ? '' : 's'}`
        : `${q.points ?? 0} point${(q.points ?? 0) === 1 ? '' : 's'}`;

    const isOpenRevision = !!(pq && pq.revision && pq.revision.requested && !pq.revision.submittedAt);

    const revisionRequestBanner = isOpenRevision ? `
        <div class="bg-orange-50 border border-orange-300 rounded-lg p-3 mb-3">
            <p class="text-[10px] font-black text-orange-700 uppercase tracking-widest mb-1"><i class="fa-solid fa-arrow-rotate-left mr-1"></i>Revision Requested</p>
            <p class="text-[12.5px] text-orange-800 font-semibold whitespace-pre-wrap m-0">${escHtml(pq.revision.prompt || (pageReadOnly ? 'Waiting on your child to revise this answer.' : 'Please review and resubmit your answer.'))}</p>
        </div>` : '';

    // Read-only feedback — only once the question is no longer actively
    // being revised (an open revision's prompt is already front-and-center
    // in the banner above).
    const feedbackBlock = (!isOpenRevision && pq && pq.note) ? `
        <div class="mt-2.5 bg-indigo-50 border border-indigo-200 rounded-lg p-3">
            <p class="text-[9.5px] font-black text-indigo-500 uppercase tracking-widest mb-1"><i class="fa-solid fa-message mr-1"></i>Teacher's Note</p>
            <p class="text-[12.5px] text-indigo-900 font-semibold whitespace-pre-wrap m-0">${escHtml(pq.note)}</p>
        </div>` : '';

    const historyBlock = (pq && pq.revision && pq.revision.studentSubmission) ? renderRevisionHistory(pq.revision) : '';

    // READONLY GATE
    const answerHtml = pageReadOnly
        ? `<div class="pl-8">${renderAnswerDisplay(q, saved, autoGrade)}</div>`
        : renderStudentQuestionInput(q, saved, frozen);

    return `
    <div class="bg-white border ${isOpenRevision ? 'border-orange-300 ring-2 ring-orange-100' : 'border-slate-200'} rounded-xl p-4" data-question-id="${escHtml(q.id)}">
        <div class="flex items-start gap-2 mb-3">
            <span class="w-6 h-6 flex-shrink-0 bg-indigo-50 text-indigo-600 border border-indigo-200 rounded-md flex items-center justify-center text-[10px] font-black">${index + 1}</span>
            <div class="min-w-0 flex-1">
                <p class="text-[13.5px] font-bold text-slate-800 whitespace-pre-wrap">${escHtml(q.prompt)}</p>
                <p class="text-[10.5px] ${hasScore ? 'text-emerald-600' : 'text-slate-400'} font-semibold mt-0.5">${pointsLabel}</p>
            </div>
        </div>
        ${revisionRequestBanner}
        ${answerHtml}
        ${feedbackBlock}
        ${historyBlock}
    </div>`;
}

function renderAssessmentSection(a, submission, frozen, grade) {
    const saved = new Map((submission?.responses || []).map(r => [r.questionId, r]));
    const autoGrade = submission?.objectiveAutoGrade || null;
    const openQuestions = grade ? a.questions.filter(q => isQuestionOpenForRevision(grade, q.id)) : [];
    const hasOpenRev = openQuestions.length > 0;

    const revisionBanner = hasOpenRev ? `
        <div class="bg-orange-50 border border-orange-200 rounded-xl p-3 mb-3 text-[12.5px] font-bold text-orange-700 flex items-center gap-2">
            <i class="fa-solid fa-arrow-rotate-left"></i> ${pageReadOnly
                ? `Your child has been asked to revise ${openQuestions.length > 1 ? 'some answers' : 'an answer'} below — look for the highlighted question${openQuestions.length > 1 ? 's' : ''}.`
                : `Your teacher has asked you to revise ${openQuestions.length > 1 ? 'some answers' : 'an answer'} below — look for the highlighted question${openQuestions.length > 1 ? 's' : ''}.`}
        </div>` : '';

    const cards = a.questions.map((q, i) => {
        const pq = grade?.perQuestion?.[q.id] || null;
        const questionFrozen = isQuestionFrozen(a, grade, q.id);
        return renderQuestionCard(q, i, saved.get(q.id), questionFrozen, pq, autoGrade);
    }).join('');

    // READONLY GATE: a read-only viewer never sees the lock banner or the
    // submit button — only, when relevant, that nothing has been turned in.
    let footer = '';
    if (pageReadOnly) {
        footer = !submission ? `
            <div class="bg-amber-50 border border-amber-200 rounded-xl p-3 text-[12px] font-bold text-amber-700 flex items-center gap-2">
                <i class="fa-solid fa-circle-exclamation"></i> No submission on file yet.
            </div>` : '';
    } else if (frozen) {
        footer = `<div class="bg-amber-50 border border-amber-200 rounded-xl p-3 text-[12px] font-bold text-amber-700 flex items-center gap-2">
               <i class="fa-solid fa-lock"></i> ${escHtml(submission ? 'This assessment has been graded, so your answers are locked.' : 'Your teacher has closed submissions for this assessment.')}
           </div>`;
    } else {
        const btnLabel = hasOpenRev ? 'Submit Revision' : (submission ? 'Update Answers' : 'Submit');
        footer = `<button id="adSubmitBtn" onclick="submitAssessmentResponses()"
               class="w-full bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 text-white font-black py-3 rounded-xl transition shadow-md text-sm flex items-center justify-center gap-2">
               <i class="fa-solid ${hasOpenRev ? 'fa-paper-plane' : (submission ? 'fa-rotate' : 'fa-paper-plane')}"></i> ${btnLabel}
           </button>
           ${submission ? `<p class="text-[10.5px] text-slate-400 font-semibold text-center mt-2">Last updated ${escHtml(formatDate(submission.updatedAt))}</p>` : ''}
           <p id="adSubMsg" class="text-sm hidden font-bold p-2.5 mt-2 rounded-xl text-center"></p>`;
    }

    return `
        ${revisionBanner}
        <div>
            <p class="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-1.5">Questions</p>
            <div id="adQuestionsContainer" class="space-y-3">${cards}</div>
        </div>
        ${footer}
        ${renderRemarksBlock(grade)}`;
}

// Pointer-drawn canvases: plain black stroke, no persistence — toDataURL()
// is read later by collectStudentResponses() at submit time. Interactive
// path only.
function initAssessmentCanvases() {
    document.querySelectorAll('canvas[data-aw-canvas]').forEach(canvas => {
        const ctx = canvas.getContext('2d');
        let drawing = false;
        const pos = (e) => {
            const rect = canvas.getBoundingClientRect();
            const p = e.touches ? e.touches[0] : e;
            return { x: p.clientX - rect.left, y: p.clientY - rect.top };
        };
        canvas.addEventListener('pointerdown', (e) => { drawing = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); });
        canvas.addEventListener('pointermove', (e) => { if (!drawing) return; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); });
        window.addEventListener('pointerup', () => { drawing = false; });
    });
    document.querySelectorAll('[data-aw-clear-canvas]').forEach(btn => {
        btn.addEventListener('click', () => {
            const canvas = document.getElementById(`canvas-${btn.dataset.awClearCanvas}`);
            if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
        });
    });
}

function canvasHasDrawing(canvas) {
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) { if (data[i] !== 0) return true; } // any non-transparent pixel
    return false;
}

// In-memory collector — pure read of the currently-rendered inputs, no
// Firestore or Storage calls. A question that isn't open right now (see
// isQuestionOpenForRevision via the `grade` param) is returned straight
// from the SAVED submission, never read from the DOM at all — a disabled
// file <input> or an unredrawn canvas can never carry a previously-saved
// attachment forward on its own. Interactive path only.
function collectStudentResponses(a, grade) {
    const submission = submissionsById.get(a.id);
    const savedByQid = new Map((submission?.responses || []).map(r => [r.questionId, r]));

    return (a.questions || []).map(q => {
        const existing = savedByQid.get(q.id) || null;
        const isOpen = grade ? isQuestionOpenForRevision(grade, q.id) : true;

        if (!isOpen) {
            return { questionId: q.id, responseText: existing?.responseText ?? '', attachmentUrl: existing?.attachmentUrl ?? null };
        }

        let responseText = '';
        let attachmentUrl = null;

        if (q.type === 'multiple_choice') {
            const checked = document.querySelector(`input[name="q-${q.id}"]:checked`);
            responseText = checked ? String(checked.dataset.optionIndex) : '';
        } else if (q.type === 'free_response' || q.type === 'short_answer' || q.type === 'math') {
            const el = document.querySelector(`[data-question-id="${q.id}"][data-question-type="${q.type}"]`);
            responseText = (el?.value || '').trim();
        } else if (q.type === 'attachment_response') {
            const requires = q.studentResponse?.requires || 'file';
            if (requires === 'drawing') {
                const canvas = document.getElementById(`canvas-${q.id}`);
                attachmentUrl = canvas && canvasHasDrawing(canvas) ? canvas.toDataURL('image/png') : (existing?.attachmentUrl ?? null);
            } else {
                const fileInput = document.querySelector(`input[type="file"][data-question-id="${q.id}"]`);
                const pickedName = fileInput?.files?.[0]?.name || null;
                attachmentUrl = pickedName || (existing?.attachmentUrl ?? null); // name only if freshly picked — no upload wiring yet at this step
            }
        }

        return { questionId: q.id, responseText, attachmentUrl };
    });
}

// ─────────────────────────────────────────────────────────────────────────
// Submission persistence (Storage upload + Firestore write). Interactive
// path only — every entry point below bails out immediately if
// pageReadOnly, as defense in depth: these are global window.* functions,
// so the guard can't rely solely on the submit button being absent.
// ─────────────────────────────────────────────────────────────────────────

function validateAssessmentResponses(a, responses) {
    const missing = [];
    a.questions.forEach((q, i) => {
        const r = responses[i];
        const answered = q.type === 'attachment_response' ? !!r.attachmentUrl : !!(r.responseText && r.responseText.trim());
        if (!answered) missing.push(i + 1);
    });
    return missing;
}

async function resolveAttachmentUploads(a, responses) {
    return Promise.all(a.questions.map(async (q, i) => {
        const r = responses[i];
        if (q.type !== 'attachment_response' || !r.attachmentUrl) return r;

        const requires = q.studentResponse?.requires || 'file';
        const source = requires === 'drawing'
            ? (r.attachmentUrl.startsWith('data:') ? r.attachmentUrl : null)
            : document.querySelector(`input[type="file"][data-question-id="${q.id}"]`)?.files?.[0];
        if (!source) return r;

        const url = await uploadSubmissionAttachment(pageSchoolId, a, pageStudentId, q.id, source);
        return { ...r, attachmentUrl: url };
    }));
}

window.submitAssessmentResponses = async function() {
    if (pageReadOnly) return; // READONLY GATE
    const a = assignmentsCache.find(x => x.id === currentAssignmentId);
    if (!a) return;
    if (isSubmissionFrozen(a, gradesById)) return; // guard against a stale panel

    const grade = gradesById.get(a.id) || null;

    const raw = collectStudentResponses(a, grade);
    const missing = validateAssessmentResponses(a, raw);
    if (missing.length) {
        showMsg('adSubMsg', `Answer question${missing.length > 1 ? 's' : ''} ${missing.join(', ')} before submitting.`, true);
        return;
    }

    const btn = document.getElementById('adSubmitBtn');
    const prevHtml = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Submitting…';
    btn.disabled = true;

    try {
        const resolved = await resolveAttachmentUploads(a, raw);
        const record = await saveSubmission(pageSchoolId, a, pageStudentId, pageStudentName, { responses: resolved });
        submissionsById.set(a.id, record);

        // Record the student's new answer + timestamp against whichever
        // question(s) were open for revision, directly on the grade doc's
        // own perQuestion[qid].revision — never touching
        // originalResponse/prompt or any other question's entry.
        if (grade) {
            const openQuestions = a.questions.filter(q => isQuestionOpenForRevision(grade, q.id));
            if (openQuestions.length) {
                const now = new Date().toISOString();
                const resolvedByQid = new Map(resolved.map(r => [r.questionId, r]));
                const updatedPerQuestion = { ...grade.perQuestion };
                openQuestions.forEach(q => {
                    const answer = resolvedByQid.get(q.id) || null;
                    const existingPQ = updatedPerQuestion[q.id] || {};
                    updatedPerQuestion[q.id] = {
                        ...existingPQ,
                        revision: {
                            ...existingPQ.revision,
                            studentSubmission: { responseText: answer?.responseText ?? '', attachmentUrl: answer?.attachmentUrl ?? null },
                            submittedAt: now,
                        },
                    };
                });

                await updateDoc(doc(db, 'students', pageStudentId, 'grades', grade.id), { perQuestion: updatedPerQuestion });
                grade.perQuestion = updatedPerQuestion; // keep the in-memory copy consistent until the next full reload
            }
        }

        renderList();
        // Re-render the panel so it reflects the saved answers, the
        // "Update Answers" label, and the new timestamp.
        window.openAssignmentDetail(a.id);
    } catch (e) {
        console.error('[Assignments] submitAssessmentResponses:', e);
        showMsg('adSubMsg', 'Could not submit your answers. Please try again.', true);
        btn.innerHTML = prevHtml;
        btn.disabled = false;
    }
};

window.saveMySubmission = async function() {
    if (pageReadOnly) return; // READONLY GATE
    const a = assignmentsCache.find(x => x.id === currentAssignmentId);
    if (!a) return;

    if (isSubmissionFrozen(a, gradesById)) return; // guard against a stale panel

    const responseText = document.getElementById('adResponseText').value.trim();
    const linkUrl = document.getElementById('adLinkUrl').value.trim();

    if (!responseText && !linkUrl) {
        showMsg('adSubMsg', 'Add a response or a link before submitting.', true);
        return;
    }
    if (linkUrl && !/^https?:\/\//i.test(linkUrl)) {
        showMsg('adSubMsg', 'Links must start with http:// or https://', true);
        return;
    }

    const btn = document.getElementById('adSubmitBtn');
    const prevHtml = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';
    btn.disabled = true;

    try {
        const record = await saveSubmission(pageSchoolId, a, pageStudentId, pageStudentName, { responseText, linkUrl });
        submissionsById.set(a.id, record);
        renderList();
        // Re-render the panel so it reflects "Update Submission" + the new timestamp.
        window.openAssignmentDetail(a.id);
    } catch (e) {
        console.error('[Assignments] saveMySubmission:', e);
        showMsg('adSubMsg', 'Could not save your submission. Please try again.', true);
        btn.innerHTML = prevHtml;
        btn.disabled = false;
    }
};
