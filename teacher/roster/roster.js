import { db } from '../../assets/js/firebase-init.js';
import { collection, query, where, getDocs, getDoc, doc, updateDoc, addDoc, setDoc, arrayUnion, writeBatch } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { openOverlay, closeOverlay, showMsg, gradeColorClass, standingBadge, standingText, gradeFill, letterGrade, downloadCSV, calculateWeightedAverage } from '../../assets/js/utils.js';

// ── 1. AUTH & LAYOUT ─────────────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    injectTeacherLayout('students', 'My Roster', 'Manage students · PINs · academic standing', true);
}

// ── 2. STATE ─────────────────────────────────────────────────────────────
let allStudentsCache          = [];
let unassignedStudentsCache   = [];
let studentMap                = {};
let currentStudentId          = null;
let currentStudentGradesCache = [];
let rawSemesters              = [];
let isSemesterLocked          = false;
let gradeDetailCache          = {};
let schoolLimit               = 50;
let cachedEvaluations         = [];
let schoolClasses             = []; // ← Live master list from schools/{id}/classes

// ── Report card type state ────────────────────────────────────────────────
let selectedRcType      = 'term';   // 'term' | 'midterm'
let selectedMidtermData = null;     // midterm object from Firestore, or null

// ── Promote state ─────────────────────────────────────────────────────────
let promoteClassTeacherMap = {}; // className → [{id, name}]

const DEFAULT_GRADE_TYPES = ['Test', 'Quiz', 'Assignment', 'Homework', 'Project', 'Midterm Exam', 'Final Exam'];

// ── Evaluation star ratings ───────────────────────────────────────────────
window.evalRatings = {
    academicMastery: 0, taskExecution: 0, engagement: 0,
    criticalThinking: 0, writtenCommunication: 0, oralParticipation: 0,
    overallAcademicGrowth: 0, subjectMasteryAcrossTerms: 0, socialPeerDynamics: 0,
    emotionalResilience: 0, selfRegulationEoy: 0, effortPersistenceYear: 0,
    responseToFeedback: 0, readinessNextGrade: 0,
    ruleAdherence: 0, conflictResolution: 0, respectAuthority: 0,
    peerInteractions: 0, selfRegulation: 0, responseToCorrection: 0,
    emotionalStability: 0,
    academicProgressToDate: 0, workCompletionRate: 0, classParticipation: 0,
    attentionFocus: 0, effortPersistence: 0, behaviourInClass: 0,
    parentEngagement: 0, communicationQuality: 0, followThroughAgreements: 0,
    responseToIntervention: 0, academicEffort: 0, focusAttention: 0,
    independenceInTasks: 0, progressTowardsGoals: 0,
    overallPerformance: 0, effortEngagement: 0, socialSkills: 0,
    workQuality: 0, customProgressGoals: 0
};

// ── Report card ratings ───────────────────────────────────────────────────
window.rcRatings = {
    characterValues:           0,
    respectCourtesy:           0,
    responsibilityReliability: 0,
    cooperationTeamwork:       0,
    leadershipInitiative:      0,
    culturalAwareness:         0,
    behavior: 0, organization: 0, respectfulness: 0, kindness: 0,
    attitudeWork: 0, attitudePeers: 0, academicComprehension: 0,
    effortResilience: 0, participation: 0, punctualityRating: 0
};

// ── Load the school's class list (single source of truth) ─────────────────
async function loadSchoolClasses() {
    try {
        const snap = await getDocs(collection(db, 'schools', session.schoolId, 'classes'));
        schoolClasses = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.name || '').localeCompare(b.name || ''))
            .map(c => c.name)
            .filter(Boolean);
    } catch (e) {
        console.error('[Roster] loadSchoolClasses:', e);
        schoolClasses = [];
    }
}

// ── FIX: Intersect assigned classes with the live master list ─────────────
function getClasses(extra = []) {
    const assigned = session.teacherData.classes || [session.teacherData.className || ''];
    let validClasses = assigned.filter(c => schoolClasses.includes(c));
    extra.forEach(c => { if (c && !validClasses.includes(c)) validClasses.push(c); });
    return validClasses.filter(Boolean);
}

function getGradeTypes() { return session.teacherData.customGradeTypes || DEFAULT_GRADE_TYPES; }

function generateStudentId() {
    const year  = new Date().getFullYear().toString().slice(-2);
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let rand = '';
    for (let i = 0; i < 5; i++) rand += chars.charAt(Math.floor(Math.random() * chars.length));
    return `S${year}-${rand}`;
}

// ── 3. INIT ───────────────────────────────────────────────────────────────
async function init() {
    if (!session) return;

    await loadSchoolClasses();

    const searchInput = document.getElementById('searchInput');
    if (searchInput) searchInput.addEventListener('input', filterStudents);

    document.getElementById('displayTeacherName').textContent = session.teacherData.name;
    document.getElementById('teacherAvatar').textContent      = session.teacherData.name.charAt(0).toUpperCase();
    document.getElementById('sidebarSchoolId').textContent    = session.schoolId;

    const classes = getClasses();

    document.getElementById('displayTeacherClasses').innerHTML =
        classes.map(c => `<span class="class-pill">${c}</span>`).join('') || '<span class="text-xs text-slate-400 italic">No assigned classes</span>';

    const classFilter = document.getElementById('rf-class');
    if (classFilter) {
        classFilter.innerHTML = '<option value="">All Classes</option>' +
            classes.map(c => `<option value="${c}">${c}</option>`).join('');
        if (classes.length <= 1) {
            const wrap = document.getElementById('classFilterWrap');
            if (wrap) wrap.style.display = 'none';
        }
    }

    // Close More menu on outside click
    document.addEventListener('click', (e) => {
        const menu = document.getElementById('rosterMoreMenu');
        const btn  = document.getElementById('rosterMoreBtn');
        if (menu && !menu.classList.contains('hidden') && !menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
            menu.classList.add('hidden');
        }
    });

    await Promise.all([fetchSchoolLimit(), loadSemesters()]);
    await loadStudents();
    window.buildStarGroups();
}

async function fetchSchoolLimit() {
    try {
        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        if (schoolSnap.exists()) {
            const limits = schoolSnap.data().limits || {};
            schoolLimit  = limits.studentLimit || 50;
        }
    } catch (e) { console.error('[Roster] fetchSchoolLimit:', e); }
}

// ── 5. SEMESTERS ─────────────────────────────────────────────────────────
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
    renderRosterPeriodNote(activeSem);
}

// ── GRADING-PERIOD NOTE (awareness only) ──────────────────────────────────
// Amber when the active period ends within 7 days; red once it has passed.
// Hidden otherwise. Reads only the active semester's endDate; writes only to
// the #rosterPeriodNote element.
const PERIOD_WARN_DAYS = 7;

function periodStartOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function renderRosterPeriodNote(activeSem) {
    const el = document.getElementById('rosterPeriodNote');
    if (!el) return;

    if (!activeSem || !activeSem.endDate) {
        el.style.display = 'none';
        el.innerHTML = '';
        return;
    }

    const today = periodStartOfDay(new Date());
    const end   = periodStartOfDay(new Date(activeSem.endDate + 'T00:00:00'));
    const msPerDay = 1000 * 60 * 60 * 24;
    const daysLeft = Math.round((end - today) / msPerDay);

    let bg, border, color, icon, text;

    if (daysLeft < 0) {
        // Period has ended
        bg = '#fee2e2'; border = '#fecaca'; color = '#7f1d1d';
        icon = 'fa-circle-exclamation';
        const ended = Math.abs(daysLeft);
        text = `The grading period <strong>${escHtml(activeSem.name)}</strong> ended ${ended} day${ended !== 1 ? 's' : ''} ago. Make sure all grades and evaluations are finalized.`;
    } else if (daysLeft <= PERIOD_WARN_DAYS) {
        // Period ending soon (includes today = 0)
        bg = '#fef3c7'; border = '#fde68a'; color = '#78350f';
        icon = 'fa-triangle-exclamation';
        const when = daysLeft === 0 ? 'today' : `in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`;
        text = `The grading period <strong>${escHtml(activeSem.name)}</strong> ends ${when}. Be sure to complete any outstanding grades and evaluations before it closes.`;
    } else {
        // Not near the end — stay hidden
        el.style.display = 'none';
        el.innerHTML = '';
        return;
    }

    el.innerHTML = `
        <div style="display:flex;align-items:flex-start;gap:11px;background:${bg};border:1px solid ${border};border-radius:4px;padding:12px 16px;">
            <i class="fa-solid ${icon}" style="color:${color};font-size:14px;margin-top:1px;flex-shrink:0;"></i>
            <p style="font-size:12.5px;color:${color};font-weight:500;margin:0;line-height:1.5;">${text}</p>
        </div>`;
    el.style.display = 'block';
}

