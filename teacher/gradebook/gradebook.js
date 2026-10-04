import { db } from '../../assets/js/firebase-init.js';
import { collection, query, where, getDocs, getDoc, doc, updateDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth, setSessionData } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { openOverlay, closeOverlay, showMsg, gradeColorClass, gradeFill, letterGrade, downloadCSV, calculateWeightedAverage, resolveGradeWeights, saveTeacherWeightingEverywhere, loadSchoolClasses, resolveClassNamesToIds } from '../../assets/js/utils.js';

// ── 1. AUTH & LAYOUT ─────────────────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    injectTeacherLayout('gradebook', 'Gradebook', 'Complete grade record for the selected period', false);
}

// ── 2. STATE ─────────────────────────────────────────────────────────────────
let allStudentsCache = [];
let allGradesCache   = null;
let studentMap       = {};
let gradeDetailCache = {};
let rawSemesters     = [];
let isSemesterLocked = false;
let currentEditData  = null;
let originalScore    = null;
let originalMax      = null;

let sfStudentValue = '';
let sfSubjectValue = '';
let sfTypeValue    = '';

// Roster source of truth: the teacher's active class (classId), never the
// student doc's teacherId — a teacher can share students' teacherId across
// classes, which leaked other classes' students into this grid.
let teacherClasses   = [];     // [{ id, name }]
let activeClass      = null;   // { id, name } | null (null = legacy fallback)

// Category (grade type) collapse state. collapseDefault applies to every
// category without an explicit per-category override.
let collapseDefault  = true;
const catOverrides   = new Map();

// ── THE "PERFECT 100" DEFAULT SYLLABUS ──
const DEFAULT_GRADE_TYPES = [
    { name: 'Test', weight: 30 },
    { name: 'Quiz', weight: 20 },
    { name: 'Project', weight: 20 },
    { name: 'Assignment', weight: 20 },
    { name: 'Homework', weight: 10 }
];

// PHASE 0: resolvedWeighting is populated once, in init(), from
// teaching_assignments (falling back to the legacy teacher-doc fields
// internally) via resolveGradeWeights() in utils.js. getGradeTypes() still
// falls back to the legacy fields directly below it, so if that initial
// resolution ever fails for any reason, behavior is identical to before
// this existed — nobody's numbers change as a side effect of this fix.
let resolvedWeighting = null;

async function loadResolvedWeighting() {
    try {
        resolvedWeighting = await resolveGradeWeights(session.schoolId, session.teacherId, { legacyTeacherData: session.teacherData });
    } catch (e) {
        console.error('[Gradebook] loadResolvedWeighting:', e);
        resolvedWeighting = null;
    }
}

function getGradeTypes() {
    const types = resolvedWeighting || session.teacherData.gradeTypes || session.teacherData.customGradeTypes;
    if (!types || types.length === 0) return DEFAULT_GRADE_TYPES;

    // Convert legacy flat strings into editable objects with 0 weight
    return types.map(t => typeof t === 'string' ? { name: t, weight: 0 } : t);
}

// ── 3. SEARCHABLE SELECT COMPONENT ───────────────────────────────────────────
function buildSearchableFilter(key, items, onSelect) {
    const input    = document.getElementById(`sf${cap(key)}Input`);
    const dropdown = document.getElementById(`sf${cap(key)}Dropdown`);
    const clearBtn = document.getElementById(`sf${cap(key)}Clear`);
    if (!input || !dropdown) return;

    let selectedId = '';
    function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

    function renderDropdown(term) {
        const t = (term || '').toLowerCase();
        const filtered = t ? items.filter(i => i.label.toLowerCase().includes(t)) : items;

        let html = `<div class="sf-item sf-all${!selectedId ? ' sf-selected' : ''}" data-id="">All</div>`;
        if (filtered.length === 0) html += `<div class="sf-no-results">No results for "${term}"</div>`;
        else html += filtered.map(i => `<div class="sf-item${i.id === selectedId ? ' sf-selected' : ''}" data-id="${escHtml(i.id)}">${escHtml(i.label)}</div>`).join('');
        
        dropdown.innerHTML = html; dropdown.classList.add('sf-open');
    }

    function close() { dropdown.classList.remove('sf-open'); }

    function select(id, label) {
        selectedId = id; input.value = id ? label : '';
        clearBtn.style.display = id ? 'block' : 'none';
        close(); onSelect(id);
    }

    input.addEventListener('focus', () => renderDropdown(input.value));
    input.addEventListener('input', () => renderDropdown(input.value));

    dropdown.addEventListener('mousedown', (e) => {
        e.preventDefault(); 
        const item = e.target.closest('.sf-item');
        if (!item) return;
        const id = item.dataset.id;
        const label = id ? items.find(i => i.id === id)?.label || '' : '';
        select(id, label);
    });

    document.addEventListener('click', (e) => {
        const wrap = document.getElementById(`sf${cap(key)}Wrap`);
        if (wrap && !wrap.contains(e.target)) close();
    });

    return { clear: () => select('', ''), setItems: (newItems) => { items = newItems; if (selectedId && !items.find(i => i.id === selectedId)) select('', ''); }, getValue: () => selectedId };
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

let sfStudent, sfSubject, sfType;
window.clearSF = function(key) {
    if (key === 'student' && sfStudent) sfStudent.clear();
    if (key === 'subject' && sfSubject) sfSubject.clear();
    if (key === 'type'    && sfType)    sfType.clear();
};

// ── 4. INIT ───────────────────────────────────────────────────────────────────
async function init() {
    if (!session) return;

    document.getElementById('displayTeacherName').textContent = session.teacherData.name;
    document.getElementById('teacherAvatar').textContent      = session.teacherData.name.charAt(0).toUpperCase();
    document.getElementById('sidebarSchoolId').textContent    = session.schoolId;
    const classes = session.teacherData.classes || [session.teacherData.className || ''];
    document.getElementById('displayTeacherClasses').innerHTML = classes.filter(Boolean).map(c => `<span class="class-pill">${c}</span>`).join('');

    await loadResolvedWeighting();

    sfType = buildSearchableFilter('type', getGradeTypes().filter(t => t).map(t => {
        const name = t.name || (typeof t === 'string' ? t : 'Uncategorized'); 
        return { id: name, label: name }; 
    }), (val) => { sfTypeValue = val; applyGradebookFilters(); });
    
    sfStudent = buildSearchableFilter('student', [], (val) => { sfStudentValue = val; applyGradebookFilters(); });

    document.getElementById('updateGradeBtn').addEventListener('click', saveEditedGrade);

    document.getElementById('gbCollapseAllBtn')?.addEventListener('click', toggleAllCategories);
    document.getElementById('gbClassSelect')?.addEventListener('change', (e) => {
        activeClass = teacherClasses.find(c => c.id === e.target.value) || null;
        try { localStorage.setItem(activeClassStorageKey(), activeClass?.id || ''); } catch (_) {}
        allGradesCache = null;
        sfStudentValue = ''; if (sfStudent) sfStudent.clear();
        loadStudents().then(loadGradebook);
    });

    await Promise.all([loadSemestersAndLockStatus(), loadTeacherClasses().then(loadStudents)]);
    await loadGradebook();
}

// ── 5. SEMESTERS ─────────────────────────────────────────────────────────────
async function loadSemestersAndLockStatus() {
    try {
        const cacheKey = `connectus_semesters_${session.schoolId}`;
        let rawSems    = [];
        const cached = localStorage.getItem(cacheKey);
        
        if (cached) { try { rawSems = JSON.parse(cached); } catch (_) { rawSems = []; } }
        if (!rawSems.length) {
            const semSnap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
            rawSems = semSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0));
            localStorage.setItem(cacheKey, JSON.stringify(rawSems));
        }

        rawSemesters = rawSems;
        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        const activeId   = schoolSnap.data()?.activeSemesterId || '';

        const semSel = document.getElementById('activeSemester');
        if (semSel) {
            semSel.innerHTML = '';
            rawSemesters.forEach(s => {
                const opt = document.createElement('option'); opt.value = s.id; opt.textContent = s.name;
                if (s.id === activeId) opt.selected = true;
                semSel.appendChild(opt);
            });

            checkLockStatus();
            const sbPeriod = document.getElementById('sb-period');
            if (sbPeriod) sbPeriod.textContent = semSel.options[semSel.selectedIndex]?.text || '—';

            semSel.addEventListener('change', () => {
                checkLockStatus(); allGradesCache = null;
                const sbP = document.getElementById('sb-period');
                if (sbP) sbP.textContent = semSel.options[semSel.selectedIndex]?.text || '—';
                loadGradebook();
            });
        }
    } catch (e) { console.error('[Gradebook] loadSemesters:', e); }
}

