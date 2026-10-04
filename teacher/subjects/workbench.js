// teacher/subjects/workbench.js — assignment management for the subject page
//
// Moved verbatim from teacher/subjects/subjects.js when the legacy slide-out
// subject panel was removed (refactor(ui): wire subject grid to new routing
// shell). Covers: Add Work / Universal Assignment Builder (create + edit),
// Mark graded / Reopen, Lock / Unlock, Delete, Review Submissions, View
// Answers, Route to Grade, and the grade-detail modal. The modal markup lives
// in teacher/subjects/subject.html; inline onclick handlers call the window.*
// functions defined below.
//
// The moved code reads the same module-level names it always did
// (session, currentSubjectName, getSubjectByName(), …). configureWorkbench()
// binds them to the ONE subject the page is showing, so name lookups can never
// resolve to a same-named subject in another class.

import { db, storage } from '../../assets/js/firebase-init.js';
import { query, where, getDocs, doc, updateDoc, deleteDoc, collectionGroup, writeBatch, serverTimestamp }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { ref as storageRef, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";
import { setSessionData } from '../../assets/js/auth.js';
import { openOverlay, closeOverlay, gradeFill, letterGrade, getTeacherDocRef } from '../../assets/js/utils.js';
import { resolvePostContext } from '../../assets/js/posts.js';
import { loadSubmissionsForAssignment } from '../../assets/js/submissions.js';
import { normalizeTheme, validatePdfFields } from '../../assets/js/assessment/engine-core.js';

// ── CONTEXT (set by configureWorkbench) ─────────────────────────────────────
let session = null;
let subjectsCache = [];        // exactly one entry: the page's subject
let resolvedClasses = [];      // exactly one entry: the page's class
let allStudentsCache = [];     // active students in the page's class
let currentSubjectName = null;
let isSemesterLocked = false;
let resolvedGradeTypes = null;
let onAssignmentsChanged = () => {};
let gradeDetailCache = {};

// Review Submissions state
let reviewAssignment = null;
let reviewRoster = [];
let reviewSubmissions = new Map();
let reviewGrades = new Map();

const DEFAULT_GRADE_TYPES = ['Test', 'Quiz', 'Assignment', 'Homework', 'Project', 'Midterm Exam', 'Final Exam'];
function getGradeTypes() { return resolvedGradeTypes || DEFAULT_GRADE_TYPES; }
function genAssignmentId() { return 'asg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5); }
function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
function getSubjectByName(name) { return subjectsCache.find(s => s.name === name && !s.archived) || null; }
function getAssignmentsForSubject(name) {
    const sub = getSubjectByName(name);
    return (sub && Array.isArray(sub.assignments)) ? sub.assignments : [];
}
// The moved code calls these after every write; the Assignments tab re-reads.
function renderAssignmentsTab() { onAssignmentsChanged(); }
function updateAssignmentTabBadge() {}

// subject: the subject doc ({ id, name, classId, ... }); className: its class name;
// assignments: current list (from subject-store); students: active class roster.
export function configureWorkbench({ session: s, subject, className, assignments, students, gradeTypes, semesterLocked, onChange }) {
    session = s;
    const sub = { ...subject, className, _source: 'new', assignments: Array.isArray(assignments) ? [...assignments] : [] };
    subjectsCache = [sub];
    resolvedClasses = [{ id: subject.classId, name: className }];
    allStudentsCache = (students || []).map(st => ({ ...st, className: st.className || className }));
    currentSubjectName = subject.name;
    isSemesterLocked = !!semesterLocked;
    resolvedGradeTypes = gradeTypes || null;
    onAssignmentsChanged = typeof onChange === 'function' ? onChange : () => {};
}

// Grade records the Performance tab rendered (for openAssignmentModal(gradeId)).
export function setGradeDetails(grades) {
    gradeDetailCache = {};
    (grades || []).forEach(g => { gradeDetailCache[g.id] = g; });
}

// LIFT & SHIFT REFACTOR: editAssignment() used to switch this tab's own
// inline composer into edit mode. It now opens the Universal Builder modal
// pre-filled instead — see openAddWorkModal(assignmentId) in the ADD WORK /
// UNIVERSAL ASSIGNMENT BUILDER section below, which is the single place
// creation AND editing both happen now.
window.editAssignment = function(assignmentId) {
    if (awOpenEditorRoute) { awOpenEditorRoute(assignmentId); return; }
    openAddWorkModal(assignmentId);
};

window.toggleAssignmentComplete = async function(assignmentId) {
    const sub = getSubjectByName(currentSubjectName);
    if (!sub) return;

    try {
        if (sub._source === 'new') {
            const current = (sub.assignments || []).find(a => a.id === assignmentId);
            const newCompleted = !(current?.completed);
            await updateDoc(doc(db, 'schools', session.schoolId, 'classes', sub.classId, 'subjects', sub.id, 'assignments', assignmentId), { completed: newCompleted });
            sub.assignments = (sub.assignments || []).map(a => a.id === assignmentId ? { ...a, completed: newCompleted } : a);
        } else {
            const subjects = (session.teacherData.subjects || []).map(s => {
                if (s.id !== sub.id) return s;
                const existing = Array.isArray(s.assignments) ? s.assignments : [];
                return {
                    ...s,
                    assignments: existing.map(a =>
                        a.id === assignmentId ? { ...a, completed: !a.completed } : a
                    )
                };
            });
            await updateDoc(getTeacherDocRef(session.schoolId, session.teacherId), { subjects });
            session.teacherData.subjects = subjects;
            setSessionData('teacher', session);
            sub.assignments = subjects.find(s => s.id === sub.id)?.assignments || [];
        }

        updateAssignmentTabBadge();
        renderAssignmentsTab();
    } catch (e) {
        console.error('[Subjects] toggleAssignmentComplete:', e);
        alert('Could not update the assignment. Please try again.');
    }
};

// PHASE 1 MILESTONE 3: quick-action lock toggle, mirroring
// toggleAssignmentComplete's exact _source fork. Informational only — does
// not gate editing, deleting, or grading; grade_form.js just displays it.
window.toggleAssignmentLocked = async function(assignmentId) {
    const sub = getSubjectByName(currentSubjectName);
    if (!sub) return;

    const now = new Date().toISOString();

    try {
        if (sub._source === 'new') {
            const current = (sub.assignments || []).find(a => a.id === assignmentId);
            const newLocked = !(current?.locked);
            const patch = { locked: newLocked, lockedAt: newLocked ? now : null };
            await updateDoc(doc(db, 'schools', session.schoolId, 'classes', sub.classId, 'subjects', sub.id, 'assignments', assignmentId), patch);
            sub.assignments = (sub.assignments || []).map(a => a.id === assignmentId ? { ...a, ...patch } : a);
        } else {
            const subjects = (session.teacherData.subjects || []).map(s => {
                if (s.id !== sub.id) return s;
                const existing = Array.isArray(s.assignments) ? s.assignments : [];
                return {
                    ...s,
                    assignments: existing.map(a =>
                        a.id === assignmentId ? { ...a, locked: !a.locked, lockedAt: !a.locked ? now : null } : a
                    )
                };
            });
            await updateDoc(getTeacherDocRef(session.schoolId, session.teacherId), { subjects });
            session.teacherData.subjects = subjects;
            setSessionData('teacher', session);
            sub.assignments = subjects.find(s => s.id === sub.id)?.assignments || [];
        }

        renderAssignmentsTab();
    } catch (e) {
        console.error('[Subjects] toggleAssignmentLocked:', e);
        alert('Could not update the assignment. Please try again.');
    }
};

window.deleteAssignment = async function(assignmentId) {
    const sub = getSubjectByName(currentSubjectName);
    if (!sub) return;
    if (!confirm('Remove this prepared assignment? Grades already recorded with this title are not affected.')) return;

    try {
        if (sub._source === 'new') {
            await deleteDoc(doc(db, 'schools', session.schoolId, 'classes', sub.classId, 'subjects', sub.id, 'assignments', assignmentId));
            sub.assignments = (sub.assignments || []).filter(a => a.id !== assignmentId);
        } else {
            const subjects = (session.teacherData.subjects || []).map(s => {
                if (s.id !== sub.id) return s;
                const existing = Array.isArray(s.assignments) ? s.assignments : [];
                return { ...s, assignments: existing.filter(a => a.id !== assignmentId) };
            });
            await updateDoc(getTeacherDocRef(session.schoolId, session.teacherId), { subjects });
            session.teacherData.subjects = subjects;
            setSessionData('teacher', session);
            sub.assignments = subjects.find(s => s.id === sub.id)?.assignments || [];
        }

        updateAssignmentTabBadge();
        renderAssignmentsTab();
    } catch (e) {
        console.error('[Subjects] deleteAssignment:', e);
        alert('Could not remove the assignment. Please try again.');
    }
};


// ── PHASE 1 MILESTONE 5: REVIEW SUBMISSIONS (inline grading) ────────────────
// Slide-in panel, triggered per-assignment from the Assignments tab above.
// Approved design: stays inline — never bounces the teacher out to
// grade_form.js. Data fetching is exactly two reads: one getDocs on the
// assignment's own submissions subcollection (who has submitted), and one
// collectionGroup('grades') query filtered by assignmentId (who's graded,
// class-wide) — see firestore.indexes.json's fieldOverrides entry for the
// index this second read needs. Grading itself goes through utils.js's
// shared saveGrade() helper, so re-grading here follows the exact same
// no-duplicate-docs + historyLogs rule as grade_form.js.
window.openReviewSubmissions = async function(assignmentId) {
    const sub = getSubjectByName(currentSubjectName);
    const assignments = (sub && Array.isArray(sub.assignments)) ? sub.assignments : [];
    const assignment = assignments.find(a => a.id === assignmentId);
    if (!sub || !assignment) return;

    const context = resolvePostContext(sub, resolvedClasses);
    if (!context) {
        alert('Could not resolve this subject to a real class, so submissions can\'t be loaded. Try reopening the Subjects page.');
        return;
    }

    reviewAssignment = { ...assignment, ...context };
    reviewRoster = allStudentsCache.filter(s => s.className === context.className);
    reviewSubmissions = new Map();
    reviewGrades = new Map();

    document.getElementById('reviewTitle').textContent = assignment.title;
    document.getElementById('reviewMeta').textContent = `${context.subjectName} · ${context.className} · out of ${assignment.maxScore}`;
    document.getElementById('reviewBody').innerHTML = `<div class="flex justify-center py-16"><i class="fa-solid fa-circle-notch fa-spin text-3xl text-teal-500"></i></div>`;

    openOverlay('reviewSubmissionsModal', 'reviewSubmissionsModalInner', true);

    try {
        const [submissionsMap, gradesSnap] = await Promise.all([
            loadSubmissionsForAssignment(session.schoolId, reviewAssignment),
            // firestore.rules' collection-group rule for grades can only prove
            // resource.data.schoolId == request.auth.token.schoolId when the
            // query itself carries a matching where('schoolId', ...) clause —
            // Firestore can't verify a list/collection-group query's security
            // per-document, only from the query's own filters (same reason
            // live.js's collectionGroup('exam_submissions') query includes its
            // own where('schoolId', ...) alongside where('examId', ...)).
            // Without this, the query is rejected outright as unprovable,
            // regardless of whether every matching doc would actually pass.
            // SECURITY: scoped to this assignment's class. firestore.rules only
            // lets a teacher list grades of a class they are assigned to
            // (class doc teacherIds), and can only prove that when the query
            // itself pins classId — a school-wide grades query is rejected.
            getDocs(query(
                collectionGroup(db, 'grades'),
                where('schoolId', '==', session.schoolId),
                where('classId', '==', reviewAssignment.classId),
                where('assignmentId', '==', assignmentId)
            ))
        ]);
        reviewSubmissions = submissionsMap;
        // Grade docs live at students/{studentId}/grades/{gradeId} and don't
        // store studentId on themselves — it's the doc's grandparent id.
        gradesSnap.docs.forEach(d => {
            const studentId = d.ref.parent.parent?.id;
            if (studentId) reviewGrades.set(studentId, { id: d.id, studentId, ...d.data() });
        });
    } catch (e) {
        console.error('[Subjects] openReviewSubmissions load failed:', e);
        document.getElementById('reviewBody').innerHTML = `<p class="text-sm font-bold text-red-600 text-center py-10">Could not load submissions. Please try again.</p>`;
        return;
    }

    renderReviewBody();
};

window.closeReviewSubmissions = function() { closeOverlay('reviewSubmissionsModal', 'reviewSubmissionsModalInner', true); };

function renderReviewBody() {
    const wrap = document.getElementById('reviewBody');
    if (!wrap || !reviewAssignment) return;

    if (!reviewRoster.length) {
        wrap.innerHTML = `<p class="text-sm font-bold text-slate-400 text-center py-10">No students on this class roster yet.</p>`;
        return;
    }

    const submittedCount = reviewRoster.filter(s => reviewSubmissions.has(s.id)).length;
    const gradedCount    = reviewRoster.filter(s => reviewGrades.has(s.id)).length;

    const summary = `
        <div class="flex items-center gap-4 text-xs font-black text-slate-500 mb-3">
            <span><i class="fa-solid fa-inbox text-teal-500 mr-1"></i>${submittedCount} of ${reviewRoster.length} submitted</span>
            <span><i class="fa-solid fa-circle-check text-emerald-500 mr-1"></i>${gradedCount} of ${reviewRoster.length} graded</span>
        </div>`;

    const lockedNotice = isSemesterLocked
        ? `<div class="bg-amber-50 border border-amber-200 rounded-2xl p-3 text-xs font-bold text-amber-700 flex items-center gap-2 mb-3"><i class="fa-solid fa-lock"></i> This period is locked. Grades are read-only.</div>`
        : '';

    const rows = reviewRoster.slice()
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
        .map(renderReviewRow).join('');

    wrap.innerHTML = summary + lockedNotice + `<div class="space-y-3">${rows}</div>`;
}

// PHASE 1 (Grading Workflow Streamline): the inline Score/Notes inputs that
// used to live in this row were a SECOND place a grade could be entered,
// duplicating the Enter Grade form and risking the two falling out of sync
// (a score typed here never got the per-question breakdown Enter Grade now
// owns). Mandate: this row becomes read-only — it shows a student's
// submitted-vs-graded state and offers two actions, "View Answers" (a
// read-only look at exactly what the student submitted, including the
// per-question responses[] an assessment submission carries, which this row
// never rendered at all before) and "Grade" (routes straight into
// grade_form.html, deep-linked to this exact subject/assignment/student via
// URL params, mirroring the ?subjectId=&classId=&subjectName= pattern the
// Lesson Builder link above already uses). Actually recording a grade is
// now Enter Grade's job alone — see saveGrade()'s own single-source-of-truth
// comment in utils.js.
function renderReviewRow(s) {
    const submission = reviewSubmissions.get(s.id) || null;
    const grade = reviewGrades.get(s.id) || null;
    const hasHistory = grade && Array.isArray(grade.historyLogs) && grade.historyLogs.length > 0;

    const submissionSummary = submission
        ? `<p class="text-[10px] text-slate-400 font-bold pt-0.5">Submitted ${submission.submittedAt ? new Date(submission.submittedAt).toLocaleString() : '—'}</p>`
        : `<p class="text-xs italic text-slate-400 font-semibold bg-slate-50 border border-dashed border-slate-200 rounded-xl p-3">Not submitted yet.</p>`;

    const gradeBadge = grade
        ? `<span class="inline-flex items-center gap-1.5 bg-emerald-50 border border-emerald-200 text-emerald-700 font-black text-sm px-3 py-2 rounded-lg"><i class="fa-solid fa-circle-check text-[11px]"></i>${grade.score}/${grade.max}</span>`
        : `<span class="inline-flex items-center gap-1.5 bg-slate-50 border border-dashed border-slate-200 text-slate-400 font-black text-xs px-3 py-2 rounded-lg uppercase tracking-wide">Not graded</span>`;

    const historyBlock = hasHistory
        ? `<details class="mt-2">
               <summary class="text-[10px] font-black text-amber-600 cursor-pointer select-none">Regraded ${grade.historyLogs.length}× — view history</summary>
               <ul class="mt-1 space-y-0.5 pl-0.5">
                   ${grade.historyLogs.map(h => `<li class="text-[10px] text-slate-500 font-semibold">${new Date(h.timestamp).toLocaleString()}: ${h.oldScore} → ${h.newScore}</li>`).join('')}
               </ul>
           </details>`
        : '';

    return `
    <div class="bg-white border border-slate-200 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-start gap-4">
        <div class="sm:w-56 flex-shrink-0">
            <p class="font-black text-slate-700 text-sm">${escHtml(s.name)}</p>
            <p class="text-[11px] text-slate-400 font-bold mb-2 font-mono">${escHtml(s.id)}</p>
            ${submissionSummary}
        </div>
        <div class="flex-1 flex items-center gap-3 flex-wrap">
            ${gradeBadge}
            <button type="button" onclick="openViewAnswers('${s.id}')" ${submission ? '' : 'disabled'}
                class="flex items-center gap-1.5 font-black px-3.5 py-2 rounded-lg text-xs border transition ${submission ? 'bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-200' : 'bg-slate-50 text-slate-300 border-slate-100 cursor-not-allowed'}">
                <i class="fa-solid fa-eye text-[10px]"></i> View Answers
            </button>
            <button type="button" onclick="routeToGrade('${s.id}')"
                class="flex items-center gap-1.5 bg-teal-600 hover:bg-teal-700 text-white font-black px-3.5 py-2 rounded-lg text-xs border border-teal-600 transition">
                <i class="fa-solid fa-pen-to-square text-[10px]"></i> ${grade ? 'Regrade' : 'Grade'}
            </button>
        </div>
        ${historyBlock}
    </div>`;
}

// ── VIEW ANSWERS (read-only) ─────────────────────────────────────────────
// Renders exactly what the student submitted — for an assessment (real
// questions[]), a per-question breakdown identical in shape to grade_form.js's
// own renderSubmissionPanel() (same MC option/auto-grade-badge markup, same
// text/attachment handling), so a teacher never has to leave this page to
// see WHAT was answered before deciding whether to open Enter Grade at all.
// For standard-work/legacy submissions, just the response text/link this row
// used to render inline.
window.openViewAnswers = function(studentId) {
    const submission = reviewSubmissions.get(studentId);
    if (!submission || !reviewAssignment) return;
    const student = reviewRoster.find(r => r.id === studentId);

    document.getElementById('viewAnswersTitle').textContent = student ? student.name : 'Student Answers';
    document.getElementById('viewAnswersMeta').textContent = `${reviewAssignment.title} · Submitted ${submission.submittedAt ? new Date(submission.submittedAt).toLocaleString() : '—'}`;
    document.getElementById('viewAnswersBody').innerHTML = renderViewAnswersBody(submission);

    openOverlay('viewAnswersModal', 'viewAnswersModalInner');
};

window.closeViewAnswers = function() { closeOverlay('viewAnswersModal', 'viewAnswersModalInner'); };

function renderViewAnswersBody(submission) {
    const isAssessment = Array.isArray(reviewAssignment.questions) && reviewAssignment.questions.length > 0;

    if (!isAssessment) {
        return `
        <div class="bg-white border border-slate-200 rounded-xl p-4 space-y-2">
            ${submission.responseText ? `<p class="text-[13px] text-slate-700 whitespace-pre-wrap">${escHtml(submission.responseText)}</p>` : ''}
            ${submission.linkUrl ? `<p class="text-[12.5px]"><a href="${escHtml(submission.linkUrl)}" target="_blank" rel="noopener" class="text-teal-600 font-bold hover:underline break-all"><i class="fa-solid fa-link mr-1"></i>${escHtml(submission.linkUrl)}</a></p>` : ''}
            ${!submission.responseText && !submission.linkUrl ? `<p class="italic text-slate-400 text-sm">Submitted with no text or link.</p>` : ''}
        </div>`;
    }

    const responsesByQid = new Map((submission.responses || []).map(r => [r.questionId, r]));
    const autoGrade = submission.objectiveAutoGrade || null;

    const cards = reviewAssignment.questions.map((q, i) => {
        const r = responsesByQid.get(q.id) || null;
        let body = '';

        if (q.type === 'multiple_choice') {
            const selectedIndex = r && r.responseText !== '' && r.responseText != null ? Number(r.responseText) : null;
            const optionsHtml = (q.options || []).map((opt, oi) => `
                <div class="flex items-center gap-2 px-2.5 py-1.5 rounded-sm text-[12px] ${selectedIndex === oi ? 'bg-teal-50 border border-teal-200 font-bold text-slate-800' : 'text-slate-500'}">
                    <span class="w-4 h-4 flex-shrink-0 rounded-full border ${selectedIndex === oi ? 'border-teal-600 bg-teal-600 text-white' : 'border-slate-300'} flex items-center justify-center text-[9px] font-bold">${selectedIndex === oi ? '<i class="fa-solid fa-check"></i>' : String.fromCharCode(65 + oi)}</span>
                    <span>${escHtml(opt)}</span>
                </div>`).join('');
            const graded = !!autoGrade && Object.prototype.hasOwnProperty.call(autoGrade.perQuestion || {}, q.id);
            const badge = selectedIndex === null
                ? `<span class="text-[10px] font-bold uppercase tracking-widest text-slate-400 bg-slate-50 border border-slate-200 px-2 py-0.5 rounded-sm">Not answered</span>`
                : !graded
                    ? `<span class="text-[10px] font-bold uppercase tracking-widest text-slate-400 bg-slate-50 border border-slate-200 px-2 py-0.5 rounded-sm">Not yet auto-graded</span>`
                    : autoGrade.perQuestion[q.id]
                        ? `<span class="text-[10px] font-bold uppercase tracking-widest text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-sm"><i class="fa-solid fa-check text-[9px] mr-1"></i>Correct</span>`
                        : `<span class="text-[10px] font-bold uppercase tracking-widest text-red-700 bg-red-50 border border-red-200 px-2 py-0.5 rounded-sm"><i class="fa-solid fa-xmark text-[9px] mr-1"></i>Incorrect</span>`;
            body = `<div class="space-y-1 mt-2">${optionsHtml}</div><div class="mt-2">${badge}</div>`;
        } else if (q.type === 'free_response' || q.type === 'short_answer' || q.type === 'math') {
            const text = r && r.responseText ? r.responseText : '';
            body = text
                ? `<p class="text-[12.5px] text-slate-700 whitespace-pre-wrap bg-slate-50 border border-slate-200 rounded-sm p-2.5 mt-2">${escHtml(text)}</p>`
                : `<p class="text-[11px] text-slate-400 italic mt-2">No answer provided.</p>`;
        } else if (q.type === 'attachment_response') {
            const url = r && r.attachmentUrl ? r.attachmentUrl : null;
            if (!url) {
                body = `<p class="text-[11px] text-slate-400 italic mt-2">No file/drawing submitted.</p>`;
            } else if (/^data:image\//i.test(url) || /\.(png|jpe?g|gif|webp)(\?|$)/i.test(url)) {
                body = `<a href="${escHtml(url)}" target="_blank" rel="noopener noreferrer" class="block mt-2"><img src="${escHtml(url)}" class="max-h-48 rounded-sm border border-slate-200" alt="Student submission"></a>`;
            } else {
                body = `<a href="${escHtml(url)}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1.5 text-[12px] font-bold text-teal-600 mt-2"><i class="fa-solid fa-paperclip text-[10px]"></i>View submitted file</a>`;
            }
        }

        return `
        <div class="border border-slate-200 rounded-sm p-3 bg-white">
            <div class="flex items-start justify-between gap-2">
                <p class="text-[12px] font-bold text-slate-800 m-0">Q${i + 1}. ${escHtml(q.prompt)}</p>
                <span class="text-[10px] font-bold text-slate-400 flex-shrink-0">${q.points ?? 0} pt${(q.points ?? 0) === 1 ? '' : 's'}</span>
            </div>
            ${body}
        </div>`;
    }).join('');

    return `<div class="space-y-3">${cards}</div>`;
}

// ── ROUTE TO GRADE ────────────────────────────────────────────────────────
// Deep-links straight into the Enter Grade form for this exact
// subject/assignment/student — the same URLSearchParams pattern the Lesson
// Builder link above uses (subjectId/classId/subjectName), just consumed by
// grade_form.js's own bootstrap instead of builder.js's. grade_form.js
// resolves subjectId back to this teacher's own cached subject list (it
// already has the same loadTeacherSubjectsCache() data this page does), so
// no extra context needs to travel in the URL beyond the three ids.
window.routeToGrade = function(studentId) {
    if (!reviewAssignment) return;
    const params = new URLSearchParams({
        subjectId: reviewAssignment.subjectId || '',
        assignmentId: reviewAssignment.id || '',
        studentId: studentId || ''
    });
    window.location.href = `../grade_form/grade_form.html?${params.toString()}`;
};

// ── 6. ASSIGNMENT DETAIL MODAL ──────────────────────────────────────────────
window.openAssignmentModal = function(gradeId) {
    const g = gradeDetailCache[gradeId];
    if (!g) return;
    
    const pct = g.max ? Math.round(g.score / g.max * 100) : null;
    const fill = gradeFill(pct || 0);
    const color = pct >= 90 ? 'text-emerald-600' : pct >= 80 ? 'text-blue-600' : pct >= 70 ? 'text-teal-600' : pct >= 65 ? 'text-amber-600' : 'text-red-600';
    
    document.getElementById('aModalTitle').textContent = g.title || 'Assessment';
    
    let histHTML = '';
    if (g.historyLogs?.length) {
        histHTML = `<div class="bg-amber-50 border border-amber-200 rounded-xl p-4"><p class="text-xs font-black text-amber-600 uppercase tracking-wider mb-2"><i class="fa-solid fa-clock-rotate-left mr-1"></i>Edit History (${g.historyLogs.length})</p><div class="space-y-2 max-h-32 overflow-y-auto">${g.historyLogs.map(l => `<div class="text-xs text-amber-800 font-semibold bg-white rounded-lg p-2 border border-amber-100"><i class="fa-solid fa-circle-dot mr-1 text-amber-400"></i>${typeof l === 'object' ? `[${l.changedAt}] ${l.oldScore}/${l.oldMax} → ${l.newScore}/${l.newMax}. Reason: ${l.reason}` : l}</div>`).join('')}</div></div>`;
    }
    
    document.getElementById('aModalBody').innerHTML = `
        <div class="text-center mb-5">
            <div class="${color} text-5xl font-black">${g.score}<span class="text-2xl text-slate-400">/${g.max || '?'}</span></div>
            ${pct !== null ? `<div class="flex items-center justify-center gap-3 mt-2"><span class="${color} text-xl font-black">${pct}%</span><span class="${color} font-black px-3 py-1 rounded-xl text-lg border ${pct >= 90 ? 'bg-emerald-50 border-emerald-200' : pct >= 80 ? 'bg-blue-50 border-blue-200' : pct >= 70 ? 'bg-teal-50 border-teal-200' : pct >= 65 ? 'bg-amber-50 border-amber-200' : 'bg-red-50 border-red-200'}">${letterGrade(pct)}</span></div>` : ''}
            <div class="mt-3 h-3 bg-slate-100 rounded-full overflow-hidden mx-4"><div class="h-full rounded-full" style="width:${pct || 0}%;background:${fill};transition:width 0.5s ease"></div></div>
        </div>
        <div class="space-y-2 text-sm mb-4">
            ${[['Subject', g.subject || '—'], ['Type', g.type || '—'], ['Date', g.date || '—']].map(([l, v]) => `<div class="flex justify-between py-2 border-b border-slate-100"><span class="text-slate-400 font-black uppercase text-xs tracking-wider">${l}</span><span class="font-black text-slate-700">${v}</span></div>`).join('')}
        </div>
        ${g.notes ? `<div class="bg-blue-50 border border-blue-100 rounded-xl p-4 mb-3"><p class="text-xs font-black text-blue-500 uppercase tracking-wider mb-1">Teacher Notes</p><p class="text-sm text-slate-700 font-semibold whitespace-pre-wrap">${g.notes}</p></div>` : ''}
        ${histHTML}
    `;
    
    openOverlay('assignmentModal', 'assignmentModalInner');
};
window.closeAssignmentModal = function() { closeOverlay('assignmentModal', 'assignmentModalInner'); };

// ═════════════  8. ADD WORK / UNIVERSAL ASSIGNMENT BUILDER  ═════════════
// LIFT & SHIFT REFACTOR: this engine used to live in teacher/grade_form/
// grade_form.js as the "Add Work" modal (Phases 3-4 built its Firestore
// persistence and legacy auto-grade shadow doc on top of it there, and it
// was create-only — nothing ever opened it in edit mode). It has moved here
// verbatim in its persistence logic, and generalized per the "one-size-
// fits-all" mandate: there is no more Assessment vs. Standard split — every
// work type gets Instructions + Description + Locked + Teacher Media
// Attachments, plus an always-available, optional (0-N question) builder.
// It now also REPLACES this file's own separate, older "Prepare a new
// assignment" inline composer (formerly saveAssignment()/
// renderAssignmentsTab()'s formCard), which wrote a simpler document shape
// (no category/questions/answer key) — this is now the ONLY way to create
// or edit an assignment in the Subjects hub, for both the plain and
// question-based cases, via openAddWorkModal() / openAddWorkModal(id).
//
// SCHEMA DECISION — read before touching field names: the assignment
// document shape written here is the PRE-EXISTING one every other reader in
// this file already depends on unnormalized — title/type/maxScore/date/
// instructions/description/locked/lockedAt/completed/createdAt/updatedAt —
// NOT the original Add Work engine's workType/pointsPossible/dueDate/status
// names (those never reached production data; the modal was never wired
// into a page teachers actually used before this refactor). Only
// `category`, `questions` (which functions/index.js's autoGradeWorkSubmission
// reads) and `attachments` carry over from the original Add Work payload.
// grade_form.js's own normalizer (`type: a.workType || a.type`, `maxScore:
// a.pointsPossible ?? a.maxScore`) still falls back correctly for any
// assignment that predates this change, so nothing existing breaks either
// way — this is simply the schema going forward.
//
// `category` is no longer derived from the work TYPE label (Test/Quiz vs.
// Assignment/Homework) — every type may now carry 0-N questions — so it's
// derived from whether the teacher actually added any: 'assessment' when at
// least one exists, 'standard' otherwise. That's exactly the condition
// autoGradeWorkSubmission and isAssessmentAssignment() (grade_form.js) both
// gate on, so auto-grading keeps working for a "Homework" with a multiple-
// choice question exactly as it would for a "Quiz" with one. There is no
// longer a separate "draft vs. posted" status — the old composer never had
// one either, and inventing a third hybrid state here would work against
// "without requiring a database migration script."
//
// Uploads (Phase 2.2) target schools/{schoolId}/attachments/{classId}/
// {subjectId}/{assignmentId}/{fileName} in Firebase Storage — a NEW rule
// added to storage.rules for this refactor (teacher/admin write, same-
// school read, 25MB cap). assignmentId is generated up front, when the
// modal opens (openAddWorkModal), rather than at Save time, specifically so
// an upload made mid-composition has a real, final path to land at —
// mirroring how uploadSubmissionAttachment (submissions.js) already uploads
// immediately on selection rather than deferring to final submit.
let awQuestions = [];
let awQuestionSeq = 0;
let awTaskAttachments = [];       // task-level "Teacher Media Attachments" — was awStandardAttachments in the original engine
let awEditingAssignmentId = null; // null = create mode; an id = editing that existing assignment
let awCurrentAssignmentId = null; // stable id for both create (generated on open) and edit (existing id)
let awFileUploadTarget = null;    // { scope: 'task'|'question', questionId } — which block #awFileInput is uploading into

// ── FULL-PAGE EDITOR ─────────────────────────────────────────────────────
// The Add Work builder renders as a page inside the Assignments tab
// (subject.html?…&tab=assignments&assignment={id|new}) instead of a modal.
// #awPanel (markup in subject.html) is moved into the tab's workspace while
// the route is open and returned to its hidden overlay on unmount, so the
// builder code below keeps reading its fields by id unchanged.
let awPage = null;               // { onClose } while the full-page editor is mounted
let awOpenEditorRoute = null;    // set by the Assignments tab: (id) => navigate to the editor
let awDirty = false;
let awPdf = null;                // { url, name, fields[], pageCount } — PDF worksheet being edited
let awPdfEditor = null;          // mountPdfFieldEditor handle

export function setAssignmentEditorRoute(fn) { awOpenEditorRoute = typeof fn === 'function' ? fn : null; }

export function mountAssignmentEditor({ host, assignmentId, onClose }) {
    const panel = document.getElementById('awPanel');
    const overlay = document.getElementById('addWorkModalOverlay');
    if (!panel || !overlay || !host) return null;
    awPage = { onClose: typeof onClose === 'function' ? onClose : () => {} };
    panel.classList.add('aw-page');
    host.appendChild(panel);
    window.openAddWorkModal(assignmentId || undefined);
    awDirty = false;
    const markDirty = () => { awDirty = true; };
    panel.addEventListener('input', markDirty);
    panel.addEventListener('change', markDirty);
    setTimeout(() => document.getElementById('awTitle')?.focus({ preventScroll: true }), 0);
    return {
        exists: !assignmentId || getAssignmentsForSubject(currentSubjectName).some(a => a.id === assignmentId),
        destroy() {
            panel.removeEventListener('input', markDirty);
            panel.removeEventListener('change', markDirty);
            if (awPdfEditor) { awPdfEditor.destroy(); awPdfEditor = null; }
            panel.classList.remove('aw-page');
            overlay.appendChild(panel);
            awPage = null;
            awDirty = false;
        },
    };
}

const AW_QUESTION_TYPES = [
    { value: 'multiple_choice',    label: 'Multiple Choice' },
    { value: 'free_response',      label: 'Free Response' },
    { value: 'short_answer',       label: 'Short Answer' },
    { value: 'math',               label: 'Math / Equation' },
    { value: 'attachment_response', label: 'Attachment / Draw / Photo Response' }
];
const AW_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // mirrors storage.rules' cap on this path

function awMakeQuestion(type = 'multiple_choice') {
    const base = { id: `q_${++awQuestionSeq}`, type, prompt: '', points: 1, attachments: [] };
    // correctOptionIndex is the answer-key source for multiple_choice — it
    // never leaves this in-memory state as part of the clean question
    // object; awSaveWork lifts it out into the separate work_answer_keys
    // write. null until the teacher marks one (validated before save).
    if (type === 'multiple_choice') { base.options = ['', '']; base.correctOptionIndex = null; }
    if (type === 'free_response' || type === 'short_answer' || type === 'math') base.hint = '';
    if (type === 'attachment_response') base.responseType = 'File Upload';
    return base;
}

function awResetQuestionTypeFields(q, newType) {
    delete q.options; delete q.hint; delete q.responseType; delete q.correctOptionIndex;
    if (newType === 'multiple_choice') { q.options = ['', '']; q.correctOptionIndex = null; }
    if (newType === 'free_response' || newType === 'short_answer' || newType === 'math') q.hint = '';
    if (newType === 'attachment_response') q.responseType = 'File Upload';
    q.type = newType;
}

function awFindQuestion(id) {
    return awQuestions.find(q => q.id === id) || null;
}

// ── DUE DATE & TIME ENGINE ────────────────────────────────────────────────
// awDueDate is now a <input type="datetime-local">, but the `date` field it
// reads/writes is unchanged — every existing assignment, sort, and display
// (normalizeAssignment/renderAssignmentCard/statusPill in the student and
// parent portals) already keys off this one field, so extending its input
// type in place is a non-breaking upgrade rather than a second, competing
// date field nothing else would know to read.
//
// Storage stays an ISO 8601 string (via .toISOString()), NOT a raw
// Firestore Timestamp object, to match every other timestamp already in
// this schema (submittedAt/createdAt/updatedAt/lockedAt — all plain ISO
// strings). A real Timestamp would (a) serialize as {_seconds,_nanoseconds}
// through getParentAssignments' JSON response instead of a comparable
// value, and (b) need its own .toDate() conversion everywhere it's
// compared against those ISO submittedAt strings — two new special cases
// for one field, for no behavioral benefit an ISO string doesn't already
// give.
//
// A legacy date-only value ("YYYY-MM-DD", saved before this mandate) has no
// time-of-day to show — dueDateToInputValue() below pre-fills midnight
// rather than guessing an end-of-day time the teacher never actually set;
// resolveDueDeadline() (student/assignments/assignments.js and
// getParentAssignments in functions/index.js) is what treats a bare date as
// "due end of that day" for comparison purposes, not this conversion.
function dueDateToInputValue(stored) {
    if (!stored) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(stored)) return stored + 'T00:00';
    const d = new Date(stored);
    if (isNaN(d.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function dueDateInputToIso(inputValue) {
    if (!inputValue) return '';
    const d = new Date(inputValue);
    return isNaN(d.getTime()) ? '' : d.toISOString();
}

// Display-only: a legacy date-only value ("YYYY-MM-DD") shows just the
// date (unchanged from before this mandate); a value saved with a time
// shows both, so a teacher can tell at a glance which of their assignments
// have a real deadline moment vs. just a due day.
function formatDueDate(stored) {
    if (!stored) return '';
    try {
        const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(stored);
        const d = isDateOnly
            ? new Date(Number(stored.slice(0, 4)), Number(stored.slice(5, 7)) - 1, Number(stored.slice(8, 10)))
            : new Date(stored);
        return isDateOnly
            ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
            : d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch (e) { return stored; }
}

window.openAddWorkModal = function(assignmentId) {
    const sub = getSubjectByName(currentSubjectName);
    const overlay = document.getElementById('addWorkModalOverlay');
    if (!sub || !overlay) return;

    const typeSel = document.getElementById('awType');
    const typeOptions = getGradeTypes().map(t => {
        const v = t.name || t;
        return `<option value="${escHtml(v)}">${escHtml(v)}</option>`;
    }).join('');
    if (typeSel) typeSel.innerHTML = '<option value="">Select type…</option>' + typeOptions;

    const existing = assignmentId ? getAssignmentsForSubject(currentSubjectName).find(a => a.id === assignmentId) : null;
    awEditingAssignmentId = existing ? existing.id : null;
    awCurrentAssignmentId = existing ? existing.id : genAssignmentId();

    document.getElementById('awModalTitle').textContent = existing ? 'Edit Assignment' : 'Add Work';
    document.getElementById('awModalSubtitle').textContent = existing
        ? `Editing "${existing.title}" in ${currentSubjectName}`
        : `Create a new assignment or assessment for ${currentSubjectName}`;
    document.getElementById('awSaveBtn').innerHTML = existing
        ? '<i class="fa-solid fa-check"></i> Save changes'
        : `<i class="fa-solid fa-plus"></i> Add to ${escHtml(currentSubjectName)}`;

    document.getElementById('awTitle').value = existing?.title || '';
    if (typeSel) typeSel.value = existing?.type || '';
    document.getElementById('awDueDate').value = dueDateToInputValue(existing?.date);
    document.getElementById('awPoints').value = existing ? (existing.maxScore ?? '') : '';
    document.getElementById('awInstructions').value = existing?.instructions || '';
    document.getElementById('awDescription').value = existing?.description || '';
    document.getElementById('awLocked').checked = !!(existing?.locked);
    document.getElementById('awTheme').value = normalizeTheme(existing?.theme);
    document.getElementById('awTimeLimit').value = existing?.timeLimitMin ? String(existing.timeLimitMin) : '';
    document.getElementById('awShowWork').checked = !!(existing?.showWork);
    awPdf = existing?.pdfWorksheet?.url ? { ...existing.pdfWorksheet, fields: [...(existing.pdfWorksheet.fields || [])] } : null;
    awRenderPdf();

    awQuestionSeq = 0;
    // Existing multiple_choice answers can never be recovered here — the
    // answer key lives in work_answer_keys, which is permanently read-denied
    // to every client (firestore.rules) by design. Prompts/points/options/
    // attachments carry over; correctOptionIndex always comes back null, and
    // awValidate already requires re-marking it before save — awRemarkNotice
    // below just makes that visible up front instead of a surprise at Save.
    awQuestions = (existing?.questions || []).map(q => {
        const copy = { ...q, attachments: Array.isArray(q.attachments) ? [...q.attachments] : [] };
        const seqNum = parseInt(String(q.id).replace(/\D/g, ''), 10);
        if (!isNaN(seqNum)) awQuestionSeq = Math.max(awQuestionSeq, seqNum);
        if (copy.type === 'multiple_choice') copy.correctOptionIndex = null;
        return copy;
    });
    awTaskAttachments = Array.isArray(existing?.attachments) ? [...existing.attachments] : [];

    const remarkNotice = document.getElementById('awRemarkNotice');
    if (remarkNotice) remarkNotice.classList.toggle('hidden', !awQuestions.some(q => q.type === 'multiple_choice'));

    awClearBanners();
    awRenderTaskAttachments();
    awRenderBuilder();
    if (awPage) return; // full-page editor: already in place
    overlay.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
};

window.closeAddWorkModal = function(opts) {
    if (awPage) {
        const saved = opts && opts.saved;
        if (!saved && awDirty && !confirm('Leave without saving? Your changes to this assignment will be lost.')) return;
        awDirty = false;
        awPage.onClose();
        return;
    }
    const overlay = document.getElementById('addWorkModalOverlay');
    if (!overlay) return;
    overlay.classList.add('hidden');
    document.body.style.overflow = '';
};

// ── Task-level "Teacher Media Attachments" — its own small mount point so
// typing in Instructions/Description (plain static fields, read directly at
// save time like Title/Type/etc.) never gets touched by an attachment re-render.
function awRenderTaskAttachments() {
    const el = document.getElementById('awTaskAttachmentsContainer');
    if (el) el.innerHTML = awRenderAttachmentBlock(awTaskAttachments, null, 'task');
}

// ── PDF worksheet: upload once, then click the pages to place answer boxes ──
function awRenderPdf() {
    const host = document.getElementById('awPdfContainer');
    if (!host) return;
    if (awPdfEditor) { awPdfEditor.destroy(); awPdfEditor = null; }
    if (!awPdf) {
        host.innerHTML = `<button type="button" data-aw-pdf="upload" class="w-full border-2 border-dashed border-slate-200 hover:border-teal-400 text-slate-500 hover:text-teal-600 rounded-xl py-3 text-[11px] font-black uppercase tracking-widest transition"><i class="fa-solid fa-file-pdf mr-1.5"></i>Upload PDF worksheet</button>`;
        return;
    }
    host.innerHTML = `
        <div class="flex items-center justify-between gap-2 mb-2">
            <a href="${escHtml(awPdf.url)}" target="_blank" rel="noopener" class="text-[12.5px] font-bold text-teal-700 truncate"><i class="fa-solid fa-file-pdf mr-1"></i>${escHtml(awPdf.name || 'Worksheet.pdf')}</a>
            <div class="flex gap-2 flex-shrink-0">
                <button type="button" data-aw-pdf="upload" class="text-[11px] font-bold text-slate-500 hover:text-teal-700">Replace</button>
                <button type="button" data-aw-pdf="remove" class="text-[11px] font-bold text-slate-400 hover:text-red-500">Remove</button>
            </div>
        </div>
        <div id="awPdfEditorHost" class="max-h-[70vh] overflow-y-auto rounded-xl bg-slate-50 p-2 border border-slate-200"></div>`;
    import('../../assets/js/assessment/pdf-worksheet.js').then(async ({ mountPdfFieldEditor }) => {
        const editorHost = document.getElementById('awPdfEditorHost');
        if (!editorHost || !awPdf) return;
        awPdfEditor = await mountPdfFieldEditor({
            host: editorHost, url: awPdf.url, fields: awPdf.fields || [],
            onChange: (fields) => { if (awPdf) { awPdf.fields = fields; awDirty = true; } },
        });
        if (awPdf) awPdf.pageCount = awPdfEditor.pageCount || awPdf.pageCount || 0;
    });
}

function initPdfEvents() {
    const host = document.getElementById('awPdfContainer');
    const input = document.getElementById('awPdfInput');
    if (!host || !input) return;
    host.addEventListener('click', (e) => {
        const b = e.target.closest('[data-aw-pdf]');
        if (!b) return;
        if (b.dataset.awPdf === 'upload') input.click();
        if (b.dataset.awPdf === 'remove' && confirm('Remove this PDF worksheet and its answer boxes?')) { awPdf = null; awDirty = true; awRenderPdf(); }
    });
    input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        input.value = '';
        if (!file) return;
        if (file.type !== 'application/pdf') { awShowError('Choose a PDF file.'); return; }
        if (file.size > AW_MAX_ATTACHMENT_BYTES) { awShowError('That PDF is larger than 25 MB.'); return; }
        host.innerHTML = '<p class="text-[12px] font-bold text-slate-400 py-3 text-center"><i class="fa-solid fa-spinner fa-spin mr-1"></i>Uploading PDF…</p>';
        try {
            const att = await uploadWorkAttachment(file);
            awPdf = { url: att.url, name: file.name, fields: [], pageCount: 0 };
            awDirty = true;
        } catch (err) {
            awShowError(err?.message || 'Could not upload the PDF.');
        }
        awRenderPdf();
    });
}

// ── Questions builder: always rendered, 0-N question cards + Add Question ──
function awRenderBuilder() {
    const container = document.getElementById('addWorkBuilderContainer');
    if (!container) return;
    const cards = awQuestions.map((q, i) => awRenderQuestionCard(q, i)).join('');
    const empty = awQuestions.length === 0
        ? `<p class="text-[11px] text-slate-400 italic text-center py-3">No questions yet — this will be an instructions-only assignment unless you add one below.</p>` : '';
    container.innerHTML = `
        ${cards}
        ${empty}
        <button type="button" data-aw-action="add-question"
            class="w-full border-2 border-dashed border-slate-200 hover:border-teal-400 text-slate-400 hover:text-teal-600 rounded-xl py-3 text-[11px] font-black uppercase tracking-widest transition">
            <i class="fa-solid fa-plus mr-1.5"></i>Add Question
        </button>`;
}

function awRenderQuestionCard(q, index) {
    const typeOptions = AW_QUESTION_TYPES.map(t =>
        `<option value="${t.value}" ${t.value === q.type ? 'selected' : ''}>${t.label}</option>`).join('');

    return `
    <div class="bg-white border border-slate-200 rounded-xl p-4 mb-3" data-question-id="${q.id}">
        <div class="flex items-start justify-between gap-3 mb-3">
            <div class="flex items-center gap-2 min-w-0">
                <span class="w-6 h-6 flex-shrink-0 bg-teal-50 text-teal-600 border border-teal-200 rounded-lg flex items-center justify-center text-[10px] font-black">${index + 1}</span>
                <select data-question-id="${q.id}" data-field="type" data-aw-change="question-type"
                    class="form-select text-[11px] font-black text-slate-700 border border-slate-200 rounded-lg py-1 pl-2 pr-6 outline-none focus:border-teal-400 appearance-none">
                    ${typeOptions}
                </select>
            </div>
            <div class="flex items-center gap-1 flex-shrink-0">
                <button type="button" data-question-id="${q.id}" data-aw-action="move-up" ${index === 0 ? 'disabled' : ''}
                    class="w-7 h-7 flex items-center justify-center text-slate-300 hover:text-slate-700 disabled:opacity-30 disabled:cursor-not-allowed rounded-lg transition" title="Move up">
                    <i class="fa-solid fa-arrow-up text-[11px]"></i>
                </button>
                <button type="button" data-question-id="${q.id}" data-aw-action="move-down" ${index === awQuestions.length - 1 ? 'disabled' : ''}
                    class="w-7 h-7 flex items-center justify-center text-slate-300 hover:text-slate-700 disabled:opacity-30 disabled:cursor-not-allowed rounded-lg transition" title="Move down">
                    <i class="fa-solid fa-arrow-down text-[11px]"></i>
                </button>
                <button type="button" data-question-id="${q.id}" data-aw-action="delete-question"
                    class="w-7 h-7 flex items-center justify-center text-slate-300 hover:text-red-500 rounded-lg transition" title="Delete question">
                    <i class="fa-solid fa-trash text-[11px]"></i>
                </button>
            </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-[1fr_100px] gap-3 mb-3">
            <div>
                <label class="block text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">Prompt</label>
                <textarea data-question-id="${q.id}" data-field="prompt" data-aw-input="question-field"
                    placeholder="Type the question…"
                    class="form-input w-full p-2 bg-white border border-slate-200 rounded-lg text-[12.5px] text-slate-800 h-16 resize-none focus:border-teal-400 focus:ring-0 transition outline-none">${escHtml(q.prompt || '')}</textarea>
            </div>
            <div>
                <label class="block text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">Points</label>
                <input type="number" min="0" step="any" inputmode="decimal" value="${q.points ?? 1}"
                    data-question-id="${q.id}" data-field="points" data-aw-input="question-field"
                    class="form-input w-full p-2 bg-white border border-slate-200 rounded-lg text-[12.5px] text-slate-800 focus:border-teal-400 focus:ring-0 transition outline-none">
            </div>
        </div>

        ${awRenderQuestionTypeFields(q)}
        ${awRenderAttachmentBlock(q.attachments, q.id, 'question')}
    </div>`;
}

function awRenderQuestionTypeFields(q) {
    if (q.type === 'multiple_choice') {
        const options = (q.options || []).map((opt, i) => `
            <div class="flex items-center gap-2">
                <input type="radio" name="aw-correct-${q.id}" data-question-id="${q.id}" data-option-index="${i}" data-aw-action="set-correct"
                    ${q.correctOptionIndex === i ? 'checked' : ''}
                    class="w-3.5 h-3.5 accent-teal-600 cursor-pointer flex-shrink-0" title="Mark as the correct answer">
                <span class="text-[10px] font-black text-slate-400 w-4 flex-shrink-0">${String.fromCharCode(65 + i)}</span>
                <input type="text" value="${escHtml(opt)}" placeholder="Option ${i + 1}"
                    data-question-id="${q.id}" data-option-index="${i}" data-aw-input="option-text"
                    class="form-input flex-1 p-1.5 bg-white border border-slate-200 rounded-lg text-[12px] text-slate-800 focus:border-teal-400 focus:ring-0 transition outline-none">
                <button type="button" data-question-id="${q.id}" data-option-index="${i}" data-aw-action="remove-option"
                    ${(q.options || []).length <= 2 ? 'disabled' : ''}
                    class="w-6 h-6 flex-shrink-0 flex items-center justify-center text-slate-300 hover:text-red-500 disabled:opacity-30 disabled:cursor-not-allowed rounded-lg transition">
                    <i class="fa-solid fa-xmark text-[11px]"></i>
                </button>
            </div>`).join('');
        return `
            <div class="mb-3 pl-1 space-y-1.5">
                ${options}
                <button type="button" data-question-id="${q.id}" data-aw-action="add-option"
                    class="text-[10.5px] font-black text-teal-600 hover:text-slate-800 mt-1"><i class="fa-solid fa-plus mr-1"></i>Add option</button>
                <p class="text-[9.5px] text-slate-400 italic m-0 pt-0.5">Select the circle next to the correct option — required before this can be saved.</p>
            </div>`;
    }

    if (q.type === 'free_response' || q.type === 'short_answer' || q.type === 'math') {
        const label = q.type === 'math' ? 'Formula / LaTeX guidance for students (optional)' : 'Guidance shown to students — e.g. expected length (optional)';
        return `
            <div class="mb-3">
                <input type="text" value="${escHtml(q.hint || '')}" placeholder="${label}"
                    data-question-id="${q.id}" data-field="hint" data-aw-input="question-field"
                    class="form-input w-full p-2 bg-white border border-slate-200 rounded-lg text-[12px] text-slate-800 focus:border-teal-400 focus:ring-0 transition outline-none">
            </div>`;
    }

    if (q.type === 'attachment_response') {
        const opts = ['File Upload', 'Camera Photo', 'Drawing Canvas']
            .map(o => `<option value="${o}" ${o === q.responseType ? 'selected' : ''}>${o}</option>`).join('');
        return `
            <div class="mb-3">
                <label class="block text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">Required student output</label>
                <select data-question-id="${q.id}" data-field="responseType" data-aw-change="question-field"
                    class="form-select w-full sm:w-64 p-2 bg-white border border-slate-200 rounded-lg text-[12px] text-slate-800 pr-8 focus:border-teal-400 focus:ring-0 transition outline-none appearance-none">
                    ${opts}
                </select>
            </div>`;
    }
    return '';
}

// ── Shared attachment block — task-level ('task') or per-question ('question') ──
function awRenderAttachmentBlock(attachments, questionId, scope) {
    const qAttr = questionId ? `data-question-id="${questionId}"` : '';
    const rows = (attachments || []).map((a, i) => `
        <div class="flex items-center gap-2 text-[12px]">
            <i class="fa-solid fa-paperclip text-slate-400 text-[11px]"></i>
            <a href="${escHtml(a.url)}" target="_blank" rel="noopener" class="flex-1 truncate text-slate-800 font-semibold hover:underline">${escHtml(a.name || a.url)}</a>
            <button type="button" ${qAttr} data-attachment-index="${i}" data-aw-scope="${scope}" data-aw-action="remove-attachment"
                class="w-6 h-6 flex-shrink-0 flex items-center justify-center text-slate-400 hover:text-red-500 rounded-lg transition">
                <i class="fa-solid fa-xmark text-[11px]"></i>
            </button>
        </div>`).join('');

    return `
        <div class="border-t border-slate-100 pt-3">
            <label class="block text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1.5">
                ${scope === 'task' ? 'Teacher media attachments' : 'Attach media to this question'}
            </label>
            <div class="space-y-1.5 mb-2">${rows}</div>
            <div class="flex items-center gap-1.5">
                <input type="url" placeholder="Paste a link (PDF/image/video)…" data-aw-scope="${scope}" ${qAttr}
                    data-aw-field="attachment-url-input"
                    class="form-input flex-1 p-1.5 bg-white border border-slate-200 rounded-lg text-[11.5px] text-slate-800 focus:border-teal-400 focus:ring-0 transition outline-none">
                <button type="button" data-aw-scope="${scope}" ${qAttr} data-aw-action="add-attachment"
                    class="text-[10.5px] font-black text-teal-600 hover:text-slate-800 px-2 py-1.5 whitespace-nowrap">
                    <i class="fa-solid fa-plus mr-1"></i>Add link
                </button>
                <button type="button" data-aw-scope="${scope}" ${qAttr} data-aw-action="trigger-upload"
                    class="text-[10.5px] font-black text-slate-700 bg-white hover:bg-slate-100 border border-slate-200 px-2.5 py-1.5 rounded-lg whitespace-nowrap transition">
                    <i class="fa-solid fa-upload mr-1"></i>Upload File
                </button>
            </div>
        </div>`;
}

function awRerenderAll() {
    awRenderTaskAttachments();
    awRenderBuilder();
}

// ── Event delegation: two containers (task attachments + questions builder)
// share the same action vocabulary, so one pair of listeners on their common
// parent (#awBuilderRoot) handles both — distinguished by data-aw-scope. ──
function initAddWorkBuilderEvents() {
    const root = document.getElementById('awBuilderRoot');
    if (!root) return;

    root.addEventListener('input', (e) => {
        const t = e.target;
        if (t.dataset.awInput === 'question-field') {
            const q = awFindQuestion(t.dataset.questionId);
            if (!q) return;
            q[t.dataset.field] = t.dataset.field === 'points' ? (parseFloat(t.value) || 0) : t.value;
        } else if (t.dataset.awInput === 'option-text') {
            const q = awFindQuestion(t.dataset.questionId);
            if (!q || !q.options) return;
            q.options[Number(t.dataset.optionIndex)] = t.value;
        }
    });

    root.addEventListener('change', (e) => {
        const t = e.target;
        if (t.dataset.awChange === 'question-type') {
            const q = awFindQuestion(t.dataset.questionId);
            if (!q) return;
            awResetQuestionTypeFields(q, t.value);
            awRenderBuilder();
        } else if (t.dataset.awChange === 'question-field') {
            const q = awFindQuestion(t.dataset.questionId);
            if (q) q[t.dataset.field] = t.value;
        }
    });

    root.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-aw-action]');
        if (!btn || btn.disabled) return;
        const action = btn.dataset.awAction;
        const qId = btn.dataset.questionId;

        if (action === 'trigger-upload') {
            awFileUploadTarget = { scope: btn.dataset.awScope, questionId: qId || null };
            document.getElementById('awFileInput')?.click();
            return; // no state changed yet — nothing to re-render
        } else if (action === 'add-question') {
            awQuestions.push(awMakeQuestion('multiple_choice'));
        } else if (action === 'delete-question') {
            awQuestions = awQuestions.filter(q => q.id !== qId);
        } else if (action === 'move-up' || action === 'move-down') {
            const i = awQuestions.findIndex(q => q.id === qId);
            const j = action === 'move-up' ? i - 1 : i + 1;
            if (i < 0 || j < 0 || j >= awQuestions.length) return;
            [awQuestions[i], awQuestions[j]] = [awQuestions[j], awQuestions[i]];
        } else if (action === 'add-option') {
            const q = awFindQuestion(qId);
            if (q?.options) q.options.push('');
        } else if (action === 'remove-option') {
            const q = awFindQuestion(qId);
            if (q?.options && q.options.length > 2) {
                const idx = Number(btn.dataset.optionIndex);
                q.options.splice(idx, 1);
                if (q.correctOptionIndex === idx) q.correctOptionIndex = null;
                else if (typeof q.correctOptionIndex === 'number' && q.correctOptionIndex > idx) q.correctOptionIndex -= 1;
            }
        } else if (action === 'set-correct') {
            const q = awFindQuestion(qId);
            if (q) q.correctOptionIndex = Number(btn.dataset.optionIndex);
        } else if (action === 'add-attachment') {
            const scope = btn.dataset.awScope;
            const input = root.querySelector(
                scope === 'task'
                    ? `input[data-aw-field="attachment-url-input"][data-aw-scope="task"]`
                    : `input[data-aw-field="attachment-url-input"][data-question-id="${qId}"]`
            );
            const url = (input?.value || '').trim();
            if (!url) return;
            let name;
            try { name = new URL(url).pathname.split('/').filter(Boolean).pop() || url; } catch { name = url; }
            const entry = { id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, name, url };
            if (scope === 'task') {
                awTaskAttachments.push(entry);
            } else {
                const q = awFindQuestion(qId);
                if (q) (q.attachments = q.attachments || []).push(entry);
            }
        } else if (action === 'remove-attachment') {
            const scope = btn.dataset.awScope;
            const idx = Number(btn.dataset.attachmentIndex);
            if (scope === 'task') {
                awTaskAttachments.splice(idx, 1);
            } else {
                const q = awFindQuestion(qId);
                if (q?.attachments) q.attachments.splice(idx, 1);
            }
        } else {
            return; // unrecognized action — don't re-render for nothing
        }
        awRerenderAll();
    });

    document.getElementById('awFileInput')?.addEventListener('change', awHandleFileSelected);
}
initAddWorkBuilderEvents();
initPdfEvents();

