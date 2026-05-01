import { db } from '../../assets/js/firebase-init.js';
import { collection, query, where, getDocs, getDoc, doc, updateDoc, addDoc, setDoc, arrayUnion, writeBatch } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { openOverlay, closeOverlay, showMsg, gradeColorClass, standingBadge, standingText, gradeFill, letterGrade, downloadCSV, calculateWeightedAverage } from '../../assets/js/utils.js';

// ── 1. AUTH & LAYOUT ─────────────────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    injectTeacherLayout('students', 'My Roster', 'Manage students · PINs · academic standing', true);
}

// ── 2. STATE ─────────────────────────────────────────────────────────────────
let allStudentsCache        = [];
let unassignedStudentsCache = [];
let studentMap              = {};
let currentStudentId        = null;
let currentStudentGradesCache = [];
let rawSemesters            = [];
let isSemesterLocked        = false;
let gradeDetailCache        = {};
let schoolLimit             = 50;
let cachedEvaluations       = [];

const DEFAULT_GRADE_TYPES = ['Test', 'Quiz', 'Assignment', 'Homework', 'Project', 'Midterm Exam', 'Final Exam'];

// Star ratings for the regular eval modal (behavioral, end-of-year, academic progress)
window.evalRatings = {
    academicMastery: 0, taskExecution: 0, engagement: 0,
    academicGrowth: 0, socialDynamics: 0, resilience: 0,
    ruleAdherence: 0, conflictResolution: 0, respectAuthority: 0
};

// Star ratings for the report card modal (separate from evalModal)
window.rcRatings = {
    academicComprehension: 0, attitudeWork: 0, effortResilience: 0,
    participation: 0, organization: 0, behavior: 0, peerRelations: 0, punctualityRating: 0
};

function getClasses()        { return session.teacherData.classes || [session.teacherData.className || '']; }
function getActiveSubjects() { return (session.teacherData.subjects || []).filter(s => !s.archived); }
function getGradeTypes()     { return session.teacherData.customGradeTypes || DEFAULT_GRADE_TYPES; }

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
    window.buildStarGroups();
}

async function fetchSchoolLimit() {
    try {
        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        if (schoolSnap.exists()) {
            const planId   = schoolSnap.data().subscriptionPlan || 'starter';
            const planSnap = await getDoc(doc(db, 'subscriptionPlans', planId));
            if (planSnap.exists()) schoolLimit = planSnap.data().studentLimit || planSnap.data().limit || 50;
        }
    } catch (e) { console.error('[Roster] fetchSchoolLimit:', e); }
}

// ── 5. SEMESTERS ─────────────────────────────────────────────────────────────
async function loadSemesters() {
    try {
        const cacheKey = `connectus_semesters_${session.schoolId}`;
        let rawSems    = [];
        const cached   = localStorage.getItem(cacheKey);
        if (cached) {
            rawSems = JSON.parse(cached);
        } else {
            const semSnap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
            rawSems = semSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order||0)-(b.order||0));
            localStorage.setItem(cacheKey, JSON.stringify(rawSems));
        }
        rawSemesters = rawSems;

        let activeId = '';
        try {
            const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
            activeId = schoolSnap.data()?.activeSemesterId || '';
        } catch(e) {}

        const semSel     = document.getElementById('activeSemester');
        const sbPeriod   = document.getElementById('sb-period');
        const evalSemSel = document.getElementById('evalSemester');
        if (evalSemSel) evalSemSel.innerHTML = '';

        if (semSel) {
            semSel.innerHTML = '';
            rawSemesters.forEach(s => {
                const opt = document.createElement('option');
                opt.value = s.id; opt.textContent = s.name;
                if (s.id === activeId) opt.selected = true;
                semSel.appendChild(opt);

                if (evalSemSel) {
                    const eOpt = document.createElement('option');
                    eOpt.value = s.id; eOpt.textContent = s.name;
                    if (s.id === activeId) eOpt.selected = true;
                    evalSemSel.appendChild(eOpt);
                }
            });
            checkLockStatus();
            semSel.addEventListener('change', () => {
                checkLockStatus(); loadStudents();
                if (sbPeriod) sbPeriod.textContent = semSel.options[semSel.selectedIndex]?.text || '—';
            });
        }
        updatePeriodLabel();
        if (sbPeriod && semSel) sbPeriod.textContent = semSel.options[semSel.selectedIndex]?.text || '—';
    } catch (e) { console.error('[Roster] loadSemesters:', e); }
}

function updatePeriodLabel() {
    const semSel = document.getElementById('activeSemester');
    const label  = document.getElementById('rosterPeriodLabel');
    if (semSel && label) label.textContent = semSel.options[semSel.selectedIndex]?.text || '—';
}

function checkLockStatus() {
    const semId      = document.getElementById('activeSemester')?.value;
    const activeSem  = rawSemesters.find(s => s.id === semId);
    isSemesterLocked = activeSem ? !!activeSem.isLocked : false;
    const badge      = document.getElementById('topbarLockedBadge');
    if (badge) {
        isSemesterLocked ? badge.classList.remove('hidden') && badge.classList.add('flex')
                         : badge.classList.add('hidden') && badge.classList.remove('flex');
    }
    updatePeriodLabel();
}

// ── 6. LOAD STUDENTS ──────────────────────────────────────────────────────────
async function loadStudents() {
    const tbody = document.getElementById('studentsTableBody');
    tbody.innerHTML = `<tr><td colspan="8"><div class="table-loader"><i class="fa-solid fa-spinner fa-spin"></i><p>Loading roster…</p></div></td></tr>`;

    try {
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
            tbody.innerHTML = `<tr><td colspan="8"><div class="table-loader"><i class="fa-solid fa-user-plus" style="color:#c5d0db;"></i><p>No students yet — enroll your first student to get started.</p></div></td></tr>`;
            const sbRisk0 = document.getElementById('sb-risk');
            if (sbRisk0) { sbRisk0.textContent = '0'; sbRisk0.classList.remove('is-risk'); }
            localStorage.setItem('connectus_sidebar_stats', JSON.stringify({ students: 0, risk: 0 }));
            return;
        }

        const semId     = document.getElementById('activeSemester')?.value;
        const allGrades = semId ? await fetchAllStudentGrades(semId) : [];
        let riskCount   = 0;

        tbody.innerHTML = allStudentsCache.map((s, i) => {
            const sG           = allGrades.filter(g => g.studentId === s.id);
            const subjectCount = new Set(sG.map(g => g.subject)).size;
            const avg          = sG.length ? calculateWeightedAverage(sG, session.teacherData.gradeTypes || getGradeTypes()) : null;
            if (avg !== null && avg < 65) riskCount++;
            const avgDisplay = avg !== null
                ? `<span class="grade-num ${gradeNumClass(avg)}">${avg}%</span>`
                : `<span style="color:#9ab0c6;font-family:'DM Mono',monospace;">—</span>`;
            const stdText  = standingText(avg);
            const stdLabel = standingLabelHtml(avg);

            return `<tr class="trow" data-class="${escHtml(s.className||'')}" data-standing="${stdText}">
                <td style="color:#9ab0c6;font-size:12px;font-family:'DM Mono',monospace;font-weight:500;width:44px;">${String(i+1).padStart(2,'0')}</td>
                <td><div class="student-cell"><div class="student-initial">${s.name.charAt(0).toUpperCase()}</div><div>
                    <span class="student-name">${escHtml(s.name)}</span>
                    <p style="font-size:10px;font-family:'DM Mono',monospace;color:#9ab0c6;margin:1px 0 0;letter-spacing:0.05em;">${s.id}</p>
                </div></div></td>
                <td style="font-size:12.5px;font-weight:500;color:#374f6b;">${escHtml(s.className||'—')}</td>
                <td style="font-size:12.5px;color:#6b84a0;font-weight:400;">${escHtml(s.parentPhone||'—')}</td>
                <td style="text-align:center;"><span class="subject-count">${subjectCount||'—'}</span></td>
                <td style="text-align:center;">${avgDisplay}</td>
                <td>${stdLabel}</td>
                <td style="text-align:right;"><div style="display:flex;align-items:center;justify-content:flex-end;gap:6px;">
                    <button onclick="quickGradeStudent('${s.id}')" class="row-action-btn row-btn-grade" title="Enter Grade"><i class="fa-solid fa-plus" style="font-size:10px;"></i></button>
                    <button onclick="openStudentPanel('${s.id}')" class="row-action-btn row-btn-view"><i class="fa-solid fa-eye"></i> View</button>
                </div></td>
            </tr>`;
        }).join('');

        const sbRisk = document.getElementById('sb-risk');
        if (sbRisk) { sbRisk.textContent = riskCount; sbRisk.classList.toggle('is-risk', riskCount > 0); }
        localStorage.setItem('connectus_sidebar_stats', JSON.stringify({ students: allStudentsCache.length, risk: riskCount }));
        applyRosterFilters();

    } catch (e) {
        console.error('[Roster] loadStudents:', e);
        document.getElementById('studentsTableBody').innerHTML = `<tr><td colspan="8"><div class="table-loader"><i class="fa-solid fa-triangle-exclamation" style="color:#dc2626;"></i><p style="color:#dc2626;">Error loading roster. Please refresh the page.</p></div></td></tr>`;
        localStorage.setItem('connectus_sidebar_stats', JSON.stringify({ students: 0, risk: 0 }));
    }
}