function checkLockStatus() {
    const semId = document.getElementById('activeSemester')?.value;
    const activeSem = rawSemesters.find(s => s.id === semId);
    isSemesterLocked = activeSem ? !!activeSem.isLocked : false;
    const badge = document.getElementById('topbarLockedBadge');
    if (badge) {
        isSemesterLocked ? badge.classList.remove('hidden') : badge.classList.add('hidden');
        isSemesterLocked ? badge.classList.add('flex') : badge.classList.remove('flex');
    }
}

// ── 6. CLASSES & STUDENTS ─────────────────────────────────────────────────────
function activeClassStorageKey() { return `connectus_gb_class_${session.schoolId}_${session.teacherId}`; }

// Teacher's classes = classes named on the teacher doc (classes[] / className)
// plus any class document listing this teacher in teacherIds.
async function loadTeacherClasses() {
    try {
        const schoolClasses = await loadSchoolClasses(session.schoolId);
        const names = session.teacherData.classes || [session.teacherData.className || ''];
        const byId = new Map();
        resolveClassNamesToIds(names, schoolClasses).resolved.forEach(c => byId.set(c.id, { id: c.id, name: c.name }));
        schoolClasses
            .filter(c => Array.isArray(c.teacherIds) && c.teacherIds.includes(session.teacherId))
            .forEach(c => byId.set(c.id, { id: c.id, name: c.name || c.id }));
        teacherClasses = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
        console.error('[Gradebook] loadTeacherClasses:', e);
        teacherClasses = [];
    }

    let savedId = '';
    try { savedId = localStorage.getItem(activeClassStorageKey()) || ''; } catch (_) {}
    activeClass = teacherClasses.find(c => c.id === savedId) || teacherClasses[0] || null;

    const sel  = document.getElementById('gbClassSelect');
    const wrap = document.getElementById('gbClassWrap');
    if (sel && wrap) {
        sel.innerHTML = teacherClasses.map(c => `<option value="${escHtml(c.id)}"${c.id === activeClass?.id ? ' selected' : ''}>${escHtml(c.name)}</option>`).join('');
        wrap.style.display = teacherClasses.length > 1 ? 'flex' : 'none';
    }
    if (!activeClass) console.warn('[Gradebook] No class resolved for this teacher — falling back to legacy teacherId roster.');
}

// Same membership test as firestore.rules studentDocInClass(): classId is the
// source of truth; className is the fallback for older student docs only.
function studentInActiveClass(s) {
    if (!activeClass) return s.teacherId === session.teacherId;
    if (s.classId) return s.classId === activeClass.id;
    return !!s.className && s.className === activeClass.name;
}

function gradeInActiveClass(g) {
    if (!activeClass) return true;
    if (g.classId) return g.classId === activeClass.id;
    if (g.className) return g.className === activeClass.name;
    return true;
}

async function loadStudents() {
    try {
        const stuSnap = await getDocs(query(collection(db, 'students'), where('currentSchoolId', '==', session.schoolId), where('enrollmentStatus', '==', 'Active')));
        allStudentsCache = stuSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(studentInActiveClass);
        studentMap = {};
        allStudentsCache.forEach(s => { studentMap[s.id] = s.name; });

        const sbStudents = document.getElementById('sb-students');
        if (sbStudents) sbStudents.textContent = allStudentsCache.length;

        if (sfStudent) sfStudent.setItems([...allStudentsCache].sort((a, b) => a.name.localeCompare(b.name)).map(s => ({ id: s.id, label: s.name })));
    } catch (e) { console.error('[Gradebook] loadStudents:', e); }
}

// ── 7. GRADE CACHE ────────────────────────────────────────────────────────────
async function getAllGrades(semId) {
    if (allGradesCache && allGradesCache.semId === semId && allGradesCache.classId === (activeClass?.id || '')) return allGradesCache.grades;
    const all = [];
    await Promise.all(allStudentsCache.map(async s => {
        try {
            const q = query(
                collection(db, 'students', s.id, 'grades'), 
                where('schoolId', '==', session.schoolId),
                where('semesterId', '==', semId)
            );
            const snap = await getDocs(q);
            snap.forEach(d => { const g = { id: d.id, studentId: s.id, studentName: s.name, ...d.data() }; if (gradeInActiveClass(g)) all.push(g); });
        } catch (e) {}
    }));
    allGradesCache = { semId, classId: activeClass?.id || '', grades: all };
    return all;
}

// ── 8. LOAD GRADEBOOK ─────────────────────────────────────────────────────────
async function loadGradebook() {
    const tbody = document.getElementById('gradebookTableBody');
    tbody.innerHTML = `<tr><td colspan="99"><div class="gb-empty"><i class="fa-solid fa-spinner fa-spin" style="color:#0ea871;"></i><p>Loading gradebook…</p></div></td></tr>`;

    const semId = document.getElementById('activeSemester')?.value;
    if (!semId) { renderGradebook(); return; }
    if (!allStudentsCache.length) await loadStudents();

    const grades = await getAllGrades(semId);

    const stuGMap = {};
    grades.forEach(g => { if (!stuGMap[g.studentId]) stuGMap[g.studentId] = []; stuGMap[g.studentId].push(g); });
    
    const riskCount = Object.values(stuGMap).filter(sg => {
        const avg = calculateWeightedAverage(sg, getGradeTypes());
        return avg !== null && avg < 65;
    }).length;
    
    const sbRisk = document.getElementById('sb-risk');
    if (sbRisk) { sbRisk.textContent = riskCount; sbRisk.classList.toggle('is-risk', riskCount > 0); }

    // Grading completeness summary (awareness only — never alters grades/averages)
    try { computeCompleteness(grades, semId); } catch (e) { console.error('[Gradebook] completeness:', e); }

    renderSubjectTabs(grades);

    renderGradebook();
}

