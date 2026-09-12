// ── PHASE 3: TEACHER GRADING UI ───────────────────────────────────────────
// Lets a teacher review free-response answers for one exam and record a
// grade for each pending question via the recordManualGrade callable
// (functions/index.js) — the ONLY write path for grading, per this
// project's Phase 3 security design (firestore.rules' exam_submissions
// `allow update` rule gives a teacher's client zero direct write access;
// see that rule's own comment). This page has no fallback direct-write
// path and does not attempt one — a rejected recordManualGrade call is
// surfaced as an error, never silently retried against Firestore directly.
//
// Reads two things per submission:
//   1. The submission doc itself (collection-group query, same required
//      denormalized-field pattern as teacher/exams/live.js — schoolId,
//      isSchoolActive, examId — see that file's own extensive comment on
//      why dropping any of those three makes Firestore reject the whole
//      query outright, not just filter results).
//   2. The exam config (schools/.../exams/{examId}) — for each question's
//      prompt/points/type, since the submission doc only stores the
//      student's ANSWERS and the grading-state fields, not the question
//      text itself.
// The answer KEY (exam_answer_keys/{examId}) is never read here — it's
// `allow read, write: if false` for every client (see that collection's own
// rule comment) and is irrelevant to manual grading anyway: only
// autoGradeObjectiveAnswers (Admin SDK) ever needs it, for multiple_choice
// questions, which this page never grades.

import { db, functions } from '../../assets/js/firebase-init.js';
import { requireAuth } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import {
    collectionGroup, query, where, onSnapshot, doc, getDoc
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ── 1. AUTH & LAYOUT ──────────────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    injectTeacherLayout('exams', 'Grade Exam', 'Review free-response answers and record grades', false);
}

const recordManualGrade = httpsCallable(functions, 'recordManualGrade');

// ── 2. EXAM CONTEXT (hash fragment, not query string — see live.js's own
//      comment for why: this project's local dev server strips the query
//      string and .html extension from every page on load) ───────────────
const params = new URLSearchParams(window.location.hash.substring(1));
const examContext = {
    classId:   params.get('classId')   || '',
    subjectId: params.get('subjectId') || '',
    examId:    params.get('examId')    || '',
};

// ── 3. STATE ──────────────────────────────────────────────────────────────
const submissionByStudent = new Map(); // studentId -> raw submission data + examSubmissionId
let examConfig = null;                 // exams/{examId} doc — questions[] (id, type, prompt, points)
let questionsById = new Map();         // questionId -> question object, for O(1) lookup while rendering
let selectedStudentId = null;
let unsubFirestore = null;

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

// ── 4. INITIALIZATION ────────────────────────────────────────────────────
async function init() {
    if (!session) return;

    cacheEls();

    if (!examContext.classId || !examContext.subjectId || !examContext.examId) {
        showFatalError('This grading link is missing information and can’t be opened. Please use the link generated for this exam.');
        return;
    }

    try {
        const examRef = doc(db, 'schools', session.schoolId, 'classes', examContext.classId,
            'subjects', examContext.subjectId, 'exams', examContext.examId);
        const examSnap = await getDoc(examRef);

        if (!examSnap.exists()) {
            showFatalError('This exam could not be found.');
            return;
        }
        examConfig = examSnap.data();
        questionsById = new Map((examConfig.questions || []).map(q => [q.id, q]));
    } catch (e) {
        console.error('[Grade Exam] Failed to load exam config:', e);
        showFatalError('Could not load this exam\'s configuration. Please try again.');
        return;
    }

    registerFirestoreListener();

    els.dashLoader.classList.add('hidden');
    els.dashBody.classList.remove('hidden');
}

function cacheEls() {
    ['dashLoader', 'dashBody', 'dashFatalState', 'dashFatalMsg',
     'rosterList', 'rosterEmpty', 'countSubmitted', 'countPending', 'countGraded', 'countTotal',
     'detailEmpty', 'detailContent', 'detailStudentId', 'detailStudentMeta', 'detailQuestionList',
    ].forEach(id => { els[id] = document.getElementById(id); });
}

function showFatalError(message) {
    if (els.dashLoader) els.dashLoader.classList.add('hidden');
    if (els.dashFatalMsg) els.dashFatalMsg.textContent = message;
    if (els.dashFatalState) els.dashFatalState.classList.remove('hidden');
}