async function fetchAllStudentGrades(semId) {
    const all = [];
    await Promise.all(allStudentsCache.map(async s => {
        try {
            const q    = query(collection(db, 'students', s.id, 'grades'), where('schoolId', '==', session.schoolId), where('semesterId', '==', semId));
            const snap = await getDocs(q);
            snap.forEach(d => all.push({ id: d.id, studentId: s.id, studentName: s.name, ...d.data() }));
        } catch (e) {}
    }));
    return all;
}

// ── 7. STANDING HELPERS ───────────────────────────────────────────────────────
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
window.applyRosterFilters = function() {
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
        if (r.dataset.hiddenByFilter !== 'true')
            r.style.display = r.textContent.toLowerCase().includes(term) ? '' : 'none';
    });
}

window.quickGradeStudent = function(studentId) {
    if (isSemesterLocked) { alert('The current grading period is locked.'); return; }
    const student = allStudentsCache.find(s => s.id === studentId);
    if (!student?.className) {
        alert(`"${student?.name || 'This student'}" is not assigned to a class yet.\n\nPlease open their record, assign them to a class, then try again.`);
        return;
    }
    localStorage.setItem('connectus_quick_grade_student', studentId);
    window.location.assign('../grade_form/grade_form.html');
};

// ── 9. ENROLL / CLAIM STUDENT ─────────────────────────────────────────────────
window.openAddStudentModal = function() {
    const searchQ = document.getElementById('sSearchQuery');
    const searchR = document.getElementById('sSearchResults');
    if (searchQ) searchQ.value = '';
    if (searchR) { searchR.innerHTML = ''; searchR.classList.add('hidden'); }

    ['sName','sEmail','sParentPhone','sParentName','sDob'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
    });
    document.getElementById('addStudentMsg').classList.add('hidden');

    const classes = getClasses().filter(Boolean);
    const sel     = document.getElementById('sClass');
    sel.innerHTML = '<option value="">— Select a Class —</option>' +
        classes.map(c => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join('');

    openOverlay('addStudentModal', 'addStudentModalInner');
};

window.closeAddStudentModal = function() { closeOverlay('addStudentModal', 'addStudentModalInner'); };

window.searchStudentRegistry = async function() {
    const rawId      = (document.getElementById('sSearchQuery')?.value || '').trim().toUpperCase();
    const resultsDiv = document.getElementById('sSearchResults');

    if (!rawId) { alert('Enter a Student Global ID to search.'); return; }

    if (!/^S\d{2}-[A-Z0-9]{5}$/.test(rawId)) {
        resultsDiv.innerHTML = `<div style="padding:14px;text-align:center;color:#dc2626;font-size:12px;font-weight:700;">Invalid format. Student ID should look like S26-XXXXX.</div>`;
        resultsDiv.classList.remove('hidden'); return;
    }

    resultsDiv.innerHTML = `<div style="padding:14px;text-align:center;color:#9ab0c6;font-size:12px;"><i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i>Searching National Registry…</div>`;
    resultsDiv.classList.remove('hidden');

    const btn = document.getElementById('sSearchBtn');
    btn.textContent = '…'; btn.disabled = true;

    try {
        const snap = await getDoc(doc(db, 'students', rawId));

        if (!snap.exists()) {
            resultsDiv.innerHTML = `<div style="padding:14px;text-align:center;color:#9ab0c6;font-size:12px;font-weight:600;">No student found with that ID. Fill in the form below to create a new identity.</div>`;
            btn.textContent = 'Search'; btn.disabled = false; return;
        }

        const s = { id: snap.id, ...snap.data() };

        if (s.currentSchoolId && s.currentSchoolId !== '') {
            if (s.currentSchoolId !== session.schoolId) {
                resultsDiv.innerHTML = `<div style="padding:14px;text-align:center;color:#dc2626;font-size:12px;font-weight:700;">This student is currently enrolled at another school. Their current school must close enrollment first.</div>`;
                btn.textContent = 'Search'; btn.disabled = false; return;
            } else {
                if (s.teacherId && s.teacherId !== '') {
                    resultsDiv.innerHTML = s.teacherId === session.teacherId
                        ? `<div style="padding:14px;text-align:center;color:#dc2626;font-size:12px;font-weight:700;">This student is already in your active roster!</div>`
                        : `<div style="padding:14px;text-align:center;color:#dc2626;font-size:12px;font-weight:700;">This student is already assigned to another teacher's roster at this school.</div>`;
                    btn.textContent = 'Search'; btn.disabled = false; return;
                }
            }
        }

        const lastSchool  = s.academicHistory?.length
            ? `Last school: ${s.academicHistory[s.academicHistory.length-1].schoolName || s.academicHistory[s.academicHistory.length-1].schoolId}`
            : 'No prior enrollment';
        const emailStatus = !s.email
            ? `<span style="color:#d97706;font-weight:700;">⚠ No email on file</span>`
            : `<span style="color:#059669;font-weight:600;">✓ Email on file</span>`;

        resultsDiv.innerHTML = `
        <div style="padding:14px 16px;display:flex;align-items:flex-start;justify-content:space-between;gap:10px;">
            <div style="flex:1;min-width:0;">
                <p style="font-weight:800;color:#0d1f35;font-size:14px;margin:0 0 3px;">${escHtml(s.name)}</p>
                <p style="font-size:10.5px;font-family:'DM Mono',monospace;color:#9ab0c6;margin:0 0 3px;">${s.id}</p>
                <p style="font-size:11px;font-weight:600;color:#374f6b;margin:0 0 2px;">${s.dob ? 'DOB: ' + s.dob + ' · ' : ''}${lastSchool}</p>
                <p style="font-size:11px;margin:0;">${emailStatus}</p>
            </div>
            <button onclick="window.claimSearchedStudent('${s.id}')"
                    style="padding:7px 16px;background:#0ea871;border:none;border-radius:4px;color:#fff;font-size:12px;font-weight:700;font-family:inherit;cursor:pointer;white-space:nowrap;flex-shrink:0;">
                Claim Student
            </button>
        </div>`;

    } catch (e) {
        console.error('[Roster] searchStudentRegistry:', e);
        resultsDiv.innerHTML = `<div style="padding:14px;text-align:center;color:#dc2626;font-size:12px;">Search failed. Try again.</div>`;
    }

    btn.textContent = 'Search'; btn.disabled = false;
};