// ── 9. RENDER ─────────────────────────────────────────────────────────────────
function renderGradebook() {
    const fText = (document.getElementById('gbSearchInput')?.value || '').toLowerCase();
    
    let rows = allGradesCache?.grades || [];
    if (sfStudentValue) rows = rows.filter(g => g.studentId === sfStudentValue);
    if (sfSubjectValue) rows = rows.filter(g => g.subject   === sfSubjectValue);
    if (sfTypeValue)    rows = rows.filter(g => g.type      === sfTypeValue);
    if (fText)          rows = rows.filter(g => (g.title || '').toLowerCase().includes(fText));

    const allRows = allGradesCache?.grades || [];
    const stuGrps = {};
    allRows.forEach(g => { if (!stuGrps[g.studentId]) stuGrps[g.studentId] = []; stuGrps[g.studentId].push(g); });
    
    const stuAvgs = Object.values(stuGrps).map(sg => calculateWeightedAverage(sg, getGradeTypes())).filter(a => a !== null);
    const avgAll  = stuAvgs.length ? Math.round(stuAvgs.reduce((a, b) => a + b, 0) / stuAvgs.length) : null;
    const allPcts = allRows.map(g => g.max ? Math.round(g.score / g.max * 100) : 0);

    const totalEl = document.getElementById('gbStatTotal');
    if (totalEl) totalEl.textContent = allRows.length || '—';

    const avgEl = document.getElementById('gbStatAvg');
    if (avgEl) { avgEl.textContent = avgAll !== null ? avgAll + '%' : '—'; avgEl.style.color = avgAll !== null ? gradeColor(avgAll) : '#0d1f35'; }

    const riskStat = Object.values(stuGrps).filter(sg => {
        const avg = calculateWeightedAverage(sg, getGradeTypes());
        return avg !== null && avg < 65;
    }).length;
    
    const riskEl = document.getElementById('gbStatRisk');
    if (riskEl) { riskEl.textContent = riskStat || '0'; riskEl.style.color = riskStat > 0 ? '#e31b4a' : '#0d1f35'; }

    const dist  = { a: 0, b: 0, c: 0, d: 0, f: 0 };
    allPcts.forEach(p => { if (p >= 90) dist.a++; else if (p >= 80) dist.b++; else if (p >= 70) dist.c++; else if (p >= 65) dist.d++; else dist.f++; });
    const tot = allPcts.length || 1;
    const distBar = document.getElementById('gbDistBar');
    if (distBar) {
        distBar.innerHTML = [
            dist.a ? `<div class="dist-seg" style="width:${dist.a/tot*100}%;background:#10b981;"></div>` : '',
            dist.b ? `<div class="dist-seg" style="width:${dist.b/tot*100}%;background:#3b82f6;"></div>` : '',
            dist.c ? `<div class="dist-seg" style="width:${dist.c/tot*100}%;background:#14b8a6;"></div>` : '',
            dist.d ? `<div class="dist-seg" style="width:${dist.d/tot*100}%;background:#f59e0b;"></div>` : '',
            dist.f ? `<div class="dist-seg" style="width:${dist.f/tot*100}%;background:#ef4444;"></div>` : '',
            !allPcts.length ? `<div style="width:100%;background:#f0f4f8;height:10px;"></div>` : ''
        ].join('');
    }

    const legendEl = document.getElementById('gbDistLegend');
    if (legendEl) {
        legendEl.innerHTML = [['A',dist.a,'#10b981'],['B',dist.b,'#3b82f6'],['C',dist.c,'#14b8a6'],['D',dist.d,'#f59e0b'],['F',dist.f,'#ef4444']]
            .map(([l,n,c]) => `<div class="dist-legend-item"><div class="dist-dot" style="background:${c};"></div>${l}: ${n}</div>`).join('');
    }

    const semSel = document.getElementById('activeSemester');
    const pbadge = document.getElementById('gbPeriodBadge');
    if (pbadge && semSel) pbadge.textContent = semSel.options[semSel.selectedIndex]?.text || '—';

    const lockedBar = document.getElementById('gbLockedBar');
    if (lockedBar) lockedBar.classList.toggle('hidden', !isSemesterLocked);

    renderGradeGrid(rows);
}

// ── 9a. SUBJECT TABS ─────────────────────────────────────────────────────────
function renderSubjectTabs(grades) {
    const el = document.getElementById('gbSubjectTabs');
    if (!el) return;
    const counts = {};
    (grades || []).forEach(g => { const k = g.subject || 'Uncategorized'; counts[k] = (counts[k] || 0) + 1; });
    const subjects = Object.keys(counts).sort((a, b) => a.localeCompare(b));
    if (sfSubjectValue && !counts[sfSubjectValue]) { sfSubjectValue = ''; collapseDefault = true; catOverrides.clear(); }

    const tab = (value, label, n) => `<button type="button" class="gb-subj-tab${sfSubjectValue === value ? ' is-active' : ''}" onclick="selectGradebookSubject('${encodeURIComponent(value)}')">${escHtml(label)}${n !== null ? `<span class="gb-subj-count">${n}</span>` : ''}</button>`;
    el.innerHTML = tab('', 'All Subjects', (grades || []).length) + subjects.map(s => tab(s, s, counts[s])).join('');
}

// All Subjects opens collapsed (category averages only); a single subject
// opens expanded. Per-category overrides reset on every subject switch.
window.selectGradebookSubject = function(encoded) {
    sfSubjectValue = decodeURIComponent(encoded);
    collapseDefault = sfSubjectValue === '';
    catOverrides.clear();
    renderSubjectTabs(allGradesCache?.grades || []);
    renderGradebook();
};

function isCatCollapsed(name) { return catOverrides.has(name) ? catOverrides.get(name) : collapseDefault; }

window.toggleGradebookCategory = function(encoded) {
    const name = decodeURIComponent(encoded);
    catOverrides.set(name, !isCatCollapsed(name));
    renderGradebook();
};

let lastRenderedCats = [];
function toggleAllCategories() {
    const anyExpanded = lastRenderedCats.some(c => !isCatCollapsed(c.name));
    collapseDefault = anyExpanded;
    catOverrides.clear();
    renderGradebook();
}

// ── 9b. STUDENT × ASSIGNMENT MATRIX (grouped by category) ────────────────────
// Column identity: assignmentId when the grade carries one; legacy/manual
// grades without one are grouped by subject + title + type + max.
function gradeColumnKey(g) {
    if (g.assignmentId) return `a:${g.assignmentId}`;
    const norm = v => String(v ?? '').trim().toLowerCase();
    return `l:${norm(g.subject)}|${norm(g.title)}|${norm(g.type)}|${norm(g.max)}`;
}

function pctBadgeClass(pct) {
    return pct >= 90 ? 'gg-a' : pct >= 80 ? 'gg-b' : pct >= 70 ? 'gg-c' : pct >= 65 ? 'gg-d' : 'gg-f';
}
function pctTone(pct) {
    if (pct === null || pct === undefined) return '';
    return pct >= 90 ? 'gb-tone-a' : pct >= 80 ? 'gb-tone-b' : pct >= 70 ? 'gb-tone-c' : pct >= 65 ? 'gb-tone-d' : 'gb-tone-f';
}
function gradePct(g) { return g.percentage !== undefined ? g.percentage : (g.max ? g.score / g.max * 100 : null); }

function buildGradeMatrix(rows) {
    const colMap  = new Map();
    const cellMap = new Map();

    rows.forEach(g => {
        const key = gradeColumnKey(g);
        if (!colMap.has(key)) {
            colMap.set(key, { key, title: g.title || 'Untitled', subject: g.subject || 'Uncategorized', type: g.type || 'Uncategorized', maxes: new Set(), date: g.date || '' });
        }
        const col = colMap.get(key);
        col.maxes.add(g.max ?? '?');
        if (g.date && (!col.date || g.date < col.date)) col.date = g.date;

        const cellKey = `${g.studentId}::${key}`;
        if (!cellMap.has(cellKey)) cellMap.set(cellKey, []);
        cellMap.get(cellKey).push(g);
    });

    cellMap.forEach(list => list.sort((a, b) => (b.date || '').localeCompare(a.date || '')));

    // Categories follow the teacher's weighting order; unknown types go last.
    const weights = getGradeTypes();
    const order = weights.map(t => String(t.name || '').toLowerCase());
    const weightOf = name => (weights.find(t => String(t.name || '').toLowerCase() === name.toLowerCase()) || {}).weight;
    const catMap = new Map();
    colMap.forEach(c => { if (!catMap.has(c.type)) catMap.set(c.type, []); catMap.get(c.type).push(c); });
    const cats = [...catMap.entries()].map(([name, cols]) => ({
        name,
        weight: weightOf(name),
        cols: cols.sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.subject.localeCompare(b.subject) || a.title.localeCompare(b.title)),
    })).sort((a, b) => {
        const ia = order.indexOf(a.name.toLowerCase()), ib = order.indexOf(b.name.toLowerCase());
        return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib) || a.name.localeCompare(b.name);
    });
    const cols = cats.flatMap(c => c.cols);

    return { cols, cats, cellMap };
}

// Mean % of every grade the student has in this category (current view).
function categoryAverage(studentId, cat, cellMap) {
    const pcts = [];
    cat.cols.forEach(c => (cellMap.get(`${studentId}::${c.key}`) || []).forEach(g => { const p = gradePct(g); if (p !== null) pcts.push(p); }));
    return pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null;
}

