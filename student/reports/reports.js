import { db } from '../../assets/js/firebase-init.js';
import { collection, getDocs, doc, getDoc, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectStudentLayout } from '../../assets/js/layout-student.js';
import { letterGrade, gradeColorClass, calculateWeightedAverage } from '../../assets/js/utils.js';

// ── 1. INIT & AUTH ────────────────────────────────────────────────────────
const session = requireAuth('student', '../login.html');

// Inject layout
injectStudentLayout('reports', 'Official Reports', 'Download and print academic records');

// Elements
const buildReportBtn = document.getElementById('buildReportBtn');
const printCustomReportBtn = document.getElementById('printCustomReportBtn');

// State Variables
let allSemesters = [];
let allGrades = [];
let schoolData = {};
let teacherRubricsCache = {}; 
let currentQueryResults = []; 
let currentQueryMeta = {};
let currentTeacherName = 'Unassigned';

// Escapes HTML to prevent XSS
function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// ── 2. INITIALIZE DATA ────────────────────────────────────────────────────
async function initializeReports() {
    try {
        // Fetch School Data (for print headers & logo)
        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        if (schoolSnap.exists()) {
            schoolData = schoolSnap.data();
            document.getElementById('displaySchoolName').innerText = schoolData.schoolName || 'ConnectUs School';
        }
        document.getElementById('displayStudentName').innerText = session.studentData.name || 'Student';
        document.getElementById('displayStudentClass').innerText = session.studentData.className || 'Unassigned Class';

        // Fetch Homeroom Teacher Name
        if (session.studentData.teacherId) {
            try {
                const teacherSnap = await getDoc(doc(db, 'teachers', session.studentData.teacherId));
                if (teacherSnap.exists()) {
                    currentTeacherName = teacherSnap.data().name || 'Unassigned';
                }
            } catch (e) {
                console.error("Could not fetch teacher name", e);
            }
        }

        // Fetch Semesters
        const semSnap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
        allSemesters = semSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0));

        const activeSemObj = allSemesters.find(s => s.id === schoolData.activeSemesterId);
        document.getElementById('activeSemesterDisplay').textContent = activeSemObj ? activeSemObj.name : 'Unknown';

        // Fetch ALL grades for the student globally matching home.js logic
        const gSnap = await getDocs(query(
            collection(db, 'students', session.studentId, 'grades'),
            where('schoolId', '==', session.schoolId)
        ));
        allGrades = gSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        // Pre-fetch teacher rubrics for GPA calculations
        const uniqueTeacherIds = [...new Set(allGrades.map(g => g.teacherId).filter(Boolean))];
        for (const tId of uniqueTeacherIds) {
            if (!teacherRubricsCache[tId]) {
                try {
                    const tSnap = await getDoc(doc(db, 'teachers', tId));
                    teacherRubricsCache[tId] = tSnap.exists() ? (tSnap.data().gradeTypes || tSnap.data().customGradeTypes || []) : [];
                } catch (e) {
                    teacherRubricsCache[tId] = [];
                }
            }
        }

        // Calculate High-Level Stats
        document.getElementById('totalAssignments').textContent = allGrades.length;
        
        if (allGrades.length > 0) {
            const bySub = {};
            allGrades.forEach(g => {
                const sub = g.subject || 'Uncategorized';
                if (!bySub[sub]) bySub[sub] = [];
                bySub[sub].push(g);
            });

            let sumSubjAvgs = 0;
            let subjCount = 0;

            for (const sub in bySub) {
                const tId = bySub[sub][0]?.teacherId;
                const rubric = tId ? (teacherRubricsCache[tId] || []) : [];
                const subAvgRaw = calculateWeightedAverage(bySub[sub], rubric);
                
                if (subAvgRaw !== null) {
                    sumSubjAvgs += subAvgRaw;
                    subjCount++;
                }
            }

            const totalAvg = subjCount > 0 ? Math.round(sumSubjAvgs / subjCount) : 0;
            const gpaEl = document.getElementById('cumulativeGpa');
            gpaEl.textContent = `${totalAvg}%`;
            
            if (totalAvg >= 90) gpaEl.classList.add('text-emerald-600');
            else if (totalAvg >= 80) gpaEl.classList.add('text-blue-600');
            else if (totalAvg >= 70) gpaEl.classList.add('text-teal-600');
            else if (totalAvg >= 65) gpaEl.classList.add('text-amber-600');
            else gpaEl.classList.add('text-red-600');
        } else {
            document.getElementById('cumulativeGpa').textContent = 'N/A';
        }

        // Populate Custom Builder Checkboxes
        populateCheckboxes();

    } catch (e) {
        console.error("Error loading report data:", e);
    }
}