function sanitizeAttachmentFileName(name) {
    return String(name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);
}

// ── Real Storage upload (Phase 2.2) — mirrors uploadSubmissionAttachment's
// pattern in submissions.js: upload immediately on selection, return
// {id, name, url}, land it in whichever attachment array the teacher clicked
// "Upload File" from. Path uses resolvePostContext() rather than raw
// sub.classId, matching how the legacy auto-grade shadow doc already
// resolves a class for a legacy subject — a subject with no resolvable
// class can't accept an upload either, and this surfaces that clearly
// instead of writing to a broken path. ──
async function uploadWorkAttachment(file) {
    const sub = getSubjectByName(currentSubjectName);
    if (!sub) throw new Error('Subject not found. Please refresh.');
    const ctx = resolvePostContext(sub, resolvedClasses);
    if (!ctx) throw new Error('Could not resolve a class for this subject, so files can\'t be uploaded yet.');
    const path = `schools/${session.schoolId}/attachments/${ctx.classId}/${ctx.subjectId}/${awCurrentAssignmentId}/${Date.now()}_${sanitizeAttachmentFileName(file.name)}`;
    const fileRef = storageRef(storage, path);
    await uploadBytes(fileRef, file);
    const url = await getDownloadURL(fileRef);
    return { id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, name: file.name, url };
}