window.claimSearchedStudent = async function(studentId) {
    const classVal = document.getElementById('sClass').value;
    if (!classVal) { alert('Please select a class from the "Assign to Class" dropdown first, then claim.'); return; }

    const btn = document.querySelector(`button[onclick="window.claimSearchedStudent('${studentId}')"]`);
    if (btn) { btn.textContent = '…'; btn.disabled = true; }

    try {
        await updateDoc(doc(db, 'students', studentId), {
            currentSchoolId: session.schoolId, teacherId: session.teacherId,
            className: classVal, enrollmentStatus: 'Active'
        });
        window.closeAddStudentModal();
        await loadStudents();
    } catch (e) {
        console.error('[Roster] claimSearchedStudent:', e);
        alert('Error claiming student. Please try again.');
        if (btn) { btn.textContent = 'Claim Student'; btn.disabled = false; }
    }
};

document.getElementById('saveStudentBtn').addEventListener('click', async () => {
    const assignedClass = document.getElementById('sClass').value;
    const name          = document.getElementById('sName').value.trim();
    const email         = document.getElementById('sEmail')?.value.trim() || '';
    const btn           = document.getElementById('saveStudentBtn');

    if (!name)  { showMsg('addStudentMsg', 'Student name is required.', true); return; }
    if (!email) { showMsg('addStudentMsg', 'Email address is required so the parent can recover their PIN.', true); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showMsg('addStudentMsg', 'Please enter a valid email address.', true); return; }

    btn.textContent = 'Saving…'; btn.disabled = true;

    try {
        const emailCheckQ    = query(collection(db, 'students'), where('email', '==', email));
        const emailCheckSnap = await getDocs(emailCheckQ);
        if (!emailCheckSnap.empty) {
            showMsg('addStudentMsg', 'This email address is already in use by another student.', true);
            btn.textContent = 'Create New Student Identity'; btn.disabled = false; return;
        }

        const countSnap = await getDocs(query(
            collection(db, 'students'),
            where('currentSchoolId', '==', session.schoolId),
            where('enrollmentStatus', '==', 'Active')
        ));
        if (countSnap.size >= schoolLimit) {
            showMsg('addStudentMsg', `School capacity reached (${schoolLimit} max). Contact Admin to upgrade.`, true);
            btn.textContent = 'Create New Student Identity'; btn.disabled = false; return;
        }

        const newId = generateStudentId();
        await setDoc(doc(db, 'students', newId), {
            studentIdNum: newId, name, email,
            dob:          document.getElementById('sDob').value,
            parentName:   document.getElementById('sParentName').value.trim(),
            parentPhone:  document.getElementById('sParentPhone').value.trim(),
            pin:          Math.floor(1000 + Math.random() * 9000).toString(),
            teacherId:    session.teacherId,
            className:    assignedClass || '',
            currentSchoolId: session.schoolId,
            enrollmentStatus: 'Active',
            securityQuestionsSet: false,
            medicalNotes: '', academicHistory: [],
            createdAt:    new Date().toISOString()
        });

        window.closeAddStudentModal();
        await loadStudents();
    } catch (e) {
        console.error('[Roster] saveStudent:', e);
        showMsg('addStudentMsg', 'Error saving student. Please try again.', true);
    }

    btn.textContent = 'Create New Student Identity'; btn.disabled = false;
});

// ── 10. STUDENT PANEL & TABS ──────────────────────────────────────────────────
window.switchStudentTab = function(tabName) {
    const btnG = document.getElementById('tabBtnGrades');
    const btnE = document.getElementById('tabBtnEvaluations');
    const conG = document.getElementById('tabContentGrades');
    const conE = document.getElementById('tabContentEvaluations');

    if (tabName === 'grades') {
        btnG.style.borderBottomColor = '#0ea871'; btnG.style.color = '#0d1f35';
        btnE.style.borderBottomColor = 'transparent'; btnE.style.color = '#6b84a0';
        conG.classList.remove('hidden'); conG.style.display = 'flex';
        conE.classList.add('hidden');   conE.style.display = 'none';
    } else {
        btnE.style.borderBottomColor = '#0ea871'; btnE.style.color = '#0d1f35';
        btnG.style.borderBottomColor = 'transparent'; btnG.style.color = '#6b84a0';
        conE.classList.remove('hidden'); conE.style.display = 'flex';
        conG.classList.add('hidden');    conG.style.display = 'none';
    }
};

