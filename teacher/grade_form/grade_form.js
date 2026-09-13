import { db } from '../../assets/js/firebase-init.js';
import { doc, getDoc, getDocs, setDoc, collection, query, where, updateDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth, setSessionData } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { letterGrade, loadTeacherSubjectsCache, getTeacherDocRef, resolveGradeWeights, saveGrade } from '../../assets/js/utils.js';

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

// PHASE 0: resolved once at init via resolveGradeWeights() — preferring the
// new schools/{schoolId}/teaching_assignments weighting over the legacy
// gradeTypes/customGradeTypes fields. Only feeds the grade-type dropdown
// (a display concern), so a once-per-load resolve is correct here.
let resolvedGradeTypes = null;

const DEFAULT_GRADE_TYPES = ['Test', 'Quiz', 'Assignment', 'Homework', 'Project', 'Midterm Exam', 'Final Exam'];

// ── HELPERS ─────────────────────────────────────────────────────────────────
function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
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
                    ${a.date ? `<span class="text-[10px] text-[#9ab0c6] font-semibold"><i class="fa-regular fa-calendar mr-1"></i>Due ${escHtml(a.date)}</span>` : ''}
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

window.pickStudent = function(studentId) {
    const select = document.getElementById('agStudent');
    if (select) select.value = studentId;
    renderRoster(); // refresh active highlight
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

// ═════════════  "ADD WORK" MODAL — SHELL ONLY (Step 1 of rebuild)  ═════════════
// Open/close + metadata population + type-selector presentation only.
// Deliberately NO save/publish wiring and NO dynamic question/attachment
// builder here — #awSaveDraftBtn and #awPublishBtn stay disabled in the HTML
// until that engine is built and explicitly authorized in a later step.

const AW_ASSESSMENT_TYPES = ['Test', 'Quiz', 'Midterm Exam', 'Final Exam'];
const AW_STANDARD_TYPES = ['Assignment', 'Homework', 'Project'];

function populateAddWorkSubjects() {
    const sel = document.getElementById('awSubject');
    if (!sel) return;
    const subjects = getActiveSubjects();
    sel.innerHTML = '<option value="">Select subject…</option>' +
        subjects.map(s => `<option value="${escHtml(s.name)}">${escHtml(s.name)}</option>`).join('');
    // Default to whatever subject the teacher already has open in the picker, if any.
    if (selectedSubject && subjects.some(s => s.name === selectedSubject)) {
        sel.value = selectedSubject;
    }
}

window.openAddWorkModal = function() {
    const overlay = document.getElementById('addWorkModalOverlay');
    if (!overlay) return;
    populateAddWorkSubjects();
    overlay.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
};

window.closeAddWorkModal = function() {
    const overlay = document.getElementById('addWorkModalOverlay');
    if (!overlay) return;
    overlay.classList.add('hidden');
    document.body.style.overflow = '';
};

window.handleAddWorkTypeChange = function() {
    const type = document.getElementById('awType')?.value || '';
    const placeholder = document.getElementById('addWorkBuilderPlaceholder');
    if (!placeholder) return;

    if (AW_ASSESSMENT_TYPES.includes(type)) {
        placeholder.innerHTML = '<i class="fa-solid fa-list-check mr-1.5"></i>Question builder (multiple choice, free response/short answer, math, attachment-photo-drawing response) loads here in the next build step.';
    } else if (AW_STANDARD_TYPES.includes(type)) {
        placeholder.innerHTML = '<i class="fa-solid fa-paperclip mr-1.5"></i>Instruction attachments (PDF/image/video) and a student submission block load here in the next build step.';
    } else {
        placeholder.innerHTML = '<i class="fa-solid fa-arrow-up mr-1.5"></i>Select a type above to build this assignment.';
    }
};
