import { db, storage } from '../../assets/js/firebase-init.js';
import { collection, query, where, getDocs, getDoc, doc, updateDoc, setDoc, deleteDoc, collectionGroup, writeBatch, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { ref as storageRef, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";
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

    const lockedNotice = isSemesterLocked
        ? `<div class="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-center gap-3 mb-5">
               <i class="fa-solid fa-lock text-amber-500 text-lg"></i>
               <p class="text-sm font-bold text-amber-700">This period is locked. You can still prepare assignments, but grading is read-only until an admin unlocks it.</p>
           </div>`
        : '';

    // LIFT & SHIFT REFACTOR: the inline "Prepare a new assignment" composer
    // that used to render here (title/type/points/date/instructions/
    // description/locked fields + its own saveAssignment()) has been
    // retired entirely — replaced by the single "+ Create Assignment /
    // Assessment" button below, which opens the Universal Builder modal
    // (openAddWorkModal() in the ADD WORK / UNIVERSAL ASSIGNMENT BUILDER
    // section further down this file). That modal is now the only way to
    // create OR edit an assignment here; editAssignment() (see the Review/
    // actions section) opens it pre-filled instead of switching this tab
    // into an inline edit mode.
    const formCard = `
        <div class="mb-5">
            <button type="button" onclick="openAddWorkModal()"
                class="w-full bg-gradient-to-r from-teal-600 to-teal-700 hover:from-teal-700 hover:to-teal-800 text-white font-black py-3.5 rounded-2xl transition shadow-md text-sm flex items-center justify-center gap-2">
                <i class="fa-solid fa-circle-plus"></i> Create Assignment / Assessment
            </button>
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

// LIFT & SHIFT REFACTOR: editAssignment() used to switch this tab's own
// inline composer into edit mode. It now opens the Universal Builder modal
// pre-filled instead — see openAddWorkModal(assignmentId) in the ADD WORK /
// UNIVERSAL ASSIGNMENT BUILDER section below, which is the single place
// creation AND editing both happen now.
window.editAssignment = function(assignmentId) {
    openAddWorkModal(assignmentId);
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

// ═════════════  8. ADD WORK / UNIVERSAL ASSIGNMENT BUILDER  ═════════════
// LIFT & SHIFT REFACTOR: this engine used to live in teacher/grade_form/
// grade_form.js as the "Add Work" modal (Phases 3-4 built its Firestore
// persistence and legacy auto-grade shadow doc on top of it there, and it
// was create-only — nothing ever opened it in edit mode). It has moved here
// verbatim in its persistence logic, and generalized per the "one-size-
// fits-all" mandate: there is no more Assessment vs. Standard split — every
// work type gets Instructions + Description + Locked + Teacher Media
// Attachments, plus an always-available, optional (0-N question) builder.
// It now also REPLACES this file's own separate, older "Prepare a new
// assignment" inline composer (formerly saveAssignment()/
// renderAssignmentsTab()'s formCard), which wrote a simpler document shape
// (no category/questions/answer key) — this is now the ONLY way to create
// or edit an assignment in the Subjects hub, for both the plain and
// question-based cases, via openAddWorkModal() / openAddWorkModal(id).
//
// SCHEMA DECISION — read before touching field names: the assignment
// document shape written here is the PRE-EXISTING one every other reader in
// this file already depends on unnormalized — title/type/maxScore/date/
// instructions/description/locked/lockedAt/completed/createdAt/updatedAt —
// NOT the original Add Work engine's workType/pointsPossible/dueDate/status
// names (those never reached production data; the modal was never wired
// into a page teachers actually used before this refactor). Only
// `category`, `questions` (which functions/index.js's autoGradeWorkSubmission
// reads) and `attachments` carry over from the original Add Work payload.
// grade_form.js's own normalizer (`type: a.workType || a.type`, `maxScore:
// a.pointsPossible ?? a.maxScore`) still falls back correctly for any
// assignment that predates this change, so nothing existing breaks either
// way — this is simply the schema going forward.
//
// `category` is no longer derived from the work TYPE label (Test/Quiz vs.
// Assignment/Homework) — every type may now carry 0-N questions — so it's
// derived from whether the teacher actually added any: 'assessment' when at
// least one exists, 'standard' otherwise. That's exactly the condition
// autoGradeWorkSubmission and isAssessmentAssignment() (grade_form.js) both
// gate on, so auto-grading keeps working for a "Homework" with a multiple-
// choice question exactly as it would for a "Quiz" with one. There is no
// longer a separate "draft vs. posted" status — the old composer never had
// one either, and inventing a third hybrid state here would work against
// "without requiring a database migration script."
//
// Uploads (Phase 2.2) target schools/{schoolId}/attachments/{classId}/
// {subjectId}/{assignmentId}/{fileName} in Firebase Storage — a NEW rule
// added to storage.rules for this refactor (teacher/admin write, same-
// school read, 25MB cap). assignmentId is generated up front, when the
// modal opens (openAddWorkModal), rather than at Save time, specifically so
// an upload made mid-composition has a real, final path to land at —
// mirroring how uploadSubmissionAttachment (submissions.js) already uploads
// immediately on selection rather than deferring to final submit.
let awQuestions = [];
let awQuestionSeq = 0;
let awTaskAttachments = [];       // task-level "Teacher Media Attachments" — was awStandardAttachments in the original engine
let awEditingAssignmentId = null; // null = create mode; an id = editing that existing assignment
let awCurrentAssignmentId = null; // stable id for both create (generated on open) and edit (existing id)
let awFileUploadTarget = null;    // { scope: 'task'|'question', questionId } — which block #awFileInput is uploading into

const AW_QUESTION_TYPES = [
    { value: 'multiple_choice',    label: 'Multiple Choice' },
    { value: 'free_response',      label: 'Free Response' },
    { value: 'short_answer',       label: 'Short Answer' },
    { value: 'math',               label: 'Math / Equation' },
    { value: 'attachment_response', label: 'Attachment / Draw / Photo Response' }
];
const AW_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // mirrors storage.rules' cap on this path

function awMakeQuestion(type = 'multiple_choice') {
    const base = { id: `q_${++awQuestionSeq}`, type, prompt: '', points: 1, attachments: [] };
    // correctOptionIndex is the answer-key source for multiple_choice — it
    // never leaves this in-memory state as part of the clean question
    // object; awSaveWork lifts it out into the separate work_answer_keys
    // write. null until the teacher marks one (validated before save).
    if (type === 'multiple_choice') { base.options = ['', '']; base.correctOptionIndex = null; }
    if (type === 'free_response' || type === 'short_answer' || type === 'math') base.hint = '';
    if (type === 'attachment_response') base.responseType = 'File Upload';
    return base;
}

function awResetQuestionTypeFields(q, newType) {
    delete q.options; delete q.hint; delete q.responseType; delete q.correctOptionIndex;
    if (newType === 'multiple_choice') { q.options = ['', '']; q.correctOptionIndex = null; }
    if (newType === 'free_response' || newType === 'short_answer' || newType === 'math') q.hint = '';
    if (newType === 'attachment_response') q.responseType = 'File Upload';
    q.type = newType;
}

function awFindQuestion(id) {
    return awQuestions.find(q => q.id === id) || null;
}

window.openAddWorkModal = function(assignmentId) {
    const sub = getSubjectByName(currentSubjectName);
    const overlay = document.getElementById('addWorkModalOverlay');
    if (!sub || !overlay) return;

    const typeSel = document.getElementById('awType');
    const typeOptions = getGradeTypes().map(t => {
        const v = t.name || t;
        return `<option value="${escHtml(v)}">${escHtml(v)}</option>`;
    }).join('');
    if (typeSel) typeSel.innerHTML = '<option value="">Select type…</option>' + typeOptions;

    const existing = assignmentId ? getAssignmentsForSubject(currentSubjectName).find(a => a.id === assignmentId) : null;
    awEditingAssignmentId = existing ? existing.id : null;
    awCurrentAssignmentId = existing ? existing.id : genAssignmentId();

    document.getElementById('awModalTitle').textContent = existing ? 'Edit Assignment' : 'Add Work';
    document.getElementById('awModalSubtitle').textContent = existing
        ? `Editing "${existing.title}" in ${currentSubjectName}`
        : `Create a new assignment or assessment for ${currentSubjectName}`;
    document.getElementById('awSaveBtn').innerHTML = existing
        ? '<i class="fa-solid fa-check"></i> Save changes'
        : `<i class="fa-solid fa-plus"></i> Add to ${escHtml(currentSubjectName)}`;

    document.getElementById('awTitle').value = existing?.title || '';
    if (typeSel) typeSel.value = existing?.type || '';
    document.getElementById('awDueDate').value = existing?.date || '';
    document.getElementById('awPoints').value = existing ? (existing.maxScore ?? '') : '';
    document.getElementById('awInstructions').value = existing?.instructions || '';
    document.getElementById('awDescription').value = existing?.description || '';
    document.getElementById('awLocked').checked = !!(existing?.locked);

    awQuestionSeq = 0;
    // Existing multiple_choice answers can never be recovered here — the
    // answer key lives in work_answer_keys, which is permanently read-denied
    // to every client (firestore.rules) by design. Prompts/points/options/
    // attachments carry over; correctOptionIndex always comes back null, and
    // awValidate already requires re-marking it before save — awRemarkNotice
    // below just makes that visible up front instead of a surprise at Save.
    awQuestions = (existing?.questions || []).map(q => {
        const copy = { ...q, attachments: Array.isArray(q.attachments) ? [...q.attachments] : [] };
        const seqNum = parseInt(String(q.id).replace(/\D/g, ''), 10);
        if (!isNaN(seqNum)) awQuestionSeq = Math.max(awQuestionSeq, seqNum);
        if (copy.type === 'multiple_choice') copy.correctOptionIndex = null;
        return copy;
    });
    awTaskAttachments = Array.isArray(existing?.attachments) ? [...existing.attachments] : [];

    const remarkNotice = document.getElementById('awRemarkNotice');
    if (remarkNotice) remarkNotice.classList.toggle('hidden', !awQuestions.some(q => q.type === 'multiple_choice'));

    awClearBanners();
    awRenderTaskAttachments();
    awRenderBuilder();
    overlay.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
};

window.closeAddWorkModal = function() {
    const overlay = document.getElementById('addWorkModalOverlay');
    if (!overlay) return;
    overlay.classList.add('hidden');
    document.body.style.overflow = '';
};

// ── Task-level "Teacher Media Attachments" — its own small mount point so
// typing in Instructions/Description (plain static fields, read directly at
// save time like Title/Type/etc.) never gets touched by an attachment re-render.
function awRenderTaskAttachments() {
    const el = document.getElementById('awTaskAttachmentsContainer');
    if (el) el.innerHTML = awRenderAttachmentBlock(awTaskAttachments, null, 'task');
}

// ── Questions builder: always rendered, 0-N question cards + Add Question ──
function awRenderBuilder() {
    const container = document.getElementById('addWorkBuilderContainer');
    if (!container) return;
    const cards = awQuestions.map((q, i) => awRenderQuestionCard(q, i)).join('');
    const empty = awQuestions.length === 0
        ? `<p class="text-[11px] text-slate-400 italic text-center py-3">No questions yet — this will be an instructions-only assignment unless you add one below.</p>` : '';
    container.innerHTML = `
        ${cards}
        ${empty}
        <button type="button" data-aw-action="add-question"
            class="w-full border-2 border-dashed border-slate-200 hover:border-teal-400 text-slate-400 hover:text-teal-600 rounded-xl py-3 text-[11px] font-black uppercase tracking-widest transition">
            <i class="fa-solid fa-plus mr-1.5"></i>Add Question
        </button>`;
}

function awRenderQuestionCard(q, index) {
    const typeOptions = AW_QUESTION_TYPES.map(t =>
        `<option value="${t.value}" ${t.value === q.type ? 'selected' : ''}>${t.label}</option>`).join('');

    return `
    <div class="bg-white border border-slate-200 rounded-xl p-4 mb-3" data-question-id="${q.id}">
        <div class="flex items-start justify-between gap-3 mb-3">
            <div class="flex items-center gap-2 min-w-0">
                <span class="w-6 h-6 flex-shrink-0 bg-teal-50 text-teal-600 border border-teal-200 rounded-lg flex items-center justify-center text-[10px] font-black">${index + 1}</span>
                <select data-question-id="${q.id}" data-field="type" data-aw-change="question-type"
                    class="form-select text-[11px] font-black text-slate-700 border border-slate-200 rounded-lg py-1 pl-2 pr-6 outline-none focus:border-teal-400 appearance-none">
                    ${typeOptions}
                </select>
            </div>
            <div class="flex items-center gap-1 flex-shrink-0">
                <button type="button" data-question-id="${q.id}" data-aw-action="move-up" ${index === 0 ? 'disabled' : ''}
                    class="w-7 h-7 flex items-center justify-center text-slate-300 hover:text-slate-700 disabled:opacity-30 disabled:cursor-not-allowed rounded-lg transition" title="Move up">
                    <i class="fa-solid fa-arrow-up text-[11px]"></i>
                </button>
                <button type="button" data-question-id="${q.id}" data-aw-action="move-down" ${index === awQuestions.length - 1 ? 'disabled' : ''}
                    class="w-7 h-7 flex items-center justify-center text-slate-300 hover:text-slate-700 disabled:opacity-30 disabled:cursor-not-allowed rounded-lg transition" title="Move down">
                    <i class="fa-solid fa-arrow-down text-[11px]"></i>
                </button>
                <button type="button" data-question-id="${q.id}" data-aw-action="delete-question"
                    class="w-7 h-7 flex items-center justify-center text-slate-300 hover:text-red-500 rounded-lg transition" title="Delete question">
                    <i class="fa-solid fa-trash text-[11px]"></i>
                </button>
            </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-[1fr_100px] gap-3 mb-3">
            <div>
                <label class="block text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">Prompt</label>
                <textarea data-question-id="${q.id}" data-field="prompt" data-aw-input="question-field"
                    placeholder="Type the question…"
                    class="form-input w-full p-2 bg-white border border-slate-200 rounded-lg text-[12.5px] text-slate-800 h-16 resize-none focus:border-teal-400 focus:ring-0 transition outline-none">${escHtml(q.prompt || '')}</textarea>
            </div>
            <div>
                <label class="block text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">Points</label>
                <input type="number" min="0" step="any" inputmode="decimal" value="${q.points ?? 1}"
                    data-question-id="${q.id}" data-field="points" data-aw-input="question-field"
                    class="form-input w-full p-2 bg-white border border-slate-200 rounded-lg text-[12.5px] text-slate-800 focus:border-teal-400 focus:ring-0 transition outline-none">
            </div>
        </div>

        ${awRenderQuestionTypeFields(q)}
        ${awRenderAttachmentBlock(q.attachments, q.id, 'question')}
    </div>`;
}

function awRenderQuestionTypeFields(q) {
    if (q.type === 'multiple_choice') {
        const options = (q.options || []).map((opt, i) => `
            <div class="flex items-center gap-2">
                <input type="radio" name="aw-correct-${q.id}" data-question-id="${q.id}" data-option-index="${i}" data-aw-action="set-correct"
                    ${q.correctOptionIndex === i ? 'checked' : ''}
                    class="w-3.5 h-3.5 accent-teal-600 cursor-pointer flex-shrink-0" title="Mark as the correct answer">
                <span class="text-[10px] font-black text-slate-400 w-4 flex-shrink-0">${String.fromCharCode(65 + i)}</span>
                <input type="text" value="${escHtml(opt)}" placeholder="Option ${i + 1}"
                    data-question-id="${q.id}" data-option-index="${i}" data-aw-input="option-text"
                    class="form-input flex-1 p-1.5 bg-white border border-slate-200 rounded-lg text-[12px] text-slate-800 focus:border-teal-400 focus:ring-0 transition outline-none">
                <button type="button" data-question-id="${q.id}" data-option-index="${i}" data-aw-action="remove-option"
                    ${(q.options || []).length <= 2 ? 'disabled' : ''}
                    class="w-6 h-6 flex-shrink-0 flex items-center justify-center text-slate-300 hover:text-red-500 disabled:opacity-30 disabled:cursor-not-allowed rounded-lg transition">
                    <i class="fa-solid fa-xmark text-[11px]"></i>
                </button>
            </div>`).join('');
        return `
            <div class="mb-3 pl-1 space-y-1.5">
                ${options}
                <button type="button" data-question-id="${q.id}" data-aw-action="add-option"
                    class="text-[10.5px] font-black text-teal-600 hover:text-slate-800 mt-1"><i class="fa-solid fa-plus mr-1"></i>Add option</button>
                <p class="text-[9.5px] text-slate-400 italic m-0 pt-0.5">Select the circle next to the correct option — required before this can be saved.</p>
            </div>`;
    }

    if (q.type === 'free_response' || q.type === 'short_answer' || q.type === 'math') {
        const label = q.type === 'math' ? 'Formula / LaTeX guidance for students (optional)' : 'Guidance shown to students — e.g. expected length (optional)';
        return `
            <div class="mb-3">
                <input type="text" value="${escHtml(q.hint || '')}" placeholder="${label}"
                    data-question-id="${q.id}" data-field="hint" data-aw-input="question-field"
                    class="form-input w-full p-2 bg-white border border-slate-200 rounded-lg text-[12px] text-slate-800 focus:border-teal-400 focus:ring-0 transition outline-none">
            </div>`;
    }

    if (q.type === 'attachment_response') {
        const opts = ['File Upload', 'Camera Photo', 'Drawing Canvas']
            .map(o => `<option value="${o}" ${o === q.responseType ? 'selected' : ''}>${o}</option>`).join('');
        return `
            <div class="mb-3">
                <label class="block text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">Required student output</label>
                <select data-question-id="${q.id}" data-field="responseType" data-aw-change="question-field"
                    class="form-select w-full sm:w-64 p-2 bg-white border border-slate-200 rounded-lg text-[12px] text-slate-800 pr-8 focus:border-teal-400 focus:ring-0 transition outline-none appearance-none">
                    ${opts}
                </select>
            </div>`;
    }
    return '';
}

// ── Shared attachment block — task-level ('task') or per-question ('question') ──
function awRenderAttachmentBlock(attachments, questionId, scope) {
    const qAttr = questionId ? `data-question-id="${questionId}"` : '';
    const rows = (attachments || []).map((a, i) => `
        <div class="flex items-center gap-2 text-[12px]">
            <i class="fa-solid fa-paperclip text-slate-400 text-[11px]"></i>
            <a href="${escHtml(a.url)}" target="_blank" rel="noopener" class="flex-1 truncate text-slate-800 font-semibold hover:underline">${escHtml(a.name || a.url)}</a>
            <button type="button" ${qAttr} data-attachment-index="${i}" data-aw-scope="${scope}" data-aw-action="remove-attachment"
                class="w-6 h-6 flex-shrink-0 flex items-center justify-center text-slate-400 hover:text-red-500 rounded-lg transition">
                <i class="fa-solid fa-xmark text-[11px]"></i>
            </button>
        </div>`).join('');

    return `
        <div class="border-t border-slate-100 pt-3">
            <label class="block text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1.5">
                ${scope === 'task' ? 'Teacher media attachments' : 'Attach media to this question'}
            </label>
            <div class="space-y-1.5 mb-2">${rows}</div>
            <div class="flex items-center gap-1.5">
                <input type="url" placeholder="Paste a link (PDF/image/video)…" data-aw-scope="${scope}" ${qAttr}
                    data-aw-field="attachment-url-input"
                    class="form-input flex-1 p-1.5 bg-white border border-slate-200 rounded-lg text-[11.5px] text-slate-800 focus:border-teal-400 focus:ring-0 transition outline-none">
                <button type="button" data-aw-scope="${scope}" ${qAttr} data-aw-action="add-attachment"
                    class="text-[10.5px] font-black text-teal-600 hover:text-slate-800 px-2 py-1.5 whitespace-nowrap">
                    <i class="fa-solid fa-plus mr-1"></i>Add link
                </button>
                <button type="button" data-aw-scope="${scope}" ${qAttr} data-aw-action="trigger-upload"
                    class="text-[10.5px] font-black text-slate-700 bg-white hover:bg-slate-100 border border-slate-200 px-2.5 py-1.5 rounded-lg whitespace-nowrap transition">
                    <i class="fa-solid fa-upload mr-1"></i>Upload File
                </button>
            </div>
        </div>`;
}

function awRerenderAll() {
    awRenderTaskAttachments();
    awRenderBuilder();
}

// ── Event delegation: two containers (task attachments + questions builder)
// share the same action vocabulary, so one pair of listeners on their common
// parent (#awBuilderRoot) handles both — distinguished by data-aw-scope. ──
function initAddWorkBuilderEvents() {
    const root = document.getElementById('awBuilderRoot');
    if (!root) return;

    root.addEventListener('input', (e) => {
        const t = e.target;
        if (t.dataset.awInput === 'question-field') {
            const q = awFindQuestion(t.dataset.questionId);
            if (!q) return;
            q[t.dataset.field] = t.dataset.field === 'points' ? (parseFloat(t.value) || 0) : t.value;
        } else if (t.dataset.awInput === 'option-text') {
            const q = awFindQuestion(t.dataset.questionId);
            if (!q || !q.options) return;
            q.options[Number(t.dataset.optionIndex)] = t.value;
        }
    });

    root.addEventListener('change', (e) => {
        const t = e.target;
        if (t.dataset.awChange === 'question-type') {
            const q = awFindQuestion(t.dataset.questionId);
            if (!q) return;
            awResetQuestionTypeFields(q, t.value);
            awRenderBuilder();
        } else if (t.dataset.awChange === 'question-field') {
            const q = awFindQuestion(t.dataset.questionId);
            if (q) q[t.dataset.field] = t.value;
        }
    });

    root.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-aw-action]');
        if (!btn || btn.disabled) return;
        const action = btn.dataset.awAction;
        const qId = btn.dataset.questionId;

        if (action === 'trigger-upload') {
            awFileUploadTarget = { scope: btn.dataset.awScope, questionId: qId || null };
            document.getElementById('awFileInput')?.click();
            return; // no state changed yet — nothing to re-render
        } else if (action === 'add-question') {
            awQuestions.push(awMakeQuestion('multiple_choice'));
        } else if (action === 'delete-question') {
            awQuestions = awQuestions.filter(q => q.id !== qId);
        } else if (action === 'move-up' || action === 'move-down') {
            const i = awQuestions.findIndex(q => q.id === qId);
            const j = action === 'move-up' ? i - 1 : i + 1;
            if (i < 0 || j < 0 || j >= awQuestions.length) return;
            [awQuestions[i], awQuestions[j]] = [awQuestions[j], awQuestions[i]];
        } else if (action === 'add-option') {
            const q = awFindQuestion(qId);
            if (q?.options) q.options.push('');
        } else if (action === 'remove-option') {
            const q = awFindQuestion(qId);
            if (q?.options && q.options.length > 2) {
                const idx = Number(btn.dataset.optionIndex);
                q.options.splice(idx, 1);
                if (q.correctOptionIndex === idx) q.correctOptionIndex = null;
                else if (typeof q.correctOptionIndex === 'number' && q.correctOptionIndex > idx) q.correctOptionIndex -= 1;
            }
        } else if (action === 'set-correct') {
            const q = awFindQuestion(qId);
            if (q) q.correctOptionIndex = Number(btn.dataset.optionIndex);
        } else if (action === 'add-attachment') {
            const scope = btn.dataset.awScope;
            const input = root.querySelector(
                scope === 'task'
                    ? `input[data-aw-field="attachment-url-input"][data-aw-scope="task"]`
                    : `input[data-aw-field="attachment-url-input"][data-question-id="${qId}"]`
            );
            const url = (input?.value || '').trim();
            if (!url) return;
            let name;
            try { name = new URL(url).pathname.split('/').filter(Boolean).pop() || url; } catch { name = url; }
            const entry = { id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, name, url };
            if (scope === 'task') {
                awTaskAttachments.push(entry);
            } else {
                const q = awFindQuestion(qId);
                if (q) (q.attachments = q.attachments || []).push(entry);
            }
        } else if (action === 'remove-attachment') {
            const scope = btn.dataset.awScope;
            const idx = Number(btn.dataset.attachmentIndex);
            if (scope === 'task') {
                awTaskAttachments.splice(idx, 1);
            } else {
                const q = awFindQuestion(qId);
                if (q?.attachments) q.attachments.splice(idx, 1);
            }
        } else {
            return; // unrecognized action — don't re-render for nothing
        }
        awRerenderAll();
    });

    document.getElementById('awFileInput')?.addEventListener('change', awHandleFileSelected);
}
initAddWorkBuilderEvents();

