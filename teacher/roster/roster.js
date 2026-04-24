import { db } from '../../assets/js/firebase-init.js';
import { collection, query, where, getDocs, getDoc, doc, updateDoc, addDoc, setDoc, arrayUnion } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth, setSessionData } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { openOverlay, closeOverlay, showMsg, gradeColorClass, standingBadge, standingText, gradeFill, letterGrade, downloadCSV } from '../../assets/js/utils.js';

// ── 1. AUTH & LAYOUT ─────────────────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    injectTeacherLayout('students', 'My Roster', 'Manage students · PINs · academic standing', true);
}

// ── 2. STATE & HELPERS ───────────────────────────────────────────────────────
let allStudentsCache        = [];
let unassignedStudentsCache = [];
let studentMap              = {};
let currentStudentId        = null;
let currentStudentGradesCache = [];
let rawSemesters            = [];
let isSemesterLocked        = false;
let gradeDetailCache        = {};
let schoolLimit             = 50;

const DEFAULT_GRADE_TYPES = ['Test', 'Quiz', 'Assignment', 'Homework', 'Project', 'Midterm Exam', 'Final Exam'];

function getClasses()        { return session.teacherData.classes || [session.teacherData.className || '']; }
function getActiveSubjects() { return (session.teacherData.subjects || []).filter(s => !s.archived); }
function getGradeTypes()     { return session.teacherData.customGradeTypes || DEFAULT_GRADE_TYPES; }

// ── CHANGED: cleaned charset, no ambiguous chars ──────────────────────────────
function generateStudentId() {
    const year  = new Date().getFullYear().toString().slice(-2);
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let rand = '';
    for (let i = 0; i < 5; i++) rand += chars.charAt(Math.floor(Math.random() * chars.length));
    return `S${year}-${rand}`;
}

// ── 3. INIT ───────────────────────────────────────────────────────────────────
async function init() {
    if (!session) return;

    const searchInput = document.getElementById('searchInput');
    if (searchInput) searchInput.addEventListener('input', filterStudents);

    document.getElementById('displayTeacherName').textContent = session.teacherData.name;
    document.getElementById('teacherAvatar').textContent      = session.teacherData.name.charAt(0).toUpperCase();
    document.getElementById('sidebarSchoolId').textContent    = session.schoolId;
    document.getElementById('displayTeacherClasses').innerHTML =
        getClasses().filter(Boolean).map(c => `<span class="class-pill">${c}</span>`).join('');

    const classes     = getClasses().filter(Boolean);
    const classFilter = document.getElementById('rf-class');
    if (classFilter) {
        classFilter.innerHTML = '<option value="">All Classes</option>' +
            classes.map(c => `<option value="${c}">${c}</option>`).join('');
        if (classes.length <= 1) {
            const wrap = document.getElementById('classFilterWrap');
            if (wrap) wrap.style.display = 'none';
        }
    }

    await Promise.all([fetchSchoolLimit(), loadSemesters()]);
    await loadStudents();
}

// ── 4. SCHOOL PLAN LIMIT ──────────────────────────────────────────────────────
async function fetchSchoolLimit() {
    try {
        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        if (schoolSnap.exists()) {
            const planId   = schoolSnap.data().subscriptionPlan || 'starter';
            const planSnap = await getDoc(doc(db, 'subscriptionPlans', planId));
            if (planSnap.exists()) schoolLimit = planSnap.data().limit || 50;
        }
    } catch (e) { console.error('[Roster] fetchSchoolLimit:', e); }
}

// ── 5. SEMESTERS (localStorage cached & UI synced) ───────────────────────────
async function loadSemesters() {
    try {
        const cacheKey = `connectus_semesters_${session.schoolId}`;
        let rawSems    = [];

        const cached = localStorage.getItem(cacheKey);
        if (cached) {
            rawSems = JSON.parse(cached);
        } else {
            const semSnap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
            rawSems       = semSnap.docs
                .map(d => ({ id: d.id, ...d.data() }))
                .sort((a, b) => (a.order || 0) - (b.order || 0));
            localStorage.setItem(cacheKey, JSON.stringify(rawSems));
        }

        rawSemesters = rawSems;

        let activeId = '';
        try {
            const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
            activeId = schoolSnap.data()?.activeSemesterId || '';
        } catch(e) {}

        const semSel   = document.getElementById('activeSemester');
        const sbPeriod = document.getElementById('sb-period');

        if (semSel) {
            semSel.innerHTML = '';
            rawSemesters.forEach(s => {
                const opt       = document.createElement('option');
                opt.value       = s.id;
                opt.textContent = s.name;
                if (s.id === activeId) opt.selected = true;
                semSel.appendChild(opt);
            });

            checkLockStatus();

            semSel.addEventListener('change', () => {
                checkLockStatus();
                loadStudents();
                if (sbPeriod) sbPeriod.textContent = semSel.options[semSel.selectedIndex]?.text || '—';
            });
        }

        updatePeriodLabel();

        if (sbPeriod && semSel) {
            sbPeriod.textContent = semSel.options[semSel.selectedIndex]?.text || '—';
        }
    } catch (e) {
        console.error('[Roster] loadSemesters:', e);
    }
}

function updatePeriodLabel() {
    const semSel = document.getElementById('activeSemester');
    const label  = document.getElementById('rosterPeriodLabel');
    if (semSel && label) {
        label.textContent = semSel.options[semSel.selectedIndex]?.text || '—';
    }
}

function checkLockStatus() {
    const semId     = document.getElementById('activeSemester')?.value;
    const activeSem = rawSemesters.find(s => s.id === semId);
    isSemesterLocked = activeSem ? !!activeSem.isLocked : false;

    const badge = document.getElementById('topbarLockedBadge');
    if (badge) {
        if (isSemesterLocked) {
            badge.classList.remove('hidden');
            badge.classList.add('flex');
        } else {
            badge.classList.add('hidden');
            badge.classList.remove('flex');
        }
    }
    updatePeriodLabel();
}

