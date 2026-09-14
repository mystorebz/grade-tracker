import { db } from '../../assets/js/firebase-init.js';
import { doc, getDoc, getDocs, setDoc, collection, query, where, updateDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth, setSessionData } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { letterGrade, loadTeacherSubjectsCache, getTeacherDocRef, resolveGradeWeights, saveGrade } from '../../assets/js/utils.js';
// PHASE 4: resolvePostContext resolves a legacy subject's classId exactly the
// way submissions.js/posts.js already do (the submission fetch below needs
// the SAME classId a student's own submission was actually written under, or
// it'd read the wrong path). loadSubmission reuses the exact Firestore path
// submissions.js uses to save a submission, rather than re-deriving it a
// third time here. (The awSaveWork legacy-shadow-doc write that used to be
// the other caller of this helper moved to teacher/subjects/subjects.js in
// the Lift & Shift refactor — resolvePostContext is still used there too.)
import { resolvePostContext } from '../../assets/js/posts.js';
import { loadSubmission } from '../../assets/js/submissions.js';

// ── 1. AUTH & LAYOUT ──────────────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
injectTeacherLayout('grade-entry', 'Enter Grade', 'Log a new assignment or assessment into the system', false);

// ── 2. STATE ──────────────────────────────────────────────────────────────
let rawSemesters    = [];
let teacherStudents = [];
let allGradesThisTerm = [];          // every grade this teacher recorded in the active term (for roster status)
let activeSemId       = '';
let isSemesterLocked  = false;

let selectedSubject     = '';        // currently chosen subject name
let selectedAssignment  = null;      // currently chosen prepared assignment object (or null = manual)
let fieldsUnlocked      = false;     // whether the locked title/type/max have been deliberately unlocked

// PHASE 0: same merged legacy/new-model subjects list as subjects.js and
// archives.js, built by the shared loadTeacherSubjectsCache() helper in
// utils.js — populated once in init() below, before the subject picker
// is drawn.
let subjectsCache = [];

// PHASE 4: the resolvedClasses half of loadTeacherSubjectsCache()'s return
// value — previously discarded here. Needed so a legacy subject's classId
// can be resolved via resolvePostContext() the exact same way the student
// side already does when it writes a submission, so the Phase 4 shadow-doc
// write and submission fetch below always agree with where a submission
// actually lives.
let resolvedClassesCache = [];

// PHASE 0: resolved once at init via resolveGradeWeights() — preferring the
// new schools/{schoolId}/teaching_assignments weighting over the legacy
// gradeTypes/customGradeTypes fields. Only feeds the grade-type dropdown
// (a display concern), so a once-per-load resolve is correct here.
let resolvedGradeTypes = null;

// PHASE 4: the submission currently loaded for the selected student +
// assessment assignment (null when there isn't one, or the assignment isn't
// an assessment at all). currentSubmissionRequestToken guards against a
// slower, now-stale fetch overwriting state after the teacher has already
// moved on to a different student/assignment while it was in flight.
let currentSubmission = null;
let currentSubmissionRequestToken = null;

const DEFAULT_GRADE_TYPES = ['Test', 'Quiz', 'Assignment', 'Homework', 'Project', 'Midterm Exam', 'Final Exam'];

// ── HELPERS ─────────────────────────────────────────────────────────────────
// Same helper as student/assignments/assignments.js — kept as a small
// duplicated function rather than a shared-utils change, since the shared
// loadTeacherSubjectsCache() is consumed by more pages than just these two
// and changing its return shape directly is a bigger, less contained change
// than normalizing at each consumer the way both of these already do.
function normalizeAssignment(a) {
    return {
        ...a,
        type: a.workType || a.type || 'Assignment',
        maxScore: a.pointsPossible ?? a.maxScore ?? 0,
        date: a.dueDate || a.date || '',
    };
}

function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// DUE DATE & TIME ENGINE (mandate): an assignment's `date` field can now
// hold either a legacy date-only string ("YYYY-MM-DD") or a full ISO
// datetime string (set via the new datetime-local picker in
// teacher/subjects/subjects.js's Add Work modal). Displaying either raw
// with escHtml() alone would show a bare ISO timestamp for the new case —
// this formats both consistently, matching the same helper added to
// subjects.js and student/assignments/assignments.js.
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

function getActiveSubjects() {
    return subjectsCache.filter(s => !s.archived);
}
function getSubjectByName(name) {
    return getActiveSubjects().find(s => s.name === name) || null;
}
function getGradeTypes() {
    return resolvedGradeTypes || DEFAULT_GRADE_TYPES;
}
function gradeTypeNames() {
    return getGradeTypes().filter(Boolean).map(t => t.name || (typeof t === 'string' ? t : 'Uncategorized'));
}

// Students enrolled with this teacher (filtered to the subject's relevance is by teacher, not subject —
// the roster is the teacher's full active roster, matching how grades are entered)
function rosterStudents() {
    return teacherStudents;
}

// Has a given student already been graded for the current subject + assignment title this term?
function isStudentGraded(studentId, subject, title) {
    if (!subject || !title) return false;
    return allGradesThisTerm.some(g =>
        g.studentId === studentId &&
        g.subject === subject &&
        (g.title || '').toLowerCase() === title.toLowerCase()
    );
}

// ── 3. INIT ───────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    const dateInput = document.getElementById('agDate');
    if (dateInput) dateInput.valueAsDate = new Date();

    const scoreInput = document.getElementById('agScore');
    const maxInput   = document.getElementById('agMax');
    if (scoreInput) {
        scoreInput.addEventListener('input', () => { sanitizeScore(); updatePreview(); });
        // Block obviously invalid keystrokes (e, E, +, -) before they register
        scoreInput.addEventListener('keydown', blockInvalidNumberKeys);
    }
    if (maxInput) {
        maxInput.addEventListener('input', () => { sanitizeScore(); updatePreview(); });
        maxInput.addEventListener('keydown', blockInvalidNumberKeys);
    }

    const commitBtn = document.getElementById('saveGradeBtn');
    if (commitBtn) commitBtn.addEventListener('click', commitGrade);

    const postBtn = document.getElementById('postToClassBtn');
    if (postBtn) postBtn.addEventListener('click', postAssignmentToClass);

    const closeBannerBtn = document.getElementById('closeBannerBtn');
    if (closeBannerBtn) closeBannerBtn.addEventListener('click', () => {
        document.getElementById('gradeSavedBanner')?.classList.add('hidden');
    });

    const closeErrorBannerBtn = document.getElementById('closeErrorBannerBtn');
    if (closeErrorBannerBtn) closeErrorBannerBtn.addEventListener('click', () => {
        document.getElementById('gradeErrorBanner')?.classList.add('hidden');
    });

    await loadSemesters();
    await loadStudents();
    await loadAllGradesThisTerm();

    try {
        const result = await loadTeacherSubjectsCache(session.schoolId, session.teacherId, session.teacherData);
        subjectsCache = result.subjectsCache;
        resolvedClassesCache = result.resolvedClasses || [];
        // PHASE 4: same field-name gap fixed on the student side (Phase 3
        // Step 1) exists here too — legacy assignments use type/maxScore/
        // date, Add Work (Step 3) uses workType/pointsPossible/dueDate
        // instead. Without this, the assignment picker showed "undefined"
        // type and "/undefined" points for any Add Work assessment/standard
        // item, which would have made this phase's own grading queue unable
        // to display what it was selecting.
        subjectsCache.forEach(sub => {
            if (!Array.isArray(sub.assignments)) return;
            sub.assignments = sub.assignments.map(normalizeAssignment);
        });
    } catch (e) {
        console.error('[Grade Form] Failed to load subjects cache:', e);
    }
    try {
        resolvedGradeTypes = await resolveGradeWeights(session.schoolId, session.teacherId, { legacyTeacherData: session.teacherData });
    } catch (e) {
        console.error('[Grade Form] Failed to resolve grade weights:', e);
    }

    populateSubjectPicker();
    renderState(); // initial render: picker visible, grading panel hidden
});