// ── 5. FIRESTORE LISTENER ─────────────────────────────────────────────────
// Same required denormalized-field query shape as teacher/exams/live.js —
// schoolId, isSchoolActive, and examId are not optional set-dressing here
// either; see that file's own extensive comment (search "COLLECTION-GROUP
// RULE" in firestore.rules for the enforcement side) for the full
// explanation of why Firestore rejects this ENTIRE query outright if any
// one of these three where() clauses is missing, rather than silently
// returning fewer results.
//
// Only terminal (non in_progress) submissions are relevant to grading —
// filtering isn't done here via an extra where('status','in',[...]) clause
// because Firestore only allows one array/inequality-style operator per
// query in some combinations and this keeps the query identical in shape to
// live.js's proven-working one; in_progress rows are simply skipped at
// render time instead (see buildRosterRows()).
function registerFirestoreListener() {
    const q = query(
        collectionGroup(db, 'exam_submissions'),
        where('schoolId', '==', session.schoolId),
        where('isSchoolActive', '==', true),
        where('examId', '==', examContext.examId)
    );

    unsubFirestore = onSnapshot(q, (snap) => {
        snap.docChanges().forEach(change => {
            const data = change.doc.data();
            const studentId = data.studentId;
            if (!studentId) return; // defensive: every real submission carries this, but never trust blindly

            if (change.type === 'removed') {
                submissionByStudent.delete(studentId);
                return;
            }
            submissionByStudent.set(studentId, {
                examSubmissionId: change.doc.id,
                studentId,
                status: data.status,
                score: data.score,
                pendingManualPoints: data.pendingManualPoints,
                pendingManualQuestionIds: Array.isArray(data.pendingManualQuestionIds) ? data.pendingManualQuestionIds : [],
                manualGrades: data.manualGrades || {},
                answers: data.answers || {},
            });
        });
        render();
    }, (error) => {
        console.error('[Grade Exam] Firestore listener error:', error);
        showFatalError('Could not load submissions for this exam. Check the console for details.');
    });
}

// ── 6. RENDER — ROSTER ────────────────────────────────────────────────────
const TERMINAL_STATUSES = ['submitted', 'auto_submitted_timeout', 'auto_submitted_disconnect_grace_expired', 'graded'];

function buildRosterRows() {
    return Array.from(submissionByStudent.values())
        .filter(sub => TERMINAL_STATUSES.includes(sub.status)) // a student still in_progress has nothing gradable yet
        .sort((a, b) => a.studentId.localeCompare(b.studentId));
}

function render() {
    const rows = buildRosterRows();

    if (!rows.length) {
        els.rosterList.innerHTML = '';
        els.rosterEmpty.classList.remove('hidden');
        updateCounts([]);
        renderDetail(); // selectedStudentId may no longer exist (e.g. listener update removed it) — re-render clears it safely
        return;
    }
    els.rosterEmpty.classList.add('hidden');

    els.rosterList.innerHTML = rows.map(renderRosterRow).join('');
    updateCounts(rows);

    // Re-attach click handlers after innerHTML replacement — event
    // delegation on the container would also work, but this mirrors the
    // simple, direct style already used elsewhere in this codebase
    // (student/exams/take.js's wireQuestionInput()) rather than introducing
    // a different pattern for one page.
    els.rosterList.querySelectorAll('[data-student-id]').forEach(rowEl => {
        rowEl.addEventListener('click', () => {
            selectedStudentId = rowEl.dataset.studentId;
            render();
        });
    });

    renderDetail();
}

function renderRosterRow(sub) {
    const pendingCount = sub.pendingManualQuestionIds.length;
    const isFullyGraded = sub.status === 'graded';
    const badgeClass = pendingCount === 0 ? 'pending-badge is-clear' : 'pending-badge';
    const badgeText = pendingCount === 0 ? 'None' : `${pendingCount} pending`;
    const isSelected = sub.studentId === selectedStudentId;

    const statusMeta = isFullyGraded
        ? { label: 'Graded', classes: 'bg-indigo-50 text-indigo-700 border-indigo-200' }
        : { label: 'Submitted', classes: 'bg-teal-50 text-teal-700 border-teal-200' };

    return `
    <div class="roster-row${isSelected ? ' is-selected' : ''}" data-student-id="${escHtml(sub.studentId)}">
        <div><p class="roster-row-id">${escHtml(sub.studentId)}</p></div>
        <div class="roster-row-score">${sub.score ?? 0} pt${sub.score === 1 ? '' : 's'}</div>
        <div><span class="status-pill ${statusMeta.classes}">${statusMeta.label}</span></div>
        <div><span class="${badgeClass}">${badgeText}</span></div>
    </div>`;
}

