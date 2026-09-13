// ── PHASE 1 MILESTONE 4: STUDENT ASSIGNMENT VIEW & SUBMISSIONS ────────────
import { getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectStudentLayout } from '../../assets/js/layout-student.js';
import { loadTeacherSubjectsCache, getTeacherDocRef, openOverlay, closeOverlay, showMsg, loadSchoolHeaderInfo } from '../../assets/js/utils.js';
import {
    loadAssignmentsForSubjects,
    loadSubmissionsForAssignments,
    loadGradesIndexForStudent,
    saveSubmission,
    isSubmissionFrozen
} from '../../assets/js/submissions.js';

// ── 1. AUTHENTICATION & LAYOUT ──────────────────────────────────────────────
const session = requireAuth('student', '../login.html');
if (session) {
    injectStudentLayout('assignments', 'Assignments', 'Everything your teacher has assigned');
}

// ── 2. STATE ──────────────────────────────────────────────────────────────
let assignmentsCache = [];      // merged legacy + new-model, from loadAssignmentsForSubjects
let submissionsById = new Map(); // assignmentId -> submission | null
let gradesById = new Map();      // assignmentId -> grade record | null
let currentSubjectFilter = '';   // '' = All Subjects, else a subjectId
let currentAssignmentId = null;  // assignment currently shown in the detail panel

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
        // Date-only strings (YYYY-MM-DD, used for the due date) must be parsed
        // as local calendar components — new Date('YYYY-MM-DD') parses as UTC
        // midnight, which renders a day early in any timezone behind UTC.
        const d = /^\d{4}-\d{2}-\d{2}$/.test(iso)
            ? new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)))
            : new Date(iso);
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (e) { return iso; }
}

// ── 3. INITIALIZATION ───────────────────────────────────────────────────────
async function init() {
    if (!session) return;

    cacheEls();
    wireEvents();

    // The sidebar/topbar ship with static "Loading..." placeholders for the
    // school name and active period — injectStudentLayout() only has the
    // student's own cached session data to render immediately, so the
    // school name (and semester name) need their own fetch, exactly like
    // every other student page already does. Fire-and-forget: it paints the
    // header whenever it resolves, independent of the assignments fetch
    // below, so a slow/failed school lookup never blocks the actual page.
    loadSchoolHeaderInfo(session.schoolId).then(({ schoolName, semesterName }) => {
        const schoolEl = document.getElementById('displaySchoolName');
        const semEl = document.getElementById('activeSemesterDisplay');
        if (schoolEl) schoolEl.textContent = schoolName;
        if (semEl) semEl.textContent = semesterName;
    });

    const teacherId = session.studentData?.teacherId;
    if (!teacherId) {
        showEmptyState("You don't have a teacher assigned yet — check back once you're enrolled in a class.");
        return;
    }

    try {
        // Same resolution path the teacher's own pages use for themselves —
        // every query below is built from this student's own
        // session.studentData.teacherId, never any other class's.
        const teacherSnap = await getDoc(getTeacherDocRef(session.schoolId, teacherId));
        const legacyTeacherData = teacherSnap.exists() ? teacherSnap.data() : null;

        const { subjectsCache, resolvedClasses } = await loadTeacherSubjectsCache(session.schoolId, teacherId, legacyTeacherData);

        // Pure in-memory merge of legacy-embedded and new-model-subcollection
        // assignments — loadTeacherSubjectsCache() already fetched both, this
        // just unifies them into one flat, annotated list.
        // Two schema generations exist side by side: legacy assignments use
        // type/maxScore/date, the new "Add Work" model (Step 3) uses
        // workType/pointsPossible/dueDate instead. normalizeAssignment()
        // maps the new names onto the old ones so every existing render
        // function below (card list, status pill, detail header) keeps
        // working unchanged for both — this was the first thing that broke
        // when checked against a real Add Work document: without it, a new
        // assessment showed an "undefined" type badge and "/undefined" score.
        //
        // 'draft' status is filtered out here, not deep in a render
        // function, so there is exactly one place that decides "is this
        // visible to a student yet" — legacy assignments have no status
        // field at all and are always visible, matching prior behavior.
        assignmentsCache = loadAssignmentsForSubjects(subjectsCache, resolvedClasses)
            .filter(a => a.status !== 'draft')
            .map(normalizeAssignment);

        renderSubjectFilterOptions();

        if (!assignmentsCache.length) {
            showEmptyState("Your teacher hasn't prepared any assignments yet.");
            return;
        }

        const [subMap, gradeMap] = await Promise.all([
            loadSubmissionsForAssignments(session.schoolId, assignmentsCache, session.studentId),
            loadGradesIndexForStudent(session.schoolId, session.studentId)
        ]);
        submissionsById = subMap;
        gradesById = gradeMap;

        els.assignmentsLoader.classList.add('hidden');
        els.assignmentListCount.classList.remove('hidden');
        renderList();
    } catch (e) {
        console.error('[Student Assignments] init:', e);
        showEmptyState('Something went wrong loading your assignments. Please try again later.');
    }
}