// ── 4. LOAD SEMESTERS ─────────────────────────────────────────────────────
async function loadSemesters() {
    try {
        const cacheKey = `connectus_semesters_${session.schoolId}`;
        const cached   = localStorage.getItem(cacheKey);
        if (cached) {
            rawSemesters = JSON.parse(cached);
        } else {
            const snap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
            rawSemesters = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0));
            localStorage.setItem(cacheKey, JSON.stringify(rawSemesters));
        }

        let activeName = 'Period';
        try {
            const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
            activeSemId = schoolSnap.data()?.activeSemesterId || '';
            const activeSem = rawSemesters.find(s => s.id === activeSemId);
            if (activeSem) {
                activeName = activeSem.name;
                isSemesterLocked = !!activeSem.isLocked;
            }
        } catch (e) {}

        const activeSemesterSelect = document.getElementById('activeSemester');
        if (activeSemesterSelect) {
            activeSemesterSelect.innerHTML = '';
            rawSemesters.forEach(s => {
                const opt = document.createElement('option');
                opt.value = s.id; opt.textContent = s.name;
                if (s.id === activeSemId) opt.selected = true;
                activeSemesterSelect.appendChild(opt);
            });
        }

        const sbPeriod = document.getElementById('sb-period');
        if (sbPeriod) sbPeriod.textContent = activeName;

        // Surface the locked notice + disable committing if the term is locked
        if (isSemesterLocked) {
            document.getElementById('lockedGradeNotice')?.classList.remove('hidden');
        }

    } catch (e) { console.error('[TeacherGradeEntry] loadSemesters:', e); }
}

// ── 5. LOAD ROSTER ────────────────────────────────────────────────────────
async function loadStudents() {
    try {
        const q = query(
            collection(db, 'students'),
            where('currentSchoolId', '==', session.schoolId),
            where('enrollmentStatus', '==', 'Active')
        );
        const snap = await getDocs(q);

        teacherStudents = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(s => s.teacherId === session.teacherId)
            .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    } catch (e) {
        console.error('[Grade Form] Failed to load students:', e);
    }
}

// ── 5b. LOAD ALL GRADES THIS TERM (for roster status) ───────────────────────
async function loadAllGradesThisTerm() {
    allGradesThisTerm = [];
    if (!activeSemId || !teacherStudents.length) return;
    try {
        await Promise.all(teacherStudents.map(async s => {
            try {
                const q = query(
                    collection(db, 'students', s.id, 'grades'),
                    where('schoolId', '==', session.schoolId),
                    where('semesterId', '==', activeSemId)
                );
                const snap = await getDocs(q);
                snap.forEach(d => allGradesThisTerm.push({ id: d.id, studentId: s.id, ...d.data() }));
            } catch (e) { /* per-student failures are non-fatal */ }
        }));
    } catch (e) {
        console.error('[Grade Form] loadAllGradesThisTerm:', e);
    }
}

// ── 6. SUBJECT PICKER ───────────────────────────────────────────────────────
function populateSubjectPicker() {
    const wrap = document.getElementById('subjectPickerList');
    if (!wrap) return;

    const subjects = getActiveSubjects();
    if (!subjects.length) {
        wrap.innerHTML = `<p class="text-[13px] text-[#6b84a0] italic font-semibold col-span-full text-center py-6">No subjects yet. Add subjects from the Subjects page first.</p>`;
        return;
    }

    wrap.innerHTML = subjects.map(s => {
        const activeCount = (Array.isArray(s.assignments) ? s.assignments : []).filter(a => !a.completed).length;
        const safe = escHtml(s.name).replace(/'/g, "&#039;");
        return `
        <button type="button" onclick="selectSubject('${s.name.replace(/'/g, "\\'")}')"
            class="gf-subject-btn group text-left bg-white border border-[#dce3ed] rounded-sm p-4 hover:border-[#0ea871] hover:shadow-md transition flex items-center justify-between gap-3 focus:outline-none focus:ring-2 focus:ring-[#0ea871]">
            <div class="min-w-0">
                <p class="font-bold text-[#0d1f35] text-[14px] truncate">${escHtml(s.name)}</p>
                <p class="text-[11px] text-[#6b84a0] font-semibold mt-0.5">${activeCount} assignment${activeCount !== 1 ? 's' : ''} ready</p>
            </div>
            <i class="fa-solid fa-chevron-right text-[#c5d0db] group-hover:text-[#0ea871] transition"></i>
        </button>`;
    }).join('');
}

window.selectSubject = function(subjectName) {
    selectedSubject = subjectName;
    selectedAssignment = null;
    fieldsUnlocked = false;
    renderAssignmentPicker();
    renderState();
};

// ── 6b. ASSIGNMENT PICKER ────────────────────────────────────────────────────
function renderAssignmentPicker() {
    const wrap = document.getElementById('assignmentPickerList');
    const heading = document.getElementById('assignmentPickerSubject');
    if (!wrap) return;

    if (heading) heading.textContent = selectedSubject;

    const sub = getSubjectByName(selectedSubject);
    const assignments = (sub && Array.isArray(sub.assignments) ? sub.assignments : []).filter(a => !a.completed);

    const manualOption = `
        <button type="button" onclick="selectManualEntry()"
            class="gf-asg-btn text-left bg-[#f8fafb] border border-dashed border-[#c5d0db] rounded-sm p-4 hover:border-[#2563eb] hover:bg-[#eef4ff] transition flex items-center gap-3 focus:outline-none focus:ring-2 focus:ring-[#2563eb]">
            <div class="w-8 h-8 bg-white border border-[#dce3ed] rounded-sm flex items-center justify-center text-[#2563eb] flex-shrink-0"><i class="fa-solid fa-pen text-[11px]"></i></div>
            <div>
                <p class="font-bold text-[#0d1f35] text-[13px]">Type one manually</p>
                <p class="text-[11px] text-[#6b84a0] font-semibold">Enter title, type and max yourself</p>
            </div>
        </button>`;

    // PHASE 1 MILESTONE 3: due date + a Locked badge are informational only
    // here — nothing below gates or blocks selecting/grading a locked
    // assignment, this just surfaces what the teacher set on the Subjects page.
    //
    // "Needs Grading": an assignment posted to the class (via Post to Class,
    // or any assignment that simply hasn't been graded for anyone yet) has
    // zero entries in allGradesThisTerm for its title/subject — the same
    // predicate isStudentGraded() already uses per-student, just checked
    // across the whole roster at once. Purely a display label; grading
    // still proceeds through the normal "click into it" flow below.
    const assignmentButtons = assignments.length
        ? assignments.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).map(a => {
            const gradedCount = rosterStudents().filter(s => isStudentGraded(s.id, selectedSubject, a.title)).length;
            const needsGrading = gradedCount === 0;
            return `
            <button type="button" onclick="selectAssignment('${a.id}')"
                class="gf-asg-btn text-left bg-white border border-[#dce3ed] rounded-sm p-4 hover:border-[#0ea871] hover:shadow-md transition focus:outline-none focus:ring-2 focus:ring-[#0ea871]">
                <div class="flex items-center justify-between gap-2 mb-1">
                    <p class="font-bold text-[#0d1f35] text-[13px] truncate">${escHtml(a.title)}</p>
                    <span class="text-[10px] font-bold text-[#6b84a0] bg-[#f8fafb] border border-[#dce3ed] px-2 py-0.5 rounded-sm flex-shrink-0">/ ${a.maxScore}</span>
                </div>
                <div class="flex items-center gap-2 flex-wrap">
                    <span class="text-[10px] font-bold uppercase tracking-widest text-[#0ea871] bg-[#edfaf4] border border-[#c6f0db] px-2 py-0.5 rounded-sm">${escHtml(a.type)}</span>
                    ${a.date ? `<span class="text-[10px] text-[#9ab0c6] font-semibold"><i class="fa-regular fa-calendar mr-1"></i>Due ${escHtml(formatDueDate(a.date))}</span>` : ''}
                    ${a.locked ? `<span class="text-[10px] font-bold uppercase tracking-widest text-amber-600 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-sm flex items-center gap-1"><i class="fa-solid fa-lock text-[9px]"></i>Locked</span>` : ''}
                    ${needsGrading ? `<span class="text-[10px] font-bold uppercase tracking-widest text-[#2563eb] bg-[#eef4ff] border border-[#c7d9fd] px-2 py-0.5 rounded-sm flex items-center gap-1"><i class="fa-solid fa-clipboard-question text-[9px]"></i>Needs Grading</span>` : ''}
                </div>
            </button>`;
        }).join('')
        : '';

    const emptyHint = !assignments.length
        ? `<p class="text-[12px] text-[#6b84a0] font-semibold col-span-full bg-[#f8fafb] border border-[#dce3ed] rounded-sm p-3 text-center">No prepared assignments for ${escHtml(selectedSubject)}. Prepare some on the Subjects page, or type one manually below.</p>`
        : '';

    wrap.innerHTML = emptyHint + assignmentButtons + manualOption;
}