async function awHandleFileSelected(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // allow re-selecting the same file later
    if (!file || !awFileUploadTarget) return;
    if (file.size > AW_MAX_ATTACHMENT_BYTES) {
        awShowError(`"${file.name}" is larger than 25MB and can't be uploaded.`);
        awFileUploadTarget = null;
        return;
    }

    const { scope, questionId } = awFileUploadTarget;
    awFileUploadTarget = null;
    const btnSelector = scope === 'task'
        ? `button[data-aw-action="trigger-upload"][data-aw-scope="task"]`
        : `button[data-aw-action="trigger-upload"][data-question-id="${questionId}"]`;
    const btn = document.querySelector(btnSelector);
    const originalHtml = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; }

    try {
        const entry = await uploadWorkAttachment(file);
        if (scope === 'task') {
            awTaskAttachments.push(entry);
        } else {
            const q = awFindQuestion(questionId);
            if (q) (q.attachments = q.attachments || []).push(entry);
        }
        awRerenderAll();
    } catch (err) {
        console.error('[Add Work] File upload failed:', err);
        awShowError('Could not upload that file. Please try again.');
        if (btn) { btn.disabled = false; btn.innerHTML = originalHtml; }
    }
}

function awClearBanners() {
    document.getElementById('awErrorBanner')?.classList.add('hidden');
    document.getElementById('awSavedBanner')?.classList.add('hidden');
}
function awShowError(message) {
    document.getElementById('awSavedBanner')?.classList.add('hidden');
    const text = document.getElementById('awErrorBannerText');
    if (text) text.textContent = message;
    document.getElementById('awErrorBanner')?.classList.remove('hidden');
}
function awShowSaved(message) {
    document.getElementById('awErrorBanner')?.classList.add('hidden');
    const text = document.getElementById('awSavedBannerText');
    if (text) text.textContent = message;
    document.getElementById('awSavedBanner')?.classList.remove('hidden');
}