window.openStudentPanel = async function(studentId) {
    currentStudentId = studentId;
    const student    = allStudentsCache.find(s => s.id === studentId);

    document.getElementById('sPanelName').textContent = student?.name || 'Student';
    document.getElementById('sPanelMeta').textContent =
        [student?.className, student?.parentPhone].filter(Boolean).join(' · ') || '—';

    window.switchStudentTab('grades');

    // Show current PIN (read-only)
    document.getElementById('spinReadonly').textContent = student?.pin || '—';

    document.getElementById('sPanelLoader').style.display = 'flex';
    document.getElementById('sViewMode').classList.add('hidden');

    const qGBtn = document.getElementById('spQuickGradeBtn2');
    if (qGBtn) {
        if (!isSemesterLocked) {
            qGBtn.style.display = 'inline-flex';
            qGBtn.onclick = () => { window.closeStudentPanel(); window.quickGradeStudent(studentId); };
        } else { qGBtn.style.display = 'none'; }
    }

    openOverlay('studentPanel', 'studentPanelInner');

    // Populate class selector (only editable field)
    const classSel = document.getElementById('editSClass');
    const classes  = getClasses().filter(Boolean);
    classSel.innerHTML = classes.map(c =>
        `<option value="${escHtml(c)}" ${c === student?.className ? 'selected' : ''}>${escHtml(c)}</option>`
    ).join('');
    classSel.dataset.original = student?.className || '';
    document.getElementById('editSClassReasonWrap').classList.add('hidden');
    document.getElementById('editSClassReason').value = '';
    document.getElementById('editClassMsg').classList.add('hidden');

    // Build read-only profile info
    document.getElementById('sInfoGrid').innerHTML = [
        ['Name',         student?.name         || '—'],
        ['Global ID',    student?.id           || '—'],
        ['Email',        student?.email        || '<span style="color:#d97706;font-weight:700;">Not set</span>'],
        ['DOB',          student?.dob          || '—'],
        ['Parent Name',  student?.parentName   || '—'],
        ['Parent Phone', student?.parentPhone  || '—'],
        ['Enrolled',     student?.createdAt
            ? new Date(student.createdAt).toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' }) : '—']
    ].map(([label, value]) => `
        <div class="info-row">
            <span class="info-row-label">${label}</span>
            <span class="info-row-value" style="${label === 'Global ID' ? "font-family:'DM Mono',monospace;font-size:11.5px;" : ''}">${escHtml(value)}</span>
        </div>`).join('');

    const semId   = document.getElementById('activeSemester')?.value || '';
    const semName = document.getElementById('activeSemester')?.options[document.getElementById('activeSemester')?.selectedIndex]?.text || '';
    document.getElementById('sPanelSemName').textContent = semName;
    document.getElementById('sPanelFilterSubject').value = '';
    document.getElementById('sPanelFilterType').value    = '';

    try {
        const gradesSnap = await getDocs(query(collection(db, 'students', studentId, 'grades'), where('schoolId', '==', session.schoolId)));
        currentStudentGradesCache = [];
        gradesSnap.forEach(d => { const g = { id: d.id, ...d.data() }; if (g.semesterId === semId) currentStudentGradesCache.push(g); });

        const subjSet = [...new Set(currentStudentGradesCache.map(g => g.subject || 'Uncategorized'))].sort();
        document.getElementById('sPanelFilterSubject').innerHTML = '<option value="">All Subjects</option>' + subjSet.map(s => `<option value="${escHtml(s)}">${escHtml(s)}</option>`).join('');
        document.getElementById('sPanelFilterType').innerHTML    = '<option value="">All Types</option>' + getGradeTypes().map(t => `<option value="${escHtml(t.name || t)}">${escHtml(t.name || t)}</option>`).join('');
        window.renderStudentGrades();
        await window.loadStudentEvaluations(studentId);
    } catch (e) { console.error('[Roster] openStudentPanel data load:', e); }

    document.getElementById('sPanelLoader').style.display = 'none';
    document.getElementById('sViewMode').classList.remove('hidden');
};

window.closeStudentPanel = function() { closeOverlay('studentPanel', 'studentPanelInner'); };

window.renderStudentGrades = function() {
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

    if (!Object.keys(by).length) { container.innerHTML = ''; noG.classList.remove('hidden'); return; }
    noG.classList.add('hidden');

    container.innerHTML = Object.entries(by).map(([subject, grades]) => {
        const avg = calculateWeightedAverage(grades, session.teacherData.gradeTypes || getGradeTypes());
        const rows = grades.sort((a,b) => (b.date||'').localeCompare(a.date||'')).map(g => {
            gradeDetailCache[g.id] = g;
            const pct   = g.max ? Math.round(g.score/g.max*100) : null;
            const color = pct >= 75 ? '#065f46' : pct >= 65 ? '#78350f' : '#7f1d1d';
            const bgCol = pct >= 90 ? '#dcfce7' : pct >= 80 ? '#dbeafe' : pct >= 70 ? '#ccfbf1' : pct >= 65 ? '#fef3c7' : '#fee2e2';
            const bdCol = pct >= 90 ? '#bbf7d0' : pct >= 80 ? '#bfdbfe' : pct >= 70 ? '#99f6e4' : pct >= 65 ? '#fde68a' : '#fecaca';
            const adminTag = g.enteredByAdmin ? `<span style="font-size:9px;font-weight:700;color:#2563eb;background:#eff6ff;border:1px solid #bfdbfe;padding:1px 5px;border-radius:3px;margin-left:4px;">Admin</span>` : '';
            return `<div onclick="window.openAssignmentModal('${g.id}')" style="display:flex;align-items:center;justify-content:space-between;background:#fff;border:1px solid #e8edf2;border-radius:3px;padding:10px 14px;cursor:pointer;" onmouseover="this.style.borderColor='#0ea871';this.style.background='#f8fefb'" onmouseout="this.style.borderColor='#e8edf2';this.style.background='#fff'">
                <div style="flex:1;min-width:0;"><p style="font-size:12.5px;font-weight:600;color:#0d1f35;margin:0 0 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(g.title||'Assessment')}${adminTag}</p><p style="font-size:11px;color:#9ab0c6;font-weight:400;margin:0;">${escHtml(g.type||'')}${g.date?' · '+g.date:''}</p></div>
                <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;margin-left:16px;"><span style="font-size:12px;font-weight:600;color:${color};font-family:'DM Mono',monospace;">${g.score}/${g.max||'?'}</span><span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:3px;background:${bgCol};border:1px solid ${bdCol};color:${color};font-family:'DM Mono',monospace;">${pct!==null?pct+'%':'—'}</span></div>
            </div>`;
        }).join('');

        const avgR    = Math.round(avg);
        const hdColor = avgR >= 90 ? '#14532d' : avgR >= 80 ? '#1e3a8a' : avgR >= 70 ? '#134e4a' : avgR >= 65 ? '#78350f' : '#7f1d1d';
        const hdBg    = avgR >= 90 ? '#dcfce7' : avgR >= 80 ? '#dbeafe' : avgR >= 70 ? '#ccfbf1' : avgR >= 65 ? '#fef3c7' : '#fee2e2';
        const hdBd    = avgR >= 90 ? '#bbf7d0' : avgR >= 80 ? '#bfdbfe' : avgR >= 70 ? '#99f6e4' : avgR >= 65 ? '#fde68a' : '#fecaca';

        // Accordions start COLLAPSED (no 'open' class)
        return `<div style="border:1px solid #dce3ed;border-radius:4px;overflow:hidden;background:#fff;">
            <div onclick="window.toggleAccordion(this)" style="display:flex;align-items:center;justify-content:space-between;padding:13px 16px;cursor:pointer;background:#fff;" onmouseover="this.style.background='#f8fafb'" onmouseout="this.style.background='#fff'">
                <div style="display:flex;align-items:center;gap:12px;"><div style="width:32px;height:32px;border-radius:4px;background:#0d1f35;color:#fff;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;">${escHtml(subject.charAt(0))}</div><div><p style="font-size:13px;font-weight:700;color:#0d1f35;margin:0;">${escHtml(subject)}</p><p style="font-size:10.5px;color:#9ab0c6;font-weight:400;margin:0;">${grades.length} assessment${grades.length!==1?'s':''}</p></div></div>
                <div style="display:flex;align-items:center;gap:10px;"><span style="font-size:11px;font-weight:700;padding:3px 10px;border-radius:3px;background:${hdBg};border:1px solid ${hdBd};color:${hdColor};font-family:'DM Mono',monospace;">${avgR}% · ${letterGrade(avg)}</span><i class="fa-solid fa-chevron-down" style="font-size:11px;color:#9ab0c6;transition:transform 0.2s;"></i></div>
            </div>
            <div class="subject-body" style="border-top:1px solid #f0f4f8;"><div style="padding:10px 12px;background:#f8fafb;display:flex;flex-direction:column;gap:6px;">${rows}</div></div>
        </div>`;
    }).join('');
};

window.toggleAccordion = function(header) {
    const body    = header.nextElementSibling;
    body.classList.toggle('open');
    const chevron = header.querySelector('.fa-chevron-down');
    if (chevron) chevron.style.transform = body.classList.contains('open') ? 'rotate(180deg)' : 'rotate(0)';
};

// ── 10.5. CLASS-ONLY EDIT ────────────────────────────────────────────────────
window.checkClassChange = function() {
    const sel  = document.getElementById('editSClass');
    const wrap = document.getElementById('editSClassReasonWrap');
    if (sel.value !== sel.dataset.original && sel.dataset.original !== '') wrap.classList.remove('hidden');
    else wrap.classList.add('hidden');
};

window.saveStudentClass = async function() {
    const btn        = document.getElementById('saveClassBtn');
    const newClass   = document.getElementById('editSClass').value;
    const origClass  = document.getElementById('editSClass').dataset.original;
    const reason     = document.getElementById('editSClassReason').value.trim();

    if (newClass !== origClass && origClass !== '' && !reason) {
        showMsg('editClassMsg', 'Please provide a reason for the class change.', true); return;
    }

    btn.textContent = 'Saving…'; btn.disabled = true;
    try {
        const u = { className: newClass };
        if (newClass !== origClass && origClass !== '') {
            u.lastClassChangeReason = reason;
            u.lastClassChangeDate   = new Date().toISOString();
        }
        await updateDoc(doc(db, 'students', currentStudentId), u);
        const idx = allStudentsCache.findIndex(s => s.id === currentStudentId);
        if (idx !== -1) allStudentsCache[idx].className = newClass;
        document.getElementById('editSClass').dataset.original = newClass;
        document.getElementById('editSClassReasonWrap').classList.add('hidden');
        document.getElementById('editSClassReason').value = '';
        document.getElementById('sPanelMeta').textContent =
            [newClass, allStudentsCache[idx]?.parentPhone].filter(Boolean).join(' · ') || '—';
        showMsg('editClassMsg', 'Class updated.', false);
        await loadStudents();
    } catch (e) {
        console.error('[Roster] saveStudentClass:', e);
        showMsg('editClassMsg', 'Error saving. Please try again.', true);
    }
    btn.textContent = 'Save Class'; btn.disabled = false;
};

// ── 10.6. PIN — EMAIL RESET ONLY ─────────────────────────────────────────────
window.sendPinResetEmail = async function() {
    const student = allStudentsCache.find(s => s.id === currentStudentId);
    if (!student?.email) {
        alert('This student has no email on file. A PIN reset email cannot be sent.\n\nPlease contact the admin to update the student\'s email first.');
        return;
    }

    const btn      = document.getElementById('pinResetEmailBtn');
    const original = btn.innerHTML;
    btn.innerHTML  = '<i class="fa-solid fa-spinner fa-spin"></i> Sending…';
    btn.disabled   = true;

    try {
        await addDoc(collection(db, 'reset_vault'), {
            email:     student.email,
            name:      student.name,
            roleLabel: 'Student Account',
            userType:  'student',
            studentId: currentStudentId,
            expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
            createdAt: new Date().toISOString()
        });
        btn.innerHTML = '<i class="fa-solid fa-check"></i> Email Sent';
        setTimeout(() => { btn.innerHTML = original; btn.disabled = false; }, 3000);
    } catch (e) {
        console.error('[Roster] sendPinResetEmail:', e);
        alert('Failed to send reset email. Please try again.');
        btn.innerHTML = original;
        btn.disabled  = false;
    }
};

// ── 11. EVALUATIONS — REGULAR (BEHAVIORAL / EOY / ACADEMIC PROGRESS) ─────────
window.buildStarGroups = function() {
    document.querySelectorAll('.rating-row').forEach(row => {
        const field = row.dataset.field;
        const group = row.querySelector('.star-group');
        group.innerHTML = [1,2,3,4,5].map(n =>
            `<button type="button" class="star-btn" data-val="${n}" data-field="${field}"
              onmouseover="window.hoverStars('${field}',${n})"
              onmouseout="window.renderStars('${field}')"
              onclick="window.setRating('${field}',${n})">★</button>`
        ).join('');
        window.renderStars(field);
    });
};

window.renderStars = function(field) {
    const val = window.evalRatings[field] || 0;
    document.querySelectorAll(`[data-field="${field}"]`).forEach(btn => {
        if (btn.tagName === 'BUTTON') btn.classList.toggle('star-active', parseInt(btn.dataset.val) <= val);
    });
};

window.hoverStars = function(field, val) {
    document.querySelectorAll(`[data-field="${field}"]`).forEach(btn => {
        if (btn.tagName === 'BUTTON') btn.classList.toggle('star-active', parseInt(btn.dataset.val) <= val);
    });
};

window.setRating = function(field, val) {
    window.evalRatings[field] = val;
    window.renderStars(field);
};

window.openEvalModal = function() {
    document.getElementById('evalDate').value = new Date().toISOString().split('T')[0];
    document.querySelectorAll('.eval-section textarea, .eval-section select').forEach(el => el.value = '');
    Object.keys(window.evalRatings).forEach(k => { window.evalRatings[k] = 0; window.renderStars(k); });
    document.getElementById('evalType').value = 'academic';
    window.toggleEvalType();
    openOverlay('evalModal', 'evalModalInner');
};

window.closeEvalModal = function() { closeOverlay('evalModal', 'evalModalInner'); };

window.toggleEvalType = function() {
    const type = document.getElementById('evalType').value;
    document.getElementById('type-academic').classList.toggle('hidden', type !== 'academic');
    document.getElementById('type-eoy').classList.toggle('hidden',      type !== 'end_of_year');
    document.getElementById('type-behavioral').classList.toggle('hidden', type !== 'behavioral');
};

window.saveEvaluation = async function() {
    const type    = document.getElementById('evalType').value;
    const semId   = document.getElementById('evalSemester').value;
    const semName = document.getElementById('evalSemester').options[document.getElementById('evalSemester').selectedIndex].text;
    const date    = document.getElementById('evalDate').value;
    const btn     = document.getElementById('btnSubmitEval');

    if (!semId || !date) { alert('Please ensure Semester and Date are filled.'); return; }

    let payload = {
        type, schoolId: session.schoolId, teacherId: session.teacherId,
        teacherName: session.teacherData.name, semesterId: semId,
        semesterName: semName, date, createdAt: new Date().toISOString()
    };

    if (type === 'academic') {
        if (!window.evalRatings.academicMastery || !window.evalRatings.taskExecution || !window.evalRatings.engagement) {
            alert('Please rate all quantitative metrics.'); return;
        }
        payload.ratings = { mastery: window.evalRatings.academicMastery, execution: window.evalRatings.taskExecution, engagement: window.evalRatings.engagement };
        payload.written = { strengths: document.getElementById('evalAcadStrengths').value.trim(), growth: document.getElementById('evalAcadGrowth').value.trim(), steps: document.getElementById('evalAcadSteps').value.trim() };
    } else if (type === 'end_of_year') {
        if (!window.evalRatings.academicGrowth || !window.evalRatings.socialDynamics || !window.evalRatings.resilience) {
            alert('Please rate all summative metrics.'); return;
        }
        payload.ratings = { growth: window.evalRatings.academicGrowth, social: window.evalRatings.socialDynamics, resilience: window.evalRatings.resilience };
        payload.written = { narrative: document.getElementById('evalEoyNarrative').value.trim(), interventions: document.getElementById('evalEoyInterventions').value.trim() };
        payload.status  = document.getElementById('evalEoyStatus').value;
        if (!payload.status) { alert('Please select a Promotion Status.'); return; }
    } else if (type === 'behavioral') {
        if (!window.evalRatings.ruleAdherence || !window.evalRatings.conflictResolution || !window.evalRatings.respectAuthority) {
            alert('Please rate all conduct metrics.'); return;
        }
        payload.ratings = { adherence: window.evalRatings.ruleAdherence, resolution: window.evalRatings.conflictResolution, respect: window.evalRatings.respectAuthority };
        payload.written = { description: document.getElementById('evalBehDesc').value.trim(), prior: document.getElementById('evalBehPrior').value.trim(), actionPlan: document.getElementById('evalBehAction').value.trim() };
        payload.status  = document.getElementById('evalBehStatus').value;
        if (!payload.status) { alert('Please select an Action Taken.'); return; }
    }

    btn.textContent = 'Saving...'; btn.disabled = true;
    try {
        await addDoc(collection(db, 'students', currentStudentId, 'evaluations'), payload);
        window.closeEvalModal();
        await window.loadStudentEvaluations(currentStudentId);
    } catch (e) {
        console.error('[Roster] saveEvaluation:', e);
        alert('Failed to save evaluation.');
    }
    btn.textContent = 'Save to Formal Record'; btn.disabled = false;
};

window.loadStudentEvaluations = async function(studentId) {
    const list  = document.getElementById('evaluationsList');
    const noMsg = document.getElementById('noEvaluationsMsg');
    list.innerHTML    = '';
    cachedEvaluations = [];

    try {
        const snap = await getDocs(query(
            collection(db, 'students', studentId, 'evaluations'),
            where('schoolId', '==', session.schoolId)
        ));
        snap.forEach(d => cachedEvaluations.push({ id: d.id, ...d.data() }));
        cachedEvaluations.sort((a,b) => new Date(b.date) - new Date(a.date));

        if (!cachedEvaluations.length) {
            noMsg.classList.remove('hidden');
        } else {
            noMsg.classList.add('hidden');
            cachedEvaluations.forEach(ev => {
                let badgeStyle = '', typeLabel = '', highlightText = '';
                if (ev.type === 'academic') {
                    badgeStyle = 'background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;';
                    typeLabel  = 'Academic Progress';
                } else if (ev.type === 'academic_report_card') {
                    badgeStyle = 'background:#edf7f1;color:#065f46;border:1px solid #a7f3d0;';
                    typeLabel  = 'Report Card Evaluation';
                } else if (ev.type === 'end_of_year') {
                    badgeStyle    = 'background:#fef3c7;color:#b45309;border:1px solid #fde68a;';
                    typeLabel     = 'Comprehensive End-of-Year';
                    highlightText = `<div style="margin-top:10px;padding:6px 10px;background:#f8fafb;border-radius:4px;font-size:11px;font-weight:700;color:#0d1f35;"><i class="fa-solid fa-award" style="color:#f59e0b;margin-right:5px;"></i> Status: ${ev.status}</div>`;
                } else if (ev.type === 'behavioral') {
                    badgeStyle    = 'background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;';
                    typeLabel     = 'Behavioral Intervention';
                    highlightText = `<div style="margin-top:10px;padding:6px 10px;background:#fff0f3;border-radius:4px;font-size:11px;font-weight:700;color:#be1240;"><i class="fa-solid fa-triangle-exclamation" style="margin-right:5px;"></i> Action: ${ev.status}</div>`;
                }

                const card = document.createElement('div');
                card.style.cssText = 'background:#fff;border:1px solid #dce3ed;border-radius:4px;padding:16px;display:flex;flex-direction:column;gap:8px;';
                card.innerHTML = `
                    <div style="display:flex;justify-content:space-between;align-items:flex-start;">
                        <div>
                            <span style="font-size:10px;font-weight:700;padding:3px 8px;border-radius:99px;text-transform:uppercase;letter-spacing:0.05em;${badgeStyle}">${typeLabel}</span>
                            <h4 style="font-size:14px;font-weight:700;color:#0d1f35;margin:8px 0 2px;">${ev.semesterName}</h4>
                            <p style="font-size:11px;color:#6b84a0;margin:0;">Filed by ${escHtml(ev.teacherName)} on ${ev.date}</p>
                        </div>
                    </div>
                    ${highlightText}
                `;
                list.appendChild(card);
            });
        }
    } catch (e) {
        console.error('[Roster] loadStudentEvaluations:', e);
        noMsg.classList.remove('hidden');
    }
};

// ── 12. REPORT CARD MODAL (GENERATE REPORT CARD FLOW) ────────────────────────
window.buildRcStarGroups = function() {
    document.querySelectorAll('.rc-rating-row').forEach(row => {
        const field = row.dataset.field;
        const group = row.querySelector('.rc-star-group');
        group.innerHTML = [1,2,3,4,5].map(n =>
            `<button type="button" class="star-btn" data-val="${n}" data-rcfield="${field}"
              onmouseover="window.hoverRcStars('${field}',${n})"
              onmouseout="window.renderRcStars('${field}')"
              onclick="window.setRcRating('${field}',${n})">★</button>`
        ).join('');
        window.renderRcStars(field);
    });
};

window.renderRcStars = function(field) {
    const val = window.rcRatings[field] || 0;
    document.querySelectorAll(`[data-rcfield="${field}"]`).forEach(btn => {
        if (btn.tagName === 'BUTTON') btn.classList.toggle('star-active', parseInt(btn.dataset.val) <= val);
    });
};

window.hoverRcStars = function(field, val) {
    document.querySelectorAll(`[data-rcfield="${field}"]`).forEach(btn => {
        if (btn.tagName === 'BUTTON') btn.classList.toggle('star-active', parseInt(btn.dataset.val) <= val);
    });
};

window.setRcRating = function(field, val) {
    window.rcRatings[field] = val;
    window.renderRcStars(field);
};

window.openReportCardModal = function() {
    // Reset ratings
    Object.keys(window.rcRatings).forEach(k => { window.rcRatings[k] = 0; });
    
    // Reset fields
    ['rcTotalSessions','rcDaysAbsent','rcDaysLate','rcComment'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
    });

    // Populate semester dropdown from rawSemesters
    const rcSem     = document.getElementById('rcSemester');
    const activeSemVal = document.getElementById('activeSemester')?.value;
    rcSem.innerHTML = '';
    rawSemesters.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.id; opt.textContent = s.name;
        if (s.id === activeSemVal) opt.selected = true;
        rcSem.appendChild(opt);
    });

    openOverlay('reportCardModal', 'reportCardModalInner');

    // Build stars after modal is visible
    window.buildRcStarGroups();
};