// ── 6. LOAD STUDENTS ──────────────────────────────────────────────────────
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

// ── 7. STANDING HELPERS ───────────────────────────────────────────────────
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

// ── 8. FILTERS ────────────────────────────────────────────────────────────
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

// ── 9. ENROLL / CLAIM STUDENT ─────────────────────────────────────────────
window.openAddStudentModal = function() {
    const searchQ = document.getElementById('sSearchQuery');
    const searchR = document.getElementById('sSearchResults');
    if (searchQ) searchQ.value = '';
    if (searchR) { searchR.innerHTML = ''; searchR.classList.add('hidden'); }

    ['sName','sEmail','sParentPhone','sParentName','sDob'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
    });
    document.getElementById('addStudentMsg').classList.add('hidden');

    const classes = getClasses();
    const sel     = document.getElementById('sClass');

    if (classes.length === 0) {
        sel.innerHTML = '<option value="">— No active classes available —</option>';
        sel.disabled = true;
        document.getElementById('sSearchBtn').disabled = true;
        document.getElementById('saveStudentBtn').disabled = true;
        showMsg('addStudentMsg', 'You currently have no active classes assigned. Please contact your administrator to assign classes to your account before enrolling students.', true);
    } else {
        sel.innerHTML = '<option value="">— Select a Class —</option>' +
            classes.map(c => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join('');
        sel.disabled = false;
        document.getElementById('sSearchBtn').disabled = false;
        document.getElementById('saveStudentBtn').disabled = false;
    }

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
        if (e.code === 'permission-denied') {
            resultsDiv.innerHTML = `<div style="padding:14px;text-align:center;color:#9ab0c6;font-size:12px;font-weight:600;">No student found with that ID. Fill in the form below to create a new identity.</div>`;
        } else {
            console.error('[Roster] searchStudentRegistry:', e);
            resultsDiv.innerHTML = `<div style="padding:14px;text-align:center;color:#dc2626;font-size:12px;">Search failed. Try again.</div>`;
        }
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
        const targetEmail = email ? email.toLowerCase() : null;
        if (targetEmail) {
            const regSnap = await getDoc(doc(db, 'registered_emails', targetEmail));
            if (regSnap.exists()) {
                showMsg('addStudentMsg', 'This email address is already in use by another account.', true);
                btn.textContent = 'Create New Student Identity'; btn.disabled = false; return;
            }
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

        const newId  = generateStudentId();
        const batch  = writeBatch(db);

        const studentRef = doc(db, 'students', newId);
        batch.set(studentRef, {
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
            medicalNotes: '', academicHistory: [], classHistory: [],
            createdAt:    new Date().toISOString()
        });

        if (targetEmail) {
            const emailRef = doc(db, 'registered_emails', targetEmail);
            batch.set(emailRef, {
                email: targetEmail, name, role: 'student',
                referenceId: newId, createdAt: new Date().toISOString()
            });
        }

        await batch.commit();
        window.closeAddStudentModal();
        await loadStudents();
    } catch (e) {
        console.error('[Roster] saveStudent:', e);
        showMsg('addStudentMsg', 'Error saving student. Please try again.', true);
    }

    btn.textContent = 'Create New Student Identity'; btn.disabled = false;
});

// ── 10. STUDENT PANEL & TABS ──────────────────────────────────────────────
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

    const classSel = document.getElementById('editSClass');
    const classes  = getClasses([student?.className]);
    classSel.innerHTML = classes.map(c =>
        `<option value="${escHtml(c)}" ${c === student?.className ? 'selected' : ''}>${escHtml(c)}</option>`
    ).join('');
    classSel.dataset.original = student?.className || '';
    document.getElementById('editSClassReasonWrap').classList.add('hidden');
    document.getElementById('editSClassReason').value = '';
    document.getElementById('editClassMsg').classList.add('hidden');

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
        renderPanelMissing(semId);
        await window.loadStudentEvaluations(studentId);
    } catch (e) { console.error('[Roster] openStudentPanel data load:', e); }

    document.getElementById('sPanelLoader').style.display = 'none';
    document.getElementById('sViewMode').classList.remove('hidden');
};

window.closeStudentPanel = function() { closeOverlay('studentPanel', 'studentPanelInner'); };

// ── PANEL "WHAT'S MISSING" BLOCK (awareness only) ─────────────────────────
// Shows gaps in THIS student's grades for the active period — only what the
// teacher grades. Appears only when the active period is ending soon or has
// ended (same window as the roster period note). Reads only
// currentStudentGradesCache; writes only to #sPanelMissing. Never touches grades.
function renderPanelMissing(semId) {
    const el = document.getElementById('sPanelMissing');
    if (!el) return;

    // Gate to the end-of-term window: only surface this when the active period
    // is within PERIOD_WARN_DAYS of ending, or has already ended.
    const activeSem = rawSemesters.find(s => s.id === semId);
    let inWindow = false;
    if (activeSem && activeSem.endDate) {
        const today    = periodStartOfDay(new Date());
        const end      = periodStartOfDay(new Date(activeSem.endDate + 'T00:00:00'));
        const daysLeft = Math.round((end - today) / (1000 * 60 * 60 * 24));
        inWindow = daysLeft <= PERIOD_WARN_DAYS; // ending soon or passed
    }

    if (!inWindow) {
        el.style.display = 'none';
        el.innerHTML = '';
        return;
    }

    const grades = currentStudentGradesCache;

    // No grades at all this period
    if (!grades.length) {
        el.innerHTML = `
            <div style="display:flex;align-items:flex-start;gap:10px;">
                <i class="fa-solid fa-circle-exclamation" style="color:#7f1d1d;font-size:13px;margin-top:1px;flex-shrink:0;"></i>
                <div>
                    <p style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#7f1d1d;margin:0 0 2px;">Needs Attention This Period</p>
                    <p style="font-size:12.5px;color:#374f6b;font-weight:500;margin:0;line-height:1.5;">No grades have been entered for this student this period.</p>
                </div>
            </div>`;
        el.style.display = 'block';
        return;
    }

    // Count grades per subject; flag subjects with exactly one grade
    const countBySubject = {};
    grades.forEach(g => {
        const subj = g.subject || 'Uncategorized';
        countBySubject[subj] = (countBySubject[subj] || 0) + 1;
    });
    const thinSubjects = Object.keys(countBySubject).filter(s => countBySubject[s] === 1).sort();

    if (!thinSubjects.length) {
        // Nothing to flag
        el.style.display = 'none';
        el.innerHTML = '';
        return;
    }

    const chips = thinSubjects.map(s =>
        `<span style="display:inline-flex;align-items:center;font-size:11.5px;font-weight:600;color:#78350f;background:#fef3c7;border:1px solid #fde68a;border-radius:3px;padding:3px 9px;">${escHtml(s)}</span>`
    ).join('');

    el.innerHTML = `
        <div style="display:flex;align-items:flex-start;gap:10px;">
            <i class="fa-solid fa-circle-half-stroke" style="color:#78350f;font-size:13px;margin-top:1px;flex-shrink:0;"></i>
            <div style="flex:1;min-width:0;">
                <p style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#78350f;margin:0 0 6px;">Only One Grade So Far</p>
                <div style="display:flex;flex-wrap:wrap;gap:6px;">${chips}</div>
            </div>
        </div>`;
    el.style.display = 'block';
}

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

// ── 10.5. CLASS-ONLY EDIT ─────────────────────────────────────────────────
window.checkClassChange = function() {
    const sel  = document.getElementById('editSClass');
    const wrap = document.getElementById('editSClassReasonWrap');
    if (sel.value !== sel.dataset.original && sel.dataset.original !== '') wrap.classList.remove('hidden');
    else wrap.classList.add('hidden');
};