// Pure function — no DOM writes — so it stays unit-testable the same way
// the original engine's render/validate functions were.
function awValidate({ title, type, maxScore, existingList, editingId }) {
    const errors = [];
    if (!title) errors.push('Title is required.');
    if (!type) errors.push('Type is required.');
    if (isNaN(maxScore) || maxScore < 1) errors.push('Points possible must be a whole number of at least 1.');
    if (existingList.some(a => a.id !== editingId && (a.title || '').toLowerCase() === title.toLowerCase())) {
        errors.push('An assignment with that title already exists for this subject.');
    }

    awQuestions.forEach((q, i) => {
        const n = i + 1;
        if (!(q.prompt || '').trim()) errors.push(`Question ${n}: a prompt is required.`);
        if (q.type === 'multiple_choice') {
            const filled = (q.options || []).filter(o => (o || '').trim() !== '');
            if (filled.length < 2) errors.push(`Question ${n}: at least 2 non-empty options are required.`);
            const ci = q.correctOptionIndex;
            const hasMark = typeof ci === 'number' && q.options && (q.options[ci] || '').trim() !== '';
            if (!hasMark) errors.push(`Question ${n}: select which option is correct.`);
        }
    });
    return errors;
}

// Strips correctOptionIndex out of each question (into the returned
// answerKeys map) and maps attachment_response's responseType into the
// studentResponse shape the backend expects. Nothing here mutates
// awQuestions — the modal's own state stays exactly as the teacher left it
// if the save fails and they need to retry.
function awBuildCleanQuestions() {
    const answerKeys = {};
    const requiresMap = { 'File Upload': 'file', 'Camera Photo': 'photo', 'Drawing Canvas': 'drawing' };

    const questions = awQuestions.map(q => {
        const clean = {
            id: q.id,
            type: q.type,
            prompt: q.prompt || '',
            points: q.points ?? 0,
            attachments: q.attachments || []
        };
        if (q.type === 'multiple_choice') {
            clean.options = [...(q.options || [])];
            if (typeof q.correctOptionIndex === 'number') answerKeys[q.id] = q.correctOptionIndex;
        } else if (q.type === 'free_response' || q.type === 'short_answer' || q.type === 'math') {
            clean.hint = q.hint || '';
        } else if (q.type === 'attachment_response') {
            clean.responseType = q.responseType || 'File Upload';
            clean.studentResponse = { requires: requiresMap[clean.responseType] || 'file' };
        }
        return clean;
    });

    return { questions, answerKeys };
}

