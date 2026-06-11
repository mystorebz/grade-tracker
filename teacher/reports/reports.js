import { db } from '../../assets/js/firebase-init.js';
import { collection, query, where, getDocs, getDoc, doc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { gradeColorClass, letterGrade, downloadCSV, calculateWeightedAverage } from '../../assets/js/utils.js';

// ── 1. AUTHENTICATION & LAYOUT ──────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    injectTeacherLayout('reports', 'Data Query Builder', 'Generate advanced analytics, multi-term reports, and custom academic transcripts', false);
}

// ── 2. STATE ─────────────────────────────────────────────────────────────────
let allStudentsCache    = [];
let studentMap          = {};
let rawSemesters        = [];
let allGradesCache      = {};
let currentQueryResults = [];
let currentQueryMeta    = {};
let resolvedSchoolName  = '';   // populated from the school doc in loadSemesters

const DEFAULT_GRADE_TYPES = ['Test', 'Quiz', 'Assignment', 'Homework', 'Project', 'Midterm Exam', 'Final Exam'];
function getGradeTypes() { return session.teacherData.gradeTypes || session.teacherData.customGradeTypes || DEFAULT_GRADE_TYPES; }

// ── Weight lookup ─────────────────────────────────────────────────────────────
function getWeight(typeName) {
    if (!typeName) return null;
    const types = getGradeTypes();
    const match = types.find(t => {
        const name = typeof t === 'string' ? t : t.name;
        return name?.toLowerCase() === typeName.toLowerCase();
    });
    if (!match || typeof match === 'string') return null;
    return match.weight ?? null;
}

// ── Student summary helper ────────────────────────────────────────────────────
// Groups grades by subject, computes weighted avg per subject, then overall avg
function computeStudentSummary(grades) {
    const bySub = {};
    grades.forEach(g => {
        const sub = g.subject || 'Uncategorized';
        if (!bySub[sub]) bySub[sub] = [];
        bySub[sub].push(g);
    });
    const subjectAvgs = {};
    let total = 0, count = 0;
    for (const sub in bySub) {
        const avg = calculateWeightedAverage(bySub[sub], getGradeTypes());
        if (avg !== null) {
            subjectAvgs[sub] = Math.round(avg);
            total += avg;
            count++;
        }
    }
    return { subjectAvgs, overall: count > 0 ? Math.round(total / count) : null };
}

function escHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// ── 3. INIT ───────────────────────────────────────────────────────────────────
async function init() {
    if (!session) return;
    document.getElementById('rb-scope').addEventListener('change', toggleScope);
    document.getElementById('generateReportBtn').addEventListener('click', executeIntelligentQuery);
    populateStaticCheckboxes();
    await loadSemesters();
    await loadStudents();
}

// ── Nothing pre-selected — isChecked defaults to false ───────────────────────
function buildCheckbox(idPrefix, value, label, isChecked = false) {
    const safeId = `${idPrefix}-${value.replace(/[^a-zA-Z0-9]/g, '_')}`;
    return `
    <label class="flex items-center gap-3 p-2.5 border border-[#dce3ed] rounded cursor-pointer transition ${isChecked ? 'bg-[#eef4ff] border-[#c7d9fd]' : 'bg-white hover:bg-[#f8fafb]'}" id="wrap-${safeId}">
        <input type="checkbox" value="${escHtml(value)}" ${isChecked ? 'checked' : ''} onchange="toggleCbVisuals(this, 'wrap-${safeId}')" class="w-4 h-4 text-[#2563eb] rounded border-[#b8c5d4] focus:ring-[#2563eb]">
        <span class="font-bold text-[#0d1f35] text-[12px] select-none truncate" title="${escHtml(label)}">${escHtml(label)}</span>
    </label>`;
}

window.toggleCbVisuals = function(cb, wrapId) {
    const wrap = document.getElementById(wrapId);
    if (cb.checked) {
        wrap.classList.add('bg-[#eef4ff]', 'border-[#c7d9fd]');
        wrap.classList.remove('bg-white', 'hover:bg-[#f8fafb]');
    } else {
        wrap.classList.remove('bg-[#eef4ff]', 'border-[#c7d9fd]');
        wrap.classList.add('bg-white', 'hover:bg-[#f8fafb]');
    }
};

window.toggleAllCheckboxes = function(containerId, state) {
    const container  = document.getElementById(containerId);
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => {
        cb.checked = state;
        const wrapId = cb.closest('label').id;
        window.toggleCbVisuals(cb, wrapId);
    });
};