window.closeReportCardModal = function() { closeOverlay('reportCardModal', 'reportCardModalInner'); };

window.saveAndGenerateReportCard = async function() {
    const semId   = document.getElementById('rcSemester').value;
    const semName = document.getElementById('rcSemester').options[document.getElementById('rcSemester').selectedIndex]?.text || '';
    const btn     = document.getElementById('btnSaveGenerate');

    if (!semId) { alert('Please select a grading period.'); return; }

    // Validate all 8 ratings
    if (Object.values(window.rcRatings).some(v => !v)) {
        alert('Please complete all 8 Behavior & Work Habit ratings before generating the report card.');
        return;
    }

    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';
    btn.disabled  = true;

    const payload = {
        type:        'academic_report_card',
        schoolId:    session.schoolId,
        teacherId:   session.teacherId,
        teacherName: session.teacherData.name,
        semesterId:  semId,
        semesterName: semName,
        date:        new Date().toISOString().split('T')[0],
        createdAt:   new Date().toISOString(),
        attendance: {
            totalSessions: parseInt(document.getElementById('rcTotalSessions').value) || 0,
            daysAbsent:    parseInt(document.getElementById('rcDaysAbsent').value)    || 0,
            daysLate:      parseInt(document.getElementById('rcDaysLate').value)      || 0
        },
        ratings: { ...window.rcRatings },
        comment: document.getElementById('rcComment').value.trim()
    };

    try {
        // 1 per term — overwrite if regenerated
        await setDoc(doc(db, 'students', currentStudentId, 'evaluations', `${currentStudentId}_${semId}_rc`), payload);
        await window.loadStudentEvaluations(currentStudentId);
        window.closeReportCardModal();
        generateFormalReportCardPDF(payload, semName);
    } catch (e) {
        console.error('[Roster] saveAndGenerateReportCard:', e);
        alert('Failed to save. Please try again.');
    }

    btn.innerHTML = '<i class="fa-solid fa-file-pdf"></i> Save & Generate Report Card';
    btn.disabled  = false;
};