function sanitizeAttachmentFileName(name) {
    return String(name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);
}

// ── Real Storage upload (Phase 2.2) — mirrors uploadSubmissionAttachment's
// pattern in submissions.js: upload immediately on selection, return
// {id, name, url}, land it in whichever attachment array the teacher clicked
// "Upload File" from. Path uses resolvePostContext() rather than raw
// sub.classId, matching how the legacy auto-grade shadow doc already
// resolves a class for a legacy subject — a subject with no resolvable
// class can't accept an upload either, and this surfaces that clearly
// instead of writing to a broken path. ──
async function uploadWorkAttachment(file) {
    const sub = getSubjectByName(currentSubjectName);
    if (!sub) throw new Error('Subject not found. Please refresh.');
    const ctx = resolvePostContext(sub, resolvedClasses);
    if (!ctx) throw new Error('Could not resolve a class for this subject, so files can\'t be uploaded yet.');
    const path = `schools/${session.schoolId}/attachments/${ctx.classId}/${ctx.subjectId}/${awCurrentAssignmentId}/${Date.now()}_${sanitizeAttachmentFileName(file.name)}`;
    const fileRef = storageRef(storage, path);
    await uploadBytes(fileRef, file);
    const url = await getDownloadURL(fileRef);
    return { id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, name: file.name, url };
}