window.selectAssignment = function(assignmentId) {
    const sub = getSubjectByName(selectedSubject);
    const assignments = sub && Array.isArray(sub.assignments) ? sub.assignments : [];
    const a = assignments.find(x => x.id === assignmentId);
    if (!a) return;

    selectedAssignment = a;
    fieldsUnlocked = false;

    // Show the grading panel first so the dropdowns get populated, THEN set values
    renderState();

    document.getElementById('agTitle').value = a.title || '';
    document.getElementById('agType').value = a.type || '';
    document.getElementById('agMax').value = a.maxScore || '';
    const notesEl = document.getElementById('agNotes');
    if (notesEl) notesEl.value = '';
    const instructionsEl = document.getElementById('agInstructions');
    if (instructionsEl) instructionsEl.value = a.instructions || '';

    applyLockState();
    updatePreview();
};

window.selectManualEntry = function() {
    // Manual: a synthetic "assignment" marker so the grading panel shows, but fields stay editable
    selectedAssignment = { manual: true, title: '', type: '', maxScore: 100 };
    fieldsUnlocked = true; // manual entry = fully editable

    renderState();

    document.getElementById('agTitle').value = '';
    document.getElementById('agType').value = '';
    document.getElementById('agMax').value = 100;
    const notesEl = document.getElementById('agNotes');
    if (notesEl) notesEl.value = '';
    const instructionsEl = document.getElementById('agInstructions');
    if (instructionsEl) instructionsEl.value = '';

    applyLockState();
    updatePreview();
};

// ── 6c. LOCK / UNLOCK FIELDS ─────────────────────────────────────────────────
function applyLockState() {
    const locked = selectedAssignment && !selectedAssignment.manual && !fieldsUnlocked;
    const titleEl = document.getElementById('agTitle');
    const typeEl  = document.getElementById('agType');
    const maxEl   = document.getElementById('agMax');
    const instructionsEl = document.getElementById('agInstructions');

    [titleEl, typeEl, maxEl, instructionsEl].forEach(el => {
        if (!el) return;
        el.readOnly = locked && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
        el.disabled = locked && el.tagName === 'SELECT';
        el.classList.toggle('gf-locked', locked);
    });

    const instructionsHint = document.getElementById('agInstructionsLockedHint');
    if (instructionsHint) instructionsHint.classList.toggle('hidden', !locked);

    const lockBtn = document.getElementById('gfEditLockBtn');
    if (lockBtn) {
        lockBtn.classList.toggle('hidden', !(selectedAssignment && !selectedAssignment.manual));
        lockBtn.innerHTML = locked
            ? '<i class="fa-solid fa-lock text-[10px]"></i> Edit fields'
            : '<i class="fa-solid fa-lock-open text-[10px]"></i> Locked from template';
    }
}

window.toggleFieldLock = function() {
    if (!selectedAssignment || selectedAssignment.manual) return;
    fieldsUnlocked = !fieldsUnlocked;
    applyLockState();
};

// ── 6d. RESET / SWITCH ───────────────────────────────────────────────────────
window.resetSelection = function() {
    selectedSubject = '';
    selectedAssignment = null;
    fieldsUnlocked = false;
    // clear all fields
    document.getElementById('agTitle').value = '';
    document.getElementById('agType').value = '';
    document.getElementById('agMax').value = 100;
    document.getElementById('agScore').value = '';
    const notesEl = document.getElementById('agNotes'); if (notesEl) notesEl.value = '';
    const instructionsEl = document.getElementById('agInstructions'); if (instructionsEl) instructionsEl.value = '';
    document.getElementById('gradePreview')?.classList.add('hidden');
    currentSubmission = null;
    currentSubmissionRequestToken = null;
    document.getElementById('gfResponseViewer')?.classList.add('hidden');
    populateSubjectPicker();
    renderState();
};

