import { db } from '../../assets/js/firebase-init.js';
import { collection, query, where, getDocs, getDoc, doc, updateDoc, setDoc, deleteDoc, collectionGroup } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth, setSessionData } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { openOverlay, closeOverlay, showMsg, gradeColorClass, letterGrade, standingBadge, gradeFill, calculateWeightedAverage, loadTeacherSubjectsCache, getTeacherDocRef, resolveGradeWeights, saveGrade } from '../../assets/js/utils.js';
import { resolvePostContext } from '../../assets/js/posts.js';
import { loadSubmissionsForAssignment } from '../../assets/js/submissions.js';

// ── 1. AUTHENTICATION & LAYOUT ──────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    injectTeacherLayout('subjects', 'Subjects Overview', 'Performance by subject for the active period', false);
}

// ── 2. STATE VARIABLES ──────────────────────────────────────────────────────
let allStudentsCache = [];
let studentMap = {}; // Maps ID to full student object (includes className)
let allGradesCache = null;
let cachedSubjectGrades = [];
let rawSemesters = [];
let isSemesterLocked = false;
let currentSubjectName = null;
let gradeDetailCache = {};
let currentPanelTab = 'performance'; // NEW: tracks active tab inside the subject panel

// PHASE 1 MILESTONE 3: null = composer is in "add new" mode; an assignment id
// = composer is editing that existing assignment. Reset whenever the panel
// tab changes or the subject panel closes, so switching away always lands
// back on a clean "add new" composer.
let editingAssignmentId = null;

// PHASE 1 MILESTONE 5: state for the Review Submissions slide-in panel.
// reviewAssignment carries the resolved {classId, subjectId, className,
// subjectName} context (via resolvePostContext, same helper posts.js and
// submissions.js already use) merged onto the raw assignment object, so
// every fetch/save below has what it needs without re-resolving.
// reviewRoster/reviewSubmissions/reviewGrades are populated fresh every
// time the panel opens for a given assignment.
let reviewAssignment = null;
let reviewRoster = [];
let reviewSubmissions = new Map();
let reviewGrades = new Map();

// PHASE 0: resolvedClasses is this teacher's className(s) resolved against
// the real schools/{schoolId}/classes collection — populated once by
// loadSubjectsCache(). subjectsCache merges, per subject: any real
// schools/{schoolId}/classes/{classId}/subjects documents across every one
// of those resolved classes (_source: 'new'), plus — only for a subject
// name not already represented in that new-model list — whatever's still
// sitting in the legacy teachers/{id}.subjects array (_source: 'legacy').
// This is what makes a not-yet-migrated teacher/school see no change at
// all, while new subjects (created via the class picker below, or already
// migrated by the bulk script) read and write through the real collections.
// Every _source:'new' subject's assignments subcollection is fetched
// up front, in loadSubjectsCache(), and attached as sub.assignments — the
// same shape a _source:'legacy' subject already carries embedded — because
// the subject tile grid needs every subject's own assignment count, not
// just whichever one panel happens to be open.
let resolvedClasses = [];
let subjectsCache = [];

// PHASE 0: resolved once at init() via resolveGradeWeights() — preferring
// the new schools/{schoolId}/teaching_assignments weighting over the
// legacy gradeTypes/customGradeTypes fields, same precedence as every
// other migrated page. Passive display data, so it's cached once here
// rather than re-resolved on every getGradeTypes() call.
let resolvedGradeTypes = null;

