import { db } from '../../assets/js/firebase-init.js';
import { collection, getDocs, doc, getDoc, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectStudentLayout } from '../../assets/js/layout-student.js';
import { letterGrade, gradeColorClass, calculateWeightedAverage } from '../../assets/js/utils.js';

// ── 1. INIT & AUTH ────────────────────────────────────────────────────────
const session = requireAuth('student', '../login.html');
injectStudentLayout('reports', 'Official Reports', 'Download and print academic records');

const buildReportBtn      = document.getElementById('buildReportBtn');
const printCustomReportBtn = document.getElementById('printCustomReportBtn');

let allSemesters        = [];
let allGrades           = [];
let schoolData          = {};
let teacherRubricsCache = {};
let currentQueryResults = [];
let currentQueryMeta    = {};
let currentTeacherName  = 'Unassigned';

function escHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// Weight lookup — keyed by teacherId since rubric cache is per-teacher
function getWeight(teacherId, type) {
    if (!teacherId || !type) return null;
    const rubric = teacherRubricsCache[teacherId] || [];
    const rule   = rubric.find(r => r.name?.toLowerCase() === type.toLowerCase());
    return rule ? rule.weight : null;
}

// Inline grade color (avoids dependency on gradeColorClass utility)
function gradeColor(pct) {
    if (pct >= 90) return '#059669';
    if (pct >= 80) return '#2563eb';
    if (pct >= 70) return '#0d9488';
    if (pct >= 65) return '#d97706';
    return '#dc2626';
}

function gradeTailwind(pct) {
    if (pct >= 90) return 'text-emerald-600';
    if (pct >= 80) return 'text-blue-600';
    if (pct >= 70) return 'text-teal-600';
    if (pct >= 65) return 'text-amber-600';
    return 'text-red-600';
}

// ── 2. INITIALIZE DATA — Fix 6: fully parallelized ────────────────────────
// Phase 1: school doc + teacher doc + semesters + all grades fire together.
// Phase 2: all teacher rubrics fire together (need grade teacherIds first).
async function initializeReports() {
    try {
        const tId = session.studentData?.teacherId;

        // Phase 1: all independent fetches in parallel
        const [schoolSnap, tSnap, semSnap, gSnap] = await Promise.all([
            getDoc(doc(db, 'schools', session.schoolId)),
            tId ? getDoc(doc(db, 'teachers', tId)) : Promise.resolve(null),
            getDocs(collection(db, 'schools', session.schoolId, 'semesters')),
            getDocs(query(
                collection(db, 'students', session.studentId, 'grades'),
                where('schoolId', '==', session.schoolId)
            ))
        ]);

        // Process school
        if (schoolSnap.exists()) {
            schoolData = schoolSnap.data();
            document.getElementById('displaySchoolName').innerText = schoolData.schoolName || 'ConnectUs School';
        }
        document.getElementById('displayStudentName').innerText  = session.studentData.name      || 'Student';
        document.getElementById('displayStudentClass').innerText = session.studentData.className || 'Unassigned Class';

        // Process teacher
        if (tSnap && tSnap.exists()) {
            currentTeacherName = tSnap.data().name || 'Unassigned';
        }

        // Process semesters
        allSemesters = semSnap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => (a.order || 0) - (b.order || 0));
        const activeSemObj = allSemesters.find(s => s.id === schoolData.activeSemesterId);
        document.getElementById('activeSemesterDisplay').textContent = activeSemObj ? activeSemObj.name : 'Unknown';

        // Process grades
        allGrades = gSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        // Phase 2: fetch all teacher rubrics in parallel (need grade data first)
        const uniqueTeacherIds = [...new Set(allGrades.map(g => g.teacherId).filter(Boolean))];
        await Promise.all(
            uniqueTeacherIds.map(async id => {
                if (!teacherRubricsCache[id]) {
                    try {
                        const snap = await getDoc(doc(db, 'teachers', id));
                        teacherRubricsCache[id] = snap.exists()
                            ? (snap.data().gradeTypes || snap.data().customGradeTypes || [])
                            : [];
                    } catch (e) {
                        teacherRubricsCache[id] = [];
                    }
                }
            })
        );

        // Stats
        document.getElementById('totalAssignments').textContent = allGrades.length;

        if (allGrades.length > 0) {
            const bySub = {};
            allGrades.forEach(g => {
                const sub = g.subject || 'Uncategorized';
                if (!bySub[sub]) bySub[sub] = [];
                bySub[sub].push(g);
            });

            let sumSubjAvgs = 0, subjCount = 0;
            for (const sub in bySub) {
                const tid    = bySub[sub][0]?.teacherId;
                const rubric = tid ? (teacherRubricsCache[tid] || []) : [];
                const raw    = calculateWeightedAverage(bySub[sub], rubric);
                if (raw !== null) { sumSubjAvgs += raw; subjCount++; }
            }

            const totalAvg = subjCount > 0 ? Math.round(sumSubjAvgs / subjCount) : 0;
            const gpaEl    = document.getElementById('cumulativeGpa');
            gpaEl.textContent = `${totalAvg}%`;
            gpaEl.classList.add(gradeTailwind(totalAvg));
        } else {
            document.getElementById('cumulativeGpa').textContent = 'N/A';
        }

        populateCheckboxes();

    } catch (e) {
        console.error("Error loading report data:", e);
    }
}

