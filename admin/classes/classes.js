import { db } from '../../assets/js/firebase-init.js';
import {
    collection, getDocs, getDoc, doc,
    setDoc, deleteDoc, updateDoc, writeBatch,
    query, where
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectAdminLayout } from '../../assets/js/layout-admin.js';
import { openOverlay, closeOverlay, letterGrade, gradeColorClass, calculateWeightedAverage } from '../../assets/js/utils.js';

const session = requireAuth('admin', '../login.html');
injectAdminLayout('classes', 'Classes', 'Create classes and view performance', false, true);

// ── DOM refs ────────────────────────────────────────────────────────────────
const tbody              = document.getElementById('classesTableBody');
const loadingMsg         = document.getElementById('classesLoadingMsg');
const globalPeriodSelect = document.getElementById('globalPeriodSelect');
const searchInput        = document.getElementById('searchInput');
const filterTeacher      = document.getElementById('filterTeacher');

const newClassInput      = document.getElementById('newClassInput');
const addClassBtn        = document.getElementById('addClassBtn');
const addClassMsg        = document.getElementById('addClassMsg');
const classCardsGrid     = document.getElementById('classCardsGrid');
const classManagerLoader = document.getElementById('classManagerLoader');
const classEmptyState    = document.getElementById('classEmptyState');
const totalClassCountEl  = document.getElementById('totalClassCount');

// ── State ─────────────────────────────────────────────────────────────────
let classDataMap     = new Map();   // className -> processed performance data
let currentClassName = null;
let allFetchedClasses = [];

// Master list from schools/{id}/classes subcollection
let managedClasses   = [];          // [{ id, name, order, createdAt }]
// Compute-on-load tallies keyed by class NAME
let teacherCountByClass = {};       // { "Grade 6": 2 }
let studentCountByClass = {};       // { "Grade 6": 14 }
let teachersByClass     = {};       // { "Grade 6": [teacherObj, ...] }

// Raw caches so the manager + performance share one fetch
let rawTeachers = [];
let rawStudents = [];

// Rename / delete targets
let renameTargetId   = null;
let renameTargetName = null;
let deleteTargetId   = null;
let deleteTargetName = null;
let deleteIsBlocked  = false;

const DEFAULT_GRADE_TYPES = ['Test', 'Quiz', 'Assignment', 'Homework', 'Project', 'Midterm Exam', 'Final Exam'];

// ── UI HELPERS ────────────────────────────────────────────────────────────
function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escAttr(str) {
    // Safe for single-quoted inline onclick handlers
    return escHtml(str).replace(/'/g, '&#39;');
}

function standingBadge(avg) {
    if (avg === null) return '<span class="badge s-none" style="font-size:0.6rem">No Grades</span>';
    if (avg >= 90) return '<span class="badge s-exc" style="font-size:0.6rem">Excelling</span>';
    if (avg >= 80) return '<span class="badge s-good" style="font-size:0.6rem">Good</span>';
    if (avg >= 70) return '<span class="badge s-track" style="font-size:0.6rem">On Track</span>';
    if (avg >= 65) return '<span class="badge s-attn" style="font-size:0.6rem">Attention</span>';
    return '<span class="badge s-risk" style="font-size:0.6rem">At Risk</span>';
}

function getTeacherClasses(t) {
    return t.classes?.length ? t.classes : (t.className ? [t.className] : []);
}

function getTeacherGradeTypes(teacherObj) {
    if (!teacherObj) return DEFAULT_GRADE_TYPES;
    return teacherObj.gradeTypes || teacherObj.customGradeTypes || DEFAULT_GRADE_TYPES;
}

function showAddMsg(text, isError = true) {
    addClassMsg.textContent = text;
    addClassMsg.className = `text-[12px] font-bold mt-2 ${isError ? 'text-red-600' : 'text-emerald-600'}`;
    addClassMsg.classList.remove('hidden');
    setTimeout(() => addClassMsg.classList.add('hidden'), 3500);
}

// ── 1. MASTER CLASS LIST (schools/{id}/classes) ─────────────────────────────
async function loadManagedClasses() {
    const snap = await getDocs(collection(db, 'schools', session.schoolId, 'classes'));
    managedClasses = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.name || '').localeCompare(b.name || ''));
}

// ── 2. COMPUTE-ON-LOAD TALLIES ──────────────────────────────────────────────
// Counts teachers and students per class name from a single fetch of each.
function computeTallies() {
    teacherCountByClass = {};
    studentCountByClass = {};
    teachersByClass     = {};

    rawTeachers.forEach(t => {
        getTeacherClasses(t).forEach(cls => {
            if (!cls) return;
            teacherCountByClass[cls] = (teacherCountByClass[cls] || 0) + 1;
            if (!teachersByClass[cls]) teachersByClass[cls] = [];
            teachersByClass[cls].push(t);
        });
    });

    rawStudents.forEach(s => {
        const cls = s.className;
        if (!cls) return;
        studentCountByClass[cls] = (studentCountByClass[cls] || 0) + 1;
    });
}