function updateCounts(rows) {
    const submitted = rows.length;
    const pending = rows.filter(r => r.pendingManualQuestionIds.length > 0).length;
    const graded = rows.filter(r => r.status === 'graded').length;

    if (els.countSubmitted) els.countSubmitted.textContent = submitted;
    if (els.countPending)   els.countPending.textContent   = pending;
    if (els.countGraded)    els.countGraded.textContent    = graded;
    if (els.countTotal)     els.countTotal.textContent     = submissionByStudent.size;
}

// ── 7. RENDER — DETAIL / GRADING PANEL ────────────────────────────────────
function renderDetail() {
    const sub = selectedStudentId ? submissionByStudent.get(selectedStudentId) : null;

    if (!sub) {
        selectedStudentId = null;
        els.detailContent.classList.add('hidden');
        els.detailEmpty.classList.remove('hidden');
        return;
    }

    els.detailEmpty.classList.add('hidden');
    els.detailContent.classList.remove('hidden');

    els.detailStudentId.textContent = sub.studentId;
    els.detailStudentMeta.textContent = `Score so far: ${sub.score ?? 0} pt${sub.score === 1 ? '' : 's'}${sub.pendingManualQuestionIds.length ? ` · ${sub.pendingManualQuestionIds.length} question(s) awaiting grading` : ' · Fully graded'}`;

    // Only free_response questions are ever relevant here — multiple_choice
    // questions are graded automatically by autoGradeObjectiveAnswers
    // (functions/index.js) the moment the exam is submitted, and this page
    // has no reason to show a question the teacher can never act on. A
    // question is included below if it EITHER still needs grading OR has
    // already been graded (so the teacher can see what they previously
    // awarded) — the only thing excluded is a multiple_choice question,
    // which never appears in pendingManualQuestionIds/manualGrades at all.
    const relevantQuestionIds = new Set([
        ...sub.pendingManualQuestionIds,
        ...Object.keys(sub.manualGrades),
    ]);

    const questionCards = Array.from(relevantQuestionIds)
        .map(qId => questionsById.get(qId))
        .filter(Boolean) // a stale/removed question ID in old data shouldn't crash rendering
        .map(question => renderQuestionCard(question, sub))
        .join('');

    els.detailQuestionList.innerHTML = questionCards || '<p class="text-sm text-slate-400 font-semibold text-center py-8">No free-response questions for this exam.</p>';

    wireGradeInputs(sub);
}

function renderQuestionCard(question, sub) {
    const answer = sub.answers?.[question.id]?.value || '';
    const existingGrade = sub.manualGrades?.[question.id];
    const isPending = sub.pendingManualQuestionIds.includes(question.id);
    const maxPoints = Number(question.points) || 0;

    if (!isPending && existingGrade) {
        // Already graded — show what was recorded, no editable inputs. A
        // teacher who wants to change a grade after the fact is out of
        // scope here: recordManualGrade's own double-grading guard rejects
        // a second call for an already-graded question by design (see that
        // function's own comment on why), so this page does not offer an
        // input that would only fail server-side.
        return `
        <div class="question-card is-graded">
            <p class="question-prompt">${escHtml(question.prompt)} <span class="text-xs font-bold text-slate-400">(${maxPoints} pt${maxPoints === 1 ? '' : 's'} max)</span></p>
            <div class="student-answer-box">${escHtml(answer) || '<em class="text-slate-400">No answer submitted.</em>'}</div>
            <div class="already-graded-summary">
                <i class="fa-solid fa-circle-check"></i> Graded: ${existingGrade.pointsAwarded} / ${maxPoints} pt${maxPoints === 1 ? '' : 's'}
                ${existingGrade.feedback ? `— "${escHtml(existingGrade.feedback)}"` : ''}
            </div>
        </div>`;
    }

    return `
    <div class="question-card" data-question-id="${escHtml(question.id)}" data-max-points="${maxPoints}">
        <p class="question-prompt">${escHtml(question.prompt)} <span class="text-xs font-bold text-slate-400">(${maxPoints} pt${maxPoints === 1 ? '' : 's'} max)</span></p>
        <div class="student-answer-box">${escHtml(answer) || '<em class="text-slate-400">No answer submitted.</em>'}</div>

        <div class="flex items-center gap-3 mb-2">
            <label class="text-xs font-bold text-slate-500" for="points_${escHtml(question.id)}">Points</label>
            <input type="number" id="points_${escHtml(question.id)}" class="grade-points-input form-input"
                style="width:90px;" min="0" max="${maxPoints}" step="1" placeholder="0-${maxPoints}">
        </div>
        <textarea id="feedback_${escHtml(question.id)}" class="grade-feedback-input form-input w-full p-2.5 text-sm"
            style="height:5rem; resize:none;" placeholder="Feedback (optional)"></textarea>

        <button class="grade-save-btn mt-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-black text-xs px-4 py-2 rounded-lg transition">
            <i class="fa-solid fa-floppy-disk"></i> Save Grade
        </button>
        <p class="grade-save-msg" id="gradeMsg_${escHtml(question.id)}"></p>
    </div>`;
}