// ── 3. QUERY BUILDER UI LOGIC ─────────────────────────────────────────────
function buildCheckbox(idPrefix, value, label, isChecked = true) {
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
    const container = document.getElementById(containerId);
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => {
        cb.checked = state;
        const wrapId = cb.closest('label').id;
        window.toggleCbVisuals(cb, wrapId);
    });
};

function getCheckedValues(containerId) {
    const checkboxes = document.querySelectorAll(`#${containerId} input[type="checkbox"]:checked`);
    return Array.from(checkboxes).map(cb => cb.value);
}

function populateCheckboxes() {
    // Semesters
    const semGrid = document.getElementById('rb-semester-grid');
    semGrid.innerHTML = allSemesters.length 
        ? allSemesters.map(s => buildCheckbox('sem', s.id, s.name, true)).join('')
        : '<p class="text-sm font-bold text-slate-400">No periods found.</p>';

    // Subjects
    const uniqueSubjects = [...new Set(allGrades.map(g => g.subject || 'Uncategorized'))].sort();
    const subGrid = document.getElementById('rb-subject-grid');
    subGrid.innerHTML = uniqueSubjects.length
        ? uniqueSubjects.map(s => buildCheckbox('sub', s, s, true)).join('')
        : '<p class="text-sm font-bold text-slate-400">No subjects found.</p>';

    // Grade Types
    const uniqueTypes = [...new Set(allGrades.map(g => g.type || 'Uncategorized'))].sort();
    const typeGrid = document.getElementById('rb-type-grid');
    typeGrid.innerHTML = uniqueTypes.length
        ? uniqueTypes.map(t => buildCheckbox('typ', t, t, true)).join('')
        : '<p class="text-sm font-bold text-slate-400">No grade types found.</p>';
}