// ── 7. RENDER OVERALL STATE (which panels show) ──────────────────────────────
function renderState() {
    const subjectPicker    = document.getElementById('subjectPickerSection');
    const assignmentPicker = document.getElementById('assignmentPickerSection');
    const gradingPanel     = document.getElementById('gradingSection');

    if (!selectedSubject) {
        subjectPicker?.classList.remove('hidden');
        assignmentPicker?.classList.add('hidden');
        gradingPanel?.classList.add('hidden');
        return;
    }

    if (selectedSubject && !selectedAssignment) {
        subjectPicker?.classList.add('hidden');
        assignmentPicker?.classList.remove('hidden');
        gradingPanel?.classList.add('hidden');
        return;
    }

    // subject + assignment chosen → grading panel
    subjectPicker?.classList.add('hidden');
    assignmentPicker?.classList.add('hidden');
    gradingPanel?.classList.remove('hidden');

    // Populate the locked Subject select so it actually displays the chosen subject
    const subjectSelect = document.getElementById('agSubject');
    if (subjectSelect) {
        subjectSelect.innerHTML = `<option value="${escHtml(selectedSubject)}">${escHtml(selectedSubject)}</option>`;
        subjectSelect.value = selectedSubject;
    }

    // Populate the grade-type dropdown
    populateTypeOptions();

    // Populate the student dropdown from the roster
    populateStudentOptions();

    updateGradingHeader();
    renderRoster();
    selectFirstUngradedStudent();

    // "Post to Class" only makes sense for a brand-new manual assignment
    // that doesn't exist as a template yet — once it's a real prepared
    // assignment (selected from the picker, or already posted/graded once
    // this session), grading proceeds through the normal Commit & Next flow.
    const postBtn  = document.getElementById('postToClassBtn');
    const postHint = document.getElementById('postToClassHint');
    const showPostBtn = !!(selectedAssignment && selectedAssignment.manual);
    postBtn?.classList.toggle('hidden', !showPostBtn);
    postHint?.classList.toggle('hidden', !showPostBtn);
}

function populateTypeOptions() {
    const typeSelect = document.getElementById('agType');
    if (!typeSelect) return;
    const current = selectedAssignment && selectedAssignment.type ? selectedAssignment.type : typeSelect.value;
    typeSelect.innerHTML = '<option value="">Select type...</option>' +
        gradeTypeNames().map(n => `<option value="${escHtml(n)}">${escHtml(n)}</option>`).join('');
    if (current) typeSelect.value = current;
}

function populateStudentOptions() {
    const studentSelect = document.getElementById('agStudent');
    if (!studentSelect) return;
    const current = studentSelect.value;
    studentSelect.innerHTML = '<option value="">Select student...</option>' +
        rosterStudents().map(s => `<option value="${escHtml(s.id)}">${escHtml(s.name)} (${escHtml(s.id)})</option>`).join('');
    if (current) studentSelect.value = current;
}

function updateGradingHeader() {
    const titleEl = document.getElementById('gfGradingTitle');
    const metaEl  = document.getElementById('gfGradingMeta');
    if (titleEl) {
        titleEl.textContent = selectedAssignment.manual
            ? `${selectedSubject} · Manual entry`
            : `${selectedSubject} · ${selectedAssignment.title}`;
    }
    if (metaEl) {
        const sub = getSubjectByName(selectedSubject);
        const total = rosterStudents().length;
        const title = selectedAssignment.manual ? document.getElementById('agTitle').value.trim() : selectedAssignment.title;
        const graded = title ? rosterStudents().filter(s => isStudentGraded(s.id, selectedSubject, title)).length : 0;
        metaEl.textContent = `${graded} of ${total} graded`;
    }
}

// ── 7b. ROSTER CHECKLIST ──────────────────────────────────────────────────────
function renderRoster() {
    const wrap = document.getElementById('gfRosterList');
    if (!wrap) return;

    const students = rosterStudents();
    if (!students.length) {
        wrap.innerHTML = `<p class="text-[12px] text-[#6b84a0] italic font-semibold p-3 text-center">No students on your roster.</p>`;
        return;
    }

    const title = selectedAssignment.manual
        ? document.getElementById('agTitle').value.trim()
        : selectedAssignment.title;

    const selectedId = document.getElementById('agStudent')?.value;

    wrap.innerHTML = students.map(s => {
        const graded = title ? isStudentGraded(s.id, selectedSubject, title) : false;
        const isActive = s.id === selectedId;
        return `
        <button type="button" onclick="pickStudent('${s.id}')"
            class="w-full text-left flex items-center gap-2.5 px-3 py-2 rounded-sm border transition focus:outline-none
                ${isActive ? 'border-[#0ea871] bg-[#edfaf4]' : 'border-transparent hover:bg-[#f8fafb]'}">
            <span class="flex-shrink-0 h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-bold
                ${graded ? 'bg-[#0ea871] text-white' : 'bg-white border border-[#dce3ed] text-transparent'}">
                <i class="fa-solid fa-check"></i>
            </span>
            <span class="min-w-0 flex-1">
                <span class="block text-[12px] font-bold ${graded ? 'text-[#6b84a0]' : 'text-[#0d1f35]'} truncate">${escHtml(s.name)}</span>
            </span>
            ${isActive ? '<i class="fa-solid fa-arrow-left text-[#0ea871] text-[11px] flex-shrink-0"></i>' : ''}
        </button>`;
    }).join('');

    // progress count in the roster header
    const total = students.length;
    const graded = title ? students.filter(s => isStudentGraded(s.id, selectedSubject, title)).length : 0;
    const prog = document.getElementById('gfRosterProgress');
    if (prog) prog.textContent = `${graded} of ${total} graded`;

    // toggle the "Mark as graded" button: enabled once at least one graded; emphasised when all graded
    const markBtn = document.getElementById('gfMarkGradedBtn');
    if (markBtn) {
        if (selectedAssignment.manual) {
            markBtn.classList.add('hidden');
        } else {
            markBtn.classList.remove('hidden');
            const allDone = total > 0 && graded === total;
            markBtn.classList.toggle('gf-mark-ready', allDone);
        }
    }
}

// ── 7c. PHASE 4: SUBMISSION RESPONSE VIEWER + OBJECTIVE AUTO-GRADE PREFILL ──
// Only assessment-category Add Work assignments (real questions[], not the
// legacy type/maxScore/date shape and not a manual entry) have a submission
// worth fetching and rendering — every other case leaves the panel hidden
// and every existing code path here behaves exactly as it did before
// (No Regression for legacy assignment grading).
function isAssessmentAssignment(a) {
    return !!(a && !a.manual && a.category === 'assessment' && Array.isArray(a.questions) && a.questions.length > 0);
}

function optionLabel(i) {
    return String.fromCharCode(65 + i); // 0 -> A, 1 -> B, ...
}

