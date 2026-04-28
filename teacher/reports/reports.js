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
let studentMap = {}; // Maps ID to full student object to access className
let rawSemesters = [];
let allGradesCache = {}; 
let currentQueryResults = []; 
let currentQueryMeta = {}; 

// UPDATED: Pull the gradeTypes array saved from the new Settings page
const DEFAULT_GRADE_TYPES = ['Test', 'Quiz', 'Assignment', 'Homework', 'Project', 'Midterm Exam', 'Final Exam'];
function getGradeTypes() { return session.teacherData.gradeTypes || session.teacherData.customGradeTypes || DEFAULT_GRADE_TYPES; }

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

// ── 3. INITIALIZATION ───────────────────────────────────────────────────────
async function init() {
    if (!session) return;

    // Attach Listeners
    document.getElementById('rb-scope').addEventListener('change', toggleScope);
    document.getElementById('generateReportBtn').addEventListener('click', executeIntelligentQuery);

    // Load Checkboxes & Data
    populateStaticCheckboxes();
    await loadSemesters(); 
    await loadStudents();
}

function buildCheckbox(idPrefix, value, label, isChecked = true) {
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
    const container = document.getElementById(containerId);
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => {
        cb.checked = state;
        const wrapId = cb.closest('label').id;
        window.toggleCbVisuals(cb, wrapId);
    });
};

function populateStaticCheckboxes() {
    // Subjects
    const subjects = (session.teacherData.subjects || []);
    const subGrid = document.getElementById('rb-subject-grid');
    if (subGrid) {
        subGrid.innerHTML = subjects.map(s => buildCheckbox('sub', s.name, s.name, true)).join('') || '<p class="text-xs text-slate-400">No subjects found.</p>';
    }

    // Types (Updated to use robust getGradeTypes handling object or string)
    let types = getGradeTypes().map(t => t.name || t);
    let archivedTypes = session.teacherData.archivedGradeTypes || [];
    let allTypes = [...new Set([...types, ...archivedTypes])];
    
    const typeGrid = document.getElementById('rb-type-grid');
    if (typeGrid) {
        typeGrid.innerHTML = allTypes.map(t => buildCheckbox('typ', t, t, true)).join('');
    }

    // Populate the Class Filter dropdown from teacher's assigned classes
    const classes = session.teacherData.classes || [session.teacherData.className || ''];
    const classSel = document.getElementById('rb-class');
    if (classSel && classes.length > 0) {
        classSel.innerHTML = '<option value="">All Classes</option>' + classes.filter(Boolean).map(c => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join('');
    }
}

async function loadSemesters() {
    try {
        let rawSems = [];
        const cacheKey = `connectus_semesters_${session.schoolId}`;
        const cached = localStorage.getItem(cacheKey);

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
        const sbPeriod = document.getElementById('sb-period');
        
        if (topSemSel) {
            topSemSel.innerHTML = '';
            rawSemesters.forEach(s => {
                const opt = document.createElement('option');
                opt.value = s.id;
                opt.textContent = s.name;
                if (s.id === activeId) opt.selected = true;
                topSemSel.appendChild(opt);
            });
            if (sbPeriod) sbPeriod.textContent = topSemSel.options[topSemSel.selectedIndex]?.text || '—';
            topSemSel.addEventListener('change', () => {
                if (sbPeriod) sbPeriod.textContent = topSemSel.options[topSemSel.selectedIndex]?.text || '—';
            });
        }

        const semGrid = document.getElementById('rb-semester-grid');
        if (semGrid) {
            semGrid.innerHTML = rawSemesters.map(s => buildCheckbox('sem', s.id, s.name, s.id === activeId)).join('');
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
        stuSel.innerHTML = '<option value="">— Target a specific student —</option>' + sortedStudents.map(s => `<option value="${s.id}">${escHtml(s.name)} ${s.archived ? '(Archived)' : ''}</option>`).join('');
    } catch (e) {
        console.error("[Reports] Error loading students:", e);
        stuSel.innerHTML = '<option value="">Error loading students</option>';
    }
}

function toggleScope() {
    const scope = document.getElementById('rb-scope').value;
    const studentWrap = document.getElementById('studentFilterWrap');
    const classWrap = document.getElementById('classFilterWrap');
    const standingWrap = document.getElementById('standingFilterWrap');

    if (scope === 'student') {
        studentWrap.classList.remove('hidden');
        classWrap.classList.add('hidden');
        standingWrap.classList.add('hidden');
        document.getElementById('rb-class').value = ''; 
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
                const q = query(collection(db, 'schools', session.schoolId, 'students', s.id, 'grades'), where('semesterId', '==', semId));
                const snap = await getDocs(q);
                snap.forEach(d => {
                    const data = d.data();
                    semGrades.push({ id: d.id, studentId: s.id, studentName: s.name, semesterId: data.semesterId, ...data });
                });
            } catch (e) { } 
        }));
        
        allGradesCache[semId] = semGrades;
        all = all.concat(semGrades);
    }
    return all;
}