function wireGradeInputs(sub) {
    els.detailQuestionList.querySelectorAll('.question-card[data-question-id]').forEach(card => {
        const questionId = card.dataset.questionId;
        const maxPoints = Number(card.dataset.maxPoints) || 0;
        const saveBtn = card.querySelector('.grade-save-btn');
        if (!saveBtn) return;

        saveBtn.addEventListener('click', () => handleSaveGrade(sub, questionId, maxPoints, card));
    });
}

async function handleSaveGrade(sub, questionId, maxPoints, card) {
    const pointsInput = card.querySelector('.grade-points-input');
    const feedbackInput = card.querySelector('.grade-feedback-input');
    const saveBtn = card.querySelector('.grade-save-btn');
    const msgEl = card.querySelector('.grade-save-msg');

    const rawPoints = pointsInput.value.trim();
    const pointsAwarded = Number(rawPoints);

    // ── Client-side validation mirrors recordManualGrade's own bounds
    //    check (functions/index.js: 0 <= pointsAwarded <= maxPoints) so a
    //    teacher gets immediate feedback instead of waiting on a round trip
    //    for an error the UI could have caught first. This is a UX
    //    convenience only — the callable re-validates independently and is
    //    the actual enforcement; this check being here does not relax that
    //    in any way. ─────────────────────────────────────────────────────
    if (rawPoints === '' || !Number.isFinite(pointsAwarded)) {
        showGradeMsg(msgEl, 'Enter a point value.', true);
        return;
    }
    if (pointsAwarded < 0 || pointsAwarded > maxPoints) {
        showGradeMsg(msgEl, `Points must be between 0 and ${maxPoints}.`, true);
        return;
    }

    const feedback = feedbackInput.value.trim();

    saveBtn.disabled = true;
    const prevBtnHtml = saveBtn.innerHTML;
    saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';
    showGradeMsg(msgEl, '', false);

    try {
        await recordManualGrade({
            studentId: sub.studentId,
            examSubmissionId: sub.examSubmissionId,
            questionId,
            pointsAwarded,
            feedback: feedback || null,
        });
        // No need to manually update local state or re-render here — the
        // onSnapshot listener registered in registerFirestoreListener()
        // will receive the server's own write (manualGrades,
        // pendingManualQuestionIds, score, and possibly status all changing
        // together) and call render(), which rebuilds this exact card from
        // fresh data. Mutating local state here too would risk a
        // double-render race with that listener's own update.
        showGradeMsg(msgEl, 'Saved.', false, true);
    } catch (e) {
        console.error(`[Grade Exam] recordManualGrade failed for ${sub.studentId}/${questionId}:`, e);
        const message = e?.code === 'functions/failed-precondition'
            ? (e.message || 'This question may have already been graded.')
            : e?.code === 'functions/permission-denied'
                ? 'You do not have permission to grade this submission.'
                : 'Could not save this grade. Please try again.';
        showGradeMsg(msgEl, message, true);
        saveBtn.disabled = false;
        saveBtn.innerHTML = prevBtnHtml;
    }
}

function showGradeMsg(el, text, isError, isSuccess = false) {
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('is-error', !!isError);
    el.classList.toggle('is-success', !!isSuccess);
}

// ── 8. CLEANUP ────────────────────────────────────────────────────────────
window.addEventListener('pagehide', () => {
    if (unsubFirestore) { unsubFirestore(); unsubFirestore = null; }
});

init();