// Weighted average over the subject in view (all subjects = overall).
function studentViewAverage(studentId) {
    let list = (allGradesCache?.grades || []).filter(g => g.studentId === studentId);
    if (sfSubjectValue) list = list.filter(g => g.subject === sfSubjectValue);
    const avg = list.length ? calculateWeightedAverage(list, getGradeTypes()) : null;
    return avg !== null ? Math.round(avg) : null;
}

function viewAverageLabel() { return sfSubjectValue ? `${sfSubjectValue} Avg` : 'Overall Avg'; }

function getViewStudents() {
    let students = [...allStudentsCache].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    if (sfStudentValue) students = students.filter(s => s.id === sfStudentValue);
    return students;
}

function renderGradeGrid(rows) {
    const thead = document.getElementById('gradebookTableHead');
    const tbody = document.getElementById('gradebookTableBody');
    gradeDetailCache = {};

    const students = getViewStudents();
    const { cols, cats, cellMap } = buildGradeMatrix(rows);
    lastRenderedCats = cats;

    const countEl = document.getElementById('gbRecordCount');
    if (countEl) countEl.innerHTML = `<div class="gb-count-dot"></div><span>${students.length} student${students.length !== 1 ? 's' : ''} · ${cols.length} assignment${cols.length !== 1 ? 's' : ''} · ${rows.length} grade${rows.length !== 1 ? 's' : ''}</span>`;

    const btn = document.getElementById('gbCollapseAllBtn');
    if (btn) {
        const anyExpanded = cats.some(c => !isCatCollapsed(c.name));
        btn.innerHTML = anyExpanded
            ? `<i class="fa-solid fa-compress"></i> Collapse categories`
            : `<i class="fa-solid fa-expand"></i> Expand categories`;
        btn.style.display = cats.length ? '' : 'none';
    }

    const missingFor = (c) => students.filter(s => !cellMap.has(`${s.id}::${c.key}`)).length;

    const row1 = cats.map(cat => {
        const collapsed = isCatCollapsed(cat.name);
        return `<th class="gb-cat-head${collapsed ? ' is-collapsed' : ''}" colspan="${collapsed ? 1 : cat.cols.length}">
            <button type="button" class="gb-cat-toggle" onclick="toggleGradebookCategory('${encodeURIComponent(cat.name)}')" title="${collapsed ? 'Expand' : 'Collapse'} ${escHtml(cat.name)}">
                <i class="fa-solid fa-chevron-${collapsed ? 'right' : 'down'}"></i>
                <span class="gb-cat-name">${escHtml(cat.name)}</span>
                <span class="gb-cat-meta">${cat.cols.length}${cat.weight !== undefined ? ` · ${cat.weight}%` : ''}</span>
            </button>
        </th>`;
    }).join('');

    const row2 = cats.map(cat => isCatCollapsed(cat.name)
        ? `<th class="gb-col-head gb-cat-avg-head" title="Average of all ${escHtml(cat.name)} grades">Avg</th>`
        : cat.cols.map(c => {
            const maxLabel = c.maxes.size === 1 ? [...c.maxes][0] : 'varies';
            const miss = missingFor(c);
            return `<th class="gb-col-head" title="${escHtml(c.title)} — ${escHtml(c.subject)} · ${escHtml(c.type)}${c.date ? ' · ' + escHtml(c.date) : ''}">
                <p class="gb-col-title">${escHtml(c.title)}</p>
                <p class="gb-col-max">/${escHtml(String(maxLabel))}${sfSubjectValue ? '' : ` · ${escHtml(c.subject)}`}</p>
                ${miss ? `<p class="gb-col-missing">${miss} missing</p>` : ''}
            </th>`;
        }).join('')
    ).join('');

    thead.innerHTML = cats.length
        ? `<tr><th class="gb-sticky-col" rowspan="2">Student</th>${row1}<th class="gb-avg-head" rowspan="2">${escHtml(viewAverageLabel())}</th></tr><tr class="gb-head-row2">${row2}</tr>`
        : `<tr><th class="gb-sticky-col">Student</th></tr>`;

    const visibleCols = cats.reduce((n, c) => n + (isCatCollapsed(c.name) ? 1 : c.cols.length), 0);
    const colspan = visibleCols + 2;
    const allRows = allGradesCache?.grades || [];

    if (!students.length) {
        tbody.innerHTML = `<tr><td colspan="${colspan}"><div class="gb-empty"><i class="fa-solid fa-user-slash"></i><p>No active students in ${escHtml(activeClass?.name || 'this class')}.</p></div></td></tr>`;
        return;
    }
    if (!cols.length) {
        tbody.innerHTML = `<tr><td colspan="${colspan}"><div class="gb-empty"><i class="fa-solid fa-folder-open"></i><p>${allRows.length ? 'No grades match the selected filters.' : 'No grades logged yet for this period.'}</p></div></td></tr>`;
        return;
    }

    tbody.innerHTML = students.map(s => {
        const missing = cols.filter(c => !cellMap.has(`${s.id}::${c.key}`)).length;
        const initial = (s.name || '?').charAt(0).toUpperCase();
        const avg = studentViewAverage(s.id);

        const cells = cats.map(cat => {
            if (isCatCollapsed(cat.name)) {
                const ca = categoryAverage(s.id, cat, cellMap);
                return ca === null
                    ? `<td class="gb-cell gb-cat-avg gb-cell-missing" title="No ${escHtml(cat.name)} grades"><span>-</span></td>`
                    : `<td class="gb-cell gb-cat-avg ${pctTone(ca)}" title="${escHtml(cat.name)} average">${ca}%</td>`;
            }
            return cat.cols.map(c => {
                const list = cellMap.get(`${s.id}::${c.key}`);
                if (!list) return `<td class="gb-cell gb-cell-missing" title="${escHtml(s.name || 'Student')}: no grade for ${escHtml(c.title)}"><span>-</span></td>`;

                list.forEach(g => { gradeDetailCache[g.id] = g; });
                const g   = list[0];
                const pct = g.max ? Math.round(g.score / g.max * 100) : null;
                const dup = list.length > 1 ? `<span class="gb-cell-dup" title="${list.length} grades recorded — showing the newest">${list.length}</span>` : '';
                const actions = isSemesterLocked ? '' : `<div class="gb-cell-actions">
                        <button onclick="openEditGradeModal('${g.studentId}','${g.id}')" class="gb-row-btn gb-btn-edit" title="Edit"><i class="fa-solid fa-pen"></i></button>
                        <button onclick="deleteGrade('${g.studentId}','${g.id}')" class="gb-row-btn gb-btn-delete" title="Delete"><i class="fa-solid fa-trash-can"></i></button>
                    </div>`;
                return `<td class="gb-cell ${pctTone(pct)}">
                    <button class="gb-cell-score" onclick="openAssignmentModal('${g.id}')" title="${pct !== null ? pct + '% · ' + letterGrade(pct) : ''}${g.notes ? ' · has teacher notes' : ''}">${g.score}<span class="gb-cell-max">/${g.max || '?'}</span></button>${dup}${actions}
                </td>`;
            }).join('');
        }).join('');

        return `<tr class="gb-row">
            <td class="gb-sticky-col">
                <div class="gb-student-cell">
                    <div class="gb-student-init">${initial}</div>
                    <div style="min-width:0;">
                        <span class="gb-student-name">${escHtml(s.name || 'Unknown')}</span>
                        ${missing ? `<div class="gb-stu-missing">${missing} missing</div>` : ''}
                    </div>
                </div>
            </td>
            ${cells}
            <td class="gb-avg-cell" style="color:${avg !== null ? gradeColor(avg) : '#9ab0c6'};">${avg !== null ? `${avg}% <span class="gb-avg-letter">${letterGrade(avg)}</span>` : '-'}</td>
        </tr>`;
    }).join('');

    // Second header row sticks directly under the first.
    requestAnimationFrame(() => {
        const r1 = thead.querySelector('tr');
        const h = r1 ? r1.getBoundingClientRect().height : 0;
        thead.querySelectorAll('.gb-head-row2 th').forEach(th => { th.style.top = h + 'px'; });
    });
}