// ── 5. INTELLIGENT GENERATOR (UI SEQUENCE & ADVANCED MATH) ──────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function executeIntelligentQuery() {
    const btn = document.getElementById('generateReportBtn');
    
    const scope = document.getElementById('rb-scope').value;
    const targetStudentId = document.getElementById('rb-student').value;
    const filterClass = document.getElementById('rb-class').value;
    const filterStanding = document.getElementById('rb-standing').value;
    
    const selectedSems = getCheckedValues('rb-semester-grid');
    const selectedSubs = getCheckedValues('rb-subject-grid');
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
        
        // 1. Initial Filtering (Scope, Subjects, Types)
        if (scope === 'student') {
            filteredGrades = filteredGrades.filter(g => g.studentId === targetStudentId);
        } else if (filterClass) {
            // Filter by selected class
            filteredGrades = filteredGrades.filter(g => {
                const student = studentMap[g.studentId];
                return student && student.className === filterClass;
            });
        }
        
        filteredGrades = filteredGrades.filter(g => selectedSubs.includes(g.subject));
        filteredGrades = filteredGrades.filter(g => selectedTypes.includes(g.type));

        // 2. Advanced Mathematical Standing Filter (On the fly calculation)
        if (scope === 'class' && filterStanding) {
            const studentAvgs = {};
            filteredGrades.forEach(g => {
                if (!studentAvgs[g.studentId]) studentAvgs[g.studentId] = [];
                if (g.max > 0) {
                    studentAvgs[g.studentId].push(g);
                }
            });

            const allowedStudentIds = new Set();
            Object.entries(studentAvgs).forEach(([sid, grades]) => {
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

                        if (std === filterStanding) allowedStudentIds.add(sid);
                    }
                }
            });

            // Strip out grades from students who don't match the standing requirement
            filteredGrades = filteredGrades.filter(g => allowedStudentIds.has(g.studentId));
        }
        
        filteredGrades.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
        currentQueryResults = filteredGrades;
        await sleep(350);

        btn.innerHTML = `<i class="fa-solid fa-chart-pie fa-fade"></i> Calculating aggregates...`;
        
        // Build Meta text based on parameters
        const totalSems = rawSemesters.length;
        const totalSubs = (session.teacherData.subjects || []).length;
        
        let semText = selectedSems.length === totalSems ? 'All Periods' : `${selectedSems.length} Periods`;
        let subText = selectedSubs.length >= totalSubs ? 'All Subjects' : `${selectedSubs.length} Subjects`;
        
        let scopeName = 'Class Overview';
        if (scope === 'student') {
            scopeName = studentMap[targetStudentId]?.name || 'Student';
        } else {
            const cStr = filterClass ? filterClass : 'All Classes';
            const sEl = document.getElementById('rb-standing');
            const sStr = filterStanding ? sEl.options[sEl.selectedIndex].text : 'All Standings';
            scopeName = `${cStr} (${sStr})`;
        }
        
        currentQueryMeta = { 
            selectedSems, 
            semText, 
            scopeName, 
            subText, 
            scope, 
            targetStudentId 
        };

        let high = null;
        let low = null;
        let validGradesCount = 0;

        filteredGrades.forEach(g => {
            if (g.max > 0) {
                const pct = Math.round((g.score / g.max) * 100);
                validGradesCount++;
                if (high === null || pct > high) high = pct;
                if (low === null || pct < low) low = pct;
            }
        });

        // UPDATED: Using Teacher-Specific Grade Types
        const avg = validGradesCount > 0 ? calculateWeightedAverage(filteredGrades, getGradeTypes()) : null;
        await sleep(300);

        // 3. Render UI
        btn.innerHTML = `<i class="fa-solid fa-object-group fa-fade"></i> Rendering interface...`;
        
        const isTranscript = scope === 'student' && selectedSems.length > 1;
        document.getElementById('reportOutputTitle').textContent = isTranscript ? 'Academic Transcript Profile' : (scope === 'class' ? 'Aggregated Class Data' : 'Student Academic Profile');
        document.getElementById('reportOutputMeta').textContent = `${semText} · ${scopeName} · ${subText}`;

        document.getElementById('resAvg').innerHTML = avg !== null ? `${avg}<span class="text-sm text-[#6b84a0] ml-1">%</span>` : '—';
        document.getElementById('resHigh').innerHTML = high !== null ? `${high}<span class="text-sm text-[#0ea871] ml-1">%</span>` : '—';
        document.getElementById('resLow').innerHTML = low !== null ? `${low}<span class="text-sm text-[#e31b4a] ml-1">%</span>` : '—';
        document.getElementById('resCount').textContent = filteredGrades.length;

        const tbody = document.getElementById('reportTableBody');
        if (filteredGrades.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" class="px-6 py-12 text-center text-[#9ab0c6] italic font-semibold">Query returned 0 matching records.</td></tr>`;
        } else {
            tbody.innerHTML = filteredGrades.map(g => {
                const pct = g.max ? Math.round((g.score / g.max) * 100) : null;
                const cClass = gradeColorClass(pct || 0);
                const semTag = selectedSems.length > 1 ? `<br><span class="text-[9px] uppercase text-[#2563eb]">${rawSemesters.find(s=>s.id===g.semesterId)?.name || 'Unknown'}</span>` : '';
                
                return `
                <tr class="border-b border-[#f0f4f8] hover:bg-[#f8fafb] transition">
                    <td class="px-6 py-4 text-[12px] font-mono text-[#6b84a0] leading-tight">${g.date || '—'} ${semTag}</td>
                    <td class="px-6 py-4 font-bold text-[#0d1f35] text-[13px]">${escHtml(g.studentName)}</td>
                    <td class="px-6 py-4"><span class="text-[10px] font-black bg-[#eef4ff] text-[#2563eb] border border-[#c7d9fd] px-2.5 py-1 rounded tracking-wide">${escHtml(g.subject || '—')}</span></td>
                    <td class="px-6 py-4 font-bold text-[#374f6b] text-[13px]">${escHtml(g.title || '—')}</td>
                    <td class="px-6 py-4"><span class="text-[10px] font-black uppercase tracking-widest bg-[#f8fafb] text-[#6b84a0] border border-[#dce3ed] px-2 py-1 rounded">${escHtml(g.type || '—')}</span></td>
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
    btn.disabled = false;
}

// ── 6. EXPORT / PRINT (PROFESSIONAL TRANSCRIPT OVERHAUL) ────────────────────
window.exportReportCSV = function() {
    if (!currentQueryResults || currentQueryResults.length === 0) {
        alert("No data available to export.");
        return;
    }
    
    const rows = [['Period', 'Date', 'Student', 'Subject', 'Assignment', 'Type', 'Score', 'Max', '%', 'Letter Grade', 'Teacher Notes']];
    
    currentQueryResults.forEach(g => {
        const pct = g.max ? Math.round((g.score / g.max) * 100) : null;
        const periodName = rawSemesters.find(s=>s.id===g.semesterId)?.name || 'Unknown';
        
        rows.push([
            periodName,
            g.date || '',
            g.studentName || '',
            g.subject || '',
            g.title || '',
            g.type || '',
            g.score,
            g.max || '',
            pct !== null ? pct + '%' : '',
            pct !== null ? letterGrade(pct) : '',
            g.notes || ''
        ]);
    });
    
    const safeName = currentQueryMeta.scopeName.replace(/\s+/g, '_').toLowerCase();
    downloadCSV(rows, `connectus_query_${safeName}.csv`);
};

window.printReport = function() {
    if (!currentQueryResults || currentQueryResults.length === 0) {
        alert("No data available to print.");
        return;
    }
    
    const isStudentReport = currentQueryMeta.scope === 'student';
    const isFullTranscript = currentQueryMeta.selectedSems.length > 1;
    
    let reportTitle = 'Aggregated Class Data';
    let docSubtitle = 'ACADEMIC REPORT';
    if (isStudentReport && isFullTranscript) {
        reportTitle = 'Academic Transcript';
        docSubtitle = 'COMPREHENSIVE RECORD';
    } else if (isStudentReport) {
        reportTitle = 'Student Report Card';
        docSubtitle = 'PERIODIC ACADEMIC RECORD';
    }
    
    const unofficalBanner = `<div style="background:#e31b4a;color:white;text-align:center;font-weight:900;letter-spacing:0.3em;padding:6px;font-size:12px;margin-bottom:20px;width:100%;">*** UNOFFICIAL RECORD ***</div>`;
    
    // UPDATED: Branded Footer Disclaimer
    const printDisclaimer = `
    <div style='font-size:10px;color:#9ab0c6;margin-top:40px;text-align:center;border-top:1px solid #dce3ed;padding-top:14px;font-style:italic;'>
        <p style="margin:0 0 10px 0;">Generated by the ConnectUs Analytical Engine for ${escHtml(session.schoolName || session.schoolId)}. This document does not constitute a certified administrative transcript unless signed and stamped by school administration.</p>
        <div style="display:flex; justify-content:center; align-items:center; gap:8px;">
            <img src="../../assets/images/logo.png" style="max-height:16px; object-fit:contain; opacity:0.8;">
            <span style="font-weight:bold; color:#0d1f35; font-style:normal;">Powered by ConnectUs</span>
        </div>
    </div>`;
    
    let html = `<html><head><title>${reportTitle} — ${escHtml(currentQueryMeta.scopeName)}</title>
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
        
        .header h1 { margin: 0 0 4px 0; font-size: 22px; color: #0d1f35; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 800; }
        .header h2 { margin: 0; font-size: 11px; color: #6b84a0; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; }
        
        .info-grid { background: #f8fafb; padding: 18px; border-radius: 4px; border: 1px solid #dce3ed; margin-bottom: 30px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .info-grid div { font-size: 13px; color: #0d1f35; font-weight: 600; }
        .info-grid strong { font-size: 10px; color: #6b84a0; text-transform: uppercase; letter-spacing: 0.1em; display: block; margin-bottom: 2px; font-weight: 700; }
        
        .transcript-section { margin-bottom: 30px; page-break-inside: avoid; border: 1px solid #dce3ed; border-radius: 4px; overflow: hidden; }
        .transcript-header { background: #0d1f35; color: white; font-weight: 700; text-transform: uppercase; font-size: 11px; letter-spacing: 0.1em; padding: 8px 14px; }
        
        table { width: 100%; border-collapse: collapse; }
        th, td { border-bottom: 1px solid #f0f4f8; padding: 10px 14px; text-align: left; font-size: 12px; }
        th { background: #f8fafb; color: #6b84a0; font-weight: 700; text-transform: uppercase; font-size: 10px; letter-spacing: 0.05em; border-bottom: 2px solid #dce3ed; }
        .tc { text-align: center; }
        .font-mono { font-family: 'DM Mono', monospace; font-weight: 700; }
        .bg-light { background: #f8fafb; }
        
        .cum-gpa { display: flex; justify-content: flex-end; align-items: center; gap: 16px; padding: 16px; background: #eef4ff; border: 1px solid #c7d9fd; border-radius: 4px; margin-top: 20px; }
        .cum-gpa-label { font-size: 11px; font-weight: 700; color: #2563eb; text-transform: uppercase; letter-spacing: 0.1em; }
        .cum-gpa-val { font-size: 20px; font-weight: 700; color: #0d1f35; font-family: 'DM Mono', monospace; }
    </style></head><body>
    
    ${unofficalBanner}
    
    <div class="header">
        <img src="${session.logo || ''}" alt="${escHtml(session.schoolName || session.schoolId)}" class="logo" onerror="this.style.display='none'">
        <h1>${reportTitle}</h1>
        <h2>${docSubtitle} • ${escHtml(session.teacherData.name)}</h2>
    </div>
    
    <div class="info-grid">
        <div><strong>Target Scope</strong> ${escHtml(currentQueryMeta.scopeName)}</div>
        <div><strong>Academic Period(s)</strong> ${escHtml(currentQueryMeta.semText)}</div>
        <div><strong>Subject Filter</strong> ${escHtml(currentQueryMeta.subText)}</div>
        <div><strong>Date Generated</strong> ${new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' })}</div>
    </div>`;

    // ── LOGIC FOR TRANSCRIPT / MULTI PERIODS ─────────────────────────────────
    if (isStudentReport && isFullTranscript) {
        
        const semGroups = {};
        currentQueryResults.forEach(g => {
            const sName = rawSemesters.find(x => x.id === g.semesterId)?.name || 'Unknown Period';
            if (!semGroups[sName]) semGroups[sName] = [];
            semGroups[sName].push(g);
        });

        for (const sName in semGroups) {
            html += `<div class="transcript-section">
                <div class="transcript-header">${escHtml(sName)}</div>
                <table>
                    <thead><tr>
                        <th>Subject</th>
                        <th>Assignment</th>
                        <th class="tc">Type</th>
                        <th class="tc">Score</th>
                        <th class="tc">%</th>
                    </tr></thead>
                    <tbody>`;
            
            let semValidCount = 0;
            
            semGroups[sName].sort((a, b) => (a.date || '').localeCompare(b.date || '')).forEach(g => {
                const pct = g.max ? Math.round((g.score / g.max) * 100) : null;
                if (pct !== null) {
                    semValidCount++;
                }
                html += `<tr>
                    <td>${escHtml(g.subject)}</td>
                    <td>${escHtml(g.title)}<br><span style="font-size:10px;color:#9ab0c6">${g.date || ''}</span></td>
                    <td class="tc" style="font-size:10px;color:#6b84a0;text-transform:uppercase;">${escHtml(g.type)}</td>
                    <td class="tc font-mono">${g.score}/${g.max}</td>
                    <td class="tc font-mono">${pct !== null ? pct + '%' : '—'}</td>
                </tr>`;
            });
            
            // UPDATED: Using Teacher-Specific Grade Types
            const semAvg = semValidCount > 0 ? calculateWeightedAverage(semGroups[sName], getGradeTypes()) : null;
            if (semAvg !== null) {
                html += `<tr>
                    <td colspan="4" style="text-align:right;font-size:10px;font-weight:700;color:#6b84a0;text-transform:uppercase;letter-spacing:0.1em;padding:12px 14px;">Term Average</td>
                    <td class="tc font-mono bg-light">${semAvg}% (${letterGrade(semAvg)})</td>
                </tr>`;
            }
            html += `</tbody></table></div>`;
        }

        // UPDATED: Using Teacher-Specific Grade Types
        const cumAvg = currentQueryResults.length > 0 ? calculateWeightedAverage(currentQueryResults, getGradeTypes()) : null;
        if (cumAvg !== null) {
            html += `<div class="cum-gpa">
                <span class="cum-gpa-label">Cumulative Academic Average</span>
                <span class="cum-gpa-val">${cumAvg}% (${letterGrade(cumAvg)})</span>
            </div>`;
        }

    } else {
        // ── STANDARD REPORT LOGIC (Single Semester or Class Scope) ─────────
        html += `<table>
            <thead>
                <tr>
                    <th style="width: 90px;">Date</th>
                    ${!isStudentReport ? '<th>Student</th>' : ''}
                    <th>Subject</th>
                    <th>Assignment</th>
                    <th class="tc">Type</th>
                    <th class="tc">Score</th>
                    <th class="tc">%</th>
                </tr>
            </thead>
            <tbody>`;
            
        currentQueryResults.forEach(g => {
            const pct = g.max ? Math.round((g.score / g.max) * 100) : null;
            html += `
                <tr>
                    <td class="font-mono text-[#6b84a0]">${g.date || '—'}</td>
                    ${!isStudentReport ? `<td><strong>${escHtml(g.studentName)}</strong></td>` : ''}
                    <td>${escHtml(g.subject)}</td>
                    <td>${escHtml(g.title)}</td>
                    <td class="tc" style="color:#6b84a0; font-size:10px; text-transform:uppercase;">${escHtml(g.type)}</td>
                    <td class="tc font-mono">${g.score}/${g.max}</td>
                    <td class="tc font-mono">${pct !== null ? pct + '%' : '—'}</td>
                </tr>`;
        });
        html += `</tbody></table>`;
    }
    
    html += `${printDisclaimer}
    <br><br>${unofficalBanner}
    </body></html>`;
    
    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
    setTimeout(() => w.print(), 600);
};

// Fire it up
init();