// ── 3. RENDER CLASS MANAGER CARDS ───────────────────────────────────────────
function renderClassCards() {
    totalClassCountEl.textContent = managedClasses.length;
    classManagerLoader.classList.add('hidden');

    if (!managedClasses.length) {
        classCardsGrid.classList.add('hidden');
        classEmptyState.classList.remove('hidden');
        return;
    }

    classEmptyState.classList.add('hidden');
    classCardsGrid.classList.remove('hidden');

    classCardsGrid.innerHTML = managedClasses.map((c, i) => {
        const tCount = teacherCountByClass[c.name] || 0;
        const sCount = studentCountByClass[c.name] || 0;
        const inUse  = tCount > 0 || sCount > 0;

        // Build delete-blocked reason text
        let blockReason = '';
        if (inUse) {
            const parts = [];
            if (tCount > 0) parts.push(`${tCount} teacher${tCount !== 1 ? 's' : ''} assigned`);
            if (sCount > 0) parts.push(`${sCount} student${sCount !== 1 ? 's' : ''} enrolled`);
            blockReason = `Can't delete — ${parts.join(' and ')}. Reassign or remove them first.`;
        }

        const teacherChip = tCount > 0
            ? `<span class="count-chip chip-teacher"><i class="fa-solid fa-chalkboard-user text-[10px]"></i> ${tCount} teacher${tCount !== 1 ? 's' : ''}</span>`
            : `<span class="count-chip chip-empty"><i class="fa-solid fa-chalkboard-user text-[10px]"></i> No teacher</span>`;

        const studentChip = sCount > 0
            ? `<span class="count-chip chip-student"><i class="fa-solid fa-user-group text-[10px]"></i> ${sCount} student${sCount !== 1 ? 's' : ''}</span>`
            : `<span class="count-chip chip-empty"><i class="fa-solid fa-user-group text-[10px]"></i> Empty</span>`;

        const deleteBtn = inUse
            ? `<span class="ttip">
                   <button class="card-act card-act-del locked"><i class="fa-solid fa-trash-can"></i></button>
                   <span class="ttip-box wide">${escHtml(blockReason)}</span>
               </span>`
            : `<span class="ttip">
                   <button class="card-act card-act-del" onclick="event.stopPropagation(); window.openDeleteModal('${c.id}','${escAttr(c.name)}')"><i class="fa-solid fa-trash-can"></i></button>
                   <span class="ttip-box">Delete this class</span>
               </span>`;

        return `
        <div class="class-card card-anim" style="animation-delay:${i * 0.03}s" onclick="window.openClassPanel('${escAttr(c.name)}')">
            <div class="flex items-start justify-between mb-4">
                <div class="flex items-center gap-3 min-w-0">
                    <div class="w-11 h-11 bg-gradient-to-br from-indigo-500 to-blue-600 text-white rounded-xl flex items-center justify-center font-black text-base shadow-sm flex-shrink-0">${escHtml(c.name.charAt(0).toUpperCase())}</div>
                    <div class="min-w-0">
                        <p class="font-black text-slate-800 text-[15px] leading-tight truncate">${escHtml(c.name)}</p>
                        <p class="text-[11px] font-semibold ${inUse ? 'text-emerald-500' : 'text-slate-400'} mt-0.5">${inUse ? 'Active' : 'Not in use'}</p>
                    </div>
                </div>
                <div class="flex items-center gap-1.5 flex-shrink-0" onclick="event.stopPropagation()">
                    <span class="ttip">
                        <button class="card-act card-act-edit" onclick="window.openRenameModal('${c.id}','${escAttr(c.name)}')"><i class="fa-solid fa-pen"></i></button>
                        <span class="ttip-box">Rename this class</span>
                    </span>
                    ${deleteBtn}
                </div>
            </div>
            <div class="flex flex-wrap gap-2">
                ${teacherChip}
                ${studentChip}
            </div>
            <div class="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between">
                <span class="text-[11px] font-bold text-indigo-500">View details</span>
                <i class="fa-solid fa-arrow-right text-indigo-300 text-[11px]"></i>
            </div>
        </div>`;
    }).join('');
}

// ── 4. ADD CLASS ─────────────────────────────────────────────────────────────
async function handleAddClass() {
    const name = newClassInput.value.trim();

    if (!name) { showAddMsg('Please enter a class name.'); return; }
    if (name.length < 2) { showAddMsg('Class name is too short.'); return; }

    // Duplicate check (case-insensitive)
    const exists = managedClasses.some(c => (c.name || '').toLowerCase() === name.toLowerCase());
    if (exists) { showAddMsg(`"${name}" already exists.`); return; }

    addClassBtn.disabled = true;
    addClassBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Adding...';

    try {
        const id = `cls_${Date.now()}`;
        const order = managedClasses.length
            ? Math.max(...managedClasses.map(c => c.order ?? 0)) + 1
            : 1;

        await setDoc(doc(db, 'schools', session.schoolId, 'classes', id), {
            name,
            order,
            createdAt: new Date().toISOString()
        });

        managedClasses.push({ id, name, order, createdAt: new Date().toISOString() });
        managedClasses.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.name || '').localeCompare(b.name || ''));

        newClassInput.value = '';
        renderClassCards();
        showAddMsg(`"${name}" added.`, false);
    } catch (e) {
        console.error('[Classes] addClass:', e);
        showAddMsg('Could not add class. Please try again.');
    }

    addClassBtn.disabled = false;
    addClassBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Add Class';
}

addClassBtn.addEventListener('click', handleAddClass);
newClassInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); handleAddClass(); } });

// ── 5. RENAME CLASS ──────────────────────────────────────────────────────────
window.openRenameModal = function(classId, className) {
    renameTargetId   = classId;
    renameTargetName = className;

    document.getElementById('renameInput').value = className;
    document.getElementById('renameMsg').classList.add('hidden');

    const tCount = teacherCountByClass[className] || 0;
    const sCount = studentCountByClass[className] || 0;
    const impact = document.getElementById('renameImpact');

    if (tCount > 0 || sCount > 0) {
        const parts = [];
        if (tCount > 0) parts.push(`${tCount} teacher${tCount !== 1 ? 's' : ''}`);
        if (sCount > 0) parts.push(`${sCount} student${sCount !== 1 ? 's' : ''}`);
        impact.innerHTML = `<i class="fa-solid fa-circle-info mr-1"></i> Renaming will update this class for ${parts.join(' and ')} automatically.`;
        impact.classList.remove('hidden');
    } else {
        impact.classList.add('hidden');
    }

    openOverlay('renameModal', 'renameModalInner');
    setTimeout(() => document.getElementById('renameInput').focus(), 100);
};

window.closeRenameModal = function() { closeOverlay('renameModal', 'renameModalInner'); };