// Fetches (or clears) the submission for whatever student + assignment is
// currently selected. This is the single funnel every call site below uses
// so the panel, the auto-grade prefill, and the actual fetch can never fall
// out of sync with each other.
async function refreshSubmissionPanel() {
    const panel = document.getElementById('gfResponseViewer');
    const studentId = document.getElementById('agStudent')?.value || '';

    if (!isAssessmentAssignment(selectedAssignment) || !studentId) {
        currentSubmission = null;
        currentSubmissionRequestToken = null;
        if (panel) panel.classList.add('hidden');
        return;
    }

    const sub = getSubjectByName(selectedSubject);
    const ctx = sub ? resolvePostContext(sub, resolvedClassesCache) : null;
    if (!ctx) {
        // Same "can't resolve a class for this subject yet" case
        // resolvePostContext's own callers already treat as unreachable —
        // pre-existing, not new to Phase 4.
        currentSubmission = null;
        currentSubmissionRequestToken = null;
        if (panel) panel.classList.add('hidden');
        return;
    }

    const assignmentId = selectedAssignment.id;
    const requestToken = `${assignmentId}:${studentId}`;
    currentSubmissionRequestToken = requestToken;

    if (panel) {
        panel.classList.remove('hidden');
        panel.innerHTML = `<p class="text-[11px] text-[#9ab0c6] italic font-semibold p-2">Loading submission…</p>`;
    }

    let submission = null;
    try {
        submission = await loadSubmission(session.schoolId, { classId: ctx.classId, subjectId: ctx.subjectId, id: assignmentId }, studentId);
    } catch (e) {
        console.error('[Grade Form] Failed to load submission for grading:', e);
    }

    // The teacher may have already switched to a different student or
    // assignment while this fetch was in flight — a slower, now-stale
    // response must never clobber whatever is now actually selected.
    if (currentSubmissionRequestToken !== requestToken) return;

    currentSubmission = submission;
    renderSubmissionPanel();
    applyAutoGradePrefill();
}

function renderSubmissionPanel() {
    const panel = document.getElementById('gfResponseViewer');
    if (!panel) return;

    if (!isAssessmentAssignment(selectedAssignment)) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');

    if (!currentSubmission) {
        panel.innerHTML = `
            <div class="p-3 bg-[#fff8ed] border border-[#fde9c8] rounded-sm text-center">
                <p class="text-[11px] font-bold text-[#92660a] m-0"><i class="fa-solid fa-circle-exclamation mr-1.5"></i>No submission on file for this student yet.</p>
            </div>`;
        return;
    }

    const responsesByQid = new Map((currentSubmission.responses || []).map(r => [r.questionId, r]));
    const autoGrade = currentSubmission.objectiveAutoGrade || null;
    const hasObjective = (selectedAssignment.questions || []).some(q => q.type === 'multiple_choice');

    const autoSummary = autoGrade
        ? `<p class="text-[11px] font-bold text-[#2563eb] bg-[#eef4ff] border border-[#c7d9fd] rounded-sm px-2.5 py-1.5 mb-2"><i class="fa-solid fa-robot mr-1.5"></i>Auto-graded ${autoGrade.correctCount}/${autoGrade.totalObjective} objective question(s) — ${autoGrade.points}/${autoGrade.maxObjectivePoints} pt(s). Score below pre-filled; review the rest before committing.</p>`
        : hasObjective
            ? `<p class="text-[11px] font-bold text-[#9ab0c6] bg-[#f8fafb] border border-[#dce3ed] rounded-sm px-2.5 py-1.5 mb-2"><i class="fa-solid fa-clock mr-1.5"></i>Auto-grading hasn't run for this submission yet.</p>`
            : '';

    const cards = (selectedAssignment.questions || []).map((q, i) => {
        const r = responsesByQid.get(q.id) || null;
        const num = i + 1;
        let body = '';

        if (q.type === 'multiple_choice') {
            const selectedIndex = r && r.responseText !== '' && r.responseText != null ? Number(r.responseText) : null;
            const graded = !!autoGrade && Object.prototype.hasOwnProperty.call(autoGrade.perQuestion || {}, q.id);
            const isCorrect = graded ? autoGrade.perQuestion[q.id] : null;
            const optionsHtml = (q.options || []).map((opt, oi) => {
                const isSelected = selectedIndex === oi;
                return `<div class="flex items-center gap-2 px-2.5 py-1.5 rounded-sm text-[12px] ${isSelected ? 'bg-[#eef4ff] border border-[#c7d9fd] font-bold text-[#0d1f35]' : 'text-[#6b84a0]'}">
                    <span class="w-4 h-4 flex-shrink-0 rounded-full border ${isSelected ? 'border-[#2563eb] bg-[#2563eb] text-white' : 'border-[#c5d0db]'} flex items-center justify-center text-[9px] font-bold">${isSelected ? '<i class="fa-solid fa-check"></i>' : optionLabel(oi)}</span>
                    <span>${escHtml(opt)}</span>
                </div>`;
            }).join('');
            const badge = selectedIndex === null
                ? `<span class="text-[10px] font-bold uppercase tracking-widest text-[#9ab0c6] bg-[#f8fafb] border border-[#dce3ed] px-2 py-0.5 rounded-sm">Not answered</span>`
                : !graded
                    ? `<span class="text-[10px] font-bold uppercase tracking-widest text-[#9ab0c6] bg-[#f8fafb] border border-[#dce3ed] px-2 py-0.5 rounded-sm">Not yet auto-graded</span>`
                    : isCorrect
                        ? `<span class="text-[10px] font-bold uppercase tracking-widest text-[#0ea871] bg-[#edfaf4] border border-[#c6f0db] px-2 py-0.5 rounded-sm"><i class="fa-solid fa-check text-[9px] mr-1"></i>Correct</span>`
                        : `<span class="text-[10px] font-bold uppercase tracking-widest text-[#e31b4a] bg-[#fff0f3] border border-[#fecaca] px-2 py-0.5 rounded-sm"><i class="fa-solid fa-xmark text-[9px] mr-1"></i>Incorrect</span>`;
            body = `<div class="space-y-1 mt-2">${optionsHtml}</div><div class="mt-2">${badge}</div>`;
        } else if (q.type === 'free_response' || q.type === 'short_answer' || q.type === 'math') {
            const text = r && r.responseText ? r.responseText : '';
            body = text
                ? `<p class="text-[12.5px] text-[#0d1f35] whitespace-pre-wrap bg-[#f8fafb] border border-[#dce3ed] rounded-sm p-2.5 mt-2">${escHtml(text)}</p>`
                : `<p class="text-[11px] text-[#9ab0c6] italic mt-2">No answer provided.</p>`;
        } else if (q.type === 'attachment_response') {
            const url = r && r.attachmentUrl ? r.attachmentUrl : null;
            if (!url) {
                body = `<p class="text-[11px] text-[#9ab0c6] italic mt-2">No file/drawing submitted.</p>`;
            } else if (/^data:image\//i.test(url) || /\.(png|jpe?g|gif|webp)(\?|$)/i.test(url)) {
                body = `<a href="${escHtml(url)}" target="_blank" rel="noopener noreferrer" class="block mt-2"><img src="${escHtml(url)}" class="max-h-48 rounded-sm border border-[#dce3ed]" alt="Student submission"></a>`;
            } else {
                body = `<a href="${escHtml(url)}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1.5 text-[12px] font-bold text-[#2563eb] mt-2"><i class="fa-solid fa-paperclip text-[10px]"></i>View submitted file</a>`;
            }
        }

        return `
        <div class="border border-[#dce3ed] rounded-sm p-3 bg-white">
            <div class="flex items-start justify-between gap-2">
                <p class="text-[12px] font-bold text-[#0d1f35] m-0">Q${num}. ${escHtml(q.prompt)}</p>
                <span class="text-[10px] font-bold text-[#9ab0c6] flex-shrink-0">${q.points ?? 0} pt${(q.points ?? 0) === 1 ? '' : 's'}</span>
            </div>
            ${body}
        </div>`;
    }).join('');

    const statusNote = currentSubmission.status === 'graded'
        ? `<p class="text-[10px] font-bold text-[#0ea871] uppercase tracking-widest mb-2"><i class="fa-solid fa-circle-check mr-1"></i>Already graded</p>`
        : '';

    panel.innerHTML = `
        <div class="flex items-center justify-between mb-2">
            <h4 class="text-[11px] font-bold text-[#0d1f35] uppercase tracking-widest m-0"><i class="fa-solid fa-file-lines mr-1.5 text-[#9ab0c6]"></i>Student Responses</h4>
        </div>
        ${statusNote}
        ${autoSummary}
        <div class="space-y-2 max-h-[26rem] overflow-y-auto pr-1">${cards}</div>`;
}