async function awHandleFileSelected(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // allow re-selecting the same file later
    if (!file || !awFileUploadTarget) return;
    if (file.size > AW_MAX_ATTACHMENT_BYTES) {
        awShowError(`"${file.name}" is larger than 25MB and can't be uploaded.`);
        awFileUploadTarget = null;
        return;
    }

    const { scope, questionId } = awFileUploadTarget;
    awFileUploadTarget = null;
    const btnSelector = scope === 'task'
        ? `button[data-aw-action="trigger-upload"][data-aw-scope="task"]`
        : `button[data-aw-action="trigger-upload"][data-question-id="${questionId}"]`;
    const btn = document.querySelector(btnSelector);
    const originalHtml = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; }

    try {
        const entry = await uploadWorkAttachment(file);
        if (scope === 'task') {
            awTaskAttachments.push(entry);
        } else {
            const q = awFindQuestion(questionId);
            if (q) (q.attachments = q.attachments || []).push(entry);
        }
        awRerenderAll();
    } catch (err) {
        console.error('[Add Work] File upload failed:', err);
        awShowError('Could not upload that file. Please try again.');
        if (btn) { btn.disabled = false; btn.innerHTML = originalHtml; }
    }
}

function awClearBanners() {
    document.getElementById('awErrorBanner')?.classList.add('hidden');
    document.getElementById('awSavedBanner')?.classList.add('hidden');
}
function awShowError(message) {
    document.getElementById('awSavedBanner')?.classList.add('hidden');
    const text = document.getElementById('awErrorBannerText');
    if (text) text.textContent = message;
    document.getElementById('awErrorBanner')?.classList.remove('hidden');
}
function awShowSaved(message) {
    document.getElementById('awErrorBanner')?.classList.add('hidden');
    const text = document.getElementById('awSavedBannerText');
    if (text) text.textContent = message;
    document.getElementById('awSavedBanner')?.classList.remove('hidden');
}