// ── 6. LOAD STUDENTS — GLOBAL QUERY ──────────────────────────────────────────
async function loadStudents() {
    const tbody = document.getElementById('studentsTableBody');
    tbody.innerHTML = `<tr><td colspan="9"><div class="table-loader">
        <i class="fa-solid fa-spinner fa-spin"></i><p>Loading roster…</p>
    </div></td></tr>`;

    try {
        // ── CHANGED: query global /students for active students at this school ──
        const allActSnap = await getDocs(query(
            collection(db, 'students'),
            where('currentSchoolId', '==', session.schoolId),
            where('enrollmentStatus', '==', 'Active')
        ));
        const allActive = allActSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        allStudentsCache        = allActive.filter(s => s.teacherId === session.teacherId);
        unassignedStudentsCache = allActive.filter(s => !s.teacherId || !s.className);

        studentMap = {};
        allStudentsCache.forEach(s => { studentMap[s.id] = s.name; });

        const sbStudents = document.getElementById('sb-students');
        if (sbStudents) sbStudents.textContent = allStudentsCache.length;

        const badge = document.getElementById('rosterCountBadge');
        if (badge) badge.textContent = allStudentsCache.length;

        if (!allStudentsCache.length) {
            tbody.innerHTML = `<tr><td colspan="9">
                <div class="table-loader">
                    <i class="fa-solid fa-user-plus" style="color:#c5d0db;"></i>
                    <p>No students yet — enroll your first student to get started.</p>
                </div>
            </td></tr>`;
            const sbRisk0 = document.getElementById('sb-risk');
            if (sbRisk0) { sbRisk0.textContent = '0'; sbRisk0.classList.remove('is-risk'); }
            localStorage.setItem('connectus_sidebar_stats', JSON.stringify({ students: 0, risk: 0 }));
            return;
        }

        const semId    = document.getElementById('activeSemester')?.value;
        const allGrades = semId ? await fetchAllStudentGrades(semId) : [];

        let riskCount = 0;

        tbody.innerHTML = allStudentsCache.map((s, i) => {
            const sG           = allGrades.filter(g => g.studentId === s.id);
            const subjectCount = new Set(sG.map(g => g.subject)).size;
            const avg          = sG.length
                ? Math.round(sG.reduce((a, g) => a + (g.max ? g.score / g.max * 100 : 0), 0) / sG.length)
                : null;

            if (avg !== null && avg < 65) riskCount++;

            const avgDisplay = avg !== null
                ? `<span class="grade-num ${gradeNumClass(avg)}">${avg}%</span>`
                : `<span style="color:#9ab0c6;font-family:'DM Mono',monospace;">—</span>`;

            const stdText  = standingText(avg);
            const stdLabel = standingLabelHtml(avg);

            return `<tr class="trow" data-class="${escHtml(s.className || '')}" data-standing="${stdText}">
                <td style="color:#9ab0c6;font-size:12px;font-family:'DM Mono',monospace;font-weight:500;width:44px;">
                    ${String(i + 1).padStart(2, '0')}
                </td>
                <td>
                    <div class="student-cell">
                        <div class="student-initial">${s.name.charAt(0).toUpperCase()}</div>
                        <div>
                            <span class="student-name">${escHtml(s.name)}</span>
                            <p style="font-size:10px;font-family:'DM Mono',monospace;color:#9ab0c6;margin:1px 0 0;letter-spacing:0.05em;">${s.id}</p>
                        </div>
                    </div>
                </td>
                <td style="font-size:12.5px;font-weight:500;color:#374f6b;">${escHtml(s.className || '—')}</td>
                <td style="font-size:12.5px;color:#6b84a0;font-weight:400;">${escHtml(s.parentPhone || '—')}</td>
                <td><span class="pin-badge">${escHtml(s.pin || '—')}</span></td>
                <td style="text-align:center;">
                    <span class="subject-count">${subjectCount || '—'}</span>
                </td>
                <td style="text-align:center;">${avgDisplay}</td>
                <td>${stdLabel}</td>
                <td style="text-align:right;">
                    <div style="display:flex;align-items:center;justify-content:flex-end;gap:6px;">
                        <button onclick="quickGradeStudent('${s.id}')"
                                class="row-action-btn row-btn-grade" title="Enter Grade">
                            <i class="fa-solid fa-plus" style="font-size:10px;"></i>
                        </button>
                        <button onclick="openStudentPanel('${s.id}')"
                                class="row-action-btn row-btn-view">
                            <i class="fa-solid fa-eye"></i> View
                        </button>
                    </div>
                </td>
            </tr>`;
        }).join('');

        const sbRisk = document.getElementById('sb-risk');
        if (sbRisk) {
            sbRisk.textContent = riskCount;
            sbRisk.classList.toggle('is-risk', riskCount > 0);
        }

        localStorage.setItem('connectus_sidebar_stats', JSON.stringify({ students: allStudentsCache.length, risk: riskCount }));

        applyRosterFilters();

    } catch (e) {
        console.error('[Roster] loadStudents:', e);
        tbody.innerHTML = `<tr><td colspan="9">
            <div class="table-loader">
                <i class="fa-solid fa-triangle-exclamation" style="color:#dc2626;"></i>
                <p style="color:#dc2626;">Error loading roster. Please refresh the page.</p>
            </div>
        </td></tr>`;
        const sbStudentsErr = document.getElementById('sb-students');
        if (sbStudentsErr) sbStudentsErr.textContent = '0';
        const sbRiskErr = document.getElementById('sb-risk');
        if (sbRiskErr) { sbRiskErr.textContent = '0'; sbRiskErr.classList.remove('is-risk'); }
        localStorage.setItem('connectus_sidebar_stats', JSON.stringify({ students: 0, risk: 0 }));
    }
}

// ── UNCHANGED: grades still written to siloed path by grade_form.js ───────────
async function fetchAllStudentGrades(semId) {
    const all = [];
    await Promise.all(allStudentsCache.map(async s => {
        try {
            const q    = query(
                collection(db, 'schools', session.schoolId, 'students', s.id, 'grades'),
                where('semesterId', '==', semId)
            );
            const snap = await getDocs(q);
            snap.forEach(d => all.push({ id: d.id, studentId: s.id, studentName: s.name, ...d.data() }));
        } catch (e) { /* silent per-student failure */ }
    }));
    return all;
}

// ── 7. STANDING LABEL HELPERS ─────────────────────────────────────────────────
function standingLabelHtml(avg) {
    if (avg === null) return `<span class="standing-label sl-none">No Data</span>`;
    if (avg >= 90)    return `<span class="standing-label sl-excelling"><i class="fa-solid fa-circle-check" style="font-size:9px;"></i>Excelling</span>`;
    if (avg >= 80)    return `<span class="standing-label sl-good"><i class="fa-solid fa-thumbs-up" style="font-size:9px;"></i>Good Standing</span>`;
    if (avg >= 70)    return `<span class="standing-label sl-ontrack"><i class="fa-solid fa-arrow-right" style="font-size:9px;"></i>On Track</span>`;
    if (avg >= 65)    return `<span class="standing-label sl-attention"><i class="fa-solid fa-eye" style="font-size:9px;"></i>Needs Attention</span>`;
    return `<span class="standing-label sl-atrisk"><i class="fa-solid fa-triangle-exclamation" style="font-size:9px;"></i>At Risk</span>`;
}

function gradeNumClass(avg) {
    if (avg >= 90) return 'grade-green';
    if (avg >= 80) return 'grade-blue';
    if (avg >= 70) return 'grade-teal';
    if (avg >= 65) return 'grade-amber';
    return 'grade-red';
}

// ── 8. FILTERS ────────────────────────────────────────────────────────────────
window.applyRosterFilters = function () {
    const fClass    = document.getElementById('rf-class')?.value    || '';
    const fStanding = document.getElementById('rf-standing')?.value || '';

    document.querySelectorAll('#studentsTableBody tr.trow').forEach(r => {
        let show = true;
        if (fClass    && r.dataset.class    !== fClass)    show = false;
        if (fStanding && r.dataset.standing !== fStanding) show = false;
        r.dataset.hiddenByFilter = !show;
        r.style.display = show ? '' : 'none';
    });
    filterStudents();
};

