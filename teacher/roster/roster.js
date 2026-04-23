import { db } from '../../assets/js/firebase-init.js';
import { collection, query, where, getDocs, getDoc, doc, updateDoc, addDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teacher.js';
import { openOverlay, closeOverlay, showMsg, gradeColorClass, standingBadge, standingText, gradeFill, letterGrade, downloadCSV } from '../../assets/js/utils.js';

// ── 1. AUTHENTICATION & LAYOUT ──────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    injectTeacherLayout('students', 'My Roster', 'Manage students, PINs and academic standing', true);
}

// ── 2. STATE VARIABLES ──────────────────────────────────────────────────────
let allStudentsCache = [];
let unassignedStudentsCache = [];
let studentMap = {};
let currentStudentId = null;
let currentStudentGradesCache = [];
let rawSemesters = [];
let isSemesterLocked = false;
let gradeDetailCache = {};
let schoolLimit = 50; // default, loaded in loadStudents

// Fallback arrays if school details are missing
const CLASSES = {
    'Primary': ['Infant 1', 'Infant 2', 'Standard 1', 'Standard 2', 'Standard 3', 'Standard 4', 'Standard 5', 'Standard 6'],
    'High School': ['First Form', 'Second Form', 'Third Form', 'Fourth Form'],
    'Junior College': ['Year 1', 'Year 2']
};
const DEFAULT_GRADE_TYPES = ['Test', 'Quiz', 'Assignment', 'Homework', 'Project', 'Midterm Exam', 'Final Exam'];

function getClasses() { return session.teacherData.classes || [session.teacherData.className || '']; }
function getActiveSubjects() { return (session.teacherData.subjects || []).filter(s => !s.archived); }
function getGradeTypes() { return session.teacherData.customGradeTypes || DEFAULT_GRADE_TYPES; }

// ── 3. INITIALIZATION ───────────────────────────────────────────────────────
async function init() {
    if (!session) return;

    // Attach Topbar Search functionality
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.addEventListener('input', filterStudents);
    }

    // Populate Sidebar Details
    document.getElementById('displayTeacherName').textContent = session.teacherData.name;
    document.getElementById('teacherAvatar').textContent = session.teacherData.name.charAt(0).toUpperCase();
    document.getElementById('sidebarSchoolId').textContent = session.schoolId;
    document.getElementById('displayTeacherClasses').innerHTML = getClasses().filter(Boolean).map(c => `<span class="class-pill">${c}</span>`).join('');

    // Setup Roster specific UI
    const classes = getClasses().filter(Boolean);
    const classFilter = document.getElementById('rf-class');
    if (classFilter) {
        classFilter.innerHTML = '<option value="">All Classes</option>' + classes.map(c => `<option value="${c}">${c}</option>`).join('');
        if (classes.length <= 1) document.getElementById('classFilterWrap').style.display = 'none';
    }

    await fetchSchoolLimit();
    await loadSemesters();
    await loadStudents();
}

async function fetchSchoolLimit() {
    try {
        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        if (schoolSnap.exists()) {
            const planId = schoolSnap.data().subscriptionPlan || 'starter';
            const planSnap = await getDoc(doc(db, 'subscriptionPlans', planId));
            if (planSnap.exists()) schoolLimit = planSnap.data().limit || 50;
        }
    } catch (e) { console.error("Error fetching plan details:", e); }
}

// ── 4. LOAD SEMESTERS ───────────────────────────────────────────────────────
async function loadSemesters() {
    try {
        const semSnap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        const activeId = schoolSnap.data()?.activeSemesterId || '';

        rawSemesters = semSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0));

        const semSel = document.getElementById('activeSemester');
        if (semSel) {
            semSel.innerHTML = '';
            rawSemesters.forEach(s => {
                semSel.innerHTML += `<option value="${s.id}"${s.id === activeId ? ' selected' : ''}>${s.name}</option>`;
            });

            checkLockStatus();

            semSel.addEventListener('change', () => {
                checkLockStatus();
                loadStudents();
            });
        }
    } catch (e) {
        console.error("Error loading semesters:", e);
    }
}

function checkLockStatus() {
    const semId = document.getElementById('activeSemester').value;
    const activeSem = rawSemesters.find(s => s.id === semId);
    isSemesterLocked = activeSem ? !!activeSem.isLocked : false;
    
    const badge = document.getElementById('topbarLockedBadge');
    if (badge) {
        isSemesterLocked ? badge.classList.remove('hidden') : badge.classList.add('hidden');
        isSemesterLocked ? badge.classList.add('flex') : badge.classList.remove('flex');
    }
}