window.applyGradebookFilters = function() { renderGradebook(); };

// ── COMPLETENESS SUMMARY (awareness only) ─────────────────────────────────────
// Flags students who have NO grades or only ONE grade in a subject their class
// has already started grading this term. Students within a 21-day grace window
// (from the later of their enrollment date or the term start) are skipped, so
// newly-enrolled students are never falsely flagged. This function only reads
// data already in memory and only writes to the #gbCompleteness element — it
// never changes grades, averages, or any other part of the gradebook.
const GRACE_DAYS = 21;

function completenessStartOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function computeCompleteness(grades, semId) {
    const el = document.getElementById('gbCompleteness');
    if (!el) return;

    // Resolve the active term's start date (same lookup checkLockStatus uses).
    const activeSem = rawSemesters.find(s => s.id === semId);
    const termStart = activeSem && activeSem.startDate
        ? completenessStartOfDay(new Date(activeSem.startDate + 'T00:00:00'))
        : null;

    const today = completenessStartOfDay(new Date());

    // Group grades: className -> subject -> studentId -> count
    // Also track which subjects each class has "started" (has >=1 grade in).
    const classSubjects = {};                 // className -> Set(subject)
    const countByClassSubjStu = {};           // className -> subject -> studentId -> count

    grades.forEach(g => {
        const cls  = g.className || '';
        const subj = g.subject || 'Uncategorized';
        const sid  = g.studentId;
        if (!classSubjects[cls]) classSubjects[cls] = new Set();
        classSubjects[cls].add(subj);
        if (!countByClassSubjStu[cls]) countByClassSubjStu[cls] = {};
        if (!countByClassSubjStu[cls][subj]) countByClassSubjStu[cls][subj] = {};
        countByClassSubjStu[cls][subj][sid] = (countByClassSubjStu[cls][subj][sid] || 0) + 1;
    });

    let noneCount   = 0;   // students with zero grades in a started subject
    let sparseCount = 0;   // students with exactly one grade in a started subject

    allStudentsCache.forEach(stu => {
        // 21-day grace: skip students still ramping up.
        let graceAnchor = null;
        if (stu.createdAt) {
            const enrolled = completenessStartOfDay(new Date(stu.createdAt));
            graceAnchor = (termStart && termStart > enrolled) ? termStart : enrolled;
        } else if (termStart) {
            graceAnchor = termStart;
        }
        if (graceAnchor) {
            const daysSince = Math.round((today - graceAnchor) / (1000 * 60 * 60 * 24));
            if (daysSince < GRACE_DAYS) return; // still in grace — do not flag
        }

        const cls = stu.className || '';
        const startedSubjects = classSubjects[cls];
        if (!startedSubjects || startedSubjects.size === 0) return; // class hasn't started grading

        let hasNone = false;
        let hasSparse = false;
        startedSubjects.forEach(subj => {
            const cnt = (countByClassSubjStu[cls][subj] || {})[stu.id] || 0;
            if (cnt === 0)      hasNone = true;
            else if (cnt === 1) hasSparse = true;
        });

        // A student is counted once per tier: "none" takes priority as the more urgent gap.
        if (hasNone)        noneCount++;
        else if (hasSparse) sparseCount++;
    });

    // Nothing to show → keep the strip hidden.
    if (noneCount === 0 && sparseCount === 0) {
        el.style.display = 'none';
        el.innerHTML = '';
        return;
    }

    const parts = [];
    if (noneCount > 0) {
        parts.push(`<span style="display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:#7f1d1d;background:#fee2e2;border:1px solid #fecaca;border-radius:4px;padding:5px 11px;">
            <i class="fa-solid fa-circle-exclamation" style="font-size:11px;"></i>
            ${noneCount} student${noneCount !== 1 ? 's' : ''} with no grades in a subject</span>`);
    }
    if (sparseCount > 0) {
        parts.push(`<span style="display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:#78350f;background:#fef3c7;border:1px solid #fde68a;border-radius:4px;padding:5px 11px;">
            <i class="fa-solid fa-circle-half-stroke" style="font-size:11px;"></i>
            ${sparseCount} student${sparseCount !== 1 ? 's' : ''} with only one grade in a subject</span>`);
    }

    el.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:#fff;border:1px solid #dce3ed;border-radius:4px;padding:12px 16px;box-shadow:0 1px 2px rgba(13,31,53,0.05);">
            <span style="font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#9ab0c6;display:inline-flex;align-items:center;gap:6px;">
                <i class="fa-solid fa-list-check" style="font-size:11px;color:#6b84a0;"></i> Grading Completeness
            </span>
            ${parts.join('')}
            <span style="font-size:10.5px;color:#9ab0c6;font-weight:500;margin-left:auto;">Students enrolled under ${GRACE_DAYS} days are not counted.</span>
        </div>`;
    el.style.display = 'block';
}

function gradeColor(pct) {
    if (pct >= 90) return '#065f46'; if (pct >= 80) return '#1e3a8a';
    if (pct >= 70) return '#134e4a'; if (pct >= 65) return '#78350f'; return '#7f1d1d';
}

// ── 11. VIEW ASSIGNMENT MODAL ─────────────────────────────────────────────────
window.openAssignmentModal = function(gradeId) {
    const g = gradeDetailCache[gradeId];
    if (!g) return;
    const pct = g.max ? Math.round(g.score / g.max * 100) : null;
    const fill = gradeFill(pct || 0);
    const color = pct >= 90 ? 'text-emerald-600' : pct >= 80 ? 'text-blue-600' : pct >= 70 ? 'text-teal-600' : pct >= 65 ? 'text-amber-600' : 'text-red-600';
    document.getElementById('aModalTitle').textContent = g.title || 'Assessment';
    let histHTML = '';
    if (g.historyLogs?.length) {
        histHTML = `<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:4px;padding:14px;margin-top:14px;">
            <p style="font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#78350f;margin:0 0 10px;"><i class="fa-solid fa-clock-rotate-left" style="margin-right:4px;"></i>Edit History (${g.historyLogs.length})</p>
            <div style="display:flex;flex-direction:column;gap:6px;max-height:120px;overflow-y:auto;">
                ${g.historyLogs.map(l => `<div style="font-size:11px;color:#78350f;background:#fff;border:1px solid #fde68a;border-radius:3px;padding:7px 10px;">${typeof l==='object' ? `[${escHtml(l.changedAt)}] ${l.oldScore}/${l.oldMax} → ${l.newScore}/${l.newMax}. ${escHtml(l.reason||'')}` : escHtml(l)}</div>`).join('')}
            </div>
        </div>`;
    }
    document.getElementById('aModalBody').innerHTML = `
        <div style="text-align:center;margin-bottom:18px;">
            <div class="${color}" style="font-size:40px;font-weight:700;font-family:'DM Mono',monospace;line-height:1;">${g.score}<span style="font-size:18px;color:#9ab0c6;"> / ${g.max||'?'}</span></div>
            ${pct!==null ? `<div style="display:flex;align-items:center;justify-content:center;gap:10px;margin-top:8px;"><span class="${color}" style="font-size:16px;font-weight:700;font-family:'DM Mono',monospace;">${pct}%</span><span class="${color}" style="font-size:13px;font-weight:700;padding:4px 12px;border-radius:3px;border:1px solid;${pct>=90?'background:#dcfce7;border-color:#bbf7d0;':pct>=80?'background:#dbeafe;border-color:#bfdbfe;':pct>=70?'background:#ccfbf1;border-color:#99f6e4;':pct>=65?'background:#fef3c7;border-color:#fde68a;':'background:#fee2e2;border-color:#fecaca;'}">${letterGrade(pct)}</span></div><div style="margin:10px 16px 0;height:6px;background:#f0f4f8;border-radius:2px;overflow:hidden;"><div style="height:100%;width:${pct||0}%;background:${fill};"></div></div>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;gap:0;margin-bottom:14px;border:1px solid #e8edf2;border-radius:4px;overflow:hidden;">
            ${[['Subject',g.subject||'—'],['Type',g.type||'—'],['Date',g.date||'—']].map(([l,v],i) => `<div style="display:flex;align-items:center;justify-content:space-between;padding:9px 14px;${i<2?'border-bottom:1px solid #f0f4f8;':''}background:#fff;"><span style="font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#9ab0c6;">${l}</span><span style="font-size:13px;font-weight:600;color:#0d1f35;">${escHtml(v)}</span></div>`).join('')}
        </div>
        ${g.notes ? `<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:4px;padding:14px;margin-bottom:14px;"><p style="font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#1e3a8a;margin:0 0 6px;">Teacher Notes</p><p style="font-size:12.5px;color:#374f6b;font-weight:400;margin:0;line-height:1.6;white-space:pre-wrap;">${escHtml(g.notes)}</p></div>` : ''}
        ${histHTML}`;
    openOverlay('assignmentModal', 'assignmentModalInner');
};
window.closeAssignmentModal = function() { closeOverlay('assignmentModal', 'assignmentModalInner'); };

// ── 12. EDIT GRADE MODAL ──────────────────────────────────────────────────────
window.openEditGradeModal = async function(studentId, gradeId) {
    if (isSemesterLocked) return;
    try {
        const snap = await getDoc(doc(db, 'students', studentId, 'grades', gradeId));
        if (!snap.exists()) return;
        currentEditData = { studentId, gradeId, ...snap.data() };
        originalScore   = currentEditData.score;
        originalMax     = currentEditData.max;
        document.getElementById('editGradeContext').textContent = `${studentMap[studentId]||'Student'} · ${currentEditData.subject||''} · ${currentEditData.title||''}`;
        document.getElementById('ed-old-notes').textContent = currentEditData.notes || '—';
        document.getElementById('ed-new-notes').value = '';
        document.getElementById('ed-score').value = currentEditData.score;
        document.getElementById('ed-max').value = currentEditData.max;
        document.getElementById('ed-reason').value = '';
        document.getElementById('reasonSection').classList.remove('visible');
        document.getElementById('editGradeMsg').classList.add('hidden');
        openOverlay('editGradeModal', 'editGradeModalInner');
    } catch (e) {
        console.error('[Gradebook] openEditGradeModal:', e);
        alert('Error loading grade details.');
    }
};
window.closeEditGradeModal = function() { closeOverlay('editGradeModal', 'editGradeModalInner'); };

window.checkScoreChange = function() {
    const s = parseFloat(document.getElementById('ed-score')?.value);
    const m = parseFloat(document.getElementById('ed-max')?.value);
    document.getElementById('reasonSection').classList.toggle('visible', s !== originalScore || m !== originalMax);
};

async function saveEditedGrade() {
    const nScore = parseFloat(document.getElementById('ed-score').value);
    const nMax   = parseFloat(document.getElementById('ed-max').value);
    const note   = document.getElementById('ed-new-notes').value.trim();
    const changed = (nScore !== originalScore || nMax !== originalMax);
    if (changed) {
        const reason = document.getElementById('ed-reason').value.trim();
        if (!reason) { alert('A reason is required when changing the score.'); document.getElementById('ed-reason').focus(); return; }
    }
    const btn = document.getElementById('updateGradeBtn');
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving…`; btn.disabled = true;
    try {
        let finalNotes = currentEditData.notes || '';
        if (note) { const ts = `[${new Date().toLocaleDateString()}] ${note}`; finalNotes = finalNotes ? `${ts}\n\n${finalNotes}` : ts; }
        const updates = { notes: finalNotes, score: nScore, max: nMax };
        if (changed) {
            const reason = document.getElementById('ed-reason').value.trim();
            updates.historyLogs = [...(currentEditData.historyLogs||[]), { changedAt: new Date().toLocaleString(), oldScore: originalScore, oldMax: originalMax, newScore: nScore, newMax: nMax, reason }];
        }
        
        await updateDoc(doc(db, 'students', currentEditData.studentId, 'grades', currentEditData.gradeId), updates);
        
        closeEditGradeModal();
        allGradesCache = null;
        loadGradebook();
    } catch (e) {
        console.error('[Gradebook] saveEditedGrade:', e);
        showMsg('editGradeMsg', 'Error saving changes.', true);
    }
    btn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save Changes`; btn.disabled = false;
}

// ── 13. DELETE ────────────────────────────────────────────────────────────────
window.deleteGrade = async function(studentId, gradeId) {
    if (isSemesterLocked) return;
    if (!confirm('Are you sure you want to permanently delete this grade?')) return;
    try {
        await deleteDoc(doc(db, 'students', studentId, 'grades', gradeId));
        allGradesCache = null;
        loadGradebook();
    } catch (e) { console.error('[Gradebook] deleteGrade:', e); alert('Failed to delete grade.'); }
};

// ── 14. EXPORT & PRINT ────────────────────────────────────────────────────────
function getFilteredRows() {
    const fText = (document.getElementById('gbSearchInput')?.value || '').toLowerCase();
    let rows = allGradesCache?.grades || [];
    if (sfStudentValue) rows = rows.filter(g => g.studentId === sfStudentValue);
    if (sfSubjectValue) rows = rows.filter(g => g.subject   === sfSubjectValue);
    if (sfTypeValue)    rows = rows.filter(g => g.type      === sfTypeValue);
    if (fText)          rows = rows.filter(g => (g.title||'').toLowerCase().includes(fText));
    return rows;
}

// Same matrix the on-screen grid renders: current class, subject tab and
// filters; newest grade per cell; category averages; view average.
function getMatrixExportData() {
    const rows = getFilteredRows();
    const students = getViewStudents();
    const { cols, cats, cellMap } = buildGradeMatrix(rows);
    const colMaxLabel = c => c.maxes.size === 1 ? String([...c.maxes][0]) : 'varies';

    const matrix = students.map(s => ({
        student: s,
        avg: studentViewAverage(s.id),
        cats: cats.map(cat => ({
            avg: categoryAverage(s.id, cat, cellMap),
            cells: cat.cols.map(c => {
                const list = cellMap.get(`${s.id}::${c.key}`);
                if (!list) return null;
                const g = list[0];
                return { score: g.score, max: g.max, pct: g.max ? Math.round(g.score / g.max * 100) : null, count: list.length };
            }),
        })),
    }));

    return { students, cols, cats, matrix, colMaxLabel, gradeCount: rows.length };
}

// CSV is always the full detail: every assignment, a category average after
// each category, then the view average.
window.exportGradebookCSV = function() {
    const { cats, matrix, colMaxLabel } = getMatrixExportData();
    const header = ['Student Name', ...cats.flatMap(cat => [...cat.cols.map(c => `${c.title} (${colMaxLabel(c)})`), `${cat.name} Average`]), viewAverageLabel().replace(/ Avg$/, ' Average')];
    const body = matrix.map(r => [
        r.student.name || 'Unknown',
        ...r.cats.flatMap(rc => [...rc.cells.map(cell => cell ? cell.score : '-'), rc.avg !== null ? `${rc.avg}%` : '-']),
        r.avg !== null ? `${r.avg}%` : '-'
    ]);
    const semName = document.getElementById('activeSemester')?.selectedOptions?.[0]?.text || '';
    const parts = [activeClass?.name, sfSubjectValue, semName].filter(Boolean).map(t => t.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, ''));
    downloadCSV([header, ...body], `${session.schoolId}_gradebook${parts.length ? '_' + parts.join('_') : ''}.csv`);
};

// Print mirrors the screen: collapsed categories print as one average column.
window.printGradebook = function() {
    const { students, cols, cats, matrix, colMaxLabel, gradeCount } = getMatrixExportData();
    const semName = document.getElementById('activeSemester')?.options[document.getElementById('activeSemester')?.selectedIndex]?.text || '';
    const schoolName = session.schoolName || session.schoolId;
    const tone = p => p === null ? '' : p >= 75 ? 'hi' : p >= 65 ? 'mid' : 'lo';
    const visible = cats.reduce((n, c) => n + (isCatCollapsed(c.name) ? 1 : c.cols.length), 0);

    const head1 = `<tr><th class="stu" rowspan="2">Student</th>${cats.map(cat =>
        `<th class="cat" colspan="${isCatCollapsed(cat.name) ? 1 : cat.cols.length}">${escHtml(cat.name)}${cat.weight !== undefined ? ` <span class="cw">${cat.weight}%</span>` : ''}</th>`
    ).join('')}<th class="avg" rowspan="2">${escHtml(viewAverageLabel())}</th></tr>`;
    const head2 = `<tr>${cats.map(cat => isCatCollapsed(cat.name)
        ? `<th><div class="ct">Average</div></th>`
        : cat.cols.map(c => `<th><div class="ct">${escHtml(c.title)}</div><div class="cx">/${escHtml(colMaxLabel(c))}${sfSubjectValue ? '' : ' · ' + escHtml(c.subject)}</div></th>`).join('')
    ).join('')}</tr>`;

    const bodyRows = matrix.map(r => `<tr><td class="stu">${escHtml(r.student.name || 'Unknown')}</td>${r.cats.map((rc, i) => isCatCollapsed(cats[i].name)
        ? (rc.avg !== null ? `<td class="mono ${tone(rc.avg)}">${rc.avg}%</td>` : `<td class="miss">-</td>`)
        : rc.cells.map(cell => cell
            ? `<td class="mono ${tone(cell.pct)}">${cell.score}<span class="mx">/${cell.max ?? '?'}</span>${cell.count > 1 ? '<sup>×' + cell.count + '</sup>' : ''}</td>`
            : `<td class="miss">-</td>`).join('')
    ).join('')}<td class="avg mono ${tone(r.avg)}">${r.avg !== null ? r.avg + '% · ' + letterGrade(r.avg) : '-'}</td></tr>`).join('');

    const w = window.open('', '_blank');
    w.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>Gradebook — ${escHtml(session.teacherData.name)}</title>
        <style>
            @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700&family=DM+Mono:wght@400&display=swap');
            *{box-sizing:border-box;margin:0;padding:0;}
            body{font-family:'DM Sans',sans-serif;padding:32px 36px;color:#0d1f35;}
            .header{display:flex;flex-direction:column;align-items:center;margin-bottom:20px;padding-bottom:14px;border-bottom:2px solid #0d1f35;}
            .logo{max-height:40px;max-width:160px;object-fit:contain;margin-bottom:8px;}
            .doc-title{font-size:16px;font-weight:700;margin-bottom:4px;}
            .meta{font-size:11px;color:#6b84a0;}
            table{width:100%;border-collapse:collapse;font-size:10.5px;table-layout:auto;}
            thead{display:table-header-group;}
            tr{page-break-inside:avoid;break-inside:avoid;}
            th{padding:6px 6px;background:#0d1f35;color:#fff;font-weight:700;text-align:center;vertical-align:bottom;border:1px solid #0d1f35;}
            th.cat{background:#1e3350;font-size:9.5px;text-transform:uppercase;letter-spacing:0.06em;}
            th .ct{font-size:9.5px;line-height:1.2;}
            th .cx,.cw{font-size:8px;font-family:'DM Mono',monospace;margin-top:2px;opacity:0.8;}
            th.stu,td.stu{text-align:left;white-space:nowrap;min-width:130px;}
            td{padding:5px 6px;border:1px solid #dce3ed;text-align:center;}
            td.stu{font-weight:700;}
            tr:nth-child(even) td{background:#f8fafb;}
            td.avg,th.avg{border-left:2px solid #0d1f35;white-space:nowrap;}
            .mx{color:#9ab0c6;font-size:9px;}
            sup{font-size:7px;color:#6b84a0;}
            .miss{color:#b6c2cf;}
            .hi{color:#065f46;font-weight:700;}
            .mid{color:#78350f;font-weight:700;}
            .lo{color:#7f1d1d;font-weight:700;}
            .mono{font-family:'DM Mono',monospace;}
            .footer{margin-top:24px;padding-top:10px;border-top:1px solid #e8edf2;font-size:10px;color:#9ab0c6;text-align:center;}
            @page{size:${visible > 6 ? 'landscape' : 'portrait'};margin:12mm;}
            @media print{
                body{padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
                th{background:#0d1f35 !important;color:#fff !important;}
                th.cat{background:#1e3350 !important;}
            }
        </style>
    </head>
    <body>
        <div class="header">
            <img src="${session.logo || ''}" alt="${escHtml(schoolName)}" class="logo" onerror="this.style.display='none'">
            <p class="doc-title">Class Gradebook${sfSubjectValue ? ' — ' + escHtml(sfSubjectValue) : ''}</p>
            <p class="meta">${escHtml(session.teacherData.name)}${activeClass ? ' &nbsp;·&nbsp; ' + escHtml(activeClass.name) : ''} &nbsp;·&nbsp; ${escHtml(semName)} &nbsp;·&nbsp; ${students.length} students &nbsp;·&nbsp; ${cols.length} assignments &nbsp;·&nbsp; ${gradeCount} grades &nbsp;·&nbsp; ${new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}</p>
        </div>
        ${cols.length ? `<table><thead>${head1}${head2}</thead><tbody>${bodyRows}</tbody></table>` : `<p style="text-align:center;color:#6b84a0;font-size:12px;">No grades match the selected filters.</p>`}
        <div class="footer" style="display:flex; flex-direction:column; align-items:center; gap:8px;">
            <span>"-" = no grade recorded. ×N = N grades recorded for that assignment (newest shown). Category averages use every grade in that category; the final column is the weighted average.</span>
            <span>Generated for ${escHtml(schoolName)}</span>
            <div style="display:flex; justify-content:center; align-items:center; gap:8px; margin-top:5px;">
                <img src="../../assets/images/logo.png" style="max-height:16px; opacity:0.8;">
                <span style="font-weight:bold; color:#0d1f35;">Powered by ConnectUs</span>
            </div>
        </div>
    </body>
    </html>`);
    w.document.close(); setTimeout(()=>w.print(), 600);
};