// Pre-fills the score from the server-computed objective auto-grade only —
// never from anything read/derived client-side, the same isolation
// principle work_answer_keys enforces everywhere else (autoGradeWorkSubmission
// in functions/index.js is the only thing that ever sees the correct
// answers). Only touches the score field while it's still blank, so it can
// never overwrite a value the teacher already typed for this student.
function applyAutoGradePrefill() {
    if (!isAssessmentAssignment(selectedAssignment) || !currentSubmission) return;
    const auto = currentSubmission.objectiveAutoGrade;
    if (!auto) return;

    const scoreEl = document.getElementById('agScore');
    if (!scoreEl || scoreEl.value !== '') return;

    scoreEl.value = auto.points;
    sanitizeScore();
    updatePreview();
}

window.pickStudent = function(studentId) {
    const select = document.getElementById('agStudent');
    if (select) select.value = studentId;
    renderRoster(); // refresh active highlight
    refreshSubmissionPanel();
    // focus the score for fast entry
    const scoreEl = document.getElementById('agScore');
    if (scoreEl) scoreEl.focus();
};

function selectFirstUngradedStudent() {
    const students = rosterStudents();
    const title = selectedAssignment.manual
        ? document.getElementById('agTitle').value.trim()
        : selectedAssignment.title;

    const firstUngraded = students.find(s => !(title ? isStudentGraded(s.id, selectedSubject, title) : false));
    const target = firstUngraded || students[0];
    const select = document.getElementById('agStudent');
    if (select && target) select.value = target.id;
    renderRoster();
    refreshSubmissionPanel();
}

// ── 8. SCORE VALIDATION + LIVE PREVIEW ──────────────────────────────────────
// Block letters and sign keys in number fields (decimals allowed)
function blockInvalidNumberKeys(e) {
    if (['e', 'E', '+', '-'].includes(e.key)) e.preventDefault();
}

// Keep score within [0, max]; show an inline hint when the typed value is out of range
function sanitizeScore() {
    const scoreEl = document.getElementById('agScore');
    const maxEl   = document.getElementById('agMax');
    const hintEl  = document.getElementById('agScoreHint');
    if (!scoreEl || !maxEl) return;

    let score = parseFloat(scoreEl.value);
    let max   = parseFloat(maxEl.value);

    // Max must be at least 1
    if (!isNaN(max) && max < 1) { maxEl.value = 1; max = 1; }

    let msg = '';
    if (scoreEl.value !== '' && !isNaN(score)) {
        if (score < 0) { scoreEl.value = 0; score = 0; msg = 'Score can’t be negative.'; }
        if (!isNaN(max) && score > max) {
            scoreEl.value = max;       // clamp to the max
            score = max;
            msg = `Score can’t exceed the max of ${max}.`;
        }
    }

    if (hintEl) {
        if (msg) { hintEl.textContent = msg; hintEl.classList.remove('hidden'); }
        else { hintEl.classList.add('hidden'); }
    }
}

function updatePreview() {
    const scoreEl = document.getElementById('agScore');
    const maxEl   = document.getElementById('agMax');
    if (!scoreEl || !maxEl) return;

    const score = parseFloat(scoreEl.value);
    const max   = parseFloat(maxEl.value);
    const prev  = document.getElementById('gradePreview');

    if (prev && !isNaN(score) && !isNaN(max) && max > 0 && score >= 0) {
        const pct = Math.round((score / max) * 100);
        prev.classList.remove('hidden');

        const prevPct = document.getElementById('prevPct');
        if (prevPct) prevPct.textContent = `${pct}%`;

        const prevLetter = document.getElementById('prevLetter');
        if (prevLetter) prevLetter.textContent = letterGrade(pct);

        const prevBar = document.getElementById('prevBar');
        if (prevBar) {
            prevBar.style.width = `${pct}%`;
            prevBar.className   = `h-full rounded-none transition-all duration-300 ${pct >= 90 ? 'bg-emerald-500' : pct >= 80 ? 'bg-blue-500' : pct >= 70 ? 'bg-teal-500' : pct >= 65 ? 'bg-amber-500' : 'bg-red-500'}`;
        }
    } else if (prev) {
        prev.classList.add('hidden');
    }
}

// ── 8b. CREATE (OR REUSE) THE PREPARED ASSIGNMENT DOCUMENT ───────────────────
// Shared by both commitGrade() (grade-and-post-if-needed) and
// postAssignmentToClass() (post-only, no grade). Writes the assignment
// template itself — title/type/maxScore/instructions/date — to wherever
// this subject's assignments actually live (new-model subcollection, or the
// legacy embedded array), identically to how commitGrade() always has.
// Returns the resolved assignment object (existing match, or newly created)
// and updates in-memory state (selectedAssignment, fieldsUnlocked, lock UI)
// exactly like the inline version this was extracted from. No-ops (returns
// null) if the subject can't be resolved or title is blank — callers should
// already have validated those themselves.
async function ensureAssignmentDoc({ subject, type, title, max, date, instructions }) {
    const sub = getSubjectByName(subject);
    if (!sub) return null;

    const existing = Array.isArray(sub.assignments) ? sub.assignments : [];
    let matchedAsg = existing.find(a => (a.title || '').toLowerCase() === title.toLowerCase());

    if (!matchedAsg) {
        matchedAsg = {
            id: 'asg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5),
            title: title,
            type: type,
            maxScore: max,
            description: '', // Blank by default, notes are usually student-specific
            instructions: instructions || '', // shown to students in Assignments/Lesson viewer
            date: date,
            completed: false,
            createdAt: new Date().toISOString()
        };

        // PHASE 0: write to wherever this subject actually lives — its own
        // assignments subcollection for a new-model subject, or the legacy
        // embedded array, unchanged, for a legacy one.
        if (sub._source === 'new') {
            await setDoc(doc(db, 'schools', session.schoolId, 'classes', sub.classId, 'subjects', sub.id, 'assignments', matchedAsg.id), matchedAsg);
        } else {
            const subjects = (session.teacherData.subjects || []).map(s => {
                if (s.id !== sub.id) return s;
                return { ...s, assignments: [...existing, matchedAsg] };
            });

            await updateDoc(getTeacherDocRef(session.schoolId, session.teacherId), { subjects });
            session.teacherData.subjects = subjects;
            setSessionData('teacher', session);
        }
        sub.assignments = [...existing, matchedAsg];
    }

    // Update state in memory so the NEXT student graded (or a later visit to
    // this same assignment) uses this established template.
    selectedAssignment = matchedAsg;
    fieldsUnlocked = false;
    applyLockState(); // Visuals update to show the fields are now locked to this template

    return matchedAsg;
}