window.confirmRename = async function() {
    const newName = document.getElementById('renameInput').value.trim();
    const msgEl   = document.getElementById('renameMsg');
    const showMsg = (text, isErr = true) => {
        msgEl.textContent = text;
        msgEl.className = `text-[12px] font-bold mb-2 ${isErr ? 'text-red-600' : 'text-emerald-600'}`;
        msgEl.classList.remove('hidden');
    };

    if (!newName) { showMsg('Please enter a name.'); return; }
    if (newName === renameTargetName) { window.closeRenameModal(); return; }

    const dup = managedClasses.some(c => c.id !== renameTargetId && (c.name || '').toLowerCase() === newName.toLowerCase());
    if (dup) { showMsg(`"${newName}" already exists.`); return; }

    const btn = document.getElementById('confirmRenameBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';

    try {
        const oldName = renameTargetName;
        const batch = writeBatch(db);

        // 1. The class doc itself
        batch.update(doc(db, 'schools', session.schoolId, 'classes', renameTargetId), { name: newName });

        // 2. Every teacher at this school holding the old class name
        const affectedTeachers = rawTeachers.filter(t => getTeacherClasses(t).includes(oldName));
        affectedTeachers.forEach(t => {
            const updatedClasses = getTeacherClasses(t).map(c => c === oldName ? newName : c);
            const upd = { classes: updatedClasses };
            if (t.className === oldName) upd.className = newName;
            batch.update(doc(db, 'teachers', t.id), upd);
        });

        // 3. Every active student at this school in the old class
        const affectedStudents = rawStudents.filter(s => s.className === oldName);
        affectedStudents.forEach(s => {
            batch.update(doc(db, 'students', s.id), { className: newName });
        });

        await batch.commit();

        // Update local caches in place (avoid full refetch)
        const mc = managedClasses.find(c => c.id === renameTargetId);
        if (mc) mc.name = newName;
        affectedTeachers.forEach(t => {
            t.classes = getTeacherClasses(t).map(c => c === oldName ? newName : c);
            if (t.className === oldName) t.className = newName;
        });
        affectedStudents.forEach(s => { s.className = newName; });

        computeTallies();
        renderClassCards();
        rebuildPerformanceFromCache();

        window.closeRenameModal();
    } catch (e) {
        console.error('[Classes] rename:', e);
        showMsg('Could not rename. Please try again.');
    }

    btn.disabled = false;
    btn.innerHTML = 'Save Changes';
};

// ── 6. DELETE CLASS ──────────────────────────────────────────────────────────
window.openDeleteModal = function(classId, className) {
    deleteTargetId   = classId;
    deleteTargetName = className;

    const tCount = teacherCountByClass[className] || 0;
    const sCount = studentCountByClass[className] || 0;
    deleteIsBlocked = (tCount > 0 || sCount > 0);

    const body = document.getElementById('deleteBody');
    const btn  = document.getElementById('confirmDeleteBtn');

    if (deleteIsBlocked) {
        const rows = [];
        if (tCount > 0) rows.push(`<div class="flex items-center gap-2.5 text-[12.5px] font-semibold text-slate-600"><i class="fa-solid fa-chalkboard-user text-red-400 w-4"></i> ${tCount} teacher${tCount !== 1 ? 's' : ''} assigned</div>`);
        if (sCount > 0) rows.push(`<div class="flex items-center gap-2.5 text-[12.5px] font-semibold text-slate-600"><i class="fa-solid fa-user-group text-red-400 w-4"></i> ${sCount} student${sCount !== 1 ? 's' : ''} enrolled</div>`);

        body.innerHTML = `
            <div class="bg-red-50 border border-red-200 rounded-xl p-4 mb-3">
                <p class="font-black text-red-700 text-[13px] mb-2"><i class="fa-solid fa-lock mr-1.5"></i>This class can't be deleted yet</p>
                <div class="space-y-1.5">${rows.join('')}</div>
            </div>
            <p class="text-[12.5px] text-slate-500 font-semibold leading-relaxed">
                To delete <strong class="text-slate-700">${escHtml(className)}</strong>, first reassign its teachers to other classes and move or archive its students. Once the class is empty, you can remove it.
            </p>`;
        btn.disabled = true;
        btn.className = 'flex-1 bg-slate-200 text-slate-400 font-bold py-3 rounded-xl text-[13px] cursor-not-allowed';
        btn.innerHTML = 'Delete Class';
    } else {
        body.innerHTML = `
            <div class="bg-slate-50 border border-slate-200 rounded-xl p-4">
                <p class="text-[12.5px] text-slate-600 font-semibold leading-relaxed">
                    Are you sure you want to delete <strong class="text-slate-800">${escHtml(className)}</strong>? This class has no teachers or students assigned, so it's safe to remove. This action can't be undone.
                </p>
            </div>`;
        btn.disabled = false;
        btn.className = 'flex-1 bg-red-600 hover:bg-red-700 text-white font-bold py-3 rounded-xl text-[13px] transition shadow-sm shadow-red-200';
        btn.innerHTML = 'Delete Class';
    }

    openOverlay('deleteModal', 'deleteModalInner');
};

window.closeDeleteModal = function() { closeOverlay('deleteModal', 'deleteModalInner'); };

window.confirmDelete = async function() {
    if (deleteIsBlocked) return;

    const btn = document.getElementById('confirmDeleteBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Deleting...';

    try {
        await deleteDoc(doc(db, 'schools', session.schoolId, 'classes', deleteTargetId));
        managedClasses = managedClasses.filter(c => c.id !== deleteTargetId);
        renderClassCards();
        window.closeDeleteModal();
    } catch (e) {
        console.error('[Classes] delete:', e);
        btn.innerHTML = 'Delete Class';
        btn.disabled = false;
        alert('Could not delete class. Please try again.');
    }
};

// ── 7. SEMESTER DROPDOWN + DATA BOOT ────────────────────────────────────────
async function loadSemestersDropdown() {
    try {
        const snap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
        const semesters = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

        globalPeriodSelect.innerHTML = semesters.map(s =>
            `<option value="${s.id}" ${s.id === session.activeSemesterId ? 'selected' : ''}>${escHtml(s.name)} ${s.archived ? '(Archived)' : ''}</option>`
        ).join('');

        globalPeriodSelect.addEventListener('change', fetchAndProcessClassData);
    } catch (error) {
        console.error('Error loading semesters:', error);
    }
}

// ── 8. FETCH & PROCESS (shared fetch powers manager + performance) ──────────
async function fetchAndProcessClassData() {
    loadingMsg.classList.remove('hidden');
    tbody.innerHTML = `<tr><td colspan="9" class="px-6 py-16 text-center text-slate-400 font-semibold"><i class="fa-solid fa-spinner fa-spin text-indigo-400 text-2xl mb-3 block"></i>Loading classes...</td></tr>`;

    const semId = globalPeriodSelect.value || session.activeSemesterId || '';

    try {
        const [tSnap, sSnap] = await Promise.all([
            getDocs(query(collection(db, 'teachers'), where('currentSchoolId', '==', session.schoolId))),
            getDocs(query(collection(db, 'students'),
                where('currentSchoolId', '==', session.schoolId),
                where('enrollmentStatus', '==', 'Active')))
        ]);

        rawTeachers = tSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        rawStudents = sSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        // Populate teacher filter once
        if (filterTeacher && filterTeacher.options.length <= 1) {
            filterTeacher.innerHTML = '<option value="">All Teachers</option>' +
                rawTeachers.map(t => `<option value="${t.id}">${escHtml(t.name)}</option>`).join('');
        }

        // Compute-on-load tallies → drive the manager cards
        computeTallies();
        renderClassCards();

        // Build performance table from same caches
        await buildPerformanceData(semId);

        loadingMsg.classList.add('hidden');
    } catch (e) {
        console.error('Error building classes table:', e);
        loadingMsg.classList.add('hidden');
        tbody.innerHTML = `<tr><td colspan="9" class="px-6 py-16 text-center text-red-500 font-semibold">Failed to load classes.</td></tr>`;
    }
}

// Builds classDataMap + allFetchedClasses (grades pulled fresh for the term)
async function buildPerformanceData(semId) {
    classDataMap.clear();
    allFetchedClasses = [];

    const classesByName = {};

    rawStudents.forEach(s => {
        const cls = s.className || 'Unassigned';
        if (!classesByName[cls]) classesByName[cls] = { students: [], teachers: [] };
        classesByName[cls].students.push(s);
    });

    rawTeachers.forEach(t => {
        getTeacherClasses(t).forEach(cls => {
            if (!cls) return;
            if (!classesByName[cls]) classesByName[cls] = { students: [], teachers: [] };
            classesByName[cls].teachers.push(t);
        });
    });

    // Ensure every managed class shows up even with zero data
    managedClasses.forEach(mc => {
        if (!classesByName[mc.name]) classesByName[mc.name] = { students: [], teachers: [] };
    });

    if (!Object.keys(classesByName).length) {
        tbody.innerHTML = `<tr><td colspan="9" class="px-6 py-16 text-center text-slate-400 italic font-semibold">No classes found. Add a class above to get started.</td></tr>`;
        return;
    }

    allFetchedClasses = await Promise.all(Object.entries(classesByName).map(async ([className, classData]) => {
        const allGrades = [];

        await Promise.all(classData.students.map(async s => {
            try {
                const conditions = [where('schoolId', '==', session.schoolId)];
                if (semId && semId !== 'all') conditions.push(where('semesterId', '==', semId));
                const q = query(collection(db, 'students', s.id, 'grades'), ...conditions);
                const snap = await getDocs(q);
                snap.forEach(d => allGrades.push({ ...d.data(), studentId: s.id }));
            } catch (e) {
                console.error(`Error fetching grades for student ${s.id}`, e);
            }
        }));

        const primaryTeacher = classData.teachers[0] || null;
        const gradeTypes = getTeacherGradeTypes(primaryTeacher);

        const stuAvgs = classData.students.map(s => {
            const sg = allGrades.filter(g => g.studentId === s.id);
            return sg.length ? calculateWeightedAverage(sg, gradeTypes) : null;
        }).filter(a => a !== null);

        const classAvg = stuAvgs.length ? Math.round(stuAvgs.reduce((a, b) => a + b, 0) / stuAvgs.length) : null;
        const allPcts  = allGrades.map(g => g.max ? Math.round(g.score / g.max * 100) : 0);
        const highest  = allPcts.length ? Math.max(...allPcts) : null;
        const lowest   = allPcts.length ? Math.min(...allPcts) : null;
        const atRisk   = stuAvgs.filter(a => a < 65).length;
        const subjectCount = new Set(allGrades.map(g => g.subject)).size;

        const processed = {
            className,
            teachers: classData.teachers,
            teacher: primaryTeacher,
            students: classData.students,
            studentCount: classData.students.length,
            subjectCount, classAvg, highest, lowest, atRisk,
            grades: allGrades,
            gradeTypes
        };
        classDataMap.set(className, processed);
        return processed;
    }));

    allFetchedClasses.sort((a, b) => a.className.localeCompare(b.className));
    renderTable();
}

// Re-render performance table from existing classDataMap (used after rename)
function rebuildPerformanceFromCache() {
    allFetchedClasses = Array.from(classDataMap.values()).sort((a, b) => a.className.localeCompare(b.className));
    renderTable();
}

// ── 9. PERFORMANCE TABLE RENDER ──────────────────────────────────────────────
function renderTable() {
    if (!tbody) return;

    let filtered = allFetchedClasses;
    const term = searchInput?.value.toLowerCase() || '';
    const teacherId = filterTeacher?.value || '';

    if (term) filtered = filtered.filter(c => c.className.toLowerCase().includes(term));
    if (teacherId) filtered = filtered.filter(c => c.teachers && c.teachers.some(t => t.id === teacherId));

    if (!filtered.length) {
        tbody.innerHTML = `<tr><td colspan="9" class="px-6 py-16 text-center text-slate-400 italic font-semibold">No classes match the filter criteria.</td></tr>`;
        return;
    }

    tbody.innerHTML = filtered.map(c => {
        const teacherCell = c.teachers && c.teachers.length
            ? `<div class="flex flex-wrap items-center gap-1.5">${c.teachers.map(t =>
                `<span class="inline-flex items-center gap-1.5 bg-blue-50 border border-blue-100 rounded-lg pr-2.5 pl-1 py-1">
                    <span class="h-6 w-6 bg-blue-100 text-blue-700 rounded-md flex items-center justify-center font-black text-[10px]">${escHtml(t.name || '?').charAt(0)}</span>
                    <span class="font-bold text-slate-700 text-[12px]">${escHtml(t.name)}</span>
                 </span>`).join('')}</div>`
            : '<span class="text-slate-400 font-semibold text-sm italic">Unassigned</span>';

        return `
        <tr class="gb-row hover:bg-slate-50 transition">
            <td class="px-6 py-4">
                <div class="flex items-center gap-3">
                    <div class="w-10 h-10 bg-gradient-to-br from-indigo-500 to-blue-600 text-white rounded-xl flex items-center justify-center font-black text-sm shadow-sm">${escHtml(c.className.charAt(0))}</div>
                    <span class="font-black text-slate-800">${escHtml(c.className)}</span>
                </div>
            </td>
            <td class="px-6 py-4">${teacherCell}</td>
            <td class="px-6 py-4 text-center"><span class="bg-indigo-50 text-indigo-700 font-black text-sm px-3 py-1 rounded-lg border border-indigo-200">${c.studentCount}</span></td>
            <td class="px-6 py-4 text-center"><span class="bg-slate-100 text-slate-600 font-bold text-xs px-3 py-1 rounded-lg border border-slate-200">${c.subjectCount}</span></td>
            <td class="px-6 py-4 text-center">${c.classAvg !== null ? `<span class="${gradeColorClass(c.classAvg)} font-black">${c.classAvg}% · ${letterGrade(c.classAvg)}</span>` : '<span class="text-slate-400">—</span>'}</td>
            <td class="px-6 py-4 text-center">${c.highest !== null ? `<span class="g-a font-black">${c.highest}%</span>` : '<span class="text-slate-400">—</span>'}</td>
            <td class="px-6 py-4 text-center">${c.lowest !== null ? `<span class="${gradeColorClass(c.lowest)} font-black">${c.lowest}%</span>` : '<span class="text-slate-400">—</span>'}</td>
            <td class="px-6 py-4 text-center">${c.atRisk ? `<span class="font-black text-red-600 bg-red-50 border border-red-200 px-2 py-0.5 rounded-lg text-xs">${c.atRisk}</span>` : '<span class="text-slate-400 font-semibold">0</span>'}</td>
            <td class="px-6 py-4 text-right"><button onclick="window.openClassPanel('${escAttr(c.className)}')" class="bg-white hover:bg-indigo-50 text-indigo-600 font-bold px-4 py-2 rounded-lg text-xs transition border border-slate-200 hover:border-indigo-200">View Details</button></td>
        </tr>`;
    }).join('');
}

searchInput?.addEventListener('input', renderTable);
filterTeacher?.addEventListener('change', renderTable);

// ── 10. SIDE PANEL ────────────────────────────────────────────────────────
window.switchClassTab = function(tabName) {
    document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`.panel-tab[data-tab="${tabName}"]`)?.classList.add('active');
    renderPanelContent(tabName);
};

window.openClassPanel = function(className) {
    currentClassName = className;
    const classData = classDataMap.get(className);

    document.getElementById('cpPanelTitle').textContent = className;
    document.getElementById('cpPanelAvatar').textContent = className.charAt(0).toUpperCase();

    const semName = globalPeriodSelect.options[globalPeriodSelect.selectedIndex]?.text || '';
    const sCount  = classData ? classData.studentCount : (studentCountByClass[className] || 0);
    const tCount  = classData && classData.teachers ? classData.teachers.length : (teacherCountByClass[className] || 0);
    document.getElementById('cpPanelMeta').textContent =
        `${semName} · ${tCount} teacher${tCount !== 1 ? 's' : ''} · ${sCount} student${sCount !== 1 ? 's' : ''}`;

    window.switchClassTab('overview');
    openOverlay('classPanel', 'classPanelInner', true);
};

window.closeClassPanel = function() { closeOverlay('classPanel', 'classPanelInner', true); };

function renderPanelContent(tab) {
    const data = classDataMap.get(currentClassName);
    const container = document.getElementById('classPanelBody');

    // A managed class with no activity yet won't be in classDataMap with data,
    // but buildPerformanceData seeds all managed classes, so this is defensive.
    if (!data) {
        container.innerHTML = `<div class="bg-white border border-slate-200 rounded-2xl p-10 text-center text-slate-400 font-semibold">No data available for this class yet.</div>`;
        return;
    }

    if (tab === 'overview') {
        const { teachers, students, grades, classAvg, studentCount, atRisk, gradeTypes } = data;

        const dist = { a: 0, b: 0, c: 0, d: 0, f: 0 };
        const stuAvgData = students.map(s => {
            const sg = grades.filter(g => g.studentId === s.id);
            const avg = sg.length ? calculateWeightedAverage(sg, gradeTypes) : null;
            if (avg !== null) {
                if (avg >= 90) dist.a++; else if (avg >= 80) dist.b++; else if (avg >= 70) dist.c++; else if (avg >= 65) dist.d++; else dist.f++;
            }
            return { ...s, avg };
        });
        const totalGraded = stuAvgData.filter(s => s.avg !== null).length || 1;

        const teacherBlock = teachers && teachers.length
            ? `<div class="space-y-2 mb-6">${teachers.map(t => `
                <div class="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm flex items-center gap-4">
                    <div class="h-11 w-11 bg-gradient-to-br from-blue-500 to-blue-600 text-white rounded-xl flex items-center justify-center font-black text-base shadow-sm flex-shrink-0">${escHtml(t.name).charAt(0)}</div>
                    <div class="min-w-0">
                        <p class="font-black text-slate-800 text-[14px]">${escHtml(t.name)}</p>
                        <p class="text-xs text-slate-400 font-semibold truncate">${escHtml(t.email || 'No email on file')}${t.phone ? ' · ' + escHtml(t.phone) : ''}</p>
                    </div>
                    <span class="ml-auto text-[10px] font-black text-emerald-600 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-lg uppercase tracking-wide">Active</span>
                </div>`).join('')}</div>`
            : '<div class="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-sm font-bold text-amber-700 mb-6"><i class="fa-solid fa-triangle-exclamation mr-2"></i>No teacher assigned to this class yet.</div>';

        container.innerHTML = `
            ${teacherBlock}

            <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
                <div class="stat-tile text-center">
                    <p class="sec-label mb-1">Class Avg</p>
                    <p class="text-3xl font-black ${classAvg !== null ? gradeColorClass(classAvg) : 'text-slate-400'}">${classAvg !== null ? classAvg + '%' : '—'}</p>
                </div>
                <div class="stat-tile text-center">
                    <p class="sec-label mb-1">Students</p>
                    <p class="text-3xl font-black text-indigo-600">${studentCount}</p>
                </div>
                <div class="stat-tile text-center">
                    <p class="sec-label mb-1">Teachers</p>
                    <p class="text-3xl font-black text-blue-600">${teachers ? teachers.length : 0}</p>
                </div>
                <div class="stat-tile text-center">
                    <p class="sec-label mb-1">At Risk</p>
                    <p class="text-3xl font-black ${atRisk ? 'text-red-600' : 'text-emerald-600'}">${atRisk}</p>
                </div>
            </div>

            <div class="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm mb-6">
                <h4 class="sec-label mb-3">Grade Distribution</h4>
                <div class="dist-bar h-4 bg-slate-100 rounded-full overflow-hidden flex">
                    ${dist.a ? `<div class="bg-emerald-500 h-full transition-all" style="width:${dist.a / totalGraded * 100}%"></div>` : ''}
                    ${dist.b ? `<div class="bg-blue-500 h-full transition-all" style="width:${dist.b / totalGraded * 100}%"></div>` : ''}
                    ${dist.c ? `<div class="bg-teal-500 h-full transition-all" style="width:${dist.c / totalGraded * 100}%"></div>` : ''}
                    ${dist.d ? `<div class="bg-amber-500 h-full transition-all" style="width:${dist.d / totalGraded * 100}%"></div>` : ''}
                    ${dist.f ? `<div class="bg-red-500 h-full transition-all" style="width:${dist.f / totalGraded * 100}%"></div>` : ''}
                    ${(dist.a===0 && dist.b===0 && dist.c===0 && dist.d===0 && dist.f===0) ? `<div class="bg-slate-300 h-full w-full"></div>` : ''}
                </div>
                <div class="flex gap-4 mt-4 flex-wrap">
                    ${[['A (90+)', dist.a, 'bg-emerald-500'], ['B (80+)', dist.b, 'bg-blue-500'], ['C (70+)', dist.c, 'bg-teal-500'], ['D (65+)', dist.d, 'bg-amber-500'], ['F (<65)', dist.f, 'bg-red-500']].map(([l, n, col]) => `<div class="flex items-center gap-1.5"><div class="w-3 h-3 rounded-sm ${col}"></div><span class="text-xs font-black text-slate-600">${l}: ${n}</span></div>`).join('')}
                </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div class="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
                    <h4 class="text-xs font-black text-emerald-600 uppercase tracking-wider mb-4 border-b border-emerald-100 pb-2 flex items-center gap-2"><i class="fa-solid fa-arrow-trend-up"></i> Top Performers (85%+)</h4>
                    <div class="space-y-2">
                        ${stuAvgData.filter(s => s.avg !== null && s.avg >= 85).sort((a,b) => b.avg - a.avg).map(s => `<div class="flex justify-between items-center text-sm"><span class="font-bold text-slate-700">${escHtml(s.name)}</span><span class="font-black text-emerald-600">${s.avg}%</span></div>`).join('') || '<p class="text-sm text-slate-400 italic">No students above 85% yet.</p>'}
                    </div>
                </div>
                <div class="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
                    <h4 class="text-xs font-black text-red-600 uppercase tracking-wider mb-4 border-b border-red-100 pb-2 flex items-center gap-2"><i class="fa-solid fa-triangle-exclamation"></i> At-Risk Students (&lt;65%)</h4>
                    <div class="space-y-2">
                        ${stuAvgData.filter(s => s.avg !== null && s.avg < 65).sort((a,b) => a.avg - b.avg).map(s => `<div class="flex justify-between items-center text-sm"><span class="font-bold text-slate-700">${escHtml(s.name)}</span><span class="font-black text-red-600">${s.avg}%</span></div>`).join('') || '<p class="text-sm text-slate-400 italic">No students at risk.</p>'}
                    </div>
                </div>
            </div>
        `;
    }

    else if (tab === 'teachers') {
        const { teachers } = data;
        if (!teachers || !teachers.length) {
            container.innerHTML = `<div class="bg-amber-50 border border-amber-200 rounded-2xl p-6 text-center text-amber-700 font-bold"><i class="fa-solid fa-triangle-exclamation mr-2"></i>No teachers assigned to this class yet.</div>`;
            return;
        }
        container.innerHTML = `
            <p class="text-[12px] font-bold text-slate-500 mb-4">${teachers.length} teacher${teachers.length !== 1 ? 's' : ''} assigned to ${escHtml(currentClassName)}</p>
            <div class="space-y-3">
                ${teachers.map(t => {
                    const subjects = (t.subjects || []).filter(s => typeof s === 'string' || !s.archived).map(s => s.name || s);
                    return `
                    <div class="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
                        <div class="flex items-center gap-4">
                            <div class="h-12 w-12 bg-gradient-to-br from-blue-500 to-blue-600 text-white rounded-xl flex items-center justify-center font-black text-lg shadow-sm flex-shrink-0">${escHtml(t.name).charAt(0)}</div>
                            <div class="min-w-0 flex-1">
                                <p class="font-black text-slate-800 text-[15px]">${escHtml(t.name)}</p>
                                <p class="text-[11px] font-mono text-slate-400 uppercase tracking-wider">${escHtml(t.id)}</p>
                            </div>
                        </div>
                        <div class="grid grid-cols-2 gap-2 mt-4">
                            <div class="bg-slate-50 border border-slate-100 rounded-lg p-2.5">
                                <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-0.5">Email</p>
                                <p class="text-[12px] font-bold text-slate-700 truncate">${escHtml(t.email) || '—'}</p>
                            </div>
                            <div class="bg-slate-50 border border-slate-100 rounded-lg p-2.5">
                                <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-0.5">Phone</p>
                                <p class="text-[12px] font-bold text-slate-700">${escHtml(t.phone) || '—'}</p>
                            </div>
                        </div>
                        ${subjects.length ? `<div class="mt-3 flex flex-wrap gap-1.5">${subjects.map(s => `<span class="text-[10px] font-bold bg-indigo-50 text-indigo-600 border border-indigo-100 px-2 py-1 rounded">${escHtml(s)}</span>`).join('')}</div>` : ''}
                    </div>`;
                }).join('')}
            </div>`;
    }

    else if (tab === 'subjects') {
        const { grades, gradeTypes } = data;
        const bySubject = {};
        grades.forEach(g => {
            const sub = g.subject || 'Uncategorized';
            if (!bySubject[sub]) bySubject[sub] = [];
            bySubject[sub].push(g);
        });

        const subjectHtml = Object.entries(bySubject).sort((a, b) => a[0].localeCompare(b[0])).map(([sub, sg]) => {
            const avg = calculateWeightedAverage(sg, gradeTypes);
            const assessments = [...new Set(sg.map(g => g.title))].map(title => {
                const ag = sg.filter(x => x.title === title);
                const aAvg = Math.round(ag.reduce((a, x) => a + (x.max ? x.score / x.max * 100 : 0), 0) / ag.length);
                return `<div class="flex justify-between py-2 border-b border-slate-200 last:border-0 text-sm"><span class="font-semibold text-slate-600">${escHtml(title)}</span><b class="${gradeColorClass(aAvg)}">${aAvg}%</b></div>`;
            }).join('');

            return `
                <div class="bg-white border border-slate-200 rounded-xl mb-3 overflow-hidden shadow-sm">
                    <div class="px-5 py-4 flex justify-between items-center cursor-pointer hover:bg-slate-50 transition" onclick="this.nextElementSibling.classList.toggle('open'); this.querySelector('.fa-chevron-down').classList.toggle('rotate-180');">
                        <span class="font-black text-slate-700 text-sm">${escHtml(sub)}</span>
                        <span class="font-black ${gradeColorClass(avg)} text-sm">${avg}% · ${letterGrade(avg)} <i class="fa-solid fa-chevron-down ml-3 text-slate-300 transition-transform duration-200"></i></span>
                    </div>
                    <div class="subject-body bg-slate-50">
                        <div class="px-5 pb-4 pt-2 border-t border-slate-100 flex flex-col gap-1">${assessments}</div>
                    </div>
                </div>`;
        }).join('');

        container.innerHTML = subjectHtml || '<p class="text-center py-10 text-slate-400 italic">No subject data found for this class.</p>';
    }

    else if (tab === 'students') {
        const { students, grades, gradeTypes } = data;

        const stuRows = students.map(s => {
            const sg = grades.filter(g => g.studentId === s.id);
            const avg = sg.length ? calculateWeightedAverage(sg, gradeTypes) : null;
            return { ...s, avg, gradeCount: sg.length };
        }).sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1)).map(s => `
            <tr class="hover:bg-slate-50 transition gb-row">
                <td class="px-5 py-3">
                    <div class="flex items-center gap-3">
                        <div class="h-8 w-8 bg-gradient-to-br from-slate-200 to-slate-300 text-slate-600 rounded-lg flex items-center justify-center font-black text-xs flex-shrink-0">${(s.name || '?').charAt(0).toUpperCase()}</div>
                        <span class="font-bold text-slate-700 text-sm">${escHtml(s.name || 'Unnamed')}</span>
                    </div>
                </td>
                <td class="px-5 py-3 text-center ${s.avg !== null ? gradeColorClass(s.avg) : 'text-slate-400'} font-black text-sm">${s.avg !== null ? s.avg + '%' : '—'}</td>
                <td class="px-5 py-3 text-center">${standingBadge(s.avg)}</td>
                <td class="px-5 py-3 text-center text-slate-500 font-semibold text-xs">${s.gradeCount}</td>
                <td class="px-5 py-3 text-right"><a href="../students/students.html?viewStudent=${escAttr(s.id)}" class="text-[11px] font-black text-indigo-600 bg-indigo-50 border border-indigo-200 px-3 py-1.5 rounded hover:bg-indigo-600 hover:text-white transition inline-block">View Profile</a></td>
            </tr>`).join('');

        container.innerHTML = `
            <div class="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
                <table class="w-full text-left">
                    <thead class="bg-slate-50 text-[10px] uppercase font-black text-slate-400 border-b border-slate-200 tracking-wider">
                        <tr><th class="px-5 py-4">Student</th><th class="px-5 py-4 text-center">Avg</th><th class="px-5 py-4 text-center">Standing</th><th class="px-5 py-4 text-center">Grades</th><th class="px-5 py-4"></th></tr>
                    </thead>
                    <tbody class="divide-y divide-slate-100">${stuRows || '<tr><td colspan="5" class="px-5 py-10 text-center text-slate-400 italic">No students enrolled in this class.</td></tr>'}</tbody>
                </table>
            </div>`;
    }
}