function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}


// ── 15. GRADE WEIGHTS CONFIGURATION MODAL (SMART UX) ─────────────────────────
let modalGradeTypes = [];
let usedGradeTypes = new Set(); 

document.getElementById('openGradeWeightsBtn')?.addEventListener('click', () => {
    if (isSemesterLocked) {
        alert('The current grading period is locked. Grade weights cannot be changed at this time.');
        return;
    }
    
    // Scan for protected/in-use grade types to prevent accidental deletion
    usedGradeTypes.clear();
    if (allGradesCache && allGradesCache.grades) {
        allGradesCache.grades.forEach(g => {
            if (g.type) usedGradeTypes.add(g.type.toLowerCase());
        });
    }

    const currentTypes = getGradeTypes();
    modalGradeTypes = JSON.parse(JSON.stringify(currentTypes));

    document.getElementById('gwNewName').value = '';
    document.getElementById('gwNewWeight').value = '';
    document.getElementById('gwMsg')?.classList.add('hidden');
    
    renderGradeWeights();
    updateSmartHelper();
    openOverlay('gradeWeightsModal', 'gradeWeightsModalInner');
});

document.getElementById('closeGradeWeightsBtn')?.addEventListener('click', () => {
    closeOverlay('gradeWeightsModal', 'gradeWeightsModalInner');
});