function populateStaticCheckboxes() {
    const subjects = (session.teacherData.subjects || []);
    const subGrid  = document.getElementById('rb-subject-grid');
    if (subGrid) {
        subGrid.innerHTML = subjects.map(s => buildCheckbox('sub', s.name, s.name, false)).join('')
            || '<p class="text-xs text-slate-400">No subjects found.</p>';
    }

    let types         = getGradeTypes().map(t => t.name || t);
    let archivedTypes = session.teacherData.archivedGradeTypes || [];
    let allTypes      = [...new Set([...types, ...archivedTypes])];
    const typeGrid    = document.getElementById('rb-type-grid');
    if (typeGrid) {
        typeGrid.innerHTML = allTypes.map(t => buildCheckbox('typ', t, t, false)).join('');
    }

    const classes  = session.teacherData.classes || [session.teacherData.className || ''];
    const classSel = document.getElementById('rb-class');
    if (classSel && classes.length > 0) {
        classSel.innerHTML = '<option value="">All Classes</option>'
            + classes.filter(Boolean).map(c => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join('');
    }
}

async function loadSemesters() {
    try {
        let rawSems    = [];
        const cacheKey = `connectus_semesters_${session.schoolId}`;
        const cached   = localStorage.getItem(cacheKey);
        if (cached) {
            rawSems = JSON.parse(cached);
        } else {
            const semSnap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
            rawSems = semSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0));
            localStorage.setItem(cacheKey, JSON.stringify(rawSems));
        }
        rawSemesters = rawSems;

        let activeId = '';
        try {
            const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
            activeId = schoolSnap.data()?.activeSemesterId || '';
            resolvedSchoolName = schoolSnap.data()?.schoolName || '';
        } catch(e) {}

        const topSemSel = document.getElementById('activeSemester');
        const sbPeriod  = document.getElementById('sb-period');
        if (topSemSel) {
            topSemSel.innerHTML = '';
            rawSemesters.forEach(s => {
                const opt = document.createElement('option');
                opt.value = s.id; opt.textContent = s.name;
                if (s.id === activeId) opt.selected = true;
                topSemSel.appendChild(opt);
            });
            if (sbPeriod) sbPeriod.textContent = topSemSel.options[topSemSel.selectedIndex]?.text || '—';
            topSemSel.addEventListener('change', () => {
                if (sbPeriod) sbPeriod.textContent = topSemSel.options[topSemSel.selectedIndex]?.text || '—';
            });
        }

        // Nothing pre-selected
        const semGrid = document.getElementById('rb-semester-grid');
        if (semGrid) {
            semGrid.innerHTML = rawSemesters.map(s => buildCheckbox('sem', s.id, s.name, false)).join('');
        }
    } catch (e) {
        console.error("[Reports] Error loading semesters:", e);
        const semGrid = document.getElementById('rb-semester-grid');
        if (semGrid) semGrid.innerHTML = '<p class="text-xs text-red-500">Error loading periods</p>';
    }
}

async function loadStudents() {
    const stuSel = document.getElementById('rb-student');
    try {
        const stuSnap = await getDocs(query(
            collection(db, 'students'),
            where('currentSchoolId', '==', session.schoolId),
            where('enrollmentStatus', '==', 'Active')
        ));
        allStudentsCache = stuSnap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(s => s.teacherId === session.teacherId);
        studentMap = {};
        allStudentsCache.forEach(s => { studentMap[s.id] = s; });
        const sorted = [...allStudentsCache].sort((a, b) => a.name.localeCompare(b.name));
        stuSel.innerHTML = '<option value="">— Target a specific student —</option>'
            + sorted.map(s => `<option value="${s.id}">${escHtml(s.name)} ${s.archived ? '(Archived)' : ''}</option>`).join('');
    } catch (e) {
        console.error("[Reports] Error loading students:", e);
        stuSel.innerHTML = '<option value="">Error loading students</option>';
    }
}

function toggleScope() {
    const scope        = document.getElementById('rb-scope').value;
    const studentWrap  = document.getElementById('studentFilterWrap');
    const classWrap    = document.getElementById('classFilterWrap');
    const standingWrap = document.getElementById('standingFilterWrap');
    if (scope === 'student') {
        studentWrap.classList.remove('hidden');
        classWrap.classList.add('hidden');
        standingWrap.classList.add('hidden');
        document.getElementById('rb-class').value    = '';
        document.getElementById('rb-standing').value = '';
    } else {
        studentWrap.classList.add('hidden');
        classWrap.classList.remove('hidden');
        standingWrap.classList.remove('hidden');
        document.getElementById('rb-student').value  = '';
    }
}

function getCheckedValues(containerId) {
    return Array.from(document.querySelectorAll(`#${containerId} input[type="checkbox"]:checked`)).map(cb => cb.value);
}

// ── 4. DATA FETCHING ──────────────────────────────────────────────────────────
async function fetchGradesForSemesters(semIds) {
    let all = [];
    for (const semId of semIds) {
        if (allGradesCache[semId]) { all = all.concat(allGradesCache[semId]); continue; }
        let semGrades = [];
        await Promise.all(allStudentsCache.map(async s => {
            try {
                const q    = query(collection(db, 'students', s.id, 'grades'), where('schoolId', '==', session.schoolId), where('semesterId', '==', semId));
                const snap = await getDocs(q);
                snap.forEach(d => {
                    semGrades.push({ id: d.id, studentId: s.id, studentName: s.name, semesterId: d.data().semesterId, ...d.data() });
                });
            } catch (e) {}
        }));
        allGradesCache[semId] = semGrades;
        all = all.concat(semGrades);
    }
    return all;
}