window.saveStudentClass = async function() {
    const btn       = document.getElementById('saveClassBtn');
    const newClass  = document.getElementById('editSClass').value;
    const origClass = document.getElementById('editSClass').dataset.original;
    const reason    = document.getElementById('editSClassReason').value.trim();

    if (newClass !== origClass && origClass !== '' && !reason) {
        showMsg('editClassMsg', 'Please provide a reason for the class change.', true); return;
    }

    btn.textContent = 'Saving…'; btn.disabled = true;

    try {
        const u = { className: newClass };

        if (newClass !== origClass && origClass !== '') {
            u.lastClassChangeReason = reason;
            u.lastClassChangeDate   = new Date().toISOString();
            u.classHistory = arrayUnion({
                fromClass: origClass, toClass: newClass,
                changedAt: new Date().toISOString(), reason, schoolId: session.schoolId
            });
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

// ── 10.6. PIN RESET ───────────────────────────────────────────────────────
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

// ── 11. EVALUATIONS ───────────────────────────────────────────────────────
window.buildStarGroups = function() {
    document.querySelectorAll('.rating-row').forEach(row => {
        const field = row.dataset.field;
        const group = row.querySelector('.star-group');
        if (!group) return;
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
    const allPanels = [
        'type-academic', 'type-eoy', 'type-behavioral',
        'type-midterm', 'type-parent-conference',
        'type-learning-support', 'type-custom'
    ];
    allPanels.forEach(id => { const el = document.getElementById(id); if (el) el.classList.add('hidden'); });
    const map = {
        academic:           'type-academic',
        end_of_year:        'type-eoy',
        behavioral:         'type-behavioral',
        midterm_review:     'type-midterm',
        parent_conference:  'type-parent-conference',
        learning_support:   'type-learning-support',
        custom:             'type-custom'
    };
    const target = map[type];
    if (target) { const el = document.getElementById(target); if (el) el.classList.remove('hidden'); }

    const semWrap = document.getElementById('evalSemesterWrap');
    if (semWrap) {
        if (type === 'end_of_year') semWrap.classList.add('hidden');
        else semWrap.classList.remove('hidden');
    }

    const behOther = document.getElementById('evalBehOtherWrap');
    if (behOther) behOther.classList.add('hidden');
};

window.toggleBehOther = function() {
    const status    = document.getElementById('evalBehStatus')?.value;
    const otherWrap = document.getElementById('evalBehOtherWrap');
    if (otherWrap) otherWrap.classList.toggle('hidden', status !== 'Other');
};

window.saveEvaluation = async function() {
    const type    = document.getElementById('evalType').value;
    const semId   = document.getElementById('evalSemester').value;
    const semName = document.getElementById('evalSemester').options[document.getElementById('evalSemester').selectedIndex].text;
    const date    = document.getElementById('evalDate').value;
    const btn     = document.getElementById('btnSubmitEval');

    if (type !== 'end_of_year' && !semId) { alert('Please select a Grading Period.'); return; }
    if (!date) { alert('Please ensure the Date is filled.'); return; }

    let payload = {
        type, schoolId: session.schoolId, teacherId: session.teacherId,
        teacherName: session.teacherData.name, semesterId: semId,
        semesterName: semName, date, createdAt: new Date().toISOString()
    };

    if (type === 'academic') {
        const required = ['academicMastery','taskExecution','engagement','criticalThinking','writtenCommunication','oralParticipation'];
        if (required.some(k => !window.evalRatings[k])) { alert('Please rate all Academic Progress metrics.'); return; }
        payload.ratings = { mastery: window.evalRatings.academicMastery, execution: window.evalRatings.taskExecution, engagement: window.evalRatings.engagement, criticalThinking: window.evalRatings.criticalThinking, writtenCommunication: window.evalRatings.writtenCommunication, oralParticipation: window.evalRatings.oralParticipation };
        payload.written = { strengths: document.getElementById('evalAcadStrengths').value.trim(), growth: document.getElementById('evalAcadGrowth').value.trim(), steps: document.getElementById('evalAcadSteps').value.trim() };
    } else if (type === 'end_of_year') {
        const required = ['overallAcademicGrowth','subjectMasteryAcrossTerms','socialPeerDynamics','emotionalResilience','selfRegulationEoy','effortPersistenceYear','responseToFeedback','readinessNextGrade'];
        if (required.some(k => !window.evalRatings[k])) { alert('Please rate all End-of-Year metrics.'); return; }
        payload.ratings = { overallAcademicGrowth: window.evalRatings.overallAcademicGrowth, subjectMasteryAcrossTerms: window.evalRatings.subjectMasteryAcrossTerms, socialPeerDynamics: window.evalRatings.socialPeerDynamics, emotionalResilience: window.evalRatings.emotionalResilience, selfRegulation: window.evalRatings.selfRegulationEoy, effortPersistenceYear: window.evalRatings.effortPersistenceYear, responseToFeedback: window.evalRatings.responseToFeedback, readinessNextGrade: window.evalRatings.readinessNextGrade };
        payload.written = { narrative: document.getElementById('evalEoyNarrative').value.trim(), interventions: document.getElementById('evalEoyInterventions').value.trim() };
        payload.status  = document.getElementById('evalEoyStatus').value;
        if (!payload.status) { alert('Please select a Promotion Status.'); return; }
        payload.semesterId   = 'full_year';
        payload.semesterName = 'Full Academic Year';
    } else if (type === 'behavioral') {
        const required = ['ruleAdherence','conflictResolution','respectAuthority','peerInteractions','selfRegulation','responseToCorrection','emotionalStability'];
        if (required.some(k => !window.evalRatings[k])) { alert('Please rate all Conduct metrics.'); return; }
        payload.ratings = { ruleAdherence: window.evalRatings.ruleAdherence, conflictResolution: window.evalRatings.conflictResolution, respectAuthority: window.evalRatings.respectAuthority, peerInteractions: window.evalRatings.peerInteractions, selfRegulation: window.evalRatings.selfRegulation, responseToCorrection: window.evalRatings.responseToCorrection, emotionalStability: window.evalRatings.emotionalStability };
        payload.written = { description: document.getElementById('evalBehDesc').value.trim(), prior: document.getElementById('evalBehPrior').value.trim(), actionPlan: document.getElementById('evalBehAction').value.trim() };
        payload.status = document.getElementById('evalBehStatus').value || 'No Action';
        if (payload.status === 'Other') {
            const otherText = document.getElementById('evalBehOtherText')?.value.trim();
            if (!otherText) { alert('Please describe the action taken.'); return; }
            payload.status = `Other: ${otherText}`;
        }
    } else if (type === 'midterm_review') {
        const required = ['academicProgressToDate','workCompletionRate','classParticipation','attentionFocus','effortPersistence','behaviourInClass'];
        if (required.some(k => !window.evalRatings[k])) { alert('Please rate all Mid-Term metrics.'); return; }
        payload.ratings = { academicProgressToDate: window.evalRatings.academicProgressToDate, workCompletionRate: window.evalRatings.workCompletionRate, classParticipation: window.evalRatings.classParticipation, attentionFocus: window.evalRatings.attentionFocus, effortPersistence: window.evalRatings.effortPersistence, behaviourInClass: window.evalRatings.behaviourInClass };
        payload.written = { strengths: document.getElementById('evalMidStrengths')?.value.trim() || '', concerns: document.getElementById('evalMidConcerns')?.value.trim() || '', comments: document.getElementById('evalMidComments')?.value.trim() || '' };
        payload.attendance = { daysAbsent: parseInt(document.getElementById('evalMidAbsent')?.value) || 0, daysLate: parseInt(document.getElementById('evalMidLate')?.value) || 0 };
    } else if (type === 'parent_conference') {
        const required = ['parentEngagement','communicationQuality','followThroughAgreements'];
        if (required.some(k => !window.evalRatings[k])) { alert('Please rate all Parent Conference metrics.'); return; }
        payload.ratings = { parentEngagement: window.evalRatings.parentEngagement, communicationQuality: window.evalRatings.communicationQuality, followThroughAgreements: window.evalRatings.followThroughAgreements };
        payload.written = { summary: document.getElementById('evalPcSummary')?.value.trim() || '', agreements: document.getElementById('evalPcAgreements')?.value.trim() || '', followUp: document.getElementById('evalPcFollowUp')?.value.trim() || '' };
        payload.parentPresent = document.getElementById('evalPcParentPresent')?.value || '';
    } else if (type === 'learning_support') {
        const required = ['responseToIntervention','academicEffort','focusAttention','independenceInTasks','progressTowardsGoals'];
        if (required.some(k => !window.evalRatings[k])) { alert('Please rate all Learning Support metrics.'); return; }
        payload.ratings = { responseToIntervention: window.evalRatings.responseToIntervention, academicEffort: window.evalRatings.academicEffort, focusAttention: window.evalRatings.focusAttention, independenceInTasks: window.evalRatings.independenceInTasks, progressTowardsGoals: window.evalRatings.progressTowardsGoals };
        payload.written = { concerns: document.getElementById('evalLsConcerns')?.value.trim() || '', interventions: document.getElementById('evalLsInterventions')?.value.trim() || '', goals: document.getElementById('evalLsGoals')?.value.trim() || '' };
        payload.supportLevel = document.getElementById('evalLsLevel')?.value || '';
    } else if (type === 'custom') {
        const customName = document.getElementById('evalCustomTypeName')?.value.trim();
        if (!customName) { alert('Please enter a name for this evaluation.'); return; }
        payload.customTypeName = customName;
        payload.ratings = { overallPerformance: window.evalRatings.overallPerformance, effortEngagement: window.evalRatings.effortEngagement, socialSkills: window.evalRatings.socialSkills, workQuality: window.evalRatings.workQuality, progressTowardsGoals: window.evalRatings.customProgressGoals };
        payload.written = { notes: document.getElementById('evalCustomNotes')?.value.trim() || '' };
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
                    badgeStyle = 'background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;'; typeLabel = 'Academic Progress';
                } else if (ev.type === 'academic_report_card') {
                    const isM = ev.reportCardType === 'midterm';
                    badgeStyle = isM ? 'background:#f5f3ff;color:#6d28d9;border:1px solid #ddd6fe;' : 'background:#edf7f1;color:#065f46;border:1px solid #a7f3d0;';
                    typeLabel  = isM ? 'Midterm Report Card' : 'Report Card';
                } else if (ev.type === 'end_of_year') {
                    badgeStyle = 'background:#fef3c7;color:#b45309;border:1px solid #fde68a;'; typeLabel = 'Comprehensive End-of-Year';
                    highlightText = `<div style="margin-top:10px;padding:6px 10px;background:#f8fafb;border-radius:4px;font-size:11px;font-weight:700;color:#0d1f35;"><i class="fa-solid fa-award" style="color:#f59e0b;margin-right:5px;"></i> Status: ${escHtml(ev.status)}</div>`;
                } else if (ev.type === 'behavioral') {
                    badgeStyle = 'background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;'; typeLabel = 'Behavioral & Conduct Intervention';
                    highlightText = ev.status && ev.status !== 'No Action' ? `<div style="margin-top:10px;padding:6px 10px;background:#fff0f3;border-radius:4px;font-size:11px;font-weight:700;color:#be1240;"><i class="fa-solid fa-triangle-exclamation" style="margin-right:5px;"></i> Action: ${escHtml(ev.status)}</div>` : '';
                } else if (ev.type === 'midterm_review') {
                    badgeStyle = 'background:#f0f9ff;color:#0369a1;border:1px solid #bae6fd;'; typeLabel = 'Mid-Term Review';
                } else if (ev.type === 'parent_conference') {
                    badgeStyle = 'background:#f5f3ff;color:#6d28d9;border:1px solid #ddd6fe;'; typeLabel = 'Parent Conference';
                } else if (ev.type === 'learning_support') {
                    badgeStyle = 'background:#fdf4ff;color:#9333ea;border:1px solid #e9d5ff;'; typeLabel = 'Learning Support Plan';
                } else if (ev.type === 'custom') {
                    badgeStyle = 'background:#f8fafc;color:#475569;border:1px solid #cbd5e1;'; typeLabel = ev.customTypeName || 'Custom Evaluation';
                } else {
                    badgeStyle = 'background:#f8fafc;color:#475569;border:1px solid #cbd5e1;'; typeLabel = ev.type || 'Evaluation';
                }
                const card = document.createElement('div');
                card.style.cssText = 'background:#fff;border:1px solid #dce3ed;border-radius:4px;padding:16px;display:flex;flex-direction:column;gap:8px;';
                card.innerHTML = `
                    <div style="display:flex;justify-content:space-between;align-items:flex-start;">
                        <div>
                            <span style="font-size:10px;font-weight:700;padding:3px 8px;border-radius:99px;text-transform:uppercase;letter-spacing:0.05em;${badgeStyle}">${typeLabel}</span>
                            <h4 style="font-size:14px;font-weight:700;color:#0d1f35;margin:8px 0 2px;">${escHtml(ev.semesterName)}</h4>
                            <p style="font-size:11px;color:#6b84a0;margin:0;">Filed by ${escHtml(ev.teacherName)} on ${ev.date}</p>
                        </div>
                    </div>${highlightText}`;
                list.appendChild(card);
            });
        }
    } catch (e) {
        console.error('[Roster] loadStudentEvaluations:', e);
        noMsg.classList.remove('hidden');
    }
};

// ── 12. REPORT CARD ───────────────────────────────────────────────────────
window.buildRcStarGroups = function() {
    document.querySelectorAll('.rc-rating-row').forEach(row => {
        const field = row.dataset.field;
        const group = row.querySelector('.rc-star-group');
        if (!group) return;
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

async function checkMidtermAvailability() {
    if (selectedRcType !== 'midterm') return;
    const semId = document.getElementById('rcSemester')?.value;
    const info  = document.getElementById('rcMidtermInfo');
    if (!info || !semId) return;
    info.innerHTML = `<div style="padding:10px;text-align:center;color:#9ab0c6;font-size:12px;"><i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i>Checking midterm…</div>`;
    info.classList.remove('hidden');
    try {
        const semSnap = await getDoc(doc(db, 'schools', session.schoolId, 'semesters', semId));
        if (!semSnap.exists() || !semSnap.data().midterm) {
            selectedMidtermData = null;
            info.innerHTML = `<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:3px;padding:12px;display:flex;align-items:flex-start;gap:10px;"><i class="fa-solid fa-triangle-exclamation" style="color:#d97706;margin-top:1px;flex-shrink:0;font-size:13px;"></i><div><p style="font-size:12px;font-weight:700;color:#78350f;margin:0 0 3px;">No midterm configured for this term</p><p style="font-size:11px;color:#92400e;margin:0;line-height:1.5;">Ask your administrator to add a midterm date range to this grading period before generating a midterm report card.</p></div></div>`;
        } else {
            const semData = semSnap.data(); selectedMidtermData = semData.midterm;
            info.innerHTML = `<div style="background:#edfaf4;border:1px solid #a7f3d0;border-radius:3px;padding:12px;display:flex;align-items:flex-start;gap:10px;"><i class="fa-solid fa-flag-checkered" style="color:#0ea871;margin-top:1px;flex-shrink:0;font-size:13px;"></i><div><p style="font-size:12px;font-weight:700;color:#065f46;margin:0 0 3px;">${escHtml(semData.midterm.name || 'Midterm')} — ${escHtml(semData.name || '')}</p><p style="font-size:11px;color:#047857;margin:0;line-height:1.5;">Grades from <strong>${escHtml(semData.midterm.startDate)}</strong> to <strong>${escHtml(semData.midterm.endDate)}</strong> will be included.</p></div></div>`;
        }
    } catch (e) {
        console.error('[Roster] checkMidtermAvailability:', e); selectedMidtermData = null;
        info.innerHTML = `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:3px;padding:12px;"><p style="font-size:12px;font-weight:700;color:#b91c1c;margin:0;">Could not verify midterm. Please try again.</p></div>`;
    }
}

window.selectRcType = function(type) {
    selectedRcType = type;
    const termBtn = document.getElementById('rcTypeTerm'), midtermBtn = document.getElementById('rcTypeMidterm'), info = document.getElementById('rcMidtermInfo');
    if (type === 'term') {
        if (termBtn)    { termBtn.style.background = '#0d1f35'; termBtn.style.borderColor = '#0d1f35'; termBtn.style.color = '#fff'; }
        if (midtermBtn) { midtermBtn.style.background = '#fff'; midtermBtn.style.borderColor = '#c5d0db'; midtermBtn.style.color = '#6b84a0'; }
        if (info) { info.innerHTML = ''; info.classList.add('hidden'); }
        selectedMidtermData = null;
    } else {
        if (midtermBtn) { midtermBtn.style.background = '#0ea871'; midtermBtn.style.borderColor = '#0ea871'; midtermBtn.style.color = '#fff'; }
        if (termBtn)    { termBtn.style.background = '#fff'; termBtn.style.borderColor = '#c5d0db'; termBtn.style.color = '#6b84a0'; }
        checkMidtermAvailability();
    }
};

window.openReportCardModal = function() {
    selectedRcType = 'term'; selectedMidtermData = null;
    const termBtn = document.getElementById('rcTypeTerm'), midtermBtn = document.getElementById('rcTypeMidterm');
    if (termBtn)    { termBtn.style.background = '#0d1f35'; termBtn.style.borderColor = '#0d1f35'; termBtn.style.color = '#fff'; }
    if (midtermBtn) { midtermBtn.style.background = '#fff'; midtermBtn.style.borderColor = '#c5d0db'; midtermBtn.style.color = '#6b84a0'; }
    const info = document.getElementById('rcMidtermInfo');
    if (info) { info.innerHTML = ''; info.classList.add('hidden'); }
    Object.keys(window.rcRatings).forEach(k => { window.rcRatings[k] = 0; });
    ['rcTotalSessions','rcDaysAbsent','rcDaysLate','rcComment'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    const rcSem = document.getElementById('rcSemester'), activeSemVal = document.getElementById('activeSemester')?.value;
    rcSem.innerHTML = '';
    rawSemesters.forEach(s => { const opt = document.createElement('option'); opt.value = s.id; opt.textContent = s.name; if (s.id === activeSemVal) opt.selected = true; rcSem.appendChild(opt); });
    rcSem.onchange = () => checkMidtermAvailability();
    openOverlay('reportCardModal', 'reportCardModalInner');
    window.buildRcStarGroups();
};

window.closeReportCardModal = function() { closeOverlay('reportCardModal', 'reportCardModalInner'); };

window.saveAndGenerateReportCard = async function() {
    const semId = document.getElementById('rcSemester').value;
    const semName = document.getElementById('rcSemester').options[document.getElementById('rcSemester').selectedIndex]?.text || '';
    const btn = document.getElementById('btnSaveGenerate');
    if (!semId) { alert('Please select a grading period.'); return; }
    if (selectedRcType === 'midterm' && !selectedMidtermData) { alert('No midterm has been configured for this term.\n\nPlease ask your administrator to add a midterm date range first.'); return; }
    const missingRatings = Object.entries(window.rcRatings).filter(([, v]) => !v);
    if (missingRatings.length > 0) { alert(`Please complete all ratings before generating the report card. ${missingRatings.length} field(s) still need a rating.`); return; }
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…'; btn.disabled = true;
    const payload = {
        type: 'academic_report_card', reportCardType: selectedRcType,
        schoolId: session.schoolId, teacherId: session.teacherId, teacherName: session.teacherData.name,
        semesterId: semId, semesterName: semName, date: new Date().toISOString().split('T')[0], createdAt: new Date().toISOString(),
        attendance: { totalSessions: parseInt(document.getElementById('rcTotalSessions').value)||0, daysAbsent: parseInt(document.getElementById('rcDaysAbsent').value)||0, daysLate: parseInt(document.getElementById('rcDaysLate').value)||0 },
        ratings: { ...window.rcRatings }, comment: document.getElementById('rcComment').value.trim()
    };
    if (selectedRcType === 'midterm' && selectedMidtermData) payload.midterm = selectedMidtermData;
    try {
        const docId = selectedRcType === 'midterm' ? `${currentStudentId}_${semId}_midterm_rc` : `${currentStudentId}_${semId}_rc`;
        await setDoc(doc(db, 'students', currentStudentId, 'evaluations', docId), payload);
        await window.loadStudentEvaluations(currentStudentId);
        window.closeReportCardModal();
        await generateFormalReportCardPDF(payload, semName, selectedRcType, selectedMidtermData);
    } catch (e) { console.error('[Roster] saveAndGenerateReportCard:', e); alert('Failed to save. Please try again.'); }
    btn.innerHTML = '<i class="fa-solid fa-file-pdf"></i> Save & Generate Report Card'; btn.disabled = false;
};

async function generateFormalReportCardPDF(ev, semName, reportType = 'term', midtermData = null) {
    const student = allStudentsCache.find(s => s.id === currentStudentId);
    if (!student) return;
    let schoolName = '';
    try { const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId)); schoolName = schoolSnap.data()?.schoolName || ''; } catch (e) {}
    let gradesToUse = [...currentStudentGradesCache];
    if (reportType === 'midterm' && midtermData?.startDate && midtermData?.endDate) {
        const start = new Date(midtermData.startDate), end = new Date(midtermData.endDate);
        gradesToUse = gradesToUse.filter(g => { if (!g.date) return false; const d = new Date(g.date); return d >= start && d <= end; });
    }
    const reportTitle    = reportType === 'midterm' ? 'MIDTERM REPORT CARD' : 'OFFICIAL GRADE REPORT';
    const reportSubtitle = reportType === 'midterm' && midtermData ? `${midtermData.name || 'Midterm'} · ${semName} · ${midtermData.startDate} – ${midtermData.endDate}` : semName;
    const bySub = {};
    gradesToUse.forEach(g => { const sub = g.subject || 'Uncategorized'; if (!bySub[sub]) bySub[sub] = []; bySub[sub].push(g); });
    const cumulativeAvg = gradesToUse.length ? calculateWeightedAverage(gradesToUse, session.teacherData.gradeTypes || getGradeTypes()) : 0;
    const gpaLetter = cumulativeAvg > 0 ? letterGrade(cumulativeAvg) : 'N/A';
    const ratingLabel = v => v >= 5 ? 'Exceptional' : v === 4 ? 'Developing Well' : v === 3 ? 'Developing' : v === 2 ? 'Needs Improvement' : v >= 1 ? 'Unsatisfactory' : '—';
    const starDisplay = v => [1,2,3,4,5].map(n => `<span style="color:${n <= v ? '#f59e0b' : '#dce3ed'};font-size:14px;">★</span>`).join('');
    const ratingLegendHtml = `<div style="font-size:9px;color:#374f6b;background:#f8fafc;padding:7px 12px;border-radius:4px;margin-bottom:12px;border:1px solid #e2e8f0;line-height:2;"><span style="color:#f59e0b;font-size:11px;">★★★★★</span> <strong>5 — Exceptional</strong> &nbsp;&nbsp;<span style="color:#f59e0b;font-size:11px;">★★★★</span><span style="color:#dce3ed;font-size:11px;">★</span> <strong>4 — Developing Well</strong> &nbsp;&nbsp;<span style="color:#f59e0b;font-size:11px;">★★★</span><span style="color:#dce3ed;font-size:11px;">★★</span> <strong>3 — Developing</strong> &nbsp;&nbsp;<span style="color:#f59e0b;font-size:11px;">★★</span><span style="color:#dce3ed;font-size:11px;">★★★</span> <strong>2 — Needs Improvement</strong> &nbsp;&nbsp;<span style="color:#f59e0b;font-size:11px;">★</span><span style="color:#dce3ed;font-size:11px;">★★★★</span> <strong>1 — Unsatisfactory</strong></div>`;
    const gradesHtml = Object.keys(bySub).length === 0 ? `<tr><td colspan="3" style="text-align:center;padding:30px;color:#64748b;font-style:italic;">No grades recorded for this period.</td></tr>` : Object.entries(bySub).sort((a,b) => a[0].localeCompare(b[0])).map(([sub, gList]) => { const subAvg = calculateWeightedAverage(gList, session.teacherData.gradeTypes || getGradeTypes()); return `<tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:10px 15px;font-weight:700;color:#1e293b;">${escHtml(sub)}</td><td style="padding:10px 15px;text-align:center;font-weight:700;">${subAvg}%</td><td style="padding:10px 15px;text-align:center;font-weight:800;font-family:monospace;">${letterGrade(subAvg)}</td></tr>`; }).join('');
    const enrichmentRows = [['Character & Values','Honesty, integrity, and ethical behaviour in daily interactions',ev.ratings.characterValues],['Respect & Courtesy','Respectful treatment of peers, teachers, and the school environment',ev.ratings.respectCourtesy],['Responsibility & Reliability','Taking ownership of tasks, duties, and personal belongings',ev.ratings.responsibilityReliability],['Cooperation & Teamwork','Working constructively with others in group and classroom settings',ev.ratings.cooperationTeamwork],['Leadership & Initiative','Volunteering, taking the lead, and showing self-driven motivation',ev.ratings.leadershipInitiative],['Cultural Awareness & Pride','Appreciation of Belizean and Caribbean culture, history, and heritage',ev.ratings.culturalAwareness]].map(([label, desc, val]) => `<tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:9px 15px;"><p style="font-weight:700;color:#1e293b;margin:0 0 2px;font-size:12px;">${label}</p><p style="font-size:10px;color:#64748b;margin:0;font-style:italic;">${desc}</p></td><td style="padding:9px 15px;text-align:center;">${starDisplay(val||0)}</td><td style="padding:9px 15px;text-align:center;font-size:11px;font-weight:700;color:#1e1b4b;">${ratingLabel(val||0)}</td></tr>`).join('');
    const learningRows = [['Behavior',ev.ratings.behavior],['Organization',ev.ratings.organization],['Respectfulness',ev.ratings.respectfulness],['Kindness',ev.ratings.kindness],['Attitude Towards Work',ev.ratings.attitudeWork],['Attitude Towards Peers',ev.ratings.attitudePeers],['Academic Comprehension',ev.ratings.academicComprehension],['Effort & Resilience',ev.ratings.effortResilience],['Participation & Engagement',ev.ratings.participation],['Attendance & Punctuality',ev.ratings.punctualityRating]].map(([label, val]) => `<tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:9px 15px;font-weight:600;color:#334155;">${label}</td><td style="padding:9px 15px;text-align:center;">${starDisplay(val||0)}</td><td style="padding:9px 15px;text-align:center;font-size:11px;font-weight:700;color:#1e1b4b;">${ratingLabel(val||0)}</td></tr>`).join('');
    const html = `<!DOCTYPE html><html><head><title>${reportTitle} — ${escHtml(student.name)}</title><style>@import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&display=swap');*{box-sizing:border-box;}body{font-family:'Nunito',sans-serif;padding:36px 44px;color:#0f172a;line-height:1.5;margin:0 auto;max-width:8.5in;font-size:13px;}.hf{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #1e1b4b;padding-bottom:16px;margin-bottom:18px;}.logo{max-height:72px;max-width:220px;object-fit:contain;}.ht{text-align:right;}.ht h1{margin:0 0 4px;font-size:22px;font-weight:900;text-transform:uppercase;color:#1e1b4b;}.ht h2{margin:0;font-size:12px;color:#64748b;font-weight:700;letter-spacing:2px;}.ht h3{margin:4px 0 0;font-size:11px;color:#94a3b8;font-weight:600;}.si{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;background:#f8fafc;border:1px solid #cbd5e1;border-radius:8px;padding:14px 18px;margin-bottom:20px;}.si-item{display:flex;flex-direction:column;gap:3px;}.il{font-size:9px;text-transform:uppercase;color:#64748b;font-weight:800;letter-spacing:1px;}.iv{font-size:14px;font-weight:800;color:#0f172a;}h3{font-size:11px;text-transform:uppercase;letter-spacing:1.2px;color:#fff;background:#1e1b4b;padding:8px 12px;border-radius:4px;margin:0 0 10px;}table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:0;}th{background:#f1f5f9;color:#475569;padding:8px 12px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:1px;border-bottom:2px solid #cbd5e1;}th.c{text-align:center;}td{border-bottom:1px solid #e2e8f0;padding:8px 12px;color:#334155;}.att{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:14px;}.ac{background:#f8fafc;border:1px solid #cbd5e1;padding:9px;text-align:center;border-radius:6px;}.al{display:block;font-size:9px;font-weight:800;color:#64748b;text-transform:uppercase;}.av{font-size:18px;font-weight:900;color:#1e1b4b;}.cb{border:1px solid #cbd5e1;border-radius:6px;padding:14px;background:#fff;min-height:70px;margin-bottom:20px;}.cl{font-size:10px;font-weight:800;color:#1e1b4b;text-transform:uppercase;margin-bottom:6px;display:block;}.fs{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:36px;}.sl{border-top:1px solid #000;padding-top:7px;font-size:11px;font-weight:700;text-align:center;color:#1e1b4b;}.sec{margin-bottom:22px;}</style></head><body><div class="hf"><img src="${session.logo||''}" alt="${escHtml(schoolName)}" class="logo" onerror="this.style.display='none'"><div class="ht"><h1>${escHtml(schoolName)}</h1><h2>${reportTitle}</h2><h3>${escHtml(reportSubtitle)}</h3></div></div><div class="si"><div class="si-item"><span class="il">Student Name</span><span class="iv">${escHtml(student.name)}</span></div><div class="si-item"><span class="il">Class</span><span class="iv">${escHtml(student.className||'Unassigned')}</span></div><div class="si-item"><span class="il">Teacher</span><span class="iv">${escHtml(ev.teacherName)}</span></div><div class="si-item"><span class="il">Grading Period</span><span class="iv">${escHtml(semName)}</span></div><div class="si-item"><span class="il">Date Issued</span><span class="iv">${new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}</span></div><div class="si-item"><span class="il">Period Average</span><span class="iv">${cumulativeAvg}% (${gpaLetter})</span></div></div><div class="sec"><h3>Academic Performance</h3><table><thead><tr><th>Subject</th><th class="c">Average</th><th class="c">Grade</th></tr></thead><tbody>${gradesHtml}</tbody></table></div><div class="sec"><h3>Enrichment &amp; Character Development</h3>${ratingLegendHtml}<table><thead><tr><th>Metric</th><th class="c">Rating</th><th class="c">Assessment</th></tr></thead><tbody>${enrichmentRows}</tbody></table></div><div class="sec"><h3>Learning Behaviours &amp; Social Growth</h3>${ratingLegendHtml}<table><thead><tr><th>Metric</th><th class="c">Rating</th><th class="c">Assessment</th></tr></thead><tbody>${learningRows}</tbody></table></div><div class="att"><div class="ac"><span class="al">Total Sessions</span><span class="av">${ev.attendance.totalSessions}</span></div><div class="ac"><span class="al">Days Absent</span><span class="av">${ev.attendance.daysAbsent}</span></div><div class="ac"><span class="al">Days Late</span><span class="av">${ev.attendance.daysLate}</span></div></div><div class="cb"><span class="cl">Teacher's Comments</span><p style="margin:0;font-size:12px;color:#334155;white-space:pre-wrap;line-height:1.6;">${escHtml(ev.comment||'No comments recorded.')}</p></div><div class="fs"><div class="sl">Teacher's Signature &amp; Date</div><div class="sl">Principal's Signature &amp; Date</div></div></body></html>`;
    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
    setTimeout(() => w.print(), 800);
}

// ── 13. ASSIGNMENT MODAL ──────────────────────────────────────────────────
window.openAssignmentModal = function(gradeId) {
    const g = gradeDetailCache[gradeId]; if (!g) return;
    const pct = g.max ? Math.round(g.score/g.max*100) : null;
    const fill = gradeFill(pct||0);
    const color = pct>=90?'#065f46':pct>=80?'#1e3a8a':pct>=70?'#134e4a':pct>=65?'#78350f':'#7f1d1d';
    const bg = pct>=90?'#dcfce7':pct>=80?'#dbeafe':pct>=70?'#ccfbf1':pct>=65?'#fef3c7':'#fee2e2';
    const bd = pct>=90?'#bbf7d0':pct>=80?'#bfdbfe':pct>=70?'#99f6e4':pct>=65?'#fde68a':'#fecaca';
    const adminNote = g.enteredByAdmin ? `<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:4px;padding:12px;margin-bottom:12px;"><p style="font-size:9.5px;font-weight:700;text-transform:uppercase;color:#2563eb;margin:0 0 4px;">Admin Entry</p><p style="font-size:12px;color:#374f6b;margin:0;">Entered by ${escHtml(g.adminName||'Admin')}</p></div>` : '';
    document.getElementById('aModalTitle').textContent = g.title || 'Assessment Detail';
    document.getElementById('aModalBody').innerHTML = `<div style="text-align:center;margin-bottom:20px;"><div style="font-size:42px;font-weight:700;color:${color};font-family:'DM Mono',monospace;line-height:1;">${g.score}<span style="font-size:20px;color:#9ab0c6;"> / ${g.max||'?'}</span></div>${pct!==null?`<div style="display:flex;align-items:center;justify-content:center;gap:12px;margin-top:8px;"><span style="font-size:18px;font-weight:700;color:${color};font-family:'DM Mono',monospace;">${pct}%</span><span style="font-size:14px;font-weight:700;padding:4px 14px;border-radius:3px;background:${bg};border:1px solid ${bd};color:${color};">${letterGrade(pct)}</span></div><div style="margin:12px 20px 0;height:8px;background:#f0f4f8;border-radius:2px;overflow:hidden;"><div style="height:100%;width:${Math.min(pct,100)}%;background:${fill};transition:width 0.5s ease;"></div></div>`:''}</div>${adminNote}<div style="display:flex;flex-direction:column;gap:0;margin-bottom:16px;border:1px solid #e8edf2;border-radius:4px;overflow:hidden;">${[['Subject',g.subject||'—'],['Type',g.type||'—'],['Class',g.className||'—'],['Date',g.date||'—']].map(([l,v],i)=>`<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;${i<3?'border-bottom:1px solid #f0f4f8;':''}background:#fff;"><span style="font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#9ab0c6;">${l}</span><span style="font-size:13px;font-weight:600;color:#0d1f35;">${escHtml(v)}</span></div>`).join('')}</div>${g.notes?`<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:4px;padding:14px;margin-bottom:14px;"><p style="font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#1e3a8a;margin:0 0 6px;">Notes</p><p style="font-size:12.5px;color:#374f6b;font-weight:400;margin:0;line-height:1.6;white-space:pre-wrap;">${escHtml(g.notes)}</p></div>`:''}`;
    openOverlay('assignmentModal', 'assignmentModalInner');
};

window.closeAssignmentModal = function() { closeOverlay('assignmentModal', 'assignmentModalInner'); };

// ── 14. ARCHIVE ───────────────────────────────────────────────────────────
window.archiveStudent = function() {
    const s = allStudentsCache.find(x => x.id === currentStudentId);
    document.getElementById('archiveStudentName').textContent = s ? s.name : 'this student';
    document.getElementById('optArchive').checked = true;
    window.toggleArchiveType();
    document.getElementById('releaseReason').value = '';
    document.getElementById('archiveNotes').value  = '';
    openOverlay('archiveModal', 'archiveModalInner');
};

window.closeArchiveModal = function() { closeOverlay('archiveModal', 'archiveModalInner'); };

window.toggleArchiveType = function() {
    const isRelease = document.getElementById('optRelease').checked;
    const rf        = document.getElementById('releaseFields');
    if (isRelease) rf.classList.remove('hidden');
    else rf.classList.add('hidden');
};

document.getElementById('confirmArchiveBtn').addEventListener('click', async () => {
    const isRelease = document.getElementById('optRelease').checked;
    const releaseReason = document.getElementById('releaseReason').value;
    const notes = document.getElementById('archiveNotes').value.trim();
    if (isRelease && !releaseReason) { alert('Please select a departure reason to close enrollment.'); return; }
    const btn = document.getElementById('confirmArchiveBtn');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing…'; btn.disabled = true;
    try {
        const s = allStudentsCache.find(x => x.id === currentStudentId);
        const batch = writeBatch(db);
        let finalStatus = 'Archived', leaveSchool = false, historyReason = 'Internally Archived';
        if (isRelease) {
            leaveSchool = true; historyReason = releaseReason;
            if (releaseReason === 'Transferred') finalStatus = 'Transferred';
            else if (releaseReason === 'Graduated') finalStatus = 'Graduated';
            else finalStatus = 'Archived';
        }
        let academicSnapshot = {};
        try {
            const gradeTypes = session.teacherData.gradeTypes || session.teacherData.customGradeTypes || DEFAULT_GRADE_TYPES;
            const gradesSnap = await getDocs(query(collection(db, 'students', currentStudentId, 'grades'), where('schoolId', '==', session.schoolId)));
            const classGrades = [];
            gradesSnap.forEach(d => { const g = { id: d.id, ...d.data() }; if (g.className === (s?.className || '')) classGrades.push(g); });
            const evalSnap = await getDocs(query(collection(db, 'students', currentStudentId, 'evaluations'), where('schoolId', '==', session.schoolId)));
            const evaluations = [];
            evalSnap.forEach(d => evaluations.push({ id: d.id, ...d.data() }));
            const bySemester = {};
            classGrades.forEach(g => {
                if (!g.semesterId) return;
                const sem = rawSemesters.find(rs => rs.id === g.semesterId);
                const semName = sem?.name || g.semesterId;
                if (!bySemester[semName]) bySemester[semName] = {};
                const subj = g.subject || 'Uncategorized';
                if (!bySemester[semName][subj]) bySemester[semName][subj] = [];
                bySemester[semName][subj].push(g);
            });
            const semesters = {};
            Object.entries(bySemester).forEach(([semName, subjects]) => {
                semesters[semName] = {};
                const allSemGrades = [];
                Object.entries(subjects).forEach(([subj, grades]) => { semesters[semName][subj] = Math.round(calculateWeightedAverage(grades, gradeTypes)); allSemGrades.push(...grades); });
                if (allSemGrades.length) semesters[semName]._overall = Math.round(calculateWeightedAverage(allSemGrades, gradeTypes));
            });
            academicSnapshot = { className: s?.className || '', semesters, evaluations, snapshotDate: new Date().toISOString() };
        } catch (snapErr) { console.warn('[Roster] academicSnapshot warning:', snapErr.message); }
        const snapshot = { schoolId: session.schoolId, schoolName: session.schoolName || session.schoolId, teacherId: s?.teacherId || '', className: s?.className || '', leftAt: new Date().toISOString(), reason: historyReason, ...(notes ? { notes } : {}) };
        batch.update(doc(db, 'students', currentStudentId), { enrollmentStatus: finalStatus, currentSchoolId: leaveSchool ? '' : session.schoolId, teacherId: '', className: '', academicHistory: arrayUnion(snapshot), lastClassName: s?.className || '', academicSnapshot, ...(leaveSchool ? { archivedSchoolIds: arrayUnion(session.schoolId) } : {}) });
        if (leaveSchool) { batch.set(doc(collection(db, 'schools', session.schoolId, 'notifications')), { type: 'student_enrollment_closed', studentId: currentStudentId, studentName: s?.name || '', reason: historyReason, closedBy: session.teacherData?.name || 'Teacher', closedAt: new Date().toISOString() }); }
        await batch.commit();
        window.closeArchiveModal(); window.closeStudentPanel(); await loadStudents();
    } catch (e) { console.error('[Roster] archive:', e); alert('Critical failure. Record preserved.'); }
    btn.innerHTML = '<i class="fa-solid fa-box-archive"></i> Confirm Action'; btn.disabled = false;
});

// ── 15. PROMOTE / REPEAT ─────────────────────────────────────────────────

// Build className → [{id, name}] from all non-archived teachers at the school
async function buildClassTeacherMap() {
    promoteClassTeacherMap = {};
    try {
        const snap = await getDocs(query(
            collection(db, 'teachers'),
            where('currentSchoolId', '==', session.schoolId)
        ));
        snap.forEach(d => {
            const t = { id: d.id, ...d.data() };
            if (t.archived) return;
            const classes = t.classes || (t.className ? [t.className] : []);
            classes.forEach(cls => {
                if (!cls) return;
                if (!promoteClassTeacherMap[cls]) promoteClassTeacherMap[cls] = [];
                promoteClassTeacherMap[cls].push({ id: d.id, name: t.name });
            });
        });
    } catch (e) { console.error('[Roster] buildClassTeacherMap:', e); }
}

// Toggle the ⋯ More menu
window.toggleRosterMoreMenu = function(e) {
    e.stopPropagation();
    const menu = document.getElementById('rosterMoreMenu');
    if (menu) menu.classList.toggle('hidden');
};

// Open promote modal — singleStudentId scopes to one student; null = whole roster
window.openPromoteModal = async function(singleStudentId = null) {
    const menu = document.getElementById('rosterMoreMenu');
    if (menu) menu.classList.add('hidden');

    await buildClassTeacherMap();

    const students = singleStudentId
        ? allStudentsCache.filter(s => s.id === singleStudentId)
        : allStudentsCache;

    const list = document.getElementById('promoteList');
    const msg  = document.getElementById('promoteMsg');
    msg.classList.add('hidden');

    if (!students.length) {
        list.innerHTML = `<p style="font-size:13px;color:#9ab0c6;text-align:center;padding:24px 0;">No students to display.</p>`;
        openOverlay('promoteModal', 'promoteModalInner');
        return;
    }

    const classOptions = [
        `<option value="">— Choose —</option>`,
        `<option value="__repeat__">↩ Repeat (stay in current class)</option>`,
        ...schoolClasses.map(c => `<option value="${escHtml(c)}">${escHtml(c)}</option>`)
    ].join('');

    list.innerHTML = students.map(s => `
        <div class="promote-row" data-student-id="${s.id}" data-current-class="${escHtml(s.className||'')}"
             style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid #f0f4f8;">
            <input type="checkbox" class="promote-check" style="width:16px;height:16px;cursor:pointer;flex-shrink:0;">
            <div style="flex:1;min-width:0;">
                <p style="font-size:13px;font-weight:700;color:#0d1f35;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(s.name)}</p>
                <p style="font-size:11px;color:#9ab0c6;margin:0;">Currently: ${escHtml(s.className||'Unassigned')}</p>
            </div>
            <select class="promote-dest form-input" style="width:180px;flex-shrink:0;font-size:12px;padding:6px 8px;">${classOptions}</select>
        </div>
    `).join('');

    // Reset the note field and warning each time the modal opens
    const noteEl     = document.getElementById('promoteNote');
    const noteWrap   = document.getElementById('promoteNoteWrap');
    const warningEl  = document.getElementById('promoteWarning');
    if (noteEl)   noteEl.value = '';
    if (noteWrap) noteWrap.style.display = 'block';
    if (warningEl) { warningEl.style.display = 'none'; warningEl.innerHTML = ''; }

    // Update the warning live as checkboxes/destinations change
    document.querySelectorAll('.promote-row').forEach(row => {
        const chk = row.querySelector('.promote-check');
        const sel = row.querySelector('.promote-dest');
        if (chk) chk.addEventListener('change', updatePromoteWarning);
        if (sel) sel.addEventListener('change', updatePromoteWarning);
    });

    openOverlay('promoteModal', 'promoteModalInner');
};

// Live warning shown before promotion is confirmed. Explains that promoted
// students leave this roster, and flags any destination class with no teacher.
function updatePromoteWarning() {
    const warningEl = document.getElementById('promoteWarning');
    if (!warningEl) return;

    let anyPromote   = false;   // at least one ticked student moving to a real class
    let anyRepeat    = false;
    const noTeacherDest = new Set();

    document.querySelectorAll('.promote-row').forEach(row => {
        const checked = row.querySelector('.promote-check')?.checked;
        if (!checked) return;
        const dest = row.querySelector('.promote-dest')?.value || '';
        if (!dest) return;
        if (dest === '__repeat__') { anyRepeat = true; return; }
        anyPromote = true;
        const owners = promoteClassTeacherMap[dest] || [];
        if (owners.length !== 1) noTeacherDest.add(dest);
    });

    if (!anyPromote && !anyRepeat) {
        warningEl.style.display = 'none';
        warningEl.innerHTML = '';
        return;
    }

    let html = `<div style="display:flex;align-items:flex-start;gap:10px;">
        <i class="fa-solid fa-triangle-exclamation" style="color:#c2410c;font-size:14px;margin-top:1px;flex-shrink:0;"></i>
        <div style="flex:1;min-width:0;">`;

    if (anyPromote) {
        html += `<p style="font-size:12.5px;font-weight:700;color:#7c2d12;margin:0 0 4px;">Promoted students will leave your roster.</p>
                 <p style="font-size:12px;color:#7c2d12;font-weight:500;margin:0 0 6px;line-height:1.5;">Once promoted, a student moves to their new class and will no longer appear here. Their full record is preserved and an admin can always reassign them if needed.</p>`;
    } else if (anyRepeat) {
        html += `<p style="font-size:12.5px;font-weight:700;color:#7c2d12;margin:0;">Confirm the students staying in their current class.</p>`;
    }

    if (noTeacherDest.size > 0) {
        const list = [...noTeacherDest].map(c => escHtml(c)).join(', ');
        html += `<p style="font-size:12px;color:#7c2d12;font-weight:500;margin:6px 0 0;line-height:1.5;"><strong>Note:</strong> ${noTeacherDest.size > 1 ? 'These classes have' : 'This class has'} no single assigned teacher (${list}). Students moved there will be <strong>unassigned</strong> until an admin places them with a teacher.</p>`;
    }

    html += `</div></div>`;
    warningEl.innerHTML = html;
    warningEl.style.display = 'block';
}

window.closePromoteModal = function() { closeOverlay('promoteModal', 'promoteModalInner'); };

// Called from sidebar "Promote / Advance" button — closes panel then opens modal for that one student
window.promoteCurrentStudent = function() {
    window.closeStudentPanel();
    window.openPromoteModal(currentStudentId);
};

// Commit all promote/repeat actions
window.confirmPromotion = async function() {
    const btn = document.getElementById('confirmPromoteBtn');
    const msg = document.getElementById('promoteMsg');
    msg.classList.add('hidden');

    const rows = document.querySelectorAll('.promote-row');
    const toProcess = [];

    rows.forEach(row => {
        const checked = row.querySelector('.promote-check')?.checked;
        if (!checked) return;
        const dest         = row.querySelector('.promote-dest')?.value || '';
        const studentId    = row.dataset.studentId;
        const currentClass = row.dataset.currentClass;
        if (!dest) return; // "— Choose —" = skip this student
        toProcess.push({ studentId, currentClass, dest });
    });

    if (!toProcess.length) {
        msg.textContent = 'Tick at least one student and choose a destination.';
        msg.style.background = '#fee2e2'; msg.style.color = '#7f1d1d';
        msg.classList.remove('hidden');
        return;
    }

    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing…';
    btn.disabled  = true;

    const promoteNote = (document.getElementById('promoteNote')?.value || '').trim();
    const gradeTypes  = session.teacherData.gradeTypes || session.teacherData.customGradeTypes || DEFAULT_GRADE_TYPES;
    const changedAt   = new Date().toISOString();
    let   batch       = writeBatch(db);
    let   opCount     = 0;
    let   unresolved  = 0;

    try {
        for (const { studentId, currentClass, dest } of toProcess) {
            const studentRef = doc(db, 'students', studentId);

            // Build the academic snapshot for the class being left (reuse of the
            // archive snapshot logic). Reads happen BEFORE the batch update — a
            // getDocs cannot run inside a writeBatch. The snapshot stores COMPUTED
            // averages (report-card style), not raw grade docs, and is appended to
            // an accumulating classSnapshots array so each year is preserved.
            const snapshot = await buildPromotionSnapshot(studentId, currentClass, gradeTypes, promoteNote, changedAt, dest);

            const historyEntry = {
                fromClass: currentClass,
                toClass:   dest === '__repeat__' ? currentClass : dest,
                changedAt,
                reason:    dest === '__repeat__' ? 'Repeated' : 'Promoted',
                schoolId:  session.schoolId,
                ...(promoteNote ? { note: promoteNote } : {})
            };

            if (dest === '__repeat__') {
                // Stays in same class — stamp a year-boundary classHistory entry,
                // and still snapshot the year that just closed.
                batch.update(studentRef, {
                    classHistory:   arrayUnion(historyEntry),
                    classSnapshots: arrayUnion(snapshot)
                });
            } else {
                // Move to destination class; auto-assign teacher if exactly one owns it
                const owners = promoteClassTeacherMap[dest] || [];
                const update = {
                    className:      dest,
                    classHistory:   arrayUnion(historyEntry),
                    classSnapshots: arrayUnion(snapshot)
                };

                if (owners.length === 1) {
                    update.teacherId = owners[0].id;
                } else {
                    update.teacherId = '';
                    unresolved++;
                }

                batch.update(studentRef, update);
            }

            opCount++;
            if (opCount >= 400) {
                await batch.commit();
                batch   = writeBatch(db);
                opCount = 0;
            }
        }

        if (opCount > 0) await batch.commit();

        await loadStudents();
        window.closePromoteModal();

        if (unresolved > 0) {
            alert(`Promotion complete.\n\n${unresolved} student(s) were moved to their new class but could not be auto-assigned to a teacher because the destination class has no teacher or multiple teachers. Please assign them manually from the admin panel.`);
        }

    } catch (e) {
        console.error('[Roster] confirmPromotion:', e);
        msg.textContent = 'Error during promotion. Please try again.';
        msg.style.background = '#fee2e2'; msg.style.color = '#7f1d1d';
        msg.classList.remove('hidden');
    }

    btn.innerHTML = '<i class="fa-solid fa-arrow-up-right-dots"></i> Confirm Promotion';
    btn.disabled  = false;
};

// Build a computed academic snapshot for the class a student is leaving.
// Mirrors the archive snapshot: grades for that class grouped by semester →
// subject with weighted averages, plus the student's evaluations. Stored as a
// summary (not raw grades); raw grades remain intact on the record.
async function buildPromotionSnapshot(studentId, className, gradeTypes, note, changedAt, dest) {
    try {
        const gradesSnap = await getDocs(query(
            collection(db, 'students', studentId, 'grades'),
            where('schoolId', '==', session.schoolId)
        ));
        const classGrades = [];
        gradesSnap.forEach(d => {
            const g = { id: d.id, ...d.data() };
            if (g.className === (className || '')) classGrades.push(g);
        });

        const evalSnap = await getDocs(query(
            collection(db, 'students', studentId, 'evaluations'),
            where('schoolId', '==', session.schoolId)
        ));
        const evaluations = [];
        evalSnap.forEach(d => evaluations.push({ id: d.id, ...d.data() }));

        const bySemester = {};
        classGrades.forEach(g => {
            if (!g.semesterId) return;
            const sem     = rawSemesters.find(rs => rs.id === g.semesterId);
            const semName = sem?.name || g.semesterId;
            if (!bySemester[semName]) bySemester[semName] = {};
            const subj = g.subject || 'Uncategorized';
            if (!bySemester[semName][subj]) bySemester[semName][subj] = [];
            bySemester[semName][subj].push(g);
        });

        const semesters = {};
        Object.entries(bySemester).forEach(([semName, subjects]) => {
            semesters[semName] = {};
            const allSemGrades = [];
            Object.entries(subjects).forEach(([subj, grades]) => {
                semesters[semName][subj] = Math.round(calculateWeightedAverage(grades, gradeTypes));
                allSemGrades.push(...grades);
            });
            if (allSemGrades.length) semesters[semName]._overall = Math.round(calculateWeightedAverage(allSemGrades, gradeTypes));
        });

        return {
            className:    className || '',
            promotedTo:   dest === '__repeat__' ? className || '' : dest,
            outcome:      dest === '__repeat__' ? 'Repeated' : 'Promoted',
            semesters,
            evaluations,
            schoolId:     session.schoolId,
            snapshotDate: changedAt,
            ...(note ? { note } : {})
        };
    } catch (snapErr) {
        console.warn('[Roster] buildPromotionSnapshot warning:', snapErr.message);
        // Even if the snapshot fails, return a minimal record so history still
        // reflects the move — never block the promotion on snapshot failure.
        return {
            className:    className || '',
            promotedTo:   dest === '__repeat__' ? className || '' : dest,
            outcome:      dest === '__repeat__' ? 'Repeated' : 'Promoted',
            semesters:    {},
            evaluations:  [],
            schoolId:     session.schoolId,
            snapshotDate: changedAt,
            snapshotError: true,
            ...(note ? { note } : {})
        };
    }
}

// ── 16. EXPORT ────────────────────────────────────────────────────────────
window.exportRosterCSV = function() {
    const rows = [['Global ID','Name','Class','Parent Phone','Parent PIN']];
    allStudentsCache.forEach(s => rows.push([s.id, s.name, s.className||'', s.parentPhone||'', s.pin]));
    downloadCSV(rows, `${session.schoolId}_roster.csv`);
};

window.printRoster = function() { window.print(); };

// ── 17. XSS PROTECTION ───────────────────────────────────────────────────
function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

// ── FIRE ──────────────────────────────────────────────────────────────────
init();