// ── 5. LOAD ROSTER (STUDENTS) ───────────────────────────────────────────────
async function loadStudents() {
    const tbody = document.getElementById('studentsTableBody');
    tbody.innerHTML = `<tr><td colspan="9" class="px-6 py-16 text-center text-slate-400 font-semibold"><i class="fa-solid fa-spinner fa-spin text-emerald-400 text-2xl mb-3 block"></i>Loading roster...</td></tr>`;
    
    try {
        const allActSnap = await getDocs(query(collection(db, 'schools', session.schoolId, 'students'), where('archived', '==', false)));
        const allActiveList = allActSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        
        allStudentsCache = allActiveList.filter(s => s.teacherId === session.teacherId);
        unassignedStudentsCache = allActiveList.filter(s => !s.teacherId || !s.className);
        
        studentMap = {};
        allStudentsCache.forEach(s => { studentMap[s.id] = s.name; });
        
        // Update Sidebar stat
        const sbStudents = document.getElementById('sb-students');
        if (sbStudents) sbStudents.textContent = allStudentsCache.length;

        if (!allStudentsCache.length) {
            tbody.innerHTML = `<tr><td colspan="9" class="px-6 py-16 text-center text-slate-400 italic font-semibold">No students yet. Add your first student!</td></tr>`;
            return;
        }

        const semId = document.getElementById('activeSemester').value;
        const allGrades = semId ? await fetchAllStudentGrades(semId) : [];

        let riskCount = 0;

        tbody.innerHTML = allStudentsCache.map((s, i) => {
            const sG = allGrades.filter(g => g.studentId === s.id);
            const subjectCount = new Set(sG.map(g => g.subject)).size;
            const avg = sG.length ? Math.round(sG.reduce((a, g) => a + (g.max ? g.score / g.max * 100 : 0), 0) / sG.length) : null;
            
            if (avg !== null && avg < 65) riskCount++;

            const gc = avg !== null ? `<span class="${gradeColorClass(avg)} font-black">${avg}%</span>` : '<span class="text-slate-400 font-semibold">—</span>';
            const stdClass = standingText(avg);
            
            return `<tr class="trow border-b border-slate-100" data-class="${s.className || ''}" data-standing="${stdClass}">
                <td class="px-6 py-4 text-slate-400 font-bold text-sm">${i + 1}</td>
                <td class="px-6 py-4">
                    <div class="flex items-center gap-3">
                        <div class="h-10 w-10 bg-gradient-to-br from-emerald-400 to-teal-500 text-white rounded-xl flex items-center justify-center font-black text-sm shadow-sm flex-shrink-0">${s.name.charAt(0).toUpperCase()}</div>
                        <span class="font-black text-slate-700">${s.name}</span>
                    </div>
                </td>
                <td class="px-6 py-4 text-slate-500 font-semibold text-sm">${s.className || '—'}</td>
                <td class="px-6 py-4 text-slate-600 font-semibold text-sm">${s.parentPhone || '—'}</td>
                <td class="px-6 py-4"><span class="font-mono font-black text-xs bg-slate-100 border border-slate-200 px-3 py-1.5 rounded-lg tracking-widest">${s.pin}</span></td>
                <td class="px-6 py-4 text-center"><span class="bg-teal-50 text-teal-700 font-black text-sm px-3 py-1 rounded-lg border border-teal-200">${subjectCount}</span></td>
                <td class="px-6 py-4 text-center">${gc}</td>
                <td class="px-6 py-4">${standingBadge(avg)}</td>
                <td class="px-6 py-4 text-right">
                    <div class="flex items-center justify-end gap-1">
                        <button onclick="quickGradeStudent('${s.id}')" class="h-8 w-8 bg-emerald-50 hover:bg-emerald-500 hover:text-white text-emerald-600 rounded-lg transition border border-emerald-200 hover:border-emerald-500 flex items-center justify-center" title="Enter Grade"><i class="fa-solid fa-plus text-xs"></i></button>
                        <button onclick="openStudentPanel('${s.id}')" class="bg-slate-50 hover:bg-slate-600 hover:text-white text-slate-700 font-black px-4 py-2 rounded-lg text-xs transition border border-slate-200 hover:border-slate-600">View</button>
                    </div>
                </td>
            </tr>`;
        }).join('');
        
        // Update Sidebar Risk Stat
        const sbRisk = document.getElementById('sb-risk');
        if (sbRisk) sbRisk.textContent = riskCount;

        applyRosterFilters();
    } catch (e) {
        console.error("Error loading roster:", e);
        tbody.innerHTML = `<tr><td colspan="9" class="px-6 py-16 text-center text-red-400 font-semibold">Error loading roster. Please try again.</td></tr>`;
    }
}