// Auto-suggest weight when typing a new category name
document.getElementById('gwNewName')?.addEventListener('input', () => {
    const weightInput = document.getElementById('gwNewWeight');
    if (weightInput && !weightInput.value) {
        const total = modalGradeTypes.reduce((sum, g) => sum + g.weight, 0);
        const remaining = Math.max(0, 100 - total);
        if (remaining > 0) weightInput.value = remaining;
    }
});

// Dynamic Hard Cap for the "Quick Add" input field
document.getElementById('gwNewWeight')?.addEventListener('input', function() {
    const total = modalGradeTypes.reduce((sum, g) => sum + g.weight, 0);
    const maxAllowed = Math.max(0, 100 - total);
    let w = parseInt(this.value, 10);
    if (w < 0) this.value = 0;
    if (w > maxAllowed) this.value = maxAllowed;
});

document.getElementById('addGwBtn')?.addEventListener('click', () => {
    const nameInput = document.getElementById('gwNewName');
    const weightInput = document.getElementById('gwNewWeight');
    
    const name = nameInput.value.trim();
    let weight = parseInt(weightInput.value, 10);

    if (!name) { showGwMsg('Please enter a category name.', true); nameInput.focus(); return; }
    if (isNaN(weight) || weight <= 0) { showGwMsg('Please enter a valid weight.', true); weightInput.focus(); return; }

    if (modalGradeTypes.some(g => g.name.toLowerCase() === name.toLowerCase())) {
        showGwMsg('This category already exists in your list.', true); return;
    }

    // Double-check the math barrier before pushing to state
    const total = modalGradeTypes.reduce((sum, g) => sum + g.weight, 0);
    const maxAllowed = Math.max(0, 100 - total);
    if (weight > maxAllowed) weight = maxAllowed;

    modalGradeTypes.push({ name, weight });
    
    nameInput.value = '';
    weightInput.value = '';
    
    renderGradeWeights();
    updateSmartHelper();
});

