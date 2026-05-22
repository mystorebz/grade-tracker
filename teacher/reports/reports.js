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

// ── 2. STATE VARIABLES ──────────────────────────────────────────────────────
let allStudentsCache = [];
let studentMap       = {};
let rawSemesters     = [];
let allGradesCache   = {};
let currentQueryResults = [];
let currentQueryMeta    = {};

const DEFAULT_GRADE_TYPES = ['Test', 'Quiz', 'Assignment', 'Homework', 'Project', 'Midterm Exam', 'Final Exam'];
function getGradeTypes() { return session.teacherData.gradeTypes || session.teacherData.customGradeTypes || DEFAULT_GRADE_TYPES; }

// ── Weight lookup — returns numeric weight or null ────────────────────────────
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

function escHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ── 3. INITIALIZATION ───────────────────────────────────────────────────────
async function init() {
    if (!session) return;
    document.getElementById('rb-scope').addEventListener('change', toggleScope);
    document.getElementById('generateReportBtn').addEventListener('click', executeIntelligentQuery);
    populateStaticCheckboxes();
    await loadSemesters();
    await loadStudents();
}

// Fix 1: default isChecked = false — nothing pre-selected on load
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
    // Subjects — Fix 1: pass false, nothing pre-checked
    const subjects = (session.teacherData.subjects || []);
    const subGrid  = document.getElementById('rb-subject-grid');
    if (subGrid) {
        subGrid.innerHTML = subjects.map(s => buildCheckbox('sub', s.name, s.name, false)).join('')
            || '<p class="text-xs text-slate-400">No subjects found.</p>';
    }

    // Types — Fix 1: pass false, nothing pre-checked
    let types        = getGradeTypes().map(t => t.name || t);
    let archivedTypes = session.teacherData.archivedGradeTypes || [];
    let allTypes     = [...new Set([...types, ...archivedTypes])];
    const typeGrid   = document.getElementById('rb-type-grid');
    if (typeGrid) {
        typeGrid.innerHTML = allTypes.map(t => buildCheckbox('typ', t, t, false)).join('');
    }

    // Class filter dropdown
    const classes  = session.teacherData.classes || [session.teacherData.className || ''];
    const classSel = document.getElementById('rb-class');
    if (classSel && classes.length > 0) {
        classSel.innerHTML = '<option value="">All Classes</option>'
            + classes.filter(Boolean).map(c => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join('');
    }
}

async function loadSemesters() {
    try {
        let rawSems   = [];
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
        } catch(e) {}

        const topSemSel = document.getElementById('activeSemester');
        const sbPeriod  = document.getElementById('sb-period');

        if (topSemSel) {
            topSemSel.innerHTML = '';
            rawSemesters.forEach(s => {
                const opt = document.createElement('option');
                opt.value       = s.id;
                opt.textContent = s.name;
                if (s.id === activeId) opt.selected = true;
                topSemSel.appendChild(opt);
            });
            if (sbPeriod) sbPeriod.textContent = topSemSel.options[topSemSel.selectedIndex]?.text || '—';
            topSemSel.addEventListener('change', () => {
                if (sbPeriod) sbPeriod.textContent = topSemSel.options[topSemSel.selectedIndex]?.text || '—';
            });
        }

        // Fix 1: all semesters unchecked — pass false (previously pre-checked active semester)
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

        const sortedStudents = [...allStudentsCache].sort((a, b) => a.name.localeCompare(b.name));
        stuSel.innerHTML = '<option value="">— Target a specific student —</option>'
            + sortedStudents.map(s => `<option value="${s.id}">${escHtml(s.name)} ${s.archived ? '(Archived)' : ''}</option>`).join('');
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
        document.getElementById('rb-class').value   = '';
        document.getElementById('rb-standing').value = '';
    } else {
        studentWrap.classList.add('hidden');
        classWrap.classList.remove('hidden');
        standingWrap.classList.remove('hidden');
        document.getElementById('rb-student').value = '';
    }
}

function getCheckedValues(containerId) {
    const checkboxes = document.querySelectorAll(`#${containerId} input[type="checkbox"]:checked`);
    return Array.from(checkboxes).map(cb => cb.value);
}

