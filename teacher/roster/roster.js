import { db } from '../../assets/js/firebase-init.js';
import { collection, query, where, getDocs, getDoc, doc, updateDoc, addDoc, setDoc, arrayUnion, writeBatch } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth, setSessionData } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { openOverlay, closeOverlay, showMsg, gradeColorClass, standingBadge, standingText, gradeFill, letterGrade, downloadCSV, calculateWeightedAverage } from '../../assets/js/utils.js';

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
let cachedEvaluations       = []; 

const DEFAULT_GRADE_TYPES = ['Test', 'Quiz', 'Assignment', 'Homework', 'Project', 'Midterm Exam', 'Final Exam'];

// New Global State for Evaluation Stars
window.evalRatings = {
    academicMastery: 0, taskExecution: 0, engagement: 0,
    academicGrowth: 0, socialDynamics: 0, resilience: 0,
    ruleAdherence: 0, conflictResolution: 0, respectAuthority: 0
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
    
    // Initialize stars
    window.buildStarGroups();
}

// ── 4. SCHOOL PLAN LIMIT ──────────────────────────────────────────────────────
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

        const semSel   = document.getElementById('activeSemester');
        const sbPeriod = document.getElementById('sb-period');
        
        // Also populate eval dropdown
        const evalSemSel = document.getElementById('evalSemester');
        if (evalSemSel) evalSemSel.innerHTML = '';

        if (semSel) {
            semSel.innerHTML = '';
            rawSemesters.forEach(s => {
                const opt = document.createElement('option');
                opt.value = s.id; opt.textContent = s.name;
                if (s.id === activeId) opt.selected = true;
                semSel.appendChild(opt);
                
                if(evalSemSel) {
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
    tbody.innerHTML = `<tr><td colspan="9"><div class="table-loader"><i class="fa-solid fa-spinner fa-spin"></i><p>Loading roster…</p></div></td></tr>`;

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
            tbody.innerHTML = `<tr><td colspan="9"><div class="table-loader"><i class="fa-solid fa-user-plus" style="color:#c5d0db;"></i><p>No students yet — enroll your first student to get started.</p></div></td></tr>`;
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
            // UPDATED: Using Teacher-Specific Grade Types
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
                <td><span class="pin-badge">${escHtml(s.pin||'—')}</span></td>
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
        document.getElementById('studentsTableBody').innerHTML = `<tr><td colspan="9"><div class="table-loader"><i class="fa-solid fa-triangle-exclamation" style="color:#dc2626;"></i><p style="color:#dc2626;">Error loading roster. Please refresh the page.</p></div></td></tr>`;
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

// ── Quick grade — blocks if student has no class ──────────────────────────────
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
window.toggleAddMethod      = function() {};

window.searchStudentRegistry = async function() {
    const rawId      = (document.getElementById('sSearchQuery')?.value || '').trim().toUpperCase();
    const resultsDiv = document.getElementById('sSearchResults');

    if (!rawId) { alert('Enter a Student Global ID to search.'); return; }

    if (!/^S\d{2}-[A-Z0-9]{5}$/.test(rawId)) {
        resultsDiv.innerHTML = `<div style="padding:14px;text-align:center;color:#dc2626;font-size:12px;font-weight:700;">
            Invalid format. Student ID should look like S26-XXXXX.
        </div>`;
        resultsDiv.classList.remove('hidden'); return;
    }

    resultsDiv.innerHTML = `<div style="padding:14px;text-align:center;color:#9ab0c6;font-size:12px;">
        <i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i>Searching National Registry…
    </div>`;
    resultsDiv.classList.remove('hidden');

    const btn = document.getElementById('sSearchBtn');
    btn.textContent = '…'; btn.disabled = true;

    try {
        const snap = await getDoc(doc(db, 'students', rawId));

        if (!snap.exists()) {
            resultsDiv.innerHTML = `<div style="padding:14px;text-align:center;color:#9ab0c6;font-size:12px;font-weight:600;">
                No student found with that ID. Fill in the form below to create a new identity.
            </div>`;
            btn.textContent = 'Search'; btn.disabled = false; return;
        }

        const s = { id: snap.id, ...snap.data() };

        if (s.currentSchoolId && s.currentSchoolId !== '') {
            if (s.currentSchoolId !== session.schoolId) {
                // They belong to a completely different school
                resultsDiv.innerHTML = `<div style="padding:14px;text-align:center;color:#dc2626;font-size:12px;font-weight:700;">This student is currently enrolled at another school. Their current school must close enrollment first.</div>`;
                btn.textContent = 'Search'; btn.disabled = false; return;
            } else {
                // They belong to THIS school. Let's see if they already have a teacher.
                if (s.teacherId && s.teacherId !== '') {
                    if (s.teacherId === session.teacherId) {
                        resultsDiv.innerHTML = `<div style="padding:14px;text-align:center;color:#dc2626;font-size:12px;font-weight:700;">This student is already in your active roster!</div>`;
                    } else {
                        resultsDiv.innerHTML = `<div style="padding:14px;text-align:center;color:#dc2626;font-size:12px;font-weight:700;">This student is already assigned to another teacher's roster at this school.</div>`;
                    }
                    btn.textContent = 'Search'; btn.disabled = false; return;
                }
            }
        }

        const lastSchool = s.academicHistory?.length
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
    if (!email) { showMsg('addStudentMsg', 'Email address is required so the student can recover their PIN.', true); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showMsg('addStudentMsg', 'Please enter a valid email address.', true); return; }

    btn.textContent = 'Saving…'; btn.disabled = true;

    try {
        // --- NEW: Check if email is already in use globally ---
        const emailCheckQ = query(collection(db, 'students'), where('email', '==', email));
        const emailCheckSnap = await getDocs(emailCheckQ);
        if (!emailCheckSnap.empty) {
            showMsg('addStudentMsg', 'This email address is already in use by another student.', true);
            btn.textContent = 'Create New Student Identity'; btn.disabled = false;
            return;
        }
        // ------------------------------------------------------

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

    if(tabName === 'grades') {
        btnG.style.borderBottomColor = '#0ea871'; btnG.style.color = '#0d1f35';
        btnE.style.borderBottomColor = 'transparent'; btnE.style.color = '#6b84a0';
        conG.classList.remove('hidden');
        conE.classList.add('hidden');
    } else {
        btnE.style.borderBottomColor = '#0ea871'; btnE.style.color = '#0d1f35';
        btnG.style.borderBottomColor = 'transparent'; btnG.style.color = '#6b84a0';
        conE.classList.remove('hidden');
        conG.classList.add('hidden');
    }
};

window.openStudentPanel = async function(studentId) {
    currentStudentId = studentId;
    const student    = allStudentsCache.find(s => s.id === studentId);

    document.getElementById('sPanelName').textContent = student?.name || 'Student';
    document.getElementById('sPanelMeta').textContent =
        [student?.className, student?.parentPhone].filter(Boolean).join(' · ') || '—';

    togglePinResetUI(false);
    window.switchStudentTab('grades'); // Default to grades tab

    document.getElementById('spinReadonly').textContent = student?.pin || '—';
    document.getElementById('sPanelLoader').style.display = 'flex';
    document.getElementById('sViewMode').classList.add('hidden');
    document.getElementById('sEditForm').classList.add('hidden');

    const qGBtn = document.getElementById('spQuickGradeBtn2');
    if (qGBtn) {
        if (!isSemesterLocked) {
            qGBtn.style.display = 'inline-flex';
            qGBtn.onclick = () => { window.closeStudentPanel(); window.quickGradeStudent(studentId); };
        } else { qGBtn.style.display = 'none'; }
    }

    openOverlay('studentPanel', 'studentPanelInner');

    document.getElementById('editSName').value       = student?.name        || '';
    document.getElementById('editSDob').value        = student?.dob         || '';
    document.getElementById('editSParentName').value = student?.parentName  || '';
    document.getElementById('editSPhone').value      = student?.parentPhone || '';

    const classSel = document.getElementById('editSClass');
    const classes  = getClasses().filter(Boolean);
    classSel.innerHTML = classes.map(c =>
        `<option value="${escHtml(c)}" ${c === student?.className ? 'selected' : ''}>${escHtml(c)}</option>`
    ).join('');
    classSel.dataset.original = student?.className || '';
    document.getElementById('editSClassReasonWrap').classList.add('hidden');
    document.getElementById('editSClassReason').value = '';

    document.getElementById('sInfoGrid').innerHTML = [
        ['Name',         student?.name         || '—'],
        ['Global ID',    student?.id           || '—'],
        ['Class',        student?.className    || '<span style="color:#d97706;font-weight:700;">Unassigned — cannot enter grades</span>'],
        ['Email',        student?.email        || '<span style="color:#d97706;font-weight:700;">Not set — required for PIN recovery</span>'],
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
    document.getElementById('sPanelSemName').textContent       = semName;
    document.getElementById('sPanelFilterSubject').value       = '';
    document.getElementById('sPanelFilterType').value          = '';

    try {
        // Load Grades from Global Passport
        const gradesSnap = await getDocs(query(collection(db, 'students', studentId, 'grades'), where('schoolId', '==', session.schoolId)));
        currentStudentGradesCache = [];
        gradesSnap.forEach(d => { const g = { id: d.id, ...d.data() }; if (g.semesterId === semId) currentStudentGradesCache.push(g); });

        const subjSet = [...new Set(currentStudentGradesCache.map(g => g.subject || 'Uncategorized'))].sort();
        document.getElementById('sPanelFilterSubject').innerHTML = '<option value="">All Subjects</option>' + subjSet.map(s => `<option value="${escHtml(s)}">${escHtml(s)}</option>`).join('');
        document.getElementById('sPanelFilterType').innerHTML    = '<option value="">All Types</option>' + getGradeTypes().map(t => `<option value="${escHtml(t.name || t)}">${escHtml(t.name || t)}</option>`).join('');
        window.renderStudentGrades();
        
        // Load Evaluations
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
        // UPDATED: Using Teacher-Specific Grade Types
        const avg = calculateWeightedAverage(grades, session.teacherData.gradeTypes || getGradeTypes());
        const rows = grades.sort((a,b) => (b.date||'').localeCompare(a.date||'')).map(g => {
            gradeDetailCache[g.id] = g;
            const pct   = g.max ? Math.round(g.score/g.max*100) : null;
            const color = pct >= 75 ? '#065f46' : pct >= 65 ? '#78350f' : '#7f1d1d';
            const bgCol = pct >= 90 ? '#dcfce7' : pct >= 80 ? '#dbeafe' : pct >= 70 ? '#ccfbf1' : pct >= 65 ? '#fef3c7' : '#fee2e2';
            const bdCol = pct >= 90 ? '#bbf7d0' : pct >= 80 ? '#bfdbfe' : pct >= 70 ? '#99f6e4' : pct >= 65 ? '#fde68a' : '#fecaca';
            const adminTag = g.enteredByAdmin ? `<span style="font-size:9px;font-weight:700;color:#2563eb;background:#eff6ff;border:1px solid #bfdbfe;padding:1px 5px;border-radius:3px;margin-left:4px;">Admin</span>` : '';
            return `<div onclick="window.openAssignmentModal('${g.id}')" style="display:flex;align-items:center;justify-content:space-between;background:#fff;border:1px solid #e8edf2;border-radius:3px;padding:10px 14px;cursor:pointer;transition:border-color 0.12s;" onmouseover="this.style.borderColor='#0ea871';this.style.background='#f8fefb'" onmouseout="this.style.borderColor='#e8edf2';this.style.background='#fff'">
                <div style="flex:1;min-width:0;"><p style="font-size:12.5px;font-weight:600;color:#0d1f35;margin:0 0 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(g.title||'Assessment')}${adminTag}</p><p style="font-size:11px;color:#9ab0c6;font-weight:400;margin:0;">${escHtml(g.type||'')}${g.date?' · '+g.date:''}</p></div>
                <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;margin-left:16px;"><span style="font-size:12px;font-weight:600;color:${color};font-family:'DM Mono',monospace;">${g.score}/${g.max||'?'}</span><span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:3px;background:${bgCol};border:1px solid ${bdCol};color:${color};font-family:'DM Mono',monospace;">${pct!==null?pct+'%':'—'}</span></div>
            </div>`;
        }).join('');

        const avgR   = Math.round(avg);
        const hdColor = avgR >= 90 ? '#14532d' : avgR >= 80 ? '#1e3a8a' : avgR >= 70 ? '#134e4a' : avgR >= 65 ? '#78350f' : '#7f1d1d';
        const hdBg    = avgR >= 90 ? '#dcfce7' : avgR >= 80 ? '#dbeafe' : avgR >= 70 ? '#ccfbf1' : avgR >= 65 ? '#fef3c7' : '#fee2e2';
        const hdBd    = avgR >= 90 ? '#bbf7d0' : avgR >= 80 ? '#bfdbfe' : avgR >= 70 ? '#99f6e4' : avgR >= 65 ? '#fde68a' : '#fecaca';

        return `<div style="border:1px solid #dce3ed;border-radius:4px;overflow:hidden;background:#fff;">
            <div onclick="window.toggleAccordion(this)" style="display:flex;align-items:center;justify-content:space-between;padding:13px 16px;cursor:pointer;background:#fff;transition:background 0.12s;" onmouseover="this.style.background='#f8fafb'" onmouseout="this.style.background='#fff'">
                <div style="display:flex;align-items:center;gap:12px;"><div style="width:32px;height:32px;border-radius:4px;background:#0d1f35;color:#fff;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;">${escHtml(subject.charAt(0))}</div><div><p style="font-size:13px;font-weight:700;color:#0d1f35;margin:0;">${escHtml(subject)}</p><p style="font-size:10.5px;color:#9ab0c6;font-weight:400;margin:0;">${grades.length} assessment${grades.length!==1?'s':''}</p></div></div>
                <div style="display:flex;align-items:center;gap:10px;"><span style="font-size:11px;font-weight:700;padding:3px 10px;border-radius:3px;background:${hdBg};border:1px solid ${hdBd};color:${hdColor};font-family:'DM Mono',monospace;">${avgR}% · ${letterGrade(avg)}</span><i class="fa-solid fa-chevron-down" style="font-size:11px;color:#9ab0c6;transition:transform 0.2s;"></i></div>
            </div>
            <div class="subject-body open" style="border-top:1px solid #f0f4f8;"><div style="padding:10px 12px;background:#f8fafb;display:flex;flex-direction:column;gap:6px;">${rows}</div></div>
        </div>`;
    }).join('');
};

window.toggleAccordion = function(header) {
    const body    = header.nextElementSibling;
    body.classList.toggle('open');
    const chevron = header.querySelector('.fa-chevron-down');
    if (chevron) chevron.style.transform = body.classList.contains('open') ? 'rotate(180deg)' : 'rotate(0)';
};

// ── 10.5. EVALUATIONS LOGIC (NEW MATRIX) ──────────────────────────────────────
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
        if(btn.tagName === 'BUTTON') {
            if(parseInt(btn.dataset.val) <= val) {
                btn.classList.add('star-active');
            } else {
                btn.classList.remove('star-active');
            }
        }
    });
};

window.hoverStars = function(field, val) {
    document.querySelectorAll(`[data-field="${field}"]`).forEach(btn => {
        if(btn.tagName === 'BUTTON') {
            if(parseInt(btn.dataset.val) <= val) {
                btn.classList.add('star-active');
            } else {
                btn.classList.remove('star-active');
            }
        }
    });
};

window.setRating = function(field, val) {
    window.evalRatings[field] = val;
    window.renderStars(field);
};

window.openEvalModal = function() {
    document.getElementById('evalDate').value = new Date().toISOString().split('T')[0];
    
    document.querySelectorAll('.eval-section textarea, .eval-section select').forEach(el => el.value = '');
    Object.keys(window.evalRatings).forEach(k => window.evalRatings[k] = 0);
    Object.keys(window.evalRatings).forEach(k => window.renderStars(k));
    
    document.getElementById('evalType').value = 'academic';
    window.toggleEvalType();
    
    openOverlay('evalModal', 'evalModalInner');
};

window.closeEvalModal = function() { closeOverlay('evalModal', 'evalModalInner'); };

window.toggleEvalType = function() {
    const type = document.getElementById('evalType').value;
    document.getElementById('type-academic').classList.toggle('hidden', type !== 'academic');
    document.getElementById('type-eoy').classList.toggle('hidden', type !== 'end_of_year');
    document.getElementById('type-behavioral').classList.toggle('hidden', type !== 'behavioral');
};

window.saveEvaluation = async function() {
    const type = document.getElementById('evalType').value;
    const semId = document.getElementById('evalSemester').value;
    const semName = document.getElementById('evalSemester').options[document.getElementById('evalSemester').selectedIndex].text;
    const date = document.getElementById('evalDate').value;
    const btn = document.getElementById('btnSubmitEval');
    
    if(!semId || !date) { alert("Please ensure Semester and Date are filled."); return; }

    let payload = {
        type: type,
        schoolId: session.schoolId,
        teacherId: session.teacherId,
        teacherName: session.teacherData.name,
        semesterId: semId,
        semesterName: semName,
        date: date,
        createdAt: new Date().toISOString()
    };

    if(type === 'academic') {
        if(!window.evalRatings.academicMastery || !window.evalRatings.taskExecution || !window.evalRatings.engagement) {
            alert("Please rate all quantitative metrics."); return;
        }
        payload.ratings = {
            mastery: window.evalRatings.academicMastery,
            execution: window.evalRatings.taskExecution,
            engagement: window.evalRatings.engagement
        };
        payload.written = {
            strengths: document.getElementById('evalAcadStrengths').value.trim(),
            growth: document.getElementById('evalAcadGrowth').value.trim(),
            steps: document.getElementById('evalAcadSteps').value.trim()
        };
    } 
    else if (type === 'end_of_year') {
        if(!window.evalRatings.academicGrowth || !window.evalRatings.socialDynamics || !window.evalRatings.resilience) {
            alert("Please rate all summative metrics."); return;
        }
        payload.ratings = {
            growth: window.evalRatings.academicGrowth,
            social: window.evalRatings.socialDynamics,
            resilience: window.evalRatings.resilience
        };
        payload.written = {
            narrative: document.getElementById('evalEoyNarrative').value.trim(),
            interventions: document.getElementById('evalEoyInterventions').value.trim()
        };
        payload.status = document.getElementById('evalEoyStatus').value;
        if(!payload.status) { alert("Please select a Promotion Status."); return; }
    }
    else if (type === 'behavioral') {
        if(!window.evalRatings.ruleAdherence || !window.evalRatings.conflictResolution || !window.evalRatings.respectAuthority) {
            alert("Please rate all conduct metrics."); return;
        }
        payload.ratings = {
            adherence: window.evalRatings.ruleAdherence,
            resolution: window.evalRatings.conflictResolution,
            respect: window.evalRatings.respectAuthority
        };
        payload.written = {
            description: document.getElementById('evalBehDesc').value.trim(),
            prior: document.getElementById('evalBehPrior').value.trim(),
            actionPlan: document.getElementById('evalBehAction').value.trim()
        };
        payload.status = document.getElementById('evalBehStatus').value;
        if(!payload.status) { alert("Please select an Action Taken."); return; }
    }

    btn.textContent = 'Saving...'; btn.disabled = true;

    try {
        await addDoc(collection(db, 'students', currentStudentId, 'evaluations'), payload);
        window.closeEvalModal();
        await window.loadStudentEvaluations(currentStudentId);
    } catch (e) {
        console.error("Error saving evaluation", e);
        alert("Failed to save evaluation.");
    }
    btn.textContent = 'Save to Formal Record'; btn.disabled = false;
};

window.loadStudentEvaluations = async function(studentId) {
    const list = document.getElementById('evaluationsList');
    const noMsg = document.getElementById('noEvaluationsMsg');
    list.innerHTML = '';
    cachedEvaluations = [];

    try {
        const q = query(
            collection(db, 'students', studentId, 'evaluations'), 
            where('schoolId', '==', session.schoolId)
        );
        const snap = await getDocs(q);
        
        snap.forEach(d => {
            cachedEvaluations.push({ id: d.id, ...d.data() });
        });

        cachedEvaluations.sort((a,b) => new Date(b.date) - new Date(a.date));

        if(cachedEvaluations.length === 0) {
            noMsg.classList.remove('hidden');
        } else {
            noMsg.classList.add('hidden');
            
            cachedEvaluations.forEach(ev => {
                let badgeClass = '';
                let typeLabel = '';
                let highlightText = '';
                
                if(ev.type === 'academic') {
                    badgeClass = 'background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;';
                    typeLabel = 'Academic Progress';
                } else if(ev.type === 'end_of_year') {
                    badgeClass = 'background:#fef3c7;color:#b45309;border:1px solid #fde68a;';
                    typeLabel = 'Comprehensive End-of-Year';
                    highlightText = `<div style="margin-top:10px;padding:6px 10px;background:#f8fafb;border-radius:4px;font-size:11px;font-weight:700;color:#0d1f35;"><i class="fa-solid fa-award" style="color:#f59e0b;margin-right:5px;"></i> Status: ${ev.status}</div>`;
                } else if(ev.type === 'behavioral') {
                    badgeClass = 'background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;';
                    typeLabel = 'Behavioral Intervention';
                    highlightText = `<div style="margin-top:10px;padding:6px 10px;background:#fff0f3;border-radius:4px;font-size:11px;font-weight:700;color:#be1240;"><i class="fa-solid fa-triangle-exclamation" style="margin-right:5px;"></i> Action: ${ev.status}</div>`;
                }

                const card = document.createElement('div');
                card.style.cssText = 'background:#fff;border:1px solid #dce3ed;border-radius:4px;padding:16px;display:flex;flex-direction:column;gap:8px;';
                card.innerHTML = `
                    <div style="display:flex;justify-content:space-between;align-items:flex-start;">
                        <div>
                            <span style="font-size:10px;font-weight:700;padding:3px 8px;border-radius:99px;text-transform:uppercase;letter-spacing:0.05em;${badgeClass}">${typeLabel}</span>
                            <h4 style="font-size:14px;font-weight:700;color:#0d1f35;margin:8px 0 2px;">${ev.semesterName}</h4>
                            <p style="font-size:11px;color:#6b84a0;margin:0;">Filed by ${ev.teacherName} on ${ev.date}</p>
                        </div>
                        <button onclick="window.printEvaluation('${ev.id}')" style="background:none;border:1px solid #dce3ed;border-radius:4px;padding:6px 10px;color:#374f6b;font-size:11px;font-weight:600;cursor:pointer;transition:all 0.15s;" onmouseover="this.style.background='#f8fafb';this.style.borderColor='#b8c5d4'" onmouseout="this.style.background='none';this.style.borderColor='#dce3ed'">
                            <i class="fa-solid fa-print"></i> Print Matrix
                        </button>
                    </div>
                    ${highlightText}
                `;
                list.appendChild(card);
            });
        }
    } catch (e) {
        console.error("Error loading evaluations", e);
        noMsg.classList.remove('hidden');
    }
};

window.printEvaluation = function(evalId) {
    const ev = cachedEvaluations.find(e => e.id === evalId);
    if(!ev) return;
    const student = allStudentsCache.find(s => s.id === currentStudentId);

    // Apply White-labeled Logo if the element exists in HTML
    const ptLogo = document.getElementById('ptSchoolLogo');
    if (ptLogo) ptLogo.src = session.logo || '../../assets/images/logo.png';

    document.getElementById('ptSchoolName').textContent = session.schoolName || 'ConnectUs Partner School';
    document.getElementById('ptStudentName').textContent = student?.name || '—';
    document.getElementById('ptStudentId').textContent = student?.id || '—';
    document.getElementById('ptEvalContext').textContent = `${ev.semesterName} · Filed ${ev.date} by ${ev.teacherName}`;

    let typeStr = "";
    let metricsHtml = "";
    let textHtml = "";

    if (ev.type === 'academic') {
        typeStr = "Academic Progress Matrix";
        metricsHtml = `
            <div class="print-metric-row"><span class="print-metric-label">Subject Mastery</span><span class="print-metric-value">${ev.ratings.mastery}/5</span></div>
            <div class="print-metric-row"><span class="print-metric-label">Task Execution</span><span class="print-metric-value">${ev.ratings.execution}/5</span></div>
            <div class="print-metric-row"><span class="print-metric-label">Classroom Engagement</span><span class="print-metric-value">${ev.ratings.engagement}/5</span></div>
        `;
        textHtml = `
            <div class="print-text-block"><div class="print-text-label">Key Academic Strengths</div><p class="print-text-content">${escHtml(ev.written.strengths) || 'None documented'}</p></div>
            <div class="print-text-block"><div class="print-text-label">Areas for Growth</div><p class="print-text-content">${escHtml(ev.written.growth) || 'None documented'}</p></div>
            <div class="print-text-block"><div class="print-text-label">Actionable Next Steps</div><p class="print-text-content">${escHtml(ev.written.steps) || 'None documented'}</p></div>
        `;
    } else if (ev.type === 'end_of_year') {
        typeStr = "Comprehensive End-of-Year Matrix";
        metricsHtml = `
            <div class="print-metric-row"><span class="print-metric-label">Overall Academic Growth</span><span class="print-metric-value">${ev.ratings.growth}/5</span></div>
            <div class="print-metric-row"><span class="print-metric-label">Social & Peer Dynamics</span><span class="print-metric-value">${ev.ratings.social}/5</span></div>
            <div class="print-metric-row"><span class="print-metric-label">Resilience & Effort</span><span class="print-metric-value">${ev.ratings.resilience}/5</span></div>
        `;
        textHtml = `
            <div class="print-text-block"><div class="print-text-label">Year-in-Review Narrative</div><p class="print-text-content">${escHtml(ev.written.narrative) || 'None documented'}</p></div>
            <div class="print-text-block"><div class="print-text-label">Recommended Interventions</div><p class="print-text-content">${escHtml(ev.written.interventions) || 'N/A'}</p></div>
            <div class="print-text-block" style="border:1px solid #000;"><div class="print-text-label" style="color:#000;">Promotion Status</div><p class="print-text-content" style="font-weight:bold;font-size:14px;">${ev.status}</p></div>
        `;
    } else if (ev.type === 'behavioral') {
        typeStr = "Behavioral & Conduct Intervention Matrix";
        metricsHtml = `
            <div class="print-metric-row"><span class="print-metric-label">Rule Adherence</span><span class="print-metric-value">${ev.ratings.adherence}/5</span></div>
            <div class="print-metric-row"><span class="print-metric-label">Conflict Resolution</span><span class="print-metric-value">${ev.ratings.resolution}/5</span></div>
            <div class="print-metric-row"><span class="print-metric-label">Respect for Authority</span><span class="print-metric-value">${ev.ratings.respect}/5</span></div>
        `;
        textHtml = `
            <div class="print-text-block"><div class="print-text-label">Conduct Description</div><p class="print-text-content">${escHtml(ev.written.description) || 'None documented'}</p></div>
            <div class="print-text-block"><div class="print-text-label">Prior Interventions Attempted</div><p class="print-text-content">${escHtml(ev.written.prior) || 'None documented'}</p></div>
            <div class="print-text-block"><div class="print-text-label">Corrective Action Plan</div><p class="print-text-content">${escHtml(ev.written.actionPlan) || 'None documented'}</p></div>
            <div class="print-text-block" style="border:2px solid #000;"><div class="print-text-label" style="color:#000;">Formal Action Taken</div><p class="print-text-content" style="font-weight:bold;font-size:14px;text-transform:uppercase;">${ev.status}</p></div>
        `;
    }

    document.getElementById('ptEvalType').textContent = typeStr;
    document.getElementById('ptMetricsList').innerHTML = metricsHtml;
    document.getElementById('ptTextList').innerHTML = textHtml;

    window.print();
};

// ── 11. EDIT STUDENT ──────────────────────────────────────────────────────────
window.toggleStudentEdit = function(show) {
    const form = document.getElementById('sEditForm');
    const isVisible = show !== undefined ? show : form.classList.contains('hidden');
    form.classList.toggle('hidden', !isVisible);
    document.getElementById('editStudentMsg').classList.add('hidden');
};

window.checkClassChange = function() {
    const sel  = document.getElementById('editSClass');
    const wrap = document.getElementById('editSClassReasonWrap');
    if (sel.value !== sel.dataset.original && sel.dataset.original !== '') wrap.classList.remove('hidden');
    else wrap.classList.add('hidden');
};

document.getElementById('saveStudentEditBtn').addEventListener('click', async () => {
    const btn           = document.getElementById('saveStudentEditBtn');
    const newClass      = document.getElementById('editSClass').value;
    const originalClass = document.getElementById('editSClass').dataset.original;
    const reason        = document.getElementById('editSClassReason').value.trim();
    if (newClass !== originalClass && originalClass !== '' && !reason) {
        showMsg('editStudentMsg', "You must provide a reason for changing the student's class.", true); return;
    }
    btn.textContent = 'Saving…'; btn.disabled = true;
    try {
        const u = {
            name:        document.getElementById('editSName').value.trim(),
            dob:         document.getElementById('editSDob').value,
            parentName:  document.getElementById('editSParentName').value.trim(),
            parentPhone: document.getElementById('editSPhone').value.trim(),
            className:   newClass
        };
        if (newClass !== originalClass && originalClass !== '') {
            u.lastClassChangeReason = reason; u.lastClassChangeDate = new Date().toISOString();
        }
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
    btn.textContent = 'Save Changes'; btn.disabled = false;
});

// ── 12. PIN ───────────────────────────────────────────────────────────────────
window.togglePinResetUI = function(show) {
    document.getElementById('pinDisplayArea').classList.toggle('hidden',  show);
    document.getElementById('pinEditArea').classList.toggle('hidden',    !show);
    if (show) document.getElementById('inlineNewPin').value = '';
};

window.saveInlinePin = async function() {
    const npin = document.getElementById('inlineNewPin').value.trim();
    if (!npin || npin.length < 4) { alert('PIN must be 4–6 digits.'); return; }
    const btn = document.getElementById('inlinePinSaveBtn');
    btn.textContent = '…'; btn.disabled = true;
    try {
        await updateDoc(doc(db, 'students', currentStudentId), { pin: npin });
        const idx = allStudentsCache.findIndex(s => s.id === currentStudentId);
        if (idx !== -1) allStudentsCache[idx].pin = npin;
        document.getElementById('spinReadonly').textContent = npin;
        window.togglePinResetUI(false);
        await loadStudents();
    } catch (e) { console.error('[Roster] saveInlinePin:', e); alert('Error saving PIN.'); }
    btn.textContent = 'Save'; btn.disabled = false;
};

// ── 13. ASSIGNMENT MODAL ──────────────────────────────────────────────────────
window.openAssignmentModal = function(gradeId) {
    const g = gradeDetailCache[gradeId]; if (!g) return;
    const pct   = g.max ? Math.round(g.score/g.max*100) : null;
    const fill  = gradeFill(pct||0);
    const color = pct>=90?'#065f46':pct>=80?'#1e3a8a':pct>=70?'#134e4a':pct>=65?'#78350f':'#7f1d1d';
    const bg    = pct>=90?'#dcfce7':pct>=80?'#dbeafe':pct>=70?'#ccfbf1':pct>=65?'#fef3c7':'#fee2e2';
    const bd    = pct>=90?'#bbf7d0':pct>=80?'#bfdbfe':pct>=70?'#99f6e4':pct>=65?'#fde68a':'#fecaca';
    const adminNote = g.enteredByAdmin ? `<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:4px;padding:12px;margin-bottom:12px;"><p style="font-size:9.5px;font-weight:700;text-transform:uppercase;color:#2563eb;margin:0 0 4px;">Admin Entry</p><p style="font-size:12px;color:#374f6b;margin:0;">Entered by ${escHtml(g.adminName||'Admin')} (${g.adminRole==='super_admin'?'Super Admin':'Sub-Admin'})</p></div>` : '';
    document.getElementById('aModalTitle').textContent = g.title || 'Assessment Detail';
    document.getElementById('aModalBody').innerHTML = `<div style="text-align:center;margin-bottom:20px;"><div style="font-size:42px;font-weight:700;color:${color};font-family:'DM Mono',monospace;line-height:1;">${g.score}<span style="font-size:20px;color:#9ab0c6;"> / ${g.max||'?'}</span></div>${pct!==null?`<div style="display:flex;align-items:center;justify-content:center;gap:12px;margin-top:8px;"><span style="font-size:18px;font-weight:700;color:${color};font-family:'DM Mono',monospace;">${pct}%</span><span style="font-size:14px;font-weight:700;padding:4px 14px;border-radius:3px;background:${bg};border:1px solid ${bd};color:${color};">${letterGrade(pct)}</span></div><div style="margin:12px 20px 0;height:8px;background:#f0f4f8;border-radius:2px;overflow:hidden;"><div style="height:100%;width:${Math.min(pct,100)}%;background:${fill};transition:width 0.5s ease;"></div></div>`:''}</div>${adminNote}<div style="display:flex;flex-direction:column;gap:0;margin-bottom:16px;border:1px solid #e8edf2;border-radius:4px;overflow:hidden;">${[['Subject',g.subject||'—'],['Type',g.type||'—'],['Date',g.date||'—']].map(([l,v],i)=>`<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;${i<2?'border-bottom:1px solid #f0f4f8;':''}background:#fff;"><span style="font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#9ab0c6;">${l}</span><span style="font-size:13px;font-weight:600;color:#0d1f35;">${escHtml(v)}</span></div>`).join('')}</div>${g.notes?`<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:4px;padding:14px;margin-bottom:14px;"><p style="font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#1e3a8a;margin:0 0 6px;">Notes</p><p style="font-size:12.5px;color:#374f6b;font-weight:400;margin:0;line-height:1.6;white-space:pre-wrap;">${escHtml(g.notes)}</p></div>`:''}`;
    openOverlay('assignmentModal', 'assignmentModalInner');
};

window.closeAssignmentModal = function() { closeOverlay('assignmentModal', 'assignmentModalInner'); };

// ── 14. ARCHIVE / CLOSE ENROLLMENT HYBRID ────────────────────────────────
window.archiveStudent = function() {
    const s = allStudentsCache.find(x => x.id === currentStudentId);
    document.getElementById('archiveStudentName').textContent = s ? s.name : 'this student';
    
    // Reset modal UI to default (Internal Archive)
    document.getElementById('optArchive').checked = true;
    window.toggleArchiveType();

    // Reset fields
    document.getElementById('releaseReason').value = '';
    document.getElementById('archiveNotes').value  = '';
    
    openOverlay('archiveModal', 'archiveModalInner');
};

window.closeArchiveModal = function() { closeOverlay('archiveModal', 'archiveModalInner'); };

window.toggleArchiveType = function() {
    const isRelease = document.getElementById('optRelease').checked;
    const releaseFields = document.getElementById('releaseFields');
    if (isRelease) releaseFields.classList.remove('hidden');
    else releaseFields.classList.add('hidden');
};

document.getElementById('confirmArchiveBtn').addEventListener('click', async () => {
    const isRelease = document.getElementById('optRelease').checked;
    const releaseReason = document.getElementById('releaseReason').value;
    const notes = document.getElementById('archiveNotes').value.trim();
    
    if (isRelease && !releaseReason) { 
        alert('Please select a departure reason to close enrollment.'); 
        return; 
    }

    const btn = document.getElementById('confirmArchiveBtn');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Processing…'; 
    btn.disabled = true;

    try {
        const s = allStudentsCache.find(x => x.id === currentStudentId);
        const batch = writeBatch(db);
        
        let finalStatus = 'Archived';
        let leaveSchool = false;
        let historyReason = 'Internally Archived';

        if (isRelease) {
            leaveSchool = true;
            historyReason = releaseReason;
            if (releaseReason === 'Transferred') finalStatus = 'Transferred';
            else if (releaseReason === 'Graduated') finalStatus = 'Graduated';
            else finalStatus = 'Archived';
        }

        const snapshot = {
            schoolId: session.schoolId, 
            schoolName: session.schoolName || session.schoolId,
            teacherId: s?.teacherId || '', 
            className: s?.className || '',
            leftAt: new Date().toISOString(), 
            reason: historyReason,
            ...(notes ? { notes } : {})
        };

        batch.update(doc(db, 'students', currentStudentId), {
            enrollmentStatus: finalStatus,
            currentSchoolId:  leaveSchool ? '' : session.schoolId,
            teacherId: '', 
            className: '',
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
        console.error('[Roster] archive/transfer:', e); 
        alert('Critical failure. Record preserved.'); 
    }

    btn.innerHTML = '<i class="fa-solid fa-box-archive mr-2"></i>Confirm Action'; 
    btn.disabled = false;
});

// ── 15. EXPORT & PROFESSIONAL UNOFFICIAL TERM REPORT ──────────────────────────
window.exportRosterCSV = function() {
    const rows = [['Global ID','Name','Class','Parent Phone','Parent PIN']];
    allStudentsCache.forEach(s => rows.push([s.id, s.name, s.className||'', s.parentPhone||'', s.pin]));
    downloadCSV(rows, `${session.schoolId}_roster.csv`);
};

window.printRoster = function() {
    window.print();
};

window.openPrintStudentModal = function() {
    const psSubj = document.getElementById('psSubject');
    psSubj.innerHTML = '<option value="all">All Subjects</option>' +
        getActiveSubjects().map(s => `<option value="${escHtml(s.name)}">${escHtml(s.name)}</option>`).join('');
    openOverlay('printStudentModal', 'printStudentModalInner');
};

window.closePrintStudentModal = function() { closeOverlay('printStudentModal', 'printStudentModalInner'); };

window.executeStudentPrint = async function() {
    const mode = document.getElementById('psMode').value;
    const subjFilter = document.getElementById('psSubject').value;
    const student = allStudentsCache.find(s => s.id === currentStudentId);

    if (!student) return;

    let gradesToPrint = currentStudentGradesCache;
    if (subjFilter !== 'all') {
        gradesToPrint = gradesToPrint.filter(g => g.subject === subjFilter);
    }

    const bySub = {};
    let totalAssessments = 0;
    
    gradesToPrint.forEach(g => {
        const sub = g.subject || 'Uncategorized';
        if (!bySub[sub]) bySub[sub] = [];
        bySub[sub].push(g);
        if (g.max) totalAssessments++;
    });

    // UPDATED: Using Teacher-Specific Grade Types
    const cumulativeAvg = gradesToPrint.length ? calculateWeightedAverage(gradesToPrint, session.teacherData.gradeTypes || getGradeTypes()) : 0;
    const gpaLetter = totalAssessments > 0 ? letterGrade(cumulativeAvg) : 'N/A';

    const semSelect = document.getElementById('activeSemester');
    const semName = semSelect?.options[semSelect.selectedIndex]?.text || 'Active Term';
    const schoolName = session.schoolName || 'ConnectUs School';

    let gradesHtml = Object.keys(bySub).length === 0
        ? `<tr><td colspan="4" style="text-align:center;color:#64748b;font-style:italic;padding:40px;">No grades recorded for this filter.</td></tr>`
        : Object.entries(bySub).sort((a,b) => a[0].localeCompare(b[0])).map(([sub, gList]) => {
            // UPDATED: Using Teacher-Specific Grade Types
            const subAvg = calculateWeightedAverage(gList, session.teacherData.gradeTypes || getGradeTypes());
            let html = `
                <tr style="background:#f8fafc; font-weight:800;">
                    <td style="border-bottom:1px solid #cbd5e1;padding:12px 15px;color:#1e293b;">${escHtml(sub)}</td>
                    <td style="border-bottom:1px solid #cbd5e1;padding:12px 15px;text-align:center;color:#64748b;">${gList.length}</td>
                    <td style="border-bottom:1px solid #cbd5e1;padding:12px 15px;text-align:center;color:#0f172a;">${subAvg}%</td>
                    <td style="border-bottom:1px solid #cbd5e1;padding:12px 15px;text-align:center;color:#0f172a;">${letterGrade(subAvg)}</td>
                </tr>
            `;

            if (mode === 'detailed') {
                gList.sort((a,b) => (b.date||'').localeCompare(a.date||'')).forEach(g => {
                    const pct = g.max ? Math.round((g.score/g.max)*100) : null;
                    html += `
                    <tr style="font-size:11px; background:#fff;">
                        <td style="border-bottom:1px solid #f1f5f9;padding:8px 15px 8px 30px;color:#475569;">
                            ${escHtml(g.title)} <span style="color:#94a3b8;margin-left:6px;">${escHtml(g.type)} · ${g.date}</span>
                        </td>
                        <td style="border-bottom:1px solid #f1f5f9;padding:8px 15px;text-align:center;color:#64748b;font-family:monospace;">${g.score}/${g.max||'?'}</td>
                        <td style="border-bottom:1px solid #f1f5f9;padding:8px 15px;text-align:center;color:#475569;font-family:monospace;">${pct!==null?pct+'%':'-'}</td>
                        <td style="border-bottom:1px solid #f1f5f9;padding:8px 15px;text-align:center;color:#475569;">${pct!==null?letterGrade(pct):'-'}</td>
                    </tr>`;
                });
            }
            return html;
        }).join('');

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Unofficial Term Report — ${escHtml(student.name)}</title>
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&display=swap');
            body { font-family: 'Nunito', sans-serif; padding: 40px; color: #0f172a; line-height: 1.5; margin: 0 auto; max-width: 8.5in; }
            .watermark { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-45deg); font-size: 110px; color: rgba(203, 213, 225, 0.25); font-weight: 900; white-space: nowrap; pointer-events: none; z-index: -1; }
            .header-flex { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px solid #1e1b4b; padding-bottom: 20px; margin-bottom: 30px; }
            .logo { max-height: 60px; max-width: 200px; object-fit: contain; }
            .header-text { text-align: right; }
            .header-text h1 { margin: 0 0 5px; font-size: 24px; font-weight: 900; text-transform: uppercase; color: #1e1b4b; }
            .header-text h2 { margin: 0; font-size: 14px; color: #64748b; font-weight: 700; letter-spacing: 2px; }
            
            .student-info-box { display: flex; border: 1px solid #cbd5e1; border-radius: 8px; overflow: hidden; margin-bottom: 30px; }
            .info-col { flex: 1; padding: 15px 20px; border-right: 1px solid #cbd5e1; }
            .info-col:last-child { border-right: none; background: #f8fafc; }
            .info-item { margin-bottom: 10px; }
            .info-item:last-child { margin-bottom: 0; }
            .info-label { font-size: 10px; text-transform: uppercase; color: #64748b; font-weight: 800; display: block; margin-bottom: 2px; }
            .info-value { font-size: 15px; font-weight: 800; color: #0f172a; }
            
            .analytics-grid { display: flex; gap: 15px; margin-bottom: 30px; }
            .analytic-card { flex: 1; background: #fff; border: 2px solid #e2e8f0; border-radius: 8px; padding: 15px; text-align: center; }
            .analytic-val { font-size: 28px; font-weight: 900; color: #4338ca; line-height: 1; margin-bottom: 5px; }
            .analytic-lbl { font-size: 11px; font-weight: 800; color: #64748b; text-transform: uppercase; letter-spacing: 1px; }

            table { width: 100%; border-collapse: collapse; font-size: 13px; border: 1px solid #e2e8f0; }
            th { background: #1e1b4b; color: #fff; padding: 10px 15px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; }
            th.center { text-align: center; }

            .footer { margin-top: 50px; text-align: center; font-size: 11px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 20px; font-weight: 600; }
        </style>
    </head>
    <body>
        <div class="watermark">UNOFFICIAL REPORT</div>
        
        <div class="header-flex">
            <img src="${session.logo || ''}" alt="${escHtml(schoolName)}" class="logo" onerror="this.style.display='none'">
            <div class="header-text">
                <h1>${escHtml(schoolName)}</h1>
                <h2>UNOFFICIAL TERM REPORT</h2>
            </div>
        </div>

        <div class="student-info-box">
            <div class="info-col">
                <div class="info-item"><span class="info-label">Student Name</span><span class="info-value">${escHtml(student.name)}</span></div>
                <div class="info-item"><span class="info-label">Global ID Number</span><span class="info-value" style="font-family:monospace;letter-spacing:1px;">${student.id}</span></div>
            </div>
            <div class="info-col">
                <div class="info-item"><span class="info-label">Academic Term</span><span class="info-value">${escHtml(semName)}</span></div>
                <div class="info-item"><span class="info-label">Current Enrollment</span><span class="info-value">${escHtml(student.className || 'Unassigned')}</span></div>
            </div>
        </div>

        <div class="analytics-grid">
            <div class="analytic-card">
                <div class="analytic-val">${cumulativeAvg}%</div>
                <div class="analytic-lbl">Term Average</div>
            </div>
            <div class="analytic-card">
                <div class="analytic-val">${gpaLetter}</div>
                <div class="analytic-lbl">Overall Grade</div>
            </div>
            <div class="analytic-card">
                <div class="analytic-val">${totalAssessments}</div>
                <div class="analytic-lbl">Total Assessments</div>
            </div>
        </div>

        <table>
            <thead>
                <tr>
                    <th>Subject / Assignment</th>
                    <th class="center">Assessments / Score</th>
                    <th class="center">Average / Pct</th>
                    <th class="center">Grade</th>
                </tr>
            </thead>
            <tbody>${gradesHtml}</tbody>
        </table>

        <div class="footer" style="display:flex; flex-direction:column; justify-content:center; align-items:center; gap:8px;">
            <span><strong>NOTICE:</strong> This document is an unofficial academic report generated for <strong>${escHtml(schoolName)}</strong>.</span>
            <span>${mode === 'summary' ? 'This is a summary report. Details omitted for brevity.' : 'This report includes all detailed assignments for the selected filters.'}</span>
            <span>Date Issued: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</span>
            
            <div style="display:flex; justify-content:center; align-items:center; gap:8px; margin-top:10px;">
                <span>Issued by ${escHtml(schoolName)}</span>
                <span>·</span>
                <img src="../../assets/images/logo.png" style="max-height:20px; object-fit:contain; opacity:0.8;">
                <span style="font-weight:bold; color:#0d1f35;">Powered by ConnectUs</span>
            </div>
        </div>
    </body>
    </html>`;

    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
    
    window.closePrintStudentModal();
    setTimeout(() => w.print(), 800);
};

// ── 16. XSS PROTECTION ───────────────────────────────────────────────────────
function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

// ── FIRE ──────────────────────────────────────────────────────────────────────
init();