// Pure function — no DOM writes — so it stays unit-testable the same way
// the original engine's render/validate functions were.
function awValidate({ title, type, maxScore, existingList, editingId }) {
    const errors = [];
    if (!title) errors.push('Title is required.');
    if (!type) errors.push('Type is required.');
    if (isNaN(maxScore) || maxScore < 1) errors.push('Points possible must be a whole number of at least 1.');
    if (existingList.some(a => a.id !== editingId && (a.title || '').toLowerCase() === title.toLowerCase())) {
        errors.push('An assignment with that title already exists for this subject.');
    }

    awQuestions.forEach((q, i) => {
        const n = i + 1;
        if (!(q.prompt || '').trim()) errors.push(`Question ${n}: a prompt is required.`);
        if (q.type === 'multiple_choice') {
            const filled = (q.options || []).filter(o => (o || '').trim() !== '');
            if (filled.length < 2) errors.push(`Question ${n}: at least 2 non-empty options are required.`);
            const ci = q.correctOptionIndex;
            const hasMark = typeof ci === 'number' && q.options && (q.options[ci] || '').trim() !== '';
            if (!hasMark) errors.push(`Question ${n}: select which option is correct.`);
        }
    });
    return errors;
}

// Strips correctOptionIndex out of each question (into the returned
// answerKeys map) and maps attachment_response's responseType into the
// studentResponse shape the backend expects. Nothing here mutates
// awQuestions — the modal's own state stays exactly as the teacher left it
// if the save fails and they need to retry.
function awBuildCleanQuestions() {
    const answerKeys = {};
    const requiresMap = { 'File Upload': 'file', 'Camera Photo': 'photo', 'Drawing Canvas': 'drawing' };

    const questions = awQuestions.map(q => {
        const clean = {
            id: q.id,
            type: q.type,
            prompt: q.prompt || '',
            points: q.points ?? 0,
            attachments: q.attachments || []
        };
        if (q.type === 'multiple_choice') {
            clean.options = [...(q.options || [])];
            if (typeof q.correctOptionIndex === 'number') answerKeys[q.id] = q.correctOptionIndex;
        } else if (q.type === 'free_response' || q.type === 'short_answer' || q.type === 'math') {
            clean.hint = q.hint || '';
        } else if (q.type === 'attachment_response') {
            clean.responseType = q.responseType || 'File Upload';
            clean.studentResponse = { requires: requiresMap[clean.responseType] || 'file' };
        }
        return clean;
    });

    return { questions, answerKeys };
}