// ── 5. QUERY ENGINE ───────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function executeIntelligentQuery() {
    const btn = document.getElementById('generateReportBtn');

    const scope           = document.getElementById('rb-scope').value;
    const targetStudentId = document.getElementById('rb-student').value;
    const filterClass     = document.getElementById('rb-class').value;
    const filterStanding  = document.getElementById('rb-standing').value;

    const selectedSems  = getCheckedValues('rb-semester-grid');
    const selectedSubs  = getCheckedValues('rb-subject-grid');
    const selectedTypes = getCheckedValues('rb-type-grid');

    // ── Validation: only period is required ──────────────────────────────────
    if (scope === 'student' && !targetStudentId) {
        alert("Please select a target student to generate an individual report.");
        return;
    }
    if (!selectedSems.length) {
        alert("Please select at least one Term to generate a report.");
        return;
    }

    // ── Mode detection ───────────────────────────────────────────────────────
    // Mode A: no subjects checked → term summary / multi-term comparison
    // Mode B: subjects checked, no types → all types included, grouped by type
    // Mode C: subjects AND types checked → fully filtered detail view
    const isModeA = selectedSubs.length === 0;
    const isModeB = selectedSubs.length > 0 && selectedTypes.length === 0;
    const isModeC = selectedSubs.length > 0 && selectedTypes.length > 0;

    btn.disabled = true;
    const area = document.getElementById('reportResultsArea');
    area.classList.add('opacity-0');

    try {
        btn.innerHTML = `<i class="fa-solid fa-database fa-fade"></i> Querying datastore...`;
        const rawGrades = await fetchGradesForSemesters(selectedSems);
        await sleep(350);

        btn.innerHTML = `<i class="fa-solid fa-microchip fa-fade"></i> Filtering datasets...`;
        let filteredGrades = rawGrades;

        // Scope filter
        if (scope === 'student') {
            filteredGrades = filteredGrades.filter(g => g.studentId === targetStudentId);
        } else if (filterClass) {
            filteredGrades = filteredGrades.filter(g => {
                const s = studentMap[g.studentId];
                return s && s.className === filterClass;
            });
        }

        // Subject filter — only for B and C
        if (!isModeA) {
            filteredGrades = filteredGrades.filter(g => selectedSubs.includes(g.subject));
        }

        // Type filter — only for C
        if (isModeC) {
            filteredGrades = filteredGrades.filter(g => selectedTypes.includes(g.type));
        }

        // Standing filter — class scope only
        if (scope === 'class' && filterStanding) {
            const studentAvgs = {};
            filteredGrades.forEach(g => {
                if (!studentAvgs[g.studentId]) studentAvgs[g.studentId] = [];
                if (g.max > 0) studentAvgs[g.studentId].push(g);
            });
            const allowed = new Set();
            Object.entries(studentAvgs).forEach(([sid, grades]) => {
                const avg = calculateWeightedAverage(grades, getGradeTypes());
                if (avg !== null) {
                    let std = 'none';
                    if (avg >= 90) std = 'excelling';
                    else if (avg >= 80) std = 'good';
                    else if (avg >= 70) std = 'ontrack';
                    else if (avg >= 65) std = 'needsattention';
                    else std = 'atrisk';
                    if (std === filterStanding) allowed.add(sid);
                }
            });
            filteredGrades = filteredGrades.filter(g => allowed.has(g.studentId));
        }

        await sleep(300);
        btn.innerHTML = `<i class="fa-solid fa-chart-pie fa-fade"></i> Calculating aggregates...`;

        // ── Meta ─────────────────────────────────────────────────────────────
        const totalSems = rawSemesters.length;
        const totalSubs = (session.teacherData.subjects || []).length;
        const semText   = selectedSems.length === totalSems ? 'All Periods' : `${selectedSems.length} Period${selectedSems.length > 1 ? 's' : ''}`;
        const subText   = isModeA ? 'All Subjects' : (selectedSubs.length >= totalSubs ? 'All Subjects' : `${selectedSubs.length} Subject${selectedSubs.length > 1 ? 's' : ''}`);

        let scopeName = 'Class Overview';
        if (scope === 'student') {
            scopeName = studentMap[targetStudentId]?.name || 'Student';
        } else {
            const cStr = filterClass || 'All Classes';
            const sEl  = document.getElementById('rb-standing');
            const sStr = filterStanding ? sEl.options[sEl.selectedIndex].text : 'All Standings';
            scopeName  = `${cStr} (${sStr})`;
        }

        const modeLabel = isModeA ? 'A' : (isModeB ? 'B' : 'C');
        currentQueryMeta = { selectedSems, semText, scopeName, subText, scope, targetStudentId, mode: modeLabel };

        // ── Render ────────────────────────────────────────────────────────────
        const tbody = document.getElementById('reportTableBody');
        const table = tbody.closest('table');
        const thead = table.querySelector('thead');

        await sleep(200);
        btn.innerHTML = `<i class="fa-solid fa-object-group fa-fade"></i> Rendering interface...`;

        // ════════════════════════════════════════════════════════════════════
        // MODE A — Term summary or multi-term comparison
        // ════════════════════════════════════════════════════════════════════
        if (isModeA) {
            const studentIds = [...new Set(filteredGrades.map(g => g.studentId))].sort((a, b) => {
                return (studentMap[a]?.name || a).localeCompare(studentMap[b]?.name || b);
            });

            if (selectedSems.length === 1) {
                // ── A-single: Student | Subject avgs | Overall ────────────
                currentQueryMeta.subMode = 'single';
                const allSubjects = [...new Set(filteredGrades.map(g => g.subject || 'Uncategorized'))].sort();
                currentQueryMeta.subjects = allSubjects;

                const rows = studentIds.map(sid => {
                    const sGrades     = filteredGrades.filter(g => g.studentId === sid);
                    const studentName = sGrades[0]?.studentName || sid;
                    const { subjectAvgs, overall } = computeStudentSummary(sGrades);
                    return { studentId: sid, studentName, subjectAvgs, overall };
                });
                currentQueryResults = rows;

                // Stats
                const overalls  = rows.map(r => r.overall).filter(v => v !== null);
                const classAvg  = overalls.length ? Math.round(overalls.reduce((a, b) => a + b, 0) / overalls.length) : null;
                document.getElementById('resAvg').innerHTML  = classAvg !== null ? `${classAvg}<span class="text-sm text-[#6b84a0] ml-1">%</span>` : '—';
                document.getElementById('resHigh').innerHTML = overalls.length ? `${Math.max(...overalls)}<span class="text-sm text-[#0ea871] ml-1">%</span>` : '—';
                document.getElementById('resLow').innerHTML  = overalls.length ? `${Math.min(...overalls)}<span class="text-sm text-[#e31b4a] ml-1">%</span>` : '—';
                document.getElementById('resCount').textContent = rows.length + ' students';

                // Thead
                thead.innerHTML = `<tr class="bg-slate-50 border-y border-slate-200">
                    <th class="px-6 py-4 text-left text-[11px] font-black uppercase tracking-widest text-slate-400">Student</th>
                    ${allSubjects.map(s => `<th class="px-6 py-4 text-center text-[11px] font-black uppercase tracking-widest text-slate-400">${escHtml(s)}</th>`).join('')}
                    <th class="px-6 py-4 text-center text-[11px] font-black uppercase tracking-widest text-slate-400">Overall</th>
                </tr>`;

                // Tbody
                if (!rows.length) {
                    tbody.innerHTML = `<tr><td colspan="${allSubjects.length + 2}" class="px-6 py-12 text-center text-[#9ab0c6] italic font-semibold">No records found for this period.</td></tr>`;
                } else {
                    tbody.innerHTML = rows.map(row => {
                        const oCol = row.overall !== null ? gradeColorClass(row.overall) : 'text-slate-400';
                        return `<tr class="border-b border-[#f0f4f8] hover:bg-[#f8fafb] transition">
                            <td class="px-6 py-4 font-bold text-[#0d1f35] text-[13px]">${escHtml(row.studentName)}</td>
                            ${allSubjects.map(s => {
                                const avg = row.subjectAvgs[s] ?? null;
                                const col = avg !== null ? gradeColorClass(avg) : 'text-slate-400';
                                return `<td class="px-6 py-4 text-center font-mono font-bold ${col}">${avg !== null ? avg + '%' : '—'}</td>`;
                            }).join('')}
                            <td class="px-6 py-4 text-center font-mono font-bold text-[16px] ${oCol}">${row.overall !== null ? row.overall + '%' : '—'}</td>
                        </tr>`;
                    }).join('');
                }

            } else {
                // ── A-multi: Student | Term1 | Term2 | ... | Cumulative ───
                currentQueryMeta.subMode = 'multi';
                const termNames = selectedSems.map(sid => rawSemesters.find(s => s.id === sid)?.name || sid);
                currentQueryMeta.termNames = termNames;

                const rows = studentIds.map(sid => {
                    const studentName = filteredGrades.find(g => g.studentId === sid)?.studentName || sid;
                    const termAvgs    = {};
                    let cumTotal = 0, cumCount = 0;
                    selectedSems.forEach((semId, i) => {
                        const tGrades = filteredGrades.filter(g => g.studentId === sid && g.semesterId === semId);
                        const { overall } = computeStudentSummary(tGrades);
                        termAvgs[termNames[i]] = overall;
                        if (overall !== null) { cumTotal += overall; cumCount++; }
                    });
                    return { studentId: sid, studentName, termAvgs, cumulative: cumCount > 0 ? Math.round(cumTotal / cumCount) : null, termNames };
                });
                currentQueryResults = rows;

                // Stats
                const cumulatives = rows.map(r => r.cumulative).filter(v => v !== null);
                const classAvg    = cumulatives.length ? Math.round(cumulatives.reduce((a, b) => a + b, 0) / cumulatives.length) : null;
                document.getElementById('resAvg').innerHTML  = classAvg !== null ? `${classAvg}<span class="text-sm text-[#6b84a0] ml-1">%</span>` : '—';
                document.getElementById('resHigh').innerHTML = cumulatives.length ? `${Math.max(...cumulatives)}<span class="text-sm text-[#0ea871] ml-1">%</span>` : '—';
                document.getElementById('resLow').innerHTML  = cumulatives.length ? `${Math.min(...cumulatives)}<span class="text-sm text-[#e31b4a] ml-1">%</span>` : '—';
                document.getElementById('resCount').textContent = rows.length + ' students';

                // Thead
                thead.innerHTML = `<tr class="bg-slate-50 border-y border-slate-200">
                    <th class="px-6 py-4 text-left text-[11px] font-black uppercase tracking-widest text-slate-400">Student</th>
                    ${termNames.map(t => `<th class="px-6 py-4 text-center text-[11px] font-black uppercase tracking-widest text-slate-400">${escHtml(t)}</th>`).join('')}
                    <th class="px-6 py-4 text-center text-[11px] font-black uppercase tracking-widest text-slate-400">Cumulative</th>
                </tr>`;

                // Tbody
                if (!rows.length) {
                    tbody.innerHTML = `<tr><td colspan="${termNames.length + 2}" class="px-6 py-12 text-center text-[#9ab0c6] italic font-semibold">No records found.</td></tr>`;
                } else {
                    tbody.innerHTML = rows.map(row => {
                        const cCol = row.cumulative !== null ? gradeColorClass(row.cumulative) : 'text-slate-400';
                        return `<tr class="border-b border-[#f0f4f8] hover:bg-[#f8fafb] transition">
                            <td class="px-6 py-4 font-bold text-[#0d1f35] text-[13px]">${escHtml(row.studentName)}</td>
                            ${termNames.map(t => {
                                const avg = row.termAvgs[t] ?? null;
                                const col = avg !== null ? gradeColorClass(avg) : 'text-slate-400';
                                return `<td class="px-6 py-4 text-center font-mono font-bold ${col}">${avg !== null ? avg + '%' : '—'}</td>`;
                            }).join('')}
                            <td class="px-6 py-4 text-center font-mono font-bold text-[16px] ${cCol}">${row.cumulative !== null ? row.cumulative + '%' : '—'}</td>
                        </tr>`;
                    }).join('');
                }
            }

            document.getElementById('reportOutputTitle').textContent =
                currentQueryMeta.subMode === 'multi' ? 'Multi-Term Comparison' : 'Term Summary Report';

        // ════════════════════════════════════════════════════════════════════
        // MODE B — Subjects selected, all types included, grouped by type
        // MODE C — Subjects + Types selected, fully filtered detail
        // ════════════════════════════════════════════════════════════════════
        } else {
            filteredGrades.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
            currentQueryResults = filteredGrades;

            // Stats
            let high = null, low = null, validCount = 0;
            filteredGrades.forEach(g => {
                if (g.max > 0) {
                    const pct = Math.round((g.score / g.max) * 100);
                    validCount++;
                    if (high === null || pct > high) high = pct;
                    if (low  === null || pct < low ) low  = pct;
                }
            });
            const avg = validCount > 0 ? calculateWeightedAverage(filteredGrades, getGradeTypes()) : null;
            document.getElementById('resAvg').innerHTML  = avg  !== null ? `${avg}<span class="text-sm text-[#6b84a0] ml-1">%</span>` : '—';
            document.getElementById('resHigh').innerHTML = high !== null ? `${high}<span class="text-sm text-[#0ea871] ml-1">%</span>` : '—';
            document.getElementById('resLow').innerHTML  = low  !== null ? `${low}<span class="text-sm text-[#e31b4a] ml-1">%</span>` : '—';
            document.getElementById('resCount').textContent = filteredGrades.length;

            // Thead
            thead.innerHTML = `<tr class="bg-slate-50 border-y border-slate-200">
                <th class="px-6 py-4 text-left text-[11px] font-black uppercase tracking-widest text-slate-400">Date</th>
                <th class="px-6 py-4 text-left text-[11px] font-black uppercase tracking-widest text-slate-400">Student</th>
                <th class="px-6 py-4 text-left text-[11px] font-black uppercase tracking-widest text-slate-400">Subject</th>
                <th class="px-6 py-4 text-left text-[11px] font-black uppercase tracking-widest text-slate-400">Assignment</th>
                <th class="px-6 py-4 text-left text-[11px] font-black uppercase tracking-widest text-slate-400">Type</th>
                <th class="px-6 py-4 text-center text-[11px] font-black uppercase tracking-widest text-slate-400">Weight</th>
                <th class="px-6 py-4 text-center text-[11px] font-black uppercase tracking-widest text-slate-400">Score</th>
                <th class="px-6 py-4 text-center text-[11px] font-black uppercase tracking-widest text-slate-400">%</th>
            </tr>`;

            if (!filteredGrades.length) {
                tbody.innerHTML = `<tr><td colspan="8" class="px-6 py-12 text-center text-[#9ab0c6] italic font-semibold">Query returned 0 matching records.</td></tr>`;
            } else {
                tbody.innerHTML = filteredGrades.map(g => {
                    const pct    = g.max ? Math.round((g.score / g.max) * 100) : null;
                    const cClass = gradeColorClass(pct || 0);
                    const w      = getWeight(g.type);
                    const semTag = selectedSems.length > 1
                        ? `<br><span class="text-[9px] uppercase text-[#2563eb]">${rawSemesters.find(s => s.id === g.semesterId)?.name || ''}</span>`
                        : '';
                    return `
                    <tr class="border-b border-[#f0f4f8] hover:bg-[#f8fafb] transition">
                        <td class="px-6 py-4 text-[12px] font-mono text-[#6b84a0] leading-tight">${g.date || '—'}${semTag}</td>
                        <td class="px-6 py-4 font-bold text-[#0d1f35] text-[13px]">${escHtml(g.studentName)}</td>
                        <td class="px-6 py-4"><span class="text-[10px] font-black bg-[#eef4ff] text-[#2563eb] border border-[#c7d9fd] px-2.5 py-1 rounded tracking-wide">${escHtml(g.subject || '—')}</span></td>
                        <td class="px-6 py-4 font-bold text-[#374f6b] text-[13px]">${escHtml(g.title || '—')}</td>
                        <td class="px-6 py-4"><span class="text-[10px] font-black uppercase tracking-widest bg-[#f8fafb] text-[#6b84a0] border border-[#dce3ed] px-2 py-1 rounded">${escHtml(g.type || '—')}</span></td>
                        <td class="px-6 py-4 text-center"><span class="text-[10px] font-black bg-amber-50 text-amber-700 border border-amber-200 px-2 py-1 rounded">${w !== null ? w + '%' : '—'}</span></td>
                        <td class="px-6 py-4 text-center font-mono font-bold text-[#0d1f35] text-[13px]">${g.score} / ${g.max || '?'}</td>
                        <td class="px-6 py-4 text-center"><span class="font-black font-mono text-[14px] ${cClass}">${pct !== null ? pct + '%' : '—'}</span></td>
                    </tr>`;
                }).join('');
            }

            document.getElementById('reportOutputTitle').textContent =
                scope === 'class' ? 'Aggregated Class Data' : 'Student Academic Profile';
        }

        document.getElementById('reportOutputMeta').textContent = `${semText} · ${scopeName} · ${subText}`;
        area.classList.remove('hidden');
        setTimeout(() => { area.classList.remove('opacity-0'); }, 50);

    } catch (e) {
        console.error(e);
        alert("System Error: Query execution failed.");
    }

    btn.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i> Generate Report`;
    btn.disabled  = false;
}

// ── 6. CSV EXPORT ─────────────────────────────────────────────────────────────
window.exportReportCSV = function() {
    if (!currentQueryResults || !currentQueryResults.length) {
        alert("No data to export.");
        return;
    }

    const meta = currentQueryMeta;
    let rows   = [];

    if (meta.mode === 'A') {
        if (meta.subMode === 'single') {
            const subjects = meta.subjects || [];
            rows.push(['Student', ...subjects, 'Overall']);
            currentQueryResults.forEach(r => {
                rows.push([r.studentName, ...subjects.map(s => r.subjectAvgs[s] !== undefined ? r.subjectAvgs[s] + '%' : '—'), r.overall !== null ? r.overall + '%' : '—']);
            });
        } else {
            const terms = meta.termNames || [];
            rows.push(['Student', ...terms, 'Cumulative']);
            currentQueryResults.forEach(r => {
                rows.push([r.studentName, ...terms.map(t => r.termAvgs[t] !== null ? r.termAvgs[t] + '%' : '—'), r.cumulative !== null ? r.cumulative + '%' : '—']);
            });
        }
    } else {
        rows.push(['Period', 'Date', 'Student', 'Subject', 'Assignment', 'Type', 'Weight', 'Score', 'Max', '%', 'Letter Grade', 'Notes']);
        currentQueryResults.forEach(g => {
            const pct        = g.max ? Math.round((g.score / g.max) * 100) : null;
            const periodName = rawSemesters.find(s => s.id === g.semesterId)?.name || '';
            const w          = getWeight(g.type);
            rows.push([
                periodName, g.date || '', g.studentName || '', g.subject || '',
                g.title || '', g.type || '', w !== null ? w + '%' : '',
                g.score, g.max || '', pct !== null ? pct + '%' : '',
                pct !== null ? letterGrade(pct) : '', g.notes || ''
            ]);
        });
    }

    const safeName = meta.scopeName.replace(/\s+/g, '_').toLowerCase();
    downloadCSV(rows, `connectus_report_${safeName}.csv`);
};

// ── 7. PRINT ──────────────────────────────────────────────────────────────────
window.printReport = function() {
    if (!currentQueryResults || !currentQueryResults.length) {
        alert("No data to print.");
        return;
    }

    const meta         = currentQueryMeta;
    const logoUrl      = new URL('../../assets/images/logo.png', window.location.href).href;
    const printDate    = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const teacherName  = session.teacherData?.name || 'Teacher';
    const schoolName   = resolvedSchoolName || session.schoolName || session.schoolId || 'ConnectUs School';

    let reportTitle = 'Academic Report';
    if (meta.mode === 'A' && meta.subMode === 'multi') reportTitle = 'Multi-Term Comparison';
    else if (meta.mode === 'A' && meta.scope === 'student') reportTitle = 'Student Report Card';
    else if (meta.mode === 'A')                         reportTitle = 'Term Summary Report';
    else if (meta.scope === 'student')                  reportTitle = 'Student Academic Report';

    function printColor(pct) {
        if (pct >= 90) return '#059669';
        if (pct >= 80) return '#2563eb';
        if (pct >= 70) return '#0d9488';
        if (pct >= 65) return '#d97706';
        return '#dc2626';
    }

    // ── Build body ────────────────────────────────────────────────────────────
    let bodyHtml = '';

    if (meta.mode === 'A') {

        if (meta.subMode === 'single') {
            const subjects = meta.subjects || [];

            if (meta.scope === 'student') {
                // ── Individual student → report-card layout (subjects as rows) ──
                const row = currentQueryResults[0] || { subjectAvgs: {}, overall: null, studentName: meta.scopeName };
                let rcRows = subjects.map(s => {
                    const avg = row.subjectAvgs[s] ?? null;
                    const col = avg !== null ? printColor(avg) : '#94a3b8';
                    return `<tr>
                        <td style="font-weight:700;">${escHtml(s)}</td>
                        <td class="center mono" style="color:${col};font-weight:800;">${avg !== null ? avg + '%' : '—'}</td>
                        <td class="center" style="color:${col};font-weight:800;">${avg !== null ? letterGrade(avg) : '—'}</td>
                    </tr>`;
                }).join('');

                const oCol = row.overall !== null ? printColor(row.overall) : '#94a3b8';
                rcRows += `<tr class="avg-row">
                    <td class="avg-label" style="text-align:left;">Overall Average</td>
                    <td class="center avg-val" style="color:${oCol};">${row.overall !== null ? row.overall + '%' : '—'}</td>
                    <td class="center avg-val" style="color:${oCol};">${row.overall !== null ? letterGrade(row.overall) : '—'}</td>
                </tr>`;

                bodyHtml = `
                <div class="sem-block">
                    <div class="sem-title">${escHtml(meta.semText)} — Report Card</div>
                    <table>
                        <thead><tr>
                            <th>Subject</th>
                            <th class="center">Grade</th>
                            <th class="center">Letter</th>
                        </tr></thead>
                        <tbody>${rcRows}</tbody>
                    </table>
                </div>`;

            } else {
                // ── Class → summary table (students as rows, subjects as columns) ──
                let rowsHtml = '';
                currentQueryResults.forEach(row => {
                    const oCol = row.overall !== null ? printColor(row.overall) : '#94a3b8';
                    rowsHtml += `<tr>
                        <td style="font-weight:700;">${escHtml(row.studentName)}</td>
                        ${subjects.map(s => {
                            const avg = row.subjectAvgs[s] ?? null;
                            const col = avg !== null ? printColor(avg) : '#94a3b8';
                            return `<td class="center mono" style="color:${col};">${avg !== null ? avg + '%' : '—'}</td>`;
                        }).join('')}
                        <td class="center mono" style="color:${oCol};font-size:14px;font-weight:900;">${row.overall !== null ? row.overall + '%' : '—'}</td>
                    </tr>`;
                });

                bodyHtml = `
                <div class="sem-block">
                    <div class="sem-title">${escHtml(meta.semText)}</div>
                    <table>
                        <thead><tr>
                            <th>Student</th>
                            ${subjects.map(s => `<th class="center">${escHtml(s)}</th>`).join('')}
                            <th class="center">Overall</th>
                        </tr></thead>
                        <tbody>${rowsHtml}</tbody>
                    </table>
                </div>`;
            }

        } else {
            // Multi-term comparison table
            const termNames = meta.termNames || [];
            let rowsHtml    = '';
            currentQueryResults.forEach(row => {
                const cCol = row.cumulative !== null ? printColor(row.cumulative) : '#94a3b8';
                rowsHtml += `<tr>
                    <td style="font-weight:700;">${escHtml(row.studentName)}</td>
                    ${termNames.map(t => {
                        const avg = row.termAvgs[t] ?? null;
                        const col = avg !== null ? printColor(avg) : '#94a3b8';
                        return `<td class="center mono" style="color:${col};">${avg !== null ? avg + '%' : '—'}</td>`;
                    }).join('')}
                    <td class="center mono" style="color:${cCol};font-size:14px;font-weight:900;">${row.cumulative !== null ? row.cumulative + '%' : '—'}</td>
                </tr>`;
            });

            bodyHtml = `
            <div class="sem-block">
                <div class="sem-title">Multi-Term Comparison — ${escHtml(meta.scopeName)}</div>
                <table>
                    <thead><tr>
                        <th>Student</th>
                        ${termNames.map(t => `<th class="center">${escHtml(t)}</th>`).join('')}
                        <th class="center">Cumulative</th>
                    </tr></thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
            </div>`;
        }

    } else if (meta.mode === 'B') {
        // Mode B: grouped by student → grouped by type within each student
        const studentIds = [...new Set(currentQueryResults.map(g => g.studentId))];

        studentIds.forEach(sid => {
            const sGrades     = currentQueryResults.filter(g => g.studentId === sid);
            const studentName = sGrades[0]?.studentName || sid;

            const byType = {};
            sGrades.forEach(g => {
                const type = g.type || 'Uncategorized';
                if (!byType[type]) byType[type] = [];
                byType[type].push(g);
            });

            let studentRows = '';
            for (const type in byType) {
                const w = getWeight(type);
                studentRows += `<tr style="background:#f0f4f9;">
                    <td colspan="5" style="padding:8px 14px;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:1.5px;color:#374f6b;">
                        ${escHtml(type)}${w !== null ? ` — ${w}% weight` : ''}
                    </td>
                </tr>`;
                byType[type].sort((a, b) => (a.date || '').localeCompare(b.date || '')).forEach(g => {
                    const pct = g.max ? Math.round((g.score / g.max) * 100) : null;
                    const col = pct !== null ? printColor(pct) : '#0d1f35';
                    studentRows += `<tr>
                        <td class="mono" style="color:#6b84a0;">${g.date || '—'}</td>
                        <td>${escHtml(g.subject || '—')}</td>
                        <td>${escHtml(g.title || '—')}</td>
                        <td class="center mono">${g.score} / ${g.max ?? '?'}</td>
                        <td class="center mono" style="color:${col};font-weight:800;">${pct !== null ? pct + '%' : '—'}</td>
                    </tr>`;
                });
            }

            const { overall } = computeStudentSummary(sGrades);
            if (overall !== null) {
                const col = printColor(overall);
                studentRows += `<tr class="avg-row">
                    <td colspan="3" class="avg-label">Student Average</td>
                    <td colspan="2" class="center avg-val" style="color:${col};">${overall}% (${letterGrade(overall)})</td>
                </tr>`;
            }

            bodyHtml += `
            <div class="sem-block">
                <div class="sem-title">${escHtml(studentName)}</div>
                <table>
                    <thead><tr>
                        <th>Date</th><th>Subject</th><th>Assignment</th>
                        <th class="center">Score</th><th class="center">%</th>
                    </tr></thead>
                    <tbody>${studentRows}</tbody>
                </table>
            </div>`;
        });

    } else {
        // Mode C: detailed filtered table grouped by semester
        const bySem = {};
        currentQueryResults.forEach(g => {
            const sName = rawSemesters.find(s => s.id === g.semesterId)?.name || 'Unknown Period';
            if (!bySem[sName]) bySem[sName] = [];
            bySem[sName].push(g);
        });

        for (const sName in bySem) {
            let rowsHtml = '';
            bySem[sName].forEach(g => {
                const pct = g.max ? Math.round((g.score / g.max) * 100) : null;
                const w   = getWeight(g.type);
                const col = pct !== null ? printColor(pct) : '#0d1f35';
                rowsHtml += `<tr>
                    <td class="mono" style="color:#6b84a0;">${g.date || '—'}</td>
                    ${meta.scope !== 'student' ? `<td style="font-weight:700;">${escHtml(g.studentName || '—')}</td>` : ''}
                    <td>${escHtml(g.subject || '—')}</td>
                    <td>${escHtml(g.title || '—')}</td>
                    <td class="center type-cell">${escHtml(g.type || '—')}</td>
                    <td class="center weight-cell">${w !== null ? w + '%' : '—'}</td>
                    <td class="center mono">${g.score} / ${g.max ?? '?'}</td>
                    <td class="center mono" style="color:${col};font-weight:800;">${pct !== null ? pct + '%' : '—'}</td>
                </tr>`;
            });

            const semAvg = calculateWeightedAverage(bySem[sName], getGradeTypes());
            if (semAvg !== null) {
                const col  = printColor(semAvg);
                const cols = meta.scope === 'student' ? 6 : 7;
                rowsHtml += `<tr class="avg-row">
                    <td colspan="${cols}" class="avg-label">Term Average</td>
                    <td class="center avg-val" style="color:${col};">${semAvg}% (${letterGrade(semAvg)})</td>
                </tr>`;
            }

            bodyHtml += `
            <div class="sem-block">
                <div class="sem-title">${escHtml(sName)}</div>
                <table>
                    <thead><tr>
                        <th>Date</th>
                        ${meta.scope !== 'student' ? '<th>Student</th>' : ''}
                        <th>Subject</th><th>Assignment</th>
                        <th class="center">Type</th><th class="center">Weight</th>
                        <th class="center">Score</th><th class="center">%</th>
                    </tr></thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
            </div>`;
        }
    }

    // ── Assemble full print document ──────────────────────────────────────────
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>${escHtml(reportTitle)} — ${escHtml(meta.scopeName)}</title>
    <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Segoe UI', Arial, sans-serif; background: #fff; color: #0d1f35; font-size: 11.5px; line-height: 1.5; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        .report-header { display:flex; align-items:center; justify-content:space-between; padding:24px 36px 20px; border-bottom:3px solid #0d1f35; }
        .header-left   { display:flex; align-items:center; gap:16px; }
        .logo          { width:52px; height:52px; object-fit:contain; }
        .brand-name    { font-size:22px; font-weight:900; color:#0d1f35; letter-spacing:-0.5px; }
        .brand-tag     { font-size:10px; color:#2563eb; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; margin-top:2px; }
        .header-right  { text-align:right; }
        .report-title  { font-size:15px; font-weight:800; color:#0d1f35; text-transform:uppercase; letter-spacing:1px; }
        .report-sub    { font-size:11px; color:#2563eb; font-weight:700; text-transform:uppercase; letter-spacing:0.8px; margin-top:3px; }
        .report-date   { font-size:10px; color:#6b84a0; margin-top:3px; font-weight:500; }
        .info-bar      { background:#f4f7fb; border-bottom:1px solid #dce3ed; padding:14px 36px; display:grid; grid-template-columns:repeat(3,1fr); }
        .info-field            { padding:0 16px; }
        .info-field:first-child { padding-left:0; }
        .info-field:not(:last-child) { border-right:1px solid #dce3ed; }
        .f-label { font-size:9px; text-transform:uppercase; letter-spacing:1.2px; font-weight:700; color:#94a3b8; display:block; margin-bottom:3px; }
        .f-value { font-size:13px; font-weight:800; color:#0d1f35; }
        .section-label { padding:20px 36px 10px; font-size:9px; font-weight:700; color:#94a3b8; text-transform:uppercase; letter-spacing:1.5px; }
        .content    { padding:0 36px; }
        .sem-block  { margin-bottom:24px; border:1px solid #e2e8f0; border-radius:8px; overflow:hidden; page-break-inside:avoid; }
        .sem-title  { background:#0d1f35; color:#fff; padding:10px 16px; font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:1.5px; }
        table { width:100%; border-collapse:collapse; }
        thead th { background:#f8fafc; font-size:9px; font-weight:700; text-transform:uppercase; letter-spacing:0.8px; color:#6b84a0; padding:8px 14px; text-align:left; border-bottom:1px solid #e8edf4; }
        thead th.center { text-align:center; }
        tbody tr:nth-child(even) { background:#fafbfc; }
        tbody td { padding:9px 14px; border-bottom:1px solid #f0f4f9; font-size:11px; color:#0d1f35; vertical-align:middle; }
        tbody td.center { text-align:center; }
        .mono        { font-family:'Courier New',monospace; font-weight:700; }
        .weight-cell { font-size:11px; font-weight:800; color:#b45309; }
        .type-cell   { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.5px; color:#64748b; }
        .avg-row td  { background:#f0f4f9; border-top:2px solid #dce3ed; padding:10px 14px; font-weight:700; }
        .avg-label   { text-align:right; color:#374f6b; font-style:italic; font-size:11px; }
        .avg-val     { font-size:14px; font-weight:900; text-align:center; }
        .report-footer { margin-top:24px; padding:14px 36px; border-top:1px solid #dce3ed; display:flex; justify-content:space-between; color:#94a3b8; font-size:9px; }
        .footer-brand  { font-weight:700; color:#2563eb; }
        .disclaimer    { padding:8px 36px 20px; font-size:9px; color:#94a3b8; text-align:center; font-style:italic; }
        @media print { .sem-block { page-break-inside:avoid; } }
    </style>
</head>
<body>
    <div class="report-header">
        <div class="header-left">
            <div>
                <div class="brand-name">${escHtml(schoolName)}</div>
            </div>
        </div>
        <div class="header-right">
            <div class="report-title">${escHtml(reportTitle)}</div>
            <div class="report-sub">${escHtml(meta.semText)} · ${escHtml(meta.subText)}</div>
            <div class="report-date">Printed: ${printDate}</div>
        </div>
    </div>
    <div class="info-bar">
        <div class="info-field"><span class="f-label">Scope</span><span class="f-value">${escHtml(meta.scopeName)}</span></div>
        <div class="info-field"><span class="f-label">Teacher</span><span class="f-value">${escHtml(teacherName)}</span></div>
        <div class="info-field"><span class="f-label">Term</span><span class="f-value">${escHtml(meta.semText)}</span></div>
    </div>
    <div class="section-label">
        ${meta.mode === 'A'
            ? (meta.subMode === 'multi'
                ? 'Term-by-Term Comparison'
                : (meta.scope === 'student' ? 'Grades by Subject' : 'Subject Averages by Student'))
            : 'Grade Entries'}
    </div>
    <div class="content">${bodyHtml}</div>
    <div class="report-footer">
        <div>Generated by <span class="footer-brand">ConnectUs</span> · Academic Management Platform</div>
        <div>${escHtml(meta.scopeName)} · ${escHtml(meta.semText)} · ${printDate}</div>
    </div>
    <div class="disclaimer">
        This document is generated from live gradebook data and does not constitute a finalized official transcript.
        For a certified copy, contact school administration.
    </div>
</body>
</html>`;

    const w = window.open('', '_blank');
    if (!w) { alert('Pop-ups are blocked. Please allow pop-ups to print.'); return; }
    w.document.write(html);
    w.document.close();
    setTimeout(() => w.print(), 600);
};

init();
