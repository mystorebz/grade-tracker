import { db } from '../../assets/js/firebase-init.js';
import { collection, query, where, getDocs, getDoc, doc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { gradeColorClass, letterGrade, downloadCSV } from '../../assets/js/utils.js';

// ── 1. AUTHENTICATION & LAYOUT ──────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    injectTeacherLayout('reports', 'Data Query Builder', 'Generate advanced analytics and custom academic transcripts', false);
}

// ── 2. STATE VARIABLES ──────────────────────────────────────────────────────
let allStudentsCache = [];
let studentMap = {};
let rawSemesters = [];
let allGradesCache = null; // Caches { semId, grades[] } to avoid re-fetching same parameters
let currentQueryResults = []; 
let currentQueryMeta = {}; 

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

    // Load Dropdowns safely
    populateStaticDropdowns();
    await loadSemesters(); // Now properly updates ALL dropdowns and sidebar
    await loadStudents();
}

function populateStaticDropdowns() {
    // Subjects (Active + Archived so historical queries still work)
    const subjects = (session.teacherData.subjects || []);
    const subSel = document.getElementById('rb-subject');
    if (subSel) {
        subSel.innerHTML = '<option value="all">All Subjects (Combined)</option>' + subjects.map(s => `<option value="${escHtml(s.name)}">${escHtml(s.name)}</option>`).join('');
    }

    // Types (Active + Archived)
    let types = session.teacherData.customGradeTypes || ['Test', 'Quiz', 'Assignment', 'Homework', 'Project', 'Midterm Exam', 'Final Exam'];
    let archivedTypes = session.teacherData.archivedGradeTypes || [];
    let allTypes = [...new Set([...types, ...archivedTypes])];
    
    const typeSel = document.getElementById('rb-type');
    if (typeSel) {
        typeSel.innerHTML = '<option value="all">All Assignment Types</option>' + allTypes.map(t => `<option value="${escHtml(t)}">${escHtml(t)}</option>`).join('');
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

        // 1. UPDATE THE TOPBAR AND SIDEBAR
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

        // 2. UPDATE THE REPORT BUILDER DROPDOWN
        const rbSemSel = document.getElementById('rb-semester');
        if (rbSemSel) {
            rbSemSel.innerHTML = '<option value="all" class="font-bold text-[#2563eb]">All Periods (Full Academic Year)</option>';
            rawSemesters.forEach(s => {
                const opt = document.createElement('option');
                opt.value = s.id;
                opt.textContent = s.name;
                if (s.id === activeId) opt.selected = true; // Auto-select current semester
                rbSemSel.appendChild(opt);
            });
        }

    } catch (e) {
        console.error("[Reports] Error loading semesters:", e);
        const rbSemSel = document.getElementById('rb-semester');
        if (rbSemSel) rbSemSel.innerHTML = '<option value="">Error loading periods</option>';
    }
}

async function loadStudents() {
    const stuSel = document.getElementById('rb-student');
    try {
        // Fetch ALL students assigned to this teacher (including archived, to allow historical transcripts)
        const stuQuery = query(collection(db, 'schools', session.schoolId, 'students'), where('teacherId', '==', session.teacherId));
        const stuSnap = await getDocs(stuQuery);
        
        allStudentsCache = stuSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        studentMap = {};
        allStudentsCache.forEach(s => { studentMap[s.id] = s.name; });

        const sortedStudents = [...allStudentsCache].sort((a, b) => a.name.localeCompare(b.name));
        stuSel.innerHTML = '<option value="">— Target a specific student —</option>' + sortedStudents.map(s => `<option value="${s.id}">${escHtml(s.name)} ${s.archived ? '(Archived)' : ''}</option>`).join('');
    } catch (e) {
        console.error("[Reports] Error loading students:", e);
        stuSel.innerHTML = '<option value="">Error loading students</option>';
    }
}

function toggleScope() {
    const scope = document.getElementById('rb-scope').value;
    const wrap = document.getElementById('studentFilterWrap');
    if (scope === 'student') {
        wrap.classList.remove('hidden');
    } else {
        wrap.classList.add('hidden');
        document.getElementById('rb-student').value = ''; 
    }
}

// ── 4. DATA FETCHING ENGINE ─────────────────────────────────────────────────
async function fetchGradesForQuery(semId) {
    // If we've already cached this exact semester request, use it to save DB reads
    if (allGradesCache && allGradesCache.semId === semId) return allGradesCache.grades;
    
    const all = [];
    await Promise.all(allStudentsCache.map(async s => {
        try {
            let q;
            if (semId === 'all') {
                // Fetch ALL historical grades for this student (Transcript Mode)
                q = collection(db, 'schools', session.schoolId, 'students', s.id, 'grades');
            } else {
                // Fetch specifically for the target semester
                q = query(collection(db, 'schools', session.schoolId, 'students', s.id, 'grades'), where('semesterId', '==', semId));
            }
            const snap = await getDocs(q);
            snap.forEach(d => {
                const data = d.data();
                all.push({ id: d.id, studentId: s.id, studentName: s.name, semesterId: data.semesterId, ...data });
            });
        } catch (e) { } // Silent fail per student to keep loop alive
    }));
    
    allGradesCache = { semId, grades: all };
    return all;
}