window.awSaveWork = async function() {
    awClearBanners();

    const sub = getSubjectByName(currentSubjectName);
    if (!sub) { awShowError('Could not resolve the selected subject.'); return; }

    const title        = document.getElementById('awTitle')?.value.trim() || '';
    const type          = document.getElementById('awType')?.value || '';
    const date          = document.getElementById('awDueDate')?.value || '';
    const maxScore      = parseInt(document.getElementById('awPoints')?.value, 10);
    const instructions  = document.getElementById('awInstructions')?.value.trim() || '';
    const description   = document.getElementById('awDescription')?.value.trim() || '';
    const locked        = !!document.getElementById('awLocked')?.checked;

    const editingId = awEditingAssignmentId;
    const existingList = getAssignmentsForSubject(currentSubjectName);
    const currentRecord = editingId ? existingList.find(a => a.id === editingId) : null;

    const errors = awValidate({ title, type, maxScore, existingList, editingId });
    if (errors.length) {
        awShowError(errors[0] + (errors.length > 1 ? ` (+${errors.length - 1} more issue${errors.length > 2 ? 's' : ''})` : ''));
        return;
    }

    const { questions: cleanQuestions, answerKeys } = awBuildCleanQuestions();
    const isAssessment = cleanQuestions.length > 0;
    const category = isAssessment ? 'assessment' : 'standard';

    const assignmentId = awCurrentAssignmentId || editingId || genAssignmentId();
    const nowIso = new Date().toISOString();
    const wasLocked = !!(currentRecord?.locked);

    const assignmentData = {
        id: assignmentId,
        title, type,
        maxScore,
        date,
        instructions,
        description,
        locked,
        lockedAt: locked ? (wasLocked ? (currentRecord?.lockedAt || nowIso) : nowIso) : null,
        completed: currentRecord?.completed ?? false,
        attachments: [...awTaskAttachments],
        category,
        questions: cleanQuestions,
        teacherId: session.teacherId,
        createdAt: currentRecord?.createdAt || nowIso,
        updatedAt: nowIso
    };

    const hasAnswerKeys = Object.keys(answerKeys).length > 0;
    const answerKeyData = hasAnswerKeys ? {
        assignmentId, schoolId: session.schoolId, keys: answerKeys, createdAt: serverTimestamp()
    } : null;

    const saveBtn = document.getElementById('awSaveBtn');
    const originalHtml = saveBtn ? saveBtn.innerHTML : '';
    if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…'; }

    try {
        const batch = writeBatch(db);
        let updatedSubjects = null;
        const nextAssignments = editingId
            ? existingList.map(a => a.id === editingId ? assignmentData : a)
            : [...existingList, assignmentData];

        if (sub._source === 'new') {
            const assignmentRef = doc(db, 'schools', session.schoolId, 'classes', sub.classId, 'subjects', sub.id, 'assignments', assignmentId);
            batch.set(assignmentRef, assignmentData);
        } else {
            updatedSubjects = (session.teacherData.subjects || []).map(s => {
                if (s.id !== sub.id) return s;
                return { ...s, assignments: nextAssignments };
            });

            // Guard the Firestore 1MB document ceiling — this doc holds EVERY
            // legacy subject's assignments, not just this one, so a rich Add
            // Work payload (question text, attachment links) can push it over
            // the limit in a way a plain grade record never could.
            const approxBytes = new Blob([JSON.stringify(updatedSubjects)]).size;
            if (approxBytes > 900000) {
                throw new Error("This subject's legacy record is too large to hold another rich assignment (Firestore's 1MB document limit). It needs migrating to the new class/subject model before adding more work here.");
            }

            batch.update(getTeacherDocRef(session.schoolId, session.teacherId), { subjects: updatedSubjects });

            // A legacy subject has no real classes/{classId}/subjects/
            // {subjectId} document of its own, so the embedded copy above is
            // otherwise the ONLY place this assignment's questions/points
            // would exist. autoGradeWorkSubmission (functions/index.js) grades
            // server-side by reading the assignment doc at the exact real
            // subcollection path every submission is written under — a path
            // Firestore lets exist even with no real parent `subjects/
            // {subjectId}` document. Without this second write, that read
            // would always come back "not found" and MC auto-grading would
            // silently never fire for any legacy-subject assessment.
            if (isAssessment) {
                const shadowCtx = resolvePostContext(sub, resolvedClasses);
                if (shadowCtx) {
                    const shadowRef = doc(db, 'schools', session.schoolId, 'classes', shadowCtx.classId, 'subjects', shadowCtx.subjectId, 'assignments', assignmentId);
                    batch.set(shadowRef, { ...assignmentData, _legacyShadow: true });
                } else {
                    console.error(`[Add Work] Could not resolve a class for subject "${sub.name}" — skipping the legacy auto-grade shadow doc for assignment ${assignmentId}.`);
                }
            }
        }

        if (answerKeyData) {
            // create the first time an assessment is saved, update from then
            // on (e.g. correcting a mis-marked answer on edit) — firestore.rules'
            // work_answer_keys now allows both under identical conditions.
            batch.set(doc(db, 'work_answer_keys', assignmentId), answerKeyData);
        }

        await batch.commit();

        if (sub._source === 'new') {
            sub.assignments = nextAssignments;
        } else if (updatedSubjects) {
            session.teacherData.subjects = updatedSubjects;
            setSessionData('teacher', session);
            sub.assignments = updatedSubjects.find(s => s.id === sub.id)?.assignments || [];
        }

        awShowSaved(editingId ? 'Changes saved.' : `Added to ${currentSubjectName}.`);
        updateAssignmentTabBadge();
        setTimeout(() => { window.closeAddWorkModal(); renderAssignmentsTab(); }, 700);
    } catch (err) {
        console.error('[Add Work] awSaveWork failed:', err);
        awShowError(err?.message || 'Could not save. Please try again.');
    } finally {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = originalHtml; }
    }
};

// Fire it up
init();