async function fetchAllStudentGrades(semId) {
    const all = [];
    await Promise.all(allStudentsCache.map(async s => {
        try {
            const q = query(collection(db, 'schools', session.schoolId, 'students', s.id, 'grades'), where('semesterId', '==', semId));
            const snap = await getDocs(q);
            snap.forEach(d => all.push({ id: d.id, studentId: s.id, studentName: s.name, ...d.data() }));
        } catch (e) { }
    }));
    return all;
}

// ── 6. TABLE FILTERS ────────────────────────────────────────────────────────
window.applyRosterFilters = function() {
    const fClass = document.getElementById('rf-class')?.value || '';
    const fStanding = document.getElementById('rf-standing')?.value || '';
    
    document.querySelectorAll('#studentsTableBody tr.trow').forEach(r => {
        let show = true;
        if (fClass && r.dataset.class !== fClass) show = false;
        if (fStanding && r.dataset.standing !== fStanding) show = false;
        r.dataset.hiddenByFilter = !show;
        r.style.display = show ? '' : 'none';
    });
    filterStudents();
};

function filterStudents() {
    const term = document.getElementById('searchInput').value.toLowerCase();
    document.querySelectorAll('#studentsTableBody tr.trow').forEach(r => {
        if (r.dataset.hiddenByFilter !== 'true') {
            r.style.display = r.textContent.toLowerCase().includes(term) ? '' : 'none';
        }
    });
}

window.quickGradeStudent = function(studentId) {
    if (isSemesterLocked) {
        alert("The current grading period is locked.");
        return;
    }
    // Redirect to Enter Grade page and pass student ID via URL param or localStorage
    // Using sessionStorage to pass temporary instruction
    sessionStorage.setItem('connectus_quick_grade_student', studentId);
    window.location.href = '../grade_form/grade_form.html';
};