function generateFormalReportCardPDF(ev, semName) {
    const student    = allStudentsCache.find(s => s.id === currentStudentId);
    if (!student)    return;
    const schoolName = session.schoolName || 'ConnectUs School';

    const bySub = {};
    currentStudentGradesCache.forEach(g => {
        const sub = g.subject || 'Uncategorized';
        if (!bySub[sub]) bySub[sub] = [];
        bySub[sub].push(g);
    });

    const cumulativeAvg = currentStudentGradesCache.length
        ? calculateWeightedAverage(currentStudentGradesCache, session.teacherData.gradeTypes || getGradeTypes())
        : 0;
    const gpaLetter = cumulativeAvg > 0 ? letterGrade(cumulativeAvg) : 'N/A';

    const r2l = v => v >= 5 ? 'E' : v === 4 ? 'D' : v === 3 ? 'B' : v > 0 ? 'I' : '—';

    const gradesHtml = Object.keys(bySub).length === 0
        ? `<tr><td colspan="3" style="text-align:center;padding:30px;color:#64748b;font-style:italic;">No grades recorded for this term.</td></tr>`
        : Object.entries(bySub).sort((a,b) => a[0].localeCompare(b[0])).map(([sub, gList]) => {
            const subAvg = calculateWeightedAverage(gList, session.teacherData.gradeTypes || getGradeTypes());
            return `<tr style="border-bottom:1px solid #e2e8f0;">
                <td style="padding:12px 15px;font-weight:700;color:#1e293b;">${escHtml(sub)}</td>
                <td style="padding:12px 15px;text-align:center;font-weight:700;">${subAvg}%</td>
                <td style="padding:12px 15px;text-align:center;font-weight:800;font-family:monospace;">${letterGrade(subAvg)}</td>
            </tr>`;
        }).join('');

    const html = `<!DOCTYPE html>
<html>
<head>
<title>Official Report Card — ${escHtml(student.name)}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&display=swap');
body { font-family:'Nunito',sans-serif; padding:40px; color:#0f172a; line-height:1.5; margin:0 auto; max-width:8.5in; }
.header-flex { display:flex; justify-content:space-between; align-items:flex-end; border-bottom:3px solid #1e1b4b; padding-bottom:20px; margin-bottom:20px; }
.logo { max-height:80px; max-width:250px; object-fit:contain; }
.header-text { text-align:right; }
.header-text h1 { margin:0 0 5px; font-size:26px; font-weight:900; text-transform:uppercase; color:#1e1b4b; }
.header-text h2 { margin:0; font-size:14px; color:#64748b; font-weight:700; letter-spacing:2px; }
.student-info { display:flex; justify-content:space-between; background:#f8fafc; border:1px solid #cbd5e1; border-radius:8px; padding:15px 20px; margin-bottom:30px; }
.student-info div { display:flex; flex-direction:column; gap:4px; }
.info-label { font-size:10px; text-transform:uppercase; color:#64748b; font-weight:800; letter-spacing:1px; }
.info-value { font-size:16px; font-weight:800; color:#0f172a; }
.grid-container { display:grid; grid-template-columns:1fr 1fr; gap:30px; margin-bottom:30px; }
h3 { font-size:14px; text-transform:uppercase; letter-spacing:1px; color:#1e1b4b; border-bottom:2px solid #1e1b4b; padding-bottom:8px; margin-top:0; margin-bottom:12px; }
table { width:100%; border-collapse:collapse; font-size:13px; margin-bottom:20px; }
th { background:#f1f5f9; color:#475569; padding:10px 15px; text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:1px; border-bottom:2px solid #cbd5e1; }
th.c { text-align:center; }
td { border-bottom:1px solid #e2e8f0; padding:10px 15px; color:#334155; }
.legend { font-size:11px; color:#64748b; font-weight:700; display:flex; justify-content:space-between; background:#f8fafc; padding:8px 12px; border-radius:6px; margin-bottom:15px; }
.attendance-grid { display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; margin-bottom:20px; }
.att-card { background:#f8fafc; border:1px solid #cbd5e1; padding:10px; text-align:center; border-radius:6px; }
.att-lbl { display:block; font-size:10px; font-weight:800; color:#64748b; text-transform:uppercase; }
.att-val { font-size:18px; font-weight:900; color:#1e1b4b; }
.comments-box { border:1px solid #cbd5e1; border-radius:8px; padding:15px; background:#fff; min-height:80px; }
.comments-label { font-size:11px; font-weight:800; color:#1e1b4b; text-transform:uppercase; margin-bottom:8px; display:block; }
.footer-sigs { display:grid; grid-template-columns:1fr 1fr; gap:40px; margin-top:50px; }
.sig-line { border-top:1px solid #000; padding-top:8px; font-size:12px; font-weight:700; text-align:center; color:#1e1b4b; }
</style>
</head>
<body>
<div class="header-flex">
    <img src="${session.logo || ''}" alt="${escHtml(schoolName)}" class="logo" onerror="this.style.display='none'">
    <div class="header-text">
        <h1>${escHtml(schoolName)}</h1>
        <h2>OFFICIAL TERM REPORT CARD</h2>
    </div>
</div>
<div class="student-info">
    <div><span class="info-label">Student Name</span><span class="info-value">${escHtml(student.name)}</span></div>
    <div><span class="info-label">Class</span><span class="info-value">${escHtml(student.className || 'Unassigned')}</span></div>
    <div><span class="info-label">Academic Term</span><span class="info-value">${escHtml(semName)}</span></div>
    <div><span class="info-label">Term Average</span><span class="info-value">${cumulativeAvg}% (${gpaLetter})</span></div>
</div>
<div class="grid-container">
    <div>
        <h3>Academic Performance</h3>
        <table>
            <thead><tr><th>Subject</th><th class="c">Term Avg</th><th class="c">Grade</th></tr></thead>
            <tbody>${gradesHtml}</tbody>
        </table>
    </div>
    <div>
        <h3>Behavior &amp; Work Habits</h3>
        <div class="legend"><span>E — Exceptional</span><span>D — Developing</span><span>B — Beginning</span><span>I — Improvement Needed</span></div>
        <table>
            <tbody>
                <tr><td style="font-weight:700;">Academic Comprehension</td><td style="text-align:center;font-weight:800;font-size:14px;">${r2l(ev.ratings.academicComprehension)}</td></tr>
                <tr><td style="font-weight:700;">Attitude Towards Work</td><td style="text-align:center;font-weight:800;font-size:14px;">${r2l(ev.ratings.attitudeWork)}</td></tr>
                <tr><td style="font-weight:700;">Effort &amp; Resilience</td><td style="text-align:center;font-weight:800;font-size:14px;">${r2l(ev.ratings.effortResilience)}</td></tr>
                <tr><td style="font-weight:700;">Participation &amp; Engagement</td><td style="text-align:center;font-weight:800;font-size:14px;">${r2l(ev.ratings.participation)}</td></tr>
                <tr><td style="font-weight:700;">Organization &amp; Time Mgt</td><td style="text-align:center;font-weight:800;font-size:14px;">${r2l(ev.ratings.organization)}</td></tr>
                <tr><td style="font-weight:700;">Classroom Behaviour</td><td style="text-align:center;font-weight:800;font-size:14px;">${r2l(ev.ratings.behavior)}</td></tr>
                <tr><td style="font-weight:700;">Peer Relations &amp; Respect</td><td style="text-align:center;font-weight:800;font-size:14px;">${r2l(ev.ratings.peerRelations)}</td></tr>
                <tr><td style="font-weight:700;">Attendance &amp; Punctuality</td><td style="text-align:center;font-weight:800;font-size:14px;">${r2l(ev.ratings.punctualityRating)}</td></tr>
            </tbody>
        </table>
        <div class="attendance-grid">
            <div class="att-card"><span class="att-lbl">Sessions</span><span class="att-val">${ev.attendance.totalSessions}</span></div>
            <div class="att-card"><span class="att-lbl">Absent</span><span class="att-val">${ev.attendance.daysAbsent}</span></div>
            <div class="att-card"><span class="att-lbl">Late</span><span class="att-val">${ev.attendance.daysLate}</span></div>
        </div>
        <div class="comments-box">
            <span class="comments-label">Teacher's Comments</span>
            <p style="margin:0;font-size:13px;color:#334155;white-space:pre-wrap;">${escHtml(ev.comment || 'No comments recorded.')}</p>
        </div>
    </div>
</div>
<div class="footer-sigs">
    <div class="sig-line">Teacher's Signature &amp; Date</div>
    <div class="sig-line">Principal's Signature &amp; Date</div>
</div>
</body>
</html>`;

    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
    setTimeout(() => w.print(), 800);
}