// ── 8c. POST TO CLASS (DO NOT GRADE YET) ─────────────────────────────────────
// Creates the assignment template (via ensureAssignmentDoc above) so it's
// immediately visible to every student in the class/subject through the
// normal loadAssignmentsForSubjects() path — but writes NO grade record for
// anyone. isSubmissionFrozen() in submissions.js only freezes a submission
// once assignment.locked is true or a grade exists for that student, so an
// assignment with zero grades reads as open/gradable-later on the student
// side with no changes needed there — this button is the only missing half.
async function postAssignmentToClass() {
    if (isSemesterLocked) { alert('This semester is locked.'); return; }

    const subject = document.getElementById('agSubject')?.value || selectedSubject || '';
    const type    = document.getElementById('agType')?.value    || '';
    const title   = document.getElementById('agTitle')?.value.trim() || '';
    const maxEl   = document.getElementById('agMax');
    const max     = maxEl ? parseFloat(maxEl.value) : NaN;
    const dateEl  = document.getElementById('agDate');
    const date    = dateEl ? dateEl.value : new Date().toISOString().split('T')[0];
    const instructionsEl = document.getElementById('agInstructions');
    const instructions   = instructionsEl ? instructionsEl.value.trim() : '';

    if (!subject || !type || !title) { alert('Subject, grade type, and title are required.'); return; }
    if (isNaN(max) || max <= 0) { alert('Please enter a valid max score.'); return; }

    const btn = document.getElementById('postToClassBtn');
    if (btn) {
        btn.disabled  = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Posting...';
    }

    try {
        const posted = await ensureAssignmentDoc({ subject, type, title, max, date, instructions });
        if (!posted) throw new Error('Could not resolve the subject for this assignment.');

        renderAssignmentPicker();
        updateGradingHeader();
        renderRoster();

        // selectedAssignment is now a real (non-manual) template, so the
        // "Post to Class" button/hint should hide — same condition
        // renderState() applies, run directly since we're not re-entering
        // renderState() itself here (the grading panel stays open/visible).
        document.getElementById('postToClassBtn')?.classList.add('hidden');
        document.getElementById('postToClassHint')?.classList.add('hidden');

        document.getElementById('gradeErrorBanner')?.classList.add('hidden');
        // showSavedBanner sets textContent (not innerHTML), so the title goes
        // in raw here — escHtml would leave literal "&amp;"-style entities
        // visible on screen instead of being decoded.
        showSavedBanner(
            `"${title}" was posted to the class.`,
            'Students can see the instructions and submit their work now — grade it here whenever you’re ready.'
        );
    } catch (e) {
        console.error('[Grade Form] postAssignmentToClass:', e);
        showSaveError(e);
    }

    if (btn) {
        btn.disabled  = false;
        btn.innerHTML = '<i class="fa-solid fa-bullhorn text-[11px]"></i> Post to Class (Do Not Grade Yet)';
    }
}

// Shared by both the "grade committed" success path and the new "posted to
// class" path — same banner markup, different message each time. Always
// resets to the grade-commit wording after the timeout so a later real
// grade-commit doesn't inherit a stale "posted to class" message.
function showSavedBanner(title, subtitle) {
    const banner = document.getElementById('gradeSavedBanner');
    const titleEl = document.getElementById('gradeSavedBannerTitle');
    const subtitleEl = document.getElementById('gradeSavedBannerSubtitle');
    if (!banner) return;

    if (titleEl) titleEl.textContent = title;
    if (subtitleEl) subtitleEl.textContent = subtitle;

    banner.classList.remove('hidden');
    clearTimeout(window.__gfBannerTimer);
    window.__gfBannerTimer = setTimeout(() => {
        banner.classList.add('hidden');
        if (titleEl) titleEl.textContent = 'Record committed successfully.';
        if (subtitleEl) subtitleEl.textContent = 'Moved to the next ungraded student.';
    }, 4500);
}