// ── 7. ADD STUDENT MODAL ────────────────────────────────────────────────────
window.openAddStudentModal = function() {
    ['sName', 'sParentPhone', 'sPin'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('addStudentMsg').classList.add('hidden');
    document.getElementById('sAddMethod').value = 'new';
    toggleAddMethod();
    
    const exSel = document.getElementById('sExistingSelect');
    if (!unassignedStudentsCache.length) {
        exSel.innerHTML = '<option value="">No unassigned students available.</option>';
        exSel.disabled = true;
    } else {
        exSel.disabled = false;
        exSel.innerHTML = '<option value="">-- Select returning student --</option>' + unassignedStudentsCache.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
    }
    
    const classes = getClasses().filter(Boolean);
    const wrap = document.getElementById('sClassWrap');
    const sel = document.getElementById('sClass');
    if (classes.length > 1) {
        wrap.classList.remove('hidden');
        sel.innerHTML = classes.map(c => `<option>${c}</option>`).join('');
    } else {
        wrap.classList.add('hidden');
    }
    openOverlay('addStudentModal', 'addStudentModalInner');
};

window.closeAddStudentModal = function() { closeOverlay('addStudentModal', 'addStudentModalInner'); };

window.toggleAddMethod = function() {
    const val = document.getElementById('sAddMethod').value;
    document.getElementById('sNewStudentFields').classList.toggle('hidden', val !== 'new');
    document.getElementById('sExistingStudentFields').classList.toggle('hidden', val === 'new');
};

document.getElementById('saveStudentBtn').addEventListener('click', async () => {
    const method = document.getElementById('sAddMethod').value;
    const classes = getClasses().filter(Boolean);
    const assignedClass = classes.length > 1 ? document.getElementById('sClass').value : classes[0] || session.teacherData.className || '';
    
    const btn = document.getElementById('saveStudentBtn');
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;
    btn.disabled = true;
    
    try {
        if (method === 'new') {
            const name = document.getElementById('sName').value.trim();
            if (!name) { showMsg('addStudentMsg', 'Student name is required.', true); btn.innerHTML = 'Save to Roster'; btn.disabled = false; return; }
            
            // Check capacity limit
            const allActSnap = await getDocs(query(collection(db, 'schools', session.schoolId, 'students'), where('archived', '==', false)));
            if (allActSnap.size >= schoolLimit) {
                showMsg('addStudentMsg', `School capacity reached (${schoolLimit} max). Contact Admin to upgrade.`, true);
                btn.innerHTML = 'Save to Roster'; btn.disabled = false; return;
            }
            
            await addDoc(collection(db, 'schools', session.schoolId, 'students'), {
                name,
                parentPhone: document.getElementById('sParentPhone').value.trim(),
                pin: document.getElementById('sPin').value.trim() || Math.floor(1000 + Math.random() * 9000).toString(),
                teacherId: session.teacherId,
                className: assignedClass,
                archived: false,
                archivedAt: null,
                archiveReason: '',
                createdAt: new Date().toISOString()
            });
        } else {
            const sid = document.getElementById('sExistingSelect').value;
            if (!sid) { showMsg('addStudentMsg', 'Please select a student to pull.', true); btn.innerHTML = 'Save to Roster'; btn.disabled = false; return; }
            await updateDoc(doc(db, 'schools', session.schoolId, 'students', sid), { teacherId: session.teacherId, className: assignedClass });
        }
        closeAddStudentModal();
        await loadStudents();
    } catch (e) {
        console.error(e);
        showMsg('addStudentMsg', 'Error saving student.', true);
    }
    btn.innerHTML = 'Save to Roster';
    btn.disabled = false;
});

// ── 8. STUDENT PANEL & DETAILS ──────────────────────────────────────────────
window.openStudentPanel = async function(studentId) {
    currentStudentId = studentId;
    const student = allStudentsCache.find(s => s.id === studentId);
    
    document.getElementById('sPanelName').textContent = student?.name || 'Student';
    document.getElementById('sPanelMeta').textContent = (student?.className || '') + (student?.parentPhone ? ' · ' + student.parentPhone : '');
    togglePinResetUI(false);
    document.getElementById('spinReadonly').textContent = student?.pin || '—';
    
    document.getElementById('sPanelLoader').classList.remove('hidden');
    document.getElementById('sViewMode').classList.add('hidden');
    document.getElementById('sEditForm').classList.add('hidden');
    
    const qGBtn = document.getElementById('spQuickGradeBtn2');
    if (qGBtn && !isSemesterLocked) {
        qGBtn.classList.remove('hidden');
        qGBtn.onclick = () => { closeStudentPanel(); quickGradeStudent(studentId); };
    } else if (qGBtn) {
        qGBtn.classList.add('hidden');
    }
    
    openOverlay('studentPanel', 'studentPanelInner');
    
    document.getElementById('editSName').value = student?.name || '';
    document.getElementById('editSPhone').value = student?.parentPhone || '';
    
    document.getElementById('sInfoGrid').innerHTML = [
        ['Name', student?.name || '—'],
        ['Class', student?.className || '—'],
        ['Parent Phone', student?.parentPhone || '—'],
        ['Added', student?.createdAt ? new Date(student.createdAt).toLocaleDateString() : '—']
    ].map(([l, v]) => `
        <div class="bg-white border border-slate-200 rounded-xl p-3">
            <p class="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-1">${l}</p>
            <p class="font-black text-slate-700 text-sm">${v}</p>
        </div>`).join('');
        
    const semId = document.getElementById('activeSemester').value;
    const semName = document.getElementById('activeSemester').options[document.getElementById('activeSemester').selectedIndex]?.text || '';
    document.getElementById('sPanelSemName').textContent = semName;
    document.getElementById('sPanelFilterSubject').value = '';
    document.getElementById('sPanelFilterType').value = '';
    
    try {
        const gradesSnap = await getDocs(collection(db, 'schools', session.schoolId, 'students', studentId, 'grades'));
        let tempGrades = [];
        gradesSnap.forEach(d => {
            const g = { id: d.id, ...d.data() };
            if (g.semesterId === semId) tempGrades.push(g);
        });
        currentStudentGradesCache = tempGrades;
        
        // Populate filters for this specific student
        const subjSet = [...new Set(currentStudentGradesCache.map(g => g.subject || 'Uncategorized'))].sort();
        document.getElementById('sPanelFilterSubject').innerHTML = '<option value="">All Subjects</option>' + subjSet.map(s => `<option value="${s}">${s}</option>`).join('');
        document.getElementById('sPanelFilterType').innerHTML = '<option value="">All Types</option>' + getGradeTypes().map(t => `<option value="${t}">${t}</option>`).join('');
        
        renderStudentGrades();
    } catch (e) {
        console.error(e);
    }
    
    document.getElementById('sPanelLoader').classList.add('hidden');
    document.getElementById('sViewMode').classList.remove('hidden');
};

window.closeStudentPanel = function() { closeOverlay('studentPanel', 'studentPanelInner'); };

window.renderStudentGrades = function() {
    const fSubj = document.getElementById('sPanelFilterSubject').value;
    const fType = document.getElementById('sPanelFilterType').value;
    const by = {};
    
    currentStudentGradesCache.forEach(g => {
        if (fSubj && g.subject !== fSubj) return;
        if (fType && g.type !== fType) return;
        const subj = g.subject || 'Uncategorized';
        if (!by[subj]) by[subj] = [];
        by[subj].push(g);
    });
    
    const container = document.getElementById('subjectAccordions');
    const noG = document.getElementById('noGradesMsg');
    gradeDetailCache = {}; // Reset cache for modal
    
    if (!Object.keys(by).length) {
        container.innerHTML = '';
        noG.classList.remove('hidden');
    } else {
        noG.classList.add('hidden');
        container.innerHTML = Object.entries(by).map(([subject, grades]) => {
            const avg = grades.reduce((a, g) => a + (g.max ? g.score / g.max * 100 : 0), 0) / grades.length;
            
            const rows = grades.sort((a, b) => (b.date || '').localeCompare(a.date || '')).map(g => {
                gradeDetailCache[g.id] = g; // Cache for Assignment Modal
                const pct = g.max ? Math.round(g.score / g.max * 100) : null;
                const txtColorClass = pct >= 75 ? 'text-emerald-600' : pct >= 65 ? 'text-amber-600' : 'text-red-600';
                const badgeColorClass = pct >= 90 ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : pct >= 80 ? 'bg-blue-50 border-blue-200 text-blue-700' : pct >= 70 ? 'bg-teal-50 border-teal-200 text-teal-700' : pct >= 65 ? 'bg-amber-50 border-amber-200 text-amber-700' : 'bg-red-50 border-red-200 text-red-700';
                
                return `
                <div class="bg-white border border-slate-200 rounded-xl p-3 flex items-center justify-between hover:shadow-sm transition cursor-pointer" onclick="openAssignmentModal('${g.id}')">
                    <div class="flex-1 min-w-0">
                        <p class="font-bold text-slate-700 text-sm truncate hover:text-emerald-600">${g.title || 'Assessment'}</p>
                        <p class="text-xs text-slate-400 font-semibold mt-0.5">${g.type || ''} ${g.date ? '· ' + g.date : ''}</p>
                    </div>
                    <div class="flex items-center gap-2 flex-shrink-0 ml-3">
                        <span class="font-black text-sm ${txtColorClass}">${g.score}/${g.max || '?'}</span>
                        <span class="text-xs font-black px-2 py-0.5 rounded-lg border ${badgeColorClass}">${pct !== null ? pct + '%' : '—'}</span>
                    </div>
                </div>`;
            }).join('');
            
            const subjectBadgeClass = avg >= 90 ? 'bg-emerald-50 border-emerald-200' : avg >= 80 ? 'bg-blue-50 border-blue-200' : avg >= 70 ? 'bg-teal-50 border-teal-200' : avg >= 65 ? 'bg-amber-50 border-amber-200' : 'bg-red-50 border-red-200';
            
            return `
            <div class="rounded-2xl border border-slate-200 overflow-hidden shadow-sm bg-white">
                <div class="flex items-center justify-between px-5 py-4 cursor-pointer hover:bg-slate-50 transition" onclick="toggleAccordion(this)">
                    <div class="flex items-center gap-3">
                        <div class="w-9 h-9 bg-gradient-to-br from-emerald-500 to-teal-600 text-white rounded-xl flex items-center justify-center font-black text-xs shadow-sm">${subject.charAt(0)}</div>
                        <div>
                            <p class="font-black text-slate-800">${subject}</p>
                            <p class="text-xs text-slate-400 font-semibold">${grades.length} assignment${grades.length !== 1 ? 's' : ''}</p>
                        </div>
                    </div>
                    <div class="flex items-center gap-3">
                        <span class="text-xs font-black px-3 py-1 rounded-xl border ${gradeColorClass(avg)} ${subjectBadgeClass}">${Math.round(avg)}% · ${letterGrade(avg)}</span>
                        <i class="fa-solid fa-chevron-down text-slate-400" style="transition:transform 0.2s"></i>
                    </div>
                </div>
                <div class="subject-body open"><div class="px-4 pb-4 pt-2 bg-slate-50/60 space-y-2">${rows}</div></div>
            </div>`;
        }).join('');
    }
};

window.toggleAccordion = function(h) {
    const b = h.nextElementSibling;
    b.classList.toggle('open');
    h.querySelector('.fa-chevron-down').style.transform = b.classList.contains('open') ? 'rotate(180deg)' : 'rotate(0deg)';
};

// Edit Student Logic
let isStudentEditMode = false;
window.toggleStudentEdit = function(show) {
    isStudentEditMode = show !== undefined ? show : !isStudentEditMode;
    document.getElementById('sEditForm').classList.toggle('hidden', !isStudentEditMode);
    document.getElementById('editStudentMsg').classList.add('hidden');
};

document.getElementById('saveStudentEditBtn').addEventListener('click', async () => {
    const btn = document.getElementById('saveStudentEditBtn');
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
    btn.disabled = true;
    
    try {
        const u = {
            name: document.getElementById('editSName').value.trim(),
            parentPhone: document.getElementById('editSPhone').value.trim()
        };
        await updateDoc(doc(db, 'schools', session.schoolId, 'students', currentStudentId), u);
        
        const idx = allStudentsCache.findIndex(s => s.id === currentStudentId);
        if (idx !== -1) Object.assign(allStudentsCache[idx], u);
        studentMap[currentStudentId] = u.name;
        
        showMsg('editStudentMsg', 'Changes saved!', false);
        toggleStudentEdit(false);
        document.getElementById('sPanelName').textContent = u.name;
        loadStudents();
    } catch (e) {
        console.error(e);
        showMsg('editStudentMsg', 'Error saving changes.', true);
    }
    btn.innerHTML = 'Save';
    btn.disabled = false;
});

// PIN Logic
window.togglePinResetUI = function(show) {
    document.getElementById('pinDisplayArea').classList.toggle('hidden', show);
    document.getElementById('pinEditArea').classList.toggle('hidden', !show);
    if (show) document.getElementById('inlineNewPin').value = '';
};

window.saveInlinePin = async function() {
    const npin = document.getElementById('inlineNewPin').value.trim();
    if (!npin || npin.length < 4) { alert('PIN must be 4-6 characters.'); return; }
    
    const btn = document.getElementById('inlinePinSaveBtn');
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
    btn.disabled = true;
    
    try {
        await updateDoc(doc(db, 'schools', session.schoolId, 'students', currentStudentId), { pin: npin });
        const idx = allStudentsCache.findIndex(s => s.id === currentStudentId);
        if (idx !== -1) allStudentsCache[idx].pin = npin;
        document.getElementById('spinReadonly').textContent = npin;
        togglePinResetUI(false);
        loadStudents();
    } catch (e) {
        console.error(e);
        alert('Error saving PIN');
    }
    btn.innerHTML = 'Save';
    btn.disabled = false;
};

// ── 9. ASSIGNMENT DETAIL MODAL ──────────────────────────────────────────────
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

// ── 10. ARCHIVE STUDENT ─────────────────────────────────────────────────────
window.archiveStudent = function() {
    const s = allStudentsCache.find(x => x.id === currentStudentId);
    document.getElementById('archiveStudentName').textContent = s ? s.name : 'this student';
    document.getElementById('archiveReasonSelect').value = 'Transferred to another school';
    document.getElementById('archiveReasonOther').value = '';
    document.getElementById('archiveReasonOther').classList.add('hidden');
    openOverlay('archiveReasonModal', 'archiveReasonModalInner');
};

window.closeArchiveReasonModal = function() { closeOverlay('archiveReasonModal', 'archiveReasonModalInner'); };

document.getElementById('confirmArchiveBtn').addEventListener('click', async () => {
    const sel = document.getElementById('archiveReasonSelect').value;
    const reason = sel === 'Other' ? document.getElementById('archiveReasonOther').value.trim() : sel;
    
    const btn = document.getElementById('confirmArchiveBtn');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Archiving...';
    btn.disabled = true;
    
    try {
        await updateDoc(doc(db, 'schools', session.schoolId, 'students', currentStudentId), {
            archived: true,
            archivedAt: new Date().toISOString(),
            archiveReason: reason || 'Not specified',
            teacherId: '',
            className: ''
        });
        closeArchiveReasonModal();
        closeStudentPanel();
        loadStudents();
    } catch (e) {
        alert('Error archiving student.');
    }
    btn.innerHTML = 'Confirm & Archive';
    btn.disabled = false;
});

// ── 11. EXPORT & PRINT ──────────────────────────────────────────────────────
window.exportRosterCSV = function() {
    const rows = [['#', 'Name', 'Class', 'Parent Phone', 'Parent PIN']];
    allStudentsCache.forEach((s, i) => rows.push([i + 1, s.name, s.className || '', s.parentPhone || '', s.pin]));
    downloadCSV(rows, `${session.schoolId}_roster.csv`);
};

window.printRoster = function() {
    const printDisclaimer = "<p style='font-size:10px;color:#64748b;margin-top:40px;text-align:center;border-top:1px solid #e2e8f0;padding-top:10px;font-style:italic;'>This document does not constitute an official report card.</p>";
    const w = window.open('', '_blank');
    w.document.write(`
        <html><head><title>Roster</title>
        <style>body{font-family:sans-serif;padding:20px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #e2e8f0;padding:8px 12px;font-size:13px;text-align:left}th{background:#064e3b;color:white;font-weight:700}</style>
        </head><body>
        <h2>${session.teacherData.name} — Class Roster</h2>
        <p style="color:#64748b;font-size:12px;margin-bottom:16px">Printed ${new Date().toLocaleDateString()}</p>
        <table><thead><tr><th>#</th><th>Name</th><th>Class</th><th>Parent Phone</th><th>Parent PIN</th></tr></thead>
        <tbody>${allStudentsCache.map((s, i) => `<tr><td>${i + 1}</td><td>${s.name}</td><td>${s.className || '—'}</td><td>${s.parentPhone || '—'}</td><td>${s.pin}</td></tr>`).join('')}</tbody>
        </table>${printDisclaimer}</body></html>`);
    w.document.close();
    setTimeout(() => w.print(), 500);
};

window.openPrintStudentModal = function() {
    const psSubj = document.getElementById('psSubject');
    const activeSubs = getActiveSubjects();
    psSubj.innerHTML = '<option value="all">All Subjects</option>' + activeSubs.map(s => `<option value="${s.name}">${s.name}</option>`).join('');
    openOverlay('printStudentModal', 'printStudentModalInner');
};

window.closePrintStudentModal = function() { closeOverlay('printStudentModal', 'printStudentModalInner'); };

window.executeStudentPrint = async function() {
    const mode = document.getElementById('psMode').value;
    const subjFilter = document.getElementById('psSubject').value;
    const studentId = currentStudentId;
    
    try {
        const sDoc = await getDoc(doc(db, 'schools', session.schoolId, 'students', studentId));
        if (!sDoc.exists()) { alert('Student not found.'); return; }
        const s = sDoc.data();
        
        const gradesSnap = await getDocs(collection(db, 'schools', session.schoolId, 'students', studentId, 'grades'));
        let grades = [];
        gradesSnap.forEach(d => grades.push(d.data()));
        
        const bySem = {};
        grades.forEach(g => {
            if (subjFilter !== 'all' && g.subject !== subjFilter) return;
            const sem = rawSemesters.find(sm => sm.id === g.semesterId)?.name || 'Unknown Period';
            const sub = g.subject || 'Uncategorized';
            if (!bySem[sem]) bySem[sem] = {};
            if (!bySem[sem][sub]) bySem[sem][sub] = [];
            bySem[sem][sub].push(g);
        });
        
        let html = `<html><head><title>Student Record - ${s.name}</title>
        <style>
            body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;padding:40px;color:#1e293b;line-height:1.5;}
            .header{text-align:center;border-bottom:2px solid #cbd5e1;padding-bottom:20px;margin-bottom:30px;}
            .header h1{margin:0 0 5px 0;font-size:22px;color:#0f172a;text-transform:uppercase;letter-spacing:1px;}
            .header h2{margin:0;font-size:14px;color:#059669;font-weight:bold;letter-spacing:2px;}
            .info-grid{display:grid;grid-template-columns:1fr 1fr;gap:15px;margin-bottom:40px;background:#f8fafc;padding:20px;border-radius:8px;border:1px solid #e2e8f0;}
            .info-item label{display:block;font-size:10px;text-transform:uppercase;color:#64748b;font-weight:bold;letter-spacing:1px;}
            .info-item span{font-size:14px;font-weight:bold;color:#0f172a;}
            .sem-block{margin-bottom:40px;page-break-inside:avoid;}
            .sem-title{font-size:14px;font-weight:bold;background:#064e3b;color:white;padding:8px 15px;margin:0 0 15px 0;border-radius:4px;}
            table{width:100%;border-collapse:collapse;margin-bottom:10px;font-size:13px;}
            th,td{border:1px solid #e2e8f0;padding:8px 12px;text-align:left;}
            th{background:#f1f5f9;color:#475569;font-weight:bold;text-transform:uppercase;font-size:10px;letter-spacing:0.5px;}
            .tc{text-align:center;}.tr{text-align:right;}
            .avg-row{background:#f8fafc;font-weight:bold;}
        </style></head><body>
        <div class="header"><h1>ConnectUs — Official Record</h1><h2>STUDENT ${mode === 'summary' ? 'REPORT CARD' : 'DETAILED TRANSCRIPT'}</h2></div>
        <div class="info-grid">
            <div class="info-item"><label>Student Name</label><span>${s.name}</span></div>
            <div class="info-item"><label>Status</label><span>${s.archived ? 'Archived / Transferred' : 'Active'}</span></div>
            <div class="info-item"><label>Last Known Class</label><span>${s.className || 'Unassigned'}</span></div>
            <div class="info-item"><label>Teacher</label><span>${session.teacherData.name}</span></div>
        </div>`;
        
        if (!Object.keys(bySem).length) {
            html += `<p style="text-align:center;color:#64748b;font-style:italic;padding:40px;">No grades recorded matching filters.</p>`;
        } else {
            for (let sem in bySem) {
                html += `<div class="sem-block"><h3 class="sem-title">${sem}</h3><table>`;
                if (mode === 'summary') {
                    html += `<thead><tr><th>Subject</th><th class="tc">Assignments</th><th class="tc">Average (%)</th><th class="tc">Letter Grade</th></tr></thead><tbody>`;
                    let semTotalPct = 0; let semSubjCount = 0;
                    for (let sub in bySem[sem]) {
                        const sGrades = bySem[sem][sub];
                        const avg = Math.round(sGrades.reduce((acc, g) => acc + (g.max ? (g.score / g.max) * 100 : 0), 0) / sGrades.length);
                        semTotalPct += avg; semSubjCount++;
                        html += `<tr><td>${sub}</td><td class="tc">${sGrades.length}</td><td class="tc">${avg}%</td><td class="tc">${letterGrade(avg)}</td></tr>`;
                    }
                    const semAvg = Math.round(semTotalPct / semSubjCount);
                    html += `<tr class="avg-row"><td colspan="2" class="tr">PERIOD AVERAGE:</td><td class="tc">${semAvg}%</td><td class="tc">${letterGrade(semAvg)}</td></tr></tbody></table></div>`;
                } else {
                    html += `<thead><tr><th>Subject</th><th>Assignment</th><th>Type</th><th class="tc">Score</th><th class="tc">%</th></tr></thead><tbody>`;
                    for (let sub in bySem[sem]) {
                        const sGrades = bySem[sem][sub].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
                        sGrades.forEach(g => {
                            const pct = g.max ? Math.round(g.score / g.max * 100) : null;
                            html += `<tr><td>${sub}</td><td>${g.title}<br><span style="font-size:10px;color:#94a3b8">${g.date || ''}</span></td><td>${g.type}</td><td class="tc">${g.score}/${g.max}</td><td class="tc">${pct !== null ? pct + '%' : '—'}</td></tr>`;
                        });
                    }
                    html += `</tbody></table></div>`;
                }
            }
        }
        
        const printDisclaimer = "<p style='font-size:10px;color:#64748b;margin-top:40px;text-align:center;border-top:1px solid #e2e8f0;padding-top:10px;font-style:italic;'>This document does not constitute an official report card.</p>";
        html += printDisclaimer + `</body></html>`;
        
        const w = window.open('', '_blank');
        w.document.write(html);
        w.document.close();
        closePrintStudentModal();
        setTimeout(() => w.print(), 500);
        
    } catch (e) {
        console.error(e);
        alert('Error generating print.');
    }
};

// Fire it up
init();
