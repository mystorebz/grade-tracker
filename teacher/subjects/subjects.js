import { db } from '../../assets/js/firebase-init.js';
import { collection, query, where, getDocs, getDoc, doc, updateDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth, setSessionData } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { openOverlay, closeOverlay, showMsg, gradeColorClass, calculateWeightedAverage, loadTeacherSubjectsCache, getTeacherDocRef, resolveGradeWeights } from '../../assets/js/utils.js';
import { resolvePostContext } from '../../assets/js/posts.js';

// ── 1. AUTHENTICATION & LAYOUT ──────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    injectTeacherLayout('subjects', 'Subjects Overview', 'Performance by subject for the active period', false);
}

// ── 2. STATE VARIABLES ──────────────────────────────────────────────────────
let allStudentsCache = [];
let studentMap = {}; // Maps ID to full student object (includes className)
let allGradesCache = null;
let rawSemesters = [];
let isSemesterLocked = false;


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

    // Returning to the grid repaints the last render instantly (sessionStorage),
    // then everything below refreshes it in place.
    const cachedGrid = readGridCache();
    if (cachedGrid) document.getElementById('subjectsGrid').innerHTML = cachedGrid.html;

    // Independent reads run concurrently (previously ~4 sequential round trips).
    const [, , , weights] = await Promise.all([
        loadSemestersAndLockStatus(),
        loadStudents(),
        loadSubjectsCache(),
        resolveGradeWeights(session.schoolId, session.teacherId, { legacyTeacherData: session.teacherData })
            .catch(e => { console.error('[Subjects] Failed to resolve grade weights:', e); return null; }),
    ]);
    resolvedGradeTypes = weights;
    await loadSubjectsTab();
}

// ── GRID SESSION CACHE (instant repaint on return) ───────────────────────
const GRID_CACHE_TTL_MS = 30 * 60 * 1000;
function gridCacheKey() { return `cu:subjects-grid:v1:${session.schoolId}:${session.teacherId}`; }
function readGridCache() {
    try {
        const v = JSON.parse(sessionStorage.getItem(gridCacheKey()) || 'null');
        return v && Date.now() - v.at < GRID_CACHE_TTL_MS ? v : null;
    } catch (e) { return null; }
}
function writeGridCache(semId, html) {
    try { sessionStorage.setItem(gridCacheKey(), JSON.stringify({ at: Date.now(), semId, html })); } catch (e) { /* quota/private mode */ }
}

async function loadSemestersAndLockStatus() {
    try {
        const [semSnap, schoolSnap] = await Promise.all([
            getDocs(collection(db, 'schools', session.schoolId, 'semesters')),
            getDoc(doc(db, 'schools', session.schoolId)),
        ]);
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

    const semId = document.getElementById('activeSemester').value;
    const semName = document.getElementById('activeSemester').options[document.getElementById('activeSemester').selectedIndex]?.text || '—';

    const sbPeriod = document.getElementById('sb-period');
    if (sbPeriod) sbPeriod.textContent = semName;

    // Lazy stats: paint the tiles from the subjects cache right away; the
    // per-student grade reads fill in the numbers when they arrive.
    const gradesPromise = getAllGrades(semId);
    const cachedForSem = readGridCache();
    if (!(cachedForSem && cachedForSem.semId === semId && grid.querySelector('.subject-tile'))) {
        renderSubjectTiles(grid, null);
    }
    const allGrades = await gradesPromise;
    renderSubjectTiles(grid, allGrades);
    writeGridCache(semId, grid.innerHTML);
}

// allGrades === null → stats pending (rendered as "…").
function renderSubjectTiles(grid, allGrades) {
    const pending = allGrades === null;
    allGrades = allGrades || [];
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
        const sg = allGrades.filter(g => g.subjectId
            ? g.subjectId === sub.id && (!sub.classId || g.classId === sub.classId)
            : g.subject === sub.name);
        const stuIds = [...new Set(sg.map(g => g.studentId))];
        const stuAvgs = stuIds.map(sid => {
            const sg2 = sg.filter(g => g.studentId === sid);
            return calculateWeightedAverage(sg2, getGradeTypes());
        }).filter(a => a !== null);

        const classAvg = stuAvgs.length ? Math.round(stuAvgs.reduce((a, b) => a + b, 0) / stuAvgs.length) : null;
        const atRisk = stuAvgs.filter(a => a < 65).length;
        const lastGraded = sg.length ? sg.sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0].date : null;
        const asgCount = Array.isArray(sub.assignments) ? sub.assignments.length : 0;
        const gradient = gradientFor(sub.name);
        const safeName = sub.name.replace(/'/g, "\\'");
        // Dedicated subject page (teacher/subjects/subject.html). Real link, so
        // middle-click / open-in-new-tab / Back all work. A subject that is still
        // legacy-only (not yet migrated into classes/{c}/subjects) has no page.
        const ctx = resolvePostContext(sub, resolvedClasses);
        const href = sub._source === 'new' && ctx
            ? `subject.html?${new URLSearchParams({ c: ctx.classId, s: sub.id })}`
            : null;
        const tag = href ? 'a' : 'div';

        return `
        <${tag} ${href ? `href="${escHtml(href)}"` : 'aria-disabled="true" title="Not migrated yet — run migrations/01-subjects-and-grades.js"'}
            class="subject-tile group relative text-left bg-white border border-slate-200 rounded-3xl p-5 shadow-sm ${href ? 'hover:shadow-xl hover:border-teal-300 hover:-translate-y-1 cursor-pointer' : 'opacity-60 cursor-not-allowed'} transition-all duration-200 flex flex-col no-underline text-inherit focus:outline-none focus:ring-2 focus:ring-teal-400 focus:ring-offset-2">
            <button type="button" onclick="event.preventDefault(); event.stopPropagation(); archiveSubject('${sub.id}', '${safeName}')" title="Archive subject"
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
                    <p class="text-base font-black text-slate-700">${pending ? '…' : stuIds.length}</p>
                </div>
                <div class="bg-slate-50 rounded-xl py-2 px-1 text-center border border-slate-100">
                    <p class="text-[9px] font-black text-slate-400 uppercase tracking-wider">Class avg</p>
                    <p class="text-base font-black ${classAvg !== null ? gradeColorClass(classAvg) : 'text-slate-300'}">${pending ? '…' : classAvg !== null ? classAvg + '%' : '—'}</p>
                </div>
                <div class="bg-teal-50 rounded-xl py-2 px-1 text-center border border-teal-100">
                    <p class="text-[9px] font-black text-teal-500 uppercase tracking-wider">Tasks</p>
                    <p class="text-base font-black text-teal-700">${asgCount}</p>
                </div>
            </div>
            <div class="flex items-center justify-between mt-3 pt-3 border-t border-slate-100">
                <span class="text-[11px] font-bold text-slate-400">${pending ? 'Loading grades…' : `${sg.length} grade${sg.length !== 1 ? 's' : ''} logged`}</span>
                <span class="text-[11px] font-bold text-slate-400">${pending ? '' : lastGraded ? 'Last: ' + lastGraded : 'Not graded'}</span>
            </div>
        </${tag}>`;
    }).join('');
}

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

// Fire it up
init();