// ── 9. SAVE GRADE (click handler — commits via the shared saveGrade() helper below) ──
async function commitGrade() {
    if (isSemesterLocked) { alert('This semester is locked. Grades are read-only.'); return; }

    const studentId = document.getElementById('agStudent')?.value;
    if (!studentId) { alert('Please select a student from the roster.'); return; }

    const subject = document.getElementById('agSubject')?.value || selectedSubject || '';
    const type    = document.getElementById('agType')?.value    || '';
    const title   = document.getElementById('agTitle')?.value.trim() || 'Untitled Assessment';

    const scoreEl = document.getElementById('agScore');
    const maxEl   = document.getElementById('agMax');
    const score   = scoreEl ? parseFloat(scoreEl.value) : NaN;
    const max     = maxEl   ? parseFloat(maxEl.value)   : NaN;

    const dateEl = document.getElementById('agDate');
    const date   = dateEl ? dateEl.value : new Date().toISOString().split('T')[0];

    const notesEl = document.getElementById('agNotes');
    const notes   = notesEl ? notesEl.value.trim() : '';

    const instructionsEl = document.getElementById('agInstructions');
    const instructions   = instructionsEl ? instructionsEl.value.trim() : '';

    const semId = activeSemId || (rawSemesters[0]?.id || '');

    if (!subject || !type || !title) { alert('Subject, grade type, and title are required.'); return; }
    if (isNaN(score) || isNaN(max) || max <= 0 || score < 0 || score > max) {
        alert('Please enter valid score and max values.'); return;
    }

    const student   = teacherStudents.find(s => s.id === studentId);
    const className = student?.className || '';

    const btn = document.getElementById('saveGradeBtn');
    if (btn) {
        btn.disabled  = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Committing...';
    }

    try {
        // ── CONVERT MANUAL ENTRY TO PREPARED ASSIGNMENT ───────────────────
        // Shared with postAssignmentToClass() — see ensureAssignmentDoc()
        // above. A no-op if selectedAssignment is already a real (non-manual)
        // assignment, same as before this was extracted.
        if (selectedAssignment && selectedAssignment.manual) {
            await ensureAssignmentDoc({ subject, type, title, max, date, instructions });
        }
        // ──────────────────────────────────────────────────────────────────

        const fields = {
            schoolId:   session.schoolId,
            teacherId:  session.teacherId,
            semesterId: semId,
            className,
            subject,
            type,
            date,
            title,
            score,
            max,
            notes,
        };
        // PHASE 1 MILESTONE 5: assignmentId is the re-grade key — saveGrade()
        // updates the existing grade doc (appending to historyLogs) instead of
        // creating a duplicate whenever one already exists for this student +
        // assignment. A manual entry with no matched/created template (sub not
        // found) has no assignmentId and is always a fresh create, same as before.
        const assignmentId = (selectedAssignment && !selectedAssignment.manual && selectedAssignment.id) || null;
        const result = await saveGrade(studentId, assignmentId, fields);

        // PHASE 4: lock the submission's status to "graded" once its grade is
        // committed — separate from, and never blocking, the grade write
        // above (that saveGrade() call is already the one source of truth
        // for the student's score). Gated on currentSubmission actually
        // matching this exact student+assignment pairing (via
        // currentSubmissionRequestToken) so a fetch still in flight, or one
        // left over from a student the teacher already moved away from,
        // can never mark the wrong submission graded.
        if (assignmentId && isAssessmentAssignment(selectedAssignment) && currentSubmission &&
            currentSubmissionRequestToken === `${assignmentId}:${studentId}`) {
            try {
                const gradedSub = getSubjectByName(subject);
                const gradedCtx = gradedSub ? resolvePostContext(gradedSub, resolvedClassesCache) : null;
                if (gradedCtx) {
                    await updateDoc(
                        doc(db, 'schools', session.schoolId, 'classes', gradedCtx.classId, 'subjects', gradedCtx.subjectId, 'assignments', assignmentId, 'submissions', studentId),
                        { status: 'graded' }
                    );
                    currentSubmission.status = 'graded'; // keep the in-memory copy consistent if the panel re-renders before a fresh fetch
                }
            } catch (e) {
                // Non-fatal: the grade itself already committed successfully
                // above. Failing to also flip the submission's status just
                // means it may still read "submitted" instead of "graded"
                // until the next successful commit — logged rather than
                // shown as a save error, since the actual grade record is
                // fine.
                console.error('[Grade Form] Failed to update submission status to graded:', e);
            }
        }

        // Update local term cache so the roster reflects this immediately.
        // On a re-grade (result.created === false) this REPLACES the existing
        // cache entry in place rather than appending a second one, so
        // isStudentGraded() / the roster progress counts don't double-count
        // this student.
        const cacheRecord = { id: result.id, studentId, ...fields };
        if (assignmentId) cacheRecord.assignmentId = assignmentId;
        const existingIdx = allGradesThisTerm.findIndex(g => g.id === result.id);
        if (existingIdx >= 0) allGradesThisTerm[existingIdx] = cacheRecord;
        else allGradesThisTerm.push(cacheRecord);

        // Clear ONLY score + notes; keep subject/assignment/title/type/max for the next student
        if (scoreEl) scoreEl.value = '';
        if (notesEl) notesEl.value = '';
        document.getElementById('gradePreview')?.classList.add('hidden');

        // Refresh roster + header, then auto-advance to next ungraded student
        renderRoster();
        updateGradingHeader();
        advanceToNextUngraded(studentId);

        document.getElementById('gradeErrorBanner')?.classList.add('hidden');
        showSavedBanner('Record committed successfully.', 'Moved to the next ungraded student.');

    } catch (e) {
        console.error('Save Error:', e);
        showSaveError(e);
    }

    if (btn) {
        btn.disabled  = false;
        btn.innerHTML = '<i class="fa-solid fa-database mr-2 text-xs"></i> Commit & Next';
    }
}

// ── SAVE ERROR BANNER ─────────────────────────────────────────────────────
// A failed grade write must never fail silently — the old behavior here was
// a blocking window.alert(), which (a) halts all page script execution
// while it's up, so a teacher who dismisses it without reading it sees the
// form return to a normal-looking, re-enabled state with no lasting record
// anything went wrong, and (b) gives no indication of WHAT failed. This
// shows a persistent, visible, in-page banner instead — it stays up until
// the teacher closes it or successfully saves — and tailors the message to
// the most common real causes so a config/permissions problem (which only
// an admin/engineer can fix) reads differently from a transient network
// hiccup (which is worth just retrying).
function showSaveError(e) {
    const banner = document.getElementById('gradeErrorBanner');
    const detail = document.getElementById('gradeErrorDetail');
    if (!banner) { alert('System error. Could not commit record.'); return; } // last-resort fallback if the banner markup is missing
    document.getElementById('gradeSavedBanner')?.classList.add('hidden');

    let message = 'The record was not committed. Please try again or contact support.';
    const code = e?.code || '';
    const text = `${code} ${e?.message || ''}`.toLowerCase();

    if (code === 'permission-denied' || text.includes('permission')) {
        message = 'You do not have permission to save this grade. Contact your school administrator.';
    } else if (text.includes('requires an index') || text.includes('requires a') && text.includes('index')) {
        message = 'This save failed because of a missing database configuration (index). This grade was NOT recorded — please notify support before re-entering it.';
    } else if (code === 'unavailable' || text.includes('network') || text.includes('offline')) {
        message = 'Connection error — the grade was not saved. Check your connection and try again.';
    }

    if (detail) detail.textContent = message;
    banner.classList.remove('hidden');
    banner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function advanceToNextUngraded(justGradedId) {
    const students = rosterStudents();
    const title = selectedAssignment.manual
        ? document.getElementById('agTitle').value.trim()
        : selectedAssignment.title;

    // find next ungraded after the one we just graded; wrap around if needed
    const startIdx = students.findIndex(s => s.id === justGradedId);
    let next = null;
    for (let i = 1; i <= students.length; i++) {
        const cand = students[(startIdx + i) % students.length];
        if (!isStudentGraded(cand.id, selectedSubject, title)) { next = cand; break; }
    }

    const select = document.getElementById('agStudent');
    if (next) {
        if (select) select.value = next.id;
    } else {
        // everyone graded — clear selection
        if (select) select.value = '';
    }
    renderRoster();
    refreshSubmissionPanel();
}

// ── 10. MARK AS GRADED (closes the assignment) ──────────────────────────────
window.markAssignmentGraded = async function() {
    if (!selectedAssignment || selectedAssignment.manual) return;
    const sub = getSubjectByName(selectedSubject);
    if (!sub) return;

    const btn = document.getElementById('gfMarkGradedBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Saving…'; }

    try {
        if (sub._source === 'new') {
            await updateDoc(doc(db, 'schools', session.schoolId, 'classes', sub.classId, 'subjects', sub.id, 'assignments', selectedAssignment.id), { completed: true });
            sub.assignments = (sub.assignments || []).map(a => a.id === selectedAssignment.id ? { ...a, completed: true } : a);
        } else {
            const subjects = (session.teacherData.subjects || []).map(s => {
                if (s.id !== sub.id) return s;
                const existing = Array.isArray(s.assignments) ? s.assignments : [];
                return {
                    ...s,
                    assignments: existing.map(a => a.id === selectedAssignment.id ? { ...a, completed: true } : a)
                };
            });

            await updateDoc(getTeacherDocRef(session.schoolId, session.teacherId), { subjects });
            session.teacherData.subjects = subjects;
            setSessionData('teacher', session);
            sub.assignments = subjects.find(s => s.id === sub.id)?.assignments || [];
        }

        // assignment is now complete → return to the assignment picker for this subject
        selectedAssignment = null;
        fieldsUnlocked = false;
        renderAssignmentPicker();
        renderState();
    } catch (e) {
        console.error('[Grade Form] markAssignmentGraded:', e);
        alert('Could not mark as graded. Please try again.');
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-check mr-1"></i> Mark as graded'; }
    }
};