// ── 3. QUERY BUILDER UI ───────────────────────────────────────────────────
// Fix 1: isChecked defaults to FALSE — nothing pre-selected on load.
function buildCheckbox(idPrefix, value, label, isChecked = false) {
    const safeId = `${idPrefix}-${value.replace(/[^a-zA-Z0-9]/g, '_')}`;
    return `
    <label class="flex items-center gap-3 p-3 md:p-3.5 border border-slate-200 rounded-xl cursor-pointer transition ${isChecked ? 'bg-indigo-50 border-indigo-200' : 'bg-white hover:bg-slate-50'}" id="wrap-${safeId}">
        <input type="checkbox" value="${escHtml(value)}" ${isChecked ? 'checked' : ''} onchange="toggleCbVisuals(this, 'wrap-${safeId}')" class="w-5 h-5 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500">
        <span class="font-bold text-slate-700 text-sm md:text-base select-none truncate" title="${escHtml(label)}">${escHtml(label)}</span>
    </label>`;
}

window.toggleCbVisuals = function(cb, wrapId) {
    const wrap = document.getElementById(wrapId);
    if (cb.checked) {
        wrap.classList.add('bg-indigo-50', 'border-indigo-200');
        wrap.classList.remove('bg-white', 'hover:bg-slate-50');
    } else {
        wrap.classList.remove('bg-indigo-50', 'border-indigo-200');
        wrap.classList.add('bg-white', 'hover:bg-slate-50');
    }
};

window.toggleAllCheckboxes = function(containerId, state) {
    document.querySelectorAll(`#${containerId} input[type="checkbox"]`).forEach(cb => {
        cb.checked = state;
        window.toggleCbVisuals(cb, cb.closest('label').id);
    });
};

function getCheckedValues(containerId) {
    return Array.from(
        document.querySelectorAll(`#${containerId} input[type="checkbox"]:checked`)
    ).map(cb => cb.value);
}

function populateCheckboxes() {
    // Fix 1: all three grids pass false — nothing checked by default

    const semGrid = document.getElementById('rb-semester-grid');
    semGrid.innerHTML = allSemesters.length
        ? allSemesters.map(s => buildCheckbox('sem', s.id, s.name, false)).join('')
        : '<p class="text-sm font-bold text-slate-400">No periods found.</p>';

    const uniqueSubjects = [...new Set(allGrades.map(g => g.subject || 'Uncategorized'))].sort();
    const subGrid = document.getElementById('rb-subject-grid');
    subGrid.innerHTML = uniqueSubjects.length
        ? uniqueSubjects.map(s => buildCheckbox('sub', s, s, false)).join('')
        : '<p class="text-sm font-bold text-slate-400">No subjects found.</p>';

    const uniqueTypes = [...new Set(allGrades.map(g => g.type || 'Uncategorized'))].sort();
    const typeGrid = document.getElementById('rb-type-grid');
    typeGrid.innerHTML = uniqueTypes.length
        ? uniqueTypes.map(t => buildCheckbox('typ', t, t, false)).join('')
        : '<p class="text-sm font-bold text-slate-400">No grade types found.</p>';
}