// Dynamic Hard Cap for inline editing
window.updateGwWeight = function(index, val) {
    let w = parseInt(val, 10);
    if (isNaN(w) || w < 0) w = 0;
    
    // Calculate the total of all OTHER categories to find out what room is left
    let sumOthers = modalGradeTypes.reduce((s, g, i) => i !== index ? s + g.weight : s, 0);
    let maxAllowed = Math.max(0, 100 - sumOthers);
    
    // Mathematically prevent them from going over 100%
    if (w > maxAllowed) w = maxAllowed;
    
    // Snap the UI input back to the clamped value so they can't leave an invalid number visually
    const inputEl = document.getElementById(`gw-input-${index}`);
    if (inputEl && inputEl.value != w) inputEl.value = w;

    modalGradeTypes[index].weight = w;
    updateSmartHelper();
};

window.removeGwType = function(index) {
    modalGradeTypes.splice(index, 1);
    renderGradeWeights();
    updateSmartHelper();
};

function showGwMsg(text, isError) {
    const el = document.getElementById('gwMsg');
    if (!el) return;
    el.textContent = text;
    el.style.background = isError ? '#fff0f3' : '#edfaf4';
    el.style.color = isError ? '#e31b4a' : '#0ea871';
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 3500);
}

// The Smart Math Guide
function updateSmartHelper() {
    let total = modalGradeTypes.reduce((sum, g) => sum + g.weight, 0);
    const totalEl = document.getElementById('gwTotalWeight');
    const saveBtn = document.getElementById('saveGwBtn');
    
    if (!totalEl || !saveBtn) return;

    if (total === 100) {
        totalEl.innerHTML = `Total: <strong>100%</strong> &mdash; Ready to save.`;
        totalEl.style.color = '#0ea871';
        totalEl.style.background = '#edfaf4';
        totalEl.style.borderColor = '#a7f3d0';
        
        saveBtn.disabled = false;
        saveBtn.style.opacity = '1';
        saveBtn.style.cursor = 'pointer';
    } else {
        const diff = 100 - total;
        // Because of the hard caps, total can NEVER be over 100%, so we only need to show what is missing.
        totalEl.innerHTML = `Total: <strong>${total}%</strong> &mdash; You need <strong>${diff}%</strong> more to reach 100%.`;
        totalEl.style.color = '#78350f';
        totalEl.style.background = '#fffbeb';
        totalEl.style.borderColor = '#fde68a';
        
        saveBtn.disabled = true;
        saveBtn.style.opacity = '0.5';
        saveBtn.style.cursor = 'not-allowed';
    }
    
    // Keep the "New Category" weight input clamped dynamically as well
    const newWeightInput = document.getElementById('gwNewWeight');
    if (newWeightInput) {
        const remaining = Math.max(0, 100 - total);
        if (parseInt(newWeightInput.value, 10) > remaining) {
            newWeightInput.value = remaining;
        }
    }
}

function renderGradeWeights() {
    const list = document.getElementById('gwList');
    if (!list) return;
    
    if (modalGradeTypes.length === 0) {
        list.innerHTML = `<div style="padding:20px;text-align:center;border:1px dashed #c5d0db;border-radius:3px;color:#9ab0c6;font-size:12px;">No metrics configured. Add below.</div>`;
    } else {
        list.innerHTML = modalGradeTypes.map((g, i) => {
            const isProtected = usedGradeTypes.has(g.name.toLowerCase());
            const actionHtml = isProtected 
                ? `<span style="font-size:10px;font-weight:700;color:#9ab0c6;background:#f0f4f8;padding:4px 8px;border-radius:3px;display:flex;align-items:center;gap:4px;" title="Cannot delete: Active grades exist"><i class="fa-solid fa-lock"></i> In Use</span>`
                : `<button onclick="window.removeGwType(${i})" style="background:none;border:none;color:#e31b4a;cursor:pointer;font-size:12px;padding:4px;" title="Delete Metric"><i class="fa-solid fa-trash-can"></i></button>`;

            return `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:12px;background:#fff;border:1px solid #dce3ed;border-radius:3px;margin-bottom:8px;">
                <div style="display:flex;align-items:center;gap:10px;">
                    <i class="fa-solid fa-tag" style="color:#9ab0c6;font-size:10px;"></i>
                    <span style="font-size:13px;font-weight:700;color:#0d1f35;">${escHtml(g.name)}</span>
                </div>
                <div style="display:flex;align-items:center;gap:12px;">
                    <div style="position:relative;width:65px;">
                        <input type="number" id="gw-input-${i}" min="0" oninput="window.updateGwWeight(${i}, this.value)" value="${g.weight}" style="width:100%;padding:6px;padding-right:20px;background:#f8fafb;border:1px solid #c5d0db;border-radius:3px;font-size:13px;font-weight:700;color:#0ea871;font-family:'DM Mono',monospace;outline:none;">
                        <span style="position:absolute;right:8px;top:7px;font-size:11px;font-weight:700;color:#9ab0c6;pointer-events:none;">%</span>
                    </div>
                    <div style="width:70px;display:flex;justify-content:flex-end;">
                        ${actionHtml}
                    </div>
                </div>
            </div>`;
        }).join('');
    }
}

document.getElementById('saveGwBtn')?.addEventListener('click', async () => {
    const total = modalGradeTypes.reduce((sum, g) => sum + g.weight, 0);
    if (total !== 100) return;
    
    const btn = document.getElementById('saveGwBtn');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving & Recalculating...';
    btn.disabled = true;

    try {
        await saveTeacherWeightingEverywhere(session.schoolId, session.teacherId, modalGradeTypes);

        resolvedWeighting = modalGradeTypes;
        session.teacherData.gradeTypes = modalGradeTypes;
        session.teacherData.customGradeTypes = modalGradeTypes;
        setSessionData('teacher', session);
        
        if (sfType) {
            sfType.setItems(modalGradeTypes.map(t => ({ id: t.name, label: t.name })));
        }

        closeOverlay('gradeWeightsModal', 'gradeWeightsModalInner');
        loadGradebook(); 
        
    } catch (e) {
        console.error('[Gradebook] saveGradeWeights:', e);
        showGwMsg('Error saving configuration. Please try again.', true);
        btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save & Recalculate';
        btn.disabled = false;
    }
});

// ── FIRE ──────────────────────────────────────────────────────────────────────
init();
