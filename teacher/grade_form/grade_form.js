import { db } from '../../assets/js/firebase-init.js';
import { doc, getDoc, getDocs, addDoc, collection, query, where, updateDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth, setSessionData } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { letterGrade } from '../../assets/js/utils.js';

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

const DEFAULT_GRADE_TYPES = ['Test', 'Quiz', 'Assignment', 'Homework', 'Project', 'Midterm Exam', 'Final Exam'];

// ── HELPERS ─────────────────────────────────────────────────────────────────
function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function getTeacherRef() {
    return /^T\d{2}-[A-Z0-9]{5}$/i.test(session.teacherId)
        ? doc(db, 'teachers', session.teacherId)
        : doc(db, 'schools', session.schoolId, 'teachers', session.teacherId);
}

function getActiveSubjects() {
    return (session.teacherData.subjects || []).filter(s => !s.archived);
}
function getSubjectByName(name) {
    return getActiveSubjects().find(s => s.name === name) || null;
}
function getGradeTypes() {
    return session.teacherData.customGradeTypes || session.teacherData.gradeTypes || DEFAULT_GRADE_TYPES;
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
    if (commitBtn) commitBtn.addEventListener('click', saveGrade);

    const closeBannerBtn = document.getElementById('closeBannerBtn');
    if (closeBannerBtn) closeBannerBtn.addEventListener('click', () => {
        document.getElementById('gradeSavedBanner')?.classList.add('hidden');
    });

    await loadSemesters();
    await loadStudents();
    await loadAllGradesThisTerm();

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

    const assignmentButtons = assignments.length
        ? assignments.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).map(a => `
            <button type="button" onclick="selectAssignment('${a.id}')"
                class="gf-asg-btn text-left bg-white border border-[#dce3ed] rounded-sm p-4 hover:border-[#0ea871] hover:shadow-md transition focus:outline-none focus:ring-2 focus:ring-[#0ea871]">
                <div class="flex items-center justify-between gap-2 mb-1">
                    <p class="font-bold text-[#0d1f35] text-[13px] truncate">${escHtml(a.title)}</p>
                    <span class="text-[10px] font-bold text-[#6b84a0] bg-[#f8fafb] border border-[#dce3ed] px-2 py-0.5 rounded-sm flex-shrink-0">/ ${a.maxScore}</span>
                </div>
                <div class="flex items-center gap-2">
                    <span class="text-[10px] font-bold uppercase tracking-widest text-[#0ea871] bg-[#edfaf4] border border-[#c6f0db] px-2 py-0.5 rounded-sm">${escHtml(a.type)}</span>
                    ${a.date ? `<span class="text-[10px] text-[#9ab0c6] font-semibold"><i class="fa-regular fa-calendar mr-1"></i>${escHtml(a.date)}</span>` : ''}
                </div>
            </button>`).join('')
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

    applyLockState();
    updatePreview();
};

// ── 6c. LOCK / UNLOCK FIELDS ─────────────────────────────────────────────────
function applyLockState() {
    const locked = selectedAssignment && !selectedAssignment.manual && !fieldsUnlocked;
    const titleEl = document.getElementById('agTitle');
    const typeEl  = document.getElementById('agType');
    const maxEl   = document.getElementById('agMax');

    [titleEl, typeEl, maxEl].forEach(el => {
        if (!el) return;
        el.readOnly = locked && el.tagName === 'INPUT';
        el.disabled = locked && el.tagName === 'SELECT';
        el.classList.toggle('gf-locked', locked);
    });

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

// ── 9. SAVE GRADE ─────────────────────────────────────────────────────────
async function saveGrade() {
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
        // ── NEW: CONVERT MANUAL ENTRY TO PREPARED ASSIGNMENT ──────────────
        if (selectedAssignment && selectedAssignment.manual) {
            const sub = getSubjectByName(subject);
            if (sub) {
                const existing = Array.isArray(sub.assignments) ? sub.assignments : [];
                let matchedAsg = existing.find(a => (a.title || '').toLowerCase() === title.toLowerCase());
                
                // If it doesn't exist yet, build it identically to the Subjects page generator
                if (!matchedAsg) {
                    matchedAsg = {
                        id: 'asg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5),
                        title: title,
                        type: type,
                        maxScore: max,
                        description: '', // Blank by default, notes are usually student-specific
                        date: date,
                        completed: false,
                        createdAt: new Date().toISOString()
                    };
                    
                    const subjects = (session.teacherData.subjects || []).map(s => {
                        if (s.id !== sub.id) return s;
                        return { ...s, assignments: [...existing, matchedAsg] };
                    });

                    await updateDoc(getTeacherRef(), { subjects });
                    session.teacherData.subjects = subjects;
                    setSessionData('teacher', session);
                }
                
                // Update state in memory so the NEXT student graded uses this established template
                selectedAssignment = matchedAsg;
                fieldsUnlocked = false; 
                applyLockState(); // Visuals update to show the fields are now locked to this template
            }
        }
        // ──────────────────────────────────────────────────────────────────

        const record = {
            schoolId:    session.schoolId,
            teacherId:   session.teacherId,
            semesterId:  semId,
            className,
            subject,
            type,
            date,
            title,
            score,
            max,
            notes,
            historyLogs: [],
            createdAt:   new Date().toISOString()
        };
        // Stamp the assignment id for future-proofing when grading from a prepared assignment
        if (selectedAssignment && !selectedAssignment.manual && selectedAssignment.id) {
            record.assignmentId = selectedAssignment.id;
        }

        const ref = await addDoc(collection(db, 'students', studentId, 'grades'), record);

        // Update local term cache so the roster reflects this immediately
        allGradesThisTerm.push({ id: ref.id, studentId, ...record });

        // Clear ONLY score + notes; keep subject/assignment/title/type/max for the next student
        if (scoreEl) scoreEl.value = '';
        if (notesEl) notesEl.value = '';
        document.getElementById('gradePreview')?.classList.add('hidden');

        // Refresh roster + header, then auto-advance to next ungraded student
        renderRoster();
        updateGradingHeader();
        advanceToNextUngraded(studentId);

        const banner = document.getElementById('gradeSavedBanner');
        if (banner) {
            banner.classList.remove('hidden');
            clearTimeout(window.__gfBannerTimer);
            window.__gfBannerTimer = setTimeout(() => banner.classList.add('hidden'), 3500);
        }

    } catch (e) {
        console.error('Save Error:', e);
        alert('System error. Could not commit record.');
    }

    if (btn) {
        btn.disabled  = false;
        btn.innerHTML = '<i class="fa-solid fa-database mr-2 text-xs"></i> Commit & Next';
    }
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
        const subjects = (session.teacherData.subjects || []).map(s => {
            if (s.id !== sub.id) return s;
            const existing = Array.isArray(s.assignments) ? s.assignments : [];
            return {
                ...s,
                assignments: existing.map(a => a.id === selectedAssignment.id ? { ...a, completed: true } : a)
            };
        });

        await updateDoc(getTeacherRef(), { subjects });
        session.teacherData.subjects = subjects;
        setSessionData('teacher', session);

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