window.awSaveWork = async function() {
    awClearBanners();

    const sub = getSubjectByName(currentSubjectName);
    if (!sub) { awShowError('Could not resolve the selected subject.'); return; }

    const title        = document.getElementById('awTitle')?.value.trim() || '';
    const type          = document.getElementById('awType')?.value || '';
    const date          = dueDateInputToIso(document.getElementById('awDueDate')?.value || '');
    const maxScore      = parseInt(document.getElementById('awPoints')?.value, 10);
    const instructions  = document.getElementById('awInstructions')?.value.trim() || '';
    const description   = document.getElementById('awDescription')?.value.trim() || '';
    const locked        = !!document.getElementById('awLocked')?.checked;
    const theme         = normalizeTheme(document.getElementById('awTheme')?.value);
    const timeLimitRaw  = parseInt(document.getElementById('awTimeLimit')?.value, 10);
    const timeLimitMin  = timeLimitRaw > 0 ? Math.min(600, timeLimitRaw) : null;
    const showWork      = !!document.getElementById('awShowWork')?.checked;
    const pdfWorksheet  = awPdf ? { url: awPdf.url, name: awPdf.name || '', pageCount: awPdf.pageCount || 0, fields: validatePdfFields(awPdf.fields || [], awPdf.pageCount || 0) } : null;

    const editingId = awEditingAssignmentId;
    const existingList = getAssignmentsForSubject(currentSubjectName);
    const currentRecord = editingId ? existingList.find(a => a.id === editingId) : null;

    const errors = awValidate({ title, type, maxScore, existingList, editingId });
    if (errors.length) {
        awShowError(errors[0] + (errors.length > 1 ? ` (+${errors.length - 1} more issue${errors.length > 2 ? 's' : ''})` : ''));
        return;
    }

    const { questions: cleanQuestions, answerKeys } = awBuildCleanQuestions();
    const isAssessment = cleanQuestions.length > 0;
    const category = isAssessment ? 'assessment' : 'standard';

    const assignmentId = awCurrentAssignmentId || editingId || genAssignmentId();
    const nowIso = new Date().toISOString();
    const wasLocked = !!(currentRecord?.locked);

    const assignmentData = {
        id: assignmentId,
        title, type,
        maxScore,
        date,
        instructions,
        description,
        locked,
        lockedAt: locked ? (wasLocked ? (currentRecord?.lockedAt || nowIso) : nowIso) : null,
        completed: currentRecord?.completed ?? false,
        attachments: [...awTaskAttachments],
        theme, timeLimitMin, showWork, pdfWorksheet,
        category,
        questions: cleanQuestions,
        teacherId: session.teacherId,
        createdAt: currentRecord?.createdAt || nowIso,
        updatedAt: nowIso
    };

    const hasAnswerKeys = Object.keys(answerKeys).length > 0;
    const answerKeyData = hasAnswerKeys ? {
        assignmentId, schoolId: session.schoolId, keys: answerKeys, createdAt: serverTimestamp()
    } : null;

    const saveBtn = document.getElementById('awSaveBtn');
    const originalHtml = saveBtn ? saveBtn.innerHTML : '';
    if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…'; }

    try {
        const batch = writeBatch(db);
        let updatedSubjects = null;
        const nextAssignments = editingId
            ? existingList.map(a => a.id === editingId ? assignmentData : a)
            : [...existingList, assignmentData];

        if (sub._source === 'new') {
            const assignmentRef = doc(db, 'schools', session.schoolId, 'classes', sub.classId, 'subjects', sub.id, 'assignments', assignmentId);
            batch.set(assignmentRef, assignmentData);
        } else {
            updatedSubjects = (session.teacherData.subjects || []).map(s => {
                if (s.id !== sub.id) return s;
                return { ...s, assignments: nextAssignments };
            });

            // Guard the Firestore 1MB document ceiling — this doc holds EVERY
            // legacy subject's assignments, not just this one, so a rich Add
            // Work payload (question text, attachment links) can push it over
            // the limit in a way a plain grade record never could.
            const approxBytes = new Blob([JSON.stringify(updatedSubjects)]).size;
            if (approxBytes > 900000) {
                throw new Error("This subject's legacy record is too large to hold another rich assignment (Firestore's 1MB document limit). It needs migrating to the new class/subject model before adding more work here.");
            }

            batch.update(getTeacherDocRef(session.schoolId, session.teacherId), { subjects: updatedSubjects });

            // A legacy subject has no real classes/{classId}/subjects/
            // {subjectId} document of its own, so the embedded copy above is
            // otherwise the ONLY place this assignment's questions/points
            // would exist. autoGradeWorkSubmission (functions/index.js) grades
            // server-side by reading the assignment doc at the exact real
            // subcollection path every submission is written under — a path
            // Firestore lets exist even with no real parent `subjects/
            // {subjectId}` document. Without this second write, that read
            // would always come back "not found" and MC auto-grading would
            // silently never fire for any legacy-subject assessment.
            if (isAssessment) {
                const shadowCtx = resolvePostContext(sub, resolvedClasses);
                if (shadowCtx) {
                    const shadowRef = doc(db, 'schools', session.schoolId, 'classes', shadowCtx.classId, 'subjects', shadowCtx.subjectId, 'assignments', assignmentId);
                    batch.set(shadowRef, { ...assignmentData, _legacyShadow: true });
                } else {
                    console.error(`[Add Work] Could not resolve a class for subject "${sub.name}" — skipping the legacy auto-grade shadow doc for assignment ${assignmentId}.`);
                }
            }
        }

        if (answerKeyData) {
            // create the first time an assessment is saved, update from then
            // on (e.g. correcting a mis-marked answer on edit) — firestore.rules'
            // work_answer_keys now allows both under identical conditions.
            batch.set(doc(db, 'work_answer_keys', assignmentId), answerKeyData);
        }

        await batch.commit();

        if (sub._source === 'new') {
            sub.assignments = nextAssignments;
        } else if (updatedSubjects) {
            session.teacherData.subjects = updatedSubjects;
            setSessionData('teacher', session);
            sub.assignments = updatedSubjects.find(s => s.id === sub.id)?.assignments || [];
        }

        awShowSaved(editingId ? 'Changes saved.' : `Added to ${currentSubjectName}.`);
        updateAssignmentTabBadge();
        awDirty = false;
        setTimeout(() => { window.closeAddWorkModal({ saved: true }); renderAssignmentsTab(); }, 700);
    } catch (err) {
        console.error('[Add Work] awSaveWork failed:', err);
        awShowError(err?.message || 'Could not save. Please try again.');
    } finally {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = originalHtml; }
    }
};

export { formatDueDate };