function cacheEls() {
    ['subjectFilter', 'assignmentsLoader', 'assignmentListCount', 'assignmentList',
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
    els.assignmentListCount.classList.add('hidden');
    els.assignmentList.innerHTML = `<div class="text-center py-10 text-slate-400 text-[13px] font-bold bg-white rounded-xl border border-slate-200">${escHtml(message)}</div>`;
}

// ── 4. SUBJECT FILTER ────────────────────────────────────────────────────
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

// ── 5. LIST ──────────────────────────────────────────────────────────────
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

function statusPill(assignment) {
    const grade = gradesById.get(assignment.id);
    if (grade) {
        return { label: `Graded: ${grade.score}/${grade.max}`, classes: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
    }
    const hasSubmission = !!submissionsById.get(assignment.id);
    if (assignment.locked) {
        return hasSubmission
            ? { label: 'Locked · Submitted', classes: 'bg-amber-50 text-amber-700 border-amber-200' }
            : { label: 'Locked · Not submitted', classes: 'bg-amber-50 text-amber-700 border-amber-200' };
    }
    return hasSubmission
        ? { label: 'Submitted', classes: 'bg-indigo-50 text-indigo-700 border-indigo-200' }
        : { label: 'Not submitted', classes: 'bg-slate-100 text-slate-500 border-slate-200' };
}

function renderList() {
    if (!els.assignmentListCount) return;
    const list = getVisibleAssignments();
    els.assignmentListCount.textContent = `${list.length} assignment${list.length === 1 ? '' : 's'}`;

    if (!list.length) {
        els.assignmentList.innerHTML = `<div class="text-center py-10 text-slate-400 text-[13px] font-bold bg-white rounded-xl border border-slate-200">
            No assignments${currentSubjectFilter ? ' for this subject' : ''}.
        </div>`;
        return;
    }

    els.assignmentList.innerHTML = list.map(renderAssignmentCard).join('');
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

// ── 6. DETAIL PANEL ──────────────────────────────────────────────────────
window.openAssignmentDetail = function(assignmentId) {
    const a = assignmentsCache.find(x => x.id === assignmentId);
    if (!a) return;
    currentAssignmentId = assignmentId;

    els.adSubjectLabel.textContent = a.subjectName || '';
    els.adTitle.textContent = a.title || 'Assignment';

    const metaChips = [
        `<span class="text-[10px] font-black uppercase bg-indigo-50 text-indigo-600 border border-indigo-200 px-2 py-0.5 rounded-md">${escHtml(a.type)}</span>`,
        `<span class="text-[10px] font-black text-slate-500 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded-md">/ ${a.maxScore} pts</span>`
    ];
    if (a.date) metaChips.push(`<span class="text-[10.5px] text-slate-400 font-semibold"><i class="fa-regular fa-calendar mr-1"></i>Due ${escHtml(formatDate(a.date))}</span>`);
    if (a.locked) metaChips.push(`<span class="text-[10px] font-black uppercase bg-amber-50 text-amber-600 border border-amber-200 px-2 py-0.5 rounded-md flex items-center gap-1"><i class="fa-solid fa-lock text-[9px]"></i>Locked</span>`);
    els.adMetaRow.innerHTML = metaChips.join('');

    els.assignmentDetailBody.innerHTML = renderDetailBody(a);
    wireDetailFormEvents(a);

    openOverlay('assignmentDetailOverlay', 'assignmentDetailInner', true);
};

window.closeAssignmentDetail = function() {
    closeOverlay('assignmentDetailOverlay', 'assignmentDetailInner', true);
    currentAssignmentId = null;
};

// Standard-work-only: teacher media attachments (Add Work's rich-attachment
// model). Legacy assignments never have this field, so it renders nothing
// for them — same as it always has.
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

function renderDetailBody(a) {
    const grade = gradesById.get(a.id);
    const submission = submissionsById.get(a.id);
    const frozen = isSubmissionFrozen(a, gradesById);
    // Only Add Work's assessment category carries a real questions[] array —
    // a legacy assignment or a standard-work item both fall through to the
    // existing generic instructions + free-text/link form below, unchanged.
    const isAssessment = a.category === 'assessment' && Array.isArray(a.questions) && a.questions.length > 0;

    if (isAssessment) {
        const gradeBlock = grade ? `
        <div class="bg-emerald-50 border border-emerald-200 rounded-xl p-4">
            <p class="text-[11px] font-black text-emerald-600 uppercase tracking-wider mb-1"><i class="fa-solid fa-circle-check mr-1"></i>Your Grade</p>
            <p class="text-2xl font-black text-emerald-700">${grade.score}<span class="text-base text-emerald-500">/${grade.max}</span></p>
            ${grade.notes ? `<p class="text-[12.5px] text-emerald-800 font-semibold mt-1 whitespace-pre-wrap">${escHtml(grade.notes)}</p>` : ''}
        </div>` : '';
        return gradeBlock + renderAssessmentSection(a, submission, frozen);
    }

    // Assessments never populate instructions/attachments (awSaveWork always
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

    const gradeBlock = grade ? `
        <div class="bg-emerald-50 border border-emerald-200 rounded-xl p-4">
            <p class="text-[11px] font-black text-emerald-600 uppercase tracking-wider mb-1"><i class="fa-solid fa-circle-check mr-1"></i>Your Grade</p>
            <p class="text-2xl font-black text-emerald-700">${grade.score}<span class="text-base text-emerald-500">/${grade.max}</span></p>
            ${grade.notes ? `<p class="text-[12.5px] text-emerald-800 font-semibold mt-1 whitespace-pre-wrap">${escHtml(grade.notes)}</p>` : ''}
        </div>` : '';

    let submissionBlock;
    if (frozen) {
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

    return instructionsBlock + attachmentsBlock + gradeBlock + submissionBlock;
}

function wireDetailFormEvents(a) {
    // Drawing canvases need pointer-event handlers attached after their
    // markup lands in the DOM — everything else on this panel is either a
    // plain inline onclick or a value read at submit time, so this is the
    // only case with anything to wire.
    if (a.category === 'assessment') initAssessmentCanvases();
}

// ─────────────────────────────────────────────────────────────────────────
// STEP 1 (Phase 3) — Student-facing assessment rendering.
// Read-only against Firestore beyond what init() already loaded; nothing
// here writes a submission. Submit is disabled with an explanatory title
// until persistence is wired up in the next authorized step, mirroring how
// the teacher builder's own Save/Publish buttons started out disabled in
// its Step 1 before Step 3 wired them up.
// ─────────────────────────────────────────────────────────────────────────

const AW_STUDENT_REQUIRES_LABEL = { file: 'Upload a file', photo: 'Take a photo', drawing: 'Draw your answer' };

function renderAssessmentSection(a, submission, frozen) {
    const saved = new Map((submission?.responses || []).map(r => [r.questionId, r]));
    const cards = a.questions.map((q, i) => renderStudentQuestionCard(q, i, saved.get(q.id), frozen)).join('');

    const footer = frozen
        ? `<div class="bg-amber-50 border border-amber-200 rounded-xl p-3 text-[12px] font-bold text-amber-700 flex items-center gap-2">
               <i class="fa-solid fa-lock"></i> ${escHtml(submission ? 'This assessment has been graded, so your answers are locked.' : 'Your teacher has closed submissions for this assessment.')}
           </div>`
        : `<button id="adSubmitBtn" disabled title="Answer submission wires up in the next authorized build step"
               class="w-full bg-slate-200 text-slate-400 font-black py-3 rounded-xl text-sm flex items-center justify-center gap-2 cursor-not-allowed">
               <i class="fa-solid fa-paper-plane"></i> Submit
           </button>
           <p id="adSubMsg" class="text-sm hidden font-bold p-2.5 mt-2 rounded-xl text-center"></p>`;

    return `
        <div>
            <p class="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-1.5">Questions</p>
            <div id="adQuestionsContainer" class="space-y-3">${cards}</div>
        </div>
        ${footer}`;
}

function renderStudentQuestionCard(q, index, saved, frozen) {
    return `
    <div class="bg-white border border-slate-200 rounded-xl p-4" data-question-id="${escHtml(q.id)}">
        <div class="flex items-start gap-2 mb-3">
            <span class="w-6 h-6 flex-shrink-0 bg-indigo-50 text-indigo-600 border border-indigo-200 rounded-md flex items-center justify-center text-[10px] font-black">${index + 1}</span>
            <div class="min-w-0 flex-1">
                <p class="text-[13.5px] font-bold text-slate-800 whitespace-pre-wrap">${escHtml(q.prompt)}</p>
                <p class="text-[10.5px] text-slate-400 font-semibold mt-0.5">${q.points ?? 0} point${(q.points ?? 0) === 1 ? '' : 's'}</p>
            </div>
        </div>
        ${renderStudentQuestionInput(q, saved, frozen)}
    </div>`;
}

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

        if (requires === 'drawing') {
            return `
                <div class="pl-8">
                    <p class="text-[11px] text-slate-400 font-semibold italic mb-1.5">${escHtml(label)}</p>
                    <canvas id="canvas-${escHtml(q.id)}" data-aw-canvas data-question-id="${escHtml(q.id)}"
                        width="400" height="220" class="border border-slate-200 rounded-lg bg-white w-full touch-none" style="max-width:400px;"></canvas>
                    ${!frozen ? `<button type="button" data-aw-clear-canvas="${escHtml(q.id)}" class="text-[11px] font-bold text-slate-400 hover:text-rose-500 mt-1.5">Clear</button>` : ''}
                </div>`;
        }

        // file / photo — a real Storage upload is out of scope until
        // persistence is wired up; this captures the picked file's name only
        // so the UI is honest about what will (and won't yet) be submitted.
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

// Pointer-drawn canvases: plain black stroke, no persistence — toDataURL()
// is read later by collectStudentResponses() when submission is wired up.
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
// Firestore or Storage calls. Shape matches what the next step's
// saveSubmission() extension will persist: an ordered array of
// { questionId, responseText, attachmentUrl }. multiple_choice stores the
// selected option's INDEX (as a string) rather than its text, so later
// auto-grading can compare directly against work_answer_keys' numeric
// indices without re-deriving them from option text that could since have
// been edited.
function collectStudentResponses(a) {
    return (a.questions || []).map(q => {
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
                attachmentUrl = canvas && canvasHasDrawing(canvas) ? canvas.toDataURL('image/png') : null;
            } else {
                const fileInput = document.querySelector(`input[type="file"][data-question-id="${q.id}"]`);
                attachmentUrl = fileInput?.files?.[0]?.name || null; // name only — no upload wiring yet
            }
        }

        return { questionId: q.id, responseText, attachmentUrl };
    });
}

// ── 7. SAVE SUBMISSION ───────────────────────────────────────────────────
window.saveMySubmission = async function() {
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
        const studentName = session.studentData?.name || '';
        const record = await saveSubmission(session.schoolId, a, session.studentId, studentName, { responseText, linkUrl });
        submissionsById.set(a.id, record);
        renderList();
        // Re-render the panel so it reflects "Update Submission" + the new timestamp.
        window.openAssignmentDetail(a.id);
    } catch (e) {
        console.error('[Student Assignments] saveMySubmission:', e);
        showMsg('adSubMsg', 'Could not save your submission. Please try again.', true);
        btn.innerHTML = prevHtml;
        btn.disabled = false;
    }
};

init();