// ── 4. EXECUTE CUSTOM REPORT ──────────────────────────────────────────────
async function executeCustomQuery() {
    const selectedSems  = getCheckedValues('rb-semester-grid');
    const selectedSubs  = getCheckedValues('rb-subject-grid');
    const selectedTypes = getCheckedValues('rb-type-grid');

    if (!selectedSems.length) {
        alert("Please select at least one Period.");
        return;
    }

    buildReportBtn.disabled = true;
    buildReportBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Processing...`;

    const isSummaryMode = selectedSubs.length === 0 && selectedTypes.length === 0;
    const tbody = document.getElementById('reportTableBody');
    const thead = tbody.closest('table').querySelector('thead');

    if (isSummaryMode) {
        // ── TERM SUMMARY — Fix 2: 3 columns only (Subject, Average, Grade) ──
        const filteredGrades = allGrades.filter(g => selectedSems.includes(g.semesterId));

        const bySemAndSub = {};
        filteredGrades.forEach(g => {
            const semName = allSemesters.find(s => s.id === g.semesterId)?.name || 'Unknown Period';
            const sub     = g.subject || 'Uncategorized';
            if (!bySemAndSub[semName])      bySemAndSub[semName] = {};
            if (!bySemAndSub[semName][sub]) bySemAndSub[semName][sub] = [];
            bySemAndSub[semName][sub].push(g);
        });

        const semText = selectedSems.length === allSemesters.length
            ? 'All Periods' : `${selectedSems.length} Period(s)`;
        currentQueryMeta    = { mode: 'summary', selectedSems, semText };
        currentQueryResults = bySemAndSub;
        document.getElementById('reportOutputMeta').textContent = `${semText} · Academic Summary`;

        // 3-column header — no Assessments column
        thead.innerHTML = `
            <tr class="bg-slate-50 border-y border-slate-200">
                <th class="px-8 py-4 text-left   text-[11px] font-black uppercase tracking-widest text-slate-400">Subject</th>
                <th class="px-8 py-4 text-center text-[11px] font-black uppercase tracking-widest text-slate-400">Average</th>
                <th class="px-8 py-4 text-center text-[11px] font-black uppercase tracking-widest text-slate-400">Grade</th>
            </tr>`;

        if (!Object.keys(bySemAndSub).length) {
            tbody.innerHTML = `<tr><td colspan="3" class="px-8 py-16 text-center text-slate-400 italic font-black text-lg">No records found for this period.</td></tr>`;
        } else {
            let html = '';
            for (const semName in bySemAndSub) {
                html += `<tr class="bg-slate-100"><td colspan="3" class="px-8 py-3 text-xs font-black uppercase tracking-widest text-slate-500">${escHtml(semName)}</td></tr>`;
                let termSum = 0, termSubCount = 0;

                for (const sub in bySemAndSub[semName]) {
                    const grades  = bySemAndSub[semName][sub];
                    const tid     = grades[0]?.teacherId;
                    const rubric  = tid ? (teacherRubricsCache[tid] || []) : [];
                    const avgRaw  = calculateWeightedAverage(grades, rubric);

                    if (avgRaw !== null) {
                        const avg    = Math.round(avgRaw);
                        const tc     = gradeTailwind(avg);
                        termSum     += avg;
                        termSubCount++;

                        html += `
                        <tr class="hover:bg-slate-50 transition border-b border-slate-100">
                            <td class="px-8 py-5">
                                <span class="text-sm font-black bg-indigo-50 text-indigo-600 border border-indigo-200 px-3 py-1.5 rounded-lg tracking-wider">${escHtml(sub)}</span>
                            </td>
                            <td class="px-8 py-5 text-center"><span class="font-black font-mono text-lg ${tc}">${avg}%</span></td>
                            <td class="px-8 py-5 text-center font-black text-lg ${tc}">${letterGrade(avg)}</td>
                        </tr>`;
                    }
                }

                if (termSubCount > 0) {
                    const termAvg = Math.round(termSum / termSubCount);
                    const tc      = gradeTailwind(termAvg);
                    html += `
                    <tr class="bg-slate-50 border-b-2 border-slate-200">
                        <td class="px-8 py-4 text-right font-black uppercase tracking-wider text-slate-600 text-xs">Term Average</td>
                        <td class="px-8 py-4 text-center font-black font-mono text-xl ${tc}">${termAvg}%</td>
                        <td class="px-8 py-4 text-center font-black text-xl ${tc}">${letterGrade(termAvg)}</td>
                    </tr>`;
                }
            }
            tbody.innerHTML = html;
        }

    } else {
        // ── DETAILED MODE — Fix 3: Weight column added ─────────────────────
        const filteredGrades = allGrades
            .filter(g =>
                selectedSems.includes(g.semesterId) &&
                selectedSubs.includes(g.subject  || 'Uncategorized') &&
                selectedTypes.includes(g.type    || 'Uncategorized')
            )
            .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

        currentQueryResults = filteredGrades;

        const semText = selectedSems.length === allSemesters.length
            ? 'All Periods' : `${selectedSems.length} Periods`;
        const subText = selectedSubs.length === document.querySelectorAll('#rb-subject-grid input').length
            ? 'All Subjects' : `${selectedSubs.length} Subjects`;
        currentQueryMeta = { mode: 'detailed', semText, subText };
        document.getElementById('reportOutputMeta').textContent = `${semText} · ${subText}`;

        // 7-column header with Weight
        thead.innerHTML = `
            <tr class="bg-slate-50 border-y border-slate-200">
                <th class="px-8 py-4 text-left   text-[11px] font-black uppercase tracking-widest text-slate-400">Date</th>
                <th class="px-8 py-4 text-left   text-[11px] font-black uppercase tracking-widest text-slate-400">Subject</th>
                <th class="px-8 py-4 text-left   text-[11px] font-black uppercase tracking-widest text-slate-400">Assignment</th>
                <th class="px-8 py-4 text-left   text-[11px] font-black uppercase tracking-widest text-slate-400">Type</th>
                <th class="px-8 py-4 text-center text-[11px] font-black uppercase tracking-widest text-slate-400">Weight</th>
                <th class="px-8 py-4 text-center text-[11px] font-black uppercase tracking-widest text-slate-400">Score</th>
                <th class="px-8 py-4 text-center text-[11px] font-black uppercase tracking-widest text-slate-400">%</th>
            </tr>`;

        if (!filteredGrades.length) {
            tbody.innerHTML = `<tr><td colspan="7" class="px-8 py-16 text-center text-slate-400 italic font-black text-lg">No records match the selected criteria.</td></tr>`;
        } else {
            tbody.innerHTML = filteredGrades.map(g => {
                const pct    = g.max ? Math.round((g.score / g.max) * 100) : null;
                const w      = getWeight(g.teacherId, g.type);
                const tc     = pct !== null ? gradeTailwind(pct) : 'text-slate-800';
                const semTag = selectedSems.length > 1
                    ? `<br><span class="text-[11px] font-black uppercase tracking-wider text-indigo-500 mt-1 inline-block">${allSemesters.find(s => s.id === g.semesterId)?.name || 'Unknown'}</span>`
                    : '';

                return `
                <tr class="hover:bg-slate-50 transition border-b border-slate-100">
                    <td class="px-8 py-5 text-sm font-black font-mono text-slate-500">${g.date || '—'}${semTag}</td>
                    <td class="px-8 py-5">
                        <span class="text-xs font-black bg-indigo-50 text-indigo-600 border border-indigo-200 px-3 py-1.5 rounded-lg tracking-wider">${escHtml(g.subject || '—')}</span>
                    </td>
                    <td class="px-8 py-5 font-black text-slate-800 text-base">${escHtml(g.title || '—')}</td>
                    <td class="px-8 py-5">
                        <span class="text-xs font-black uppercase tracking-widest bg-slate-100 text-slate-500 border border-slate-200 px-3 py-1.5 rounded-lg">${escHtml(g.type || '—')}</span>
                    </td>
                    <td class="px-8 py-5 text-center">
                        <span class="text-xs font-black bg-amber-50 text-amber-700 border border-amber-200 px-3 py-1.5 rounded-lg">${w !== null ? w + '%' : '—'}</span>
                    </td>
                    <td class="px-8 py-5 text-center font-black font-mono text-slate-800 text-base">${g.score} / ${g.max || '?'}</td>
                    <td class="px-8 py-5 text-center"><span class="font-black font-mono text-lg md:text-xl ${tc}">${pct !== null ? pct + '%' : '—'}</span></td>
                </tr>`;
            }).join('');
        }
    }

    const area = document.getElementById('reportResultsArea');
    area.classList.remove('hidden');
    setTimeout(() => { area.classList.remove('opacity-0'); }, 50);

    buildReportBtn.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i> Build Report`;
    buildReportBtn.disabled  = false;
}