// UPDATED: Pull the gradeTypes array saved from the new Settings page
const DEFAULT_GRADE_TYPES = ['Test', 'Quiz', 'Assignment', 'Homework', 'Project', 'Midterm Exam', 'Final Exam'];
function getActiveSubjects() { return subjectsCache.filter(s => !s.archived); }
function getGradeTypes() { return resolvedGradeTypes || DEFAULT_GRADE_TYPES; }
function genId() { return 'sub_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5); }
function genAssignmentId() { return 'asg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5); }

// Escapes HTML to prevent XSS in rendering
function escHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// NEW: deterministic gradient per subject name so each tile has a stable identity colour
const TILE_GRADIENTS = [
    'from-teal-500 to-emerald-600',
    'from-sky-500 to-blue-600',
    'from-violet-500 to-purple-600',
    'from-amber-500 to-orange-600',
    'from-rose-500 to-pink-600',
    'from-cyan-500 to-teal-600',
    'from-indigo-500 to-violet-600',
    'from-emerald-500 to-green-600'
];
function gradientFor(name) {
    let hash = 0;
    for (let i = 0; i < (name || '').length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    return TILE_GRADIENTS[hash % TILE_GRADIENTS.length];
}

// NEW: read the assignment templates for a subject by name (safe fallback to [])
function getSubjectByName(name) {
    return subjectsCache.find(s => s.name === name && !s.archived) || null;
}
// Both _source values carry a real sub.assignments array by the time this
// is called — 'new' subjects have theirs fetched up front in
// loadSubjectsCache(), 'legacy' ones already have it embedded.
function getAssignmentsForSubject(name) {
    const sub = getSubjectByName(name);
    return (sub && Array.isArray(sub.assignments)) ? sub.assignments : [];
}

// PHASE 0: single source of truth for the legacy/new-model subjects merge —
// lives in utils.js as loadTeacherSubjectsCache() so grade_form.js and
// archives.js can share the exact same logic instead of each carrying
// their own copy.
async function loadSubjectsCache() {
    const result = await loadTeacherSubjectsCache(session.schoolId, session.teacherId, session.teacherData);
    subjectsCache = result.subjectsCache;
    resolvedClasses = result.resolvedClasses;
}

// ── 3. INITIALIZATION ───────────────────────────────────────────────────────
async function init() {
    if (!session) return;

    document.getElementById('displayTeacherName').textContent = session.teacherData.name;
    document.getElementById('teacherAvatar').textContent = session.teacherData.name.charAt(0).toUpperCase();
    document.getElementById('sidebarSchoolId').textContent = session.schoolId;

    const classes = session.teacherData.classes || [session.teacherData.className || ''];
    document.getElementById('displayTeacherClasses').innerHTML = classes.map(c => `<span class="class-pill">${c}</span>`).join('');

    document.getElementById('saveSubjectFormBtn').addEventListener('click', saveSubject);

    await loadSemestersAndLockStatus();
    await loadStudents();
    await loadSubjectsCache();
    try {
        resolvedGradeTypes = await resolveGradeWeights(session.schoolId, session.teacherId, { legacyTeacherData: session.teacherData });
    } catch (e) {
        console.error('[Subjects] Failed to resolve grade weights:', e);
    }
    await loadSubjectsTab();
}

async function loadSemestersAndLockStatus() {
    try {
        const semSnap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        const activeId = schoolSnap.data()?.activeSemesterId || '';

        rawSemesters = semSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0));

        const semSel = document.getElementById('activeSemester');
        semSel.innerHTML = '';
        rawSemesters.forEach(s => {
            semSel.innerHTML += `<option value="${s.id}"${s.id === activeId ? ' selected' : ''}>${s.name}</option>`;
        });

        checkLockStatus();

        semSel.addEventListener('change', () => {
            checkLockStatus();
            allGradesCache = null; // Clear cache on semester change
            loadSubjectsTab();
        });
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

async function loadStudents() {
    try {
        // CHANGED: query global /students, filter teacherId in memory
        const stuSnap = await getDocs(query(
            collection(db, 'students'),
            where('currentSchoolId', '==', session.schoolId),
            where('enrollmentStatus', '==', 'Active')
        ));
        allStudentsCache = stuSnap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(s => s.teacherId === session.teacherId);
        studentMap = {};
        allStudentsCache.forEach(s => { studentMap[s.id] = s; }); // Store full object
        
        // Update Sidebar Stat
        const sbStudents = document.getElementById('sb-students');
        if (sbStudents) sbStudents.textContent = allStudentsCache.length;
    } catch (e) { console.error("Error loading students:", e); }
}

async function getAllGrades(semId) {
    if (allGradesCache && allGradesCache.semId === semId) return allGradesCache.grades;
    const all = [];
    await Promise.all(allStudentsCache.map(async s => {
        try {
            // FIXED: Point to the global students collection
            const q = query(collection(db, 'students', s.id, 'grades'), where('schoolId', '==', session.schoolId), where('semesterId', '==', semId));
            const snap = await getDocs(q);
            snap.forEach(d => all.push({ id: d.id, studentId: s.id, studentName: s.name, ...d.data() }));
        } catch (e) { }
    }));
    allGradesCache = { semId, grades: all };
    return all;
}

// ── 4. RENDER MAIN SUBJECTS GRID (TILES) ────────────────────────────────────
async function loadSubjectsTab() {
    const grid = document.getElementById('subjectsGrid');
    grid.innerHTML = `<div class="col-span-full flex flex-col items-center justify-center py-24 text-slate-400 font-semibold">
        <i class="fa-solid fa-spinner fa-spin text-teal-400 text-3xl mb-4"></i>Loading subjects…
    </div>`;

    const semId = document.getElementById('activeSemester').value;
    const semName = document.getElementById('activeSemester').options[document.getElementById('activeSemester').selectedIndex]?.text || '—';

    const sbPeriod = document.getElementById('sb-period');
    if (sbPeriod) sbPeriod.textContent = semName;

    const allGrades = await getAllGrades(semId);
    const active = getActiveSubjects();

    if (!active.length) {
        grid.innerHTML = `
            <div class="col-span-full">
                <div class="bg-white border-2 border-dashed border-teal-200 rounded-3xl py-20 px-6 text-center">
                    <div class="w-16 h-16 mx-auto mb-5 bg-teal-50 text-teal-500 rounded-2xl flex items-center justify-center text-2xl">
                        <i class="fa-solid fa-layer-group"></i>
                    </div>
                    <h3 class="font-black text-slate-700 text-lg mb-1.5">No subjects yet</h3>
                    <p class="text-sm text-slate-400 font-semibold max-w-sm mx-auto mb-6">Create your first subject to start tracking performance and prepare assignments ahead of grading.</p>
                    <button onclick="openSubjectFormModal()" class="inline-flex items-center gap-2 bg-teal-600 hover:bg-teal-700 text-white font-black px-5 py-2.5 rounded-xl text-sm shadow-md shadow-teal-500/20 transition">
                        <i class="fa-solid fa-plus"></i> Add your first subject
                    </button>
                </div>
            </div>`;
        return;
    }

    grid.innerHTML = active.map(sub => {
        const sg = allGrades.filter(g => g.subject === sub.name);
        const stuIds = [...new Set(sg.map(g => g.studentId))];
        const stuAvgs = stuIds.map(sid => {
            const sg2 = sg.filter(g => g.studentId === sid);
            return calculateWeightedAverage(sg2, getGradeTypes());
        }).filter(a => a !== null);

        const classAvg = stuAvgs.length ? Math.round(stuAvgs.reduce((a, b) => a + b, 0) / stuAvgs.length) : null;
        const atRisk = stuAvgs.filter(a => a < 65).length;
        const lastGraded = sg.length ? sg.sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0].date : null;
        const asgCount = getAssignmentsForSubject(sub.name).length;
        const gradient = gradientFor(sub.name);
        const safeName = sub.name.replace(/'/g, "\\'");

        return `
        <div class="subject-tile group relative text-left bg-white border border-slate-200 rounded-3xl p-5 shadow-sm hover:shadow-xl hover:border-teal-300 hover:-translate-y-1 transition-all duration-200 flex flex-col cursor-pointer focus:outline-none focus:ring-2 focus:ring-teal-400 focus:ring-offset-2"
            tabindex="0" role="button"
            onclick="openSubjectPanel('${safeName}')"
            onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openSubjectPanel('${safeName}');}">
            <button type="button" onclick="event.stopPropagation(); archiveSubject('${sub.id}', '${safeName}')" title="Archive subject"
                class="absolute top-4 right-4 z-10 w-7 h-7 flex items-center justify-center rounded-lg text-slate-300 hover:text-amber-600 hover:bg-amber-50 border border-transparent hover:border-amber-200 opacity-0 group-hover:opacity-100 transition-opacity">
                <i class="fa-solid fa-box-archive text-xs"></i>
            </button>
            <div class="flex items-start justify-between mb-4 pr-8">
                <div class="w-12 h-12 bg-gradient-to-br ${gradient} text-white rounded-2xl flex items-center justify-center font-black text-lg shadow-md flex-shrink-0">${escHtml(sub.name.charAt(0).toUpperCase())}</div>
                ${atRisk
                    ? `<span class="inline-flex items-center gap-1 text-[11px] font-black text-red-600 bg-red-50 border border-red-200 px-2.5 py-1 rounded-full"><i class="fa-solid fa-triangle-exclamation text-[9px]"></i> ${atRisk} at risk</span>`
                    : `<span class="text-teal-500 opacity-0 group-hover:opacity-100 transition-opacity"><i class="fa-solid fa-arrow-right"></i></span>`}
            </div>
            <h3 class="font-black text-slate-800 text-lg leading-tight">${escHtml(sub.name)}</h3>
            <p class="text-xs text-slate-400 font-semibold mt-1 mb-4 line-clamp-2 min-h-[2rem]">${sub.description ? escHtml(sub.description) : 'No description'}</p>

            <div class="mt-auto grid grid-cols-3 gap-2">
                <div class="bg-slate-50 rounded-xl py-2 px-1 text-center border border-slate-100">
                    <p class="text-[9px] font-black text-slate-400 uppercase tracking-wider">Students</p>
                    <p class="text-base font-black text-slate-700">${stuIds.length}</p>
                </div>
                <div class="bg-slate-50 rounded-xl py-2 px-1 text-center border border-slate-100">
                    <p class="text-[9px] font-black text-slate-400 uppercase tracking-wider">Class avg</p>
                    <p class="text-base font-black ${classAvg !== null ? gradeColorClass(classAvg) : 'text-slate-300'}">${classAvg !== null ? classAvg + '%' : '—'}</p>
                </div>
                <div class="bg-teal-50 rounded-xl py-2 px-1 text-center border border-teal-100">
                    <p class="text-[9px] font-black text-teal-500 uppercase tracking-wider">Tasks</p>
                    <p class="text-base font-black text-teal-700">${asgCount}</p>
                </div>
            </div>
            <div class="flex items-center justify-between mt-3 pt-3 border-t border-slate-100">
                <span class="text-[11px] font-bold text-slate-400">${sg.length} grade${sg.length !== 1 ? 's' : ''} logged</span>
                <span class="text-[11px] font-bold text-slate-400">${lastGraded ? 'Last: ' + lastGraded : 'Not graded'}</span>
            </div>
        </div>`;
    }).join('');
}

// ── 5. SUBJECT PANEL (SLIDE OUT) ────────────────────────────────────────────
window.openSubjectPanel = async function(subjectName) {
    currentSubjectName = subjectName;
    currentPanelTab = 'performance'; // always reset to Performance on open
    editingAssignmentId = null; // always reopen the assignments composer in "add new" mode
    document.getElementById('spPanelTitle').textContent = subjectName;
    document.getElementById('subjectPanelBody').innerHTML = '<div class="flex justify-center py-16"><i class="fa-solid fa-circle-notch fa-spin text-3xl text-teal-500"></i></div>';

    // Reset Filters
    document.getElementById('spFilterClass').value = '';
    document.getElementById('spFilterStudent').value = '';
    document.getElementById('spFilterStanding').value = '';
    document.getElementById('spFilterType').value = '';
    document.getElementById('spSearchTitle').value = '';

    // Populate Class Filter
    const classes = session.teacherData.classes || [session.teacherData.className || ''];
    const spClass = document.getElementById('spFilterClass');
    spClass.innerHTML = '<option value="">All Classes</option>' + classes.filter(Boolean).map(c => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join('');

    // Populate Type Filter (Updated to use robust getGradeTypes handling object or string)
    const spType = document.getElementById('spFilterType');
    spType.innerHTML = '<option value="">All Types</option>' + getGradeTypes().map(t => `<option value="${t.name || t}">${t.name || t}</option>`).join('');

    openOverlay('subjectPanel', 'subjectPanelInner', true);

    const quickGradeBtn = document.getElementById('spQuickGradeBtn');
    if (isSemesterLocked) {
        quickGradeBtn.classList.add('hidden');
    } else {
        quickGradeBtn.classList.remove('hidden');
        quickGradeBtn.onclick = () => { window.location.href = '../grade_form/grade_form.html'; };
    }

    const semId = document.getElementById('activeSemester').value;
    const semName = document.getElementById('activeSemester').options[document.getElementById('activeSemester').selectedIndex]?.text || '';
    document.getElementById('spPanelMeta').textContent = `${semName} · Loading...`;

    const allGrades = await getAllGrades(semId);
    cachedSubjectGrades = allGrades.filter(g => g.subject === subjectName);

    // Populate Student Filter based on enrolled
    const spStuFilter = document.getElementById('spFilterStudent');
    const stuIdsInSubj = [...new Set(cachedSubjectGrades.map(g => g.studentId))];
    spStuFilter.innerHTML = '<option value="">All Students</option>' + stuIdsInSubj.map(sid => `<option value="${sid}">${studentMap[sid]?.name || 'Unknown'}</option>`).join('');

    // NEW: refresh the assignments-tab count badge
    updateAssignmentTabBadge();

    switchPanelTab('performance');
};

// NEW: tab switcher inside the subject panel
window.switchPanelTab = function(tab) {
    currentPanelTab = tab;

    const perfBtn = document.getElementById('spTabPerformance');
    const asgBtn = document.getElementById('spTabAssignments');
    const filters = document.getElementById('spFilterBar');

    [perfBtn, asgBtn].forEach(b => {
        if (!b) return;
        b.classList.remove('sp-tab-active');
    });

    if (tab === 'performance') {
        perfBtn?.classList.add('sp-tab-active');
        if (filters) filters.classList.remove('hidden');
        renderSubjectPanelData();
    } else {
        asgBtn?.classList.add('sp-tab-active');
        if (filters) filters.classList.add('hidden'); // filters only apply to performance view
        renderAssignmentsTab();
    }
};

function updateAssignmentTabBadge() {
    const badge = document.getElementById('spAsgCountBadge');
    if (!badge) return;
    // Count only active (not-yet-graded) assignments — that's what's left to act on in the grade form
    const count = getAssignmentsForSubject(currentSubjectName).filter(a => !a.completed).length;
    badge.textContent = count;
    badge.classList.toggle('hidden', count === 0);
}

function getFilteredSubjectData() {
    const fClass = document.getElementById('spFilterClass').value;
    const fStudent = document.getElementById('spFilterStudent').value;
    const fStanding = document.getElementById('spFilterStanding').value;
    const fType = document.getElementById('spFilterType').value;
    const fTitle = document.getElementById('spSearchTitle').value.toLowerCase();
    
    let sg = cachedSubjectGrades;

    // Pre-calculate student averages for standing filter
    const studentAvgs = {};
    sg.forEach(g => {
        if (!studentAvgs[g.studentId]) studentAvgs[g.studentId] = [];
        if (g.max > 0) studentAvgs[g.studentId].push(g);
    });

    // 1. Filter students by Class and Standing
    const validStudentIds = new Set();
    Object.entries(studentAvgs).forEach(([sid, grades]) => {
        const student = studentMap[sid];
        if (!student) return;

        if (fClass && student.className !== fClass) return;
        
        if (fStanding) {
            if (grades.length > 0) {
                // UPDATED: Using Teacher-Specific Grade Types
                const avg = calculateWeightedAverage(grades, getGradeTypes());
                if (avg !== null) {
                    let std = 'none';
                    if (avg >= 90) std = 'excelling';
                    else if (avg >= 80) std = 'good';
                    else if (avg >= 70) std = 'ontrack';
                    else if (avg >= 65) std = 'needsattention';
                    else std = 'atrisk';

                    if (std !== fStanding) return;
                } else return;
            } else {
                return; 
            }
        }
        
        validStudentIds.add(sid);
    });

    // 2. Filter the grades array
    sg = sg.filter(g => validStudentIds.has(g.studentId));
    if (fStudent) sg = sg.filter(g => g.studentId === fStudent);
    if (fType) sg = sg.filter(g => g.type === fType);
    if (fTitle) sg = sg.filter(g => (g.title || '').toLowerCase().includes(fTitle));

    // 3. Re-calculate filtered student data for the breakdown table
    const stuIds = [...new Set(sg.map(g => g.studentId))];
    const stuData = stuIds.map(sid => {
        const sg2 = sg.filter(g => g.studentId === sid);
        // UPDATED: Using Teacher-Specific Grade Types
        const avg = calculateWeightedAverage(sg2, getGradeTypes()) || 0;
        return { 
            sid, 
            name: studentMap[sid]?.name || 'Unknown', 
            className: studentMap[sid]?.className || '—',
            avg: avg, 
            count: sg2.length 
        };
    }).sort((a, b) => a.avg - b.avg);

    return { sg, stuData, stuIds };
}

window.renderSubjectPanelData = function() {
    if (currentPanelTab !== 'performance') return; // guard: only render when Performance tab is active
    const { sg, stuData, stuIds } = getFilteredSubjectData();
    
    const dist = { a: 0, b: 0, c: 0, d: 0, f: 0 };
    stuData.forEach(s => {
        if (s.avg >= 90) dist.a++; else if (s.avg >= 80) dist.b++; else if (s.avg >= 70) dist.c++; else if (s.avg >= 65) dist.d++; else dist.f++;
    });
    
    const total = stuData.length || 1;
    const classAvg = stuData.length ? Math.round(stuData.reduce((a, s) => a + s.avg, 0) / stuData.length) : null;
    const atRiskStudents = stuData.filter(s => s.avg < 65);
    
    const semName = document.getElementById('activeSemester').options[document.getElementById('activeSemester').selectedIndex]?.text || '';
    document.getElementById('spPanelMeta').textContent = `${semName} · ${stuIds.length} students`;
    
    gradeDetailCache = {};
    sg.forEach(g => { gradeDetailCache[g.id] = g; });
    
    document.getElementById('subjectPanelBody').innerHTML = `
        <div class="grid grid-cols-3 gap-3">
            <div class="bg-white border border-slate-200 rounded-2xl p-4 text-center shadow-sm">
                <p class="text-xs font-black text-slate-400 uppercase tracking-wider mb-1">Avg</p>
                <p class="text-3xl font-black ${classAvg !== null ? gradeColorClass(classAvg) : 'text-slate-400'}">${classAvg !== null ? classAvg + '%' : '—'}</p>
            </div>
            <div class="bg-white border border-slate-200 rounded-2xl p-4 text-center shadow-sm">
                <p class="text-xs font-black text-slate-400 uppercase tracking-wider mb-1">Students</p>
                <p class="text-3xl font-black text-teal-600">${stuIds.length}</p>
            </div>
            <div class="bg-white border border-slate-200 rounded-2xl p-4 text-center shadow-sm">
                <p class="text-xs font-black text-slate-400 uppercase tracking-wider mb-1">At Risk</p>
                <p class="text-3xl font-black ${atRiskStudents.length ? 'text-red-600' : 'text-emerald-600'}">${atRiskStudents.length}</p>
            </div>
        </div>
        
        <div class="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
            <h4 class="text-xs font-black text-slate-500 uppercase tracking-wider mb-3">Grade Distribution</h4>
            <div class="dist-bar">
                ${dist.a ? `<div class="dist-seg bg-emerald-500" style="width:${dist.a / total * 100}%">A:${dist.a}</div>` : ''}
                ${dist.b ? `<div class="dist-seg bg-blue-500" style="width:${dist.b / total * 100}%">B:${dist.b}</div>` : ''}
                ${dist.c ? `<div class="dist-seg bg-teal-500" style="width:${dist.c / total * 100}%">C:${dist.c}</div>` : ''}
                ${dist.d ? `<div class="dist-seg bg-amber-500" style="width:${dist.d / total * 100}%">D:${dist.d}</div>` : ''}
                ${dist.f ? `<div class="dist-seg bg-red-500" style="width:${dist.f / total * 100}%">F:${dist.f}</div>` : ''}
                ${!stuData.length ? `<div class="dist-seg bg-slate-300" style="width:100%">No Data</div>` : ''}
            </div>
            <div class="flex gap-4 mt-3 flex-wrap">
                ${[['A', dist.a, 'bg-emerald-500'], ['B', dist.b, 'bg-blue-500'], ['C', dist.c, 'bg-teal-500'], ['D', dist.d, 'bg-amber-500'], ['F', dist.f, 'bg-red-500']].map(([l, n, c]) => `
                <div class="flex items-center gap-1.5">
                    <div class="w-3 h-3 rounded-sm ${c}"></div><span class="text-xs font-black text-slate-600">${l}: ${n}</span>
                </div>`).join('')}
            </div>
        </div>
        
        ${atRiskStudents.length ? `
        <div class="bg-red-50 border border-red-200 rounded-2xl p-5">
            <h4 class="font-black text-red-700 text-sm uppercase tracking-wider mb-3 flex items-center gap-2"><i class="fa-solid fa-triangle-exclamation"></i> Needs Attention</h4>
            <div class="space-y-2">
                ${atRiskStudents.map(s => `
                <div class="flex items-center justify-between bg-white border border-red-100 rounded-xl p-3">
                    <span class="font-black text-slate-700 text-sm">${s.name} <span class="text-xs text-slate-400 ml-1">(${s.className})</span></span>
                    <span class="font-black text-red-600">${s.avg}%</span>
                </div>`).join('')}
            </div>
        </div>` : ''}
        
        <div class="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
            <div class="px-5 py-4 border-b border-slate-100 bg-slate-50"><h4 class="font-black text-slate-700 text-sm uppercase tracking-wider">Student Breakdown</h4></div>
            <div class="overflow-x-auto">
                <table class="w-full text-sm">
                    <thead class="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider border-b border-slate-200">
                        <tr>
                            <th class="px-4 py-3 font-black text-left">Student</th>
                            <th class="px-4 py-3 font-black text-left">Class</th>
                            <th class="px-4 py-3 font-black text-center">Average</th>
                            <th class="px-4 py-3 font-black text-center">Standing</th>
                            <th class="px-4 py-3 font-black text-center">Assignments</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${stuData.length ? stuData.reverse().map(s => `
                        <tr class="gb-row">
                            <td class="px-4 py-3">
                                <div class="flex items-center gap-2">
                                    <div class="h-8 w-8 bg-gradient-to-br from-emerald-400 to-teal-500 text-white rounded-lg flex items-center justify-center font-black text-xs flex-shrink-0">${s.name.charAt(0)}</div>
                                    <span class="font-black text-slate-700 text-sm">${s.name}</span>
                                </div>
                            </td>
                            <td class="px-4 py-3 text-slate-500 font-bold text-xs">${s.className}</td>
                            <td class="px-4 py-3 text-center"><span class="${gradeColorClass(s.avg)} font-black">${s.avg}% · ${letterGrade(s.avg)}</span></td>
                            <td class="px-4 py-3 text-center">${standingBadge(s.avg)}</td>
                            <td class="px-4 py-3 text-center text-slate-500 font-semibold text-sm">${s.count}</td>
                        </tr>`).join('') : '<tr><td colspan="5" class="px-4 py-8 text-center text-slate-400 italic">No students match filter.</td></tr>'}
                    </tbody>
                </table>
            </div>
        </div>
        
        <div class="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
            <div class="px-5 py-4 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
                <h4 class="font-black text-slate-700 text-sm uppercase tracking-wider">Filtered Assignments</h4>
                <span class="text-xs text-slate-400 font-bold">${sg.length} record${sg.length !== 1 ? 's' : ''}</span>
            </div>
            <div class="overflow-x-auto">
                <table class="w-full text-sm">
                    <thead class="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider border-b border-slate-200">
                        <tr>
                            <th class="px-4 py-3 font-black text-left">Title</th>
                            <th class="px-4 py-3 font-black text-left">Type</th>
                            <th class="px-4 py-3 font-black text-left">Student</th>
                            <th class="px-4 py-3 font-black text-center">Score</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${sg.length ? sg.sort((a, b) => (b.date || '').localeCompare(a.date || '')).map(g => {
                            const pct = g.max ? Math.round(g.score / g.max * 100) : null;
                            return `
                            <tr class="gb-row cursor-pointer" onclick="openAssignmentModal('${g.id}')">
                                <td class="px-4 py-3">
                                    <p class="font-bold text-slate-700 text-sm hover:text-teal-600">${g.title || '—'}</p>
                                    <p class="text-xs text-slate-400">${g.date || ''}</p>
                                </td>
                                <td class="px-4 py-3"><span class="text-[10px] font-black uppercase bg-slate-100 text-slate-500 border border-slate-200 px-2 py-1 rounded-md">${g.type || '—'}</span></td>
                                <td class="px-4 py-3 text-sm font-bold text-slate-700">${studentMap[g.studentId]?.name || '—'}</td>
                                <td class="px-4 py-3 text-center"><span class="${gradeColorClass(pct || 0)} font-black text-sm">${pct !== null ? pct + '%' : '—'}</span></td>
                            </tr>`;
                        }).join('') : '<tr><td colspan="4" class="px-4 py-8 text-center text-slate-400 italic">No assignments match filter.</td></tr>'}
                    </tbody>
                </table>
            </div>
        </div>`;
};

// ── 5b. ASSIGNMENTS TAB (PREDEFINED TEMPLATES) ──────────────────────────────
window.renderAssignmentsTab = function() {
    if (currentPanelTab !== 'assignments') return;
    const assignments = getAssignmentsForSubject(currentSubjectName);

    const semName = document.getElementById('activeSemester').options[document.getElementById('activeSemester').selectedIndex]?.text || '';
    document.getElementById('spPanelMeta').textContent = `${semName} · ${assignments.length} prepared task${assignments.length !== 1 ? 's' : ''}`;

    // PHASE 1 MILESTONE 3: the same composer doubles as the edit form — when
    // editingAssignmentId is set, fields are pre-filled from that assignment
    // and the Save button commits an update instead of creating a new one.
    // Computed before typeOptions below so the Type <select> can mark the
    // right <option> selected (a plain value="" attribute has no effect on
    // <select> — only a matching <option selected> does).
    const isEditingAssignment = !!editingAssignmentId;
    const editingAssignment = isEditingAssignment ? assignments.find(a => a.id === editingAssignmentId) : null;
    if (isEditingAssignment && !editingAssignment) editingAssignmentId = null; // vanished (e.g. deleted elsewhere) — fall back to add mode

    const typeOptions = getGradeTypes().map(t => {
        const v = t.name || t;
        const isSelected = editingAssignment && editingAssignment.type === v;
        return `<option value="${escHtml(v)}" ${isSelected ? 'selected' : ''}>${escHtml(v)}</option>`;
    }).join('');

    const lockedNotice = isSemesterLocked
        ? `<div class="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-center gap-3 mb-5">
               <i class="fa-solid fa-lock text-amber-500 text-lg"></i>
               <p class="text-sm font-bold text-amber-700">This period is locked. You can still prepare assignments, but grading is read-only until an admin unlocks it.</p>
           </div>`
        : '';

    const formCard = `
        <div class="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm mb-5">
            <div class="flex items-center justify-between mb-4">
                <h4 class="text-xs font-black text-slate-500 uppercase tracking-wider flex items-center gap-2">
                    <i class="fa-solid ${editingAssignment ? 'fa-pen' : 'fa-circle-plus'} text-teal-500"></i>
                    ${editingAssignment ? 'Edit assignment' : 'Prepare a new assignment'}
                </h4>
                ${editingAssignment ? `<button type="button" onclick="cancelEditAssignment()" class="text-[11px] font-black text-slate-400 hover:text-slate-600 flex items-center gap-1"><i class="fa-solid fa-xmark"></i> Cancel</button>` : ''}
            </div>

            <!-- Title -->
            <div class="mb-3">
                <label class="block text-[11px] font-black text-slate-500 uppercase tracking-wider mb-1.5">Title <span class="text-red-500">*</span></label>
                <input type="text" id="asgTitle" placeholder="e.g. Chapter 5 Quiz" class="form-input w-full p-2.5 bg-white border border-slate-200 rounded-xl text-sm" value="${escHtml(editingAssignment?.title || '')}">
            </div>

            <!-- Type / Points / Due Date row -->
            <div class="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-3">
                <div>
                    <label class="block text-[11px] font-black text-slate-500 uppercase tracking-wider mb-1.5">Type <span class="text-red-500">*</span></label>
                    <select id="asgType" class="form-input w-full p-2.5 bg-white border border-slate-200 rounded-xl text-sm cursor-pointer">
                        <option value="">Select type…</option>
                        ${typeOptions}
                    </select>
                </div>
                <div>
                    <label class="block text-[11px] font-black text-slate-500 uppercase tracking-wider mb-1.5">Points possible <span class="text-red-500">*</span></label>
                    <input type="number" id="asgMax" min="1" step="1" placeholder="e.g. 50" class="form-input w-full p-2.5 bg-white border border-slate-200 rounded-xl text-sm" value="${editingAssignment?.maxScore ?? ''}">
                </div>
                <div class="col-span-2 sm:col-span-1">
                    <label class="block text-[11px] font-black text-slate-500 uppercase tracking-wider mb-1.5">Due Date <span class="normal-case font-semibold text-slate-400">(optional)</span></label>
                    <input type="date" id="asgDate" class="form-input w-full p-2.5 bg-white border border-slate-200 rounded-xl text-sm cursor-pointer" value="${escHtml(editingAssignment?.date || '')}">
                </div>
            </div>

            <!-- Instructions (student-facing) -->
            <div class="mb-3">
                <label class="block text-[11px] font-black text-slate-500 uppercase tracking-wider mb-1.5">Instructions <span class="normal-case font-semibold text-slate-400">(optional — visible to students)</span></label>
                <textarea id="asgInstructions" placeholder="What students should do, submit, or study for this assignment."
                    class="form-input w-full p-3 bg-white border border-slate-200 rounded-xl text-sm resize-none leading-relaxed"
                    style="height: 5rem;">${escHtml(editingAssignment?.instructions || '')}</textarea>
            </div>

            <!-- Description (big, expandable — private teacher notes, never shown to students) -->
            <div class="mb-4">
                <div class="flex items-center justify-between mb-1.5">
                    <label class="block text-[11px] font-black text-slate-500 uppercase tracking-wider">Description <span class="normal-case font-semibold text-slate-400">(optional — private notes, not shown to students)</span></label>
                    <button type="button" id="asgDescExpandBtn" onclick="toggleDescExpand()" title="Expand description"
                        class="flex items-center gap-1 text-[11px] font-black text-teal-600 hover:text-teal-700 bg-teal-50 hover:bg-teal-100 border border-teal-200 px-2 py-1 rounded-lg transition">
                        <i id="asgDescExpandIcon" class="fa-solid fa-down-left-and-up-right-to-center fa-rotate-90 text-[10px]"></i>
                        <span id="asgDescExpandLabel">Expand</span>
                    </button>
                </div>
                <textarea id="asgDesc" placeholder="Notes, instructions, topics covered, or a link to a Google Form — anything you want on record for this assignment."
                    class="form-input w-full p-3 bg-white border border-slate-200 rounded-xl text-sm resize-none transition-all duration-200 leading-relaxed"
                    style="height: 7rem;">${escHtml(editingAssignment?.description || '')}</textarea>
            </div>

            <!-- Locked -->
            <label class="flex items-center gap-2.5 mb-4 cursor-pointer select-none">
                <input type="checkbox" id="asgLocked" class="w-4 h-4 rounded accent-teal-600 cursor-pointer" ${editingAssignment?.locked ? 'checked' : ''}>
                <span class="text-[12.5px] font-bold text-slate-600">Locked <span class="font-normal text-slate-400">— marks this assignment as finalized. Informational only; does not restrict editing or grading.</span></span>
            </label>

            <button onclick="saveAssignment()" id="asgSaveBtn" class="w-full bg-gradient-to-r from-teal-600 to-teal-700 hover:from-teal-700 hover:to-teal-800 text-white font-black py-3 rounded-xl transition shadow-md text-sm flex items-center justify-center gap-2">
                <i class="fa-solid ${editingAssignment ? 'fa-check' : 'fa-plus'}"></i> ${editingAssignment ? 'Save changes' : `Add to ${escHtml(currentSubjectName)}`}
            </button>
            <p id="asgMsg" class="text-sm hidden font-bold p-2.5 mt-2 rounded-xl text-center"></p>
        </div>`;

    // Split into active (still grading) and graded (marked complete)
    const sorted = assignments.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    const activeList = sorted.filter(a => !a.completed);
    const gradedList = sorted.filter(a => a.completed);

    // Row renderer — `graded` controls the muted styling and which action button shows
    const renderRow = (a, graded) => `
        <div class="px-5 py-3.5 flex items-center justify-between gap-3 hover:bg-slate-50 transition ${graded ? 'opacity-70' : ''}">
            <div class="min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                    ${graded ? '<i class="fa-solid fa-circle-check text-emerald-500 text-sm flex-shrink-0"></i>' : ''}
                    <p class="font-black text-slate-700 text-sm truncate ${graded ? 'line-through decoration-slate-300' : ''}">${escHtml(a.title)}</p>
                    <span class="text-[10px] font-black uppercase bg-teal-50 text-teal-600 border border-teal-200 px-2 py-0.5 rounded-md">${escHtml(a.type)}</span>
                    <span class="text-[10px] font-black text-slate-500 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded-md">/ ${a.maxScore}</span>
                    ${a.locked ? `<span class="text-[10px] font-black uppercase bg-amber-50 text-amber-600 border border-amber-200 px-2 py-0.5 rounded-md flex items-center gap-1"><i class="fa-solid fa-lock text-[9px]"></i>Locked</span>` : ''}
                </div>
                ${a.instructions ? `<p class="text-xs text-slate-500 font-semibold mt-0.5 truncate"><span class="text-slate-400 font-black">Instructions:</span> ${escHtml(a.instructions)}</p>` : ''}
                ${a.description ? `<p class="text-xs text-slate-400 font-semibold mt-0.5 truncate">${escHtml(a.description)}</p>` : ''}
                ${a.date ? `<p class="text-[11px] text-slate-400 font-bold mt-0.5"><i class="fa-regular fa-calendar mr-1"></i>Due ${escHtml(a.date)}</p>` : ''}
            </div>
            <div class="flex items-center gap-1.5 flex-shrink-0">
                <button onclick="openReviewSubmissions('${a.id}')" title="Review submissions and grade inline"
                    class="flex items-center gap-1 text-[11px] font-black text-teal-700 hover:text-white bg-teal-50 hover:bg-teal-600 border border-teal-200 hover:border-teal-600 px-2.5 py-1.5 rounded-lg transition">
                    <i class="fa-solid fa-inbox text-[10px]"></i> Review
                </button>
                <button onclick="editAssignment('${a.id}')" title="Edit assignment"
                    class="flex items-center gap-1 text-[11px] font-black text-slate-500 hover:text-teal-700 bg-slate-100 hover:bg-teal-50 border border-slate-200 hover:border-teal-200 px-2.5 py-1.5 rounded-lg transition">
                    <i class="fa-solid fa-pen text-[10px]"></i> Edit
                </button>
                ${graded
                    ? `<button onclick="toggleAssignmentComplete('${a.id}')" title="Reopen for grading"
                           class="flex items-center gap-1 text-[11px] font-black text-slate-500 hover:text-teal-700 bg-slate-100 hover:bg-teal-50 border border-slate-200 hover:border-teal-200 px-2.5 py-1.5 rounded-lg transition">
                           <i class="fa-solid fa-rotate-left text-[10px]"></i> Reopen
                       </button>`
                    : `<button onclick="toggleAssignmentComplete('${a.id}')" title="Mark as graded — hides it from the grade form"
                           class="flex items-center gap-1 text-[11px] font-black text-emerald-700 hover:text-white bg-emerald-50 hover:bg-emerald-600 border border-emerald-200 hover:border-emerald-600 px-2.5 py-1.5 rounded-lg transition">
                           <i class="fa-solid fa-check text-[10px]"></i> Mark graded
                       </button>`}
                <button onclick="toggleAssignmentLocked('${a.id}')" title="${a.locked ? 'Unlock assignment' : 'Lock assignment'}"
                    class="text-slate-300 hover:text-amber-500 h-8 w-8 rounded-lg flex items-center justify-center hover:bg-amber-50 transition ${a.locked ? 'text-amber-500' : ''}">
                    <i class="fa-solid ${a.locked ? 'fa-lock' : 'fa-lock-open'} text-sm"></i>
                </button>
                <button onclick="deleteAssignment('${a.id}')" title="Remove assignment"
                    class="text-slate-300 hover:text-red-500 h-8 w-8 rounded-lg flex items-center justify-center hover:bg-red-50 transition">
                    <i class="fa-solid fa-trash-can text-sm"></i>
                </button>
            </div>
        </div>`;

    const activeCard = activeList.length
        ? `<div class="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm mb-5">
               <div class="px-5 py-4 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
                   <h4 class="font-black text-slate-700 text-sm uppercase tracking-wider"><i class="fa-solid fa-list-check text-teal-500 mr-1.5"></i> Active assignments</h4>
                   <span class="text-xs text-slate-400 font-bold">${activeList.length} shown in grade form</span>
               </div>
               <div class="divide-y divide-slate-100">
                   ${activeList.map(a => renderRow(a, false)).join('')}
               </div>
           </div>`
        : (assignments.length
            ? `<div class="bg-white border border-slate-200 rounded-2xl p-6 text-center shadow-sm mb-5">
                   <p class="text-sm font-black text-slate-600 mb-0.5">All assignments graded</p>
                   <p class="text-xs text-slate-400 font-semibold">Nothing is waiting in the grade form for this subject. Add a new one above or reopen a graded one below.</p>
               </div>`
            : '');

    const gradedCard = gradedList.length
        ? `<div class="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
               <div class="px-5 py-4 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
                   <h4 class="font-black text-slate-500 text-sm uppercase tracking-wider"><i class="fa-solid fa-circle-check text-emerald-500 mr-1.5"></i> Graded</h4>
                   <span class="text-xs text-slate-400 font-bold">${gradedList.length} hidden from grade form</span>
               </div>
               <div class="divide-y divide-slate-100">
                   ${gradedList.map(a => renderRow(a, true)).join('')}
               </div>
           </div>`
        : '';

    const emptyState = !assignments.length
        ? `<div class="bg-white border-2 border-dashed border-slate-200 rounded-2xl py-14 px-6 text-center">
               <div class="w-12 h-12 mx-auto mb-4 bg-teal-50 text-teal-500 rounded-xl flex items-center justify-center text-xl"><i class="fa-solid fa-clipboard-list"></i></div>
               <p class="font-black text-slate-600 text-sm mb-1">No prepared assignments</p>
               <p class="text-xs text-slate-400 font-semibold max-w-xs mx-auto">Add a quiz or test above. It'll appear in the grade form so you can grade students without retyping the title or points.</p>
           </div>`
        : '';

    const listCard = emptyState + activeCard + gradedCard;

    document.getElementById('subjectPanelBody').innerHTML = lockedNotice + formCard + listCard;
};

// NEW: inline expand/collapse for the description textarea (grows in place, no popup)
window.toggleDescExpand = function() {
    const ta = document.getElementById('asgDesc');
    const icon = document.getElementById('asgDescExpandIcon');
    const label = document.getElementById('asgDescExpandLabel');
    if (!ta) return;
    const expanded = ta.dataset.expanded === 'true';
    if (expanded) {
        ta.style.height = '7rem';
        ta.dataset.expanded = 'false';
        if (icon) icon.className = 'fa-solid fa-down-left-and-up-right-to-center fa-rotate-90 text-[10px]';
        if (label) label.textContent = 'Expand';
    } else {
        ta.style.height = '20rem';
        ta.dataset.expanded = 'true';
        if (icon) icon.className = 'fa-solid fa-up-right-and-down-left-from-center fa-rotate-90 text-[10px]';
        if (label) label.textContent = 'Collapse';
        ta.focus();
    }
};

// PHASE 1 MILESTONE 3: entry point for the composer's Save button in both
// modes. editingAssignmentId === null means "create"; otherwise this updates
// that existing assignment in place, preserving its id/createdAt/completed.
window.saveAssignment = async function() {
    const title = document.getElementById('asgTitle').value.trim();
    const type = document.getElementById('asgType').value;
    const maxRaw = document.getElementById('asgMax').value;
    const date = document.getElementById('asgDate').value || '';
    const instructions = document.getElementById('asgInstructions').value.trim();
    const desc = document.getElementById('asgDesc').value.trim();
    const locked = document.getElementById('asgLocked').checked;
    const max = parseInt(maxRaw, 10);

    if (!title) { showMsg('asgMsg', 'Title is required.', true); return; }
    if (!type) { showMsg('asgMsg', 'Please choose a type.', true); return; }
    if (isNaN(max) || max < 1) { showMsg('asgMsg', 'Max score must be a whole number of at least 1.', true); return; }

    const sub = getSubjectByName(currentSubjectName);
    if (!sub) { showMsg('asgMsg', 'Subject not found. Please refresh.', true); return; }

    const btn = document.getElementById('asgSaveBtn');
    const prevHtml = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';
    btn.disabled = true;

    const editingId = editingAssignmentId;

    try {
        const existing = getAssignmentsForSubject(currentSubjectName);
        // Prevent duplicate titles within the same subject (case-insensitive),
        // excluding the assignment currently being edited against itself.
        if (existing.some(a => a.id !== editingId && (a.title || '').toLowerCase() === title.toLowerCase())) {
            throw new Error('DUPLICATE');
        }

        const now = new Date().toISOString();
        let savedAssignment;

        if (editingId) {
            const current = existing.find(a => a.id === editingId);
            if (!current) throw new Error('NOT_FOUND');
            const wasLocked = !!current.locked;
            const patch = {
                title, type,
                maxScore: max,
                description: desc,
                instructions,
                date,
                locked,
                lockedAt: locked ? (wasLocked ? (current.lockedAt || now) : now) : null,
                updatedAt: now
            };
            savedAssignment = { ...current, ...patch };

            if (sub._source === 'new') {
                await updateDoc(doc(db, 'schools', session.schoolId, 'classes', sub.classId, 'subjects', sub.id, 'assignments', editingId), patch);
                sub.assignments = (sub.assignments || []).map(a => a.id === editingId ? savedAssignment : a);
            } else {
                const subjects = (session.teacherData.subjects || []).map(s => {
                    if (s.id !== sub.id) return s;
                    return { ...s, assignments: existing.map(a => a.id === editingId ? savedAssignment : a) };
                });
                await updateDoc(getTeacherDocRef(session.schoolId, session.teacherId), { subjects });
                session.teacherData.subjects = subjects;
                setSessionData('teacher', session);
                sub.assignments = subjects.find(s => s.id === sub.id)?.assignments || [];
            }
        } else {
            savedAssignment = {
                id: genAssignmentId(),
                title, type,
                maxScore: max,
                description: desc,
                instructions,
                date,
                locked,
                lockedAt: locked ? now : null,
                completed: false,
                createdAt: now,
                updatedAt: now
            };

            if (sub._source === 'new') {
                // PHASE 0: assignments are their own documents under the subject
                await setDoc(doc(db, 'schools', session.schoolId, 'classes', sub.classId, 'subjects', sub.id, 'assignments', savedAssignment.id), savedAssignment);
                sub.assignments = [...(sub.assignments || []), savedAssignment];
            } else {
                // Legacy path, unchanged: rewrite the whole embedded subjects array
                const subjects = (session.teacherData.subjects || []).map(s => {
                    if (s.id !== sub.id) return s;
                    return { ...s, assignments: [...existing, savedAssignment] };
                });
                await updateDoc(getTeacherDocRef(session.schoolId, session.teacherId), { subjects });
                session.teacherData.subjects = subjects;
                setSessionData('teacher', session);
                sub.assignments = [...existing, savedAssignment];
            }
        }

        editingAssignmentId = null;
        updateAssignmentTabBadge();
        renderAssignmentsTab(); // re-render with the cleared form + new/updated row
    } catch (e) {
        if (e.message === 'DUPLICATE') {
            showMsg('asgMsg', 'An assignment with that title already exists for this subject.', true);
        } else if (e.message === 'NOT_FOUND') {
            showMsg('asgMsg', 'This assignment no longer exists. Please refresh.', true);
        } else {
            console.error('[Subjects] saveAssignment:', e);
            showMsg('asgMsg', 'Could not save. Please try again.', true);
        }
        btn.innerHTML = prevHtml;
        btn.disabled = false;
    }
};

// PHASE 1 MILESTONE 3: switches the composer into edit mode for one
// assignment. The composer itself (in renderAssignmentsTab) reads
// editingAssignmentId to pre-fill its fields — this just sets that state,
// re-renders, and scrolls the composer into view.
window.editAssignment = function(assignmentId) {
    editingAssignmentId = assignmentId;
    renderAssignmentsTab();
    document.getElementById('asgTitle')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
};

window.cancelEditAssignment = function() {
    editingAssignmentId = null;
    renderAssignmentsTab();
};

window.toggleAssignmentComplete = async function(assignmentId) {
    const sub = getSubjectByName(currentSubjectName);
    if (!sub) return;

    try {
        if (sub._source === 'new') {
            const current = (sub.assignments || []).find(a => a.id === assignmentId);
            const newCompleted = !(current?.completed);
            await updateDoc(doc(db, 'schools', session.schoolId, 'classes', sub.classId, 'subjects', sub.id, 'assignments', assignmentId), { completed: newCompleted });
            sub.assignments = (sub.assignments || []).map(a => a.id === assignmentId ? { ...a, completed: newCompleted } : a);
        } else {
            const subjects = (session.teacherData.subjects || []).map(s => {
                if (s.id !== sub.id) return s;
                const existing = Array.isArray(s.assignments) ? s.assignments : [];
                return {
                    ...s,
                    assignments: existing.map(a =>
                        a.id === assignmentId ? { ...a, completed: !a.completed } : a
                    )
                };
            });
            await updateDoc(getTeacherDocRef(session.schoolId, session.teacherId), { subjects });
            session.teacherData.subjects = subjects;
            setSessionData('teacher', session);
            sub.assignments = subjects.find(s => s.id === sub.id)?.assignments || [];
        }

        updateAssignmentTabBadge();
        renderAssignmentsTab();
    } catch (e) {
        console.error('[Subjects] toggleAssignmentComplete:', e);
        alert('Could not update the assignment. Please try again.');
    }
};

// PHASE 1 MILESTONE 3: quick-action lock toggle, mirroring
// toggleAssignmentComplete's exact _source fork. Informational only — does
// not gate editing, deleting, or grading; grade_form.js just displays it.
window.toggleAssignmentLocked = async function(assignmentId) {
    const sub = getSubjectByName(currentSubjectName);
    if (!sub) return;

    const now = new Date().toISOString();

    try {
        if (sub._source === 'new') {
            const current = (sub.assignments || []).find(a => a.id === assignmentId);
            const newLocked = !(current?.locked);
            const patch = { locked: newLocked, lockedAt: newLocked ? now : null };
            await updateDoc(doc(db, 'schools', session.schoolId, 'classes', sub.classId, 'subjects', sub.id, 'assignments', assignmentId), patch);
            sub.assignments = (sub.assignments || []).map(a => a.id === assignmentId ? { ...a, ...patch } : a);
        } else {
            const subjects = (session.teacherData.subjects || []).map(s => {
                if (s.id !== sub.id) return s;
                const existing = Array.isArray(s.assignments) ? s.assignments : [];
                return {
                    ...s,
                    assignments: existing.map(a =>
                        a.id === assignmentId ? { ...a, locked: !a.locked, lockedAt: !a.locked ? now : null } : a
                    )
                };
            });
            await updateDoc(getTeacherDocRef(session.schoolId, session.teacherId), { subjects });
            session.teacherData.subjects = subjects;
            setSessionData('teacher', session);
            sub.assignments = subjects.find(s => s.id === sub.id)?.assignments || [];
        }

        renderAssignmentsTab();
    } catch (e) {
        console.error('[Subjects] toggleAssignmentLocked:', e);
        alert('Could not update the assignment. Please try again.');
    }
};

window.deleteAssignment = async function(assignmentId) {
    const sub = getSubjectByName(currentSubjectName);
    if (!sub) return;
    if (!confirm('Remove this prepared assignment? Grades already recorded with this title are not affected.')) return;

    try {
        if (sub._source === 'new') {
            await deleteDoc(doc(db, 'schools', session.schoolId, 'classes', sub.classId, 'subjects', sub.id, 'assignments', assignmentId));
            sub.assignments = (sub.assignments || []).filter(a => a.id !== assignmentId);
        } else {
            const subjects = (session.teacherData.subjects || []).map(s => {
                if (s.id !== sub.id) return s;
                const existing = Array.isArray(s.assignments) ? s.assignments : [];
                return { ...s, assignments: existing.filter(a => a.id !== assignmentId) };
            });
            await updateDoc(getTeacherDocRef(session.schoolId, session.teacherId), { subjects });
            session.teacherData.subjects = subjects;
            setSessionData('teacher', session);
            sub.assignments = subjects.find(s => s.id === sub.id)?.assignments || [];
        }

        updateAssignmentTabBadge();
        renderAssignmentsTab();
    } catch (e) {
        console.error('[Subjects] deleteAssignment:', e);
        alert('Could not remove the assignment. Please try again.');
    }
};

window.closeSubjectPanel = function() { closeOverlay('subjectPanel', 'subjectPanelInner', true); };

// ── PHASE 1 MILESTONE 5: REVIEW SUBMISSIONS (inline grading) ────────────────
// Slide-in panel, triggered per-assignment from the Assignments tab above.
// Approved design: stays inline — never bounces the teacher out to
// grade_form.js. Data fetching is exactly two reads: one getDocs on the
// assignment's own submissions subcollection (who has submitted), and one
// collectionGroup('grades') query filtered by assignmentId (who's graded,
// class-wide) — see firestore.indexes.json's fieldOverrides entry for the
// index this second read needs. Grading itself goes through utils.js's
// shared saveGrade() helper, so re-grading here follows the exact same
// no-duplicate-docs + historyLogs rule as grade_form.js.
window.openReviewSubmissions = async function(assignmentId) {
    const sub = getSubjectByName(currentSubjectName);
    const assignments = (sub && Array.isArray(sub.assignments)) ? sub.assignments : [];
    const assignment = assignments.find(a => a.id === assignmentId);
    if (!sub || !assignment) return;

    const context = resolvePostContext(sub, resolvedClasses);
    if (!context) {
        alert('Could not resolve this subject to a real class, so submissions can\'t be loaded. Try reopening the Subjects page.');
        return;
    }

    reviewAssignment = { ...assignment, ...context };
    reviewRoster = allStudentsCache.filter(s => s.className === context.className);
    reviewSubmissions = new Map();
    reviewGrades = new Map();

    document.getElementById('reviewTitle').textContent = assignment.title;
    document.getElementById('reviewMeta').textContent = `${context.subjectName} · ${context.className} · out of ${assignment.maxScore}`;
    document.getElementById('reviewBody').innerHTML = `<div class="flex justify-center py-16"><i class="fa-solid fa-circle-notch fa-spin text-3xl text-teal-500"></i></div>`;

    openOverlay('reviewSubmissionsModal', 'reviewSubmissionsModalInner', true);

    try {
        const [submissionsMap, gradesSnap] = await Promise.all([
            loadSubmissionsForAssignment(session.schoolId, reviewAssignment),
            getDocs(query(collectionGroup(db, 'grades'), where('assignmentId', '==', assignmentId)))
        ]);
        reviewSubmissions = submissionsMap;
        // Grade docs live at students/{studentId}/grades/{gradeId} and don't
        // store studentId on themselves — it's the doc's grandparent id.
        gradesSnap.docs.forEach(d => {
            const studentId = d.ref.parent.parent?.id;
            if (studentId) reviewGrades.set(studentId, { id: d.id, studentId, ...d.data() });
        });
    } catch (e) {
        console.error('[Subjects] openReviewSubmissions load failed:', e);
        document.getElementById('reviewBody').innerHTML = `<p class="text-sm font-bold text-red-600 text-center py-10">Could not load submissions. Please try again.</p>`;
        return;
    }

    renderReviewBody();
};

window.closeReviewSubmissions = function() { closeOverlay('reviewSubmissionsModal', 'reviewSubmissionsModalInner', true); };

function renderReviewBody() {
    const wrap = document.getElementById('reviewBody');
    if (!wrap || !reviewAssignment) return;

    if (!reviewRoster.length) {
        wrap.innerHTML = `<p class="text-sm font-bold text-slate-400 text-center py-10">No students on this class roster yet.</p>`;
        return;
    }

    const submittedCount = reviewRoster.filter(s => reviewSubmissions.has(s.id)).length;
    const gradedCount    = reviewRoster.filter(s => reviewGrades.has(s.id)).length;

    const summary = `
        <div class="flex items-center gap-4 text-xs font-black text-slate-500 mb-3">
            <span><i class="fa-solid fa-inbox text-teal-500 mr-1"></i>${submittedCount} of ${reviewRoster.length} submitted</span>
            <span><i class="fa-solid fa-circle-check text-emerald-500 mr-1"></i>${gradedCount} of ${reviewRoster.length} graded</span>
        </div>`;

    const lockedNotice = isSemesterLocked
        ? `<div class="bg-amber-50 border border-amber-200 rounded-2xl p-3 text-xs font-bold text-amber-700 flex items-center gap-2 mb-3"><i class="fa-solid fa-lock"></i> This period is locked. Grades are read-only.</div>`
        : '';

    const rows = reviewRoster.slice()
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
        .map(renderReviewRow).join('');

    wrap.innerHTML = summary + lockedNotice + `<div class="space-y-3">${rows}</div>`;
}

function renderReviewRow(s) {
    const submission = reviewSubmissions.get(s.id) || null;
    const grade = reviewGrades.get(s.id) || null;
    const hasHistory = grade && Array.isArray(grade.historyLogs) && grade.historyLogs.length > 0;

    const submissionBlock = submission
        ? `<div class="bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs text-slate-600 space-y-1.5">
               ${submission.responseText ? `<p class="whitespace-pre-wrap leading-relaxed">${escHtml(submission.responseText)}</p>` : ''}
               ${submission.linkUrl ? `<a href="${escHtml(submission.linkUrl)}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-teal-600 font-bold hover:underline break-all"><i class="fa-solid fa-link text-[10px] flex-shrink-0"></i> ${escHtml(submission.linkUrl)}</a>` : ''}
               ${!submission.responseText && !submission.linkUrl ? `<p class="italic text-slate-400">Submitted with no text or link.</p>` : ''}
               <p class="text-[10px] text-slate-400 font-bold pt-0.5">Submitted ${submission.submittedAt ? new Date(submission.submittedAt).toLocaleString() : '—'}</p>
           </div>`
        : `<p class="text-xs italic text-slate-400 font-semibold bg-slate-50 border border-dashed border-slate-200 rounded-xl p-3">Not submitted yet.</p>`;

    const historyBlock = hasHistory
        ? `<details class="mt-2">
               <summary class="text-[10px] font-black text-amber-600 cursor-pointer select-none">Regraded ${grade.historyLogs.length}× — view history</summary>
               <ul class="mt-1 space-y-0.5 pl-0.5">
                   ${grade.historyLogs.map(h => `<li class="text-[10px] text-slate-500 font-semibold">${new Date(h.timestamp).toLocaleString()}: ${h.oldScore} → ${h.newScore}</li>`).join('')}
               </ul>
           </details>`
        : '';

    return `
    <div class="bg-white border border-slate-200 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-start gap-4">
        <div class="sm:w-56 flex-shrink-0">
            <p class="font-black text-slate-700 text-sm">${escHtml(s.name)}</p>
            <p class="text-[11px] text-slate-400 font-bold mb-2 font-mono">${escHtml(s.id)}</p>
            ${submissionBlock}
        </div>
        <div class="flex-1 flex items-start gap-3 flex-wrap">
            <div>
                <label class="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1">Score</label>
                <div class="flex items-center gap-1.5">
                    <input type="number" id="revScore_${s.id}" min="0" max="${reviewAssignment.maxScore}" step="1"
                        value="${grade ? grade.score : ''}"
                        class="form-input w-20 p-2 bg-white border border-slate-200 rounded-lg text-sm text-center font-bold">
                    <span class="text-xs text-slate-400 font-bold">/ ${reviewAssignment.maxScore}</span>
                </div>
            </div>
            <div class="flex-1 min-w-[140px]">
                <label class="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1">Notes <span class="normal-case font-semibold text-slate-400">(optional)</span></label>
                <input type="text" id="revNotes_${s.id}" value="${escHtml(grade?.notes || '')}" placeholder="Feedback for this student"
                    class="form-input w-full p-2 bg-white border border-slate-200 rounded-lg text-sm">
            </div>
            <div class="flex flex-col items-stretch gap-1">
                <label class="block text-[10px] font-black text-transparent uppercase tracking-wider mb-1 select-none">·</label>
                <button id="revSaveBtn_${s.id}" onclick="saveInlineGrade('${s.id}')"
                    class="flex items-center gap-1.5 ${grade ? 'bg-slate-100 hover:bg-teal-50 text-slate-600 hover:text-teal-700 border-slate-200' : 'bg-teal-600 hover:bg-teal-700 text-white border-teal-600'} font-black px-3.5 py-2 rounded-lg text-xs border transition">
                    <i class="fa-solid ${grade ? 'fa-rotate' : 'fa-check'} text-[10px]"></i> ${grade ? 'Update' : 'Save'}
                </button>
            </div>
        </div>
        ${historyBlock}
    </div>`;
}

window.saveInlineGrade = async function(studentId) {
    if (!reviewAssignment) return;
    if (isSemesterLocked) { alert('This period is locked. Grades are read-only.'); return; }

    const scoreEl = document.getElementById(`revScore_${studentId}`);
    const notesEl = document.getElementById(`revNotes_${studentId}`);
    const btn      = document.getElementById(`revSaveBtn_${studentId}`);
    const max      = reviewAssignment.maxScore;
    const score    = scoreEl ? parseFloat(scoreEl.value) : NaN;

    if (isNaN(score) || score < 0 || score > max) {
        alert(`Please enter a valid score between 0 and ${max}.`);
        return;
    }

    const wasRegrade = reviewGrades.has(studentId);
    const originalBtnHtml = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-[10px]"></i>'; }

    try {
        const semId = document.getElementById('activeSemester')?.value || '';
        const fields = {
            schoolId:   session.schoolId,
            teacherId:  session.teacherId,
            semesterId: semId,
            className:  reviewAssignment.className,
            subject:    reviewAssignment.subjectName,
            type:       reviewAssignment.type,
            date:       reviewAssignment.date || new Date().toISOString().split('T')[0],
            title:      reviewAssignment.title,
            score,
            max,
            notes: notesEl ? notesEl.value.trim() : '',
        };

        const result = await saveGrade(studentId, reviewAssignment.id, fields);

        // Reflect the write locally without a re-fetch: on a create, start a
        // fresh historyLogs; on an update, carry forward + append, mirroring
        // exactly what saveGrade() itself just did server-side.
        const priorHistory = wasRegrade ? (reviewGrades.get(studentId)?.historyLogs || []) : [];
        const historyLogs = wasRegrade
            ? [...priorHistory, { timestamp: new Date().toISOString(), oldScore: reviewGrades.get(studentId)?.score, newScore: score }]
            : [];
        reviewGrades.set(studentId, { id: result.id, studentId, ...fields, assignmentId: reviewAssignment.id, historyLogs });

        renderReviewBody();
    } catch (e) {
        console.error('[Subjects] saveInlineGrade:', e);
        alert('Could not save this grade. Please try again.');
        if (btn) { btn.disabled = false; btn.innerHTML = originalBtnHtml; }
    }
};

// ── 6. ASSIGNMENT DETAIL MODAL ──────────────────────────────────────────────
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

// ── 7. ADD SUBJECT (From Subjects Page) ─────────────────────────────────────
window.openSubjectFormModal = function() {
    document.getElementById('subjectFormName').value = '';
    document.getElementById('subjectFormDesc').value = '';
    document.getElementById('subjectFormMsg').classList.add('hidden');

    // PHASE 0: every new subject is created class-scoped, so the teacher
    // picks which of their (resolved) classes it belongs to.
    const classSel = document.getElementById('subjectFormClass');
    if (classSel) {
        if (resolvedClasses.length) {
            classSel.innerHTML = resolvedClasses.map(c => `<option value="${c.id}">${escHtml(c.name)}</option>`).join('');
            classSel.disabled = false;
        } else {
            classSel.innerHTML = `<option value="">No classes found for this school</option>`;
            classSel.disabled = true;
        }
    }

    openOverlay('subjectFormModal', 'subjectFormModalInner');
};
window.closeSubjectFormModal = function() { closeOverlay('subjectFormModal', 'subjectFormModalInner'); };

async function saveSubject() {
    const name = document.getElementById('subjectFormName').value.trim();
    const desc = document.getElementById('subjectFormDesc').value.trim();
    const classId = document.getElementById('subjectFormClass')?.value || '';

    if (!name) { showMsg('subjectFormMsg', 'Subject name is required.', true); return; }
    if (!classId) { showMsg('subjectFormMsg', 'Please choose a class.', true); return; }

    const btn = document.getElementById('saveSubjectFormBtn');
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;
    btn.disabled = true;

    try {
        // Checked against the full merged list (new-model + legacy) so a
        // teacher still can't create two subjects that show up with the
        // same visible name, even though the new model itself only
        // enforces uniqueness within one class.
        if (subjectsCache.some(s => s.name === name && !s.archived)) {
            showMsg('subjectFormMsg', 'Subject already exists.', true);
            btn.innerHTML = 'Save Subject'; btn.disabled = false;
            return;
        }

        const cls = resolvedClasses.find(c => c.id === classId);
        const newSubjectId = genId();
        const newSubjectData = {
            name,
            description: desc,
            schoolId: session.schoolId,
            classId,
            archived: false,
            archivedAt: null,
            createdAt: new Date().toISOString()
        };

        // PHASE 0: every new subject is created directly in the new
        // per-class collection — never the legacy embedded array.
        await setDoc(doc(db, 'schools', session.schoolId, 'classes', classId, 'subjects', newSubjectId), newSubjectData);
        subjectsCache.push({ id: newSubjectId, classId, className: cls?.name || '', _source: 'new', ...newSubjectData });

        closeSubjectFormModal();
        loadSubjectsTab(); // Reload table
    } catch (e) {
        console.error(e);
        showMsg('subjectFormMsg', 'Error saving subject.', true);
    }
    btn.innerHTML = 'Save Subject';
    btn.disabled = false;
}

// ── 7a. ARCHIVE SUBJECT (tile hover icon) ───────────────────────────────────
// Mirrors the dual-mode write archives.js's restoreSubject()/
// permanentDeleteSubject() already use — this is the missing other end of
// that flow: the only way a subject reaches the Archives page in the first
// place. Hides it from this page immediately (getActiveSubjects() filters
// on !archived) without touching its assignments or any grades already
// recorded against it.
window.archiveSubject = async function(subjectId, subjectName) {
    const sub = subjectsCache.find(s => s.id === subjectId && !s.archived);
    if (!sub) return;
    if (!confirm(`Archive "${subjectName}"? It'll be hidden from this page and moved to Archives, where you can restore it or delete it permanently.`)) return;

    try {
        const archivedAt = new Date().toISOString();
        if (sub._source === 'new') {
            await updateDoc(doc(db, 'schools', session.schoolId, 'classes', sub.classId, 'subjects', sub.id), { archived: true, archivedAt });
        } else {
            const subjects = (session.teacherData.subjects || []).map(s =>
                s.id === subjectId ? { ...s, archived: true, archivedAt } : s
            );
            await updateDoc(getTeacherDocRef(session.schoolId, session.teacherId), { subjects });
            session.teacherData.subjects = subjects;
            setSessionData('teacher', session);
        }
        sub.archived = true;
        sub.archivedAt = archivedAt;
        loadSubjectsTab();
    } catch (e) {
        console.error('[Subjects] archiveSubject:', e);
        alert('Could not archive the subject. Please try again.');
    }
};

// ── 8. PRINT REPORT (PROFESSIONAL TEMPLATE) ─────────────────────────────────
window.printSubjectReport = function() {
    const semName = document.getElementById('activeSemester').options[document.getElementById('activeSemester').selectedIndex]?.text || '';
    const schoolName = session.schoolName || session.schoolId;
    
    // Grab text representations of the current filters
    const classEl = document.getElementById('spFilterClass');
    const fClassText = classEl.options[classEl.selectedIndex]?.text || 'All Classes';
    
    const stuEl = document.getElementById('spFilterStudent');
    const fStudentText = stuEl.options[stuEl.selectedIndex]?.text || 'All Students';
    
    const stdEl = document.getElementById('spFilterStanding');
    const fStandingText = stdEl.options[stdEl.selectedIndex]?.text || 'All Standings';
    
    const typeEl = document.getElementById('spFilterType');
    const fTypeText = typeEl.options[typeEl.selectedIndex]?.text || 'All Types';
    
    const fTitleText = document.getElementById('spSearchTitle').value || 'None';

    // Retrieve the exact same filtered data that is currently on the screen
    const { sg } = getFilteredSubjectData();
    
    const unofficalBanner = `<div style="background:#e31b4a;color:white;text-align:center;font-weight:900;letter-spacing:0.3em;padding:6px;font-size:12px;margin-bottom:20px;width:100%;">*** UNOFFICIAL RECORD ***</div>`;
    
    // UPDATED: Branded Footer Disclaimer
    const printDisclaimer = `
    <div style='font-size:10px;color:#9ab0c6;margin-top:40px;text-align:center;border-top:1px solid #dce3ed;padding-top:14px;font-style:italic;'>
        <p style="margin:0 0 10px 0;">Generated by the ConnectUs Analytical Engine for ${escHtml(schoolName)}. This document does not constitute a certified administrative transcript unless signed and stamped by school administration.</p>
        <div style="display:flex; justify-content:center; align-items:center; gap:8px;">
            <img src="../../assets/images/logo.png" style="max-height:16px; object-fit:contain; opacity:0.8;">
            <span style="font-weight:bold; color:#0d1f35; font-style:normal;">Powered by ConnectUs</span>
        </div>
    </div>`;
    
    let html = `<html><head><title>Subject Report — ${escHtml(currentSubjectName)}</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap');
        
        /* Force browsers to print the precise colors and backgrounds */
        @media print {
            * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
            body { padding: 0; margin: 0; }
            @page { margin: 1.5cm; }
        }
        
        body { font-family: 'DM Sans', sans-serif; padding: 40px; color: #0d1f35; line-height: 1.5; background: white; }
        
        .header { display: flex; flex-direction: column; align-items: center; border-bottom: 2px solid #0d1f35; padding-bottom: 20px; margin-bottom: 24px; }
        .logo { max-height: 60px; max-width: 220px; object-fit: contain; margin-bottom: 12px; }
        
        .header .school-name { margin: 0 0 10px 0; font-size: 26px; color: #0d1f35; font-weight: 900; letter-spacing: 0.02em; text-align: center; }
        .header h1 { margin: 0 0 4px 0; font-size: 18px; color: #0d1f35; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 800; }
        .header h2 { margin: 0; font-size: 11px; color: #6b84a0; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; }
        
        .info-grid { background: #f8fafb; padding: 18px; border-radius: 4px; border: 1px solid #dce3ed; margin-bottom: 30px; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
        .info-grid div { font-size: 13px; color: #0d1f35; font-weight: 600; }
        .info-grid strong { font-size: 10px; color: #6b84a0; text-transform: uppercase; letter-spacing: 0.1em; display: block; margin-bottom: 2px; font-weight: 700; }
        
        table { width: 100%; border-collapse: collapse; }
        th, td { border-bottom: 1px solid #f0f4f8; padding: 10px 14px; text-align: left; font-size: 12px; }
        th { background: #f8fafb; color: #6b84a0; font-weight: 700; text-transform: uppercase; font-size: 10px; letter-spacing: 0.05em; border-bottom: 2px solid #dce3ed; }
        .tc { text-align: center; }
        .font-mono { font-family: 'DM Mono', monospace; font-weight: 700; }
    </style></head><body>
    
    ${unofficalBanner}
    
    <div class="header">
        <img src="${session.logo || ''}" alt="" class="logo" onerror="this.style.display='none'">
        <p class="school-name">${escHtml(schoolName)}</p>
        <h1>Subject Report: ${escHtml(currentSubjectName)}</h1>
        <h2>${escHtml(session.teacherData.name)} • ACADEMIC RECORD</h2>
    </div>
    
    <div class="info-grid">
        <div><strong>Academic Period</strong> ${escHtml(semName)}</div>
        <div><strong>Class Filter</strong> ${escHtml(fClassText)}</div>
        <div><strong>Student Filter</strong> ${escHtml(fStudentText)}</div>
        <div><strong>Standing Filter</strong> ${escHtml(fStandingText)}</div>
        <div><strong>Assignment Type</strong> ${escHtml(fTypeText)}</div>
        <div><strong>Assignment Search</strong> ${escHtml(fTitleText)}</div>
    </div>
    
    <table>
        <thead>
            <tr>
                <th style="width: 90px;">Date</th>
                <th>Assignment</th>
                <th class="tc">Type</th>
                <th>Student</th>
                <th>Class</th>
                <th class="tc">Score</th>
                <th class="tc">%</th>
            </tr>
        </thead>
        <tbody>`;
    
    if (!sg.length) {
        html += `<tr><td colspan="7" class="tc" style="padding:40px;font-style:italic;color:#6b84a0;">No records match the current filters.</td></tr>`;
    } else {
        sg.forEach(g => {
            const pct = g.max ? Math.round(g.score / g.max * 100) : null;
            const studentName = studentMap[g.studentId]?.name || 'Unknown';
            const className = studentMap[g.studentId]?.className || '—';
            
            html += `<tr>
                <td class="font-mono text-[#6b84a0]">${g.date || '—'}</td>
                <td>${escHtml(g.title)}</td>
                <td class="tc" style="color:#6b84a0; font-size:10px; text-transform:uppercase;">${escHtml(g.type)}</td>
                <td><strong>${escHtml(studentName)}</strong></td>
                <td style="color:#6b84a0; font-size:11px; font-weight:bold;">${escHtml(className)}</td>
                <td class="tc font-mono">${g.score}/${g.max}</td>
                <td class="tc font-mono">${pct !== null ? pct + '%' : '—'}</td>
            </tr>`;
        });
    }
    
    html += `</tbody></table>
    
    ${printDisclaimer}
    <br><br>${unofficalBanner}
    </body></html>`;
    
    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
    setTimeout(() => w.print(), 600);
};

// Fire it up
init();