function filterStudents() {
    const term = (document.getElementById('searchInput')?.value || '').toLowerCase();
    document.querySelectorAll('#studentsTableBody tr.trow').forEach(r => {
        if (r.dataset.hiddenByFilter !== 'true') {
            r.style.display = r.textContent.toLowerCase().includes(term) ? '' : 'none';
        }
    });
}

window.quickGradeStudent = function (studentId) {
    if (isSemesterLocked) { alert('The current grading period is locked.'); return; }
    localStorage.setItem('connectus_quick_grade_student', studentId);
    window.location.assign('../grade_form/grade_form.html');
};

// ── 9. ENROLL / CLAIM STUDENT — SEARCH-FIRST FLOW ────────────────────────────
window.openAddStudentModal = function () {
    // Reset search area
    const searchQ = document.getElementById('sSearchQuery');
    const searchR = document.getElementById('sSearchResults');
    if (searchQ) searchQ.value = '';
    if (searchR) { searchR.innerHTML = ''; searchR.classList.add('hidden'); }

    // Reset create form fields
    ['sName', 'sParentPhone', 'sParentName', 'sDob'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    document.getElementById('addStudentMsg').classList.add('hidden');

    // Populate class dropdown
    const classes = getClasses().filter(Boolean);
    const sel     = document.getElementById('sClass');
    sel.innerHTML = '<option value="">— Select a Class —</option>' +
        classes.map(c => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join('');

    openOverlay('addStudentModal', 'addStudentModalInner');
};

window.closeAddStudentModal = function () { closeOverlay('addStudentModal', 'addStudentModalInner'); };

// ── Stub: no longer used but kept to avoid errors from any cached calls ───────
window.toggleAddMethod = function () {};

// ── SEARCH NATIONAL REGISTRY ──────────────────────────────────────────────────
window.searchStudentRegistry = async function () {
    const searchTerm = (document.getElementById('sSearchQuery')?.value || '').trim();
    if (!searchTerm) { alert('Enter a name or Global ID to search.'); return; }

    const resultsDiv = document.getElementById('sSearchResults');
    resultsDiv.innerHTML = `<div style="padding:14px;text-align:center;color:#9ab0c6;font-size:12px;">
        <i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i>Searching National Registry…
    </div>`;
    resultsDiv.classList.remove('hidden');

    const btn = document.getElementById('sSearchBtn');
    btn.textContent = '…';
    btn.disabled    = true;

    try {
        let students = [];
        const idPattern = /^S\d{2}-[A-Z0-9]{5}$/i;

        if (idPattern.test(searchTerm.replace(/\s/g, ''))) {
            // ── Exact ID lookup ────────────────────────────────────────────
            const snap = await getDoc(doc(db, 'students', searchTerm.toUpperCase()));
            if (snap.exists()) students = [{ id: snap.id, ...snap.data() }];
        } else {
            // ── Name prefix search across global registry ──────────────────
            const snap = await getDocs(query(
                collection(db, 'students'),
                where('name', '>=', searchTerm),
                where('name', '<=', searchTerm + '\uf8ff')
            ));
            students = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        }

        if (!students.length) {
            resultsDiv.innerHTML = `<div style="padding:14px;text-align:center;color:#9ab0c6;font-size:12px;">
                No students found. Fill in the form below to create a new identity.
            </div>`;
            btn.textContent = 'Search';
            btn.disabled    = false;
            return;
        }

        resultsDiv.innerHTML = students.map(s => {
            const alreadyHere  = s.currentSchoolId === session.schoolId && s.teacherId === session.teacherId;
            const atThisSchool = s.currentSchoolId === session.schoolId;
            const statusLabel  = alreadyHere  ? 'Already in your roster'
                               : atThisSchool ? 'At this school — unassigned'
                               : s.currentSchoolId ? 'At another school'
                               : 'Not currently enrolled';
            const statusColor  = alreadyHere  ? '#9ab0c6' : atThisSchool ? '#0ea871' : '#374f6b';
            const canClaim     = !alreadyHere;

            return `<div style="padding:12px 16px;border-bottom:1px solid #f0f4f8;display:flex;align-items:center;justify-content:space-between;gap:10px;">
                <div style="flex:1;min-width:0;">
                    <p style="font-weight:700;color:#0d1f35;font-size:13px;margin:0 0 1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                        ${escHtml(s.name)}
                    </p>
                    <p style="font-size:10.5px;font-family:'DM Mono',monospace;color:#9ab0c6;margin:0 0 2px;">${s.id}</p>
                    <p style="font-size:10.5px;color:${statusColor};font-weight:600;margin:0;">
                        ${s.dob ? 'DOB: ' + s.dob + ' · ' : ''}${statusLabel}
                    </p>
                </div>
                ${canClaim ? `
                <button onclick="window.claimSearchedStudent('${s.id}')"
                        style="padding:6px 14px;background:#0ea871;border:none;border-radius:3px;
                               color:#fff;font-size:11.5px;font-weight:700;font-family:inherit;
                               cursor:pointer;white-space:nowrap;flex-shrink:0;">
                    Claim
                </button>` : `
                <span style="font-size:11px;color:#9ab0c6;font-weight:600;white-space:nowrap;flex-shrink:0;">
                    In Roster
                </span>`}
            </div>`;
        }).join('');

    } catch (e) {
        console.error('[Roster] searchStudentRegistry:', e);
        resultsDiv.innerHTML = `<div style="padding:14px;text-align:center;color:#dc2626;font-size:12px;">
            Search failed. Try again.
        </div>`;
    }

    btn.textContent = 'Search';
    btn.disabled    = false;
};

// ── CLAIM STUDENT FROM SEARCH RESULTS ─────────────────────────────────────────
window.claimSearchedStudent = async function (studentId) {
    const classVal = document.getElementById('sClass').value;
    if (!classVal) {
        alert('Please select a class from the "Assign to Class" dropdown first, then claim.');
        return;
    }

    const btn = document.querySelector(`button[onclick="window.claimSearchedStudent('${studentId}')"]`);
    if (btn) { btn.textContent = '…'; btn.disabled = true; }

    try {
        await updateDoc(doc(db, 'students', studentId), {
            currentSchoolId:  session.schoolId,
            teacherId:        session.teacherId,
            className:        classVal,
            enrollmentStatus: 'Active'
        });
        window.closeAddStudentModal();
        await loadStudents();
    } catch (e) {
        console.error('[Roster] claimSearchedStudent:', e);
        alert('Error claiming student. Please try again.');
        if (btn) { btn.textContent = 'Claim'; btn.disabled = false; }
    }
};

// ── SAVE NEW STUDENT ──────────────────────────────────────────────────────────
document.getElementById('saveStudentBtn').addEventListener('click', async () => {
    const assignedClass = document.getElementById('sClass').value;
    const btn           = document.getElementById('saveStudentBtn');

    if (!assignedClass) {
        showMsg('addStudentMsg', 'You must assign the student to a class.', true);
        return;
    }

    const name = document.getElementById('sName').value.trim();
    if (!name) {
        showMsg('addStudentMsg', 'Student name is required.', true);
        return;
    }

    btn.textContent = 'Saving…';
    btn.disabled    = true;

    try {
        // ── CHANGED: check limit against global collection ─────────────────
        const countSnap = await getDocs(query(
            collection(db, 'students'),
            where('currentSchoolId', '==', session.schoolId),
            where('enrollmentStatus', '==', 'Active')
        ));
        if (countSnap.size >= schoolLimit) {
            showMsg('addStudentMsg', `School capacity reached (${schoolLimit} max). Contact Admin to upgrade.`, true);
            btn.textContent = 'Save to Roster';
            btn.disabled    = false;
            return;
        }

        // ── CHANGED: setDoc on global /students path with new schema ───────
        const newId = generateStudentId();
        await setDoc(doc(db, 'students', newId), {
            studentIdNum:     newId,
            name,
            dob:              document.getElementById('sDob').value,
            parentName:       document.getElementById('sParentName').value.trim(),
            parentPhone:      document.getElementById('sParentPhone').value.trim(),
            pin:              Math.floor(1000 + Math.random() * 9000).toString(),
            teacherId:        session.teacherId,
            className:        assignedClass,
            currentSchoolId:  session.schoolId,
            enrollmentStatus: 'Active',
            medicalNotes:     '',
            academicHistory:  [],
            createdAt:        new Date().toISOString()
        });

        window.closeAddStudentModal();
        await loadStudents();
    } catch (e) {
        console.error('[Roster] saveStudent:', e);
        showMsg('addStudentMsg', 'Error saving student. Please try again.', true);
    }

    btn.textContent = 'Save to Roster';
    btn.disabled    = false;
});

// ── 10. STUDENT DETAIL PANEL ──────────────────────────────────────────────────
window.openStudentPanel = async function (studentId) {
    currentStudentId = studentId;
    const student    = allStudentsCache.find(s => s.id === studentId);

    document.getElementById('sPanelName').textContent = student?.name || 'Student';
    document.getElementById('sPanelMeta').textContent =
        [student?.className, student?.parentPhone].filter(Boolean).join(' · ') || '—';

    togglePinResetUI(false);
    document.getElementById('spinReadonly').textContent = student?.pin || '—';

    document.getElementById('sPanelLoader').style.display = 'flex';
    document.getElementById('sViewMode').classList.add('hidden');
    document.getElementById('sEditForm').classList.add('hidden');

    const qGBtn = document.getElementById('spQuickGradeBtn2');
    if (qGBtn) {
        if (!isSemesterLocked) {
            qGBtn.style.display = 'inline-flex';
            qGBtn.onclick = () => { window.closeStudentPanel(); window.quickGradeStudent(studentId); };
        } else {
            qGBtn.style.display = 'none';
        }
    }

    openOverlay('studentPanel', 'studentPanelInner');

    // Prefill edit fields
    document.getElementById('editSName').value       = student?.name        || '';
    document.getElementById('editSDob').value        = student?.dob         || '';
    document.getElementById('editSParentName').value = student?.parentName  || '';
    document.getElementById('editSPhone').value      = student?.parentPhone || '';

    // Populate class edit dropdown
    const classSel = document.getElementById('editSClass');
    const classes  = getClasses().filter(Boolean);
    classSel.innerHTML = classes.map(c =>
        `<option value="${escHtml(c)}" ${c === student?.className ? 'selected' : ''}>${escHtml(c)}</option>`
    ).join('');
    classSel.dataset.original = student?.className || '';

    // Reset reason box
    document.getElementById('editSClassReasonWrap').classList.add('hidden');
    document.getElementById('editSClassReason').value = '';

    // Info rows — CHANGED: show global ID (doc id = studentIdNum)
    document.getElementById('sInfoGrid').innerHTML = [
        ['Name',         student?.name         || '—'],
        ['Global ID',    student?.id           || '—'],
        ['Class',        student?.className    || '—'],
        ['DOB',          student?.dob          || '—'],
        ['Parent Name',  student?.parentName   || '—'],
        ['Parent Phone', student?.parentPhone  || '—'],
        ['Enrolled',     student?.createdAt
            ? new Date(student.createdAt).toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' })
            : '—']
    ].map(([label, value]) => `
        <div class="info-row">
            <span class="info-row-label">${label}</span>
            <span class="info-row-value" style="${label === 'Global ID' ? "font-family:'DM Mono',monospace;font-size:11.5px;" : ''}">${escHtml(value)}</span>
        </div>`).join('');

    const semId   = document.getElementById('activeSemester')?.value || '';
    const semName = document.getElementById('activeSemester')?.options[
        document.getElementById('activeSemester')?.selectedIndex
    ]?.text || '';

    document.getElementById('sPanelSemName').textContent = semName;
    document.getElementById('sPanelFilterSubject').value = '';
    document.getElementById('sPanelFilterType').value    = '';

    try {
        // ── UNCHANGED: grades still at siloed path (grade_form writes here) ──
        const gradesSnap = await getDocs(
            collection(db, 'schools', session.schoolId, 'students', studentId, 'grades')
        );
        currentStudentGradesCache = [];
        gradesSnap.forEach(d => {
            const g = { id: d.id, ...d.data() };
            if (g.semesterId === semId) currentStudentGradesCache.push(g);
        });

        const subjSet = [...new Set(currentStudentGradesCache.map(g => g.subject || 'Uncategorized'))].sort();
        document.getElementById('sPanelFilterSubject').innerHTML =
            '<option value="">All Subjects</option>' +
            subjSet.map(s => `<option value="${escHtml(s)}">${escHtml(s)}</option>`).join('');
        document.getElementById('sPanelFilterType').innerHTML =
            '<option value="">All Types</option>' +
            getGradeTypes().map(t => `<option value="${escHtml(t)}">${escHtml(t)}</option>`).join('');

        window.renderStudentGrades();
    } catch (e) {
        console.error('[Roster] openStudentPanel grades:', e);
    }

    document.getElementById('sPanelLoader').style.display = 'none';
    document.getElementById('sViewMode').classList.remove('hidden');
};

window.closeStudentPanel = function () { closeOverlay('studentPanel', 'studentPanelInner'); };

window.renderStudentGrades = function () {
    const fSubj = document.getElementById('sPanelFilterSubject').value;
    const fType = document.getElementById('sPanelFilterType').value;
    const by    = {};

    currentStudentGradesCache.forEach(g => {
        if (fSubj && g.subject !== fSubj) return;
        if (fType && g.type   !== fType)  return;
        const subj = g.subject || 'Uncategorized';
        if (!by[subj]) by[subj] = [];
        by[subj].push(g);
    });

    const container = document.getElementById('subjectAccordions');
    const noG       = document.getElementById('noGradesMsg');
    gradeDetailCache = {};

    if (!Object.keys(by).length) {
        container.innerHTML = '';
        noG.classList.remove('hidden');
        return;
    }

    noG.classList.add('hidden');
    container.innerHTML = Object.entries(by).map(([subject, grades]) => {
        const avg = grades.reduce((a, g) => a + (g.max ? g.score / g.max * 100 : 0), 0) / grades.length;

        const rows = grades
            .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
            .map(g => {
                gradeDetailCache[g.id] = g;
                const pct   = g.max ? Math.round(g.score / g.max * 100) : null;
                const color = pct >= 75 ? '#065f46' : pct >= 65 ? '#78350f' : '#7f1d1d';
                const bgCol = pct >= 90 ? '#dcfce7' : pct >= 80 ? '#dbeafe' : pct >= 70 ? '#ccfbf1' : pct >= 65 ? '#fef3c7' : '#fee2e2';
                const bdCol = pct >= 90 ? '#bbf7d0' : pct >= 80 ? '#bfdbfe' : pct >= 70 ? '#99f6e4' : pct >= 65 ? '#fde68a' : '#fecaca';

                return `<div onclick="window.openAssignmentModal('${g.id}')"
                             style="display:flex;align-items:center;justify-content:space-between;
                                    background:#fff;border:1px solid #e8edf2;border-radius:3px;
                                    padding:10px 14px;cursor:pointer;transition:border-color 0.12s;"
                             onmouseover="this.style.borderColor='#0ea871';this.style.background='#f8fefb'"
                             onmouseout="this.style.borderColor='#e8edf2';this.style.background='#fff'">
                    <div style="flex:1;min-width:0;">
                        <p style="font-size:12.5px;font-weight:600;color:#0d1f35;margin:0 0 2px;
                                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                            ${escHtml(g.title || 'Assessment')}
                        </p>
                        <p style="font-size:11px;color:#9ab0c6;font-weight:400;margin:0;">
                            ${escHtml(g.type || '')}${g.date ? ' · ' + g.date : ''}
                        </p>
                    </div>
                    <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;margin-left:16px;">
                        <span style="font-size:12px;font-weight:600;color:${color};font-family:'DM Mono',monospace;">
                            ${g.score}/${g.max || '?'}
                        </span>
                        <span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:3px;
                                     background:${bgCol};border:1px solid ${bdCol};color:${color};
                                     font-family:'DM Mono',monospace;">
                            ${pct !== null ? pct + '%' : '—'}
                        </span>
                    </div>
                </div>`;
            }).join('');

        const avgRounded = Math.round(avg);
        const hdColor = avgRounded >= 90 ? '#14532d' : avgRounded >= 80 ? '#1e3a8a' : avgRounded >= 70 ? '#134e4a' : avgRounded >= 65 ? '#78350f' : '#7f1d1d';
        const hdBg    = avgRounded >= 90 ? '#dcfce7' : avgRounded >= 80 ? '#dbeafe' : avgRounded >= 70 ? '#ccfbf1' : avgRounded >= 65 ? '#fef3c7' : '#fee2e2';
        const hdBd    = avgRounded >= 90 ? '#bbf7d0' : avgRounded >= 80 ? '#bfdbfe' : avgRounded >= 70 ? '#99f6e4' : avgRounded >= 65 ? '#fde68a' : '#fecaca';

        return `<div style="border:1px solid #dce3ed;border-radius:4px;overflow:hidden;background:#fff;">
            <div onclick="window.toggleAccordion(this)"
                 style="display:flex;align-items:center;justify-content:space-between;
                        padding:13px 16px;cursor:pointer;background:#fff;transition:background 0.12s;"
                 onmouseover="this.style.background='#f8fafb'"
                 onmouseout="this.style.background='#fff'">
                <div style="display:flex;align-items:center;gap:12px;">
                    <div style="width:32px;height:32px;border-radius:4px;background:#0d1f35;
                                color:#fff;font-size:12px;font-weight:700;
                                display:flex;align-items:center;justify-content:center;">
                        ${escHtml(subject.charAt(0))}
                    </div>
                    <div>
                        <p style="font-size:13px;font-weight:700;color:#0d1f35;margin:0;">${escHtml(subject)}</p>
                        <p style="font-size:10.5px;color:#9ab0c6;font-weight:400;margin:0;">
                            ${grades.length} assessment${grades.length !== 1 ? 's' : ''}
                        </p>
                    </div>
                </div>
                <div style="display:flex;align-items:center;gap:10px;">
                    <span style="font-size:11px;font-weight:700;padding:3px 10px;border-radius:3px;
                                 background:${hdBg};border:1px solid ${hdBd};color:${hdColor};
                                 font-family:'DM Mono',monospace;">
                        ${avgRounded}% · ${letterGrade(avg)}
                    </span>
                    <i class="fa-solid fa-chevron-down" style="font-size:11px;color:#9ab0c6;transition:transform 0.2s;"></i>
                </div>
            </div>
            <div class="subject-body open" style="border-top:1px solid #f0f4f8;">
                <div style="padding:10px 12px;background:#f8fafb;display:flex;flex-direction:column;gap:6px;">
                    ${rows}
                </div>
            </div>
        </div>`;
    }).join('');
};

window.toggleAccordion = function (header) {
    const body    = header.nextElementSibling;
    body.classList.toggle('open');
    const chevron = header.querySelector('.fa-chevron-down');
    if (chevron) chevron.style.transform = body.classList.contains('open') ? 'rotate(180deg)' : 'rotate(0)';
};

// ── 11. EDIT STUDENT ──────────────────────────────────────────────────────────
window.toggleStudentEdit = function (show) {
    const form      = document.getElementById('sEditForm');
    const isVisible = show !== undefined ? show : form.classList.contains('hidden');
    form.classList.toggle('hidden', !isVisible);
    document.getElementById('editStudentMsg').classList.add('hidden');
};

window.checkClassChange = function () {
    const sel  = document.getElementById('editSClass');
    const wrap = document.getElementById('editSClassReasonWrap');
    if (sel.value !== sel.dataset.original && sel.dataset.original !== '') {
        wrap.classList.remove('hidden');
    } else {
        wrap.classList.add('hidden');
    }
};

document.getElementById('saveStudentEditBtn').addEventListener('click', async () => {
    const btn           = document.getElementById('saveStudentEditBtn');
    const newClass      = document.getElementById('editSClass').value;
    const originalClass = document.getElementById('editSClass').dataset.original;
    const reason        = document.getElementById('editSClassReason').value.trim();

    if (newClass !== originalClass && originalClass !== '' && !reason) {
        showMsg('editStudentMsg', "You must provide a reason for changing the student's class.", true);
        return;
    }

    btn.textContent = 'Saving…';
    btn.disabled    = true;

    try {
        const u = {
            name:        document.getElementById('editSName').value.trim(),
            dob:         document.getElementById('editSDob').value,
            parentName:  document.getElementById('editSParentName').value.trim(),
            parentPhone: document.getElementById('editSPhone').value.trim(),
            className:   newClass
        };

        if (newClass !== originalClass && originalClass !== '') {
            u.lastClassChangeReason = reason;
            u.lastClassChangeDate   = new Date().toISOString();
        }

        // ── CHANGED: update global doc ────────────────────────────────────
        await updateDoc(doc(db, 'students', currentStudentId), u);

        const idx = allStudentsCache.findIndex(s => s.id === currentStudentId);
        if (idx !== -1) Object.assign(allStudentsCache[idx], u);
        studentMap[currentStudentId] = u.name;

        showMsg('editStudentMsg', 'Changes saved successfully.', false);
        window.toggleStudentEdit(false);
        document.getElementById('sPanelName').textContent = u.name;
        await loadStudents();
    } catch (e) {
        console.error('[Roster] saveStudentEdit:', e);
        showMsg('editStudentMsg', 'Error saving changes.', true);
    }

    btn.textContent = 'Save Changes';
    btn.disabled    = false;
});

// ── 12. PIN ───────────────────────────────────────────────────────────────────
window.togglePinResetUI = function (show) {
    document.getElementById('pinDisplayArea').classList.toggle('hidden',  show);
    document.getElementById('pinEditArea').classList.toggle('hidden',    !show);
    if (show) document.getElementById('inlineNewPin').value = '';
};

window.saveInlinePin = async function () {
    const npin = document.getElementById('inlineNewPin').value.trim();
    if (!npin || npin.length < 4) { alert('PIN must be 4–6 digits.'); return; }

    const btn = document.getElementById('inlinePinSaveBtn');
    btn.textContent = '…';
    btn.disabled    = true;

    try {
        // ── CHANGED: update global doc ────────────────────────────────────
        await updateDoc(doc(db, 'students', currentStudentId), { pin: npin });
        const idx = allStudentsCache.findIndex(s => s.id === currentStudentId);
        if (idx !== -1) allStudentsCache[idx].pin = npin;
        document.getElementById('spinReadonly').textContent = npin;
        window.togglePinResetUI(false);
        await loadStudents();
    } catch (e) {
        console.error('[Roster] saveInlinePin:', e);
        alert('Error saving PIN.');
    }

    btn.textContent = 'Save';
    btn.disabled    = false;
};

// ── 13. ASSIGNMENT DETAIL MODAL ───────────────────────────────────────────────
window.openAssignmentModal = function (gradeId) {
    const g = gradeDetailCache[gradeId];
    if (!g) return;

    const pct   = g.max ? Math.round(g.score / g.max * 100) : null;
    const fill  = gradeFill(pct || 0);
    const color = pct >= 90 ? '#065f46' : pct >= 80 ? '#1e3a8a' : pct >= 70 ? '#134e4a' : pct >= 65 ? '#78350f' : '#7f1d1d';
    const bg    = pct >= 90 ? '#dcfce7' : pct >= 80 ? '#dbeafe' : pct >= 70 ? '#ccfbf1' : pct >= 65 ? '#fef3c7' : '#fee2e2';
    const bd    = pct >= 90 ? '#bbf7d0' : pct >= 80 ? '#bfdbfe' : pct >= 70 ? '#99f6e4' : pct >= 65 ? '#fde68a' : '#fecaca';

    document.getElementById('aModalTitle').textContent = g.title || 'Assessment Detail';

    let histHTML = '';
    if (g.historyLogs?.length) {
        histHTML = `<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:4px;padding:14px;margin-top:14px;">
            <p style="font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#78350f;margin:0 0 10px;">
                <i class="fa-solid fa-clock-rotate-left" style="margin-right:4px;"></i>Edit History (${g.historyLogs.length})
            </p>
            <div style="display:flex;flex-direction:column;gap:6px;max-height:120px;overflow-y:auto;">
                ${g.historyLogs.map(l => `
                <div style="font-size:11px;color:#78350f;font-weight:500;background:#fff;
                            border:1px solid #fde68a;border-radius:3px;padding:7px 10px;">
                    ${typeof l === 'object'
                        ? `[${escHtml(l.changedAt)}] ${l.oldScore}/${l.oldMax} → ${l.newScore}/${l.newMax}. ${escHtml(l.reason || '')}`
                        : escHtml(l)}
                </div>`).join('')}
            </div>
        </div>`;
    }

    document.getElementById('aModalBody').innerHTML = `
        <div style="text-align:center;margin-bottom:20px;">
            <div style="font-size:42px;font-weight:700;color:${color};font-family:'DM Mono',monospace;line-height:1;">
                ${g.score}<span style="font-size:20px;color:#9ab0c6;"> / ${g.max || '?'}</span>
            </div>
            ${pct !== null ? `
            <div style="display:flex;align-items:center;justify-content:center;gap:12px;margin-top:8px;">
                <span style="font-size:18px;font-weight:700;color:${color};font-family:'DM Mono',monospace;">${pct}%</span>
                <span style="font-size:14px;font-weight:700;padding:4px 14px;border-radius:3px;background:${bg};border:1px solid ${bd};color:${color};">
                    ${letterGrade(pct)}
                </span>
            </div>
            <div style="margin:12px 20px 0;height:8px;background:#f0f4f8;border-radius:2px;overflow:hidden;">
                <div style="height:100%;width:${Math.min(pct, 100)}%;background:${fill};transition:width 0.5s ease;"></div>
            </div>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;gap:0;margin-bottom:16px;border:1px solid #e8edf2;border-radius:4px;overflow:hidden;">
            ${[['Subject', g.subject || '—'], ['Type', g.type || '—'], ['Date', g.date || '—']].map(([l, v], i) => `
            <div style="display:flex;align-items:center;justify-content:space-between;
                        padding:10px 14px;${i < 2 ? 'border-bottom:1px solid #f0f4f8;' : ''}background:#fff;">
                <span style="font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#9ab0c6;">${l}</span>
                <span style="font-size:13px;font-weight:600;color:#0d1f35;">${escHtml(v)}</span>
            </div>`).join('')}
        </div>
        ${g.notes ? `<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:4px;padding:14px;margin-bottom:14px;">
            <p style="font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#1e3a8a;margin:0 0 6px;">Teacher Notes</p>
            <p style="font-size:12.5px;color:#374f6b;font-weight:400;margin:0;line-height:1.6;white-space:pre-wrap;">${escHtml(g.notes)}</p>
        </div>` : ''}
        ${histHTML}`;

    openOverlay('assignmentModal', 'assignmentModalInner');
};

window.closeAssignmentModal = function () { closeOverlay('assignmentModal', 'assignmentModalInner'); };

// ── 14. ARCHIVE / CLOSE ENROLLMENT ───────────────────────────────────────────
window.archiveStudent = function () {
    const s = allStudentsCache.find(x => x.id === currentStudentId);
    document.getElementById('archiveStudentName').textContent = s ? s.name : 'this student';
    document.getElementById('archiveReasonSelect').value = 'Transferred to another school';
    document.getElementById('archiveReasonOther').value  = '';
    document.getElementById('archiveReasonOther').classList.add('hidden');
    openOverlay('archiveReasonModal', 'archiveReasonModalInner');
};

window.closeArchiveReasonModal = function () { closeOverlay('archiveReasonModal', 'archiveReasonModalInner'); };

document.getElementById('confirmArchiveBtn').addEventListener('click', async () => {
    const sel    = document.getElementById('archiveReasonSelect').value;
    const reason = sel === 'Other' ? document.getElementById('archiveReasonOther').value.trim() : sel;

    const btn = document.getElementById('confirmArchiveBtn');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Archiving…';
    btn.disabled  = true;

    try {
        const s        = allStudentsCache.find(x => x.id === currentStudentId);
        const isTransfer = reason === 'Transferred to another school';
        const newStatus  = reason === 'Graduated' ? 'Graduated' : isTransfer ? 'Transferred' : 'Archived';

        // ── CHANGED: global doc update with snapshot + enrollmentStatus ────
        const snapshot = {
            schoolId:   session.schoolId,
            teacherId:  s?.teacherId  || '',
            className:  s?.className  || '',
            leftAt:     new Date().toISOString(),
            reason:     reason || 'Not specified'
        };

        await updateDoc(doc(db, 'students', currentStudentId), {
            enrollmentStatus: newStatus,
            currentSchoolId:  isTransfer ? '' : session.schoolId,
            teacherId:        '',
            className:        '',
            academicHistory:  arrayUnion(snapshot)
        });

        window.closeArchiveReasonModal();
        window.closeStudentPanel();
        await loadStudents();
    } catch (e) {
        console.error('[Roster] archiveStudent:', e);
        alert('Error archiving student. Please try again.');
    }

    btn.textContent = 'Confirm & Archive';
    btn.disabled    = false;
});

// ── 15. EXPORT / PRINT ────────────────────────────────────────────────────────
window.exportRosterCSV = function () {
    const rows = [['Global ID', 'Name', 'Class', 'Parent Phone', 'Parent PIN']];
    allStudentsCache.forEach((s, i) =>
        rows.push([s.id, s.name, s.className || '', s.parentPhone || '', s.pin])
    );
    downloadCSV(rows, `${session.schoolId}_roster.csv`);
};

window.printRoster = function () {
    const semName = document.getElementById('activeSemester')?.options[
        document.getElementById('activeSemester')?.selectedIndex
    ]?.text || '—';

    const w = window.open('', '_blank');
    w.document.write(`<!DOCTYPE html><html><head>
    <meta charset="UTF-8">
    <title>Class Roster — ${session.teacherData.name}</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'DM Sans', sans-serif; color: #0d1f35; background: #fff; padding: 40px 48px; }
        .print-header { display: flex; flex-direction: column; align-items: center; margin-bottom: 32px; padding-bottom: 24px; border-bottom: 2px solid #0d1f35; }
        .print-logo { max-height: 48px; max-width: 180px; object-fit: contain; margin-bottom: 14px; }
        .print-school { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.14em; color: #6b84a0; margin-bottom: 4px; }
        .print-doc-title { font-size: 18px; font-weight: 700; color: #0d1f35; letter-spacing: -0.3px; margin-bottom: 4px; }
        .print-meta { font-size: 11px; color: #6b84a0; font-weight: 400; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 12px; }
        thead th { padding: 10px 14px; text-align: left; background: #0d1f35; color: #fff; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.12em; }
        tbody tr { border-bottom: 1px solid #e8edf2; }
        tbody tr:nth-child(even) { background: #f8fafb; }
        tbody td { padding: 10px 14px; color: #374f6b; font-size: 12px; }
        tbody td strong { color: #0d1f35; font-weight: 700; }
        .pin { font-family: 'DM Mono', monospace; font-size: 11px; letter-spacing: 0.14em; }
        .footer { margin-top: 40px; padding-top: 14px; border-top: 1px solid #e8edf2; display: flex; justify-content: space-between; align-items: center; }
        .footer p { font-size: 10px; color: #9ab0c6; font-style: italic; }
    </style>
    </head><body>
    <div class="print-header">
        <img src="../../assets/images/logo.png" alt="ConnectUs" class="print-logo" onerror="this.style.display='none'">
        <p class="print-school">ConnectUs · Educational Management Platform</p>
        <p class="print-doc-title">Official Class Roster</p>
        <p class="print-meta">
            Teacher: <strong>${escHtml(session.teacherData.name)}</strong> &nbsp;·&nbsp;
            Period: <strong>${escHtml(semName)}</strong> &nbsp;·&nbsp;
            Printed: ${new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' })}
        </p>
    </div>
    <table>
        <thead>
            <tr>
                <th style="width:40px;">#</th>
                <th>Global ID</th>
                <th>Student Name</th>
                <th>Class</th>
                <th>Parent / Guardian Phone</th>
                <th>Parent PIN</th>
            </tr>
        </thead>
        <tbody>
            ${allStudentsCache.map((s, i) => `
            <tr>
                <td style="font-family:'DM Mono',monospace;color:#9ab0c6;">${String(i + 1).padStart(2, '0')}</td>
                <td style="font-family:'DM Mono',monospace;font-size:11px;">${escHtml(s.id)}</td>
                <td><strong>${escHtml(s.name)}</strong></td>
                <td>${escHtml(s.className || '—')}</td>
                <td>${escHtml(s.parentPhone || '—')}</td>
                <td class="pin">${escHtml(s.pin || '—')}</td>
            </tr>`).join('')}
        </tbody>
    </table>
    <div class="footer">
        <p>Total students: ${allStudentsCache.length} &nbsp;|&nbsp; School ID: ${escHtml(session.schoolId)}</p>
        <p>This document does not constitute an official academic report.</p>
    </div>
    </body></html>`);

    w.document.close();
    setTimeout(() => w.print(), 600);
};

window.openPrintStudentModal = function () {
    const psSubj     = document.getElementById('psSubject');
    const activeSubs = getActiveSubjects();
    psSubj.innerHTML = '<option value="all">All Subjects</option>' +
        activeSubs.map(s => `<option value="${escHtml(s.name)}">${escHtml(s.name)}</option>`).join('');
    openOverlay('printStudentModal', 'printStudentModalInner');
};

window.closePrintStudentModal = function () { closeOverlay('printStudentModal', 'printStudentModalInner'); };

window.executeStudentPrint = async function () {
    const mode       = document.getElementById('psMode').value;
    const subjFilter = document.getElementById('psSubject').value;
    const studentId  = currentStudentId;

    try {
        // ── CHANGED: student doc from global path ─────────────────────────
        const sDoc = await getDoc(doc(db, 'students', studentId));
        if (!sDoc.exists()) { alert('Student not found.'); return; }
        const s = sDoc.data();

        // ── UNCHANGED: grades still at siloed path ────────────────────────
        const gradesSnap = await getDocs(
            collection(db, 'schools', session.schoolId, 'students', studentId, 'grades')
        );
        const grades = [];
        gradesSnap.forEach(d => grades.push(d.data()));

        const bySem = {};
        grades.forEach(g => {
            if (subjFilter !== 'all' && g.subject !== subjFilter) return;
            const sem = rawSemesters.find(sm => sm.id === g.semesterId)?.name || 'Unknown Period';
            const sub = g.subject || 'Uncategorized';
            if (!bySem[sem])      bySem[sem]      = {};
            if (!bySem[sem][sub]) bySem[sem][sub] = [];
            bySem[sem][sub].push(g);
        });

        let bodyRows = '';
        if (!Object.keys(bySem).length) {
            bodyRows = `<p style="text-align:center;color:#9ab0c6;padding:40px;font-style:italic;">No grades recorded matching the selected filters.</p>`;
        } else {
            for (const sem in bySem) {
                bodyRows += `<div style="margin-bottom:32px;page-break-inside:avoid;">
                    <div style="background:#0d1f35;color:#fff;padding:8px 14px;font-size:11px;
                                font-weight:700;text-transform:uppercase;letter-spacing:0.1em;
                                margin-bottom:12px;border-radius:2px;">
                        ${escHtml(sem)}
                    </div>
                    <table style="width:100%;border-collapse:collapse;font-size:12px;">`;

                if (mode === 'summary') {
                    bodyRows += `<thead><tr>
                        <th style="padding:8px 12px;background:#f2f5f8;color:#6b84a0;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;text-align:left;border:1px solid #e8edf2;">Subject</th>
                        <th style="padding:8px 12px;background:#f2f5f8;color:#6b84a0;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;text-align:center;border:1px solid #e8edf2;">Assessments</th>
                        <th style="padding:8px 12px;background:#f2f5f8;color:#6b84a0;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;text-align:center;border:1px solid #e8edf2;">Average</th>
                        <th style="padding:8px 12px;background:#f2f5f8;color:#6b84a0;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;text-align:center;border:1px solid #e8edf2;">Grade</th>
                    </tr></thead><tbody>`;
                    let semTotal = 0, semCount = 0;
                    for (const sub in bySem[sem]) {
                        const sGrades = bySem[sem][sub];
                        const avg     = Math.round(sGrades.reduce((a, g) => a + (g.max ? (g.score / g.max) * 100 : 0), 0) / sGrades.length);
                        semTotal += avg; semCount++;
                        bodyRows += `<tr>
                            <td style="padding:9px 12px;border:1px solid #e8edf2;">${escHtml(sub)}</td>
                            <td style="padding:9px 12px;border:1px solid #e8edf2;text-align:center;">${sGrades.length}</td>
                            <td style="padding:9px 12px;border:1px solid #e8edf2;text-align:center;font-family:'DM Mono',monospace;font-weight:700;">${avg}%</td>
                            <td style="padding:9px 12px;border:1px solid #e8edf2;text-align:center;font-weight:700;">${letterGrade(avg)}</td>
                        </tr>`;
                    }
                    const semAvg = Math.round(semTotal / semCount);
                    bodyRows += `<tr style="background:#f8fafb;font-weight:700;">
                        <td colspan="2" style="padding:9px 12px;border:1px solid #e8edf2;text-align:right;font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:#6b84a0;">Period Average</td>
                        <td style="padding:9px 12px;border:1px solid #e8edf2;text-align:center;font-family:'DM Mono',monospace;">${semAvg}%</td>
                        <td style="padding:9px 12px;border:1px solid #e8edf2;text-align:center;">${letterGrade(semAvg)}</td>
                    </tr>`;
                    bodyRows += `</tbody></table></div>`;
                } else {
                    bodyRows += `<thead><tr>
                        <th style="padding:8px 12px;background:#f2f5f8;color:#6b84a0;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;text-align:left;border:1px solid #e8edf2;">Subject</th>
                        <th style="padding:8px 12px;background:#f2f5f8;color:#6b84a0;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;text-align:left;border:1px solid #e8edf2;">Assignment</th>
                        <th style="padding:8px 12px;background:#f2f5f8;color:#6b84a0;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;text-align:left;border:1px solid #e8edf2;">Type</th>
                        <th style="padding:8px 12px;background:#f2f5f8;color:#6b84a0;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;text-align:center;border:1px solid #e8edf2;">Score</th>
                        <th style="padding:8px 12px;background:#f2f5f8;color:#6b84a0;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;text-align:center;border:1px solid #e8edf2;">%</th>
                    </tr></thead><tbody>`;
                    for (const sub in bySem[sem]) {
                        bySem[sem][sub]
                            .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
                            .forEach(g => {
                                const pct = g.max ? Math.round(g.score / g.max * 100) : null;
                                bodyRows += `<tr>
                                    <td style="padding:8px 12px;border:1px solid #e8edf2;">${escHtml(sub)}</td>
                                    <td style="padding:8px 12px;border:1px solid #e8edf2;">
                                        ${escHtml(g.title || '—')}
                                        ${g.date ? `<br><span style="font-size:10px;color:#9ab0c6;">${g.date}</span>` : ''}
                                    </td>
                                    <td style="padding:8px 12px;border:1px solid #e8edf2;">${escHtml(g.type || '—')}</td>
                                    <td style="padding:8px 12px;border:1px solid #e8edf2;text-align:center;font-family:'DM Mono',monospace;">${g.score}/${g.max || '?'}</td>
                                    <td style="padding:8px 12px;border:1px solid #e8edf2;text-align:center;font-weight:700;">${pct !== null ? pct + '%' : '—'}</td>
                                </tr>`;
                            });
                    }
                    bodyRows += `</tbody></table></div>`;
                }
            }
        }

        const w = window.open('', '_blank');
        w.document.write(`<!DOCTYPE html><html><head>
        <meta charset="UTF-8">
        <title>Student Record — ${escHtml(s.name)}</title>
        <style>
            @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap');
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body { font-family: 'DM Sans', sans-serif; color: #0d1f35; background: #fff; padding: 40px 48px; }
            .header { display: flex; flex-direction: column; align-items: center; margin-bottom: 28px; padding-bottom: 22px; border-bottom: 2px solid #0d1f35; }
            .logo { max-height: 48px; max-width: 180px; object-fit: contain; margin-bottom: 12px; }
            .doc-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.16em; color: #6b84a0; margin-bottom: 4px; }
            .doc-title { font-size: 17px; font-weight: 700; color: #0d1f35; margin-bottom: 6px; }
            .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 28px; background: #f8fafb; padding: 18px; border: 1px solid #e8edf2; border-radius: 3px; }
            .info-item label { display: block; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.12em; color: #9ab0c6; margin-bottom: 3px; }
            .info-item span { font-size: 13px; font-weight: 600; color: #0d1f35; }
            .footer { margin-top: 40px; padding-top: 12px; border-top: 1px solid #e8edf2; display: flex; justify-content: space-between; }
            .footer p { font-size: 10px; color: #9ab0c6; font-style: italic; }
        </style>
        </head><body>
        <div class="header">
            <img src="../../assets/images/logo.png" alt="ConnectUs" class="logo" onerror="this.style.display='none'">
            <p class="doc-label">ConnectUs · Official Student Record</p>
            <p class="doc-title">${mode === 'summary' ? 'Academic Report Card' : 'Detailed Grade Transcript'}</p>
            <p style="font-size:11px;color:#6b84a0;">
                Printed ${new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' })}
            </p>
        </div>
        <div class="info-grid">
            <div class="info-item"><label>Student Name</label><span>${escHtml(s.name)}</span></div>
            <div class="info-item"><label>Global ID</label><span style="font-family:'DM Mono',monospace;">${escHtml(studentId)}</span></div>
            <div class="info-item"><label>Class</label><span>${escHtml(s.className || 'Unassigned')}</span></div>
            <div class="info-item"><label>Teacher</label><span>${escHtml(session.teacherData.name)}</span></div>
        </div>
        ${bodyRows}
        <div class="footer">
            <p>School ID: ${escHtml(session.schoolId)}</p>
            <p>This document does not constitute an official academic report card.</p>
        </div>
        </body></html>`);

        w.document.close();
        window.closePrintStudentModal();
        setTimeout(() => w.print(), 600);

    } catch (e) {
        console.error('[Roster] executeStudentPrint:', e);
        alert('Error generating print report.');
    }
};

// ── 16. XSS PROTECTION ───────────────────────────────────────────────────────
function escHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ── FIRE ──────────────────────────────────────────────────────────────────────
init();