// ── 5. INTELLIGENT GENERATOR (UI SEQUENCE) ──────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function executeIntelligentQuery() {
    const btn = document.getElementById('generateReportBtn');
    
    const semId = document.getElementById('rb-semester').value;
    const scope = document.getElementById('rb-scope').value;
    const targetStudentId = document.getElementById('rb-student').value;
    const subject = document.getElementById('rb-subject').value;
    const type = document.getElementById('rb-type').value;

    if (scope === 'student' && !targetStudentId) {
        alert("System Notice: A target student must be selected to generate an individual report.");
        return;
    }

    btn.disabled = true;
    const area = document.getElementById('reportResultsArea');
    area.classList.add('opacity-0'); // Fade out old results
    
    try {
        // Step 1: Simulated Database Connection
        btn.innerHTML = `<i class="fa-solid fa-database fa-fade"></i> Querying datastore...`;
        const rawGrades = await fetchGradesForQuery(semId);
        await sleep(350);

        // Step 2: Filtering logic
        btn.innerHTML = `<i class="fa-solid fa-microchip fa-fade"></i> Filtering datasets...`;
        let filteredGrades = rawGrades;
        if (scope === 'student') {
            filteredGrades = filteredGrades.filter(g => g.studentId === targetStudentId);
        }
        if (subject !== 'all') {
            filteredGrades = filteredGrades.filter(g => g.subject === subject);
        }
        if (type !== 'all') {
            filteredGrades = filteredGrades.filter(g => g.type === type);
        }
        
        // Sort chronologically
        filteredGrades.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
        currentQueryResults = filteredGrades;
        await sleep(350);

        // Step 3: Aggregation
        btn.innerHTML = `<i class="fa-solid fa-chart-pie fa-fade"></i> Calculating aggregates...`;
        
        const semSel = document.getElementById('rb-semester');
        const semName = semSel.options[semSel.selectedIndex]?.text || 'Full Academic Year';
        const scopeName = scope === 'class' ? 'Class Overview' : studentMap[targetStudentId];
        const subName = subject === 'all' ? 'All Subjects' : subject;
        const typeName = type === 'all' ? 'All Types' : type;

        currentQueryMeta = { semId, semName, scopeName, subName, typeName, scope, targetStudentId };

        let sumPct = 0;
        let high = null;
        let low = null;
        let validGradesCount = 0;

        filteredGrades.forEach(g => {
            if (g.max > 0) {
                const pct = Math.round((g.score / g.max) * 100);
                sumPct += pct;
                validGradesCount++;
                if (high === null || pct > high) high = pct;
                if (low === null || pct < low) low = pct;
            }
        });

        const avg = validGradesCount > 0 ? Math.round(sumPct / validGradesCount) : null;
        await sleep(300);

        // Step 4: Render UI
        btn.innerHTML = `<i class="fa-solid fa-object-group fa-fade"></i> Rendering interface...`;
        
        // Change title dynamically if we are generating a Full Transcript
        if (semId === 'all' && scope === 'student') {
            document.getElementById('reportOutputTitle').textContent = 'Academic Transcript Profile';
        } else {
            document.getElementById('reportOutputTitle').textContent = scope === 'class' ? 'Aggregated Class Data' : 'Student Academic Profile';
        }
        
        document.getElementById('reportOutputMeta').textContent = `${semName} · ${scopeName} · ${subName}`;

        // Populate Stat Cards
        document.getElementById('resAvg').innerHTML = avg !== null ? `${avg}<span class="text-sm text-[#6b84a0] ml-1">%</span>` : '—';
        document.getElementById('resHigh').innerHTML = high !== null ? `${high}<span class="text-sm text-[#0ea871] ml-1">%</span>` : '—';
        document.getElementById('resLow').innerHTML = low !== null ? `${low}<span class="text-sm text-[#e31b4a] ml-1">%</span>` : '—';
        document.getElementById('resCount').textContent = filteredGrades.length;

        // Populate Data Table
        const tbody = document.getElementById('reportTableBody');
        if (filteredGrades.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" class="px-6 py-12 text-center text-[#9ab0c6] italic font-semibold">Query returned 0 matching records.</td></tr>`;
        } else {
            tbody.innerHTML = filteredGrades.map(g => {
                const pct = g.max ? Math.round((g.score / g.max) * 100) : null;
                const cClass = gradeColorClass(pct || 0);
                // If checking "All Semesters", prepend the semester name to the date for context
                const semTag = semId === 'all' ? `<br><span class="text-[9px] uppercase text-[#2563eb]">${rawSemesters.find(s=>s.id===g.semesterId)?.name || 'Unknown'}</span>` : '';
                
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

        // Reveal the Results Area
        area.classList.remove('hidden');
        setTimeout(() => { area.classList.remove('opacity-0'); }, 50);

    } catch (e) {
        console.error(e);
        alert("System Error: Query execution failed.");
    }

    // Reset button state
    btn.innerHTML = `<i class="fa-solid fa-play"></i> Execute Query`;
    btn.disabled = false;
}

// ── 6. EXPORT / PRINT (OFFICIAL TRANSCRIPT & REPORT CARD GEN) ───────────────
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
    const isFullTranscript = currentQueryMeta.semId === 'all';
    
    // Determine the Document Type
    let reportTitle = 'Aggregated Class Data';
    let docSubtitle = 'ACADEMIC REPORT';
    if (isStudentReport && isFullTranscript) {
        reportTitle = 'Official Academic Transcript';
        docSubtitle = 'COMPLETE HISTORICAL RECORD';
    } else if (isStudentReport) {
        reportTitle = 'Official Student Report Card';
        docSubtitle = 'PERIODIC ACADEMIC RECORD';
    }
    
    const printDisclaimer = "<p style='font-size:10px;color:#9ab0c6;margin-top:40px;text-align:center;border-top:1px solid #dce3ed;padding-top:14px;font-style:italic;'>Generated by ConnectUs Analytical Engine. This document does not constitute a certified administrative transcript unless signed and stamped by school administration.</p>";
    
    let html = `<html><head><title>${reportTitle} — ${escHtml(currentQueryMeta.scopeName)}</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap');
        body { font-family: 'DM Sans', sans-serif; padding: 40px; color: #0d1f35; line-height: 1.5; background: white; }
        
        .header { display: flex; flex-direction: column; align-items: center; border-bottom: 2px solid #0d1f35; padding-bottom: 20px; margin-bottom: 24px; }
        .logo { max-height: 50px; max-width: 180px; object-fit: contain; margin-bottom: 12px; }
        
        .header h1 { margin: 0 0 4px 0; font-size: 20px; color: #0d1f35; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 700; }
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
    
    <div class="header">
        <img src="../../assets/images/logo.png" alt="ConnectUs" class="logo" onerror="this.style.display='none'">
        <h1>${reportTitle}</h1>
        <h2>${docSubtitle} • ${escHtml(session.teacherData.name)}</h2>
    </div>
    
    <div class="info-grid">
        <div><strong>Target Scope</strong> ${escHtml(currentQueryMeta.scopeName)}</div>
        <div><strong>Academic Period</strong> ${escHtml(currentQueryMeta.semName)}</div>
        <div><strong>Subject Filter</strong> ${escHtml(currentQueryMeta.subName)}</div>
        <div><strong>Date Generated</strong> ${new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' })}</div>
    </div>`;

    // ── LOGIC FOR TRANSCRIPT / ALL PERIODS ─────────────────────────────────
    if (isStudentReport && isFullTranscript) {
        
        // Group grades by Semester
        const semGroups = {};
        currentQueryResults.forEach(g => {
            const sName = rawSemesters.find(x => x.id === g.semesterId)?.name || 'Unknown Period';
            if (!semGroups[sName]) semGroups[sName] = [];
            semGroups[sName].push(g);
        });

        let totalCumPct = 0;
        let totalCumCount = 0;

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
            
            let semSumPct = 0;
            let semValidCount = 0;
            
            // Sort chronologically within the semester block
            semGroups[sName].sort((a, b) => (a.date || '').localeCompare(b.date || '')).forEach(g => {
                const pct = g.max ? Math.round((g.score / g.max) * 100) : null;
                if (pct !== null) {
                    semSumPct += pct;
                    semValidCount++;
                    totalCumPct += pct;
                    totalCumCount++;
                }
                html += `<tr>
                    <td>${escHtml(g.subject)}</td>
                    <td>${escHtml(g.title)}<br><span style="font-size:10px;color:#9ab0c6">${g.date || ''}</span></td>
                    <td class="tc" style="font-size:10px;color:#6b84a0;text-transform:uppercase;">${escHtml(g.type)}</td>
                    <td class="tc font-mono">${g.score}/${g.max}</td>
                    <td class="tc font-mono">${pct !== null ? pct + '%' : '—'}</td>
                </tr>`;
            });
            
            const semAvg = semValidCount > 0 ? Math.round(semSumPct / semValidCount) : null;
            if (semAvg !== null) {
                html += `<tr>
                    <td colspan="4" style="text-align:right;font-size:10px;font-weight:700;color:#6b84a0;text-transform:uppercase;letter-spacing:0.1em;padding:12px 14px;">Term Average</td>
                    <td class="tc font-mono bg-light">${semAvg}% (${letterGrade(semAvg)})</td>
                </tr>`;
            }
            html += `</tbody></table></div>`;
        }

        // Print Cumulative GPA at the bottom
        const cumAvg = totalCumCount > 0 ? Math.round(totalCumPct / totalCumCount) : null;
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
    
    html += `${printDisclaimer}</body></html>`;
    
    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
    setTimeout(() => w.print(), 600);
};

// Fire it up
init();