// ── 4. DATA FETCHING ENGINE ─────────────────────────────────────────────────
async function fetchGradesForSemesters(semIds) {
    let all = [];
    for (const semId of semIds) {
        if (allGradesCache[semId]) {
            all = all.concat(allGradesCache[semId]);
            continue;
        }
        let semGrades = [];
        await Promise.all(allStudentsCache.map(async s => {
            try {
                const q    = query(collection(db, 'students', s.id, 'grades'), where('schoolId', '==', session.schoolId), where('semesterId', '==', semId));
                const snap = await getDocs(q);
                snap.forEach(d => {
                    const data = d.data();
                    semGrades.push({ id: d.id, studentId: s.id, studentName: s.name, semesterId: data.semesterId, ...data });
                });
            } catch (e) {}
        }));
        allGradesCache[semId] = semGrades;
        all = all.concat(semGrades);
    }
    return all;
}

// ── 5. INTELLIGENT GENERATOR ─────────────────────────────────────────────────
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

    if (scope === 'student' && !targetStudentId) {
        alert("System Notice: A target student must be selected to generate an individual report.");
        return;
    }

    if (!selectedSems.length || !selectedSubs.length || !selectedTypes.length) {
        alert("System Notice: You must select at least one Period, Subject, and Grade Type to run a query.");
        return;
    }

    btn.disabled = true;
    const area = document.getElementById('reportResultsArea');
    area.classList.add('opacity-0');

    try {
        btn.innerHTML = `<i class="fa-solid fa-database fa-fade"></i> Querying datastore...`;
        const rawGrades = await fetchGradesForSemesters(selectedSems);
        await sleep(350);

        btn.innerHTML = `<i class="fa-solid fa-microchip fa-fade"></i> Filtering datasets...`;
        let filteredGrades = rawGrades;

        if (scope === 'student') {
            filteredGrades = filteredGrades.filter(g => g.studentId === targetStudentId);
        } else if (filterClass) {
            filteredGrades = filteredGrades.filter(g => {
                const student = studentMap[g.studentId];
                return student && student.className === filterClass;
            });
        }

        filteredGrades = filteredGrades.filter(g => selectedSubs.includes(g.subject));
        filteredGrades = filteredGrades.filter(g => selectedTypes.includes(g.type));

        if (scope === 'class' && filterStanding) {
            const studentAvgs = {};
            filteredGrades.forEach(g => {
                if (!studentAvgs[g.studentId]) studentAvgs[g.studentId] = [];
                if (g.max > 0) studentAvgs[g.studentId].push(g);
            });

            const allowedStudentIds = new Set();
            Object.entries(studentAvgs).forEach(([sid, grades]) => {
                if (grades.length > 0) {
                    const avg = calculateWeightedAverage(grades, getGradeTypes());
                    if (avg !== null) {
                        let std = 'none';
                        if (avg >= 90) std = 'excelling';
                        else if (avg >= 80) std = 'good';
                        else if (avg >= 70) std = 'ontrack';
                        else if (avg >= 65) std = 'needsattention';
                        else std = 'atrisk';
                        if (std === filterStanding) allowedStudentIds.add(sid);
                    }
                }
            });

            filteredGrades = filteredGrades.filter(g => allowedStudentIds.has(g.studentId));
        }

        filteredGrades.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
        currentQueryResults = filteredGrades;
        await sleep(350);

        btn.innerHTML = `<i class="fa-solid fa-chart-pie fa-fade"></i> Calculating aggregates...`;

        const totalSems = rawSemesters.length;
        const totalSubs = (session.teacherData.subjects || []).length;

        let semText  = selectedSems.length === totalSems  ? 'All Periods'  : `${selectedSems.length} Periods`;
        let subText  = selectedSubs.length  >= totalSubs  ? 'All Subjects' : `${selectedSubs.length} Subjects`;

        let scopeName = 'Class Overview';
        if (scope === 'student') {
            scopeName = studentMap[targetStudentId]?.name || 'Student';
        } else {
            const cStr = filterClass ? filterClass : 'All Classes';
            const sEl  = document.getElementById('rb-standing');
            const sStr = filterStanding ? sEl.options[sEl.selectedIndex].text : 'All Standings';
            scopeName  = `${cStr} (${sStr})`;
        }

        currentQueryMeta = { selectedSems, semText, scopeName, subText, scope, targetStudentId };

        let high = null, low = null, validGradesCount = 0;
        filteredGrades.forEach(g => {
            if (g.max > 0) {
                const pct = Math.round((g.score / g.max) * 100);
                validGradesCount++;
                if (high === null || pct > high) high = pct;
                if (low  === null || pct < low ) low  = pct;
            }
        });

        const avg = validGradesCount > 0 ? calculateWeightedAverage(filteredGrades, getGradeTypes()) : null;
        await sleep(300);

        btn.innerHTML = `<i class="fa-solid fa-object-group fa-fade"></i> Rendering interface...`;

        const isTranscript = scope === 'student' && selectedSems.length > 1;
        document.getElementById('reportOutputTitle').textContent = isTranscript
            ? 'Academic Transcript Profile'
            : (scope === 'class' ? 'Aggregated Class Data' : 'Student Academic Profile');
        document.getElementById('reportOutputMeta').textContent = `${semText} · ${scopeName} · ${subText}`;

        document.getElementById('resAvg').innerHTML  = avg  !== null ? `${avg}<span class="text-sm text-[#6b84a0] ml-1">%</span>` : '—';
        document.getElementById('resHigh').innerHTML = high !== null ? `${high}<span class="text-sm text-[#0ea871] ml-1">%</span>` : '—';
        document.getElementById('resLow').innerHTML  = low  !== null ? `${low}<span class="text-sm text-[#e31b4a] ml-1">%</span>` : '—';
        document.getElementById('resCount').textContent = filteredGrades.length;

        const tbody = document.getElementById('reportTableBody');

        // Fix 3: Weight column added to on-screen results table
        // Update thead — caller's HTML must have the 8-column header already,
        // but we rebuild it here dynamically to stay self-contained.
        const thead = tbody.closest('table').querySelector('thead');
        if (thead) {
            thead.innerHTML = `
            <tr class="bg-slate-50 border-y border-slate-200">
                <th class="px-6 py-4 text-left text-[11px] font-black uppercase tracking-widest text-slate-400">Date</th>
                <th class="px-6 py-4 text-left text-[11px] font-black uppercase tracking-widest text-slate-400">Student</th>
                <th class="px-6 py-4 text-left text-[11px] font-black uppercase tracking-widest text-slate-400">Subject</th>
                <th class="px-6 py-4 text-left text-[11px] font-black uppercase tracking-widest text-slate-400">Assignment</th>
                <th class="px-6 py-4 text-left text-[11px] font-black uppercase tracking-widest text-slate-400">Type</th>
                <th class="px-6 py-4 text-center text-[11px] font-black uppercase tracking-widest text-slate-400">Weight</th>
                <th class="px-6 py-4 text-center text-[11px] font-black uppercase tracking-widest text-slate-400">Score</th>
                <th class="px-6 py-4 text-center text-[11px] font-black uppercase tracking-widest text-slate-400">%</th>
            </tr>`;
        }

        if (filteredGrades.length === 0) {
            tbody.innerHTML = `<tr><td colspan="8" class="px-6 py-12 text-center text-[#9ab0c6] italic font-semibold">Query returned 0 matching records.</td></tr>`;
        } else {
            tbody.innerHTML = filteredGrades.map(g => {
                const pct    = g.max ? Math.round((g.score / g.max) * 100) : null;
                const cClass = gradeColorClass(pct || 0);
                const w      = getWeight(g.type);
                const semTag = selectedSems.length > 1
                    ? `<br><span class="text-[9px] uppercase text-[#2563eb]">${rawSemesters.find(s => s.id === g.semesterId)?.name || 'Unknown'}</span>`
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

        area.classList.remove('hidden');
        setTimeout(() => { area.classList.remove('opacity-0'); }, 50);

    } catch (e) {
        console.error(e);
        alert("System Error: Query execution failed.");
    }

    btn.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i> Generate Report`;
    btn.disabled  = false;
}

// ── 6. EXPORT CSV — unchanged ────────────────────────────────────────────────
window.exportReportCSV = function() {
    if (!currentQueryResults || currentQueryResults.length === 0) {
        alert("No data available to export.");
        return;
    }

    const rows = [['Period', 'Date', 'Student', 'Subject', 'Assignment', 'Type', 'Weight', 'Score', 'Max', '%', 'Letter Grade', 'Teacher Notes']];

    currentQueryResults.forEach(g => {
        const pct        = g.max ? Math.round((g.score / g.max) * 100) : null;
        const periodName = rawSemesters.find(s => s.id === g.semesterId)?.name || 'Unknown';
        const w          = getWeight(g.type);

        rows.push([
            periodName,
            g.date        || '',
            g.studentName || '',
            g.subject     || '',
            g.title       || '',
            g.type        || '',
            w !== null ? w + '%' : '',
            g.score,
            g.max         || '',
            pct !== null  ? pct + '%' : '',
            pct !== null  ? letterGrade(pct) : '',
            g.notes       || ''
        ]);
    });

    const safeName = currentQueryMeta.scopeName.replace(/\s+/g, '_').toLowerCase();
    downloadCSV(rows, `connectus_query_${safeName}.csv`);
};

// ── 7. PRINT — Fix 2 (no banner) + Fix 4 (weights) + Fix 5 (consistent style)
window.printReport = function() {
    if (!currentQueryResults || currentQueryResults.length === 0) {
        alert("No data available to print.");
        return;
    }

    const isStudentReport  = currentQueryMeta.scope === 'student';
    const isFullTranscript = currentQueryMeta.selectedSems.length > 1;

    let reportTitle = 'Aggregated Class Report';
    if (isStudentReport && isFullTranscript) reportTitle = 'Academic Transcript';
    else if (isStudentReport)               reportTitle = 'Student Academic Report';

    const logoUrl   = new URL('../../assets/images/logo.png', window.location.href).href;
    const printDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const teacherName  = session.teacherData?.name   || 'Teacher';
    const schoolName   = session.schoolName           || session.schoolId || 'ConnectUs School';
    const scopeName    = currentQueryMeta.scopeName   || '—';
    const semText      = currentQueryMeta.semText     || '—';
    const subText      = currentQueryMeta.subText     || '—';

    // ── Helper: grade color for print ─────────────────────────────────────
    function printColor(pct) {
        if (pct >= 90) return '#059669';
        if (pct >= 80) return '#2563eb';
        if (pct >= 70) return '#0d9488';
        if (pct >= 65) return '#d97706';
        return '#dc2626';
    }

    // ── Build body content ────────────────────────────────────────────────
    let bodyHtml = '';

    if (isStudentReport && isFullTranscript) {
        // Multi-semester transcript view
        const semGroups = {};
        currentQueryResults.forEach(g => {
            const sName = rawSemesters.find(x => x.id === g.semesterId)?.name || 'Unknown Period';
            if (!semGroups[sName]) semGroups[sName] = [];
            semGroups[sName].push(g);
        });

        for (const sName in semGroups) {
            let rowsHtml = '';
            semGroups[sName].sort((a, b) => (a.date || '').localeCompare(b.date || '')).forEach(g => {
                const pct = g.max ? Math.round((g.score / g.max) * 100) : null;
                const w   = getWeight(g.type);
                const col = pct !== null ? printColor(pct) : '#0d1f35';
                rowsHtml += `
                <tr>
                    <td>${escHtml(g.subject || '—')}</td>
                    <td>${escHtml(g.title || '—')}<br><span style="font-size:10px;color:#9ab0c6;">${g.date || ''}</span></td>
                    <td class="center type-cell">${escHtml(g.type || '—')}</td>
                    <td class="center weight-cell">${w !== null ? w + '%' : '—'}</td>
                    <td class="center mono">${g.score} / ${g.max ?? '?'}</td>
                    <td class="center mono" style="color:${col};font-weight:800;">${pct !== null ? pct + '%' : '—'}</td>
                </tr>`;
            });

            const semAvg = semGroups[sName].length > 0
                ? calculateWeightedAverage(semGroups[sName], getGradeTypes())
                : null;
            if (semAvg !== null) {
                const col = printColor(semAvg);
                rowsHtml += `
                <tr class="avg-row">
                    <td colspan="4" class="avg-label">Term Average</td>
                    <td class="center avg-val" style="color:${col};">${semAvg}%</td>
                    <td class="center avg-val" style="color:${col};">${letterGrade(semAvg)}</td>
                </tr>`;
            }

            bodyHtml += `
            <div class="sem-block">
                <div class="sem-title">${escHtml(sName)}</div>
                <table>
                    <thead>
                        <tr>
                            <th>Subject</th>
                            <th>Assignment</th>
                            <th class="center">Type</th>
                            <th class="center">Weight</th>
                            <th class="center">Score</th>
                            <th class="center">%</th>
                        </tr>
                    </thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
            </div>`;
        }

        // Cumulative average
        const cumAvg = currentQueryResults.length > 0
            ? calculateWeightedAverage(currentQueryResults, getGradeTypes())
            : null;
        if (cumAvg !== null) {
            const col = printColor(cumAvg);
            bodyHtml += `
            <div class="cum-box">
                <div>
                    <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;color:#94a3b8;margin-bottom:4px;">Cumulative Academic Average</div>
                    <div style="font-size:13px;font-weight:700;color:#374f6b;">${semText} · ${subText}</div>
                </div>
                <div style="text-align:right;">
                    <div style="font-size:36px;font-weight:900;color:${col};line-height:1;">${cumAvg}%</div>
                    <div style="font-size:16px;font-weight:900;color:${col};">${letterGrade(cumAvg)}</div>
                </div>
            </div>`;
        }

    } else {
        // Standard single-semester or class view
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
                rowsHtml += `
                <tr>
                    <td class="mono" style="color:#6b84a0;">${g.date || '—'}</td>
                    ${!isStudentReport ? `<td style="font-weight:700;">${escHtml(g.studentName || '—')}</td>` : ''}
                    <td>${escHtml(g.subject || '—')}</td>
                    <td>${escHtml(g.title || '—')}</td>
                    <td class="center type-cell">${escHtml(g.type || '—')}</td>
                    <td class="center weight-cell">${w !== null ? w + '%' : '—'}</td>
                    <td class="center mono">${g.score} / ${g.max ?? '?'}</td>
                    <td class="center mono" style="color:${col};font-weight:800;">${pct !== null ? pct + '%' : '—'}</td>
                </tr>`;
            });

            // Term average per semester block
            const semAvg = bySem[sName].length > 0
                ? calculateWeightedAverage(bySem[sName], getGradeTypes())
                : null;
            if (semAvg !== null) {
                const col   = printColor(semAvg);
                const cols  = isStudentReport ? 6 : 7;
                rowsHtml += `
                <tr class="avg-row">
                    <td colspan="${cols}" class="avg-label">Term Average</td>
                    <td class="center avg-val" style="color:${col};">${semAvg}% (${letterGrade(semAvg)})</td>
                </tr>`;
            }

            const colCount = isStudentReport ? 8 : 9;
            bodyHtml += `
            <div class="sem-block">
                <div class="sem-title">${escHtml(sName)}</div>
                <table>
                    <thead>
                        <tr>
                            <th>Date</th>
                            ${!isStudentReport ? '<th>Student</th>' : ''}
                            <th>Subject</th>
                            <th>Assignment</th>
                            <th class="center">Type</th>
                            <th class="center">Weight</th>
                            <th class="center">Score</th>
                            <th class="center">%</th>
                        </tr>
                    </thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
            </div>`;
        }
    }

    // ── Assemble full document — Fix 2: no banner, Fix 5: consistent style ─
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>${escHtml(reportTitle)} — ${escHtml(scopeName)}</title>
    <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: 'Segoe UI', Arial, sans-serif;
            background: #fff; color: #0d1f35;
            font-size: 11.5px; line-height: 1.5;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
        }

        /* ── Header ── */
        .report-header {
            display: flex; align-items: center;
            justify-content: space-between;
            padding: 24px 36px 20px;
            border-bottom: 3px solid #0d1f35;
        }
        .header-left  { display: flex; align-items: center; gap: 16px; }
        .logo         { width: 52px; height: 52px; object-fit: contain; }
        .brand-name   { font-size: 22px; font-weight: 900; color: #0d1f35; letter-spacing: -0.5px; }
        .brand-tag    { font-size: 10px; color: #2563eb; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; margin-top: 2px; }
        .header-right { text-align: right; }
        .report-title { font-size: 15px; font-weight: 800; color: #0d1f35; text-transform: uppercase; letter-spacing: 1px; }
        .report-sub   { font-size: 11px; color: #2563eb; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; margin-top: 3px; }
        .report-date  { font-size: 10px; color: #6b84a0; margin-top: 3px; font-weight: 500; }

        /* ── Info bar ── */
        .info-bar {
            background: #f4f7fb; border-bottom: 1px solid #dce3ed;
            padding: 14px 36px;
            display: grid; grid-template-columns: repeat(4, 1fr);
        }
        .info-field            { padding: 0 16px; }
        .info-field:first-child { padding-left: 0; }
        .info-field:not(:last-child) { border-right: 1px solid #dce3ed; }
        .f-label { font-size: 9px; text-transform: uppercase; letter-spacing: 1.2px; font-weight: 700; color: #94a3b8; display: block; margin-bottom: 3px; }
        .f-value { font-size: 13px; font-weight: 800; color: #0d1f35; }

        /* ── Section label ── */
        .section-label { padding: 20px 36px 10px; font-size: 9px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: 1.5px; }

        /* ── Content ── */
        .content    { padding: 0 36px; }
        .sem-block  { margin-bottom: 28px; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden; page-break-inside: avoid; }
        .sem-title  { background: #0d1f35; color: #fff; padding: 10px 16px; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 1.5px; }

        /* ── Tables ── */
        table { width: 100%; border-collapse: collapse; }
        thead th {
            background: #f8fafc; font-size: 9px; font-weight: 700;
            text-transform: uppercase; letter-spacing: 0.8px; color: #6b84a0;
            padding: 8px 14px; text-align: left; border-bottom: 1px solid #e8edf4;
        }
        thead th.center { text-align: center; }
        tbody tr:nth-child(even) { background: #fafbfc; }
        tbody td { padding: 9px 14px; border-bottom: 1px solid #f0f4f9; font-size: 11px; color: #0d1f35; vertical-align: middle; }
        tbody td.center { text-align: center; }
        .mono        { font-family: 'Courier New', monospace; font-weight: 700; }
        .weight-cell { font-size: 11px; font-weight: 800; color: #b45309; }
        .type-cell   { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #64748b; }

        /* ── Average row ── */
        .avg-row td  { background: #f0f4f9; border-top: 2px solid #dce3ed; padding: 10px 14px; font-weight: 700; }
        .avg-label   { text-align: right; color: #374f6b; font-style: italic; font-size: 11px; }
        .avg-val     { font-size: 14px; font-weight: 900; text-align: center; }

        /* ── Cumulative box ── */
        .cum-box {
            margin: 24px 36px;
            padding: 18px 24px;
            border: 2px solid #0d1f35;
            border-radius: 10px;
            display: flex; align-items: center; justify-content: space-between;
            background: #f4f7fb;
        }

        /* ── Footer ── */
        .report-footer {
            margin-top: 24px; padding: 14px 36px;
            border-top: 1px solid #dce3ed;
            display: flex; justify-content: space-between;
            color: #94a3b8; font-size: 9px;
        }
        .footer-brand { font-weight: 700; color: #2563eb; }
        .disclaimer   { padding: 8px 36px 20px; font-size: 9px; color: #94a3b8; text-align: center; font-style: italic; }

        @media print {
            body      { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
            .sem-block { page-break-inside: avoid; }
        }
    </style>
</head>
<body>

    <!-- Header -->
    <div class="report-header">
        <div class="header-left">
            <img src="${logoUrl}" class="logo" alt="Logo" onerror="this.style.display='none'">
            <div>
                <div class="brand-name">ConnectUs</div>
                <div class="brand-tag">Academic Platform · Belize</div>
            </div>
        </div>
        <div class="header-right">
            <div class="report-title">${escHtml(reportTitle)}</div>
            <div class="report-sub">${escHtml(semText)} · ${escHtml(subText)}</div>
            <div class="report-date">Printed: ${printDate}</div>
        </div>
    </div>

    <!-- Info bar -->
    <div class="info-bar">
        <div class="info-field">
            <span class="f-label">Scope</span>
            <span class="f-value">${escHtml(scopeName)}</span>
        </div>
        <div class="info-field">
            <span class="f-label">Teacher</span>
            <span class="f-value">${escHtml(teacherName)}</span>
        </div>
        <div class="info-field">
            <span class="f-label">Period(s)</span>
            <span class="f-value">${escHtml(semText)}</span>
        </div>
        <div class="info-field">
            <span class="f-label">School</span>
            <span class="f-value">${escHtml(schoolName)}</span>
        </div>
    </div>

    <div class="section-label">${isStudentReport ? 'Grade Entries by Period' : 'Grade Entries'}</div>

    <div class="content">${bodyHtml}</div>

    <div class="report-footer">
        <div>Generated by <span class="footer-brand">ConnectUs</span> · Academic Management Platform</div>
        <div>${escHtml(scopeName)} · ${escHtml(semText)} · ${printDate}</div>
    </div>

    <div class="disclaimer">
        This document is generated from live gradebook data and does not constitute a finalized official transcript.
        For an officially certified copy, please contact school administration.
    </div>

</body>
</html>`;

    const w = window.open('', '_blank');
    if (!w) {
        alert('Pop-ups are blocked. Please allow pop-ups for this site to print the report.');
        return;
    }
    w.document.write(html);
    w.document.close();
    setTimeout(() => w.print(), 600);
};

// Fire it up
init();