// ── 13. ASSIGNMENT MODAL ──────────────────────────────────────────────────────
window.openAssignmentModal = function(gradeId) {
    const g = gradeDetailCache[gradeId]; if (!g) return;
    const pct      = g.max ? Math.round(g.score/g.max*100) : null;
    const fill     = gradeFill(pct||0);
    const color    = pct>=90?'#065f46':pct>=80?'#1e3a8a':pct>=70?'#134e4a':pct>=65?'#78350f':'#7f1d1d';
    const bg       = pct>=90?'#dcfce7':pct>=80?'#dbeafe':pct>=70?'#ccfbf1':pct>=65?'#fef3c7':'#fee2e2';
    const bd       = pct>=90?'#bbf7d0':pct>=80?'#bfdbfe':pct>=70?'#99f6e4':pct>=65?'#fde68a':'#fecaca';
    const adminNote = g.enteredByAdmin ? `<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:4px;padding:12px;margin-bottom:12px;"><p style="font-size:9.5px;font-weight:700;text-transform:uppercase;color:#2563eb;margin:0 0 4px;">Admin Entry</p><p style="font-size:12px;color:#374f6b;margin:0;">Entered by ${escHtml(g.adminName||'Admin')}</p></div>` : '';
    document.getElementById('aModalTitle').textContent = g.title || 'Assessment Detail';
    document.getElementById('aModalBody').innerHTML = `<div style="text-align:center;margin-bottom:20px;"><div style="font-size:42px;font-weight:700;color:${color};font-family:'DM Mono',monospace;line-height:1;">${g.score}<span style="font-size:20px;color:#9ab0c6;"> / ${g.max||'?'}</span></div>${pct!==null?`<div style="display:flex;align-items:center;justify-content:center;gap:12px;margin-top:8px;"><span style="font-size:18px;font-weight:700;color:${color};font-family:'DM Mono',monospace;">${pct}%</span><span style="font-size:14px;font-weight:700;padding:4px 14px;border-radius:3px;background:${bg};border:1px solid ${bd};color:${color};">${letterGrade(pct)}</span></div><div style="margin:12px 20px 0;height:8px;background:#f0f4f8;border-radius:2px;overflow:hidden;"><div style="height:100%;width:${Math.min(pct,100)}%;background:${fill};transition:width 0.5s ease;"></div></div>`:''}</div>${adminNote}<div style="display:flex;flex-direction:column;gap:0;margin-bottom:16px;border:1px solid #e8edf2;border-radius:4px;overflow:hidden;">${[['Subject',g.subject||'—'],['Type',g.type||'—'],['Date',g.date||'—']].map(([l,v],i)=>`<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;${i<2?'border-bottom:1px solid #f0f4f8;':''}background:#fff;"><span style="font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#9ab0c6;">${l}</span><span style="font-size:13px;font-weight:600;color:#0d1f35;">${escHtml(v)}</span></div>`).join('')}</div>${g.notes?`<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:4px;padding:14px;margin-bottom:14px;"><p style="font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#1e3a8a;margin:0 0 6px;">Notes</p><p style="font-size:12.5px;color:#374f6b;font-weight:400;margin:0;line-height:1.6;white-space:pre-wrap;">${escHtml(g.notes)}</p></div>`:''}`;
    openOverlay('assignmentModal', 'assignmentModalInner');
};