// ── 11. PRINT (unchanged behaviour, multi-teacher aware) ────────────────────
window.executeClassPrint = async function() {
    const data = classDataMap.get(currentClassName);
    if (!data) return;

const semName = globalPeriodSelect.options[globalPeriodSelect.selectedIndex]?.text || 'Active Term';
    
    let schoolName = session.schoolName || '';
    try {
        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        if (schoolSnap.exists()) schoolName = schoolSnap.data().schoolName || schoolName;
    } catch (e) {
        console.error("Error fetching school name:", e);
    }

    const { className, teachers, students, grades, classAvg, gradeTypes } = data;
    const teacherNames = teachers && teachers.length ? teachers.map(t => t.name).join(', ') : 'Unassigned';

    const stuData = students.map(s => {
        const sg = grades.filter(g => g.studentId === s.id);
        const avg = sg.length ? calculateWeightedAverage(sg, gradeTypes) : null;
        return { name: s.name, avg };
    }).sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1));

    const studentRowsHtml = stuData.map(s => `
        <tr>
            <td style="padding:8px 12px; border-bottom:1px solid #e2e8f0; color:#1e293b; font-weight:600;">${escHtml(s.name)}</td>
            <td style="padding:8px 12px; border-bottom:1px solid #e2e8f0; text-align:center; font-weight:bold; color:${s.avg !== null && s.avg < 60 ? '#e31b4a' : '#0f172a'};">${s.avg !== null ? s.avg + '%' : '—'}</td>
        </tr>`).join('');

    const bySubject = {};
    grades.forEach(g => {
        const sub = g.subject || 'Uncategorized';
        if (!bySubject[sub]) bySubject[sub] = [];
        bySubject[sub].push(g);
    });

    const subjectRowsHtml = Object.entries(bySubject).sort((a, b) => a[0].localeCompare(b[0])).map(([sub, sg]) => {
        const avg = calculateWeightedAverage(sg, gradeTypes);
        return `<tr><td style="padding:8px 12px; border-bottom:1px solid #e2e8f0; color:#1e293b; font-weight:600;">${escHtml(sub)}</td><td style="padding:8px 12px; border-bottom:1px solid #e2e8f0; text-align:center; font-weight:bold;">${avg}%</td></tr>`;
    }).join('') || '<tr><td colspan="2" style="padding:15px; text-align:center; color:#64748b; font-style:italic;">No subject data found.</td></tr>';

    const html = `
    <!DOCTYPE html><html><head><title>Class Report — ${escHtml(className)}</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&display=swap');
        body { font-family: 'Nunito', sans-serif; padding: 40px; color: #0f172a; line-height: 1.5; margin: 0 auto; max-width: 8.5in; }
        .header-flex { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px solid #4f46e5; padding-bottom: 20px; margin-bottom: 30px; }
        .header-text { text-align: right; }
        .header-text h1 { margin: 0 0 5px; font-size: 24px; font-weight: 900; text-transform: uppercase; color: #4f46e5; }
        .header-text h2 { margin: 0; font-size: 14px; color: #64748b; font-weight: 700; letter-spacing: 2px; }
        .meta-grid { display: flex; gap: 15px; margin-bottom: 30px; }
        .meta-card { flex: 1; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 15px; }
        .meta-lbl { font-size: 10px; font-weight: 800; color: #64748b; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 5px; display:block;}
        .meta-val { font-size: 16px; font-weight: 800; color: #0f172a; line-height: 1.2; }
        .data-section { display: flex; gap: 30px; }
        .data-col { flex: 1; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; border: 1px solid #e2e8f0; }
        th { background: #4f46e5; color: #fff; padding: 8px 12px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; }
        th.center { text-align: center; }
        .footer { margin-top: 50px; text-align: center; font-size: 11px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 20px; font-weight: 600; }
    </style></head><body>
        <div class="header-flex">
            <div>
                <h1 style="margin:0; font-size: 28px; font-weight:900; color:#0f172a;">${escHtml(className)}</h1>
                <p style="margin:5px 0 0; color:#64748b; font-weight:700;">${escHtml(semName)}</p>
            </div>
            <div class="header-text">
                <h1>${escHtml(schoolName)}</h1>
                <h2>OFFICIAL CLASS REPORT</h2>
            </div>
        </div>
        <div class="meta-grid">
            <div class="meta-card">
                <span class="meta-lbl">Assigned Teacher(s)</span>
                <span class="meta-val">${escHtml(teacherNames)}</span>
            </div>
            <div class="meta-card" style="text-align:center;">
                <span class="meta-lbl">Total Students</span>
                <span class="meta-val">${students.length}</span>
            </div>
            <div class="meta-card" style="text-align:center; background:#eef2ff; border-color:#c7d2fe;">
                <span class="meta-lbl" style="color:#4f46e5;">Class Average</span>
                <span class="meta-val" style="color:#4f46e5; font-size:22px;">${classAvg !== null ? classAvg + '%' : 'N/A'}</span>
            </div>
        </div>
        <div class="data-section">
            <div class="data-col">
                <h3 style="font-size:14px; font-weight:800; color:#0f172a; border-bottom:2px solid #e2e8f0; padding-bottom:5px; margin-bottom:15px;">Student Roster</h3>
                <table><thead><tr><th>Student Name</th><th class="center">Cum. Avg</th></tr></thead><tbody>${studentRowsHtml}</tbody></table>
            </div>
            <div class="data-col">
                <h3 style="font-size:14px; font-weight:800; color:#0f172a; border-bottom:2px solid #e2e8f0; padding-bottom:5px; margin-bottom:15px;">Subject Averages</h3>
                <table><thead><tr><th>Subject</th><th class="center">Class Avg</th></tr></thead><tbody>${subjectRowsHtml}</tbody></table>
            </div>
        </div>
        <div class="footer">Generated on ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })} · Powered by ConnectUs</div>
    </body></html>`;

    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
    setTimeout(() => w.print(), 800);
};

// ── BOOT ────────────────────────────────────────────────────────────────────
async function init() {
    await loadManagedClasses();   // master list first so cards can render
    renderClassCards();           // render immediately (counts fill after fetch)
    await loadSemestersDropdown();
    await fetchAndProcessClassData();
}

document.addEventListener('DOMContentLoaded', init);