// ── 4. EXECUTE CUSTOM REPORT ──────────────────────────────────────────────
async function executeCustomQuery() {
    const selectedSems = getCheckedValues('rb-semester-grid');
    const selectedSubs = document.getElementById('rb-subject-grid') ? getCheckedValues('rb-subject-grid') : [];
    const selectedTypes = document.getElementById('rb-type-grid') ? getCheckedValues('rb-type-grid') : [];

    // Validation: Only Period (Term) is mandatory
    if (!selectedSems.length) {
        alert("Please select at least one Period.");
        return;
    }

    buildReportBtn.disabled = true;
    buildReportBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Processing...`;

    // Determine Mode: Summary Mode triggers if Subjects & Types are left blank
    const isSummaryMode = selectedSubs.length === 0 && selectedTypes.length === 0;

    const tbody = document.getElementById('reportTableBody');
    const thead = tbody.closest('table').querySelector('thead');

    if (isSummaryMode) {
        // ==========================================
        // TERM SUMMARY REPORT CARD MODE
        // ==========================================
        let filteredGrades = allGrades.filter(g => selectedSems.includes(g.semesterId));
        
        const bySemAndSub = {};
        filteredGrades.forEach(g => {
            const semName = allSemesters.find(s => s.id === g.semesterId)?.name || 'Unknown Period';
            const sub = g.subject || 'Uncategorized';
            if (!bySemAndSub[semName]) bySemAndSub[semName] = {};
            if (!bySemAndSub[semName][sub]) bySemAndSub[semName][sub] = [];
            bySemAndSub[semName][sub].push(g);
        });

        const semText = selectedSems.length === allSemesters.length ? 'All Periods' : `${selectedSems.length} Period(s)`;
        currentQueryMeta = { mode: 'summary', selectedSems, semText };
        currentQueryResults = bySemAndSub;

        document.getElementById('reportOutputMeta').textContent = `${semText} · Academic Summary`;

        // Dynamically inject 4-column headers for Summary
        thead.innerHTML = `
            <tr class="bg-slate-50 border-y border-slate-200">
                <th class="px-8 py-4 text-left text-[11px] font-black uppercase tracking-widest text-slate-400">Subject</th>
                <th class="px-8 py-4 text-center text-[11px] font-black uppercase tracking-widest text-slate-400">Assessments</th>
                <th class="px-8 py-4 text-center text-[11px] font-black uppercase tracking-widest text-slate-400">Average</th>
                <th class="px-8 py-4 text-center text-[11px] font-black uppercase tracking-widest text-slate-400">Grade</th>
            </tr>`;

        if (Object.keys(bySemAndSub).length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" class="px-8 py-16 text-center text-slate-400 italic font-black text-lg">No records found for this period.</td></tr>`;
        } else {
            let html = '';
            for (const semName in bySemAndSub) {
                html += `<tr class="bg-slate-100"><td colspan="4" class="px-8 py-3 text-xs font-black uppercase tracking-widest text-slate-500">${escHtml(semName)}</td></tr>`;
                let termSum = 0; let termSubCount = 0;

                for (const sub in bySemAndSub[semName]) {
                    const grades = bySemAndSub[semName][sub];
                    const tId = grades[0]?.teacherId;
                    const rubric = tId ? (teacherRubricsCache[tId] || []) : [];
                    const avgRaw = calculateWeightedAverage(grades, rubric);
                    
                    if (avgRaw !== null) {
                        const avg = Math.round(avgRaw);
                        let textCol = 'text-slate-800';
                        if(avg >= 90) textCol = 'text-emerald-600'; else if(avg >= 80) textCol = 'text-blue-600'; else if(avg >= 70) textCol = 'text-teal-600'; else if(avg >= 65) textCol = 'text-amber-600'; else textCol = 'text-red-600';

                        termSum += avg; termSubCount++;
                        html += `<tr class="hover:bg-slate-50 transition border-b border-slate-100">
                            <td class="px-8 py-5"><span class="text-sm font-black bg-indigo-50 text-indigo-600 border border-indigo-200 px-3 py-1.5 rounded-lg tracking-wider">${escHtml(sub)}</span></td>
                            <td class="px-8 py-5 text-center font-black text-slate-500 text-sm">${grades.length}</td>
                            <td class="px-8 py-5 text-center"><span class="font-black font-mono text-lg ${textCol}">${avg}%</span></td>
                            <td class="px-8 py-5 text-center font-black text-lg ${textCol}">${letterGrade(avg)}</td>
                        </tr>`;
                    }
                }
                
                if (termSubCount > 0) {
                    const termAvg = Math.round(termSum / termSubCount);
                    html += `<tr class="bg-slate-50 border-b-2 border-slate-200">
                        <td colspan="2" class="px-8 py-4 text-right font-black uppercase tracking-wider text-slate-600 text-xs">Term Average</td>
                        <td class="px-8 py-4 text-center font-black font-mono text-xl text-slate-800">${termAvg}%</td>
                        <td class="px-8 py-4 text-center font-black text-xl text-slate-800">${letterGrade(termAvg)}</td>
                    </tr>`;
                }
            }
            tbody.innerHTML = html;
        }

    } else {
        // ==========================================
        // DETAILED ASSIGNMENT LIST MODE
        // ==========================================
        let filteredGrades = allGrades.filter(g => 
            selectedSems.includes(g.semesterId) && 
            selectedSubs.includes(g.subject || 'Uncategorized') && 
            selectedTypes.includes(g.type || 'Uncategorized')
        );

        filteredGrades.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
        currentQueryResults = filteredGrades;

        const semText = selectedSems.length === allSemesters.length ? 'All Periods' : `${selectedSems.length} Periods`;
        const subText = selectedSubs.length === document.querySelectorAll('#rb-subject-grid input').length ? 'All Subjects' : `${selectedSubs.length} Subjects`;
        
        currentQueryMeta = { mode: 'detailed', semText, subText };
        document.getElementById('reportOutputMeta').textContent = `${semText} · ${subText}`;

        // Dynamically inject 6-column headers for Detailed view
        thead.innerHTML = `
            <tr class="bg-slate-50 border-y border-slate-200">
                <th class="px-8 py-4 text-left text-[11px] font-black uppercase tracking-widest text-slate-400">Date</th>
                <th class="px-8 py-4 text-left text-[11px] font-black uppercase tracking-widest text-slate-400">Subject</th>
                <th class="px-8 py-4 text-left text-[11px] font-black uppercase tracking-widest text-slate-400">Assignment</th>
                <th class="px-8 py-4 text-left text-[11px] font-black uppercase tracking-widest text-slate-400">Type</th>
                <th class="px-8 py-4 text-center text-[11px] font-black uppercase tracking-widest text-slate-400">Score</th>
                <th class="px-8 py-4 text-center text-[11px] font-black uppercase tracking-widest text-slate-400">%</th>
            </tr>`;

        if (filteredGrades.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" class="px-8 py-16 text-center text-slate-400 italic font-black text-lg">No records match the selected criteria.</td></tr>`;
        } else {
            tbody.innerHTML = filteredGrades.map(g => {
                const pct = g.max ? Math.round((g.score / g.max) * 100) : null;
                let textCol = 'text-slate-800';
                if(pct !== null) {
                    if(pct >= 90) textCol = 'text-emerald-600'; else if(pct >= 80) textCol = 'text-blue-600'; else if(pct >= 70) textCol = 'text-teal-600'; else if(pct >= 65) textCol = 'text-amber-600'; else textCol = 'text-red-600';
                }
                const semTag = selectedSems.length > 1 ? `<br><span class="text-[11px] font-black uppercase tracking-wider text-indigo-500 mt-1 inline-block">${allSemesters.find(s=>s.id===g.semesterId)?.name || 'Unknown'}</span>` : '';
                
                return `
                <tr class="hover:bg-slate-50 transition border-b border-slate-100">
                    <td class="px-8 py-5 text-sm font-black font-mono text-slate-500">${g.date || '—'} ${semTag}</td>
                    <td class="px-8 py-5"><span class="text-xs font-black bg-indigo-50 text-indigo-600 border border-indigo-200 px-3 py-1.5 rounded-lg tracking-wider">${escHtml(g.subject || '—')}</span></td>
                    <td class="px-8 py-5 font-black text-slate-800 text-base">${escHtml(g.title || '—')}</td>
                    <td class="px-8 py-5"><span class="text-xs font-black uppercase tracking-widest bg-slate-100 text-slate-500 border border-slate-200 px-3 py-1.5 rounded-lg">${escHtml(g.type || '—')}</span></td>
                    <td class="px-8 py-5 text-center font-black font-mono text-slate-800 text-base">${g.score} / ${g.max || '?'}</td>
                    <td class="px-8 py-5 text-center"><span class="font-black font-mono text-lg md:text-xl ${textCol}">${pct !== null ? pct + '%' : '—'}</span></td>
                </tr>`;
            }).join('');
        }
    }

    const area = document.getElementById('reportResultsArea');
    area.classList.remove('hidden');
    setTimeout(() => { area.classList.remove('opacity-0'); }, 50);

    buildReportBtn.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i> Build Report`;
    buildReportBtn.disabled = false;
}

// ── 5. PROFESSIONAL PRINT GENERATOR ───────────────────────────────────────
function printDocument() {
    if (!currentQueryResults || (Array.isArray(currentQueryResults) && currentQueryResults.length === 0) || Object.keys(currentQueryResults).length === 0) {
        alert("No academic records found to print.");
        return;
    }

    const isSummaryMode = currentQueryMeta.mode === 'summary';
    const docTitle = isSummaryMode ? "ACADEMIC SUMMARY REPORT" : "ACADEMIC PROGRESS REPORT";
    const docSubtitle = isSummaryMode ? currentQueryMeta.semText : `${currentQueryMeta.semText} • ${currentQueryMeta.subText}`;
    const unofficalBanner = `<div style="background:#4f46e5;color:white;text-align:center;font-weight:900;letter-spacing:0.3em;padding:8px;font-size:12px;margin-bottom:20px;width:100%;">*** LIVE FAMILY PORTAL RECORD ***</div>`;
    const logoSrc = schoolData.logo || '../../assets/images/logo.png';

    let html = `<html><head><title>${docTitle} - ${escHtml(session.studentData.name)}</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800;900&family=DM+Mono:wght@400;500;700&display=swap');
        @media print { * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; } body { padding: 0; margin: 0; } @page { margin: 1.5cm; } }
        body { font-family: 'DM Sans', sans-serif; padding: 40px; color: #0f172a; line-height: 1.5; background: white; }
        .header { display: flex; flex-direction: column; align-items: center; border-bottom: 3px solid #0f172a; padding-bottom: 25px; margin-bottom: 30px; text-align: center; }
        .logo { max-height: 70px; max-width: 250px; object-fit: contain; margin-bottom: 15px; }
        .header h1 { margin: 0 0 6px 0; font-size: 26px; color: #0f172a; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 900; }
        .header h2 { margin: 0 0 4px 0; font-size: 16px; color: #4f46e5; font-weight: 800; letter-spacing: 0.15em; text-transform: uppercase; }
        .header h3 { margin: 0; font-size: 13px; color: #64748b; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; }
        .info-grid { background: #f8fafc; padding: 20px; border-radius: 8px; border: 1px solid #e2e8f0; margin-bottom: 40px; display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        .info-grid div { font-size: 15px; color: #0f172a; font-weight: 700; }
        .info-grid strong { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 0.15em; display: block; margin-bottom: 4px; font-weight: 800; }
        .sem-block { margin-bottom: 40px; page-break-inside: avoid; border: 1px solid #cbd5e1; border-radius: 6px; overflow: hidden; }
        .sem-title { font-size: 14px; font-weight: 800; background: #0f172a; color: white; text-transform: uppercase; letter-spacing: 0.15em; padding: 12px 16px; margin: 0; }
        table { width: 100%; border-collapse: collapse; }
        th, td { border-bottom: 1px solid #f1f5f9; padding: 14px 16px; text-align: left; font-size: 14px; font-weight: 600; }
        th { background: #f8fafc; color: #64748b; font-weight: 800; text-transform: uppercase; font-size: 11px; letter-spacing: 0.1em; border-bottom: 2px solid #cbd5e1; }
        .tc { text-align: center; } .tr { text-align: right; } .font-mono { font-family: 'DM Mono', monospace; font-weight: 700; } .bg-light { background: #f8fafc; }
        .footer { font-size: 11px; color: #94a3b8; margin-top: 50px; text-align: center; border-top: 1px solid #e2e8f0; padding-top: 20px; font-weight: 600; font-style: italic; }
    </style></head><body>
    ${unofficalBanner}
    <div class="header">
        <img src="${logoSrc}" class="logo" onerror="this.style.display='none'">
        <h1>${escHtml(schoolData.schoolName || 'ConnectUs School')}</h1>
        <h2>${docTitle}</h2>
        <h3>${docSubtitle}</h3>
    </div>
    <div class="info-grid">
        <div><strong>Student Name</strong> ${escHtml(session.studentData.name || 'Unknown')}</div>
        <div><strong>Student ID</strong> ${escHtml(session.studentData.studentIdNum || 'N/A')}</div>
        <div><strong>Class</strong> ${escHtml(session.studentData.className || 'Unassigned')}</div>
        <div><strong>Teacher</strong> ${escHtml(currentTeacherName)}</div>
        <div style="grid-column: 1 / -1;"><strong>Date Generated</strong> ${new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' })}</div>
    </div>`;

    if (isSummaryMode) {
        // SUMMARY PRINT VIEW
        for (let semName in currentQueryResults) {
            html += `<div class="sem-block">
                <h3 class="sem-title">${escHtml(semName)}</h3>
                <table>
                    <thead><tr><th>Subject</th><th class="tc">Assessments</th><th class="tc">Average</th><th class="tc">Grade</th></tr></thead>
                    <tbody>`;
            
            let termSum = 0; let termSubCount = 0;
            for (let sub in currentQueryResults[semName]) {
                const grades = currentQueryResults[semName][sub];
                const tId = grades[0]?.teacherId;
                const rubric = tId ? (teacherRubricsCache[tId] || []) : [];
                const avgRaw = calculateWeightedAverage(grades, rubric);
                
                if (avgRaw !== null) {
                    const avg = Math.round(avgRaw);
                    termSum += avg; termSubCount++;
                    html += `<tr><td>${escHtml(sub)}</td><td class="tc" style="font-size:12px;color:#64748b;">${grades.length}</td><td class="tc font-mono">${avg}%</td><td class="tc font-mono">${letterGrade(avg)}</td></tr>`;
                }
            }

            const semAvg = termSubCount > 0 ? Math.round(termSum / termSubCount) : null;
            if (semAvg !== null) {
                html += `<tr><td colspan="2" class="tr" style="font-size:12px;font-weight:900;color:#64748b;text-transform:uppercase;letter-spacing:0.1em;padding:16px;">Term Average</td><td class="tc font-mono bg-light" style="font-size:16px;">${semAvg}%</td><td class="tc font-mono bg-light" style="font-size:16px;">${letterGrade(semAvg)}</td></tr>`;
            }
            html += `</tbody></table></div>`;
        }
    } else {
        // DETAILED PRINT VIEW (Original)
        const bySem = {};
        currentQueryResults.forEach(g => {
            const semName = allSemesters.find(s => s.id === g.semesterId)?.name || 'Unknown Period';
            if (!bySem[semName]) bySem[semName] = [];
            bySem[semName].push(g);
        });

        for (let semName in bySem) {
            html += `<div class="sem-block"><h3 class="sem-title">${escHtml(semName)}</h3><table>`;
            html += `<thead><tr><th>Subject</th><th>Assignment</th><th class="tc">Type</th><th class="tc">Score</th><th class="tc">%</th></tr></thead><tbody>`;
            
            bySem[semName].forEach(g => {
                const pct = g.max ? Math.round((g.score / g.max) * 100) : null;
                html += `<tr><td>${escHtml(g.subject)}</td><td>${escHtml(g.title)}<br><span style="font-size:11px;color:#94a3b8">${g.date || ''}</span></td><td class="tc" style="font-size:11px;color:#64748b;text-transform:uppercase;">${escHtml(g.type)}</td><td class="tc font-mono">${g.score}/${g.max}</td><td class="tc font-mono">${pct !== null ? pct + '%' : '—'}</td></tr>`;
            });

            const bySub = {};
            bySem[semName].forEach(g => {
                const sub = g.subject || 'Uncategorized';
                if (!bySub[sub]) bySub[sub] = [];
                bySub[sub].push(g);
            });

            let semSum = 0; let semSubCount = 0;
            for(let sub in bySub) {
                const tId = bySub[sub][0]?.teacherId;
                const rubric = tId ? (teacherRubricsCache[tId] || []) : [];
                const avg = calculateWeightedAverage(bySub[sub], rubric);
                if(avg !== null) { semSum += avg; semSubCount++; }
            }

            const semAvg = semSubCount > 0 ? Math.round(semSum / semSubCount) : null;
            if (semAvg !== null) {
                html += `<tr><td colspan="4" class="tr" style="font-size:12px;font-weight:900;color:#64748b;text-transform:uppercase;letter-spacing:0.1em;padding:16px;">Term Average</td><td class="tc font-mono bg-light" style="font-size:16px;">${semAvg}% (${letterGrade(semAvg)})</td></tr>`;
            }
            html += `</tbody></table></div>`;
        }
    }

    html += `<div class="footer">Generated securely by the ConnectUs Family Portal.<br>This document represents live progress and does not constitute a finalized administrative transcript.</div></body></html>`;
    
    const w = window.open('', '_blank'); 
    w.document.write(html); 
    w.document.close();
    setTimeout(() => w.print(), 600);
}

// ── 6. EVENT LISTENERS ────────────────────────────────────────────────────
buildReportBtn.addEventListener('click', executeCustomQuery);
printCustomReportBtn.addEventListener('click', printDocument);

// ── INITIALIZE ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', initializeReports);