window.closeAssignmentModal = function() { closeOverlay('assignmentModal', 'assignmentModalInner'); };

// ── 14. ARCHIVE ───────────────────────────────────────────────────────────────
window.archiveStudent = function() {
    const s = allStudentsCache.find(x => x.id === currentStudentId);
    document.getElementById('archiveStudentName').textContent = s ? s.name : 'this student';
    document.getElementById('optArchive').checked = true;
    window.toggleArchiveType();
    document.getElementById('releaseReason').value = '';
    document.getElementById('archiveNotes').value  = '';
    openOverlay('archiveModal', 'archiveModalInner');
};

window.closeArchiveModal  = function() { closeOverlay('archiveModal', 'archiveModalInner'); };

window.toggleArchiveType = function() {
    const isRelease = document.getElementById('optRelease').checked;
    const rf        = document.getElementById('releaseFields');
    if (isRelease) rf.classList.remove('hidden');
    else rf.classList.add('hidden');
};

document.getElementById('confirmArchiveBtn').addEventListener('click', async () => {
    const isRelease     = document.getElementById('optRelease').checked;
    const releaseReason = document.getElementById('releaseReason').value;
    const notes         = document.getElementById('archiveNotes').value.trim();

    if (isRelease && !releaseReason) { alert('Please select a departure reason to close enrollment.'); return; }

    const btn = document.getElementById('confirmArchiveBtn');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing…'; btn.disabled = true;

    try {
        const s     = allStudentsCache.find(x => x.id === currentStudentId);
        const batch = writeBatch(db);

        let finalStatus   = 'Archived';
        let leaveSchool   = false;
        let historyReason = 'Internally Archived';

        if (isRelease) {
            leaveSchool   = true;
            historyReason = releaseReason;
            if (releaseReason === 'Transferred')   finalStatus = 'Transferred';
            else if (releaseReason === 'Graduated') finalStatus = 'Graduated';
            else finalStatus = 'Archived';
        }

        const snapshot = {
            schoolId: session.schoolId, schoolName: session.schoolName || session.schoolId,
            teacherId: s?.teacherId || '', className: s?.className || '',
            leftAt: new Date().toISOString(), reason: historyReason,
            ...(notes ? { notes } : {})
        };

        batch.update(doc(db, 'students', currentStudentId), {
            enrollmentStatus: finalStatus,
            currentSchoolId:  leaveSchool ? '' : session.schoolId,
            teacherId: '', className: '',
            academicHistory: arrayUnion(snapshot)
        });

        if (leaveSchool) {
            batch.set(doc(collection(db, 'schools', session.schoolId, 'notifications')), {
                type: 'student_enrollment_closed', studentId: currentStudentId,
                studentName: s?.name || '', reason: historyReason,
                closedBy: session.teacherData?.name || 'Teacher', closedAt: new Date().toISOString()
            });
        }

        await batch.commit();
        window.closeArchiveModal();
        window.closeStudentPanel();
        await loadStudents();
    } catch (e) {
        console.error('[Roster] archive:', e);
        alert('Critical failure. Record preserved.');
    }

    btn.innerHTML = '<i class="fa-solid fa-box-archive"></i> Confirm Action'; btn.disabled = false;
});

// ── 15. EXPORT ────────────────────────────────────────────────────────────────
window.exportRosterCSV = function() {
    const rows = [['Global ID','Name','Class','Parent Phone','Parent PIN']];
    allStudentsCache.forEach(s => rows.push([s.id, s.name, s.className||'', s.parentPhone||'', s.pin]));
    downloadCSV(rows, `${session.schoolId}_roster.csv`);
};

window.printRoster = function() { window.print(); };

// ── 16. XSS PROTECTION ───────────────────────────────────────────────────────
function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

// ── FIRE ──────────────────────────────────────────────────────────────────────
init();