// ── 5. PRINT GENERATOR — Fix 4 (no banner) + Fix 5 (consistent style) ────
function printDocument() {
    const isEmpty = !currentQueryResults ||
        (Array.isArray(currentQueryResults) && !currentQueryResults.length) ||
        (!Array.isArray(currentQueryResults) && !Object.keys(currentQueryResults).length);

    if (isEmpty) {
        alert("No academic records found to print.");
        return;
    }

    const isSummaryMode = currentQueryMeta.mode === 'summary';
    const logoUrl       = schoolData.logo || new URL('../../assets/images/logo.png', window.location.href).href;
    const printDate     = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const studentName   = session.studentData?.name      || 'Student';
    const studentClass  = session.studentData?.className || '—';
    const schoolName    = schoolData.schoolName          || 'ConnectUs School';
    const reportTitle   = isSummaryMode ? 'Academic Summary Report' : 'Academic Progress Report';
    const reportSub     = isSummaryMode
        ? currentQueryMeta.semText
        : `${currentQueryMeta.semText} · ${currentQueryMeta.subText}`;

    // ── Build body content ────────────────────────────────────────────────
    let bodyHtml = '';

    if (isSummaryMode) {
        // Fix 2 in print: 3 columns (Subject, Average, Grade) — no Assessments
        for (const semName in currentQueryResults) {
            let termSum = 0, termSubCount = 0;
            let rowsHtml = '';

            for (const sub in currentQueryResults[semName]) {
                const grades  = currentQueryResults[semName][sub];
                const tid     = grades[0]?.teacherId;
                const rubric  = tid ? (teacherRubricsCache[tid] || []) : [];
                const avgRaw  = calculateWeightedAverage(grades, rubric);

                if (avgRaw !== null) {
                    const avg   = Math.round(avgRaw);
                    const col   = gradeColor(avg);
                    termSum    += avg;
                    termSubCount++;

                    rowsHtml += `
                    <tr>
                        <td class="col-subject">${escHtml(sub)}</td>
                        <td class="center avg" style="color:${col};">${avg}%</td>
                        <td class="center letter" style="color:${col};">${letterGrade(avg)}</td>
                    </tr>`;
                }
            }

            if (termSubCount > 0) {
                const termAvg = Math.round(termSum / termSubCount);
                const col     = gradeColor(termAvg);
                rowsHtml += `
                <tr class="avg-row">
                    <td class="avg-label">Term Average</td>
                    <td class="center avg-val" style="color:${col};">${termAvg}%</td>
                    <td class="center avg-val" style="color:${col};">${letterGrade(termAvg)}</td>
                </tr>`;
            }

            bodyHtml += `
            <div class="sem-block">
                <div class="sem-title">${escHtml(semName)}</div>
                <table>
                    <thead>
                        <tr>
                            <th class="col-subject">Subject</th>
                            <th class="center">Average</th>
                            <th class="center">Grade</th>
                        </tr>
                    </thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
            </div>`;
        }

    } else {
        // Fix 3 in print: add Weight column, consistent styling
        const bySem = {};
        currentQueryResults.forEach(g => {
            const semName = allSemesters.find(s => s.id === g.semesterId)?.name || 'Unknown Period';
            if (!bySem[semName]) bySem[semName] = [];
            bySem[semName].push(g);
        });

        for (const semName in bySem) {
            let rowsHtml = '';

            bySem[semName].forEach(g => {
                const pct = g.max ? Math.round((g.score / g.max) * 100) : null;
                const w   = getWeight(g.teacherId, g.type);
                const col = pct !== null ? gradeColor(pct) : '#0d1f35';

                rowsHtml += `
                <tr>
                    <td class="col-date mono">${escHtml(g.date || '—')}</td>
                    <td>${escHtml(g.subject || '—')}</td>
                    <td>${escHtml(g.title   || '—')}</td>
                    <td class="center type-cell">${escHtml(g.type || '—')}</td>
                    <td class="center weight-cell">${w !== null ? w + '%' : '—'}</td>
                    <td class="center mono">${g.score} / ${g.max ?? '?'}</td>
                    <td class="center avg" style="color:${col};">${pct !== null ? pct + '%' : '—'}</td>
                </tr>`;
            });

            // Term average at bottom of section
            const bySub = {};
            bySem[semName].forEach(g => {
                const sub = g.subject || 'Uncategorized';
                if (!bySub[sub]) bySub[sub] = [];
                bySub[sub].push(g);
            });
            let semSum = 0, semSubCount = 0;
            for (const sub in bySub) {
                const tid    = bySub[sub][0]?.teacherId;
                const rubric = tid ? (teacherRubricsCache[tid] || []) : [];
                const avg    = calculateWeightedAverage(bySub[sub], rubric);
                if (avg !== null) { semSum += avg; semSubCount++; }
            }
            const semAvg = semSubCount > 0 ? Math.round(semSum / semSubCount) : null;
            if (semAvg !== null) {
                const col = gradeColor(semAvg);
                rowsHtml += `
                <tr class="avg-row">
                    <td colspan="5" class="avg-label">Term Average</td>
                    <td class="center avg-val" style="color:${col};">${semAvg}%</td>
                    <td class="center avg-val" style="color:${col};">${letterGrade(semAvg)}</td>
                </tr>`;
            }

            bodyHtml += `
            <div class="sem-block">
                <div class="sem-title">${escHtml(semName)}</div>
                <table>
                    <thead>
                        <tr>
                            <th class="col-date">Date</th>
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

    // ── Assemble full print document ──────────────────────────────────────
    // Fix 4: no banner. Fix 5: consistent header/style with grades.js print.
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>${escHtml(reportTitle)} — ${escHtml(studentName)}</title>
    <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: 'Segoe UI', Arial, sans-serif;
            background: #fff;
            color: #0d1f35;
            font-size: 11.5px;
            line-height: 1.5;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
        }

        /* ── Report Header (matches grades.js print) ── */
        .report-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 24px 36px 20px;
            border-bottom: 3px solid #1e1b4b;
        }
        .header-left    { display: flex; align-items: center; gap: 16px; }
        .logo           { width: 52px; height: 52px; object-fit: contain; }
        .brand-name     { font-size: 22px; font-weight: 900; color: #1e1b4b; letter-spacing: -0.5px; }
        .brand-tagline  { font-size: 10px; color: #818cf8; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; margin-top: 2px; }
        .header-right   { text-align: right; }
        .report-title   { font-size: 15px; font-weight: 800; color: #1e1b4b; text-transform: uppercase; letter-spacing: 1px; }
        .report-subtitle{ font-size: 11px; color: #818cf8; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; margin-top: 3px; }
        .report-date    { font-size: 10px; color: #6b84a0; margin-top: 3px; font-weight: 500; }

        /* ── Student Info Bar (matches grades.js print) ── */
        .student-bar {
            background: #f4f7fb;
            border-bottom: 1px solid #dce3ed;
            padding: 14px 36px;
            display: grid;
            grid-template-columns: repeat(4, 1fr);
        }
        .student-field              { padding: 0 16px; }
        .student-field:first-child  { padding-left: 0; }
        .student-field:not(:last-child) { border-right: 1px solid #dce3ed; }
        .field-label { font-size: 9px; text-transform: uppercase; letter-spacing: 1.2px; font-weight: 700; color: #94a3b8; display: block; margin-bottom: 3px; }
        .field-value { font-size: 13px; font-weight: 800; color: #0d1f35; }

        /* ── Section label ── */
        .section-label { padding: 20px 36px 10px; font-size: 9px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: 1.5px; }

        /* ── Semester blocks ── */
        .content   { padding: 0 36px; }
        .sem-block { margin-bottom: 28px; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden; page-break-inside: avoid; }
        .sem-title { background: #1e1b4b; color: #fff; padding: 10px 16px; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 1.5px; }

        /* ── Tables ── */
        table { width: 100%; border-collapse: collapse; }
        thead th {
            background: #f8fafc;
            font-size: 9px; font-weight: 700;
            text-transform: uppercase; letter-spacing: 0.8px;
            color: #6b84a0;
            padding: 8px 14px;
            text-align: left;
            border-bottom: 1px solid #e8edf4;
        }
        thead th.center { text-align: center; }
        tbody tr:nth-child(even) { background: #fafbfc; }
        tbody td {
            padding: 9px 14px;
            border-bottom: 1px solid #f0f4f9;
            font-size: 11px;
            color: #0d1f35;
            vertical-align: middle;
        }
        tbody td.center { text-align: center; }

        /* Column helpers */
        .col-subject  { width: 45%; }
        .col-date     { width: 10%; white-space: nowrap; }
        .mono         { font-family: 'Courier New', monospace; font-weight: 700; }
        .avg          { font-size: 13px; font-weight: 800; }
        .letter       { font-size: 13px; font-weight: 900; }
        .type-cell    { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #64748b; }
        .weight-cell  { font-size: 11px; font-weight: 800; color: #b45309; }

        /* ── Average footer row ── */
        .avg-row td   { background: #f0f4f9; border-top: 2px solid #dce3ed; padding: 10px 14px; font-weight: 700; }
        .avg-label    { text-align: right; color: #374f6b; font-style: italic; font-size: 11px; }
        .avg-val      { font-size: 14px; font-weight: 900; text-align: center; }

        /* ── Footer ── */
        .report-footer {
            margin-top: 24px;
            padding: 14px 36px;
            border-top: 1px solid #dce3ed;
            display: flex;
            justify-content: space-between;
            color: #94a3b8;
            font-size: 9px;
        }
        .footer-brand    { font-weight: 700; color: #818cf8; }
        .disclaimer      { padding: 8px 36px 20px; font-size: 9px; color: #94a3b8; text-align: center; font-style: italic; }

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
                <div class="brand-tagline">Academic Platform · Belize</div>
            </div>
        </div>
        <div class="header-right">
            <div class="report-title">${escHtml(reportTitle)}</div>
            <div class="report-subtitle">${escHtml(reportSub)}</div>
            <div class="report-date">Printed: ${printDate}</div>
        </div>
    </div>

    <!-- Student info bar -->
    <div class="student-bar">
        <div class="student-field">
            <span class="field-label">Student</span>
            <span class="field-value">${escHtml(studentName)}</span>
        </div>
        <div class="student-field">
            <span class="field-label">Class</span>
            <span class="field-value">${escHtml(studentClass)}</span>
        </div>
        <div class="student-field">
            <span class="field-label">Teacher</span>
            <span class="field-value">${escHtml(currentTeacherName)}</span>
        </div>
        <div class="student-field">
            <span class="field-label">School</span>
            <span class="field-value">${escHtml(schoolName)}</span>
        </div>
    </div>

    <div class="section-label">${isSummaryMode ? 'Grade Summary by Subject' : 'Detailed Grade Entries'}</div>

    <div class="content">${bodyHtml}</div>

    <div class="report-footer">
        <div>Generated by <span class="footer-brand">ConnectUs</span> · Academic Management Platform</div>
        <div>${escHtml(studentName)} · ${escHtml(reportSub)} · ${printDate}</div>
    </div>

    <div class="disclaimer">
        This document is generated from live gradebook data and does not constitute a finalized official transcript.
        For an officially sealed copy, please contact school administration.
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
}

// ── 6. EVENT LISTENERS ────────────────────────────────────────────────────
buildReportBtn.addEventListener('click', executeCustomQuery);
printCustomReportBtn.addEventListener('click', printDocument);

// ── INITIALIZE ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', initializeReports);
